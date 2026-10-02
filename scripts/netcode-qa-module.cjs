// Explicit test fixture: serves the candidate ES module at the production URL.
// Without QA_SDK_PATH, tests use the actual public URL. Never used by the game.
const fs=require('node:fs');
const url='https://byh-playground.github.io/rollback-netcode/rollback-netcode.js';
async function routeCandidate(page){
  if(process.env.QA_SDK_PATH)await page.route(url,r=>r.fulfill({contentType:'text/javascript',headers:{'access-control-allow-origin':'*'},body:fs.readFileSync(process.env.QA_SDK_PATH,'utf8')}));
  return page;
}
exports.wrapChromium=chromium=>({launch:async options=>{
  const browser=await chromium.launch(options);
  const newPage=browser.newPage.bind(browser),newContext=browser.newContext.bind(browser);
  browser.newPage=async(...args)=>routeCandidate(await newPage(...args));
  browser.newContext=async(...args)=>{const context=await newContext(...args),create=context.newPage.bind(context);context.newPage=async(...p)=>routeCandidate(await create(...p));return context;};
  return browser;
}});
