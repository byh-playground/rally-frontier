const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const fakePage=()=>({routes:[],async route(url,handler){this.routes.push({url,handler});}});

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
