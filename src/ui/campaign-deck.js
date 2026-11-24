import {
    CAMPAIGN_DECK_HERO_LIMIT,
    CAMPAIGN_DECK_LIMIT,
    campaignDeckPool,
    campaignDeckRequired,
    resolveCampaignDeck,
} from '../definitions/campaign-deck.js';
import { SUNSHINE } from '../definitions/roster.js';
import { ResourceDisplay } from './resource-display.js';

// The campaign's own deck editor: the cards the player brings to one stage, and the sunshine-bought upgrades of those
// cards. It is a separate sheet from the versus deck editor (deck-editor.js), so nothing of the campaign shows on a
// screen the versus match also uses, and its picks are saved per stage in the roster record, not in the versus decks.
export class CampaignDeck {
    // roster: the Roster; owns(type): whether the card is usable now (the debug unlock owns everything);
    // temporary(): the debug unlock, whose picks and upgrades are not saved; heroTypes: the hero card ids;
    // nameOf, statsOf, portraitOf: how a card is told; upgradeOf(type): the card's campaign upgrade
    // { name, summary } or null.
    static install({ roster, owns, temporary, heroTypes, nameOf, statsOf, portraitOf, upgradeOf }) {
        Object.assign(this, { roster, owns, temporary, heroTypes, nameOf, statsOf, portraitOf });
        this.upgradeOf = upgradeOf;
        this.$ = (id) => document.getElementById(id);
        this.dialog = this.$('campaignDeckDialog');
        this.$('campaignDeckCloseBtn').addEventListener('click', () => this.dialog.close());
        this.$('campaignDeckDoneBtn').addEventListener('click', () => this.dialog.close());
        this.dialog.addEventListener('click', (event) => {
            if (event.target === this.dialog) this.dialog.close();
        });
        this.dialog.addEventListener('close', () => this.onClose?.());
    }

    // The deck the stage starts with now.
    static deckOf(stage) {
        return resolveCampaignDeck(stage, this.roster.savedDeck(stage.id), this.owns);
    }

    static open(stage, onClose) {
        this.stage = stage;
        this.onClose = onClose;
        this.slots = this.deckOf(stage);
        this.paint();
        this.$('campaignDeckNotice').textContent = '';
        if (!this.dialog.open) this.dialog.showModal();
    }

    static isHero(type) {
        return this.heroTypes.includes(type);
    }

    static portrait(type) {
        const image = document.createElement('img');
        image.alt = '';
        Promise.resolve(this.portraitOf(type)).then(
            (src) => (image.src = src),
            () => image.remove(),
        );
        return image;
    }

    static paint() {
        this.$('campaignDeckKicker').textContent = `${this.stage.title} · 캠페인 전용 덱`;
        this.$('campaignDeckSunshine').textContent = `☀ ${this.roster.sunshine}`;
        this.$('campaignDeckCount').textContent = `${this.slots.length} / ${CAMPAIGN_DECK_LIMIT}칸`;
        this.paintSlots();
        this.paintCards();
    }

    static paintSlots() {
        const required = campaignDeckRequired(this.stage),
            host = this.$('campaignDeckSelected');
        host.replaceChildren();
        for (let index = 0; index < CAMPAIGN_DECK_LIMIT; index++) {
            const type = this.slots[index],
                tile = document.createElement('div'),
                slot = document.createElement('button');
            tile.className = 'deck-tile';
            slot.type = 'button';
            slot.className = 'deck-slot';
            if (type) {
                const name = document.createElement('span'),
                    locked = required.includes(type);
                name.textContent = locked ? `${this.nameOf(type)} · 필수` : this.nameOf(type);
                slot.toggleAttribute('data-hero', this.isHero(type));
                slot.disabled = locked;
                slot.setAttribute(
                    'aria-label',
                    `${index + 1}번 칸 ${this.nameOf(type)}${locked ? ' · 이 판의 필수 카드' : ' · 덱에서 제외'}`,
                );
                slot.append(this.portrait(type), name);
                slot.addEventListener('click', () => this.toggle(type));
            } else {
                slot.classList.add('deck-slot-empty');
                slot.disabled = true;
                slot.textContent = '빈 칸';
                slot.setAttribute('aria-label', `${index + 1}번 빈 칸`);
            }
            tile.append(slot);
            host.append(tile);
        }
    }

