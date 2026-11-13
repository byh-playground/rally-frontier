import { CAMPAIGN_STAGES, campaignTier } from '../definitions/campaign.js';

const PROGRESS_KEY = 'ssalkongpang.campaign.v1';
const REWARD_STAGES = new Map(
    CAMPAIGN_STAGES.filter((stage) => stage.rewardCard).map((stage) => [stage.rewardCard, stage]),
);

export class CampaignProgress {
    #debugUnlocked = false;

    constructor(storage) {
        this.storage = storage;
        this.completed = new Set();
        this.sync();
    }

    sync() {
        let saved;
        try {
            saved = JSON.parse(this.storage?.getItem(PROGRESS_KEY) || 'null');
        } catch {
            return;
        }
        if (!Array.isArray(saved?.completed)) return;
        for (const stage of CAMPAIGN_STAGES)
            if (saved.completed.includes(stage.id)) this.completed.add(stage.id);
    }

    save() {
        try {
            this.storage?.setItem(PROGRESS_KEY, JSON.stringify({ completed: [...this.completed] }));
        } catch (error) {
            console.warn('캠페인 진행 저장 실패', error);
        }
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

    isUnlocked(card) {
        const stage = this.unlockStage(card);
        return this.#debugUnlocked || !stage || this.isComplete(stage);
    }

    complete(stage) {
        if (this.#debugUnlocked) return null;
        this.sync();
        if (!stage || this.isComplete(stage) || !this.canStart(stage)) return null;
        this.completed.add(stage.id);
        this.save();
        return stage.rewardCard ?? null;
    }
}
