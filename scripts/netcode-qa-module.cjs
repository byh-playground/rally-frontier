// Historical HTML can still request the former SDK URL. Intercept it locally;
// never depend on the retired repository or its Pages hosting during QA.
// The current game uses the pinned Gamekit build dependency, never this fixture.
const fs=require('node:fs');
const path=require('node:path');
const {readGamekit}=require('./setup-gamekit.cjs');
const legacyFixtureURL='https://byh-playground.github.io/rollback-netcode/rollback-netcode.js';
function fixtureSource(){
  if(process.env.QA_SDK_PATH)return fs.readFileSync(process.env.QA_SDK_PATH,'utf8');
  const {modules}=readGamekit(path.join(__dirname,'..'));
  return ['rollback','deterministic','simloop','transport'].map(name=>{
    const bytes=modules[name];
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

// Current source QA uses the real ESM graph and original assets. The optional
// observer is appended inside main.js's app scope, without changing game code.
exports.serveSource = async function(htmlPath, { observer = '' } = {}) {
  const http = require('node:http');
  const root = path.dirname(path.resolve(htmlPath));
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const html = fs.readFileSync(htmlPath, 'utf8');
  if (!html.includes('src="./src/main.js"')) throw Error('Expected source ESM entrypoint. Historical standalone files need their historical tooling.');
  const server = http.createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
      let bytes = fs.readFileSync(file);
      if (file === path.join(root, 'src/main.js') && observer) {
        const main = bytes.toString('utf8'), end = main.lastIndexOf('})();');
        if (end < 0) throw Error('Production app IIFE missing from src/main.js');
        bytes = Buffer.from(main.slice(0, end) + observer + main.slice(end));
      }
      response.writeHead(200, { 'content-type': (mime[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'cache-control': 'no-store' });
      response.end(bytes);
    } catch (_) { response.writeHead(404); response.end('Source resource missing'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolve => server.close(resolve)) };
};
exports.routePinnedSDK = async function(page) {
  const { lock, modules } = readGamekit(path.join(__dirname, '..'));
  for (const [name, entry] of Object.entries(lock.modules)) {
    await page.route(`https://cdn.jsdelivr.net/gh/${lock.repository}@${lock.distCommit}/${entry.file}`, route => route.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: modules[name] }));
  }
};
