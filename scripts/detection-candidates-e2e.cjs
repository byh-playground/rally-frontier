const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
let html=require('./bundle-gamekit.cjs').bundleGame(root,fs.readFileSync(path.join(root,'index.html'),'utf8'));
const end=html.lastIndexOf('})();');
html=html.slice(0,end)+'window.__detectionQA={GLRenderer,VisibilityPolicy,WorldContext,MapGeneration,GameRuleDefinition};'+html.slice(end);
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.setContent(html);await page.waitForFunction(()=>window.__detectionQA);
    const result=await page.evaluate(()=>{
      const {GLRenderer,VisibilityPolicy,WorldContext,MapGeneration,GameRuleDefinition}=window.__detectionQA;
      const canvas=document.createElement('canvas');canvas.width=390;canvas.height=650;const r=new GLRenderer(canvas);
      const descriptor=MapGeneration.generateMapDescriptor({rules:GameRuleDefinition.defaults,seed:8});r.world=WorldContext.fromMap(descriptor);
      const originalSources=VisibilityPolicy.sources,originalPredicate=VisibilityPolicy.sourceCanDetectPoint;
      let seed=12345,mode='reference',referenceCalls=0,indexedCalls=0,compared=0;
      const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
      const sources=[[],[]];
      for(let side=0;side<2;side++)for(let i=0;i<280;i++){
        const x=i%3?1600+random()*800:Math.floor(random()*50)*64,y=i%3?1800+random()*800:Math.floor(random()*60)*64;
        sources[side].push({x,y,r:350,detect:i%70?0:225,level:r.world.terrain.surfaces.levelAt(x,y),air:i%3===0,ignoresTerrainVision:i%17===0});
      }
      // Negative ranges retain the original predicate's zero-radius behavior.
      sources[0].push({x:64,y:128,r:0,detect:-5,level:0,air:true,ignoresTerrainVision:true});
      VisibilityPolicy.sources=(_,side)=>sources[side];
      VisibilityPolicy.sourceCanDetectPoint=function(...args){if(mode==='reference')referenceCalls++;else indexedCalls++;return originalPredicate.apply(this,args)};
      r.snapshot={tick:10,world:r.world,mapDescriptor:descriptor,units:[],buildings:[],activeSpells:[]};r.rebuildVisibilityCache();
      const reference=(x,y,targetAir)=>{
        if(r.replayObserverAll||r.replayVisionMode==='union')return true;
        const targetLevel=targetAir?null:r.world.terrain.surfaces.levelAt(x,y);
        for(const side of r.replayVisionSides())for(const src of r.visionSourcesBySide[side]||[])if(VisibilityPolicy.sourceCanDetectPoint(r.snapshot,src,x,y,{targetAir,targetLevel}))return true;
        return false;
      };
      const points=sources.flatMap(side=>side.flatMap(s=>[[s.x,s.y],[s.x+s.detect,s.y],[s.x-s.detect,s.y]]));
      for(let i=0;i<1500;i++)points.push([random()*r.world.width,random()*r.world.height]);
      for(const x of [-1,0,64,128,256,r.world.width])for(const delta of [-1e-10,0,1e-10])points.push([x+delta,128]);
      try{
        for(const [role,vision,observer] of [['host',null,false],['guest',null,false],['host','guest',false],['guest','union',false],['host',null,true]]){
          r.role=role;r.replayVisionMode=vision;r.replayObserverAll=observer;
          for(const air of [false,true])for(const [x,y]of points){mode='reference';const expected=reference(x,y,air);mode='indexed';const actual=r.detectedRaw(x,y,air);if(expected!==actual)throw Error('Detection mismatch '+JSON.stringify({role,vision,observer,air,x,y}));compared++}
        }
      }finally{VisibilityPolicy.sources=originalSources;VisibilityPolicy.sourceCanDetectPoint=originalPredicate;r.device.dispose()}
      return {compared,referenceCalls,indexedCalls,zeroRadius:true,boundaries:true,signedTerrain:true,replaySides:true};
    });
    assert.deepEqual(errors,[]);assert(result.indexedCalls<result.referenceCalls);
    fs.mkdirSync(path.join(root,'.qa/detection-candidates'),{recursive:true});fs.writeFileSync(path.join(root,'.qa/detection-candidates/result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{await browser.close()}
})().catch(e=>{console.error(String(e.stack).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,'[bundled gamekit]'));process.exitCode=1});
