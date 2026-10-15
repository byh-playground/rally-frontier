const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const htmlPath = path.resolve(process.argv[2] || path.join(__dirname, '..', '_site', 'index.html'));
const source = fs.readFileSync(htmlPath, 'utf8');
const end = source.lastIndexOf('})();');
assert.ok(end >= 0, 'Application IIFE exists');
const html = source.slice(0, end) + `
  window.__startupRegression={
    MatchLifecycle,MapGeneration,GameSession,TerrainNavigation,ActiveViewState,BUILD_META,
    longTasks:[],frameGaps:[],events:[],frameAt:0,
  };
  {const q=window.__startupRegression,wrap=(owner,key,name)=>{const original=owner?.[key];if(typeof original!=='function')return;owner[key]=function(...args){const at=performance.now();try{return original.apply(this,args)}finally{q.events.push({name,at,ms:performance.now()-at})}}};
    wrap(MapGeneration,'generateMapDescriptor','map.generate');wrap(DraftPresentation,'renderDraftMapPreview','map.preview');
    wrap(GameSession.prototype,'startSim','sim.start');wrap(TerrainNavigation.prototype,'layer','nav.layer');
    wrap(TerrainNavigation.prototype,'prepareLayersInSlices','nav.prepare-start');wrap(GLRenderer.prototype,'loop','render.loop');}
  try{new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__startupRegression.longTasks.push({start:entry.startTime,duration:entry.duration})}).observe({type:'longtask',buffered:true})}catch{}
  requestAnimationFrame(function sampleFrame(now){const q=window.__startupRegression;if(q.frameAt)q.frameGaps.push({from:q.frameAt,at:now,duration:now-q.frameAt});q.frameAt=now;requestAnimationFrame(sampleFrame)});
` + source.slice(end);

const browserArgs = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const deckTypes = ['swordsman', 'archer', 'kickhopper', 'tank', 'medic', 'clawhunter', 'siege', 'aegisbeetle'];

