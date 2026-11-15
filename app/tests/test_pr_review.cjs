const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const p=path.join(__dirname,'../static');
function runtime(){
  const w={},ctx={window:w,URL,setTimeout,clearTimeout,console};
  vm.runInNewContext(fs.readFileSync(path.join(p,'pr-impact.js'),'utf8'),ctx);
  vm.runInNewContext(fs.readFileSync(path.join(p,'pr-review.js'),'utf8'),ctx);
  return w;
}
const graph={source:'github',url:'https://github.com/public/demo',
  nodes:[
    {id:'core',path:'src/core',kind:'library',fileIndex:['src/core/lib.ts']},
    {id:'api',path:'src/api',kind:'api',files:['src/api/index.ts']},
    {id:'web',path:'apps/web',kind:'frontend',files:['apps/web/index.ts']},
    {id:'test',path:'tests/core',kind:'test',files:['tests/core/a.test.ts']},
    {id:'misc',path:'docs',kind:'docs',files:['docs/readme.md']}],
  edges:[{source:'api',target:'core',type:'import'},
    {source:'test',target:'core',type:'import'},
    {source:'web',target:'api',type:'import'}]};
const preview=(w,g,paths)=>w.GitCityPullImpact.analyze(g,25,paths.map(filename=>({
  filename,status:'modified',additions:1,deletions:0
})));
test('reverse static import edges produce direct, 2-hop, and linked tests only',()=>{
  const w=runtime(),p=preview(w,graph,['src/core/lib.ts','unmapped/something.ts']);
  const out=w.GitCityPRReview.build(graph,p);
  assert.equal(out.changedModules[0].nodeId,'core');
  assert.deepEqual(Array.from(out.directImporters.map(x=>x.nodeId)),['api','test']);
  assert.deepEqual(Array.from(out.twoHopImporters.map(x=>x.nodeId)),['web']);
  assert.deepEqual(Array.from(out.testCandidates.map(x=>x.nodeId)),['test']);
  assert.equal(out.unmapped,1);
  assert.equal(out.linkedEdges.length,3);
  assert.match(out.disclaimer,/No runtime impact/);
});
test('changed modules are excluded from importer suggestions, including cyclic links',()=>{
  const w=runtime(),g={...graph,edges:[...graph.edges,{source:'core',target:'api'}]};
  const out=w.GitCityPRReview.build(g,preview(w,g,['src/core/lib.ts','src/api/index.ts']));
  assert.deepEqual(Array.from(out.changedModules.map(x=>x.nodeId)),['core','api']);
  assert.deepEqual(Array.from(out.directImporters.map(x=>x.nodeId)),['test','web']);
  assert.equal(out.twoHopImporters.length,0);
});
test('without imports, review does not invent a blast radius or relevant tests',()=>{
  const w=runtime(),g={...graph,edges:[]};
  const plan=w.GitCityPRReview.build(g,preview(w,g,['src/core/lib.ts']));
  assert.equal(plan.directImporters.length,0);
  assert.equal(plan.twoHopImporters.length,0);
  assert.equal(plan.testCandidates.length,0);
  const notes=w.GitCityPRReview.formatChecklist(plan);
  assert.match(notes,/No linked test module observed/);
  assert.match(notes,/run relevant tests manually/);
});
test('test files changed directly are actionable without claiming execution',()=>{
  const w=runtime(),out=w.GitCityPRReview.build(graph,preview(w,graph,['tests/core/a.test.ts']));
  assert.equal(out.testCandidates.length,1);
  assert.equal(out.testCandidates[0].evidence,'changed-test-module');
});
test('directory-only hints are marked weaker than indexed path evidence',()=>{
  const w=runtime(),out=w.GitCityPRReview.build(graph,preview(w,graph,['src/core/new.ts']));
  assert.equal(out.changedModules[0].hasHint,true);
  assert.equal(out.changedModules[0].hasIndexed,false);
  assert.match(w.GitCityPRReview.formatChecklist(out),/directory hint only/);
});
test('invalid repository, unknown edge nodes, and malicious markup do not escalate',()=>{
  const w=runtime(),p=preview(w,graph,['src/core/lib.ts']);
  assert.throws(()=>w.GitCityPRReview.build(graph,{...p,repository:'other/repo'}));
  const injected={...graph,nodes:[...graph.nodes,{id:'evil',path:'<script>',kind:'test'}],
    edges:[{source:'evil',target:'non-existent'}]};
  const report=w.GitCityPRReview.build(injected,p);
  assert.equal(report.directImporters.length,0);
  assert.doesNotMatch(w.GitCityPRReview.formatChecklist(report),/<script>/);
});
