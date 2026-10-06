const fs=require('node:fs'),path=require('node:path');
const performanceFile='.qa/game-performance-benchmark/summary.json';
if(fs.existsSync(performanceFile)){
 const report=JSON.parse(fs.readFileSync(performanceFile,'utf8'));
 console.log('RALLY_PERFORMANCE '+JSON.stringify({config:report.config,machine:report.machine,browserVersion:report.browserVersion,results:report.results.map(({revision,condition,repetition,setup,summary})=>({revision,condition,repetition,setup,summary}))}));
}
const preferred=['.qa/netcode-ui-e2e/host-mode-settings.png','.qa/netcode-ui-e2e/guest-battle.png','.qa/gamekit-standalone/standalone-campaign-game.png','.qa/game-performance-benchmark/f6037f05-quiet-1/battle.png','.qa/game-performance-benchmark/HEAD-quiet-1/battle.png'];
const fallback=['.qa/gamekit-standalone','.qa/netcode-ui-e2e','.qa/ground-depth'].flatMap(root=>fs.existsSync(root)?fs.readdirSync(root).filter(name=>name.endsWith('.png')).map(name=>path.join(root,name)):[]);
let count=0;
for(const file of new Set([...preferred,...fallback])){
 if(!fs.existsSync(file)||count>=4)continue;const bytes=fs.readFileSync(file);if(bytes.length>500000)continue;
 console.log('RALLY_PNG_BEGIN '+file);const encoded=bytes.toString('base64');for(let i=0;i<encoded.length;i+=6000)console.log(encoded.slice(i,i+6000));console.log('RALLY_PNG_END');count++;
}
console.log('RALLY_VISUAL_COUNT '+count);
