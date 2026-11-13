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
    'hero-watermelon':
        '영웅 출격은 무료예요. 착지 뒤 카드를 길게 누르면 스킬, 한 번 누르면 복귀예요.',
    'hero-banana': '바나나 카드를 길게 눌러 부메랑을 던지세요. 나갈 때와 돌아올 때 적을 맞혀요.',
    'hero-grape': '포도 카드를 길게 눌러 스킬을 예약하세요. 적이 가까워지면 포도알을 연사해요.',
};

export function campaignBriefingLines(stage) {
    const guide = {
        speaker: '게임 가이드',
        text: Object.hasOwn(GUIDE, stage.id) ? GUIDE[stage.id] : stage.briefing,
    };
    return stage.id === 'first' ? [...OPENING, guide] : [guide];
}
