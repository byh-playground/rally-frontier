const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.qa/fog-visibility-reuse');
let html=require('./bundle-gamekit.cjs').bundleGame(root,fs.readFileSync(path.join(root,'index.html'),'utf8')),end=html.lastIndexOf('})();');
html=html.slice(0,end)+'window.__fogReuseQA={GLRenderer,MiniMap,VisibilityPolicy,WorldContext,MapGeneration,GameRuleDefinition,TerrainNavigation};'+html.slice(end);
(async()=>{fs.mkdirSync(out,{recursive:true});const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setContent(html);await page.waitForFunction(()=>window.__fogReuseQA);
  const result=await page.evaluate(()=>{
    const {GLRenderer,MiniMap,WorldContext,MapGeneration,GameRuleDefinition,TerrainNavigation}=window.__fogReuseQA;
    const check=(v,m)=>{if(!v)throw Error(m)},equal=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
    const rect=(x0,y0,x1,y1)=>[{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}];
    const maps=[{width:3200,height:4096,terrain:{layers:[{id:'bank',level:-1,points:rect(700,800,2600,3400),innerPoints:rect(850,950,2450,3250)},{id:'high',level:5,points:rect(1200,1300,2000,2100)}],ramps:[{id:'high-ramp',layerId:'high',edge:0,t0:.2,t1:.6,run:160}],blockers:[],bridges:[{id:'bridge',x:1600,y:2700,angle:.18,halfLength:1000,halfWidth:70,level:0}]}},
      MapGeneration.generateMapDescriptor({rules:GameRuleDefinition.defaults,seed:8})];
    const canvas=document.createElement('canvas');canvas.width=390;canvas.height=650;const r=new GLRenderer(canvas),miniCanvas=document.createElement('canvas'),mini=new MiniMap(miniCanvas);
    const source=(x,y,level,radius,extra={})=>({x,y,level,r:radius,detect:0,air:false,ignoresTerrainVision:false,...extra});
    const grid=sources=>{const maps=[new Map(),new Map()];for(let side=0;side<2;side++)for(const s of sources[side])for(let y=Math.floor((s.y-s.r)/r.visionCellSize);y<=Math.floor((s.y+s.r)/r.visionCellSize);y++)for(let x=Math.floor((s.x-s.r)/r.visionCellSize);x<=Math.floor((s.x+s.r)/r.visionCellSize);x++){const key=x+','+y;if(!maps[side].has(key))maps[side].set(key,[]);maps[side].get(key).push(s)}return maps};
    let compared=0,oracleRays=0,sharedRays=0;const cases=[];
    for(const descriptor of maps){
      r.world=WorldContext.fromMap(descriptor);r.snapshot={tick:10,world:r.world,mapDescriptor:descriptor,units:[],buildings:[],activeSpells:[]};
      const atlas=r.world.terrain.surfaces,sources=[[source(800,1000,0,1700),source(1600,1700,5,1700),source(2700,3000,0,700,{air:true})],
        [source(900,1800,-1,1200),source(2200,2000,0,1200,{ignoresTerrainVision:true})]];
      r.visionGridBySide=grid(sources);r.prepareFogSurfaces(atlas);
      const nav=TerrainNavigation.forState(r.snapshot),ray=nav.visionSegmentClear.bind(nav);let calls=0;nav.visionSegmentClear=(...a)=>{calls++;return ray(...a)};
      for(const [role,vision]of[['host',null],['guest',null],['host','guest'],['guest','union']]){
        r.role=role;r.replayVisionMode=vision;r.replayObserverAll=false;
        const fields=[];for(const step of[64,128]){
          r.fogMaskStep=step;const w=Math.max(2,Math.ceil(r.world.width/step)+1),h=Math.max(2,Math.ceil(r.world.height/step)+1),oracle=new Map();calls=0;
          for(const level of r.fogSurfaces.keys()){const mask=new Uint8Array(w*h);for(let j=0;j<h;j++)for(let i=0;i<w;i++)mask[j*w+i]=r.visibleRawAtLevel(i/(w-1)*r.world.width,j/(h-1)*r.world.height,level)?255:0;oracle.set(level,mask)}oracleRays+=calls;calls=0;
          const field=r.fogVisibilityGrid(step);for(const [level,mask]of oracle){const actual=field.atLevel(level);check(equal(mask,actual),'Level mask mismatch: '+role+'/'+vision+'/'+level+'/'+step);compared+=mask.length}sharedRays+=calls;fields.push(field);
        }
        r.fogMaskStep=64;const field=r.fogVisibilityGrid(64),oracle=new Uint8Array(field.w*field.h);
        for(let j=0;j<field.h;j++)for(let i=0;i<field.w;i++)oracle[j*field.w+i]=r.visibleRaw(r.viewX(i/(field.w-1)*r.world.width),r.viewY(j/(field.h-1)*r.world.height),false)?255:0;
        const actual=field.atGround(r);check(equal(actual,oracle),'Ground mask mismatch: '+role+'/'+vision);compared+=oracle.length;
        const generation=field.generation,target=field.atLevel(0),saved=target.slice();calls=0;
        r.cameraLeft+=13;r.cameraTop+=7;r.fogVisibilityGrid(64).atGround(r);r.fogVisibilityGrid(64).atLevel(0);check(calls===0&&field.generation===generation,'Camera-only update rebuilt visibility');
        mini.set(r,r.snapshot);mini.canvas.width=390;mini.canvas.height=650;mini.drawFog();const image=mini.fogMask.getContext('2d').getImageData(0,0,field.w,field.h).data;
        for(let k=0;k<actual.length;k++)check(image[k*4+3]===(actual[k]?0:(vision?245:224)),'Minimap alpha mismatch');calls=0;mini.drawFog();check(calls===0,'Repeated minimap recomputed rays');
        r.visionGridBySide=grid([[source(2000,1800,5,800)],[]]);const changed=r.fogVisibilityGrid(64);check(changed.generation>generation,'Same-tick correction kept stale field');changed.atLevel(0);check(equal(target,saved),'Old transition target was mutated');
        r.visionGridBySide=grid(sources);r.fogVisibilityGrid(64);
        cases.push({role,vision,width:r.world.width,height:r.world.height,levels:[...r.fogSurfaces.keys()],cameraReuse:true,sameTickInvalidation:true,immutablePriorTarget:true});
      }
      r.replayObserverAll=true;const observer=r.fogVisibilityGrid(64).atLevel(5);check(observer.every(x=>x===255),'Observer visibility differs');r.replayObserverAll=false;
    }
    check(sharedRays<oracleRays,'Shared field did not reduce terrain rays');
    r.device.dispose();return{comparedTexels:compared,oracleRays,sharedRays,cases};
  });
  assert(result.comparedTexels>10000);assert(result.sharedRays<result.oracleRays);assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({result,errors},null,2));console.log(JSON.stringify({comparedTexels:result.comparedTexels,oracleRays:result.oracleRays,sharedRays:result.sharedRays,cases:result.cases.length,errors},null,2));
}finally{await browser.close()}})().catch(e=>{console.error(e.stack);process.exitCode=1});
