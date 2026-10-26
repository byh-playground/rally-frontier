const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function main(htmlPath = path.resolve(process.argv[2] || '_site/index.html')) {
  const { serveSource, routePinnedSDK } = require('./netcode-qa-module.cjs');
  const expected = JSON.parse(fs.readFileSync(path.join(path.dirname(htmlPath), 'assets/units/manifest.json'), 'utf8'));
  const server = await serveSource(htmlPath);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.QA_BROWSER_CHANNEL || 'msedge' });
    const page = await browser.newPage();
    await routePinnedSDK(page);
    const pageErrors = [];
    const relativeRequests = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (request.url().startsWith('http://127.0.0.1:') && pathname !== '/' && pathname !== '/index.html' && pathname !== '/favicon.ico') relativeRequests.push(request.url());
    });
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
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
    if (!relativeRequests.some(url => new URL(url).pathname === '/src/main.js')) throw new Error('Original source entrypoint was not requested');
    if (!relativeRequests.some(url => new URL(url).pathname === '/assets/units/manifest.json')) throw new Error('Original SVG manifest was not requested');
    if (pageErrors.length) throw new Error(`Browser page errors during startup: ${pageErrors.join('; ')}`);
    console.log(JSON.stringify({ status: 'passed', assetCount: result.ids.length, relativeRequests, pageErrors }, null, 2));
  } finally {
    try { await browser?.close(); } finally { await server.close(); }
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
