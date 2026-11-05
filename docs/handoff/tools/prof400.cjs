// Spawns ~N grains per side in an in-page AI match, then records sim step time, frame time and a CPU profile.
// Usage: node prof400.cjs <repo> <perSide> <seconds> [out.json]
const path=require('path'),fs=require('fs');
const repo=path.resolve(process.argv[2]),per=Number(process.argv[3]||200),secs=Number(process.argv[4]||8),out=process.argv[5];
const { chromium } = require('playwright');
const { serveSource, routePinnedSDK } = require(path.join(repo,'scripts/netcode-qa-module.cjs'));
(async()=>{
  const worker=process.env.WORKER==='1';
  const observer=`CONFIG.single.botWorker=${worker};globalThis.__p={MatchLifecycle,ActiveViewState,UiRuntimeState};`;
  const server=await serveSource(path.join(repo,'index.html'),{observer});
  const browser=await chromium.launch({channel:'msedge',args:['--disable-renderer-backgrounding','--disable-background-timer-throttling']});
  const page=await browser.newPage({viewport:{width:412,height:915}});
  const errs=[];page.on('pageerror',e=>errs.push(e.message));page.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,300))});
  await routePinnedSDK(page);
  await page.goto(server.url+'#/');await page.waitForFunction(()=>globalThis.__p,null,{timeout:60000});await page.waitForTimeout(800);
  await page.click('#gameStartBtn');
  await page.waitForFunction(()=>globalThis.__p.UiRuntimeState.value.screen==='game'&&globalThis.__p.ActiveViewState.snap?.tick>20,null,{timeout:60000});
  const spawned=await page.evaluate(per=>{
    const m=globalThis.__p.MatchLifecycle.singleMatch,types=['rice','soybean','redbean'];let n=0;
    for(const s of Object.values(m.sessions)){
      const sim=s.sim;if(!sim?.buildings)continue;
      for(const side of [0,1]){
        const base=sim.buildings.find(b=>b.id==='base'+side),enemy=sim.buildings.find(b=>b.id==='base'+(1-side));
        const dx=enemy.x-base.x,dy=enemy.y-base.y,L=Math.hypot(dx,dy),ux=dx/L,uy=dy/L;
        for(let i=0;i<per;i++){
          const along=250+(i%20)*28,across=(Math.floor(i/20)-per/40)*28;
          sim.spawnUnit(side,types[i%3],Math.round(base.x+ux*along-uy*across),Math.round(base.y+uy*along+ux*across));n++;
        }
      }
      // Time every step of this sim.
      const orig=sim.stepSimulation.bind(sim);sim.__stepMs=[];
      sim.stepSimulation=function(){const t=performance.now();const r=orig();sim.__stepMs.push(performance.now()-t);return r};
    }
    // Frame intervals of the page.
    globalThis.__frames=[];let last=performance.now();
    const loop=t=>{globalThis.__frames.push(t-last);last=t;if(globalThis.__frames.length<100000)requestAnimationFrame(loop)};requestAnimationFrame(loop);
    return n;
  },per);
  await page.waitForTimeout(1500);
  const draws=await page.evaluate(async()=>{
    const P=WebGL2RenderingContext.prototype,names=['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced','bufferSubData','bufferData'];const c={};const orig={};
    for(const n of names){orig[n]=P[n];c[n]=0;P[n]=function(...a){c[n]++;if(n==='drawArraysInstanced'||n==='drawElementsInstanced')c.instances=(c.instances||0)+(a[n==='drawArraysInstanced'?3:4]||0);return orig[n].apply(this,a)}}
    const r=globalThis.__p.ActiveViewState.renderer;const before=r.vectorAssetDrawnInstances||0;
    let f=0;await new Promise(res=>{const t=()=>{if(++f>=60)res();else requestAnimationFrame(t)};requestAnimationFrame(t)});
    for(const n of names)P[n]=orig[n];
    const per={};for(const k in c)per[k]=+(c[k]/60).toFixed(1);per.grainsDrawn=+(((r.vectorAssetDrawnInstances||0)-before)/60).toFixed(1);return per;
  });
  console.log('DRAWS/frame',JSON.stringify(draws));
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:200});await cdp.send('Profiler.start');
  await page.evaluate(()=>{globalThis.__frames.length=0;for(const s of Object.values(globalThis.__p.MatchLifecycle.singleMatch.sessions))if(s.sim?.__stepMs)s.sim.__stepMs.length=0});
  await page.waitForTimeout(secs*1000);
  const {profile}=await cdp.send('Profiler.stop');
  const stats=await page.evaluate(()=>{
    const q=(a,p)=>{const b=[...a].sort((x,y)=>x-y);return b.length?+b[Math.min(b.length-1,Math.floor(b.length*p))].toFixed(2):null};
    const m=globalThis.__p.MatchLifecycle.singleMatch,r=globalThis.__p.ActiveViewState.renderer;
    const sims=Object.entries(m.sessions).map(([role,s])=>({role,alive:s.sim?.units?.filter(u=>u.alive).length,steps:s.sim?.__stepMs?.length,stepAvg:s.sim?.__stepMs?+(s.sim.__stepMs.reduce((a,b)=>a+b,0)/Math.max(1,s.sim.__stepMs.length)).toFixed(2):null,stepP95:s.sim?.__stepMs?q(s.sim.__stepMs,.95):null,perf:s.sim&&Object.fromEntries(Object.entries(s.sim.perfStats||{}).filter(([k,v])=>/Ms$/.test(k)).map(([k,v])=>[k,+(+v).toFixed(2)]))}));
    const f=globalThis.__frames;
    return {sims,frames:f.length,frameAvg:+(f.reduce((a,b)=>a+b,0)/Math.max(1,f.length)).toFixed(2),frameP95:q(f,.95),frameWork:r?.perfStats?.ewmaFrameWorkMs};
  });
  // Self time by function.
  const nodes=new Map(profile.nodes.map(n=>[n.id,n]));const self=new Map();
  const dt=profile.timeDeltas;let total=0;
  profile.samples.forEach((id,i)=>{const n=nodes.get(id);const cf=n.callFrame;const key=`${cf.functionName||'(anon)'} ${cf.url.replace(/^.*\/src\//,'src/').replace(/^.*\//,'')}:${cf.lineNumber+1}`;const d=(dt[i]||0)/1000;self.set(key,(self.get(key)||0)+d);total+=d});
  const top=[...self].sort((a,b)=>b[1]-a[1]).slice(0,30).map(([k,v])=>`${(v/secs).toFixed(2).padStart(7)} ms/s ${(100*v/total).toFixed(1).padStart(5)}%  ${k}`);
  const parent=new Map();for(const n of profile.nodes)for(const c of n.children||[])parent.set(c,n.id);
  const incl=new Map();const keyOf=n=>{const cf=n.callFrame;return `${cf.functionName||'(anon)'} ${cf.url.replace(/^.*\/src\//,'src/').replace(/^.*\//,'')}:${cf.lineNumber+1}`};
  profile.samples.forEach((id,i)=>{const seen=new Set();let x=id;while(x!=null){const k=keyOf(nodes.get(x));if(!seen.has(k)){seen.add(k);incl.set(k,(incl.get(k)||0)+(dt[i]||0)/1000)}x=parent.get(x)}});
  const inclTop=[...incl].filter(([k])=>/[a-z-]+[.]js:/.test(k)).sort((a,b)=>b[1]-a[1]).slice(0,45).map(([k,v])=>`${(v/secs).toFixed(1).padStart(7)} ms/s  ${k}`);
  const res={worker,per,spawned,draws,stats,top,inclTop,errs:errs.slice(0,5)};
  if(out)fs.writeFileSync(out,JSON.stringify(res,null,2));
  console.log(JSON.stringify({worker,spawned,stats,errs:errs.slice(0,5)},null,1));console.log(top.join('\n'));
  await browser.close();await server.close();
})();
