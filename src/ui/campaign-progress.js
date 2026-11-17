import { CAMPAIGN_STAGES, campaignTier } from '../definitions/campaign.js';
import { loadPlayerSave, updatePlayerSave } from './player-saves.js';

const REWARD_STAGES = new Map(
    CAMPAIGN_STAGES.filter((stage) => stage.rewardCard).map((stage) => [stage.rewardCard, stage]),
);

export class CampaignProgress {
    #debugUnlocked = false;

    // `save` is the campaign record of src/ui/player-saves.js; without one, progress lasts for this page only.
    // `roster` (src/ui/roster.js) receives the card a stage rewards.
    constructor(save = null, roster = null) {
        this.save = save;
        this.roster = roster;
        this.completed = new Set();
    }

    // Takes the cleared stages of the loaded record (another tab may have added some).
    sync() {
        const saved = this.save?.data?.completed;
        if (!saved) return;
        for (const stage of CAMPAIGN_STAGES)
            if (saved.includes(stage.id)) this.completed.add(stage.id);
    }

    async load() {
        if (this.save && (await loadPlayerSave(this.save, '캠페인 진행'))) this.sync();
    }

    persist(id) {
        if (!this.save || this.save.locked) return;
        updatePlayerSave(this.save, (draft) => {
            if (draft.completed.includes(id)) return false;
            draft.completed.push(id);
        }).then(
            () => this.sync(),
            (error) => console.warn('캠페인 진행 저장 실패', error),
        );
    }

    // First stage in definition order that can be started now and is not cleared yet.
    get nextStage() {
        return (
            CAMPAIGN_STAGES.find((stage) => !this.isComplete(stage) && this.canStart(stage)) || null
        );
    }

    // The debug unlock saves nothing, so there the next stage is simply the following one in definition order.
    nextAfter(stage) {
        return this.#debugUnlocked
            ? CAMPAIGN_STAGES[CAMPAIGN_STAGES.indexOf(stage) + 1] || null
            : this.nextStage;
    }

    // Clearing any one stage of the previous tier opens a tier.
    isTierOpen(tierId) {
        const tier = campaignTier(tierId);
        return (
            this.#debugUnlocked ||
            !tier.requires ||
            CAMPAIGN_STAGES.some((stage) => stage.tier === tier.requires && this.isComplete(stage))
        );
    }

    isComplete(stage) {
        return this.completed.has(stage.id);
    }

    get debugUnlocked() {
        return this.#debugUnlocked;
    }

    enableDebugUnlock() {
        this.#debugUnlocked = true;
    }

    canStart(stage) {
        return (
            this.#debugUnlocked ||
            (this.isTierOpen(stage.tier) &&
                (!stage.prerequisite || this.completed.has(stage.prerequisite)))
        );
    }

    unlockStage(card) {
        return REWARD_STAGES.get(card) || null;
    }

    // Does a result count? Not under the debug unlock, which saves nothing (no progress, reward or sunshine).
    get records() {
        return !this.#debugUnlocked;
    }

    complete(stage) {
        if (!this.records) return null;
        if (!stage || this.isComplete(stage) || !this.canStart(stage)) return null;
        this.completed.add(stage.id);
        if (stage.rewardCard) void this.roster?.grant([stage.rewardCard]);
        this.persist(stage.id);
        return stage.rewardCard ?? null;
    }
}
