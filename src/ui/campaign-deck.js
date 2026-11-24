import {
    CAMPAIGN_DECK_HERO_LIMIT,
    CAMPAIGN_DECK_LIMIT,
    campaignDeckPool,
    campaignDeckRequired,
    resolveCampaignDeck,
} from '../definitions/campaign-deck.js';
import { ResourceDisplay } from './resource-display.js';

// The campaign's own deck editor: the cards the player brings to one stage. It is a separate sheet from the versus
// deck editor (deck-editor.js), so nothing of the campaign shows on a screen the versus match also uses, and its
// picks are saved per stage in the roster record, not in the versus decks. The cards look as they do in the versus
// editor; a star marks a card whose campaign upgrade is open (the upgrades are bought on their own sheet,
// campaign-upgrades.js, because they belong to the card for good, not to one stage's deck).
export class CampaignDeck {
    // roster: the Roster; owns(type): whether the card is usable now (the debug unlock owns everything);
    // temporary(): the debug unlock, whose picks are not saved; heroTypes: the hero card ids;
    // nameOf, statsOf, portraitOf: how a card is told.
    static install({ roster, owns, temporary, heroTypes, nameOf, statsOf, portraitOf }) {
        Object.assign(this, { roster, owns, temporary, heroTypes, nameOf, statsOf, portraitOf });
        this.$ = (id) => document.getElementById(id);
        this.dialog = this.$('campaignDeckDialog');
        this.$('campaignDeckCloseBtn').addEventListener('click', () => this.dialog.close());
        this.$('campaignDeckDoneBtn').addEventListener('click', () => this.dialog.close());
        this.$('campaignDeckResetBtn').addEventListener('click', () => this.reset());
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
                locked = required.includes(type),
                tile = document.createElement('div'),
                button = document.createElement('button'),
                name = document.createElement('b'),
                detail = document.createElement('small'),
                check = document.createElement('span');
            tile.className = 'deck-tile';
            button.type = 'button';
            button.className = 'deck-card';
            button.dataset.deckType = type;
            button.toggleAttribute('data-required', locked);
            button.setAttribute('aria-pressed', String(chosen));
            name.textContent = this.nameOf(type);
            detail.innerHTML = this.isHero(type)
                ? '영웅'
                : ResourceDisplay.costMarkup(this.statsOf(type));
            check.className = 'deck-card-check';
            check.setAttribute('aria-hidden', 'true');
            check.textContent = locked ? '필수' : chosen ? '✓' : '+';
            button.setAttribute(
                'aria-label',
                `${this.nameOf(type)}, ${locked ? '이 판의 필수 카드' : chosen ? '덱에서 제외' : '덱에 추가'}${
                    this.roster.hasUpgrade(type) ? ', 캠페인 강화 열림' : ''
                }`,
            );
            button.append(this.portrait(type), name, detail, check);
            button.addEventListener('click', () => this.toggle(type));
            tile.append(button);
            if (!this.isHero(type) && this.roster.hasUpgrade(type)) {
                const star = document.createElement('i');
                star.className = 'campaign-deck-star';
                star.title = '캠페인 강화 열림';
                star.setAttribute('aria-hidden', 'true');
                star.textContent = '★';
                tile.append(star);
            }
            host.append(tile);
        }
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
        await this.persist(() => this.roster.setCampaignDeck(this.stage.id, this.slots));
    }

    // Back to the stage's recommended deck.
    static async reset() {
        this.slots = [...this.stage.deck];
        this.paint();
        await this.persist(() => this.roster.resetCampaignDeck(this.stage.id));
    }

    static async persist(save) {
        const notice = this.$('campaignDeckNotice');
        if (this.temporary()) {
            notice.textContent = '디버그 편성은 이번 접속에서만 유지돼요.';
            return;
        }
        notice.textContent = (await save())
            ? '이 기기에 저장됐어요.'
            : '이 기기에 저장할 수 없어 이번에만 유지돼요.';
    }
}
