// Dialogue belongs to presentation. Match rules never read this copy.
const BRIEFINGS = {
    first: [
        { speaker: '정찰병', text: '대장, 앞에 빈 거점이 있어요.' },
        { speaker: '대장', text: '잘됐네. 적보다 먼저 깃발 꽂고 오자.' },
    ],
    bean: [
        { speaker: '정찰병', text: '콩들이 길을 딱 막았어요. 비켜줄 생각은 없어 보여요.' },
        { speaker: '대장', text: '그럼 우리가 길을 내자. 저 너머가 적 본진이야.' },
    ],
    defense: [
        { speaker: '정찰병', text: '대장, 팝콘이 잔뜩 몰려와요!' },
        { speaker: '대장', text: '멀리까지 쫓아갈 거 없어. 여기만 지키면 돼.' },
    ],
    counterattack: [
        { speaker: '정찰병', text: '팥이 앞장서네요. 이번엔 저쪽이 먼저 오겠어요.' },
        { speaker: '대장', text: '좋아. 한바탕 버티고 나면 우리가 갈 차례야.' },
    ],
    breakthrough: [
        { speaker: '정찰병', text: '조 부대가 길을 막았어요. 식량도 넉넉하진 않아요.' },
        { speaker: '대장', text: '시간 끌 여유는 없네. 앞쪽 거점부터 잡자.' },
    ],
    chestnut: [
        { speaker: '정찰병', text: '밤톨이 저 뒤에서 가시를 겨누고 있어요.' },
        { speaker: '대장', text: '쌀이 앞을 맡아 줄 거야. 조는 그 틈에 달려가자.' },
    ],
    corn: [
        { speaker: '정찰병', text: '옥수수는 정면에 있고, 옆 기름 거점은 비어 있어요.' },
        { speaker: '대장', text: '마침 잘됐네. 저쪽이 눈치채기 전에 옆부터 잡자.' },
    ],
    acorn: [
        { speaker: '정찰병', text: '도토리가 앞에 모였어요. 다 같이 굴러올 것 같아요.' },
        { speaker: '대장', text: '잔뜩 모였다고? 그럼 우리 옥수수가 나설 때네.' },
    ],
    millet: [
        { speaker: '정찰병', text: '저기만 지나면 적 본진이에요. 정말 마지막이네요.' },
        { speaker: '대장', text: '그러게. 여기까지 왔으니 마저 가 보자.' },
    ],
};

export function campaignBriefingLines(stage) {
    return Object.hasOwn(BRIEFINGS, stage.id)
        ? BRIEFINGS[stage.id]
        : [{ speaker: '정찰병', text: stage.briefing }];
}
