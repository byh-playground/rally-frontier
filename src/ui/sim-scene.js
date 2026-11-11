import {
    attachPublishedVisibility,
    captureFramePresentationEvents,
    configureFramePresentationJournal,
    createFramePresentationJournal,
    emitFramePresentationEvents,
} from '../core/presentation-frame-event.js';
import { RollingBody } from '../sim/capabilities/rolling-body.js';
import { LaunchRules } from '../sim/launch-rules.js';
import { BattlefieldProjection } from '../sim/terrain.js';

// Staging helpers shared by the card previews, the title scenes (title-scenes.js) and the debug scenes
// (src/debug-scenes.js): they place what a scene starts with through the sim's own spawn and command paths.

// The axis between the two main bases: the way each side's units walk by default.
export function baseAxis(sim) {
    const host = sim.buildings.find((b) => b.id === 'base0'),
        guest = sim.buildings.find((b) => b.id === 'base1');
    const length = Math.hypot(guest.x - host.x, guest.y - host.y);
    return {
        host,
        guest,
        center: { x: (host.x + guest.x) / 2, y: (host.y + guest.y) / 2 },
        dir: { x: (guest.x - host.x) / length, y: (guest.y - host.y) / length },
    };
}

// The distance between neighbours in a block of these types: the widest body plus a small gap.
export function blockSpacing(sim, types) {
    return 2 * Math.max(...types.map((type) => sim.unitRadius(type))) + 4;
}

// Fills a square block of `count` units around `center`, rows across `dir` (the side's facing), types taken in
// turn. A rolling unit starts rolling along `dir`, as one landing from a shell fired that way. Returns the block's
// depth along `dir`.
export function placeBlock(sim, side, types, count, center, dir) {
    const spacing = blockSpacing(sim, types);
    const columns = Math.ceil(Math.sqrt(count)),
        rows = Math.ceil(count / columns);
    for (let i = 0; i < count; i++) {
        const along = (Math.floor(i / columns) - (rows - 1) / 2) * spacing,
            across = ((i % columns) - (columns - 1) / 2) * spacing;
        const unit = sim.spawnUnit(
            side,
            types[i % types.length],
            center.x + dir.x * along - dir.y * across,
            center.y + dir.y * along + dir.x * across,
        );
        RollingBody.aim(unit, dir.x, dir.y);
    }
    return rows * spacing;
}

// A finished, full-health outpost of `side` on `point` (a capture point, or any { id, x, y }).
export function buildOutpost(sim, point, side) {
    const outpost = sim.spawnOutpost(point, side);
    sim.completeConstruction(outpost);
    outpost.hp = outpost.maxHp;
    return outpost;
}

// Queues the launch a player makes by holding `cannon` just long enough to land `unitType` on (x, y) at the
// side's current range level.
export function queueLaunch(sim, { tick, seq, side, cannon, unitType, x, y }) {
    const distance = Math.hypot(x - cannon.x, y - cannon.y);
    sim.queueCommand({
        tick,
        seq,
        actor: side ? 'guest' : 'host',
        action: {
            type: 'LAUNCH',
            cannonId: cannon.id,
            unitType,
            holdMs: Math.round(LaunchRules.holdFor(distance, unitType, sim.launchRangeLevel[side])),
            x,
            y,
        },
    });
}

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
// events. Card previews (unit-showcase.js), the title scenes (title-scenes.js) and the debug scenes
// (src/debug-scenes.js) open their scenes here.
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
                // The sim's own earlier state: same map, rules and decks, so the navigation built for them is kept.
                sim.importState(initialState, { rollback: true });
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
