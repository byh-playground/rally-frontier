const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const FP=100,RangeUtil={clamp:(v,a,b)=>Math.max(a,Math.min(b,v))};
const {Coarse,Fine,Contact}=new Function('FP','RangeUtil',extract('class SweptCircleContact{','class SurfaceContactGeometry{')+extract('class DeterministicCollisionGrid{','class DeterministicUnitSpatialGrid{')+';return {Coarse:DeterministicCollisionGrid,Fine:DeterministicSweptCollisionGrid,Contact:SweptCircleContact};')(FP,RangeUtil);
let seed=123456789;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
let queries=0,oldCandidates=0,fineCandidates=0,actualHits=0,overflowQueries=0;
for(let scene=0;scene<160;scene++){
  const world={width:1024,height:1024},n=scene%3===0?128:48,coarse=new Coarse(128,world),fine=new Fine(world);
  const radii=new Int32Array(n),sx=new Int32Array(n),sy=new Int32Array(n),motion={flags:new Uint8Array(n),layers:[]};
  const units=Array.from({length:n},(_,i)=>{
    const boundary=scene%5===0,cluster=scene%3===0;
    const x=boundary?Math.floor(random()*8)*128*FP+(i%3-1):Math.round((cluster?480+random()*64:random()*1024)*FP);
    const y=boundary?Math.floor(random()*16)*64*FP+(i%3-1):Math.round((cluster?480+random()*64:random()*1024)*FP);
    radii[i]=[675,2025,4725,8100][i%4];motion.flags[i]=i%19===0?1:0;motion.layers[i]=i%3?'AIR':'GROUND';
    sx[i]=i%7===0?Math.round(random()*world.width*FP):x+Math.round((random()-.5)*6000);
    sy[i]=i%7===0?Math.round(random()*world.height*FP):y+Math.round((random()-.5)*6000);
    if(i%4===0){sx[i]=x;sy[i]=y}
    return {fx:x,fy:y,alive:i%23!==0,side:i%3};
  });
  coarse.reset(units);fine.reset(units,motion,radii,sx,sy,coarse);
  const before=JSON.stringify(coarse.buckets);
  const radius=new Map(),travel=new Map();
  for(let i=0;i<n;i++)if(units[i].alive&&!motion.flags[i]){const l=motion.layers[i];radius.set(l,Math.max(radius.get(l)||0,radii[i]));travel.set(l,Math.max(travel.get(l)||0,Math.ceil(Math.hypot(units[i].fx-sx[i],units[i].fy-sy[i]))))}
  for(let i=0;i<n;i++){
    const a=units[i],layer=motion.layers[i];if(!a.alive||motion.flags[i]||!travel.get(layer))continue;
    const reach=radii[i]+radius.get(layer)+travel.get(layer);
    const x0=coarse.cellXFP(Math.min(sx[i],a.fx)-reach),x1=coarse.cellXFP(Math.max(sx[i],a.fx)+reach),y0=coarse.cellYFP(Math.min(sy[i],a.fy)-reach),y1=coarse.cellYFP(Math.max(sy[i],a.fy)+reach);
    const original=[];for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)for(const j of coarse.buckets[y*coarse.cols+x])if(j>i&&!motion.flags[j])original.push(j);
    const b=fine.bounds,expected=original.filter(j=>!(b.maxX[i]<b.minX[j]||b.maxX[j]<b.minX[i]||b.maxY[i]<b.minY[j]||b.maxY[j]<b.minY[i]));
    const actual=[...fine.query(i,coarse,x0,x1,y0,y1)];
    assert.deepEqual(actual,expected,'Exactly ordered pruning of old candidates, scene '+scene+' unit '+i);
    assert(fine.lists.length<=17);assert.equal(new Set(actual).size,actual.length);
    for(const j of original){
      const u=units[j];if(motion.layers[j]!==layer||((a.side===0||a.side===1)&&a.side===u.side))continue;
      const vx=(a.fx/FP-sx[i]/FP)-(u.fx/FP-sx[j]/FP),vy=(a.fy/FP-sy[i]/FP)-(u.fy/FP-sy[j]/FP);
      const hit=Contact.cast(sx[i]/FP-sx[j]/FP,sy[i]/FP-sy[j]/FP,vx,vy,(radii[i]+radii[j])/FP,Contact.policies.relative,()=>({x:1,y:0}));
      if(hit){assert(actual.includes(j),'No original TOI contact may be discarded');actualHits++}
    }
    const cells=(fine.cellX(b.maxX[i])-fine.cellX(b.minX[i])+1)*(fine.cellY(b.maxY[i])-fine.cellY(b.minY[i])+1);if(cells>16)overflowQueries++;
    queries++;oldCandidates+=original.length;fineCandidates+=actual.length;
  }
  assert.equal(JSON.stringify(coarse.buckets),before,'Queries never mutate old bins');
}
console.log(JSON.stringify({scenes:160,queries,oldCandidates,fineCandidates,actualHits,overflowQueries,ordered:true,contactsPreserved:true}));
