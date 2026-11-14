import { ResourceDisplay } from './resource-display.js';
import { CAMPAIGN_GROUPS, CAMPAIGN_STAGES, CAMPAIGN_TIERS } from '../definitions/campaign.js';
import { CampaignPresentation } from './campaign-presentation.js';
import { unitCardStats } from './unit-card-stats.js';
import './grain-portrait.js';
import { UNITS, unitCard } from '../units/index.js';

// Launch match screens (title, friend, help, in-game HUD and cards, match menu, result) and their addresses.
// Routes: #/ title, #/friend, #/help, #/play, #/play/menu, #/play/help, #/play/<grain> card detail, #/result.
// The game owns matches; this module owns which screen and sheet the address shows, and asks the game through `actions`.
const SCREENS = new Set(['', 'friend', 'help', 'play', 'result']);

export class LaunchScreens {
    static grainInfo(type) {
        return unitCard(type)?.card || { role: '병사', feature: '', land: '', fire: '', notes: [] };
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
        const MENU = SCREEN === 'play' && ITEM === 'menu';
        if (MENU) {
            A.openMenu();
        } else {
            A.closeMenu();
        }
        this.$('matchMenuSoundBtn').textContent = A.soundOn() ? '소리 끄기' : '소리 켜기';
        if (SCREEN === 'friend') this.syncFriendDeckChoice();
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
    static syncFriendDeckChoice() {
        const size = this.actions.ownDeckSize(),
            own = this.$('friendDeckOwn');
        own.disabled = size === 0;
        this.$('friendDeckOwnLabel').textContent = size
            ? `본인 덱 · ${size}장`
            : '본인 덱 · 비어 있음';
        if (own.disabled) this.$('friendDeckRandom').checked = true;
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
            this.campaignOpen = this.initialCampaignOpen();
            this.renderCampaignList();
            campaignDialog.showModal();
        };
        $('campaignCloseBtn').onclick = () => campaignDialog.close();
        $('friendMatchBtn').onclick = () => this.go('friend');
        $('titleHelpBtn').onclick = () => this.go('help');
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
    // Depth list: tiers (depth 0) fold open to their stages (depth 1); a stage group (`CAMPAIGN_GROUPS`, depth 1)
    // folds open to its stages (depth 2). Only one tier and one group are open at a time, so the whole list fits
    // without scrolling.
    static initialCampaignOpen() {
        const progress = this.actions.campaignProgress;
        const next = progress.nextStage;
        if (next) return { tier: next.tier, group: next.group ?? null };
        const opened = CAMPAIGN_TIERS.filter((tier) => progress.isTierOpen(tier.id));
        return { tier: opened.at(-1)?.id ?? null, group: null };
    }
    static renderCampaignList(focusKey) {
        const list = this.$('campaignStages');
        list.replaceChildren(...CAMPAIGN_TIERS.map((tier) => this.campaignTierSection(tier)));
        if (focusKey) list.querySelector(`[data-key="${focusKey}"]`)?.focus();
    }
    static campaignTierSection(tier) {
        const progress = this.actions.campaignProgress;
        const open = progress.isTierOpen(tier.id);
        const expanded = this.campaignOpen.tier === tier.id;
        const stages = CAMPAIGN_STAGES.filter((stage) => stage.tier === tier.id);
        const section = document.createElement('section');
        section.className = `campaign-tier${open ? '' : ' is-locked'}`;
        const done = stages.filter((stage) => progress.isComplete(stage)).length;
        const row = this.campaignRow({
            depth: 0,
            key: `tier-${tier.id}`,
            title: tier.title,
            expanded,
            meta: open ? `${done}/${stages.length}` : '🔒 앞 단계에서 하나만 깨면 열려요',
        });
        row.classList.add('is-tier');
        row.onclick = () => {
            this.campaignOpen = { ...this.campaignOpen, tier: expanded ? null : tier.id };
            this.renderCampaignList(`tier-${tier.id}`);
        };
        section.append(row);
        if (!expanded) return section;
        for (const stage of stages.filter((stage) => !stage.group))
            section.append(this.campaignStageRow(stage, 1));
        for (const group of CAMPAIGN_GROUPS) {
            const members = stages.filter((stage) => stage.group === group.id);
            if (!members.length) continue;
            const key = `group-${tier.id}-${group.id}`,
                groupOpen = this.campaignOpen.group === group.id;
            const groupRow = this.campaignRow({
                depth: 1,
                key,
                title: group.title,
                expanded: groupOpen,
                art: group.art,
                meta: `${members.filter((stage) => progress.isComplete(stage)).length}/${members.length}`,
            });
            groupRow.classList.add('is-tier');
            groupRow.onclick = () => {
                this.campaignOpen = { ...this.campaignOpen, group: groupOpen ? null : group.id };
                this.renderCampaignList(key);
            };
            section.append(groupRow);
            if (groupOpen)
                for (const stage of members) section.append(this.campaignStageRow(stage, 2));
        }
        return section;
    }
    // One list row. `expanded` is undefined for leaves; folding rows show an arrow and report aria-expanded.
    static campaignRow({ depth, key, title, expanded, art, mark, meta }) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'campaign-row';
        row.dataset.key = key;
        row.style.setProperty('--depth', depth);
        const lead = document.createElement('span');
        lead.className = 'campaign-row-lead';
        lead.setAttribute('aria-hidden', 'true');
        if (expanded !== undefined) {
            lead.textContent = expanded ? '▾' : '▸';
            row.setAttribute('aria-expanded', String(expanded));
        }
        row.append(lead);
        if (art || mark) {
            const image = document.createElement('span');
            image.className = 'campaign-row-art';
            if (mark) image.textContent = mark;
            else {
                const img = document.createElement('img');
                img.alt = '';
                this.actions.portraitSource(art).then((src) => {
                    img.src = src;
                });
                image.append(img);
            }
            row.append(image);
        }
        const name = document.createElement('span');
        name.className = 'campaign-row-title';
        name.textContent = title;
        row.append(name);
        if (meta) {
            const note = document.createElement('span');
            note.className = 'campaign-row-meta';
            note.textContent = meta;
            row.append(note);
        }
        return row;
    }
    static campaignStageRow(stage, depth) {
        const progress = this.actions.campaignProgress;
        const locked = !progress.canStart(stage);
        const done = progress.isComplete(stage);
        const reward = stage.rewardCard ? `보상 ${this.actions.grainName(stage.rewardCard)}` : '';
        const row = this.campaignRow({
            depth,
            key: `stage-${stage.id}`,
            // Under a group row the shared "영웅 …"·"코코넛 …" prefix is redundant and would crowd the row on a phone.
            title: stage.group ? stage.title.split(' · ').pop() : stage.title,
            art: stage.nodeMark ? null : (stage.rewardCard ?? stage.deck[0]),
            mark: stage.nodeMark,
            meta: done ? '완료' : reward,
        });
        row.classList.add('is-stage');
        if (locked) row.classList.add('is-locked');
        if (done) {
            row.classList.add('is-done');
            row.querySelector('.campaign-row-lead').textContent = '✓';
        }
        row.disabled = locked;
        row.setAttribute(
            'aria-label',
            `${stage.title}, ${locked ? '잠김' : done ? '완료' : '도전 가능'}`,
        );
        row.onclick = () => this.showCampaignBriefing(stage);
        return row;
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
