// The campaign: three acts of stages (CAMPAIGN_ACT_STAGES), the regions of act 2 (CAMPAIGN_REGIONS). Timing and
// map seeds are provisional play-test values.
import { LaunchRules } from '../sim/launch-rules.js';

// A stage whose whole pressure is scripted attacks and clouds keeps the enemy AI off (`enemyPacing: SCRIPTED_ONLY`);
// every other stage's enemy plays as the match AI does, and the difficulty is its income rate (campaign-pace.js).
const SCRIPTED_ONLY = Object.freeze({ disabled: true });
// One scripted attack of a survival defence: it is fired `atMs` after the match starts, whatever is still standing, by the
// enemy's main cannon at each formation's place (CampaignMission.launchWave; a `hold` garrison is placed on the ground).
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
// A practice may name an enemy outpost to bring down instead of (or beside) soldier targets: `building: '<point id>'`, a
// point of `enemyOutposts` (nuts-crack-the-gate: peanuts only attack buildings). A boss stage may declare sacs that
// bring the player reinforcements (sim/spore-sac.js): `sporeReinforceMs` and, on each sac, `reinforce: [{ type, count,
// x, y }]`; the sacs broken when that time comes bring theirs (nuts-watermelon-warden).
// A stage may declare one side goal (sim/side-goal.js), paid once with sunshine (SUNSHINE.sideGoal) beside the clear;
// winning without it is still winning. Its kinds: `{ kind: 'freeCaptives', count? }` (the spore sacs' captives freed,
// all or at least `count`), `{ kind: 'burnFields' }` (no blighted cell left), `{ kind: 'withinMs', ms }` (won within
// `ms` on the mission's clock) and `{ kind: 'keepAlive', hpRatio, point? }` (won with the main base, or the player's
// starting outpost on `point`, never below `hpRatio` of its health). `{ kind: 'lossesAtMost', count }` (won with at most `count` of the player's soldiers lost) and
// `{ kind: 'allReinforcements' }` (a boss stage's sacs all broken when its reinforcements come). The match start rejects another kind and a goal
// its stage cannot judge (captives without sacs, fields without fields, a point the player does not hold). The new
// campaign's act 1 stages declare one each.
// A stage of the new campaign declares `act` (1, 2 or 3, the act it belongs to): its won result is recorded in the
// roster (Roster.recordClear: progress, sunshine, owned cards) and the result screen shows the sunshine it paid. Those
// stages are CAMPAIGN_ACT_STAGES below.
// The new campaign (재구성 초안 docs/campaign-stage-draft): act 1 in order, then act 2's three regions (a stage of
// act 2 also declares `region`, campaign-pace.js), then act 3. Which stage is open is computed from these
// declarations and the roster's cleared stages (src/ui/campaign-acts.js); a region with no stage here does not show.
// Every stage of it declares its story for the briefing and the result: `story.text` the story line that follows the
// stage before it, `story.brief` the mission line (the rules this stage teaches; the briefing only) and
// `story.captain` the commander's one-line tip, shown together (no dialogue to step through).
export const CAMPAIGN_REGIONS = Object.freeze([
    // `theme` is the map look of the region's stages (map-themes.js); a region without one keeps its map's own.
    {
        id: 'nut-forest',
        title: '견과 숲',
        blurb: '단단한 껍질들이 깜부기에 갇혔어요.',
        theme: 'nut-forest',
    },
    {
        id: 'field-town',
        title: '밭 마을',
        blurb: '밭 곡식들이 깜부기 장단에 춤춰요.',
        theme: 'field-town',
    },
    {
        id: 'wind-hill',
        title: '바람 언덕',
        blurb: '바람 타고 포자가 날아다녀요.',
        theme: 'wind-hill',
    },
]);
export const CAMPAIGN_ACT_STAGES = Object.freeze([
    {
        id: 'paddy-first-shot',
        act: 1,
        paceScale: 0.8,
        map: 'small-field',
        title: '첫 발사',
        story: {
            text: '깜부기가 논두렁의 곡식들을 감염시켰다. 정찰병 쌀이 첫 대포 투입으로 길을 연다.',
            brief: '대포로 쏜 쌀은 적 위에 떨어지는 순간 주변 적에게 피해를 주고, 그 자리에서 병사로 싸운다. 앞 거점을 지으면 대포가 늘어난다. 거점을 지어 적 본진을 부순다.',
            captain: '발사는 병력 투입 및 수비의 핵심입니다.',
        },
        deck: ['rice'],
        enemyDeck: ['rice'],
        rewardCard: 'rice',
        enemyOutposts: [],
        seed: 200,
        blight: true,
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
            text: '첫 거점을 되찾은 부대가 콩밭에 닿는다. 콩들이 포자 주머니에 묶여 있다.',
            brief: '본진과 앞 거점의 대포 사거리가 겹치는 곳에 쏘면 대포가 최대 3문까지 함께 발사한다. 포자 주머니를 부수면 묶여 있던 콩이 아군이 된다.',
            captain: '비용은 동일하고, 대포가 한 문 더해질 때마다 총병력이 20% 늘어납니다.',
        },
        deck: ['pea', 'rice'],
        enemyDeck: ['rice', 'millet'],
        rewardCard: 'pea',
        enemyOutposts: ['natural-2'],
        friendlyOutposts: ['natural-1'],
        seed: 201,
        blight: true,
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
            text: '콩밭을 지난 부대 앞을 고개가 막아선다. 고개 뒤에 적 포대가 있다.',
            brief: '팥은 같은 자리에 세 번 연달아 떨어지고, 병사는 적에게 뛰어올라 착지하며 충격을 준다. 해바라기씨는 멀리서 쏘는 병종이라 가까이 붙어야 한다.',
            captain: '팥은 적 바로 앞에 떨어뜨리세요.',
        },
        deck: ['redbean', 'rice', 'pea'],
        enemyDeck: ['sunflower-seed', 'chestnut'],
        rewardCard: 'redbean',
        enemyOutposts: ['natural-2'],
        friendlyOutposts: ['natural-1'],
        startingLaunchRangeLevel: 1,
        seed: 202,
        blight: true,
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
            text: '고개를 넘자 바람이 포자를 실어 온다. 깜부기의 포자 구름이 처음 나타난다.',
            brief: '조는 20명이 두 곳으로 나뉘어 떨어지고 걸음이 빠르다. 포자 구름이 세 방향에서 차례로 도착하며, 5초 전에 예고 표시가 뜬다. 120초 동안 앞 거점을 지킨다.',
            captain: '구름이 내릴 자리에 포탄을 먼저 떨어뜨리세요.',
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
    {
        id: 'nuts-thorn-watch',
        act: 2,
        region: 'nut-forest',
        map: 'twin-gates',
        title: '가시 초소',
        story: {
            text: '첫 포자 구름을 막은 부대가 견과 숲 입구의 초소에 닿는다.',
            brief: '상대 진영에서 감염 병력을 아군 본진 주변에 직접 투입해 공격한다. 원거리 병종인 밤톨로 막아야 한다.',
            captain: '원거리 유닛은 모일수록 강합니다.',
        },
        deck: ['chestnut', 'pea', 'redbean', 'rice'],
        enemyDeck: ['pea', 'acorn'],
        rewardCard: 'chestnut',
        enemyOutposts: ['natural-2'],
        friendlyOutposts: ['natural-1'],
        startingLaunchRangeLevel: 1,
        seed: 204,
        blight: true,
        practice: {
            card: 'chestnut',
            cue: '밤톨을 쏴서 깜부기 콩 둘을 쓰러뜨려요',
            targets: [{ type: 'pea', x: 560, y: 3200, count: 2, columns: 2 }],
        },
        mission: { startingPremium: [premiumFor('chestnut') * 3, premiumFor('acorn') * 3] },
        sideGoal: { kind: 'lossesAtMost', count: 25 },
    },
    {
        id: 'nuts-whirling-path',
        act: 2,
        region: 'nut-forest',
        map: 'small-field',
        title: '빙글 숲길',
        story: {
            text: '초소를 지나 숲길로 들어서자 좁은 길마다 감염 병력이 떼를 지어 있다.',
            brief: '도토리는 한 발에 두 명씩, 범위가 좁아지는 3연사로 떨어진 뒤 회전하며 주변 적을 밀어낸다. 좁은 길에 뭉친 적을 노린다.',
            captain: '뭉친 적일수록 회전 한 번에 많이 맞습니다.',
        },
        deck: ['acorn', 'chestnut', 'pea', 'rice', 'redbean'],
        enemyDeck: ['rice', 'millet'],
        rewardCard: 'acorn',
        enemyOutposts: ['natural-2'],
        friendlyOutposts: ['natural-1'],
        seed: 205,
        blight: true,
        practice: {
            card: 'acorn',
            cue: '도토리를 쏴서 빽빽한 깜부기 쌀 열둘을 한꺼번에 쓸어요',
            targets: [{ type: 'rice', x: 800, y: 3290, count: 12, columns: 4 }],
        },
        mission: { startingPremium: [premiumFor('acorn') * 3 + premiumFor('chestnut') * 2, 0] },
        sideGoal: { kind: 'withinMs', ms: 240_000 },
    },
    {
        id: 'nuts-crack-the-gate',
        act: 2,
        paceScale: 0.8,
        region: 'nut-forest',
        map: 'artillery-basin',
        title: '껍질 문을 깨라',
        story: {
            text: '숲길 끝의 문 안쪽에 포로들이 갇혀 있고, 문 앞을 적 거점들이 지키고 있다.',
            brief: '땅콩은 적 병사를 공격하지 못하는 대신 건물만 노려 들이받고, 한 번의 피해가 일반 병종보다 훨씬 크다. 병사가 길을 막으면 다른 병종이 엄호해야 한다. 포자 주머니를 부수면 땅콩 포로 5명이 합류한다.',
            captain: '땅콩이 건물에 닿을 때까지 앞길을 먼저 치워 주세요.',
        },
        deck: ['peanut', 'acorn', 'chestnut', 'pea', 'rice'],
        enemyDeck: ['chestnut', 'rice'],
        rewardCard: 'peanut',
        // The first of them is the practice's building, standing in the opening view.
        enemyOutposts: [
            'basin-natural-1',
            'basin-natural-2',
            'basin-shoulder-2',
            'basin-edge-2',
            'basin-rim-2',
        ],
        friendlyOutposts: ['basin-oil-1'],
        seed: 208,
        blight: true,
        practice: {
            card: 'peanut',
            cue: '땅콩을 쏴서 깜부기가 차지한 거점을 부숴요',
            building: 'basin-natural-1',
        },
        mission: {
            startingPremium: [
                premiumFor('acorn') * 3 + premiumFor('chestnut') * 2,
                premiumFor('chestnut') * 3,
            ],
        },
        sporeSacs: [{ x: 1650, y: 3000, captives: [{ type: 'peanut', count: 5 }] }],
        sideGoal: { kind: 'freeCaptives', count: 5 },
    },
    {
        id: 'nuts-last-shell',
        act: 2,
        paceScale: 0.8,
        region: 'nut-forest',
        map: 'causeway-flats',
        title: '마지막 껍질',
        story: {
            text: '문을 지나 둑길로 나서니 길목마다 감염 밭이 번져 있다.',
            brief: '호두는 받는 피해가 절반인 탱커로, 앞줄을 맡고 맞은 적 둘레도 함께 친다. 감염 밭 위에서는 아군 지상 병력이 초당 피해를 입는다. 화로 자리를 아군이 점령하면 그 주변 밭이 정화된다.',
            captain: '호두가 버티는 동안 화로를 켜세요.',
        },
        deck: ['walnut', 'chestnut', 'peanut', 'pea', 'rice', 'redbean'],
        enemyDeck: ['rice', 'buckwheat'],
        rewardCard: 'walnut',
        enemyOutposts: ['natural-2'],
        friendlyOutposts: ['natural-1'],
        seed: 206,
        blight: true,
        practice: {
            card: 'walnut',
            cue: '단단한 호두를 메밀 앞에 내려 가시를 받아내요',
            targets: [{ type: 'buckwheat', x: 811, y: 3559, count: 3, columns: 3 }],
        },
        mission: { startingPremium: [premiumFor('chestnut') * 3, 0] },
        blightFields: [{ x: 1020, y: 1840 }],
        braziers: [{ x: 1090, y: 1930, radius: 125 }],
        sideGoal: { kind: 'burnFields' },
    },
    {
        id: 'nuts-rolling-hollow',
        act: 2,
        region: 'nut-forest',
        map: 'twin-gates',
        title: '굴러가는 골짜기',
        story: {
            text: '둑길을 되찾자 두 관문 사이 골짜기에 감염 병력이 줄지어 있다.',
            brief: '코코넛은 착지하면 발사 방향으로 굴러 가속하며 닿는 적을 쳐서 날려 보낸다. 멈춰서 싸우지 않고, 가벼운 적일수록 멀리 날아간다.',
            captain: '적이 일렬로 늘어선 곳을 향해 쏘세요.',
        },
        deck: ['coconut', 'walnut', 'chestnut', 'peanut', 'pea', 'redbean'],
        enemyDeck: ['rice', 'millet'],
        rewardCard: 'coconut',
        enemyOutposts: ['natural-2'],
        friendlyOutposts: ['natural-1'],
        startingLaunchRangeLevel: 1,
        seed: 207,
        blight: true,
        practice: {
            card: 'coconut',
            cue: '코코넛을 굴려서 길게 늘어선 깜부기 쌀을 밀어내요',
            targets: [{ type: 'rice', x: 560, y: 3200, count: 12, columns: 12, spacing: 40 }],
        },
        mission: { startingPremium: [premiumFor('coconut') * 3 + premiumFor('chestnut') * 2, 0] },
        sideGoal: { kind: 'withinMs', ms: 300_000 },
    },
    {
        id: 'nuts-watermelon-warden',
        act: 2,
        region: 'nut-forest',
        map: 'small-field',
        title: '수박 숲지기',
        story: {
            text: '견과 숲의 수호자 수박이 깜부기에 지배당해 숲 깊은 곳을 막고 있다.',
            brief: '수박 수호자는 5레벨 영웅으로, 아군 병사를 30명 쓰러뜨리면 각성한다. 포자 주머니 세 개를 75초 안에 부수면 부순 개수만큼 지원군이 온다. 수호자를 쓰러뜨리면 해방된다.',
            captain: '병력을 한꺼번에 투입하면 각성만 앞당깁니다. 나눠서 투입하세요.',
        },
        // The hero the stage frees is not lent beforehand: the guardian is its own lesson.
        deck: ['redbean', 'chestnut', 'walnut', 'peanut', 'pea', 'rice'],
        enemyDeck: ['watermelon', 'rice'],
        rewardCard: 'watermelon',
        enemyOutposts: [],
        friendlyOutposts: ['natural-1'],
        seed: 209,
        blight: true,
        enemyPacing: SCRIPTED_ONLY,
        boss: { type: 'watermelon', level: 5, x: 1900, y: 1300 },
        mission: {
            startingPremium: [premiumFor('chestnut') * 3, 0],
            waves: [
                attack(1_000, { type: 'rice', x: 1900, y: 1400, count: 4, columns: 4, hold: true }),
            ],
        },
        // Three sacs on the way; the ones broken when the reinforcements come each bring redbeans and chestnuts.
        sporeReinforceMs: 75_000,
        sporeSacs: [
            { x: 1100, y: 2150, captives: [], reinforce: sacHelp(1100, 2150) },
            { x: 1900, y: 2400, captives: [], reinforce: sacHelp(1900, 2400) },
            { x: 1500, y: 1250, captives: [], reinforce: sacHelp(1500, 1250) },
        ],
        sideGoal: { kind: 'allReinforcements' },
    },
    {
        id: 'fields-kernel-rain',
        act: 2,
        paceScale: 0.8,
        region: 'field-town',
        map: 'artillery-basin',
        title: '알맹이 비',
        story: {
            text: '첫 포자 구름을 막은 부대가 밭 마을 어귀에 닿는다. 낮은 분지에 감염 병력이 모여 있다.',
            brief: '옥수수는 높고 느린 곡사로 떨어진 뒤 알을 던져 지연 폭발을 일으킨다. 뭉친 적에게 맞고, 분지 가장자리 너머로도 쏠 수 있다.',
            captain: '옥수수는 앞줄 뒤에서 쏘게 하세요.',
        },
        deck: ['corn', 'pea', 'redbean', 'rice'],
        enemyDeck: ['pea', 'rice'],
        rewardCard: 'corn',
        enemyOutposts: ['basin-natural-2'],
        friendlyOutposts: ['basin-oil-1'],
        seed: 210,
        blight: true,
        practice: {
            card: 'corn',
            cue: '옥수수를 쏴서 뭉친 깜부기 콩 셋을 한꺼번에 맞혀요',
            targets: [{ type: 'pea', x: 820, y: 3470, count: 3, columns: 3, spacing: 40 }],
        },
        mission: {
            startingPremium: [premiumFor('corn') * 3, 0],
            // The low floor of the basin: a tight clump the player's shells can reach over the rim.
            waves: [
                attack(1_000, { type: 'pea', x: 1800, y: 2300, count: 6, columns: 3, hold: true }),
            ],
        },
        sideGoal: { kind: 'withinMs', ms: 240_000 },
    },
    {
        id: 'fields-pop-the-line',
        act: 2,
        region: 'field-town',
        map: 'small-field',
        title: '팡! 하고 빈틈',
        story: {
            text: '마을 안쪽에서 감염 병력이 전열을 이루고 길을 막고 있다.',
            brief: '팝콘은 좌우로 5명씩 착지해 적에게 뛰어들어 자폭한다. 촘촘한 전열에 구멍을 낸다.',
            captain: '팝콘으로 틈을 낸 뒤 바로 후속 병력을 투입하세요.',
        },
        deck: ['popcorn', 'corn', 'pea', 'redbean', 'rice'],
        enemyDeck: ['pea', 'millet'],
        rewardCard: 'popcorn',
        enemyOutposts: ['natural-2'],
        friendlyOutposts: ['natural-1'],
        seed: 211,
        blight: true,
        practice: {
            card: 'popcorn',
            cue: '팝콘을 터뜨려서 촘촘한 깜부기 콩 여섯을 쓰러뜨려요',
            targets: [{ type: 'pea', x: 800, y: 3290, count: 6, columns: 3, spacing: 36 }],
        },
        mission: { startingPremium: [premiumFor('corn') * 2, 0] },
        sideGoal: { kind: 'keepAlive', hpRatio: 0.75 },
    },
    {
        id: 'fields-forward-battery',
        act: 2,
        paceScale: 0.7,
        region: 'field-town',
        map: 'artillery-basin',
        title: '한 발 더 앞으로',
        story: {
            text: '고지 위의 적 거점에는 아군 대포의 사거리가 닿지 않는다.',
            brief: '감자는 착지한 자리에 파고들어 5초 뒤 전진 대포가 된다. 전진 대포는 체력이 줄어 약 15초 뒤 사라지고, 뿌리내리는 동안 쓰러지면 생기지 않는다. 먼 거점을 전진 대포로 노린다.',
            captain: '사거리가 겹친 대포가 많을수록 전진 대포도 한꺼번에 늘어납니다.',
        },
        deck: ['potato', 'popcorn', 'corn', 'pea', 'redbean', 'rice'],
        enemyDeck: ['chestnut', 'rice'],
        rewardCard: 'potato',
        // The far rim's outposts are the stage's point: the shells reach them from a forward cannon.
        enemyOutposts: ['basin-rim-2', 'basin-edge-2', 'basin-natural-2'],
        friendlyOutposts: ['basin-oil-1'],
        seed: 212,
        blight: true,
        practice: {
            card: 'potato',
            cue: '감자를 쏴서 빈터에 전진 대포를 세워요',
            forwardCannon: true,
        },
        mission: {
            startingPremium: [
                premiumFor('potato') * 3 + premiumFor('corn') * 2,
                premiumFor('chestnut') * 3,
            ],
        },
        sideGoal: { kind: 'withinMs', ms: 300_000 },
    },
    {
        id: 'fields-sesame-crew',
        act: 2,
        region: 'field-town',
        map: 'standard',
        title: '깨알 공사대',
        story: {
            text: '마을 한쪽에서 포로가 된 참깨 공사대를 찾았다.',
            brief: '참깨는 거점을 두 배 빠르게 짓고 건설 중 받는 피해가 4분의 1로 줄지만 싸우지 못한다. 포자 주머니를 부수면 참깨 30명이 합류한다.',
            captain: '참깨는 빈 점령 지점에 내려 거점부터 지으세요.',
        },
        deck: ['sesame', 'potato', 'corn', 'pea', 'redbean', 'rice'],
        enemyDeck: ['rice', 'buckwheat'],
        rewardCard: 'sesame',
        enemyOutposts: ['natural-2'],
        seed: 213,
        blight: true,
        practice: {
            card: 'sesame',
            cue: '참깨를 빈 거점 둘레에 내려 첫 거점을 지어요',
            built: 'natural-1',
        },
        mission: { startingPremium: [premiumFor('potato') * 3 + premiumFor('corn') * 2, 0] },
        sporeSacs: [{ x: 1500, y: 3000, captives: [{ type: 'sesame', count: 30 }] }],
        sideGoal: { kind: 'freeCaptives', count: 30 },
    },
    {
        id: 'fields-triangle-volley',
        act: 2,
        region: 'field-town',
        map: 'small-field',
        title: '세모 탄막',
        story: {
            text: '마을 외곽 언덕의 거점을 지키는 방어 임무가 시작된다.',
            brief: '메밀은 20명이 착지해 가까운 적에게 0.5초마다 씨앗을 던진다. 원거리 병종 중 사거리가 가장 짧고 몸이 약하다. 적 본진이 30초마다 쌀과 조를 번갈아 쏘아 보내며, 150초 동안 앞 거점을 지킨다.',
            captain: '메밀은 앞줄 뒤에서 쏘게 하세요.',
        },
        deck: ['buckwheat', 'sesame', 'corn', 'pea', 'redbean', 'rice'],
        enemyDeck: ['rice', 'millet'],
        rewardCard: 'buckwheat',
        enemyOutposts: [],
        friendlyOutposts: ['west-1'],
        seed: 214,
        blight: true,
        enemyPacing: SCRIPTED_ONLY,
        practice: {
            card: 'buckwheat',
            cue: '메밀을 콩 뒤에서 쏴서 깜부기 쌀 여섯을 쓰러뜨려요',
            targets: [{ type: 'rice', x: 800, y: 3290, count: 6, columns: 3 }],
        },
        mission: {
            startingPremium: [premiumFor('corn') * 2, 0],
            surviveMs: 150_000,
            guardPoint: 'west-1',
            // A wave every 30 s, rice and millet in turn, from the low ground north of the guarded hill.
            waves: [
                attack(30_000, { type: 'rice', x: 590, y: 1490, count: 12, columns: 4 }),
                attack(60_000, { type: 'millet', x: 910, y: 1930, count: 8, columns: 4 }),
                attack(90_000, { type: 'rice', x: 340, y: 1500, count: 12, columns: 4 }),
                attack(120_000, { type: 'millet', x: 590, y: 1490, count: 8, columns: 4 }),
            ],
        },
        sideGoal: { kind: 'keepAlive', hpRatio: 0.5, point: 'west-1' },
    },
    {
        id: 'fields-burn-a-road',
        act: 2,
        region: 'field-town',
        map: 'causeway-flats',
        title: '불길로 낸 길',
        story: {
            text: '마을 길목 두 곳이 감염 밭으로 막혀 있다.',
            brief: '고추는 좁고 긴 불줄기를 뿜어 줄기 안의 적을 모두 태운다. 밭 위에서는 아군 지상 병력이 초당 피해를 입고, 고추는 적이 없으면 사거리 안의 밭을 스스로 태운다.',
            captain: '불줄기는 옆이나 뒤로 돌아오는 적에 약합니다. 고추 옆을 지킬 병력을 두세요.',
        },
        deck: ['chili', 'pea', 'buckwheat', 'sesame', 'potato', 'redbean', 'rice'],
        enemyDeck: ['rice', 'millet'],
        rewardCard: 'chili',
        enemyOutposts: ['natural-2'],
        friendlyOutposts: ['natural-1'],
        seed: 215,
        blight: true,
        practice: {
            card: 'chili',
            cue: '고추를 내려 불줄기로 깜부기 쌀 여섯을 태워요',
            targets: [{ type: 'rice', x: 811, y: 3559, count: 6, columns: 3 }],
        },
        mission: { startingPremium: [premiumFor('chili') * 3 + premiumFor('potato') * 2, 0] },
        // One on each causeway road, both outside the opening view.
        blightFields: [
            { x: 1050, y: 2100 },
            { x: 2300, y: 3300 },
        ],
        sideGoal: { kind: 'burnFields' },
    },
    {
        id: 'fields-banana-bend',
        act: 2,
        region: 'field-town',
        map: 'small-field',
        title: '돌아오는 칼날',
        story: {
            text: '밭 마을의 수호자 바나나가 깜부기에 지배당해 길 끝을 막고 있다.',
            brief: '바나나 수호자는 5레벨 영웅으로, 네 번째 평타의 부메랑이 적을 왕복 관통한다. 포자 주머니 세 개를 75초 안에 부수면 부순 개수만큼 지원군이 온다. 수호자를 쓰러뜨리면 해방된다.',
            captain: '병력을 한 줄로 늘어세우지 마세요.',
        },
        deck: ['redbean', 'pea', 'buckwheat', 'corn', 'sesame', 'chili'],
        enemyDeck: ['banana', 'rice'],
        rewardCard: 'banana',
        enemyOutposts: [],
        friendlyOutposts: ['natural-1'],
        seed: 216,
        blight: true,
        enemyPacing: SCRIPTED_ONLY,
        boss: { type: 'banana', level: 5, x: 1900, y: 1300 },
        mission: {
            startingPremium: [premiumFor('corn') * 2 + premiumFor('chili') * 3, 0],
            waves: [
                attack(1_000, { type: 'rice', x: 1900, y: 1400, count: 4, columns: 4, hold: true }),
            ],
        },
        // Redbeans 100 and buckwheat 20 in all, in three helps; the sacs broken when they come bring theirs.
        sporeReinforceMs: 75_000,
        sporeSacs: [
            { x: 1100, y: 2150, captives: [], reinforce: bananaHelp(1100, 2150) },
            { x: 1900, y: 2400, captives: [], reinforce: bananaHelp(1900, 2400) },
            { x: 1500, y: 1250, captives: [], reinforce: bananaHelp(1500, 1250) },
        ],
        sideGoal: { kind: 'allReinforcements' },
    },
    {
        id: 'winds-over-the-wall',
        act: 2,
        region: 'wind-hill',
        map: 'wind-ravines',
        title: '벽 너머 한 줌',
        story: {
            text: '첫 포자 구름을 막은 부대가 바람 언덕에 닿는다. 절벽 너머에 감염 밭이 있다.',
            brief: '민들레씨는 투입되면 떠올라 벽과 절벽을 곧장 넘고, 적이 사거리에 들어오면 내려앉아 땅에서 싸운다. 나는 동안에는 공격하지 않는다. 화로 자리를 아군이 점령하면 주변 밭이 정화된다.',
            captain: '절벽 너머로 병력을 보낼 땐 민들레씨를 쓰세요.',
        },
        deck: ['dandelion', 'redbean', 'pea', 'rice'],
        enemyDeck: ['rice', 'pea'],
        rewardCard: 'dandelion',
        enemyOutposts: ['ravine-2'],
        friendlyOutposts: ['ravine-1'],
        seed: 217,
        blight: true,
        // The target stands just north of the middle wall, in reach of the forward cannon south of it.
        practice: {
            card: 'dandelion',
            cue: '민들레씨를 쏴서 절벽 너머 깜부기 쌀 넷을 쓰러뜨려요',
            targets: [{ type: 'rice', x: 1500, y: 2080, count: 4, columns: 2, spacing: 40 }],
        },
        mission: {},
        blightFields: [{ x: 2000, y: 1700 }],
        braziers: [{ x: 2080, y: 1760, radius: 125 }],
        sideGoal: { kind: 'burnFields' },
    },
    {
        id: 'winds-sky-watch',
        act: 2,
        region: 'wind-hill',
        map: 'small-field',
        title: '하늘을 지켜라',
        story: {
            text: '바람 언덕에 포자 구름이 날아든다. 이번에는 구름에서 나는 병력이 내려온다.',
            brief: '해바라기씨는 적 투입탄과 나는 적을 먼저 연사하고, 공중에 적이 없으면 지상을 쏜다. 구름은 5초 전에 예고되고 세 번 오며 갈수록 나는 병력이 늘어난다. 150초 동안 앞 거점을 지킨다.',
            captain: '해바라기씨를 앞 거점 근처에 먼저 투입해 두세요.',
        },
        deck: ['sunflower-seed', 'pea', 'dandelion', 'redbean', 'rice'],
        enemyDeck: ['dandelion', 'rice'],
        rewardCard: 'sunflower-seed',
        enemyOutposts: [],
        friendlyOutposts: ['west-1'],
        seed: 218,
        blight: true,
        enemyPacing: SCRIPTED_ONLY,
        practice: {
            card: 'sunflower-seed',
            cue: '해바라기씨를 쏴서 깜부기 쌀 둘을 연달아 쓰러뜨려요',
            targets: [{ type: 'rice', x: 800, y: 3290, count: 2, columns: 2 }],
        },
        mission: {
            startingPremium: [premiumFor('sunflower-seed') * 3, 0],
            surviveMs: 150_000,
            guardPoint: 'west-1',
            waves: [],
        },
        // Flying soldiers by cloud, a few more each time: the first is the anti-air lesson.
        sporeClouds: [
            skyAttack(30_000, 340, 1500, 4),
            skyAttack(70_000, 590, 1490, 6),
            skyAttack(110_000, 910, 1930, 8),
        ],
        sideGoal: { kind: 'keepAlive', hpRatio: 0.5, point: 'west-1' },
    },
    {
        id: 'winds-linked-lightning',
        act: 2,
        paceScale: 0.9,
        region: 'wind-hill',
        map: 'kings-hill',
        title: '이어지는 번개',
        story: {
            text: '언덕 위에서 지상과 공중의 감염 병력이 함께 접근한다.',
            brief: '목화솜의 번개는 가까운 적으로 튀어 4명까지 이어져 1초 동안 감전시키고 1초 쉰다. 나는 적에게도 닿는다. 몸이 약해 넘어지면 번개가 끊긴다.',
            captain: '목화솜은 앞줄 뒤에 두세요.',
        },
        deck: ['cotton', 'sunflower-seed', 'pea', 'dandelion', 'redbean', 'rice'],
        enemyDeck: ['rice', 'dandelion'],
        rewardCard: 'cotton',
        enemyOutposts: ['natural-2'],
        friendlyOutposts: ['natural-1'],
        seed: 219,
        blight: true,
        practice: {
            card: 'cotton',
            cue: '목화솜을 쏴서 흩어진 깜부기 쌀 넷을 번개로 이어 쓰러뜨려요',
            targets: [{ type: 'rice', x: 770, y: 3410, count: 4, columns: 4, spacing: 60 }],
        },
        mission: {
            startingPremium: [premiumFor('cotton') * 3 + premiumFor('sunflower-seed') * 2, 0],
        },
        sideGoal: { kind: 'withinMs', ms: 300_000 },
    },
    {
        id: 'winds-cannon-relay',
        act: 2,
        region: 'wind-hill',
        map: 'artillery-basin',
        title: '대포 징검다리',
        story: {
            text: '언덕 사이 분지에 아군 거점이 둘 있다. 앞쪽 거점이 전선 가까이에 있다.',
            brief: '검은콩은 적에게 떨어져 2.5초 싸운 뒤, 앞에 있는 아군 대포로 달려가 올라타고 다시 적 쪽으로 날아간다. 이때 비용과 재장전은 쓰지 않는다.',
            captain: '아군 거점이 이어져 있을수록 검은콩이 멀리 갑니다.',
        },
        deck: ['black-bean', 'cotton', 'sunflower-seed', 'pea', 'redbean', 'rice'],
        enemyDeck: ['rice', 'millet'],
        rewardCard: 'black-bean',
        enemyOutposts: ['basin-natural-2'],
        // Two forward outposts of the player's: the black beans ride from one to the next.
        friendlyOutposts: ['basin-oil-1', 'basin-shoulder-1'],
        seed: 220,
        blight: true,
        practice: {
            card: 'black-bean',
            cue: '검은콩을 쏴서 깜부기 쌀 넷을 쓰러뜨려요',
            targets: [{ type: 'rice', x: 820, y: 3470, count: 4, columns: 2, spacing: 40 }],
        },
        mission: {
            startingPremium: [premiumFor('black-bean') * 3 + premiumFor('cotton') * 2, 0],
        },
        sideGoal: { kind: 'withinMs', ms: 300_000 },
    },
    {
        id: 'winds-silence-the-muzzle',
        act: 2,
        paceScale: 0.5,
        region: 'wind-hill',
        map: 'artillery-basin',
        title: '입 다물 대포',
        story: {
            text: '적 거점마다 대포가 있어 발사망이 촘촘하다.',
            brief: '찹쌀은 시야 안의 적 건물로 달려가 완공된 거점의 포구에 1초 붙는다. 붙어 있는 동안 그 거점은 발사와 포탑 공격을 못 한다. 같은 병사는 5초 뒤 다시 붙을 수 있다.',
            captain: '포구가 막힌 거점은 포탑도 멈춥니다. 그 사이 병력을 투입하세요.',
        },
        deck: ['sticky-rice', 'black-bean', 'cotton', 'sunflower-seed', 'redbean', 'pea', 'rice'],
        enemyDeck: ['black-bean', 'rice'],
        rewardCard: 'sticky-rice',
        // The first is the practice's: a finished outpost in the opening view, whose muzzle the rice holds.
        enemyOutposts: ['basin-natural-1', 'basin-natural-2', 'basin-shoulder-2'],
        friendlyOutposts: ['basin-oil-1'],
        seed: 221,
        blight: true,
        practice: {
            card: 'sticky-rice',
            cue: '찹쌀을 쏴서 적 거점의 포구에 붙여요',
            clamp: 'basin-natural-1',
        },
        mission: {
            startingPremium: [
                premiumFor('sticky-rice') * 3 + premiumFor('black-bean') * 2,
                premiumFor('black-bean') * 3,
            ],
        },
        sideGoal: { kind: 'keepAlive', hpRatio: 0.75 },
    },
    {
        id: 'winds-grape-crown',
        act: 2,
        region: 'wind-hill',
        map: 'small-field',
        title: '보랏빛 왕관',
        story: {
            text: '바람 언덕의 수호자 포도가 깜부기에 지배당해 언덕 위에서 기다린다.',
            brief: '포도 수호자는 5레벨 영웅으로, 네 번째 평타마다 표적의 앞·중앙·뒤에 곡사탄을 던진다. 포자 주머니 세 개를 75초 안에 부수면 부순 개수만큼 지원군이 온다. 수호자를 쓰러뜨리면 해방된다.',
            captain: '병력이 뭉쳐 있으면 곡사탄 세 알에 한꺼번에 맞습니다. 나눠서 투입하세요.',
        },
        deck: ['redbean', 'sunflower-seed', 'cotton', 'sticky-rice', 'pea', 'rice'],
        enemyDeck: ['grape', 'rice'],
        rewardCard: 'grape',
        enemyOutposts: [],
        friendlyOutposts: ['natural-1'],
        seed: 222,
        blight: true,
        enemyPacing: SCRIPTED_ONLY,
        boss: { type: 'grape', level: 5, x: 1900, y: 1300 },
        mission: {
            startingPremium: [
                premiumFor('sunflower-seed') * 3 +
                    premiumFor('cotton') * 2 +
                    premiumFor('sticky-rice') * 2,
                0,
            ],
            waves: [
                attack(1_000, { type: 'rice', x: 1900, y: 1400, count: 4, columns: 4, hold: true }),
            ],
        },
        // Redbeans 99 and sunflower seeds 9 in all, in three helps.
        sporeReinforceMs: 75_000,
        sporeSacs: [
            { x: 1100, y: 2150, captives: [], reinforce: grapeHelp(1100, 2150) },
            { x: 1900, y: 2400, captives: [], reinforce: grapeHelp(1900, 2400) },
            { x: 1500, y: 1250, captives: [], reinforce: grapeHelp(1500, 1250) },
        ],
        sideGoal: { kind: 'allReinforcements' },
    },
    {
        id: 'interlude-fallen-captain',
        act: 3,
        theme: 'black-granary',
        map: 'small-field',
        title: '대장이 쓰러지다',
        story: {
            text: '세 고장의 수호자를 해방한 부대가 후미와 합류한다. 포자 구름이 세 방향에서 몰려온다.',
            brief: '포자 구름이 세 방향에서 차례로 도착하고, 구름마다 쌀·조·민들레씨가 섞여 있다. 5초 전에 예고 표시가 뜬다. 100초 동안 앞 거점을 지킨다.',
            captain: '나는 병력은 해바라기씨와 목화솜으로 막으세요.',
        },
        deck: ['watermelon', 'pea', 'redbean', 'sunflower-seed', 'cotton', 'sesame', 'rice'],
        enemyDeck: ['rice', 'millet', 'dandelion'],
        enemyOutposts: [],
        friendlyOutposts: ['west-1'],
        seed: 223,
        blight: true,
        enemyPacing: SCRIPTED_ONLY,
        mission: {
            startingPremium: [premiumFor('sunflower-seed') * 3 + premiumFor('cotton') * 2, 0],
            surviveMs: 100_000,
            guardPoint: 'west-1',
            waves: [],
        },
        // Three announced attacks from three ways, rice, millet and dandelion seeds in each.
        sporeClouds: [
            mixedAttack(20_000, 340, 1500),
            mixedAttack(50_000, 590, 1490),
            mixedAttack(80_000, 910, 1930),
        ],
        sideGoal: { kind: 'keepAlive', hpRatio: 0.5, point: 'west-1' },
    },
    {
        id: 'granary-find-the-captain',
        act: 3,
        theme: 'black-granary',
        map: 'twin-gates',
        title: '대장을 찾아서',
        story: {
            text: '구출한 병사들이 대장이 끌려간 곳이 검은 곳간이라고 알려 준다. 가는 길목에도 포로가 있다.',
            brief: '갈림길의 포자 주머니 세 개를 부수면 땅콩, 검은콩, 호두 포로가 각각 합류한다. 적은 두 관문을 나누어 지킨다.',
            captain: '구출한 병종마다 역할이 다릅니다. 땅콩은 건물, 호두는 앞줄로 쓰세요.',
        },
        deck: ['banana', 'peanut', 'black-bean', 'walnut', 'chestnut', 'redbean', 'sesame', 'rice'],
        enemyDeck: ['chestnut', 'pea', 'rice'],
        enemyOutposts: ['natural-2'],
        friendlyOutposts: ['natural-1'],
        startingLaunchRangeLevel: 1,
        seed: 224,
        blight: true,
        mission: {
            startingPremium: [
                premiumFor('black-bean') * 3 + premiumFor('chestnut') * 3,
                premiumFor('chestnut') * 3,
            ],
            // The guards stand at the two gates, apart.
            formations: [
                { type: 'rice', x: 480, y: 1150, count: 4, columns: 4 },
                { type: 'pea', x: 3320, y: 3050, count: 4, columns: 4 },
            ],
        },
        // Three sacs at the forks, each holding a different help.
        sporeSacs: [
            { x: 700, y: 2200, captives: [{ type: 'peanut', count: 8 }] },
            { x: 1700, y: 3000, captives: [{ type: 'black-bean', count: 8 }] },
            { x: 2450, y: 3150, captives: [{ type: 'walnut', count: 8 }] },
        ],
        sideGoal: { kind: 'freeCaptives', count: 24 },
    },
    {
        id: 'granary-black-fields',
        act: 3,
        theme: 'black-granary',
        map: 'causeway-flats',
        title: '까만 들판',
        story: {
            text: '검은 곳간으로 향하는 마지막 통로가 감염 밭으로 막혀 있고, 포자 구름이 계속 날아든다.',
            brief: '고추 6명이 앞 거점 앞의 감염 밭을 태운다. 감염 밭 위에서는 아군 지상 병력이 초당 피해를 입는다. 구름은 5초 전에 예고되고 쌀·조·민들레씨가 차례로 온다. 180초 동안 앞 거점을 지킨다.',
            captain: '고추가 밭을 태우는 동안 구름을 막아 주세요.',
        },
        deck: ['grape', 'chili', 'walnut', 'sesame', 'sunflower-seed', 'cotton', 'redbean', 'rice'],
        enemyDeck: ['rice', 'millet', 'dandelion'],
        enemyOutposts: [],
        friendlyOutposts: ['west-head-1'],
        seed: 225,
        blight: true,
        enemyPacing: SCRIPTED_ONLY,
        mission: {
            startingPremium: [
                premiumFor('chili') * 3 +
                    premiumFor('sunflower-seed') * 2 +
                    premiumFor('cotton') * 2,
                0,
            ],
            surviveMs: 180_000,
            guardPoint: 'west-head-1',
            // Six chili soldiers stand by the guarded outpost from the start: they clear the way ahead of it.
            formations: [{ type: 'chili', x: 960, y: 2150, count: 6, columns: 3, side: 0 }],
            waves: [],
        },
        // One field on each road to the guarded outpost.
        blightFields: [
            { x: 1000, y: 1850 },
            { x: 1150, y: 2350 },
        ],
        sporeClouds: [
            sporeCloudOf(30_000, 1100, 1700, 'rice', 8),
            sporeCloudOf(70_000, 700, 1900, 'millet', 6),
            sporeCloudOf(110_000, 1300, 2200, 'dandelion', 4),
        ],
        sideGoal: { kind: 'burnFields' },
    },
    {
        id: 'granary-black-ear',
        act: 3,
        theme: 'black-granary',
        map: 'kings-hill',
        title: '검은 이삭',
        story: {
            text: '검은 이삭에게 지배당한 대장이 곳간 깊은 곳에서 기다린다.',
            brief: '감염된 대장은 5레벨 영웅이다. 고추 6명이 진입로의 감염 밭을 태운 뒤 팥 100명과 호두 2명이 합류한다. 대장을 쓰러뜨리면 감염이 풀린다.',
            captain: '밭은 10초마다 넓어집니다. 고추로 진입로를 먼저 여세요.',
        },
        deck: [
            'grape',
            'redbean',
            'walnut',
            'chili',
            'sesame',
            'sunflower-seed',
            'cotton',
            'black-bean',
        ],
        // The infected captain is the watermelon boss again, grown over by the blight.
        enemyDeck: ['watermelon', 'rice'],
        enemyOutposts: [],
        friendlyOutposts: ['natural-1'],
        seed: 226,
        blight: true,
        enemyPacing: SCRIPTED_ONLY,
        boss: {
            type: 'watermelon',
            level: 5,
            x: 1900,
            y: 2100,
            escorts: [{ type: 'rice', x: 1900, y: 1960, count: 8, columns: 4 }],
        },
        mission: {
            startingPremium: [
                premiumFor('chili') * 3 +
                    premiumFor('sunflower-seed') * 2 +
                    premiumFor('cotton') * 2 +
                    premiumFor('black-bean') * 2,
                0,
            ],
            // Six chili soldiers first, to open the road; redbeans and walnuts follow once the fire has had its time.
            waves: [
                attack(1_000, { type: 'chili', x: 1500, y: 3000, count: 6, columns: 3, side: 0 }),
                attack(
                    45_000,
                    { type: 'redbean', x: 1500, y: 3000, count: 100, columns: 10, side: 0 },
                    { type: 'walnut', x: 1500, y: 3100, count: 2, columns: 2, side: 0 },
                ),
            ],
        },
        // The two roads up to the boss, each with a field and a brazier to light.
        blightFields: [
            { x: 1500, y: 2650 },
            { x: 2300, y: 2650 },
        ],
        braziers: [
            { x: 1400, y: 2720, radius: 125 },
            { x: 2400, y: 2720, radius: 125 },
        ],
        sideGoal: { kind: 'burnFields' },
    },
]);
// What one broken sac of the nut forest's boss stage brings the player: 30 redbeans and 3 chestnuts where it stood.
function sacHelp(x, y) {
    return [
        { type: 'redbean', x, y, count: 30, columns: 6 },
        { type: 'chestnut', x, y: y + 90, count: 3, columns: 3 },
    ];
}
// What one broken sac of the field town's boss stage brings the player: 33 redbeans and 7 buckwheat where it stood.
function bananaHelp(x, y) {
    return [
        { type: 'redbean', x, y, count: 33, columns: 6 },
        { type: 'buckwheat', x, y: y + 100, count: 7, columns: 7 },
    ];
}
// What one broken sac of the wind hill's boss stage brings the player: 33 redbeans and 3 sunflower seeds.
function grapeHelp(x, y) {
    return [
        { type: 'redbean', x, y, count: 33, columns: 6 },
        { type: 'sunflower-seed', x, y: y + 90, count: 3, columns: 3 },
    ];
}
// One announced attack of the wind hill's sky defence: `count` dandelion seeds brought by a cloud that comes once.
function skyAttack(atMs, x, y, count) {
    return {
        atMs,
        everyMs: atMs,
        warnMs: 5_000,
        times: 1,
        formations: [{ type: 'dandelion', x, y, count, columns: Math.min(count, 4) }],
    };
}
// One announced attack of the interlude's defence: rice, millet and dandelion seeds together, 12 in all.
function mixedAttack(atMs, x, y) {
    return {
        atMs,
        everyMs: atMs,
        warnMs: 5_000,
        times: 1,
        formations: [
            { type: 'rice', x, y: y - 40, count: 5, columns: 5 },
            { type: 'millet', x, y: y + 20, count: 4, columns: 4 },
            { type: 'dandelion', x, y: y + 80, count: 3, columns: 3 },
        ],
    };
}
// One announced attack of `count` soldiers of one kind, brought by a cloud that comes once.
function sporeCloudOf(atMs, x, y, type, count) {
    return {
        atMs,
        everyMs: atMs,
        warnMs: 5_000,
        times: 1,
        formations: [{ type, x, y, count, columns: Math.min(count, 4) }],
    };
}
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
// The map look a stage asks for: its region's theme, else its own `theme`, else null (the map's own).
export function campaignStageTheme(stage) {
    return (
        CAMPAIGN_REGIONS.find((region) => region.id === stage?.region)?.theme ??
        stage?.theme ??
        null
    );
}
export function campaignStage(id) {
    return CAMPAIGN_ACT_STAGES.find((stage) => stage.id === id) || null;
}
