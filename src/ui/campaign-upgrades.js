import { SUNSHINE } from '../definitions/roster.js';

// The campaign's upgrade sheet: every upgrade of the cards the player owns, with its state or the sunshine price to
// open it. An open upgrade is always on in the campaign and never in a versus match. It lives on the campaign screen
// (not in a deck sheet, versus or campaign) because an upgrade belongs to its card for good, whatever the deck.
export class CampaignUpgradeSheet {
    // roster: the Roster; owns(type): whether the card is usable now; temporary(): the debug unlock, whose upgrades
    // are not saved so the sheet only lists them; heroTypes: the hero card ids; nameOf, portraitOf: how a card is
    // told; upgradeOf(type): the card's campaign upgrade { name, summary } or null; cards(): the card ids to list.
    static install({ roster, owns, temporary, heroTypes, nameOf, portraitOf, upgradeOf, cards }) {
        Object.assign(this, { roster, owns, temporary, heroTypes, nameOf, portraitOf, upgradeOf });
        this.cards = cards;
        this.$ = (id) => document.getElementById(id);
        this.dialog = this.$('campaignUpgradeDialog');
        this.$('campaignUpgradeCloseBtn').addEventListener('click', () => this.dialog.close());
        this.$('campaignUpgradeDoneBtn').addEventListener('click', () => this.dialog.close());
        this.dialog.addEventListener('click', (event) => {
            if (event.target === this.dialog) this.dialog.close();
        });
        this.dialog.addEventListener('close', () => this.onClose?.());
    }

    static open(onClose) {
        this.onClose = onClose;
        this.$('campaignUpgradeNotice').textContent = '';
        this.paint();
        if (!this.dialog.open) this.dialog.showModal();
    }

    static paint() {
        this.$('campaignUpgradeSunshine').textContent = `☀ ${this.roster.sunshine}`;
        const host = this.$('campaignUpgradeList'),
            listed = this.cards().filter(
                (type) => !this.heroTypes.includes(type) && this.owns(type) && this.upgradeOf(type),
            );
        host.replaceChildren();
        if (!listed.length) {
            const empty = document.createElement('p');
            empty.className = 'campaign-upgrade-empty';
            empty.textContent = '병종을 얻으면 그 병종의 강화가 여기에 나와요.';
            host.append(empty);
            return;
        }
        for (const type of listed) host.append(this.row(type));
    }

    static row(type) {
        const upgrade = this.upgradeOf(type),
            row = document.createElement('div'),
            image = document.createElement('img'),
            text = document.createElement('p'),
            name = document.createElement('b'),
            summary = document.createElement('span');
        row.className = 'campaign-upgrade-row';
        image.alt = '';
        Promise.resolve(this.portraitOf(type)).then(
            (src) => (image.src = src),
            () => image.remove(),
        );
        name.textContent = `${this.nameOf(type)} · ${upgrade.name}`;
        summary.textContent = upgrade.summary;
        text.append(name, summary);
        row.append(image, text);
        if (this.roster.hasUpgrade(type)) {
            const state = document.createElement('em');
            state.textContent = '열림';
            row.append(state);
            return row;
        }
        const price = SUNSHINE.openUpgrade,
            missing = price - this.roster.sunshine,
            button = document.createElement('button');
        button.type = 'button';
        button.className = 'launch-btn campaign-upgrade-open';
        button.disabled = missing > 0 || this.temporary();
        button.textContent = missing > 0 ? `☀ ${price} · ${missing} 모자라요` : `☀ ${price} · 열기`;
        button.addEventListener('click', async () => {
            button.disabled = true;
            this.$('campaignUpgradeNotice').textContent = (await this.roster.openUpgrade(type))
                ? `${this.nameOf(type)} 강화를 열었어요.`
                : '강화를 열지 못했어요.';
            this.paint();
        });
        row.append(button);
        return row;
    }
}
