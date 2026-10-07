// Historical HTML can still request the former SDK URL. Intercept it locally;
// never depend on the retired repository or its Pages hosting during QA.
// The current game uses its own pinned, bundled gamekit and never this fixture.
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const legacyFixtureURL='https://byh-playground.github.io/rollback-netcode/rollback-netcode.js';
function fixtureSource(){
  if(process.env.QA_SDK_PATH)return fs.readFileSync(process.env.QA_SDK_PATH,'utf8');
  const root=path.join(__dirname,'..','vendor','gamekit');
  const provenance=JSON.parse(fs.readFileSync(path.join(root,'provenance.json'),'utf8'));
  return ['rollback','deterministic','simloop','transport'].map(name=>{
    const entry=provenance.modules[name],file=name+'.js';
    if(entry?.file!==file)throw Error(`Missing pinned QA module: ${name}`);
    const bytes=fs.readFileSync(path.join(root,file));
    if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error(`Pinned QA module hash mismatch: ${name}`);
    return `export * from ${JSON.stringify('data:text/javascript;base64,'+bytes.toString('base64'))};`;
  }).join('\n');
}
async function routeCandidate(page){
  await page.route(legacyFixtureURL,r=>r.fulfill({contentType:'text/javascript',headers:{'access-control-allow-origin':'*'},body:fixtureSource()}));
  return page;
}
exports.wrapChromium=chromium=>({launch:async options=>{
  const browser=await chromium.launch(options);
  const newPage=browser.newPage.bind(browser),newContext=browser.newContext.bind(browser);
  browser.newPage=async(...args)=>routeCandidate(await newPage(...args));
  browser.newContext=async(...args)=>{const context=await newContext(...args),create=context.newPage.bind(context);context.newPage=async(...p)=>routeCandidate(await create(...p));return context;};
  return browser;
}});
