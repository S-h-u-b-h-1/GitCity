/* Opt-in, same-browser public-city recovery after ephemeral server resets.
 * Stores sanitized, size-bounded PUBLIC city maps only. No session cookies,
 * CSRF tokens, guest IDs, AI responses, notes, issue details, or source text.
 * Does not restore live backend sessions or auto-import missing GitHub repos.
 */
(function(){
  'use strict';
  const KEY='gitcity:public-recovery-vault:v1';
  const OPT_IN='gitcity:public-recovery-opt-in:v1';
  const VERSION=1, MAX_CITIES=8, MAX_RECORD_CHARS=750_000, MAX_TOTAL_CHARS=3_000_000;
  function enabled(storage){
    try{return storage?.getItem?.(OPT_IN)==='1';}catch{return false;}
  }
  function setEnabled(storage,active){
    if(!storage?.setItem||!storage?.removeItem)throw Error('Browser storage is unavailable.');
    try{
      if(active)storage.setItem(OPT_IN,'1');else storage.removeItem(OPT_IN);
    }catch{throw Error('Browser storage is full or blocked.');}
    return enabled(storage);
  }
  function verify(record){
    if(!record||typeof record!=='object'||!Number.isFinite(record.savedAt)||
       record.savedAt<=0||record.savedAt>Date.now()+60_000)return null;
    const sanitizer=window.RepoWorldOfflineCity?.sanitize;
    if(typeof sanitizer!=='function')return null;
    try{
      const graph=sanitizer(record.graph);
      const repo=new URL(graph.url).pathname.slice(1);
      if(typeof record.repo!=='string'||record.repo.toLowerCase()!==repo.toLowerCase())return null;
      const output={repo,savedAt:record.savedAt,graph};
      return JSON.stringify(output).length<=MAX_RECORD_CHARS?output:null;
    }catch{return null;}
  }
  function load(storage){
    try{
      const raw=storage?.getItem?.(KEY);
      if(!raw||raw.length>MAX_TOTAL_CHARS)return [];
      const parsed=JSON.parse(raw);
      if(parsed?.version!==VERSION||!Array.isArray(parsed.cities)||parsed.cities.length>MAX_CITIES)return [];
      const seen=new Set(),cities=[];
      for(const row of parsed.cities){
        const safe=verify(row);
        const key=safe?.repo.toLowerCase();
        if(!key||seen.has(key))continue;
        seen.add(key);cities.push(safe);
      }
      return cities.sort((a,b)=>b.savedAt-a.savedAt);
    }catch{return [];}
  }
  function list(storage){
    return load(storage).map(record=>({repo:record.repo,savedAt:record.savedAt,
      moduleCount:record.graph.nodes.length}));
  }
  function open(storage,repo){
    if(typeof repo!=='string')return null;
    const match=load(storage).find(item=>item.repo.toLowerCase()===repo.toLowerCase());
    return match?{repo:match.repo,savedAt:match.savedAt,graph:match.graph}:null;
  }
  function capture(graph,storage){
    if(!enabled(storage))return {saved:false,reason:'not-enabled'};
    const sanitizer=window.RepoWorldOfflineCity?.sanitize;
    if(typeof sanitizer!=='function')throw Error('Public-map sanitizer is unavailable.');
    const safe=sanitizer(graph);
    const repo=new URL(safe.url).pathname.slice(1);
    const item={repo,savedAt:Date.now(),graph:safe};
    if(JSON.stringify(item).length>MAX_RECORD_CHARS)
      throw Error('This public city exceeds the browser recovery size limit.');
    const previous=load(storage);
    const all=[item,...previous.filter(x=>x.repo.toLowerCase()!==repo.toLowerCase())];
    const evicted=[];
    while(all.length>MAX_CITIES)evicted.push(all.pop().repo);
    let json=JSON.stringify({version:VERSION,cities:all});
    while(json.length>MAX_TOTAL_CHARS&&all.length>1){
      evicted.push(all.pop().repo);
      json=JSON.stringify({version:VERSION,cities:all});
    }
    if(json.length>MAX_TOTAL_CHARS)throw Error('This city exceeds the browser recovery storage limit.');
    try{storage.setItem(KEY,json);}
    catch{throw Error('Browser storage is full or blocked; the recovery vault was not updated.');}
    return {saved:true,repo,count:all.length,evicted};
  }
  function clear(storage){
    try{storage?.removeItem?.(KEY);return true;}catch{return false;}
  }
  window.GitCityRecoveryVault=Object.freeze({
    enabled,setEnabled,list,open,capture,clear,maxCities:MAX_CITIES,
    maxRecordChars:MAX_RECORD_CHARS,maxTotalChars:MAX_TOTAL_CHARS
  });
})();