'use strict';

const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const baselinePath = path.resolve(process.argv[2] || process.env.VISUAL_BASELINE_HTML || '');
const migratedPath = path.resolve(process.argv[3] || path.join(root, '_site/index.html'));
const outputDirectory = path.join(root, '.qa/vector-assets-visual-comparison');
const sceneSeed = 20261016;
const pauseTick = 5;
const visiblePixelTolerance = 8;
const maximumVisibleDiffRatio = 0.001;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function exposeVisualHarness(html, label) {
  if (html.includes('src="./src/main.js"')) throw Error('Historical standalone visual comparison requires historical bundled HTML. Current source validation uses npm run test:startup and npm run test:ui.');
  const marker = 'DebugScenarioHarness.populateUi();';
  assert.equal(html.split(marker).length - 1, 1, `${label} must expose the Rally renderer at the expected startup point`);
  const expose = `window.__rallyVectorVisualQA={MatchLifecycle,DebugScenarioHarness,ActiveViewState,UiRuntimeState,ViewRuntimeState,GameSession,BattlefieldProjection};\n`;
  // Freeze cosmetic air-unit and idle flag animation in both builds. A fixed
  // simulation tick does not freeze these wall-clock presentation phases.
  return html.replace(marker, `${expose}${marker}`)
    .replace('record.player.seek(this.presentationNow(performance.now())+phase)', 'record.player.seek(500+phase)')
    .replace('Math.sin(this.presentationNow()*.004+', 'Math.sin(500*.004+')
    .replace('const idleWave=Math.sin(now*.0045)*2.2*sc;', 'const idleWave=Math.sin(500*.0045)*2.2*sc;');
}

const baselineHtml = exposeVisualHarness(fs.readFileSync(baselinePath, 'utf8'), 'pre-migration build');
const migratedHtml = exposeVisualHarness(fs.readFileSync(migratedPath, 'utf8'), 'startup-loader build');

