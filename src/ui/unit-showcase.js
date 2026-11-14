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
const OPENING_LAUNCH_DELAY_SECONDS = 1.1;
const OPENING_SHOT_DISTANCE = 1400;
const OPENING_RANGE_LEVEL = 2;
const OPENING_ZOOM = 5.4;
const OPENING_LANDING_ZOOM = 3.6;
const OPENING_LANDING_APPROACH = 400;
const OPENING_LANDING_HOLD_MS = 1800;
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

function createArena(unitType, opening, interception) {
    const sim = new StrategySim(SEED, undefined, [[unitType], [interception?.launchType ?? 'pea']]);
    const { x, y } = sim.world.center;
    const state = sim.exportState();
    const siege = UnitDefinition.onlyAttacksBuildings(unitType),
        grows = UnitDefinition.get(unitType)?.growsCannon,
        rider = !opening && UnitDefinition.get(unitType)?.cannonRider ? CANNON_RIDER : null,
        roller = !opening && UnitDefinition.get(unitType)?.rolling ? ROLLER : null;
    // A muzzle-wrapping unit can only hold a completed outpost, so the main base moves out of its sight.
    const wrapsOutpost = !!UnitDefinition.get(unitType)?.stickyCling;
    const host = { x: x - VOLLEY_DISTANCE, y };
    const guest = {
        x: opening
            ? host.x + OPENING_SHOT_DISTANCE
            : rider
              ? host.x + rider.guestDistance
              : roller
                ? x + roller.baseOffset
                : x + (siege ? 150 : 460),
        y,
    };
    const base = wrapsOutpost ? { x: guest.x + 700, y } : guest;
    const target = opening
        ? guest
        : rider
          ? { x: host.x + rider.launchDistance, y }
          : roller
            ? { x: x + roller.landOffset, y }
            : { x, y };
    state.launchRangeLevel[0] = opening ? OPENING_RANGE_LEVEL : 0;
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
        if (interception || siege || grows || rider || roller)
            building.cooldownUntil =
                grows || rider || roller
                    ? Number.MAX_SAFE_INTEGER
                    : sim.msTicks(interception?.durationMs ?? DURATION_SECONDS * 1000);
    }
    if (interception) state.launchRangeLevel[1] = interception.rangeLevel;
    sim.importState(state);
    if (wrapsOutpost) {
        const outpost = buildOutpost(sim, { id: 'showcase', ...guest }, 1);
        outpost.cooldownUntil = sim.msTicks(DURATION_SECONDS * 1000);
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
    } else if (!opening && !siege && !grows) {
        for (const [dx, dy] of DEFENDERS) sim.spawnUnit(1, 'pea', x + dx, y + dy);
    }
    return { sim, x, y, host, target, rider, roller };
}

// Card previews use an isolated showcase run with the same commands and rendering as a match.
export function prepareUnitShowcase(options) {
    return prepareVolleyShowcase(options);
}

export function prepareCampaignOpening(options) {
    return prepareVolleyShowcase({ ...options, unitType: 'rice' }, true);
}

