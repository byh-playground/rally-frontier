import { CAMPAIGN_ACT_STAGES, CAMPAIGN_REGIONS } from '../definitions/campaign.js';

// Which stage of the new campaign is open, computed from the stage declarations (campaign.js CAMPAIGN_ACT_STAGES)
// and the stages the player has cleared (Roster.clearedStages). Nothing is listed ahead of time:
//   act 1                 in order
//   act 2 (each region)   all three regions open together once act 1 is cleared; in order inside a region
//   act 3                 once every region's last stage (its boss) is cleared, in order (the interlude first)
// A chapter is one act, or one region of act 2; only a region with stages is a chapter.
const stagesWhere = (pick) => CAMPAIGN_ACT_STAGES.filter(pick);
const CHAPTERS = Object.freeze(
    [
        { id: 'act1', act: 1, title: '1막 논두렁', stages: stagesWhere((s) => s.act === 1) },
        ...CAMPAIGN_REGIONS.map((region) => ({
            id: region.id,
            act: 2,
            title: region.title,
            region,
            stages: stagesWhere((s) => s.region === region.id),
        })),
        {
            id: 'act3',
            act: 3,
            title: '막간 · 3막 검은 곳간',
            stages: stagesWhere((s) => s.act === 3),
        },
    ].filter((chapter) => chapter.stages.length),
);

export class CampaignActs {
    static chapters = CHAPTERS;

    static chapter(id) {
        return CHAPTERS.find((chapter) => chapter.id === id) ?? null;
    }

    static chapterOf(stage) {
        return CHAPTERS.find((chapter) => chapter.stages.includes(stage)) ?? null;
    }

    // `cleared` is a Set of stage ids.
    static isChapterCleared(chapter, cleared) {
        return chapter.stages.every((stage) => cleared.has(stage.id));
    }

    static isChapterOpen(chapter, cleared) {
        const done = (act) =>
            CHAPTERS.filter((other) => other.act === act).every((other) =>
                act === 2
                    ? cleared.has(other.stages.at(-1).id)
                    : this.isChapterCleared(other, cleared),
            );
        if (chapter.act === 1) return true;
        if (chapter.act === 2) return done(1);
        return done(1) && done(2);
    }

    static isOpen(stage, cleared) {
        const chapter = this.chapterOf(stage);
        if (!chapter || !this.isChapterOpen(chapter, cleared)) return false;
        const index = chapter.stages.indexOf(stage);
        return index === 0 || cleared.has(chapter.stages[index - 1].id);
    }

    // The first open, uncleared stage inside `chapter` only, or null when the chapter has none left.
    static nextIn(chapter, cleared) {
        return (
            chapter.stages.find((stage) => !cleared.has(stage.id) && this.isOpen(stage, cleared)) ??
            null
        );
    }

    // The stage to play next after a clear: the next one of `chapter` (when given), else of the whole campaign.
    static next(cleared, chapter = null) {
        return (
            (chapter && this.nextIn(chapter, cleared)) ??
            CHAPTERS.map((other) => this.nextIn(other, cleared)).find(Boolean) ??
            null
        );
    }
}
