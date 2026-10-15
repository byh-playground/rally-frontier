// Injected inside the actual game's IIFE by inject.cjs. Never shipped by the game.
const PhysicsProbe=globalThis.PhysicsControllerProbe;
PhysicsProbe.variants=['original','matter-full-1','matter-full-6','rapier-full-1','rapier-full-6','matter-guarded','rapier-guarded','matter-guarded-lite','rapier-guarded-lite'];
PhysicsProbe.records=new WeakMap();
PhysicsProbe.defaultVariant='original';
PhysicsProbe.originalSolve=StrategySim.prototype.solveContacts;
PhysicsProbe.frame=function(sim,{stationary=false}={}){
  const units=[];
  for(let i=0;i<sim.units.length;i++){
    const u=sim.units[i],d=UnitDefinition.get(u.type);
    if(!u.alive||d?.crowdCollision===false||u.capability(LeapableMixin.KEY)?.isActive(sim)||u.objectiveChargeActive)continue;
    const x0=stationary?u.x:i<sim.collisionStartCount?sim.collisionStartFx[i]/FP:u.x;
    const y0=stationary?u.y:i<sim.collisionStartCount?sim.collisionStartFy[i]/FP:u.y;
    units.push({id:String(u.id),index:i,side:u.side,layer:sim.unitLayer(u.type),burrow:!!u.capability(BurrowableMixin.KEY)?.isActive(),
      radius:sim.radiusFP(u)/FP,mass:sim.mass(u),x0,y0,x1:u.x,y1:u.y,
      hasIntent:u.collisionIntentTick===sim.tick,intentX:u.collisionIntentTx??u.x,intentY:u.collisionIntentTy??u.y});
  }
  return {tick:sim.tick,dt:1/sim.tps,bounds:{width:sim.world.width,height:sim.world.height},units};
};
PhysicsProbe.attach=function(sim,variant=this.defaultVariant){
  if(!this.variants.includes(variant))throw Error('Unknown physics variant '+variant);
  this.records.get(sim)?.controller?.dispose();
  const guarded=variant.includes('-guarded'),engine=variant.split('-')[0],lite=variant.endsWith('-lite');
  const C=engine==='matter'?this.MatterController:engine==='rapier'?this.RapierController:null;
  const controller=C?new C({substeps:variant.endsWith('-6')?6:1,collisionPolicy:guarded?'allies':'all'}):null;
  if(guarded&&engine==='rapier'){
    // This path replaces positional separation, so tune Rapier's soft recovery
    // toward a hard position constraint and use the game's 0.01-unit quantum.
    controller.world.integrationParameters.contact_natural_frequency=1e6;
    controller.world.integrationParameters.normalizedAllowedLinearError=.0001;
    if(lite)controller.world.numSolverIterations=1;
  }
  if(lite&&engine==='matter'){
    // Only positional separation is requested here. Avoid paying six position
    // and four velocity iterations inside EACH of the game's eight iterations.
    controller.engine.positionIterations=1;
    controller.engine.velocityIterations=0;
    controller.engine.constraintIterations=0;
  }
  const record={variant,guarded,controller,lastMs:0,lastEngineMs:0,lastCalls:0,diagnostics:null};this.records.set(sim,record);return record;
};
PhysicsProbe.write=function(sim,frame,result,cap=false){
  let changed=0;
  const frames=new Map(frame.units.map(u=>[u.index,u]));
  for(const p of result.positions){
    const u=sim.units[p.index],f=frames.get(p.index);if(!u||!f||!Number.isFinite(p.x)||!Number.isFinite(p.y))throw Error('Invalid engine position');
    let dx=Math.round(p.x*FP)-u.fx,dy=Math.round(p.y*FP)-u.fy;
    if(cap){const limit=Math.max(FP,Math.round(f.radius*FP)),length=Math.hypot(dx,dy);if(length>limit){dx=Math.trunc(dx*limit/length);dy=Math.trunc(dy*limit/length)}}
    if(dx||dy)changed++;
    u.fx+=dx;u.fy+=dy;u.x=u.fx/FP;u.y=u.fy/FP;
  }
  return changed;
};
PhysicsProbe.projectAllies=function(sim){
  const r=this.records.get(sim),frame=this.frame(sim,{stationary:true});frame.dt/=COLLISION_ITERS;
  frame.projectionOnly=r.variant.endsWith('-lite');
  const started=performance.now(),result=r.controller.solve(frame);r.lastEngineMs+=performance.now()-started;r.lastCalls++;r.diagnostics=result.diagnostics;
  const changed=this.write(sim,frame,result,true);
  return r.variant.endsWith('-lite')?changed:Math.max(changed,Number(result.diagnostics.contacts)||0);
};
// Only replace the allied Jacobi pair scan/application. Original enemy sweeps,
// terrain constraints, fixed-point bounds and SAP recovery stay in this path.
{
  const source=PhysicsProbe.originalSolve.toString(),start=source.indexOf('      for(let i=0;i<n;i++){\n        const a=units[i];'),
    end=source.indexOf('      // Allied crowd correction',start);
  if(start<0||end<0)throw Error('Original PBD region changed; probe must be reviewed');
  const replacement=`      overlaps=PhysicsProbe.projectAllies(this);\n      if(perf){perf.collisionPbdApplyMs+=now()-mark;perf.collisionOverlaps+=overlaps}\n\n`;
  const guarded=source.slice(0,start)+replacement+source.slice(end);
  PhysicsProbe.guardedSolve=eval('({'+guarded+'}).solveContacts');
  const lean=guarded.replace('      grid.reset(units);','      // Engine owns allied broad-phase; enemy sweep rebuilds its own grid.')
    .replace('      dxA.fill(0,0,n);dyA.fill(0,0,n);cnt.fill(0,0,n);','      // Original Jacobi accumulators are unused by the replacement.');
  PhysicsProbe.guardedLiteSolve=eval('({'+lean+'}).solveContacts');
}
StrategySim.prototype.solveContacts=function(){
  const r=PhysicsProbe.records.get(this)||PhysicsProbe.attach(this);
  const started=performance.now();r.lastEngineMs=0;r.lastCalls=0;
  try{
    if(!r.controller)return PhysicsProbe.originalSolve.call(this);
    if(r.guarded)return (r.variant.endsWith('-lite')?PhysicsProbe.guardedLiteSolve:PhysicsProbe.guardedSolve).call(this);
    this.constrainSurfaceContacts();
    const frame=PhysicsProbe.frame(this),t=performance.now(),result=r.controller.solve(frame);
    r.lastEngineMs=performance.now()-t;r.lastCalls=1;r.diagnostics=result.diagnostics;
    PhysicsProbe.write(this,frame,result);
    this.constrainSurfaceContacts();
    for(const u of this.units)if(u.alive)this.syncUnitSpatial(u);
  }finally{r.lastMs=performance.now()-started}
};
const physicsOriginalCreate=StrategySim.createForMatch;
StrategySim.createForMatch=function(...args){const s=physicsOriginalCreate.apply(this,args);PhysicsProbe.attach(s);return s};
// Include full engine warm state in QA game snapshots and checksums. The codec's
// array/string limits are respected by chunking a JSON representation, not by
// dropping solver caches. None of these fields are added to production source.
PhysicsProbe.packState=function(state){
  const json=JSON.stringify(state,(_,v)=>{
    if(!ArrayBuffer.isView(v))return v;
    const bytes=new Uint8Array(v.buffer,v.byteOffset,v.byteLength),parts=[];
    for(let i=0;i<bytes.length;i+=32768)parts.push(String.fromCharCode(...bytes.subarray(i,i+32768)));
    return {physicsBytes:btoa(parts.join(''))};
  }),chunks=[];
  for(let i=0;i<json.length;i+=64000)chunks.push(json.slice(i,i+64000));return chunks;
};
PhysicsProbe.unpackState=chunks=>JSON.parse(chunks.join(''),(_,v)=>v&&typeof v.physicsBytes==='string'?Uint8Array.from(atob(v.physicsBytes),c=>c.charCodeAt(0)):v);
const physicsOriginalExport=StrategySim.prototype.exportState,physicsOriginalImport=StrategySim.prototype.importState,physicsOriginalDispose=StrategySim.prototype.dispose;
StrategySim.prototype.exportState=function(...args){
  const state=physicsOriginalExport.apply(this,args),r=PhysicsProbe.records.get(this);
  if(r?.controller)state.physicsControllerState={variant:r.variant,chunks:PhysicsProbe.packState(r.controller.snapshot())};
  return state;
};
StrategySim.prototype.importState=function(state,...args){
  const core={...state};delete core.physicsControllerState;const result=physicsOriginalImport.call(this,core,...args);
  const external=state.physicsControllerState;
  if(external){const r=PhysicsProbe.attach(this,external.variant);r.controller.restore(PhysicsProbe.unpackState(external.chunks))}
  else PhysicsProbe.attach(this,'original');return result;
};
StrategySim.prototype.dispose=function(...args){try{return physicsOriginalDispose.apply(this,args)}finally{PhysicsProbe.records.get(this)?.controller?.dispose();PhysicsProbe.records.delete(this)}};
PhysicsProbe.exposed={StrategySim,GameRuleDefinition,DebugScenarioHarness,RallyStateCodec,BuildingDefinition,UnitDefinition,Unit,MapGeneration,ECONOMY_WORKER_TYPE,NEUTRAL_SIDE,FP,
  ActiveViewState,MatchLifecycle,GameSession,SurfaceMotion,ReplayPresentation,COLLISION_ITERS};
