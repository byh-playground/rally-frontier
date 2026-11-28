import { UnitDefinition } from '../definitions/units.js';
import { LaunchRules } from '../sim/launch-rules.js';
import { StrategySim } from '../sim/strategy-sim.js';
import { buildOutpost, centerCamera, prepareSimScene, queueLaunch } from './sim-scene.js';

const SEED = 12345;
const DURATION_SECONDS = 7;
const VOLLEY_DISTANCE = 330;
const LAUNCH_DELAY_SECONDS = 0.4;
// A potato preview runs on until its forward cannon has stood this long.
const GROWN_CANNON_HOLD_MS = 2000;
const INTERCEPTION = Object.freeze({
    durationMs: 4500,
    launchDelayMs: 800,
    launchType: 'corn',
    rangeLevel: 1,
    zoom: 4.2,
    aimOffset: -150,
    cameraOffset: 82,
    cameraHeight: 175,
    formation: [
        [-62, -24],
        [-22, 0],
        [-62, 24],
    ],
});
const DEFENDERS = [
    [180, -115],
    [205, -60],
    [220, 0],
    [205, 60],
    [180, 115],
];
// A cannon rider's loop: land, fight, run to the friendly cannon ahead, ride it, fly at the enemy, land.
// Distances are from the host cannon; the outpost ahead keeps the enemy inside its launch range.
const CANNON_RIDER = Object.freeze({
    durationMs: 12000,
    launchDistance: 250,
    // Ahead of the landing squad, so the whole squad runs to it after the delay.
    outpostDistance: 520,
    defenders: [
        [300, -50],
        [315, 0],
        [300, 50],
    ],
    guestDistance: 1400,
    cameraOffset: 200,
});
// A rolling unit lands well short of ten soldiers racked like bowling pins, reaches near top speed,
// scatters them and bounces off the enemy main base behind them. The pins hold still so the rack
// stays in the rolling unit's path. Offsets are from the arena centre.
const ROLLER = Object.freeze({
    durationMs: 11000,
    landOffset: -250,
    baseOffset: 640,
    pinType: 'rice',
    pins: [0, 1, 2, 3].flatMap((row) =>
        Array.from({ length: row + 1 }, (_, k) => [360 + row * 60, (k - row / 2) * 30]),
    ),
    camera: [-180, 480],
    cameraMs: [1200, 3600],
    zoom: 3,
});
// The long lob needs room for both the windup and the landing. One ally spots for the battery.
const GINKGO = Object.freeze({
    durationMs: 9000,
    camera: [-110, 145],
    frameWidth: 560,
    frameHeight: 230,
    height: 55,
    spotter: [155, 85],
    defenders: [
        [310, -45],
        [340, 0],
        [310, 45],
    ],
});
// A stationary front-line target keeps the hit and the accumulating status in the card frame.
const PLUM = Object.freeze({
    durationMs: 6200,
    camera: [-125, 67],
    cameraMs: [420, 900],
    frameWidth: 410,
    frameHeight: 218,
    height: 39,
    target: [178, 7],
});
// Soft targets in two ranks show the squad firing and moving on to the next living target.
const PINE_NUT = Object.freeze({
    durationMs: 6600,
    camera: [-125, 53],
    cameraMs: [380, 930],
    frameWidth: 460,
    frameHeight: 320,
    height: 39,
    defenders: [
        ['rice', 163, -33],
        ['rice', 155, 0],
        ['rice', 163, 34],
        ['rice', 190, -19],
        ['rice', 190, 19],
        ['pea', 213, 0],
    ],
});

