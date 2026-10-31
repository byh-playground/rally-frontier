/**
 * 주소로 여는 확인용 장면(`?debug=1&scene=이름&tick=N&…`). 일반 플레이에서는 로드되지 않는다.
 * 호스트는 파라미터를 해석하지 않으므로 값의 형식은 각 장면이 정하고, 틀리면 그대로 실패한다.
 */
const SCENE_EPOCH_MS = 10_000_000;

export function createDebugScenes({ openBattle }) {
  return {
    /**
     * 두 병종이 맞붙는 전투를 실제 경기 생성 경로와 리플레이 재생기로 연다.
     * 예: `?debug=1&scene=battle&seed=7&ally=swarmbug&enemy=shelltitan&allyCount=10&enemyCount=5&tick=60`
     */
    battle({ seed, ally, enemy, allyCount, enemyCount }) {
      if (!/^\d+$/.test(seed ?? '')) throw new Error(`battle needs an integer seed: ${seed}`);
      // 보간·연출이 읽는 시계도 틱에서 나오게 해, 같은 주소가 항상 같은 화면을 만든다.
      // 깃발 흔들림처럼 절대 시각을 읽는 연출이 있어 시작 시각도 고정한다. 이미 발행된
      // 표시 시각이 거꾸로 가지 않도록 페이지를 연 뒤 지난 시간보다 커야 한다.
      const realNow = performance.now.bind(performance);
      if (realNow() >= SCENE_EPOCH_MS) throw new Error(`battle must open within ${SCENE_EPOCH_MS}ms of page load`);
      let clock = SCENE_EPOCH_MS;
      performance.now = () => clock;
      let player;
      try {
        player = openBattle({ seed: Number(seed) >>> 0, allyType: ally, enemyType: enemy, allyCount: Number(allyCount), enemyCount: Number(enemyCount) });
      } catch (error) {
        performance.now = realNow;
        throw error;
      }
      const tickMs = 1000 / player.sim.tps;
      return {
        step() {
          if (!player.stepOnce()) throw new Error(`battle stopped at tick ${player.sim.tick}`);
          clock += tickMs;
        },
        render() {
          player.publish();
          // 마지막 틱의 보간이 끝난 시각에서 그려 화면이 틱 상태와 같게 한다.
          clock += tickMs;
        },
        state() {
          const alive = side => player.sim.units.filter(unit => unit.alive && unit.side === side).length;
          return {
            simTick: player.sim.tick,
            host: alive(0),
            guest: alive(1),
            checksum: player.sim.checksum(),
          };
        },
        dispose() {
          player.stop();
          performance.now = realNow;
        },
      };
    },
  };
}
