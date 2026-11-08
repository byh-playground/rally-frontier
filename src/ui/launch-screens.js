import { ResourceDisplay } from './resource-display.js';
import { CAMPAIGN_STAGES } from '../definitions/campaign.js';
import './grain-portrait.js';

// Launch match screens (title, friend, help, in-game HUD and cards, match menu, result) and their addresses.
// Routes: #/ title, #/friend, #/help, #/play, #/play/menu, #/play/help, #/play/<grain> card detail, #/result.
// The game owns matches; this module owns which screen and sheet the address shows, and asks the game through `actions`.
const GRAIN_COPY = Object.freeze({
    watermelon: {
        role: '범위 근접 영웅',
        feature: '범위 평타 4회 → 양팔 360도 휩쓸기',
        land: '영웅 한 명 출격',
        fire: '영웅 단발',
        desc: '수박의 평타는 맞은 적 주변의 병력에도 피해를 줍니다. 병력에게 평타가 네 번 맞으면 다음 공격에 양팔로 몸 주변을 휩쓸어 기본 공격과 같은 피해를 주고 적을 밀어냅니다.',
        exceptions: [
            '출격 중 카드를 짧게 탭하면 진격과 복귀를 전환합니다.',
            '카드를 길게 누르면 수박이 높이 뛰어오릅니다. 바닥의 원과 화살표가 착지 충격파 범위와 구르기 경로를 예고합니다.',
            '착지 충격파와 구르기 접촉은 각각 평타와 같은 피해를 줍니다.',
            '다른 동작 중에는 스킬을 한 번 예약하고, 발동할 때 보급을 씁니다.',
            '아군 거점에 회수되면 체력이 차오르고, 현재 체력으로 다시 출격할 수 있습니다.',
        ],
    },
    banana: {
        role: '왕복 원거리 영웅',
        feature: '네 번째 평타 · 왕복 관통',
        land: '영웅 한 명 출격',
        fire: '영웅 단발',
        desc: '작은 부메랑으로 적 하나를 공격합니다. 네 번째 평타는 금빛 부메랑이 처음 겨눈 적 뒤까지 날아가고, 나갈 때와 돌아올 때 경로의 적을 각각 한 번 맞힙니다.',
        exceptions: [
            '카드를 길게 누르면 긴 왕복 궤적을 예고하고 큰 부메랑을 던집니다. 나갈 때와 돌아올 때 적 병력과 영웅에게 각각 평타의 두 배 피해를 줍니다.',
            '바나나는 큰 부메랑을 받을 때까지 제자리에 있습니다.',
        ],
    },
    grape: {
        role: '곡사 원거리 영웅',
        feature: '세 번째 평타 · 포도알 곡사탄',
        land: '영웅 한 명 출격',
        fire: '영웅 단발',
        desc: '포도알로 적 하나를 공격합니다. 세 번째 평타마다 포도알 한 알을 추가로 높이 던져 착탄 지점 주변에 피해를 줍니다.',
        exceptions: [
            '카드를 길게 누르면 적 주변의 착탄 지점을 예고하고 포도알 여덟 알을 차례로 곡사 투척합니다. 한 알의 피해는 세 번째 평타의 추가 곡사탄과 같습니다.',
        ],
    },
    rice: {
        role: '기동 근접',
        feature: '빠른 이동 · 산탄 투입',
        land: '넓게 흩어짐',
        fire: '5갈래 산탄',
        desc: '포탄 다섯 발이 좌우로 퍼지며 넓게 늘어선 전열을 한 번에 훑습니다.',
    },
    millet: {
        role: '기동 근접',
        feature: '비전투 이동 2배 · 몸통 돌진',
        land: '앞뒤로 10명씩 투입',
        fire: '앞뒤 2발',
        desc: '포탄 두 발이 발사 방향을 따라 앞뒤로 동시에 떨어집니다. 조는 두 무리로 나와 빠르게 이동하고 적에게 몸을 부딪혀 싸웁니다.',
        exceptions: ['착점 주변에 자리가 부족하면 해당 무리가 나올 수 있을 때까지 기다립니다.'],
    },
    pea: {
        role: '전열 근접',
        feature: '높은 체력 · 중심 강타',
        land: '한 줄로 착지',
        fire: '단발 · 중심 강타',
        desc: '좁은 범위에 강한 포탄 한 발을 쏩니다. 중심에 정확히 맞힌 뒤 체력이 높은 콩으로 전열을 잡습니다.',
    },
    acorn: {
        role: '범위 근접',
        feature: '회전 공격 · 밀쳐내기',
        land: '한 발당 두 명',
        fire: '범위가 좁아지는 3연사',
        desc: '같은 자리에 세 발을 떨어뜨립니다. 뒤로 갈수록 착탄 범위가 좁아지고 마지막 탄이 가장 강합니다. 도토리는 착지 후 적 가까이에서 회전하며 공격하고 밀쳐냅니다.',
        exceptions: [
            '회전 공격은 타격마다 가까운 적 지상 병사를 최대 세 명 맞혀 밀쳐냅니다.',
            '범위 안의 적 건물은 모두 맞힙니다.',
        ],
    },
    corn: {
        role: '범위 원거리',
        feature: '알 착지 후 지연 폭발',
        land: '착점에 6명 모여 투입',
        fire: '높고 느린 곡사 단발',
        desc: '높이 날아가는 포탄 한 발로 옥수수 6명을 모아 내립니다. 착지한 병사가 던진 알은 땅에 닿은 뒤 1초 후 폭발합니다.',
    },
    popcorn: {
        role: '자폭 근접',
        feature: '낮게 도약 · 착지 자폭',
        land: '좌우에 5명씩 투입',
        fire: '좌우 2발',
        desc: '조준점 양쪽에 포탄을 동시에 떨어뜨려 팝콘을 5명씩 내립니다. 팝콘은 적에게 낮게 뛰어들어 착지와 동시에 자폭하고 주변 적 병사를 밀어냅니다.',
        exceptions: [
            '이미 가까운 적에게는 제자리에서 1초 동안 부푼 뒤 폭발합니다.',
            '착지나 부풀기 전에 쓰러지면 폭발하지 않습니다. 부푸는 중 쓰러지면 즉시 폭발합니다.',
        ],
    },
    chestnut: {
        role: '단일 원거리',
        feature: '가시로 먼 적 공격',
        land: '발사 방향과 직각으로 6명 배치',
        fire: '낮고 빠른 단발',
        desc: '낮고 빠른 포탄으로 밤톨 6명을 좌우로 펼쳐 내립니다. 밤톨은 적과 거리를 유지하며 가시를 쏩니다.',
        exceptions: ['가시는 발사할 때 정한 적에게만 맞으며, 적이 피하면 빗나갑니다.'],
    },
    redbean: {
        role: '돌격 근접',
        feature: '높이 뛰어 내려찍기 · 착지 충격파',
        land: '착지 후 돌격',
        fire: '한 지점을 덮는 3연사',
        desc: '같은 자리에 같은 범위의 포탄을 0.3초 간격으로 세 번 떨어뜨립니다. 팥은 적 병사 쪽으로 높이 뛰어올라 내려찍고, 착지 충격파로 주변 적을 공격합니다.',
        exceptions: [
            '점프에는 재사용 대기 시간이 있으며, 가까운 적은 일반 근접 공격으로 상대합니다.',
        ],
    },
});
const SCREENS = new Set(['', 'friend', 'help', 'play', 'result']);

