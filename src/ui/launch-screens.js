import { ResourceDisplay } from './resource-display.js';
import { CAMPAIGN_STAGES } from '../definitions/campaign.js';
import { CampaignPresentation } from './campaign-presentation.js';
import { unitCardStats } from './unit-card-stats.js';
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
        notes: [
            '평타 네 번 뒤 양팔로 적을 휩쓸어요.',
            '스킬로 뛰어올라 착지한 뒤 적을 향해 굴러요.',
        ],
    },
    banana: {
        role: '왕복 원거리 영웅',
        feature: '네 번째 평타 · 왕복 관통',
        land: '영웅 한 명 출격',
        fire: '영웅 단발',
        notes: [
            '네 번째 평타의 금빛 부메랑이 적을 왕복 관통해요.',
            '스킬은 더 멀리 날아가는 큰 부메랑을 던져요.',
        ],
    },
    grape: {
        role: '곡사 원거리 영웅',
        feature: '네 번째 평타 · 곡사탄 3알',
        land: '영웅 한 명 출격',
        fire: '영웅 단발',
        notes: [
            '네 번째 평타마다 표적의 앞·중앙·뒤에 곡사탄을 던져요.',
            '스킬로 포도알 여덟 알을 곡사 연사해요.',
        ],
    },
    rice: {
        role: '기동 근접',
        feature: '빠른 이동 · 산탄 투입',
        land: '넓게 흩어짐',
        fire: '5갈래 산탄',
        notes: ['산탄 다섯 발로 좌우 전열을 훑어요.'],
    },
    millet: {
        role: '기동 근접',
        feature: '비전투 이동 2배 · 몸통 돌진',
        land: '앞뒤로 10명씩 투입',
        fire: '앞뒤 2발',
        notes: ['앞뒤에 투입되어 빠르게 달리고 몸으로 부딪쳐요.'],
    },
    pea: {
        role: '전열 근접',
        feature: '높은 체력 · 중심 강타',
        land: '한 줄로 착지',
        fire: '단발 · 중심 강타',
        notes: ['좁은 착탄점에 큰 피해를 주고 전열을 잡아요.'],
    },
    peanut: {
        role: '건물 돌격',
        feature: '건물만 몸통으로 공격',
        land: '발사 방향과 직각으로 한 줄 배치',
        fire: '단발',
        notes: [
            '착지하면 시야에 들어온 가까운 적 건물에 달려가 들이받아요.',
            '적 병사가 길을 막으면 아군의 엄호가 필요해요.',
        ],
    },
    acorn: {
        role: '범위 근접',
        feature: '회전 공격 · 밀쳐내기',
        land: '한 발당 두 명',
        fire: '범위가 좁아지는 3연사',
        notes: ['탄착 범위가 좁아지는 3연사 뒤 회전으로 적을 밀어요.'],
    },
    corn: {
        role: '범위 원거리',
        feature: '알 착지 후 지연 폭발',
        land: '착점에 6명 모여 투입',
        fire: '높고 느린 곡사 단발',
        notes: ['모여 착지한 뒤 알을 던져 지연 폭발을 일으켜요.'],
    },
    popcorn: {
        role: '자폭 근접',
        feature: '낮게 도약 · 착지 자폭',
        land: '좌우에 5명씩 투입',
        fire: '좌우 2발',
        notes: ['좌우에 착지한 뒤 적에게 뛰어들어 자폭해요.'],
    },
    chestnut: {
        role: '단일 원거리',
        feature: '가시로 먼 적 공격',
        land: '발사 방향과 직각으로 6명 배치',
        fire: '낮고 빠른 단발',
        notes: ['한 줄로 펼쳐져 거리를 두고 가시를 쏴요.'],
    },
    'sunflower-seed': {
        role: '대공 호위',
        feature: '투입탄 우선 · 씨앗 연사',
        land: '착점에 모여 투입',
        fire: '단발',
        notes: [],
        airNote: '적 투입탄을 먼저 연사하고, 공중에 적이 없으면 지상을 쏴요.',
    },
    redbean: {
        role: '돌격 근접',
        feature: '높이 뛰어 내려찍기 · 착지 충격파',
        land: '착지 후 돌격',
        fire: '한 지점을 덮는 3연사',
        notes: ['시간차로 투입되어 적에게 뛰어들어 내려찍어요.'],
    },
});
const SCREENS = new Set(['', 'friend', 'help', 'play', 'result']);

