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
    const server = await serveSource(htmlPath, {
        observer: 'globalThis.__launchImpactReady=true;',
    });
    const browser = await chromium.launch({
        channel: process.env.QA_BROWSER_CHANNEL || 'chromium',
    });
    const page = await browser.newPage(),
        pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    try {
        await routePinnedSDK(page);
        await page.goto(server.url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
            () => globalThis.__launchImpactReady && globalThis.RallyGamekit,
            null,
            { timeout: 60000 },
        );
        const result = await page.evaluate(async () => {
            const { StrategySim } = await import(
                new URL('./src/sim/strategy-sim.js', location.href)
            );
            const { Building } = await import(new URL('./src/sim/entities.js', location.href));
            const { BuildingDefinition } = await import(
                new URL('./src/definitions/buildings.js', location.href)
            );
            const { NAV_BUILDING_MARGIN } = await import(
                new URL('./src/definitions/combat-rules.js', location.href)
            );
            const { FP } = await import(new URL('./src/core/config.js', location.href));
            const { LaunchImpact } = await import(
                new URL('./src/sim/launch-impact.js', location.href)
            );
            const { LaunchImpactRules } = await import(
                new URL('./src/definitions/launch-impact-rules.js', location.href)
            );
            const check = (value, message, detail = null) => {
                if (!value)
                    throw new Error(message + (detail ? ': ' + JSON.stringify(detail) : ''));
            };
            const rows = [];
            function arena({ wall = false } = {}) {
                const sim = new StrategySim(12345),
                    state = sim.exportState();
                const map = structuredClone(state.mapDescriptor),
                    x = Math.round(map.width / 2),
                    y = Math.round(map.height / 2);
                map.terrain = {
                    layers: [],
                    ramps: [],
                    blockers: wall
                        ? [
                              {
                                  id: 'impact-wall',
                                  kind: 'wall',
                                  points: [
                                      { x: x + 100, y: y - 1000 },
                                      { x: x + 120, y: y - 1000 },
                                      { x: x + 120, y: y + 1000 },
                                      { x: x + 100, y: y + 1000 },
                                  ],
                              },
                          ]
                        : [],
                    riverPath: [],
                    riverBranches: [],
                    riverPolygon: [],
                    riverBranchPolygons: [],
                    riverHalfWidth: 0,
                    bridges: [],
                };
                state.mapDescriptor = map;
                state.units = [];
                state.projectiles = [];
                state.capturePoints = [];
                for (const b of state.buildings) {
                    b.x = x + (b.side ? 800 : -800);
                    b.y = y;
                    b.hp = b.maxHp = 100000;
                }
                state.flags = [
                    { x, y, forced: false },
                    { x, y, forced: false },
                ];
                sim.importState(state);
                return { sim, x, y };
            }
            function defender(sim, x, y, side = 1) {
                const u = sim.spawnUnit(side, 'pea', x, y);
                u.hp = u.maxHp = 10000;
                return u;
            }
            function shell(sim, x, y, { fromX = x - 600, startX = x - 10, count = 12 } = {}) {
                return sim.spawnProjectile({
                    id: 'qa-shell-' + ++sim.seq,
                    owner: 'base0',
                    side: 0,
                    type: 'pea',
                    x: startX,
                    y,
                    launchX: fromX,
                    launchY: y,
                    lockedAimX: x,
                    lockedAimY: y,
                    trajectoryPolicy: 'lockedPoint',
                    speed: 750,
                    damage: 1,
                    splash: 100,
                    splashUnitDamage: 1,
                    splashBuildingDamage: 1,
                    damageClass: 'area',
                    sourceDamageResolved: true,
                    payload: { type: 'pea', count },
                });
            }
            function step(sim, n, visit = () => {}) {
                for (let i = 0; i < n; i++) {
                    sim.stepSimulation();
                    visit(sim);
                }
            }
            function trace(sim, n) {
                const out = [];
                step(sim, n, (s) => out.push(s.checksum()));
                return out;
            }
            function restored(sim) {
                const copy = new StrategySim(12345);
                copy.importState(sim.exportState());
                check(copy.checksum() === sim.checksum(), 'mid-motion restore checksum');
                return copy;
            }
            {
                function fight(type) {
                    const { sim, x, y } = arena();
                    const source = sim.spawnUnit(0, type, x - 120, y);
                    const target = defender(sim, x, y);
                    target.combat.cooldownUntil = sim.tick + 3 * sim.tps;
                    const landings = [];
                    let apex = 0;
                    let checkpoint;
                    for (let i = 0; i < 28; i++) {
                        sim.stepSimulation();
                        apex = Math.max(apex, (source.impactMotion?.heightFP || 0) / FP);
                        if (!checkpoint && apex > 0 && type === 'popcorn')
                            checkpoint = restored(sim);
                        else if (checkpoint) {
                            checkpoint.stepSimulation();
                            check(
                                checkpoint.checksum() === sim.checksum(),
                                'popcorn leap restores through detonation',
                            );
                        }
                        for (const event of sim.events) {
                            if (event.sourceId !== source.id) continue;
                            if (event.type === 'unitSelfDestruct' || event.type === 'leapLand')
                                landings.push({
                                    type: event.type,
                                    tick: sim.tick,
                                    height: source.impactMotion?.heightFP || 0,
                                });
                        }
                    }
                    return { apex, landings, alive: source.alive, damage: 10000 - target.hp };
                }

                const redbean = fight('redbean');
                const popcorn = fight('popcorn');
                const ratio = popcorn.apex / redbean.apex;
                check(
                    ratio >= 0.45 && ratio <= 0.55,
                    'popcorn jumps to about half the redbean height',
                    { popcorn, redbean, ratio },
                );
                check(
                    popcorn.landings.length === 1 &&
                        popcorn.landings[0].type === 'unitSelfDestruct' &&
                        popcorn.landings[0].height === 0 &&
                        !popcorn.alive &&
                        popcorn.damage === 15 &&
                        redbean.landings[0]?.type === 'leapLand',
                    'landing deals one popcorn blast and keeps the redbean shockwave',
                    { popcorn, redbean },
                );

                const { sim, x, y } = arena();
                const airborne = sim.spawnUnit(0, 'popcorn', x - 120, y);
                defender(sim, x, y);
                for (let i = 0; i < 10 && !airborne.impactMotion?.heightFP; i++)
                    sim.stepSimulation();
                check(
                    airborne.impactMotion?.heightFP > 0,
                    'popcorn is airborne before being killed',
                );
                sim.emitUnitDeath(airborne, 1, 'pea');
                step(sim, 20, (s) =>
                    check(
                        !s.events.some(
                            (event) =>
                                event.type === 'unitSelfDestruct' && event.sourceId === airborne.id,
                        ),
                        'popcorn killed before touchdown cannot explode',
                    ),
                );
                const close = arena();
                const grounded = close.sim.spawnUnit(0, 'popcorn', close.x - 25, close.y);
                const closeTarget = defender(close.sim, close.x, close.y);
                closeTarget.combat.cooldownUntil = close.sim.tick + 3 * close.sim.tps;
                for (let i = 0; i < 10 && !grounded.selfDestruct; i++) close.sim.stepSimulation();
                check(
                    grounded.selfDestruct?.phase === 'windup' &&
                        grounded.selfDestruct.endTick - close.sim.tick === close.sim.tps,
                    'close enemies still trigger the original one-second ground fuse',
                );
                step(close.sim, close.sim.tps);
                check(
                    close.sim.events.filter(
                        (event) =>
                            event.type === 'unitSelfDestruct' && event.sourceId === grounded.id,
                    ).length === 1,
                    'the ground fuse detonates once',
                );
                rows.push({
                    scenario: 'popcorn leaps at half height and detonates on touchdown',
                    popcorn,
                    redbean,
                    ratio,
                });
            }
            function clearOfTerrain(sim, units) {
                for (const u of units.filter((u) => u.alive))
                    check(
                        sim.world.terrain.field.polygonCircleClear(
                            u.x,
                            u.y,
                            sim.unitRadius(u.type) - 0.03,
                        ),
                        'impulse cannot enter wall',
                        { id: u.id, x: u.x, y: u.y },
                    );
            }
            function clearOfBuildings(sim, units) {
                for (const u of units.filter((u) => u.alive))
                    for (const b of sim.buildings.filter((b) => b.alive !== false)) {
                        const required =
                            sim.unitRadius(u.type) +
                            (BuildingDefinition.get(b.type)?.size || 35) +
                            NAV_BUILDING_MARGIN;
                        check(
                            Math.hypot(u.x - b.x, u.y - b.y) >= required - 0.1,
                            'impulse cannot enter building',
                            {
                                id: u.id,
                                building: b.id,
                                distance: Math.hypot(u.x - b.x, u.y - b.y),
                                required,
                            },
                        );
                    }
            }
            // Two real shell shocks must add momentum; an opposite shock must cancel instead of replacing it.
            {
                const run = (directions) => {
                    const { sim, x, y } = arena(),
                        u = defender(sim, x + 30, y);
                    for (const [i, direction] of directions.entries())
                        LaunchImpact.blast(
                            sim,
                            { id: 'impulse-hit-' + i, side: 0 },
                            direction > 0 ? x : x + 60,
                            y,
                            100,
                            0,
                        );
                    const before = u.x;
                    sim.stepSimulation();
                    const measured = {
                        travel: u.x - before,
                        vxFP: u.impactMotion?.vxFP || 0,
                        peakHeightFP: u.impactMotion?.heightFP || 0,
                    };
                    step(sim, 8, () => {
                        measured.peakHeightFP = Math.max(
                            measured.peakHeightFP,
                            u.impactMotion?.heightFP || 0,
                        );
                    });
                    return measured;
                };
                const single = run([1]),
                    doubled = run([1, 1]),
                    cancelled = run([1, -1]);
                check(
                    single.travel > 0 && doubled.travel > single.travel * 1.5,
                    'two same-direction hits add momentum instead of replacing the first velocity',
                    { single, doubled },
                );
                check(
                    doubled.peakHeightFP > single.peakHeightFP * 1.5,
                    'repeated shocks also add vertical momentum instead of taking the larger lift',
                    { single, doubled },
                );
                check(
                    Math.abs(cancelled.travel) < single.travel / 4,
                    'equal opposite hits cancel horizontal momentum instead of overwriting its direction',
                    { single, cancelled },
                );
                rows.push({
                    scenario: 'repeated shell shocks add and opposing shocks cancel',
                    single,
                    doubled,
                    cancelled,
                });
            }
            // Identical impulses change velocity by inverse mass without teleporting either soldier.
            {
                const measurements = [];
                for (const type of ['rice', 'pea']) {
                    const { sim, x, y } = arena(),
                        u = sim.spawnUnit(1, type, x, y);
                    u.hp = u.maxHp = 10000;
                    const initial = [u.x, u.y],
                        impulse = 22500;
                    sim.navigation.motion.applyImpulse(
                        u,
                        { x: impulse, y: 0, z: 0 },
                        { sourceId: 'equal-impulse', originX: x - 10, originY: y },
                    );
                    check(
                        u.x === initial[0] && u.y === initial[1],
                        'applying an impulse changes momentum without moving the body immediately',
                        { type },
                    );
                    const mass = sim.mass(u),
                        vxFP = u.impactMotion.vxFP;
                    sim.stepSimulation();
                    check(
                        u.x > initial[0],
                        'the physics step integrates impulse velocity into actual movement',
                        { type },
                    );
                    measurements.push({ type, mass, vxFP, travel: u.x - initial[0] });
                }
                const [light, heavy] = measurements;
                check(
                    light.mass < heavy.mass && light.vxFP > heavy.vxFP,
                    'the same impulse accelerates the lighter body more',
                );
                check(
                    Math.abs(light.vxFP * light.mass - heavy.vxFP * heavy.mass) <=
                        Math.max(light.mass, heavy.mass),
                    'the same impulse produces equal mass-weighted velocity change',
                    { measurements },
                );
                check(
                    Math.abs(light.travel * light.mass - heavy.travel * heavy.mass) <=
                        Math.max(light.mass, heavy.mass) * 0.05,
                    'inverse mass appears in actual integrated displacement',
                    { measurements },
                );
                rows.push({
                    scenario: 'identical impulse changes velocity and movement by inverse mass',
                    measurements,
                });
            }
            // A wall removes only inward normal velocity; the same body keeps sliding along the wall.
            {
                const { sim, x, y } = arena({ wall: true }),
                    u = defender(sim, x + 70, y),
                    mass = sim.mass(u),
                    beforeY = u.y;
                sim.navigation.motion.applyImpulse(
                    u,
                    { x: 300 * mass, y: 100 * mass, z: 0 },
                    { sourceId: 'oblique-wall-hit', originX: x, originY: y },
                );
                let contact = null;
                step(sim, 8, () => {
                    clearOfTerrain(sim, [u]);
                    if (!contact && u.x >= x + 100 - sim.unitRadius(u.type) - 0.5)
                        contact = {
                            vxFP: u.impactMotion?.vxFP || 0,
                            vyFP: u.impactMotion?.vyFP || 0,
                            x: u.x,
                            y: u.y,
                        };
                });
                check(
                    contact && contact.vxFP <= 0 && contact.vyFP > 0,
                    'wall contact resolves normal momentum while retaining tangential momentum',
                    { contact },
                );
                check(
                    u.y > beforeY + 5 && u.x <= x + 100 - sim.unitRadius(u.type) + 0.03,
                    'the soldier physically slides without entering the wall',
                );
                rows.push({
                    scenario: 'oblique impulse slides with normal velocity resolved',
                    contact,
                    final: [u.x, u.y],
                });
            }
            // A moving hostile body transfers momentum to the struck body rather than merely clipping its own position.
            {
                const { sim, x, y } = arena(),
                    moving = defender(sim, x - 40, y),
                    struck = defender(sim, x + 15, y, 0),
                    initialX = struck.x;
                sim.navigation.motion.applyImpulse(
                    moving,
                    { x: 400 * sim.mass(moving), y: 0, z: 0 },
                    { sourceId: 'body-contact-shot', originX: x - 100, originY: y },
                );
                let transmitted = false,
                    minimumGap = Infinity;
                step(sim, 12, () => {
                    const gap =
                        Math.hypot(moving.x - struck.x, moving.y - struck.y) -
                        sim.unitRadius(moving.type) -
                        sim.unitRadius(struck.type);
                    minimumGap = Math.min(minimumGap, gap);
                    check(
                        gap >= -0.05,
                        'momentum-transferring hostile bodies remain nonpenetrating',
                        { gap },
                    );
                    transmitted ||=
                        struck.impactMotion?.sourceId === moving.id && struck.impactMotion.vxFP > 0;
                });
                check(
                    transmitted && struck.x > initialX + 1,
                    'contact transfers observable momentum and actual movement to the struck body',
                    { transmitted, initialX, finalX: struck.x },
                );
                rows.push({
                    scenario: 'hostile body contact transfers momentum and remains nonpenetrating',
                    minimumGap,
                    finalStruckX: struck.x,
                });
            }
            // A checkpoint during overlapping impulses must preserve accumulated momentum, not recreate a one-shot push.
            {
                const { sim, x, y } = arena(),
                    u = defender(sim, x, y),
                    mass = sim.mass(u);
                sim.navigation.motion.applyImpulse(
                    u,
                    { x: 100 * mass, y: 50 * mass, z: 150 * mass },
                    { sourceId: 'first-shock', originX: x - 10, originY: y },
                );
                step(sim, 2);
                sim.navigation.motion.applyImpulse(
                    u,
                    { x: -25 * mass, y: 75 * mass, z: 100 * mass },
                    { sourceId: 'second-shock', originX: x, originY: y - 10 },
                );
                const copy = restored(sim),
                    before = { ...u.impactMotion };
                check(
                    JSON.stringify(trace(sim, 100)) === JSON.stringify(trace(copy, 100)),
                    'overlapping impulse checkpoint restores the exact future trajectory',
                );
                rows.push({
                    scenario: 'overlapping impulse checkpoint preserves future trajectory',
                    before,
                    checksum: sim.checksum(),
                });
            }
            // The deployment's ejection impulse is applied once, not once as inherited velocity and again as a new kick.
            {
                const { sim, x, y } = arena();
                sim.spawnProjectile({
                    id: 'single-rice-ejection',
                    owner: 'base0',
                    side: 0,
                    type: 'rice',
                    x: x - 10,
                    y,
                    launchX: x - 600,
                    launchY: y,
                    lockedAimX: x,
                    lockedAimY: y,
                    trajectoryPolicy: 'lockedPoint',
                    speed: 750,
                    damage: 1,
                    splash: 100,
                    splashUnitDamage: 1,
                    splashBuildingDamage: 1,
                    damageClass: 'area',
                    sourceDamageResolved: true,
                    payload: { type: 'rice', count: 1 },
                });
                sim.stepSimulation();
                const event = sim.events.find((e) => e.type === 'launchLand'),
                    u = sim.units.find((u) => u.id === event?.unitIds[0]);
                check(u && sim.mass(u) === 100, 'ejection fixture uses the reference-mass soldier');
                check(
                    u.impactMotion?.vzFP ===
                        ((LaunchImpactRules.referenceMass * LaunchImpactRules.deploymentLift) /
                            sim.mass(u)) *
                            FP,
                    'ground packet gives exactly one authored ejection impulse',
                    { vzFP: u.impactMotion?.vzFP },
                );
                rows.push({
                    scenario: 'deployment applies exactly one vertical ejection impulse',
                    vzFP: u.impactMotion.vzFP,
                });
            }
            // An earlier body contact stops the original sweep; a later candidate must not receive a ghost impulse.
            {
                const { sim, x, y } = arena(),
                    a = sim.spawnUnit(1, 'rice', x - 100, y),
                    radius = sim.unitRadius('rice') + sim.unitRadius('pea');
                a.hp = a.maxHp = 10000;
                const b = defender(sim, a.x + radius + 5, y, 0),
                    c = defender(sim, a.x + radius + 55, y, 0);
                for (const u of [b, c])
                    u.impactMotion = {
                        kind: 'knockback',
                        startTick: 0,
                        endTick: 100,
                        recoverUntilTick: 101,
                        heightFP: 0,
                        vzFP: 0,
                        vxFP: 0,
                        vyFP: 0,
                        originX: u.x,
                        originY: u.y,
                        sourceId: 'existing-rest-state',
                    };
                const beforeC = [c.x, c.y];
                sim.navigation.motion.applyImpulse(
                    a,
                    { x: 600 * sim.mass(a), y: 0, z: 0 },
                    { sourceId: 'first-body-shot', originX: a.x, originY: y },
                );
                sim.stepSimulation();
                check(
                    b.impactMotion.vxFP > 0,
                    'first reachable body receives actual contact momentum',
                );
                const gapBC =
                    Math.hypot(b.x - c.x, b.y - c.y) -
                    sim.unitRadius(b.type) -
                    sim.unitRadius(c.type);
                check(
                    gapBC > 0.1,
                    'the struck body has not physically reached the later body in this tick',
                    { gapBC },
                );
                check(
                    c.impactMotion.vxFP === 0 &&
                        c.impactMotion.vyFP === 0 &&
                        c.x === beforeC[0] &&
                        c.y === beforeC[1],
                    'a later unreachable candidate receives neither ghost momentum nor movement',
                    {
                        velocity: [c.impactMotion.vxFP, c.impactMotion.vyFP],
                        beforeC,
                        afterC: [c.x, c.y],
                    },
                );
                rows.push({
                    scenario: 'first body contact excludes unreachable later candidates',
                    gapBC,
                    velocityC: [c.impactMotion.vxFP, c.impactMotion.vyFP],
                });
            }
            // A collision within one tick integrates the post-impact velocities through the tick's remaining time.
            {
                const { sim, x, y } = arena(),
                    a = sim.spawnUnit(1, 'rice', x - 100, y),
                    radius = sim.unitRadius('rice') + sim.unitRadius('pea');
                a.hp = a.maxHp = 10000;
                const b = defender(sim, a.x + radius + 10, y, 0),
                    startA = a.x,
                    startB = b.x,
                    speed = 600,
                    dt = 1 / sim.tps;
                b.impactMotion = {
                    kind: 'knockback',
                    startTick: 0,
                    endTick: 100,
                    recoverUntilTick: 101,
                    heightFP: 0,
                    vzFP: 0,
                    vxFP: 0,
                    vyFP: 0,
                    originX: b.x,
                    originY: b.y,
                    sourceId: 'existing-rest-state',
                };
                sim.navigation.motion.applyImpulse(
                    a,
                    { x: speed * sim.mass(a), y: 0, z: 0 },
                    { sourceId: 'remaining-time-shot', originX: startA, originY: y },
                );
                const massA = sim.mass(a),
                    massB = sim.mass(b),
                    restitution = LaunchImpactRules.restitution,
                    remaining = dt - 10 / speed;
                const velocityA = (speed * (massA - restitution * massB)) / (massA + massB),
                    velocityB = (speed * (1 + restitution) * massA) / (massA + massB);
                const expectedA = startA + 10 + velocityA * remaining,
                    expectedB = startB + velocityB * remaining;
                sim.stepSimulation();
                check(
                    Math.abs(a.x - expectedA) < 0.1 && Math.abs(b.x - expectedB) < 0.1,
                    'both bodies move with post-impact velocity during the same tick remainder',
                    {
                        actual: [a.x, b.x],
                        expected: [expectedA, expectedB],
                        remaining,
                        velocityA,
                        velocityB,
                    },
                );
                check(
                    b.x - a.x >= radius - 0.05,
                    'post-impact integration retains contact nonpenetration',
                );
                const drag = Math.max(0, 1 - LaunchImpactRules.groundDrag / sim.tps);
                check(
                    Math.abs(a.impactMotion.vxFP - velocityA * FP * drag) < 3 &&
                        Math.abs(b.impactMotion.vxFP - velocityB * FP * drag) < 3,
                    'drag is applied once after contact integration',
                    {
                        actual: [a.impactMotion.vxFP, b.impactMotion.vxFP],
                        expected: [velocityA * FP * drag, velocityB * FP * drag],
                    },
                );
                rows.push({
                    scenario:
                        'same-tick contact integrates both post-impact velocities before drag',
                    actual: [a.x, b.x],
                    expected: [expectedA, expectedB],
                });
            }
            // Three moving bodies share one chronological collision timeline: B-C contact changes the later A-B contact.
            {
                const { sim, x, y } = arena(),
                    units = [
                        sim.spawnUnit(0, 'rice', x - 100, y),
                        sim.spawnUnit(1, 'rice', x - 20, y),
                        sim.spawnUnit(0, 'rice', x + 20, y),
                    ];
                for (const u of units) {
                    u.hp = u.maxHp = 10000;
                    u.impactMotion = {
                        kind: 'knockback',
                        startTick: 0,
                        endTick: 100,
                        recoverUntilTick: 101,
                        heightFP: 0,
                        vzFP: 0,
                        vxFP: 0,
                        vyFP: 0,
                        originX: u.x,
                        originY: u.y,
                        sourceId: 'stationary-contact-fixture',
                    };
                }
                sim.navigation.motion.applyImpulse(
                    units[0],
                    { x: 1000 * sim.mass(units[0]), y: 0, z: 0 },
                    { sourceId: 'left-moving-shot' },
                );
                sim.navigation.motion.applyImpulse(
                    units[2],
                    { x: -800 * sim.mass(units[2]), y: 0, z: 0 },
                    { sourceId: 'right-moving-shot' },
                );
                const before = units.map((u) => ({ id: u.id, x: u.x, vxFP: u.impactMotion.vxFP }));
                const initialMomentum = units.reduce(
                    (sum, u) => sum + (sim.mass(u) * u.impactMotion.vxFP) / FP,
                    0,
                );
                sim.stepSimulation();
                const [a, b, c] = units,
                    gaps = [
                        b.x - a.x - sim.unitRadius(a.type) - sim.unitRadius(b.type),
                        c.x - b.x - sim.unitRadius(b.type) - sim.unitRadius(c.type),
                    ];
                const after = units.map((u) => ({
                    id: u.id,
                    x: u.x,
                    vxFP: u.impactMotion?.vxFP || 0,
                }));
                check(
                    a.x < b.x && b.x < c.x && gaps.every((gap) => gap >= -0.05),
                    'chronological three-body contact preserves order and hostile nonpenetration',
                    { before, after, gaps },
                );
                const expectedMomentum =
                        initialMomentum * Math.max(0, 1 - LaunchImpactRules.groundDrag / sim.tps),
                    actualMomentum = units.reduce(
                        (sum, u) => sum + (sim.mass(u) * (u.impactMotion?.vxFP || 0)) / FP,
                        0,
                    );
                check(
                    Math.abs(actualMomentum - expectedMomentum) < 5,
                    'three-body collision conserves momentum apart from the authored once-per-step drag',
                    { before, after, expectedMomentum, actualMomentum },
                );
                rows.push({
                    scenario: 'chronological three-body contact preserves order, gap and momentum',
                    before,
                    after,
                    gaps,
                    expectedMomentum,
                    actualMomentum,
                });
            }
            // A contact-iteration budget must not discard physical time for an unrelated moving soldier.
            {
                const { sim, x, y } = arena(),
                    pairs = [],
                    rest = (u) => {
                        u.hp = u.maxHp = 10000;
                        u.impactMotion = {
                            kind: 'knockback',
                            startTick: 0,
                            endTick: 100,
                            recoverUntilTick: 101,
                            heightFP: 0,
                            vzFP: 0,
                            vxFP: 0,
                            vyFP: 0,
                            originX: u.x,
                            originY: u.y,
                            sourceId: 'fixed-contact-rest',
                        };
                    };
                for (let i = 0; i < 33; i++) {
                    const px = x - 450 + (i % 6) * 150,
                        py = y - 450 + Math.floor(i / 6) * 150;
                    const a = sim.spawnUnit(1, 'rice', px, py),
                        radius = sim.unitRadius('rice') * 2,
                        b = sim.spawnUnit(0, 'rice', px + radius + (i + 1) * 0.5, py);
                    rest(a);
                    rest(b);
                    pairs.push([a, b]);
                    sim.navigation.motion.applyImpulse(
                        a,
                        { x: 200 * sim.mass(a), y: 0, z: 0 },
                        { sourceId: 'separate-pair-' + i },
                    );
                }
                const probe = sim.spawnUnit(0, 'rice', x + 700, y + 700);
                rest(probe);
                const initialX = probe.x,
                    expectedTravel = 100 / sim.tps;
                sim.navigation.motion.applyImpulse(
                    probe,
                    { x: 100 * sim.mass(probe), y: 0, z: 0 },
                    { sourceId: 'independent-clock-probe' },
                );
                sim.stepSimulation();
                const actualTravel = probe.x - initialX;
                check(
                    Math.abs(actualTravel - expectedTravel) < 0.03,
                    'many distinct contact times cannot discard the unrelated probe remaining timestep',
                    { expectedTravel, actualTravel, pairs: pairs.length },
                );
                for (const [a, b] of pairs) {
                    const gap = b.x - a.x - sim.unitRadius(a.type) - sim.unitRadius(b.type);
                    check(gap >= -0.05, 'each independent contact pair remains nonpenetrating', {
                        pair: [a.id, b.id],
                        gap,
                    });
                    check(
                        b.impactMotion?.vxFP > 0,
                        'every reachable pair resolves its contact within the same physical tick',
                        { pair: [a.id, b.id] },
                    );
                }
                rows.push({
                    scenario:
                        'many distinct contact times preserve full tick duration and resolve every pair',
                    pairs: pairs.length,
                    expectedTravel,
                    actualTravel,
                });
            }
            // A soldier moved by impulse crosses a low shell between authority samples; relative sweep must observe that motion.
            {
                const { sim, x, y } = arena(),
                    victim = defender(sim, x - 30, y - 40),
                    initialY = victim.y;
                sim.navigation.motion.applyImpulse(
                    victim,
                    { x: 0, y: 800 * sim.mass(victim), z: 0 },
                    { sourceId: 'crossing-impulse' },
                );
                shell(sim, x, y, { startX: x - 60, count: 0 });
                sim.stepSimulation();
                const impact = sim.events.find((e) => e.type === 'launchImpact');
                check(
                    victim.y > y && initialY < y,
                    'the soldier actually crosses the projectile line during this physical tick',
                    { initialY, finalY: victim.y, projectileY: y },
                );
                check(
                    impact?.directHitId === victim.id,
                    'a low shell hits the impulse-driven crossing rather than treating the soldier as stationary',
                    { impact, victim: victim.id },
                );
                rows.push({
                    scenario:
                        'relative projectile sweep includes impulse movement in the current tick',
                    initialY,
                    finalY: victim.y,
                    directHitId: impact.directHitId,
                });
            }
            // A pea bundle opens over several ticks; its twelve soldiers recover on the ground.
            {
                const { sim, x, y } = arena();
                shell(sim, x, y);
                sim.stepSimulation();
                const firstCount = sim.units.filter((u) => u.side === 0).length;
                check(firstCount < 12, 'bundle must not instantly materialize its entire squad', {
                    firstCount,
                });
                check(sim.launchDeployments?.length > 0, 'landing leaves pending deployment');
                const copy = restored(sim),
                    a = trace(sim, 100),
                    b = trace(copy, 100);
                check(
                    JSON.stringify(a) === JSON.stringify(b),
                    'pending deployment and airborne soldiers restore deterministically',
                );
                const squad = sim.units.filter((u) => u.side === 0);
                check(
                    squad.length === 12 && squad.every((u) => u.alive),
                    'all twelve soldiers deploy exactly once',
                    { count: squad.length },
                );
                check(
                    squad.every(
                        (u) =>
                            !u.impactMotion ||
                            (u.impactMotion.heightFP === 0 &&
                                sim.tick >= u.impactMotion.recoverUntilTick),
                    ),
                    'deployed soldiers land and recover',
                );
                clearOfBuildings(sim, squad);
                rows.push({
                    scenario: 'bundle opens, deploys and recovers; mid-deployment restore',
                    firstCount,
                    finalCount: squad.length,
                    checksum: sim.checksum(),
                });
            }
            // Center impact launches a defender farther/higher than a defender near the splash edge.
            {
                const { sim, x, y } = arena(),
                    center = defender(sim, x + 30, y),
                    edge = defender(sim, x + 90, y);
                shell(sim, x, y, { count: 0 });
                const initial = [center.x, edge.x],
                    peaks = [0, 0],
                    maxTravel = [0, 0];
                let airborneCopy,
                    edgeShoved = false;
                step(sim, 20, (s) => {
                    edgeShoved ||=
                        edge.impactMotion?.kind === 'knockback' && edge.impactMotion.vxFP > 0;
                    [center, edge].forEach((u, i) => {
                        peaks[i] = Math.max(peaks[i], u.impactMotion?.heightFP || 0);
                        maxTravel[i] = Math.max(maxTravel[i], u.x - initial[i]);
                    });
                    if (s.tick === 2) {
                        check(
                            center.impactMotion?.heightFP > 0,
                            'checkpoint is captured during actual flight',
                        );
                        airborneCopy = restored(s);
                    }
                });
                check(
                    peaks[0] > 0 && maxTravel[0] > 5,
                    'center defender is physically launched and displaced',
                    { peaks, maxTravel },
                );
                check(edgeShoved, 'edge defender receives a real outward shove');
                check(maxTravel[0] > maxTravel[1], 'center impulse exceeds edge shove', {
                    maxTravel,
                });
                check(peaks[0] > peaks[1], 'center launch exceeds edge lift', { peaks });
                step(airborneCopy, 18);
                check(
                    airborneCopy.checksum() === sim.checksum(),
                    'airborne checkpoint preserves impulse integration',
                );
                check(
                    JSON.stringify(trace(sim, 60)) === JSON.stringify(trace(airborneCopy, 60)),
                    'knockback restore follows same trajectory',
                );
                check(
                    !center.impactMotion || center.impactMotion.heightFP === 0,
                    'launched defender returns to ground',
                );
                rows.push({
                    scenario: 'center launch versus edge shove',
                    peaks,
                    maxTravel,
                    checksum: sim.checksum(),
                });
            }
            // Contact solvers must clip blast impulses against a wall and a building, rather than teleporting through.
            for (const obstacle of ['wall', 'building']) {
                const { sim, x, y } = arena({ wall: obstacle === 'wall' });
                if (obstacle === 'building') {
                    sim.buildings.push(
                        new Building({
                            id: 'impact-outpost',
                            type: 'outpost',
                            side: 1,
                            x: x + 170,
                            y,
                            hp: 100000,
                            maxHp: 100000,
                            alive: true,
                        }),
                    );
                    sim.rebuildRuntimeIndexes();
                }
                const u = defender(sim, x + 65, y);
                shell(sim, x + 15, y, { count: 0 });
                let moved = false,
                    previous = u.x;
                step(sim, 15, () => {
                    moved ||= Math.abs(u.x - previous) > 0.01;
                    previous = u.x;
                    clearOfTerrain(sim, [u]);
                    clearOfBuildings(sim, [u]);
                });
                check(moved, obstacle + ': blast actually attempts movement');
                rows.push({ scenario: 'impact clipped by ' + obstacle, x: u.x, y: u.y });
            }
            // A blast-driven enemy cannot cross a friendly body; the friendly receives no blast impulse.
            {
                const { sim, x, y } = arena(),
                    enemy = defender(sim, x + 30, y),
                    ally = defender(sim, x + 90, y, 0);
                shell(sim, x, y, { count: 0 });
                let minimumGap = Infinity,
                    observedImpulse = false;
                step(sim, 15, () => {
                    observedImpulse ||= !!enemy.impactMotion;
                    const gap =
                        Math.hypot(enemy.x - ally.x, enemy.y - ally.y) -
                        (sim.radiusFP(enemy) + sim.radiusFP(ally)) / FP;
                    minimumGap = Math.min(minimumGap, gap);
                    check(gap >= -0.05, 'blast-driven hostile bodies remain nonpenetrating', {
                        gap,
                        enemy: [enemy.x, enemy.y],
                        ally: [ally.x, ally.y],
                    });
                    check(
                        !ally.impactMotion ||
                            !String(ally.impactMotion.sourceId).startsWith('qa-shell-'),
                        'friendly unit does not directly receive its own shell blast impulse; body contact may transfer momentum',
                    );
                });
                check(observedImpulse, 'contact scenario exercises a real blast impulse');
                rows.push({ scenario: 'hostile contact and friendly blast policy', minimumGap });
            }
            // An enemy standing under the high part of an arc is passed; one near the low approach causes contact.
            for (const altitude of ['high', 'low']) {
                const { sim, x, y } = arena(),
                    victimX = altitude === 'high' ? x - 300 : x - 5;
                const u = defender(sim, victimX, y);
                shell(sim, x, y, { startX: altitude === 'high' ? victimX - 30 : x - 25, count: 0 });
                const initialHP = u.hp;
                sim.stepSimulation();
                if (altitude === 'high')
                    check(
                        sim.projectiles.length === 1 && u.hp === initialHP && !u.impactMotion,
                        'high arc passes over a grounded unit',
                    );
                else
                    check(
                        sim.projectiles.length === 0 && u.impactMotion?.sourceId,
                        'low approach directly hits instead of crossing a unit',
                        { projectiles: sim.projectiles.length, unit: u.toState() },
                    );
                rows.push({
                    scenario: altitude + ' arc contact',
                    projectiles: sim.projectiles.length,
                    hp: u.hp,
                });
            }
            // Planar overlap alone is not a hit: a low shell passes below an airborne body's bottom.
            {
                const contacts = [];
                for (const bottom of [100, 0]) {
                    const { sim, x, y } = arena(),
                        victim = defender(sim, x - 5, y);
                    if (bottom)
                        victim.impactMotion = {
                            kind: 'knockback',
                            startTick: 0,
                            endTick: 40,
                            recoverUntilTick: 45,
                            heightFP: bottom * FP,
                            vzFP: 0,
                            vxFP: 0,
                            vyFP: 0,
                            originX: victim.x,
                            originY: victim.y,
                            sourceId: 'qa-existing-flight',
                        };
                    shell(sim, x, y, { startX: x - 17, count: 0 });
                    const shot = sim.projectiles.at(-1),
                        projectileHeight = LaunchImpact.projectileHeight(sim, shot, shot.x, shot.y);
                    check(
                        projectileHeight >= 18 && projectileHeight <= 22,
                        'underflight fixture actually places the shell near height twenty',
                        { projectileHeight },
                    );
                    sim.stepSimulation();
                    const impact = sim.events.find((e) => e.type === 'launchImpact');
                    check(
                        impact,
                        'low projectile reaches its landing point in the height-slab scenario',
                    );
                    if (bottom)
                        check(
                            impact.directHitId !== victim.id,
                            'a roughly twenty-high shell must pass below the airborne body bottom at one hundred',
                            { directHitId: impact.directHitId, victim: victim.id, bottom },
                        );
                    else
                        check(
                            impact.directHitId === victim.id,
                            'the same shell directly hits a body occupying its height interval',
                            { directHitId: impact.directHitId, victim: victim.id },
                        );
                    contacts.push({
                        bodyBottom: bottom,
                        projectileHeight,
                        directHitId: impact.directHitId,
                    });
                }
                rows.push({
                    scenario:
                        'vertical body slab rejects underflight and accepts matching-height contact',
                    contacts,
                });
            }
            // Even a one-unit-wide raised floor is solid to a low shot, while an arc above it passes.
            {
                const contacts = [];
                for (const altitude of ['low', 'high']) {
                    const { sim, x, y } = arena(),
                        state = sim.exportState(),
                        ridgeX = x - (altitude === 'low' ? 55 : 300);
                    state.mapDescriptor = structuredClone(state.mapDescriptor);
                    state.mapDescriptor.terrain.layers = [
                        {
                            id: 'thin-raised-floor',
                            level: 2,
                            points: [
                                { x: ridgeX, y: y - 80 },
                                { x: ridgeX + 1, y: y - 80 },
                                { x: ridgeX + 1, y: y + 80 },
                                { x: ridgeX, y: y + 80 },
                            ],
                        },
                    ];
                    sim.importState(state);
                    shell(sim, x, y, {
                        startX: altitude === 'low' ? x - 80 : x - 330,
                        count: altitude === 'low' ? 12 : 0,
                    });
                    const shot = sim.projectiles.at(-1);
                    sim.stepSimulation();
                    const impact = sim.events.find((e) => e.type === 'launchImpact');
                    if (altitude === 'low') {
                        check(
                            impact?.directHitId === 'thin-raised-floor',
                            'low shot hits the thin raised floor before crossing it',
                            { impact },
                        );
                        const expectedHeightFP = Math.round(
                            LaunchImpact.projectileHeight(sim, shot, impact.x, impact.y) * FP,
                        );
                        check(
                            Math.abs(impact.impactHeightFP - expectedHeightFP) <= 3 &&
                                impact.impactHeightFP < 96 * FP,
                            'cliff-face contact keeps actual projectile altitude instead of teleporting to plateau height',
                            { actual: impact.impactHeightFP, expected: expectedHeightFP },
                        );
                        check(
                            impact.x <= ridgeX - 1 / FP + 0.001 &&
                                impact.x >= ridgeX - 2 / FP - 0.001,
                            'cliff contact stays one fixed-point step outside the raised floor',
                            { impactX: impact.x, ridgeX },
                        );
                        const packet = sim.launchDeployments[0];
                        check(
                            packet &&
                                Math.round(
                                    sim.world.terrain.surfaces.heightAt(packet.x, packet.y) * FP,
                                ) +
                                    packet.heightFP ===
                                    impact.impactHeightFP,
                            'cliff-face packet starts at actual contact height',
                        );
                        let released = 0;
                        const packetHeights = [packet.heightFP];
                        const observeReleases = (world) => {
                            for (const group of world.launchDeployments)
                                packetHeights.push(group.heightFP);
                            for (const event of world.events.filter((e) => e.type === 'launchLand'))
                                for (const id of event.unitIds) {
                                    const birth = event.units.find((unit) => unit.id === id);
                                    check(
                                        birth && birth.x < ridgeX,
                                        'a packet below the ridge cannot instantly release a soldier on the opposite side',
                                        { birth, ridgeX },
                                    );
                                    const unit = world.units.find((u) => u.id === id),
                                        floorFP = Math.round(
                                            world.world.terrain.surfaces.heightAt(unit.x, unit.y) *
                                                FP,
                                        );
                                    released++;
                                    check(
                                        floorFP <= event.impactHeightFP &&
                                            event.impactHeightFP < 96 * FP,
                                        'cliff-face soldier releases below the plateau without a height jump',
                                        { floorFP, height: event.impactHeightFP },
                                    );
                                    check(
                                        floorFP + unit.impactMotion.heightFP ===
                                            event.impactHeightFP,
                                        'cliff-face soldier and falling packet share the same release altitude',
                                    );
                                }
                        };
                        observeReleases(sim);
                        step(sim, 100, observeReleases);
                        check(
                            released === 12 && sim.launchDeployments.length === 0,
                            'cliff-face packet finds safe space and releases every soldier',
                            { released, pending: sim.launchDeployments.length },
                        );
                        check(
                            packetHeights.some((height) => height < packetHeights[0]),
                            'cliff-face packet falls from contact altitude before emptying',
                        );
                    } else
                        check(
                            !impact && sim.projectiles.length === 1,
                            'high arc crosses the same thin raised floor without impact',
                        );
                    contacts.push({
                        altitude,
                        directHitId: impact?.directHitId || null,
                        impactHeightFP: impact?.impactHeightFP || null,
                    });
                }
                rows.push({
                    scenario: 'thin raised terrain catches low shots and allows high arcs',
                    contacts,
                });
            }
            // An airborne direct hit opens its packet at contact height; pending and released grains stay continuous.
            {
                const { sim, x, y } = arena(),
                    victim = defender(sim, x - 100, y);
                victim.impactMotion = {
                    kind: 'knockback',
                    startTick: 0,
                    endTick: 40,
                    recoverUntilTick: 45,
                    heightFP: 100 * FP,
                    vzFP: 0,
                    vxFP: 0,
                    vyFP: 0,
                    originX: victim.x,
                    originY: victim.y,
                    sourceId: 'qa-existing-flight',
                };
                shell(sim, x, y, { startX: x - 130 });
                sim.stepSimulation();
                const impact = sim.events.find((e) => e.type === 'launchImpact'),
                    first = sim.events.find((e) => e.type === 'launchLand');
                check(
                    impact?.directHitId === victim.id && impact.impactHeightFP > 90 * FP,
                    'direct hit records actual airborne contact height',
                    { impact },
                );
                check(
                    first?.impactHeightFP === impact.impactHeightFP,
                    'first released soldier starts at packet contact height',
                    { impact, first },
                );
                const born = sim.units.find((u) => u.id === first.unitIds[0]);
                check(
                    Math.round(sim.world.terrain.surfaces.heightAt(born.x, born.y) * FP) +
                        born.impactMotion.heightFP ===
                        impact.impactHeightFP,
                    'released soldier authority height matches airborne packet',
                );
                const group = sim.launchDeployments[0],
                    firstHeight = group.heightFP;
                check(
                    group.heightFP +
                        Math.round(sim.world.terrain.surfaces.heightAt(group.x, group.y) * FP) ===
                        impact.impactHeightFP,
                    'pending packet retains relative contact height',
                );
                const releasedIds = new Set(first.unitIds),
                    releaseCounts = new Map(first.unitIds.map((id) => [id, 1]));
                const copy = restored(sim),
                    a = [],
                    b = [],
                    heights = [firstHeight];
                step(sim, 100, (world) => {
                    a.push(world.checksum());
                    if (world.launchDeployments.length)
                        heights.push(world.launchDeployments[0].heightFP);
                    for (const event of world.events.filter((e) => e.type === 'launchLand'))
                        for (const id of event.unitIds) {
                            releasedIds.add(id);
                            releaseCounts.set(id, (releaseCounts.get(id) || 0) + 1);
                            const unit = world.units.find((u) => u.id === id);
                            check(
                                unit &&
                                    Math.round(
                                        world.world.terrain.surfaces.heightAt(unit.x, unit.y) * FP,
                                    ) +
                                        unit.impactMotion.heightFP ===
                                        event.impactHeightFP,
                                'each later release uses current falling packet height',
                            );
                        }
                });
                step(copy, 100, (world) => b.push(world.checksum()));
                check(
                    JSON.stringify(a) === JSON.stringify(b),
                    'airburst packet falling and release queue restore exactly',
                );
                check(
                    heights.some((height) => height < firstHeight),
                    'remaining packet physically falls after airborne contact',
                );
                check(
                    releasedIds.size === 12 &&
                        [...releaseCounts.values()].every((n) => n === 1) &&
                        sim.launchDeployments.length === 0,
                    'airburst releases its complete squad exactly once before subsequent combat deaths',
                    {
                        released: [...releasedIds],
                        releaseCounts: [...releaseCounts],
                        pending: sim.launchDeployments,
                    },
                );
                rows.push({
                    scenario: 'airborne impact preserves packet and released soldier height',
                    impactHeightFP: impact.impactHeightFP,
                    firstHeight,
                    lowestPendingHeight: Math.min(...heights),
                    checksum: sim.checksum(),
                });
            }
            // A ground burst cannot damage or re-launch a body far above its three-dimensional reach.
            {
                const contacts = [];
                for (const bottom of [300, 0]) {
                    const { sim, x, y } = arena(),
                        victim = defender(sim, x + 30, y);
                    if (bottom)
                        victim.impactMotion = {
                            kind: 'knockback',
                            startTick: 0,
                            endTick: 40,
                            recoverUntilTick: 45,
                            heightFP: bottom * FP,
                            vzFP: 0,
                            vxFP: 0,
                            vyFP: 0,
                            originX: victim.x,
                            originY: victim.y,
                            sourceId: 'qa-existing-flight',
                        };
                    const hp = victim.hp;
                    shell(sim, x, y, { count: 0 });
                    sim.stepSimulation();
                    if (bottom)
                        check(
                            victim.hp === hp &&
                                victim.impactMotion.sourceId === 'qa-existing-flight' &&
                                victim.impactMotion.vxFP === 0 &&
                                victim.impactMotion.vyFP === 0,
                            'ground burst misses the vertically separated body in both damage and impulse',
                        );
                    else
                        check(
                            victim.hp < hp &&
                                victim.impactMotion?.sourceId !== 'qa-existing-flight',
                            'overlapping ground body receives both blast damage and impulse',
                        );
                    contacts.push({
                        bodyBottom: bottom,
                        hpLost: hp - victim.hp,
                        sourceId: victim.impactMotion?.sourceId,
                    });
                }
                rows.push({
                    scenario: 'blast damage and impulse share three-dimensional body distance',
                    contacts,
                });
            }
            // Lethal damage ends combat immediately, while the corpse completes its physical trajectory.
            {
                const { sim, x, y } = arena(),
                    victim = defender(sim, x + 30, y),
                    observer = defender(sim, x - 200, y, 0);
                victim.hp = 1;
                observer.target = victim.id;
                shell(sim, x, y, { count: 0 });
                sim.stepSimulation();
                check(!victim.alive && victim.hp <= 0, 'lethal shell immediately ends target life');
                check(
                    sim.units.some((u) => u.id === victim.id) && victim.impactMotion,
                    'lethal shell preserves a flying corpse until its motion finishes',
                );
                const initialHeight = victim.impactMotion.heightFP;
                sim.stepSimulation();
                check(
                    victim.impactMotion?.heightFP > initialHeight,
                    'dead victim continues rising after the lethal tick',
                );
                check(
                    observer.target !== victim.id,
                    'combat stops targeting the dead victim on the next authority update',
                );
                const copy = restored(sim),
                    a = trace(sim, 100),
                    b = trace(copy, 100);
                check(
                    JSON.stringify(a) === JSON.stringify(b),
                    'flying corpse restores with the same authority trajectory',
                );
                check(
                    !sim.units.some((u) => u.id === victim.id),
                    'finished corpse is removed by scheduled cleanup',
                );
                rows.push({
                    scenario:
                        'lethal impact keeps corpse motion, ends targeting, restores and cleans up',
                    initialHeight,
                    checksum: sim.checksum(),
                });
            }
            // Both direct roof hits and terrain hits inside a friendly footprint must release before destruction.
            for (const side of [0, 1]) {
                const { LaunchRules } = await import(
                    new URL('./src/sim/launch-rules.js', location.href)
                );
                const sim = new StrategySim(12345);
                const site = sim.capturePoints.find((point) => point.id === 'natural-2');
                const cannon = sim.spawnOutpost(site, side);
                cannon.hp = cannon.maxHp;
                sim.completeConstruction(cannon);
                const base = sim.buildings.find((building) => building.id === 'base1');
                base.hp = base.maxHp = 100000;
                const actor = side === 0 ? 'host' : 'guest';
                check(
                    sim.applyCommand(actor, { type: 'UPGRADE_LAUNCH_RANGE' }) &&
                        sim.applyCommand(actor, {
                            type: 'LAUNCH',
                            cannonId: cannon.id,
                            unitType: 'rice',
                            holdMs: LaunchRules.holdFor(side === 0 ? 550 : 460, 'rice', 1),
                            x: base.x,
                            y: base.y,
                        }),
                    'first upgraded rice volley launches from the captured natural',
                );
                const radius = BuildingDefinition.get(base.type).size;
                const distance = (point) => Math.hypot(point.x - base.x, point.y - base.y);
                let impact;
                for (let i = 0; i < sim.tps * 2 && !impact; i++) {
                    sim.stepSimulation();
                    impact = sim.events.find(
                        (event) =>
                            event.type === 'launchImpact' &&
                            event.directHitId === (side === 0 ? base.id : 'base-high-1') &&
                            distance(event) < radius,
                    );
                }
                check(impact, 'central pellet impacts inside the base footprint');
                const group = sim.launchDeployments.find(
                    (pending) => pending.projectileId === impact.projectileId,
                );
                check(
                    group && distance(group) > radius,
                    'roof hit releases from outside the base',
                    {
                        impact,
                        group,
                    },
                );
                const initial = sim.events.filter(
                    (event) =>
                        event.type === 'launchLand' && event.projectileId === impact.projectileId,
                ).length;
                const copy = restored(sim);
                const finish = (world) => {
                    const released = [];
                    step(world, world.tps * 2, () => {
                        for (const event of world.events)
                            if (
                                event.type === 'launchLand' &&
                                event.projectileId === impact.projectileId
                            )
                                released.push(world.tick);
                    });
                    return released;
                };
                const released = finish(sim);
                check(
                    JSON.stringify(released) === JSON.stringify(finish(copy)) &&
                        sim.checksum() === copy.checksum(),
                    'roof-hit deployment is deterministic across restore',
                );
                check(
                    base.alive !== false &&
                        base.hp > 0 &&
                        initial + released.length === 4 &&
                        !sim.launchDeployments.some(
                            (pending) => pending.projectileId === impact.projectileId,
                        ),
                    'all four soldiers deploy while the base remains standing',
                    { baseHp: base.hp, initial, released, pending: sim.launchDeployments },
                );
                sim.applyDamage(0, 'rice', base, true, base.hp, null, {
                    sourceDamageResolved: true,
                });
                check(
                    base.alive === false && finish(sim).length === 0,
                    'base destruction cannot release old rice',
                );
                rows.push({
                    scenario: 'rice landing inside the base deploys outside while it stands',
                    firingSide: side,
                    impactId: impact.directHitId,
                    impactDistance: distance(impact),
                    deploymentDistance: distance(group),
                    released: initial + released.length,
                    releasedAfterDestruction: 0,
                });
            }
            // A sealed landing area must retain the entire squad instead of silently losing it after a timeout.
            {
                const { sim, x, y } = arena(),
                    sealed = sim.exportState();
                sealed.mapDescriptor = structuredClone(sealed.mapDescriptor);
                sealed.mapDescriptor.terrain.blockers = [
                    {
                        id: 'sealed-landing',
                        kind: 'wall',
                        points: [
                            { x: x - 1000, y: y - 1000 },
                            { x: x + 1000, y: y - 1000 },
                            { x: x + 1000, y: y + 1000 },
                            { x: x - 1000, y: y + 1000 },
                        ],
                    },
                ];
                sim.importState(sealed);
                shell(sim, x, y);
                step(sim, sim.msTicks(2000));
                const pending = () =>
                    sim.launchDeployments.reduce(
                        (total, group) => total + group.count - group.index,
                        0,
                    );
                check(
                    sim.units.length === 0 && pending() === 12,
                    'two seconds of blocked terrain preserves all twelve pending soldiers',
                    { units: sim.units.length, pending: pending() },
                );
                const before = sim.checksum(),
                    view = sim.snapshot();
                check(
                    view.launchDeployments?.length > 0,
                    'snapshot exposes the pending landing bundle',
                );
                view.launchDeployments[0].index = view.launchDeployments[0].count;
                view.launchDeployments[0].x += 500;
                check(
                    sim.checksum() === before && pending() === 12,
                    'mutating a snapshot cannot change authority deployment queue',
                );
                const copy = restored(sim);
                for (const world of [sim, copy]) {
                    const open = world.exportState();
                    open.mapDescriptor = structuredClone(open.mapDescriptor);
                    open.mapDescriptor.terrain.blockers = [];
                    world.importState(open);
                }
                check(
                    JSON.stringify(trace(sim, 100)) === JSON.stringify(trace(copy, 100)),
                    'blocked queue restores and retries deterministically after opening terrain',
                );
                check(
                    sim.units.filter((u) => u.side === 0).length === 12 && pending() === 0,
                    'opening space releases every preserved soldier exactly once',
                );
                rows.push({
                    scenario:
                        'blocked deployment retains squad, snapshot is isolated, opening terrain releases all',
                    finalCount: sim.units.length,
                    checksum: sim.checksum(),
                });
            }
            // Identical mission inputs repeat exactly, including in-flight checkpoint restoration.
            const repeat = () => {
                const { sim, x, y } = arena();
                defender(sim, x + 30, y);
                shell(sim, x, y, { startX: x - 600 });
                step(sim, 4);
                const copy = restored(sim);
                const a = trace(sim, 140),
                    b = trace(copy, 140);
                check(JSON.stringify(a) === JSON.stringify(b), 'mid-flight restoration');
                return a;
            };
            check(
                JSON.stringify(repeat()) === JSON.stringify(repeat()),
                'fixed seed and inputs repeat exactly',
            );
            rows.push({ scenario: 'in-flight restore and repeated fixed input', pass: true });
            return { seed: 12345, rows };
        });
        assert.deepEqual(pageErrors, [], 'scenario browser page errors');
        const output = path.join(root, '.qa', 'launch-impact');
        fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ pass: true, ...result }, null, 2));
    } finally {
        await browser.close();
        await server.close();
    }
})().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
});
