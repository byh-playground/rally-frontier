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
    const browser = await chromium.launch({
        channel: process.env.QA_BROWSER_CHANNEL || 'chromium',
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }),
        pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    try {
        await routePinnedSDK(page);
        await page.goto(server.url + '?tps=20&role=host&netcode=' + mode, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForFunction(() => window.__economyE2E?.ready && window.RallyGamekit, null, {
            timeout: 60000,
        });
        const result = await page.evaluate(async () => {
            const { StrategySim } = await import(
                new URL('./src/sim/strategy-sim.js', location.href)
            );
            const { LaunchRules } = await import(
                new URL('./src/sim/launch-rules.js', location.href)
            );
            const { GameRuleDefinition } = await import(
                new URL('./src/core/game-rules.js', location.href)
            );
            const { BuildingDefinition } = await import(
                new URL('./src/definitions/buildings.js', location.href)
            );
            const { UnitDefinition } = await import(
                new URL('./src/definitions/units.js', location.href)
            );
            const { InteractionGeometry } = await import(
                new URL('./src/sim/navigation.js', location.href)
            );
            const { ConstructionRules } = await import(
                new URL('./src/sim/construction-rules.js', location.href)
            );
            const { FP } = await import(new URL('./src/core/config.js', location.href));
            const check = (value, message, detail) => {
                if (!value) throw Error(message + (detail ? ': ' + JSON.stringify(detail) : ''));
            };
            const rows = [],
                seed = 12345;
            function arena(tps = 20, count = 1) {
                const rules = GameRuleDefinition.resolve({ overrides: { simulation: { tps } } });
                const sim = new StrategySim(seed, rules),
                    state = sim.exportState();
                const map = structuredClone(state.mapDescriptor),
                    x = Math.round(map.width / 2),
                    y = Math.round(map.height / 2);
                map.terrain = {
                    layers: [],
                    ramps: [],
                    blockers: [],
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
                state.launchDeployments = [];
                state.capturePoints = Array.from({ length: count }, (_, i) => ({
                    id: 'economy-' + i,
                    x: x + ((i % 3) - 1) * 550,
                    y: y + Math.floor(i / 3) * 550,
                    owner: null,
                    outpostId: null,
                    enabled: true,
                    label: '거점' + i,
                }));
                for (const b of state.buildings) {
                    b.x = x + (b.side ? 1400 : -1400);
                    b.y = y - 1000;
                }
                sim.importState(state);
                return sim;
            }
            function step(sim, n, visit = () => {}) {
                for (let i = 0; i < n; i++) {
                    sim.stepSimulation();
                    visit(sim);
                }
            }
            function start(sim, { workers = 1, contact = true, side = 0 } = {}) {
                const groups = [];
                for (const cp of sim.capturePoints) {
                    const ids = [];
                    for (let i = 0; i < Math.max(1, workers); i++) {
                        const a = (i * Math.PI * 2) / Math.max(1, workers);
                        ids.push(
                            sim.spawnUnit(
                                side,
                                'rice',
                                cp.x + Math.cos(a) * (contact ? 100 : 160),
                                cp.y + Math.sin(a) * (contact ? 100 : 160),
                            ).id,
                        );
                    }
                    groups.push(ids);
                }
                step(sim, 1);
                check(
                    sim.capturePoints.every((cp) => cp.owner === null && cp.outpostId),
                    'presence immediately starts a building without completed ownership',
                );
                const state = sim.exportState();
                if (!workers) state.units = [];
                else if (contact)
                    for (const [index, ids] of groups.entries()) {
                        const building = sim.buildings.find(
                            (b) => b.id === sim.capturePoints[index].outpostId,
                        );
                        for (const [i, id] of ids.entries()) {
                            const u = state.units.find((unit) => unit.id === id),
                                radius = sim.buildingClearanceDistance(u, building) + 0.75,
                                a = (i * Math.PI * 2) / workers;
                            u.x = building.x + Math.cos(a) * radius;
                            u.y = building.y + Math.sin(a) * radius;
                            u.fx = Math.round(u.x * FP);
                            u.fy = Math.round(u.y * FP);
                            u.constructionWork = null;
                        }
                    }
                sim.importState(state);
                step(sim, 1);
                return sim.capturePoints.map((cp) =>
                    sim.buildings.find((b) => b.id === cp.outpostId),
                );
            }
            function smallProjects(sim, buildings) {
                const state = sim.exportState(),
                    ids = buildings.map((b) => b.id);
                for (const b of state.buildings)
                    if (ids.includes(b.id)) {
                        b.construction = ConstructionRules.create(
                            { cost: 3, workRequired: 7, initialHpRatio: 0.1 },
                            sim.tick,
                        );
                        b.hp = ConstructionRules.healthAt(b.construction, b.maxHp, 0);
                    }
                sim.importState(state);
                return ids.map((id) => sim.buildings.find((b) => b.id === id));
            }
            function finish(sim, building, maxSeconds = 20) {
                for (let i = 0; i < maxSeconds * sim.tps && building.construction; i++)
                    sim.stepSimulation();
                check(building.construction === null, 'active workers finish their funded project');
            }
            function nextHitMission({
                cost = 75,
                workRequired = 375,
                workDone = 0,
                power = 1,
                wallet = 50,
            } = {}) {
                const original = UnitDefinition.get('rice').construction.workPerHit;
                UnitDefinition.get('rice').construction.workPerHit = power;
                try {
                    const sim = arena(),
                        [initial] = start(sim);
                    step(sim, sim.tps - 1);
                    const state = sim.exportState(),
                        b = state.buildings.find((b) => b.id === initial.id);
                    b.construction = ConstructionRules.create(
                        { cost, workRequired, initialHpRatio: 0.1 },
                        1,
                    );
                    b.construction.workDone = workDone;
                    b.construction.invested = Math.floor((cost * workDone) / workRequired);
                    b.hp = ConstructionRules.healthAt(b.construction, b.maxHp, workDone);
                    state.wallet[0] = wallet;
                    state.launchIncomeCarry[0] = 0;
                    sim.importState(state);
                    sim.stepSimulation();
                    return {
                        sim,
                        building: sim.buildings.find((b) => b.id === initial.id),
                        events: sim.events.filter((e) => e.type === 'constructionHit'),
                    };
                } finally {
                    UnitDefinition.get('rice').construction.workPerHit = original;
                }
            }
            function restore(sim) {
                const copy = new StrategySim(seed, sim.rules);
                copy.importState(sim.exportState());
                check(
                    copy.checksum() === sim.checksum(),
                    'checkpoint restores authoritative checksum',
                );
                return copy;
            }
            function destroy(sim, building) {
                sim.applyDamage(1 - building.side, 'rice', building, true, 100000, null, {
                    sourceDamageResolved: true,
                });
            }
            // The player can trade the entire starting wallet for a global range level.
            {
                const sim = arena(),
                    base = sim.launchCannons(0)[0];
                check(
                    LaunchRules.maxReachOf('rice', 0) === 500 &&
                        LaunchRules.maxReachOf('pea', 0) === 425 &&
                        LaunchRules.maxReachOf('redbean', 0) === 375,
                    'initial short launch ranges',
                );
                check(
                    !sim.applyCommand('observer', { type: 'UPGRADE_LAUNCH_RANGE' }),
                    'spectator cannot buy range',
                );
                check(
                    sim.applyCommand('host', { type: 'UPGRADE_LAUNCH_RANGE' }) &&
                        sim.wallet[0] === 0 &&
                        sim.launchRangeLevel[0] === 1 &&
                        sim.launchRangeLevel[1] === 0,
                    '250 resource purchase upgrades only the buying side',
                );
                check(
                    !sim.applyCommand('host', { type: 'UPGRADE_LAUNCH_RANGE' }) &&
                        sim.wallet[0] === 0,
                    'insufficient wallet is rejected without spending',
                );
                sim.wallet[0] = 500;
                check(
                    sim.applyCommand('host', { type: 'UPGRADE_LAUNCH_RANGE' }) &&
                        sim.wallet[0] === 125 &&
                        sim.launchRangeLevel[0] === 2,
                    'second level costs375',
                );
                check(
                    !sim.applyCommand('host', { type: 'UPGRADE_LAUNCH_RANGE' }) &&
                        sim.wallet[0] === 125,
                    'maximum level rejects further payment',
                );
                sim.wallet[0] = 500;
                const target = {
                    type: 'LAUNCH',
                    cannonId: base.id,
                    unitType: 'pea',
                    holdMs: 1500,
                    x: base.x,
                    y: base.y + 2000,
                };
                check(sim.applyCommand('host', target), 'upgraded cannon accepts normal launch');
                const fire = sim.events.find((e) => e.type === 'launchFire');
                check(
                    Math.abs(Math.hypot(fire.aimX - base.x, fire.aimY - base.y) - 1275) <= 1,
                    'authoritative launch consumes the upgraded grain range',
                    fire,
                );
                rows.push({
                    scenario: 'range purchases and authoritative launch',
                    level: sim.launchRangeLevel,
                    wallet: sim.wallet,
                    reach: 1275,
                });
            }
            // Economy values share one currency scale; construction was already scaled.
            {
                const sim = arena();
                check(
                    sim.wallet[0] === 250 &&
                        LaunchRules.walletCap === 500 &&
                        LaunchRules.incomePerSecond === 15 &&
                        LaunchRules.captureIncomePerSecond === 5,
                    'complete fivefold resource conversion',
                );
                check(
                    LaunchRules.grain('rice').cost === 125 &&
                        LaunchRules.grain('pea').cost === 250 &&
                        LaunchRules.grain('redbean').cost === 250,
                    'all launch prices use the same currency',
                );
                sim.wallet[0] = 495;
                sim.launchIncomeCarry[0] = 0;
                step(sim, sim.tps);
                check(sim.wallet[0] === 500, 'income caps at500 instead of the old100');
                rows.push({
                    scenario:
                        'fivefold currency covers wallet income launches upgrades and existing75-cost construction',
                    cap: LaunchRules.walletCap,
                    start: 250,
                    income: 15,
                    launchCosts: [125, 250, 250],
                });
            }
            // Start at capture-presence distance. No fixture moves workers into contact:
            // a symmetric crowd formerly stalled forever just outside the work radius.
            {
                const sim = arena(),
                    [tower] = start(sim, { workers: 20, contact: false });
                sim.wallet[0] = 500;
                const hits = [],
                    lastHits = new Map(),
                    begun = sim.tick,
                    checkpoint = restore(sim);
                for (let i = 0; i < 60 * sim.tps && tower.construction; i++) {
                    sim.stepSimulation();
                    checkpoint.stepSimulation();
                    check(
                        sim.checksum() === checkpoint.checksum(),
                        'crowd approach and hits restore identical futures',
                    );
                    for (const e of sim.events)
                        if (e.type === 'constructionHit') {
                            const worker = sim.unitById.get(e.sourceId);
                            check(
                                !lastHits.has(worker.id) ||
                                    sim.tick - lastHits.get(worker.id) >= sim.tps,
                                'crowd contact jitter cannot bypass the one-second hit cooldown',
                            );
                            lastHits.set(worker.id, sim.tick);
                            check(
                                sim.constructionContact(
                                    worker,
                                    tower,
                                    UnitDefinition.get(worker.type).construction.range,
                                ),
                                'crowd work requires real post-contact reach',
                            );
                            check(
                                Math.hypot(worker.x - tower.x, worker.y - tower.y) >=
                                    sim.buildingClearanceDistance(worker, tower) - 0.1,
                                'crowd worker never enters the building collider',
                            );
                            hits.push(e);
                        }
                }
                check(
                    tower.construction === null &&
                        sim.capturePoints[0].owner === 0 &&
                        hits.reduce((n, e) => n + e.workAdded, 0) === 375 &&
                        hits.reduce((n, e) => n + e.spend, 0) === 75,
                    'funded symmetric crowd completes375 work and spends75',
                    { hits: hits.length, work: tower.construction },
                );
                rows.push({
                    scenario:
                        'twenty workers approach through crowd contacts and complete without a funded stall',
                    elapsedTicks: sim.tick - begun,
                    work: 375,
                    spend: 75,
                    checksum: sim.checksum(),
                });
            }
            // One hit adds one work. Payment follows the project ratio independently
            // of the one-second body-charge cadence and the five visual meter cells.
            for (const tps of [10, 20, 30]) {
                const sim = arena(tps),
                    [building] = start(sim),
                    startTick = sim.tick,
                    hits = [];
                check(
                    building.construction.cost === 75 &&
                        building.construction.workRequired === 375 &&
                        building.construction.workDone === 0 &&
                        building.hp === 140,
                    'default project declares75 cost and375 work at10% HP',
                );
                check(
                    !sim.launchCannons(0).some((b) => b.id === building.id),
                    'unfinished project cannot launch',
                );
                step(sim, 4 * tps, (s) =>
                    hits.push(...s.events.filter((e) => e.type === 'constructionHit')),
                );
                check(
                    building.construction.workDone === 4 &&
                        building.construction.invested === 0 &&
                        hits.length === 4 &&
                        hits.every((e) => e.spend === 0),
                    'first four actual work hits cost zero',
                    { tps, work: building.construction.workDone, hits },
                );
                step(sim, tps);
                check(
                    building.construction.workDone === 5 && building.construction.invested === 1,
                    'fifth actual hit crosses the first resource threshold',
                );
                rows.push({
                    scenario: 'one-second work cadence is independent of money thresholds',
                    tps,
                    elapsedTicks: sim.tick - startTick,
                    workDone: building.construction.workDone,
                    invested: building.construction.invested,
                });
            }
            {
                const sim = arena(),
                    [tower] = start(sim),
                    started = sim.tick,
                    hits = [];
                const hpBefore = tower.hp;
                sim.applyDamage(1, 'rice', tower, true, 50, null, { sourceDamageResolved: true });
                const damage = hpBefore - tower.hp;
                step(sim, 375 * sim.tps - 1, (s) =>
                    hits.push(...s.events.filter((e) => e.type === 'constructionHit')),
                );
                check(
                    tower.construction.workDone === 374 &&
                        tower.construction.invested === 74 &&
                        sim.capturePoints[0].owner === null,
                    '374 hits cannot complete375-work project',
                );
                step(sim, 1, (s) =>
                    hits.push(...s.events.filter((e) => e.type === 'constructionHit')),
                );
                check(
                    tower.construction === null &&
                        hits.length === 375 &&
                        hits.reduce((n, e) => n + e.spend, 0) === 75 &&
                        sim.tick - started === 375 * sim.tps,
                    'one worker finishes in375 seconds and spends exactly75',
                );
                check(
                    tower.hp === tower.maxHp - damage,
                    'work-proportional HP preserves damage through full completion',
                );
                rows.push({
                    scenario: 'full375-hit project spends75 and preserves damage',
                    elapsedTicks: sim.tick - started,
                    hits: hits.length,
                    spend: hits.reduce((n, e) => n + e.spend, 0),
                    hp: tower.hp,
                });
            }
            // Arbitrary project ratios must use the same actual-hit mechanic; no
            // five-hit rule may leak from the meter into work or payment resolution.
            {
                const cases = [];
                for (const [cost, workRequired, expected] of [
                    [3, 7, [0, 0, 1, 1, 2, 2, 3]],
                    [
                        75,
                        150,
                        Array.from({ length: 150 }, (_, i) => Math.floor((75 * (i + 1)) / 150)),
                    ],
                    [8, 3, [2, 5, 8]],
                    [0, 7, [0, 0, 0, 0, 0, 0, 0]],
                ]) {
                    const original = UnitDefinition.get('rice').construction.workPerHit;
                    try {
                        UnitDefinition.get('rice').construction.workPerHit = 1;
                        const sim = arena(),
                            [initial] = start(sim),
                            state = sim.exportState(),
                            b = state.buildings.find((b) => b.id === initial.id);
                        b.construction = ConstructionRules.create(
                            { cost, workRequired, initialHpRatio: 0.1 },
                            sim.tick,
                        );
                        sim.importState(state);
                        const invested = [];
                        step(sim, expected.length * sim.tps, (s) =>
                            invested.push(
                                ...s.events
                                    .filter((e) => e.type === 'constructionHit')
                                    .map((e) => e.invested),
                            ),
                        );
                        check(
                            JSON.stringify(invested) === JSON.stringify(expected),
                            'actual hits honor arbitrary cost/work integer boundaries',
                            { cost, workRequired, invested, expected },
                        );
                        if (expected.length === workRequired)
                            check(
                                sim.buildings.find((b) => b.id === initial.id).construction ===
                                    null,
                                'arbitrary ratio completes at its declared work requirement',
                            );
                        cases.push({ cost, workRequired, invested });
                    } finally {
                        UnitDefinition.get('rice').construction.workPerHit = original;
                    }
                }
                rows.push({ scenario: 'independent project price and required work', cases });
            }
            {
                const cases = [];
                for (const spec of [
                    { workDone: 0, power: 3, wallet: 0, expectedWork: 0, expectedSpend: 0 },
                    { workDone: 3, power: 3, wallet: 0, expectedWork: 3, expectedSpend: 0 },
                    { workDone: 4, power: 3, wallet: 1, expectedWork: 7, expectedSpend: 1 },
                    {
                        cost: 75,
                        workRequired: 150,
                        workDone: 3,
                        power: 3,
                        wallet: 10,
                        expectedWork: 6,
                        expectedSpend: 2,
                    },
                    {
                        cost: 75,
                        workRequired: 150,
                        workDone: 1,
                        power: 3,
                        wallet: 1,
                        expectedWork: 3,
                        expectedSpend: 1,
                    },
                    {
                        cost: 3,
                        workRequired: 2,
                        workDone: 0,
                        power: 3,
                        wallet: 1,
                        expectedWork: 1,
                        expectedSpend: 1,
                    },
                    { workDone: 374, power: 3, wallet: 1, expectedWork: 375, expectedSpend: 1 },
                ]) {
                    const { building, events } = nextHitMission(spec),
                        event = events[0];
                    if (spec.wallet === 0) {
                        check(
                            events.length === 0 &&
                                building.construction.workDone === spec.expectedWork,
                            'empty wallet pauses even work before the next payment boundary',
                            { spec, events },
                        );
                    } else {
                        check(
                            events.length === 1 &&
                                event.workDone === spec.expectedWork &&
                                event.spend === spec.expectedSpend,
                            'specialist work crosses boundaries, carries partial progress and respects wallet/cap',
                            { spec, events },
                        );
                    }
                    if (spec.expectedWork === (spec.workRequired || 375))
                        check(
                            building.construction === null,
                            'specialist final hit cannot exceed remaining work',
                        );
                    cases.push({
                        power: spec.power,
                        previousWork: spec.workDone,
                        workDone: event?.workDone ?? building.construction.workDone,
                        workAdded: event?.workAdded ?? 0,
                        spend: event?.spend ?? 0,
                    });
                }
                rows.push({
                    scenario: 'specialist contribution and partial affordable work use common hits',
                    cases,
                });
            }
            {
                const sim = arena(),
                    [tower] = start(sim, { workers: 3 }),
                    started = sim.tick,
                    hits = [],
                    completed = [];
                step(sim, 125 * sim.tps, (s) => {
                    hits.push(...s.events.filter((e) => e.type === 'constructionHit'));
                    completed.push(...s.events.filter((e) => e.type === 'captureComplete'));
                });
                check(
                    tower.construction === null &&
                        hits.length === 375 &&
                        completed.length === 1 &&
                        hits.reduce((n, e) => n + e.spend, 0) === 75,
                    'three actual workers finish375 work in125 seconds and charge75 once',
                );
                const last = nextHitMission({ workDone: 374, power: 3, wallet: 1 });
                check(
                    last.events.length === 1 &&
                        last.events[0].workAdded === 1 &&
                        last.events[0].spend === 1 &&
                        last.building.construction === null,
                    'final specialist hit caps work and payment',
                );
                rows.push({
                    scenario:
                        'multiple workers accelerate while completion and total payment stay exact',
                    durationTicks: sim.tick - started,
                    spend: hits.reduce((n, e) => n + e.spend, 0),
                    completeEvents: completed.length,
                });
            }
            // No work is performed while the wallet is empty, including before
            // the next payment threshold; funding still requires a new body hit.
            {
                for (let workDone = 0; workDone < 4; workDone++) {
                    const { events, building } = nextHitMission({ workDone, wallet: 0 });
                    check(
                        events.length === 0 && building.construction.workDone === workDone,
                        'zero wallet pauses work even before the next payment',
                    );
                }
                const { sim, building: tower, events } = nextHitMission({ workDone: 4, wallet: 0 });
                check(
                    events.length === 0 &&
                        tower.construction.workDone === 4 &&
                        tower.construction.invested === 0,
                    'empty wallet blocks work crossing the next price threshold',
                );
                sim.wallet[0] = 1;
                step(sim, 1);
                check(tower.construction.workDone === 4, 'funding alone cannot create work');
                step(sim, sim.tps - 1);
                check(
                    tower.construction.workDone === 4,
                    'resumed worker still needs a whole work cycle',
                );
                step(sim, 1);
                check(
                    tower.construction.workDone === 5 && tower.construction.invested === 1,
                    'funded worker crosses the threshold on the next actual hit',
                );
                rows.push({
                    scenario: 'zero wallet pauses work and funding resumes it on a hit',
                    workDone: tower.construction.workDone,
                    invested: tower.construction.invested,
                });
            }
            // Without workers the project has no autonomous progress of any kind.
            {
                const sim = arena(),
                    [tower] = start(sim, { workers: 0 });
                step(sim, 15 * sim.tps);
                check(
                    tower.construction.workDone === 0 &&
                        tower.construction.invested === 0 &&
                        tower.hp === 140,
                    'worker absence cannot grant free work or paid work',
                );
                rows.push({
                    scenario: 'no workers means no autonomous construction',
                    workDone: tower.construction.workDone,
                });
                for (const leave of [false, true]) {
                    const world = arena(),
                        [site] = start(world);
                    step(world, 2 * world.tps);
                    const workDone = site.construction.workDone;
                    if (leave) {
                        const state = world.exportState();
                        for (const u of state.units) {
                            u.x += 2000;
                            u.fx = Math.round(u.x * FP);
                        }
                        world.importState(state);
                    } else
                        for (const u of world.units)
                            world.applyDamage(1, 'rice', u, false, 100000, null, {
                                sourceDamageResolved: true,
                            });
                    step(world, 3 * world.tps);
                    const current = world.buildings.find((b) => b.id === site.id);
                    check(
                        current.construction.workDone === workDone,
                        'dead or departing workers cannot add even free work',
                        { leave, workDone, actual: current.construction.workDone },
                    );
                    rows.push({
                        scenario: leave
                            ? 'workers leaving stops construction'
                            : 'worker death stops construction',
                        workDone,
                    });
                }
            }
            // The approach uses the same physical envelope as movement: no center
            // teleport or work from175-pixel capture presence distance is allowed.
            {
                const sim = arena(),
                    [tower] = start(sim, { contact: false }),
                    worker = sim.units[0],
                    before = Math.hypot(worker.x - tower.x, worker.y - tower.y),
                    started = sim.tick;
                let firstHit = null;
                step(sim, 4 * sim.tps, (s) => {
                    const distance = Math.hypot(worker.x - tower.x, worker.y - tower.y);
                    check(
                        distance >= sim.buildingClearanceDistance(worker, tower) - 0.1,
                        'construction approach stays outside the building collider',
                        { distance },
                    );
                    for (const e of s.events)
                        if (e.type === 'constructionHit' && firstHit === null) {
                            firstHit = s.tick;
                            check(
                                distance <=
                                    sim.interactionDistance(
                                        worker,
                                        tower,
                                        'construction',
                                        UnitDefinition.get(worker.type).construction.range,
                                    ) +
                                        0.1,
                                'work hit requires common construction contact',
                            );
                        }
                });
                check(
                    before > sim.buildingClearanceDistance(worker, tower) &&
                        firstHit > started + sim.tps,
                    'travel precedes the one-second work cycle',
                    { before, started, firstHit },
                );
                rows.push({
                    scenario: 'worker approaches the common interaction region before working',
                    before,
                    firstHit,
                });
            }
            // Geometric proximity cannot bypass a wall or an unconnected terrain
            // level. Both fixtures keep the worker and tower outside obstacle interiors.
            {
                const sim = arena(),
                    [initial] = start(sim),
                    state = sim.exportState();
                state.mapDescriptor = structuredClone(state.mapDescriptor);
                state.mapDescriptor.terrain.blockers = [
                    {
                        id: 'construction-wall',
                        kind: 'wall',
                        points: [
                            { x: initial.x + 49, y: initial.y - 500 },
                            { x: initial.x + 51, y: initial.y - 500 },
                            { x: initial.x + 51, y: initial.y + 500 },
                            { x: initial.x + 49, y: initial.y + 500 },
                        ],
                    },
                ];
                sim.importState(state);
                let tower = sim.buildings.find((b) => b.id === initial.id);
                const worker = sim.units[0];
                check(
                    sim.world.terrain.field.polygonCircleClear(
                        worker.x,
                        worker.y,
                        sim.unitRadius(worker.type),
                    ),
                    'wall fixture worker circle starts outside its collider',
                );
                check(
                    Math.hypot(worker.x - tower.x, worker.y - tower.y) <=
                        InteractionGeometry.reach(
                            worker,
                            tower,
                            'construction',
                            UnitDefinition.get(worker.type).construction.range,
                        ),
                    'wall fixture is geometrically within the actual construction reach',
                );
                check(
                    !sim.world.terrain.field.polygonSegmentClear(
                        worker.x,
                        worker.y,
                        tower.x,
                        tower.y,
                        0,
                    ),
                    'wall fixture blocks the worker-to-building line',
                );
                step(sim, 2 * sim.tps);
                check(
                    tower.construction.workDone === 0,
                    'a nearby worker cannot construct through a wall',
                );
                const opened = sim.exportState();
                opened.mapDescriptor = structuredClone(opened.mapDescriptor);
                opened.mapDescriptor.terrain.blockers = [];
                sim.importState(opened);
                tower = sim.buildings.find((b) => b.id === initial.id);
                step(sim, 4 * sim.tps);
                check(
                    tower.construction.workDone > 0,
                    'removing the wall permits ordinary approach and construction',
                );
                rows.push({
                    scenario: 'wall blocks nearby work, removing it permits contribution',
                    resumedWork: tower.construction.workDone,
                });
                const level = arena(),
                    [site] = start(level),
                    raised = level.exportState();
                raised.mapDescriptor = structuredClone(raised.mapDescriptor);
                raised.units[0].x = site.x + 65.5;
                raised.units[0].fx = Math.round(raised.units[0].x * FP);
                raised.mapDescriptor.terrain.layers = [
                    {
                        id: 'construction-opposite-level',
                        level: 2,
                        points: [
                            { x: site.x + 52, y: site.y - 500 },
                            { x: site.x + 600, y: site.y - 500 },
                            { x: site.x + 600, y: site.y + 500 },
                            { x: site.x + 52, y: site.y + 500 },
                        ],
                    },
                ];
                level.importState(raised);
                const builder = level.units[0],
                    actual = level.buildings.find((b) => b.id === site.id);
                check(
                    level.terrainLevelAt(builder.x, builder.y) === 2 &&
                        level.terrainLevelAt(actual.x, actual.y) === 0,
                    'level fixture places nearby worker and tower on different levels without a ramp',
                );
                check(
                    Math.hypot(builder.x - actual.x, builder.y - actual.y) <=
                        InteractionGeometry.reach(
                            builder,
                            actual,
                            'construction',
                            UnitDefinition.get(builder.type).construction.range,
                        ),
                    'opposite-level fixture is geometrically within the actual construction reach',
                );
                step(level, 2 * level.tps);
                check(
                    actual.construction.workDone === 0,
                    'a nearby worker cannot construct across an unconnected level boundary',
                );
                rows.push({
                    scenario: 'unconnected terrain levels block nearby work',
                    workDone: actual.construction.workDone,
                });
            }
            // Contact is insufficient while recovering or airborne from a real impulse.
            {
                const sim = arena(),
                    [tower] = start(sim),
                    worker = sim.units[0];
                sim.navigation.motion.applyImpulse(
                    worker,
                    { x: 0, y: 0, z: 2000 * sim.mass(worker) },
                    { sourceId: 'work-airborne', originX: worker.x, originY: worker.y },
                );
                const recoveryUntil = worker.impactMotion.recoverUntilTick,
                    hits = [];
                while (sim.tick < recoveryUntil) {
                    sim.stepSimulation();
                    hits.push(...sim.events.filter((e) => e.type === 'constructionHit'));
                }
                check(
                    hits.length === 0 && tower.construction.workDone === 0,
                    'airborne and recovery ticks cannot produce work hits',
                );
                step(sim, 2 * sim.tps);
                check(
                    tower.construction.workDone >= 1,
                    'grounded recovered worker resumes real work',
                );
                rows.push({
                    scenario: 'impulse air and recovery block construction, landing resumes',
                    recoveryUntil,
                    workDone: tower.construction.workDone,
                });
            }
            // The worker must resolve nearby combat before resuming construction.
            {
                const sim = arena(),
                    [tower] = start(sim),
                    worker = sim.units[0];
                worker.hp = worker.maxHp = 10000;
                const enemy = sim.spawnUnit(1, 'rice', worker.x + 35, worker.y);
                enemy.hp = enemy.maxHp = 10000;
                const workDone = tower.construction.workDone,
                    hits = [];
                step(sim, 2 * sim.tps, (s) =>
                    hits.push(
                        ...s.events.filter((e) => e.type === 'hit' && e.sourceId === worker.id),
                    ),
                );
                check(
                    tower.construction.workDone === workDone && hits.length > 0,
                    'nearby enemy combat takes priority over construction',
                );
                sim.applyDamage(0, 'rice', enemy, false, 100000, null, {
                    sourceDamageResolved: true,
                });
                step(sim, 3 * sim.tps);
                check(
                    tower.construction.workDone > workDone,
                    'worker resumes after combat target disappears',
                );
                rows.push({
                    scenario: 'combat interrupts construction and workers resume afterwards',
                    combatHits: hits.length,
                    resumedWork: tower.construction.workDone,
                });
            }
            // Contested sites and unfinished cannons preserve their existing contracts.
            {
                const contested = arena(),
                    cp = contested.capturePoints[0];
                contested.spawnUnit(0, 'rice', cp.x + 100, cp.y);
                contested.spawnUnit(1, 'rice', cp.x - 100, cp.y);
                step(contested, 1);
                check(
                    cp.owner === null && cp.outpostId === null && cp.enabled,
                    'opposing presence cannot start construction',
                );
                const sim = arena(),
                    [tower] = start(sim),
                    wallet = sim.wallet[0];
                check(
                    !sim.applyCommand('host', {
                        type: 'LAUNCH',
                        cannonId: tower.id,
                        unitType: 'rice',
                        holdMs: 1500,
                        x: tower.x,
                        y: tower.y + 1000,
                    }) && sim.wallet[0] === wallet,
                    'unfinished cannon rejects launch without spending',
                );
                rows.push({ scenario: 'contested capture and unfinished cannon reject', wallet });
            }
            // Global range, capture income and loss remain part of the worker scenario.
            {
                const sim = arena();
                check(
                    sim.applyCommand('host', { type: 'UPGRADE_LAUNCH_RANGE' }),
                    'buy shared range before capturing',
                );
                sim.wallet[0] = 500;
                const [tower] = smallProjects(sim, start(sim));
                finish(sim, tower);
                check(
                    sim.applyCommand('host', {
                        type: 'LAUNCH',
                        cannonId: tower.id,
                        unitType: 'pea',
                        holdMs: 1500,
                        x: tower.x,
                        y: tower.y + 2000,
                    }),
                    'completed worker-built cannon accepts launch',
                );
                const fire = sim.events.find(
                        (e) => e.type === 'launchFire' && e.cannonId === tower.id,
                    ),
                    reach = Math.hypot(fire.aimX - tower.x, fire.aimY - tower.y);
                check(Math.abs(reach - 850) <= 1, 'worker-built cannon inherits global range');
                const income = arena(20, 3),
                    towers = smallProjects(income, start(income));
                for (const b of towers) finish(income, b);
                income.wallet[0] = 0;
                income.launchIncomeCarry[0] = 0;
                step(income, income.tps);
                check(income.wallet[0] === 30, 'three completed worker projects give30 income');
                const clear = income.exportState();
                clear.units = [];
                income.importState(clear);
                destroy(
                    income,
                    income.buildings.find((b) => b.id === towers[0].id),
                );
                income.wallet[0] = 0;
                income.launchIncomeCarry[0] = 0;
                step(income, income.tps);
                check(income.wallet[0] === 25, 'destroyed capture stops its income');
                const loss = arena(),
                    [partial] = start(loss);
                step(loss, 5 * loss.tps);
                const paid = partial.construction.invested,
                    wallet = loss.wallet[0];
                destroy(loss, partial);
                check(
                    paid === 1 && loss.wallet[0] === wallet && loss.capturePoints[0].owner === null,
                    'destroyed worker project loses invested resources',
                );
                rows.push({
                    scenario: 'worker-built cannon range, capture income and construction loss',
                    reach,
                    incomeAfterLoss: income.wallet[0],
                    lostInvestment: paid,
                });
            }
            // Completed towers retain their single-target basic defense; unfinished
            // structures do not inherit that attack while their workers are busy.
            {
                const sim = arena(),
                    [tower] = smallProjects(sim, start(sim));
                finish(sim, tower);
                const workerState = sim.exportState();
                workerState.units = [];
                sim.importState(workerState);
                const one = sim.spawnUnit(1, 'pea', tower.x + 150, tower.y),
                    two = sim.spawnUnit(1, 'pea', tower.x + 180, tower.y + 50);
                for (const u of [one, two]) u.hp = u.maxHp = 10000;
                const hits = [];
                step(sim, 2 * sim.tps, (s) =>
                    hits.push(
                        ...s.events
                            .filter((e) => e.type === 'hit' && e.sourceId === tower.id)
                            .map((e) => ({ tick: s.tick, targetId: e.targetId, amount: e.amount })),
                    ),
                );
                check(
                    hits.length === 2 &&
                        hits.every((e) => e.amount === 10) &&
                        hits[1].tick - hits[0].tick === sim.tps,
                    'finished tower retains10 damage single-target attacks every second',
                    hits,
                );
                const incomplete = arena(),
                    [site] = start(incomplete, { workers: 0 });
                incomplete.spawnUnit(1, 'pea', site.x + 150, site.y);
                const forbidden = [];
                step(incomplete, incomplete.tps, (s) =>
                    forbidden.push(
                        ...s.events.filter((e) => e.type === 'hit' && e.sourceId === site.id),
                    ),
                );
                check(forbidden.length === 0, 'unfinished structure cannot use its basic attack');
                rows.push({ scenario: 'completed tower retains its basic defense', hits });
            }
            // Construction also belongs to ordinary buildings without a capture-point
            // association. A trusted mission configures the existing base capability.
            {
                const sim = arena(),
                    state = sim.exportState(),
                    base = state.buildings.find((b) => b.id === 'base0');
                base.construction = ConstructionRules.create(
                    { cost: 3, workRequired: 7, initialHpRatio: 0.1 },
                    sim.tick,
                );
                base.hp = ConstructionRules.healthAt(base.construction, base.maxHp, 0);
                sim.importState(state);
                const building = sim.buildings.find((b) => b.id === 'base0');
                sim.spawnUnit(
                    0,
                    'rice',
                    building.x + sim.buildingClearanceDistance('rice', building) + 0.75,
                    building.y,
                );
                step(sim, 1);
                const hits = [],
                    captures = [];
                step(sim, 7 * sim.tps, (s) => {
                    hits.push(...s.events.filter((e) => e.type === 'constructionHit'));
                    captures.push(...s.events.filter((e) => e.type === 'captureComplete'));
                });
                check(
                    building.construction === null &&
                        building.hp === building.maxHp &&
                        hits.length === 7 &&
                        hits.reduce((n, e) => n + e.spend, 0) === 3 &&
                        captures.length === 0,
                    'ordinary building completes its work and price without requiring a capture point',
                );
                rows.push({
                    scenario: 'ordinary building capability completes without capture ownership',
                    workHits: hits.length,
                    spend: hits.reduce((n, e) => n + e.spend, 0),
                    captureEvents: captures.length,
                });
            }
            // Snapshots around the first payment must preserve independent work,
            // invested money, worker phase and future deterministic results.
            {
                const sim = arena(),
                    [tower] = start(sim);
                step(sim, 4 * sim.tps);
                check(
                    tower.construction.workDone === 4 && tower.construction.invested === 0,
                    'checkpoint before the first payment has four work and zero spent',
                );
                check(
                    sim.applyCommand('host', { type: 'UPGRADE_LAUNCH_RANGE' }),
                    'range investment during worker action',
                );
                let copy = restore(sim);
                const before = sim.checksum(),
                    snap = sim.snapshot();
                snap.buildings.find((b) => b.id === tower.id).construction.workDone = 99;
                snap.units[0].constructionWork.nextHitTick = 0;
                check(
                    sim.checksum() === before,
                    'snapshot work and action mutation cannot change authority',
                );
                for (let i = 0; i < sim.tps; i++) {
                    sim.stepSimulation();
                    copy.stepSimulation();
                    check(
                        sim.checksum() === copy.checksum(),
                        'work4 checkpoint crosses the first payment identically',
                    );
                }
                check(
                    tower.construction.workDone === 5 && tower.construction.invested === 1,
                    'restored checkpoint reaches five work and one payment',
                );
                copy = restore(sim);
                for (let i = 0; i < 6 * sim.tps; i++) {
                    sim.stepSimulation();
                    copy.stepSimulation();
                    check(
                        sim.checksum() === copy.checksum(),
                        'post-payment checkpoint preserves work and next boundaries',
                    );
                }
                rows.push({
                    scenario:
                        'work-before-payment and post-payment checkpoints restore exact future',
                    checksum: sim.checksum(),
                });
            }
            return { seed, viewport: { width: 1280, height: 800 }, rows };
        });
        await page.locator('#gameStartBtn').click();
        await page.locator('#gameScreen').waitFor({ state: 'visible', timeout: 35000 });
        await page.waitForFunction(
            () =>
                Object.values(window.__economyE2E.MatchLifecycle.singleMatch?.sessions || {})
                    .length === 2 &&
                Object.values(window.__economyE2E.MatchLifecycle.singleMatch.sessions).every(
                    (s) => s.netcodeSession?.ready && s.sim?.tick >= 4,
                ),
            null,
            { timeout: 15000 },
        );
        await page.locator('#launchRangeBtn').click();
        await page.waitForFunction(
            () =>
                Object.values(window.__economyE2E.MatchLifecycle.singleMatch.sessions).every(
                    (s) => s.sim?.launchRangeLevel?.[0] === 1,
                ),
            null,
            { timeout: 15000 },
        );
        await page.waitForFunction(
            () => document.querySelector('#launchRangeBtn')?.textContent.includes('375'),
            null,
            { timeout: 5000 },
        );
        const ui = await page.evaluate(() => {
            const q = window.__economyE2E,
                sessions = Object.values(q.MatchLifecycle.singleMatch.sessions);
            return {
                button: document.querySelector('#launchRangeBtn').textContent,
                income: document.querySelector('#launchIncomeText').textContent,
                wallet: document.querySelector('#launchEnergyText').textContent,
                levels: sessions.map((s) => s.sim.launchRangeLevel),
                recorded: sessions.map(
                    (s) =>
                        s.replayRecorder.commands.filter(
                            (c) => c.actor === 'host' && c.action.type === 'UPGRADE_LAUNCH_RANGE',
                        ).length,
                ),
                rtc: Object.values(q.MatchLifecycle.singleMatch.transports).map(
                    (t) => t.room.peerConnection.connectionState,
                ),
                ticks: sessions.map((s) => s.sim.tick),
                seeds: sessions.map((s) => s.sim.seed),
                modes: sessions.map((s) => s.netcodeSession.profile.mode),
            };
        });
        assert(
            ui.wallet.endsWith('/ 500') && ui.income === '+15/초' && ui.button.includes('375'),
            'native HUD displays the converted currency',
        );
        assert(
            ui.modes.every((value) => value === mode),
            'selected netcode mode reaches both real peers',
        );
        assert(
            ui.recorded.every((n) => n === 1),
            'native purchase reaches both replay recorders exactly once',
        );
        assert(
            ui.rtc.every((s) => s === 'connected'),
            'real RTC peers carry the upgrade command',
        );
        const ranges = await page.evaluate(async () => {
            const { StrategySim } = await import(
                new URL('./src/sim/strategy-sim.js', location.href)
            );
            const { WorldContext } = await import(
                new URL('./src/sim/world-context.js', location.href)
            );
            const { BattlefieldProjection } = await import(
                new URL('./src/sim/terrain.js', location.href)
            );
            const r = window.__economyE2E.ActiveViewState.renderer,
                map = structuredClone(new StrategySim(12345).mapDescriptor);
            const cx = map.width / 2,
                cy = map.height / 2;
            map.terrain = {
                layers: [
                    {
                        id: 'range-highground',
                        level: 2,
                        points: [
                            { x: cx + 100, y: 100 },
                            { x: map.width - 100, y: 100 },
                            { x: map.width - 100, y: map.height - 100 },
                            { x: cx + 100, y: map.height - 100 },
                        ],
                    },
                ],
                ramps: [],
                blockers: [],
                riverPath: [],
                riverBranches: [],
                riverPolygon: [],
                riverBranchPolygons: [],
                riverHalfWidth: 0,
                bridges: [],
            };
            const original = {
                    world: r.world,
                    orientation: r.replayOrientationRole,
                    project: r.worldToPx,
                    line: r.line,
                },
                rows = [];
            const check = (ok, message, details) => {
                if (!ok) throw Error(message + ': ' + JSON.stringify(details));
            };
            try {
                r.world = WorldContext.fromMap(map);
                for (const orientation of ['host', 'guest']) {
                    r.replayOrientationRole = orientation;
                    for (const [type, level, radius] of [
                        ['rice', 0, 500],
                        ['pea', 0, 425],
                        ['redbean', 0, 375],
                        ['rice', 1, 1000],
                        ['rice', 2, 1500],
                    ]) {
                        const projected = [],
                            lines = [];
                        // Observe the real geometry producer and forward every call unchanged.
                        // No renderer or projection result is substituted.
                        r.worldToPx = function (x, y, height) {
                            const xy = original.project.call(this, x, y, height),
                                wx = this.viewX(x),
                                wy = this.viewY(y);
                            projected.push({ x: wx, y: wy, height, xy });
                            return xy;
                        };
                        r.line = function (...args) {
                            lines.push(args);
                            return original.line.apply(this, args);
                        };
                        r.drawLaunchRange({ x: cx, y: cy }, type, level, true);
                        check(
                            lines.length > 30 && projected.length === lines.length * 2,
                            'actual range helper emits projected contour segments',
                            { orientation, type, level, count: lines.length },
                        );
                        for (const p of projected) {
                            check(
                                Math.abs(Math.hypot(p.x - cx, p.y - cy) - radius) < 0.001,
                                'contour uses the cannon center and actual maximum reach',
                                { type, level, radius, p },
                            );
                            check(
                                p.height === r.world.terrain.surfaces.heightAt(p.x, p.y),
                                'each contour vertex uses its own canonical terrain height in either orientation',
                                { orientation, p },
                            );
                            const flat = original.project.call(r, r.viewX(p.x), r.viewY(p.y), 0);
                            check(
                                Math.abs(
                                    flat[1] -
                                        p.xy[1] -
                                        p.height * BattlefieldProjection.heightScale * r.sc(),
                                ) < 0.001,
                                'highground contour uses the shared screen projection',
                                { orientation, p, flat },
                            );
                        }
                        check(
                            projected.some((p) => p.height > 0) &&
                                projected.some((p) => p.height === 0),
                            'scenario spans both low and high terrain',
                            { orientation, type },
                        );
                        for (const [i, line] of lines.entries())
                            check(
                                Math.hypot(
                                    line[0] - projected[i * 2].xy[0],
                                    line[1] - projected[i * 2].xy[1],
                                    line[2] - projected[i * 2 + 1].xy[0],
                                    line[3] - projected[i * 2 + 1].xy[1],
                                ) < 0.001,
                                'drawn line endpoints match actual projected contour vertices',
                                { i },
                            );
                        rows.push({ orientation, type, level, radius, segments: lines.length });
                    }
                }
            } finally {
                r.world = original.world;
                r.replayOrientationRole = original.orientation;
                r.worldToPx = original.project;
                r.line = original.line;
            }
            return { seed: 12345, cannon: { x: cx, y: cy }, rows };
        });
        const meters = await page.evaluate(async () => {
            const { ConstructionRules } = await import(
                new URL('./src/sim/construction-rules.js', location.href)
            );
            const r = window.__economyE2E.ActiveViewState.renderer,
                canvas = document.createElement('canvas');
            canvas.width = 240;
            canvas.height = 250;
            const ctx = canvas.getContext('2d'),
                rows = [],
                original = ctx.fillRect;
            const check = (ok, message, details) => {
                if (!ok) throw Error(message + ': ' + JSON.stringify(details));
            };
            const cases = [
                {
                    name: 'one ordinary hit',
                    cost: 75,
                    workRequired: 375,
                    workDone: 1,
                    invested: 0,
                    fill: [1, 0, 0, 0, 0],
                    remaining: 4,
                    amount: 1,
                },
                {
                    name: 'three ordinary hits',
                    cost: 75,
                    workRequired: 375,
                    workDone: 3,
                    invested: 0,
                    fill: [1, 1, 1, 0, 0],
                    remaining: 2,
                    amount: 1,
                },
                {
                    name: 'one specialist hit adding3',
                    cost: 75,
                    workRequired: 375,
                    workDone: 3,
                    invested: 0,
                    fill: [1, 1, 1, 0, 0],
                    remaining: 2,
                    amount: 1,
                },
                {
                    name: 'next interval after spending',
                    cost: 75,
                    workRequired: 375,
                    workDone: 5,
                    invested: 1,
                    fill: [0, 0, 0, 0, 0],
                    remaining: 5,
                    amount: 1,
                },
                {
                    name: 'three-cost seven-work project',
                    cost: 3,
                    workRequired: 7,
                    workDone: 1,
                    invested: 0,
                    fill: [1, 2 / 3, 0, 0, 0],
                    remaining: 2,
                    amount: 1,
                },
                {
                    name: '75-cost150-work project',
                    cost: 75,
                    workRequired: 150,
                    workDone: 1,
                    invested: 0,
                    fill: [1, 1, 0.5, 0, 0],
                    remaining: 1,
                    amount: 1,
                },
                {
                    name: 'price greater than work',
                    cost: 8,
                    workRequired: 3,
                    workDone: 0,
                    invested: 0,
                    fill: [0, 0, 0, 0, 0],
                    remaining: 1,
                    amount: 2,
                },
                {
                    name: 'uneven next payment',
                    cost: 8,
                    workRequired: 3,
                    workDone: 1,
                    invested: 2,
                    fill: [0, 0, 0, 0, 0],
                    remaining: 1,
                    amount: 3,
                },
                {
                    name: 'payment flash completes all five cells',
                    cost: 75,
                    workRequired: 375,
                    workDone: 5,
                    invested: 1,
                    fill: [1, 1, 1, 1, 1],
                    remaining: 5,
                    amount: 1,
                    impact: { fx: { spend: 1 }, pulse: 1 },
                },
                {
                    name: 'free project has no expense cells',
                    cost: 0,
                    workRequired: 7,
                    workDone: 1,
                    invested: 0,
                    fill: null,
                },
            ];
            try {
                for (const [index, c] of cases.entries()) {
                    const work = ConstructionRules.create(
                        { cost: c.cost, workRequired: c.workRequired, initialHpRatio: 0.1 },
                        0,
                    );
                    Object.assign(work, { workDone: c.workDone, invested: c.invested });
                    const calls = [];
                    ctx.fillRect = function (...args) {
                        calls.push({ args, color: this.fillStyle });
                        return original.apply(this, args);
                    };
                    const y = index * 24 + 6,
                        next = r.drawConstructionPaymentMeter(ctx, work, 120, y, 100, 10, c.impact);
                    if (!c.fill)
                        check(
                            next === null && calls.length === 0,
                            'free work has no payment meter',
                            c,
                        );
                    else {
                        check(
                            next.workRemaining === c.remaining && next.amount === c.amount,
                            'meter reads the actual next payment threshold',
                            { c, next },
                        );
                        const fills = calls
                            .filter((_, i) => i % 2 === 1)
                            .map((call) => call.args[2] / ((100 - 12) / 5));
                        check(
                            fills.length === 5 &&
                                fills.every((n, i) => Math.abs(n - c.fill[i]) < 0.000001),
                            'actual canvas fills normalize the expense interval without a five-hit rule',
                            { c, fills },
                        );
                        for (let i = 0; i < 5; i++) {
                            const pixel = ctx.getImageData(
                                Math.floor(70 + i * (17.6 + 3) + 8),
                                y + 5,
                                1,
                                1,
                            ).data;
                            if (c.fill[i] > 0.5)
                                check(
                                    pixel[0] > 0 && pixel[2] > 0,
                                    'filled cells reach actual canvas pixels',
                                    { name: c.name, i, pixel: [...pixel] },
                                );
                            if (c.fill[i] === 0)
                                check(
                                    pixel[0] === 0 && pixel[2] === 0,
                                    'empty cells remain empty on the actual canvas',
                                    { name: c.name, i, pixel: [...pixel] },
                                );
                        }
                    }
                    rows.push({ name: c.name, next, fill: c.fill });
                }
            } finally {
                ctx.fillRect = original;
            }
            return { rows, image: canvas.toDataURL('image/png') };
        });
        fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(
            path.join(output, 'payment-meter.png'),
            Buffer.from(meters.image.split(',')[1], 'base64'),
        );
        delete meters.image;
        await page.screenshot({ path: path.join(output, 'range-upgrade-desktop.png') });
        await page.setViewportSize({ width: 412, height: 915 });
        await page.screenshot({ path: path.join(output, 'range-upgrade-mobile.png') });
        assert.deepEqual(pageErrors, [], 'scenario browser page errors');
        fs.writeFileSync(
            path.join(output, 'result.json'),
            JSON.stringify({ ...result, ui, ranges, meters }, null, 2),
        );
        console.log(JSON.stringify({ pass: true, ...result, ui, ranges, meters }, null, 2));
    } finally {
        await browser.close();
        await server.close();
    }
})().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
});
