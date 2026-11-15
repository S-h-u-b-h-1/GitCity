const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const base=path.join(__dirname,'../static');
function boot(){
 const window={},sandbox={window,URL,Date,console};
 vm.runInNewContext(fs.readFileSync(path.join(base,'offline-city.js'),'utf8'),sandbox);
 vm.runInNewContext(fs.readFileSync(path.join(base,'city-vault.js'),'utf8'),sandbox);
 return window.GitCityRecoveryVault;
}
function store(){
 const map=new Map();
 return {map,getItem:key=>map.has(key)?map.get(key):null,
   setItem:(key,value)=>map.set(key,String(value)),
   removeItem:key=>map.delete(key)};
}
const graph=(repo='public/repo')=>{
 const [owner,name]=repo.split('/');
 return {owner,name,url:'https://github.com/'+repo,source:'github',branch:'main',
 nodes:[{id:'src/core',path:'src/core',name:'Core',kind:'core',fileCount:3,
   files:['src/core/index.ts'],symbols:[{name:'handle',file:'src/core/index.ts'}]}],
 edges:[],warnings:[],stats:{modules:1}};
};
test('nothing persists by default; only explicit opt-in enables subsequent saves',()=>{
 const api=boot(),s=store();
 const p=api.capture(graph(),s);
 assert.equal(p.saved,false);
 assert.equal(api.list(s).length,0);
 assert.equal(s.map.size,0);
 assert.equal(api.setEnabled(s,true),true);
 assert.equal(api.enabled(s),true);
 const result=api.capture(graph(),s);
 assert.equal(result.saved,true);
 assert.equal(api.list(s).length,1);
 assert.equal(api.open(s,'public/repo').graph.nodes[0].name,'Core');
});
test('sanitizer removes cookies, provider keys and model data, including nested fields',()=>{
 const api=boot(),s=store();api.setEnabled(s,true);
 const g=graph();
 g.csrf='secret-should-not-store';g.session='cookie-should-not-store';
 g.nodes[0].token='sensitive-token';g.nodes[0].modelAnswer='large language output';
 g.nodes[0].files.push('.env'); // invalid public source files must fail validation
 assert.throws(()=>api.capture(g,s),/Invalid public file path/);
 assert.equal(api.list(s).length,0);
 g.nodes[0].files.pop();
 api.capture(g,s);
 const text=s.map.get('gitcity:public-recovery-vault:v1');
 for(const secret of ['secret-should-not-store','cookie-should-not-store','sensitive-token','large language output'])
   assert.ok(!text.includes(secret),secret);
 assert.equal(api.open(s,'public/repo').graph.stats.partial,true);
});
test('eight newest distinct public city snapshots retained, oldest evicted',()=>{
 const api=boot(),s=store();api.setEnabled(s,true);
 for(let i=0;i<11;i++){
   const result=api.capture(graph('owner/repo-'+i),s);
   assert.equal(result.saved,true);
 }
 const records=api.list(s);
 assert.equal(records.length,8);
 assert.equal(api.open(s,'owner/repo-0'),null);
 assert.equal(api.open(s,'owner/repo-10').repo,'owner/repo-10');
 assert.equal(records[0].repo,'owner/repo-10');
 assert.ok(records.every(x=>x.moduleCount===1));
});
test('corrupt, unsafe and cross-origin vault records cannot be used for recovery',()=>{
 const api=boot(),s=store();api.setEnabled(s,true);
 for(const raw of ['{','{"version":2,"cities":[]}',
   JSON.stringify({version:1,cities:[{repo:'safe/repo',savedAt:Date.now(),
     graph:{...graph('safe/repo'),url:'https://evil.example/safe/repo'}}]})]){
   s.setItem('gitcity:public-recovery-vault:v1',raw);
   assert.equal(api.list(s).length,0);
   assert.equal(api.open(s,'safe/repo'),null);
 }
 api.capture(graph('public/repo'),s);
 const record=JSON.parse(s.map.get('gitcity:public-recovery-vault:v1'));
 record.cities[0].graph.nodes[0].files=['../../../../secret'];
 s.setItem('gitcity:public-recovery-vault:v1',JSON.stringify(record));
 assert.equal(api.list(s).length,0);
});
test('disabled persistence retains existing snapshots until explicitly cleared',()=>{
 const api=boot(),s=store();api.setEnabled(s,true);
 api.capture(graph('public/repo'),s);
 api.setEnabled(s,false);
 assert.equal(api.enabled(s),false);
 assert.equal(api.capture(graph('owner/another'),s).saved,false);
 assert.equal(api.list(s).length,1);
 assert.ok(api.open(s,'PUBLIC/REPO'));
 assert.equal(api.clear(s),true);
 assert.equal(api.list(s).length,0);
});
test('blocked or full storage does not erase previous known-good maps',()=>{
 const api=boot(),s=store();api.setEnabled(s,true);
 api.capture(graph('public/repo'),s);
 const existing=s.map.get('gitcity:public-recovery-vault:v1');
 const blocked={getItem:s.getItem,setItem(){throw Error('quota reached');},removeItem:s.removeItem};
 assert.throws(()=>api.capture(graph('owner/another'),blocked),/full or blocked/);
 assert.equal(s.map.get('gitcity:public-recovery-vault:v1'),existing);
 assert.equal(api.list({getItem(){throw Error('blocked');}}).length,0);
 assert.equal(api.setEnabled(s,false),false);
});
test('rejects public snapshots that exceed per-city budget and never stores fictional cities',()=>{
 const api=boot(),s=store();api.setEnabled(s,true);
 const huge=graph();
 huge.nodes=Array.from({length:72},(_,i)=>({
   id:'dir-'+i,path:'dir-'+i,name:'Module '+i,kind:'core',fileCount:1,
   files:Array.from({length:16},(_,j)=>'p'+j+'/'+'x'.repeat(360)+'/'+i),symbols:[]
 }));
 assert.throws(()=>api.capture(huge,s),/browser recovery size limit/);
 assert.equal(api.list(s).length,0);
 assert.throws(()=>api.capture({...graph(),source:'demo'},s),/public GitHub/);
 assert.equal(api.list(s).length,0);
});
