// Dialogue and hints belong to presentation. Match rules never read this copy.
import { LaunchRules } from '../sim/launch-rules.js';

const OPENING = [
    { speaker: '대장', text: '전장에 투입할 최신 병기가 완성됐어.' },
    { speaker: '정찰병', text: '최신 병기요? 뭔데요?' },
    { speaker: '대장', text: '너를 대포로 날리는 거야.' },
    {
        speaker: '정찰병',
        text: '그건 최신식이 아니잖…',
        interruptedByLaunch: '그건 최신식이 아니잖아—!',
    },
];

const volleyBonuses = Array.from(
    { length: LaunchRules.maxVolleyCannons - 1 },
    (_, i) => `${i + 2}문 +${(i + 1) * LaunchRules.volleyReinforcementPctPerExtraCannon}%`,
).join(', ');

const GUIDE = {
    first: '쌀 카드를 고르고 전장을 길게 눌러 보세요. 손을 떼면 그 방향으로 발사해요.',
    'volley-practice': `사거리가 겹치는 곳에 쏘면 준비된 아군 대포가 최대 ${LaunchRules.maxVolleyCannons}문까지 함께 쏴요. 병력 보너스는 ${volleyBonuses}예요. 비용은 한 묶음 값이에요. 1문·2문·3문이 닿는 세 지점의 수비대를 겨냥해 보세요.`,
    bean: '적 콩이 모인 곳을 겨냥해 쌀 포격을 집중해 보세요.',
    defense: '화면 위의 시간이 다 될 때까지 본진을 지켜요. 팝콘이 몰려오는 곳을 노려 보세요.',
    counterattack: '방어 시간이 끝나면 목표가 바뀌어요. 그때 적 본진을 공격하면 돼요.',
    breakthrough: '앞쪽 거점을 먼저 확보하면 식량 수입을 늘리고 적에게 더 가까이서 쏠 수 있어요.',
    chestnut: '사거리를 한 번 강화하면 본진 대포에서 측면 기름 거점까지 닿아요.',
    corn: '밤톨을 발사하려면 기름이 필요해요. 측면 기름 거점부터 확보해 보세요.',
    acorn: '옥수수는 적이 한곳에 모였을 때 겨냥하면 좋아요.',
    millet: '전진 거점을 확보하면 그곳의 대포에서도 병력을 발사할 수 있어요.',
    'sunflower-seed':
        '해바라기씨는 적 투입탄부터 쏴요. 사거리 밖에 병력을 내려 걸어서 접근해 보세요.',
};

export function campaignBriefingLines(stage) {
    const guide = {
        speaker: '게임 가이드',
        text: Object.hasOwn(GUIDE, stage.id) ? GUIDE[stage.id] : stage.briefing,
    };
    return stage.id === 'first' ? [...OPENING, guide] : [guide];
}
