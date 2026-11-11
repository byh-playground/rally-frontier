import {
    attachPublishedVisibility,
    captureFramePresentationEvents,
    configureFramePresentationJournal,
    createFramePresentationJournal,
    emitFramePresentationEvents,
} from '../core/presentation-frame-event.js';
import { BattlefieldProjection } from '../sim/terrain.js';

// Centres the camera on a world point standing at the given terrain height. The zoom stays the caller's.
export function centerCamera(renderer, x, y, height = 0) {
    renderer.cameraLeft = x - renderer.viewWorldW() / 2;
    renderer.cameraTop = renderer.clampCameraTop(
        BattlefieldProjection.planarY(y, height) - renderer.viewWorldH() / 2,
    );
}

// Where the fighting is: the mean position of live units engaging a nearby enemy, else the map centre.
export function battleFocus(sim) {
    const units = new Map(sim.units.filter((unit) => unit.alive).map((unit) => [unit.id, unit]));
    let x = 0,
        y = 0,
        count = 0;
    for (const unit of units.values()) {
        const target = units.get(unit.target);
        if (
            !target ||
            target.side === unit.side ||
            Math.hypot(unit.x - target.x, unit.y - target.y) > 250
        )
            continue;
        x += unit.x;
        y += unit.y;
        count++;
    }
    return count ? { x: x / count, y: y / count } : sim.world.center;
}

// One StrategySim on the GameKit scenario timeline, drawn by the match renderer with the match's presentation
// events. Card previews (unit-showcase.js) and the debug scenes (src/debug-scenes.js) open their scenes here.
// Every run (a loop's repeat included) restarts from the sim's state at this call. `start` sets the camera and
// queues the run's commands, `beforeStep` adds commands for the tick about to run, `render` follows the camera.
// The returned handle starts paused: play() for the real-time loop, play({ automatic: false }) then step() for
// exact ticks.
export function prepareSimScene({
    renderer,
    createScenario,
    createPresentationView,
    sim,
    seed,
    endTick,
    loop,
    advanceTick = () => sim.step(),
    start,
    beforeStep,
    render,
    onPresent,
    isComplete,
    onEnd,
    onError,
}) {
    const initialState = sim.exportState();
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
        if (disposed || frame?.timeMs == null) return;
        journal?.present(frame);
        if (!disposed) onPresent?.(frame);
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        if (renderer.onPresentationFrame === presentFrame) renderer.onPresentationFrame = null;
        scenario?.dispose();
        journal?.dispose();
        sim.dispose('sim-scene');
    };

    try {
        renderer.onPresentationFrame = presentFrame;
        scenario = createScenario({
            definition: { seed, tickRate: sim.tps, endTick, loop },
            onEnd(snapshot) {
                if (!disposed) onEnd?.(snapshot);
            },
            createRun() {
                sim.importState(initialState);
                renderer.setSnapshot(sim.snapshot(), { snapTargets: true });
                start?.();
                journal = createFramePresentationJournal({
                    getView: () => view,
                    onImmediate: () => {},
                });
                configureFramePresentationJournal(journal, view, sim.tps, active);
                return {
                    step(frame) {
                        try {
                            beforeStep?.(frame);
                            advanceTick();
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
                    render,
                    isComplete,
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
            sim,
            view,
            play({ automatic = true } = {}) {
                if (disposed) return;
                active = true;
                journal.setPresentationActive(true);
                scenario.play({ automatic });
            },
            pause() {
                if (disposed) return;
                active = false;
                scenario.pause();
                journal.setPresentationActive(false);
            },
            step: () => scenario.step(),
            render: () => scenario.render(),
            dispose,
        };
    } catch (error) {
        dispose();
        throw error;
    }
}