async function playMatch(browser, { name, viewport, deviceScaleFactor = 1 }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor, isMobile: deviceScaleFactor > 1, hasTouch: deviceScaleFactor > 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('dialog', dialog => dialog.accept());
  await page.route('http://startup-regression.local/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto('http://startup-regression.local/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__startupRegression);
  await page.locator('#gameStartBtn').click();
  await page.locator('#selectionDeckBtn').click();
  await page.locator('#singleBtn').click();
  await page.locator('#singleHostBtn').click();
  await page.locator('#deckConfirmBtn').waitFor({ state: 'visible' });
  await page.locator('#deckEditBtn').click();
  await page.locator('#deckBuilderClearBtn').click();
  for (const id of deckTypes) await page.locator(`[data-deck-card-type="unit"][data-deck-card-id="${id}"]`).evaluate(element => element.click());
  for (const id of ['thornTowerCard', 'sporeTowerCard']) {
    const card = page.locator(`[data-deck-card-type="defense"][data-deck-card-id="${id}"]`);
    if (await card.count()) await card.evaluate(element => element.click());
  }
  while (await page.locator('.deck-builder-slot.filled').count() < 10) {
    await page.locator('[data-deck-card-type="defense"]:not(.selected)').first().evaluate(element => element.click());
  }
  await page.locator('#deckBuilderSaveBtn').click();
  await page.waitForFunction(() => !document.querySelector('#deckConfirmBtn').disabled);
  const t0 = await page.evaluate(() => performance.now());
  await page.locator('#deckConfirmBtn').click();
  await page.locator('#gameScreen').waitFor({ state: 'visible', timeout: 45000 });
  const gameAt = await page.evaluate(() => performance.now());
  await page.waitForFunction(() => {
    const match = window.__startupRegression.MatchLifecycle.singleMatch;
    const sessions = Object.values(match?.sessions || {});
    return sessions.length === 2 && sessions.every(session => session.sim?.tick >= 10 &&
      session.transport?.pc?.connectionState === 'connected' && session.transport?.dc?.readyState === 'open');
  }, null, { timeout: 45000 });
  await page.waitForTimeout(500);
  const result = await page.evaluate(({ t0, gameAt, pageErrors }) => {
    const q = window.__startupRegression, match = q.MatchLifecycle.singleMatch;
    const sessions = Object.values(match?.sessions || {});
    const renderer = q.ActiveViewState?.renderer;
    const startedLongTasks = q.longTasks.filter(task => task.start >= t0);
    const gaps = q.frameGaps.filter(gap => gap.at >= t0);
    const descriptors = sessions.map(session => session.sim.mapDescriptor);
    const expectedMapSeed = q.MapGeneration.mapRuleSeed(sessions[0].sim.seed, sessions[0].sim.rules, sessions[0].sim.rules?.roundNumber || 1);
    return {
      buildId: q.BUILD_META?.id,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      tickRates: sessions.map(session => session.sim.tps),
      ticks: sessions.map(session => session.sim.tick),
      rtc: sessions.map(session => ({ role: session.role, connection: session.transport.pc?.connectionState,
        dataChannel: session.transport.dc?.readyState, state: session.transport.connState })),
      simulationCpu: sessions.map(session => ({ role: session.role, lastStepMs: session.sim.perfStats?.lastStepMs,
        ewmaStepMs: session.sim.perfStats?.ewmaStepMs, maxStepMs: session.sim.perfStats?.maxStepMs,
        lastSnapshotMs: session.sim.perfStats?.snapshotMs, maxSnapshotMs: session.sim.perfStats?.maxSnapshotMs })),
      sameMapSeed: descriptors.length === 2 && descriptors[0].seed === descriptors[1].seed && descriptors[0].seed === expectedMapSeed,
      sameMapDescriptor: descriptors.length === 2 && descriptors[0] === descriptors[1],
      mapCacheSeed: q.MapGeneration.descriptorCache?.descriptor?.seed,
      navigation: sessions.map(session => ({ role: session.role, layersBuilt: session.sim.navigation.metrics.layersBuilt,
        preparedLayers: session.sim.navigation.metrics.preparationLayersBuilt || 0,
        preparationCpuMs: +(session.sim.navigation.metrics.preparationWorkMs || 0).toFixed(1) })),
      renderer: renderer ? { backend: renderer.backend, frameWorkMs: renderer.perfStats?.frameWorkMs,
        maxFrameWorkMs: renderer.perfStats?.maxFrameWorkMs, passSnapshot: renderer.passProfiler?.snapshot?.() || null,
        gpuTimerExtension: !!renderer.gl?.getExtension?.('EXT_disjoint_timer_query_webgl2') } : null,
      preGameLongTasks: startedLongTasks.filter(task => task.start < gameAt),
      inGameLongTasks: startedLongTasks.filter(task => task.start >= gameAt),
      startupEvents: q.events.filter(event => event.at >= t0 && event.at < gameAt + 600).filter(event => event.name !== 'render.loop'),
      maxInGameFrameGapMs: +Math.max(0, ...gaps.filter(gap => gap.from >= gameAt).map(gap => gap.duration)).toFixed(1),
      maxStartupFrameGapMs: +Math.max(0, ...gaps.map(gap => gap.duration)).toFixed(1),
      pageErrors,
    };
  }, { t0, gameAt, pageErrors: errors });
  assert.deepEqual(result.pageErrors, [], `${name}: browser errors`);
  assert.ok(result.rtc.every(peer => peer.connection === 'connected' && peer.dataChannel === 'open'), `${name}: both real RTC peers are open`);
  if (process.env.QA_BASELINE !== '1') assert.ok(result.sameMapSeed && result.sameMapDescriptor, `${name}: single-player peers use the exact shared deterministic map`);
  assert.ok(result.tickRates.every(tps => tps === 10 && tps <= 30), `${name}: default tick rate remains 10 TPS and <= 30`);
  await page.screenshot({ path: path.resolve(__dirname, '..', '.qa', 'startup-stutter', `${name}.png`), fullPage: false });
  await page.close();
  return result;
}

(async () => {
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: true, args: browserArgs });
  try {
    const results = [];
    results.push(await playMatch(browser, { name: 'after-desktop', viewport: { width: 1440, height: 900 } }));
    results.push(await playMatch(browser, { name: 'after-mobile-landscape', viewport: { width: 915, height: 412 }, deviceScaleFactor: 2 }));
    results.push(await playMatch(browser, { name: 'after-restart-desktop', viewport: { width: 1440, height: 900 } }));
    console.log(JSON.stringify({ cases: results }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
