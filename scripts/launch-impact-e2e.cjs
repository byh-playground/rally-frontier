const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { serveSource, routePinnedSDK } = require('./netcode-qa-module.cjs');

// Fixed imported mission states exercise the production simulation through projectile flight,
// landing, deployment and contact resolution. No simulation method is mocked or replaced.
const root = path.resolve(__dirname, '..');
const htmlPath = path.resolve(process.argv[2] || path.join(root, 'index.html'));
(async () => {
  const server = await serveSource(htmlPath, { observer: 'globalThis.__launchImpactReady=true;' });
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'chromium' });
  const page = await browser.newPage(), pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await routePinnedSDK(page);
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.__launchImpactReady && globalThis.RallyGamekit, null, { timeout: 60000 });
    const result = await page.evaluate(async () => {
      const { StrategySim } = await import(new URL('./src/sim/strategy-sim.js', location.href));
      const { Building } = await import(new URL('./src/sim/entities.js', location.href));
      const { BuildingDefinition } = await import(new URL('./src/definitions/buildings.js', location.href));
      const { NAV_BUILDING_MARGIN } = await import(new URL('./src/definitions/combat-rules.js', location.href));
      const { FP } = await import(new URL('./src/core/config.js', location.href));
      const { LaunchImpact } = await import(new URL('./src/sim/launch-impact.js', location.href));
      const check = (value, message, detail = null) => { if (!value) throw new Error(message + (detail ? ': ' + JSON.stringify(detail) : '')); };
      const rows = [];
      function arena({ wall = false } = {}) {
        const sim = new StrategySim(12345), state = sim.exportState();
        const map = structuredClone(state.mapDescriptor), x = Math.round(map.width / 2), y = Math.round(map.height / 2);
        map.terrain = { layers: [], ramps: [], blockers: wall ? [{ id: 'impact-wall', kind: 'wall', points: [{ x: x + 100, y: y - 1000 }, { x: x + 120, y: y - 1000 }, { x: x + 120, y: y + 1000 }, { x: x + 100, y: y + 1000 }] }] : [], riverPath: [], riverBranches: [], riverPolygon: [], riverBranchPolygons: [], riverHalfWidth: 0, bridges: [] };
        state.mapDescriptor = map; state.units = []; state.projectiles = []; state.capturePoints = [];
        for (const b of state.buildings) { b.x = x + (b.side ? 800 : -800); b.y = y; b.hp = b.maxHp = 100000; }
        state.flags = [{ x, y, forced: false }, { x, y, forced: false }];
        sim.importState(state);
        return { sim, x, y };
      }
      function defender(sim, x, y, side = 1) {
        const u = sim.spawnUnit(side, 'soybean', x, y); u.hp = u.maxHp = 10000;
        return u;
      }
      function shell(sim, x, y, { fromX = x - 600, startX = x - 10, count = 12 } = {}) {
        return sim.spawnProjectile({ id: 'qa-shell-' + (++sim.seq), owner: 'base0', side: 0, type: 'soybean', x: startX, y, launchX: fromX, launchY: y,
          lockedAimX: x, lockedAimY: y, trajectoryPolicy: 'lockedPoint', speed: 750, damage: 1, splash: 100,
          splashUnitDamage: 1, splashBuildingDamage: 1, damageClass: 'area', sourceDamageResolved: true, payload: { type: 'soybean', count } });
      }
      function step(sim, n, visit = () => {}) { for (let i = 0; i < n; i++) { sim.stepSimulation(); visit(sim); } }
      function trace(sim, n) { const out = []; step(sim, n, s => out.push(s.checksum())); return out; }
      function restored(sim) { const copy = new StrategySim(12345); copy.importState(sim.exportState()); check(copy.checksum() === sim.checksum(), 'mid-motion restore checksum'); return copy; }
      function clearOfTerrain(sim, units) {
        for (const u of units.filter(u => u.alive)) check(sim.world.terrain.field.polygonCircleClear(u.x, u.y, sim.unitRadius(u.type) - .03), 'impulse cannot enter wall', { id: u.id, x: u.x, y: u.y });
      }
      function clearOfBuildings(sim, units) {
        for (const u of units.filter(u => u.alive)) for (const b of sim.buildings.filter(b => b.alive !== false)) {
          const required = sim.unitRadius(u.type) + (BuildingDefinition.get(b.type)?.size || 35) + NAV_BUILDING_MARGIN;
          check(Math.hypot(u.x - b.x, u.y - b.y) >= required - .1, 'impulse cannot enter building', { id: u.id, building: b.id, distance: Math.hypot(u.x - b.x, u.y - b.y), required });
        }
      }
      // A soybean bundle opens over several ticks; its twelve soldiers recover on the ground.
      {
        const { sim, x, y } = arena(); shell(sim, x, y); sim.stepSimulation();
        const firstCount = sim.units.filter(u => u.side === 0).length;
        check(firstCount < 12, 'bundle must not instantly materialize its entire squad', { firstCount });
        check(sim.launchDeployments?.length > 0, 'landing leaves pending deployment');
        const copy = restored(sim), a = trace(sim, 100), b = trace(copy, 100);
        check(JSON.stringify(a) === JSON.stringify(b), 'pending deployment and airborne soldiers restore deterministically');
        const squad = sim.units.filter(u => u.side === 0);
        check(squad.length === 12 && squad.every(u => u.alive), 'all twelve soldiers deploy exactly once', { count: squad.length });
        check(squad.every(u => !u.impactMotion || (u.impactMotion.heightFP === 0 && sim.tick >= u.impactMotion.recoverUntilTick)), 'deployed soldiers land and recover');
        clearOfBuildings(sim, squad); rows.push({ scenario: 'bundle opens, deploys and recovers; mid-deployment restore', firstCount, finalCount: squad.length, checksum: sim.checksum() });
      }
      // Center impact launches a defender farther/higher than a defender near the splash edge.
      {
        const { sim, x, y } = arena(), center = defender(sim, x + 30, y), edge = defender(sim, x + 90, y);
        shell(sim, x, y, { count: 0 });
        const initial = [center.x, edge.x], peaks = [0, 0], maxTravel = [0, 0]; let airborneCopy, edgeShoved = false;
        step(sim, 20, s => { edgeShoved ||= edge.impactMotion?.kind === 'knockback' && edge.impactMotion.vxFP > 0; [center, edge].forEach((u, i) => { peaks[i] = Math.max(peaks[i], u.impactMotion?.heightFP || 0); maxTravel[i] = Math.max(maxTravel[i], u.x - initial[i]); }); if(s.tick === 2) { check(center.impactMotion?.heightFP > 0, 'checkpoint is captured during actual flight'); airborneCopy = restored(s); } });
        check(peaks[0] > 0 && maxTravel[0] > 5, 'center defender is physically launched and displaced', { peaks, maxTravel });
        check(edgeShoved, 'edge defender receives a real outward shove');
        check(maxTravel[0] > maxTravel[1], 'center impulse exceeds edge shove', { maxTravel });
        check(peaks[0] > peaks[1], 'center launch exceeds edge lift', { peaks });
        step(airborneCopy, 18); check(airborneCopy.checksum() === sim.checksum(), 'airborne checkpoint preserves impulse integration'); check(JSON.stringify(trace(sim, 60)) === JSON.stringify(trace(airborneCopy, 60)), 'knockback restore follows same trajectory');
        check(!center.impactMotion || center.impactMotion.heightFP === 0, 'launched defender returns to ground');
        rows.push({ scenario: 'center launch versus edge shove', peaks, maxTravel, checksum: sim.checksum() });
      }
      // Contact solvers must clip blast impulses against a wall and a building, rather than teleporting through.
      for (const obstacle of ['wall', 'building']) {
        const { sim, x, y } = arena({ wall: obstacle === 'wall' });
        if (obstacle === 'building') { sim.buildings.push(new Building({ id: 'impact-outpost', type: 'outpost', side: 1, x: x + 170, y, hp: 100000, maxHp: 100000, alive: true })); sim.rebuildRuntimeIndexes(); }
        const u = defender(sim, x + 65, y); shell(sim, x + 15, y, { count: 0 });
        let moved = false, previous = u.x;
        step(sim, 15, () => { moved ||= Math.abs(u.x - previous) > .01; previous = u.x; clearOfTerrain(sim, [u]); clearOfBuildings(sim, [u]); });
        check(moved, obstacle + ': blast actually attempts movement'); rows.push({ scenario: 'impact clipped by ' + obstacle, x: u.x, y: u.y });
      }
      // A blast-driven enemy cannot cross a friendly body; the friendly receives no blast impulse.
      {
        const { sim, x, y } = arena(), enemy = defender(sim, x + 30, y), ally = defender(sim, x + 90, y, 0);
        shell(sim, x, y, { count: 0 }); let minimumGap = Infinity, observedImpulse = false;
        step(sim, 15, () => {
          observedImpulse ||= !!enemy.impactMotion;
          const gap = Math.hypot(enemy.x - ally.x, enemy.y - ally.y) - (sim.radiusFP(enemy) + sim.radiusFP(ally)) / FP;
          minimumGap = Math.min(minimumGap, gap);
          check(gap >= -.05, 'blast-driven hostile bodies remain nonpenetrating', { gap, enemy: [enemy.x, enemy.y], ally: [ally.x, ally.y] });
          check(!ally.impactMotion || ally.impactMotion.kind !== 'knockback', 'friendly unit does not receive friendly blast impulse');
        });
        check(observedImpulse, 'contact scenario exercises a real blast impulse'); rows.push({ scenario: 'hostile contact and friendly blast policy', minimumGap });
      }
      // An enemy standing under the high part of an arc is passed; one near the low approach causes contact.
      for (const altitude of ['high', 'low']) {
        const { sim, x, y } = arena(), victimX = altitude === 'high' ? x - 300 : x - 5;
        const u = defender(sim, victimX, y); shell(sim, x, y, { startX: altitude === 'high' ? victimX - 30 : x - 25, count: 0 });
        const initialHP = u.hp; sim.stepSimulation();
        if (altitude === 'high') check(sim.projectiles.length === 1 && u.hp === initialHP && !u.impactMotion, 'high arc passes over a grounded unit');
        else check(sim.projectiles.length === 0 && u.impactMotion?.sourceId, 'low approach directly hits instead of crossing a unit', { projectiles: sim.projectiles.length, unit: u.toState() });
        rows.push({ scenario: altitude + ' arc contact', projectiles: sim.projectiles.length, hp: u.hp });
      }
      // Planar overlap alone is not a hit: a low shell passes below an airborne body's bottom.
      {
        const contacts = [];
        for (const bottom of [100, 0]) {
          const { sim, x, y } = arena(), victim = defender(sim, x - 5, y);
          if (bottom) victim.impactMotion = { kind: 'knockback', startTick: 0, endTick: 40, recoverUntilTick: 45, heightFP: bottom * FP, vzFP: 0, vxFP: 0, vyFP: 0, originX: victim.x, originY: victim.y, sourceId: 'qa-existing-flight' };
          shell(sim, x, y, { startX: x - 17, count: 0 });
          const shot = sim.projectiles.at(-1), projectileHeight = LaunchImpact.projectileHeight(sim, shot, shot.x, shot.y);
          check(projectileHeight >= 18 && projectileHeight <= 22, 'underflight fixture actually places the shell near height twenty', { projectileHeight });
          sim.stepSimulation();
          const impact = sim.events.find(e => e.type === 'launchImpact');
          check(impact, 'low projectile reaches its landing point in the height-slab scenario');
          if (bottom) check(impact.directHitId !== victim.id, 'a roughly twenty-high shell must pass below the airborne body bottom at one hundred', { directHitId: impact.directHitId, victim: victim.id, bottom });
          else check(impact.directHitId === victim.id, 'the same shell directly hits a body occupying its height interval', { directHitId: impact.directHitId, victim: victim.id });
          contacts.push({ bodyBottom: bottom, projectileHeight, directHitId: impact.directHitId });
        }
        rows.push({ scenario: 'vertical body slab rejects underflight and accepts matching-height contact', contacts });
      }
      // Even a one-unit-wide raised floor is solid to a low shot, while an arc above it passes.
      {
        const contacts = [];
        for (const altitude of ['low', 'high']) {
          const { sim, x, y } = arena(), state = sim.exportState(), ridgeX = x - (altitude === 'low' ? 55 : 300);
          state.mapDescriptor = structuredClone(state.mapDescriptor);
          state.mapDescriptor.terrain.layers = [{ id: 'thin-raised-floor', level: 2, points: [{ x: ridgeX, y: y - 80 }, { x: ridgeX + 1, y: y - 80 }, { x: ridgeX + 1, y: y + 80 }, { x: ridgeX, y: y + 80 }] }];
          sim.importState(state); shell(sim, x, y, { startX: altitude === 'low' ? x - 80 : x - 330, count: altitude === 'low' ? 12 : 0 });
          const shot = sim.projectiles.at(-1); sim.stepSimulation();
          const impact = sim.events.find(e => e.type === 'launchImpact');
          if (altitude === 'low') {
            check(impact?.directHitId === 'thin-raised-floor', 'low shot hits the thin raised floor before crossing it', { impact });
            const expectedHeightFP = Math.round(LaunchImpact.projectileHeight(sim, shot, impact.x, impact.y) * FP);
            check(Math.abs(impact.impactHeightFP - expectedHeightFP) <= 3 && impact.impactHeightFP < 96 * FP, 'cliff-face contact keeps actual projectile altitude instead of teleporting to plateau height', { actual: impact.impactHeightFP, expected: expectedHeightFP });
            check(impact.x <= ridgeX - 1 / FP + .001 && impact.x >= ridgeX - 2 / FP - .001, 'cliff contact stays one fixed-point step outside the raised floor', { impactX: impact.x, ridgeX });
            const packet = sim.launchDeployments[0];
            check(packet && Math.round(sim.world.terrain.surfaces.heightAt(packet.x, packet.y) * FP) + packet.heightFP === impact.impactHeightFP, 'cliff-face packet starts at actual contact height');
            let released = 0; const packetHeights = [packet.heightFP];
            const observeReleases = world => {
              for (const group of world.launchDeployments) packetHeights.push(group.heightFP);
              for (const event of world.events.filter(e => e.type === 'launchLand')) for (const id of event.unitIds) {
                const birth = event.units.find(unit => unit.id === id);
                check(birth && birth.x < ridgeX, 'a packet below the ridge cannot instantly release a soldier on the opposite side', { birth, ridgeX });
                const unit = world.units.find(u => u.id === id), floorFP = Math.round(world.world.terrain.surfaces.heightAt(unit.x, unit.y) * FP); released++;
                check(floorFP <= event.impactHeightFP && event.impactHeightFP < 96 * FP, 'cliff-face soldier releases below the plateau without a height jump', { floorFP, height: event.impactHeightFP });
                check(floorFP + unit.impactMotion.heightFP === event.impactHeightFP, 'cliff-face soldier and falling packet share the same release altitude');
              }
            };
            observeReleases(sim); step(sim, 100, observeReleases);
            check(released === 12 && sim.launchDeployments.length === 0, 'cliff-face packet finds safe space and releases every soldier', { released, pending: sim.launchDeployments.length });
            check(packetHeights.some(height => height < packetHeights[0]), 'cliff-face packet falls from contact altitude before emptying');
          } else check(!impact && sim.projectiles.length === 1, 'high arc crosses the same thin raised floor without impact');
          contacts.push({ altitude, directHitId: impact?.directHitId || null, impactHeightFP: impact?.impactHeightFP || null });
        }
        rows.push({ scenario: 'thin raised terrain catches low shots and allows high arcs', contacts });
      }
      // An airborne direct hit opens its packet at contact height; pending and released grains stay continuous.
      {
        const { sim, x, y } = arena(), victim = defender(sim, x - 100, y);
        victim.impactMotion = { kind: 'knockback', startTick: 0, endTick: 40, recoverUntilTick: 45, heightFP: 100 * FP, vzFP: 0, vxFP: 0, vyFP: 0, originX: victim.x, originY: victim.y, sourceId: 'qa-existing-flight' };
        shell(sim, x, y, { startX: x - 130 }); sim.stepSimulation();
        const impact = sim.events.find(e => e.type === 'launchImpact'), first = sim.events.find(e => e.type === 'launchLand');
        check(impact?.directHitId === victim.id && impact.impactHeightFP > 90 * FP, 'direct hit records actual airborne contact height', { impact });
        check(first?.impactHeightFP === impact.impactHeightFP, 'first released soldier starts at packet contact height', { impact, first });
        const born = sim.units.find(u => u.id === first.unitIds[0]);
        check(Math.round(sim.world.terrain.surfaces.heightAt(born.x, born.y) * FP) + born.impactMotion.heightFP === impact.impactHeightFP, 'released soldier authority height matches airborne packet');
        const group = sim.launchDeployments[0], firstHeight = group.heightFP;
        check(group.heightFP + Math.round(sim.world.terrain.surfaces.heightAt(group.x, group.y) * FP) === impact.impactHeightFP, 'pending packet retains relative contact height');
        const copy = restored(sim), a = [], b = [], heights = [firstHeight];
        step(sim, 100, world => {
          a.push(world.checksum()); if (world.launchDeployments.length) heights.push(world.launchDeployments[0].heightFP);
          for (const event of world.events.filter(e => e.type === 'launchLand')) for (const id of event.unitIds) { const unit = world.units.find(u => u.id === id); check(unit && Math.round(world.world.terrain.surfaces.heightAt(unit.x, unit.y) * FP) + unit.impactMotion.heightFP === event.impactHeightFP, 'each later release uses current falling packet height'); }
        });
        step(copy, 100, world => b.push(world.checksum())); check(JSON.stringify(a) === JSON.stringify(b), 'airburst packet falling and release queue restore exactly');
        check(heights.some(height => height < firstHeight), 'remaining packet physically falls after airborne contact');
        check(sim.units.filter(u => u.side === 0).length === 12, 'airburst releases its complete squad');
        rows.push({ scenario: 'airborne impact preserves packet and released soldier height', impactHeightFP: impact.impactHeightFP, firstHeight, lowestPendingHeight: Math.min(...heights), checksum: sim.checksum() });
      }
      // A ground burst cannot damage or re-launch a body far above its three-dimensional reach.
      {
        const contacts = [];
        for (const bottom of [300, 0]) {
          const { sim, x, y } = arena(), victim = defender(sim, x + 30, y);
          if (bottom) victim.impactMotion = { kind: 'knockback', startTick: 0, endTick: 40, recoverUntilTick: 45, heightFP: bottom * FP, vzFP: 0, vxFP: 0, vyFP: 0, originX: victim.x, originY: victim.y, sourceId: 'qa-existing-flight' };
          const hp = victim.hp; shell(sim, x, y, { count: 0 }); sim.stepSimulation();
          if (bottom) check(victim.hp === hp && victim.impactMotion.sourceId === 'qa-existing-flight' && victim.impactMotion.vxFP === 0 && victim.impactMotion.vyFP === 0, 'ground burst misses the vertically separated body in both damage and impulse');
          else check(victim.hp < hp && victim.impactMotion?.sourceId !== 'qa-existing-flight', 'overlapping ground body receives both blast damage and impulse');
          contacts.push({ bodyBottom: bottom, hpLost: hp - victim.hp, sourceId: victim.impactMotion?.sourceId });
        }
        rows.push({ scenario: 'blast damage and impulse share three-dimensional body distance', contacts });
      }
      // Lethal damage ends combat immediately, while the corpse completes its physical trajectory.
      {
        const { sim, x, y } = arena(), victim = defender(sim, x + 30, y), observer = defender(sim, x - 200, y, 0);
        victim.hp = 1; observer.target = victim.id; shell(sim, x, y, { count: 0 }); sim.stepSimulation();
        check(!victim.alive && victim.hp <= 0, 'lethal shell immediately ends target life');
        check(sim.units.some(u => u.id === victim.id) && victim.impactMotion, 'lethal shell preserves a flying corpse until its motion finishes');
        const initialHeight = victim.impactMotion.heightFP; sim.stepSimulation();
        check(victim.impactMotion?.heightFP > initialHeight, 'dead victim continues rising after the lethal tick');
        check(observer.target !== victim.id, 'combat stops targeting the dead victim on the next authority update');
        const copy = restored(sim), a = trace(sim, 100), b = trace(copy, 100);
        check(JSON.stringify(a) === JSON.stringify(b), 'flying corpse restores with the same authority trajectory');
        check(!sim.units.some(u => u.id === victim.id), 'finished corpse is removed by scheduled cleanup');
        rows.push({ scenario: 'lethal impact keeps corpse motion, ends targeting, restores and cleans up', initialHeight, checksum: sim.checksum() });
      }
      // A sealed landing area must retain the entire squad instead of silently losing it after a timeout.
      {
        const { sim, x, y } = arena(), sealed = sim.exportState();
        sealed.mapDescriptor = structuredClone(sealed.mapDescriptor);
        sealed.mapDescriptor.terrain.blockers = [{ id: 'sealed-landing', kind: 'wall', points: [{ x: x - 1000, y: y - 1000 }, { x: x + 1000, y: y - 1000 }, { x: x + 1000, y: y + 1000 }, { x: x - 1000, y: y + 1000 }] }];
        sim.importState(sealed); shell(sim, x, y); step(sim, sim.msTicks(2000));
        const pending = () => sim.launchDeployments.reduce((total, group) => total + group.count - group.index, 0);
        check(sim.units.length === 0 && pending() === 12, 'two seconds of blocked terrain preserves all twelve pending soldiers', { units: sim.units.length, pending: pending() });
        const before = sim.checksum(), view = sim.snapshot();
        check(view.launchDeployments?.length > 0, 'snapshot exposes the pending landing bundle');
        view.launchDeployments[0].index = view.launchDeployments[0].count; view.launchDeployments[0].x += 500;
        check(sim.checksum() === before && pending() === 12, 'mutating a snapshot cannot change authority deployment queue');
        const copy = restored(sim);
        for (const world of [sim, copy]) { const open = world.exportState(); open.mapDescriptor = structuredClone(open.mapDescriptor); open.mapDescriptor.terrain.blockers = []; world.importState(open); }
        check(JSON.stringify(trace(sim, 100)) === JSON.stringify(trace(copy, 100)), 'blocked queue restores and retries deterministically after opening terrain');
        check(sim.units.filter(u => u.side === 0).length === 12 && pending() === 0, 'opening space releases every preserved soldier exactly once');
        rows.push({ scenario: 'blocked deployment retains squad, snapshot is isolated, opening terrain releases all', finalCount: sim.units.length, checksum: sim.checksum() });
      }
      // Identical mission inputs repeat exactly, including in-flight checkpoint restoration.
      const repeat = () => { const { sim, x, y } = arena(); defender(sim, x + 30, y); shell(sim, x, y, { startX: x - 600 }); step(sim, 4); const copy = restored(sim); const a = trace(sim, 140), b = trace(copy, 140); check(JSON.stringify(a) === JSON.stringify(b), 'mid-flight restoration'); return a; };
      check(JSON.stringify(repeat()) === JSON.stringify(repeat()), 'fixed seed and inputs repeat exactly');
      rows.push({ scenario: 'in-flight restore and repeated fixed input', pass: true });
      return { seed: 12345, rows };
    });
    assert.deepEqual(pageErrors, [], 'scenario browser page errors');
    const output = path.join(root, '.qa', 'launch-impact'); fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ pass: true, ...result }, null, 2));
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
