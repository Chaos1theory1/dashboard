(function(){
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
