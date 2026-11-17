import { ResourceDisplay } from './resource-display.js';
import { updatePlayerSave } from './player-saves.js';

// Saved player loadouts are local preferences (the decks record of src/ui/player-saves.js);
// the match owns its immutable copy.
const DECK_COUNT = 3;

export class DeckEditor {
    static install({
        types,
        heroes,
        starter,
        limit,
        heroLimit,
        nameOf,
        statsOf,
        portraitOf,
        infoOf,
        renderDetails,
        isUnlocked,
        isTemporary = () => false,
        unlockHint,
        upgradeOf = () => null,
        openUpgrade = async () => false,
        sunshine = () => 0,
        store = null,
    }) {
        if (this.initialized) return;
        this.initialized = true;
        this.types = types;
        this.heroes = heroes;
        this.starter = starter;
        this.limit = limit;
        this.heroLimit = heroLimit;
        this.nameOf = nameOf;
        this.statsOf = statsOf;
        this.portraitOf = portraitOf;
        this.infoOf = infoOf;
        this.renderDetails = renderDetails;
        this.isUnlocked = isUnlocked;
        this.isTemporary = isTemporary;
        this.unlockHint = unlockHint;
        this.upgradeOf = upgradeOf;
        this.openUpgrade = openUpgrade;
        this.sunshine = sunshine;
        this.store = store;
        this.filter = 'grain';
        this.selectedSlot = null;
        this.dialog = document.getElementById('deckDialog');
        this.details = document.getElementById('deckCardDialog');
        this.detailsContent = document.getElementById('deckCardDetail');
        this.state = this.load();
        for (const button of this.dialog.querySelectorAll('[data-deck-filter]')) {
            button.addEventListener('click', () => {
                this.filter = button.dataset.deckFilter;
                this.renderCatalog();
            });
        }
        document.getElementById('deckEditBtn').addEventListener('click', () => this.open());
        document.getElementById('deckDoneBtn').addEventListener('click', () => this.dialog.close());
        document
            .getElementById('deckCloseBtn')
            .addEventListener('click', () => this.dialog.close());
        this.dialog.addEventListener('click', (event) => {
            if (event.target === this.dialog) this.dialog.close();
        });
        this.details.addEventListener('click', (event) => {
            if (event.target === this.details || event.target.closest('[data-sheet-close]'))
                this.details.close();
        });
        this.details.addEventListener('close', () => {
            if (this.details.open) return;
            this.closeDetails?.();
            this.closeDetails = null;
            if (this.dialog.open) this.detailTrigger?.focus();
            this.detailTrigger = null;
        });
        this.refresh();
    }

    static load() {
        const heroes = this.heroes(),
            available = new Set(
                [...heroes, ...this.types()].filter((type) => this.isUnlocked(type)),
            ),
            saved = this.store?.data;
        const selected = Number.isInteger(saved?.selected)
            ? Math.max(0, Math.min(DECK_COUNT - 1, saved.selected))
            : 0;
        const starter = this.starter().filter((type) => available.has(type));
        const starterSlots = () =>
            Array.from({ length: this.limit }, (_, index) => starter[index] ?? null);
        const decks = Array.from({ length: DECK_COUNT }, (_, index) => {
            const deck = saved?.decks?.[index];
            if (!Array.isArray(deck)) return starterSlots();
            const seen = new Set();
            let heroCount = 0;
            const slots = Array.from({ length: this.limit }, (_, slot) => {
                const type = deck[slot];
                if (!available.has(type) || seen.has(type)) return null;
                if (heroes.includes(type)) {
                    if (heroCount >= this.heroLimit) return null;
                    heroCount++;
                }
                seen.add(type);
                return type;
            });
            return seen.size ? slots : starterSlots();
        });
        return { selected, decks };
    }

    // Resolves true once the loadouts are in the device save, false when they can only last for this page.
    static async save() {
        const store = this.store;
        if (!store || store.locked) return false;
        const { selected, decks } = structuredClone(this.state);
        try {
            await updatePlayerSave(store, (draft) => {
                draft.selected = selected;
                draft.decks = decks;
            });
            return true;
        } catch (error) {
            console.warn('덱 저장 실패', error);
            return false;
        }
    }

    static getSlots() {
        return this.state.decks[this.state.selected];
    }

    static getDeck() {
        return this.getSlots().filter((type) => type !== null);
    }

    static open(type) {
        this.selectedSlot = null;
        if (type) this.filter = this.heroes().includes(type) ? 'hero' : 'grain';
        this.refresh();
        if (!this.dialog.open) this.dialog.showModal();
        if (type) this.dialog.querySelector(`[data-deck-type="${CSS.escape(type)}"]`)?.focus();
    }

