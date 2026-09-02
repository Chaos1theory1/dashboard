#!/usr/bin/env python3
from pathlib import Path
import re, sys, shutil

STAMP='20260902-stage2'

def backup(p: Path):
    b=p.with_name(p.name+'.'+STAMP+'.bak')
    if not b.exists(): shutil.copy2(p,b)
    return b

def locate(root, candidates):
    for rel in candidates:
        p=root/rel
        if p.exists(): return p
    return None

def detect_strain_tables(strains_text: str):
    tables=set(re.findall(r'\bstrain_[a-z0-9_]*requests\b', strains_text, flags=re.I))
    creation=next((t for t in tables if 'creation' in t.lower()), None)
    certification=next((t for t in tables if 'certification' in t.lower()), None)
    return creation, certification

def patch_heartbeat_guard(root: Path):
    public=root/'public'
    jsdir=public/'js'; jsdir.mkdir(parents=True, exist_ok=True)
    guard=jsdir/'mtd-heartbeat-guard.js'
    guard.write_text(r'''(function(){
  'use strict';
  if(window.__MTD_HEARTBEAT_GUARD__) return;
  window.__MTD_HEARTBEAT_GUARD__=true;

  const nativeFetch=window.fetch.bind(window);
  const HEARTBEAT_MS=60*60*1000;
  const KEY='mtd:last-heartbeat-at:v1';

  function urlOf(input){
    try{return new URL(typeof input==='string'?input:input.url,window.location.origin)}catch(_){return null}
  }
  function methodOf(input,init){return String((init&&init.method)||(input&&input.method)||'GET').toUpperCase()}
  function lastAt(){try{return Number(localStorage.getItem(KEY)||0)}catch(_){return 0}}
  function setNow(){try{localStorage.setItem(KEY,String(Date.now()))}catch(_){}}
  function clear(){try{localStorage.removeItem(KEY)}catch(_){}}

  window.fetch=async function(input,init){
    const url=urlOf(input),method=methodOf(input,init);
    if(!url||url.origin!==window.location.origin) return nativeFetch(input,init);

    if(url.pathname==='/api/auth/heartbeat' && method==='POST'){
      if(Date.now()-lastAt()<HEARTBEAT_MS){
        return new Response(null,{status:204,headers:{'X-MTD-Heartbeat-Skipped':'1'}});
      }
      const response=await nativeFetch(input,init);
      if(response.ok) setNow();
      return response;
    }

    if(['/api/auth/login','/api/auth/visitor','/api/auth/logout'].includes(url.pathname) && method==='POST'){
      const response=await nativeFetch(input,init);
      if(response.ok) clear();
      return response;
    }

    return nativeFetch(input,init);
  };
})();
''',encoding='utf-8')
    print(f'[saved] {guard}')

    marker='<script src="js/mtd-heartbeat-guard.js"></script>'
    auth_re=re.compile(r'(<script\s+src=["\']js/admin-auth\.js["\']\s*></script>)',re.I)
    changed=0
    for html in public.glob('*.html'):
        text=html.read_text(encoding='utf-8')
        if marker in text or not auth_re.search(text): continue
        backup(html)
        text=auth_re.sub(marker+'\n\\1',text,count=1)
        html.write_text(text,encoding='utf-8')
        changed+=1
    print(f'[ok] heartbeat guard inserted before admin-auth.js in {changed} HTML files')

