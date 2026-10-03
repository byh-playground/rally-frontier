const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process');
const folder=path.resolve(process.argv[2]||'.qa/ground-planners'),output=process.argv[3];
const dataset=JSON.parse(fs.readFileSync(path.join(folder,'summary.json'),'utf8'));assert.equal(dataset.config.timingVersion,2,'Publish only callback-clock frame measurements');
const expected=dataset.config.modes.length*dataset.config.counts.length*dataset.config.complexities.length*dataset.config.runs;assert.equal(dataset.results.length,expected,'Full matrix must finish before publication');assert.equal(new Set(dataset.results.map(r=>r.id)).size,expected,'No duplicate runs');
const mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
const rows=dataset.results.map(r=>{
  const raw=JSON.parse(fs.readFileSync(path.join(folder,r.id,'result.json'),'utf8'));
  assert.equal(raw.config.timingVersion,2);assert(raw.frames.every(f=>f.interval>=0));assert(Math.abs(raw.durationMs-raw.frames.reduce((sum,f)=>sum+f.interval,0))<5);assert.equal(raw.end.host.checksum,raw.end.guest.checksum);
  let minimumSeparation=raw.initial.host.minimumSeparation;const roster=raw.initial.host.roster;if(minimumSeparation==null){minimumSeparation=Infinity;for(let i=0;i<roster.length;i++)for(let j=0;j<i;j++)minimumSeparation=Math.min(minimumSeparation,Math.hypot(roster[i].x-roster[j].x,roster[i].y-roster[j].y));}
  const completionSpans=['host','guest'].map(role=>{const s=raw.steps.filter(s=>s.role===role).sort((a,b)=>a.tick-b.tick),a=s[0],b=s.at(-1);assert.equal(s.length,dataset.config.ticks);return {ticks:b.tick-a.tick,ms:b.at+b.ms-a.at-a.ms};});
  const tps=1000*completionSpans.reduce((n,s)=>n+s.ticks,0)/completionSpans.reduce((n,s)=>n+s.ms,0);
  const unreachable=raw.end.host.nav.unreachable-raw.initial.host.nav.unreachable;assert.equal(unreachable,0,'No route search failure');
  return {...r,minimumSeparation,unreachable,observedTps:tps,peerChecksums:[raw.end.host.checksum,raw.end.guest.checksum],networkEvents:raw.networkEvents,initializationIncludesFixtureValidation:true};
});
const groups=new Map();
for(const r of rows){const k=[r.config.scenario,r.config.complexity,r.config.count,r.config.mode].join('/');if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
const cases=[...groups.values()].map(rs=>{
  assert.equal(rs.length,dataset.config.runs,'Each case has all repeats');const r=rs[0],read=f=>rs.map(f),q=read(r=>r.summary.nav.routeQueries);
  return {scenario:r.config.scenario,formation:dataset.config.formation||'dense',initialMinimumSeparation:r.minimumSeparation,unitRadius:r.initial.unitRadius??null,complexity:r.config.complexity,count:r.config.count,algorithm:r.config.mode,runs:rs.length,
    meanTickMs:mean(read(r=>r.summary.step.mean)),runMeanTickMs:read(r=>r.summary.step.mean),firstTickMs:mean(read(r=>r.summary.firstTick.mean)),
    laterTickMs:mean(read(r=>r.summary.laterTicks.mean)),maxTickMs:Math.max(...read(r=>r.summary.step.max)),frameP95Ms:mean(read(r=>r.summary.frame.p95)),frameMaxMs:Math.max(...read(r=>r.summary.frame.max)),
    observedTps:mean(read(r=>r.observedTps)),renderCpuMs:mean(read(r=>r.summary.render.mean)),meshPreparationMs:mean(read(r=>r.initial.preparationMs)),
    routeQueries:mean(q),directQueries:mean(read(r=>r.summary.nav.directQueries)),fieldsBuilt:mean(read(r=>r.summary.nav.fieldsBuilt)),
    astarQueries:mean(read(r=>r.summary.nav.astarQueries)),expandedNodes:mean(read(r=>r.summary.nav.astarExpanded)),sharedSuffixCandidates:mean(read(r=>r.summary.nav.sharedAstarHits)),
    alive:r.summary.alive,hp:r.summary.hp,heightChanged:r.summary.heightChanged,netDisplacement:r.summary.movedDistance,endingHash:r.summary.checksum,
    combatHits:mean(read(r=>r.summary.combatHits||0)),fixtureHash:r.fixtureHash,graph:r.summary.complexity,peerInterruptions:mean(read(r=>(r.networkEvents||[]).filter(e=>e.type==='peer-interrupted').length)),
    unreachable:mean(read(r=>r.unreachable)),exactRepeat:read(r=>r.summary.checksum).every(h=>h===r.summary.checksum)};
});
for(const c of cases){assert(c.exactRepeat);const comparisons=cases.filter(x=>x.scenario===c.scenario&&x.count===c.count&&x.complexity===c.complexity);assert(comparisons.every(x=>x.fixtureHash===c.fixtureHash));if(c.algorithm==='shared-astar'){const plain=comparisons.find(x=>x.algorithm==='astar');if(plain)assert.equal(c.endingHash,plain.endingHash);}}
const result={recordedAt:new Date().toISOString(),sourceRevision:dataset.revision,gameSourceCommit:cp.execFileSync('git',['log','-1','--format=%H',dataset.revision,'--','index.html'],{encoding:'utf8'}).trim(),gameGitBlob:cp.execFileSync('git',['rev-parse',dataset.revision+':index.html'],{encoding:'utf8'}).trim(),scenario:dataset.config.scenario,unit:dataset.config.unit,targetTicks:dataset.config.ticks,nominalTps:[...new Set(rows.map(r=>r.initial.tps))],runs:dataset.config.runs,
  timingVersion:dataset.config.timingVersion,frameClock:'performance.now at rAF callback; full window coverage asserted',browser:dataset.browser,cpu:[...new Set(dataset.machine.cpus)],gpu:rows[0].gpu,peerCount:2,scope:'Each peer simulates N ordinary ground units. Same fixed start state, warmed mesh, cold search cache. First '+dataset.config.ticks+' ticks, not destination completion. Frame interval includes closing rAF; checksum collected after timing.',
  tpsDefinition:'Sum of tick1-completion to tickN-completion tick deltas divided by sum of peer elapsed times.',
  formation:dataset.config.formation||'dense',formationNote:'Dense starts at 30-unit separation; clear mode asserts body separation. Tick timings include movement/contact resolution.',fixtureBuildings:'Same debug starting buildings included in authoritative initial state hash; production paused.',
  cases};
if(output){fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');}
for(const complexity of ['low','medium','high'])for(const count of dataset.config.counts){const items=cases.filter(c=>c.complexity===complexity&&c.count===count);if(items.length)console.log(complexity+' '+count+' '+items.map(c=>c.algorithm+': '+c.meanTickMs.toFixed(1)+'ms / '+c.observedTps.toFixed(2)+'TPS / frame-max '+c.frameMaxMs.toFixed(0)+'ms').join(' | '));}
