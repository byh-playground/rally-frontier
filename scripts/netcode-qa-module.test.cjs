const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {wrapChromium}=require('./netcode-qa-module.cjs');
const fakePage=()=>({routes:[],async route(url,handler){this.routes.push({url,handler});}});
const fakeChromium={launch:async()=>({newPage:async()=>fakePage(),newContext:async()=>({newPage:async()=>fakePage()})})};
test('historical SDK imports are always fulfilled locally for pages and contexts',async()=>{
 const browser=await wrapChromium(fakeChromium).launch({});
 for(const page of [await browser.newPage(),await(await browser.newContext()).newPage()]){
  assert.equal(page.routes.length,1);let response;
  await page.routes[0].handler({fulfill:async value=>{response=value;}});
  assert.equal(response.contentType,'text/javascript');assert.ok(response.body.includes('data:text/javascript;base64,'));
  const api=await import('data:text/javascript;base64,'+Buffer.from(response.body).toString('base64'));
  assert.equal(typeof api.createSession,'function');assert.equal(typeof api.createLoop,'function');assert.equal(typeof api.createNostrRoom,'function');
 }
});
test('explicit QA candidate remains opt-in and a missing candidate fails visibly',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rally-sdk-fixture-'));const previous=process.env.QA_SDK_PATH;
 try{
  const file=path.join(dir,'sdk.js');fs.writeFileSync(file,'export const candidate = true;');process.env.QA_SDK_PATH=file;
  const browser=await wrapChromium(fakeChromium).launch({}),page=await browser.newPage();let body;
  await page.routes[0].handler({fulfill:async r=>{body=r.body;}});assert.equal(body,'export const candidate = true;');
  process.env.QA_SDK_PATH=path.join(dir,'missing.js');
  assert.throws(()=>page.routes[0].handler({fulfill:()=>{}}),/ENOENT/);
 }finally{if(previous===undefined)delete process.env.QA_SDK_PATH;else process.env.QA_SDK_PATH=previous;fs.rmSync(dir,{recursive:true,force:true});}
});
