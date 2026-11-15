const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../static/pr-impact.js'),'utf8');
const graph={source:'github',url:'https://github.com/public/demo',nodes:[
 {id:'api',name:'API',path:'services/api',fileIndex:['services/api/main.py','services/api/old.py']},
 {id:'web',name:'Web',path:'apps/web',files:['apps/web/index.ts']},
]};
function runtime(fetchStub){
 const window={};
 const sb={window,URL,setTimeout,clearTimeout,console};
 if(fetchStub)sb.fetch=fetchStub;
 vm.runInNewContext(source,sb);
 return window.GitCityPullImpact;
}
test('PR number/repository/path validation rejects external and unsafe inputs',()=>{
 const p=runtime();
 assert.equal(p.repositoryFromGraph(graph),'public/demo');
 for(const url of ['http://github.com/public/demo','https://evil.example/public/demo',
                    'https://github.com/public/demo?token=x',
                    'https://user:secret@github.com/public/demo',
                    'https://github.com/public/demo/extra']){
   assert.equal(p.repositoryFromGraph({...graph,url}),null,url);
 }
 for(const num of [0,-1,1.5,'0','01','1/2','1?','9999999999','<script>','Infinity',null]){
   assert.equal(p.validPullNumber(num),null,String(num));
 }
 assert.equal(p.validPullNumber(25),25);
 for(const name of ['/etc/passwd','src/../secret','src\\test','bad\0name','', 'a'.repeat(500)]){
   assert.equal(p.validPath(name),false,name);
 }
});
test('PR number and canonical GitHub PR URLs stay bound to the current graph',()=>{
 const p=runtime();
 assert.equal(p.pullNumberFromInput(graph,'#25'),25);
 assert.equal(p.pullNumberFromInput(graph,'25'),25);
 assert.equal(p.pullNumberFromInput(graph,'https://github.com/PUBLIC/demo/pull/25'),25);
 for(const input of [
   'https://github.com/attacker/demo/pull/25',
   'https://github.com/public/demo/issues/25',
   'https://github.com/public/demo/pull/25?token=x',
   'https://user:pw@github.com/public/demo/pull/25',
   '#0', 'not-an-id', '<script>alert(1)</script>'
 ])assert.equal(p.pullNumberFromInput(graph,input),null,input);
});
test('actual changed indexed files, renamed paths, directory hints and unmatched files stay distinct',()=>{
 const p=runtime();
 const found=p.analyze(graph,25,[
  {filename:'services/api/main.py',status:'modified',additions:7,deletions:4},
  {filename:'services/api/new.py',previous_filename:'services/api/old.py',status:'renamed',additions:2,deletions:1},
  {filename:'apps/web/feature.ts',status:'added',additions:10,deletions:0},
  {filename:'unindexed/README.md',status:'removed',additions:0,deletions:4},
  {filename:'services/api/../../secret',status:'modified',additions:999,deletions:0},
 ]);
 assert.equal(found.number,25);
 assert.equal(found.files.length,4);
 assert.equal(found.mapped,3);
 assert.equal(found.unmapped,1);
 assert.equal(found.moduleCount,2);
 assert.deepEqual(Array.from(found.files.map(x=>x.mapped?.evidence||null)),
                 ['indexed-file','previous-file','directory-hint',null]);
 assert.ok(found.scope.includes('no runtime impact'));
});
test('changing file names never fabricates a module match; partial listings remain disclosed',()=>{
 const p=runtime();
 const rows=Array.from({length:100},(_,i)=>({filename:'external/file'+i+'.ts',
   status:'modified',additions:1,deletions:0}));
 const found=p.analyze(graph,2,rows);
 assert.equal(found.partial,false,'Exactly 100 files with no next-page link is complete');
 assert.equal(found.mapped,0);
 assert.equal(found.unmapped,100);
});
test('browser request is public read-only, bounded, origin-checked and honest on provider quota',async()=>{
 const calls=[];
 const p=runtime(async(url,opts)=>{
  calls.push({url,opts});
  return {status:200,ok:true,headers:{get:k=>null},
    json:async()=>[{filename:'services/api/main.py',status:'modified',additions:1,deletions:1}]};
 });
 const out=await p.load(graph,45);
 assert.equal(out.mapped,1);
 assert.equal(calls[0].url,'https://api.github.com/repos/public/demo/pulls/45/files?per_page=100&page=1');
 assert.equal(calls[0].opts.credentials,'omit');
 assert.equal(calls[0].opts.mode,'cors');
 assert.equal(calls[0].opts.redirect,'error');
 assert.ok(!calls[0].opts.headers.Authorization);
 const limited=runtime(async()=>({status:429,ok:false,headers:{get:()=>null}}));
 await assert.rejects(limited.load(graph,45),/denied or rate-limited/);
 const privatePR=runtime(async()=>({status:404,ok:false,headers:{get:()=>null}}));
 await assert.rejects(privatePR.load(graph,45),/not found/);
});
test('PR response cannot inject HTML or unsupported statuses into city changes',()=>{
 const p=runtime();
 const bad=p.analyze(graph,17,[
  {filename:'<img src=x onerror=alert(1)>',status:'modified',additions:0,deletions:0},
  {filename:'api/unknown',status:'unexpected',additions:1,deletions:0},
  {filename:'services/api/main.py',status:'modified',additions:1e20,deletions:-100},
 ]);
 assert.equal(bad.files.length,2); // the first is a valid literal filename but never HTML.
 assert.equal(bad.files[0].mapped,null);
 assert.equal(bad.files[1].additions,null);
 assert.equal(bad.files[1].deletions,null);
});

