const fs=require('node:fs'),path=require('node:path'),{spawnSync,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.qa/sweep-side-index-20261012');fs.mkdirSync(out,{recursive:true});
const base='ffbc47e7091f48f27e1a0f429f721c5371193e02';
const baselinePath=path.join(out,'baseline.html'),candidatePath=path.join(out,'candidate.html');
fs.writeFileSync(baselinePath,execFileSync('git',['show',base+':index.html'],{cwd:root,maxBuffer:16*1024*1024}));
fs.writeFileSync(candidatePath,fs.readFileSync(path.join(root,'index.html')));
const cases=[
 {name:'basic400',type:'swordsman',count:1,rate:1,center:true,research:false,roster:[{type:'worker',count:40},{type:'swordsman',count:180}]},
 {name:'mixed400',type:'swordsman',count:1,rate:1,center:true,research:true,roster:[{type:'worker',count:40},{type:'tank',count:12},{type:'swordsman',count:60},{type:'archer',count:60},{type:'medic',count:10},{type:'mage',count:10}]}
];
const jobs=[];
for(let repeat=1;repeat<=2;repeat++)for(const c of repeat===1?cases:[...cases].reverse())for(const variant of repeat===1?['baseline','candidate']:['candidate','baseline'])jobs.push({repeat,c,variant});
const results=[];
for(const {repeat,c,variant}of jobs){
 const run=`side-index-${variant}-${c.name}-r${repeat}`,html=variant==='baseline'?baselinePath:candidatePath;
 const args=[path.join(root,'scripts/target-refresh-rtc-benchmark.cjs'),'--run',run,'--html',html,'--duration','30000','--cases',JSON.stringify([c])];
 const map=path.join(root,'.qa/bottleneck-reproduction/canonical-map.json');if(fs.existsSync(map))args.push('--map',map);
 console.log(JSON.stringify({start:run}));
 const r=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:150000,maxBuffer:16*1024*1024});
 fs.writeFileSync(path.join(out,run+'.log'),(r.stdout||'')+'\n'+(r.stderr||''));
 const file=path.join(root,'.qa/netcode-starvation',run,c.name+'-summary.json'),data=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
 results.push({run,repeat,variant,roster:c.name,exit:r.status,error:r.error?.message,...data});fs.writeFileSync(path.join(out,'rtc.json'),JSON.stringify(results,null,2));
 console.log(JSON.stringify({done:run,exit:r.status,summaries:data?.summaries?.map(s=>({role:s.role,step:s.step.mean,sweep:s.sweep.mean,command:s.command.mean,commandP95:s.command.p95,tps:s.tps}))}));
 if(r.status!==0){console.error(r.stderr);process.exitCode=1;break}
}