def patch_server(server: Path, creation_table: str, cert_table: str):
    text=server.read_text(encoding='utf-8')
    original=text

    # Step 8 backend: online threshold 75 min everywhere it is used for last_seen_at presence.
    text,n=re.subn(r"last_seen_at\s*>=\s*now\(\)\s*-\s*interval\s*'\d+\s+minutes'",
                   "last_seen_at >= now()-interval '75 minutes'",text,flags=re.I)
    print(f'[ok] online threshold normalized to 75 minutes ({n} occurrence(s))')

    old_hb=re.compile(r"app\.post\('/api/auth/heartbeat',\s*async\s*\(req,\s*res\)\s*=>\s*\{.*?\n\}\);",re.S)
    new_hb="""app.post('/api/auth/heartbeat', async (req, res) => {
  if (!req.adminSession?.userId) return res.status(204).end();
  try {
    // MTD_STAGE2: browsers send at most once/hour; this WHERE is a second safety net
    // so older clients cannot repeatedly write last_seen_at.
    await realPool.query(`
      UPDATE app_users
         SET last_seen_at=now()
       WHERE auth_user_id=$1
         AND (last_seen_at IS NULL OR last_seen_at < now()-interval '55 minutes')
    `, [req.adminSession.userId]);
    res.status(204).end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});"""
    if 'MTD_STAGE2: browsers send at most once/hour' not in text:
        text,n=old_hb.subn(new_hb,text,count=1)
        if n!=1: raise RuntimeError('Could not locate /api/auth/heartbeat route safely.')
        print('[ok] heartbeat DB write protected with 55-minute server-side gate')
    else:
        print('[ok] heartbeat backend already patched')

    # Step 2 + 9: replace only dashboard route, preserving whatever schema-check preamble
    # the current project has before const isAdmin. This avoids undoing the previous performance patch.
    start=text.find("app.get('/api/dashboard/summary'")
    if start<0: raise RuntimeError('Could not find /api/dashboard/summary route.')
    end=text.find("// Search across real production entities used by the global dashboard header.",start)
    if end<0: raise RuntimeError('Could not find end of dashboard summary route.')
    old_route=text[start:end]

    isadmin_pos=old_route.find("    const isAdmin = req.adminSession?.role === 'admin';")
    if isadmin_pos<0: raise RuntimeError('Dashboard route shape differs: const isAdmin anchor missing.')
    prefix=old_route[:isadmin_pos]

    # preserve prior schema-check behavior exactly; route calculations below are replaced.
    route = prefix + f"""    const isAdmin = req.adminSession?.role === 'admin';
    const canWrite = req.adminSession?.role !== 'viewer';

    // MTD_STAGE2 STEP 2: one KPI round-trip instead of separate count queries.
    // Status distribution, seven-day trend and recent activity stay separate because they are
    // distinct datasets. Fresh admin dashboard: 4 SQL round-trips total instead of 14.
    const adminExtrasSql = isAdmin ? `
      , users AS (
          SELECT count(*) FILTER (WHERE active)::int AS active,
                 count(*) FILTER (WHERE active AND last_seen_at >= now()-interval '75 minutes')::int AS online,
                 count(*)::int AS total
          FROM app_users
        )
      , approvals AS (
          SELECT (
            (SELECT count(*) FROM photo_deletion_requests WHERE lower(COALESCE(status::text,'pending'))='pending') +
            (SELECT count(*) FROM petri_deletion_requests WHERE lower(COALESCE(status::text,'pending'))='pending') +
            (SELECT count(*) FROM lc_deletion_requests WHERE lower(COALESCE(status::text,'pending'))='pending') +
            (SELECT count(*) FROM grain_deletion_requests WHERE lower(COALESCE(status::text,'pending'))='pending') +
            (SELECT count(*) FROM {creation_table} WHERE lower(COALESCE(status::text,'pending'))='pending') +
            (SELECT count(*) FROM {cert_table} WHERE lower(COALESCE(status::text,'pending'))='pending')
          )::int AS total
        )
    ` : `
      , users AS (SELECT 0::int AS active,0::int AS online,0::int AS total)
      , approvals AS (SELECT 0::int AS total)
    `;

    const [kpiRows,statusRows,trendRows,recentRows] = await Promise.all([
      realPool.query(`
        WITH petri AS (
          SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS total,
                 count(*) FILTER (
                   WHERE deleted_at IS NULL
                     AND UPPER(COALESCE(status,'EN_INCUBATION')) NOT IN
                       ('STOCK_FRIGO','CONSERVATION_FRIGORIFIQUE','STOCK','CONSERVATION','VALIDE','PIQUE','PERIME','PERIMEE','SUPPRIME','A_DETRUIRE','CONTAMINE')
                 )::int AS active
          FROM iso_petris
        ), lc AS (
          SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS total,
                 count(*) FILTER (
                   WHERE deleted_at IS NULL
                     AND COALESCE(fridge_stored,FALSE)=FALSE
                     AND UPPER(COALESCE(status,'ACTIF')) NOT IN ('STOCK','UTILISE','SUPPRIME','REJETE','CONTAMINE')
                 )::int AS active,
                 count(*) FILTER (WHERE deleted_at IS NULL AND COALESCE(lc_validated,FALSE)=TRUE)::int AS validated
          FROM lc_pots
        ), grain AS (
          SELECT count(*)::int AS total,
                 count(*) FILTER (
                   WHERE storage_at IS NULL
                     AND UPPER(COALESCE(statut,'PREPARE')) NOT IN
                       ('STOCK','EN_STOCK','STOCKE','STOCKEE','FRIGO','SUPPRIME','CONTAMINE','UTILISE','PERIME','PERIMEE','REJETE')
                 )::int AS active
          FROM myc_grain_units
        ), strain AS (
          SELECT count(*) FILTER (WHERE COALESCE(status::text,'ACTIVE') <> 'ARCHIVED')::int AS active
          FROM strains
        ), last_j AS (
          SELECT DISTINCT ON (petri_id) petri_id,is_pickable,choices
          FROM iso_petri_journal
          ORDER BY petri_id,day_index DESC,treated_at DESC,id DESC
        ), p3 AS (
          SELECT count(*)::int AS ready
          FROM iso_petris p
          LEFT JOIN last_j lj ON lj.petri_id=p.id
          WHERE p.phase=3 AND p.deleted_at IS NULL
            AND (COALESCE(lj.is_pickable,FALSE)=TRUE OR COALESCE((lj.choices->>'is_pickable')::boolean,FALSE)=TRUE)
        )
        ${{adminExtrasSql}}
        SELECT petri.active AS petri_active,petri.total AS petri_total,
               lc.active AS lc_active,lc.total AS lc_total,lc.validated AS validated_lc,
               grain.active AS grain_active,grain.total AS grain_total,
               strain.active AS strains_active,p3.ready AS p3_ready,
               users.active AS users_active,users.online AS users_online,users.total AS users_total,
               approvals.total AS pending_approvals
        FROM petri CROSS JOIN lc CROSS JOIN grain CROSS JOIN strain CROSS JOIN p3 CROSS JOIN users CROSS JOIN approvals
      `),
      realPool.query(`
        WITH classified AS (
          SELECT CASE
            WHEN deleted_at IS NOT NULL OR UPPER(COALESCE(status,'')) IN ('SUPPRIME','PIQUE','UTILISE') THEN 'Retiré / terminé'
            WHEN UPPER(COALESCE(status,'')) IN ('CONTAMINE','PERIME','PERIMEE','A_DETRUIRE') THEN 'À surveiller'
            WHEN UPPER(COALESCE(status,'')) IN ('STOCK_FRIGO','CONSERVATION_FRIGORIFIQUE','STOCK','CONSERVATION') THEN 'Stock / conservation'
            WHEN UPPER(COALESCE(status,'')) IN ('VALIDE','VALIDÉ','PRETE','PRET') THEN 'Prêt / validé'
            ELSE 'En cours' END AS category
          FROM iso_petris
          UNION ALL
          SELECT CASE
            WHEN deleted_at IS NOT NULL OR UPPER(COALESCE(status,'')) IN ('SUPPRIME','UTILISE') THEN 'Retiré / terminé'
            WHEN UPPER(COALESCE(status,'')) IN ('CONTAMINE','REJETE','PERIME','PERIMEE') THEN 'À surveiller'
            WHEN COALESCE(fridge_stored,FALSE)=TRUE OR UPPER(COALESCE(status,''))='STOCK' THEN 'Stock / conservation'
            WHEN COALESCE(lc_validated,FALSE)=TRUE OR UPPER(COALESCE(status,'')) IN ('LC_VALIDEE','PRET','PRETE') THEN 'Prêt / validé'
            ELSE 'En cours' END AS category
          FROM lc_pots
          UNION ALL
          SELECT CASE
            WHEN UPPER(COALESCE(statut,'')) IN ('SUPPRIME','UTILISE') THEN 'Retiré / terminé'
            WHEN UPPER(COALESCE(statut,'')) IN ('CONTAMINE','REJETE','PERIME','PERIMEE') THEN 'À surveiller'
            WHEN UPPER(COALESCE(statut,'')) IN ('STOCK','EN_STOCK','STOCKE','STOCKEE','FRIGO') OR storage_at IS NOT NULL THEN 'Stock / conservation'
            WHEN UPPER(COALESCE(statut,'')) IN ('PRET','PRETE','VALIDE','VALIDÉ') THEN 'Prêt / validé'
            ELSE 'En cours' END AS category
          FROM myc_grain_units
        )
        SELECT category AS status,count(*)::int AS total
        FROM classified GROUP BY category
        ORDER BY CASE category WHEN 'En cours' THEN 1 WHEN 'Prêt / validé' THEN 2 WHEN 'Stock / conservation' THEN 3 WHEN 'À surveiller' THEN 4 ELSE 5 END
      `),
      realPool.query(`
        WITH days AS (
          SELECT generate_series(CURRENT_DATE - 6,CURRENT_DATE,interval '1 day')::date AS activity_day
        ), petri AS (
          SELECT COALESCE(treated_at::date,updated_at::date,created_at::date,journal_date::date) AS activity_day,count(*)::int AS total
          FROM iso_petri_journal
          WHERE COALESCE(treated_at::date,updated_at::date,created_at::date,journal_date::date) >= CURRENT_DATE - 6
          GROUP BY 1
        ), lc AS (
          SELECT treated_at::date AS activity_day,count(*)::int AS total
          FROM lc_pot_journal WHERE treated_at::date >= CURRENT_DATE - 6 GROUP BY 1
        ), grain AS (
          SELECT (treated_at AT TIME ZONE 'Europe/Berlin')::date AS activity_day,count(*)::int AS total
          FROM myc_grain_journal WHERE (treated_at AT TIME ZONE 'Europe/Berlin')::date >= CURRENT_DATE - 6 GROUP BY 1
        )
        SELECT to_char(days.activity_day,'YYYY-MM-DD') AS day,
               COALESCE(petri.total,0)::int AS petri,COALESCE(lc.total,0)::int AS lc,COALESCE(grain.total,0)::int AS grain
        FROM days LEFT JOIN petri USING(activity_day) LEFT JOIN lc USING(activity_day) LEFT JOIN grain USING(activity_day)
        ORDER BY days.activity_day
      `),
      realPool.query(`
        SELECT id,actor_name,actor_role,module,action_type,item_id,item_label,day_index,created_at
        FROM production_activity_log ORDER BY created_at DESC,id DESC LIMIT 8
      `)
    ]);

    const k=kpiRows.rows[0] || {{}};
    const p3Ready=Number(k.p3_ready||0);
    const validatedLc=Number(k.validated_lc||0);
    const activeStrains=Number(k.strains_active||0);
    const pendingApprovals=Number(k.pending_approvals||0);
    const userSummary={{active:Number(k.users_active||0),online:Number(k.users_online||0),total:Number(k.users_total||0)}};

    const quickActions=[
      {{id:'scan-petri',label:'Scanner une boîte',description:'Ouvrir un journal Petri par QR ou identifiant.',href:'admin-isolement.html#scan-inline-card',icon:'scan-line',enabled:true,badge:`${{Number(k.petri_active||0)}} actives`}},
      {{id:'new-isolation',label:'Nouvel isolement',description:'Créer une isolation et ses premières boîtes.',href:'admin-isolement.html?action=new-isolation',icon:'flask-conical',enabled:canWrite,badge:canWrite?'Disponible':'Lecture seule'}},
      {{id:'new-lc',label:'Créer un lot LC',description:p3Ready?`${{p3Ready}} P3 transférable${{p3Ready>1?'s':''}}.`:'Aucun P3 transférable actuellement.',href:'admin-myc-liquide.html#p3-ready-body',icon:'beaker',enabled:canWrite&&p3Ready>0,badge:`${{p3Ready}} P3 prêt${{p3Ready>1?'s':''}}`}},
      {{id:'new-grain',label:'Préparer du grain',description:(validatedLc||p3Ready)?`${{validatedLc}} LC validée${{validatedLc>1?'s':''}} · ${{p3Ready}} P3 prêt${{p3Ready>1?'s':''}}.`:'Aucune LC validée ni P3 transférable actuellement.',href:'admin-myc-grain.html',icon:'wheat',enabled:canWrite&&(validatedLc>0||p3Ready>0),badge:`${{validatedLc}} LC · ${{p3Ready}} P3`}}
    ];
    if(isAdmin) quickActions.push({{
      id:'users',label:'Gérer les utilisateurs',
      description:pendingApprovals?`${{pendingApprovals}} demande${{pendingApprovals>1?'s':''}} d’approbation à examiner.`:'Rôles, accès et approbations.',
      href:'admin-users.html',icon:'users',enabled:true,badge:`${{userSummary.online}} en ligne`
    }});

    return res.json({{
      generated_at:new Date().toISOString(),
      counts:{{
        petri_active:Number(k.petri_active||0),lc_active:Number(k.lc_active||0),grain_active:Number(k.grain_active||0),
        petri_total:Number(k.petri_total||0),lc_total:Number(k.lc_total||0),grain_total:Number(k.grain_total||0),
        strains_active:activeStrains,p3_ready:p3Ready,validated_lc:validatedLc,
        pending_approvals:pendingApprovals,
        // compatibility for any older frontend code; now means ALL approval types, not deletions only.
        pending_deletions:pendingApprovals
      }},
      users:isAdmin?{{total:userSummary.total,active:userSummary.active,online:userSummary.online}}:null,
      status_distribution:statusRows.rows,activity_trend:trendRows.rows,recent_activity:recentRows.rows,quick_actions:quickActions,
      sources:{{
        kpis:['iso_petris','lc_pots','myc_grain_units','strains','app_users'],
        approvals:['photo_deletion_requests','petri_deletion_requests','lc_deletion_requests','grain_deletion_requests','{creation_table}','{cert_table}'],
        activity_trend:['iso_petri_journal','lc_pot_journal','myc_grain_journal'],status_distribution:['iso_petris','lc_pots','myc_grain_units'],
        recent_activity:['production_activity_log'],users:['app_users','app_roles'],quick_actions:['iso_petris','iso_petri_journal','lc_pots']
      }},
      definitions:{{
        petri_active:'Boîtes non supprimées hors stockage, conservation, validation, retrait ou contamination.',
        lc_active:'Pots non supprimés, non stockés et hors utilisation, rejet ou contamination.',
        grain_active:'Unités hors stock, utilisation, retrait, péremption ou contamination.',
        activity_trend:'Nombre réel d’entrées de journal enregistrées par jour sur Petri, LC et grain.'
      }}
    }});
  }} catch (e) {{
    console.error('Dashboard summary:',e);
    return res.status(500).json({{error:'Impossible de charger les données réelles du tableau de bord.'}});
  }}
}});

"""
    text=text[:start]+route+text[end:]
    print(f'[ok] dashboard summary consolidated; approvals include {creation_table} + {cert_table}')

    if text!=original:
        backup(server)
        server.write_text(text,encoding='utf-8')
        print(f'[saved] {server}')
    else:
        print('[info] server already up to date')


