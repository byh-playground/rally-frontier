// Fixed campaign scenarios. Timing and map seeds are provisional play-test values.
import { LaunchRules } from '../sim/launch-rules.js';

// Enemy launch cadence is the difficulty lever. Within a stage the enemy starts at the shared AI decision
// interval (a hard early push) and slows linearly to `endIntervalMs` over `rampMs`, so the player can stop the
// push and turn the match around. Later tiers end at a shorter interval (15s -> 10s). A full wallet always
// forces a decision at the shared interval (see BotController).
const RAMP_MS = 180_000;
// Clearing any one stage of a tier opens the whole next tier. Stages inside a tier have no fixed order
// (a stage may still require one earlier stage through `prerequisite`).
export const CAMPAIGN_TIERS = Object.freeze([
    { id: 'basics', title: '기초', endIntervalMs: 15_000 },
    { id: 'basic-units', title: '기본 병종', requires: 'basics', endIntervalMs: 12_000 },
    { id: 'new-units', title: '새 병종', requires: 'basic-units', endIntervalMs: 10_000 },
]);
// Stages that share a `group` fold together under one row of their tier (`art` is that row's portrait card).
export const CAMPAIGN_GROUPS = Object.freeze([
    { id: 'hero', title: '영웅', art: 'watermelon' },
    { id: 'coconut', title: '코코넛', art: 'coconut' },
    { id: 'black-bean', title: '검은콩', art: 'black-bean' },
    { id: 'potato', title: '감자', art: 'potato' },
    { id: 'sticky-rice', title: '찹쌀', art: 'sticky-rice' },
    { id: 'dandelion', title: '민들레씨', art: 'dandelion' },
    { id: 'chili', title: '고추', art: 'chili' },
    { id: 'cotton', title: '목화솜', art: 'cotton' },
    { id: 'sesame', title: '참깨', art: 'sesame' },
    { id: 'buckwheat', title: '메밀', art: 'buckwheat' },
]);
export function campaignTier(id) {
    return CAMPAIGN_TIERS.find((tier) => tier.id === id) || null;
}
// From the basic-unit chapter on, every stage is built for the player to win: the player's deck counters the
// enemy deck, and the enemy deck carries no counter of the player's cards. Each basic-unit stage introduces
// its first card (`deck[0]`) against the enemy it beats. The new-unit chapter pairs "써 보기" (the unit in the
// player's deck) with "상대하기" (the unit in the enemy deck) for each unit group; inside that chapter no two
// stages' enemy decks share more than one card, except the rice·millet swarm that black-bean-chain and
// cotton-storm both face and the dandelion·rice deck that dandelion-sky-guard and cotton-sky both face. A stage with `map` (a PvP preset of game-rules.js) names that map's capture points.
const pacing = (firstDecisionMs, tierId) =>
    Object.freeze({
        firstDecisionMs,
        endIntervalMs: campaignTier(tierId).endIntervalMs,
        rampMs: RAMP_MS,
    });
const SCRIPTED_ONLY = Object.freeze({ disabled: true });
// Survival defences: the enemy AI launches at one steady interval between the scripted attacks.
const defendPacing = (firstDecisionMs, intervalMs) =>
    Object.freeze({ firstDecisionMs, intervalMs });
// One scripted attack of a survival defence: it arrives `atMs` after the match starts, whatever is still standing.
const attack = (atMs, ...formations) => ({ atMs, formations });
const premiumFor = (type) => LaunchRules.payload(type).premiumCost;

