// How hard the campaign enemy plays: two knobs, the AI's decision interval and the enemy's starting resources, each a
// multiplier. They come from two sources that multiply: the difficulty the player picked, and how late the player
// opened the stage's region (act 2's three regions go in the player's order: the 1st is easy, the 3rd is hardest).
// A campaign match copies the product once at its start into `matchConfig.campaignPace` (see Roster.paceFor), so a
// save changed mid-match does not reach it. A stage belongs to a region when it declares `region: '<region id>'`
// (nut-forest, field-town, wind-hill); the other stages have none and always take step 1. All numbers are first drafts.
export const CAMPAIGN_DIFFICULTIES = Object.freeze([
    { id: 'easy', title: '쉬움', decisionScale: 1.5, resourceScale: 0.75 },
    { id: 'normal', title: '보통', decisionScale: 1, resourceScale: 1 },
    { id: 'hard', title: '어려움', decisionScale: 0.75, resourceScale: 1.25 },
]);
export const DEFAULT_DIFFICULTY = 'normal';

// Index 0 is the 1st region the player opened (and every stage that belongs to no region).
export const REGION_STEPS = Object.freeze([
    { decisionScale: 1, resourceScale: 1 },
    { decisionScale: 0.9, resourceScale: 1.1 },
    { decisionScale: 0.8, resourceScale: 1.25 },
]);

export function isDifficulty(id) {
    return CAMPAIGN_DIFFICULTIES.some((difficulty) => difficulty.id === id);
}

const round = (value) => Math.round(value * 10_000) / 10_000;

// `place` is Roster.regionPlace of the stage's region: 1..3, or 0 for a stage with no region.
export function campaignPace(difficultyId, place = 0) {
    const difficulty = CAMPAIGN_DIFFICULTIES.find(({ id }) => id === difficultyId);
    if (!difficulty) throw new RangeError(`알 수 없는 난이도: ${difficultyId}`);
    if (!Number.isInteger(place) || place < 0 || place > REGION_STEPS.length)
        throw new RangeError(`고장 순번은 0~${REGION_STEPS.length}여야 합니다: ${place}`);
    const step = REGION_STEPS[Math.max(place, 1) - 1];
    return {
        decisionScale: round(difficulty.decisionScale * step.decisionScale),
        resourceScale: round(difficulty.resourceScale * step.resourceScale),
    };
}

// A defence wave's enemy formations with their head counts scaled by the pace's resource multiplier (rounded, at
// least 1). Neutral pace returns the formations untouched; a formation of the player's side is never scaled.
export function scaleFormations(formations, pace) {
    if (isNeutralPace(pace)) return formations;
    return formations.map((formation) =>
        (formation.side ?? 1) === 1
            ? { ...formation, count: Math.max(1, Math.round(formation.count * pace.resourceScale)) }
            : formation,
    );
}

// The pace the sim reads. Absent from a stage's rules = x1·x1, so a normal difficulty on a 1st-step stage runs exactly
// as a match without this module did; any other pace is part of the match's rules (snapshot, replay, match identity).
export function isNeutralPace(pace) {
    return !pace || (pace.decisionScale === 1 && pace.resourceScale === 1);
}
export const NEUTRAL_PACE = Object.freeze({ decisionScale: 1, resourceScale: 1 });

// The stage as a match's `rules.campaign`: the stage itself, plus the pace when it is not neutral.
export function stageRules(stage, pace) {
    return isNeutralPace(pace) ? stage : { ...stage, pace: { ...pace } };
}
