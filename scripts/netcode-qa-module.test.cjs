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

test('current ESM server serves real dependencies and puts observer only inside main scope', async t => {
 const {serveSource}=require('./netcode-qa-module.cjs');
 const root=path.resolve(__dirname,'..'), observer='window.__sourceObserver={BUILD_ID};';
 const server=await serveSource(path.join(root,'index.html'),{observer});t.after(()=>server.close());
 assert(server.url.startsWith('http://127.0.0.1:'));
 const html=await(await fetch(server.url)).text();assert(html.includes('src="./src/main.js"'));assert(!html.includes(observer));
 const main=await(await fetch(server.url+'src/main.js')).text();
 assert.equal(main.split(observer).length,2);assert.equal(main.replace(observer,''),fs.readFileSync(path.join(root,'src/main.js'),'utf8'));
 assert.equal((await fetch(server.url+'src/core/game-rules.js')).status,200);
 assert.equal((await fetch(server.url+'missing.js')).status,404);
});
test('current SDK QA serves exact verified bytes only at the immutable production URL',async()=>{
 const page=fakePage();await require('./netcode-qa-module.cjs').routePinnedSDK(page);
 const {lock,modules}=require('./setup-gamekit.cjs').readGamekit(path.resolve(__dirname,'..'));
 assert.equal(page.routes.length,Object.keys(lock.modules).length);
 for(const route of page.routes){
  const name=Object.keys(lock.modules).find(name=>route.url===`https://cdn.jsdelivr.net/gh/${lock.repository}@${lock.distCommit}/${lock.modules[name].file}`);
  assert(name);let response;await route.handler({fulfill:async r=>{response=r;}});assert.deepEqual(response.body,modules[name]);
 }
});