async function createBrowserPage(browser, url, label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await context.route(/^https?:\/\//, route => {
    const hostname = new URL(route.request().url()).hostname;
    if (hostname === '127.0.0.1') return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__rallyVectorVisualQA && window.RallyGamekit, undefined, { timeout: 90_000 });
  await page.evaluate(({ seed, targetTick }) => {
    const q = window.__rallyVectorVisualQA;
    q.UiRuntimeState.value.settings.selectionMode = 'deck';
    q.UiRuntimeState.value.settings.presetId = 'standard';
    q.freezeAtTick = targetTick;
    q.frozenAtTick = null;
    q.presentationSnapshots = new Map();
    const originalFrameApplied = q.GameSession.prototype.onNetcodeFrameApplied;
    q.GameSession.prototype.onNetcodeFrameApplied = function (...args) {
      const result = originalFrameApplied.apply(this, args);
      if (this.role === 'host' && this.sim.tick > 0 && this.sim.tick <= targetTick) {
        // Detached fixture samples preserve the exact simulation path, independent
        // of how many requestAnimationFrame callbacks happened before pausing.
        q.presentationSnapshots.set(this.sim.tick, {
          tick: this.sim.tick, tps: this.sim.tps,
          units: this.sim.units.map(unit => unit.toState()),
          projectiles: this.sim.projectiles.map(projectile => projectile.toState()),
          flags: structuredClone(this.sim.flags),
        });
      }
      // Stop each peer at the fixed tick, before a pulse can catch up again.
      if (this.sim?.tick >= targetTick) {
        this.setTestModePaused(true);
        if (this.role === 'host') {
          q.frozenAtTick = this.sim.tick;
          const r=q.ActiveViewState.renderer, units=this.sim.units.filter(u=>u.hp>0);
          const x=units.reduce((sum,u)=>sum+u.x,0)/units.length, y=units.reduce((sum,u)=>sum+u.y,0)/units.length;
          r.cameraLeft=Math.max(0,Math.min(r.world.width-r.viewWorldW(),r.viewX(x)-r.viewWorldW()/2));
          r.cameraTop=r.clampCameraTop(q.BattlefieldProjection.planarY(r.viewY(y),r.world.terrain.surfaces.heightAt(x,y))-r.viewWorldH()/2);
          q.ViewRuntimeState.byRole.host.cameraLeft=r.cameraLeft;
          q.ViewRuntimeState.byRole.host.cameraTop=r.cameraTop;
        }
      }
      return result;
    };
    q.DebugScenarioHarness.pending = q.DebugScenarioHarness.normalize({
      kind: 'unit-combat', testMode: 'mobile-battle', totalUnits: 100, composition: 'mixed',
      fixedSeed: seed, sampleSeconds: 10, humanRole: 'host', research: false,
    });
    q.MatchLifecycle.startLocalTest();
  }, { seed: sceneSeed, targetTick: pauseTick });

  await page.waitForFunction(() => window.__rallyVectorVisualQA?.ActiveViewState?.snap?.tick >= 5,
    undefined, {timeout: 90_000});
  await page.evaluate(() => {
    const q=window.__rallyVectorVisualQA,r=q.ActiveViewState.renderer;
    const units=q.ActiveViewState.session.sim.units.filter(u=>u.hp>0);
    const x=units.reduce((sum,u)=>sum+u.x,0)/units.length,y=units.reduce((sum,u)=>sum+u.y,0)/units.length;
    r.cameraLeft=Math.max(0,Math.min(r.world.width-r.viewWorldW(),r.viewX(x)-r.viewWorldW()/2));
    r.cameraTop=r.clampCameraTop(q.BattlefieldProjection.planarY(r.viewY(y),r.world.terrain.surfaces.heightAt(x,y))-r.viewWorldH()/2);
    Object.assign(q.ViewRuntimeState.byRole.host,{cameraLeft:r.cameraLeft,cameraTop:r.cameraTop});
  });

  try { await page.waitForFunction(() => {
    const q = window.__rallyVectorVisualQA;
    const renderer = q?.ActiveViewState?.renderer;
    const snap = q?.ActiveViewState?.snap;
    return q?.frozenAtTick === 5 && snap?.tick >= 5 && renderer?.backend === 'WebGL' &&
      renderer?.vectorUnitAssetCache?.size > 0 && renderer?.vectorAssetDrawnInstances > 0 &&
      !q.ActiveViewState.session.renderTimelineChanged;
  }, undefined, { timeout: 90_000 }); } catch (error) {
    fs.mkdirSync(outputDirectory, { recursive: true });
    const diagnostic = await page.evaluate(() => {
      const q = window.__rallyVectorVisualQA;
      return { frozenAtTick: q?.frozenAtTick, snapTick: q?.ActiveViewState?.snap?.tick,
        backend: q?.ActiveViewState?.renderer?.backend,
        vectorRecords: q?.ActiveViewState?.renderer?.vectorUnitAssetCache?.size,
        vectorDrawInstances: q?.ActiveViewState?.renderer?.vectorAssetDrawnInstances,
        camera: {left:q?.ActiveViewState?.renderer?.cameraLeft,top:q?.ActiveViewState?.renderer?.cameraTop},
        peers: Object.fromEntries(Object.entries(q?.MatchLifecycle.localTest?.sessions || {}).map(([id, s]) =>
          [id, { tick: s.sim?.tick, paused: s.testModePaused, fatal: s.simulationFatal, scenario: s.matchConfig?.debugScenario }])) };
    });
    fs.writeFileSync(path.join(outputDirectory, 'startup-failure.json'), JSON.stringify({label, errors, diagnostic}, null, 2));
    await page.screenshot({ path: path.join(outputDirectory, 'startup-failure.png') });
    throw error;
  }

  // Let transient startup VFX expire, then replay the same captured presentation
  // history in both builds. Pausing resets snapshot deltas to zero, so waiting
  // alone cannot settle a facing cache that remembers an earlier render frame.
  await page.waitForTimeout(1500);
  await page.evaluate(async targetTick => {
    const q=window.__rallyVectorVisualQA, renderer=q.ActiveViewState.renderer;
    const snapshots=[...q.presentationSnapshots.values()].sort((a,b)=>a.tick-b.tick);
    if (snapshots.length!==targetTick || snapshots.some((snapshot,i)=>snapshot.tick!==i+1)) {
      throw new Error('Visual fixture must capture every presentation tick before pausing');
    }
    const stepMs=renderer.presentationTargetIntervalMs(snapshots.at(-1));
    const base=performance.now()-(targetTick+3)*stepMs;
    renderer.renderState=new renderer.renderState.constructor(renderer.renderState.definitions);
    for (const snapshot of snapshots) {
      renderer.renderState.capture(snapshot,base+snapshot.tick*stepMs,snapshot.tick===1,stepMs);
    }
    renderer.renderState.updateMetadata(renderer.snapshot);
    renderer.unitFacingStates.clear();
    renderer.artilleryFacingStates.clear();
    // The normal renderer derives facing from the shared final movement sample;
    // no fixture angle, region exclusion, or production-renderer change is used.
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  }, pauseTick);
  const info = await page.evaluate(() => {
    const q = window.__rallyVectorVisualQA;
    const session = q.ActiveViewState.session;
    const renderer = q.ActiveViewState.renderer;
    const canvas = document.getElementById('glCanvas');
    return {
      backend: renderer.backend,
      tick: session.sim.tick,
      seed: session.sim.seed,
      mapHash: session.sim.mapFingerprint(),
      units: session.sim.units.length,
      vectorRecords: renderer.vectorUnitAssetCache.size,
      vectorAssetSignatures: Object.fromEntries(Object.entries(window.RallyVectorAssets || {}).map(([key,asset]) => {
        const hash = value => { const text=JSON.stringify(value); let h=2166136261; for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619); return (h>>>0).toString(16); };
        return [key,{geometry:hash(asset.geometry),metadata:hash(asset.metadata),vertices:asset.geometry.vertices.length,indices:asset.geometry.indices.length}];
      })),
      vectorDrawInstances: renderer.vectorAssetDrawnInstances,
      presentationHistoryTicks: [...q.presentationSnapshots.keys()].sort((a,b)=>a-b),
      // Keep the final display contract in the report as well as the pixel comparison.
      snapshotTick: renderer.snapshot?.tick,
      renderUnits: Object.fromEntries(renderer.renderState.displayed('unit', renderer.presentationNow()).map(u => {
        const model=renderer.renderState.model('unit',u.id,renderer.presentationNow());
        const authority=session.sim.units.find(unit=>unit.id===u.id);
        const delta=renderer.renderTrackedDelta(u,'unit');
        return [u.id,{type:u.type,displayed:[model?.entity?.x,model?.entity?.y],
          authority:[authority?.x,authority?.y],delta:[delta.x,delta.y],
          facingAngle:renderer.unitFacingStates.get(u.id)?.angle??null}];
      })),
      canvas: { width: canvas.width, height: canvas.height },
    };
  });
  assert.equal(info.backend, 'WebGL', `${label} should use the real WebGL battlefield renderer`);
  assert.equal(info.seed, sceneSeed, `${label} should use the fixed map seed`);
  assert.equal(info.tick, pauseTick, `${label} should freeze at the same simulation tick`);
  assert(info.vectorRecords > 0 && info.vectorDrawInstances > 0, `${label} should draw compiled vector unit meshes`);
  assert.deepEqual(errors, [], `${label} should have no browser page errors`);
  const canvas = page.locator('#glCanvas');
  const bounds = await canvas.boundingBox();
  assert(bounds && bounds.width > 0 && bounds.height > 0, `${label} WebGL canvas must be visible`);
  const png = await canvas.screenshot({ animations: 'disabled', timeout: 45_000 });
  return { context: page.context(), page, png, info, errors };
}

