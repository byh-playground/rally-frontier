// A title-only simulation Worker. It has no player storage, network transport or UI.
self.__RALLY_PRESENT_FATAL__ = (detail) => self.postMessage({ type: 'fatal', detail });
self.__RALLY_GAMEKIT_SCOPE__ = 'simulation';
const ready = import('./title-showcase-sim.js');
let run,
    checkpoints,
    currentScene = -1;
self.addEventListener('message', async ({ data }) => {
    try {
        const module = await ready;
        if (data.type === 'initialize') {
            const response = await fetch(
                new URL('../../assets/title-showcase.json', import.meta.url),
            );
            if (!response.ok) throw new Error('타이틀 전투 데이터를 불러오지 못했습니다.');
            const saved = await response.json();
            const { PRODUCT_VERSION } = await import('../core/product-version.js');
            if (
                saved.productVersion !== PRODUCT_VERSION ||
                saved.seed !== 12349 ||
                saved.checkpoints?.length !== 3
            )
                throw new Error('타이틀 전투 데이터 버전이 현재 게임과 다릅니다.');
            checkpoints = saved.checkpoints;
            const map = JSON.stringify(checkpoints[0].state.mapDescriptor);
            if (
                checkpoints.some(
                    (checkpoint) => JSON.stringify(checkpoint.state.mapDescriptor) !== map,
                )
            )
                throw new Error('타이틀 전투 장면의 맵이 일치하지 않습니다.');
            run = module.createTitleRun(saved.seed);
            for (const checkpoint of checkpoints) {
                run.restore(checkpoint);
                if (run.sim.checksum() !== checkpoint.checksum)
                    throw new Error('타이틀 전투 상태 검증에 실패했습니다.');
            }
            run.restore(checkpoints[0]);
            currentScene = 0;
            self.postMessage({
                type: 'ready',
                snapshot: run.sim.snapshot(),
                tickRate: run.sim.tps,
            });
        } else if (data.type === 'step') {
            if (!run) throw new Error('타이틀 전투가 준비되지 않았습니다.');
            if (data.scene !== currentScene || data.restart) {
                run.restore(checkpoints[data.scene]);
                currentScene = data.scene;
            }
            run.advance();
            const snapshot = run.sim.snapshot();
            // A title scenario uses one immutable map. Transfer it once, not on every tick.
            delete snapshot.mapDescriptor;
            self.postMessage({
                type: 'snapshot',
                id: data.id,
                scene: currentScene,
                tick: run.sim.tick,
                snapshot,
            });
        }
    } catch (error) {
        // Error is structured-cloned across the Worker boundary with its name, message and stack.
        self.postMessage({ type: 'fatal', error });
    }
});
