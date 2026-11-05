const path=require('path');const repo=path.resolve(process.argv[2]);
const { chromium } = require('playwright');
const { serveSource, routePinnedSDK } = require(path.join(repo,'scripts/netcode-qa-module.cjs'));
(async()=>{const server=await serveSource(path.join(repo,'index.html'),{observer:'globalThis.__ok=1;'});
const b=await chromium.launch({channel:'msedge'});const p=await b.newPage();await routePinnedSDK(p);await p.goto(server.url+'#/');await p.waitForFunction(()=>globalThis.__ok&&globalThis.RallyVectorAssets,null,{timeout:60000});await p.waitForTimeout(500);
const out=await p.evaluate(async()=>{const {grainPortrait}=await import(new URL('./src/ui/grain-portrait.js',location.href).href);const fnv=s=>{let h=2166136261>>>0;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0}return h.toString(16)};const r={};for(const t of ['rice','soybean','redbean']){for(const w of [160,320]){const url=await grainPortrait(t,globalThis.RallyVectorAssets[t],w);r[t+':'+w]=fnv(url)+':'+url.length}}return r});
console.log(JSON.stringify(out));await b.close();await server.close()})();
