const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium:nativeChromium}=require('playwright'),chromium=require('./netcode-qa-module.cjs').wrapChromium(nativeChromium);
let html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8'),end=html.lastIndexOf('})();');
html=html.slice(0,end)+'window.__codecBench={StrategySim,GameRuleDefinition,RallySimulationAdapter,RallyStateCodec,StableSerializationUtil,StateValue};'+html.slice(end);
(async()=>{const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});try{
 const page=await browser.newPage();await page.route('https://codec-bench.local/',r=>r.fulfill({contentType:'text/html',body:html}));await page.goto('https://codec-bench.local/');await page.waitForFunction(()=>window.__codecBench);
 const results=await page.evaluate(()=>{const q=window.__codecBench,encoder=new TextEncoder(),decoder=new TextDecoder();
 const json={encode:v=>encoder.encode(q.StableSerializationUtil.stableStringify(v)),decode:b=>JSON.parse(decoder.decode(b))};
 const legacyJson={encode:v=>json.encode(JSON.parse(JSON.stringify(v))),decode:json.decode};
 const importState=(game,state,options,legacy)=>{const copy=q.StateValue.copy;if(legacy)q.StateValue.copy=value=>JSON.parse(JSON.stringify(value));try{game.sim.importState(state,options)}finally{q.StateValue.copy=copy}};
 const create=()=>{const sim=new q.StrategySim({decks:{host:['swarmbug'],guest:['swarmbug']},defenseCards:{host:[],guest:[]}},831047,q.GameRuleDefinition.resolve({overrides:{map:{generator:'fixed-standard'}}}));return {sim,adapter:new q.RallySimulationAdapter({sim})}};
 const median=a=>a.sort((x,y)=>x-y)[Math.floor(a.length/2)];const out=[];
 for(const count of [78,158]){const seed=create();while(seed.sim.units.length<count){const u=seed.sim.units[seed.sim.units.length%seed.sim.units.length].toState('save');u.id='bench-'+seed.sim.units.length;seed.sim.units.push(seed.sim.units[0].constructor.fromState(u));}seed.sim.rebuildRuntimeIndexes();
 const state=seed.sim.exportState(),cases={};let expected;
 for(const [name,codec]of Object.entries({legacyJson,json,binary:q.RallyStateCodec.codec})){
 const encoded=codec.encode(state),decoded=codec.decode(encoded);if(q.StableSerializationUtil.stableStringify(decoded)!==q.StableSerializationUtil.stableStringify(state))throw Error('state mismatch');
 const save=[],load=[],total=[];const game=create();importState(game,decoded,undefined,name==='legacyJson');
 for(let i=0;i<15;i++){let t=performance.now();const bytes=codec.encode(game.sim.exportState());save.push(performance.now()-t);t=performance.now();importState(game,codec.decode(bytes),{rollback:true},name==='legacyJson');load.push(performance.now()-t);}
 for(let i=0;i<35;i++){let t=performance.now();game.sim.step();const bytes=codec.encode(game.sim.exportState());total.push(performance.now()-t);}
 const final=q.StableSerializationUtil.stableStringify(game.sim.exportState());if(expected&&final!==expected)throw Error('game result mismatch');expected=final;
 cases[name]={bytes:encoded.length,saveMedianMs:median(save),loadMedianMs:median(load),stepSaveMedianMs:median(total),finalTick:game.sim.tick};game.sim.dispose?.();
 }out.push({units:count,equivalent:true,cases});seed.sim.dispose?.();}return out;});console.log(JSON.stringify(results,null,2));
 fs.mkdirSync(path.join(__dirname,'..','.qa'),{recursive:true});fs.writeFileSync(path.join(__dirname,'..','.qa','codec-benchmark.json'),JSON.stringify(results,null,2));
 }finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
