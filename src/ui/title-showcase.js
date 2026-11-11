import { PRODUCT_VERSION } from '../core/product-version.js';
import {
    attachPublishedVisibility,
    captureFramePresentationEvents,
    createFramePresentationJournal,
    configureFramePresentationJournal,
    emitFramePresentationEvents,
} from '../core/presentation-frame-event.js';
import { BattlefieldProjection } from '../sim/terrain.js';
import { battleFocus } from './sim-scene.js';
import { createTitleRun } from './title-showcase-sim.js';

let titleCheckpoints;

async function loadTitleCheckpoints(signal) {
    if (titleCheckpoints) return titleCheckpoints;
    const response = await fetch(new URL('../../assets/title-showcase.json', import.meta.url), {
        signal,
    });
    if (!response.ok) throw new Error('타이틀 전투 데이터를 불러오지 못했습니다.');
    const saved = await response.json();
    if (
        saved.productVersion !== PRODUCT_VERSION ||
        saved.seed !== 12349 ||
        saved.checkpoints?.length !== 3
    )
        throw new Error('타이틀 전투 데이터 버전이 현재 게임과 다릅니다.');
    const map = JSON.stringify(saved.checkpoints[0].state.mapDescriptor);
    if (
        saved.checkpoints.some(
            (checkpoint) => JSON.stringify(checkpoint.state.mapDescriptor) !== map,
        )
    )
        throw new Error('타이틀 전투 장면의 맵이 일치하지 않습니다.');
    titleCheckpoints = saved;
    return saved;
}

export async function prepareTitleShowcase({
    renderer,
    createScenario,
    createPresentationView,
    signal,
    onError,
}) {
    const saved = await loadTitleCheckpoints(signal);
    signal?.throwIfAborted();
    const { checkpoints } = saved;
    const run = createTitleRun(saved.seed);
    let scenario;
    let journal;
    let presentationActive = false;
    let disposed = false;
    let shownScene = -1;
    const owner = {
        finishPresentationEvent(record) {
            return journal?.finish(record);
        },
    };
    const view = createPresentationView(owner, () => renderer, { hud: false, audio: false });
    const presentFrame = (frame) => {
        if (!disposed && frame?.timeMs != null) journal?.present(frame);
    };
    let openingShot = null;
    const camera = (x, y, zoom, elevation = run.sim.world.terrain.surfaces.heightAt(x, y)) => {
        renderer.replayZoom = zoom;
        renderer.cameraLeft = Math.max(0, x - renderer.viewWorldW() / 2);
        renderer.cameraTop = renderer.clampCameraTop(
            BattlefieldProjection.planarY(y, elevation) - renderer.viewWorldH() / 2,
        );
    };
    const load = (index) => {
        journal?.dispose();
        journal = createFramePresentationJournal({ getView: () => view, onImmediate: () => {} });
        configureFramePresentationJournal(journal, view, run.sim.tps, presentationActive);
        run.restore(checkpoints[index]);
        renderer.setSnapshot(run.sim.snapshot(), { snapTargets: true });
        openingShot = null;
        if (index === 0) {
            const previousShot = run.sim.projectiles.find(
                (shot) => shot.side === 0 && shot.payload,
            );
            const cannon =
                run.sim.buildingById.get(previousShot?.owner) ||
                run.sim.launchCannons(0)[0] ||
                run.sim.world.center;
            camera(cannon.x, cannon.y, 2.2);
        } else {
            const focus = battleFocus(run.sim);
            camera(focus.x, focus.y, index === 1 ? 1.35 : 1.65);
        }
        shownScene = index;
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        if (renderer.onPresentationFrame === presentFrame) renderer.onPresentationFrame = null;
        scenario?.dispose();
        journal?.dispose();
        run.sim.dispose('title-showcase');
    };
    try {
        for (const checkpoint of checkpoints) {
            run.restore(checkpoint);
            if (run.sim.checksum() !== checkpoint.checksum)
                throw new Error('타이틀 전투 상태 검증에 실패했습니다.');
        }
        renderer.role = 'host';
        renderer.replayObserverAll = true;
        load(0);
        renderer.onPresentationFrame = presentFrame;
        scenario = createScenario({
            definition: { seed: saved.seed, tickRate: run.sim.tps, endTick: 102, loop: true },
            createRun() {
                return {
                    step(frame) {
                        try {
                            const scene = frame.tick <= 42 ? 0 : frame.tick <= 72 ? 1 : 2;
                            if (scene !== shownScene || frame.tick === 1) load(scene);
                            run.advance();
                            const snapshot = run.sim.snapshot();
                            if (scene === 0 && !openingShot) {
                                const fire = snapshot.events?.find(
                                    (event) => event.type === 'launchFire' && event.side === 0,
                                );
                                if (fire) {
                                    openingShot = { fire, tick: frame.tick };
                                    camera(fire.x, fire.y, 2.2);
                                }
                            }
                            if (scene === 0 && openingShot && !openingShot.impact) {
                                openingShot.impact = snapshot.events?.find(
                                    (event) =>
                                        event.type === 'launchImpact' &&
                                        event.projectileId === openingShot.fire.projectileId,
                                );
                            }
                            const events = captureFramePresentationEvents(
                                snapshot.events || [],
                                run.sim,
                            );
                            renderer.setSnapshot(snapshot, {
                                liveTargets: false,
                                snapTargets: false,
                            });
                            journal.update(performance.now());
                            emitFramePresentationEvents(
                                journal,
                                view,
                                run.sim.tick,
                                attachPublishedVisibility(events, view),
                            );
                        } catch (error) {
                            dispose();
                            renderer.stopLoop();
                            onError?.(error);
                        }
                    },
                    render(frame) {
                        if (!openingShot || shownScene !== 0) return;
                        const { fire, tick, impact } = openingShot;
                        const age = frame.tick + frame.alpha - tick;
                        if (age < 2) return;
                        const shell = renderer.snapshot.projectiles.find(
                            (projectile) => projectile.id === fire.projectileId,
                        );
                        const point =
                            shell && renderer.resolveRenderWorldPosition(shell, 'projectile');
                        const x = point?.x ?? impact?.x ?? fire.aimX;
                        const y = point?.z ?? impact?.y ?? fire.aimY;
                        const terrain = run.sim.world.terrain.surfaces;
                        const height = point?.y ?? terrain.heightAt(x, y);
                        const startHeight = terrain.heightAt(fire.x, fire.y);
                        const t = Math.min(1, (age - 2) / 4);
                        const eased = t * t * (3 - 2 * t);
                        camera(
                            fire.x + (x - fire.x) * eased,
                            fire.y + (y - fire.y) * eased,
                            2.2 + (1.35 - 2.2) * eased,
                            startHeight + (height - startHeight) * eased,
                        );
                    },
                    dispose() {},
                };
            },
        });
        scenario.play();
        scenario.pause();
        return {
            play() {
                if (disposed) return;
                presentationActive = true;
                journal.setPresentationActive(true);
                scenario.play();
            },
            pause() {
                if (disposed) return;
                scenario.pause();
                presentationActive = false;
                journal.setPresentationActive(false);
            },
            dispose,
        };
    } catch (error) {
        dispose();
        throw error;
    }
}
