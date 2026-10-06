const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),cp=require('node:child_process'),path=require('node:path');
const root=path.resolve(__dirname,'..');
(async()=>{
 const kit=await import('data:text/javascript;base64,'+fs.readFileSync(root+'/vendor/gamekit/interpolation.js').toString('base64'));
 const source=fs.readFileSync(root+'/index.html','utf8'),before=cp.execFileSync('git',['show','c6106ee:index.html'],{cwd:root,encoding:'utf8',maxBuffer:5e6});
 const make=s=>{const ctx=vm.createContext({RallyGamekit:kit,performance});vm.runInContext(s.slice(s.indexOf('class RenderStateStore{'),s.indexOf('class FloatingTextPresentationDefinition'))+';globalThis.C=RenderStateStore',ctx);return new ctx.C({unit:{snapDistance:120,fields:{x:{},y:{},angle:{mode:'shortest-angle'}}}})};
 const old=make(before),fresh=make(source);let checks=0;
 for(let tick=0;tick<100;tick++){
  const now=tick*100,duration=tick<50?100:50;
  for(const store of [old,fresh]){
   if(tick===70)store.clear();
   if(tick===0||tick===70)store.ensure('unit',1,{x:3,y:5,angle:6.2},now);
   const epoch=store.begin('unit');
   if(tick!==30)store.track('unit',1,{x:tick*7,y:tick%4,angle:tick*.4},now,epoch,tick===20||tick===60,duration);
   store.track('unit',2,{x:200-tick,y:5,angle:1},now,epoch,false,duration);store.end('unit',epoch);
  }
  for(const t of [now,now+25,now+50])for(const id of [1,2]){
   const a=old.position('unit',id,{},t),b=fresh.position('unit',id,{},t);
   for(const field of ['x','y','angle'])assert.equal(b[field],a[field],JSON.stringify({tick,t,id,field}));checks++;
   if(fresh.has('unit',id))assert.strictEqual(fresh.position('unit',id,{},t),b,'same-time borrowed pose reused');
  }
 }
 const a=fresh.position('unit',1,{},10000),b=fresh.position('unit',2,{},10000);assert.notStrictEqual(a,b,'entity scratch outputs must not alias');
 // Warm repeated sampling: count actual timeline calls and wrapper-object identities.
 const bench=store=>{let calls=0;const timeline=store.state('unit').timeline,original=timeline.sampleInto;timeline.sampleInto=function(...args){calls++;return original.apply(this,args)};const poses=new Set(),start=performance.now();for(let frame=0;frame<1000;frame++)for(let repeat=0;repeat<10;repeat++)for(const id of [1,2])poses.add(store.position('unit',id,{},11000+frame));return {sampleCalls:calls,poseObjects:poses.size,elapsedMs:performance.now()-start}};
 const measurements={before:bench(old),after:bench(fresh)};
 const trackBench=store=>{const entries=new Set(),values=new Set(),deltas=new Set();for(let tick=0;tick<1000;tick++){const epoch=store.begin('unit');for(const id of [1,2]){const e=store.track('unit',id,{x:tick,y:id,angle:tick*.1},13000+tick*100,epoch,false,100);entries.add(e);values.add(e.values);deltas.add(e.delta)}store.end('unit',epoch)}return {entryObjects:entries.size,valueObjects:values.size,deltaObjects:deltas.size}};
 measurements.before.tracking=trackBench(old);measurements.after.tracking=trackBench(fresh);
 assert.deepEqual(measurements.after.tracking,{entryObjects:2,valueObjects:2,deltaObjects:2});
 // A snapshot accepted after a pose read at exactly the same clock invalidates cache.
 const stage=make(source);let epoch=stage.begin('unit');stage.track('unit',1,{x:1,y:2,angle:0},0,epoch,true,100);stage.end('unit',epoch);assert.equal(stage.position('unit',1,{},0).x,1);
 epoch=stage.begin('unit');stage.track('unit',1,{x:99,y:2,angle:0},0,epoch,true,100);stage.end('unit',epoch);assert.equal(stage.position('unit',1,{},0).x,99);
 epoch=stage.begin('unit');stage.end('unit',epoch);epoch=stage.begin('unit');stage.track('unit',1,{x:200,y:2,angle:0},0,epoch,false,100);stage.end('unit',epoch);assert.equal(stage.position('unit',1,{},0).x,200);assert.equal(measurements.after.sampleCalls,2000);assert.equal(measurements.after.poseObjects,2);
 console.log(JSON.stringify({checks,parity:true,measurements},null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
