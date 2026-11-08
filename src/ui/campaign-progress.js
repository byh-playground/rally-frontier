import { CAMPAIGN_STAGES } from '../definitions/campaign.js';

const PROGRESS_KEY = 'ssalkongpang.campaign.v1';
const LEGACY_PROGRESS_KEY = 'ssalkongpang-campaign-progress';
const REWARD_STAGES = new Map(
    CAMPAIGN_STAGES.filter((stage) => stage.rewardCard).map((stage) => [stage.rewardCard, stage]),
);

export class CampaignProgress {
    constructor(storage, equippedCards) {
        this.storage = storage;
        this.completed = new Set();
        this.retainedCards = new Set();
        if (!this.sync()) {
            const legacy = Number(this.read(LEGACY_PROGRESS_KEY));
            if (Number.isFinite(legacy) && legacy > 0)
                for (const stage of CAMPAIGN_STAGES.slice(0, legacy)) this.completed.add(stage.id);
            for (const card of equippedCards(storage))
                if (REWARD_STAGES.has(card)) this.retainedCards.add(card);
            this.save();
        }
    }

    read(key) {
        try {
            return this.storage?.getItem(key);
        } catch {
            return null;
        }
    }

    sync() {
        let saved;
        try {
            saved = JSON.parse(this.read(PROGRESS_KEY) || 'null');
        } catch {
            return false;
        }
        if (!Array.isArray(saved?.completed) || !Array.isArray(saved?.retainedCards)) return false;
        for (const stage of CAMPAIGN_STAGES)
            if (saved.completed.includes(stage.id)) this.completed.add(stage.id);
        for (const card of saved.retainedCards)
            if (REWARD_STAGES.has(card)) this.retainedCards.add(card);
        return true;
    }

    save() {
        try {
            this.storage?.setItem(
                PROGRESS_KEY,
                JSON.stringify({
                    completed: [...this.completed],
                    retainedCards: [...this.retainedCards],
                }),
            );
        } catch (error) {
            console.warn('캠페인 진행 저장 실패', error);
        }
    }

    get nextStage() {
        return CAMPAIGN_STAGES.find((stage) => !this.completed.has(stage.id)) || null;
    }

    isComplete(stage) {
        return this.completed.has(stage.id);
    }

    canStart(stage) {
        return this.isComplete(stage) || this.nextStage === stage;
    }

    unlockStage(card) {
        return REWARD_STAGES.get(card) || null;
    }

    isUnlocked(card) {
        const stage = this.unlockStage(card);
        return !stage || this.isComplete(stage) || this.retainedCards.has(card);
    }

    complete(stage) {
        this.sync();
        if (stage !== this.nextStage) return null;
        const reward =
            stage.rewardCard && !this.isUnlocked(stage.rewardCard) ? stage.rewardCard : null;
        this.completed.add(stage.id);
        this.save();
        return reward;
    }
}
