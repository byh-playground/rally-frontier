// Card ammo. Every deck card stays in the hand; a launch spends one round of the card and a card with no round
// cannot launch. A card below its max refills one round per its recharge time, the next round starting where the
// last one finished. A match starts full. LaunchRules.ammo(type) gives { max, rechargeMs } (payload.ammo, else the
// food/oil defaults in src/units/baseline.js); a hero card has none and is never limited here.
//
// State (authoritative, StateContract save/checksum/replay): sim.cardAmmo[side] = { rounds, readyTick, phase },
// integer arrays by deck card index. rounds is the rounds left, readyTick the tick the next round arrives (0 when
// full), phase the accumulating timer's carry (SimulationTiming.timerTotal). Hero entries stay 0.
//
// A volley spends one round however many cannons join; a launch refused before it fires (overheat, reload…)
// spends none; a spent round is the presentation event cardAmmoSpent. update() runs once per tick, in place,
// without allocation.
import { SimulationTiming } from '../core/simulation-timing.js';
import { LaunchRules } from './launch-rules.js';

export class CardAmmo {
    static create(decks) {
        return decks.map((deck) => ({
            rounds: deck.map((type) => LaunchRules.ammo(type)?.max ?? 0),
            readyTick: deck.map(() => 0),
            phase: deck.map(() => 0),
        }));
    }

    // True when the card can launch: a hero, or a card with a round left.
    static ready(state, side, type) {
        if (!LaunchRules.ammo(type)) return true;
        const index = state.decks[side]?.indexOf(type) ?? -1;
        return index >= 0 && state.cardAmmo[side].rounds[index] > 0;
    }

    static schedule(sim, ammo, index, rechargeMs, fromTick) {
        const total = SimulationTiming.timerTotal(rechargeMs, sim.tps, ammo.phase[index]);
        ammo.readyTick[index] = fromTick + Math.max(1, Math.floor(total / 1000));
        ammo.phase[index] = total % 1000;
    }

    // One round of `type` is spent (a launch that fired). A full card starts recharging now.
    static spend(sim, side, type) {
        const spec = LaunchRules.ammo(type);
        if (!spec) return;
        const ammo = sim.cardAmmo[side],
            index = sim.decks[side].indexOf(type);
        ammo.rounds[index]--;
        if (!ammo.readyTick[index]) this.schedule(sim, ammo, index, spec.rechargeMs, sim.tick);
        sim.events.push({
            type: 'cardAmmoSpent',
            side,
            unitType: type,
            rounds: ammo.rounds[index],
        });
    }

    static update(sim) {
        for (let side = 0; side < 2; side++) {
            const deck = sim.decks[side],
                ammo = sim.cardAmmo[side];
            for (let index = 0; index < deck.length; index++) {
                const ready = ammo.readyTick[index];
                if (!ready || sim.tick < ready) continue;
                const spec = LaunchRules.ammo(deck[index]);
                ammo.rounds[index]++;
                if (ammo.rounds[index] < spec.max)
                    this.schedule(sim, ammo, index, spec.rechargeMs, ready);
                else {
                    ammo.readyTick[index] = 0;
                    ammo.phase[index] = 0;
                }
            }
        }
    }

    static validate(state) {
        const bad = () => {
            throw new Error('게임 snapshot의 카드 탄약이 잘못되었습니다.');
        };
        if (!Array.isArray(state.cardAmmo) || state.cardAmmo.length !== 2) bad();
        for (const [side, ammo] of state.cardAmmo.entries()) {
            const deck = state.decks[side];
            if (!ammo || Object.keys(ammo).sort().join(',') !== 'phase,readyTick,rounds') bad();
            for (const key of ['rounds', 'readyTick', 'phase'])
                if (
                    !Array.isArray(ammo[key]) ||
                    ammo[key].length !== deck.length ||
                    ammo[key].some((value) => !Number.isSafeInteger(value) || value < 0)
                )
                    bad();
            for (const [index, type] of deck.entries()) {
                const spec = LaunchRules.ammo(type),
                    rounds = ammo.rounds[index],
                    ready = ammo.readyTick[index];
                if (!spec) {
                    if (rounds || ready || ammo.phase[index]) bad();
                } else if (
                    rounds > spec.max ||
                    ammo.phase[index] >= 1000 ||
                    rounds < spec.max !== ready > 0
                )
                    bad();
            }
        }
    }
}