async function compareImages(browser, baseline, migrated) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ({ baselinePng, migratedPng, tolerance }) => {
      const decode = async data => createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
      const [a, b] = await Promise.all([decode(baselinePng), decode(migratedPng)]);
      if (a.width !== b.width || a.height !== b.height) throw new Error(`WebGL screenshots have different sizes: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
      const canvas = document.createElement('canvas');
      canvas.width = a.width; canvas.height = a.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(a, 0, 0); const oldPixels = ctx.getImageData(0, 0, a.width, a.height).data;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(b, 0, 0); const newPixels = ctx.getImageData(0, 0, b.width, b.height).data;
      const diff = ctx.createImageData(a.width, a.height);
      let changedPixels = 0, visibleChangedPixels = 0, totalAbsoluteError = 0, maxChannelDelta = 0;
      for (let i = 0; i < oldPixels.length; i += 4) {
        const delta = Math.max(Math.abs(oldPixels[i] - newPixels[i]), Math.abs(oldPixels[i + 1] - newPixels[i + 1]), Math.abs(oldPixels[i + 2] - newPixels[i + 2]));
        if (delta) changedPixels++;
        if (delta > tolerance) visibleChangedPixels++;
        maxChannelDelta = Math.max(maxChannelDelta, delta);
        totalAbsoluteError += Math.abs(oldPixels[i] - newPixels[i]) + Math.abs(oldPixels[i + 1] - newPixels[i + 1]) + Math.abs(oldPixels[i + 2] - newPixels[i + 2]);
        const at = i;
        if (delta > tolerance) { diff.data[at] = 255; diff.data[at + 1] = 12; diff.data[at + 2] = 12; diff.data[at + 3] = 255; }
        else { const gray = Math.round((newPixels[i] + newPixels[i + 1] + newPixels[i + 2]) / 12); diff.data[at] = gray; diff.data[at + 1] = gray; diff.data[at + 2] = gray; diff.data[at + 3] = 255; }
      }
      ctx.putImageData(diff, 0, 0);
      return {
        width: a.width, height: a.height, pixelCount: a.width * a.height,
        changedPixels, visibleChangedPixels, visibleChangedRatio: visibleChangedPixels / (a.width * a.height),
        maxChannelDelta, meanAbsoluteChannelError: totalAbsoluteError / (a.width * a.height * 3),
        differencePng: canvas.toDataURL('image/png').split(',')[1],
      };
    }, {
      baselinePng: baseline.png.toString('base64'), migratedPng: migrated.png.toString('base64'), tolerance: visiblePixelTolerance,
    });
  } finally {
    await page.close();
  }
}

async function main() {
  assert(fs.existsSync(baselinePath), `Pre-migration build not found: ${baselinePath}`);
  assert(fs.existsSync(migratedPath), `Startup-loader build not found: ${migratedPath}`);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const pages = new Map([['/baseline.html', baselineHtml], ['/migrated.html', migratedHtml]]);
  const server = http.createServer((request, response) => {
    const html = pages.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (html) { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(html); }
    else { response.writeHead(404); response.end('not found'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  let baseline, migrated;
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    baseline = await createBrowserPage(browser, `${origin}/baseline.html`, 'pre-migration baseline');
    migrated = await createBrowserPage(browser, `${origin}/migrated.html`, 'startup-loader build');
    assert.equal(migrated.info.mapHash, baseline.info.mapHash, 'Both builds should produce the same deterministic battle map');
    assert.equal(migrated.info.units, baseline.info.units, 'Both builds should render the same battlefield unit count');
    assert.deepEqual(migrated.info.canvas, baseline.info.canvas, 'Both builds should use the same WebGL canvas dimensions');
    const diff = await compareImages(browser, baseline, migrated);
    // Delta remains diagnostic: the live paused bridge can reanchor it to zero
    // without changing the already displayed pose. Compare the visible contract.
    const displayedPoses = info => Object.fromEntries(Object.entries(info.renderUnits).map(([id, {delta, ...pose}]) => [id, pose]));
    const displayedPoseMatches = isDeepStrictEqual(displayedPoses(migrated.info), displayedPoses(baseline.info));
    const report = {
      displayedPoseMatches,
      status: displayedPoseMatches && diff.visibleChangedRatio <= maximumVisibleDiffRatio ? 'passed' : 'failed',
      comparison: 'pre-migration PR #76 standalone build vs SDK startup-loader standalone build',
      renderer: 'real LOCAL 2P battlefield WebGL canvas',
      condition: { fixedSeed: sceneSeed, pausedAtTick: pauseTick, cosmeticAnimationTimeMs: 500, presentationHistoryTicks: [1, 2, 3, 4, 5], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
      tolerance: { perPixelChannelDelta: visiblePixelTolerance, maximumVisibleChangedRatio: maximumVisibleDiffRatio },
      baseline: { ...baseline.info, pngSha256: sha256(baseline.png) },
      migrated: { ...migrated.info, pngSha256: sha256(migrated.png) },
      imageDiff: { ...diff, differencePng: undefined },
    };
    fs.writeFileSync(path.join(outputDirectory, 'pre-migration-webgl.png'), baseline.png);
    fs.writeFileSync(path.join(outputDirectory, 'startup-loader-webgl.png'), migrated.png);
    fs.writeFileSync(path.join(outputDirectory, 'visual-diff.png'), Buffer.from(diff.differencePng, 'base64'));
    fs.writeFileSync(path.join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    assert.deepEqual(displayedPoses(migrated.info), displayedPoses(baseline.info),
      'Both builds should compare identical final displayed positions and facing');
    assert(diff.visibleChangedRatio <= maximumVisibleDiffRatio,
      `WebGL image comparison exceeded tolerance: ${(diff.visibleChangedRatio * 100).toFixed(4)}% visible pixel differences`);
  } finally {
    await baseline?.page.close().catch(() => {});
    await baseline?.context.close().catch(() => {});
    await migrated?.page.close().catch(() => {});
    await migrated?.context.close().catch(() => {});
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

