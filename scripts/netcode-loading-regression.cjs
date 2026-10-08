const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const {modules:gamekitModules}=require('./setup-gamekit.cjs').readGamekit(path.join(__dirname,'..'));
const html=fs.readFileSync(process.argv[2]||path.join(__dirname,'../_site/index.html'),'utf8');
(async()=>{const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'chromium',headless:true});
try{const results=[];
for(const mode of ['bundled-offline','missing-api','invalid-module','delayed']){
 const page=await browser.newPage(),requests=[];page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url())});
 let source=html;
 if(mode==='missing-api'||mode==='invalid-module'||mode==='delayed'){
  const replacement=mode==='missing-api'?'export const VERSION="missing"':mode==='invalid-module'?'invalid Javascript!':'await new Promise(resolve=>setTimeout(resolve,750));'+gamekitModules.rollback.toString('utf8');
  const map=source.match(/const RALLY_GAMEKIT_MODULES=Object.freeze\((\{[^\n]+\})\);/);assert(map);
  const modules=JSON.parse(map[1]);modules.rollback='data:text/javascript;base64,'+Buffer.from(replacement).toString('base64');source=source.replace(map[0],`const RALLY_GAMEKIT_MODULES=Object.freeze(${JSON.stringify(modules)});`);
 }
 await page.route('**/*',route=>route.abort());await page.setContent(source);
 if(mode==='delayed')assert.equal(await page.evaluate(()=>window.RallyNetcode),undefined);
 if(mode==='bundled-offline'||mode==='delayed'){await page.waitForFunction(()=>window.RallyNetcode);assert.equal(await page.evaluate(()=>window.__RALLY_FATAL_DIAGNOSTIC__?.kind),undefined)}
 else{await page.waitForFunction(()=>window.__RALLY_FATAL_DIAGNOSTIC__?.kind==='RALLY_NETCODE_LOAD_FAILED');assert(await page.locator('#renderFatalOverlay').isVisible());assert.equal(await page.evaluate(()=>window.RallyNetcode),undefined)}
 assert.deepEqual(requests,[]);results.push({mode,status:'PASS'});await page.close();
}console.log(JSON.stringify(results,null,2));}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