    static paintCards() {
        const host = this.$('campaignDeckCollection'),
            required = campaignDeckRequired(this.stage);
        host.replaceChildren();
        for (const type of campaignDeckPool(this.stage, this.owns)) {
            const chosen = this.slots.includes(type),
                row = document.createElement('div'),
                pick = document.createElement('button'),
                name = document.createElement('b'),
                cost = document.createElement('small'),
                check = document.createElement('span');
            row.className = 'campaign-deck-row';
            pick.type = 'button';
            pick.className = 'campaign-deck-pick';
            pick.setAttribute('aria-pressed', String(chosen));
            pick.disabled = required.includes(type);
            name.textContent = this.nameOf(type);
            cost.innerHTML = this.isHero(type)
                ? '영웅'
                : ResourceDisplay.costMarkup(this.statsOf(type));
            check.className = 'campaign-deck-mark';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = required.includes(type) ? '필수' : chosen ? '✓' : '+';
            pick.append(this.portrait(type), name, cost, check);
            pick.addEventListener('click', () => this.toggle(type));
            row.append(pick);
            const upgrade = this.upgradeRow(type);
            if (upgrade) row.append(upgrade);
            host.append(row);
        }
    }

    // The card's campaign upgrade line: what it does, and its state or the price to open it. A card the stage only
    // lends (not owned yet) and a hero have none.
    static upgradeRow(type) {
        const upgrade = this.upgradeOf(type);
        if (!upgrade || this.isHero(type) || !this.owns(type) || this.temporary()) return null;
        const line = document.createElement('div'),
            text = document.createElement('p'),
            title = document.createElement('b'),
            summary = document.createElement('span');
        line.className = 'campaign-deck-upgrade';
        title.textContent = `캠페인 강화 · ${upgrade.name}`;
        summary.textContent = upgrade.summary;
        text.append(title, summary);
        line.append(text);
        if (this.roster.hasUpgrade(type)) {
            const state = document.createElement('em');
            state.textContent = '열림';
            line.append(state);
        } else {
            const price = SUNSHINE.openUpgrade,
                missing = price - this.roster.sunshine,
                button = document.createElement('button');
            button.type = 'button';
            button.className = 'launch-btn campaign-deck-open';
            button.disabled = missing > 0;
            button.textContent =
                missing > 0 ? `☀ ${price} · ${missing} 모자라요` : `☀ ${price} · 열기`;
            button.addEventListener('click', async () => {
                button.disabled = true;
                this.$('campaignDeckNotice').textContent = (await this.roster.openUpgrade(type))
                    ? `${this.nameOf(type)} 강화를 열었어요.`
                    : '강화를 열지 못했어요.';
                this.paint();
            });
            line.append(button);
        }
        return line;
    }

    static additionBlock(type) {
        if (this.slots.length >= CAMPAIGN_DECK_LIMIT)
            return `덱은 최대 ${CAMPAIGN_DECK_LIMIT}칸이에요. 카드 한 장을 먼저 빼 주세요.`;
        if (
            this.isHero(type) &&
            this.slots.filter((card) => this.isHero(card)).length >= CAMPAIGN_DECK_HERO_LIMIT
        )
            return `영웅은 최대 ${CAMPAIGN_DECK_HERO_LIMIT}명이에요. 장착한 영웅을 먼저 빼 주세요.`;
        return '';
    }

    static async toggle(type) {
        const notice = this.$('campaignDeckNotice');
        if (campaignDeckRequired(this.stage).includes(type)) {
            notice.textContent = '이 판의 필수 카드는 뺄 수 없어요.';
            return;
        }
        if (this.slots.includes(type)) {
            if (this.slots.length === 1) {
                notice.textContent = '카드를 한 장 이상 골라야 해요.';
                return;
            }
            this.slots = this.slots.filter((card) => card !== type);
        } else {
            const block = this.additionBlock(type);
            if (block) {
                notice.textContent = block;
                return;
            }
            this.slots = [...this.slots, type];
        }
        this.paint();
        if (this.temporary()) {
            notice.textContent = '디버그 편성은 이번 접속에서만 유지돼요.';
            return;
        }
        notice.textContent = (await this.roster.setCampaignDeck(this.stage.id, this.slots))
            ? '이 기기에 저장됐어요.'
            : '이 기기에 저장할 수 없어 이번에만 유지돼요.';
    }
}
