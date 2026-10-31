const fs=require('node:fs');
const path=require('node:path');
const {readGamekit}=require('./setup-gamekit.cjs');

// Current source QA uses the real ESM graph and original assets. The optional
// observer is appended inside main.js's app scope, without changing game code.
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
