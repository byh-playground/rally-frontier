const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

async function main(htmlPath = path.resolve(process.argv[2] || '_site/index.html')) {
  const html = fs.readFileSync(htmlPath);
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets/units/manifest.json'), 'utf8'));
  const server = http.createServer((request, response) => {
    if (request.url === '/' || request.url === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
    } else {
      response.writeHead(404);
      response.end('standalone output must not request relative resources');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    const relativeRequests = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (request.url().startsWith('http://127.0.0.1:') && pathname !== '/' && pathname !== '/index.html' && pathname !== '/favicon.ico') relativeRequests.push(request.url());
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Object.keys(window.RallyVectorAssets || {}).length > 0 && typeof window.RallyGamekit?.createVectorAssetLoader === 'function' && window.RallyVectorAssetLoader, undefined, { timeout: 90_000 });
    const result = await page.evaluate(expected => {
      const assets = window.RallyVectorAssets || {};
      return {
        ids: Object.keys(assets).sort(),
        expectedIds: expected.assets.map(entry => entry.id).sort(),
        sourceHashes: Object.fromEntries(Object.entries(assets).map(([id, asset]) => [id, asset.sourceSha256])),
        expectedHashes: Object.fromEntries(expected.assets.map(entry => [entry.id, entry.sha256])),
        geometry: Object.fromEntries(Object.entries(assets).map(([id, asset]) => [id, Boolean(asset.geometry && asset.metadata && asset.viewBox)])),
        omittedSourcePaths: Object.values(assets).every(asset => !Object.hasOwn(asset, 'sourcePaths')),
        cacheSize: window.RallyVectorAssetLoader?.size ?? -1,
        pendingLoads: window.RallyVectorAssetLoader?.pendingCount ?? -1,
        moduleAPI: typeof window.RallyGamekit?.createVectorAssetLoader,
      };
    }, expected);
    if (result.ids.length !== 51) throw new Error(`Expected 51 compiled unit SVGs, found ${result.ids.length}`);
    if (JSON.stringify(result.ids) !== JSON.stringify(result.expectedIds)) throw new Error('Compiled unit IDs do not match the SVG manifest');
    if (JSON.stringify(result.sourceHashes) !== JSON.stringify(result.expectedHashes)) throw new Error('Compiled source hashes do not match the SVG manifest');
    if (Object.values(result.geometry).some(value => !value)) throw new Error('A compiled unit SVG has no geometry, metadata, or viewBox');
    if (!result.omittedSourcePaths) throw new Error('Compiled unit SVGs unexpectedly include sourcePaths');
    if (result.cacheSize !== result.ids.length || result.pendingLoads !== 0) throw new Error('SDK startup loader cache does not contain every completed unit compilation');
    if (result.moduleAPI !== 'function') throw new Error('Pinned GameKit loader API is missing from the runtime');
    if (relativeRequests.length) throw new Error(`Standalone output requested relative resources: ${relativeRequests.join(', ')}`);
    if (pageErrors.length) throw new Error(`Browser page errors during startup: ${pageErrors.join('; ')}`);
    console.log(JSON.stringify({ status: 'passed', assetCount: result.ids.length, relativeRequests, pageErrors }, null, 2));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
