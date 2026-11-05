const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
// routePinnedSDK routes on the page's context so a sim Worker shares the pinned bytes.
const fakePage=()=>{const context={routes:[],async route(url,handler){this.routes.push({url,handler});}};return {routes:context.routes,context:()=>context};};

test('current ESM server serves real dependencies and appends the observer to main.js only', async t => {
 const {serveSource}=require('./netcode-qa-module.cjs');
 const root=path.resolve(__dirname,'..'), observer='window.__sourceObserver={BUILD_META};';
 const server=await serveSource(path.join(root,'index.html'),{observer});t.after(()=>server.close());
 assert(server.url.startsWith('http://127.0.0.1:'));
 const html=await(await fetch(server.url)).text();assert(html.includes('src="./src/main.js"'));assert(!html.includes(observer));
 const main=await(await fetch(server.url+'src/main.js')).text();
 const original=fs.readFileSync(path.join(root,'src/main.js'),'utf8'),added=main.slice(original.length);
 assert.equal(main.split(observer).length,2);assert(main.startsWith(original));
 // BUILD_META reaches the observer from core/build-info.js through the appended scope imports.
 assert.match(added,/import \* as __qaScope\d+ from '\.\/core\/build-info\.js';/);
 assert.match(added,/const \{[^}]*\bBUILD_META\b[^}]*\}=Object\.assign/);
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
