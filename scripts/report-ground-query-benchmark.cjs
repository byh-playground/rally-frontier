const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path'),cp=require('node:child_process');
const [farPath,nearPath,refinePath,out]=process.argv.slice(2);assert(farPath&&nearPath&&refinePath&&out,'Usage: node report-ground-query-benchmark.cjs far.json near.json refine.json output.json');
const inputs=[['far','full',farPath],['near','full',nearPath],['near','refined',refinePath]],modes=['astar','shared-astar','flow-field'];
const stats=xs=>{const a=xs.slice().sort((a,b)=>a-b),quant=p=>{const n=(a.length-1)*p,i=Math.floor(n);return a[i]+(a[Math.ceil(n)]-a[i])*(n-i)};return {n:a.length,median:quant(.5),q1:quant(.25),q3:quant(.75),min:a[0],max:a.at(-1)}};
const counter=xs=>{assert.equal(new Set(xs).size,1,'Deterministic query counters agree across repetitions');return xs[0]};
const range=xs=>({min:Math.min(...xs),max:Math.max(...xs)});
const datasets=[];
for(const [distance,variant,file] of inputs){
 const d=JSON.parse(fs.readFileSync(file,'utf8')),c=d.config;
 const expected=c.complexities.length*c.patterns.length*3*c.counts.reduce((n,count)=>n+(count<=10?c.smallRuns:c.largeRuns),0);
 assert.equal(d.results.length,expected,'Complete query matrix');assert.equal(new Set(d.results.map(r=>[r.complexity,r.pattern,r.n,r.mode,r.rep].join('/'))).size,expected);
 const reference=new Map();
 for(const r of d.results){
  assert.equal(r.cold.waypointHash,r.warm.waypointHash);
  for(const phase of ['cold','warm']){const m=r[phase].metrics;assert(r[phase].ms>=0);assert.equal(m.routeQueries,r.n);assert.equal(m.directQueries,0);assert.equal(m.unreachable,0);assert.equal(m.layersBuilt,0);assert.equal(m.meshBuildMs,0);assert.equal(m.projectionTilesBuilt,0);}
  const key=[r.complexity,r.pattern,r.n,r.mode==='flow-field'?'field':'astar'].join('/');
  if(reference.has(key))assert.equal(reference.get(key),r.cold.waypointHash);else reference.set(key,r.cold.waypointHash);
 }
 const fixtures=Object.fromEntries(Object.entries(d.fixtures).map(([level,f])=>{
  assert(f.isolation.authorityEqual&&f.isolation.graphEqual&&f.isolation.originalDisposed&&!f.isolation.querySimDisposed&&f.isolation.renderCallbacksSuppressed);
  assert.equal(f.freshValidation.length,6);assert(f.freshValidation.every(v=>v.equal));
  const distances=Object.fromEntries(c.patterns.map(p=>[p,range(f.sources.map((s,i)=>Math.hypot(s.x-f.goals[p][i].x,s.y-f.goals[p][i].y)))]));
  return [level,{fixtureHash:f.fixtureHash,graphHash:f.graphHash,sourceHash:f.sourceHash,goalHashes:f.goalHashes,radius:f.radius,caps:f.caps,complexity:f.complexity,
    sameGoal:{x:f.goals.same[0].x,y:f.goals.same[0].y},straightDistance:distances,sampledAstarPath:f.distances?Object.fromEntries(c.patterns.map(p=>[p,f.distances[p].sampledAstarPath])):null,timerResolutionMs:f.timerResolutionMs??null}];
 }));
 const cases=[];
 for(const level of c.complexities)for(const pattern of c.patterns)for(const n of c.counts)for(const mode of modes){
  const rows=d.results.filter(r=>r.complexity===level&&r.pattern===pattern&&r.n===n&&r.mode===mode);assert.equal(rows.length,n<=10?c.smallRuns:c.largeRuns);
  cases.push({complexity:level,pattern,n,algorithm:mode,cold:stats(rows.map(r=>r.cold.ms)),warm:stats(rows.map(r=>r.warm.ms)),
   coldFieldBuilds:counter(rows.map(r=>r.cold.metrics.fieldsBuilt)),warmFieldBuilds:counter(rows.map(r=>r.warm.metrics.fieldsBuilt)),
   coldExpanded:counter(rows.map(r=>r.cold.metrics.astarExpanded)),warmExpanded:counter(rows.map(r=>r.warm.metrics.astarExpanded)),
   warmSharedCandidates:counter(rows.map(r=>r.warm.metrics.sharedAstarHits)),endingWaypointHash:rows[0].cold.waypointHash});
 }
 datasets.push({distance,variant,config:{counts:c.counts,complexities:c.complexities,patterns:c.patterns,smallRuns:c.smallRuns,largeRuns:c.largeRuns},pairCount:expected,
  benchmarkRevision:d.revision,sourceHash:d.sourceHash,browser:d.browser,machine:d.machine,method:d.method,fixtures,cases});
}
for(const level of ['low','medium','high']){for(const d of datasets){assert.equal(d.fixtures[level].fixtureHash,datasets[0].fixtures[level].fixtureHash);assert.equal(d.fixtures[level].graphHash,datasets[0].fixtures[level].graphHash);}assert.equal(datasets[1].fixtures[level].sourceHash,datasets[2].fixtures[level].sourceHash);assert.deepEqual(datasets[1].fixtures[level].goalHashes,datasets[2].fixtures[level].goalHashes);}
const crossovers=[];
for(const distance of ['far','near'])for(const level of ['low','medium','high'])for(const reference of ['astar','shared-astar']){
 const d=datasets.find(d=>d.distance===distance&&d.variant===(distance==='near'?'refined':'full'));
 const ns=d.config.counts.slice().sort((a,b)=>a-b),row=(n,mode)=>d.cases.find(r=>r.complexity===level&&r.pattern==='same'&&r.n===n&&r.algorithm===mode);
 const beats=(n,iqr=false)=>iqr?row(n,'flow-field').cold.q3<row(n,reference).cold.q1:row(n,'flow-field').cold.median<row(n,reference).cold.median;
 const first=ns.findIndex((n,i)=>beats(n)&&ns.slice(i).every(n=>beats(n)));
 assert(first>=0,'Measured upper crossover bound must exist');
 const conservative=ns.find((n,i)=>i>=first&&beats(n,true)&&ns.slice(i).every(n=>beats(n)));
 crossovers.push({distance,complexity:level,reference,lowerMeasuredCount:first?ns[first-1]:null,upperMeasuredCount:ns[first],
   iqrOverlapAtUpper:!beats(ns[first],true),conservativeMeasuredCount:conservative??null,
   interpretation:'Cache-cold same-goal batch medians; not a universal unit count. IQR separation is descriptive, not a significance test.'});
}
const result={recordedAt:new Date().toISOString(),gameSourceCommit:cp.execFileSync('git',['log','-1','--format=%H','--','index.html'],{encoding:'utf8'}).trim(),
 unit:'swordsman',pairedBatches:datasets.reduce((n,d)=>n+d.pairCount,0),timedBatches:datasets.reduce((n,d)=>n+2*d.pairCount,0),
 notes:['Same goal means same point, mover radius and navigation topology. Only blocked routes enter measured planners.',
 'Individual query inputs are not a simultaneous non-overlapping formation. No simulation tick or renderer work runs in query timers.',
 'Mesh construction and cache reset are outside timers; query allocation and search are inside. Warm repeats only the same N batch.',
 'Warm single-query values below approximately 0.1ms must be displayed as <0.1ms. Cold and warm use the same JIT-warmed browser code.',
 'Near and far are different route fixtures. Original far run omitted explicit distance/timer-resolution metadata; query coordinates and hashes are retained.',
 'Counts are queries, not a permanent unit cutoff. Goal lifetime and bounded goal-cache eviction change the tradeoff.'],
 crossovers,datasets};
fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({pairedBatches:result.pairedBatches,timedBatches:result.timedBatches,crossovers},null,2));
