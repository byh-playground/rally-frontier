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
            const { InteractionGeometry, TerrainNavigation } = await import(
                new URL('./src/sim/navigation.js', location.href)
            );
            const { ConstructionRules } = await import(
                new URL('./src/sim/construction-rules.js', location.href)
            );
            const { CAMPAIGN_STAGES, campaignStage } = await import(
                new URL('./src/definitions/campaign.js', location.href)
            );
            const { CampaignProgress } = await import(
                new URL('./src/ui/campaign-progress.js', location.href)
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
                for (const base of state.baseProducers) base.production.basic.incomePerSecond = 0;
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
                    resourceType: 'basic',
                    extractedResources: 0,
                    production: LaunchRules.productionChannels(LaunchRules.outpostIncomePerSecond),
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
                paymentWork = 1,
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
                        { cost, workRequired, paymentWork, initialHpRatio: 0.1 },
                        1,
                    );
                    b.construction.workDone = workDone;
                    b.construction.invested = Math.floor(
                        (cost * Math.floor(workDone / paymentWork) * paymentWork) / workRequired,
                    );
                    b.hp = ConstructionRules.healthAt(b.construction, b.maxHp, workDone);
                    state.wallet[0] = wallet;
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
            const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
            function secureWithRice(sim, actor, cannon, target, supportDistance = 0) {
                const side = cannon.side;
                const level = sim.launchRangeLevel[side];
                const reach = distance(cannon, target);
                check(
                    reach <= LaunchRules.maxReachOf('rice', level) + supportDistance,
                    'launch can reach the deposit or its support area',
                );
                check(
                    sim.applyCommand(actor, {
                        type: 'LAUNCH',
                        cannonId: cannon.id,
                        unitType: 'rice',
                        holdMs: LaunchRules.holdFor(reach, 'rice', level),
                        x: target.x,
                        y: target.y,
                    }),
                    'launch toward deposit',
                );
                const projectiles = new Set(
                    sim.events
                        .filter(
                            (event) => event.type === 'launchFire' && event.cannonId === cannon.id,
                        )
                        .map((event) => event.projectileId),
                );
                let landed = false;
                for (let i = 0; i < 60 * sim.tps && (!landed || target.owner !== side); i++) {
                    sim.stepSimulation();
                    landed ||= sim.events.some(
                        (event) =>
                            event.type === 'launchLand' &&
                            projectiles.has(event.projectileId) &&
                            distance(event, target) <= LaunchRules.captureHoldRadius,
                    );
                }
                check(landed && target.owner === side, 'launch lands and the deposit is secured', {
                    target,
                    tick: sim.tick,
                    landed,
                });
                return sim.launchCannons(side).find((building) => building.id === target.outpostId);
            }
            function checkOilOpening(sim, actor, side, target) {
                const base = sim.launchCannons(side)[0];
                check(
                    distance(base, target) >
                        LaunchRules.maxReachOf('rice') + LaunchRules.captureHoldRadius,
                    'basic range cannot aim into the oil construction area',
                );
                const beforeUpgrade = restore(sim);
                check(
                    beforeUpgrade.applyCommand(actor, {
                        type: 'LAUNCH',
                        cannonId: base.id,
                        unitType: 'rice',
                        x: target.x,
                        y: target.y,
                        holdMs: LaunchRules.chargeMs,
                    }),
                    'basic range still launches toward the oil side',
                );
                const unbuilt = beforeUpgrade.capturePoints.find((p) => p.id === target.id);
                step(beforeUpgrade, 60 * beforeUpgrade.tps);
                check(
                    unbuilt.owner === null && unbuilt.outpostId === null,
                    'basic range leaves oil neutral',
                );
                check(
                    sim.applyCommand(actor, { type: 'UPGRADE_LAUNCH_RANGE' }),
                    'buy one upgrade from home',
                );
                const cannon = secureWithRice(sim, actor, base, target);
                check(
                    sim.launchRangeLevel[side] === 1 &&
                        sim.capturePoints
                            .filter((point) => point.owner === side)
                            .every((point) => point.id === target.id),
                    'the first upgrade earns the oil cannon without a forward expansion',
                );
                return cannon;
            }
            // The compact campaign lets the player support the next fight from owned ground.
            {
                const openStage = (stage) =>
                    new StrategySim(
                        stage.seed,
                        { ...GameRuleDefinition.resolve(), campaign: stage },
                        [stage.deck, stage.enemyDeck],
                    );
                const layouts = [];
                const towerDefinitions = ['mainBase', 'outpost'].map((role) =>
                    BuildingDefinition.get(BuildingDefinition.forRole(role)),
                );
                const towerEnvelope =
                    Math.max(...towerDefinitions.map((d) => d.range + (d.mortar?.radius ?? 0))) +
                    Math.max(...towerDefinitions.map((d) => d.size));
                for (const stage of CAMPAIGN_STAGES) {
                    const sim = openStage(stage);
                    const { world, capturePoints: points, mapDescriptor } = sim;
                    const [home, enemy] = world.bases;
                    const advance = points.find((p) => p.id === 'advance');
                    const center = points.find((p) => p.id === 'center');
                    const oil = points.find((p) => p.resourceType === 'premium');
                    const enemies = points.filter((p) => p.owner === 1);
                    check(
                        world.width === 2400 &&
                            world.height === 3000 &&
                            distance(home, enemy) === 2200,
                        'the compact campaign keeps its map size and base separation',
                        stage.id,
                    );
                    const towerPositions = [
                        { id: 'home', ...home },
                        { id: 'enemy', ...enemy },
                        ...points,
                    ];
                    const towerPairs = towerPositions.flatMap((a, i) =>
                        towerPositions.slice(i + 1).map((b) => ({
                            from: a.id,
                            to: b.id,
                            distance: distance(a, b),
                        })),
                    );
                    const nearestPair = towerPairs.reduce((nearest, pair) =>
                        pair.distance < nearest.distance ? pair : nearest,
                    );
                    check(
                        nearestPair.distance > towerEnvelope,
                        'every potential opposing tower pair is beyond automatic fire and mortar splash',
                        { stage: stage.id, nearestPair, towerEnvelope },
                    );
                    const landing = LaunchRules.target(
                        home,
                        advance.x,
                        advance.y,
                        LaunchRules.chargeMs,
                        world,
                        enemy,
                        'rice',
                    );
                    check(
                        distance(landing, advance) < LaunchRules.captureHoldRadius,
                        'the initial rice cannon can land workers close enough to secure the first site',
                        { stage: stage.id, landing, advance },
                    );
                    check(
                        enemies.map((p) => p.id).join(',') === stage.enemyOutposts.join(',') &&
                            [advance, center].every(
                                (point) =>
                                    point.owner ===
                                    (stage.friendlyOutposts?.includes(point.id) ? 0 : null),
                            ),
                        'stages start with their authored friendly and enemy outposts',
                        stage.id,
                    );
                    check(
                        [home, enemy, ...points].every(
                            (p) =>
                                world.terrain.field.polygonCircleClear(p.x, p.y, 42) &&
                                world.terrain.surfaces.buildable(p.x, p.y, 42),
                        ) &&
                            new TerrainNavigation({ world, tick: 0, buildings: [] }).connected(
                                home,
                                [enemy, ...points],
                                sim.maxUnitRadius,
                            ),
                        'all campaign pads are buildable and connected, including elevated pads',
                        stage.id,
                    );
                    const reach = Math.min(
                        ...stage.deck.map((type) => LaunchRules.maxReachOf(type, 2)),
                    );
                    const pairs = points.flatMap((point, index) =>
                        points.slice(index + 1).map((other) => distance(point, other)),
                    );
                    const directPairs = pairs.filter((length) => length <= reach).length;
                    check(
                        directPairs >= Math.ceil(pairs.length * 0.8) &&
                            enemies.every((p) => distance(center, p) <= reach),
                        'third range tier directly reaches most outpost pairs and every enemy defense from center',
                        { stage: stage.id, reach, directPairs, pairs: pairs.length },
                    );
                    check(
                        !!oil === !!stage.resourceLesson &&
                            (!oil ||
                                (oil.owner === null &&
                                    distance(advance, oil) >
                                        LaunchRules.maxReachOf('rice') +
                                            LaunchRules.captureHoldRadius &&
                                    distance(home, oil) <= LaunchRules.maxReachOf('rice', 1))),
                        'only lesson maps have one side oil site, with a direct shot from home after one range upgrade',
                        stage.id,
                    );
                    layouts.push({
                        stage: stage.id,
                        nearestPair,
                        directPairs,
                        pairs: pairs.length,
                        ramps: mapDescriptor.terrain.ramps.length,
                    });
                }
                {
                    const lesson = campaignStage('volley-practice'),
                        first = campaignStage('first'),
                        bean = campaignStage('bean'),
                        goal = lesson.volleyGoal;
                    const storage = new Map();
                    const progress = new CampaignProgress({
                        getItem: (key) => storage.get(key),
                        setItem: (key, value) => storage.set(key, value),
                    });
                    check(!progress.canStart(lesson), 'practice opens after the first stage');
                    progress.complete(first);
                    check(
                        progress.canStart(lesson) &&
                            progress.canStart(bean) &&
                            progress.nextStage === bean,
                        'practice is available without blocking the main campaign',
                    );
                    progress.complete(lesson);
                    check(
                        progress.isComplete(lesson) && progress.nextStage === bean,
                        'the optional clear saves separately from main campaign progression',
                    );

                    function launchLesson(sim, aim, readyCannons) {
                        const cannons = sim.launchCannons(0),
                            primary = cannons.find((cannon) => cannon.id === 'base0'),
                            level = sim.launchRangeLevel[0];
                        check(
                            cannons.length === 3 && level === 1,
                            'practice starts with three cannons and range ×2',
                        );
                        for (const cannon of cannons
                            .filter((cannon) => cannon !== primary)
                            .slice(readyCannons - 1))
                            cannon.launchReadyTick = sim.tick + 4 * sim.tps;
                        const beforeLaunch = sim.events.length;
                        check(
                            sim.applyCommand('host', {
                                type: 'LAUNCH',
                                cannonId: primary.id,
                                unitType: 'rice',
                                x: aim.x,
                                y: aim.y,
                                holdMs: LaunchRules.holdFor(distance(primary, aim), 'rice', level),
                            }),
                            'launch is accepted in practice',
                        );
                        const fire = sim.events
                            .slice(beforeLaunch)
                            .filter((event) => event.type === 'launchFire');
                        check(
                            new Set(fire.map((event) => event.cannonId)).size === readyCannons,
                            'practice uses exactly the ready cannons that reach the aim',
                            { readyCannons, fired: fire.map((event) => event.cannonId) },
                        );
                        return new Set(fire.map((event) => event.projectileId));
                    }

                    const practice = openStage(lesson),
                        garrisonIds = new Set(practice.campaignVolleyPractice.garrisonIds),
                        initialVision = practice.visionSources(0);
                    const survivingGarrison = (sim) =>
                        sim.units.filter((unit) => unit.alive && garrisonIds.has(unit.id));
                    const defenders = survivingGarrison(practice);
                    check(
                        garrisonIds.size === 16 &&
                            defenders.length === 16 &&
                            new Set(defenders.map((unit) => unit.x)).size === 4 &&
                            new Set(defenders.map((unit) => unit.y)).size === 4 &&
                            new Set(defenders.map((unit) => `${unit.x},${unit.y}`)).size === 16 &&
                            defenders.every(
                                (unit) =>
                                    unit.side === 1 &&
                                    unit.type === 'pea' &&
                                    distance(unit, goal) <= goal.radius &&
                                    practice.canSeeCombatTarget(0, unit, initialVision),
                            ),
                        'the marked circle begins with sixteen visible enemy pea defenders in a grid',
                    );
                    const launchIds = launchLesson(practice, goal, 3);
                    check(
                        launchIds.size === 15 && practice.launchStats.sent[0] === 28,
                        'the marked practice shot launches fifteen shells with twenty-eight rice',
                    );
                    check(
                        practice.stepSimulation() === null && practice.projectiles.length > 0,
                        'practice does not clear while the volley is still in flight',
                    );
                    const restored = openStage(lesson);
                    restored.importState(practice.exportState());
                    check(
                        restored.checksum() === practice.checksum(),
                        'mid-flight practice checkpoint matches',
                    );
                    let landed = 0,
                        landedInGoal = false,
                        winner = null,
                        volleys = 1;
                    const riceCost = LaunchRules.payload('rice').cost;
                    for (let i = 0; i < 25 * practice.tps && !winner; i++) {
                        winner = practice.stepSimulation();
                        for (const event of practice.events) {
                            if (event.type !== 'launchLand' || !launchIds.has(event.projectileId))
                                continue;
                            landed += event.count;
                            landedInGoal ||= distance(event, goal) <= goal.radius;
                        }
                        check(
                            restored.stepSimulation() === winner &&
                                restored.checksum() === practice.checksum(),
                            'practice objective resolves identically after restoring the volley',
                        );
                        if (
                            !winner &&
                            practice.tick % (5 * practice.tps) === 0 &&
                            practice.wallet[0] >= riceCost
                        ) {
                            launchLesson(practice, goal, 3);
                            launchLesson(restored, goal, 3);
                            check(
                                restored.checksum() === practice.checksum(),
                                'both runs accept the same follow-up volley after restoring',
                            );
                            volleys++;
                        }
                    }
                    check(
                        winner === 'host' &&
                            landed === 28 &&
                            landedInGoal &&
                            !survivingGarrison(practice).length,
                        'a three-cannon hit clears practice after deployment and garrison defeat',
                        {
                            winner,
                            landed,
                            landedInGoal,
                            volleys,
                            remaining: survivingGarrison(practice).length,
                        },
                    );

                    const holdout = openStage(lesson),
                        toughGuard = survivingGarrison(holdout)[0];
                    toughGuard.hp = toughGuard.maxHp = 100000;
                    launchLesson(holdout, goal, 3);
                    for (let i = 0; i < 4 * holdout.tps; i++)
                        check(
                            holdout.stepSimulation() === null,
                            'a surviving defender prevents a clear',
                        );
                    check(
                        holdout.campaignVolleyPractice.landed &&
                            !holdout.campaignVolleyPractice.projectileIds.length &&
                            toughGuard.alive,
                        'a valid landed volley alone does not clear the lesson',
                    );

                    for (const [readyCannons, aim] of [
                        [1, goal],
                        [2, goal],
                        [3, { x: goal.x, y: goal.y + goal.radius * 2 }],
                    ]) {
                        const miss = openStage(lesson);
                        launchLesson(miss, aim, readyCannons);
                        for (let i = 0; i < 4 * miss.tps; i++)
                            check(
                                miss.stepSimulation() === null,
                                'wrong aim or fewer than three cannons cannot clear practice',
                                { readyCannons, aim },
                            );
                        check(
                            !miss.campaignVolleyPractice.landed,
                            'the objective never credits an ineligible shot',
                            { readyCannons, aim },
                        );
                    }
                    rows.push({
                        scenario: 'optional three-cannon practice clears after garrison defeat',
                        projectiles: launchIds.size,
                        troops: practice.launchStats.sent[0],
                        defenders: garrisonIds.size,
                        volleys,
                        clearTick: practice.tick,
                    });
                }
                const oilLesson = openStage(campaignStage('millet'));
                const lessonOil = oilLesson.capturePoints.find((p) => p.resourceType === 'premium');
                const lessonCannon = checkOilOpening(oilLesson, 'host', 0, lessonOil);
                const oilCaptureSeconds = oilLesson.tick / oilLesson.tps;
                const acorn = LaunchRules.payload('acorn');
                step(oilLesson, (acorn.premiumCost / 2.5) * oilLesson.tps);
                const enemyBase = oilLesson.world.bases[1];
                check(
                    oilLesson.applyCommand('host', {
                        type: 'LAUNCH',
                        cannonId: lessonCannon.id,
                        unitType: 'acorn',
                        x: enemyBase.x,
                        y: enemyBase.y,
                        holdMs: LaunchRules.chargeMs,
                    }) && oilLesson.premiumWallet[0] === 0,
                    'oil-only campaign opening funds the lesson unit',
                );
                const opening = openStage(campaignStage('first'));
                const home = opening.launchCannons(0)[0];
                const advance = opening.capturePoints.find((p) => p.id === 'advance');
                for (let shot = 0; shot < 2; shot++) {
                    check(
                        opening.applyCommand('host', {
                            type: 'LAUNCH',
                            cannonId: home.id,
                            unitType: 'rice',
                            x: advance.x,
                            y: advance.y,
                            holdMs: LaunchRules.holdFor(distance(home, advance), 'rice', 0),
                        }),
                        'first campaign landing can send construction workers from the home cannon',
                    );
                    step(opening, opening.tps);
                }
                for (let i = 0; advance.owner !== 0 && i < 90 * opening.tps; i++)
                    opening.stepSimulation();
                check(
                    advance.owner === 0,
                    'the opening rice waves complete the first campaign outpost',
                    {
                        tick: opening.tick,
                        advance,
                        construction: opening.buildingById.get(advance.outpostId)?.construction,
                    },
                );
                const openingCaptureSeconds = opening.tick / opening.tps;
                const damage = [];
                for (const [sourceId, targetId] of [
                    ['advance', 'enemy-front'],
                    ['advance', 'enemy-ridge'],
                    ['center', 'enemy-rear'],
                ]) {
                    const sim = openStage(campaignStage('breakthrough'));
                    const source = sim.capturePoints.find((p) => p.id === sourceId);
                    const target = sim.capturePoints.find((p) => p.id === targetId);
                    const cannon = sim.spawnOutpost(source, 0);
                    cannon.hp = cannon.maxHp;
                    sim.completeConstruction(cannon);
                    for (let level = 0; level < 2; level++) {
                        sim.wallet[0] = LaunchRules.walletCap;
                        check(
                            sim.applyCommand('host', { type: 'UPGRADE_LAUNCH_RANGE' }),
                            'range upgrade is legal',
                        );
                    }
                    sim.wallet[0] = LaunchRules.walletCap;
                    const defense = sim.buildingById.get(target.outpostId);
                    const before = defense.hp;
                    check(
                        sim.applyCommand('host', {
                            type: 'LAUNCH',
                            cannonId: cannon.id,
                            unitType: 'redbean',
                            x: target.x,
                            y: target.y,
                            holdMs: LaunchRules.holdFor(distance(cannon, target), 'redbean', 2),
                        }),
                        'third-tier cannon fires the shortest-range campaign shell',
                    );
                    let shellDamage = 0;
                    step(sim, 3 * sim.tps, (state) => {
                        for (const event of state.events) {
                            if (
                                event.type === 'hit' &&
                                event.targetId === defense.id &&
                                event.sourceId === cannon.id &&
                                event.sourceType === 'redbean'
                            )
                                shellDamage += event.amount;
                        }
                    });
                    check(
                        shellDamage > 0 && defense.hp < before,
                        'direct shell hits the intended enemy outpost',
                        {
                            sourceId,
                            targetId,
                        },
                    );
                    damage.push({ sourceId, targetId, shellDamage });
                }
                rows.push({
                    scenario: 'compact campaign third-tier cannon coverage',
                    layouts,
                    openingCaptureSeconds,
                    oilCaptureSeconds,
                    damage,
                });
            }
            // The opening earns a forward cannon and keeps high resources contestable.
            {
                const sim = new StrategySim(seed),
                    base = sim.launchCannons(0)[0],
                    point = (id) => sim.capturePoints.find((cp) => cp.id === id),
                    natural = point('natural-1'),
                    front = point('front-1'),
                    flank = point('flank-near-1'),
                    center = point('mid-center'),
                    premium = point('oil-near-1'),
                    enemyBase = sim.buildings.find((b) => b.id === 'base1');
                // Keep the target in play long enough to observe the mining and launch cycle.
                enemyBase.hp = enemyBase.maxHp = 100000;
                check(
                    sim.mapDescriptor.generation.accepted &&
                        sim.capturePoints.length === 11 &&
                        sim.capturePoints.filter((cp) => cp.resourceType === 'premium').length ===
                            2 &&
                        center.resourceType === 'basic' &&
                        sim.capturePoints.every((cp) => cp.owner === null),
                    'standard terrain has eleven neutral sites, two side oil sites and center supply',
                    sim.mapDescriptor.generation,
                );
                const supplyOpening = new StrategySim(seed);
                const supplyHome = supplyOpening.launchCannons(0)[0];
                const supplyNatural = supplyOpening.capturePoints.find((p) => p.id === 'natural-1');
                secureWithRice(supplyOpening, 'host', supplyHome, supplyNatural);
                check(
                    supplyOpening.launchRangeLevel[0] === 0 && supplyOpening.premiumWallet[0] === 0,
                    'the supply-first opening takes ground before investing in range',
                );
                const centralDistance = distance(front, center);
                check(
                    centralDistance === distance(point('front-2'), center) &&
                        centralDistance > LaunchRules.maxReachOf('rice', 1) &&
                        centralDistance <= LaunchRules.maxReachOf('rice', 2),
                    'both sides retain direct third-tier support to the center',
                );
                const guest = new StrategySim(seed);
                const guestOil = guest.capturePoints.find((cp) => cp.id === 'oil-near-2');
                check(
                    guestOil.x + premium.x === sim.world.width &&
                        guestOil.y + premium.y === sim.world.height &&
                        distance(guest.world.bases[1], guestOil) === distance(base, premium),
                    'early oil is mirrored for equal first upgrade access',
                );
                checkOilOpening(guest, 'guest', 1, guestOil);
                const guestOilCaptureSeconds = guest.tick / guest.tps;
                const oilCannon = checkOilOpening(sim, 'host', 0, premium);
                const hostOilCaptureSeconds = sim.tick / sim.tps;
                const { basic: supply, premium: oil } = premium.production;
                check(
                    supply.incomePerSecond === 2.5 && oil.incomePerSecond === 2.5,
                    'oil outpost divides the production rate equally',
                );
                const oilAtCapture = sim.premiumWallet[0];
                step(sim, 2 * sim.tps);
                check(
                    sim.premiumWallet[0] - oilAtCapture === 5,
                    'completed oil outpost produces five oil in two seconds',
                );
                const corn = LaunchRules.payload('corn');
                for (
                    let i = 0;
                    i < 55 * sim.tps &&
                    (sim.wallet[0] < corn.cost || sim.premiumWallet[0] < corn.premiumCost);
                    i++
                )
                    sim.stepSimulation();
                const wallet = [sim.wallet[0], sim.premiumWallet[0]];
                check(
                    sim.applyCommand('host', {
                        type: 'LAUNCH',
                        cannonId: oilCannon.id,
                        unitType: 'corn',
                        holdMs: LaunchRules.chargeMs,
                        x: enemyBase.x,
                        y: enemyBase.y,
                    }) &&
                        wallet[0] - sim.wallet[0] === corn.cost &&
                        wallet[1] - sim.premiumWallet[0] === corn.premiumCost,
                    'mined premium and basic resources pay for a corn launch',
                );
                step(sim, sim.tps * 8);
                check(
                    sim.unitResultStats[0].corn.deployed === corn.count,
                    'all corn soldiers deploy',
                );
                // Each wallet pauses independently at its own cap.
                sim.wallet[0] = LaunchRules.walletCap;
                const supplyCarry = supply.miningCarry;
                const extractedBefore = premium.extractedResources;
                const oilBefore = sim.premiumWallet[0];
                step(sim, 2 * sim.tps);
                check(
                    sim.wallet[0] === LaunchRules.walletCap &&
                        supply.miningCarry === supplyCarry &&
                        premium.extractedResources === extractedBefore + 5 &&
                        sim.premiumWallet[0] - oilBefore === 5,
                    'oil production continues while supply is at capacity',
                );
                sim.wallet[0] = 0;
                sim.premiumWallet[0] = LaunchRules.premiumWalletCap;
                const oilCarry = oil.miningCarry;
                const supplyRate = LaunchRules.incomePerSecondFor(
                    [...sim.baseProducers, ...sim.capturePoints],
                    0,
                );
                const copy = restore(sim);
                step(sim, 2 * sim.tps);
                step(copy, 2 * copy.tps);
                check(
                    sim.wallet[0] === 2 * supplyRate &&
                        sim.premiumWallet[0] === LaunchRules.premiumWalletCap &&
                        oil.miningCarry === oilCarry &&
                        sim.checksum() === copy.checksum(),
                    'supply production continues with a capped oil wallet after restore',
                );
                // Rebuild a previously worked site for the other side.
                premium.extractedResources = 1500;
                supply.miningCarry = oil.miningCarry = 0;
                destroy(sim, oilCannon);
                check(premium.owner === null, 'destroying the outpost leaves the site neutral');
                const rebuilt = sim.spawnOutpost(premium, 1);
                sim.completeConstruction(rebuilt);
                check(
                    premium.owner === 1 &&
                        LaunchRules.productionEfficiency(premium) === 50 &&
                        LaunchRules.productionRate(premium, 'basic') === 1.25 &&
                        LaunchRules.productionRate(premium, 'premium') === 1.25,
                    'recapturing the site keeps its efficiency and exact fractional rates',
                );
                sim.wallet[1] = LaunchRules.walletCap;
                sim.premiumWallet[1] = 0;
                for (const expected of [1, 2, 3, 5]) {
                    step(sim, sim.tps);
                    check(
                        sim.premiumWallet[1] === expected,
                        '1.25 oil per second carries the fractional share into later payouts',
                    );
                }
                rows.push({
                    scenario: 'both sides can choose oil from home or advance on supply',
                    hostOilCaptureSeconds,
                    guestOilCaptureSeconds,
                    independentCaps: true,
                    recapturedOilPerSecond: 1.25,
                    cornDeployed: sim.unitResultStats[0].corn.deployed,
                    distances: [
                        distance(base, natural),
                        distance(natural, front),
                        centralDistance,
                        distance(natural, flank),
                    ],
                    tick: sim.tick,
                });
            }
            // The player can buy a global range level with the starting wallet.
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
                        sim.wallet[0] === 250 &&
                        sim.launchRangeLevel[0] === 1 &&
                        sim.launchRangeLevel[1] === 0,
                    '250 resource purchase upgrades only the buying side',
                );
                check(
                    !sim.applyCommand('host', { type: 'UPGRADE_LAUNCH_RANGE' }) &&
                        sim.wallet[0] === 250,
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
                    'third upgrade rejects insufficient basic and premium resources',
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
            // Home bases keep producing once spending frees space in the wallet.
            {
                const sim = new StrategySim(seed, GameRuleDefinition.resolve()),
                    base = sim.baseProducers[0];
                check(
                    sim.wallet[0] === 500 &&
                        sim.premiumWallet[0] === 0 &&
                        LaunchRules.walletCap === 500,
                    'full starting basic wallet and empty premium wallet',
                );
                check(
                    LaunchRules.grain('rice').cost +
                        LaunchRules.upgradeCost(0) +
                        BuildingDefinition.get(BuildingDefinition.forRole('outpost')).construction
                            .cost ===
                        LaunchRules.startingWallet + 25,
                    'the opening upgrade, rice launch and oil construction need 25 additional supply',
                );
                check(
                    base.production.basic.incomePerSecond === 15 &&
                        sim.capturePoints.every((point) =>
                            point.resourceType === 'premium'
                                ? point.production.basic.incomePerSecond === 2.5 &&
                                  point.production.premium.incomePerSecond === 2.5
                                : point.production.basic.incomePerSecond === 5 &&
                                  !point.production.premium,
                        ),
                    'main bases, supply outposts and oil outposts use the specified rates',
                );
                step(sim, sim.tps);
                check(
                    sim.wallet[0] === 500 && base.extractedResources === 0,
                    'full wallet pauses production',
                );
                sim.wallet[0] = 495;
                step(sim, sim.tps);
                check(sim.wallet[0] === 500, 'production resumes and caps again');

                check(base.extractedResources === 5, 'only the five credited supplies count');
                base.extractedResources = 0;
                for (let interval = 0; interval < 6; interval++) {
                    sim.wallet[0] = 0;
                    step(sim, 20 * sim.tps);
                    check(
                        sim.wallet[0] === 300,
                        'main base produces 15 per second for its first 2 minutes of yield',
                    );
                }
                check(
                    base.extractedResources === 1800 &&
                        LaunchRules.productionEfficiency(base) === 100,
                    'base has full efficiency through the 2-minute yield',
                );
                let intermediate;
                while (base.extractedResources < 4500 && sim.tick < 450 * sim.tps) {
                    sim.wallet[0] = 0;
                    step(sim, 20 * sim.tps);
                    const efficiency = LaunchRules.productionEfficiency(base);
                    if (efficiency > 50 && efficiency < 100) intermediate = efficiency;
                }
                check(
                    intermediate &&
                        base.extractedResources >= 4500 &&
                        LaunchRules.productionEfficiency(base) === 50 &&
                        LaunchRules.productionRate(base, 'basic') === 7.5,
                    'efficiency falls in steps and reaches 50% at the 5-minute yield',
                );
                sim.wallet[0] = 0;
                step(sim, 2 * sim.tps);
                check(sim.wallet[0] === 15, 'the base still produces 7.5 per second at the floor');
                rows.push({
                    scenario:
                        'full 2-minute yield, declining efficiency and continuing production at 50%',
                    produced: base.extractedResources,
                    intermediate,
                    rate: 7.5,
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
                        hits.reduce((n, e) => n + e.workAdded, 0) === 250 &&
                        hits.reduce((n, e) => n + e.spend, 0) === 100,
                    'funded symmetric crowd completes 250 work and spends 100',
                    { hits: hits.length, work: tower.construction },
                );
                rows.push({
                    scenario:
                        'twenty workers approach through crowd contacts and complete without a funded stall',
                    elapsedTicks: sim.tick - begun,
                    work: 250,
                    spend: 100,
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
                    building.construction.cost === 100 &&
                        building.construction.workRequired === 250 &&
                        building.construction.paymentWork === 5 &&
                        building.construction.workDone === 0 &&
                        building.hp === 50 &&
                        building.maxHp === 500,
                    'default project declares 100 cost and 250 work, with 50 of 500 HP at start',
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
                    building.construction.workDone === 5 && building.construction.invested === 2,
                    'fifth actual hit pays the first two supply',
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
                sim.applyDamage(1, 'rice', tower, true, 25, null, { sourceDamageResolved: true });
                const damage = hpBefore - tower.hp;
                step(sim, 250 * sim.tps - 1, (s) =>
                    hits.push(...s.events.filter((e) => e.type === 'constructionHit')),
                );
                check(
                    tower.construction.workDone === 249 &&
                        tower.construction.invested === 98 &&
                        sim.capturePoints[0].owner === null,
                    '249 hits cannot complete a 250-work project',
                );
                const restored = restore(sim);
                step(restored, 1);
                step(sim, 1, (s) =>
                    hits.push(...s.events.filter((e) => e.type === 'constructionHit')),
                );
                check(
                    tower.construction === null &&
                        hits.length === 250 &&
                        hits.every((e, i) => e.spend === ((i + 1) % 5 === 0 ? 2 : 0)) &&
                        hits.reduce((n, e) => n + e.spend, 0) === 100 &&
                        sim.tick - started === 250 * sim.tps &&
                        sim.checksum() === restored.checksum(),
                    'one worker pays two supply on each fifth hit and finishes at 250 hits after a checkpoint',
                );
                check(
                    tower.hp === tower.maxHp - damage,
                    'work-proportional HP preserves damage through full completion',
                );
                rows.push({
                    scenario: 'full 250-hit project spends 100 and preserves damage',
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
                step(sim, 84 * sim.tps, (s) => {
                    hits.push(...s.events.filter((e) => e.type === 'constructionHit'));
                    completed.push(...s.events.filter((e) => e.type === 'captureComplete'));
                });
                check(
                    tower.construction === null &&
                        hits.length === 250 &&
                        completed.length === 1 &&
                        hits.reduce((n, e) => n + e.spend, 0) === 100,
                    'three actual workers finish 250 work in 84 seconds and charge exactly 100',
                );
                const last = nextHitMission({
                    cost: 100,
                    workRequired: 250,
                    paymentWork: 5,
                    workDone: 249,
                    power: 3,
                    wallet: 2,
                });
                check(
                    last.events.length === 1 &&
                        last.events[0].workAdded === 1 &&
                        last.events[0].spend === 2 &&
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
                const grouped = { cost: 100, workRequired: 250, paymentWork: 5 };
                for (let workDone = 0; workDone < 4; workDone++) {
                    const { events, building } = nextHitMission({
                        ...grouped,
                        workDone,
                        wallet: 0,
                    });
                    check(
                        events.length === 0 && building.construction.workDone === workDone,
                        'zero wallet pauses work even before the next payment',
                    );
                }
                const prefix = nextHitMission({ ...grouped, workDone: 3, power: 3, wallet: 1 });
                check(
                    prefix.events.length === 1 &&
                        prefix.events[0].workDone === 4 &&
                        prefix.events[0].spend === 0,
                    'a multiwork hit stops at four when the wallet cannot cover the two-supply payment',
                    prefix.events,
                );
                const {
                    sim,
                    building: tower,
                    events,
                } = nextHitMission({
                    ...grouped,
                    workDone: 4,
                    wallet: 1,
                });
                check(
                    events.length === 0 &&
                        tower.construction.workDone === 4 &&
                        tower.construction.invested === 0,
                    'one supply cannot cross the two-supply payment boundary',
                );
                sim.wallet[0] = 2;
                step(sim, 1);
                check(tower.construction.workDone === 4, 'funding alone cannot create work');
                step(sim, sim.tps - 1);
                check(
                    tower.construction.workDone === 4,
                    'resumed worker still needs a whole work cycle',
                );
                step(sim, 1);
                check(
                    tower.construction.workDone === 5 &&
                        tower.construction.invested === 2 &&
                        sim.wallet[0] === 0,
                    'funded worker crosses the threshold on the next actual hit',
                );
                rows.push({
                    scenario: 'zero wallet pauses work and grouped payments resume when funded',
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
                        tower.hp === 50,
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
            // Assigned workers defend against actual hits without chasing retreating enemies.
            {
                const sim = arena(),
                    [tower] = start(sim),
                    worker = sim.units[0];
                worker.hp = worker.maxHp = 10000;
                const enemies = [
                    sim.spawnUnit(1, 'rice', worker.x, worker.y + 39),
                    sim.spawnUnit(1, 'rice', worker.x, worker.y - 34),
                ];
                for (const enemy of enemies) {
                    enemy.hp = enemy.maxHp = 10000;
                    enemy.combat.cooldownUntil = enemy.combat.moveRecoveryUntil =
                        sim.tick + 10 * sim.tps;
                }
                const workBeforeContact = tower.construction.workDone;
                const workerHits = (world) =>
                    world.events.filter((e) => e.type === 'hit' && e.sourceId === worker.id);
                step(sim, 2 * sim.tps, (world) =>
                    check(
                        workerHits(world).length === 0 && worker.hp === worker.maxHp,
                        'nearby enemies that have not attacked do not interrupt work',
                    ),
                );
                check(
                    tower.construction.workDone > workBeforeContact,
                    'worker keeps building near passive enemies',
                );
                // Exercise the real projectile impact path with no owner on the shell.
                const mortar = BuildingDefinition.get('base').mortar;
                sim.fireMortar(
                    { id: null, side: 1, type: 'base', x: worker.x + 300, y: worker.y },
                    worker,
                    mortar,
                );
                let shellHit;
                for (let i = 0; i <= sim.msTicks(mortar.flightMs) && !shellHit; i++) {
                    step(sim, 1);
                    shellHit = sim.events.find((e) => e.type === 'hit' && e.targetId === worker.id);
                    check(
                        workerHits(sim).length === 0,
                        'an incoming shell does not trigger defense',
                    );
                }
                check(
                    sim.events.some((e) => e.type === 'mortarImpact') &&
                        shellHit?.sourceId === null &&
                        worker.hp < worker.maxHp &&
                        worker.constructionWork?.phase === 'defend',
                    'actual shell damage without an owner puts the worker in defense mode',
                );
                const workBeforeHit = tower.construction.workDone;
                const copy = restore(sim);
                const hits = [];
                step(sim, 2 * sim.tps, (world) => {
                    hits.push(...workerHits(world));
                    copy.stepSimulation();
                    check(
                        world.checksum() === copy.checksum(),
                        'checkpoint retains the defense phase after ownerless shell damage',
                    );
                });
                check(
                    hits.length > 0 &&
                        hits.every((hit) => enemies.some((enemy) => enemy.id === hit.targetId)),
                    'worker fights reachable enemies even when they did not fire the shell',
                );
                check(
                    tower.construction.workDone === workBeforeHit &&
                        worker.constructionWork?.phase === 'defend',
                    'defense pauses work while enemies are within reach',
                );
                for (const [index, enemy] of enemies.entries()) {
                    enemy.x = tower.x + 260;
                    enemy.y = tower.y + 60 * index;
                    enemy.fx = Math.round(enemy.x * FP);
                    enemy.fy = Math.round(enemy.y * FP);
                }
                step(sim, 3 * sim.tps, (world) =>
                    check(
                        workerHits(world).length === 0 &&
                            worker.constructionWork?.targetId === tower.id,
                        'worker stays on the project as enemies retreat',
                    ),
                );
                check(
                    tower.construction.workDone > workBeforeHit,
                    'worker resumes construction while retreating enemies are still alive',
                );
                rows.push({
                    scenario:
                        'ownerless shell damage triggers construction defense without chasing',
                    damageSource: shellHit.sourceId,
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
                step(income, income.tps);
                check(income.wallet[0] === 15, 'three completed worker projects give15 income');
                const clear = income.exportState();
                clear.units = [];
                income.importState(clear);
                destroy(
                    income,
                    income.buildings.find((b) => b.id === towers[0].id),
                );
                income.wallet[0] = 0;
                step(income, income.tps);
                check(income.wallet[0] === 10, 'destroyed capture stops its income');
                const loss = arena(),
                    [partial] = start(loss);
                step(loss, 5 * loss.tps);
                const paid = partial.construction.invested,
                    wallet = loss.wallet[0];
                destroy(loss, partial);
                check(
                    paid === 2 && loss.wallet[0] === wallet && loss.capturePoints[0].owner === null,
                    'destroyed worker project loses invested resources',
                );
                rows.push({
                    scenario: 'worker-built cannon range, capture income and construction loss',
                    reach,
                    incomeAfterLoss: income.wallet[0],
                    lostInvestment: paid,
                });
            }
            for (const type of ['outpost', 'base']) {
                const sim = arena(),
                    tower =
                        type === 'outpost'
                            ? smallProjects(sim, start(sim))[0]
                            : sim.buildings.find((b) => b.id === 'base0');
                if (tower.construction) finish(sim, tower);
                check(tower.maxHp === (type === 'base' ? 2400 : 500), 'tower HP matches its role');
                const state = sim.exportState(),
                    enemyBase = state.buildings.find((b) => b.id === 'base1'),
                    { x, y } = tower;
                state.units = [];
                enemyBase.x = x + 501;
                enemyBase.y = y;
                enemyBase.cooldownUntil = sim.tick + 10 * sim.tps;
                const spot = () => sim.spawnUnit(0, 'rice', x + 440, y - 100);
                const attacks = (s) =>
                    s.events.filter((e) => e.type === 'hit' && e.sourceId === tower.id);
                sim.importState(state);
                spot();
                step(sim, 1);
                check(!attacks(sim).length, 'a visible enemy at distance 501 is out of range');
                enemyBase.x = x + 500;
                sim.importState(state);
                step(sim, 1);
                check(!attacks(sim).length, 'an unspotted enemy at 500 remains hidden');
                sim.importState(state);
                const ally = spot();
                const firstShotTick = sim.tick + 1,
                    attackInterval = sim.msTicks(500);
                const hits = [];
                step(sim, 4 * attackInterval, (s) =>
                    hits.push(
                        ...attacks(s).map((e) => ({
                            tick: s.tick,
                            targetId: e.targetId,
                            amount: e.amount,
                        })),
                    ),
                );
                check(
                    hits.length === 4 &&
                        hits.every(
                            (e, i) =>
                                e.amount === 8 &&
                                e.targetId === enemyBase.id &&
                                e.tick === firstShotTick + i * attackInterval,
                        ),
                    'four basic attacks deal 8 damage at distance 500 every 0.5 seconds',
                    hits,
                );
                const restored = arena();
                restored.importState(sim.exportState());
                step(sim, 1);
                step(restored, 1);
                const fire = sim.events.find((e) => e.type === 'mortarFire');
                check(
                    fire?.cannonId === tower.id &&
                        !attacks(sim).length &&
                        sim.projectiles.length === 1 &&
                        sim.checksum() === restored.checksum(),
                    'the fifth attack fires only a mortar and survives a pre-fire checkpoint',
                    { fire, hits: attacks(sim) },
                );
                const near = [
                    sim.spawnUnit(1, 'rice', x + 435, y + 67),
                    sim.spawnUnit(1, 'pea', x + 435, y - 67),
                ];
                const outside = sim.spawnUnit(1, 'pea', x + 590, y + 60);
                step(sim, 5);
                check(
                    sim.projectiles.length === 1,
                    'the mortar is still airborne after five ticks',
                );
                restored.importState(sim.exportState());
                let impact, blastHits;
                for (let i = 0; i < sim.tps && !impact; i++) {
                    step(sim, 1);
                    step(restored, 1);
                    impact = sim.events.find((e) => e.type === 'mortarImpact');
                    blastHits = attacks(sim);
                    check(sim.checksum() === restored.checksum(), 'midflight checkpoint replays');
                }
                check(
                    impact?.projectileId === fire.projectileId &&
                        impact.radius === 100 &&
                        blastHits.find((e) => e.targetId === enemyBase.id)?.amount === 20 &&
                        near.every(
                            (u, i) =>
                                blastHits.find((e) => e.targetId === u.id)?.amount === [10, 15][i],
                        ) &&
                        !blastHits.some(
                            (e) => e.targetId === ally.id || e.targetId === outside.id,
                        ) &&
                        !sim.launchDeployments.length,
                    'the mortar damages multiple nearby enemies and leaves allies and distant units alone',
                    { impact, blastHits },
                );
                rows.push({
                    scenario:
                        'base or completed outpost fires a radius-100 mortar every fifth attack',
                    towerType: type,
                    hits,
                    impact,
                    blastHits,
                });
            }
            {
                const sim = arena(),
                    [site] = start(sim, { workers: 0 });
                sim.spawnUnit(1, 'pea', site.x + 150, site.y);
                const forbidden = [];
                step(sim, 5 * sim.tps, (s) =>
                    forbidden.push(
                        ...s.events.filter((e) => e.sourceId === site.id || e.cannonId === site.id),
                    ),
                );
                check(forbidden.length === 0, 'unfinished structure cannot fire');
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
                    tower.construction.workDone === 5 && tower.construction.invested === 2,
                    'restored checkpoint reaches five work and a two-supply payment',
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
                income: document.querySelector('[data-resource=basic] .launch-resource-state')
                    .textContent,
                wallet: document.querySelector('#launchResources').textContent,
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
            ui.wallet.includes('◆') &&
                ui.wallet.includes('✦') &&
                ui.income.includes('+15/초') &&
                ui.button.includes('375'),
            'native HUD displays both currencies and the active home base income',
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
                    cost: 100,
                    workRequired: 250,
                    paymentWork: 5,
                    workDone: 1,
                    invested: 0,
                    fill: [1, 0, 0, 0, 0],
                    remaining: 4,
                    amount: 2,
                },
                {
                    name: 'three ordinary hits',
                    cost: 100,
                    workRequired: 250,
                    paymentWork: 5,
                    workDone: 3,
                    invested: 0,
                    fill: [1, 1, 1, 0, 0],
                    remaining: 2,
                    amount: 2,
                },
                {
                    name: 'one specialist hit adding3',
                    cost: 100,
                    workRequired: 250,
                    paymentWork: 5,
                    workDone: 3,
                    invested: 0,
                    fill: [1, 1, 1, 0, 0],
                    remaining: 2,
                    amount: 2,
                },
                {
                    name: 'next interval after spending',
                    cost: 100,
                    workRequired: 250,
                    paymentWork: 5,
                    workDone: 5,
                    invested: 2,
                    fill: [0, 0, 0, 0, 0],
                    remaining: 5,
                    amount: 2,
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
                    cost: 100,
                    workRequired: 250,
                    paymentWork: 5,
                    workDone: 5,
                    invested: 2,
                    fill: [1, 1, 1, 1, 1],
                    remaining: 5,
                    amount: 2,
                    impact: { fx: { spend: 2 }, pulse: 1 },
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
                        {
                            cost: c.cost,
                            workRequired: c.workRequired,
                            paymentWork: c.paymentWork,
                            initialHpRatio: 0.1,
                        },
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
