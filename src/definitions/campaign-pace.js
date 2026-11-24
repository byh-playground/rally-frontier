// How hard the campaign enemy plays: one knob, the enemy's income rate (a multiplier of how fast its food and oil come
// in; its starting wallet and the size of its scripted attacks follow it). The enemy AI itself plays exactly as the
// match AI does, whatever the difficulty. The multiplier is the product of two sources: the difficulty the player
// picked, and how late the player opened the stage's region (act 2's three regions go in the player's order: the 1st is
// easy, the 3rd is hardest).
// A campaign match copies the product once at its start into `matchConfig.campaignPace` (see Roster.paceFor), so a
// save changed mid-match does not reach it. A stage belongs to a region when it declares `region: '<region id>'`
// (nut-forest, field-town, wind-hill); the other stages have none and always take step 1. All numbers are first drafts.
export const CAMPAIGN_DIFFICULTIES = Object.freeze([
    { id: 'easy', title: '쉬움', incomeScale: 0.5 },
    { id: 'normal', title: '보통', incomeScale: 0.8 },
    { id: 'hard', title: '어려움', incomeScale: 1 },
]);
export const DEFAULT_DIFFICULTY = 'normal';

// Index 0 is the 1st region the player opened (and every stage that belongs to no region).
export const REGION_STEPS = Object.freeze([
    { incomeScale: 1 },
    { incomeScale: 1.05 },
    { incomeScale: 1.1 },
]);

export function isDifficulty(id) {
    return CAMPAIGN_DIFFICULTIES.some((difficulty) => difficulty.id === id);
}

const round = (value) => Math.round(value * 10_000) / 10_000;

// `place` is Roster.regionPlace of the stage's region: 1..3, or 0 for a stage with no region.
// `stageScale` is the stage's own `paceScale` (1 when it declares none): a stage whose enemy plays harder than its
// place in the story is eased here, for every difficulty alike.
export function campaignPace(difficultyId, place = 0, stageScale = 1) {
    const difficulty = CAMPAIGN_DIFFICULTIES.find(({ id }) => id === difficultyId);
    if (!difficulty) throw new RangeError(`알 수 없는 난이도: ${difficultyId}`);
    if (!Number.isInteger(place) || place < 0 || place > REGION_STEPS.length)
        throw new RangeError(`고장 순번은 0~${REGION_STEPS.length}여야 합니다: ${place}`);
    const step = REGION_STEPS[Math.max(place, 1) - 1];
    if (!(Number.isFinite(stageScale) && stageScale > 0))
        throw new RangeError(`스테이지 paceScale은 0보다 큰 수여야 합니다: ${stageScale}`);
    return { incomeScale: round(difficulty.incomeScale * step.incomeScale * stageScale) };
}

// A defence wave's enemy formations with their head counts scaled by the pace's income multiplier (rounded, at
// least 1). Neutral pace returns the formations untouched; a formation of the player's side is never scaled.
export function scaleFormations(formations, pace) {
    if (isNeutralPace(pace)) return formations;
    return formations.map((formation) =>
        (formation.side ?? 1) === 1
            ? { ...formation, count: Math.max(1, Math.round(formation.count * pace.incomeScale)) }
            : formation,
    );
}

// The pace the sim reads. Absent from a stage's rules = x1, so a normal difficulty on a 1st-step stage runs exactly
// as a match without this module did; any other pace is part of the match's rules (snapshot, replay, match identity).
export function isNeutralPace(pace) {
    return !pace || pace.incomeScale === 1;
}
export const NEUTRAL_PACE = Object.freeze({ incomeScale: 1 });

// The stage as a match's `rules.campaign`: the stage itself, plus the pace when it is not neutral.
export function stageRules(stage, pace) {
    return isNeutralPace(pace) ? stage : { ...stage, pace: { ...pace } };
}
