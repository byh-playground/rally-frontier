// Hand cycle (the basic Clash Royale rotation). A side's match deck is split into the hand, the only cards it can
// launch, and the queue. A used card goes to the back of the queue and the queue's front card takes its hand slot.
// The hand holds min(4, cards − 1) cards so at least one waits; a one-card cycle keeps reusing that card.
//
// State (authoritative, StateContract save/checksum/replay): sim.handCycle[side] = { hand: [i…], queue: [i…] }, card
// indices into sim.decks[side]. The start order is the deck shuffled by the match seed per side.
//
// A hero card leaves the cycle when it is launched and is in neither list while HeroDeployment has its slot (in flight,
// on the field, or dead). When the slot is cleared (recovered, or the landing failed) the card rejoins at the back of
// the queue. A dead hero keeps its slot (it cannot sortie again in the match), so its card stays out. While a hero is
// out the hand size follows the cards left in the cycle.
//
// Ticks never run this module: it changes only on a launch command or a hero docking, in place, without allocation.
import { HashUtil } from './map-generation.js';
import { LaunchRules } from './launch-rules.js';

export class HandCycle {
    static handLimit = 4;

    static handSize(cards) {
        return cards <= 1 ? cards : Math.min(this.handLimit, cards - 1);
    }

    static create(decks, seed) {
        return decks.map((deck, side) => {
            const order = deck.map((_, index) => index);
            for (let i = order.length - 1; i > 0; i--) {
                const j =
                    HashUtil.finish(
                        HashUtil.word(HashUtil.word(HashUtil.word(HashUtil.OFFSET, seed), side), i),
                    ) %
                    (i + 1);
                [order[i], order[j]] = [order[j], order[i]];
            }
            const size = this.handSize(order.length);
            return { hand: order.slice(0, size), queue: order.slice(size) };
        });
    }

    // The hand slot holding `type`, or -1.
    static slotOf(state, side, type) {
        const index = state.decks[side]?.indexOf(type) ?? -1;
        return index < 0 ? -1 : (state.handCycle[side]?.hand.indexOf(index) ?? -1);
    }

    // The card in `slot` was launched. A card that leaves the cycle (a hero) gives its slot to the queue's front card
    // only while the smaller cycle still has room for it in the hand; otherwise the slot closes.
    static use(sim, side, slot) {
        const cycle = sim.handCycle[side],
            { hand, queue } = cycle,
            card = hand[slot];
        if (!LaunchRules.isHeroType(sim.decks[side][card])) {
            queue.push(card);
            hand[slot] = queue.shift();
            return;
        }
        if (hand.length - 1 < this.handSize(hand.length + queue.length - 1) && queue.length)
            hand[slot] = queue.shift();
        else {
            for (let i = slot; i < hand.length - 1; i++) hand[i] = hand[i + 1];
            hand.length--;
        }
    }

    // A hero card that was out comes back to the back of the queue; the hand refills to the cycle's size.
    static rejoin(sim, side, type) {
        const index = sim.decks[side].indexOf(type),
            { hand, queue } = sim.handCycle[side];
        if (index < 0 || hand.includes(index) || queue.includes(index))
            throw new Error(`손패 순환에 이미 있는 카드가 돌아왔습니다: ${type}`);
        queue.push(index);
        const size = this.handSize(hand.length + queue.length);
        while (hand.length < size) hand.push(queue.shift());
        sim.events.push({ type: 'cardRejoined', side, unitType: type });
    }

    // A hero placed on the field without a launch (debug scenes) leaves the cycle from wherever its card is.
    static takeOut(sim, side, type) {
        const index = sim.decks[side].indexOf(type),
            { hand, queue } = sim.handCycle[side],
            slot = hand.indexOf(index);
        if (slot >= 0) return this.use(sim, side, slot);
        const at = queue.indexOf(index);
        if (at < 0) return;
        queue.splice(at, 1);
        const size = this.handSize(hand.length + queue.length);
        while (hand.length > size) queue.unshift(hand.pop());
    }

    static validate(state) {
        if (!Array.isArray(state.handCycle) || state.handCycle.length !== 2)
            throw new Error('게임 snapshot의 손패 순환이 잘못되었습니다.');
        for (const [side, cycle] of state.handCycle.entries()) {
            const deck = state.decks[side];
            if (
                !cycle ||
                Object.keys(cycle).sort().join(',') !== 'hand,queue' ||
                !Array.isArray(cycle.hand) ||
                !Array.isArray(cycle.queue)
            )
                throw new Error('게임 snapshot의 손패 순환이 잘못되었습니다.');
            const cards = [...cycle.hand, ...cycle.queue];
            const out = deck
                .map((type, index) => index)
                .filter((index) => state.heroes[side]?.[deck[index]]);
            if (
                cards.some(
                    (index) => !Number.isSafeInteger(index) || index < 0 || index >= deck.length,
                ) ||
                new Set(cards).size !== cards.length ||
                cards.length + out.length !== deck.length ||
                out.some((index) => cards.includes(index)) ||
                cycle.hand.length !== this.handSize(cards.length)
            )
                throw new Error('게임 snapshot의 손패 순환이 경기 덱과 다릅니다.');
        }
    }
}