function createArena(unitType, interception) {
    const sim = new StrategySim(SEED, undefined, [[unitType], [interception?.launchType ?? 'pea']]);
    const { x, y } = sim.world.center;
    const state = sim.exportState();
    const siege = UnitDefinition.onlyAttacksBuildings(unitType),
        grows = UnitDefinition.get(unitType)?.growsCannon,
        rider = UnitDefinition.get(unitType)?.cannonRider ? CANNON_RIDER : null,
        roller = UnitDefinition.get(unitType)?.rolling ? ROLLER : null,
        ginkgo = UnitDefinition.get(unitType)?.ginkgoCloud ? GINKGO : null,
        plum = UnitDefinition.get(unitType)?.plumAcid ? PLUM : null,
        pineNut = UnitDefinition.get(unitType)?.rapidHitscan ? PINE_NUT : null,
        framed = ginkgo ?? plum ?? pineNut;
    // A muzzle-wrapping unit can only hold a completed outpost, so the main base moves out of its sight.
    const wrapsOutpost = !!UnitDefinition.get(unitType)?.stickyCling;
    const host = { x: x - VOLLEY_DISTANCE, y };
    const guest = {
        x: rider
            ? host.x + rider.guestDistance
            : roller
              ? x + roller.baseOffset
              : x + (siege ? 150 : 460),
        y,
    };
    const base = wrapsOutpost ? { x: guest.x + 700, y } : guest;
    const target = rider
        ? { x: host.x + rider.launchDistance, y }
        : roller
          ? { x: x + roller.landOffset, y }
          : { x, y };
    state.launchRangeLevel[0] = 0;
    state.mapDescriptor = {
        ...state.mapDescriptor,
        spawns: { host, guest: base },
        capturePoints: [],
        laneControlPoints: { top: [], mid: [host, guest], bot: [] },
        terrain: {
            layers: [],
            ramps: [],
            blockers: [],
            riverPath: [],
            riverBranches: [],
            riverPolygon: [],
            riverBranchPolygons: [],
            riverHalfWidth: 0,
            bridges: [],
        },
    };
    state.capturePoints = [];
    state.flags = [
        { ...base, forced: false },
        { ...host, forced: false },
    ];
    for (const building of state.buildings) {
        Object.assign(building, building.side === 0 ? host : base);
        // The showcase's artillery is available to launch, while its automatic fire stays quiet.
        // A rooting potato is left alone for the whole preview.
        if (interception || siege || grows || rider || roller || framed)
            building.cooldownUntil =
                grows || rider || roller || framed
                    ? Number.MAX_SAFE_INTEGER
                    : sim.time.ceilTicks(
                          interception?.durationMs ?? Math.round(DURATION_SECONDS * 1000),
                      );
    }
    if (interception) state.launchRangeLevel[1] = interception.rangeLevel;
    sim.importState(state);
    if (wrapsOutpost) {
        const outpost = buildOutpost(sim, { id: 'showcase', ...guest }, 1);
        outpost.cooldownUntil = sim.time.ceilTicks(Math.round(DURATION_SECONDS * 1000));
    }
    sim.creditResources(0, LaunchRules.premiumWalletCap, 'premium');
    if (interception) {
        sim.creditResources(1, LaunchRules.premiumWalletCap, 'premium');
        for (const [dx, dy] of interception.formation) sim.spawnUnit(0, unitType, x + dx, y + dy);
    } else if (rider) {
        const outpost = buildOutpost(
            sim,
            { id: 'showcase', x: host.x + rider.outpostDistance, y },
            0,
        );
        outpost.cooldownUntil = Number.MAX_SAFE_INTEGER;
        for (const [dx, dy] of rider.defenders) sim.spawnUnit(1, 'pea', host.x + dx, y + dy);
    } else if (roller) {
        for (const [dx, dy] of roller.pins) {
            const pin = sim.spawnUnit(1, roller.pinType, x + dx, y + dy);
            pin.combat.moveRecoveryUntil = pin.combat.cooldownUntil = Number.MAX_SAFE_INTEGER;
        }
    } else if (ginkgo) {
        const [spotX, spotY] = ginkgo.spotter;
        const spotter = sim.spawnUnit(0, 'pea', x + spotX, y + spotY);
        spotter.combat.moveRecoveryUntil = spotter.combat.cooldownUntil = Number.MAX_SAFE_INTEGER;
        for (const [dx, dy] of ginkgo.defenders) {
            const target = sim.spawnUnit(1, 'pea', x + dx, y + dy);
            target.combat.moveRecoveryUntil = target.combat.cooldownUntil = Number.MAX_SAFE_INTEGER;
        }
    } else if (plum) {
        const [dx, dy] = plum.target;
        const walnut = sim.spawnUnit(1, 'walnut', x + dx, y + dy);
        walnut.combat.moveRecoveryUntil = walnut.combat.cooldownUntil = Number.MAX_SAFE_INTEGER;
    } else if (pineNut) {
        for (const [type, dx, dy] of pineNut.defenders) {
            const defender = sim.spawnUnit(1, type, x + dx, y + dy);
            defender.combat.moveRecoveryUntil = defender.combat.cooldownUntil =
                Number.MAX_SAFE_INTEGER;
        }
    } else if (!siege && !grows) {
        for (const [dx, dy] of DEFENDERS) sim.spawnUnit(1, 'pea', x + dx, y + dy);
    }
    return { sim, x, y, host, target, rider, roller, framed };
}

