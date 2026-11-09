import { CAMPAIGN_STAGES } from '../definitions/campaign.js';

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

    get nextStage() {
        return (
            CAMPAIGN_STAGES.find((stage) => !stage.optional && !this.completed.has(stage.id)) ||
            null
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
            this.isComplete(stage) ||
            (stage.optional ? this.completed.has(stage.prerequisite) : this.nextStage === stage)
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
