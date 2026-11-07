import { PRODUCT_VERSION } from '../core/product-version.js';
import { createTitleRun } from './title-showcase-sim.js';

// The title document owns a separate simulation; it never joins a player session.
export async function prepareTitleShowcase({ renderer, createScenario }) {
    const response = await fetch(new URL('../../assets/title-showcase.json', import.meta.url));
    if (!response.ok) throw new Error('타이틀 전투 데이터를 불러오지 못했습니다.');
    const saved = await response.json();
    if (
        saved.productVersion !== PRODUCT_VERSION ||
        saved.seed !== 12349 ||
        saved.checkpoints?.length !== 3
    )
        throw new Error('타이틀 전투 데이터 버전이 현재 게임과 다릅니다.');
    const checkpoints = saved.checkpoints;
    const map = JSON.stringify(checkpoints[0].state.mapDescriptor);
    if (checkpoints.some((checkpoint) => JSON.stringify(checkpoint.state.mapDescriptor) !== map))
        throw new Error('타이틀 전투 장면의 맵이 일치하지 않습니다.');

    const run = createTitleRun(saved.seed);
    let scenario;
    let disposed = false;
    let shownScene = -1;
    const cameras = [
        [1470, 3120],
        [2630, 2893],
        [2684, 3031],
    ];
    const camera = (index) => {
        const [x, y] = cameras[index];
        renderer.replayZoom = index === 0 ? 2.2 : 1.25;
        renderer.cameraLeft = Math.max(0, x - renderer.viewWorldW() / 2);
        renderer.cameraTop = renderer.clampCameraTop(y - renderer.viewWorldH() / 2);
    };
    const load = (index) => {
        run.restore(checkpoints[index]);
        camera(index);
        renderer.setSnapshot(run.sim.snapshot(), { snapTargets: true });
        shownScene = index;
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        scenario?.dispose();
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
        // Strategic status belongs to the interactive match HUD, not this background scene.
        renderer.drawStrategicLabels = () => {};
        load(0);
        scenario = createScenario({
            definition: { seed: saved.seed, tickRate: run.sim.tps, endTick: 102, loop: true },
            createRun() {
                return {
                    step(frame) {
                        try {
                            const scene = frame.tick <= 42 ? 0 : frame.tick <= 72 ? 1 : 2;
                            if (scene !== shownScene || frame.tick === 1) load(scene);
                            run.advance();
                            renderer.setSnapshot(run.sim.snapshot(), {
                                liveTargets: false,
                                snapTargets: false,
                            });
                        } catch (error) {
                            dispose();
                            renderer.stopLoop();
                            console.error(error);
                            parent.postMessage({ type: 'title-showcase-failed' }, location.origin);
                        }
                    },
                    render(frame) {
                        if (frame.tick < 10 || frame.tick > 18 || shownScene !== 0) return;
                        const t = Math.min(1, Math.max(0, (frame.tick + frame.alpha - 10) / 8));
                        const eased = t * t * (3 - 2 * t);
                        renderer.replayZoom = 2.2 + (1.25 - 2.2) * eased;
                        const x = 1470 + (1940 - 1470) * eased;
                        const y = 3120 + (2940 - 3120) * eased;
                        renderer.cameraLeft = Math.max(0, x - renderer.viewWorldW() / 2);
                        renderer.cameraTop = renderer.clampCameraTop(y - renderer.viewWorldH() / 2);
                    },
                    dispose() {},
                };
            },
        });
        scenario.play();
        scenario.pause();
        return {
            play() {
                if (!disposed) scenario.play();
            },
            pause() {
                if (!disposed) scenario.pause();
            },
            dispose,
        };
    } catch (error) {
        dispose();
        throw error;
    }
}
