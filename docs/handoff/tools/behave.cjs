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
const base0=sim.buildings.find(x=>x.id==='base0'),base1=sim.buildings.find(x=>x.id==='base1');
const last=new Map();const rows=[];
for(let k=1;k<=ticks;k++){
 if(k===1)for(const side of [0,1]){const own=side?base1:base0,en=side?base0:base1;for(let i=0;i<150;i++){const along=250+(i%15)*30,across=(Math.floor(i/15)-5)*30;const dx=en.x-own.x,dy=en.y-own.y,L=Math.hypot(dx,dy),ux=dx/L,uy=dy/L;try{sim.spawnUnit(side,types[i%3],Math.round(own.x+ux*along-uy*across),Math.round(own.y+uy*along+ux*across))}catch(e){}}}
 sim.stepSimulation();
 if(k%100===0){let n=0,stuck=0,dsum=0;for(const u of sim.units){if(!u.alive)continue;n++;const en=u.side?base0:base1;dsum+=Math.hypot(u.x-en.x,u.y-en.y);const p=last.get(u.id);if(p&&Math.hypot(p.x-u.x,p.y-u.y)<1&&!u.target)stuck++;last.set(u.id,{x:u.x,y:u.y})}
  rows.push({k,alive:n,avgDistToEnemyBase:Math.round(dsum/Math.max(1,n)),idleNoTarget:stuck,b0:Math.round(base0.hp),b1:Math.round(base1.hp)})}}
const nav=sim.navigation.metrics;
return {rows,nav,ms:Math.round(performance.now()-t)};},ticks);
console.log(JSON.stringify(r.rows),JSON.stringify(r.nav),r.ms,JSON.stringify(errs.slice(0,2)));await b.close();await server.close()})();
