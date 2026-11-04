import './grain-portrait.js';

// Launch match screens (title, friend, help, in-game HUD and cards, match menu, result) and their addresses.
// Routes: #/ title, #/friend, #/help, #/play, #/play/menu, #/play/help, #/play/<grain> card detail, #/result.
// The game owns matches; this module owns which screen and sheet the address shows, and asks the game through `actions`.
const GRAIN_COPY = Object.freeze({
    rice: { land: '넓게 흩어짐', desc: '가장 멀리 날아가 넓게 흩어집니다. 먼 곳을 먼저 차지할 때 씁니다.' },
    soybean: { land: '한 줄로 착지', desc: '착지하면 적 본진 쪽으로 한 줄로 섭니다. 기본 전열입니다.' },
    redbean: { land: '착지 후 돌격', desc: '착지하자마자 잠깐 빠르게 돌격합니다. 마무리 일격입니다.' },
});
const SCREENS = new Set(['', 'friend', 'help', 'play', 'result']);

export class LaunchScreens {
    // actions: { inMatch(), hasResult(), startAiMatch(), openMenu(), closeMenu(), grains(), grainName(type), grainStats(type),
    //           portraitSource(type), toggleSound(), soundOn(), createRoom(), joinRoom(code), leaveToTitle() }
    static install({ createNavigation, actions }) {
        this.actions = actions;
        this.$ = (id) => document.getElementById(id);
        this.navigation = createNavigation({
            normalize: (route) => (SCREENS.has(route.screen) ? route : { screen: '', item: '', query: '' }),
        });
        this.bindButtons();
        this.renderPortraits();
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
        this.showSheet('launchHelpSheet', SCREEN === 'help' || (SCREEN === 'play' && ITEM === 'help'));
        const CARD = SCREEN === 'play' && A.grains().includes(ITEM) ? ITEM : null;
        if (CARD) {
            this.renderCardDetail(CARD);
        }
        this.showSheet('cardSheet', !!CARD);
    }
    static showSheet(id, on) {
        this.$(id).classList.toggle('hidden', !on);
    }
    static bindButtons() {
        const A = this.actions,
            $ = this.$;
        // A start that failed leaves the address on #/play, so the button starts again without an address change.
        $('gameStartBtn').onclick = () => (this.navigation.snapshot().screen === 'play' ? A.startAiMatch() : this.go('play'));
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
        $('matchMenuBtnGame').onclick = () => (this.navigation.snapshot().item === 'menu' ? A.openMenu() : this.go('play', 'menu'));
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
        $('launchCards').addEventListener('click', (e) => {
            const INFO = e.target.closest('[data-card-info]');
            if (INFO) {
                e.stopPropagation();
                this.go('play', INFO.dataset.cardInfo);
            }
        }, true);
        $('resultTitleBtn').onclick = () => A.leaveToTitle();
    }
    static closeSheet() {
        const ROUTE = this.navigation.snapshot();
        this.replace(ROUTE.screen === 'play' ? 'play' : '');
    }
    static async renderPortraits() {
        const HOST = this.$('titleGrains');
        HOST.replaceChildren();
        for (const TYPE of this.actions.grains()) {
            const IMG = document.createElement('img');
            IMG.alt = this.actions.grainName(TYPE);
            HOST.append(IMG);
            this.actions.portraitSource(TYPE).then((src) => (IMG.src = src), () => IMG.remove());
        }
    }
    // Card buttons with face portraits; the game keeps their selected/unaffordable classes.
    static cardMarkup(type) {
        const A = this.actions,
            STATS = A.grainStats(type);
        return `<button type="button" class="launch-card" data-launch-card="${type}"><span class="launch-card-info" data-card-info="${type}" role="button" aria-label="${A.grainName(type)} 상세">i</span><img class="launch-card-portrait" data-portrait="${type}" alt=""><b>${A.grainName(type)} ×${STATS.count}</b><em>${STATS.cost}</em></button>`;
    }
    static fillCardPortraits(host) {
        for (const IMG of host.querySelectorAll('img[data-portrait]')) {
            this.actions.portraitSource(IMG.dataset.portrait).then((src) => (IMG.src = src), () => {});
        }
    }
    static renderCardDetail(type) {
        const A = this.actions,
            STATS = A.grainStats(type),
            COPY = GRAIN_COPY[type] || { land: '', desc: '' },
            HOST = this.$('cardDetail');
        HOST.innerHTML = `<div class="launch-detail"><img data-portrait="${type}" alt=""><div><h2>${A.grainName(type)}</h2><p>${COPY.desc}</p></div></div>
<div class="launch-stats"><div>비용<b>${STATS.cost}</b></div><div>병사 수<b>${STATS.count}</b></div><div>최대 사거리<b>${STATS.maxReach.toLocaleString('ko-KR')}</b></div><div>착지<b>${COPY.land}</b></div></div>
<button type="button" class="launch-btn primary" data-sheet-close>닫기</button>`;
        this.fillCardPortraits(HOST);
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
            ARROW.querySelector('b').textContent = `적 본진 ${Math.round(enemyDirection.distance).toLocaleString('ko-KR')}`;
        }
    }
    // Label over the landing ring while aiming; at is the ring centre in page pixels, or null when not aiming.
    static renderAimLabel(at, type) {
        const LABEL = this.$('aimLabel');
        LABEL.classList.toggle('hidden', !at);
        if (!at) {
            return;
        }
        const TEXT = `${this.actions.grainName(type)} ×${this.actions.grainStats(type).count} · ${this.landingLabel(type)}`;
        if (LABEL.textContent !== TEXT) {
            LABEL.textContent = TEXT;
        }
        LABEL.style.transform = `translate(${Math.round(at.x)}px,${Math.round(at.y)}px) translate(-50%,-100%)`;
    }
    static renderResult({ durationMs, launches, sent, kills }) {
        const $ = this.$;
        $('resultStats').innerHTML = `<div>경기 시간<b>${formatClock(durationMs)}</b></div><div>발사<b>${launches}회</b></div><div>내보낸 병사<b>${sent}</b></div><div>처치<b>${kills}</b></div>`;
    }
}

function formatClock(ms) {
    const SECONDS = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(SECONDS / 60)}:${String(SECONDS % 60).padStart(2, '0')}`;
}