// Card previews use an isolated showcase run with the same commands and rendering as a match.
export function prepareUnitShowcase(options) {
    return prepareVolleyShowcase(options);
}

function prepareVolleyShowcase({
    renderer,
    createScenario,
    createPresentationView,
    unitType,
    advanceTick,
    onError,
}) {
    if (!LaunchRules.grain(unitType)) throw new Error('알 수 없는 병종 소개 장면입니다.');
    const unit = UnitDefinition.get(unitType);
    const interception = unit?.burstAttack && unit.canAttackAir ? INTERCEPTION : null;
    const { sim, x, y, host, target, rider, roller, framed } = createArena(unitType, interception);
    const side = interception ? 1 : 0;
    const cannon = sim.launchCannons(side)[0];
    const launchTarget = interception ? { x: x + interception.aimOffset, y } : target;
    const launchType = interception?.launchType ?? unitType;
    const distance = Math.hypot(launchTarget.x - cannon.x, launchTarget.y - cannon.y);
    const launchDelayMs = interception?.launchDelayMs ?? LAUNCH_DELAY_SECONDS * 1000;
    const launchTick = sim.time.ceilTicks(Math.round(launchDelayMs));
    const endTick = sim.time.ceilTicks(
        Math.ceil(
            interception?.durationMs ??
                rider?.durationMs ??
                roller?.durationMs ??
                framed?.durationMs ??
                Math.max(
                    DURATION_SECONDS * 1000,
                    unit?.growsCannon
                        ? launchDelayMs +
                              (distance / LaunchRules.shellSpeed(unitType)) * 1000 +
                              unit.growsCannon.delayMs +
                              GROWN_CANNON_HOLD_MS
                        : 0,
                ),
        ),
    );
    const frameCamera = (timeMs) => {
        if (framed && renderer.baseSc() > 0) {
            const widthScale = renderer.canvas.width / framed.frameWidth;
            const heightScale = renderer.canvas.height / framed.frameHeight;
            renderer.replayZoom = Math.min(widthScale, heightScale) / renderer.baseSc();
        }
        const [cameraStart, cameraDuration] = framed?.cameraMs ?? roller?.cameraMs ?? [600, 1000];
        const progress = Math.max(0, Math.min(1, (timeMs - cameraStart) / cameraDuration));
        // A rider's loop stays between its cannon and the enemy, so its camera holds still.
        // A roller's camera runs from its landing point to the base it bounces off.
        const [fromX, toX] = framed?.camera ?? roller?.camera ?? [-120, 125];
        const focusX = interception
            ? x + interception.cameraOffset
            : rider
              ? host.x + rider.cameraOffset
              : x + fromX + (toX - fromX) * progress * progress * (3 - 2 * progress);
        centerCamera(renderer, focusX, y, framed?.height ?? interception?.cameraHeight ?? 0);
    };

    renderer.role = 'host';
    renderer.replayObserverAll = true;
    renderer.replayZoom = interception?.zoom ?? roller?.zoom ?? 4;
    const scene = prepareSimScene({
        renderer,
        createScenario,
        createPresentationView,
        sim,
        seed: SEED,
        endTick,
        loop: true,
        advanceTick,
        start() {
            frameCamera(0);
            queueLaunch(sim, {
                tick: launchTick,
                seq: 1,
                side,
                cannon,
                unitType: launchType,
                ...launchTarget,
            });
        },
        render: (frame) => frameCamera(frame.timeMs),
        onError,
    });
    return scene;
}