test('GitHub PR pages load on demand and merge actual file mapping',async()=>{
 const requests=[];
 const p=runtime(async(url,opts)=>{
   requests.push(url);
   const page=new URL(url).searchParams.get('page');
   const rows=page==='1'
     ?Array.from({length:100},(_,i)=>({filename:'outside/file-'+i+'.ts',status:'modified',additions:1,deletions:0}))
     :[{filename:'services/api/main.py',status:'modified',additions:3,deletions:2}];
   const next=page==='1'?'<https://api.github.com/repos/public/demo/pulls/25/files?per_page=100&page=2>; rel="next"':'';
   return {status:200,ok:true,headers:{get:key=>key==='Link'?next:null},
     json:async()=>rows};
 });
 const first=await p.load(graph,25);
 assert.equal(first.files.length,100);
 assert.equal(first.partial,true);
 assert.equal(first.nextPage,2);
 assert.equal(first.mapped,0);
 assert.equal(requests.length,1,'No second page without explicit action');
 const second=await p.loadMore(graph,first);
 assert.equal(second.files.length,101);
 assert.equal(second.mapped,1);
 assert.equal(second.nextPage,null);
 assert.equal(second.partial,false);
 assert.equal(requests.length,2);
 assert.match(requests[1],/page=2$/);
});

test('PR API page limit is three pages with explicit remainder warning',async()=>{
 const requests=[];
 const p=runtime(async(url,opts)=>{
   requests.push(url);
   const page=Number(new URL(url).searchParams.get('page'));
   const rows=Array.from({length:100},(_,i)=>({
     filename:'other/file-'+page+'-'+i+'.py',status:'modified',additions:0,deletions:0
   }));
   return {status:200,ok:true,
     headers:{get:key=>key==='Link'?'<https://api.github.com/repos/public/demo/pulls/7/files?per_page=100&page='+(page+1)+'>; rel="next"':null},
     json:async()=>rows};
 });
 const first=await p.load(graph,7);
 const second=await p.loadMore(graph,first);
 const third=await p.loadMore(graph,second);
 assert.equal(third.files.length,300);
 assert.equal(third.nextPage,null);
 assert.equal(third.partial,true);
 assert.equal(third.capped,true);
 assert.equal(requests.length,3);
 await assert.rejects(p.loadMore(graph,third),/no longer current/);
 assert.equal(requests.length,3);
});

test('PR pagination rejects stale repository context and impossible page values',async()=>{
 const p=runtime(async()=>{throw Error('Must not fetch');});
 await assert.rejects(p.loadMore(graph,{repository:'attacker/repo',number:7,nextPage:2,files:[]}),
   /no longer current/);
 await assert.rejects(p.loadMore(graph,{repository:'public/demo',number:7,nextPage:99,files:[]}),
   /no longer current/);
});
