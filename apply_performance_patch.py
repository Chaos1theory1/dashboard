#!/usr/bin/env python3
from pathlib import Path
import sys, shutil, re

MARK = 'MTD_PERF_V1'
STAMP = '20260902'

def backup(path):
    b = path.with_name(path.name + '.perf-backup-' + STAMP)
    if not b.exists():
        shutil.copy2(path, b)
    return b

def replace_once(text, old, new, label):
    if new in text:
        print('[ok]', label, ': already applied')
        return text, True
    if old not in text:
        print('[warn]', label, ': pattern not found')
        return text, False
    print('[ok]', label)
    return text.replace(old, new, 1), True

def locate(root, candidates):
    for rel in candidates:
        p = root / rel
        if p.exists(): return p
    return None

def patch_server(path):
    text = path.read_text(encoding='utf-8')
    original = text

    timing = r'''
// MTD_PERF_V1: lightweight API timing. Visible in Chrome DevTools as Server-Timing.
app.use((req, res, next) => {
  const perfStarted = process.hrtime.bigint();
  const originalWriteHead = res.writeHead;
  let timingAdded = false;
  res.writeHead = function (...args) {
    if (!timingAdded) {
      timingAdded = true;
      const ms = Number(process.hrtime.bigint() - perfStarted) / 1e6;
      try {
        if (!res.hasHeader("Server-Timing")) res.setHeader("Server-Timing", `app;dur=${ms.toFixed(1)}`);
      } catch (_) {}
    }
    return originalWriteHead.apply(this, args);
  };
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - perfStarted) / 1e6;
    if (req.path && req.path.startsWith("/api/") && ms >= 500) {
      console.warn(`[perf] ${req.method} ${req.originalUrl || req.url} ${ms.toFixed(0)}ms`);
    }
  });
  next();
});
'''
    if MARK + ': lightweight API timing' not in text:
        anchor = 'app.use(express.json());'
        if anchor in text:
            text = text.replace(anchor, anchor + timing, 1)
            print('[ok] server: added Server-Timing + slow API logging')
        else: print('[warn] server: express.json anchor not found')

    auth_cache = r'''
// MTD_PERF_V1: short-lived RBAC cache.
// PostgreSQL remains the source of truth; cache disappears with the serverless instance.
const applicationUserCache = new Map();
const APP_USER_CACHE_MS = Math.max(5000, Number(process.env.APP_USER_CACHE_MS || 30000));
async function loadApplicationUserCached(userId) {
  const key = String(userId || "");
  const now = Date.now();
  const hit = applicationUserCache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const value = await loadApplicationUser(userId);
  applicationUserCache.set(key, { value, expiresAt: now + APP_USER_CACHE_MS });
  return value;
}
function invalidateApplicationUserCache(userId = null) {
  if (userId) applicationUserCache.delete(String(userId));
  else applicationUserCache.clear();
}
'''
    if MARK + ': short-lived RBAC cache' not in text:
        anchor = 'async function requireAdminSession(req, res, next) {'
        if anchor in text:
            text = text.replace(anchor, auth_cache + '\n' + anchor, 1)
            print('[ok] server: added 30s RBAC cache')
        else: print('[warn] server: requireAdminSession anchor not found')

    old = '''    if (session.role !== "visitor" && session.userId) {
      await ensureUserManagementSchema();
      const access = await loadApplicationUser(session.userId);'''
    new = '''    if (session.role !== "visitor" && session.userId) {
      // MTD_PERF_V1: avoid production DDL on every cold serverless instance.
      if (String(process.env.AUTH_RUNTIME_SCHEMA_CHECKS || "") === "1") await ensureUserManagementSchema();
      const access = await loadApplicationUserCached(session.userId);'''
    text, _ = replace_once(text, old, new, 'server: optimized auth hot path')

    dashboard_cache = r'''
// MTD_PERF_V1: short dashboard response cache, separated by role.
const dashboardResponseCache = new Map();
const DASHBOARD_CACHE_MS = Math.max(5000, Number(process.env.DASHBOARD_CACHE_MS || 20000));
app.use("/api/dashboard/summary", (req, res, next) => {
  if (req.method !== "GET") return next();
  const cacheKey = String(req.adminSession?.role || "operator");
  const hit = dashboardResponseCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    res.setHeader("X-MTD-Cache", "HIT");
    return res.json(hit.payload);
  }
  const originalJson = res.json.bind(res);
  res.json = (payload) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      dashboardResponseCache.set(cacheKey, { payload, expiresAt: Date.now() + DASHBOARD_CACHE_MS });
      res.setHeader("X-MTD-Cache", "MISS");
    }
    return originalJson(payload);
  };
  next();
});
'''
    route_anchor = "app.get('/api/dashboard/summary', async (req, res) => {"
    if MARK + ': short dashboard response cache' not in text:
        if route_anchor in text:
            text = text.replace(route_anchor, dashboard_cache + '\n' + route_anchor, 1)
            print('[ok] server: added 20s dashboard cache')
        else: print('[warn] server: dashboard route anchor not found')

    old_schema = '''    await ensureUserManagementSchema();
    await ensurePetriDeletionWorkflowSchema();
    await ensureLcDeletionWorkflowSchema();
    await ensureIsoPetrisStorageSchema();
    await ensureLcPotWorkflowSchema();
    await ensureGrainWorkflowSchema();'''
    new_schema = '''    // MTD_PERF_V1: schema belongs in migrations, not the dashboard hot path.
    if (String(process.env.DASHBOARD_RUNTIME_SCHEMA_CHECKS || "") === "1") {
      await ensureUserManagementSchema();
      await ensurePetriDeletionWorkflowSchema();
      await ensureLcDeletionWorkflowSchema();
      await ensureIsoPetrisStorageSchema();
      await ensureLcPotWorkflowSchema();
      await ensureGrainWorkflowSchema();
    }'''
    text, _ = replace_once(text, old_schema, new_schema, 'server: removed dashboard runtime DDL')

    if text != original:
        backup(path); path.write_text(text, encoding='utf-8'); print('[saved]', path)
    else: print('[info] server: no changes needed')

