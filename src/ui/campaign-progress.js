import { CAMPAIGN_ACT_STAGES } from '../definitions/campaign.js';
import { CampaignActs } from './campaign-acts.js';
import { updatePlayerSave } from './player-saves.js';

const REWARD_STAGES = new Map(
    CAMPAIGN_ACT_STAGES.filter((stage) => stage.rewardCard).map((stage) => [
        stage.rewardCard,
        stage,
    ]),
);

// What the campaign allows now, read from the roster's record (src/ui/roster.js, the stages it has cleared) and the
// act rules (campaign-acts.js). A result is recorded by Roster.recordClear, not here.
export class CampaignProgress {
    #debugUnlocked = false;
    #introReadThisVisit = false;

    // `roster` (src/ui/roster.js) holds the cleared stages and the cards the stages have rewarded.
    constructor(roster, hints) {
        this.roster = roster;
        this.hints = hints;
    }

    // A previous clear is enough to skip the automatic introduction on older saves.
    get needsIntroduction() {
        return (
            !this.#introReadThisVisit &&
            this.hints?.data?.campaignIntroRead !== true &&
            this.roster.clearedStages.size === 0
        );
    }

    async readIntroduction() {
        this.#introReadThisVisit = true;
        const hints = this.hints;
        if (!this.records || !hints?.data || hints.locked || hints.data.campaignIntroRead) return;
        try {
            await updatePlayerSave(hints, (draft) => {
                if (draft.campaignIntroRead) return false;
                draft.campaignIntroRead = true;
            });
        } catch (error) {
            console.warn('캠페인 소개 기록 저장 실패', error);
        }
    }

    // The stage to play after `stage` (won just now, its record still saving): the next open stage of its chapter,
    // else the next one of the whole campaign.
    nextAfter(stage) {
        return CampaignActs.next(
            new Set([...this.roster.clearedStages, stage.id]),
            CampaignActs.chapterOf(stage),
        );
    }

    get debugUnlocked() {
        return this.#debugUnlocked;
    }

    enableDebugUnlock() {
        this.#debugUnlocked = true;
    }

    canStart(stage) {
        return this.#debugUnlocked || CampaignActs.isOpen(stage, this.roster.clearedStages);
    }

    // The stage that rewards this card (shown on a locked card), or null.
    unlockStage(card) {
        return REWARD_STAGES.get(card) || null;
    }

    // Does a result count? Not under the debug unlock, which saves nothing (no progress, reward or sunshine).
    get records() {
        return !this.#debugUnlocked;
    }
}