export class LaunchScreens {
    static grainInfo(type) {
        return GRAIN_COPY[type] || { role: '병사', feature: '', land: '', fire: '', notes: [] };
    }
    // actions: { inMatch(), hasResult(), startAiMatch(), openMenu(), closeMenu(), grains(), grainName(type), grainStats(type),
    //           portraitSource(type), toggleSound(), soundOn(), createRoom(), joinRoom(code), leaveToTitle() }
    static install({ createNavigation, showcaseSurface, actions }) {
        this.actions = actions;
        this.showcaseSurface = showcaseSurface;
        this.$ = (id) => document.getElementById(id);
        CampaignPresentation.install(this.$, {
            openOpening: (container, events) => {
                this.closeTitleBattle();
                return this.showcaseSurface.mount({
                    container,
                    scene: { kind: 'campaign-opening', ...events },
                });
            },
            onOpeningClosed: () => this.syncTitleBattle?.(),
        });
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
        if (CARD) this.renderCardDetail(CARD);
        else if (this.cardDetail?.host === this.$('cardDetail')) this.closeCardDetail();
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
        const campaignButton = $('campaignBtn'),
            campaignDialog = $('campaignDialog');
        let campaignHoldTimer = null;
        const cancelCampaignHold = () => {
            clearTimeout(campaignHoldTimer);
            campaignHoldTimer = null;
        };
        campaignButton.addEventListener('pointerdown', (event) => {
            if (!event.isPrimary || event.button !== 0) return;
            cancelCampaignHold();
            campaignHoldTimer = setTimeout(() => {
                campaignHoldTimer = null;
                A.campaignProgress.enableDebugUnlock();
                campaignButton.click();
            }, 1000);
        });
        for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'lostpointercapture'])
            campaignButton.addEventListener(type, (event) => {
                if (event.isPrimary) cancelCampaignHold();
            });
        campaignButton.addEventListener('pointermove', (event) => {
            if (campaignHoldTimer === null || !event.isPrimary) return;
            if (!campaignButton.contains(document.elementFromPoint(event.clientX, event.clientY)))
                cancelCampaignHold();
        });
        campaignButton.addEventListener('contextmenu', (event) => {
            if (campaignHoldTimer !== null || event.pointerType === 'touch') event.preventDefault();
        });
        window.addEventListener('blur', cancelCampaignHold);
        campaignButton.onclick = () => {
            if (campaignDialog.open) return;
            const progress = A.campaignProgress;
            progress.sync();
            $('campaignTitle').textContent = progress.debugUnlocked
                ? '캠페인 · 디버그 해금'
                : '캠페인';
            $('campaignStages').replaceChildren();
            let stageNumber = 0;
            CAMPAIGN_STAGES.forEach((stage) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'launch-btn secondary campaign-stage';
                button.disabled = !progress.canStart(stage);
                const title = document.createElement('b');
                title.textContent = stage.optional
                    ? stage.title
                    : `${++stageNumber}. ${stage.title}`;
                const status = document.createElement('span');
                status.className = 'campaign-stage-status';
                const stageStatus = button.disabled
                    ? '잠김'
                    : progress.isComplete(stage)
                      ? '완료'
                      : '';
                const reward = stage.rewardCard ? `보상 ${A.grainName(stage.rewardCard)}` : '';
                status.textContent = [stage.optional ? '선택 연습' : '', stageStatus, reward]
                    .filter(Boolean)
                    .join(' · ');
                const description = document.createElement('small');
                description.textContent = stage.briefing;
                button.append(title, status, description);
                button.onclick = () => this.showCampaignBriefing(stage);
                $('campaignStages').append(button);
            });
            campaignDialog.showModal();
        };
        $('campaignCloseBtn').onclick = () => campaignDialog.close();
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
        $('resultDeckBtn').onclick = () => A.openRewardDeck(this.resultReward);
        $('resultNextCampaignBtn').onclick = () => this.showCampaignBriefing(this.resultNextStage);
    }
    static showCampaignBriefing(stage) {
        if (!stage || !this.actions.campaignProgress.canStart(stage)) return;
        CampaignPresentation.showBriefing(stage, () => {
            const list = this.$('campaignDialog');
            if (list.open) list.close();
            this.actions.startCampaignStage(stage);
        });
    }
    static renderCampaignResult(reward, nextStage) {
        const $ = this.$;
        this.resultReward = reward;
        this.resultNextStage = nextStage;
        $('resultCampaignReward').hidden = !reward;
        $('resultNextCampaignBtn').hidden = !nextStage;
        $('rematchBtn').hidden = !!nextStage;
        if (!reward) return;
        $('resultRewardText').textContent = `${this.actions.grainName(reward)} 카드를 얻었어요`;
        const portrait = $('resultRewardPortrait');
        portrait.removeAttribute('src');
        this.actions.portraitSource(reward).then(
            (src) => {
                if (this.resultReward === reward) portrait.src = src;
            },
            () => {},
        );
    }
    static closeSheet() {
        const ROUTE = this.navigation.snapshot();
        this.replace(ROUTE.screen === 'play' ? 'play' : '');
    }
    static closeTitleBattle() {
        const mount = this.titleBattleMount;
        this.titleBattleMount = null;
        mount?.dispose();
    }

    static async prepareTitleBattle() {
        if (
            matchMedia('(prefers-reduced-motion: reduce)').matches ||
            this.$('lobby').classList.contains('hidden') ||
            this.cardDetail?.mount ||
            CampaignPresentation.opening ||
            this.titleBattleMount ||
            this.titleBattleFailed
        )
            return;
        const host = this.$('titleBattle');
        let mount;
        const fail = (error) => {
            if (mount && this.titleBattleMount !== mount) return;
            this.titleBattleFailed = true;
            this.closeTitleBattle();
            console.error(error);
        };
        try {
            mount = this.showcaseSurface.mount({
                container: host,
                scene: { kind: 'title', onError: fail },
            });
            this.titleBattleMount = mount;
            if ((await mount.ready) && this.titleBattleMount === mount) this.syncTitleBattle?.();
        } catch (error) {
            fail(error);
        }
    }
    static installTitleBattle() {
        const LOBBY = this.$('lobby');
        const MOTION = matchMedia('(prefers-reduced-motion: reduce)');
        const sync = () => {
            const lobbyVisible = !LOBBY.classList.contains('hidden');
            if (!lobbyVisible) this.closeTitleBattle();
            const active =
                !document.hidden &&
                !this.cardDetail?.mount &&
                !CampaignPresentation.opening &&
                !document.body.classList.contains('boot-loading') &&
                lobbyVisible &&
                !MOTION.matches;
            if (active && !this.titleBattleMount && !this.titleBattleFailed)
                void this.prepareTitleBattle();
            this.titleBattleMount?.setActive(active);
            this.cardDetail?.syncPlayback?.();
            CampaignPresentation.syncOpening();
        };
        this.syncTitleBattle = sync;
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
        if (this.cardDetail?.type === type && this.cardDetail.host === host)
            return this.cardDetail.close;
        this.closeCardDetail(false);
        const A = this.actions,
            copy = this.grainInfo(type),
            stats = unitCardStats(type, A.grainRangeLevel(), copy),
            sections = ['소개', '병력', '포탄'];
        const detail = {
            type,
            host,
            tabIndex: 0,
            close: () => {
                if (this.cardDetail === detail) this.closeCardDetail();
            },
        };
        this.cardDetail = detail;
        const renderStats = (groups) =>
            `<div class="unit-stat-groups">${groups
                .map(
                    ([title, rows, notes = []]) =>
                        `<section class="unit-stat-group"><h3>${title}</h3><dl>${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>${notes.map((line) => `<p>${line}</p>`).join('')}</section>`,
                )
                .join('')}</div>`;
        const panels = [
            `<div class="launch-unit-showcase"></div><p>${copy.airNote ?? copy.notes[0] ?? copy.feature}</p>`,
            renderStats(stats.troop),
            `<p class="unit-stat-note">대포 1대 · 현재 사거리 강화 기준</p>${renderStats(stats.shell)}`,
        ];
        host.innerHTML = `<div class="launch-detail"><img data-portrait="${type}" alt=""><div><h2>${A.grainName(type)}</h2><p>${copy.role}</p></div></div>
<div class="deck-tabs" role="tablist" aria-label="유닛 정보">${sections.map((label, index) => `<button type="button" role="tab" id="${host.id}-tab-${index}" aria-controls="${host.id}-panel-${index}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${label}</button>`).join('')}</div>
${panels.map((body, index) => `<section class="unit-info-panel" role="tabpanel" id="${host.id}-panel-${index}" aria-labelledby="${host.id}-tab-${index}"${index === 0 ? '' : ' hidden'}>${body}</section>`).join('')}
<button type="button" class="launch-btn primary" data-sheet-close>닫기</button>`;
        this.bindCardDetailTabs(detail);
        this.fillCardPortraits(host);
        const panel = host.querySelector('.launch-unit-showcase');
        const motion = matchMedia('(prefers-reduced-motion: reduce)');
        if (motion.matches) {
            panel.dataset.static = 'true';
            const play = document.createElement('button');
            play.type = 'button';
            play.className = 'launch-btn';
            play.textContent = '소개 재생';
            play.addEventListener(
                'click',
                () => void this.startUnitShowcase(detail, panel, motion, true),
                {
                    once: true,
                },
            );
            panel.append(play);
            this.syncTitleBattle?.();
        } else void this.startUnitShowcase(detail, panel, motion, false);
        return detail.close;
    }

    static bindCardDetailTabs(detail) {
        const tabs = [...detail.host.querySelectorAll('[role="tab"]')],
            panels = [...detail.host.querySelectorAll('[role="tabpanel"]')];
        const select = (index) => {
            detail.tabIndex = index;
            tabs.forEach((tab, i) => {
                tab.setAttribute('aria-selected', String(i === index));
                tab.tabIndex = i === index ? 0 : -1;
                panels[i].hidden = i !== index;
            });
            detail.syncPlayback?.();
        };
        tabs.forEach((tab, index) => {
            tab.addEventListener('click', () => select(index));
            tab.addEventListener('keydown', (event) => {
                let next;
                if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
                else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = tabs.length - 1;
                else return;
                event.preventDefault();
                select(next);
                tabs[next].focus();
            });
        });
    }

    static async startUnitShowcase(detail, panel, motion, manual) {
        if (this.cardDetail !== detail) return;
        delete panel.dataset.static;
        panel.innerHTML = '<p role="status">소개를 준비하고 있어요.</p>';
        let mount;
        const fail = (error) => {
            if (this.cardDetail !== detail || (mount && detail.mount !== mount)) return;
            detail.mount = null;
            detail.syncPlayback = null;
            mount?.dispose();
            panel.dataset.static = 'true';
            panel.innerHTML = '<p role="status">소개를 불러오지 못했어요.</p>';
            console.error(error);
            this.syncTitleBattle?.();
        };
        try {
            this.closeTitleBattle();
            mount = this.showcaseSurface.mount({
                container: panel,
                scene: { kind: 'unit', unitType: detail.type, onError: fail },
            });
            detail.mount = mount;
            detail.syncPlayback = () =>
                mount.setActive(
                    detail.tabIndex === 0 && !document.hidden && (manual || !motion.matches),
                );
            detail.syncPlayback();
            if (
                (await mount.ready) &&
                (await mount.presented) &&
                this.cardDetail === detail &&
                detail.mount === mount
            ) {
                panel.querySelector('p')?.remove();
            }
        } catch (error) {
            fail(error);
        }
    }

    static closeCardDetail(resumeTitle = true) {
        const detail = this.cardDetail;
        if (!detail) return;
        this.cardDetail = null;
        const mount = detail.mount;
        detail.mount = null;
        detail.syncPlayback = null;
        mount?.dispose();
        if (resumeTitle) this.syncTitleBattle?.();
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
    static renderAimLabel(
        at,
        type,
        maxReach,
        cannonCount,
        passengerCount,
        { showVolleyHint = false, requiredCannons } = {},
    ) {
        const LABEL = this.$('aimLabel');
        LABEL.classList.toggle('hidden', !at);
        if (!at) {
            return;
        }
        if (requiredCannons != null) {
            const status =
                cannonCount === requiredCannons
                    ? '충족'
                    : cannonCount < requiredCannons
                      ? '부족'
                      : '초과';
            const text = `목표 ${requiredCannons}문 · 현재 ${cannonCount}문 · ${status}`;
            LABEL.classList.remove('shared');
            if (LABEL.textContent !== text) LABEL.textContent = text;
            const half = LABEL.offsetWidth / 2,
                x = Math.max(half, Math.min(at.x, LABEL.parentElement.clientWidth - half));
            LABEL.style.transform = `translate(${Math.round(x)}px,${Math.round(at.y)}px) translate(-50%,-100%)`;
            return;
        }
        const SHARED = cannonCount > 1,
            NAME = this.actions.grainName(type),
            STATS = this.actions.grainStats(type),
            BONUS = passengerCount - STATS.count,
            TEXT = SHARED
                ? `${NAME} ${passengerCount}기${BONUS > 0 ? ` (+${BONUS})` : ''} · 대포 ${cannonCount}문`
                : `${NAME} ×${passengerCount} · ${GRAIN_COPY[type]?.fire || this.landingLabel(type)} · 최대 발사 ${maxReach.toLocaleString('ko-KR')}`,
            COST = SHARED ? ResourceDisplay.costText(STATS) : '',
            HINT = showVolleyHint ? '대포의 사거리가 겹치면 같은 값으로 병력이 더 나와요.' : '';
        LABEL.classList.toggle('shared', SHARED);
        if (LABEL.textContent !== TEXT + COST + HINT) {
            LABEL.textContent = TEXT;
            if (COST) {
                const detail = document.createElement('span');
                detail.className = 'aim-label-cost';
                detail.textContent = COST;
                LABEL.append(detail);
            }
            if (HINT) {
                const hint = document.createElement('span');
                hint.className = 'aim-label-hint';
                hint.textContent = HINT;
                LABEL.append(hint);
            }
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
