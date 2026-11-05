const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { serveSource, routePinnedSDK } = require('./netcode-qa-module.cjs');

// Fixed mission states exercise the production capture/economy/combat steps. The UI
// scenario submits the range purchase through its native button and real RTC peers.
const root = path.resolve(__dirname, '..');
const htmlPath = path.resolve(process.argv[2] || path.join(root, 'index.html'));
const mode = process.env.QA_NETCODE_MODE || 'lockstep';
assert(['lockstep', 'rollback'].includes(mode), 'supported UI netcode mode');
const output = path.join(root, '.qa', 'capture-economy-' + mode);
const observer = `CONFIG.single.botWorker=false;
window.__economyE2E={ActiveViewState,MatchLifecycle,ready:true};`;
(async () => {
  const server = await serveSource(htmlPath, { observer });
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'chromium' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }), pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await routePinnedSDK(page);
    await page.goto(server.url + '?tps=20&role=host&netcode=' + mode, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__economyE2E?.ready && window.RallyGamekit, null, { timeout: 60000 });
    const result = await page.evaluate(async () => {
      const { StrategySim } = await import(new URL('./src/sim/strategy-sim.js', location.href));
      const { LaunchRules } = await import(new URL('./src/sim/launch-rules.js', location.href));
      const { GameRuleDefinition } = await import(new URL('./src/core/game-rules.js', location.href));
      const { BuildingDefinition } = await import(new URL('./src/definitions/buildings.js', location.href));
      const check = (value, message, detail) => { if (!value) throw Error(message + (detail ? ': ' + JSON.stringify(detail) : '')); };
      const rows = [], seed = 12345;
      function arena(tps = 20, count = 1) {
        const rules = GameRuleDefinition.resolve({ overrides: { simulation: { tps } } });
        const sim = new StrategySim(seed, rules), state = sim.exportState();
        const map = structuredClone(state.mapDescriptor), x = Math.round(map.width / 2), y = Math.round(map.height / 2);
        map.terrain = { layers: [], ramps: [], blockers: [], riverPath: [], riverBranches: [], riverPolygon: [], riverBranchPolygons: [], riverHalfWidth: 0, bridges: [] };
        state.mapDescriptor = map; state.units = []; state.projectiles = []; state.launchDeployments = [];
        state.capturePoints = Array.from({ length: count }, (_, i) => ({ id: 'economy-' + i, x: x + (i % 3 - 1) * 550, y: y + Math.floor(i / 3) * 550, owner: null, outpostId: null, enabled: true, label: '거점' + i }));
        for (const b of state.buildings) { b.x = x + (b.side ? 1400 : -1400); b.y = y - 1000; }
        sim.importState(state);
        return sim;
      }
      function step(sim, n, visit = () => {}) { for (let i = 0; i < n; i++) { sim.stepSimulation(); visit(sim); } }
      function start(sim, side = 0) {
        for (const cp of sim.capturePoints) sim.spawnUnit(side, 'rice', cp.x + 100, cp.y);
        step(sim, 1);
        check(sim.capturePoints.every(cp => cp.owner === null && cp.outpostId), 'presence immediately starts a building without completed ownership');
        const state = sim.exportState(); state.units = []; sim.importState(state);
        return sim.capturePoints.map(cp => sim.buildings.find(b => b.id === cp.outpostId));
      }
      function restore(sim) { const copy = new StrategySim(seed, sim.rules); copy.importState(sim.exportState()); check(copy.checksum() === sim.checksum(), 'checkpoint restores authoritative checksum'); return copy; }
      function destroy(sim, building) { sim.applyDamage(1 - building.side, 'rice', building, true, 100000, null, { sourceDamageResolved: true }); }
      // The player can trade the entire starting wallet for a global range level.
      {
        const sim = arena(), base = sim.launchCannons(0)[0];
        check(LaunchRules.maxReachOf('rice', 0) === 500 && LaunchRules.maxReachOf('soybean', 0) === 425 && LaunchRules.maxReachOf('redbean', 0) === 375, 'initial short launch ranges');
        check(!sim.applyCommand('observer', { type: 'UPGRADE_LAUNCH_RANGE' }), 'spectator cannot buy range');
        check(sim.applyCommand('host', { type: 'UPGRADE_LAUNCH_RANGE' }) && sim.wallet[0] === 0 && sim.launchRangeLevel[0] === 1 && sim.launchRangeLevel[1] === 0, '50 resource purchase upgrades only the buying side');
        check(!sim.applyCommand('host', { type: 'UPGRADE_LAUNCH_RANGE' }) && sim.wallet[0] === 0, 'insufficient wallet is rejected without spending');
        sim.wallet[0] = 100;
        check(sim.applyCommand('host', { type: 'UPGRADE_LAUNCH_RANGE' }) && sim.wallet[0] === 25 && sim.launchRangeLevel[0] === 2, 'second level costs75');
        check(!sim.applyCommand('host', { type: 'UPGRADE_LAUNCH_RANGE' }) && sim.wallet[0] === 25, 'maximum level rejects further payment');
        sim.wallet[0] = 100;
        const target = { type: 'LAUNCH', cannonId: base.id, unitType: 'soybean', holdMs: 1500, x: base.x, y: base.y + 2000 };
        check(sim.applyCommand('host', target), 'upgraded cannon accepts normal launch');
        const fire = sim.events.find(e => e.type === 'launchFire');
        check(Math.abs(Math.hypot(fire.aimX - base.x, fire.aimY - base.y) - 1275) <= 1, 'authoritative launch consumes the upgraded grain range', fire);
        rows.push({ scenario: 'range purchases and authoritative launch', level: sim.launchRangeLevel, wallet: sim.wallet, reach: 1275 });
      }
      // Construction has the same 15-second cadence at every supported scenario TPS.
      for (const tps of [10, 20, 30]) {
        const sim = arena(tps), [building] = start(sim), startTick = sim.tick, wallet = sim.wallet[0];
        check(building.hp === building.maxHp * .1 && building.construction.invested === 0, 'construction starts at10% with no immediate payment');
        check(!sim.launchCannons(0).some(b => b.id === building.id), 'unfinished tower cannot launch');
        step(sim, tps - 1);
        check(building.construction.invested === 0, 'no payment before one whole second');
        step(sim, 1);
        check(building.construction.invested === 1 && Math.abs(building.hp - building.maxHp * .16) < .001, 'one resource increases health and progress after a second');
        const hpBefore = building.hp; sim.applyDamage(1, 'rice', building, true, 50, null, { sourceDamageResolved: true }); const damage = hpBefore - building.hp;
        step(sim, 14 * tps - 1);
        check(sim.capturePoints[0].owner === null && building.construction.invested === 14, 'ownership waits until the fifteenth payment');
        step(sim, 1);
        check(sim.tick - startTick === 15 * tps && building.construction === null && sim.capturePoints[0].owner === 0, 'fifteen seconds completes capture with no troop remaining');
        check(Math.abs(building.hp - (building.maxHp - damage)) < .001, 'construction preserves prior damage instead of healing it away');
        check(sim.launchCannons(0).some(b => b.id === building.id), 'completed tower becomes an available cannon');
        // Basic income is45 over the15 seconds; the15 construction resources are lost from wallet.
        check(sim.wallet[0] === wallet + 45 - 15, 'exact construction investment costs15', { before: wallet, after: sim.wallet[0], tps });
        rows.push({ scenario: '15-second construction, proportional health and damage preserved', tps, elapsedTicks: sim.tick - startTick, hp: building.hp, wallet: sim.wallet[0] });
      }
      // Simultaneous opposing presence cannot choose either side. An unfinished
      // tower rejects a real launch command before touching the shared wallet.
      {
        const contested = arena(), cp = contested.capturePoints[0];
        contested.spawnUnit(0, 'rice', cp.x + 100, cp.y); contested.spawnUnit(1, 'rice', cp.x - 100, cp.y);
        step(contested, 1);
        check(cp.owner === null && cp.outpostId === null && cp.enabled, 'contested point cannot start construction for either side');
        const sim = arena(), [building] = start(sim), wallet = sim.wallet[0];
        check(!sim.applyCommand('host', { type: 'LAUNCH', cannonId: building.id, unitType: 'rice', holdMs: 1500, x: building.x, y: building.y + 1000 }) && sim.wallet[0] === wallet && sim.projectiles.length === 0, 'unfinished tower launch command rejects without spending');
        rows.push({ scenario: 'contested capture and unfinished cannon reject without spending', wallet });
      }
      // At the exact due tick an empty wallet pauses the project. A later single
      // resource is invested immediately, then a fresh full second is required.
      {
        const sim = arena(), [initial] = start(sim); step(sim, sim.tps - 1);
        const state = sim.exportState(); state.wallet[0] = 0; state.launchIncomeCarry[0] = 0; sim.importState(state);
        const building = sim.buildings.find(b => b.id === initial.id); step(sim, 1);
        check(building.construction.invested === 0 && sim.wallet[0] === 0, 'empty wallet at payment deadline cannot grant free progress');
        sim.wallet[0] = 1; step(sim, 1);
        check(building.construction.invested === 1 && sim.wallet[0] === 0, 'a newly available resource immediately resumes overdue construction');
        sim.wallet[0] = 100; step(sim, sim.tps - 1);
        check(building.construction.invested === 1, 'resumed construction waits a whole second before its next payment');
        step(sim, 1); check(building.construction.invested === 2, 'new one-second payment cadence starts on actual resumed payment');
        rows.push({ scenario: 'empty wallet pauses and refill resumes without banked catch-up', invested: building.construction.invested, tick: sim.tick });
      }
      // A tower captured after buying the global upgrade inherits the same range.
      {
        const sim = arena(); check(sim.applyCommand('host', { type: 'UPGRADE_LAUNCH_RANGE' }), 'buy shared range before capturing another cannon');
        sim.wallet[0] = 100; const [building] = start(sim); step(sim, 15 * sim.tps);
        check(sim.applyCommand('host', { type: 'LAUNCH', cannonId: building.id, unitType: 'soybean', holdMs: 1500, x: building.x, y: building.y + 2000 }), 'completed outpost accepts launch');
        const fire = sim.events.find(e => e.type === 'launchFire' && e.cannonId === building.id), reach = Math.hypot(fire.aimX - building.x, fire.aimY - building.y);
        check(Math.abs(reach - 850) <= 1, 'new outpost uses the previously purchased global range level', { reach });
        rows.push({ scenario: 'newly captured cannon inherits shared range upgrade', reach });
      }
      // When five projects compete for the basic3/s, later projects wait rather
      // than gaining free progress or banking missed payments for a burst later.
      {
        const sim = arena(20, 5), buildings = start(sim); sim.wallet[0] = 0;
        step(sim, sim.tps);
        check(JSON.stringify(buildings.map(b => b.construction.invested)) === JSON.stringify([1, 1, 1, 0, 0]), 'simultaneously due projects spend the available3 in oldest-first order');
        step(sim, 3 * sim.tps);
        const invested = buildings.map(b => b.construction?.invested || 0);
        check(invested.reduce((a, b) => a + b, 0) === 12 && invested.every((n, i) => i === 0 || n <= invested[i - 1]) && invested[4] < 4, 'oldest project priority with wallet starvation', invested);
        const waiting = buildings.find(b => b.construction.invested < 4), before = waiting.construction.invested;
        sim.wallet[0] = 100; step(sim, 1);
        check(waiting.construction.invested <= before + 1, 'refill cannot instantly pay missed construction seconds');
        rows.push({ scenario: 'parallel construction spends income and pauses without catch-up', invested, afterRefill: waiting.construction.invested });
      }
      // Completed capture income scales with ownership, and construction loss has no refund.
      {
        const sim = arena(20, 3), buildings = start(sim); step(sim, 15 * sim.tps);
        check(sim.capturePoints.every(cp => cp.owner === 0), 'three funded projects complete');
        sim.wallet[0] = 0; sim.launchIncomeCarry[0] = 0; step(sim, sim.tps);
        check(sim.wallet[0] === 6, 'three completed points give base3+3 income');
        destroy(sim, buildings[0]); sim.wallet[0] = 0; sim.launchIncomeCarry[0] = 0; step(sim, sim.tps);
        check(sim.wallet[0] === 5 && sim.capturePoints[0].owner === null && sim.capturePoints[0].outpostId === null, 'destroyed capture immediately stops its income');
        rows.push({ scenario: 'capture income grows and stops on loss', incomeBefore: 6, incomeAfter: sim.wallet[0] });
        const loss = arena(), [partial] = start(loss); step(loss, 4 * loss.tps); const paid = partial.construction.invested, wallet = loss.wallet[0]; destroy(loss, partial);
        check(paid === 4 && loss.wallet[0] === wallet && loss.capturePoints[0].owner === null && loss.capturePoints[0].outpostId === null, 'unfinished destruction loses every payment with no refund');
        rows.push({ scenario: 'destroyed construction loses its investment', paid, wallet });
      }
      // The completed tower chooses one visible enemy, deals10 per second,
      // and does not attack while it is still being built.
      {
        const sim = arena(), [building] = start(sim), cp = sim.capturePoints[0];
        const first = sim.spawnUnit(1, 'soybean', cp.x + 150, cp.y); first.hp = first.maxHp = 10000;
        const incompleteHits = []; step(sim, sim.tps, s => incompleteHits.push(...s.events.filter(e => e.type === 'hit' && e.sourceId === building.id)));
        check(incompleteHits.length === 0, 'construction cannot use its basic attack');
        const empty = sim.exportState(); empty.units = []; sim.importState(empty);
        step(sim, 14 * sim.tps);
        const tower = sim.buildings.find(b => b.id === building.id);
        check(tower.construction === null, 'funded tower completed before its defense scenario');
        const one = sim.spawnUnit(1, 'soybean', cp.x + 150, cp.y), two = sim.spawnUnit(1, 'soybean', cp.x + 180, cp.y + 50), friend = sim.spawnUnit(0, 'soybean', cp.x - 150, cp.y);
        for (const u of [one, two, friend]) u.hp = u.maxHp = 10000;
        const hits = []; step(sim, 2 * sim.tps, s => hits.push(...s.events.filter(e => e.type === 'hit' && e.sourceId === tower.id).map(e => ({ tick: s.tick, targetId: e.targetId, amount: e.amount }))));
        check(hits.length === 2 && hits.every(e => e.amount === 10 && e.targetId !== friend.id), 'single-target tower attacks deal10 every second and exclude friends', hits);
        check(hits[1].tick - hits[0].tick === sim.tps, 'tower attack interval is one second', hits);
        check(BuildingDefinition.get(tower.type).range === 250, 'tower range is250');
        const state = sim.exportState(); state.units = []; sim.importState(state);
        const far = sim.spawnUnit(1, 'soybean', cp.x + 500, cp.y); far.hp = far.maxHp = 10000;
        const farHits = []; step(sim, sim.tps, s => farHits.push(...s.events.filter(e => e.type === 'hit' && e.sourceId === tower.id)));
        check(farHits.length === 0, 'distant enemy is not attacked');
        rows.push({ scenario: 'finished tower basic defense is single target10 per second', hits, distantHits: farHits.length });
      }
      // A checkpoint during construction and a purchase must preserve future
      // payment cadence, HP, ownership, income, and shared range state.
      {
        const sim = arena(), [building] = start(sim); step(sim, 3 * sim.tps + 7);
        check(sim.applyCommand('host', { type: 'UPGRADE_LAUNCH_RANGE' }), 'mid-construction range investment accepted');
        const copy = restore(sim), before = sim.checksum(), snap = sim.snapshot();
        snap.buildings.find(b => b.id === building.id).construction.invested = 14; snap.launchRangeLevel[0] = 99;
        check(sim.checksum() === before, 'snapshot mutation cannot change construction or upgrade authority');
        for (let i = 0; i < 16 * sim.tps; i++) { sim.stepSimulation(); copy.stepSimulation(); check(sim.checksum() === copy.checksum(), 'restored future construction and range hashes match', { tick: sim.tick }); }
        rows.push({ scenario: 'construction and upgrade checkpoint restores exact future', checksum: sim.checksum() });
      }
      return { seed, viewport: { width: 1280, height: 800 }, rows };
    });
    await page.locator('#gameStartBtn').click();
    await page.locator('#gameScreen').waitFor({ state: 'visible', timeout: 35000 });
    await page.waitForFunction(() => Object.values(window.__economyE2E.MatchLifecycle.singleMatch?.sessions || {}).length === 2 && Object.values(window.__economyE2E.MatchLifecycle.singleMatch.sessions).every(s => s.netcodeSession?.ready && s.sim?.tick >= 4), null, { timeout: 15000 });
    await page.locator('#launchRangeBtn').click();
    await page.waitForFunction(() => Object.values(window.__economyE2E.MatchLifecycle.singleMatch.sessions).every(s => s.sim?.launchRangeLevel?.[0] === 1), null, { timeout: 15000 });
    const ui = await page.evaluate(() => {
      const q = window.__economyE2E, sessions = Object.values(q.MatchLifecycle.singleMatch.sessions);
      return { button: document.querySelector('#launchRangeBtn').textContent, income: document.querySelector('#launchIncomeText').textContent,
        levels: sessions.map(s => s.sim.launchRangeLevel), recorded: sessions.map(s => s.replayRecorder.commands.filter(c => c.actor === 'host' && c.action.type === 'UPGRADE_LAUNCH_RANGE').length),
        rtc: Object.values(q.MatchLifecycle.singleMatch.transports).map(t => t.room.peerConnection.connectionState),
        ticks: sessions.map(s => s.sim.tick), seeds: sessions.map(s => s.sim.seed), modes: sessions.map(s => s.netcodeSession.profile.mode) };
    });
    assert(ui.modes.every(value => value === mode), 'selected netcode mode reaches both real peers');
    assert(ui.recorded.every(n => n === 1), 'native purchase reaches both replay recorders exactly once');
    assert(ui.rtc.every(s => s === 'connected'), 'real RTC peers carry the upgrade command');
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'range-upgrade-desktop.png') });
    await page.setViewportSize({ width: 412, height: 915 });
    await page.screenshot({ path: path.join(output, 'range-upgrade-mobile.png') });
    assert.deepEqual(pageErrors, [], 'scenario browser page errors');
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ...result, ui }, null, 2));
    console.log(JSON.stringify({ pass: true, ...result, ui }, null, 2));
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
