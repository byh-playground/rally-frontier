import { ResourceDisplay } from './resource-display.js';

// Saved player loadouts are local preferences; the match owns its immutable copy.
const STORAGE_KEY = 'ssalkongpang.decks.v1';
const DECK_COUNT = 3;
const LOADOUT_VERSION = 3;

export class DeckEditor {
    static install({
        types,
        heroes,
        starter,
        limit,
        nameOf,
        statsOf,
        portraitOf,
        infoOf,
        renderDetails,
    }) {
        if (this.initialized) return;
        this.initialized = true;
        this.types = types;
        this.heroes = heroes;
        this.starter = starter;
        this.limit = limit;
        this.nameOf = nameOf;
        this.statsOf = statsOf;
        this.portraitOf = portraitOf;
        this.infoOf = infoOf;
        this.renderDetails = renderDetails;
        this.filter = 'hero';
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
            available = new Set([...heroes, ...this.types()]);
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        } catch {
            // A missing, damaged or inaccessible preference uses the full starter deck.
        }
        const selected = Number.isInteger(saved?.selected)
            ? Math.max(0, Math.min(DECK_COUNT - 1, saved.selected))
            : 0;
        const starter = this.starter();
        const starterSlots = () =>
            Array.from({ length: this.limit }, (_, index) => starter[index] ?? null);
        const decks = Array.from({ length: DECK_COUNT }, (_, index) => {
            const deck = saved?.decks?.[index];
            if (!Array.isArray(deck)) return starterSlots();
            const legacyHero = saved?.heroTypes?.[index];
            const cards =
                saved.version === LOADOUT_VERSION || saved.version === 2
                    ? deck
                    : [heroes.includes(legacyHero) ? legacyHero : heroes[0], ...deck];
            // Older loadouts were dense. Migrate in order; new loadouts preserve slot indices.
            const entries =
                saved.version === LOADOUT_VERSION
                    ? cards
                    : [...new Set(cards.filter((type) => available.has(type)))];
            const seen = new Set();
            const slots = Array.from({ length: this.limit }, (_, slot) => {
                const type = entries[slot];
                if (!available.has(type) || seen.has(type)) return null;
                seen.add(type);
                return type;
            });
            return seen.size ? slots : starterSlots();
        });
        return { version: LOADOUT_VERSION, selected, decks };
    }

    static save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
            return true;
        } catch {
            return false;
        }
    }

    static getSlots() {
        return this.state.decks[this.state.selected];
    }

    static getDeck() {
        return this.getSlots().filter((type) => type !== null);
    }

    static open() {
        this.selectedSlot = null;
        this.refresh();
        if (!this.dialog.open) this.dialog.showModal();
    }

    static refresh() {
        const deck = this.getDeck(),
            tabs = document.getElementById('deckTabs');
        document.getElementById('deckSummary').textContent =
            `덱 ${this.state.selected + 1} · ${deck.length}/${this.limit}칸`;
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
            this.details.showModal();
            this.detailsContent.querySelector('[data-sheet-close]')?.focus();
        });
        return button;
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
                button = document.createElement('button'),
                name = document.createElement('b'),
                detail = document.createElement('small'),
                check = document.createElement('span');
            button.type = 'button';
            button.className = 'deck-card';
            button.dataset.deckType = type;
            if (heroCatalog) button.dataset.deckHero = type;
            button.setAttribute('aria-pressed', String(chosen));
            const full = !chosen && deck.length >= this.limit;
            button.toggleAttribute('data-capacity-blocked', full);
            name.textContent = this.nameOf(type);
            const stats = this.statsOf(type),
                info = this.infoOf(type);
            detail.innerHTML = heroCatalog ? '영웅' : ResourceDisplay.costMarkup(stats);
            button.title = `${info.role} · ${info.feature}`;
            button.setAttribute(
                'aria-label',
                `${this.nameOf(type)}, ${info.role}, 비용 ${ResourceDisplay.costText(stats, true)}, ${stats.count}명, ${info.feature}, ${chosen ? '덱에서 제외' : full ? '덱이 가득 찼어요' : '덱에 추가'}`,
            );
            check.className = 'deck-card-check';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = chosen ? '✓' : '+';
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

    static toggleCard(type) {
        const slots = this.getSlots().slice(),
            index = slots.indexOf(type),
            notice = document.getElementById('deckNotice');
        if (index >= 0) {
            if (this.getDeck().length === 1) {
                notice.textContent = '카드를 한 장 이상 골라야 해요.';
                return false;
            }
            slots[index] = null;
            this.selectedSlot = index;
        } else {
            const empty =
                slots[this.selectedSlot] === null ? this.selectedSlot : slots.indexOf(null);
            if (empty < 0) {
                notice.textContent = `덱은 최대 ${this.limit}칸이에요. 카드 한 장을 먼저 빼 주세요.`;
                return false;
            }
            slots[empty] = type;
            this.selectedSlot = null;
        }
        this.state.decks[this.state.selected] = slots;
        this.persistAndRefresh();
        return true;
    }

    static persistAndRefresh() {
        const saved = this.save();
        this.refresh();
        document.getElementById('deckNotice').textContent = saved
            ? '이 기기에 저장됐어요.'
            : '이 기기에 저장할 수 없어 이번에만 유지돼요.';
    }
}