function prepareVolleyShowcase(
    {
        renderer,
        createScenario,
        createPresentationView,
        unitType,
        advanceTick,
        onError,
        onLaunch,
        onComplete,
    },
    opening = false,
) {
    if (!LaunchRules.grain(unitType)) throw new Error('알 수 없는 병종 소개 장면입니다.');
    const unit = UnitDefinition.get(unitType);
    const interception = !opening && unit?.burstAttack && unit.canAttackAir ? INTERCEPTION : null;
    const { sim, x, y, host, target, rider, roller } = createArena(unitType, opening, interception);
    const side = interception ? 1 : 0;
    const cannon = sim.launchCannons(side)[0];
    const launchTarget = interception ? { x: x + interception.aimOffset, y } : target;
    const launchType = interception?.launchType ?? unitType;
    const distance = Math.hypot(launchTarget.x - cannon.x, launchTarget.y - cannon.y);
    const launchDelayMs =
        interception?.launchDelayMs ??
        (opening ? OPENING_LAUNCH_DELAY_SECONDS : LAUNCH_DELAY_SECONDS) * 1000;
    const launchTick = sim.msTicks(launchDelayMs);
    const endTick = opening
        ? launchTick +
          sim.msTicks(
              (distance / LaunchRules.shellSpeed(unitType)) * 1000 + OPENING_LANDING_HOLD_MS,
          )
        : sim.msTicks(
              interception?.durationMs ??
                  rider?.durationMs ??
                  roller?.durationMs ??
                  Math.max(
                      DURATION_SECONDS * 1000,
                      unit?.growsCannon
                          ? launchDelayMs +
                                (distance / LaunchRules.shellSpeed(unitType)) * 1000 +
                                unit.growsCannon.delayMs +
                                GROWN_CANNON_HOLD_MS
                          : 0,
                  ),
          );
    let launchShown = false;
    let centerShot = null;
    const openingCamera = () => {
        const shot =
            centerShot && renderer.renderState.entity('projectile', centerShot.projectileId);
        const position = shot && renderer.resolveRenderWorldPosition(shot, 'projectile');
        const shotX = position?.x ?? centerShot?.aimX;
        const approach =
            shotX == null
                ? 0
                : Math.max(0, 1 - Math.abs(target.x - shotX) / OPENING_LANDING_APPROACH);
        const focusX = shotX == null ? host.x + 55 : shotX + (target.x - shotX) * approach * 0.5;
        const focusY = position?.z ?? centerShot?.aimY ?? y;
        renderer.replayZoom = OPENING_ZOOM + (OPENING_LANDING_ZOOM - OPENING_ZOOM) * approach;
        centerCamera(renderer, focusX, focusY, (position?.y ?? 0) * (1 - approach * 0.5));
    };
    const frameCamera = (timeMs) => {
        const progress = roller
            ? Math.max(0, Math.min(1, (timeMs - roller.cameraMs[0]) / roller.cameraMs[1]))
            : Math.max(0, Math.min(1, (timeMs - 600) / 1000));
        // A rider's loop stays between its cannon and the enemy, so its camera holds still.
        // A roller's camera runs from its landing point to the base it bounces off.
        const [fromX, toX] = roller?.camera ?? [-120, 125];
        const focusX = interception
            ? x + interception.cameraOffset
            : rider
              ? host.x + rider.cameraOffset
              : x + fromX + (toX - fromX) * progress * progress * (3 - 2 * progress);
        centerCamera(renderer, focusX, y, interception?.cameraHeight ?? 0);
    };

    renderer.role = 'host';
    renderer.replayObserverAll = true;
    renderer.replayZoom = opening ? OPENING_ZOOM : (interception?.zoom ?? roller?.zoom ?? 4);
    const scene = prepareSimScene({
        renderer,
        createScenario,
        createPresentationView,
        sim,
        seed: SEED,
        endTick,
        loop: !opening,
        advanceTick,
        start() {
            if (opening) openingCamera();
            else frameCamera(0);
            queueLaunch(sim, {
                tick: launchTick,
                seq: 1,
                side,
                cannon,
                unitType: launchType,
                ...launchTarget,
            });
        },
        render: opening ? undefined : (frame) => frameCamera(frame.timeMs),
        onPresent: opening ? openingCamera : undefined,
        onEnd: opening ? () => onComplete?.() : undefined,
        onError,
    });
    if (opening) {
        const { start } = scene.view;
        scene.view.start = (record, at, age) => {
            const handle = start(record, at, age);
            const fire = record.payload;
            if (fire.type === 'launchFire' && fire.side === 0) {
                if (fire.shot === Math.floor(fire.shots / 2)) centerShot = fire;
                if (!launchShown) {
                    launchShown = true;
                    onLaunch?.(fire);
                }
            }
            return handle;
        };
    }
    return scene;
}
