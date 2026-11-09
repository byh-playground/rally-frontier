// Dialogue belongs to presentation. Match rules never read this copy.
const BRIEFINGS = {
    first: [
        { speaker: '정찰병', text: '앞쪽 거점이 비어 있습니다. 적도 그쪽을 노릴 겁니다.' },
        { speaker: '대장', text: '그럼 우리가 먼저 깃발을 꽂는다. 전열을 갖춰라.' },
    ],
    bean: [
        { speaker: '정찰병', text: '길목에 적 콩이 버티고 있습니다. 진형이 단단합니다.' },
        { speaker: '대장', text: '저 길을 열어야 본진에 닿는다. 포격을 한곳에 모아라.' },
    ],
    defense: [
        { speaker: '정찰병', text: '적 팝콘이 본진 쪽으로 몰려옵니다!' },
        { speaker: '대장', text: '추격하지 마라. 오늘은 이 자리를 지키는 게 임무다.' },
    ],
    counterattack: [
        { speaker: '정찰병', text: '적 팥이 선두에 섰습니다. 곧 우리 전열을 덮칠 겁니다.' },
        { speaker: '대장', text: '전열을 지켜라. 저쪽 기세가 꺾이면 그때 우리가 간다.' },
    ],
    breakthrough: [
        { speaker: '정찰병', text: '적 조 부대가 진입로를 막았습니다. 본진 식량도 빠듯합니다.' },
        { speaker: '대장', text: '여기서 오래 버틸 순 없다. 전진 거점을 먼저 잡는다.' },
    ],
    chestnut: [
        { speaker: '정찰병', text: '적 밤톨이 방어선 뒤에서 가시를 겨누고 있습니다.' },
        { speaker: '대장', text: '쌀 부대는 앞줄을 맡아라. 조 부대는 틈이 열리면 간다.' },
    ],
    corn: [
        { speaker: '정찰병', text: '적 옥수수가 정면에 섰습니다. 옆의 기름 거점은 비어 있습니다.' },
        { speaker: '대장', text: '정면에 발이 묶이기 전에 측면부터 잡는다. 밤톨 부대, 준비.' },
    ],
    acorn: [
        { speaker: '정찰병', text: '적 도토리가 선두에 모였습니다. 돌파를 준비하는 모양입니다.' },
        { speaker: '대장', text: '옥수수 부대, 저 선두를 맡아라. 여기서 전열을 지킨다.' },
    ],
    millet: [
        { speaker: '정찰병', text: '이 방어선 너머가 적의 마지막 본진입니다.' },
        { speaker: '대장', text: '여기까지 함께 왔다. 마지막 본진까지 같이 간다.' },
    ],
};

export function campaignBriefingLines(stage) {
    return Object.hasOwn(BRIEFINGS, stage.id)
        ? BRIEFINGS[stage.id]
        : [{ speaker: '정찰병', text: stage.briefing }];
}
