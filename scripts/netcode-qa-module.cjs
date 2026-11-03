const fs=require('node:fs');
const path=require('node:path');
const {readGamekit}=require('./setup-gamekit.cjs');

// Current source QA uses the real ESM graph and original assets. The optional
// observer is appended to main.js, without changing game code: it sees main.js's
// own names plus every name exported by the modules main.js reaches, and runs on
// the page only, after boot, like the old end of the app IIFE.
function observerScope(root) {
  const seen = new Map(), queue = ['src/main.js'];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const names = new Set();
    for (const [, list] of text.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const item of list.split(',')) { const name = item.trim().split(/\s+as\s+/).pop(); if (name) names.add(name); }
    for (const [, name] of text.matchAll(/^export\s+(?:async\s+)?(?:class|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(name);
    seen.set(file, names);
    for (const [, spec] of text.matchAll(/^import\s+(?:[^'"]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]+\.js)['"]/gm)) queue.push(path.posix.join(path.posix.dirname(file), spec));
  }
  seen.delete('src/main.js');
  return [...seen].map(([file, names]) => ({ spec: './' + path.posix.relative('src', file), names: [...names] }));
}
function withObserver(main, observer, scope) {
  const imports = scope.map(({ spec }, i) => `import * as __qaScope${i} from '${spec}';`).join('\n');
  const names = [...new Set(scope.flatMap(({ names }) => names))];
  return `${main}\n${imports}\nif(!SIM_WORKER){const {${names.join(',')}}=Object.assign({},${scope.map((_, i) => '__qaScope' + i).join(',')});\n${observer}\n}\n`;
}
exports.serveSource = async function(htmlPath, { observer = '' } = {}) {
  const http = require('node:http');
  const root = path.dirname(path.resolve(htmlPath));
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const html = fs.readFileSync(htmlPath, 'utf8');
  if (!html.includes('src="./src/main.js"')) throw Error('Expected source ESM entrypoint.');
  const server = http.createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + path.sep)) { response.writeHead(403); response.end(); return; }
      let bytes = fs.readFileSync(file);
      if (file === path.join(root, 'src/main.js') && observer) bytes = Buffer.from(withObserver(bytes.toString('utf8'), observer, observerScope(root)));
      response.writeHead(200, { 'content-type': (mime[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'cache-control': 'no-store' });
      response.end(bytes);
    } catch (_) { response.writeHead(404); response.end('Source resource missing'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolve => server.close(resolve)) };
};
// Routes on the page's context so a single-player AI Worker (src/sim-worker.js),
// which loads GameKit itself, also gets the pinned local bytes instead of the CDN.
exports.routePinnedSDK = async function(page) {
  const { lock, modules } = readGamekit(path.join(__dirname, '..'));
  for (const [name, entry] of Object.entries(lock.modules)) {
    await page.context().route(`https://cdn.jsdelivr.net/gh/${lock.repository}@${lock.distCommit}/${entry.file}`, route => route.fulfill({ contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: modules[name] }));
  }
};
