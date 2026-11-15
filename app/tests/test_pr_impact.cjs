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
 assert.equal(found.partial,true);
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
 await assert.rejects(limited.load(graph,45),/rate-limiting/);
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
