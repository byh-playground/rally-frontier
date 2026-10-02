const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Real default Guest unit-test flow, live WebRTC/GameSession battle, native
// pointer drag, and active impact shake. Telemetry never changes gameplay or FX.
async function run() {
  const htmlPath = process.argv[2] || path.join(__dirname, '..', 'index.html');
  const output = path.resolve(__dirname, '..', '.qa', 'camera-shake-e2e');
  fs.mkdirSync(output, { recursive: true });
  let html = fs.readFileSync(htmlPath, 'utf8');
  const closing = html.lastIndexOf('})();');
  assert.ok(closing >= 0);
  html = html.slice(0, closing) +
    'window.__shakeE2E={ActiveViewState,MatchLifecycle};' + html.slice(closing);
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge',
    headless: process.env.QA_HEADED !== '1' });
  try {
    const page = await browser.newPage({ viewport: { width: 412, height: 915 },
      deviceScaleFactor: Number(process.env.QA_DPR) || 1,
      recordVideo: { dir: output, size: { width: 412, height: 915 } } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://127.0.0.1:32117/', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://127.0.0.1:32117/', { waitUntil: 'domcontentloaded' });
    await page.locator('#gameStartBtn').click();
    await page.locator('#advancedTestSettings summary').click();
    assert.equal(await page.locator('#unitTestAllyType').inputValue(), 'swarmbug');
    assert.equal(await page.locator('#unitTestEnemyType').inputValue(), 'shelltitan');
    await page.locator('#unitTestBtn').click();
    await page.locator('#singleGuestBtn').click();
    await Promise.race([
      page.locator('#gameScreen').waitFor({ state: 'visible', timeout: 30000 }),
      page.locator('#deckConfirmBtn').waitFor({ state: 'visible', timeout: 30000 })
    ]);
    if (await page.locator('#deckConfirmBtn').isVisible()) {
      if (await page.locator('#deckConfirmBtn').isDisabled()) {
        await page.locator('#deckEditBtn').click();
        await page.locator('#deckBuilderClearBtn').click();
        for (let i = 0; i < 9; i++) await page.locator('.deck-collection-card:not(.selected)').first().click();
        await page.locator('#deckBuilderSaveBtn').click();
      }
      await page.locator('#deckConfirmBtn').click();
    }
    await page.locator('#gameScreen').waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForTimeout(150);
    const initial = await page.evaluate(() => {
      const { ActiveViewState, MatchLifecycle } = window.__shakeE2E;
      const r = ActiveViewState.renderer;
      return { role: r.role, backend: r.backend, tick: r.snapshot.tick,
        dpr:devicePixelRatio,
        transport: ActiveViewState.transport?.constructor?.name,
        seed: r.snapshot.mapDescriptor.seed,
        peers: Object.keys(MatchLifecycle.singleMatch.sessions),
        units: r.snapshot.units.filter(u => u.alive).map(u => ({ side: u.side, type: u.type })) };
    });
    assert.equal(initial.role, 'guest');
    assert.equal(initial.backend, 'WebGL');
    assert.deepEqual(initial.peers.sort(), ['guest', 'host']);
    assert.ok(initial.units.some(u => u.side === 1 && u.type === 'swarmbug'));
    assert.ok(initial.units.some(u => u.side === 0 && u.type === 'shelltitan'));
    const jump = await page.evaluate(() => {
      const r = window.__shakeE2E.ActiveViewState.renderer, m = window.__shakeE2E.ActiveViewState.minimap;
      const unit = r.snapshot.units.find(u => u.alive && u.side === r.mySide() && u.type === 'swarmbug');
      const rect = m.contentRect();
      return { x: rect.left + r.viewX(unit.x) / r.world.width * rect.width,
        y: rect.top + r.viewY(unit.y) / r.world.height * rect.height };
    });
    await page.mouse.click(jump.x, jump.y);
    await page.evaluate(() => {
      const r = window.__shakeE2E.ActiveViewState.renderer;
      const x = r.world.width * .5, z = r.world.height * .5;
      const probe = { x, y: r.world.terrain.surfaces.heightAt(x, z), z, groundY: 0 };
      const original = r.renderMinimapPass.bind(r);
      window.__shakeFrames = [];
      let last = performance.now();
      r.renderMinimapPass = function () {
        original();
        const p = r.projectRenderWorldPosition(probe), sc = r.sc(),
          ox = (r.canvas.width - r.viewWorldW() * sc) / 2, now = performance.now();
        window.__shakeFrames.push({ tick: r.snapshot.tick, dt: now - last,
          shakeX: r.frameShakeX, shakeY: r.frameShakeY,
          left:r.cameraLeft,top:r.cameraTop,dragMoved:window.__shakeE2E.ActiveViewState.drag?.moved===true,
          geometryError: Math.max(Math.abs((p.x - ox) / sc + r.cameraLeft - r.viewX(probe.x)),
            Math.abs(p.y / sc + r.cameraTop - (r.viewY(probe.z) - probe.y * .6))),
          compositionMs: r.passProfiler.current['camera-compose'],
          workMs: r.perfStats.frameWorkMs });
        last = now;
      };
    });
    await page.locator('#glCanvas').scrollIntoViewIfNeeded();
    const box = await page.locator('#glCanvas').boundingBox();
    const start = await page.evaluate(box => {
      for(const fy of [.5,.35,.65])for(const fx of [.5,.25,.75]){
        const point={x:box.x+box.width*fx,y:box.y+box.height*fy};
        if(document.elementFromPoint(point.x,point.y)?.id==='glCanvas')return point;
      }
      return null;
    },box);
    assert.ok(start,'Native pointer has an unobstructed battlefield target');
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x+24,start.y+16);
    await page.waitForFunction(()=>window.__shakeE2E.ActiveViewState.drag?.moved===true,null,{timeout:3000});
    for (let i = 0; i < 120; i++) {
      const t = i / 119 * Math.PI * 6;
      await page.mouse.move(start.x + 55 * Math.sin(t), start.y + 35 * Math.sin(t * .5));
      await page.waitForTimeout(50);
      if (i === 20 || i === 80) await page.screenshot({ path: path.join(output, `combat-${i}.png`) });
    }
    await page.mouse.move(start.x, start.y); await page.mouse.up();
    const frames = await page.evaluate(() => window.__shakeFrames);
    const active = frames.filter(f => Math.abs(f.shakeX) + Math.abs(f.shakeY) > .1);
    const geometryError = Math.max(...frames.map(f => f.geometryError));
    const summary = { initial, frames: frames.length, activeShakeFrames: active.length,
      draggedFrames:frames.filter(f=>f.dragMoved).length,
      cameraTravel:Math.max(...frames.map(f=>f.left))-Math.min(...frames.map(f=>f.left)),
      shakeMaxX: Math.max(...frames.map(f => Math.abs(f.shakeX))),
      shakeMaxY: Math.max(...frames.map(f => Math.abs(f.shakeY))),
      geometryError, compositionMaxMs: Math.max(...frames.map(f => f.compositionMs || 0)), pageErrors: errors };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ summary, frames }, null, 2));
    await page.close();
    summary.video = await page.video().path();
    console.log(JSON.stringify(summary, null, 2));
    assert.ok(frames.length > 100, 'Actual live frames were observed during drag');
    assert.ok(active.length > 10, 'Camera shake stayed enabled and actually occurred');
    assert.ok(summary.draggedFrames>10&&summary.cameraTravel>10,'Native pointer really dragged the live camera');
    assert.ok(geometryError < 1e-7, 'Active shake never changes stable scene geometry during actual drag');
    assert.ok(summary.compositionMaxMs > 0, 'Live frames executed the final camera composition stage');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
