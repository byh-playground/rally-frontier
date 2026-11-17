import { SUNSHINE, startingOwned } from '../definitions/roster.js';
import { loadPlayerSave, updatePlayerSave } from './player-saves.js';

// The roster record of src/ui/player-saves.js: the single source of which cards the player owns, plus the new
// campaign's progress and sunshine. Without a save, it lasts for this page only. Until the record loads (or when it
// cannot be read) the player owns the starting set.
export class Roster {
    #owned = new Set(startingOwned());

    constructor(save = null) {
        this.save = save;
    }

    // Takes the loaded record (another tab may have changed it).
    sync() {
        const saved = this.save?.data;
        if (saved) this.#owned = new Set(saved.owned);
    }

    async load() {
        if (this.save && (await loadPlayerSave(this.save, '소유 목록'))) this.sync();
    }

    owns(type) {
        return this.#owned.has(type);
    }

    get owned() {
        return [...this.#owned];
    }

    get campaign() {
        return this.save?.data?.campaign ?? null;
    }

    get sunshine() {
        return this.campaign?.sunshine ?? 0;
    }

    // 1-based place of a region in the order it was first cleared, or 0 while it is not.
    regionPlace(regionId) {
        return (this.campaign?.regionOrder.indexOf(regionId) ?? -1) + 1;
    }

    hasUpgrade(type) {
        return !!this.campaign?.upgrades.includes(type);
    }

    // The one way a card is added (a stage reward). Resolves true once it is in the device save; a failed save
    // leaves the roster as it was.
    async grant(types) {
        if (!this.save) {
            for (const type of types) this.#owned.add(type);
            return true;
        }
        return this.#write((draft) => this.#addOwned(draft, types));
    }

    // Records one stage result of the new campaign in a single save: progress marks, sunshine, owned cards, and the
    // region's place. `result` = { stageId, cleared, sideGoal, hard, opensRegion?, grants? }. Each item pays and
    // marks only the first time. Resolves { sunshine } paid by this result (0 when the save failed).
    async recordClear({
        stageId,
        cleared,
        sideGoal = false,
        hard = false,
        opensRegion,
        grants = [],
    }) {
        const paid = { sunshine: 0 };
        if (!cleared) return paid;
        const saved = await this.#write((draft) => {
            paid.sunshine = 0;
            const progress = draft.campaign;
            const mark = (list, amount) => {
                if (list.includes(stageId)) return;
                list.push(stageId);
                progress.sunshine += amount;
                paid.sunshine += amount;
            };
            mark(progress.firstCleared, SUNSHINE.firstClear);
            if (sideGoal) mark(progress.sideGoalCleared, SUNSHINE.sideGoal);
            if (hard) mark(progress.hardCleared, SUNSHINE.hardFirstClear);
            if (opensRegion && !progress.regionOrder.includes(opensRegion))
                progress.regionOrder.push(opensRegion);
            this.#addOwned(draft, grants);
        });
        return saved ? paid : { sunshine: 0 };
    }

    // Opens the upgrade of an owned card for the sunshine price. Resolves false when it cannot be paid, is already
    // open, or the save failed.
    async openUpgrade(type) {
        let opened = false;
        const saved = await this.#write((draft) => {
            opened = false;
            const progress = draft.campaign;
            if (
                !draft.owned.includes(type) ||
                progress.upgrades.includes(type) ||
                progress.sunshine < SUNSHINE.openUpgrade
            )
                return false;
            progress.sunshine -= SUNSHINE.openUpgrade;
            progress.upgrades.push(type);
            opened = true;
        });
        return saved && opened;
    }

    #addOwned(draft, types) {
        for (const type of types) if (!draft.owned.includes(type)) draft.owned.push(type);
    }

    // Resolves whether the change reached the device save; the owned set follows the saved record only.
    async #write(mutate) {
        if (!this.save || this.save.locked) return false;
        try {
            await updatePlayerSave(this.save, mutate);
        } catch (error) {
            console.warn('소유 목록 저장 실패', error);
            return false;
        }
        this.sync();
        return true;
    }
}
