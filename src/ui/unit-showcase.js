import {
    attachPublishedVisibility,
    captureFramePresentationEvents,
    configureFramePresentationJournal,
    createFramePresentationJournal,
    emitFramePresentationEvents,
} from '../core/presentation-frame-event.js';
import { UnitDefinition } from '../definitions/units.js';
import { LaunchRules } from '../sim/launch-rules.js';
import { StrategySim } from '../sim/strategy-sim.js';
import { BattlefieldProjection } from '../sim/terrain.js';

const SEED = 12345;
const DURATION_SECONDS = 7;
const VOLLEY_DISTANCE = 330;
const LAUNCH_DELAY_SECONDS = 0.4;
const HERO_SKILL_DELAY_SECONDS = 2;
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

function createArena(unitType, opening, interception) {
    const sim = new StrategySim(SEED, undefined, [[unitType], [interception?.launchType ?? 'pea']]);
    const { x, y } = sim.world.center;
    const state = sim.exportState();
    const host = { x: x - VOLLEY_DISTANCE, y };
    const guest = { x: opening ? host.x + OPENING_SHOT_DISTANCE : x + 460, y };
    const target = opening ? guest : { x, y };
    const rangeLevel = opening ? OPENING_RANGE_LEVEL : 0;
    state.launchRangeLevel[0] = rangeLevel;
    state.mapDescriptor = {
        ...state.mapDescriptor,
        spawns: { host, guest },
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
        { ...guest, forced: false },
        { ...host, forced: false },
    ];
    for (const building of state.buildings) {
        Object.assign(building, building.side === 0 ? host : guest);
        // The showcase's artillery is available to launch, while its automatic fire stays quiet.
        if (interception) building.cooldownUntil = sim.msTicks(interception.durationMs);
    }
    if (interception) state.launchRangeLevel[1] = interception.rangeLevel;
    sim.importState(state);
    sim.creditResources(0, LaunchRules.premiumWalletCap, 'premium');
    if (interception) {
        sim.creditResources(1, LaunchRules.premiumWalletCap, 'premium');
        for (const [dx, dy] of interception.formation) sim.spawnUnit(0, unitType, x + dx, y + dy);
    } else if (!opening) {
        for (const [dx, dy] of DEFENDERS) sim.spawnUnit(1, 'pea', x + dx, y + dy);
    }
    return { sim, x, y, host, target, rangeLevel };
}

// Card previews use an isolated showcase run with the same commands and rendering as a match.
export function prepareUnitShowcase(options) {
    return prepareVolleyShowcase(options);
}

export function prepareCampaignOpening(options) {
    return prepareVolleyShowcase({ ...options, unitType: 'rice' }, true);
}

