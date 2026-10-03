const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Production grid and DOM pointer handlers: camera movement must not change
// world geometry, and CSS pointer distances must agree with framebuffer scale.
async function run() {
  let html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  const closing = html.lastIndexOf('})();');
  assert.ok(closing >= 0);
  html = html.slice(0, closing) +
    'window.__cameraQA={GLRenderer,WorldContext,ActiveViewState,ReplayPresentation};' + html.slice(closing);
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const cases = [];
    for (const dpr of [1, 1.6]) {
      const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: dpr });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setContent(html);
    await page.waitForFunction(() => window.__cameraQA);
      await page.locator('#gameStartBtn').click();
      const grid = await page.evaluate(() => {
        const { GLRenderer, WorldContext } = window.__cameraQA;
        const canvas = document.createElement('canvas');
        canvas.width = 900; canvas.height = 1500;
        const renderer = new GLRenderer(canvas);
        renderer.world = WorldContext.fromMap({ width: 2560, height: 3840, terrain: {
          layers: [{ id: 'hill', level: 1, points: [
            { x: 1024, y: 900 }, { x: 2048, y: 900 },
            { x: 2048, y: 2100 }, { x: 1024, y: 2100 }
          ] }]
        } });
        const lines = [];
        renderer.line = (...args) => lines.push(args);
        renderer.circle = renderer.rect = () => {};
        const result = [];
        for (const role of ['host', 'guest']) {
          renderer.role = role;
          renderer.cameraTop = renderer.viewY(1100) - 400;
          const frames = [];
          for (const worldX of [1023, 1025]) {
            renderer.cameraLeft = renderer.viewX(worldX);
            lines.length = 0;
            // Calling the consumer also proves the underlay actually uses the grid.
            renderer.drawGround();
            frames.push(lines.filter(line => line[5]?.[3] === .035).map(line => line[1]));
          }
          result.push({ role, frames });
        }
        return result;
      });
      for (const item of grid) {
        assert.deepEqual(item.frames[0], item.frames[1], `${item.role}: grid phase is independent of edge terrain height`);
        assert.ok(item.frames[0].some(y => Math.abs(y - 400) < 1e-7), `${item.role}: authored world grid line is preserved`);
      }
      await page.evaluate(() => {
        const { GLRenderer, ActiveViewState, ReplayPresentation } = window.__cameraQA;
        const canvas = document.getElementById('glCanvas');
        const style = document.createElement('style');
        style.textContent = '#gameScreen{display:block!important;position:fixed!important;inset:0!important;z-index:9999!important} #glCanvas{display:block!important;width:396px!important;height:660px!important}';
        document.head.appendChild(style);
        // Make the real input surface visible without starting a second game.
        for (let parent = canvas; parent; parent = parent.parentElement) parent.style.display = 'block';
        canvas.style.width = '396px'; canvas.style.height = '660px';
        const renderer = new GLRenderer(canvas);
        renderer.resize(); renderer.cameraLeft = 1200; renderer.cameraTop = 1400;
        ActiveViewState.renderer = renderer;
        ActiveViewState.snap = { tick: 0 };
        ReplayPresentation.replayPlayer = {}; // Production replay input accepts only camera drag.
      });
      const box = await page.locator('#glCanvas').boundingBox();
      assert.ok(box && box.width > 0 && box.height > 0);
      const start = { x: box.x + box.width * .5, y: box.y + box.height * .5 };
      const initial = await page.evaluate(() => {
        const r = window.__cameraQA.ActiveViewState.renderer;
        const rect = r.canvas.getBoundingClientRect();
        return { left: r.cameraLeft, top: r.cameraTop, sc: r.sc(), bufferW: r.canvas.width,
          bufferH: r.canvas.height, cssW: rect.width, cssH: rect.height };
      });
      const canvasInput = page.locator('#glCanvas');
      await canvasInput.dispatchEvent('pointerdown', { pointerId: 1, clientX: start.x, clientY: start.y });
      await canvasInput.dispatchEvent('pointermove', { pointerId: 1, clientX: start.x + 40, clientY: start.y + 30 });
      const moved = await page.evaluate(() => {
        const r = window.__cameraQA.ActiveViewState.renderer;
        return { left: r.cameraLeft, top: r.cameraTop };
      });
      assert.ok(Math.abs(moved.left - (initial.left - 40 * initial.bufferW / initial.cssW / initial.sc)) < 1e-7, `DPR ${dpr}: horizontal camera motion matches CSS gesture`);
      assert.ok(Math.abs(moved.top - (initial.top - 30 * initial.bufferH / initial.cssH / initial.sc)) < 1e-7, `DPR ${dpr}: vertical camera motion matches CSS gesture`);
      await canvasInput.dispatchEvent('pointermove', { pointerId: 1, clientX: start.x, clientY: start.y });
      await canvasInput.dispatchEvent('pointerup', { pointerId: 1, clientX: start.x, clientY: start.y });
      const returned = await page.evaluate(() => {
        const r = window.__cameraQA.ActiveViewState.renderer;
        return { left: r.cameraLeft, top: r.cameraTop };
      });
      assert.deepEqual(returned, { left: initial.left, top: initial.top }, 'Gesture round trip restores exact camera position');
      assert.deepEqual(errors, []);
      cases.push({ dpr, grid, initial, moved, returned, pageErrors: errors });
      await page.close();
    }
    console.log(JSON.stringify({ cases, assertions: 'PASS' }, null, 2));
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
