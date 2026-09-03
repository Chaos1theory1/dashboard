(function(){
  'use strict';

  const PAGE=((location.pathname||'').split('/').pop()||'').toLowerCase();
  if(PAGE!=='admin-myc-liquide.html') return;

  const API_BASE=window.location.origin;
  let rows=[];
  let search='';
  let statusFilter='ALL';
  let sourceFilter='ALL';

  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const norm=v=>String(v??'').trim().toUpperCase();

  function addStyles(){
    if(document.getElementById('lc-stock-overview-style')) return;
    const s=document.createElement('style');
    s.id='lc-stock-overview-style';
    s.textContent=`
      /* P3 stock viewport: about 2x the previous height */
      .banniere-historique-table{max-height:520px!important;}

      .lc-overview-card{background:#fff;padding:22px 24px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.07);margin:0 0 25px;width:calc(100% + 160px);margin-left:-80px;}
      .lc-overview-action{white-space:nowrap;}
      .lc-exhausted-btn{border:0;border-radius:8px;padding:7px 12px;background:#8a5a18;color:#fff;font-size:10px;font-weight:900;cursor:pointer;}
      .lc-exhausted-btn:hover:not(:disabled){background:#70470f;}
      .lc-exhausted-btn:disabled{background:#d6d9d7;color:#8a918c;cursor:not-allowed;opacity:.8;}
      .lc-overview-head{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:12px;}
      .lc-overview-head h4{margin:0;font-weight:900;color:#1f2a22;}
      .lc-overview-sub{font-size:12px;color:#6c746e;margin-top:4px;}
      .lc-overview-tools{display:flex;gap:9px;align-items:center;flex-wrap:wrap;}
      .lc-overview-search{min-width:260px;flex:1 1 300px;height:40px;border:1px solid #d5ddd8;border-radius:10px;padding:8px 12px;background:#fff;font-size:13px;}
      .lc-overview-select{height:40px;border:1px solid #d5ddd8;border-radius:10px;padding:7px 32px 7px 10px;background:#fff;font-size:12px;font-weight:700;color:#35433a;}
      .lc-overview-wrap{margin-top:12px;max-height:520px;overflow:auto;border:1px solid #e1e8e3;border-radius:11px;}
      .lc-overview-table{width:100%;border-collapse:collapse;font-size:12px;}
      .lc-overview-table thead th{position:sticky;top:0;z-index:2;background:#f0f5f1;color:#59655d;text-transform:uppercase;letter-spacing:.05em;font-size:10px;font-weight:900;padding:11px 10px;border-bottom:1px solid #d9e1db;text-align:left;}
      .lc-overview-table td{padding:10px;border-bottom:1px solid #e8ece9;vertical-align:middle;}
      .lc-overview-table tbody tr:hover{background:#f8fcf9;}
      .lc-overview-code{font-weight:900;color:#1f7a41;word-break:break-word;}
      .lc-overview-small{font-size:10px;color:#748078;margin-top:2px;}
      .lc-overview-badge{display:inline-flex;align-items:center;border-radius:999px;padding:4px 9px;font-size:10px;font-weight:900;white-space:nowrap;}
      .lc-st-fridge{background:#e8f4ff;color:#21618c;}
      .lc-st-valid{background:#dff5e8;color:#116b35;}
      .lc-st-incubation{background:#efe6ff;color:#4b2b83;}
      .lc-st-contam{background:#ffe1dd;color:#922b21;}
      .lc-st-active{background:#fff3cd;color:#856404;}
      .lc-overview-empty{text-align:center!important;padding:24px!important;color:#6c746e;}
      .lc-overview-count{font-size:11px;color:#6c746e;font-weight:700;margin-top:8px;}

      /* P3 table: sticky header + compact status filter inside the header */
      .banniere-historique-table table thead th{position:sticky!important;top:0!important;z-index:8!important;background:#f0f5f1!important;}
      .banniere-historique-table table thead{position:sticky!important;top:0!important;z-index:8!important;}
      .p3-status-filter-wrap{display:flex;align-items:center;gap:6px;white-space:nowrap;}
      .p3-status-filter-label{font:inherit;font-weight:900;color:inherit;}
      .p3-status-filter{width:auto!important;min-width:112px!important;height:28px!important;margin:0!important;padding:4px 24px 4px 7px!important;border:1px solid #cbd8cf!important;border-radius:7px!important;background:#fff!important;color:#35433a!important;font-size:10px!important;font-weight:800!important;}
      @media(max-width:1200px){.lc-overview-card{width:100%;margin-left:0;}}
      @media(max-width:760px){
        .banniere-historique-table{max-height:460px!important;}
        .lc-overview-card{padding:16px;}
        .lc-overview-tools{width:100%;}
        .lc-overview-search,.lc-overview-select{width:100%;min-width:0;}
        .lc-overview-wrap{max-height:480px;}
      }
    `;
    document.head.appendChild(s);
  }

  async function getJSON(path){
    const r=await fetch(API_BASE+path,{credentials:'same-origin',cache:'no-store'});
    const j=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(j.error||'Erreur API');
    return j;
  }

  function statusOf(p){
    const st=norm(p.status||p.statut);
    if(p.fridge_stored===true || p.fridge_stored_at) return {key:'FRIGO',label:'Frigo / stocké',cls:'lc-st-fridge'};
    if(st==='CONTAMINE') return {key:'CONTAMINE',label:'Contaminé',cls:'lc-st-contam'};
    if(p.lc_validated===true) return {key:'VALIDE',label:'LC validée',cls:'lc-st-valid'};
    if(['ACTIF','EN_INCUBATION','INCUBATION','ENSEMENCE','PREPARE'].includes(st) || !st) return {key:'INCUBATION',label:'Incubation',cls:'lc-st-incubation'};
    return {key:st||'ACTIF',label:st||'Actif',cls:'lc-st-active'};
  }

  function potCode(p,lot){
    if(p.code) return p.code;
    if(p.lc_pot_code) return p.lc_pot_code;
    const n=String(p.pot_number||p.numero||p.number||'').padStart(2,'0');
    return `${lot.code||('LC-'+lot.id)}${n?'-POT-'+n:''}`;
  }

  function sourceInfo(lot,p){
    const p3=lot.source_petri_id||p.source_petri_id;
    const iso=lot.iso_code||p.iso_code||'';
    return {
      key:p3?`P3-${p3}`:'AUTRE',
      main:p3?`P3-${p3}`:'—',
      sub:iso
    };
  }

  function injectCard(){
    if(document.getElementById('lc-stock-overview-card')) return;
    const anchor=document.querySelector('.banniere-historique');
    if(!anchor) return;
    const card=document.createElement('section');
    card.className='lc-overview-card';
    card.id='lc-stock-overview-card';
    card.innerHTML=`
      <div class="lc-overview-head">
        <div>
          <h4>Suivi des pots LC</h4>
          <div class="lc-overview-sub">Vue globale des pots LC en incubation, validés et conservés au frigo.</div>
        </div>
      </div>
      <div class="lc-overview-tools">
        <input id="lc-overview-search" class="lc-overview-search" type="search" placeholder="Rechercher LC, pot, lot, P3, isolation…" autocomplete="off">
        <select id="lc-overview-source" class="lc-overview-select" aria-label="Filtrer par source"><option value="ALL">Toutes les sources</option></select>
        <select id="lc-overview-status" class="lc-overview-select" aria-label="Filtrer par statut">
          <option value="ALL">Tous les statuts</option>
          <option value="INCUBATION">Incubation</option>
          <option value="VALIDE">LC validée</option>
          <option value="FRIGO">Frigo / stocké</option>
          <option value="CONTAMINE">Contaminé</option>
        </select>
      </div>
      <div class="lc-overview-wrap">
        <table class="lc-overview-table">
          <thead><tr><th>LC / Pot</th><th>Source</th><th>Lot LC</th><th>Statut</th><th>Conservation</th><th>Action</th></tr></thead>
          <tbody id="lc-overview-body"><tr><td colspan="6" class="lc-overview-empty">Chargement…</td></tr></tbody>
        </table>
      </div>
      <div id="lc-overview-count" class="lc-overview-count"></div>`;
    anchor.insertAdjacentElement('beforebegin',card);

    card.querySelector('#lc-overview-search').addEventListener('input',e=>{search=norm(e.target.value);render();});
    card.querySelector('#lc-overview-status').addEventListener('change',e=>{statusFilter=e.target.value;render();});
    card.querySelector('#lc-overview-source').addEventListener('change',e=>{sourceFilter=e.target.value;render();});
  }

  function conservationText(r){
    if(!r.pot.fridge_stored && !r.pot.fridge_stored_at) return '—';
    const stored=r.pot.fridge_stored_at?String(r.pot.fridge_stored_at).slice(0,10):'';
    const exp=r.pot.fridge_expiry_date?String(r.pot.fridge_expiry_date).slice(0,10):'';
    return `${stored?'Stocké '+esc(stored):'Frigo'}${exp?`<div class="lc-overview-small">Limite ${esc(exp)}</div>`:''}`;
  }

  function render(){
    const body=document.getElementById('lc-overview-body');
    if(!body) return;
    const filtered=rows.filter(r=>{
      if(statusFilter!=='ALL'&&r.status.key!==statusFilter) return false;
      if(sourceFilter!=='ALL'&&r.source.key!==sourceFilter) return false;
      if(search){
        const hay=norm([r.code,r.lot.code,r.source.main,r.source.sub,r.status.label,r.pot.status].join(' '));
        if(!hay.includes(search)) return false;
      }
      return true;
    });

    if(!filtered.length){
      body.innerHTML='<tr><td colspan="6" class="lc-overview-empty">Aucun pot LC correspondant aux filtres.</td></tr>';
    }else{
      body.innerHTML=filtered.map(r=>`<tr>
        <td><div class="lc-overview-code">${esc(r.code)}</div><div class="lc-overview-small">Pot #${esc(r.pot.pot_number||r.pot.numero||'—')}</div></td>
        <td><strong>${esc(r.source.main)}</strong>${r.source.sub?`<div class="lc-overview-small">${esc(r.source.sub)}</div>`:''}</td>
        <td>${esc(r.lot.code||('LC #'+r.lot.id))}</td>
        <td><span class="lc-overview-badge ${r.status.cls}">${esc(r.status.label)}</span></td>
        <td>${conservationText(r)}</td>
        <td class="lc-overview-action"><button type="button" class="lc-exhausted-btn" ${r.status.key==='FRIGO'?'':'disabled'} onclick="window.markLcPotExhausted(${Number(r.pot.id)},${Number(r.lot.id)})">✓ Épuisé</button></td>
      </tr>`).join('');
    }
    const count=document.getElementById('lc-overview-count');
    if(count) count.textContent=`${filtered.length} pot${filtered.length===1?'':'s'} affiché${filtered.length===1?'':'s'} sur ${rows.length}`;
  }

  function fillSources(){
    const sel=document.getElementById('lc-overview-source');
    if(!sel) return;
    const sources=[...new Set(rows.map(r=>r.source.key).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'fr'));
    sel.innerHTML='<option value="ALL">Toutes les sources</option>'+sources.map(k=>{
      const r=rows.find(x=>x.source.key===k);
      return `<option value="${esc(k)}">${esc(r?.source.main||k)}</option>`;
    }).join('');
  }

  async function load(){
    const body=document.getElementById('lc-overview-body');
    try{
      const lotsRaw=await getJSON('/api/lc-workflow/lots');
      const lots=Array.isArray(lotsRaw)?lotsRaw:[];
      const results=await Promise.all(lots.map(async lot=>{
        try{
          const potsRaw=await getJSON(`/api/lc-workflow/lots/${encodeURIComponent(lot.id)}/pots-status-today`);
          const pots=Array.isArray(potsRaw)?potsRaw:(Array.isArray(potsRaw.pots)?potsRaw.pots:[]);
          return pots.filter(p=>!p.deleted_at).map(p=>({lot,pot:p,code:potCode(p,lot),source:sourceInfo(lot,p),status:statusOf(p)}));
        }catch(_){return [];}
      }));
      rows=results.flat();
      fillSources();
      render();
    }catch(e){
      if(body) body.innerHTML=`<tr><td colspan="6" class="lc-overview-empty">Impossible de charger le suivi LC : ${esc(e.message)}</td></tr>`;
    }
  }

  let p3StatusFilter='ALL';
  let p3Observer=null;

  function getP3Table(){
    const wrap=document.querySelector('.banniere-historique-table');
    return wrap ? wrap.querySelector('table') : null;
  }

  function p3StatusFromRow(tr){
    if(!tr) return '';
    const cells=[...tr.querySelectorAll('td')];
    if(!cells.length) return '';
    const table=getP3Table();
    const headers=table?[...table.querySelectorAll('thead th')]:[];
    let idx=headers.findIndex(th=>norm(th.textContent).includes('STATUT'));
    if(idx<0) idx=cells.length-1;
    return norm(cells[idx]?.textContent||'');
  }

  function collectP3Statuses(){
    const table=getP3Table();
    if(!table) return [];
    return [...new Set([...table.querySelectorAll('tbody tr')].map(p3StatusFromRow).filter(Boolean))]
      .sort((a,b)=>a.localeCompare(b,'fr'));
  }

  function applyP3StatusFilter(){
    const table=getP3Table();
    if(!table) return;
    [...table.querySelectorAll('tbody tr')].forEach(tr=>{
      const status=p3StatusFromRow(tr);
      tr.style.display=(p3StatusFilter==='ALL'||status===p3StatusFilter)?'':'none';
    });
  }

  function ensureP3HeaderFilter(){
    const table=getP3Table();
    if(!table||!table.tHead) return;
    const headers=[...table.querySelectorAll('thead th')];
    let th=headers.find(el=>norm(el.textContent).includes('STATUT'));
    if(!th) return;

    const statuses=collectP3Statuses();
    let select=th.querySelector('#p3-stock-status-filter');
    if(!select){
      th.textContent='';
      const wrap=document.createElement('div');
      wrap.className='p3-status-filter-wrap';
      const label=document.createElement('span');
      label.className='p3-status-filter-label';
      label.textContent='STATUT';
      select=document.createElement('select');
      select.id='p3-stock-status-filter';
      select.className='p3-status-filter';
      select.setAttribute('aria-label','Filtrer les P3 par statut');
      select.addEventListener('change',e=>{p3StatusFilter=e.target.value;applyP3StatusFilter();});
      wrap.append(label,select);
      th.appendChild(wrap);
    }
    const current=p3StatusFilter;
    select.innerHTML='<option value="ALL">Tous</option>'+statuses.map(st=>`<option value="${esc(st)}">${esc(st.charAt(0)+st.slice(1).toLowerCase())}</option>`).join('');
    if([...select.options].some(o=>o.value===current)) select.value=current; else {p3StatusFilter='ALL';select.value='ALL';}
    applyP3StatusFilter();
  }

  function setupP3TableEnhancements(){
    const wrap=document.querySelector('.banniere-historique-table');
    if(!wrap) return;
    ensureP3HeaderFilter();
    if(p3Observer) p3Observer.disconnect();
    let queued=false;
    p3Observer=new MutationObserver(()=>{
      if(queued) return;
      queued=true;
      requestAnimationFrame(()=>{queued=false;ensureP3HeaderFilter();});
    });
    p3Observer.observe(wrap,{childList:true,subtree:true,characterData:true});
  }

  function init(){
    addStyles();
    injectCard();
    setupP3TableEnhancements();
    if(document.getElementById('lc-stock-overview-card')) load();
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init,{once:true}); else init();
})();
