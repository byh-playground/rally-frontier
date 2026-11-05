// Digest of terrain-dependent behaviour that must stay bit-identical across the geometry-module migration:
// map descriptors, terrain clearance queries, surface mesh, and surface-motion solves on real generated maps.
// Usage: node terraindigest.cjs <repo> [seeds=14]
const path=require('path');const repo=path.resolve(process.argv[2]),count=+(process.argv[3]||14);
const { chromium } = require('playwright');
const { serveSource, routePinnedSDK } = require(path.join(repo,'scripts/netcode-qa-module.cjs'));
(async()=>{const server=await serveSource(path.join(repo,'index.html'),{observer:'globalThis.__ok=1;'});
const b=await chromium.launch({channel:'msedge'});const p=await b.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,200))});
await routePinnedSDK(p);await p.goto(server.url+'#/');await p.waitForFunction(()=>globalThis.__ok&&globalThis.RallyGamekit,null,{timeout:60000});await p.waitForTimeout(500);
const out=await p.evaluate(async(count)=>{
  const base=new URL('./src/',location.href).href;
  const {MapGeneration}=await import(base+'sim/map-generation.js');
  const {WorldContext}=await import(base+'sim/world-context.js');
  const {StrategySim}=await import(base+'sim/strategy-sim.js');
  const fnv=(s)=>{let h=2166136261>>>0;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0}return h.toString(16).padStart(8,'0')};
  const num=(v)=>Object.is(v,-0)?'-0':String(v);
  const rows=[];
  for(let i=0;i<count;i++){
    const seed=1000+i*37;let rng=seed*7+1;const rand=()=>{rng=(Math.imul(rng,1103515245)+12345)>>>0;return rng/4294967296};
    const map=MapGeneration.generateMapDescriptor({seed});
    const row={seed,map:fnv(JSON.stringify(map))};
    const world=WorldContext.fromMap(map),terrain=world.terrain;
    const circleClear=(x,y,r)=>terrain.circleClear?terrain.circleClear(x,y,r):terrain.field.polygonCircleClear(x,y,r);
    const segClear=(a,b,c,d,r)=>terrain.segmentClear?terrain.segmentClear(a,b,c,d,r):terrain.field.polygonSegmentClear(a,b,c,d,r);
    const nearest=(x,y,r,m)=>terrain.nearestOpen?terrain.nearestOpen(x,y,r,m):terrain.field.nearestOpen(x,y,r,m);
    let acc='';
    for(let k=0;k<1500;k++){
      const x=rand()*terrain.width,y=rand()*terrain.height,r=[0,5,13.5,20.25,42][k%5];
      acc+=circleClear(x,y,r)?'1':'0';
      const x2=x+(rand()-.5)*300,y2=y+(rand()-.5)*300;
      acc+=segClear(x,y,x2,y2,r)?'1':'0';
      if(k%30===0){const q=nearest(x,y,r+1,256);acc+=q?num(q.x)+','+num(q.y):'n'}
      acc+=(terrain.projectileSegmentClear?terrain.projectileSegmentClear(x,y,x2,y2):true)?'1':'0';
    }
    row.clear=fnv(acc);
    const mesh=terrain.surfaces.presentationSurfaceMesh();
    row.mesh=fnv(JSON.stringify(mesh,(k,v)=>typeof v==='number'?num(v):v).slice(0,2000000));
    const sim=new StrategySim(seed);
    const nav=sim.navigation,motion=nav.motion.solve?nav.motion:nav.motion.surface;let ms='';
    const clearNav=(...a)=>nav.segmentClear?nav.segmentClear(...a):nav.field.segmentClear(...a);
    for(let k=0;k<700;k++){
      const x=rand()*terrain.width,y=rand()*terrain.height,r=[13.5,20.25][k&1],tx=x+(rand()-.5)*160,ty=y+(rand()-.5)*160;
      const mode=['steer','stop','project'][k%3];
      const s=motion.solve(Math.round(x*100)/100,Math.round(y*100)/100,Math.round(tx*100)/100,Math.round(ty*100)/100,r,k%7===0?'*':null,mode,'u'+k);
      ms+=num(s.x)+','+num(s.y)+','+(s.hit?s.hit.key:'-')+(s.valid===false?'!':'')+';';
      ms+=clearNav(x,y,tx,ty,r,null,k%2===0,.25)?'1':'0';
    }
    row.motion=fnv(ms);
    rows.push(row);
  }
  return rows;
},count);
console.log(JSON.stringify(out));console.log(JSON.stringify(errs.slice(0,3)));await b.close();await server.close()})();
