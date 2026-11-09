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
    first: '전진 거점을 길게 조준하고 손을 떼서 쌀을 보내요. 거점이 완공되면 그곳에서도 쏠 수 있어요.',
    'volley-practice': `조준 중 목표 대포 수를 확인하세요. 일제사격은 한 묶음 비용으로 병력이 늘어요 (${volleyBonuses}).`,
    bean: '콩 수비대가 흩어지기 전에 쌀 산탄으로 한꺼번에 맞혀 보세요.',
    defense: '팝콘이 오는 쪽이 바뀌어요. 병력이 한곳에서 폭발을 맞지 않도록 나눠 쏴 보세요.',
    counterattack:
        '마지막 팥 공격을 막으면 전진 거점과 팝콘 한 묶음분 식량을 받아요. 거기서 바로 반격하세요.',
    breakthrough:
        '전진 거점을 완공하면 팥 한 묶음분의 식량이 들어와요. 조가 오는 쪽을 막고 돌파하세요.',
    chestnut: '조를 밤톨 수비대 양쪽에 내려 가시 사격을 나눠 받아요.',
    corn: '측면 기름 거점을 확보하면 밤톨을 바로 쏠 수 있어요. 옥수수 폭발을 가로 착지로 분산하세요.',
    acorn: '처음부터 옥수수를 쏠 기름이 있어요. 경사로에 도토리가 몰리면 폭발로 막아 보세요.',
    millet: '조는 측면으로 보내고 도토리는 중앙에 내려요. 해바라기씨로 적 투입탄도 견제해 보세요.',
    'sunflower-seed':
        '시범 포탄이 떨어지는 곳을 보세요. 해바라기씨의 사거리 밖에 병력을 내려 걸어서 접근하면 돼요.',
};

export function campaignBriefingLines(stage) {
    const guide = {
        speaker: '게임 가이드',
        text: Object.hasOwn(GUIDE, stage.id) ? GUIDE[stage.id] : stage.briefing,
    };
    return stage.id === 'first' ? [...OPENING, guide] : [guide];
}
