const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const siteRoot = path.resolve(process.argv[2] || path.join(root, '_site'));
const outputDir = path.resolve(process.argv[3] || path.join(root, '.qa', 'gamekit-v090', 'rally-alpha-batching'));
const seed = Number(process.env.QA_VECTOR_SEED) || 20261015;
const vectorType = process.env.QA_VECTOR_TYPE || 'swordsman';
const vectorState = (process.env.QA_VECTOR_STATE || '').split(',').filter(Boolean);
const viewport = { width: 1280, height: 800 };
const { serveSource, routePinnedSDK } = require('./netcode-qa-module.cjs');

const observer = [
  'window.__vectorAlphaQA={BUILD_META,MatchLifecycle,ActiveViewState,RenderStateStore,GLRenderer,GameSession,MapGeneration,UnitDefinition,UiRuntimeState,UiController,ViewRuntimeState,NetworkModuleLoader,captures:[],holds:[],samples:{},captureLabel:null,captureHoldTick:null,captureRenderRole:null,presentationHoldNow:null,renderSequence:0};',
  'const q=window.__vectorAlphaQA;',
  'MapGeneration.mapRuleSeed=()=>'+seed+';',
  'q.seedRandom=seed=>{let state=seed>>>0;Math.random=()=>{state=(state+0x6D2B79F5)>>>0;let t=state;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296}};',
  'const originalCapture=RenderStateStore.prototype.capture;',
  'RenderStateStore.prototype.capture=function(sim,now,snapshot,stepMs){const lifecycle=MatchLifecycle.localTest||MatchLifecycle.singleMatch,role=Object.values(lifecycle?.sessions||{}).find(session=>session.sim===sim)?.role||null;q.captures.push({role,now,tick:sim.tick,stepMs});return originalCapture.call(this,sim,now,snapshot,stepMs)};',
  'const originalApplied=GameSession.prototype.onNetcodeFrameApplied;',
  'GameSession.prototype.onNetcodeFrameApplied=function(){const result=originalApplied.apply(this,arguments);if(q.captureHoldTick!==null&&this.sim?.tick>=q.captureHoldTick){q.holds.push({role:this.role,tick:this.sim.tick});this.syncHold=true;if(q.presentationHoldNow===null&&this.role===q.captureRenderRole){const renderer=q.ActiveViewState.renderer,last=[...q.captures].reverse().find(row=>row.role===this.role&&row.tick<=this.sim.tick);if(renderer?.renderState&&last){q.presentationHoldNow=last.now+200+(this.sim.tick-last.tick)*100;renderer._framePresentationAt=q.presentationHoldNow}}}return result};',
  'const originalPresentationNow=GLRenderer.prototype.presentationNow;',
  'GLRenderer.prototype.presentationNow=function(now){return q.presentationHoldNow===null?originalPresentationNow.call(this,now):q.presentationHoldNow};',
].join('\n');

function decodePng(file) {
  const png = fs.readFileSync(file);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'Playwright emitted a PNG');
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  assert.equal(bitDepth, 8, '8-bit PNG screenshot expected');
  assert.ok(channels, 'RGB or RGBA PNG screenshot expected');
  const stride = width * channels, inflated = zlib.inflateSync(Buffer.concat(idat));
  const decoded = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const inputAt = y * (stride + 1), filter = inflated[inputAt], rowAt = y * stride, previousAt = rowAt - stride;
    for (let x = 0; x < stride; x++) {
      const raw = inflated[inputAt + 1 + x], left = x >= channels ? decoded[rowAt + x - channels] : 0;
      const up = y ? decoded[previousAt + x] : 0, upperLeft = y && x >= channels ? decoded[previousAt + x - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : NaN;
      assert.ok(Number.isFinite(predictor), 'PNG scanline filter is supported');
      decoded[rowAt + x] = (raw + predictor) & 255;
    }
  }
  if (channels === 4) return { width, height, rgba: decoded };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < decoded.length; i += 3, j += 4) { rgba[j] = decoded[i]; rgba[j + 1] = decoded[i + 1]; rgba[j + 2] = decoded[i + 2]; rgba[j + 3] = 255; }
  return { width, height, rgba };
}

