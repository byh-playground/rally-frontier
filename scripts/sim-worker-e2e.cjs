const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { serveSource, routePinnedSDK } = require('./netcode-qa-module.cjs');

// Single-player AI hosted in src/sim-worker.js: the human session runs in the page,
// the AI session in a Worker; the AI's real WebRTC transport stays in the page and
// WorkerSessionProxy relays it. Checks connection, the
// lockstep cores' own state-hash comparison, manual recovery while connected and
// after the link is invalidated, balance telemetry from the Worker, and port traffic.
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.qa', 'sim-worker');
const observer = `window.__simWorkerE2E={MatchLifecycle,MobileBattleTestMode,RecoveryTelemetry,AppLifecycle,PerformanceTelemetry,
  state(){
    const m=MatchLifecycle.singleMatch;
    return Object.fromEntries(Object.entries(m?.sessions||{}).map(([role,s])=>[role,{kind:s.constructor.name,tick:s.sim?.tick??null,
      connected:!!s.transportConnected,phase:s.recoveryPhase,ready:!!s.netcodeSession?.ready,
      hashMismatches:s.netcodeSession?.metrics?.hashMismatches??null,stateHashes:s.netcodeSession?.metrics?.stateHashComputations??null,
      traffic:s.traffic?{...s.traffic}:null}]));
  }};`;

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const server = await serveSource(path.join(root, 'index.html'), { observer });
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: process.env.QA_HEADED !== '1' });
  const steps = [];
  try {
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, acceptDownloads: true });
    const page = await context.newPage(), pageErrors = [], workerErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    page.on('worker', worker => worker.on('console', message => { if (message.type() === 'error') workerErrors.push(message.text()); }));
    await routePinnedSDK(page);
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.locator('#gameStartBtn').click();
    await page.locator('#advancedTestSettings summary').click();
    await page.selectOption('#battleTestUnitCount', '100');
    await page.selectOption('#battleTestComposition', 'mixed');
    await page.selectOption('#battleTestSampleSeconds', '30');
    await page.locator('#battleTestStartBtn').click();
    await page.waitForFunction(() => window.__simWorkerE2E.MobileBattleTestMode.phase === 'warmup', null, { timeout: 60_000 });

    const state = () => page.evaluate(() => window.__simWorkerE2E.state());
    const advances = async (label, ms = 3000) => {
      const before = await state();
      await page.waitForTimeout(ms);
      const after = await state();
      steps.push({ label, before, after });
      for (const role of ['host', 'guest']) {
        assert.ok(after[role].tick > before[role].tick, `${label}: ${role} tick advances`);
        assert.ok(after[role].connected && after[role].phase === 'idle', `${label}: ${role} connected and idle`);
      }
      return after;
    };

    const initial = await advances('start');
    assert.equal(initial.host.kind, 'GameSession');
    assert.equal(initial.guest.kind, 'WorkerSessionProxy', 'The AI session runs in a Worker');

    assert.ok(await page.evaluate(() => window.__simWorkerE2E.RecoveryTelemetry.requestManualRecovery()), 'Manual recovery starts while connected');
    await advances('recovery while connected');

    await page.evaluate(() => window.__simWorkerE2E.AppLifecycle.invalidateLiveConnectionForLifecycle('qa-lifecycle'));
    await page.waitForFunction(() => Object.values(window.__simWorkerE2E.state()).every(s => !s.connected && s.phase === 'needs-manual'), null, { timeout: 5000 });
    assert.ok(await page.evaluate(() => window.__simWorkerE2E.RecoveryTelemetry.requestManualRecovery()), 'Manual recovery starts after invalidation');
    await page.waitForFunction(() => Object.values(window.__simWorkerE2E.state()).every(s => s.connected && s.phase === 'idle'), null, { timeout: 5000 });
    // The battle test ends its sample on the disconnect and pauses both sessions; resume to observe the recovered link.
    await page.evaluate(() => Object.values(window.__simWorkerE2E.MatchLifecycle.singleMatch.sessions).forEach(s => s.setTestModePaused(false)));
    const recovered = await advances('recovery after invalidation', 5000);

    for (const role of ['host', 'guest']) {
      assert.equal(recovered[role].hashMismatches, 0, `${role} lockstep core saw no state hash mismatch`);
      assert.ok(recovered[role].stateHashes > 0, `${role} lockstep core compared state hashes`);
    }
    // Steady play only: the window before any recovery, which resends a snapshot.
    const { before, after } = steps[0], traffic = recovered.guest.traffic;
    const bytes = role => after.guest.traffic[role + 'PacketBytes'] - before.guest.traffic[role + 'PacketBytes'];
    const perTick = (bytes('sent') + bytes('received')) / (after.guest.tick - before.guest.tick);
    assert.ok(perTick > 0 && perTick < 512, `Relayed traffic stays small in steady play (${perTick.toFixed(1)} B/tick)`);

    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), page.evaluate(() => window.__simWorkerE2E.PerformanceTelemetry.exportBalanceTelemetry())]);
    const balance = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    for (const role of ['host', 'guest']) assert.ok(Number.isFinite(balance.sessions[role]?.tick) && typeof balance.sessions[role]?.checksum === 'string', `${role} balance telemetry exported`);

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(workerErrors, []);
    const result = { steps, trafficPerTickBytes: +perTick.toFixed(1), traffic, balanceTicks: { host: balance.sessions.host.tick, guest: balance.sessions.guest.tick } };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    await page.screenshot({ path: path.join(output, 'recovered.png') });
    console.log(JSON.stringify({ pass: true, recovered: { host: recovered.host.tick, guest: recovered.guest.tick }, trafficPerTickBytes: result.trafficPerTickBytes, balanceTicks: result.balanceTicks }, null, 2));
    await context.close();
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, steps }, null, 2));
    throw error;
  } finally {
    await browser.close();
    await server.close();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
