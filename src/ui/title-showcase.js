// The scenario clock runs in the isolated title document; the actual simulation runs in a Worker.
export async function prepareTitleShowcase({ renderer, createScenario }) {
    const worker = new Worker(new URL('./title-showcase-worker.js', import.meta.url), {
        type: 'module',
    });
    let scenario = null;
    let disposed = false;
    let pending = 0;
    let nextId = 0;
    let expectedId = 1;
    let shownScene = -1;
    let firstSnapshot;
    let tickRate;
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
    const fail = (error) => {
        if (disposed) return;
        disposed = true;
        scenario?.dispose();
        renderer.stopLoop();
        worker.terminate();
        console.error(error);
        parent.postMessage({ type: 'title-showcase-failed' }, location.origin);
    };
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error('타이틀 전투 준비 시간이 초과되었습니다.')),
                12000,
            );
            worker.onerror = (event) => {
                clearTimeout(timer);
                reject(event.error ?? event);
            };
            worker.onmessage = ({ data }) => {
                if (data.type === 'fatal') {
                    clearTimeout(timer);
                    reject(data.error ?? data.detail);
                }
                if (data.type === 'ready') {
                    clearTimeout(timer);
                    firstSnapshot = data.snapshot;
                    tickRate = data.tickRate;
                    resolve();
                }
            };
            worker.postMessage({ type: 'initialize' });
        });
    } catch (error) {
        worker.terminate();
        throw error;
    }
    renderer.role = 'host';
    renderer.replayObserverAll = true;
    // Strategic status belongs to the interactive match HUD, not this background scene.
    renderer.drawStrategicLabels = () => {};
    const mapDescriptor = firstSnapshot.mapDescriptor;
    camera(0);
    renderer.setSnapshot(firstSnapshot, { snapTargets: true });
    shownScene = 0;
    worker.onerror = (event) => fail(event.error ?? event);
    worker.onmessage = ({ data }) => {
        if (data.type === 'fatal') {
            fail(data.error ?? data.detail);
            return;
        }
        if (data.type !== 'snapshot' || disposed) return;
        if (data.id !== expectedId++) {
            fail(new Error('타이틀 전투 상태 순서가 올바르지 않습니다.'));
            return;
        }
        pending--;
        const changed =
            data.scene !== shownScene || (data.id > 1 && data.scene === 0 && data.tick === 297);
        if (changed) camera(data.scene);
        data.snapshot.mapDescriptor = mapDescriptor;
        renderer.setSnapshot(data.snapshot, { liveTargets: false, snapTargets: changed });
        shownScene = data.scene;
    };
    scenario = createScenario({
        definition: { seed: 12349, tickRate, endTick: 102, loop: true },
        canAdvance: () => pending < 2,
        createRun() {
            return {
                step(frame) {
                    const scene = frame.tick <= 42 ? 0 : frame.tick <= 72 ? 1 : 2;
                    worker.postMessage({
                        type: 'step',
                        id: ++nextId,
                        scene,
                        restart: frame.tick === 1,
                    });
                    pending++;
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
            scenario.pause();
        },
        dispose() {
            disposed = true;
            scenario.dispose();
            worker.terminate();
        },
    };
}
