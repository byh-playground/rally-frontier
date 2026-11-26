import { ResourceDisplay } from './resource-display.js';
import { CAMPAIGN_DIFFICULTIES } from '../definitions/campaign-pace.js';
import { SUNSHINE } from '../definitions/roster.js';
import { CampaignActs } from './campaign-acts.js';
import { CampaignPresentation } from './campaign-presentation.js';
import { CampaignScreen, storyMarkup } from './campaign-screen.js';
import { unitCardStats } from './unit-card-stats.js';
import './grain-portrait.js';
import { UNITS, unitCard } from '../units/index.js';

// The result line's name of each sunshine item (definitions/roster.js SUNSHINE).
const SUNSHINE_LABELS = Object.freeze({
    firstClear: '처음 클리어',
    sideGoal: '보조 목표',
    hardFirstClear: '어려움',
});

// Launch match screens (title, friend, help, in-game HUD and cards, match menu, result) and their addresses.
// Routes: #/ title, #/settings, #/friend, #/help, #/play, #/play/menu, #/play/help, #/play/<grain> card detail, #/result, and
// and the campaign: #/campaign, #/campaign/<chapter>?stage=<id> (CampaignScreen).
// The game owns matches; this module owns which screen and sheet the address shows, and asks the game through `actions`.
const SCREENS = new Set(['', 'settings', 'friend', 'help', 'play', 'result']);
// Holding the settings button this long opens the debug mode, which is its own address (`?debug=1`).
const DEBUG_HOLD_MS = 800;

