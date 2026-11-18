/* RepoWorld Neon City: dependency-free, perspective-3D canvas renderer.
 * Districts group modules by heuristic path classification. Glowing links are
 * sampled STATIC IMPORTS, never asserted to be observed runtime traffic.
 */
(function () {
  'use strict';
  const COLORS = Object.freeze({
    frontend:'#a4a6ed', api:'#74b6e9', service:'#79cdb5', library:'#8ccfe0',
    database:'#abd589', security:'#e5a1b3', infra:'#dfaa84',
    test:'#c3a0dd', docs:'#b3c0cd', core:'#e6c58d',
  });
  const DISTRICTS = Object.freeze({
    frontend:{name:'Frontend Boulevard',short:'Frontend',hint:'User interfaces, screens and components',icon:'◈'},
    api:{name:'API Heights',short:'API',hint:'Routes and interfaces to other services',icon:'⬡'},
    service:{name:'Service Quarter',short:'Services',hint:'Application and business-logic modules',icon:'◇'},
    database:{name:'Data Harbor',short:'Data',hint:'Storage, schema and state-related files',icon:'▥'},
    library:{name:'Utility Alley',short:'Libraries',hint:'Shared code, packages and helpers',icon:'✳'},
    security:{name:'Identity Ward',short:'Security',hint:'Security- and authentication-related paths',icon:'◆'},
    infra:{name:'Infra Grid',short:'Infrastructure',hint:'Deployment and infrastructure configuration',icon:'▦'},
    test:{name:'Test Sector',short:'Tests',hint:'Test suites and validation tooling',icon:'✦'},
    docs:{name:'Archive Row',short:'Docs',hint:'Documentation and design notes',icon:'☷'},
    core:{name:'Core Nexus',short:'Core',hint:'Repository root and foundational modules',icon:'◎'},
  });
  const DISTRICT_ORDER = ['frontend','api','service','library','database','core','security','infra','test','docs'];
  const PI2=Math.PI*2;
  const MIN_CAMERA_DISTANCE=36, MAX_CAMERA_DISTANCE=850;
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  function rgb(hex){const c=(hex||'#ffffff').replace('#','');return [parseInt(c.slice(0,2),16)||0,parseInt(c.slice(2,4),16)||0,parseInt(c.slice(4,6),16)||0];}
  function rgba(hex,opacity){const [r,g,b]=rgb(hex);return `rgba(${r},${g},${b},${opacity})`;}
  function mix(from,to,t){const a=rgb(from),b=rgb(to);return `rgb(${a.map((v,i)=>Math.round(v*(1-t)+b[i]*t)).join(',')})`;}
  function hash(s){let h=2166136261;for(let i=0;i<String(s).length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0)/4294967295;}
  function rounded(ctx,x,y,w,h,r){if(w>0&&h>0){ctx.beginPath();ctx.roundRect(x,y,w,h,Math.max(0,Math.min(r,w/2,h/2)));}}
  function poly(ctx,points){ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();}

  class RepoWorldRenderer {
    constructor(canvas, options={}){
      this.canvas=canvas;this.ctx=canvas.getContext('2d');
      this.onSelect=options.onSelect||(()=>{});this.onIssueSelect=options.onIssueSelect||(()=>{});this.onDistrictSelect=options.onDistrictSelect||(()=>{});this.onHover=options.onHover||(()=>{});
      this.nodes=[];this.edges=[];this.districts=[];this.hotspots=[];this.mode='structure';this.selected=null;this.hovered=null;this.impact=null;this.prChangedNodes=new Set();this.prDirectNodes=new Set();this.prIndirectNodes=new Set();this.prReviewEdges=new Set();this.issueMarkers=new Map();this.districtHitAreas=[];
      this.view='city';this.moduleFilter=null;this.neighbors=new Map();
      this.yaw=-.71;this.pitch=.85;this.distance=140;this.targetDistance=140;this.overviewDistance=140;this.zoomAnchor=null;
      this.pan={x:0,z:0};this.targetPan={x:0,z:0};this.activeDistrict=null;
      this.width=0;this.height=0;this.pixelRatio=1;this.spin=false;this.traffic=true;
      this.isDragging=false;this.dragDistance=0;this.hitAreas=[];this.issueHitAreas=[];this.time=0;
      this.pendingCompactSelection=null;
      this.touchPointers=new Map();this.pinchDistance=0;this.pinchHappened=false;
      this.motion=!!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      this.tooltip=document.getElementById('sceneTooltip');
      this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(canvas);
      this.addEvents();this.resize();this.render();
    }
    resize(){
      const rect=this.canvas.getBoundingClientRect();
      const atOverview=this.targetDistance===this.overviewDistance&&this.targetPan.x===0&&this.targetPan.z===0;
      this.width=Math.max(100,rect.width);this.height=Math.max(100,rect.height);
      this.pixelRatio=Math.min(window.devicePixelRatio||1,2);
      this.canvas.width=Math.round(this.width*this.pixelRatio);
      this.canvas.height=Math.round(this.height*this.pixelRatio);
      this.ctx.setTransform(this.pixelRatio,0,0,this.pixelRatio,0,0);
      this.lastPaintAt=null;
      if(this.districts.length&&rect.width&&rect.height){
        this.overviewDistance=this.fitOverviewDistance();
        if(atOverview)this.distance=this.targetDistance=this.overviewDistance;
      }
    }
    setGraph(graph){
      const groups=new Map();
      const nodes=(graph.nodes||[]).map(item=>({...item,kind:DISTRICTS[item.kind]?item.kind:'core',x:0,y:0,z:0}));
      for(const node of nodes){if(!groups.has(node.kind))groups.set(node.kind,[]);groups.get(node.kind).push(node);}
      const present=DISTRICT_ORDER.filter(kind=>groups.has(kind));
      const primary=groups.has('core')?'core':present.slice().sort((a,b)=>
        groups.get(b).reduce((v,n)=>v+(n.fileCount||1),0)-groups.get(a).reduce((v,n)=>v+(n.fileCount||1),0))[0];
      // Every module is a real clickable building. Previous 4.4-unit grid
      // spacing could overlap buildings up to 6.9 units wide. Keep a physical
      // gap at every density, including the 72-module graph limit.
      const TILE=7.9, PLATFORM_GAP=5.5;
      const positions=[[-.96,-.63],[.31,-1],[1,-.47],[-1,.28],[1,.29],
        [-.8,.88],[.18,1],[.82,.82],[-.32,-1.15]];
      const spiralSlot=index=>{
        let ring=1;
        while(index>=8*ring){index-=8*ring;ring++;}
        const side=2*ring;
        if(index<side)return {x:ring,z:-ring+index};
        index-=side;
        if(index<side)return {x:ring-index,z:ring};
        index-=side;
        if(index<side)return {x:-ring,z:ring-index};
        index-=side;
        return {x:-ring+index,z:-ring};
      };
      const planned=present.map(kind=>{
        const items=groups.get(kind),central=kind===primary;
        const columns=Math.max(1,Math.ceil(Math.sqrt(items.length)));
        const rows=Math.ceil(items.length/columns);
        items.sort((a,b)=>b.fileCount-a.fileCount||String(a.id).localeCompare(String(b.id)));
        items.forEach((node,i)=>{
          if(central){
            const slot=spiralSlot(i);
            node.x=slot.x*TILE;node.z=slot.z*TILE;
          }else{
            node.x=((i%columns)-(columns-1)/2)*TILE;
            node.z=(Math.floor(i/columns)-(rows-1)/2)*TILE;
          }
          const size=Math.log2(Math.max(0,node.fileCount||0)+1);
          node.width=1.7+1.75*size/(size+4);
          node.height=4+size*1.6;
          node.color=COLORS[kind];node.district=DISTRICTS[kind].name;
          node.landmark=false;node.degree=0;
        });
        const halfWidth=Math.max(central?15.2:7.5,...items.map(node=>Math.abs(node.x)+node.width+2));
        const halfDepth=Math.max(central?14.6:7.4,...items.map(node=>Math.abs(node.z)+node.width+2));
        return {kind,...DISTRICTS[kind],color:COLORS[kind],count:items.length,
          center:{x:0,z:0},halfWidth,halfDepth,nodes:items,central};
      });
      const positioned=[];
      // Keep the old floating-district orientation, but push each island
      // outward until its actual occupied bounds cannot overlap another.
      let satellite=0;
      for(const district of planned.filter(d=>d.central).concat(planned.filter(d=>!d.central))){
        if(!district.central){
          const [dx,dz]=positions[satellite++%positions.length];
          let found=false;
          for(let radius=28;radius<=700;radius+=3.5){
            const cx=dx*radius,cz=dz*radius;
            const overlaps=positioned.some(other=>
              Math.abs(cx-other.center.x)<district.halfWidth+other.halfWidth+PLATFORM_GAP &&
              Math.abs(cz-other.center.z)<district.halfDepth+other.halfDepth+PLATFORM_GAP);
            if(!overlaps){
              district.center={x:cx,z:cz};found=true;break;
            }
          }
          if(!found)throw Error('Unable to place a code district without collision');
          for(const node of district.nodes){node.x+=district.center.x;node.z+=district.center.z;}
        }
        positioned.push(district);
      }
      this.districts=positioned;
      this.nodes=nodes;this.issueMarkers=new Map();this.issueHitAreas=[];this.districtHitAreas=[];
      const lookup=new Map(nodes.map(n=>[n.id,n]));
      this.edges=(graph.edges||[]).map(edge=>({...edge,a:lookup.get(edge.source),b:lookup.get(edge.target)})).filter(e=>e.a&&e.b);
      this.neighbors=new Map(nodes.map(node=>[node.id,new Set()]));
      for(const edge of this.edges){
        edge.a.degree++;edge.b.degree++;
        this.neighbors.get(edge.a.id).add(edge.b.id);this.neighbors.get(edge.b.id).add(edge.a.id);
      }
      this.hotspots=[...nodes].filter(n=>n.degree>=2).sort((a,b)=>b.degree-a.degree||b.fileCount-a.fileCount).slice(0,5);
      for(const district of this.districts){const main=[...district.nodes].sort((a,b)=>b.degree-a.degree||b.fileCount-a.fileCount)[0];if(main)main.landmark=true;}
      this.selected=null;this.hovered=null;this.activeDistrict=null;this.impact=null;this.moduleFilter=null;this.prChangedNodes.clear();this.prDirectNodes.clear();this.prIndirectNodes.clear();this.prReviewEdges.clear();
      // A repository with only three districts can still have far-apart islands.
      // Fit the *actual projected island bounds* instead of assuming fewer districts
      // always means a closer camera. This prevents clipped cities on first load.
      this.overviewDistance=this.fitOverviewDistance();
      this.resetCamera();
      // The initial empty frame may share this animation timestamp.
      // Never throttle the first real drawing after a repository switch.
      this.lastPaintAt=null;
    }
    getDistricts(){return this.districts.map(d=>({kind:d.kind,name:d.name,short:d.short,description:d.hint,count:d.count,color:d.color}));}
    getHotspots(){return [...this.hotspots];}
    setIssueMarkers(byNode){
      const ids=new Set(this.nodes.map(n=>n.id));this.issueMarkers=new Map();
      for(const [id,data] of Object.entries(byNode||{})){
        if(!ids.has(id))continue;
        this.issueMarkers.set(id,{referenced:Array.isArray(data.referenced)?data.referenced.length:0,
          suggested:Array.isArray(data.suggested)?data.suggested.length:0,
          observed:Array.isArray(data.observed)?data.observed.length:0});
      }
    }
    setMode(mode){if(['structure','dependencies','flows','hotspots'].includes(mode))this.mode=mode;}
    setView(view){
      if(!['city','plan'].includes(view)||this.view===view)return;
      this.view=view;
      this.overviewDistance=this.fitOverviewDistance();this.resetCamera();
      this.hovered=null;if(this.tooltip)this.tooltip.hidden=true;
    }
    setModuleFilter(ids){
      this.moduleFilter=ids===null?null:new Set(ids);
      this.hovered=null;if(this.tooltip)this.tooltip.hidden=true;
    }
    setTraffic(value){this.traffic=!!value;}
    setImpactTrace(trace){
      if(!trace){this.impact=null;return;}
      const ids=new Set(this.nodes.map(n=>n.id));
      if(!ids.has(trace.root)){this.impact=null;return;}
      this.impact={root:trace.root,
        direct:new Set((trace.direct||[]).map(i=>i.nodeId).filter(i=>ids.has(i))),
        indirect:new Set((trace.indirect||[]).map(i=>i.nodeId).filter(i=>ids.has(i))),
        edges:new Set((trace.edges||[]).filter(e=>ids.has(e.source)&&ids.has(e.target)).map(e=>e.source+'\0'+e.target))};
    }
    setPullChangedNodes(ids){
      const known=new Set(this.nodes.map(n=>n.id));
      this.prChangedNodes=new Set((Array.isArray(ids)?ids:[]).filter(id=>known.has(id)));
    }
    setPullReviewPlan(plan){
      if(!plan){
        this.prDirectNodes.clear();this.prIndirectNodes.clear();
        this.prReviewEdges.clear();return;
      }
      const known=new Set(this.nodes.map(n=>n.id));
      this.prChangedNodes=new Set((plan.changedModules||[]).map(item=>item.nodeId).filter(id=>known.has(id)));
      this.prDirectNodes=new Set((plan.directImporters||[]).map(item=>item.nodeId)
        .filter(id=>known.has(id)&&!this.prChangedNodes.has(id)));
      this.prIndirectNodes=new Set((plan.twoHopImporters||[]).map(item=>item.nodeId)
        .filter(id=>known.has(id)&&!this.prChangedNodes.has(id)&&!this.prDirectNodes.has(id)));
      const realLinks=new Set(this.edges.map(e=>e.a.id+'\0'+e.b.id));
      this.prReviewEdges=new Set((plan.linkedEdges||[]).filter(e=>
        realLinks.has(e.source+'\0'+e.target)).map(e=>e.source+'\0'+e.target));
    }
    setSelected(id,{focus=false}={}){
      if(id===null){this.selected=null;return;}
      const node=this.nodes.find(n=>n.id===id);if(!node)return;
      this.selected=id;
      if(focus)this.activeDistrict=node.kind;
      else if(this.activeDistrict&&node.kind!==this.activeDistrict)this.activeDistrict=null;
      if(focus){this.zoomAnchor=null;this.targetPan={x:node.x,z:node.z};this.targetDistance=Math.min(this.distance,60);}
    }
    fitDistrictDistance(district){
      const original={distance:this.distance,yaw:this.yaw,pitch:this.pitch,pan:this.pan};
      this.yaw=-.54;this.pitch=.78;this.pan={...district.center};
      const side=this.width<600?18:Math.min(90,this.width*.085);
      const top=this.height*.10,bottom=this.height*.87;
      const samples=[];
      for(const x of [-district.halfWidth,district.halfWidth])
        for(const z of [-district.halfDepth,district.halfDepth]){
          samples.push([district.center.x+x,0,district.center.z+z]);
          samples.push([district.center.x+x,-2.4,district.center.z+z]);
        }
      for(const node of district.nodes)samples.push([node.x,node.height+.37,node.z]);
      let fitted=MAX_CAMERA_DISTANCE;
      for(let distance=65;distance<=MAX_CAMERA_DISTANCE;distance+=5){
        this.distance=distance;
        const projected=samples.map(p=>this.project(...p));
        if(projected.every(p=>p.x>=side&&p.x<=this.width-side&&p.y>=top&&p.y<=bottom)){
          fitted=distance;break;
        }
      }
      this.distance=original.distance;this.yaw=original.yaw;
      this.pitch=original.pitch;this.pan=original.pan;
      return fitted;
    }
    focusDistrict(kind){
      const district=this.districts.find(d=>d.kind===kind);if(!district)return false;
      this.activeDistrict=kind;
      this.zoomAnchor=null;
      const distance=this.fitDistrictDistance(district);
      this.targetPan={...district.center};
      this.targetDistance=clamp(distance,65,MAX_CAMERA_DISTANCE);
      this.yaw=-.54;this.pitch=.78;
      return true;
    }
    focusHotspot(){
      const target=this.getHotspots()[0];if(!target)return null;
      this.setMode('hotspots');this.setSelected(target.id,{focus:true});return target;
    }
    cycleModule(direction=1){
      if(!this.nodes.length)return null;
      // Stable, bounded walk through ACTUAL imported module IDs.
      const sorted=[...this.nodes].sort((a,b)=>
        DISTRICT_ORDER.indexOf(a.kind)-DISTRICT_ORDER.indexOf(b.kind)||
        String(a.name).localeCompare(String(b.name))||
        String(a.id).localeCompare(String(b.id)));
      const current=sorted.findIndex(n=>n.id===this.selected);
      const step=direction<0?-1:1;
      const next=current<0?(step>0?0:sorted.length-1):
        (current+step+sorted.length)%sorted.length;
      const node=sorted[next];
      this.setSelected(node.id,{focus:true});
      return node;
    }
    fitOverviewDistance(){
      if(!this.districts.length)return 140;
      const old={distance:this.distance,yaw:this.yaw,pitch:this.pitch,pan:this.pan};
      this.yaw=-.71;this.pitch=.83;this.pan={x:0,z:0};
      const marginX=this.width<600?18:Math.min(92,this.width*.085);
      const top=this.height*.10,bottom=this.height*.87;
      const sample=[];
      for(const d of this.districts){
        for(const x of [-d.halfWidth,d.halfWidth])for(const z of [-d.halfDepth,d.halfDepth]){
          sample.push([d.center.x+x,0,d.center.z+z]);
          sample.push([d.center.x+x,-2.4,d.center.z+z]);
        }
        for(const n of d.nodes)sample.push([n.x,n.height+.37,n.z]);
      }
      let fitted=110;
      for(let distance=110;distance<=MAX_CAMERA_DISTANCE;distance+=5){
        this.distance=distance;
        const pixels=sample.map(point=>this.project(...point));
        const x=pixels.map(p=>p.x),y=pixels.map(p=>p.y);
        fitted=distance;
        if(Math.min(...x)>=marginX && Math.max(...x)<=this.width-marginX &&
           Math.min(...y)>=top && Math.max(...y)<=bottom)break;
      }
      this.distance=old.distance;this.yaw=old.yaw;this.pitch=old.pitch;this.pan=old.pan;
      return fitted;
    }
    resetCamera(){
      this.yaw=-.71;this.pitch=.83;this.pan={x:0,z:0};this.targetPan={x:0,z:0};
      this.distance=this.overviewDistance;this.targetDistance=this.overviewDistance;
      this.zoomAnchor=null;this.activeDistrict=null;
    }
    project(x,y,z){
      const dx=x-this.pan.x,dz=z-this.pan.z;
      const focal=Math.min(this.width*1.30,this.height*1.90);
      if(this.view==='plan'){
        const scale=focal/this.distance;
        return {x:this.width*.5+dx*scale,y:this.height*.55+dz*scale,depth:z,scale};
      }
      const a=dx*Math.cos(this.yaw)-dz*Math.sin(this.yaw);
      const b=dx*Math.sin(this.yaw)+dz*Math.cos(this.yaw);
      const elevation=y*Math.cos(this.pitch)-b*Math.sin(this.pitch);
      const depth=y*Math.sin(this.pitch)+b*Math.cos(this.pitch);
      const scale=focal/Math.max(10,this.distance+depth);
      return {x:this.width*.5+a*scale,y:this.height*.55-elevation*scale,depth,scale};
    }
    // Undo the perspective projection on a horizontal world plane. Using this
    // instead of a fixed zoom center lets the point under the cursor stay put.
    screenToWorldOnPlane(screenX,screenY,planeY=0,distance=this.distance,pan=this.pan){
      const focal=Math.min(this.width*1.30,this.height*1.90);
      const u=(screenX-this.width*.5)/focal;
      const v=(screenY-this.height*.55)/focal;
      if(this.view==='plan')return {x:pan.x+u*distance,z:pan.z+v*distance};
      const sin=Math.sin(this.pitch),cos=Math.cos(this.pitch);
      const denominator=sin-v*cos;
      // Near-horizon rays do not reliably intersect the selected plane.
      if(denominator<=.12)return null;
      const b=(v*(distance+planeY*sin)+planeY*cos)/denominator;
      const a=u*(distance+planeY*sin+b*cos);
      const x=pan.x+a*Math.cos(this.yaw)+b*Math.sin(this.yaw);
      const z=pan.z-a*Math.sin(this.yaw)+b*Math.cos(this.yaw);
      return Number.isFinite(x)&&Number.isFinite(z)?{x,z}:null;
    }
    zoomToward(factor,screenX=this.width*.5,screenY=this.height*.55){
      if(!Number.isFinite(factor)||factor<=0||Math.abs(factor-1)<1e-10)return;
      const cx=Number.isFinite(screenX)?clamp(screenX,0,this.width):this.width*.5;
      const cy=Number.isFinite(screenY)?clamp(screenY,0,this.height):this.height*.55;
      const issue=this.getIssueHit(cx,cy);
      const node=issue?this.nodes.find(n=>n.id===issue.nodeId):this.getHit(cx,cy);
      const planeY=node?node.height*.5:0;
      // Some screen rays (e.g. the horizon at extreme tilt) cannot meet the
      // ground; safely fall back to the center instead of jumping the camera.
      let x=cx,y=cy,elevation=planeY;
      let anchor=this.screenToWorldOnPlane(x,y,elevation);
      if(!anchor){x=this.width*.5;y=this.height*.55;elevation=0;
        anchor=this.screenToWorldOnPlane(x,y,0);}
      if(!anchor)return;
      this.zoomAnchor={x,y,planeY:elevation,world:anchor};
      this.targetDistance=clamp(this.targetDistance*factor,MIN_CAMERA_DISTANCE,MAX_CAMERA_DISTANCE);
      // A new zoom overrides an unfinished automatic district focus.
      this.targetPan={...this.pan};
    }
    addEvents(){
      // Restore the city overview from the canvas as well as the Fit button.
      this.canvas.addEventListener('dblclick', e => {
        e.preventDefault();
        if(this.pendingCompactSelection!==null){clearTimeout(this.pendingCompactSelection);this.pendingCompactSelection=null;}
        this.resetCamera();this.pan={x:0,z:0};
        if(this.tooltip)this.tooltip.hidden=true;
      });
      this.canvas.addEventListener('pointerdown',e=>{
        this.canvas.setPointerCapture(e.pointerId);
        // Orbit gestures should not compete with an in-flight anchored zoom.
        this.zoomAnchor=null;this.targetDistance=this.distance;
        if(e.pointerType==='touch'){
          const r=this.canvas.getBoundingClientRect();
          this.touchPointers.set(e.pointerId,{x:e.clientX-r.left,y:e.clientY-r.top});
          if(this.touchPointers.size===2){
            const [a,b]=[...this.touchPointers.values()];
            this.pinchDistance=Math.hypot(a.x-b.x,a.y-b.y);
            this.pinchHappened=true;this.isDragging=false;
            if(this.tooltip)this.tooltip.hidden=true;
            return;
          }
        }
        this.isDragging=true;this.dragDistance=0;
        this.lastPointer={x:e.clientX,y:e.clientY};this.lastInteraction=performance.now();
      });
      this.canvas.addEventListener('pointermove',e=>{
        const x=e.clientX,y=e.clientY;
        if(e.pointerType==='touch'&&this.touchPointers.has(e.pointerId)){
          const r=this.canvas.getBoundingClientRect();
          this.touchPointers.set(e.pointerId,{x:x-r.left,y:y-r.top});
          if(this.touchPointers.size>=2){
            const [a,b]=[...this.touchPointers.values()];
            const next=Math.hypot(a.x-b.x,a.y-b.y);
            if(next>8&&this.pinchDistance>8){
              this.zoomToward(clamp(this.pinchDistance/next,.78,1.28),(a.x+b.x)/2,(a.y+b.y)/2);
            }
            this.pinchDistance=next;this.pinchHappened=true;
            return;
          }
          if(this.pinchHappened)return;
        }
        if(this.isDragging){
          const dx=x-this.lastPointer.x,dy=y-this.lastPointer.y;this.dragDistance+=Math.abs(dx)+Math.abs(dy);
          if(this.view==='plan'||e.shiftKey||e.buttons===2){
            // Pan in world coordinates under the cursor, respecting yaw/zoom.
            const r=this.canvas.getBoundingClientRect();
            const before=this.screenToWorldOnPlane(this.lastPointer.x-r.left,this.lastPointer.y-r.top);
            const after=this.screenToWorldOnPlane(x-r.left,y-r.top);
            if(before&&after){this.pan.x+=before.x-after.x;this.pan.z+=before.z-after.z;
              this.targetPan={...this.pan};}
          }else{this.yaw+=dx*.007;this.pitch=clamp(this.pitch+dy*.005,.57,1.11);}
          this.lastPointer={x,y};if(this.tooltip)this.tooltip.hidden=true;
        }else{const r=this.canvas.getBoundingClientRect();this.updateHover(x-r.left,y-r.top);}
      });
      this.canvas.addEventListener('pointerup',e=>{
        const afterPinch=e.pointerType==='touch'&&this.pinchHappened;
        if(e.pointerType==='touch'){
          this.touchPointers.delete(e.pointerId);
          if(this.touchPointers.size<2)this.pinchDistance=0;
          if(!this.touchPointers.size)this.pinchHappened=false;
        }
        if(!afterPinch&&this.isDragging&&this.dragDistance<6){
          const r=this.canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
          const plaque=this.getDistrictHit(x,y),issue=this.getIssueHit(x,y);
          // A badge takes priority only when the click is over its visible circle.
          const onIssueBadge=issue&&Math.hypot(issue.x-x,issue.y-y)<=14.5;
          const hit=this.getHit(x,y);
          const select=()=>{
            if(plaque&&!onIssueBadge){
              if(this.tooltip)this.tooltip.hidden=true;
              this.focusDistrict(plaque.kind);this.onDistrictSelect(plaque.kind);
            }else if(issue){
              if(this.tooltip)this.tooltip.hidden=true;
              this.setSelected(issue.nodeId,{focus:false});this.onIssueSelect(issue.nodeId);
            }else if(hit){
              this.setSelected(hit.id,{focus:false});this.onSelect(hit.id);
            }
          };
          // On compact screens the inspector can cover the second click before
          // the canvas sees dblclick. Delay only selections that open a panel,
          // and cancel them if a double-click requests the city overview.
          if(this.width<650&&((issue&&(!plaque||onIssueBadge))||(!plaque&&hit))){
            if(this.pendingCompactSelection!==null)clearTimeout(this.pendingCompactSelection);
            this.pendingCompactSelection=setTimeout(()=>{
              this.pendingCompactSelection=null;select();
            },300);
          }else select();
        }
        this.isDragging=false;
      });
      this.canvas.addEventListener('pointercancel',e=>{
        this.isDragging=false;this.touchPointers.delete(e.pointerId);
        if(this.touchPointers.size<2)this.pinchDistance=0;
        if(!this.touchPointers.size)this.pinchHappened=false;
      });
      this.canvas.addEventListener('pointerleave',()=>{if(!this.isDragging){this.hovered=null;if(this.tooltip)this.tooltip.hidden=true;}});
      this.canvas.addEventListener('contextmenu',e=>e.preventDefault());
      this.canvas.addEventListener('wheel',e=>{
        e.preventDefault();
        const rect=this.canvas.getBoundingClientRect();
        // Normalize pixels, lines, and pages; proportional zoom works with both
        // precise Mac trackpads and notched mouse wheels. Ctrl-wheel is pinch.
        const delta=(Number(e.deltaY)||0)*(e.deltaMode===1?16:e.deltaMode===2?this.height:1);
        const logFactor=clamp(delta*(e.ctrlKey?.0034:.0015),-.22,.22);
        this.zoomToward(Math.exp(logFactor),e.clientX-rect.left,e.clientY-rect.top);
      },{passive:false});
      this.canvas.addEventListener('keydown',e=>{
        if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','Home','Enter','[',']'].includes(e.key))e.preventDefault();
        if(e.key==='['||e.key===']'){
          const next=this.cycleModule(e.key===']'?1:-1);
          if(next)this.onSelect(next.id);
          return;
        }
        if(this.view==='plan'&&e.key.startsWith('Arrow')){
          const step=24/this.project(0,0,0).scale;
          this.zoomAnchor=null;
          this.targetPan.x+=e.key==='ArrowLeft'?-step:e.key==='ArrowRight'?step:0;
          this.targetPan.z+=e.key==='ArrowUp'?-step:e.key==='ArrowDown'?step:0;
        }else{
          if(e.key==='ArrowLeft')this.yaw-=.14;
          if(e.key==='ArrowRight')this.yaw+=.14;
          if(e.key==='ArrowUp')this.pitch=clamp(this.pitch+.1,.57,1.11);
          if(e.key==='ArrowDown')this.pitch=clamp(this.pitch-.1,.57,1.11);
        }
        if(e.key==='+'||e.key==='=')this.zoomToward(.88);
        if(e.key==='-')this.zoomToward(1/.88);
        if(e.key==='Home')this.resetCamera();
        if(e.key==='Enter'&&this.selected)this.onSelect(this.selected);
      });
    }
    getIssueHit(x,y){
      // Select a visible issue badge before its underlying building. Touch target
      // is larger than the painted circle, without blocking map rotation.
      const candidates=this.issueHitAreas.filter(p=>Math.hypot(p.x-x,p.y-y)<=p.hitRadius);
      return candidates.sort((a,b)=>Math.hypot(a.x-x,a.y-y)-Math.hypot(b.x-x,b.y-y)||a.depth-b.depth)[0]||null;
    }
    getHit(x,y){const hits=this.hitAreas.filter(h=>!h.filtered&&x>=h.x1&&x<=h.x2&&y>=h.y1&&y<=h.y2);return hits.sort((a,b)=>a.depth-b.depth)[0]?.node||null;}
    getDistrictHit(x,y){return this.districtHitAreas.find(p=>x>=p.x1&&x<=p.x2&&y>=p.y1&&y<=p.y2)||null;}
    updateHover(x,y){
      const plaque=this.getDistrictHit(x,y),pin=this.getIssueHit(x,y);
      if(plaque&&(!pin||Math.hypot(pin.x-x,pin.y-y)>14.5)){
        this.hovered=null;this.canvas.style.cursor='pointer';
        if(this.tooltip)this.tooltip.hidden=true;
        this.onHover(null);return;
      }
      if(pin){
        this.hovered=pin.nodeId;
        this.canvas.style.cursor='pointer';
        if(this.tooltip){
          this.tooltip.replaceChildren();
          const title=document.createElement('strong');title.textContent=`${pin.count} open issue${pin.count===1?'':'s'} · ${pin.name}`;
          const text=document.createElement('span');text.textContent=pin.observed
            ? `${pin.observed} source identifier match${pin.observed===1?'':'es'} · Issue itself not confirmed`
            : pin.referenced
              ? `${pin.referenced} path reference${pin.referenced===1?'':'s'}${pin.suggested?` · ${pin.suggested} suggested`:''} · Click for issues`
              : `Suggested location only · Click for issues`;
          this.tooltip.append(title,text);this.tooltip.hidden=false;
          this.tooltip.style.left=clamp(x+15,7,this.width-255)+'px';this.tooltip.style.top=clamp(y-58,7,this.height-75)+'px';
        }
        this.onHover(this.hovered);return;
      }
      const hit=this.getHit(x,y);this.hovered=hit?.id||null;
      if(hit&&this.tooltip){
        this.canvas.style.cursor='pointer';this.tooltip.replaceChildren();
        const title=document.createElement('strong');title.textContent=hit.name;
        const subtitle=document.createElement('span');const issues=this.issueMarkers.get(hit.id);
        subtitle.textContent=`${hit.district} · ${hit.fileCount} files · ${hit.degree} sampled links`+(issues?.observed?` · ${issues.observed} source-matched issues`:issues?.referenced?` · ${issues.referenced} referenced issues`:issues?.suggested?` · ${issues.suggested} issue suggestions`:'');
        this.tooltip.append(title,subtitle);this.tooltip.hidden=false;
        this.tooltip.style.left=clamp(x+14,7,this.width-235)+'px';
        this.tooltip.style.top=clamp(y-53,7,this.height-75)+'px';
      }else{this.canvas.style.cursor='grab';if(this.tooltip)this.tooltip.hidden=true;}
      this.onHover(this.hovered);
    }
    drawSky(ctx){
      const w=this.width,h=this.height;
      const g=ctx.createLinearGradient(0,0,w,h);
      g.addColorStop(0,'#0c171f');g.addColorStop(1,'#091318');
      ctx.fillStyle=g;ctx.fillRect(0,0,w,h);
      ctx.fillStyle='rgba(159,195,207,.15)';
      for(let x=15;x<w;x+=22)for(let y=15;y<h;y+=22){
        ctx.fillRect(x,y,1,1);
      }
    }
    islandVertices(d,y){const {x,z}=d.center,w=d.halfWidth,h=d.halfDepth;
      return [[x-w,y,z-h],[x+w,y,z-h],[x+w,y,z+h],[x-w,y,z+h]].map(v=>this.project(...v));}
    drawDistricts(ctx){
      const ordered=[...this.districts].sort((a,b)=>this.project(b.center.x,0,b.center.z).depth-this.project(a.center.x,0,a.center.z).depth);
      for(const d of ordered){
        const top=this.islandVertices(d,0),base=this.islandVertices(d,-2.4);
        ctx.save();
        if(this.activeDistrict&&d.kind!==this.activeDistrict)ctx.globalAlpha=.23;
        if(this.view==='city'){
          for(let side=0;side<4;side++){
            const next=(side+1)%4;
            poly(ctx,[top[side],top[next],base[next],base[side]]);
            ctx.fillStyle=mix('#0b1721',d.color,.12);ctx.fill();
            ctx.strokeStyle=rgba(d.color,.32);ctx.lineWidth=.7;ctx.stroke();
          }
        }
        poly(ctx,top);
        const surface=ctx.createLinearGradient(top[0].x,top[0].y,top[2].x,top[2].y);
        surface.addColorStop(0,mix('#16272e',d.color,.15));surface.addColorStop(1,mix('#142029',d.color,.06));
        ctx.fillStyle=surface;ctx.fill();
        ctx.strokeStyle=rgba(d.color,d.kind===this.activeDistrict?.92:.50);
        ctx.lineWidth=d.kind===this.activeDistrict?2:1.1;ctx.stroke();
        ctx.restore();
      }
    }
    pickPathEdges(){
      // Highlight a discovered chain of sampled static imports; NOT runtime execution.
      const starts=this.nodes.filter(n=>n.kind==='frontend');
      let current=this.nodes.find(n=>n.id===this.selected)||starts[0]||this.nodes[0];
      const used=new Set(),visited=new Set();
      for(let step=0;step<8&&current;step++){
        visited.add(current.id);
        const next=this.edges.find(e=>e.a.id===current.id&&!visited.has(e.b.id));
        if(!next)break;used.add(next);current=next.b;
      }
      return used;
    }
    drawEdges(ctx,now){
      const path=this.mode==='flows'?this.pickPathEdges():null;
      const hotspots=new Set(this.getHotspots().map(n=>n.id));
      for(const edge of this.edges){
        if(this.moduleFilter&&!(this.moduleFilter.has(edge.a.id)&&this.moduleFilter.has(edge.b.id)))continue;
        const traceEdge=this.impact?.edges.has(edge.a.id+'\0'+edge.b.id);
        const reviewEdge=this.prReviewEdges.has(edge.a.id+'\0'+edge.b.id);
        if(this.impact&&!traceEdge)continue;
        const regularActive=this.mode==='flows'?path.has(edge):
          this.mode==='dependencies'?(!this.selected||edge.a.id===this.selected||edge.b.id===this.selected):
            this.mode==='hotspots'?(hotspots.has(edge.a.id)||hotspots.has(edge.b.id)):
              edge.a.id===this.selected||edge.b.id===this.selected;
        const active=this.impact?traceEdge:(reviewEdge||regularActive);
        if(this.mode==='structure'&&!active)continue;
        const cross=edge.a.kind!==edge.b.kind;
        const elevation=cross?2.1:.45;
        const p=this.project(edge.a.x,elevation+Math.min(edge.a.height,2),edge.a.z);
        const q=this.project(edge.b.x,elevation+Math.min(edge.b.height,2),edge.b.z);
        const mid=this.project((edge.a.x+edge.b.x)/2,Math.max(edge.a.height,edge.b.height)/2+(cross?3:1),(edge.a.z+edge.b.z)/2);
        const strength=this.impact?.89:reviewEdge?.82:active?.68:.13;
        const accent=this.impact?'#f3c58b':reviewEdge?'#91dbd1':this.mode==='hotspots'&&active?'#f0a2af':cross?'#9dcffe':'#91e2ef';
        ctx.save();ctx.lineWidth=active?cross?2.4:1.65:1.0;
        if(!active)ctx.setLineDash([2,7]);
        ctx.strokeStyle=rgba(accent,strength);
        ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.quadraticCurveTo(mid.x,mid.y,q.x,q.y);ctx.stroke();ctx.setLineDash([]);ctx.shadowBlur=0;
        if(active&&Math.hypot(q.x-p.x,q.y-p.y)>30){
          const x=.09*p.x+.42*mid.x+.49*q.x,y=.09*p.y+.42*mid.y+.49*q.y;
          const angle=Math.atan2(.3*(mid.y-p.y)+.7*(q.y-mid.y),.3*(mid.x-p.x)+.7*(q.x-mid.x));
          ctx.beginPath();ctx.moveTo(x-6*Math.cos(angle-.55),y-6*Math.sin(angle-.55));
          ctx.lineTo(x,y);ctx.lineTo(x-6*Math.cos(angle+.55),y-6*Math.sin(angle+.55));ctx.stroke();
        }
        if(active&&this.traffic&&!this.motion){
          // Animated particles are visualizations of static links, not packet traces.
          const t=(now*.00015+hash(edge.a.id+edge.b.id))%1;
          const x=(1-t)*(1-t)*p.x+2*(1-t)*t*mid.x+t*t*q.x;
          const y=(1-t)*(1-t)*p.y+2*(1-t)*t*mid.y+t*t*q.y;
          const glow=ctx.createRadialGradient(x,y,0,x,y,10);
          glow.addColorStop(0,rgba(accent,.8));glow.addColorStop(1,rgba(accent,0));
          ctx.fillStyle=glow;ctx.beginPath();ctx.arc(x,y,10,0,PI2);ctx.fill();
          ctx.fillStyle='#f4ffff';ctx.beginPath();ctx.arc(x,y,1.5,0,PI2);ctx.fill();
        }
        ctx.restore();
      }
    }
    drawBuilding(ctx,n,now){
      const selected=n.id===this.selected,hovered=n.id===this.hovered;
      const neighbors=this.neighbors.get(this.selected)?.has(n.id);
      const tracedDirect=this.impact?.direct.has(n.id),tracedIndirect=this.impact?.indirect.has(n.id);
      const traced=tracedDirect||tracedIndirect;
      const prChanged=this.prChangedNodes.has(n.id),prDirect=this.prDirectNodes.has(n.id),
        prIndirect=this.prIndirectNodes.has(n.id);
      const outsideFocus=Boolean(this.activeDistrict&&n.kind!==this.activeDistrict);
      const prFocused=this.prChangedNodes.size+this.prDirectNodes.size+this.prIndirectNodes.size>0;
      const prDim=prFocused&&!prChanged&&!prDirect&&!prIndirect&&!selected;
      const filtered=Boolean(this.moduleFilter&&!this.moduleFilter.has(n.id)&&!selected);
      const dim=filtered||outsideFocus||prDim||(this.impact?!selected&&!traced:this.mode==='dependencies'&&this.selected&&!selected&&!neighbors);
      const hot=this.mode==='hotspots'&&this.hotspots.some(item=>item.id===n.id);
      const color=prChanged?'#f3c58b':prDirect?'#91dbd1':prIndirect?'#b6acff':
        tracedDirect?'#efbd89':tracedIndirect?'#b6acff':hot?'#ff5d89':n.color,w=n.width,h=n.height;
      if(this.view==='plan'){
        const roof=this.project(n.x,0,n.z),half=roof.scale*w;
        const x=roof.x-half,y=roof.y-half;
        ctx.save();ctx.globalAlpha=filtered?.10:dim?.28:1;
        rounded(ctx,x,y,half*2,half*2,2);
        ctx.fillStyle=mix('#13252e',color,selected?.75:.44);ctx.fill();
        ctx.strokeStyle=rgba(selected?'#f3fffa':color,selected||hovered?1:.82);ctx.lineWidth=selected?2:1;ctx.stroke();ctx.restore();
        return {node:n,roof,depth:roof.depth,selected,hovered,dim,filtered,x1:x-4,x2:roof.x+half+4,y1:y-4,y2:roof.y+half+4};
      }
      const verts=[[-w,0,-w],[w,0,-w],[w,0,w],[-w,0,w],[-w,h,-w],[w,h,-w],[w,h,w],[-w,h,w]];
      const pts=verts.map(p=>this.project(n.x+p[0],p[1],n.z+p[2]));
      const depth=this.project(n.x,h*.5,n.z).depth;
      const roof=this.project(n.x,h,n.z),base=this.project(n.x,0,n.z);
      ctx.save();ctx.globalAlpha=filtered?.10:outsideFocus?.20:dim?.34:1;
      const shadow=ctx.createRadialGradient(base.x,base.y,0,base.x,base.y,Math.max(14,base.scale*7));
      shadow.addColorStop(0,rgba(color,selected?.33:.17));shadow.addColorStop(1,rgba(color,0));
      ctx.fillStyle=shadow;ctx.beginPath();ctx.ellipse(base.x,base.y,Math.max(12,base.scale*7),Math.max(4,base.scale*3.4),0,0,PI2);ctx.fill();
      if(selected||hovered||hot||traced||prChanged||prDirect||prIndirect){
        const pulse=selected&&!this.motion?.12*Math.sin(now*.004):0;
        const highlighted=prChanged||prDirect||prIndirect;
        const glowStrength=selected?(.78+pulse):hovered?.55:traced?.67:highlighted?.82:.4;
        ctx.strokeStyle=rgba(color,glowStrength);
        ctx.lineWidth=selected?2.2:traced||highlighted?1.8:1.3;
        ctx.shadowColor=color;ctx.shadowBlur=selected?18:traced?12:6;
        ctx.beginPath();ctx.ellipse(base.x,base.y,base.scale*(w*2+1.1),base.scale*(w+.5),0,0,PI2);ctx.stroke();ctx.shadowBlur=0;
      }
      const faces=[
        {ids:[0,1,5,4],bright:.20},{ids:[1,2,6,5],bright:.32},
        {ids:[2,3,7,6],bright:.16},{ids:[3,0,4,7],bright:.23},
        {ids:[4,5,6,7],bright:.50},
      ].sort((a,b)=>b.ids.reduce((t,i)=>t+pts[i].depth,0)-a.ids.reduce((t,i)=>t+pts[i].depth,0));
      for(const face of faces){
        poly(ctx,face.ids.map(i=>pts[i]));
        const gd=ctx.createLinearGradient(roof.x,roof.y,base.x,base.y);
        gd.addColorStop(0,mix('#547181',color,face.bright+.30));
        gd.addColorStop(.52,mix('#203341',color,face.bright*.90));
        gd.addColorStop(1,mix('#101e24',color,face.bright*.70));
        ctx.fillStyle=gd;ctx.fill();
        ctx.lineWidth=selected?1.25:.65;ctx.strokeStyle=rgba('#9fb7cb',selected?.9:.26);
        ctx.shadowColor=rgba(color,.45);ctx.shadowBlur=selected?9:1;ctx.stroke();ctx.shadowBlur=0;
      }
      // Raised architectural crown restores the original tower silhouette.
      // These are still the exact modules from the imported repository.
      const capWidth=w*1.085,capHeight=.37;
      const rim=[[-capWidth,h,-capWidth],[capWidth,h,-capWidth],
        [capWidth,h,capWidth],[-capWidth,h,capWidth]].map(p=>this.project(n.x+p[0],p[1],n.z+p[2]));
      const crown=[[-capWidth,h+capHeight,-capWidth],[capWidth,h+capHeight,-capWidth],
        [capWidth,h+capHeight,capWidth],[-capWidth,h+capHeight,capWidth]].map(p=>this.project(n.x+p[0],p[1],n.z+p[2]));
      poly(ctx,[rim[1],rim[2],crown[2],crown[1]]);
      ctx.fillStyle=mix('#152d46',color,.27);ctx.fill();
      poly(ctx,[rim[2],rim[3],crown[3],crown[2]]);
      ctx.fillStyle=mix('#101e32',color,.19);ctx.fill();
      poly(ctx,crown);ctx.fillStyle=mix('#344b57',color,.58);ctx.fill();
      ctx.strokeStyle=rgba(selected?'#f4fbff':color,selected?.95:.52);
      ctx.lineWidth=selected?1.8:1.1;ctx.stroke();
      // Windows and mullions follow the two camera-visible facades.
      const visibleX=Math.sin(this.yaw)<0?w:-w;
      const visibleZ=Math.cos(this.yaw)>0?-w:w;
      const facesVisible=[
        (side,y)=>this.project(n.x+visibleX+Math.sign(visibleX)*.025,y,n.z+side),
        (side,y)=>this.project(n.x+side,y,n.z+visibleZ+Math.sign(visibleZ)*.025)
      ];
      const detailed=roof.scale*w>=(this.width<650?8.3:7.0);
      const floors=detailed?Math.min(this.width<650||this.nodes.length>45?4:8,Math.max(3,Math.floor(h/1.6))):0;
      for(let facadeIndex=0;facadeIndex<facesVisible.length;facadeIndex++){
        const point=facesVisible[facadeIndex];
        for(let lane=1;lane<=3&&detailed;lane++){
          const side=-w+2*w*lane/4;
          const a=point(side,.65),b=point(side,h-.35);
          ctx.strokeStyle=rgba('#bcd9f1',.12);
          ctx.lineWidth=.65;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
        }
        for(let floor=1;floor<=floors;floor++){
          const y=h*(floor/(floors+1));
          const a=point(-w,y),b=point(w,y);
          ctx.strokeStyle=rgba('#b5d8f3',.16);ctx.lineWidth=.6;
          ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
          for(let lane=1;lane<=3;lane++){
            if(hash(n.id+':'+facadeIndex+':'+floor+':'+lane)<.31)continue;
            const side=-w+2*w*lane/4,start=point(side,y+.19),end=point(side,Math.min(h-.28,y+.79));
            ctx.strokeStyle=rgba('#e0f2ff',.24+.31*hash(n.id+':light:'+floor+':'+lane));
            ctx.lineWidth=clamp(roof.scale*.19,1,2.05);
            ctx.beginPath();ctx.moveTo(start.x,start.y);ctx.lineTo(end.x,end.y);ctx.stroke();
          }
        }
      }
      // Draw a short selection marker above the active module.
      if(selected){
        const beamHeight=21;
        const glow=ctx.createLinearGradient(roof.x,roof.y-beamHeight,roof.x,roof.y+2);
        glow.addColorStop(0,rgba(color,0));glow.addColorStop(.70,rgba(color,.60));glow.addColorStop(1,rgba(color,.25));
        ctx.strokeStyle=glow;ctx.lineWidth=2;
        ctx.shadowColor=color;ctx.shadowBlur=7;
        ctx.beginPath();ctx.moveTo(roof.x,roof.y-beamHeight);ctx.lineTo(roof.x,roof.y);ctx.stroke();ctx.shadowBlur=0;
      }
      ctx.fillStyle=selected?'#efffff':color;ctx.beginPath();ctx.arc(roof.x,roof.y,selected?3:1.8,0,PI2);ctx.fill();
      ctx.restore();
      const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);
      return {node:n,x1:Math.min(...xs)-5,x2:Math.max(...xs)+5,y1:Math.min(...ys)-5,y2:Math.max(...ys)+5,
        depth,roof,selected,hovered,dim,filtered};
    }
    drawBuildingLabels(ctx,hits){
      // Avoid 60 overlapping file labels. Show district landmarks by default,
      // and reveal other names on selection, hover, or closer camera zoom.
      const candidates=hits.filter(h=>(!this.activeDistrict||h.node.kind===this.activeDistrict)&&
        (h.selected||h.hovered||((this.prChangedNodes.has(h.node.id)||this.prDirectNodes.has(h.node.id)||this.prIndirectNodes.has(h.node.id))&&this.distance<=95)||(this.impact?.direct.has(h.node.id)&&this.distance<=92)||(h.node.landmark&&this.distance<=84)||this.distance<=58))
        .sort((a,b)=>Number(b.selected)-Number(a.selected)||Number(b.hovered)-Number(a.hovered)||Number(b.node.landmark)-Number(a.node.landmark));
      const placed=[];
      for(const h of candidates){
        const {node,roof,selected,hovered,dim}=h;if(dim&&!selected)continue;
        const label=node.name.length>19?node.name.slice(0,18)+'…':node.name;
        ctx.font=selected?'bold 14px system-ui':'600 12px system-ui';
        const width=clamp(ctx.measureText(label).width+28,67,210),x=roof.x-width/2,y=roof.y-(selected?39:32);
        if(x<4||x+width>this.width-4||y<4||y+26>this.height)continue;
        if(!selected&&!hovered&&placed.some(p=>x<p.x+p.w+4&&x+width>p.x-4&&y<p.y+26&&y+26>p.y))continue;
        ctx.save();rounded(ctx,x,y,width,26,6);
        ctx.fillStyle=selected?'rgba(22,32,67,.97)':'rgba(8,16,36,.89)';ctx.fill();
        ctx.strokeStyle=rgba(node.color,selected?.95:.55);ctx.lineWidth=selected?1.25:1;ctx.stroke();
        ctx.fillStyle=selected?'#ffffff':'#d8e7ff';ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.fillText(label,roof.x,y+13);
        if(selected){ctx.strokeStyle=rgba(node.color,.75);ctx.beginPath();ctx.moveTo(roof.x,y+26);ctx.lineTo(roof.x,roof.y-1);ctx.stroke();}
        ctx.restore();placed.push({x,y,w:width});
      }
    }
    drawIssuePins(ctx,hits){
      // Overlay clickable, evidence-qualified issue pins. A badge is a pointer to
      // an OPEN GitHub issue, NOT a defect finding or a severity prediction.
      this.issueHitAreas=[];
      const placed=[];
      for(const hit of hits){
        if(this.activeDistrict&&hit.node.kind!==this.activeDistrict)continue;
        const match=this.issueMarkers.get(hit.node.id);
        if(!match||(!match.referenced&&!match.suggested&&!match.observed)||hit.dim)continue;
        const count=match.referenced+match.suggested+match.observed,hasRef=match.referenced>0||match.observed>0;
        const roof=hit.roof,x=roof.x+14,y=roof.y-13;
        if(x<19||x>this.width-19||y<20||y>this.height-24)continue;
        // Declutter at the default skyline scale, but never render fake grouped
        // counts: the badge always belongs to one real module.
        if(placed.some(p=>Math.hypot(p.x-x,p.y-y)<29))continue;
        placed.push({x,y});
        ctx.save();
        ctx.shadowColor=hasRef?'#e7b57f':'#89bde0';ctx.shadowBlur=hasRef?15:6;
        ctx.beginPath();ctx.arc(x,y,13.5,0,PI2);
        ctx.fillStyle=hasRef?'rgba(73,46,31,.97)':'rgba(17,39,65,.96)';ctx.fill();
        ctx.strokeStyle=hasRef?'#f3c58b':'#9cbed8';ctx.lineWidth=1.3;ctx.stroke();
        ctx.shadowBlur=0;ctx.font='650 12px system-ui';ctx.fillStyle='#fff5e5';ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.fillText(hasRef?String(count>9?'9+':count):'?',x,y+.5);ctx.restore();
        this.issueHitAreas.push({x,y,nodeId:hit.node.id,name:hit.node.name,
          referenced:match.referenced,suggested:match.suggested,observed:match.observed,count,hitRadius:26,depth:hit.depth});
      }
    }
    drawDistrictLabels(ctx){
      const labels=[];this.districtHitAreas=[];
      // Leading lines identify real (heuristically classified) code districts.
      for(const d of [...this.districts].sort((a,b)=>Number(b.central)-Number(a.central))){
        if(this.activeDistrict&&d.kind!==this.activeDistrict)continue;
        if(!this.activeDistrict&&this.width<560&&!d.central&&!['api','database','test'].includes(d.kind))continue;
        const center=this.project(d.center.x,5,d.center.z);
        const anchor=this.project(d.center.x-d.halfWidth*.25,2,d.center.z-d.halfDepth*.15);
        const name=d.short,count=`${d.count} ${d.count===1?'module':'modules'}`;
        const central=d.central;
        ctx.save();ctx.font='650 12px system-ui';
        const width=Math.max(82,ctx.measureText(name).width+28);
        // Place plaque high enough to clear roofs, offset horizontally from island centre.
        const x=center.x+(central?Math.max(52,center.scale*7):(-d.center.x*.12)),
          y=center.y-(this.view==='plan'?center.scale*d.halfDepth+39:Math.min(105,27+center.scale*11));
        const clampedX=clamp(x-width*.5,7,this.width-width-7);
        const clampedY=clamp(y,12,this.height-52);
        if(labels.some(p=>clampedX<p.x+p.w+5&&clampedX+width>p.x-5&&clampedY<p.y+44&&clampedY+44>p.y)){
          ctx.restore();continue;
        }
        labels.push({x:clampedX,y:clampedY,w:width});
        // Drawn labels are now accessible map controls, not just decoration.
        this.districtHitAreas.push({kind:d.kind,x1:clampedX,y1:clampedY,
          x2:clampedX+width,y2:clampedY+44});
        ctx.strokeStyle=rgba('#bad5f1',.36);ctx.lineWidth=.85;
        ctx.beginPath();ctx.moveTo(anchor.x,anchor.y-5);ctx.lineTo(clampedX+width*.5,clampedY+38);ctx.stroke();
        ctx.fillStyle='rgba(7,16,28,.94)';rounded(ctx,clampedX,clampedY,width,44,6);ctx.fill();
        ctx.strokeStyle=rgba(d.color,.54);ctx.lineWidth=.8;ctx.stroke();
        ctx.fillStyle='#eaf4ff';ctx.font='650 12px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.fillText(name,clampedX+width*.5,clampedY+16);
        ctx.fillStyle='#b3c9dd';ctx.font='500 10px system-ui';ctx.fillText(count,clampedX+width*.5,clampedY+33);
        ctx.restore();
      }
    }
    render(now=performance.now()){
      // Preserve smooth gestures, but avoid repainting the idle skyline at 60 Hz.
      // In particular a large mobile city can be GPU/CPU intensive.
      const transitioning=this.isDragging||this.zoomAnchor||this.spin||
        Math.abs(this.targetDistance-this.distance)>.15||
        Math.abs(this.targetPan.x-this.pan.x)>.1||
        Math.abs(this.targetPan.z-this.pan.z)>.1;
      const minFrameMs=this.width<650?33:transitioning?16:60;
      if(this.lastPaintAt!=null&&now-this.lastPaintAt<minFrameMs){
        this.frame=requestAnimationFrame(t=>this.render(t));return;
      }
      this.lastPaintAt=now;
      const dt=Math.min(50,now-(this.lastTime||now));this.lastTime=now;this.time=now;
      if(this.spin&&!this.motion&&!this.isDragging)this.yaw+=dt*.00018;
      // Use time-based easing, not per-frame or fixed-unit jumps.
      const zoomEase=1-Math.exp(-dt/65);
      if(Math.abs(this.targetDistance-this.distance)>.025){
        this.distance+=(this.targetDistance-this.distance)*zoomEase;
      }else this.distance=this.targetDistance;
      if(this.zoomAnchor){
        const {x,y,planeY,world}=this.zoomAnchor;
        const local=this.screenToWorldOnPlane(x,y,planeY,this.distance,{x:0,z:0});
        if(local){this.pan={x:world.x-local.x,z:world.z-local.z};this.targetPan={...this.pan};}
        if(this.distance===this.targetDistance||!local)this.zoomAnchor=null;
      }else{
        const panEase=1-Math.exp(-dt/130);
        this.pan.x+=(this.targetPan.x-this.pan.x)*panEase;
        this.pan.z+=(this.targetPan.z-this.pan.z)*panEase;
      }
      const ctx=this.ctx;ctx.setTransform(this.pixelRatio,0,0,this.pixelRatio,0,0);
      this.drawSky(ctx);this.drawDistricts(ctx);this.drawEdges(ctx,now);
      const ordered=[...this.nodes].sort((a,b)=>this.project(b.x,b.height/2,b.z).depth-this.project(a.x,a.height/2,a.z).depth);
      this.hitAreas=ordered.map(n=>this.drawBuilding(ctx,n,now));
      this.drawBuildingLabels(ctx,this.hitAreas);this.drawIssuePins(ctx,this.hitAreas);this.drawDistrictLabels(ctx);
      this.frame=requestAnimationFrame(t=>this.render(t));
    }
    destroy(){
      if(this.pendingCompactSelection!==null)clearTimeout(this.pendingCompactSelection);
      cancelAnimationFrame(this.frame);this.resizeObserver.disconnect();
    }
  }
  window.RepoWorldRenderer=RepoWorldRenderer;
  window.REPOWORLD_COLORS=COLORS;
  window.REPOWORLD_DISTRICTS=DISTRICTS;
})();
