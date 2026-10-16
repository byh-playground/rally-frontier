// No browser or gameplay fixture: exercise the extracted owners with the exact
// SHA-verified public simloop module and deterministic timer/Worker transports.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/\r\n/g,'\n');
const gamekit=require('./setup-gamekit.cjs').readGamekit(root,process.env.QA_GAMEKIT_CACHE||path.join(root,'.cache','gamekit'));
const results=[];
function test(name,fn){const evidence=fn();results.push({name,pass:true,...(evidence?{evidence}:{})});}
function timers(){let now=0,serial=0;const pending=new Map();return{pending,set(fn,ms){const id=++serial;pending.set(id,{fn,at:now+ms});return id;},clear(id){pending.delete(id);},advance(ms){now+=ms;},fire(){const [id,event]=[...pending].sort((a,b)=>a[1].at-b[1].at)[0]||[];assert(event,'timer missing');pending.delete(id);now=Math.max(now,event.at);event.fn();},get now(){return now;}};}
async function main(){
 const sdk=await import('data:text/javascript;base64,'+gamekit.modules.simloop.toString('base64'));
 const setupStart=html.indexOf('    this.netcodeLoop=RallyNetcode.createLoop('),setupEnd=html.indexOf("onError:error=>this.enterSimulationFatal(error,{source:'netcode-loop'})});",setupStart)+"onError:error=>this.enterSimulationFatal(error,{source:'netcode-loop'})});".length;
 assert(setupStart>0&&setupEnd>setupStart);
 const pulseStart=html.indexOf('  advanceSimulation(now=performance.now()){'),pulseEnd=html.indexOf('\nenterSimulationFatal',pulseStart);
 const dropStart=html.indexOf('  onBacklogDrop({'),dropEnd=html.indexOf('  emitNetworkHealth(',dropStart);let driverDrops=[];
 const owner=vm.runInNewContext('(class{'+html.slice(dropStart,dropEnd)+html.slice(pulseStart,pulseEnd)+'})',{performance:{now:()=>0},StateValue:{copy:structuredClone},SNAPSHOT_EMIT_INTERVAL_MS:100,RecoveryTelemetry:{recordRecovery(_name,_session,_transport,event){driverDrops.push(event);}}});
 function sessionFixture(tps=20){
  let cpu=0,polls=0,advances=0,stepCost=0,pollCost=0,progressCalls=0,presentationCalls=0,snapshotCalls=0,drops=[];driverDrops=drops;
  const session={inputSize:1,profile:{tickRate:tps,maxCatchupSteps:3},metrics:{pace:1},tick:0,closed:false,resimulating:false,
   poll(){polls++;cpu+=pollCost;},advance(){assert(!this.resimulating);advances++;cpu+=stepCost;this.tick++;return{status:'advanced'};}};
  const game=Object.assign(new owner(),{sim:{tick:0,tps,snapshot:()=>({events:[]})},simEnded:false,simulationFatal:false,netcodeSession:session,neutralInput:new Uint8Array(1),netcodeNow:0,lastDriverPulseAt:0,lastSnapshotEmitAt:0,frameOutputs:new Map(),presentationEventBuffer:[],presentationEventsPublished:0,
   reconcileNetcodeProgress(){progressCalls++;this.sim.tick=session.tick;},reconcileNetcodePresentation(){presentationCalls++;},publishNetcodeSnapshot(){snapshotCalls++;},emitSnapshot(){},enterSimulationFatal(e){throw e;}});
  const setup=new Function('RallyNetcode','performance','MAX_CATCHUP_STEPS_PER_PULSE','SIM_SUSPENSION_THRESHOLD_MS',html.slice(setupStart,setupEnd));setup.call(game,sdk,{now:()=>cpu},3,3000);
  return{game,session,drops,setStepCost:n=>stepCost=n,setPollCost:n=>pollCost=n,get polls(){return polls;},get advances(){return advances;},get progressCalls(){return progressCalls;},get presentationCalls(){return presentationCalls;},get snapshotCalls(){return snapshotCalls;}};
 }
 test('ordinary 250/500 ms CPU delay still polls and advances, with three catchup ticks maximum',()=>{const f=sessionFixture();f.game.advanceSimulation(0);f.game.advanceSimulation(250);assert.equal(f.polls,2);assert.equal(f.advances,3);f.game.advanceSimulation(750);assert.equal(f.advances,6);assert.equal(f.drops.length,0);});
 test('12 ms budget yields only after first due step, including expensive synchronous poll',()=>{const f=sessionFixture();f.setPollCost(30);f.setStepCost(20);f.game.advanceSimulation(0);f.game.advanceSimulation(500);assert.equal(f.polls,2);assert.equal(f.advances,1);f.game.advanceSimulation(550);assert.equal(f.advances,2);assert.equal(f.drops.length,0);});
 test('simulation progress runs for each due tick while presentation and UI snapshot publication run once per pulse',()=>{const f=sessionFixture();f.game.advanceSimulation(0);f.game.advanceSimulation(200);assert.equal(f.advances,3);assert.equal(f.progressCalls,5);assert.equal(f.presentationCalls,2);assert.equal(f.snapshotCalls,2);return{pulses:2,authoritativeAdvances:f.advances,progressCallbacks:f.progressCalls,presentationCallbacks:f.presentationCalls,snapshotCallbacks:f.snapshotCalls};});
 test('single multi-second gap invokes clock-gap diagnostics, rebases presentation and never advances discarded debt',()=>{const f=sessionFixture();f.game.advanceSimulation(0);f.game.advanceSimulation(50);assert.equal(f.advances,1);f.game.advanceSimulation(3100);assert.equal(f.drops.length,1);assert.equal(f.drops[0].elapsedMs,3050);assert.equal(f.drops[0].droppedMs,3050);assert.equal(f.drops[0].reason,'clock-gap');assert.equal(f.polls,3);assert.equal(f.advances,1);assert.equal(f.game.renderTimelineChanged,true);f.game.advanceSimulation(3150);assert.equal(f.advances,2);});
 test('backlog diagnostics preserve bounded wall-clock overflow details without changing the authoritative tick',()=>{const f=sessionFixture();f.game.sim.tick=41;f.game.onBacklogDrop({elapsedMs:80,droppedMs:35,droppedTicks:0,timestamp:900,reason:'backlog-overflow'});assert.equal(f.drops.length,1);assert.equal(f.drops[0].droppedMs,35);assert.equal(f.drops[0].reason,'backlog-overflow');assert.equal(f.game.sim.tick,41);return{tick:f.game.sim.tick,droppedWallClockMs:f.drops[0].droppedMs,reason:f.drops[0].reason};});
 test('repeated held pulses cap wall-clock debt at three seconds and then resume real ticks in sequence',()=>{const f=sessionFixture();f.game.advanceSimulation(0);f.game.syncHold=true;for(let now=500;now<=4000;now+=500)f.game.advanceSimulation(now);assert.equal(f.session.tick,0);assert.equal(f.advances,0);assert.equal(f.polls,9);assert.equal(f.drops.length,2);for(const event of f.drops){assert.equal(event.reason,'backlog-overflow');assert.equal(event.droppedMs,500);}f.game.syncHold=false;f.game.advanceSimulation(4500);assert.equal(f.advances,3);assert.equal(f.session.tick,3);assert.equal(f.polls,10);return{heldPulses:8,droppedWallClockMs:f.drops.reduce((sum,event)=>sum+event.droppedMs,0),resumedTicks:f.session.tick,resumeBudget:f.session.profile.maxCatchupSteps};});
 test('held and resimulating sessions continue polling, never advance through atomic rollback',()=>{const f=sessionFixture();f.game.advanceSimulation(0);f.game.syncHold=true;f.game.advanceSimulation(50);assert.equal(f.polls,2);assert.equal(f.advances,0);f.game.syncHold=false;f.session.resimulating=true;f.game.advanceSimulation(100);assert.equal(f.polls,3);assert.equal(f.advances,0);f.session.resimulating=false;f.game.advanceSimulation(150);assert(f.advances>0);});
 test('per-pulse CPU budget and a held session preserve timing continuity without rebasing the display',()=>{const f=sessionFixture();f.game.advanceSimulation(0);f.setStepCost(20);f.game.advanceSimulation(150);assert.equal(f.advances,1);assert.equal(f.game.driverLastAlpha,1);assert(!f.game.renderTimelineChanged);const held=sessionFixture();held.game.advanceSimulation(0);held.game.syncHold=true;held.game.advanceSimulation(100);assert(!held.game.renderTimelineChanged);});
 const interpolation=await import('data:text/javascript;base64,'+gamekit.modules.interpolation.toString('base64'));
 const fieldsStart=html.indexOf('const RenderField=RallyGamekit.RenderObject;'),fieldsEnd=html.indexOf('// wall-clock driver',fieldsStart);
 const storeStart=html.indexOf('class RenderStateStore{'),storeEnd=html.indexOf('class FloatingTextPresentationDefinition',storeStart);
 const storeContext={RallyGamekit:interpolation,structuredClone,performance:{now:()=>0}};vm.createContext(storeContext);
 vm.runInContext(html.slice(fieldsStart,fieldsEnd)+html.slice(storeStart,storeEnd)+';this.makeStore=()=>new RenderStateStore(RENDER_TRACKS);',storeContext);
 test('actual pinned RenderStateStore interpolates after a 700 ms driver gap while defer keeps bounded tick debt',()=>{
  const f=sessionFixture(10),store=storeContext.makeStore();let receiptAt=0,resets=0;
  const flags=()=>({tick:f.session.tick,units:[],projectiles:[],flags:[{x:f.session.tick*10,y:20,forced:false}]});
  store.capture(flags(),0,true,100);
  f.game.reconcileNetcodePresentation=()=>{
    f.game.sim.tick=f.session.tick;
    if(f.game.renderTimelineChanged||f.game.renderedTick!==f.session.tick){
      const reset=!!f.game.renderTimelineChanged;if(reset)resets++;
      store.capture(flags(),receiptAt,reset,100);f.game.renderTimelineChanged=false;f.game.renderedTick=f.session.tick;
    }
  };
  f.game.advanceSimulation(0);receiptAt=100;f.game.advanceSimulation(100);
  assert.equal(store.position('flag',0,null,250).x,5);
  receiptAt=800;f.game.advanceSimulation(800);assert.equal(resets,0);assert.equal(f.drops.length,0);assert.equal(f.polls,3);assert(f.advances>1);
  // A sub-suspension gap keeps the current display timeline continuous.
  const start=store.position('flag',0,null,800).x;
  const midpoint=store.position('flag',0,null,850).x;
  receiptAt=900;const before=f.session.tick;f.game.advanceSimulation(900);
  const nextMidpoint=store.position('flag',0,null,950).x;
  // The next receipt must keep interpolation moving without changing authority.
  assert.equal(midpoint,start);
  assert(nextMidpoint>midpoint&&nextMidpoint<=f.session.tick*10,'next 100ms receipt did not advance the delayed display');
  const nextPulseAdvances=f.session.tick-before,remainingDebtMs=900-f.session.tick*100;
  assert.equal(nextPulseAdvances,f.session.profile.maxCatchupSteps);
  assert(remainingDebtMs>0&&remainingDebtMs<=700,'deferred wall-clock debt escaped its bounded catch-up budget');
  assert.equal(flags().flags[0].x,f.session.tick*10);
  return{gapMs:700,resets,polls:f.polls,nextPulseAdvances,remainingDebtMs,gapResetX:start,nextReceiptMidpointX:nextMidpoint,authoritativeX:flags().flags[0].x};
 });
 test('bounded defer policy carries a sub-threshold backlog in order and preserves the next midpoint',()=>{
  const f=sessionFixture(),store=storeContext.makeStore();let receiptAt=0,resets=0;
  const flags=()=>({tick:f.session.tick,units:[],projectiles:[],flags:[{x:f.session.tick*10,y:20,forced:false}]});
  store.capture(flags(),0,true,50);
  f.game.reconcileNetcodePresentation=()=>{
    f.game.sim.tick=f.session.tick;
    if(f.game.renderTimelineChanged||f.game.renderedTick!==f.session.tick){
      if(f.game.renderTimelineChanged)resets++;
      store.capture(flags(),receiptAt,!!f.game.renderTimelineChanged,50);f.game.renderTimelineChanged=false;f.game.renderedTick=f.session.tick;
    }
  };
  const timestamps=[0,49,169,219,268,388,438,487,607];
  for(const timestamp of timestamps){receiptAt=timestamp;f.game.advanceSimulation(timestamp);}
  assert.equal(resets,0);assert.equal(f.drops.length,0);
  assert.equal(f.polls,timestamps.length);assert.equal(f.session.tick,12);assert(Math.abs(f.game.driverLastAlpha-0.14)<1e-9);
  const seedX=store.position('flag',0,null,607).x;
  receiptAt=657;f.game.advanceSimulation(receiptAt);
  const midpointX=store.position('flag',0,null,682).x;
  assert(midpointX>seedX&&midpointX<flags().flags[0].x,'accumulated short cap loss held the display endpoint');
  assert.equal(f.session.tick,13);assert(Math.abs(f.game.driverLastAlpha-0.14)<1e-9);
  return{timestamps,resets,polls:f.polls,seedX,midpointX,authoritativeX:flags().flags[0].x};
 });
 test('a held session resumes without an alpha-only presentation reset',()=>{
  const f=sessionFixture();f.game.advanceSimulation(0);f.game.advanceSimulation(50);f.game.syncHold=true;
  f.game.advanceSimulation(100);assert.equal(f.game.driverLastAlpha,1);
  f.game.syncHold=false;f.game.renderTimelineChanged=false;f.game.advanceSimulation(110);assert.equal(f.game.renderTimelineChanged,false);assert.equal(f.polls,4);
 });
 test('ended and fatal owners never pulse; Core callback errors use the existing fatal boundary',()=>{const f=sessionFixture();f.game.simEnded=true;f.game.advanceSimulation(50);assert.equal(f.polls,0);f.game.simEnded=false;f.game.simulationFatal=true;f.game.advanceSimulation(100);assert.equal(f.polls,0);f.game.simulationFatal=false;f.game.reconcileNetcodePresentation=()=>{throw Error('callback failure');};assert.throws(()=>f.game.advanceSimulation(150),/callback failure/);});
 const start=html.indexOf('class AppLifecycle{'),ensure=html.indexOf('  static ensureBackgroundTicker(){',start),end=html.indexOf('\n}\n}\n',ensure)+5;
 assert(start>0&&end>ensure);
 const timer=timers(),workers=[],transport=[],sessions=new Set([{}]);let pulses=0,failConstruction=false;
 class Worker{
  constructor(source){if(failConstruction)throw Error('Worker unavailable');this.timer=timers();this.context={performance:{now:()=>this.timer.now},setTimeout:(fn,ms)=>this.timer.set(fn,ms),clearTimeout:id=>this.timer.clear(id),postMessage:data=>transport.push({worker:this,data})};vm.createContext(this.context);vm.runInContext(source,this.context);workers.push(this);}
  postMessage(data){this.context.onmessage({data});}
  terminate(){this.terminated=true;this.timer.pending.clear();}
 }
 const context={Worker,Blob:class{constructor(parts){this.source=parts.join('');}},URL:{createObjectURL:blob=>blob.source,revokeObjectURL(){}},setTimeout:(fn,ms)=>timer.set(fn,ms),clearTimeout:id=>timer.clear(id),BACKGROUND_TICK_PULSE_MS:25,BACKGROUND_TICK_SESSIONS:sessions,performance:{now:()=>timer.now}};
 vm.createContext(context);vm.runInContext(html.slice(start,end)+';this.App=AppLifecycle;',context);const App=context.App;App.pulseBackgroundSessions=()=>pulses++;
 function deliver(){const {worker,data}=transport.shift();worker.onmessage?.({data});}
 test('Worker has one pending request during CPU delay; ACK retains cadence and yields without a zero-delay hot loop',()=>{App.ensureBackgroundTicker();const w=workers.at(-1);w.timer.fire();assert.equal(transport.length,1);assert.equal(w.timer.pending.size,0);w.timer.advance(1000);assert.equal(transport.length,1);deliver();assert.equal(pulses,1);assert.equal(w.timer.pending.size,1);const next=[...w.timer.pending.values()][0];assert.equal(next.at,w.timer.now+1);w.timer.fire();deliver();assert.equal(pulses,2);assert.equal([...w.timer.pending.values()][0].at,w.timer.now+25);});
 test('Worker stop/restart rejects old ACKs and never rearms on unknown messages',()=>{const w=workers.at(-1);w.timer.fire();const old=transport.shift().data;w.postMessage('stop');assert.equal(w.timer.pending.size,0);w.postMessage({type:'ack',sequence:old.sequence});assert.equal(w.timer.pending.size,0);w.postMessage('start');w.timer.fire();const current=transport.shift().data;assert(current.sequence>old.sequence);w.postMessage({type:'ack',sequence:old.sequence});assert.equal(w.timer.pending.size,0);w.postMessage({type:'ack',sequence:current.sequence});assert.equal(w.timer.pending.size,1);});
 test('stale Worker callbacks after ownership change cannot pulse or ACK a replacement',()=>{const w=workers.at(-1),oldHandler=w.onmessage;App.stopBackgroundTicker();assert(w.terminated);App.ensureBackgroundTicker();const before=pulses;oldHandler({data:{type:'tick',sequence:123}});assert.equal(pulses,before);assert.equal(workers.at(-1).timer.pending.size,1);});
 test('Worker errors enter one recursive fallback timer; stop clears fallback and restart restores Worker',()=>{const w=workers.at(-1);w.onerror();assert(w.terminated);assert.equal(App.backgroundTickWorker,null);assert.equal(timer.pending.size,1);timer.advance(1000);timer.fire();assert.equal(timer.pending.size,1);App.startBackgroundTickFallback();assert.equal(timer.pending.size,1);App.stopBackgroundTicker();assert.equal(timer.pending.size,0);App.ensureBackgroundTicker();assert(App.backgroundTickWorker);});
 test('Worker construction failure and ACK failure clean up ownership before bounded fallback',()=>{App.stopBackgroundTicker();failConstruction=true;App.ensureBackgroundTicker();assert.equal(timer.pending.size,1);App.stopBackgroundTicker();failConstruction=false;App.ensureBackgroundTicker();const w=workers.at(-1);w.timer.fire();const original=w.postMessage.bind(w);w.postMessage=data=>{if(data?.type==='ack')throw Error('closed worker');original(data);};deliver();assert(w.terminated);assert.equal(timer.pending.size,1);App.stopBackgroundTicker();});
 test('fallback with no sessions does not spin or restart',()=>{sessions.clear();App.ensureBackgroundTicker();assert.equal(timer.pending.size,0);assert.equal(App.backgroundTickWorker,null);});
 for(const [,attrs,script]of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g))if(!attrs.includes('application/json'))new vm.Script(script);
 console.log(JSON.stringify({results,checks:results.length,pinnedSimloopSha256:gamekit.lock.modules.simloop.sha256,pinnedInterpolationSha256:gamekit.lock.modules.interpolation.sha256,note:'Timer wall time and synthetic CPU cost are separate; these are correctness checks, not CPU benchmarks.'},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
