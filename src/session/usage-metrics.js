// 게임 지표(GameKit metrics). 이미 있는 사실(화면 주소·부팅 단계·경기 결과)만 읽어 보내고 새로 재는 것은 없다.
//
//   screen:<main·friend·help·play·result>:enter   주소의 화면이 바뀔 때(LaunchScreens.apply 한 곳)
//   boot:ready:done                                   로딩이 끝날 때 한 번(GameKit boot 단계별 ms, 100ms 단위)
//   match:<campaign·ai·friend>:start                  경기 시뮬레이션이 시작될 때(metrics.beginMatch)
//   경기 기록(recordMatch)                             결과가 정해질 때. 연결 만료로 중단된 경기는 남기지 않는다(미완주)
//   campaign:<판 id>:start · campaign:<판 id>:clear   캠페인 판 시작과 클리어
//
// 디버그 장면(?debug=1&scene=)은 이 객체를 만들지 않고, 자동 시험(navigator.webdriver)은 메모리에만 남긴다.
// 기기 ID는 브라우저 저장소에 두지 않는다(metrics 모듈 D-237). 개발자 본인 플레이는 수집 서버가 접속 키로 나중에 거른다.
const RALLY_METRICS_GAME = 'rally-frontier';
const RALLY_METRICS_ENDPOINT = 'https://bloom-metrics.byh-playground.workers.dev';
const BOOT_STAGE_PROPS = Object.freeze({
    sdk: 'sdk',
    units: 'units',
    sprites: 'sprites',
    graphics: 'gfx',
    title: 'title',
});
const round100 = (ms) => Math.max(0, Math.round(ms / 100) * 100);

export class RallyUsageMetrics {
    // gamekit: RallyGamekit (createMetrics·HttpAdapter·MemoryAdapter), version: PRODUCT_VERSION.
    constructor({ gamekit, version, isolated, locale = 'ko' }) {
        this.metrics = gamekit.createMetrics({
            game: RALLY_METRICS_GAME,
            version,
            locale,
            adapter: isolated
                ? new gamekit.MemoryAdapter()
                : new gamekit.HttpAdapter(RALLY_METRICS_ENDPOINT),
        });
        this.lastScreen = null;
        this.bootSent = false;
        // GameSession → { recorder, mode, stageId, finished }
        this.matches = new WeakMap();
    }
    // Address screens only; the same screen again (a sheet or card inside it) is not a new entry.
    screen(screen) {
        const name = screen || 'main';
        if (name === this.lastScreen) return;
        this.lastScreen = name;
        this.safely(() => this.metrics.track('screen', name, 'enter'));
    }
    // marks: RallyBootMarks (stage → { begin, end }). loadMs is page start to ready; `pre` is page start to the first stage.
    bootReady(marks, readyAt = performance.now()) {
        if (this.bootSent) return;
        this.bootSent = true;
        const props = { loadMs: round100(readyAt), pre: round100(marks.sdk?.begin ?? readyAt) };
        for (const [stage, key] of Object.entries(BOOT_STAGE_PROPS))
            if (marks[stage]) props[key] = round100(marks[stage].end - marks[stage].begin);
        this.safely(() => this.metrics.track('boot', 'ready', 'done', props));
    }
    // The match on screen started its simulation. mode: campaign | ai | friend.
    matchStarted(session, { mode, stageId = null }) {
        if (this.matches.has(session)) return;
        const entry = { recorder: null, mode, stageId, finished: false };
        this.matches.set(session, entry);
        this.safely(() => {
            entry.recorder = this.metrics.beginMatch({
                mode,
                seed: session.sim?.seed ?? null,
                ...(session.metricsMatchId ? { matchId: session.metricsMatchId } : {}),
            });
            if (stageId) this.metrics.track('campaign', stageId, 'start');
        });
    }
    // result: win | loss | draw from the local side. A disconnect timeout is an interrupted match and is not recorded.
    matchEnded(session, { result, reason, cleared = false }) {
        const entry = this.matches.get(session);
        if (!entry || entry.finished) return;
        entry.finished = true;
        if (reason === 'disconnect-timeout' || !entry.recorder) return;
        const sim = session.sim,
            ticks = session.matchResult?.tick ?? sim?.tick ?? 0,
            tps = sim?.tps || 0;
        this.safely(() => {
            this.metrics.recordMatch(entry.recorder, {
                result,
                reason,
                ticks,
                durationMs: tps ? Math.round((1000 * ticks) / tps) : null,
                ...(entry.stageId ? { stageId: entry.stageId, cleared } : {}),
            });
            if (entry.stageId && cleared) this.metrics.track('campaign', entry.stageId, 'clear');
        });
    }
    // Metrics never stop the game: a wrong value or size is reported to the console only.
    safely(send) {
        try {
            send();
        } catch (error) {
            console.warn('게임 지표를 남기지 못했습니다.', error);
        }
    }
}
