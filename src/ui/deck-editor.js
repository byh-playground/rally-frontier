import { ResourceDisplay } from './resource-display.js';

// Saved player loadouts are local preferences; the match owns its immutable copy.
const STORAGE_KEY = 'ssalkongpang.decks.v1';
const DECK_COUNT = 3;

export class DeckEditor {
    static install({ types, heroes, nameOf, statsOf, portraitOf, infoOf, onChange = () => {} }) {
        if (this.initialized) return;
        this.initialized = true;
        this.types = types;
        this.heroes = heroes;
        this.nameOf = nameOf;
        this.statsOf = statsOf;
        this.portraitOf = portraitOf;
        this.infoOf = infoOf;
        this.onChange = onChange;
        this.dialog = document.getElementById('deckDialog');
        this.state = this.load();
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

    static available() {
        return [...this.types()];
    }

    static load() {
        const available = this.available();
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
            const value = saved?.decks?.[index];
            if (!Array.isArray(value)) return [...available];
            const filtered = available.filter((type) => value.includes(type));
            return filtered.length ? filtered : [...available];
        });
        const heroes = this.heroes();
        const heroTypes = Array.from({ length: DECK_COUNT }, (_, index) => {
            const type = saved?.heroTypes?.[index];
            return heroes.includes(type) ? type : heroes[0];
        });
        return { selected, decks, heroTypes };
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
    static getHeroType() {
        return this.state.heroTypes[this.state.selected];
    }

    static open() {
        this.refresh();
        if (!this.dialog.open) this.dialog.showModal();
    }

    static refresh() {
        const deck = this.getDeck(),
            tabs = document.getElementById('deckTabs'),
            selected = document.getElementById('deckSelected'),
            collection = document.getElementById('deckCollection');
        document.getElementById('deckSummary').textContent =
            `덱 ${this.state.selected + 1} · ${this.nameOf(this.getHeroType())} · ${deck.length}종`;
        document.getElementById('deckCount').textContent = `${deck.length}종 선택`;
        tabs.replaceChildren();
        selected.replaceChildren();
        collection.replaceChildren();
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
        for (const type of deck) {
            const item = document.createElement('span');
            item.textContent = this.nameOf(type);
            selected.append(item);
        }
        this.renderHeroes();
        for (const type of this.available()) {
            const chosen = deck.includes(type),
                button = document.createElement('button'),
                image = document.createElement('img'),
                name = document.createElement('b'),
                role = document.createElement('span'),
                detail = document.createElement('small'),
                feature = document.createElement('span'),
                check = document.createElement('span');
            button.type = 'button';
            button.className = 'deck-card';
            button.dataset.deckType = type;
            button.setAttribute('aria-pressed', String(chosen));
            image.alt = '';
            Promise.resolve(this.portraitOf(type)).then(
                (src) => (image.src = src),
                () => image.remove(),
            );
            name.textContent = this.nameOf(type);
            const stats = this.statsOf(type),
                info = this.infoOf(type);
            role.className = 'deck-card-role';
            role.textContent = info.role;
            detail.textContent = `${ResourceDisplay.costText(stats)} · ${stats.count}명`;
            feature.className = 'deck-card-feature';
            feature.textContent = info.feature;
            button.setAttribute(
                'aria-label',
                `${this.nameOf(type)}, ${info.role}, 비용 ${ResourceDisplay.costText(stats, true)}, ${stats.count}명, ${info.feature}, ${chosen ? '덱에서 제외' : '덱에 추가'}`,
            );
            check.className = 'deck-card-check';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = chosen ? '✓' : '+';
            button.append(image, name, role, detail, feature, check);
            button.addEventListener('click', () => {
                if (chosen && deck.length === 1) {
                    document.getElementById('deckNotice').textContent =
                        '병사는 한 종류 이상 선택해야 해요.';
                    return;
                }
                this.state.decks[this.state.selected] = chosen
                    ? deck.filter((item) => item !== type)
                    : this.available().filter((item) => item === type || deck.includes(item));
                this.persistAndRefresh();
                collection.querySelectorAll('.deck-card')[this.available().indexOf(type)]?.focus();
            });
            collection.append(button);
        }
        this.onChange(this.getDeck());
    }

    static renderHeroes() {
        const host = document.getElementById('deckHeroes');
        host.replaceChildren();
        for (const type of this.heroes()) {
            const button = document.createElement('button'),
                image = document.createElement('img'),
                name = document.createElement('b'),
                role = document.createElement('span');
            button.type = 'button';
            button.className = 'deck-card';
            button.dataset.deckHero = type;
            button.setAttribute('aria-pressed', String(type === this.getHeroType()));
            image.alt = '';
            Promise.resolve(this.portraitOf(type)).then(
                (src) => (image.src = src),
                () => image.remove(),
            );
            name.textContent = this.nameOf(type);
            role.className = 'deck-card-role';
            role.textContent = this.infoOf(type).role;
            button.append(image, name, role);
            button.addEventListener('click', () => {
                this.state.heroTypes[this.state.selected] = type;
                this.persistAndRefresh();
                host.querySelector(`[data-deck-hero="${type}"]`)?.focus();
            });
            host.append(button);
        }
    }

    static persistAndRefresh() {
        const saved = this.save();
        this.refresh();
        document.getElementById('deckNotice').textContent = saved
            ? '이 기기에 저장됐어요.'
            : '이 기기에 저장할 수 없어 이번에만 유지돼요.';
    }
}