def main():
    root=Path(sys.argv[1] if len(sys.argv)>1 else '.').expanduser().resolve()
    if not root.exists(): raise SystemExit(f'Project folder not found: {root}')
    server=locate(root,['backend/server.js','server.js'])
    strains=locate(root,['backend/routes/strains.js','routes/strains.js'])
    if not server: raise SystemExit('Could not find backend/server.js')
    if not strains: raise SystemExit('Could not find backend/routes/strains.js; required to verify approval table names safely.')

    strains_text=strains.read_text(encoding='utf-8')
    creation,cert=detect_strain_tables(strains_text)
    if not creation or not cert:
        raise SystemExit('Could not safely detect both strain creation/certification request table names from routes/strains.js. No files were changed.')
    print(f'[detected] strain creation table: {creation}')
    print(f'[detected] strain certification table: {cert}')

    patch_server(server,creation,cert)
    patch_heartbeat_guard(root)
    print('\nDone.')
    print('Step 2: dashboard fresh-load SQL round-trips reduced from 14 to 4 for admin.')
    print('Step 8: actual browser heartbeat capped at once every 60 minutes; online threshold 75 minutes.')
    print('Step 9: dashboard pending approval count now includes deletion + strain creation + strain certification queues.')
    print('Next: deploy/test, then inspect Step 12 separately (runtime ensure...Schema calls).')

if __name__=='__main__': main()