export class LaunchScreens {
    static grainInfo(type) {
        return GRAIN_COPY[type] || { role: '병사', feature: '', land: '', fire: '', desc: '' };
    }
    // actions: { inMatch(), hasResult(), startAiMatch(), openMenu(), closeMenu(), grains(), grainName(type), grainStats(type),
    //           portraitSource(type), toggleSound(), soundOn(), createRoom(), joinRoom(code), leaveToTitle() }
    static install({ createNavigation, mountScenarioFrame, actions }) {
        this.actions = actions;
        this.mountScenarioFrame = mountScenarioFrame;
        this.$ = (id) => document.getElementById(id);
        this.navigation = createNavigation({
            normalize: (route) =>
                SCREENS.has(route.screen) ? route : { screen: '', item: '', query: '' },
        });
        this.bindButtons();
        this.installTitleBattle();
        this.navigation.subscribe((route) => this.apply(route), { immediate: true });
    }
    static go(screen, item = '') {
        this.navigation?.navigate({ screen, item, query: '' });
    }
    static replace(screen, item = '') {
        this.navigation?.replace({ screen, item, query: '' });
    }
    static back() {
        this.navigation?.back();
    }
    // The game moved to another screen on its own (match started, result, back to the lobby).
    static syncScreen(screen) {
        if (!this.navigation) {
            return;
        }
        const ROUTE = this.navigation.snapshot();
        if (screen === 'game' && ROUTE.screen !== 'play') {
            this.replace('play');
        } else if (screen === 'result' && ROUTE.screen !== 'result') {
            this.replace('result');
        } else if (screen === 'lobby' && ROUTE.screen === 'result') {
            this.replace('');
        }
    }
    static apply(route) {
        const A = this.actions,
            SCREEN = route.screen,
            ITEM = route.item;
        // A running match keeps the battlefield: leaving its address opens the menu instead.
        if (SCREEN !== 'play' && A.inMatch()) {
            this.replace('play', 'menu');
            return;
        }
        if (SCREEN === 'play' && !A.inMatch()) {
            if (A.hasResult()) {
                this.replace('result');
                return;
            }
            A.startAiMatch();
        }
        if (SCREEN === 'result' && !A.hasResult()) {
            this.replace('');
            return;
        }
        const MENU = SCREEN === 'play' && ITEM === 'menu';
        if (MENU) {
            A.openMenu();
        } else {
            A.closeMenu();
        }
        this.$('matchMenuSoundBtn').textContent = A.soundOn() ? '소리 끄기' : '소리 켜기';
        this.showSheet('friendSheet', SCREEN === 'friend');
        this.showSheet(
            'launchHelpSheet',
            SCREEN === 'help' || (SCREEN === 'play' && ITEM === 'help'),
        );
        const CARD = SCREEN === 'play' && A.grains().includes(ITEM) ? ITEM : null;
        if (CARD) {
            this.renderCardDetail(CARD);
        }
        this.showSheet('cardSheet', !!CARD);
        if (CARD) this.$('cardDetail').querySelector('[data-sheet-close]')?.focus();
        else if (this.cardDetailTrigger) {
            if (SCREEN === 'play' && !ITEM && this.cardDetailTrigger.isConnected)
                this.cardDetailTrigger.focus();
            this.cardDetailTrigger = null;
        }
    }
    static showSheet(id, on) {
        this.$(id).classList.toggle('hidden', !on);
    }
    static bindButtons() {
        const A = this.actions,
            $ = this.$;
        // A start that failed leaves the address on #/play, so the button starts again without an address change.
        $('gameStartBtn').onclick = () => {
            A.selectCampaign(null);
            if (this.navigation.snapshot().screen === 'play') A.startAiMatch();
            else this.go('play');
        };
        $('campaignBtn').onclick = () => {
            const progress = A.campaignProgress();
            $('campaignStages').replaceChildren();
            CAMPAIGN_STAGES.forEach((stage, index) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'launch-btn secondary campaign-stage';
                button.disabled = index > progress;
                const title = document.createElement('b');
                title.textContent = `${index + 1}. ${stage.title}`;
                const status = document.createElement('span');
                status.className = 'campaign-stage-status';
                status.textContent = button.disabled ? '잠김' : index < progress ? '완료' : '';
                const description = document.createElement('small');
                description.textContent = stage.briefing;
                button.append(title, status, description);
                button.onclick = () => {
                    $('campaignDialog').close();
                    A.selectCampaign(stage.id);
                    if (this.navigation.snapshot().screen === 'play') A.startAiMatch();
                    else this.go('play');
                };
                $('campaignStages').append(button);
            });
            $('campaignDialog').showModal();
        };
        $('campaignCloseBtn').onclick = () => $('campaignDialog').close();
        $('friendMatchBtn').onclick = () => this.go('friend');
        $('titleHelpBtn').onclick = () => this.go('help');
        $('friendCreateBtn').onclick = () => {
            this.replace('');
            A.createRoom();
        };
        $('friendJoinBtn').onclick = () => {
            const CODE = $('friendCodeInput').value.replace(/\D/g, '').slice(0, 4);
            if (CODE.length !== 4) {
                $('friendCodeInput').focus();
                return;
            }
            this.replace('');
            A.joinRoom(CODE);
        };
        $('friendCodeInput').oninput = (e) => {
            e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
        };
        // The menu can close without an address change (Esc), so a tap on the same address opens it directly.
        $('matchMenuBtnGame').onclick = () =>
            this.navigation.snapshot().item === 'menu' ? A.openMenu() : this.go('play', 'menu');
        $('matchMenuHelpBtn').onclick = () => this.replace('play', 'help');
        $('matchMenuSoundBtn').onclick = () => {
            A.toggleSound();
            $('matchMenuSoundBtn').textContent = A.soundOn() ? '소리 끄기' : '소리 켜기';
        };
        for (const id of ['matchMenuContinueBtn', 'matchMenuCloseBtn', 'matchMenuBackdrop']) {
            $(id).onclick = () => this.replace('play');
        }
        for (const id of ['friendSheet', 'launchHelpSheet', 'cardSheet']) {
            $(id).addEventListener('click', (e) => {
                if (e.target.id === id || e.target.closest('[data-sheet-close]')) {
                    this.closeSheet();
                }
            });
        }
        $('launchCards').addEventListener(
            'click',
            (e) => {
                const INFO = e.target.closest('[data-card-info]');
                if (INFO) {
                    e.stopPropagation();
                    this.cardDetailTrigger = INFO;
                    this.go('play', INFO.dataset.cardInfo);
                }
            },
            true,
        );
        $('resultTitleBtn').onclick = () => A.leaveToTitle();
    }
    static closeSheet() {
        const ROUTE = this.navigation.snapshot();
        this.replace(ROUTE.screen === 'play' ? 'play' : '');
    }
    static async prepareTitleBattle() {
        if (
            matchMedia('(prefers-reduced-motion: reduce)').matches ||
            this.$('lobby').classList.contains('hidden') ||
            this.titleBattleFrame ||
            this.titleBattleFailed
        )
            return;
        const host = this.$('titleBattle');
        try {
            const mount = this.mountScenarioFrame({
                container: host,
                src: './index.html?titleShowcase=1',
                timeoutMs: 15000,
                configure(frame) {
                    frame.title = '실시간 전투 배경';
                    frame.tabIndex = -1;
                    frame.setAttribute('aria-hidden', 'true');
                },
                prepare: ({ frame, signal }) =>
                    new Promise((resolve) => {
                        const finish = (ok) => {
                            window.removeEventListener('message', receive);
                            signal.removeEventListener('abort', abort);
                            if (!ok) this.titleBattleFailed = true;
                            resolve();
                        };
                        const abort = () => finish(false);
                        const receive = (event) => {
                            if (
                                event.origin !== location.origin ||
                                event.source !== frame.contentWindow
                            )
                                return;
                            if (event.data?.type === 'title-showcase-ready') finish(true);
                            else if (event.data?.type === 'title-showcase-failed') finish(false);
                        };
                        window.addEventListener('message', receive);
                        signal.addEventListener('abort', abort, { once: true });
                    }),
            });
            this.titleBattleMount = mount;
            this.titleBattleFrame = mount.frame;
            const ready = await mount.ready;
            if (!ready || this.titleBattleFailed) {
                mount.dispose();
                this.titleBattleFrame = null;
            } else this.titleBattleReady = true;
        } catch (error) {
            this.titleBattleFailed = true;
            this.titleBattleFrame = null;
            console.error(error);
        }
        this.syncTitleBattle?.();
    }
    static installTitleBattle() {
        const LOBBY = this.$('lobby');
        const MOTION = matchMedia('(prefers-reduced-motion: reduce)');
        const sync = () => {
            const active =
                !document.hidden &&
                !document.body.classList.contains('boot-loading') &&
                !LOBBY.classList.contains('hidden') &&
                !MOTION.matches;
            if (active && !this.titleBattleFrame && !this.titleBattleFailed) {
                void this.prepareTitleBattle();
            }
            this.titleBattleFrame?.contentWindow?.postMessage(
                { type: 'title-showcase-active', active },
                location.origin,
            );
        };
        this.syncTitleBattle = sync;
        window.addEventListener('message', (event) => {
            if (
                this.titleBattleReady &&
                event.origin === location.origin &&
                event.source === this.titleBattleFrame?.contentWindow &&
                event.data?.type === 'title-showcase-failed'
            ) {
                this.titleBattleMount?.dispose();
                this.titleBattleFrame = null;
                this.titleBattleFailed = true;
            }
        });
        new MutationObserver(sync).observe(LOBBY, { attributes: true, attributeFilter: ['class'] });
        new MutationObserver(sync).observe(document.body, {
            attributes: true,
            attributeFilter: ['class'],
        });
        document.addEventListener('visibilitychange', sync);
        MOTION.addEventListener('change', sync);
    }
    // Card buttons with face portraits; the game keeps their selected/unaffordable classes.
    static cardMarkup(type, hero) {
        const A = this.actions,
            STATS = A.grainStats(type);
        return `<div class="launch-card-slot"><button type="button" class="launch-card" data-launch-card="${type}"><img class="launch-card-portrait" data-portrait="${type}" alt=""><b>${A.grainName(type)}${hero ? '' : ` ×${STATS.count}`}</b><em>${ResourceDisplay.costMarkup(STATS)}</em></button><button type="button" class="launch-card-info" data-card-info="${type}" aria-label="${A.grainName(type)} 상세">i</button></div>`;
    }
    static fillCardPortraits(host) {
        for (const IMG of host.querySelectorAll('img[data-portrait]')) {
            this.actions.portraitSource(IMG.dataset.portrait).then(
                (src) => (IMG.src = src),
                () => {},
            );
        }
    }
    static renderCardDetail(type, host = this.$('cardDetail')) {
        const A = this.actions,
            STATS = A.grainStats(type),
            COPY = this.grainInfo(type);
        const EXCEPTIONS = COPY.exceptions?.length
            ? `<ul aria-label="알아둘 점" style="margin:6px 0 10px;padding-left:1.2em;font-size:.9em;line-height:1.45">${COPY.exceptions.map((text) => `<li>${text}</li>`).join('')}</ul>`
            : '';
        host.innerHTML = `<div class="launch-detail"><img data-portrait="${type}" alt=""><div><h2>${A.grainName(type)}</h2><p>${COPY.desc}</p></div></div>
${EXCEPTIONS}
<div class="launch-stats"><div>비용<b>${ResourceDisplay.costText(STATS, true)}</b></div><div>병사 수<b>${STATS.count}</b></div><div>최대 사거리<b>${STATS.maxReach.toLocaleString('ko-KR')}</b></div><div>발사<b>${COPY.fire}</b></div><div>착지<b>${COPY.land}</b></div></div>
<button type="button" class="launch-btn primary" data-sheet-close>닫기</button>`;
        this.fillCardPortraits(host);
    }
    static landingLabel(type) {
        return GRAIN_COPY[type]?.land || '';
    }
    // Top HUD: both main bases' health and the elapsed match time. enemyDirection is null while the base is on screen.
    static renderHud({ myHpPct, enemyHpPct, elapsedMs, enemyDirection }) {
        const $ = this.$;
        $('launchHudMine').textContent = `나 ♥ ${myHpPct}%`;
        $('launchHudEnemy').textContent = `적 ♥ ${enemyHpPct}%`;
        $('launchHudTime').textContent = formatClock(elapsedMs);
        const ARROW = $('enemyBaseArrow');
        ARROW.classList.toggle('hidden', !enemyDirection);
        if (enemyDirection) {
            ARROW.querySelector('i').style.transform = `rotate(${enemyDirection.angle}rad)`;
            ARROW.querySelector('b').textContent =
                `적 본진 ${Math.round(enemyDirection.distance).toLocaleString('ko-KR')}`;
        }
    }
    // Label over the landing ring while aiming; at is the ring centre in page pixels, or null when not aiming.
    static renderAimLabel(at, type, maxReach) {
        const LABEL = this.$('aimLabel');
        LABEL.classList.toggle('hidden', !at);
        if (!at) {
            return;
        }
        const TEXT = `${this.actions.grainName(type)} ×${this.actions.grainStats(type).count} · ${GRAIN_COPY[type]?.fire || this.landingLabel(type)} · 최대 발사 ${maxReach.toLocaleString('ko-KR')}`;
        if (LABEL.textContent !== TEXT) {
            LABEL.textContent = TEXT;
        }
        LABEL.style.transform = `translate(${Math.round(at.x)}px,${Math.round(at.y)}px) translate(-50%,-100%)`;
    }
    static renderResult({ durationMs, launches, sent, kills, unitStats, deck, partial = false }) {
        const $ = this.$;
        $('resultStats').innerHTML =
            `<div>경기 시간<b>${formatClock(durationMs)}</b></div><div>발사<b>${launches}회</b></div><div>발사 배정 병사<b>${sent}</b></div><div>처치<b>${kills}</b></div>`;
        const section = $('resultByUnit'),
            rows = $('resultByUnitRows');
        rows.replaceChildren();
        section.hidden = !unitStats;
        $('resultByUnitPartial').hidden = !partial;
        if (!unitStats) return;
        const types = new Set([...this.actions.grains(), ...deck, ...Object.keys(unitStats)]);
        for (const type of types) {
            const stat = unitStats[type];
            if (!stat || (!deck.includes(type) && !Object.values(stat).some((value) => value > 0)))
                continue;
            const row = document.createElement('tr');
            const name = document.createElement('th');
            name.scope = 'row';
            name.textContent = this.actions.grainName(type);
            row.append(name);
            for (const value of [
                stat.deployed,
                stat.kills,
                stat.unitDamage + stat.buildingDamage,
            ]) {
                const cell = document.createElement('td');
                cell.textContent = value.toLocaleString('ko-KR');
                row.append(cell);
            }
            const damage = row.lastElementChild;
            damage.title = `병사 ${stat.unitDamage.toLocaleString('ko-KR')} · 건물 ${stat.buildingDamage.toLocaleString('ko-KR')}`;
            damage.setAttribute(
                'aria-label',
                `유효 피해 ${damage.textContent}, 병사 ${stat.unitDamage}, 건물 ${stat.buildingDamage}`,
            );
            rows.append(row);
        }
    }
}

function formatClock(ms) {
    const SECONDS = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(SECONDS / 60)}:${String(SECONDS % 60).padStart(2, '0')}`;
}
