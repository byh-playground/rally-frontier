const assert=require('node:assert/strict');
const fs=require('node:fs');
const {chromium}=require('playwright');
const url='https://byh-playground.github.io/rollback-netcode/rollback-netcode.js';
const html=fs.readFileSync(require('node:path').join(__dirname,'..','index.html'),'utf8');
assert(!html.includes('rally-netcode-bundle'));
assert(!fs.existsSync(require('node:path').join(__dirname,'embed-netcode.cjs')));
(async()=>{const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true});
try{const results=[];
for(const mode of ['public','offline','missing-api','candidate','delayed']){
 const page=await browser.newPage();const requests=[];page.on('request',r=>{if(r.url().includes('rollback-netcode'))requests.push(r.url())});
 await page.route('https://loading-qa.local/',r=>r.fulfill({contentType:'text/html',body:html}));
 if(mode==='offline')await page.route(url,r=>r.abort());
 if(mode==='missing-api')await page.route(url,r=>r.fulfill({contentType:'text/javascript',body:'export const VERSION="missing";'}));
 if(['candidate','delayed'].includes(mode))await page.route(url,async r=>{if(mode==='delayed'){await new Promise(resolve=>setTimeout(resolve,750));}await r.fulfill({contentType:'text/javascript',body:fs.readFileSync(process.env.QA_SDK_PATH,'utf8')})});
 await page.goto('https://loading-qa.local/',{waitUntil:'domcontentloaded'});
 if(mode==='delayed'){assert.equal(await page.evaluate(()=>window.RallyNetcode),undefined);}
 if(mode==='public'){await page.waitForFunction(()=>window.RallyNetcode||window.__RALLY_FATAL_DIAGNOSTIC__); }
 if(['candidate','delayed'].includes(mode)){await page.waitForFunction(()=>window.RallyNetcode);assert.equal(await page.evaluate(()=>window.__RALLY_FATAL_DIAGNOSTIC__?.kind),undefined);}
 else if(mode!=='public'||!(await page.evaluate(()=>!!window.RallyNetcode))){await page.waitForFunction(()=>window.__RALLY_FATAL_DIAGNOSTIC__?.kind==='RALLY_NETCODE_LOAD_FAILED');assert(await page.locator('#renderFatalOverlay').isVisible());assert.equal(await page.evaluate(()=>window.RallyNetcode),undefined);}
 assert(requests.length===1&&requests[0]===url);results.push({mode,status:'PASS',diagnostic:await page.evaluate(()=>window.__RALLY_FATAL_DIAGNOSTIC__?.message)});await page.close();
}console.log(JSON.stringify(results,null,2));}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