def patch_shell(path):
    text = path.read_text(encoding='utf-8')
    original = text
    text, _ = replace_once(text,
        '  let searchTimer=null;\n  let iconRefreshTimer=null;',
        '  let searchTimer=null;\n  let iconRefreshTimer=null;\n  // MTD_PERF_V1: avoid duplicate approval fan-out.\n  let requestsLoadedAt=0;\n  let requestsLoading=false;',
        'shell: added approval fetch guards')

    text, _ = replace_once(text,
        "top.querySelector('#mtd-shell-bell').addEventListener('click',event=>{event.stopPropagation();notifications.classList.toggle('open')});",
        "top.querySelector('#mtd-shell-bell').addEventListener('click',event=>{event.stopPropagation();const opening=!notifications.classList.contains('open');notifications.classList.toggle('open');if(opening)loadRequests();});",
        'shell: lazy approval loading')

    old_start = "  async function loadRequests(){\n    const list=document.getElementById('mtd-shell-request-list');\n    try{"
    new_start = "  async function loadRequests(){\n    const list=document.getElementById('mtd-shell-request-list');\n    if(requestsLoading)return;\n    if(Date.now()-requestsLoadedAt<30000)return;\n    requestsLoading=true;\n    try{"
    text, _ = replace_once(text, old_start, new_start, 'shell: approval request dedupe')

    old_end = "    }catch(_){list.innerHTML='<div class=\"mtd-shell-empty\">Impossible de charger les demandes.</div>'}\n  }\n\n  function applySession(auth){"
    new_end = "    }catch(_){list.innerHTML='<div class=\"mtd-shell-empty\">Impossible de charger les demandes.</div>'}\n    finally{requestsLoading=false;requestsLoadedAt=Date.now();if(list)list.dataset.ready='1'}\n  }\n\n  function applySession(auth){"
    text, _ = replace_once(text, old_end, new_end, 'shell: approval request TTL')

    old_apply = "const bell=document.getElementById('mtd-shell-bell');if(bell){bell.hidden=!isAdmin;bell.style.display=isAdmin?'':'none';if(isAdmin)loadRequests();else document.getElementById('mtd-shell-notifications')?.classList.remove('open')}"
    new_apply = "const bell=document.getElementById('mtd-shell-bell');if(bell){bell.hidden=!isAdmin;bell.style.display=isAdmin?'':'none';if(isAdmin){const list=document.getElementById('mtd-shell-request-list');if(list&&!list.dataset.ready)list.innerHTML='<div class=\"mtd-shell-empty\">Ouvrez la cloche pour charger les demandes.</div>'}else document.getElementById('mtd-shell-notifications')?.classList.remove('open')}"
    text, _ = replace_once(text, old_apply, new_apply, 'shell: removed startup approval fan-out')

    # Replace loadSystemStatus by locating function boundaries up to bindSearch.
    if 'mtd:system-status:v1' not in text:
        a = text.find('  async function loadSystemStatus(){')
        b = text.find('\n  function bindSearch(){', a)
        if a >= 0 and b > a:
            new_status = r'''  async function loadSystemStatus(){
    const label=document.getElementById('mtd-system-label'),dot=document.getElementById('mtd-system-dot'),copy=document.getElementById('mtd-system-copy'),time=document.getElementById('mtd-system-time');
    const cacheKey='mtd:system-status:v1';
    const renderOk=(serverNow)=>{label.textContent='Opérationnel';dot.classList.remove('error');copy.textContent='PostgreSQL répond correctement. Données de production disponibles.';time.textContent=new Date(serverNow||Date.now()).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})};
    const renderError=()=>{label.textContent='Connexion limitée';dot.classList.add('error');copy.textContent='La base de données ne répond pas correctement. Certaines pages peuvent être indisponibles.';time.textContent='—'};
    try{const cached=JSON.parse(sessionStorage.getItem(cacheKey)||'null');if(cached&&Date.now()-Number(cached.at||0)<120000){cached.ok?renderOk(cached.now):renderError();return}}catch(_){}
    // MTD_PERF_V1: let the page's primary data request use the DB pool first.
    await sleep(800);
    try{const response=await fetch('/api/ping',{credentials:'same-origin',cache:'no-store'});const data=await response.json().catch(()=>({}));if(!response.ok||data.db!=='ok')throw new Error();renderOk(data.now);try{sessionStorage.setItem(cacheKey,JSON.stringify({at:Date.now(),ok:true,now:data.now||Date.now()}))}catch(_){}}
    catch(_){renderError();try{sessionStorage.setItem(cacheKey,JSON.stringify({at:Date.now(),ok:false}))}catch(_){}}
  }
'''
            text = text[:a] + new_status + text[b:]
            print('[ok] shell: cached/delayed /api/ping')
        else: print('[warn] shell: loadSystemStatus function not found')

    if text != original:
        backup(path); path.write_text(text, encoding='utf-8'); print('[saved]', path)
    else: print('[info] shell: no changes needed')

def main():
    root = Path(sys.argv[1] if len(sys.argv)>1 else '.').expanduser().resolve()
    if not root.exists(): raise SystemExit('Project folder not found: ' + str(root))
    server = locate(root, ['backend/server.js','server.js'])
    shell = locate(root, ['public/js/admin-dashboard-shell.js','js/admin-dashboard-shell.js'])
    if server: patch_server(server)
    else: print('[error] Could not find backend/server.js or server.js')
    if shell: patch_shell(shell)
    else: print('[warn] Could not find public/js/admin-dashboard-shell.js')
    print('\nDone. Run the SQL migration first, then deploy.')
    print('Recommended defaults: APP_USER_CACHE_MS=30000, DASHBOARD_CACHE_MS=20000')
    print('Leave AUTH_RUNTIME_SCHEMA_CHECKS and DASHBOARD_RUNTIME_SCHEMA_CHECKS unset in production.')

if __name__ == '__main__': main()