// A stage may declare `blight: true`: every soldier and hero then created for its enemy side is blighted
// (sim/blight.js). The new campaign's stages declare it.
// A blighted stage may declare its spore sacs (sim/spore-sac.js), each with the blighted soldiers bound to it:
//     sporeSacs: [{ x: 1400, y: 2600, captives: [{ type: 'rice', count: 8 }, { type: 'pea', count: 4 }] }],
// The sac is an enemy building (health 100, no attack). Its captives stand in rings around it and take no part in
// the fight while it stands: they do not move or attack, nobody targets them and nothing hurts or pushes them.
// When it is destroyed every living captive is freed and joins the player's side. A captive is any soldier but a
// hero. The match start rejects a declaration on a stage without `blight: true`. paddy-stained-beans declares one.
// A blighted stage may declare its blight fields (sim/blight-field.js, numbers in definitions/blight-field.js) and,
// for a stage without fire of its own, braziers:
//     blightFields: [{ x: 1500, y: 2790 }],
//     braziers: [{ x: 1580, y: 2700, radius: 125 }],
// A field is blighted ground in 25-unit cells: radius 100 at the start, 25 wider every 10 seconds up to 200. The
// player's ground soldiers and heroes standing on it lose 5 health a second; flying units, buildings and the enemy
// lose none. The player's chili burns it: each damage tick of its flame purifies the one nearest blighted cell the
// flame reaches, for good, and with no enemy in reach it stops at the field's edge and burns it by itself. A brazier lights
// when the player's side alone holds its place (the capture point's presence rule) and then keeps every cell within
// its `radius` purified. The match start rejects fields on a stage without `blight: true` and braziers on a stage
// without fields. No stage declares either yet.
// A blighted stage may declare its spore clouds (sim/spore-cloud.js): a cloud is a defence wave (`mission.waves`,
// `{ atMs, formations }`) that repeats and is announced.
//     sporeClouds: [{ atMs: 10_000, everyMs: 30_000, warnMs: 5_000, times: 4,
//                     formations: [{ type: 'rice', x: 1400, y: 1700, count: 10, columns: 5 }] }],
// Its soldiers (blighted, as every enemy of the stage) first appear at `atMs` and again every `everyMs`, `times`
// times in all (without `times`, for as long as the match runs), and march on the player as a wave's do. Each
// arrival is announced `warnMs` before it: a cloud drifts in to each formation's place and the battle screen says
// so. A formation is a wave's (`spacing` too) without `side` and `hold`, and never a hero. The match start rejects
// a declaration on a stage without `blight: true`, an `atMs` or `everyMs` shorter than `warnMs`, and a place
// outside the map. paddy-hold-the-line declares three.
// A blighted stage may declare its boss (sim/blight-boss.js), a hero the blight rules, and the escorts beside it:
//     boss: { type: 'watermelon', level: 5, x: 1400, y: 2500,
//             escorts: [{ type: 'rice', x: 1400, y: 2380, count: 12, columns: 4 }] },
// At the start the enemy main base fires the hero at (x, y) on the ordinary hero sortie, at the kills of `level`
// (5: 70 kills, so it awakens at 100, 30 more). The escorts (wave formations without `side`, never a hero) stand
// from the first tick. Its landing strike hurts nobody. The boss does not die: at 0 health the blight leaves it and
// the stage is won, the only way to win it (the enemy main base falling does not end it); the player's main base
// falling still loses it, on that same tick too. `type` must be a hero card of `enemyDeck`. A stage that
// rewards the hero it frees (`rewardCard`) names the same card. The match start rejects a boss on a stage without
// `blight: true`, a soldier card or a card the enemy deck lacks, a place outside the map, and a boss beside a
// survival defence (`mission.surviveMs`), a hero lesson or volley goals. No stage declares one yet.
// A stage where a new card joins may declare a practice step (sim/campaign-practice.js): the player first tries the
// card on targets that stand still, and the stage's own mission begins when they are all down. The stage stays one
// match:
//     practice: { card: 'pea', cue: '콩을 쏴서 허수아비를 쓰러뜨려요',
//                 targets: [{ type: 'rice', x: 1300, y: 2500, count: 6, columns: 3 }] },
// `targets` are wave formations without `side` and `hold`, never a hero: enemy soldiers that never move or attack but
// can be hit and killed (blighted on a blighted stage). `card` must be in `deck`; `cue` is the battle screen's one line
// while the practice runs. Until the last target is down the enemy AI makes no decision and the mission's clock
// (CampaignMission.clock) stands at 0: defence waves, the survival countdown, spore clouds and blight field growth all
// count their ms from that tick. The match start rejects a card outside `deck`, an empty cue and a place outside the
// map. The new campaign's act 1 stages declare one.
// A stage may declare one side goal (sim/side-goal.js), paid once with sunshine (SUNSHINE.sideGoal) beside the clear;
// winning without it is still winning. Its kinds: `{ kind: 'freeCaptives', count? }` (the spore sacs' captives freed,
// all or at least `count`), `{ kind: 'burnFields' }` (no blighted cell left), `{ kind: 'withinMs', ms }` (won within
// `ms` on the mission's clock) and `{ kind: 'keepAlive', hpRatio, point? }` (won with the main base, or the player's
// starting outpost on `point`, never below `hpRatio` of its health). The match start rejects another kind and a goal
// its stage cannot judge (captives without sacs, fields without fields, a point the player does not hold). The new
// campaign's act 1 stages declare one each.
// A stage of the new campaign declares `act` (1, 2 or 3, the act it belongs to): its won result is recorded in the
// roster (Roster.recordClear: progress, sunshine, owned cards) and the result screen shows the sunshine it paid. Those
// stages are CAMPAIGN_ACT_STAGES below.
export const CAMPAIGN_STAGES = Object.freeze([
    {
        id: 'first',
        tier: 'basics',
        enemyPacing: pacing(20_000, 'basics'),
        title: '첫 진격',
        briefing: '쌀로 전진 거점을 세우고 새 대포로 적 본진을 노리세요.',
        deck: ['rice'],
        enemyDeck: ['rice'],
        introducedEnemy: 'rice',
        enemyOutposts: ['enemy-front'],
        seed: 100,
        mode: 'eliminate',
        layout: {
            guestY: 1200,
            advance: { x: 1080, y: 2180 },
            center: { x: 1450, y: 1790 },
            front: { x: 950, y: 1490 },
        },
        mission: { firstCapture: 'advance' },
    },
    {
        id: 'volley-practice',
        tier: 'basics',
        prerequisite: 'first',
        enemyPacing: SCRIPTED_ONLY,
        title: '일제사격 연습',
        nodeMark: '1·2·3',
        briefing: '대포가 1문, 2문, 3문씩 닿는 지점의 적 콩 수비대를 격파하세요.',
        deck: ['rice'],
        enemyDeck: ['pea'],
        enemyOutposts: [],
        friendlyOutposts: ['advance', 'center'],
        startingLaunchRangeLevel: 1,
        seed: 110,
        mode: 'volley-practice',
        volleyGoals: [
            {
                x: 1850,
                y: 2670,
                radius: 110,
                cannons: 1,
                garrison: { type: 'pea', count: 8, columns: 4, spacing: 34 },
            },
            {
                x: 575,
                y: 2475,
                radius: 110,
                cannons: 2,
                garrison: { type: 'pea', count: 12, columns: 4, spacing: 34 },
            },
            {
                x: 1710,
                y: 2150,
                radius: 110,
                cannons: 3,
                garrison: { type: 'pea', count: 16, columns: 4, spacing: 34 },
            },
        ],
    },
    {
        id: 'hero-watermelon',
        tier: 'basics',
        group: 'hero',
        prerequisite: 'first',
        enemyPacing: SCRIPTED_ONLY,
        title: '영웅 훈련 · 수박 출격',
        briefing: '수박을 쏴 적을 처치한 뒤, 복귀시켜 다시 출격하세요.',
        deck: ['watermelon'],
        enemyDeck: ['rice'],
        enemyOutposts: [],
        seed: 111,
        mode: 'hero-lesson',
        mission: {
            heroLesson: { type: 'watermelon', recover: true },
            formations: [{ type: 'rice', x: 1160, y: 2050, count: 4, columns: 2, spacing: 26 }],
        },
    },
    {
        id: 'hero-banana',
        tier: 'basics',
        group: 'hero',
        prerequisite: 'first',
        enemyPacing: SCRIPTED_ONLY,
        title: '영웅 획득 · 바나나 부메랑',
        briefing: '바나나를 쏴 줄지어 선 적을 부메랑으로 처치하세요.',
        deck: ['banana'],
        enemyDeck: ['pea'],
        enemyOutposts: [],
        rewardCard: 'banana',
        seed: 112,
        mode: 'hero-lesson',
        mission: {
            heroLesson: { type: 'banana' },
            formations: [{ type: 'pea', x: 1200, y: 2030, count: 4, columns: 1, spacing: 40 }],
        },
    },
    {
        id: 'hero-grape',
        tier: 'basics',
        group: 'hero',
        prerequisite: 'first',
        enemyPacing: SCRIPTED_ONLY,
        title: '영웅 획득 · 포도 곡사탄',
        briefing: '포도를 쏴 모여 있는 적을 곡사탄으로 처치하세요.',
        deck: ['grape'],
        enemyDeck: ['pea'],
        enemyOutposts: [],
        rewardCard: 'grape',
        seed: 113,
        mode: 'hero-lesson',
        mission: {
            heroLesson: { type: 'grape' },
            formations: [{ type: 'pea', x: 1200, y: 2050, count: 8, columns: 4 }],
        },
    },
    {
        id: 'basic-pea',
        tier: 'basic-units',
        enemyPacing: defendPacing(30_000, 25_000),
        title: '콩 · 무너지지 않는 앞줄',
        briefing:
            '콩은 튼튼하고 포탄이 넓게 터져요. 몰려오는 쌀·조 떼 한가운데에 콩을 떨어뜨려 막으세요.',
        deck: ['pea'],
        enemyDeck: ['rice', 'millet'],
        enemyOutposts: ['enemy-front', 'enemy-rear'],
        friendlyOutposts: ['advance'],
        seed: 140,
        mode: 'defend',
        mission: {
            surviveMs: 150_000,
            guardPoint: 'advance',
            waves: [
                attack(10_000, { type: 'rice', x: 1150, y: 1650, count: 6, columns: 3 }),
                attack(
                    35_000,
                    { type: 'rice', x: 950, y: 1650, count: 8, columns: 4 },
                    { type: 'millet', x: 1400, y: 1600, count: 6, columns: 3 },
                ),
                attack(
                    60_000,
                    { type: 'millet', x: 950, y: 1600, count: 10, columns: 5 },
                    { type: 'rice', x: 1300, y: 1650, count: 12, columns: 4 },
                ),
                attack(
                    85_000,
                    { type: 'rice', x: 950, y: 1650, count: 16, columns: 4 },
                    { type: 'millet', x: 1450, y: 1600, count: 12, columns: 4 },
                ),
                attack(
                    110_000,
                    { type: 'millet', x: 950, y: 1600, count: 16, columns: 4 },
                    { type: 'rice', x: 1400, y: 1650, count: 20, columns: 5 },
                ),
                attack(
                    130_000,
                    { type: 'rice', x: 900, y: 1650, count: 20, columns: 5 },
                    { type: 'millet', x: 1250, y: 1600, count: 24, columns: 6 },
                    { type: 'rice', x: 1600, y: 1650, count: 20, columns: 5 },
                ),
            ],
        },
    },
    {
        id: 'basic-redbean',
        tier: 'basic-units',
        map: 'small-field',
        enemyPacing: pacing(30_000, 'basic-units'),
        title: '팥 · 포대 덮치기',
        briefing:
            '해바라기씨 포대는 멀리서 쏘지만 붙으면 약해요. 팥은 높이 뛰어 내려찍으니 포대 바로 앞에 떨어뜨리세요.',
        deck: ['redbean', 'rice'],
        enemyDeck: ['sunflower-seed'],
        enemyOutposts: ['natural-2', 'oil-2'],
        friendlyOutposts: ['natural-1'],
        startingLaunchRangeLevel: 1,
        seed: 141,
        mode: 'eliminate',
        mission: {
            startingPremium: [0, premiumFor('sunflower-seed') * 3],
            formations: [
                { type: 'sunflower-seed', x: 1950, y: 1150, count: 5, columns: 5, hold: true },
                { type: 'sunflower-seed', x: 2300, y: 1150, count: 5, columns: 5, hold: true },
            ],
        },
    },
    {
        id: 'basic-millet',
        tier: 'basic-units',
        enemyPacing: pacing(30_000, 'basic-units'),
        title: '조 · 원거리 녹이기',
        briefing:
            '옥수수와 해바라기씨는 붙으면 약해요. 빠른 조를 포대 바로 옆에 떨어뜨려 몸으로 들이받으세요.',
        deck: ['millet'],
        enemyDeck: ['corn', 'sunflower-seed'],
        enemyOutposts: ['enemy-front', 'enemy-ridge', 'enemy-oil'],
        seed: 142,
        mode: 'eliminate',
        layout: { guestY: 800 },
        mission: {
            startingPremium: [0, premiumFor('corn') * 2],
            formations: [
                { type: 'corn', x: 1050, y: 1400, count: 6, columns: 3, hold: true },
                { type: 'sunflower-seed', x: 2075, y: 1775, count: 4, columns: 4, hold: true },
                { type: 'corn', x: 1500, y: 1250, count: 6, columns: 3, hold: true },
            ],
        },
    },
    {
        id: 'basic-peanut',
        tier: 'basic-units',
        enemyPacing: pacing(35_000, 'basic-units'),
        title: '땅콩 · 거점 허물기',
        briefing:
            '땅콩은 병사를 때리지 않고 건물만 들이받아요. 쌀로 길을 열고 적 거점 앞에 땅콩을 내리세요.',
        deck: ['peanut', 'rice'],
        enemyDeck: ['peanut'],
        enemyOutposts: ['enemy-front', 'enemy-rear', 'enemy-ridge'],
        friendlyOutposts: ['advance', 'center'],
        seed: 143,
        mode: 'eliminate',
        layout: { guestY: 600 },
        mission: {
            formations: [
                { type: 'rice', x: 1000, y: 1250, count: 8, columns: 4, hold: true },
                { type: 'rice', x: 1900, y: 1700, count: 6, columns: 3, hold: true },
            ],
        },
    },
    {
        id: 'basic-popcorn',
        tier: 'basic-units',
        enemyPacing: pacing(45_000, 'basic-units'),
        title: '팝콘 · 뭉친 줄 터뜨리기',
        briefing:
            '팝콘은 적에게 뛰어들어 터져요. 촘촘히 뭉친 콩 앞줄 옆에 내려 한꺼번에 날려 보내세요.',
        deck: ['popcorn', 'chestnut'],
        enemyDeck: ['pea'],
        enemyOutposts: ['enemy-front'],
        friendlyOutposts: ['advance', 'center', 'oil'],
        seed: 144,
        mode: 'eliminate',
        layout: { guestY: 700 },
        mission: {
            startingPremium: [premiumFor('chestnut') * 4, 0],
            formations: [
                { type: 'pea', x: 1200, y: 1600, count: 16, columns: 4, spacing: 24, hold: true },
                { type: 'pea', x: 900, y: 1300, count: 12, columns: 4, spacing: 24, hold: true },
            ],
        },
    },
    {
        id: 'basic-chestnut',
        tier: 'basic-units',
        enemyPacing: defendPacing(30_000, 25_000),
        title: '밤톨 · 멀리서 깎기',
        briefing:
            '도토리와 콩은 느린 근접이에요. 다가오는 길에 밤톨을 떨어뜨려 붙기 전에 가시로 깎으세요.',
        deck: ['chestnut', 'corn'],
        enemyDeck: ['acorn', 'pea'],
        enemyOutposts: ['enemy-front'],
        friendlyOutposts: ['advance', 'oil'],
        seed: 145,
        mode: 'defend',
        mission: {
            startingPremium: [premiumFor('chestnut') * 4 + premiumFor('corn') * 2, 0],
            surviveMs: 150_000,
            guardPoint: 'advance',
            waves: [
                attack(10_000, { type: 'pea', x: 1200, y: 1450, count: 6, columns: 3 }),
                attack(
                    35_000,
                    { type: 'acorn', x: 1000, y: 1400, count: 2, columns: 2, spacing: 40 },
                    { type: 'pea', x: 1400, y: 1450, count: 8, columns: 4 },
                ),
                attack(
                    60_000,
                    { type: 'acorn', x: 1200, y: 1350, count: 3, columns: 3, spacing: 40 },
                    { type: 'pea', x: 1000, y: 1450, count: 10, columns: 5 },
                ),
                attack(
                    85_000,
                    { type: 'acorn', x: 1200, y: 1350, count: 4, columns: 2, spacing: 40 },
                    { type: 'pea', x: 900, y: 1450, count: 10, columns: 5 },
                    { type: 'pea', x: 1500, y: 1450, count: 6, columns: 3 },
                ),
                attack(
                    110_000,
                    { type: 'acorn', x: 1200, y: 1350, count: 4, columns: 2, spacing: 40 },
                    { type: 'pea', x: 900, y: 1450, count: 12, columns: 6 },
                    { type: 'pea', x: 1500, y: 1450, count: 10, columns: 5 },
                ),
                attack(
                    130_000,
                    { type: 'acorn', x: 1200, y: 1350, count: 6, columns: 3, spacing: 40 },
                    { type: 'pea', x: 900, y: 1450, count: 14, columns: 7 },
                    { type: 'pea', x: 1500, y: 1450, count: 14, columns: 7 },
                ),
            ],
        },
    },
    {
        id: 'basic-corn',
        tier: 'basic-units',
        map: 'causeway-flats',
        enemyPacing: pacing(30_000, 'basic-units'),
        title: '옥수수 · 넘겨 던지는 폭발',
        briefing:
            '옥수수 알은 떨어진 뒤 터져 둘레를 함께 맞혀요. 콩 앞줄 뒤에서 뭉쳐 선 수비대에 던지세요.',
        deck: ['corn', 'pea'],
        enemyDeck: ['pea', 'rice'],
        enemyOutposts: ['natural-2', 'rear-2'],
        friendlyOutposts: ['natural-1', 'oil-1'],
        startingLaunchRangeLevel: 1,
        seed: 146,
        mode: 'eliminate',
        mission: {
            startingPremium: [premiumFor('corn') * 4, 0],
            formations: [
                { type: 'pea', x: 2850, y: 1400, count: 12, columns: 6, spacing: 24, hold: true },
                { type: 'rice', x: 2600, y: 1250, count: 20, columns: 10, spacing: 22, hold: true },
            ],
        },
    },
    {
        id: 'basic-acorn',
        tier: 'basic-units',
        enemyPacing: pacing(25_000, 'basic-units'),
        title: '도토리 · 회전으로 쓸기',
        briefing:
            '도토리는 제자리에서 돌며 둘레의 적을 한꺼번에 쳐요. 몰려든 쌀·조 떼 한가운데에 내리세요.',
        deck: ['acorn', 'pea'],
        enemyDeck: ['rice', 'millet'],
        enemyOutposts: ['enemy-front', 'enemy-rear'],
        friendlyOutposts: ['oil'],
        seed: 147,
        mode: 'eliminate',
        layout: { guestY: 900 },
        mission: {
            startingPremium: [premiumFor('acorn') * 4, 0],
            formations: [
                { type: 'rice', x: 1250, y: 1650, count: 20, columns: 10, spacing: 26, hold: true },
                {
                    type: 'millet',
                    x: 1000,
                    y: 1400,
                    count: 20,
                    columns: 10,
                    spacing: 26,
                    hold: true,
                },
            ],
        },
    },
    {
        id: 'basic-sunflower-seed',
        tier: 'basic-units',
        map: 'kings-hill',
        enemyPacing: pacing(25_000, 'basic-units'),
        title: '해바라기씨 · 하늘 쏘기',
        briefing:
            '민들레씨는 날아서 벽을 넘어요. 해바라기씨는 나는 적을 먼저 두 배로 쏘니 우리 거점 앞에 세우세요.',
        deck: ['sunflower-seed', 'rice'],
        enemyDeck: ['dandelion'],
        enemyOutposts: ['natural-2'],
        friendlyOutposts: ['natural-1', 'oil-1'],
        startingLaunchRangeLevel: 1,
        seed: 148,
        mode: 'eliminate',
        mission: {
            startingPremium: [premiumFor('sunflower-seed') * 4, 0],
        },
    },
    {
        id: 'coconut-lanes',
        tier: 'new-units',
        group: 'coconut',
        enemyPacing: pacing(30_000, 'new-units'),
        title: '코코넛 · 볼링 레인',
        briefing: '코코넛은 날아간 방향으로 굴러요. 줄지어 선 쌀 수비대를 옆으로 쓸어 보세요.',
        deck: ['coconut', 'rice'],
        enemyDeck: ['millet'],
        enemyOutposts: ['enemy-front'],
        friendlyOutposts: ['advance', 'oil'],
        seed: 120,
        mode: 'eliminate',
        layout: { guestY: 900 },
        mission: {
            startingPremium: [premiumFor('coconut') * 4, 0],
            formations: [
                { type: 'rice', x: 1100, y: 1650, count: 12, columns: 12, spacing: 28, hold: true },
                { type: 'rice', x: 1350, y: 1400, count: 12, columns: 12, spacing: 28, hold: true },
                { type: 'rice', x: 1100, y: 1180, count: 12, columns: 12, spacing: 28, hold: true },
            ],
        },
    },
    {
        id: 'coconut-heavy-wall',
        tier: 'new-units',
        group: 'coconut',
        enemyPacing: pacing(25_000, 'new-units'),
        title: '코코넛 · 무거운 벽',
        briefing: '굴러오는 코코넛은 무거운 도토리로 받아 멈추고 밤톨 가시로 체력을 깎으세요.',
        deck: ['acorn', 'chestnut', 'pea'],
        enemyDeck: ['coconut', 'pea'],
        enemyOutposts: ['enemy-front', 'enemy-rear', 'enemy-oil'],
        friendlyOutposts: ['oil'],
        startingLaunchRangeLevel: 1,
        seed: 121,
        mode: 'eliminate',
        layout: { guestY: 850 },
        mission: {
            startingPremium: [premiumFor('acorn') * 2, premiumFor('coconut') * 2],
        },
    },
    {
        id: 'black-bean-chain',
        tier: 'new-units',
        group: 'black-bean',
        enemyPacing: pacing(30_000, 'new-units'),
        title: '검은콩 · 징검다리 대포',
        briefing: '검은콩은 싸운 뒤 앞쪽 대포로 돌아가 다시 날아가요. 거점을 이어 멀리 보내세요.',
        deck: ['black-bean', 'rice'],
        enemyDeck: ['rice', 'millet'],
        enemyOutposts: ['enemy-front', 'enemy-rear', 'enemy-oil'],
        friendlyOutposts: ['advance', 'center', 'oil'],
        seed: 122,
        mode: 'eliminate',
        layout: { guestY: 500 },
        mission: {
            startingPremium: [premiumFor('black-bean') * 3, 0],
            formations: [
                { type: 'rice', x: 1250, y: 1250, count: 10, columns: 5, hold: true },
                { type: 'rice', x: 1700, y: 1000, count: 10, columns: 5, hold: true },
            ],
        },
    },
    {
        id: 'black-bean-muzzle',
        tier: 'new-units',
        group: 'black-bean',
        enemyPacing: pacing(25_000, 'new-units'),
        title: '검은콩 · 포구를 막아라',
        briefing: '찹쌀이 붙은 대포에는 검은콩이 다시 타지 못해요. 앞쪽 적 거점 포구부터 막으세요.',
        deck: ['sticky-rice', 'rice', 'peanut'],
        enemyDeck: ['black-bean', 'rice'],
        enemyOutposts: ['enemy-front', 'enemy-rear', 'enemy-ridge', 'enemy-oil'],
        friendlyOutposts: ['oil'],
        startingLaunchRangeLevel: 1,
        seed: 123,
        mode: 'eliminate',
        layout: { guestY: 820, front: { x: 1000, y: 1250 } },
        mission: {
            startingPremium: [premiumFor('sticky-rice') * 2, premiumFor('black-bean') * 2],
        },
    },
    {
        id: 'potato-battery',
        tier: 'new-units',
        group: 'potato',
        enemyPacing: pacing(30_000, 'new-units'),
        title: '감자 · 전진 포대',
        briefing: '멀리 있는 적 본진은 감자로 대포를 세워 가며 닿게 하세요.',
        deck: ['potato', 'rice'],
        enemyDeck: ['pea', 'rice'],
        enemyOutposts: ['enemy-front', 'enemy-rear', 'enemy-oil'],
        friendlyOutposts: ['oil'],
        seed: 124,
        mode: 'eliminate',
        layout: { guestY: 400 },
        mission: {
            startingPremium: [premiumFor('potato') * 4, 0],
            formations: [{ type: 'pea', x: 1475, y: 1500, count: 8, columns: 4, hold: true }],
        },
    },
    {
        id: 'potato-uproot',
        tier: 'new-units',
        group: 'potato',
        enemyPacing: pacing(25_000, 'new-units'),
        title: '감자 · 뿌리 뽑기',
        briefing: '감자는 내려앉고 5초 뒤 대포가 돼요. 뿌리내리는 동안 쌀을 쏘아 끊으세요.',
        deck: ['rice', 'millet'],
        enemyDeck: ['potato', 'pea'],
        enemyOutposts: ['enemy-front', 'enemy-oil'],
        seed: 125,
        mode: 'eliminate',
        layout: { guestY: 600 },
        mission: {
            startingPremium: [0, premiumFor('potato') * 4],
        },
    },
    {
        id: 'sticky-rice-seal',
        tier: 'new-units',
        group: 'sticky-rice',
        enemyPacing: pacing(40_000, 'new-units'),
        title: '찹쌀 · 포문 봉쇄',
        briefing: '찹쌀로 적 거점 포구를 막아 포탑을 멈추고, 그 틈에 땅콩으로 부수세요.',
        deck: ['sticky-rice', 'peanut', 'rice'],
        enemyDeck: ['rice', 'peanut'],
        enemyOutposts: ['enemy-front', 'enemy-ridge', 'enemy-oil'],
        friendlyOutposts: ['oil'],
        startingLaunchRangeLevel: 1,
        seed: 126,
        mode: 'eliminate',
        layout: { guestY: 870 },
        mission: {
            startingPremium: [premiumFor('sticky-rice') * 4, 0],
        },
    },
    {
        id: 'sticky-rice-guard',
        tier: 'new-units',
        group: 'sticky-rice',
        enemyPacing: pacing(15_000, 'new-units'),
        title: '찹쌀 · 거점 수비',
        briefing: '찹쌀은 병사를 때리지 않아요. 거점 옆에 콩을 세워 포구에 붙기 전에 막으세요.',
        deck: ['pea', 'chestnut'],
        enemyDeck: ['sticky-rice', 'millet'],
        enemyOutposts: ['enemy-front', 'enemy-rear', 'enemy-oil'],
        friendlyOutposts: ['advance', 'oil'],
        seed: 127,
        mode: 'eliminate',
        layout: { guestY: 700 },
        mission: {
            startingPremium: [premiumFor('chestnut') * 2, premiumFor('sticky-rice') * 4],
        },
    },
    {
        id: 'dandelion-over-wall',
        tier: 'new-units',
        group: 'dandelion',
        map: 'twin-gates',
        enemyPacing: pacing(30_000, 'new-units'),
        title: '민들레씨 · 벽 너머로',
        briefing:
            '쌀은 바위벽을 돌아가지만 민들레씨는 벽을 넘어 날아가요. 밤톨·옥수수 포대 곁에 내려앉아 바짝 붙어 싸우세요.',
        deck: ['dandelion', 'rice'],
        enemyDeck: ['chestnut', 'corn'],
        enemyOutposts: ['natural-2', 'oil-2'],
        friendlyOutposts: ['natural-1'],
        startingLaunchRangeLevel: 1,
        seed: 128,
        mode: 'eliminate',
        mission: {
            startingPremium: [0, premiumFor('chestnut') * 2 + premiumFor('corn')],
            formations: [
                { type: 'chestnut', x: 2300, y: 1450, count: 10, columns: 5, hold: true },
                { type: 'corn', x: 2750, y: 2050, count: 6, columns: 3, hold: true },
            ],
        },
    },
    {
        id: 'dandelion-sky-guard',
        tier: 'new-units',
        group: 'dandelion',
        map: 'wind-ravines',
        enemyPacing: pacing(25_000, 'new-units'),
        title: '민들레씨 · 하늘 지키기',
        briefing:
            '민들레씨는 골짜기 벽을 넘어 날아와요. 나는 동안 해바라기씨로 떨어뜨리고, 내려앉은 적은 콩으로 막으세요.',
        deck: ['sunflower-seed', 'pea'],
        enemyDeck: ['dandelion', 'rice'],
        enemyOutposts: ['natural-2', 'ravine-2', 'oil-2'],
        friendlyOutposts: ['natural-1', 'oil-1'],
        startingLaunchRangeLevel: 1,
        seed: 129,
        mode: 'eliminate',
        mission: {
            startingPremium: [premiumFor('sunflower-seed') * 3, 0],
        },
    },
    {
        id: 'chili-alley',
        tier: 'new-units',
        group: 'chili',
        enemyPacing: defendPacing(30_000, 25_000),
        title: '고추 · 불길 골목',
        briefing: '콩 앞줄 뒤에서 고추 불줄기로 몰려오는 조 떼를 태우세요.',
        deck: ['chili', 'pea'],
        enemyDeck: ['millet', 'redbean'],
        enemyOutposts: ['enemy-front', 'enemy-rear'],
        friendlyOutposts: ['oil'],
        seed: 130,
        mode: 'defend',
        mission: {
            startingPremium: [premiumFor('chili') * 3, 0],
            formations: [
                { type: 'pea', x: 1200, y: 2150, count: 12, columns: 6, side: 0, hold: true },
            ],
            surviveMs: 150_000,
            guardPoint: 'oil',
            waves: [
                attack(8_000, { type: 'millet', x: 1200, y: 1650, count: 8, columns: 4 }),
                attack(
                    30_000,
                    { type: 'millet', x: 1000, y: 1650, count: 10, columns: 5 },
                    { type: 'redbean', x: 1400, y: 1700, count: 2, columns: 2 },
                ),
                attack(
                    55_000,
                    { type: 'millet', x: 1200, y: 1650, count: 14, columns: 7 },
                    { type: 'redbean', x: 1400, y: 1700, count: 3, columns: 3 },
                ),
                attack(
                    80_000,
                    { type: 'millet', x: 1000, y: 1650, count: 16, columns: 4 },
                    { type: 'redbean', x: 1400, y: 1700, count: 4, columns: 2 },
                ),
                attack(
                    105_000,
                    { type: 'millet', x: 1200, y: 1600, count: 20, columns: 5 },
                    { type: 'redbean', x: 1200, y: 1750, count: 5, columns: 5 },
                ),
                attack(
                    128_000,
                    { type: 'millet', x: 1000, y: 1600, count: 14, columns: 7 },
                    { type: 'millet', x: 1400, y: 1600, count: 14, columns: 7 },
                    { type: 'redbean', x: 1200, y: 1750, count: 8, columns: 4 },
                ),
            ],
        },
    },
    {
        id: 'chili-flank',
        tier: 'new-units',
        group: 'chili',
        enemyPacing: pacing(25_000, 'new-units'),
        title: '고추 · 넘기고 돌아가기',
        briefing:
            '고추는 정면만 태우고 천천히 돌아요. 옥수수 알을 불줄기 너머로 던지고, 조로 옆과 뒤를 치세요.',
        deck: ['corn', 'millet'],
        enemyDeck: ['chili'],
        enemyOutposts: ['enemy-front', 'enemy-rear', 'enemy-oil'],
        friendlyOutposts: ['oil'],
        seed: 131,
        mode: 'eliminate',
        layout: { guestY: 850 },
        mission: {
            startingPremium: [premiumFor('corn') * 4, premiumFor('chili') * 2],
            formations: [
                { type: 'chili', x: 900, y: 1550, count: 3, columns: 3, hold: true },
                { type: 'chili', x: 1200, y: 1650, count: 3, columns: 3, hold: true },
                { type: 'chili', x: 1500, y: 1550, count: 3, columns: 3, hold: true },
            ],
        },
    },
    {
        id: 'cotton-storm',
        tier: 'new-units',
        group: 'cotton',
        enemyPacing: defendPacing(30_000, 25_000),
        title: '목화솜 · 번개 사슬',
        briefing:
            '목화솜 번개는 뭉친 적 넷까지 튀어요. 콩 앞줄 뒤에 목화솜을 세우고 몰려오는 쌀·조 떼에 번개를 이으세요.',
        deck: ['cotton', 'pea'],
        enemyDeck: ['rice', 'millet'],
        enemyOutposts: ['enemy-front', 'enemy-rear'],
        friendlyOutposts: ['advance', 'oil'],
        seed: 132,
        mode: 'defend',
        mission: {
            startingPremium: [premiumFor('cotton') * 5, 0],
            surviveMs: 165_000,
            guardPoint: 'advance',
            waves: [
                attack(10_000, { type: 'rice', x: 1200, y: 1600, count: 8, columns: 4 }),
                attack(
                    35_000,
                    { type: 'millet', x: 950, y: 1600, count: 8, columns: 4 },
                    { type: 'rice', x: 1450, y: 1650, count: 8, columns: 4 },
                ),
                attack(
                    60_000,
                    { type: 'rice', x: 1000, y: 1600, count: 12, columns: 4 },
                    { type: 'millet', x: 1400, y: 1550, count: 10, columns: 5 },
                ),
                attack(
                    90_000,
                    { type: 'rice', x: 1000, y: 1600, count: 14, columns: 7 },
                    { type: 'millet', x: 1400, y: 1550, count: 14, columns: 7 },
                ),
                attack(
                    120_000,
                    { type: 'rice', x: 1000, y: 1600, count: 18, columns: 6 },
                    { type: 'millet', x: 1400, y: 1550, count: 18, columns: 6 },
                ),
                attack(
                    145_000,
                    { type: 'rice', x: 1000, y: 1600, count: 18, columns: 6 },
                    { type: 'millet', x: 1250, y: 1550, count: 24, columns: 6 },
                    { type: 'rice', x: 1500, y: 1600, count: 18, columns: 6 },
                ),
            ],
        },
    },
    {
        id: 'cotton-sky',
        tier: 'new-units',
        group: 'cotton',
        map: 'twin-gates',
        enemyPacing: pacing(25_000, 'new-units'),
        title: '목화솜 · 하늘까지',
        briefing:
            '목화솜 번개는 나는 민들레씨에도 닿아요. 바위벽을 넘어오는 민들레씨를 콩 앞줄 뒤에서 번개로 떨어뜨리세요.',
        deck: ['cotton', 'pea'],
        enemyDeck: ['dandelion', 'rice'],
        enemyOutposts: ['natural-2'],
        friendlyOutposts: ['natural-1', 'oil-1'],
        startingLaunchRangeLevel: 1,
        seed: 133,
        mode: 'eliminate',
        mission: {
            startingPremium: [premiumFor('cotton') * 4, 0],
            formations: [{ type: 'rice', x: 2300, y: 1450, count: 10, columns: 5, hold: true }],
        },
    },
    {
        id: 'cotton-outrange',
        tier: 'new-units',
        group: 'cotton',
        enemyPacing: pacing(30_000, 'new-units'),
        title: '목화솜 · 사거리 밖에서',
        briefing:
            '목화솜은 사거리 250이에요. 사거리 300 해바라기씨로 밖에서 쏘고, 번개가 닿으면 튼튼한 콩이 버티세요.',
        deck: ['sunflower-seed', 'pea'],
        enemyDeck: ['cotton', 'rice'],
        enemyOutposts: ['enemy-front', 'enemy-rear', 'enemy-oil'],
        friendlyOutposts: ['oil'],
        seed: 134,
        mode: 'eliminate',
        layout: { guestY: 850 },
        mission: {
            startingPremium: [premiumFor('sunflower-seed') * 3, premiumFor('cotton') * 3],
            formations: [
                { type: 'rice', x: 1200, y: 1500, count: 10, columns: 5, hold: true },
                { type: 'cotton', x: 1000, y: 1650, count: 4, columns: 4, hold: true },
                { type: 'cotton', x: 1400, y: 1650, count: 4, columns: 4, hold: true },
            ],
        },
    },
    {
        id: 'sesame-builders',
        tier: 'new-units',
        group: 'sesame',
        enemyPacing: pacing(45_000, 'new-units'),
        title: '참깨 · 뚝딱 일꾼',
        briefing:
            '참깨는 건설이 두 배 빠르고 짓는 동안 덜 다쳐요. 빈 거점에 참깨를 내려 서둘러 세우고, 쌀로 적을 막으세요.',
        deck: ['sesame', 'rice'],
        enemyDeck: ['rice'],
        enemyOutposts: ['enemy-front'],
        seed: 135,
        mode: 'eliminate',
        layout: { guestY: 700 },
        mission: {
            formations: [{ type: 'rice', x: 1000, y: 1250, count: 6, columns: 3, hold: true }],
        },
    },
    {
        id: 'buckwheat-volley',
        tier: 'new-units',
        group: 'buckwheat',
        enemyPacing: defendPacing(30_000, 25_000),
        title: '메밀 · 씨앗 세례',
        briefing:
            '메밀은 몸이 약해도 20명이 씨앗을 쏟아부어요. 콩 앞줄 뒤에 메밀을 세우고 몰려오는 쌀 떼와 밤톨을 쓸어내세요.',
        deck: ['buckwheat', 'pea'],
        enemyDeck: ['rice', 'chestnut'],
        enemyOutposts: ['enemy-front', 'enemy-rear'],
        friendlyOutposts: ['advance', 'oil'],
        seed: 136,
        mode: 'defend',
        mission: {
            surviveMs: 180_000,
            guardPoint: 'advance',
            waves: [
                attack(10_000, { type: 'rice', x: 1200, y: 1600, count: 8, columns: 4 }),
                attack(
                    38_000,
                    { type: 'rice', x: 1000, y: 1600, count: 10, columns: 5 },
                    { type: 'chestnut', x: 1450, y: 1650, count: 2, columns: 2, spacing: 36 },
                ),
                attack(
                    66_000,
                    { type: 'rice', x: 1000, y: 1600, count: 14, columns: 7 },
                    { type: 'chestnut', x: 1450, y: 1650, count: 2, columns: 2, spacing: 36 },
                ),
                attack(
                    94_000,
                    { type: 'rice', x: 1000, y: 1600, count: 16, columns: 4 },
                    { type: 'chestnut', x: 1450, y: 1650, count: 3, columns: 3, spacing: 36 },
                ),
                attack(
                    122_000,
                    { type: 'rice', x: 1000, y: 1600, count: 20, columns: 5 },
                    { type: 'chestnut', x: 1450, y: 1650, count: 4, columns: 2, spacing: 36 },
                ),
                attack(
                    150_000,
                    { type: 'rice', x: 950, y: 1600, count: 22, columns: 6 },
                    { type: 'chestnut', x: 1250, y: 1650, count: 6, columns: 3, spacing: 36 },
                    { type: 'rice', x: 1550, y: 1600, count: 22, columns: 6 },
                ),
            ],
        },
    },
    {
        id: 'buckwheat-rush',
        tier: 'new-units',
        group: 'buckwheat',
        enemyPacing: pacing(40_000, 'new-units'),
        title: '메밀 · 붙으면 끝',
        briefing:
            '메밀은 멀리서 쏘지만 몸이 약해요. 빠른 조를 메밀 수비대 바로 옆에 내려 붙고, 콩으로 씨앗을 받아내세요.',
        deck: ['millet', 'pea'],
        enemyDeck: ['buckwheat', 'rice'],
        enemyOutposts: ['enemy-front', 'enemy-rear'],
        friendlyOutposts: ['advance', 'center'],
        seed: 137,
        mode: 'eliminate',
        layout: { guestY: 700 },
        mission: {
            formations: [
                { type: 'buckwheat', x: 1000, y: 1250, count: 20, columns: 5, hold: true },
                { type: 'buckwheat', x: 1450, y: 1150, count: 10, columns: 5, hold: true },
                { type: 'rice', x: 1250, y: 1300, count: 8, columns: 4, hold: true },
            ],
        },
    },
]);
// The new campaign (재구성 초안 docs/campaign-stage-draft): act 1 in order, then act 2's three regions (a stage of
// act 2 also declares `region`, campaign-pace.js), then act 3. Which stage is open is computed from these
// declarations and the roster's cleared stages (src/ui/campaign-acts.js); a region with no stage here does not show.
// Every stage of it declares its story for the briefing and the result: `story.text` the one-line story and
// `story.captain` the captain's line, shown together (no dialogue to step through).
export const CAMPAIGN_REGIONS = Object.freeze([
    { id: 'nut-forest', title: '견과 숲', blurb: '단단한 껍질들이 깜부기에 갇혔어요.' },
    { id: 'field-town', title: '밭 마을', blurb: '밭 곡식들이 깜부기 장단에 춤춰요.' },
    { id: 'wind-hill', title: '바람 언덕', blurb: '바람 타고 포자가 날아다녀요.' },
]);
export const CAMPAIGN_ACT_STAGES = Object.freeze([
    {
        id: 'paddy-first-shot',
        act: 1,
        map: 'small-field',
        title: '첫 발사',
        story: {
            text: '정찰병이 첫 대포 투입으로 길을 연다.',
            captain: '착지는 네 몫이다. 발사는 내 공이다!',
        },
        deck: ['rice'],
        enemyDeck: ['rice'],
        rewardCard: 'rice',
        enemyOutposts: [],
        seed: 200,
        blight: true,
        enemyPacing: defendPacing(45_000, 30_000),
        practice: {
            card: 'rice',
            cue: '쌀을 쏴서 깜부기 쌀 셋을 쓰러뜨려요',
            targets: [{ type: 'rice', x: 800, y: 3290, count: 3, columns: 3 }],
        },
        mission: { firstCapture: 'natural-1' },
        sideGoal: { kind: 'withinMs', ms: 300_000 },
    },
    {
        id: 'paddy-stained-beans',
        act: 1,
        map: 'small-field',
        title: '물든 콩밭',
        story: {
            text: '콩밭의 포자 주머니를 깨자 콩들이 돌아온다.',
            captain: '콩 심은 데 콩 나고, 주머니 깬 데 지원군 난다!',
        },
        deck: ['pea', 'rice'],
        enemyDeck: ['rice', 'millet'],
        rewardCard: 'pea',
        enemyOutposts: ['natural-2'],
        friendlyOutposts: ['natural-1'],
        seed: 201,
        blight: true,
        enemyPacing: defendPacing(30_000, 25_000),
        practice: {
            card: 'pea',
            cue: '콩을 쏴서 깜부기 조 여덟을 한꺼번에 맞혀요',
            targets: [{ type: 'millet', x: 800, y: 3290, count: 8, columns: 4 }],
        },
        mission: {
            waves: [attack(10_000, { type: 'rice', x: 1600, y: 1500, count: 12, columns: 4 })],
        },
        sporeSacs: [{ x: 1200, y: 2200, captives: [{ type: 'pea', count: 12 }] }],
        sideGoal: { kind: 'freeCaptives', count: 12 },
    },
    {
        id: 'paddy-redbean-pass',
        act: 1,
        map: 'twin-gates',
        title: '팥죽 고개',
        story: {
            text: '고개 뒤 포대를 팥이 뛰어넘어 덮친다.',
            captain: '고개는 숙이지 말고, 넘어가!',
        },
        deck: ['redbean', 'rice', 'pea'],
        enemyDeck: ['sunflower-seed', 'chestnut'],
        rewardCard: 'redbean',
        enemyOutposts: ['natural-2'],
        friendlyOutposts: ['natural-1'],
        startingLaunchRangeLevel: 1,
        seed: 202,
        blight: true,
        enemyPacing: defendPacing(30_000, 25_000),
        practice: {
            card: 'redbean',
            cue: '팥을 해바라기씨 바로 앞에 떨어뜨려 덮쳐요',
            targets: [{ type: 'sunflower-seed', x: 560, y: 3200, count: 2, columns: 2 }],
        },
        mission: {
            startingPremium: [0, premiumFor('sunflower-seed') * 3 + premiumFor('chestnut') * 2],
            waves: [
                attack(1_000, {
                    type: 'sunflower-seed',
                    x: 480,
                    y: 1150,
                    count: 4,
                    columns: 4,
                    hold: true,
                }),
            ],
        },
        sideGoal: { kind: 'withinMs', ms: 240_000 },
    },
    {
        id: 'paddy-hold-the-line',
        act: 1,
        map: 'small-field',
        title: '논두렁 사수',
        story: {
            text: '바람을 타고 온 첫 포자 구름을 막는다.',
            captain: '하늘에서 오는 건 비만인 줄 알았는데!',
        },
        deck: ['millet', 'pea', 'redbean', 'rice'],
        enemyDeck: ['corn', 'rice'],
        rewardCard: 'millet',
        enemyOutposts: [],
        friendlyOutposts: ['west-1'],
        seed: 203,
        blight: true,
        enemyPacing: SCRIPTED_ONLY,
        practice: {
            card: 'millet',
            cue: '빠른 조를 옥수수 바로 옆에 내려 들이받아요',
            targets: [{ type: 'corn', x: 800, y: 3290, count: 2, columns: 2, spacing: 40 }],
        },
        mission: { surviveMs: 120_000, guardPoint: 'west-1', waves: [] },
        // Three attacks from three ways, each announced 5 s ahead, on the low ground before the guarded hill's north
        // and east ramps; all three places sit in the opening view.
        sporeClouds: [
            sporeAttack(20_000, 340, 1500),
            sporeAttack(50_000, 590, 1490),
            sporeAttack(80_000, 910, 1930),
        ],
        sideGoal: { kind: 'keepAlive', hpRatio: 0.5, point: 'west-1' },
    },
]);
// One announced attack of act 1's defence: corn 2 and rice 6 brought by a spore cloud that comes once.
function sporeAttack(atMs, x, y) {
    return {
        atMs,
        everyMs: atMs,
        warnMs: 5_000,
        times: 1,
        formations: [
            { type: 'corn', x, y: y - 40, count: 2, columns: 2, spacing: 40 },
            { type: 'rice', x, y: y + 30, count: 6, columns: 3 },
        ],
    };
}
export function campaignStage(id) {
    return (
        CAMPAIGN_STAGES.find((stage) => stage.id === id) ||
        CAMPAIGN_ACT_STAGES.find((stage) => stage.id === id) ||
        null
    );
}