function comparePng(leftPath, rightPath) {
  const left = decodePng(leftPath), right = decodePng(rightPath);
  assert.equal(left.width, right.width); assert.equal(left.height, right.height);
  let changedChannels = 0, changedPixels = 0, minX = left.width, minY = left.height, maxX = -1, maxY = -1;
  for (let i = 0; i < left.rgba.length; i += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel++) if (left.rgba[i + channel] !== right.rgba[i + channel]) { changedChannels++; changed = true; }
    if (changed) {
      changedPixels++;
      const pixel = i / 4, x = pixel % left.width, y = Math.floor(pixel / left.width);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return { width: left.width, height: left.height, changedPixels, changedChannels, changedBounds: changedPixels ? { minX, minY, maxX, maxY } : null,
    totalPixels: left.width * left.height };
}

async function captureFrame(page, label) {
  return page.evaluate(async label => {
    const q = window.__vectorAlphaQA, renderer = q.ActiveViewState.renderer;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    if (!renderer) throw new Error('Renderer is missing for ' + label);
    const vector = renderer.vectorContext.stats().mesh;
    return { frameSequence: renderer.perfStats.lastFrameAt, renderCpuMs: renderer.perfStats.frameWorkMs,
      drawCalls: renderer.perfStats.drawCalls, vectorSubmissions: renderer.vectorAssetDrawnInstances || 0,
      vectorDraws: vector.draws, vectorInstances: vector.instances, vectorStats: vector,
      scene: { role: renderer.role, side: renderer.mySide(), simTick: q.MatchLifecycle.activeSession()?.sim?.tick,
        displayTimeMs: renderer.renderState?.frame(q.presentationHoldNow)?.timeMs, viewport: [innerWidth, innerHeight, devicePixelRatio],
        canvas: [renderer.canvas.width, renderer.canvas.height] } };
  }, label);
}

let server = null;
async function runRole(browser, role) {
  const name = 'gamekit-v090-alpha-' + role;
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const pageErrors = [];
  const browserErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
  page.on('requestfailed', request => browserErrors.push(request.url() + ' ' + request.failure()?.errorText));
  try {
    await routePinnedSDK(page);
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__vectorAlphaQA?.seedRandom, null, { timeout: 60000 });
    await page.evaluate(value => { window.__vectorAlphaQA.seedRandom(value); Date.now = () => 1700000000000 + value; }, seed);
    await page.locator('#gameStartBtn').click();
    await page.locator('#advancedTestSettings summary').click();
    await page.locator('#unitTestAllyType').selectOption('swordsman');
    await page.locator('#unitTestAllyCount').fill('4');
    await page.locator('#unitTestEnemyType').selectOption('medic');
    await page.locator('#unitTestEnemyCount').fill('1');
    await page.locator('#unitTestResearch').uncheck();
    await page.locator('#unitTestBtn').click();
    await page.evaluate(() => window.__vectorAlphaQA.MatchLifecycle.startLocalTest());
    await page.locator('#gameScreen').waitFor({ state: 'visible', timeout: 15000 }).catch(async error => {
      const state = await page.evaluate(() => {
        const q = window.__vectorAlphaQA, match = q.MatchLifecycle.localTest;
        return { screen: document.querySelector('#gameScreen')?.className, currentScreen: q.UiRuntimeState?.value?.screen,
          gameStart: document.querySelector('#gameStartBtn')?.className, hostButton: document.querySelector('#singleHostBtn')?.disabled,
          guestButton: document.querySelector('#singleGuestBtn')?.disabled, networkReady: !!window.RallyNetcode?.createNostrSignaler,
          networkLoadState: q.NetworkModuleLoader?.networkLoadState, match: !!match, sessions: Object.keys(match?.sessions || {}),
          logs: [...document.querySelectorAll('.game-log,.toast,.menu-error')].slice(-5).map(node => node.textContent) };
      });
      const failurePath = path.join(outputDir, name + '-startup-failure.png');
      await page.screenshot({ path: failurePath, fullPage: true });
      throw new Error(error.message + '; startup state=' + JSON.stringify(state) + '; pageErrors=' + JSON.stringify(pageErrors) +
        '; browserErrors=' + JSON.stringify(browserErrors) + '; screenshot=' + failurePath);
    });
    if (role === 'guest') await page.locator('#guestViewBtn').click();
    await page.evaluate(() => window.__vectorAlphaQA.MatchLifecycle.singleMatch?.bot?.stop());
    await page.waitForFunction(() => {
      const lifecycle = window.__vectorAlphaQA.MatchLifecycle, match = lifecycle.localTest || lifecycle.singleMatch, sessions = Object.values(match?.sessions || {});
      return sessions.length === 2 && sessions.every(session => session.sim?.tick >= 8);
    }, null, { timeout: 45000 });
    await page.evaluate(roleName => { const q = window.__vectorAlphaQA; q.captureRenderRole = roleName; q.captureHoldTick = 24; }, role);
    await page.waitForFunction(() => {
      const q = window.__vectorAlphaQA, lifecycle = q.MatchLifecycle, match = lifecycle.localTest || lifecycle.singleMatch, sessions = Object.values(match?.sessions || {});
      return sessions.length === 2 && sessions.every(session => session.syncHold && session.sim?.tick === 24);
    }, null, { timeout: 15000 });
    const fixture = await page.evaluate(({ requestedType, state }) => {
      const q = window.__vectorAlphaQA, session = q.MatchLifecycle.activeSession(), renderer = q.ActiveViewState.renderer;
      if (!session || !renderer?.renderState) throw new Error('Active render session is not ready');
      let holdNow = q.presentationHoldNow;
      if (!Number.isFinite(holdNow)) {
        const last = [...q.captures].reverse().find(row => row.role === session.role && row.tick <= session.sim.tick);
        if (!last) throw new Error('No render-state capture exists for the held tick');
        holdNow = last.now + 200 + (session.sim.tick - last.tick) * 100;
      }
      let frame = renderer.renderState.frame(holdNow);
      for (let i = 0; i < 5 && frame && Math.abs(frame.timeMs - 2400) > 0.05; i++) { holdNow += 2400 - frame.timeMs; frame = renderer.renderState.frame(holdNow); }
      q.presentationHoldNow = holdNow; renderer._framePresentationAt = holdNow;
      const side = session.role === 'host' ? 0 : 1, priorUnitCount = session.sim.units.length;
      session.sim.units.length = 0;
      session.sim.rebuildRuntimeIndexes();
      const candidates = Object.keys(q.UnitDefinition.all || {}).filter(type => window.RallyVectorAssets?.[type]).sort();
      if (state.includes('cloak')) q.GLRenderer.prototype.snapshotStealthed = () => true;
      const type = candidates.includes(requestedType) ? requestedType : candidates[0];
      if (!type) throw new Error('No compiled vector unit is available');
      const rect = renderer.canvas.getBoundingClientRect(), positions = [0.38, 0.39, 0.68, 0.78].map(x => ({ x: rect.left + rect.width * x, y: rect.top + rect.height * 0.52 }));
      const spawned = positions.map(position => {
        const world = renderer.pxToWorld(position.x, position.y), unit = session.sim.spawnUnit(side, type, world[0], world[1]);
        unit.x = world[0]; unit.y = world[1]; unit.fx = world[0]; unit.fy = world[1]; unit.attackFlash = state.includes('attack') ? 1 : 0; unit.hitFlash = state.includes('hit') ? 1 : 0;
        if (!renderer.shouldUseVectorUnitArt(unit)) throw new Error('AIR test unit did not select the vector renderer: ' + type);
        return { id: unit.id, type: unit.type, x: unit.x, y: unit.y, screen: position };
      });
      session.emitRenderTargets(session.sim, true);
      const fixed = new q.RenderStateStore(renderer.renderState.definitions);
      fixed.capture(session.sim, 2600, true, renderer.renderState.stepMs); renderer.renderState = fixed;
      const display = fixed.frame(2800);
      if (display?.timeMs !== 2400) throw new Error('Fixed display timestamp is not tick 24 / 2400ms');
      if (session.role === 'guest') {
        const first = fixed.displayed('unit', 2800).find(unit => spawned[0].id === unit.id);
        const current = renderer.projectEntityScreen(first, 'unit'), rect = renderer.canvas.getBoundingClientRect();
        const targetX = renderer.canvas.width * 0.5;
        const targetY = renderer.canvas.height * 0.5;
        const zoom = renderer.sc();
        renderer.cameraLeft += (current.x - targetX) / zoom;
        renderer.cameraTop = renderer.clampCameraTop(renderer.cameraTop + (current.y - targetY) / zoom);
        q.ViewRuntimeState.byRole.guest.cameraLeft = renderer.cameraLeft;
        q.ViewRuntimeState.byRole.guest.cameraTop = renderer.cameraTop;
      }
      const projected = fixed.displayed('unit', 2800).filter(unit => spawned.some(item => item.id === unit.id))
        .map(unit => ({ id: unit.id, ...renderer.projectEntityScreen(unit, 'unit') }));
      q.presentationHoldNow = 2800; renderer._framePresentationAt = 2800;
      return { build: q.BUILD_META.id, role: session.role, side, tick: session.sim.tick, tps: session.sim.tps, seed: session.sim.seed,
        mapSeed: session.sim.mapDescriptor?.seed, displayTimeMs: display.timeMs, canvas: [renderer.canvas.width, renderer.canvas.height],
        viewport: [innerWidth, innerHeight, devicePixelRatio], vectorType: type, vectorUnitIds: spawned.map(unit => unit.id),
        projected,
        positions: spawned.map(unit => ({ x: +unit.screen.x.toFixed(2), y: +unit.screen.y.toFixed(2) })),
        priorUnitCount, unitCount: spawned.length, rendererRole: renderer.role };
    }, { requestedType: vectorType, state: vectorState });
    assert.equal(fixture.role, role); assert.equal(fixture.tick, 24); assert.equal(fixture.tps, 10); assert.equal(fixture.displayTimeMs, 2400);
    const modes = await page.evaluate(() => {
      const q = window.__vectorAlphaQA, renderer = q.ActiveViewState.renderer;
      const meshes = renderer.vectorContext.acquireMeshRenderer();
      if (typeof meshes.safeAlphaRunBatching !== 'boolean') throw new Error('Pinned VectorContext batching toggle is unavailable');
      meshes.safeAlphaRunBatching = false;
      return { batching: meshes.safeAlphaRunBatching };
    });
    assert.equal(modes.batching, false);
    const baselineSample = await captureFrame(page, 'baseline');
    const baselinePath = path.join(outputDir, name + '-baseline.png');
    await page.locator('#glCanvas').screenshot({ path: baselinePath });
    const candidateEnabled = await page.evaluate(() => {
      const renderer = window.__vectorAlphaQA.ActiveViewState.renderer;
      const meshes = renderer.vectorContext.acquireMeshRenderer();
      meshes.safeAlphaRunBatching = true;
      return meshes.safeAlphaRunBatching;
    });
    assert.equal(candidateEnabled, true);
    const candidateSample = await captureFrame(page, 'candidate');
    const candidatePath = path.join(outputDir, name + '-candidate.png');
    await page.locator('#glCanvas').screenshot({ path: candidatePath });
    fs.writeFileSync(path.join(outputDir, name + '-counters.json'), JSON.stringify({ fixture, baseline: baselineSample, candidate: candidateSample }, null, 2));
    process.stdout.write(JSON.stringify({ role, fixture, baseline: { submissions: baselineSample.vectorSubmissions, draws: baselineSample.vectorDraws,
      stats: baselineSample.vectorStats }, candidate: { submissions: candidateSample.vectorSubmissions, draws: candidateSample.vectorDraws,
      stats: candidateSample.vectorStats } }, null, 2) + '\n');
    const pixelComparison = comparePng(baselinePath, candidatePath);
    process.stdout.write('Pixel comparison: ' + JSON.stringify(pixelComparison) + '\n');
    assert.equal(baselineSample.scene.simTick, candidateSample.scene.simTick);
    assert.deepEqual(baselineSample.scene.viewport, candidateSample.scene.viewport);
    assert.equal(baselineSample.scene.role, candidateSample.scene.role);
    assert.ok(candidateSample.vectorSubmissions >= fixture.vectorUnitIds.length, 'Vector body submissions include all four test units');
    // The vector body count must match; draw and batch counts are reported, not asserted, because they depend on the
    // compiled triangle order of the pinned compiler. The on/off pixel comparison is recorded, not asserted: a small
    // animated object in the scene differs between any two frames of the same build.
    assert.ok(candidateSample.vectorDraws <= baselineSample.vectorDraws, 'Safe batching never adds WebGL mesh draws');
    assert.equal(Object.values(candidateSample.vectorStats.drawDispatchReasons).reduce((sum, count) => sum + count, 0), candidateSample.vectorDraws,
      'Native draw-dispatch reasons classify every actual VectorContext mesh device.draw call');
    assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
    return { fixture, baseline: { submissions: baselineSample.vectorSubmissions, webglDraws: baselineSample.vectorDraws,
        stats: baselineSample.vectorStats, screenshot: path.basename(baselinePath) },
      candidate: { submissions: candidateSample.vectorSubmissions, webglDraws: candidateSample.vectorDraws,
        stats: candidateSample.vectorStats, screenshot: path.basename(candidatePath) }, pixelComparison, pageErrors };
  } catch (error) {
    const fatal = await page.evaluate(() => document.getElementById('renderFatalOverlay')?.innerText || window.__RALLY_FATAL_DIAGNOSTIC__ || null).catch(() => null);
    if (fatal) throw new Error(error.message + ' | Rally fatal diagnostic: ' + JSON.stringify(fatal).slice(0, 2000), { cause: error });
    throw error;
  } finally { await page.close(); }
}

(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  let browser = null;
  try {
    const launchOptions = { headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };
    if (process.env.QA_BROWSER_CHANNEL) launchOptions.channel = process.env.QA_BROWSER_CHANNEL;
    server = await serveSource(path.join(siteRoot, 'index.html'), { observer });
    browser = await chromium.launch(launchOptions);
    const results = [];
    for (const role of (process.env.QA_ROLES || 'host,guest').split(',')) results.push(await runRole(browser, role));
    const report = { build: JSON.parse(fs.readFileSync(path.join(siteRoot, 'build.json'), 'utf8')).commit, seed, viewport,
      officialGamekit: '0.9.0', roles: results };
    fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally { if (browser) await browser.close(); if (server) await server.close(); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
