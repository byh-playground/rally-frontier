const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Exercises the production mask upload and Fog fragment shader on a real WebGL
// context. The control restores instantaneous mask replacement without changing
// simulation visibility; it must reproduce the 1-world-unit boundary flash.
async function run() {
  let html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  const close = html.lastIndexOf('})();');
  assert.ok(close >= 0);
  html = html.slice(0, close) + 'window.__fogTemporalQA={GLRenderer,WorldContext};' + html.slice(close);
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(html);
    await page.waitForFunction(() => window.__fogTemporalQA);
    const result = await page.evaluate(() => {
      const { GLRenderer, WorldContext } = window.__fogTemporalQA;
      const canvas = document.createElement('canvas');
      canvas.width = 32; canvas.height = 32;
      const renderer = new GLRenderer(canvas), gl = renderer.gl;
      let clock = 1000;
      Object.defineProperty(performance, 'now', { value: () => clock, configurable: true });
      const makeWorld = () => WorldContext.fromMap({ width: 2560, height: 3840, terrain: { layers: [] } });
      renderer.world = makeWorld();
      const snapshot = tick => ({ tick, world: renderer.world, units: [], buildings: [], activeSpells: [] });
      function source(x) {
        const src = { x, y: 1024, level: 0, r: 400, detect: 0, air: false, ignoresTerrainVision: false };
        renderer.visionGridBySide = [new Map(), new Map()];
        for (let cy = 0; cy <= 12; cy++) for (let cx = 0; cx <= 8; cx++) {
          renderer.visionGridBySide[0].set(`${cx},${cy}`, [src]);
        }
      }
      function update(tick, x) {
        renderer.snapshot = snapshot(tick); source(x); renderer.ensureFogTextures();
      }
      update(10, 1274);
      const first = renderer.fogMaskRecords.get('level:0').target.slice();
      clock = 1100; update(11, 1275);
      const next = renderer.fogMaskRecords.get('level:0').target;
      const changed = [...next.keys()].filter(i => first[i] !== next[i]);
      const index = changed[0], { w, h } = renderer.fogMaskSize;
      const u = (index % w) / (w - 1), v = Math.floor(index / w) / (h - 1);
      function pixel() {
        if(renderer.device.active)renderer.device.endFrame();
        renderer.device.beginFrame({width:canvas.width,height:canvas.height,clearColor:[1,1,1,1]});
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        renderer.fogFrame.reset();
        for (const [x, y] of [[0,0],[32,0],[32,32],[0,0],[32,32],[0,32]]) {
          renderer.fogFrame.push5(x, y, 0, u, v);
        }
        renderer.flushFog(renderer.fogTextures.get('level:0'), [0,0,0,1], renderer.fogPreviousTextures.get('level:0'));
        const rgba = new Uint8Array(4); gl.readPixels(16, 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        return rgba[0];
      }
      const frames = [];
      for (const t of [0,20,40,60,80,100]) { clock = 1100 + t; frames.push(pixel()); }
      const productionAmount = renderer.fogTransitionAmount;
      renderer.fogTransitionAmount = () => 1;
      clock = 1100;
      const instantaneousControl = pixel();
      renderer.fogTransitionAmount = productionAmount;
      // An early next snapshot starts from the currently displayed mask rather
      // than restarting from the last binary target.
      clock = 1150;
      const beforeInterrupted = pixel(); update(12, 1274);
      const afterInterrupted = pixel();
      const exactVisibility = renderer.visibleRawAtLevel((index % w)/(w-1)*2560, Math.floor(index/w)/(h-1)*3840, 0);
      const resets = {};
      renderer.role = 'guest'; renderer.ensureFogTextures(); resets.side = { amount: renderer.fogTransitionAmount(), pixel: pixel() };
      renderer.role = 'host'; renderer.ensureFogTextures();
      clock += 100; update(13, 1275);
      renderer.world = makeWorld(); renderer.snapshot = snapshot(14);
      renderer.visionGridBySide = [new Map(), new Map()]; renderer.ensureFogTextures();
      resets.world = { amount: renderer.fogTransitionAmount(), pixel: pixel() };
      update(15, 1274); clock += 100; update(16, 1275);
      renderer.snapshot = snapshot(15); renderer.visionGridBySide = [new Map(),new Map()]; renderer.ensureFogTextures();
      resets.backwardSeek = { amount: renderer.fogTransitionAmount(), pixel: pixel() };
      update(16, 1274); clock += 100; update(17, 1275);
      renderer.resetFogTransition(); renderer.visionGridBySide = [new Map(),new Map()]; renderer.ensureFogTextures();
      resets.explicitSeek = { amount: renderer.fogTransitionAmount(), pixel: pixel() };
      update(18, 1274); clock += 100; update(19, 1275);
      renderer.setSnapshot(snapshot(20), { snapTargets: true }); renderer.ensureFogTextures();
      resets.snap = { amount: renderer.fogTransitionAmount(), pixel: pixel() };
      update(21, 1274); clock += 100; update(22, 1275);
      renderer.replayVisionMode = 'guest'; renderer.ensureFogTextures();
      resets.replayPerspective = { amount: renderer.fogTransitionAmount(), pixel: pixel() };
      renderer.replayVisionMode = null; renderer.ensureFogTextures();
      renderer.replayObserverAll = true; renderer.drawFog(); renderer.replayObserverAll = false;
      renderer.visionGridBySide = [new Map(),new Map()]; renderer.ensureFogTextures();
      resets.observer = { amount: renderer.fogTransitionAmount(), pixel: pixel() };
      update(23, 1274); clock += 100; update(24, 1275);
      renderer.snapshot = snapshot(100); renderer.visionGridBySide = [new Map(),new Map()]; renderer.ensureFogTextures();
      resets.forwardSeek = { amount: renderer.fogTransitionAmount(), pixel: pixel() };
      return { changedTexels: changed.length, oldValue: first[index], newValue: next[index], frames,
        instantaneousControl, beforeInterrupted, afterInterrupted, exactVisibility,
        exactMask: renderer.fogMaskRecords.get('level:0').target[index], resets, glError: gl.getError() };
    });
    assert.equal(result.changedTexels, 2);
    assert.equal(Math.abs(result.oldValue - result.newValue), 255);
    assert.equal(result.frames[0], result.oldValue);
    assert.equal(result.frames.at(-1), result.newValue);
    assert.ok(result.frames.slice(1,-1).every(p => p > 0 && p < 255));
    const jumps = result.frames.slice(1).map((p,i) => Math.abs(p - result.frames[i]));
    assert.ok(Math.max(...jumps) <= 110, 'Real GPU 20 ms frames have bounded brightness changes');
    assert.equal(Math.abs(result.instantaneousControl - result.frames[0]), 255, 'Negative control reproduces old binary flash');
    assert.ok(Math.abs(result.beforeInterrupted - result.afterInterrupted) <= 2, 'Interrupted blend preserves its displayed brightness');
    assert.equal(result.exactVisibility, result.oldValue === 255, 'Exact visibility immediately uses new snapshot');
    for (const reset of Object.values(result.resets)) assert.deepEqual(reset, { amount: 1, pixel: 0 });
    assert.equal(result.glError, 0); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ...result, pageErrors: errors, assertions: 'PASS' }, null, 2));
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
