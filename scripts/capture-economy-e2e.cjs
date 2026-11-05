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
      const { UnitDefinition } = await import(new URL('./src/definitions/units.js', location.href));
      const { InteractionGeometry } = await import(new URL('./src/sim/navigation.js', location.href));
      const { FP } = await import(new URL('./src/core/config.js', location.href));
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
      function start(sim, { workers = 1, contact = true, side = 0 } = {}) {
        const groups = [];
        for (const cp of sim.capturePoints) {
          const ids = [];
          for (let i = 0; i < Math.max(1, workers); i++) { const a = i * Math.PI * 2 / Math.max(1, workers); ids.push(sim.spawnUnit(side, 'rice', cp.x + Math.cos(a) * (contact ? 100 : 160), cp.y + Math.sin(a) * (contact ? 100 : 160)).id); }
          groups.push(ids);
        }
        step(sim, 1);
        check(sim.capturePoints.every(cp => cp.owner === null && cp.outpostId), 'presence immediately starts a building without completed ownership');
        const state = sim.exportState();
        if (!workers) state.units = [];
        else if (contact) for (const [index, ids] of groups.entries()) {
          const building = sim.buildings.find(b => b.id === sim.capturePoints[index].outpostId);
          for (const [i, id] of ids.entries()) {
            const u = state.units.find(unit => unit.id === id), radius = sim.buildingClearanceDistance(u, building) + .75, a = i * Math.PI * 2 / workers;
            u.x = building.x + Math.cos(a) * radius; u.y = building.y + Math.sin(a) * radius;
            u.fx = Math.round(u.x * FP); u.fy = Math.round(u.y * FP); u.constructionWork = null;
          }
        }
        sim.importState(state); step(sim, 1);
        return sim.capturePoints.map(cp => sim.buildings.find(b => b.id === cp.outpostId));
      }
      function finish(sim, building, maxSeconds = 20) {
        for (let i = 0; i < maxSeconds * sim.tps && building.construction; i++) sim.stepSimulation();
        check(building.construction === null, 'active workers finish their funded tower');
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
      // One worker continuously contacting the common construction region needs
      // fifteen one-second work cycles. Travel time is deliberately excluded.
      for (const tps of [10, 20, 30]) {
        const sim = arena(tps), [building] = start(sim), startTick = sim.tick, wallet = sim.wallet[0];
        const worker = sim.units[0];
        check(worker.constructionWork?.targetId === building.id, 'contacting worker starts a real construction action');
        check(building.hp === building.maxHp * .1 && building.construction.invested === 0, 'construction starts at10% with no immediate investment');
        check(!sim.launchCannons(0).some(b => b.id === building.id), 'unfinished tower cannot launch');
        step(sim, tps - 1); check(building.construction.invested === 0, 'no work hit before a whole second');
        step(sim, 1); check(building.construction.invested === 1 && Math.abs(building.hp - building.maxHp * .16) < .001, 'one work hit invests1 and increases HP');
        const hpBefore = building.hp; sim.applyDamage(1, 'rice', building, true, 50, null, { sourceDamageResolved: true }); const damage = hpBefore - building.hp;
        step(sim, 14 * tps - 1); check(sim.capturePoints[0].owner === null && building.construction.invested === 14, 'ownership waits for the fifteenth work hit');
        step(sim, 1);
        check(sim.tick - startTick === 15 * tps && building.construction === null && sim.capturePoints[0].owner === 0, 'one worker completes fifteen seconds of uninterrupted contact work');
        check(Math.abs(building.hp - (building.maxHp - damage)) < .001, 'work preserves prior damage');
        check(sim.wallet[0] === wallet + 45 - 15, 'fifteen work hits invest exactly15 resources', { wallet, actual: sim.wallet[0], tps });
        rows.push({ scenario: 'one worker needs15 seconds, investment and damage remain exact', tps, elapsedTicks: sim.tick - startTick, hp: building.hp, wallet: sim.wallet[0] });
      }
      // A building has no autonomous timer. Empty sites, dead workers, and workers
      // moved away cannot produce work hits even while the wallet has resources.
      {
        const sim = arena(), [building] = start(sim, { workers: 0 }); step(sim, 15 * sim.tps);
        check(building.construction.invested === 0 && building.hp === building.maxHp * .1 && sim.capturePoints[0].owner === null, 'absence cannot autonomously construct a tower');
        rows.push({ scenario: 'no workers means no autonomous construction', invested: building.construction.invested });
        for (const leave of [false, true]) {
          const world = arena(), [tower] = start(world); step(world, 2 * world.tps); const invested = tower.construction.invested;
          if (leave) { const state = world.exportState(); for (const u of state.units) { u.x += 2000; u.fx = Math.round(u.x * FP); } world.importState(state); }
          else for (const u of world.units) world.applyDamage(1, 'rice', u, false, 100000, null, { sourceDamageResolved: true });
          step(world, 3 * world.tps);
          const current = world.buildings.find(b => b.id === tower.id);
          check(current.construction.invested === invested, 'work stops after every worker dies or leaves', { leave, invested, actual: current.construction.invested });
          rows.push({ scenario: leave ? 'workers leaving stops construction' : 'worker death stops construction', invested });
        }
      }
      // Three workers accelerate the same15-resource project to five seconds.
      // Their synchronized final hits can never overcharge or complete it twice.
      {
        const sim = arena(), [tower] = start(sim, { workers: 3 }), started = sim.tick, wallet = sim.wallet[0], hits = [], completed = [];
        step(sim, 5 * sim.tps, s => { hits.push(...s.events.filter(e => e.type === 'constructionHit')); completed.push(...s.events.filter(e => e.type === 'captureComplete')); });
        check(tower.construction === null && hits.length === 15 && completed.length === 1 && sim.tick - started === 5 * sim.tps, 'three workers finish exactly15 hits in five seconds', { hits: hits.length, completed: completed.length, tick: sim.tick });
        check(sim.wallet[0] === wallet + 15 - 15, 'accelerated construction still costs exactly15');
        const final = arena(), [initial] = start(final, { workers: 3 }), state = final.exportState(), b = state.buildings.find(building => building.id === initial.id);
        b.construction.invested = 14; b.hp = Math.round(b.maxHp * .94); state.wallet[0] = 50; state.launchIncomeCarry[0] = 0; final.importState(state);
        const lastHits = [], lastCompletions = []; step(final, final.tps, s => { lastHits.push(...s.events.filter(e => e.type === 'constructionHit')); lastCompletions.push(...s.events.filter(e => e.type === 'captureComplete')); });
        check(lastHits.length === 1 && lastCompletions.length === 1 && final.wallet[0] === 52, 'three simultaneous final hits charge only the remaining1 resource', { hits: lastHits.length, completed: lastCompletions.length, wallet: final.wallet[0] });
        rows.push({ scenario: 'multiple workers accelerate without overcharging the final hit', durationTicks: sim.tick - started, hits: hits.length, finalHitCharges: lastHits.length });
      }
      // No wallet means no work investment. Once a resource is available a
      // waiting worker resumes, and cannot bank missed cycles for a burst.
      {
        const sim = arena(), [initial] = start(sim); step(sim, sim.tps - 1);
        const state = sim.exportState(); state.wallet[0] = 0; state.launchIncomeCarry[0] = 0; sim.importState(state);
        const tower = sim.buildings.find(b => b.id === initial.id); step(sim, 1);
        check(tower.construction.invested === 0 && sim.wallet[0] === 0, 'empty wallet blocks a completed work hit');
        sim.wallet[0] = 1; step(sim, 1); check(tower.construction.invested === 0, 'funded waiting worker begins a fresh work cycle');
        sim.wallet[0] = 100; step(sim, sim.tps - 1); check(tower.construction.invested === 0, 'a resumed worker cannot bank missed work cycles');
        step(sim, 1); check(tower.construction.invested === 1, 'new work hit requires a full second after funds return');
        rows.push({ scenario: 'workers wait for funds without banked free work', invested: tower.construction.invested });
      }
      // The approach uses the same physical envelope as movement: no center
      // teleport or work from175-pixel capture presence distance is allowed.
      {
        const sim = arena(), [tower] = start(sim, { contact: false }), worker = sim.units[0], before = Math.hypot(worker.x - tower.x, worker.y - tower.y), started = sim.tick;
        let firstHit = null;
        step(sim, 4 * sim.tps, s => {
          const distance = Math.hypot(worker.x - tower.x, worker.y - tower.y);
          check(distance >= sim.buildingClearanceDistance(worker, tower) - .1, 'construction approach stays outside the building collider', { distance });
          for (const e of s.events) if (e.type === 'constructionHit' && firstHit === null) { firstHit = s.tick; check(distance <= sim.interactionDistance(worker, tower, 'construction', UnitDefinition.get(worker.type).construction.range) + .1, 'work hit requires common construction contact'); }
        });
        check(before > sim.buildingClearanceDistance(worker, tower) && firstHit > started + sim.tps, 'travel precedes the one-second work cycle', { before, started, firstHit });
        rows.push({ scenario: 'worker approaches the common interaction region before working', before, firstHit });
      }
      // Geometric proximity cannot bypass a wall or an unconnected terrain
      // level. Both fixtures keep the worker and tower outside obstacle interiors.
      {
        const sim = arena(), [initial] = start(sim), state = sim.exportState();
        state.mapDescriptor = structuredClone(state.mapDescriptor);
        state.mapDescriptor.terrain.blockers = [{ id: 'construction-wall', kind: 'wall', points: [{ x: initial.x + 49, y: initial.y - 500 }, { x: initial.x + 51, y: initial.y - 500 }, { x: initial.x + 51, y: initial.y + 500 }, { x: initial.x + 49, y: initial.y + 500 }] }];
        sim.importState(state);
        let tower = sim.buildings.find(b => b.id === initial.id); const worker = sim.units[0];
        check(sim.world.terrain.field.polygonCircleClear(worker.x, worker.y, sim.unitRadius(worker.type)), 'wall fixture worker circle starts outside its collider');
        check(Math.hypot(worker.x - tower.x, worker.y - tower.y) <= InteractionGeometry.reach(worker, tower, 'construction', UnitDefinition.get(worker.type).construction.range), 'wall fixture is geometrically within the actual construction reach');
        check(!sim.world.terrain.field.polygonSegmentClear(worker.x, worker.y, tower.x, tower.y, 0), 'wall fixture blocks the worker-to-building line');
        step(sim, 2 * sim.tps); check(tower.construction.invested === 0, 'a nearby worker cannot construct through a wall');
        const opened = sim.exportState(); opened.mapDescriptor = structuredClone(opened.mapDescriptor); opened.mapDescriptor.terrain.blockers = []; sim.importState(opened);
        tower = sim.buildings.find(b => b.id === initial.id); step(sim, 4 * sim.tps);
        check(tower.construction.invested > 0, 'removing the wall permits ordinary approach and construction');
        rows.push({ scenario: 'wall blocks nearby work, removing it permits contribution', resumedInvestment: tower.construction.invested });
        const level = arena(), [site] = start(level), raised = level.exportState(); raised.mapDescriptor = structuredClone(raised.mapDescriptor);
        raised.units[0].x = site.x + 65.5; raised.units[0].fx = Math.round(raised.units[0].x * FP);
        raised.mapDescriptor.terrain.layers = [{ id: 'construction-opposite-level', level: 2, points: [{ x: site.x + 52, y: site.y - 500 }, { x: site.x + 600, y: site.y - 500 }, { x: site.x + 600, y: site.y + 500 }, { x: site.x + 52, y: site.y + 500 }] }];
        level.importState(raised);
        const builder = level.units[0], actual = level.buildings.find(b => b.id === site.id);
        check(level.terrainLevelAt(builder.x, builder.y) === 2 && level.terrainLevelAt(actual.x, actual.y) === 0, 'level fixture places nearby worker and tower on different levels without a ramp');
        check(Math.hypot(builder.x - actual.x, builder.y - actual.y) <= InteractionGeometry.reach(builder, actual, 'construction', UnitDefinition.get(builder.type).construction.range), 'opposite-level fixture is geometrically within the actual construction reach');
        step(level, 2 * level.tps);
        check(actual.construction.invested === 0, 'a nearby worker cannot construct across an unconnected level boundary');
        rows.push({ scenario: 'unconnected terrain levels block nearby work', invested: actual.construction.invested });
      }
      // Contact is insufficient while recovering or airborne from a real impulse.
      {
        const sim = arena(), [tower] = start(sim), worker = sim.units[0];
        sim.navigation.motion.applyImpulse(worker, { x: 0, y: 0, z: 2000 * sim.mass(worker) }, { sourceId: 'work-airborne', originX: worker.x, originY: worker.y });
        const recoveryUntil = worker.impactMotion.recoverUntilTick, hits = [];
        while (sim.tick < recoveryUntil) { sim.stepSimulation(); hits.push(...sim.events.filter(e => e.type === 'constructionHit')); }
        check(hits.length === 0 && tower.construction.invested === 0, 'airborne and recovery ticks cannot produce work hits');
        step(sim, 2 * sim.tps); check(tower.construction.invested >= 1, 'grounded recovered worker resumes real work');
        rows.push({ scenario: 'impulse air and recovery block construction, landing resumes', recoveryUntil, invested: tower.construction.invested });
      }
      // The worker must resolve nearby combat before resuming construction.
      {
        const sim = arena(), [tower] = start(sim), worker = sim.units[0]; worker.hp = worker.maxHp = 10000;
        const enemy = sim.spawnUnit(1, 'rice', worker.x + 35, worker.y); enemy.hp = enemy.maxHp = 10000;
        const invested = tower.construction.invested, hits = [];
        step(sim, 2 * sim.tps, s => hits.push(...s.events.filter(e => e.type === 'hit' && e.sourceId === worker.id)));
        check(tower.construction.invested === invested && hits.length > 0, 'nearby enemy combat takes priority over construction');
        sim.applyDamage(0, 'rice', enemy, false, 100000, null, { sourceDamageResolved: true }); step(sim, 3 * sim.tps);
        check(tower.construction.invested > invested, 'worker resumes after combat target disappears');
        rows.push({ scenario: 'combat interrupts construction and workers resume afterwards', combatHits: hits.length, resumedInvestment: tower.construction.invested });
      }
      // Contested sites and unfinished cannons preserve their existing contracts.
      {
        const contested = arena(), cp = contested.capturePoints[0]; contested.spawnUnit(0, 'rice', cp.x + 100, cp.y); contested.spawnUnit(1, 'rice', cp.x - 100, cp.y); step(contested, 1);
        check(cp.owner === null && cp.outpostId === null && cp.enabled, 'opposing presence cannot start construction');
        const sim = arena(), [tower] = start(sim), wallet = sim.wallet[0];
        check(!sim.applyCommand('host', { type: 'LAUNCH', cannonId: tower.id, unitType: 'rice', holdMs: 1500, x: tower.x, y: tower.y + 1000 }) && sim.wallet[0] === wallet, 'unfinished cannon rejects launch without spending');
        rows.push({ scenario: 'contested capture and unfinished cannon reject', wallet });
      }
      // Global range, capture income and loss remain part of the worker scenario.
      {
        const sim = arena(); check(sim.applyCommand('host', { type: 'UPGRADE_LAUNCH_RANGE' }), 'buy shared range before capturing'); sim.wallet[0] = 100;
        const [tower] = start(sim); finish(sim, tower);
        check(sim.applyCommand('host', { type: 'LAUNCH', cannonId: tower.id, unitType: 'soybean', holdMs: 1500, x: tower.x, y: tower.y + 2000 }), 'completed worker-built cannon accepts launch');
        const fire = sim.events.find(e => e.type === 'launchFire' && e.cannonId === tower.id), reach = Math.hypot(fire.aimX - tower.x, fire.aimY - tower.y);
        check(Math.abs(reach - 850) <= 1, 'worker-built cannon inherits global range');
        const income = arena(20, 3), towers = start(income); for (const b of towers) finish(income, b);
        income.wallet[0] = 0; income.launchIncomeCarry[0] = 0; step(income, income.tps); check(income.wallet[0] === 6, 'three completed worker projects give6 income');
        const clear = income.exportState(); clear.units = []; income.importState(clear); destroy(income, income.buildings.find(b => b.id === towers[0].id)); income.wallet[0] = 0; income.launchIncomeCarry[0] = 0; step(income, income.tps);
        check(income.wallet[0] === 5, 'destroyed capture stops its income');
        const loss = arena(), [partial] = start(loss); step(loss, 4 * loss.tps); const paid = partial.construction.invested, wallet = loss.wallet[0]; destroy(loss, partial);
        check(paid === 4 && loss.wallet[0] === wallet && loss.capturePoints[0].owner === null, 'destroyed worker project loses invested resources');
        rows.push({ scenario: 'worker-built cannon range, capture income and construction loss', reach, incomeAfterLoss: income.wallet[0], lostInvestment: paid });
      }
      // Completed towers retain their single-target basic defense; unfinished
      // structures do not inherit that attack while their workers are busy.
      {
        const sim = arena(), [tower] = start(sim); finish(sim, tower);
        const workerState = sim.exportState(); workerState.units = []; sim.importState(workerState);
        const one = sim.spawnUnit(1, 'soybean', tower.x + 150, tower.y), two = sim.spawnUnit(1, 'soybean', tower.x + 180, tower.y + 50);
        for (const u of [one, two]) u.hp = u.maxHp = 10000;
        const hits = []; step(sim, 2 * sim.tps, s => hits.push(...s.events.filter(e => e.type === 'hit' && e.sourceId === tower.id).map(e => ({ tick: s.tick, targetId: e.targetId, amount: e.amount }))));
        check(hits.length === 2 && hits.every(e => e.amount === 10) && hits[1].tick - hits[0].tick === sim.tps, 'finished tower retains10 damage single-target attacks every second', hits);
        const incomplete = arena(), [site] = start(incomplete, { workers: 0 }); incomplete.spawnUnit(1, 'soybean', site.x + 150, site.y);
        const forbidden = []; step(incomplete, incomplete.tps, s => forbidden.push(...s.events.filter(e => e.type === 'hit' && e.sourceId === site.id)));
        check(forbidden.length === 0, 'unfinished structure cannot use its basic attack');
        rows.push({ scenario: 'completed tower retains its basic defense', hits });
      }
      // Checkpoints include partial unit work actions and their future hit times.
      {
        const sim = arena(), [tower] = start(sim); step(sim, 3 * sim.tps + 7); check(sim.applyCommand('host', { type: 'UPGRADE_LAUNCH_RANGE' }), 'range investment during worker action');
        const copy = restore(sim), before = sim.checksum(), snap = sim.snapshot(); snap.buildings.find(b => b.id === tower.id).construction.invested = 14; snap.units[0].constructionWork.nextHitTick = 0;
        check(sim.checksum() === before, 'snapshot work-action mutation cannot change authority');
        for (let i = 0; i < 16 * sim.tps; i++) { sim.stepSimulation(); copy.stepSimulation(); check(sim.checksum() === copy.checksum(), 'restored work actions produce identical future hashes', { tick: sim.tick }); }
        rows.push({ scenario: 'partial worker action checkpoint restores exact future', checksum: sim.checksum() });
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
    const ranges = await page.evaluate(async () => {
      const { StrategySim } = await import(new URL('./src/sim/strategy-sim.js', location.href));
      const { WorldContext } = await import(new URL('./src/sim/world-context.js', location.href));
      const { BattlefieldProjection } = await import(new URL('./src/sim/terrain.js', location.href));
      const r = window.__economyE2E.ActiveViewState.renderer, map = structuredClone(new StrategySim(12345).mapDescriptor);
      const cx = map.width / 2, cy = map.height / 2;
      map.terrain = { layers: [{ id: 'range-highground', level: 2, points: [{ x: cx + 100, y: 100 }, { x: map.width - 100, y: 100 }, { x: map.width - 100, y: map.height - 100 }, { x: cx + 100, y: map.height - 100 }] }], ramps: [], blockers: [], riverPath: [], riverBranches: [], riverPolygon: [], riverBranchPolygons: [], riverHalfWidth: 0, bridges: [] };
      const original = { world: r.world, orientation: r.replayOrientationRole, project: r.worldToPx, line: r.line }, rows = [];
      const check = (ok, message, details) => { if (!ok) throw Error(message + ': ' + JSON.stringify(details)); };
      try {
        r.world = WorldContext.fromMap(map);
        for (const orientation of ['host', 'guest']) {
          r.replayOrientationRole = orientation;
          for (const [type, level, radius] of [['rice', 0, 500], ['soybean', 0, 425], ['redbean', 0, 375], ['rice', 1, 1000], ['rice', 2, 1500]]) {
            const projected = [], lines = [];
            // Observe the real geometry producer and forward every call unchanged.
            // No renderer or projection result is substituted.
            r.worldToPx = function (x, y, height) {
              const xy = original.project.call(this, x, y, height), wx = this.viewX(x), wy = this.viewY(y);
              projected.push({ x: wx, y: wy, height, xy }); return xy;
            };
            r.line = function (...args) { lines.push(args); return original.line.apply(this, args); };
            r.drawLaunchRange({ x: cx, y: cy }, type, level, true);
            check(lines.length > 30 && projected.length === lines.length * 2, 'actual range helper emits projected contour segments', { orientation, type, level, count: lines.length });
            for (const p of projected) {
              check(Math.abs(Math.hypot(p.x - cx, p.y - cy) - radius) < .001, 'contour uses the cannon center and actual maximum reach', { type, level, radius, p });
              check(p.height === r.world.terrain.surfaces.heightAt(p.x, p.y), 'each contour vertex uses its own canonical terrain height in either orientation', { orientation, p });
              const flat = original.project.call(r, r.viewX(p.x), r.viewY(p.y), 0);
              check(Math.abs((flat[1] - p.xy[1]) - p.height * BattlefieldProjection.heightScale * r.sc()) < .001, 'highground contour uses the shared screen projection', { orientation, p, flat });
            }
            check(projected.some(p => p.height > 0) && projected.some(p => p.height === 0), 'scenario spans both low and high terrain', { orientation, type });
            for (const [i, line] of lines.entries()) check(Math.hypot(line[0] - projected[i * 2].xy[0], line[1] - projected[i * 2].xy[1], line[2] - projected[i * 2 + 1].xy[0], line[3] - projected[i * 2 + 1].xy[1]) < .001, 'drawn line endpoints match actual projected contour vertices', { i });
            rows.push({ orientation, type, level, radius, segments: lines.length });
          }
        }
      } finally { r.world = original.world; r.replayOrientationRole = original.orientation; r.worldToPx = original.project; r.line = original.line; }
      return { seed: 12345, cannon: { x: cx, y: cy }, rows };
    });
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, 'range-upgrade-desktop.png') });
    await page.setViewportSize({ width: 412, height: 915 });
    await page.screenshot({ path: path.join(output, 'range-upgrade-mobile.png') });
    assert.deepEqual(pageErrors, [], 'scenario browser page errors');
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ ...result, ui, ranges }, null, 2));
    console.log(JSON.stringify({ pass: true, ...result, ui, ranges }, null, 2));
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
