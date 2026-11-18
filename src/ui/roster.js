import { DEFAULT_DIFFICULTY, campaignPace, isDifficulty } from '../definitions/campaign-pace.js';
import { SUNSHINE, startingOwned } from '../definitions/roster.js';
import { loadPlayerSave, updatePlayerSave } from './player-saves.js';

// The arguments of Roster.recordClear for one finished match of a new-campaign stage (a stage that declares `act`,
// campaign.js): `cleared` the stage was won, `sideGoal` the confirmed end state's side goal (SideGoal, the snapshot's
// `sideGoal`, absent on a stage without one) and `difficulty` the one the match started on.
export function clearRecord(stage, { cleared, sideGoal, difficulty }) {
    return {
        stageId: stage.id,
        cleared,
        sideGoal: sideGoal?.status === 'met',
        hard: difficulty === 'hard',
        ...(stage.region && { opensRegion: stage.region }),
        grants: stage.rewardCard ? [stage.rewardCard] : [],
    };
}

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

    // The difficulty picked last on the campaign screen.
    get difficulty() {
        return this.campaign?.difficulty ?? DEFAULT_DIFFICULTY;
    }

    isHardCleared(stageId) {
        return !!this.campaign?.hardCleared.includes(stageId);
    }

    isSideGoalCleared(stageId) {
        return !!this.campaign?.sideGoalCleared.includes(stageId);
    }

    // The new campaign's stages cleared at least once (what CampaignActs opens the next stages from).
    get clearedStages() {
        return new Set(this.campaign?.firstCleared ?? []);
    }

    // How hard the stage's enemy plays now: what a campaign match copies at its start (matchConfig.campaignPace).
    paceFor(stage) {
        if (!stage.region) return campaignPace(this.difficulty, 0);
        // A region not opened yet takes the next place; an opened one keeps its saved place.
        const place =
            this.regionPlace(stage.region) || (this.campaign?.regionOrder.length ?? 0) + 1;
        return campaignPace(this.difficulty, place);
    }

    // Remembers the difficulty. Resolves false when the save failed.
    setDifficulty(id) {
        if (!isDifficulty(id)) throw new RangeError(`알 수 없는 난이도: ${id}`);
        return this.#write((draft) => {
            draft.campaign.difficulty = id;
        });
    }

    hasUpgrade(type) {
        return !!this.campaign?.upgrades.includes(type);
    }

    // The cards whose upgrade is open: what a campaign match copies at its start.
    get openUpgrades() {
        return [...(this.campaign?.upgrades ?? [])];
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
    // region's place. `result` = { stageId, cleared, sideGoal, hard, opensRegion?, grants? } (clearRecord). Each item
    // pays and marks only the first time. Resolves { sunshine, paid } for this result: the total and the SUNSHINE keys
    // it paid, in order (firstClear, sideGoal, hardFirstClear); nothing when the save failed.
    async recordClear({
        stageId,
        cleared,
        sideGoal = false,
        hard = false,
        opensRegion,
        grants = [],
    }) {
        const result = { sunshine: 0, paid: [] };
        if (!cleared) return result;
        const saved = await this.#write((draft) => {
            result.sunshine = 0;
            result.paid = [];
            const progress = draft.campaign;
            const mark = (list, key) => {
                if (list.includes(stageId)) return;
                list.push(stageId);
                progress.sunshine += SUNSHINE[key];
                result.sunshine += SUNSHINE[key];
                result.paid.push(key);
            };
            mark(progress.firstCleared, 'firstClear');
            if (sideGoal) mark(progress.sideGoalCleared, 'sideGoal');
            if (hard) mark(progress.hardCleared, 'hardFirstClear');
            if (opensRegion && !progress.regionOrder.includes(opensRegion))
                progress.regionOrder.push(opensRegion);
            this.#addOwned(draft, grants);
        });
        return saved ? result : { sunshine: 0, paid: [] };
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
