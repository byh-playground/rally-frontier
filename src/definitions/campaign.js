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
    { id: 'walnut', title: '호두', art: 'walnut' },
    { id: 'black-bean', title: '검은콩', art: 'black-bean' },
    { id: 'potato', title: '감자', art: 'potato' },
    { id: 'sticky-rice', title: '찹쌀', art: 'sticky-rice' },
    { id: 'dandelion', title: '민들레씨', art: 'dandelion' },
    { id: 'chili', title: '고추', art: 'chili' },
    { id: 'cotton', title: '목화솜', art: 'cotton' },
]);
export function campaignTier(id) {
    return CAMPAIGN_TIERS.find((tier) => tier.id === id) || null;
}
// From the basic-unit chapter on, every stage is built for the player to win: the player's deck counters the
// enemy deck, and the enemy deck carries no counter of the player's cards. Each basic-unit stage introduces
// its first card (`deck[0]`) against the enemy it beats. The new-unit chapter pairs "써 보기" (the unit in the
// player's deck) with "상대하기" (the unit in the enemy deck) for each unit group; inside that chapter no two
// stages' enemy decks share more than one card, except the rice·millet swarm that black-bean-chain and
// cotton-storm both face. A stage with `map` (a PvP preset of game-rules.js) names that map's capture points.
const pacing = (firstDecisionMs, tierId) =>
    Object.freeze({
        firstDecisionMs,
        endIntervalMs: campaignTier(tierId).endIntervalMs,
        rampMs: RAMP_MS,
    });
const SCRIPTED_ONLY = Object.freeze({ disabled: true });
const premiumFor = (type) => LaunchRules.payload(type).premiumCost;

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
        briefing: '수박을 쏘고 스킬을 쓴 뒤, 복귀시켜 다시 출격하세요.',
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
        briefing: '줄지어 선 적에게 왕복하는 부메랑을 던져 보세요.',
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
        title: '영웅 획득 · 포도알 연사',
        briefing: '모여 있는 적을 향해 포도알을 연달아 던져 보세요.',
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
        enemyPacing: SCRIPTED_ONLY,
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
            waves: [
                {
                    delayMs: 4000,
                    formations: [{ type: 'rice', x: 1150, y: 1650, count: 20, columns: 5 }],
                },
                {
                    delayMs: 8000,
                    formations: [
                        { type: 'rice', x: 900, y: 1650, count: 20, columns: 5 },
                        { type: 'millet', x: 1400, y: 1600, count: 20, columns: 5 },
                    ],
                },
                {
                    delayMs: 8000,
                    formations: [
                        { type: 'millet', x: 950, y: 1600, count: 20, columns: 5 },
                        { type: 'rice', x: 1250, y: 1650, count: 30, columns: 6 },
                        { type: 'millet', x: 1550, y: 1550, count: 20, columns: 5 },
                    ],
                },
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
        enemyPacing: SCRIPTED_ONLY,
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
            waves: [
                {
                    delayMs: 4000,
                    formations: [{ type: 'pea', x: 1200, y: 1450, count: 12, columns: 6 }],
                },
                {
                    delayMs: 10000,
                    formations: [
                        { type: 'acorn', x: 1000, y: 1400, count: 4, columns: 2, spacing: 40 },
                        { type: 'pea', x: 1400, y: 1450, count: 12, columns: 6 },
                    ],
                },
                {
                    delayMs: 10000,
                    formations: [
                        { type: 'acorn', x: 1200, y: 1350, count: 6, columns: 3, spacing: 40 },
                        { type: 'pea', x: 900, y: 1450, count: 12, columns: 6 },
                        { type: 'pea', x: 1500, y: 1450, count: 12, columns: 6 },
                    ],
                },
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
        id: 'walnut-lanes',
        tier: 'new-units',
        group: 'walnut',
        enemyPacing: pacing(30_000, 'new-units'),
        title: '호두 · 볼링 레인',
        briefing: '호두는 날아간 방향으로 굴러요. 줄지어 선 쌀 수비대를 옆으로 쓸어 보세요.',
        deck: ['walnut', 'rice'],
        enemyDeck: ['millet'],
        enemyOutposts: ['enemy-front'],
        friendlyOutposts: ['advance', 'oil'],
        seed: 120,
        mode: 'eliminate',
        layout: { guestY: 900 },
        mission: {
            startingPremium: [premiumFor('walnut') * 4, 0],
            formations: [
                { type: 'rice', x: 1100, y: 1650, count: 12, columns: 12, spacing: 28, hold: true },
                { type: 'rice', x: 1350, y: 1400, count: 12, columns: 12, spacing: 28, hold: true },
                { type: 'rice', x: 1100, y: 1180, count: 12, columns: 12, spacing: 28, hold: true },
            ],
        },
    },
    {
        id: 'walnut-heavy-wall',
        tier: 'new-units',
        group: 'walnut',
        enemyPacing: pacing(25_000, 'new-units'),
        title: '호두 · 무거운 벽',
        briefing: '굴러오는 호두는 무거운 도토리로 받아 멈추고 밤톨 가시로 체력을 깎으세요.',
        deck: ['acorn', 'chestnut', 'pea'],
        enemyDeck: ['walnut', 'pea'],
        enemyOutposts: ['enemy-front', 'enemy-rear', 'enemy-oil'],
        friendlyOutposts: ['oil'],
        startingLaunchRangeLevel: 1,
        seed: 121,
        mode: 'eliminate',
        layout: { guestY: 850 },
        mission: {
            startingPremium: [premiumFor('acorn') * 2, premiumFor('walnut') * 2],
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
        enemyPacing: SCRIPTED_ONLY,
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
            waves: [
                {
                    delayMs: 3000,
                    formations: [{ type: 'millet', x: 1200, y: 1650, count: 20, columns: 5 }],
                },
                {
                    delayMs: 6000,
                    formations: [
                        { type: 'millet', x: 1000, y: 1650, count: 20, columns: 5 },
                        { type: 'redbean', x: 1400, y: 1700, count: 6, columns: 3 },
                    ],
                },
                {
                    delayMs: 6000,
                    formations: [
                        { type: 'millet', x: 1200, y: 1600, count: 30, columns: 6 },
                        { type: 'redbean', x: 1200, y: 1750, count: 10, columns: 5 },
                    ],
                },
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
        enemyPacing: SCRIPTED_ONLY,
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
            waves: [
                {
                    delayMs: 5000,
                    formations: [{ type: 'rice', x: 1200, y: 1600, count: 20, columns: 5 }],
                },
                {
                    delayMs: 8000,
                    formations: [
                        { type: 'millet', x: 950, y: 1600, count: 20, columns: 5 },
                        { type: 'rice', x: 1450, y: 1650, count: 20, columns: 5 },
                    ],
                },
                {
                    delayMs: 8000,
                    formations: [
                        { type: 'rice', x: 1000, y: 1600, count: 25, columns: 5 },
                        { type: 'millet', x: 1250, y: 1550, count: 25, columns: 5 },
                        { type: 'rice', x: 1500, y: 1600, count: 25, columns: 5 },
                    ],
                },
            ],
        },
    },
]);
export function campaignStage(id) {
    return CAMPAIGN_STAGES.find((stage) => stage.id === id) || null;
}
