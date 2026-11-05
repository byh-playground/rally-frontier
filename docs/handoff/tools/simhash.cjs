// Deterministic sim hash: isolated StrategySim from the live match draft, 200 grains per side, launches, checksum every 100 ticks.
const path=require('path');const repo=path.resolve(process.argv[2]),ticks=+(process.argv[3]||600);
const { chromium } = require('playwright');
const { serveSource, routePinnedSDK } = require(path.join(repo,'scripts/netcode-qa-module.cjs'));
(async()=>{const server=await serveSource(path.join(repo,'index.html'),{observer:'CONFIG.single.botWorker=false;globalThis.__p={MatchLifecycle,UiRuntimeState};'});
const b=await chromium.launch({channel:'msedge'});const p=await b.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));await routePinnedSDK(p);
await p.goto(server.url+'#/');await p.waitForFunction(()=>globalThis.__p,null,{timeout:60000});await p.waitForTimeout(500);await p.click('#gameStartBtn');
await p.waitForFunction(()=>globalThis.__p.MatchLifecycle.singleMatch?.sessions?.host?.replayRecorder,null,{timeout:60000});
const r=await p.evaluate(async(ticks)=>{const base=new URL('./src/',location.href).href;const {StrategySim}=await import(base+'sim/strategy-sim.js');
const rec=globalThis.__p.MatchLifecycle.singleMatch.sessions.host.replayRecorder;const sim=new StrategySim(12345,rec.rules);
const types=['rice','soybean','redbean'];for(const side of [0,1]){const base=sim.buildings.find(x=>x.id==='base'+side),en=sim.buildings.find(x=>x.id==='base'+(1-side));const dx=en.x-base.x,dy=en.y-base.y,L=Math.hypot(dx,dy),ux=dx/L,uy=dy/L;
const mx=(base.x+en.x)/2,my=(base.y+en.y)/2;for(let i=0;i<200;i++){const along=200+(i%20)*28,across=(Math.floor(i/20)-5)*28;sim.spawnUnit(side,types[i%3],Math.round(mx-ux*along-uy*across),Math.round(my-uy*along+ux*across))}}
const hashes=[];const t=performance.now();
for(let k=1;k<=ticks;k++){if(k%25===0)for(const side of [0,1]){const c=sim.buildings.find(x=>x.id==='base'+side),en=sim.buildings.find(x=>x.id==='base'+(1-side));if(sim.applyCommand(side?'guest':'host',{type:'LAUNCH',cannonId:c.id,x:Math.round((c.x+en.x)/2),y:Math.round((c.y+en.y)/2),unitType:types[k%3],holdMs:600})===true)globalThis.__launches=(globalThis.__launches||0)+1;}
sim.stepSimulation();if(k%100===0)hashes.push(sim.tick+':'+sim.checksum()+':'+sim.units.filter(u=>u.alive).length)}
return {launches:globalThis.__launches||0,hashes,ms:Math.round(performance.now()-t)}},ticks);
console.log(JSON.stringify(r),JSON.stringify(errs.slice(0,2)));await b.close();await server.close()})();
