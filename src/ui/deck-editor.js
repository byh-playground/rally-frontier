import { ResourceDisplay } from './resource-display.js';

// Saved player loadouts are local preferences; the match owns its immutable copy.
const STORAGE_KEY = 'ssalkongpang.decks.v1';
const DECK_COUNT = 3;
const LOADOUT_VERSION = 2;

export class DeckEditor {
    static install({ types, heroes, starter, limit, nameOf, statsOf, portraitOf, infoOf }) {
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
        this.filter = 'hero';
        this.dialog = document.getElementById('deckDialog');
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
        const decks = Array.from({ length: DECK_COUNT }, (_, index) => {
            const deck = saved?.decks?.[index];
            if (!Array.isArray(deck)) return [...this.starter()];
            const legacyHero = saved?.heroTypes?.[index];
            const cards =
                saved.version === LOADOUT_VERSION
                    ? deck
                    : [heroes.includes(legacyHero) ? legacyHero : heroes[0], ...deck];
            const valid = [...new Set(cards.filter((type) => available.has(type)))].slice(
                0,
                this.limit,
            );
            return valid.length ? valid : [...this.starter()];
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

    static getDeck() {
        return [...this.state.decks[this.state.selected]];
    }
    static open() {
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
                this.persistAndRefresh();
                tabs.querySelector(`[data-deck-index="${index}"]`)?.focus();
            });
            tabs.append(button);
        }
        this.renderSlots(deck);
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

    static renderSlots(deck) {
        const selected = document.getElementById('deckSelected');
        selected.replaceChildren();
        for (let index = 0; index < this.limit; index++) {
            const type = deck[index];
            const slot = document.createElement(type ? 'button' : 'span');
            slot.className = 'deck-slot';
            if (type) {
                slot.type = 'button';
                slot.dataset.deckSlotCard = type;
                slot.toggleAttribute('data-hero', this.heroes().includes(type));
                slot.setAttribute(
                    'aria-label',
                    `${index + 1}번 칸 ${this.nameOf(type)} · 덱에서 제외`,
                );
                const name = document.createElement('span');
                name.textContent = this.nameOf(type);
                slot.append(this.makePortrait(type), name);
                slot.addEventListener('click', () => {
                    if (!this.toggleCard(type)) return;
                    const remaining = selected.querySelectorAll('button');
                    remaining[Math.min(index, remaining.length - 1)]?.focus();
                });
            } else {
                slot.classList.add('deck-slot-empty');
                slot.textContent = '빈 칸';
            }
            selected.append(slot);
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
            host.append(button);
        }
    }

    static toggleCard(type) {
        const deck = this.getDeck(),
            chosen = deck.includes(type),
            notice = document.getElementById('deckNotice');
        if (chosen && deck.length === 1) {
            notice.textContent = '카드를 한 장 이상 골라야 해요.';
            return false;
        }
        if (!chosen && deck.length >= this.limit) {
            notice.textContent = `덱은 최대 ${this.limit}칸이에요. 카드 한 장을 먼저 빼 주세요.`;
            return false;
        }
        this.state.decks[this.state.selected] = chosen
            ? deck.filter((card) => card !== type)
            : [...deck, type];
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
