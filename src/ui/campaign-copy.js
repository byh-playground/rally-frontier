// Dialogue belongs to presentation. Match rules never read this copy.
const BRIEFINGS = {
    first: [
        { speaker: '정찰병', text: '앞쪽에 비어 있는 거점이 있어요.' },
        { speaker: '대장', text: '쌀 카드를 고르고 거점 방향을 길게 눌렀다가 떼세요.' },
    ],
    bean: [
        { speaker: '정찰병', text: '적 콩이 앞을 막고 있어요. 한 알씩 버티는 힘이 세요.' },
        { speaker: '대장', text: '콩이 모이는 곳에 쌀 포격을 집중해 길을 내요.' },
    ],
    defense: [
        { speaker: '정찰병', text: '적 팝콘이 본진으로 와요. 가까이서 터지면 위험해요.' },
        { speaker: '대장', text: '쌀과 콩을 나눠 쏘면서 시간이 끝날 때까지 본진을 지켜요.' },
    ],
    counterattack: [
        { speaker: '정찰병', text: '적 팥이 뛰어들어 우리 전열을 흩뜨려요.' },
        { speaker: '대장', text: '먼저 본진을 지켜요. 방어 시간이 끝나면 팝콘으로 반격해요.' },
    ],
    breakthrough: [
        { speaker: '정찰병', text: '적 조가 빠르게 다가와요. 이번엔 본진 식량도 천천히 차요.' },
        { speaker: '대장', text: '거점을 먼저 확보해요. 식량이 모이면 팥으로 방어선을 뚫어요.' },
    ],
    chestnut: [
        { speaker: '정찰병', text: '적 밤톨이 멀리서 가시를 던져 전진을 막고 있어요.' },
        { speaker: '대장', text: '쌀로 길을 열고 빠른 조를 거점 가까이에 내려요.' },
    ],
    corn: [
        { speaker: '정찰병', text: '적 옥수수가 뭉친 병력을 한꺼번에 노려요.' },
        { speaker: '대장', text: '사거리를 한 번 강화해 옆의 기름 거점을 확보하고 밤톨을 보내요.' },
    ],
    acorn: [
        { speaker: '정찰병', text: '적 도토리가 회전하며 우리 전열을 밀어내요.' },
        { speaker: '대장', text: '기름을 모아 옥수수를 쏘고, 적이 모이는 곳을 노려요.' },
    ],
    millet: [
        { speaker: '정찰병', text: '이 앞이 적의 마지막 방어선이에요.' },
        { speaker: '대장', text: '쌀과 조로 전진하고, 도토리로 적이 몰린 곳을 밀어내요.' },
    ],
};

export function campaignBriefingLines(stage) {
    return Object.hasOwn(BRIEFINGS, stage.id)
        ? BRIEFINGS[stage.id]
        : [{ speaker: '정찰병', text: stage.briefing }];
}
