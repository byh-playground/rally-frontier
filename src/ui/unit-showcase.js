import {
    attachPublishedVisibility,
    captureFramePresentationEvents,
    configureFramePresentationJournal,
    createFramePresentationJournal,
    emitFramePresentationEvents,
} from '../core/presentation-frame-event.js';
import { LaunchRules } from '../sim/launch-rules.js';
import { StrategySim } from '../sim/strategy-sim.js';
import { BattlefieldProjection } from '../sim/terrain.js';

const SEED = 12345;
const DURATION_SECONDS = 7;
const VOLLEY_DISTANCE = 330;
const LAUNCH_DELAY_SECONDS = 0.4;
const HERO_SKILL_DELAY_SECONDS = 2;
const DEFENDERS = [
    [180, -115],
    [205, -60],
    [220, 0],
    [205, 60],
    [180, 115],
];

function createArena(unitType) {
    const sim = new StrategySim(SEED, undefined, [[unitType], ['pea']]);
    const { x, y } = sim.world.center;
    const state = sim.exportState();
    const host = { x: x - VOLLEY_DISTANCE, y };
    const guest = { x: x + 460, y };
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
    for (const building of state.buildings)
        Object.assign(building, building.side === 0 ? host : guest);
    sim.importState(state);
    sim.creditResources(0, LaunchRules.premiumWalletCap, 'premium');
    for (const [dx, dy] of DEFENDERS) sim.spawnUnit(1, 'pea', x + dx, y + dy);
    return { sim, x, y };
}

// Card previews use an isolated showcase run with the same commands and rendering as a match.
export function prepareUnitShowcase({
    renderer,
    createScenario,
    createPresentationView,
    unitType,
}) {
    if (!LaunchRules.grain(unitType)) throw new Error('알 수 없는 병종 소개 장면입니다.');
    const { sim, x, y } = createArena(unitType);
    const initialState = sim.exportState();
    const launchTick = sim.msTicks(LAUNCH_DELAY_SECONDS * 1000);
    const skillTick = sim.msTicks(HERO_SKILL_DELAY_SECONDS * 1000);
    let scenario;
    let journal;
    let active = false;
    let disposed = false;
    const owner = {
        finishPresentationEvent(record) {
            return journal?.finish(record);
        },
    };
    const view = createPresentationView(owner, () => renderer, { hud: false, audio: false });
    const presentFrame = (frame) => {
        if (frame?.timeMs != null) journal?.present(frame);
    };
    const frameCamera = (timeMs) => {
        const progress = Math.max(0, Math.min(1, (timeMs - 600) / 1000));
        const focusX = x - 120 + 245 * progress * progress * (3 - 2 * progress);
        renderer.cameraLeft = focusX - renderer.viewWorldW() / 2;
        renderer.cameraTop = renderer.clampCameraTop(
            BattlefieldProjection.planarY(y, 0) - renderer.viewWorldH() / 2,
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
        renderer.drawStrategicLabels = () => {};
        renderer.replayZoom = 4;
        renderer.onPresentationFrame = presentFrame;
        scenario = createScenario({
            definition: {
                seed: SEED,
                tickRate: sim.tps,
                endTick: DURATION_SECONDS * sim.tps,
                loop: true,
            },
            createRun() {
                sim.importState(initialState);
                renderer.setSnapshot(sim.snapshot(), { snapTargets: true });
                frameCamera(0);
                journal = createFramePresentationJournal({
                    getView: () => view,
                    onImmediate: () => {},
                });
                configureFramePresentationJournal(journal, view, sim.tps, active);
                sim.queueCommand({
                    tick: launchTick,
                    seq: 1,
                    actor: 'host',
                    action: {
                        type: 'LAUNCH',
                        cannonId: sim.launchCannons(0)[0].id,
                        unitType,
                        holdMs: Math.round(LaunchRules.holdFor(VOLLEY_DISTANCE, unitType, 0)),
                        x,
                        y,
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
                            console.error(error);
                            parent.postMessage({ type: 'unit-showcase-failed' }, location.origin);
                        }
                    },
                    render(frame) {
                        frameCamera(frame.timeMs);
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
