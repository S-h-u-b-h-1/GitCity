/* GitCity pull-request file preview — read-only browser GitHub metadata.
 * GitHub reports changed filenames; GitCity merely locates them on the
 * currently imported, possibly partial city. It does not predict defects.
 */
(function(){
  'use strict';
  const REPO=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
  const MAX_FILES=100;
  const VALID_STATUS=new Set(['added','modified','removed','renamed','copied','changed','unchanged']);
  function repositoryFromGraph(graph){
    if(graph?.source!=='github'||typeof graph.url!=='string')return null;
    try{
      const url=new URL(graph.url);
      if(url.protocol!=='https:'||url.hostname!=='github.com'||url.port||
         url.username||url.password||url.search||url.hash)return null;
      const full=url.pathname.replace(/^\/+|\/+$/g,'');
      if(!REPO.test(full)||['.','..'].includes(full.split('/')[1]))return null;
      return full;
    }catch{return null;}
  }
  function validPullNumber(number){
    const raw=typeof number==='number'?String(number):number;
    if(typeof raw!=='string'||!(/^[1-9][0-9]{0,8}$/.test(raw)))return null;
    return Number(raw);
  }
  // Accept a PR number, #number, or an exact GitHub /owner/repo/pull/number URL.
  // Reject URLs to other repositories and never permit embedded credentials.
  function pullNumberFromInput(graph,input){
    const repo=repositoryFromGraph(graph);
    if(!repo||typeof input!=='string')return null;
    const raw=input.trim();
    const simple=raw.startsWith('#')?raw.slice(1):raw;
    const numeric=validPullNumber(simple);
    if(numeric!==null)return numeric;
    if(!raw.startsWith('https://')||raw.length>300)return null;
    try{
      const parsed=new URL(raw);
      if(parsed.origin!=='https://github.com'||parsed.username||parsed.password||
         parsed.search||parsed.hash)return null;
      const match=/^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]{0,8})\/?$/.exec(parsed.pathname);
      if(!match||repo.toLowerCase()!==(match[1]+'/'+match[2]).toLowerCase())return null;
      return validPullNumber(match[3]);
    }catch{return null;}
  }
  function validPath(value){
    if(typeof value!=='string'||!value||value.length>450||value.startsWith('/')||
       value.includes('\\')||/[\x00-\x1f\x7f]/.test(value))return false;
    return value.split('/').every(part=>part&&part!=='.'&&part!=='..');
  }
  function normalizedNodePath(value){
    return typeof value==='string'&&validPath(value)?value:null;
  }
  function mapOneFile(graph,row){
    const filename=row.filename;
    let best=null;
    for(const node of (Array.isArray(graph?.nodes)?graph.nodes:[]).slice(0,72)){
      if(!node||typeof node.id!=='string')continue;
      const indexed=(Array.isArray(node.fileIndex)?node.fileIndex:node.files)||[];
      const known=new Set(indexed.slice(0,240).filter(validPath));
      let score=0,evidence='';
      if(known.has(filename)){score=3000+filename.length;evidence='indexed-file';}
      else if(row.status==='renamed'&&row.previousFilename&&known.has(row.previousFilename)){
        score=2000+row.previousFilename.length;evidence='previous-file';
      }else{
        const directory=normalizedNodePath(node.path);
        if(directory&&(filename.startsWith(directory+'/')||
            (row.previousFilename&&row.previousFilename.startsWith(directory+'/')))){
          score=1000+directory.length;evidence='directory-hint';
        }
      }
      if(score&&(best===null||score>best.score)){
        best={score,nodeId:node.id,nodeName:String(node.name||node.path||node.id).slice(0,110),
              nodePath:String(node.path||node.id).slice(0,260),evidence};
      }
    }
    return best?{nodeId:best.nodeId,nodeName:best.nodeName,nodePath:best.nodePath,evidence:best.evidence}:null;
  }
  function normalizeFile(row){
    if(!row||!validPath(row.filename)||!VALID_STATUS.has(row.status))return null;
    const previous=row.status==='renamed'&&validPath(row.previous_filename)?row.previous_filename:null;
    const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=10000000?value:null;
    return {filename:row.filename,status:row.status,previousFilename:previous,
            additions:count(row.additions),deletions:count(row.deletions)};
  }
  function analyze(graph,number,raw,hasNext=false){
    if(!repositoryFromGraph(graph))throw Error('Pull requests require an imported public GitHub city.');
    const id=validPullNumber(number);
    if(id===null)throw Error('Enter a valid positive GitHub pull request number.');
    if(!Array.isArray(raw))throw Error('GitHub returned an invalid pull-request file list.');
    const files=[],touched=new Set();let ignored=raw.length>MAX_FILES;
    for(const source of raw.slice(0,MAX_FILES)){
      const row=normalizeFile(source);
      if(!row){ignored=true;continue;}
      const mapped=mapOneFile(graph,row);
      files.push({...row,mapped});
      if(mapped)touched.add(mapped.nodeId);
    }
    return {number:id,repository:repositoryFromGraph(graph),files,
            partial:hasNext||raw.length>=MAX_FILES||ignored,
            mapped:files.filter(row=>row.mapped).length,
            unmapped:files.filter(row=>!row.mapped).length,
            moduleCount:touched.size,
            scope:'GitHub-reported changed files. Mappings use imported, potentially partial paths. Directory matches are hints only; no runtime impact or defect is verified.'};
  }
  async function load(graph,number){
    const repo=repositoryFromGraph(graph),id=validPullNumber(number);
    if(!repo)throw Error('Only saved, public GitHub repositories support pull-request previews.');
    if(id===null)throw Error('Enter a pull request number from 1 to 999999999.');
    const [owner,name]=repo.split('/');
    const url='https://api.github.com/repos/'+encodeURIComponent(owner)+'/'+encodeURIComponent(name)+
      '/pulls/'+id+'/files?per_page=100&page=1';
    const controller=typeof AbortController==='function'?new AbortController():null;
    const timer=controller?setTimeout(()=>controller.abort(),15000):null;
    let response;
    try{
      response=await fetch(url,{mode:'cors',credentials:'omit',redirect:'error',
        headers:{Accept:'application/vnd.github+json'},
        ...(controller?{signal:controller.signal}:{})});
    }catch{
      throw Error('GitHub pull-request files could not be fetched by this browser. Retry later.');
    }finally{if(timer!==null)clearTimeout(timer);}
    if(response.status===403||response.status===429)throw Error('GitHub is rate-limiting this browser. Retry after its API budget resets.');
    if(response.status===404)throw Error('Pull request not found or not publicly accessible.');
    if(!response.ok)throw Error('GitHub pull-request file endpoint returned HTTP '+response.status+'.');
    let rows;
    try{rows=await response.json();}catch{throw Error('GitHub returned unreadable pull-request data.');}
    const link=response.headers?.get?.('Link')||'';
    return analyze(graph,id,rows,/rel=["']?next/.test(link));
  }
  window.GitCityPullImpact=Object.freeze({
    repositoryFromGraph,validPullNumber,pullNumberFromInput,validPath,analyze,load
  });
})();