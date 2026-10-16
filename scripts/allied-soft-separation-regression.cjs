const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { bundleGame } = require('./bundle-gamekit.cjs');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const bundled = bundleGame(root, source);
const iifeEnd = bundled.lastIndexOf('})();');
assert(iifeEnd > 0, 'Application IIFE must exist');
const html = bundled.slice(0, iifeEnd) + `
  window.__alliedSoftQA = {
    StrategySim, GameRuleDefinition, DebugScenarioHarness, RallyStateCodec,
    UnitDefinition, BuildingDefinition, SIM_VERSION, FP,
    ALLY_SOFT_IDLE_RADIUS_FRACTION, ALLY_SOFT_MAX_RADIUS_FRACTION, ALLY_SOFT_SPEED_FRACTION
  };
` + bundled.slice(iifeEnd);

async function run() {
  fs.mkdirSync(path.join(root, '.qa'), { recursive: true });
  const browserData = fs.mkdtempSync(path.join(root, '.qa', 'allied-soft-browser-'));
  const resolvedBrowserData = path.resolve(browserData);
  assert.equal(path.dirname(resolvedBrowserData), path.resolve(root, '.qa'), 'Browser profile stays in task QA folder');
  let context = null;
  try {
    context = await chromium.launchPersistentContext(browserData, {
      channel: process.env.QA_BROWSER_CHANNEL || 'msedge',
      headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('http://allied-soft-qa.local/**', route => route.fulfill({
      status: 200, contentType: 'text/html', body: html,
    }));
    await page.goto('http://allied-soft-qa.local/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__alliedSoftQA && window.RallyNetcode);
    const result = await page.evaluate(() => {
      const {
        StrategySim, GameRuleDefinition, DebugScenarioHarness, RallyStateCodec,
        UnitDefinition, BuildingDefinition, SIM_VERSION, FP,
        ALLY_SOFT_IDLE_RADIUS_FRACTION, ALLY_SOFT_MAX_RADIUS_FRACTION, ALLY_SOFT_SPEED_FRACTION,
      } = window.__alliedSoftQA;
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const scenario = DebugScenarioHarness.normalize({
        kind: 'unit-combat', allyType: 'swordsman', enemyType: 'swordsman',
        allyCount: 12, enemyCount: 12, research: false, humanRole: 'host',
      });
      const draft = { decks: { host: ['swordsman'], guest: ['swordsman'] }, defenseCards: { host: [], guest: [] } };
      const rules = GameRuleDefinition.resolve({ overrides: { simulation: { tps: 10 } } });
      const create = () => StrategySim.createForMatch({ draft, seed: 20261016, rules, debugScenario: scenario });
      const reset = sim => {
        sim.units.length = 0;
        sim.unitById.clear(); sim.unitIndexById.clear(); sim.runtimeIndexTick = -1;
        sim.rebuildRuntimeIndexes();
      };
      const spawn = (sim, side, type, x, y) => sim.spawnUnit(side, type, x, y);
      const place = (unit, x, y) => {
        unit.fx = Math.round(x * FP); unit.fy = Math.round(y * FP);
        unit.x = unit.fx / FP; unit.y = unit.fy / FP;
      };
      const startStep = sim => sim.captureCollisionStepStarts();
      const perf = () => Object.fromEntries([
        'collisionPairs', 'collisionOverlaps', 'collisionSoftPasses', 'collisionSoftContacts',
        'collisionSoftMovedUnits', 'collisionSoftCappedUnits', 'collisionPrepMs', 'collisionGridBuildMs',
        'collisionPairScanMs', 'collisionSoftApplyMs', 'collisionSweptMotionMs', 'collisionTerrainMs',
        'collisionHardFixMs', 'collisionSweptCalls', 'collisionSweptActivePasses', 'collisionSweptZeroMotionCalls',
        'collisionSweptEmptyPasses', 'collisionSweptPairTests', 'collisionSweptHits',
        'collisionSweptCorrectionUnits', 'collisionSweptNoCorrectionPasses', 'collisionHardFixCalls',
        'collisionHardFixPasses', 'collisionHardFixActivePairTests', 'collisionHardFixCandidates',
        'collisionHardFixCorrections', 'collisionHardFixNoOpCalls',
      ].map(key => [key, 0]));
      const solve = sim => {
        const counters = perf(); sim._perfCollect = counters;
        sim.solveContacts(); sim._perfCollect = null;
        return counters;
      };
      const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const cap = (sim, unit) => {
        const radius = sim.radiusFP(unit), speed = Math.max(0, Number(UnitDefinition.get(unit.type)?.speed) || 0);
        const idle = Math.round(radius * ALLY_SOFT_IDLE_RADIUS_FRACTION);
        const speedStep = Math.round(speed / sim.tps * FP * ALLY_SOFT_SPEED_FRACTION);
        return Math.max(1, Math.min(Math.round(radius * ALLY_SOFT_MAX_RADIUS_FRACTION), Math.max(idle, speedStep))) / FP;
      };
      const overlapCount = (sim, units) => {
        let count = 0;
        for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
          const sum = (sim.radiusFP(units[i]) + sim.radiusFP(units[j])) / FP;
          if (distance(units[i], units[j]) < sum) count++;
        }
        return count;
      };
      const stateBytes = sim => RallyStateCodec.encode(sim.exportState());
      const sameBytes = (a, b, label) => check(a.length === b.length && a.every((value, index) => value === b[index]), `Peer bytes differ: ${label}`);
      const results = [];
      const base = create();
      try {
        reset(base);
        const centerX = base.world.width * .5, centerY = base.world.height * .5;

        // A stationary in-range attacker still receives one small allied nudge.
        const attacker = spawn(base, 0, 'archer', centerX, centerY);
        const wing = spawn(base, 0, 'archer', centerX + 4, centerY);
        const enemy = spawn(base, 1, 'swordsman', centerX + 120, centerY);
        check(distance(attacker, enemy) <= UnitDefinition.get(attacker.type).range,
          'Attacking unit fixture starts within its weapon range');
        attacker.combat.attackWindupTargetId = enemy.id;
        attacker.combat.attackWindupUntil = 20;
        const before = distance(attacker, wing);
        startStep(base);
        const attackPerf = solve(base);
        const after = distance(attacker, wing);
        check(attacker.collisionIntentTick !== base.tick && attacker.collisionMoveTick !== base.tick,
          'Attacking fixture must have no movement intent');
        check(attacker.combat.attackWindupTargetId === enemy.id, 'Attack windup remains active during soft correction');
        check(after > before && after < (base.radiusFP(attacker) + base.radiusFP(wing)) / FP,
          'Idle allies separate softly while residual overlap is allowed');
        check(attackPerf.collisionSoftPasses === 1 && attackPerf.collisionSoftMovedUnits > 0,
          'A stationary attack pair receives exactly one soft pass');
        check(attackPerf.collisionHardFixCalls === 1, 'Hostile stationary safety runs once');
        results.push({ fixture: 'stationary-in-range-attacker', before, after, residualOverlap: true,
          softPasses: attackPerf.collisionSoftPasses, movedUnits: attackPerf.collisionSoftMovedUnits });

        // Dense units share only one accumulated pass; the radius/speed cap bounds displacement.
        reset(base);
        const dense = Array.from({ length: 48 }, () => spawn(base, 0, 'swordsman', centerX, centerY));
        const origins = dense.map(unit => ({ x: unit.x, y: unit.y }));
        startStep(base);
        const densePerf = solve(base);
        const denseResidual = overlapCount(base, dense);
        check(densePerf.collisionSoftPasses === 1, 'Dense crowd has no iterative ally convergence');
        check(densePerf.collisionSoftContacts > 0 && densePerf.collisionSoftMovedUnits > 0,
          'Dense crowd records contacts and attempts separation');
        check(denseResidual > 0, 'Dense crowd is allowed to retain overlap after the bounded pass');
        for (let i = 0; i < dense.length; i++) {
          const moved = Math.hypot(dense[i].x - origins[i].x, dense[i].y - origins[i].y);
          check(moved <= cap(base, dense[i]) + .02, `Dense displacement exceeds unit cap: ${moved} > ${cap(base, dense[i])}`);
        }
        check(densePerf.collisionSweptCalls <= 2 && densePerf.collisionHardFixCalls === 1,
          'Dense crowd only runs movement sweep, optional one correction sweep, and one final SAP');
        results.push({ fixture: 'dense-48', contacts: densePerf.collisionSoftContacts,
          movedUnits: densePerf.collisionSoftMovedUnits, cappedUnits: densePerf.collisionSoftCappedUnits,
          residualOverlaps: denseResidual, sweptCalls: densePerf.collisionSweptCalls,
          hardFixCalls: densePerf.collisionHardFixCalls, passCount: densePerf.collisionSoftPasses });

        // Opposing allied steps close a gap; a single pass reacts without relying on array update order.
        reset(base);
        const left = spawn(base, 0, 'swordsman', centerX - 28, centerY);
        const right = spawn(base, 0, 'swordsman', centerX + 28, centerY);
        startStep(base);
        place(left, centerX - 2, centerY); place(right, centerX + 2, centerY);
        const opposePerf = solve(base);
        check(distance(left, right) > 4, 'Opposing allies are pushed apart after their converging movement');
        check(distance(left, right) < (base.radiusFP(left) + base.radiusFP(right)) / FP,
          'Opposing allies may retain overlap instead of fully converging');
        check(Math.hypot(left.x - (centerX - 2), left.y - centerY) <= cap(base, left) + .02,
          'Left opposing unit correction is bounded');
        check(Math.hypot(right.x - (centerX + 2), right.y - centerY) <= cap(base, right) + .02,
          'Right opposing unit correction is bounded');
        results.push({ fixture: 'opposing-directions', finalDistance: distance(left, right),
          passCount: opposePerf.collisionSoftPasses, sweptCalls: opposePerf.collisionSweptCalls });

        // Mixed radii preserve mass weighting: the lighter/smaller unit yields farther.
        reset(base);
        const small = spawn(base, 0, 'swordsman', centerX, centerY);
        const heavy = spawn(base, 0, 'tank', centerX, centerY);
        const mixedCenter = { x: small.x, y: small.y };
        startStep(base);
        const mixedPerf = solve(base);
        const smallMove = Math.hypot(small.x - mixedCenter.x, small.y - mixedCenter.y);
        const heavyMove = Math.hypot(heavy.x - mixedCenter.x, heavy.y - mixedCenter.y);
        check(smallMove > heavyMove, `Mass weighting should move smaller unit farther (${smallMove} <= ${heavyMove})`);
        check(mixedPerf.collisionSoftPasses === 1, 'Mixed-size contact uses one pass');
        results.push({ fixture: 'mixed-radii', smallMove, heavyMove, passCount: mixedPerf.collisionSoftPasses });

        // Map-edge wall clamps soft correction and hostile hard-fix while retaining both agents in bounds.
        reset(base);
        const edgeRadius = base.radiusFP({ type: 'swordsman' });
        const edgeA = spawn(base, 0, 'swordsman', edgeRadius / FP + 2, centerY);
        const edgeB = spawn(base, 0, 'swordsman', edgeRadius / FP + 3, centerY);
        place(edgeA, edgeRadius / FP + 1, centerY); place(edgeB, edgeRadius / FP + 1, centerY);
        startStep(base);
        const edgePerf = solve(base);
        check(edgeA.x >= base.radiusFP(edgeA) / FP - .01 && edgeB.x >= base.radiusFP(edgeB) / FP - .01,
          'World-edge wall retains each collision radius inside the world');
        check(edgePerf.collisionSoftPasses === 1, 'Wall-pinned allies use one soft pass');
        results.push({ fixture: 'map-edge-wall', positions: [edgeA.x, edgeB.x], passCount: edgePerf.collisionSoftPasses });

        // A static building wall blocks the inward half of the same soft correction.
        reset(base);
        base.navigation.sync();
        const mainBase = base.buildings.find(building => building.side === 0 && BuildingDefinition.get(building.type)?.isMainBase);
        check(mainBase, 'Static building wall fixture has a main base');
        const wall = base.navigation.circles.find(obstacle => obstacle.id === mainBase.id);
        check(wall && Number.isFinite(wall.r), 'Main base has an indexed collision wall');
        const wallRadius = base.radiusFP({ type: 'swordsman' }) / FP;
        const wallX = mainBase.x + wall.r + wallRadius - 2;
        const wallY = mainBase.y;
        const wallA = spawn(base, 0, 'swordsman', wallX, wallY);
        const wallB = spawn(base, 0, 'swordsman', wallX, wallY);
        place(wallA, wallX, wallY); place(wallB, wallX, wallY);
        startStep(base);
        const wallPerf = solve(base);
        const wallClearanceA = distance(wallA, mainBase) - wall.r - base.radiusFP(wallA) / FP;
        const wallClearanceB = distance(wallB, mainBase) - wall.r - base.radiusFP(wallB) / FP;
        check(wallClearanceA >= -.02 && wallClearanceB >= -.02,
          `Ally correction may not push units into a static building (${wallClearanceA}, ${wallClearanceB})`);
        check(wallPerf.collisionSoftPasses === 1, 'Building-pinned crowd receives one allied soft pass');
        results.push({ fixture: 'static-building-wall', clearance: [wallClearanceA, wallClearanceB],
          softPasses: wallPerf.collisionSoftPasses, movedUnits: wallPerf.collisionSoftMovedUnits });

        // A stationary hostile overlap beside the same wall keeps the hard invariant when the wall constrains recovery.
        reset(base);
        const wallEnemyA = spawn(base, 0, 'swordsman', wallX, wallY);
        const wallEnemyB = spawn(base, 1, 'swordsman', wallX, wallY);
        place(wallEnemyA, wallX, wallY); place(wallEnemyB, wallX, wallY);
        startStep(base);
        const wallEnemyPerf = solve(base);
        const wallEnemyDistance = distance(wallEnemyA, wallEnemyB);
        const wallEnemyMinDistance = (base.radiusFP(wallEnemyA) + base.radiusFP(wallEnemyB)) / FP;
        const wallEnemyClearance = [wallEnemyA, wallEnemyB].map(unit =>
          distance(unit, mainBase) - wall.r - base.radiusFP(unit) / FP);
        check(wallEnemyDistance >= wallEnemyMinDistance - .02,
          `Stationary hostile wall overlap must retain hard separation (${wallEnemyDistance} < ${wallEnemyMinDistance})`);
        check(wallEnemyClearance.every(clearance => clearance >= -.02),
          `Stationary hostile recovery may not push into building wall (${wallEnemyClearance})`);
        check(wallEnemyPerf.collisionHardFixCorrections > 0, 'Wall-pinned hostile overlap is handled by the final hard-fix');
        results.push({ fixture: 'stationary-hostile-building-wall', finalDistance: wallEnemyDistance,
          minDistance: wallEnemyMinDistance, clearance: wallEnemyClearance,
          hardFixCorrections: wallEnemyPerf.collisionHardFixCorrections });

        // Zero-motion hostile overlap is repaired by the final hard-fix even without a swept path.
        reset(base);
        const stillHostileA = spawn(base, 0, 'swordsman', centerX, centerY);
        const stillHostileB = spawn(base, 1, 'swordsman', centerX, centerY);
        startStep(base);
        const stillPerf = solve(base);
        const stillDistance = distance(stillHostileA, stillHostileB);
        const stillMinDistance = (base.radiusFP(stillHostileA) + base.radiusFP(stillHostileB)) / FP;
        check(stillDistance >= stillMinDistance - .02, 'Stationary hostile overlap is hard-fixed');
        check(stillPerf.collisionSweptZeroMotionCalls === 1 && stillPerf.collisionHardFixCorrections > 0,
          'Zero relative motion uses the retained stationary SAP safety net');
        results.push({ fixture: 'stationary-hostile-overlap', finalDistance: stillDistance,
          minDistance: stillMinDistance, sweptZeroMotionCalls: stillPerf.collisionSweptZeroMotionCalls,
          hardFixCorrections: stillPerf.collisionHardFixCorrections });

        // Opposing high-speed hostile movement is still swept and cannot pass through.
        reset(base);
        const fastA = spawn(base, 0, 'wildhound', centerX - 180, centerY);
        const fastB = spawn(base, 1, 'wildhound', centerX + 180, centerY);
        startStep(base);
        place(fastA, centerX + 180, centerY); place(fastB, centerX - 180, centerY);
        const fastPerf = solve(base);
        const fastDistance = distance(fastA, fastB), hostileRadii = (base.radiusFP(fastA) + base.radiusFP(fastB)) / FP;
        check(fastDistance >= hostileRadii - .02, `Hostile high-speed sweep must prevent tunneling (${fastDistance} < ${hostileRadii})`);
        check(fastPerf.collisionSweptCalls === 1 && fastPerf.collisionSweptHits > 0,
          'High-speed hostile path is handled by the existing swept contact phase');
        check(fastPerf.collisionHardFixCalls === 1, 'High-speed hostile path still runs one stationary final safety check');
        results.push({ fixture: 'hostile-high-speed-crossing', finalDistance: fastDistance,
          minDistance: hostileRadii, sweptCalls: fastPerf.collisionSweptCalls, sweptHits: fastPerf.collisionSweptHits,
          hardFixCalls: fastPerf.collisionHardFixCalls });
      } finally {
        base.dispose('allied-soft-qa');
      }

      // Separate identical peers prove stable fixed-point ordering and repeatability.
      const leftPeer = create(), rightPeer = create();
      try {
        for (const sim of [leftPeer, rightPeer]) {
          reset(sim);
          const x = sim.world.width * .5, y = sim.world.height * .5;
          for (let i = 0; i < 32; i++) spawn(sim, 0, i % 2 ? 'swordsman' : 'tank', x + (i % 3), y + (i % 5));
          startStep(sim);
          solve(sim);
        }
        sameBytes(stateBytes(leftPeer), stateBytes(rightPeer), 'dense twin peers after soft correction');
        results.push({ fixture: 'deterministic-fixed-point-peer', units: leftPeer.units.length,
          equalStateBytes: true, simVersion: SIM_VERSION });
      } finally {
        leftPeer.dispose('allied-soft-determinism-qa');
        rightPeer.dispose('allied-soft-determinism-qa');
      }
      return results;
    });
    assert.deepEqual(pageErrors, [], 'Application loads without page errors');
    console.log(JSON.stringify({ result, pageErrors }, null, 2));
  } finally {
    if (context) await context.close();
    if (fs.existsSync(resolvedBrowserData)) fs.rmSync(resolvedBrowserData, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