export class LaunchScreens {
    static grainInfo(type) {
        return unitCard(type)?.card || { role: '병사', feature: '', land: '', fire: '', notes: [] };
    }
    // actions: { onScreen(screen), inMatch(), hasResult(), startAiMatch(), openMenu(), closeMenu(), grains(), grainName(type), grainStats(type),
    //           portraitSource(type), toggleSound(), soundOn(), createRoom(), joinRoom(code), leaveToTitle() }
    static install({ createNavigation, showcaseSurface, actions }) {
        this.actions = actions;
        this.showcaseSurface = showcaseSurface;
        this.$ = (id) => document.getElementById(id);
        CampaignPresentation.install(this.$);
        this.navigation = createNavigation({
            normalize: (route) =>
                SCREENS.has(route.screen) || route.screen === 'campaign'
                    ? route
                    : { screen: '', item: '', query: '' },
        });
        CampaignScreen.install({
            actions,
            nav: {
                title: () => this.go(''),
                home: () => this.go('campaign'),
                // Picking another stage of the same chapter replaces the address; a new chapter is a step.
                chapter: (id, stageId) => {
                    const route = {
                        screen: 'campaign',
                        item: id,
                        query: stageId ? `stage=${encodeURIComponent(stageId)}` : '',
                    };
                    if (this.navigation.snapshot().item === id) this.navigation.replace(route);
                    else this.navigation.navigate(route);
                },
            },
            difficulty: (host) => this.renderCampaignDifficulty(host),
        });
        this.renderUnitHelp();
        this.bindButtons();
        this.installTitleBattle();
        this.navigation.subscribe((route) => this.apply(route), { immediate: true });
    }
    // Unit-specific help lives with each unit (src/units/<id>/index.js `help`); the page holds only the slots.
    static renderUnitHelp() {
        const guide = document.querySelector('#launchHelpSheet .help-guide');
        const names = UNITS.filter((card) => card.hero).map((card) => card.unit.name);
        for (const slot of guide.querySelectorAll('[data-unit-hero-names]'))
            slot.replaceWith(names.join(', '));
        for (const slot of guide.querySelectorAll('[data-unit-help]')) {
            const entries = UNITS.flatMap((card) =>
                card.help.filter((entry) => entry.section === slot.dataset.unitHelp),
            );
            slot.replaceWith(
                ...entries.map(({ summary, paragraphs }) => {
                    const details = document.createElement('details'),
                        title = document.createElement('summary');
                    title.textContent = summary;
                    details.append(title);
                    for (const text of paragraphs) {
                        const p = document.createElement('p');
                        p.textContent = text;
                        details.append(p);
                    }
                    return details;
                }),
            );
        }
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
        // The one screen-entry point for metrics: after the redirects above, on the address that stays.
        A.onScreen(SCREEN);
        const MENU = SCREEN === 'play' && ITEM === 'menu';
        if (MENU) {
            A.openMenu();
        } else {
            A.closeMenu();
        }
        this.$('matchMenuSoundBtn').textContent = A.soundOn() ? '소리 끄기' : '소리 켜기';
        const CAMPAIGN = SCREEN === 'campaign';
        if (CAMPAIGN && !CampaignScreen.render(ITEM, route.query)) {
            this.replace('campaign');
            return;
        }
        CampaignScreen.show(CAMPAIGN);
        if (SCREEN === 'friend') this.syncFriendDeckChoice();
        this.showSheet('friendSheet', SCREEN === 'friend');
        this.showSheet('settingsSheet', SCREEN === 'settings');
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
    static syncFriendDeckChoice() {
        const size = this.actions.ownDeckSize(),
            own = this.$('friendDeckOwn');
        own.disabled = size === 0;
        this.$('friendDeckOwnLabel').textContent = size
            ? `본인 덱 · ${size}장`
            : '본인 덱 · 비어 있음';
        if (own.disabled) this.$('friendDeckRandom').checked = true;
    }
    // A tap opens the settings; a long press goes to the debug mode's address.
    static bindSettingsButton(button) {
        let timer = 0,
            held = false;
        const release = () => clearTimeout(timer);
        button.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            held = false;
            release();
            timer = setTimeout(() => {
                held = true;
                location.assign(`${location.pathname}?debug=1`);
            }, DEBUG_HOLD_MS);
        });
        for (const type of ['pointerup', 'pointercancel', 'pointerleave'])
            button.addEventListener(type, release);
        button.addEventListener('contextmenu', (event) => event.preventDefault());
        button.onclick = () => {
            if (!held) this.go('settings');
        };
    }
    static friendDeckMode() {
        return this.$('friendDeckRandom').checked ? 'random' : 'own';
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
        $('campaignBtn').onclick = () => this.go('campaign');
        $('friendMatchBtn').onclick = () => this.go('friend');
        this.bindSettingsButton($('titleSettingsBtn'));
        $('settingsHelpBtn').onclick = () => this.go('help');
        $('friendCreateBtn').onclick = () => {
            const deckMode = this.friendDeckMode();
            this.replace('');
            A.createRoom(deckMode);
        };
        $('friendJoinBtn').onclick = () => {
            const CODE = $('friendCodeInput').value.replace(/\D/g, '').slice(0, 4);
            if (CODE.length !== 4) {
                $('friendCodeInput').focus();
                return;
            }
            const deckMode = this.friendDeckMode();
            this.replace('');
            A.joinRoom(CODE, deckMode);
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
        for (const id of ['friendSheet', 'settingsSheet', 'launchHelpSheet', 'cardSheet']) {
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
        // The next stage opens on its chapter's screen.
        $('resultNextCampaignBtn').onclick = () =>
            A.openCampaignStage(
                CampaignActs.chapterOf(this.resultNextStage).id,
                this.resultNextStage.id,
            );
    }
    // The difficulty toggle (above the list, or on the new campaign's briefing): one of three, remembered in the
    // roster save.
    static renderCampaignDifficulty(host) {
        const picked = this.actions.difficulty();
        host.replaceChildren(
            ...CAMPAIGN_DIFFICULTIES.map(({ id, title }) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'campaign-difficulty-option';
                button.textContent = title;
                button.dataset.difficulty = id;
                button.setAttribute('aria-pressed', String(id === picked));
                button.onclick = async () => {
                    if (id !== this.actions.difficulty()) await this.actions.setDifficulty(id);
                    this.renderCampaignDifficulty(host);
                    host.querySelector(`[data-difficulty="${id}"]`)?.focus();
                };
                return button;
            }),
        );
    }
    // `stage` is the won campaign stage (null outside the campaign or on a loss): a new-campaign stage shows its story.
    static renderCampaignResult(reward, nextStage, stage = null) {
        const $ = this.$;
        const story = $('resultCampaignStory');
        story.hidden = !stage?.story;
        story.innerHTML = stage?.story ? storyMarkup(stage, { result: true }) : '';
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
    // The sunshine a new-campaign result paid (Roster.recordClear: { sunshine, paid }), one line on the result screen;
    // nothing paid (a replay of a cleared stage, or no result yet) hides it.
    static renderCampaignSunshine(result) {
        const line = this.$('resultSunshine');
        line.hidden = !result?.sunshine;
        if (line.hidden) return;
        line.textContent = `☀ +${result.sunshine} · ${result.paid
            .map((key) => `${SUNSHINE_LABELS[key]} ${SUNSHINE[key]}`)
            .join(' · ')}`;
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
                !document.body.classList.contains('boot-loading') &&
                lobbyVisible &&
                !MOTION.matches;
            if (active && !this.titleBattleMount && !this.titleBattleFailed)
                void this.prepareTitleBattle();
            this.titleBattleMount?.setActive(active);
            this.cardDetail?.syncPlayback?.();
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
    // Card buttons with face portraits and, on an ammo card, its round dots and recharge bar (CardAmmo); the game
    // keeps their selected/unaffordable/ammo-empty classes, spent dots and bar fill.
    static cardMarkup(type, hero) {
        const A = this.actions,
            STATS = A.grainStats(type),
            AMMO = STATS.ammo
                ? `<span class="launch-card-ammo" aria-hidden="true"><span class="launch-card-rounds">${'<i></i>'.repeat(STATS.ammo.max)}</span><span class="launch-card-charge"></span></span>`
                : '';
        return `<div class="launch-card-slot"><button type="button" class="launch-card" data-launch-card="${type}">${AMMO}<img class="launch-card-portrait" data-portrait="${type}" alt=""><b>${A.grainName(type)}${hero ? '' : ` ×${STATS.count}`}</b><em>${ResourceDisplay.costMarkup(STATS)}</em></button><button type="button" class="launch-card-info" data-card-info="${type}" aria-label="${A.grainName(type)} 상세">i</button></div>`;
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
            stats = unitCardStats(type, A.grainRangeLevel(), copy, A.heroLevel(type)),
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
        return unitCard(type)?.card.land || '';
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
    // The spore clouds coming from off screen: one badge each on the screen edge, pointing at its place, with the
    // seconds left; a tap moves the camera there. `alerts` = [{ id, left, top, angle, seconds, focus }] in page px
    // of the battlefield box (left/top), or [] when no cloud is under warning off screen.
    static renderCloudAlerts(alerts) {
        const host = this.$('cloudAlerts');
        const wanted = new Set(alerts.map((alert) => String(alert.id)));
        for (const badge of [...host.children])
            if (!wanted.has(badge.dataset.cloud)) badge.remove();
        for (const alert of alerts) {
            let badge = host.querySelector(`[data-cloud="${alert.id}"]`);
            if (!badge) {
                badge = document.createElement('button');
                badge.type = 'button';
                badge.className = 'cloud-alert';
                badge.dataset.cloud = String(alert.id);
                badge.innerHTML = '<i aria-hidden="true"></i><b></b>';
                host.append(badge);
            }
            badge.onclick = alert.focus;
            badge.style.left = `${alert.left}px`;
            badge.style.top = `${alert.top}px`;
            badge.querySelector('i').style.transform = `rotate(${alert.angle}rad)`;
            const text = String(alert.seconds);
            if (badge.querySelector('b').textContent !== text)
                badge.querySelector('b').textContent = text;
            badge.setAttribute(
                'aria-label',
                `포자 구름 ${alert.seconds}초 뒤 도착, 누르면 그 자리로 이동`,
            );
        }
    }
    // Label over the landing ring while aiming; at is the ring centre in page pixels, or null when not aiming.
    static renderAimLabel(
        at,
        type,
        maxReach,
        cannonCount,
        passengerCount,
        { showVolleyHint = false } = {},
    ) {
        const LABEL = this.$('aimLabel');
        LABEL.classList.toggle('hidden', !at);
        if (!at) {
            return;
        }
        const SHARED = cannonCount > 1,
            NAME = this.actions.grainName(type),
            STATS = this.actions.grainStats(type),
            BONUS = passengerCount - STATS.count,
            TEXT = SHARED
                ? `${NAME} ${passengerCount}기${BONUS > 0 ? ` (+${BONUS})` : ''} · 대포 ${cannonCount}문`
                : `${NAME} ×${passengerCount} · ${unitCard(type)?.card.fire || this.landingLabel(type)} · 최대 발사 ${maxReach.toLocaleString('ko-KR')}`,
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
