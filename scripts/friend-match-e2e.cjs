const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { serveSource, routePinnedSDK } = require('./netcode-qa-module.cjs');
const { readGamekit } = require('./setup-gamekit.cjs');

// Two isolated players use native friend controls, real public Nostr relays and
// real WebRTC. Only the pinned SDK's verified bytes are served from cache.
// The room-code fixture reuses one real occupied code to exercise native retry;
// discovery, relay responses, SDP/ICE and packets are never substituted.
const root = path.resolve(__dirname, '..');
const sdkVersion = readGamekit(root).modules.rollback.toString('utf8').match(/\b(?:var|const)\s+VERSION\s*=\s*["']([^"']+)["']/)?.[1];
assert(sdkVersion, 'pinned SDK declares its version');
const mode = process.env.QA_NETCODE_MODE || 'lockstep';
assert(['lockstep', 'rollback'].includes(mode));
const output = path.join(root, '.qa', 'friend-match-' + mode);
const observer = `window.__friend={ActiveViewState,MatchLifecycle,ReplayPresentation,UiRuntimeState,PerformanceTelemetry,PRODUCT_VERSION,
  generatedCodes:[],originalCode:RoomCodeUtil.randomCode,
  inspect(){const s=ActiveViewState.session;return {role:s?.role,room:s?.roomCode,screen:UiRuntimeState.value.screen,
    single:!!MatchLifecycle.singleMatch,mode:s?.netcodeMode,tick:s?.sim?.tick,ready:s?.netcodeSession?.ready,
    state:ActiveViewState.transport?.room?.state,gameVersion:PRODUCT_VERSION,sdkVersion:RallyNetcode.VERSION,
    hashMismatches:s?.netcodeSession?.metrics?.hashMismatches,fatal:s?.simulationFatal,
    metrics:s?.netcodeSession?.metrics,simPerf:s?.sim?.perfStats,rendererPerf:ActiveViewState.renderer?.perfStats,connectionPerf:s?.performanceStats,
    commands:s?.replayRecorder?.commands,result:s?.replayRecorder?.result,
    armies:[0,1].map(side=>s?.sim?.units.filter(u=>u.alive&&u.side===side).length)}}};
RoomCodeUtil.randomCode=()=>window.__friend.generatedCodes.shift()||window.__friend.originalCode();`;

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const server = await serveSource(path.resolve(process.argv[2] || path.join(root, 'index.html')), { observer });
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'chromium' });
  const pages = [], errors = [], relays = [], rows = [];
  try {
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext({ viewport: { width: 412, height: 915 }, ignoreHTTPSErrors: true });
      const page = await context.newPage(); pages.push(page);
      page.on('dialog', dialog => dialog.accept());
      page.on('pageerror', error => errors.push({ player: i, message: error.message }));
      page.on('websocket', socket => relays.push({ player: i, url: socket.url() }));
      await routePinnedSDK(page);
      await page.goto(server.url + '?tps=20&netcode=' + (i ? mode === 'lockstep' ? 'rollback' : 'lockstep' : mode));
      await page.waitForFunction(() => window.__friend && window.RallyVectorAssets?.cannon, null, { timeout: 45000 });
    }
    const [host, guest] = pages;
    const create = async page => { await page.locator('#friendMatchBtn').click(); await page.locator('#friendCreateBtn').click(); };
    const code = async page => { await page.locator('#hostCodeArea').waitFor({ state: 'visible', timeout: 30000 }); return (await page.locator('#hostCode').textContent()).trim(); };
    const join = async (page, value) => { await page.locator('#friendMatchBtn').click(); await page.locator('#friendCodeInput').fill(value); await page.locator('#friendJoinBtn').click(); };
    if (process.env.QA_CHECK_SETUP !== '0') {
      // Cancel while SDK discovery is still pending, including native Escape.
      await create(host);
      await host.evaluate(() => { window.__friend.cancelledTransport = window.__friend.ActiveViewState.transport; });
      await host.keyboard.press('Escape');
      assert(await host.evaluate(() => !window.__friend.ActiveViewState.session && window.__friend.cancelledTransport.intentionalClose && window.__friend.cancelledTransport.openController.signal.aborted));
      // Cancel a ready public room. A guest must never revive the cancelled host.
      await create(host); const cancelledCode = await code(host);
      await host.evaluate(() => { window.__friend.cancelledRoom = window.__friend.ActiveViewState.transport.room; });
      await host.locator('#createCloseBtn').click();
      assert.equal(await host.evaluate(() => window.__friend.cancelledRoom.state), 'closed');
      await join(guest, cancelledCode);
      await guest.waitForFunction(() => document.querySelector('#joinError').textContent.length > 0, null, { timeout: 30000 });
      assert.equal(await host.evaluate(() => window.__friend.UiRuntimeState.value.screen), 'lobby');
      assert.equal(await host.evaluate(() => window.__friend.ActiveViewState.session), null);
      assert.equal(await guest.evaluate(() => !!window.__friend.ActiveViewState.session?.sim), false);
      await guest.locator('#joinCloseBtn').click();
      rows.push({ scenario: 'pending and ready room cancellation cannot start a hidden match', cancelledCode });
    }
    await create(host); const roomCode = await code(host);
    if (process.env.QA_CHECK_SETUP !== '0') {
      // Actual Nostr room claim collision, then a native retry must create a new room.
      await guest.evaluate(value => window.__friend.generatedCodes.push(value), roomCode);
      await create(guest);
      await guest.locator('#createRetryBtn').waitFor({ state: 'visible', timeout: 30000 });
      assert.match(await guest.locator('#createStatus').textContent(), /사용 중/);
      await guest.locator('#createRetryBtn').click(); const retryCode = await code(guest);
      assert.notEqual(retryCode, roomCode);
      await guest.locator('#createCloseBtn').click();
      rows.push({ scenario: 'occupied public code fails and native retry opens a fresh room', occupiedCode: roomCode, retryCode });
    }
    await join(guest, roomCode);
    assert.equal(await guest.locator('#joinConfirmBtn').isDisabled(), true, 'join stays busy during discovery');
    await guest.evaluate(() => { window.__friend.joinSession = window.__friend.ActiveViewState.session; });
    const button = await guest.locator('#joinConfirmBtn').boundingBox();
    if (button) await guest.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
    assert(await guest.evaluate(() => window.__friend.ActiveViewState.session === window.__friend.joinSession), 'duplicate native click cannot replace an in-flight join');
    for (const page of pages) {
      await page.waitForFunction(() => { const q = window.__friend, s = q.ActiveViewState.session; return q.UiRuntimeState.value.screen === 'game' && s?.netcodeSession?.ready && s.sim.tick > 5; }, null, { timeout: 30000 });
      const state = await page.evaluate(() => window.__friend.inspect());
      assert.equal(state.mode, mode, 'guest follows the host mode despite a different local setting');
      assert.equal(state.single, false); assert.equal(state.state, 'open'); assert.equal(state.sdkVersion, sdkVersion);
      assert.equal(state.fatal, false);
      const ice = await page.evaluate(async () => { const {ActiveViewState,PerformanceTelemetry}=window.__friend; const s=ActiveViewState.session; await PerformanceTelemetry.sampleConnection(s); return { fetched:s.performanceStats.iceFetchedAt, error:s.performanceStats.iceError }; });
      assert.ok(Number.isFinite(ice.fetched) && !ice.error, 'ICE statistics are sampled from the active peer connection');
    }
    assert(relays.some(r => r.player === 0 && r.url.startsWith('wss://')) && relays.some(r => r.player === 1 && r.url.startsWith('wss://')));
    assert(await host.evaluate(()=>window.__friend.ActiveViewState.session.command({type:'LAUNCH',cannonId:'missing-cannon',x:0,y:0,holdMs:400,unitType:'rice'})), 'Invalidated cannon command reaches the authoritative simulation');
    await host.locator('#launchFeedback').waitFor({state:'visible',timeout:10000});
    assert.match(await host.locator('#launchFeedback').textContent(),/대포/,'An authoritative rejection is visible to the host');
    await host.screenshot({path:path.join(output,'launch-rejected.png')});
    for (const page of pages) {
      await page.locator('[data-launch-card="rice"]').click();
      const point = await page.evaluate(() => { const rect = document.querySelector('#glCanvas').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height * .4 }; });
      await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.waitForTimeout(650);
      await page.mouse.move(point.x + 8, point.y - 24); await page.mouse.up();
    }
    for (const page of pages) await page.waitForFunction(() => {
      const q = window.__friend.inspect();
      return ['host','guest'].every(role => q.commands.some(c => c.actor === role && c.action.type === 'LAUNCH')) && q.armies.every(n => n > 0);
    }, null, { timeout: 20000 });
    const playing = await Promise.all(pages.map(page => page.evaluate(() => window.__friend.inspect())));
    assert(playing.every(s => s.hashMismatches === 0 && !s.fatal));
    rows.push({ scenario: 'two real players launch through both native controls and share commands', roomCode, mode, playing });
    for (let i = 0; i < pages.length; i++) await pages[i].screenshot({ path: path.join(output, 'player-' + i + '.png') });
    await host.locator('#matchMenuBtnGame').click(); await host.locator('#matchMenuSurrenderBtn').click();
    for (const page of pages) await page.waitForFunction(() => window.__friend.ActiveViewState.session?.simEnded && window.__friend.ActiveViewState.session?.replayRecorder?.result, null, { timeout: 20000 });
    const ended = await Promise.all(pages.map(page => page.evaluate(() => window.__friend.inspect())));
    assert.deepEqual(ended[0].result, ended[1].result); assert.equal(ended[0].result.winner, 'guest'); assert.equal(ended[0].result.reason, 'surrender');
    for (const [i, page] of pages.entries()) {
      await page.locator('#replayWatchBtn').click(); await page.locator('#replayDock').waitFor({ state: 'visible' });
      await page.locator('#replayPlayPauseBtn').click();
      await page.locator('#replayTimeInput').fill(String(ended[i].result.endTick / 20)); await page.locator('#replayTimeGoBtn').click();
      const replay = await page.evaluate(() => { const p = window.__friend.ReplayPresentation.replayPlayer; return { tick: p.sim.tick, checksum: p.sim.checksum() }; });
      assert.equal(replay.tick, ended[i].result.endTick); assert.equal(replay.checksum, ended[i].result.checksum);
    }
    assert.deepEqual(errors, []);
    const result = { pass: true, environment: 'Chromium software WebGL; isolated contexts on one machine; real public Nostr and WebRTC; verified SDK cache', roomCode, mode, relays, rows, ended: ended.map(s => s.result), errors };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    for (const [i, page] of pages.entries()) { try { await page.screenshot({ path: path.join(output, 'failure-' + i + '.png') }); } catch (_) {} }
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, rows, relays, errors }, null, 2)); throw error;
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
