const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{inject,VERSIONS}=require('./inject.cjs');
const root=path.resolve(__dirname,'../..'),out=path.join(root,'.qa/physics-controller-20261011');
const smoke=process.argv.includes('--smoke');
const only=process.argv.includes('--only')?process.argv[process.argv.indexOf('--only')+1]:null;
const skipFixed=process.argv.includes('--skip-fixed');
const fixedOnly=process.argv.includes('--fixed-only');
const canonicalPath=path.join(root,'.qa/bottleneck-reproduction/canonical-map.json');
const canonical=fs.existsSync(canonicalPath)?JSON.parse(fs.readFileSync(canonicalPath,'utf8')):null;
(async()=>{
  fs.mkdirSync(out,{recursive:true});const html=inject(root,{allLibraries:true});
  const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true});
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.text().startsWith('__physics__'))console.log(m.text())});
    await page.route('https://physics-probe.local/**',r=>r.fulfill({contentType:'text/html',body:html}));
    await page.goto('https://physics-probe.local/');await page.waitForFunction(()=>globalThis.PhysicsControllerProbe?.exposed,null,{timeout:60000});
    const result=await page.evaluate(async({canonical,smoke,only,skipFixed,fixedOnly})=>{
      const q=PhysicsControllerProbe,{StrategySim,GameRuleDefinition,DebugScenarioHarness,Unit,MapGeneration,BuildingDefinition,ECONOMY_WORKER_TYPE,NEUTRAL_SIDE,RallyStateCodec}=q.exposed;
      const check=(v,m)=>{if(!v)throw Error(m)},same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
      if(canonical)MapGeneration.generateMapDescriptor=()=>JSON.parse(JSON.stringify(canonical));
      const draft={decks:{host:['swordsman'],guest:['swordsman']},defenseCards:{host:[],guest:[]}},rules=GameRuleDefinition.resolve({overrides:{simulation:{tps:10}}});
      const scenario=DebugScenarioHarness.normalize({kind:'unit-combat',allyType:'swordsman',enemyType:'swordsman',allyCount:1,enemyCount:1,research:false,humanRole:'host'});
      const create=variant=>{q.defaultVariant=variant;return StrategySim.createForMatch({draft,seed:3231409986,rules,debugScenario:scenario})};
      const measure=values=>{const a=values.slice().sort((a,b)=>a-b);return {n:a.length,mean:a.reduce((s,x)=>s+x,0)/a.length,p95:a[Math.ceil(a.length*.95)-1],max:a.at(-1)}};
      const tickYield=()=>new Promise(r=>setTimeout(r,0));
      const variants=only?only.split(','):q.variants;
      const build400=(sim,mixed=false)=>{
        sim.units=sim.units.filter(u=>u.side===NEUTRAL_SIDE);sim.rebuildRuntimeIndexes();
        const roster=mixed?[['worker',40],['tank',12],['swordsman',60],['archer',60],['medic',10],['mage',10]]:[['worker',40],['swordsman',180]];
        const cx=sim.world.width*.5,cy=sim.world.height*.5;
        for(const side of [0,1]){const dir=side===0?1:-1,base=sim.buildings.find(b=>b.side===side&&BuildingDefinition.get(b.type)?.isMainBase);let depth=0;
          for(const [name,count]of roster){const type=name==='worker'?ECONOMY_WORKER_TYPE:name;
            if(mixed&&name!=='worker')sim.abilities[side][type]=true;
            if(name==='worker'){for(let i=0;i<count;i++){if(sim.spawnFromBuilding(base,type))continue;const angle=i*Math.PI*2/count;sim.spawnUnit(side,type,base.x+Math.cos(angle)*(140+i%3*28),base.y+Math.sin(angle)*(140+i%3*28))}}
            else{const cols=Math.min(12,count),spacing=Math.max(24,sim.unitRadius(type)*2+8);for(let i=0;i<count;i++)sim.spawnUnit(side,type,cx+(i%cols-(cols-1)/2)*spacing,cy+dir*(110+depth+Math.floor(i/cols)*spacing));depth+=Math.ceil(count/cols)*spacing+16}
          }
        }
        sim.rebuildRuntimeIndexes();check(sim.supplyUsed(0)===400&&sim.supplyUsed(1)===400,'400 supply fixture');
      };
      // A circle-only lab runs the production solver against identical inputs.
      // Static terrain is deliberately disabled ONLY in this isolated lab; real
      // game-loop measurements below retain actual terrain and game behaviors.
      const lab=create('original');lab.constrainSurfaceContacts=()=>0;lab.navigation.motion.constrain=()=>false;
      function setLab(frame,variant){
        const rows=frame.units.map((f,index)=>({...f,index})),byId=new Map(rows.map(f=>[f.id,f]));
        lab.units=rows.map(f=>{const u=new Unit({id:f.id,type:f.id,side:f.side,alive:true,fx:Math.round(f.x1*100),fy:Math.round(f.y1*100),x:f.x1,y:f.y1,hp:100,maxHp:100});
          u.capability=key=>key==='burrowable'?{isActive:()=>f.burrow}:null;return u});
        lab.radiusFP=u=>Math.round(byId.get(u.id).radius*100);lab.mass=u=>byId.get(u.id).mass;lab.unitLayer=type=>byId.get(type)?.layer||'GROUND';
        lab.tick=frame.tick;lab.rebuildRuntimeIndexes();lab.captureCollisionStepStarts();
        rows.forEach((f,i)=>{lab.collisionStartFx[i]=Math.round(f.x0*100);lab.collisionStartFy[i]=Math.round(f.y0*100);lab.units[i].collisionIntentTick=f.hasIntent===false?-1:lab.tick;lab.units[i].collisionIntentTx=f.intentX??f.x1;lab.units[i].collisionIntentTy=f.intentY??f.y1});
        if(q.records.get(lab).variant!==variant)q.attach(lab,variant);return rows;
      }
      function quality(rows,positions){
        const p=new Map(positions.map(x=>[x.index,x])),ally=[],enemy=[];
        for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
          const a=rows[i],b=rows[j];if(a.layer!==b.layer||a.burrow!==b.burrow)continue;
          const allied=(a.side===0||a.side===1)&&a.side===b.side;if(a.burrow&&!allied)continue;
          const x=p.get(i),y=p.get(j),pen=Math.max(0,a.radius+b.radius-Math.hypot(x.x-y.x,x.y-y.y));
          if(pen>0.010001)(allied?ally:enemy).push(pen);
        }
        return {allyOverlaps:ally.length,allyMax:Math.max(0,...ally),enemyOverlaps:enemy.length,enemyMax:Math.max(0,...enemy)};
      }
      const unit=(id,side,x0,y0,x1=x0,y1=y0,extra={})=>({id,index:0,side,layer:'GROUND',burrow:false,radius:10,mass:100,x0,y0,x1,y1,...extra});
      const fixtures=[
        {name:'allied-pack',units:[unit('a',0,1000,1000),unit('b',0,1010,1000),unit('c',0,1020,1000),unit('d',0,1000,1010),unit('e',0,1010,1010)]},
        {name:'unequal-mass',units:[unit('light',0,1000,1000),unit('heavy',0,1010,1000,1010,1000,{mass:1000})]},
        {name:'warm-external-reposition',units:[unit('a',0,1000,1000),unit('b',0,1010,1000)]},
        {name:'enemy-relative-crossing',units:[unit('a',0,960,1000,1040,1000),unit('b',1,1040,1000,960,1000)]},
        {name:'enemy-relative-crossing-warm',units:[unit('a',0,960,1000,1040,1000),unit('b',1,1040,1000,960,1000)]},
        {name:'enemy-pressure',units:[unit('a',0,1000,1000),unit('b',0,1008,1000),unit('c',0,1016,1000),unit('enemy',1,1036,1000)]},
        {name:'neutral-pressure',units:[unit('a',0,1000,1000),unit('b',0,1008,1000),unit('c',0,1016,1000),unit('enemy',NEUTRAL_SIDE,1036,1000)]},
        {name:'separate-layers',units:[unit('a',0,1000,1000),unit('b',1,1000,1000,1000,1000,{layer:'AIR'})]},
        {name:'burrow-enemy-excluded',units:[unit('a',0,1000,1000,1000,1000,{burrow:true}),unit('b',1,1000,1000,1000,1000,{burrow:true})]},
        {name:'fast-moving-vs-stationary',units:[unit('a',0,900,1000,1200,1000),unit('enemy',1,1000,1000)]},
        {name:'fast-moving-vs-stationary-warm',units:[unit('a',0,900,1000,1200,1000),unit('enemy',1,1000,1000)]}
      ];
      const gates=[];
      for(const variant of variants){
        for(const fixture of fixtures){
          const frame={tick:1,dt:.1,bounds:{width:lab.world.width,height:lab.world.height},units:fixture.units};
          q.attach(lab,variant);
          if(fixture.name.endsWith('-warm')){const warm={...frame,tick:0,units:frame.units.map(u=>({...u,x1:u.x0,y1:u.y0}))};setLab(warm,variant);lab.solveContacts()}
          const rows=setLab(frame,variant),started=performance.now();lab.solveContacts();const ms=performance.now()-started;
          if(fixture.name==='warm-external-reposition'){
            const second={...frame,tick:2,units:[unit('a',0,1000,1000),unit('b',0,1100,1000)]};setLab(second,variant);lab.solveContacts();
          }
          const positions=lab.units.map((u,index)=>({index,x:u.x,y:u.y})),metrics=quality(rows,positions),enemy=rows.findIndex(u=>u.id==='enemy');
          const pressure=enemy>=0?Math.hypot(positions[enemy].x-rows[enemy].x0,positions[enemy].y-rows[enemy].y0):0;
          const crossed=fixture.name.startsWith('enemy-relative-crossing')?positions[0].x>positions[1].x:fixture.name.startsWith('fast-moving-vs-stationary')?positions[0].x>rows[1].x0: false;
          const lightMove=Math.hypot(positions[0].x-rows[0].x0,positions[0].y-rows[0].y0),heavyMove=Math.hypot(positions[1].x-rows[1].x0,positions[1].y-rows[1].y0);
          const massRatio=fixture.name==='unequal-mass'?lightMove/Math.max(.00001,heavyMove):null;
          const drift=fixture.name==='warm-external-reposition'?Math.max(Math.hypot(positions[0].x-1000,positions[0].y-1000),Math.hypot(positions[1].x-1100,positions[1].y-1000)):null;
          const invalid=Number(q.records.get(lab).diagnostics?.invalidPositions)||0;
          const failures=[];if(invalid)failures.push('nonfinite output');if(crossed)failures.push('tunneling');if(pressure>.010001)failures.push('enemy pressure');if(metrics.enemyMax>.010001)failures.push('enemy overlap');
          if(massRatio!==null&&(massRatio<8||massRatio>12))failures.push('mass response');if(drift!==null&&drift>.010001)failures.push('warm displacement');
          if(['separate-layers','burrow-enemy-excluded'].includes(fixture.name)&&positions.some((p,i)=>Math.hypot(p.x-rows[i].x1,p.y-rows[i].y1)>.010001))failures.push('collision filter');
          gates.push({variant,fixture:fixture.name,ms,positions,...metrics,stationaryEnemyDisplacement:pressure,crossed,massRatio,drift,accepted:failures.length===0,failures,diagnostics:q.records.get(lab).diagnostics});
        }
        console.info('__physics__'+JSON.stringify({phase:'gates',variant}));await tickYield();
      }
      lab.dispose('lab-complete');
      if(smoke)return {gates};
      const closedLoop=[],recorded=[];
      for(const mixed of [false,true]){
        const reference=create('original');build400(reference,mixed);
        const savedSolve=reference.solveContacts;
        reference.solveContacts=function(){if(this.tick>=21&&this.tick<=50)recorded.push({roster:mixed?'mixed400':'basic400',frame:q.frame(this)});return savedSolve.call(this)};
        for(let t=1;t<=50;t++){reference.step();if(t%5===0)await tickYield()}delete reference.solveContacts;reference.dispose('record-complete');
        if(!fixedOnly)for(const variant of variants){
          const sim=create(variant);build400(sim,mixed);const steps=[],physics=[],engines=[];let snapshot=null,checkpointMs=0,checkpointBytes=0,restoreMs=0,restorePassed=true,restoreDifference=null;
          try{
            for(let tick=1;tick<=60;tick++){
              sim.step();const r=q.records.get(sim);steps.push(sim.perfStats.lastStepMs);physics.push(r.lastMs);engines.push(r.lastEngineMs);
              if(tick===30){const start=performance.now();snapshot=RallyStateCodec.encode(sim.exportState());checkpointMs=performance.now()-start;checkpointBytes=snapshot.length}
              if(tick%5===0)await tickYield();
            }
            const expectedState=sim.exportState(),expected=RallyStateCodec.encode(expectedState),cold=create(variant);const start=performance.now();cold.importState(RallyStateCodec.decode(snapshot));restoreMs=performance.now()-start;
            try{
              for(let tick=31;tick<=60;tick++){cold.step();if(tick%5===0)await tickYield()}
              const actualState=cold.exportState();restorePassed=same(expected,RallyStateCodec.encode(actualState));
              if(!restorePassed){
                const firstDiff=(a,b,p='root')=>{if(Object.is(a,b))return null;if(!a||!b||typeof a!=='object'||typeof b!=='object')return {path:p,a:String(a).slice(0,120),b:String(b).slice(0,120)};for(const k of new Set([...Object.keys(a),...Object.keys(b)])){const d=firstDiff(a[k],b[k],p+'.'+k);if(d)return d}return null};
                const a={...expectedState},b={...actualState};delete a.physicsControllerState;delete b.physicsControllerState;
                restoreDifference={game:firstDiff(a,b),engine:firstDiff(q.unpackState(expectedState.physicsControllerState.chunks),q.unpackState(actualState.physicsControllerState.chunks))};
              }
            }finally{cold.dispose('cold-restore-complete')}
            const finalRows=q.frame(sim).units.map((f,index)=>({...f,index}));
            const finalQuality=quality(finalRows,finalRows.map(f=>({index:f.index,x:f.x1,y:f.y1})));
            closedLoop.push({roster:mixed?'mixed400':'basic400',variant,step:measure(steps),physics:measure(physics),engine:measure(engines),checkpointMs,checkpointBytes,restoreMs,restorePassed,restoreDifference,finalQuality,units:sim.units.filter(u=>u.alive).length,diagnostics:q.records.get(sim).diagnostics});
          }finally{sim.dispose('closed-loop-complete')}
          console.info('__physics__'+JSON.stringify({phase:'closed-loop',roster:mixed?'mixed400':'basic400',variant,result:closedLoop.at(-1)}));await tickYield();
        }
      }
      // Same 30 consecutive pre-controller frames, repeated in opposite variant order.
      const fixedFrames=[];
      for(let repeat=1;!skipFixed&&repeat<=2;repeat++)for(const mixed of [false,true])for(const variant of repeat===1?variants:[...variants].reverse()){
        // Reuse the lab setup closures against this one solver instance by a local
        // frame replay that does not serialize or recreate engine bodies each tick.
        const times=[],qualitySamples=[],rowsForCase=recorded.filter(r=>r.roster===(mixed?'mixed400':'basic400'));
        const bare=create(variant);bare.constrainSurfaceContacts=()=>0;bare.navigation.motion.constrain=()=>false;
        try{
          for(const {frame}of rowsForCase){
            const rows=frame.units.map((f,index)=>({...f,index})),byId=new Map(rows.map(f=>[f.id,f]));
            bare.units=rows.map(f=>{const u=new Unit({id:f.id,type:f.id,side:f.side,alive:true,fx:Math.round(f.x1*100),fy:Math.round(f.y1*100),x:f.x1,y:f.y1,hp:100,maxHp:100});u.capability=key=>key==='burrowable'?{isActive:()=>f.burrow}:null;return u});
            bare.radiusFP=u=>Math.round(byId.get(u.id).radius*100);bare.mass=u=>byId.get(u.id).mass;bare.unitLayer=type=>byId.get(type)?.layer||'GROUND';bare.tick=frame.tick;bare.rebuildRuntimeIndexes();bare.captureCollisionStepStarts();
            rows.forEach((f,i)=>{bare.collisionStartFx[i]=Math.round(f.x0*100);bare.collisionStartFy[i]=Math.round(f.y0*100);bare.units[i].collisionIntentTick=f.hasIntent===false?-1:bare.tick;bare.units[i].collisionIntentTx=f.intentX??f.x1;bare.units[i].collisionIntentTy=f.intentY??f.y1});
            const start=performance.now();bare.solveContacts();times.push(performance.now()-start);
            if(times.length%10===0)qualitySamples.push({tick:frame.tick,...quality(rows,bare.units.map((u,index)=>({index,x:u.x,y:u.y})))});
            if(times.length%5===0)await tickYield();
          }
          fixedFrames.push({repeat,roster:mixed?'mixed400':'basic400',variant,controller:measure(times),qualitySamples,diagnostics:q.records.get(bare).diagnostics});
        }finally{bare.dispose('fixed-frame-complete')}
        console.info('__physics__'+JSON.stringify({phase:'fixed-frames',result:fixedFrames.at(-1)}));
      }
      return {gates,closedLoop,fixedFrames};
    },{canonical,smoke,only,skipFixed,fixedOnly});
    assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,smoke?'smoke.json':fixedOnly?'fixed-only.json':only?'offline-'+only.replaceAll(',','-')+'.json':'offline.json'),JSON.stringify({versions:VERSIONS,errors,...result},null,2)+'\n');
    console.log(JSON.stringify({gates:result.gates.length,accepted:result.gates.filter(r=>r.accepted).length,rejected:result.gates.filter(r=>!r.accepted).length,closedLoop:result.closedLoop?.length,fixedFrames:result.fixedFrames?.length}));
  }finally{await browser.close()}
})().catch(e=>{console.error(String(e.stack).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,'[bundled module]'));process.exitCode=1});
