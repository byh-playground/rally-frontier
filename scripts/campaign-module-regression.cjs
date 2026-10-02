const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.qa/campaign-module');
const missionIds = ['frontier-01-first-flag', 'frontier-02-rear-fire', 'frontier-03-spear-wall',
  'frontier-04-moving-front', 'frontier-05-two-flags', 'frontier-06-wounded-road', 'frontier-07-frontier-line'];

async function run() {
  fs.mkdirSync(output, { recursive: true });
  let baseline;
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const end = source.lastIndexOf('})();');
  assert.ok(end >= 0);
  const html = source.slice(0, end) + 'window.__campaignModuleQA={CampaignBuiltinCatalog,CampaignRuntime,UiRuntimeState};' + source.slice(end);
  let behavior = { mode: 'normal', requests: [] };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('Cache-Control', 'no-store');
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    if (pathname === '/campaign/campaigns.js') {
      const state = behavior;
      state.requests.push(req.url);
      const send = () => {
        if (state.mode === 'failure') { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('QA catalog temporarily unavailable'); }
        else { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(fs.readFileSync(path.join(root, pathname))); }
      };
      if (state.mode === 'delayed') state.release = send;
      else send();
      return;
    }
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: true });
  const results = { scenarios: [], pageErrors: [] };
  const contextPage = async mode => {
    behavior = { mode, requests: [] };
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', error => results.pageErrors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => window.__campaignModuleQA);
    assert.equal(behavior.requests.length, 0, 'Ordinary boot does not eagerly request the optional campaign module');
    return { context, page, state: behavior };
  };
  const openMenu = async page => { await page.locator('#gameStartBtn').click(); await page.locator('#campaignBtn').click(); };
  const waitRequested = async state => {
    const deadline = Date.now() + 10000;
    while (!state.release && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(state.release, 'Native module request reached the HTTP server');
  };
  try {
    {
      const { context, page, state } = await contextPage('normal');
      const loaded = await page.evaluate(async () => {
        const catalog = window.__campaignModuleQA.CampaignBuiltinCatalog;
        const [a, b] = await Promise.all([catalog.manifest(), catalog.manifest()]);
        const cached = await catalog.manifest();
        const native = (await import('./campaign/campaigns.js')).default;
        return { manifest: a, coalesced: a === b, cached: a === cached, native: a === native };
      });
      baseline = loaded.manifest;
      assert.equal(baseline.schemaVersion, 2);
      assert.deepEqual(baseline.campaigns.flatMap(c => c.missions).map(m => m.id), missionIds);
      for (const entry of baseline.campaigns.flatMap(c => c.missions)) {
        assert.equal(entry.mission.schemaVersion, 7);
        assert.equal(entry.mission.missionId, entry.id);
      }
      assert.equal(loaded.coalesced, true); assert.equal(loaded.cached, true); assert.equal(loaded.native, true);
      assert.equal(state.requests.length, 1, 'Concurrent and cached consumers make one native module request');
      await openMenu(page);
      const missions = baseline.campaigns.flatMap(c => c.missions);
      await page.locator('#campaignRepositoryList [data-mission-id]').first().waitFor();
      assert.deepEqual(await page.locator('#campaignRepositoryList [data-mission-id]').evaluateAll(nodes => nodes.map(n => ({ id: n.dataset.missionId, title: n.textContent }))), missions.map(m => ({ id: m.id, title: m.title })));
      for (const mission of missions) {
        await page.locator(`[data-mission-id="${mission.id}"]`).click();
        assert.equal(await page.locator('#campaignMissionTitle').textContent(), mission.title);
        assert.equal(await page.locator('#campaignStartBtn').isEnabled(), true);
        assert.equal(await page.evaluate(() => window.__campaignModuleQA.CampaignRuntime.pending.missionId), mission.id);
      }
      await page.screenshot({ path: path.join(output, 'catalog-seven-missions.png') });
      results.scenarios.push({ name: 'native-import-data-cache-menu-selection', missions: missions.length, requests: state.requests });
      await context.close();
    }
    {
      const { context, page, state } = await contextPage('delayed');
      await openMenu(page); await waitRequested(state);
      await page.locator('#campaignCloseBtn').click();
      const before = await page.locator('#campaignStatus').textContent();
      state.release();
      await page.evaluate(() => window.__campaignModuleQA.CampaignBuiltinCatalog.manifest());
      assert.equal(await page.locator('#campaignDialog').isVisible(), false);
      assert.equal(await page.locator('#campaignStatus').textContent(), before, 'Closed menu receives no stale load status');
      assert.equal(await page.locator('#campaignRepositoryList [data-mission-id]').count(), 0);
      assert.equal(await page.evaluate(() => window.__campaignModuleQA.CampaignRuntime.pending), null);
      assert.equal(await page.locator('#campaignStartBtn').isEnabled(), false);
      await openMenu(page);
      await page.locator('#campaignRepositoryList [data-mission-id]').first().waitFor();
      assert.equal(state.requests.length, 1, 'Reopening uses the successful cached catalog');
      results.scenarios.push({ name: 'delayed-close-and-reopen', requests: state.requests });
      await context.close();
    }
    {
      const { context, page, state } = await contextPage('delayed');
      await openMenu(page); await waitRequested(state);
      const preview = structuredClone(baseline.campaigns[0].missions[0].mission);
      preview.missionId = 'qa-newer-preview'; preview.title = 'Newer Preview selection';
      await page.locator('#campaignFileInput').setInputFiles({ name: 'qa-preview.js', mimeType: 'text/javascript', buffer: Buffer.from(`(${JSON.stringify(preview)})`) });
      await page.waitForFunction(() => window.__campaignModuleQA.CampaignRuntime.pending?.missionId === 'qa-newer-preview');
      const before = await page.locator('#campaignStatus').textContent();
      state.release();
      await page.evaluate(() => window.__campaignModuleQA.CampaignBuiltinCatalog.manifest());
      assert.equal(await page.locator('#campaignMissionTitle').textContent(), preview.title);
      assert.equal(await page.locator('#campaignStatus').textContent(), before);
      assert.equal(await page.locator('#campaignStartBtn').isEnabled(), true);
      assert.equal(await page.evaluate(() => window.__campaignModuleQA.CampaignRuntime.pending.missionId), preview.missionId);
      await page.screenshot({ path: path.join(output, 'newer-preview-preserved.png') });
      results.scenarios.push({ name: 'delayed-catalog-preserves-newer-file-preview' });
      await context.close();
    }
    {
      const { context, page, state } = await contextPage('failure');
      await openMenu(page);
      await page.waitForFunction(() => document.getElementById('campaignStatus').textContent.includes('실패'));
      assert.equal(await page.locator('#campaignStartBtn').isEnabled(), false);
      assert.equal(await page.locator('#campaignRepositoryList [data-mission-id]').count(), 0, 'Failed module does not provide an embedded fallback');
      await page.screenshot({ path: path.join(output, 'catalog-load-failure.png') });
      await page.locator('#campaignCloseBtn').click(); await page.locator('#gameStartBtn').click(); await page.locator('#singleBtn').click();
      await page.locator('#singleHostBtn').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#singleGuestBtn').isEnabled(), true, 'Base game choices remain usable when the optional catalog fails');
      await page.locator('#singleRoleCloseBtn').click();
      await openMenu(page);
      await page.waitForFunction(() => document.getElementById('campaignStatus').textContent.includes('실패'));
      assert.equal(state.requests.length, 2, 'Reopening while offline attempts the catalog again');
      state.mode = 'normal';
      await page.locator('#campaignRefreshBtn').click();
      await page.locator('#campaignRepositoryList [data-mission-id]').first().waitFor({ timeout: 15000 });
      assert.equal(state.requests.length, 3, 'Refresh makes a new HTTP module request after the failed native import');
      await page.locator('[data-mission-id="frontier-01-first-flag"]').click();
      assert.equal(await page.locator('#campaignStartBtn').isEnabled(), true);
      await page.screenshot({ path: path.join(output, 'catalog-retry-recovered.png') });
      results.scenarios.push({ name: 'visible-failure-base-ui-and-native-retry', requests: state.requests });
      await context.close();
    }
    assert.deepEqual(results.pageErrors, []);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