    static refresh() {
        const deck = this.getDeck(),
            tabs = document.getElementById('deckTabs');
        document.getElementById('deckSummary').textContent =
            `덱 ${this.state.selected + 1} · ${deck.length}/${this.limit}칸`;
        this.paintSunshine();
        document.getElementById('deckCount').textContent = `${deck.length} / ${this.limit}칸`;
        tabs.replaceChildren();
        for (let index = 0; index < DECK_COUNT; index++) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = `덱 ${index + 1}`;
            button.dataset.deckIndex = String(index);
            button.setAttribute('aria-pressed', String(index === this.state.selected));
            button.addEventListener('click', () => {
                this.state.selected = index;
                this.selectedSlot = null;
                this.persistAndRefresh();
                tabs.querySelector(`[data-deck-index="${index}"]`)?.focus();
            });
            tabs.append(button);
        }
        this.renderSlots();
        this.renderCatalog(deck);
    }

    static makePortrait(type) {
        const image = document.createElement('img');
        image.alt = '';
        Promise.resolve(this.portraitOf(type)).then(
            (src) => (image.src = src),
            () => image.remove(),
        );
        return image;
    }

    static infoButton(type) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'launch-card-info deck-card-info';
        button.dataset.deckCardInfo = type;
        button.setAttribute('aria-label', `${this.nameOf(type)} 상세`);
        button.setAttribute('aria-haspopup', 'dialog');
        button.textContent = 'i';
        button.addEventListener('click', () => {
            this.detailTrigger = button;
            this.details.setAttribute('aria-label', `${this.nameOf(type)} 상세`);
            this.closeDetails = this.renderDetails(type, this.detailsContent);
            this.renderUpgrade(type);
            this.details.showModal();
            this.detailsContent.querySelector('[data-sheet-close]')?.focus();
        });
        return button;
    }

    // The card's campaign-only upgrade, drawn above the close button of its detail sheet. A card whose definition has
    // no upgrade gets no section; an open one shows its state, an unopened one the price button (disabled while the
    // sunshine falls short). A failed save leaves the section as it was.
    static renderUpgrade(type) {
        const upgrade = this.upgradeOf(type);
        if (!upgrade) return;
        const section = document.createElement('section');
        section.className = 'deck-upgrade';
        const draw = () => {
            const missing = upgrade.price - this.sunshine(),
                open = upgrade.open(),
                state = document.createElement(open ? 'p' : 'button'),
                title = document.createElement('div'),
                name = document.createElement('b'),
                tag = document.createElement('small'),
                summary = document.createElement('span');
            name.textContent = upgrade.name;
            tag.textContent = '캠페인 강화';
            summary.textContent = upgrade.summary;
            title.append(name, tag, summary);
            if (open) {
                state.className = 'deck-upgrade-state';
                state.textContent = '캠페인에서 적용 중';
            } else {
                state.type = 'button';
                state.className = 'launch-btn primary deck-upgrade-open';
                state.disabled = missing > 0;
                state.textContent =
                    missing > 0
                        ? `햇살 ${upgrade.price} · ${missing} 모자라요`
                        : `햇살 ${upgrade.price} · 강화 열기`;
                state.addEventListener('click', async () => {
                    state.disabled = true;
                    if (await this.openUpgrade(type)) this.paintSunshine();
                    draw();
                });
            }
            section.replaceChildren(title, state);
        };
        draw();
        this.detailsContent.querySelector('[data-sheet-close]')?.before(section);
    }

    static paintSunshine() {
        document.getElementById('deckSunshine').textContent = `☀ ${this.sunshine()}`;
    }

    static renderSlots() {
        const selected = document.getElementById('deckSelected');
        selected.replaceChildren();
        for (const [index, type] of this.getSlots().entries()) {
            const tile = document.createElement('div');
            tile.className = 'deck-tile';
            const slot = document.createElement('button');
            slot.type = 'button';
            slot.className = 'deck-slot';
            slot.dataset.deckSlotIndex = String(index);
            tile.append(slot);
            if (type) {
                slot.dataset.deckSlotCard = type;
                slot.toggleAttribute('data-hero', this.heroes().includes(type));
                slot.setAttribute(
                    'aria-label',
                    `${index + 1}번 칸 ${this.nameOf(type)} · 덱에서 제외`,
                );
                const name = document.createElement('span');
                name.textContent = this.nameOf(type);
                slot.append(this.makePortrait(type), name);
                tile.append(this.infoButton(type));
            } else {
                slot.classList.add('deck-slot-empty');
                slot.textContent = '빈 칸';
                slot.setAttribute('aria-label', `${index + 1}번 빈 칸 선택`);
                slot.setAttribute('aria-pressed', String(this.selectedSlot === index));
            }
            slot.addEventListener('click', () => {
                if (type) {
                    if (!this.toggleCard(type)) return;
                } else {
                    this.selectedSlot = index;
                    this.renderSlots();
                    document.getElementById('deckNotice').textContent =
                        `${index + 1}번 칸에 넣을 카드를 골라 주세요.`;
                }
                selected.querySelector(`[data-deck-slot-index="${index}"]`)?.focus();
            });
            selected.append(tile);
        }
    }

    static renderCatalog(deck = this.getDeck()) {
        for (const button of this.dialog.querySelectorAll('[data-deck-filter]'))
            button.setAttribute('aria-pressed', String(button.dataset.deckFilter === this.filter));
        const heroCatalog = this.filter === 'hero',
            heroes = document.getElementById('deckHeroes'),
            grains = document.getElementById('deckCollection'),
            host = heroCatalog ? heroes : grains;
        heroes.hidden = !heroCatalog;
        grains.hidden = heroCatalog;
        host.replaceChildren();
        for (const type of heroCatalog ? this.heroes() : this.types()) {
            const chosen = deck.includes(type),
                locked = !this.isUnlocked(type),
                button = document.createElement('button'),
                name = document.createElement('b'),
                detail = document.createElement('small'),
                check = document.createElement('span');
            button.type = 'button';
            button.disabled = locked;
            button.className = 'deck-card';
            button.dataset.deckType = type;
            if (heroCatalog) button.dataset.deckHero = type;
            button.setAttribute('aria-pressed', String(chosen));
            const blockReason = !locked && !chosen ? this.additionBlock(type, deck) : '';
            button.toggleAttribute('data-capacity-blocked', !!blockReason);
            name.textContent = this.nameOf(type);
            const stats = this.statsOf(type),
                info = this.infoOf(type);
            if (locked) {
                const hint = this.unlockHint(type);
                detail.textContent = hint;
                button.title = hint;
                button.setAttribute('aria-label', `${this.nameOf(type)} 잠김 · ${hint}`);
            } else {
                detail.innerHTML = heroCatalog ? '영웅' : ResourceDisplay.costMarkup(stats);
                button.title = blockReason || `${info.role} · ${info.feature}`;
                button.setAttribute(
                    'aria-label',
                    `${this.nameOf(type)}, ${info.role}, 비용 ${ResourceDisplay.costText(stats, true)}, ${stats.count}명, ${info.feature}, ${chosen ? '덱에서 제외' : blockReason || '덱에 추가'}`,
                );
            }
            check.className = 'deck-card-check';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = locked ? '잠김' : chosen ? '✓' : '+';
            button.append(this.makePortrait(type), name, detail, check);
            button.addEventListener('click', () => {
                if (this.toggleCard(type))
                    host.querySelector(`[data-deck-type="${type}"]`)?.focus();
            });
            const tile = document.createElement('div');
            tile.className = 'deck-tile';
            tile.append(button, this.infoButton(type));
            host.append(tile);
        }
    }

    static additionBlock(type, deck) {
        const heroes = this.heroes();
        if (
            heroes.includes(type) &&
            deck.filter((card) => heroes.includes(card)).length >= this.heroLimit
        )
            return `영웅은 최대 ${this.heroLimit}명이에요. 장착한 영웅을 먼저 빼 주세요.`;
        if (deck.length >= this.limit)
            return `덱은 최대 ${this.limit}칸이에요. 카드 한 장을 먼저 빼 주세요.`;
        return '';
    }

    static toggleCard(type) {
        const notice = document.getElementById('deckNotice');
        if (!this.isUnlocked(type)) {
            notice.textContent = this.unlockHint(type);
            return false;
        }
        const slots = this.getSlots().slice(),
            index = slots.indexOf(type);
        if (index >= 0) {
            if (this.getDeck().length === 1) {
                notice.textContent = '카드를 한 장 이상 골라야 해요.';
                return false;
            }
            slots[index] = null;
            this.selectedSlot = index;
        } else {
            const blockReason = this.additionBlock(type, this.getDeck());
            if (blockReason) {
                notice.textContent = blockReason;
                return false;
            }
            const empty =
                slots[this.selectedSlot] === null ? this.selectedSlot : slots.indexOf(null);
            slots[empty] = type;
            this.selectedSlot = null;
        }
        this.state.decks[this.state.selected] = slots;
        this.persistAndRefresh();
        return true;
    }

    static persistAndRefresh() {
        const notice = document.getElementById('deckNotice');
        this.refresh();
        if (this.isTemporary()) {
            notice.textContent = '디버그 덱은 이번 접속에서만 유지돼요.';
            return;
        }
        const pending = (this.pendingSave = this.save());
        void pending.then((saved) => {
            if (pending !== this.pendingSave) return;
            notice.textContent = saved
                ? '이 기기에 저장됐어요.'
                : '이 기기에 저장할 수 없어 이번에만 유지돼요.';
        });
    }
}
