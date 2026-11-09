import { LaunchRules } from '../sim/launch-rules.js';

export function normalizeDeckSelection(deckMode, deck) {
    if (deckMode === 'own') return { deckMode, deck: LaunchRules.normalizeDeck(deck) };
    if (deckMode === 'random' && deck === undefined) return { deckMode };
    throw new Error('친구 대전 덱 선택이 잘못되었습니다.');
}

function drawRandomDeck() {
    const normals = LaunchRules.deck.slice(),
        normalCount = LaunchRules.deckLimit - 1,
        heroes = LaunchRules.heroTypes;
    if (!heroes.length || normals.length < normalCount)
        throw new Error('랜덤 덱에 필요한 카드가 부족합니다.');

    const value = new Uint32Array(1);
    const randomIndex = (length) => {
        const range = 2 ** 32;
        const upper = range - (range % length);
        do {
            crypto.getRandomValues(value);
        } while (value[0] >= upper);
        return value[0] % length;
    };
    const deck = [heroes[randomIndex(heroes.length)]];
    for (let i = 0; i < normalCount; i++) {
        const index = i + randomIndex(normals.length - i);
        [normals[i], normals[index]] = [normals[index], normals[i]];
        deck.push(normals[i]);
    }
    return deck;
}

export function resolveDeckSelection(selection) {
    return selection.deckMode === 'random' ? drawRandomDeck() : selection.deck.slice();
}

export function matchesDeckSelection(selection, deck) {
    if (selection.deckMode === 'random')
        return (
            deck.length === LaunchRules.deckLimit &&
            deck.filter((type) => LaunchRules.isHeroType(type)).length === 1
        );
    return (
        selection.deck.length === deck.length && selection.deck.every((type, i) => type === deck[i])
    );
}