function prepareVolleyShowcase(
    { renderer, createScenario, createPresentationView, unitType, onError, onLaunch, onComplete },
    opening = false,
) {
    if (!LaunchRules.grain(unitType)) throw new Error('알 수 없는 병종 소개 장면입니다.');
    const unit = UnitDefinition.get(unitType);
    const interception = !opening && unit?.burstAttack && unit.canAttackAir ? INTERCEPTION : null;
    const { sim, x, y, host, target, rangeLevel } = createArena(unitType, opening, interception);
    const side = interception ? 1 : 0;
    const cannon = sim.launchCannons(side)[0];
    const launchTarget = interception ? { x: x + interception.aimOffset, y } : target;
    const launchType = interception?.launchType ?? unitType;
    const distance = Math.hypot(launchTarget.x - cannon.x, launchTarget.y - cannon.y);
    const initialState = sim.exportState();
    const launchDelayMs =
        interception?.launchDelayMs ??
        (opening ? OPENING_LAUNCH_DELAY_SECONDS : LAUNCH_DELAY_SECONDS) * 1000;
    const launchTick = sim.msTicks(launchDelayMs);
    const endTick = opening
        ? launchTick +
          sim.msTicks(
              (distance / LaunchRules.shellSpeed(unitType)) * 1000 + OPENING_LANDING_HOLD_MS,
          )
        : sim.msTicks(interception?.durationMs ?? DURATION_SECONDS * 1000);
    const skillTick = sim.msTicks(HERO_SKILL_DELAY_SECONDS * 1000);
    let scenario;
    let journal;
    let active = false;
    let disposed = false;
    let launchShown = false;
    let centerShot = null;
    const owner = {
        finishPresentationEvent(record) {
            return journal?.finish(record);
        },
    };
    const view = createPresentationView(owner, () => renderer, { hud: false, audio: false });
    if (opening) {
        const { start } = view;
        view.start = (record, at, age) => {
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
        renderer.cameraLeft = focusX - renderer.viewWorldW() / 2;
        renderer.cameraTop = renderer.clampCameraTop(
            BattlefieldProjection.planarY(focusY, (position?.y ?? 0) * (1 - approach * 0.5)) -
                renderer.viewWorldH() / 2,
        );
    };
    const presentFrame = (frame) => {
        if (disposed || frame?.timeMs == null) return;
        journal?.present(frame);
        if (opening && !disposed) openingCamera();
    };
    const frameCamera = (timeMs) => {
        const progress = Math.max(0, Math.min(1, (timeMs - 600) / 1000));
        const focusX = interception
            ? x + interception.cameraOffset
            : x - 120 + 245 * progress * progress * (3 - 2 * progress);
        renderer.cameraLeft = focusX - renderer.viewWorldW() / 2;
        renderer.cameraTop = renderer.clampCameraTop(
            BattlefieldProjection.planarY(y, interception?.cameraHeight ?? 0) -
                renderer.viewWorldH() / 2,
        );
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        if (renderer.onPresentationFrame === presentFrame) renderer.onPresentationFrame = null;
        scenario?.dispose();
        journal?.dispose();
        sim.dispose('unit-showcase');
    };

    try {
        renderer.role = 'host';
        renderer.replayObserverAll = true;
        renderer.replayZoom = opening ? OPENING_ZOOM : (interception?.zoom ?? 4);
        renderer.onPresentationFrame = presentFrame;
        scenario = createScenario({
            definition: {
                seed: SEED,
                tickRate: sim.tps,
                endTick,
                loop: !opening,
            },
            onEnd() {
                if (opening && !disposed) onComplete?.();
            },
            createRun() {
                sim.importState(initialState);
                renderer.setSnapshot(sim.snapshot(), { snapTargets: true });
                if (opening) openingCamera();
                else frameCamera(0);
                journal = createFramePresentationJournal({
                    getView: () => view,
                    onImmediate: () => {},
                });
                configureFramePresentationJournal(journal, view, sim.tps, active);
                sim.queueCommand({
                    tick: launchTick,
                    seq: 1,
                    actor: interception ? 'guest' : 'host',
                    action: {
                        type: 'LAUNCH',
                        cannonId: cannon.id,
                        unitType: launchType,
                        holdMs: Math.round(
                            LaunchRules.holdFor(
                                distance,
                                launchType,
                                interception?.rangeLevel ?? rangeLevel,
                            ),
                        ),
                        ...launchTarget,
                    },
                });
                let skillRequested = false;
                return {
                    step(frame) {
                        try {
                            const hero = sim.heroes[0][unitType];
                            if (!skillRequested && frame.tick >= skillTick && hero?.unitId) {
                                skillRequested = true;
                                sim.queueCommand({
                                    tick: sim.tick + 1,
                                    seq: 2,
                                    actor: 'host',
                                    action: {
                                        type: 'ACTIVATE_HERO_SKILL',
                                        sortieId: hero.sortieId,
                                    },
                                });
                            }
                            sim.stepSimulation();
                            const snapshot = sim.snapshot();
                            const events = captureFramePresentationEvents(snapshot.events, sim);
                            renderer.setSnapshot(snapshot, { liveTargets: false });
                            journal.update(performance.now());
                            emitFramePresentationEvents(
                                journal,
                                view,
                                sim.tick,
                                attachPublishedVisibility(events, view),
                            );
                        } catch (error) {
                            dispose();
                            renderer.stopLoop();
                            onError?.(error);
                        }
                    },
                    render(frame) {
                        if (!opening) frameCamera(frame.timeMs);
                    },
                    dispose() {
                        journal.dispose();
                        journal = null;
                    },
                };
            },
        });
        scenario.play();
        scenario.pause();
        return {
            play() {
                if (disposed) return;
                active = true;
                journal.setPresentationActive(true);
                scenario.play();
            },
            pause() {
                if (disposed) return;
                active = false;
                scenario.pause();
                journal.setPresentationActive(false);
            },
            dispose,
        };
    } catch (error) {
        dispose();
        throw error;
    }
}
