/* GitCity — bounded, evidence-qualified PR review map.
   Only indexed changed files and sampled static imports. Never predicts defects. */
(function(){
'use strict';
const MAX_NODES=72, MAX_EDGES=1200;
const safe=(v,n=220)=>typeof v==='string'?v.slice(0,n):'';
const TEST_DIRECTORY=/(^|\/)(?:test|tests|__tests__|spec|specs)(?:\/|$)/i;
const isTest=n=>n?.kind==='test'||TEST_DIRECTORY.test(n?.path||'');
function build(graph,preview){
  const repo=window.GitCityPullImpact?.repositoryFromGraph?.(graph);
  if(!repo||typeof preview?.repository!=='string'||
     preview.repository.toLowerCase()!==repo.toLowerCase()||
     !window.GitCityPullImpact?.validPullNumber(preview.number)||
     !Array.isArray(preview.files))
    throw Error('A matching, public PR preview is required.');
  const nodes=(Array.isArray(graph.nodes)?graph.nodes:[]).slice(0,MAX_NODES)
    .filter(n=>n&&typeof n.id==='string'&&n.id.length<=200);
  const byId=new Map(nodes.map(n=>[n.id,n]));
  const changed=new Map();
  const evidence=new Set(['indexed-file','previous-file','directory-hint']);
  let unmapped=0;
  for(const file of preview.files.slice(0,300)){
    const mapping=file?.mapped, id=mapping?.nodeId;
    if(!byId.has(id)||!evidence.has(mapping.evidence)){unmapped++;continue;}
    if(!changed.has(id)){
      const node=byId.get(id);
      changed.set(id,{nodeId:id,name:safe(node.name||node.path||id,110),path:safe(node.path||id),
        kind:safe(node.kind,40),files:[],hasIndexed:false,hasPrevious:false,hasHint:false});
    }
    const entry=changed.get(id);
    if(entry.files.length<24)entry.files.push(safe(file.filename,450));
    entry.hasIndexed ||= mapping.evidence==='indexed-file';
    entry.hasPrevious ||= mapping.evidence==='previous-file';
    entry.hasHint ||= mapping.evidence==='directory-hint';
  }
  const byTarget=new Map(),seen=new Set();
  for(const edge of (Array.isArray(graph.edges)?graph.edges:[]).slice(0,MAX_EDGES)){
    if(!byId.has(edge?.source)||!byId.has(edge?.target)||edge.source===edge.target)continue;
    const key=edge.source+'\u0000'+edge.target;
    if(seen.has(key))continue;
    seen.add(key);
    const incoming=byTarget.get(edge.target)||[];
    incoming.push(edge.source);byTarget.set(edge.target,incoming);
  }
  // Import edge direction: source imports target. Traverse in reverse.
  const direct=new Map(),indirect=new Map(),support=new Set();
  for(const root of changed.keys()){
    for(const consumer of byTarget.get(root)||[]){
      if(changed.has(consumer))continue;
      if(!direct.has(consumer))direct.set(consumer,{id:consumer,chain:[consumer,root]});
      support.add(consumer+'\u0000'+root);
    }
  }
  for(const item of direct.values()){
    for(const consumer of byTarget.get(item.id)||[]){
      if(changed.has(consumer)||direct.has(consumer))continue;
      if(!indirect.has(consumer))indirect.set(consumer,{id:consumer,chain:[consumer,...item.chain]});
      support.add(consumer+'\u0000'+item.id);
    }
  }
  const describe=(item,hops)=>{
    const n=byId.get(item.id);
    return {nodeId:item.id,name:safe(n.name||n.path||item.id,110),path:safe(n.path||item.id),
      kind:safe(n.kind,40),hops,chain:item.chain.map(id=>safe(byId.get(id)?.path||id))};
  };
  const changedModules=[...changed.values()];
  const directImporters=[...direct.values()].map(x=>describe(x,1));
  const twoHopImporters=[...indirect.values()].map(x=>describe(x,2));
  const testCandidates=new Map();
  for(const c of changedModules)if(isTest(byId.get(c.nodeId)))
    testCandidates.set(c.nodeId,{nodeId:c.nodeId,name:c.name,path:c.path,
      chain:[c.path],hops:0,evidence:'changed-test-module'});
  for(const item of [...directImporters,...twoHopImporters])
    if(isTest(byId.get(item.nodeId))&&!testCandidates.has(item.nodeId))
      testCandidates.set(item.nodeId,{...item,evidence:'sampled-static-import'});
  const linkedEdges=[...support].map(key=>{
    const [source,target]=key.split('\u0000');return {source,target};
  });
  return {repository:repo,number:preview.number,changedModules,directImporters,twoHopImporters,
    testCandidates:[...testCandidates.values()],linkedEdges,sourceEdgeCount:seen.size,unmapped,
    partial:Boolean(preview.partial)||Boolean(preview.nextPage)||Boolean(preview.capped)||
      graph.nodes.length>MAX_NODES||graph.edges?.length>MAX_EDGES,
    disclaimer:'Possible review locations inferred from sampled static imports and a partial city map. No runtime impact, defect, or test result is verified.'};
}
function formatChecklist(plan){
  if(!plan||!Array.isArray(plan.changedModules)||!Array.isArray(plan.directImporters)||
     !window.GitCityPullImpact?.validPullNumber(plan.number))
    throw Error('No validated PR review plan is available.');
  const tick=String.fromCharCode(96);
  const code=value=>tick+safe(value,260).replace(new RegExp(tick,'g'),'\u02cb')+tick;
  const lines=['# GitCity PR #'+plan.number+' — review checklist',
    'Source: https://github.com/'+plan.repository+'/pull/'+plan.number,'',plan.disclaimer,'',
    '## Changed mapped modules ('+plan.changedModules.length+')'];
  if(!plan.changedModules.length)lines.push('- [ ] No changed file mapped; inspect the GitHub diff directly.');
  for(const item of plan.changedModules.slice(0,30)){
    const quality=item.hasIndexed?'exact indexed filename':item.hasPrevious?
      'previous indexed filename':'directory hint only';
    lines.push('- [ ] Review '+code(item.path)+' ('+quality+')');
  }
  lines.push('','## Possible direct importers ('+plan.directImporters.length+')');
  if(!plan.directImporters.length)lines.push('- [ ] No direct importer link observed in sampled imports.');
  for(const item of plan.directImporters.slice(0,20))
    lines.push('- [ ] Inspect '+item.chain.map(code).join(' → '));
  lines.push('','## Possible two-hop importers ('+plan.twoHopImporters.length+')');
  if(!plan.twoHopImporters.length)lines.push('- [ ] No two-hop importer link observed.');
  for(const item of plan.twoHopImporters.slice(0,15))
    lines.push('- [ ] Consider '+item.chain.map(code).join(' → '));
  lines.push('','## Relevant indexed tests ('+plan.testCandidates.length+')');
  if(!plan.testCandidates.length)lines.push('- [ ] No linked test module observed; inspect tests manually.');
  for(const item of plan.testCandidates.slice(0,15))
    lines.push('- [ ] Review '+code(item.path)+' ('+(item.evidence==='changed-test-module'?
      'changed test':'sampled static link')+')');
  lines.push('','- [ ] Inspect actual source changes and run relevant tests manually.');
  if(plan.partial)lines.push('- [ ] Review omitted or unindexed files in GitHub.');
  return lines.join('\n');
}
window.GitCityPRReview=Object.freeze({build,formatChecklist});
})();