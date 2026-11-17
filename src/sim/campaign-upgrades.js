import { LaunchRules } from './launch-rules.js';
import { UNITS } from '../units/index.js';

// Each card's declared upgrade (Definition `campaignUpgrade`, src/units/define-unit.js), and for an effect that keeps
// something per soldier the state a new soldier starts with: `charges` (how many `hits` are left), `attacks` (thorns
// thrown since the last heavy one), `taken` (damage taken toward the next shards), `followTick`·`followId`·
// `followBuilding` (the second thorn still to throw) or `breathScale` (how much longer its flame is).
const DECLARED = Object.fromEntries(UNITS.map((card) => [card.id, card.unit.campaignUpgrade]));
const SOLDIER_STATE = Object.freeze({
    firstHitBlock: (spec) => ({ charges: spec.hits }),
    firstStrike: (spec) => ({ charges: spec.hits }),
    heavyThorn: () => ({ attacks: 0 }),
    shellShards: () => ({ taken: 0 }),
    doubleShot: () => ({ followTick: 0, followId: null, followBuilding: false }),
    longBreath: (spec) => ({ breathScale: spec.lengthScale }),
});
const SOLDIER_START = Object.fromEntries(
    UNITS.map((card) => {
        const upgrade = card.unit.campaignUpgrade,
            effect = upgrade && Object.keys(SOLDIER_STATE).find((name) => upgrade[name]);
        return [card.id, effect ? Object.freeze(SOLDIER_STATE[effect](upgrade[effect])) : null];
    }),
);

// Campaign-only card upgrades (the roster's `campaign.upgrades`, opened with sunshine). A match carries which upgrades
// are on for each side as `sim.campaignUpgrades = [hostCards, guestCards]`: sorted card ids, copied once when the
// match starts and never changed by the sim, so a save opened mid-match cannot reach it. It is part of the match
// identity (snapshot, replay and rollback check it the way they check the decks) and only a campaign stage may
// carry any. Ability code asks `CampaignUpgrades.has(sim, side, type)`; this class is the only reader.
// What an upgrade does is the card's own declaration: ability code takes its numbers from
// `CampaignUpgrades.effect(sim, side, type, '<effect>')` (null while off, so an off match runs exactly as before).
// An effect kept per soldier has `unit.campaignUpgrade = { charges }` (or `{ attacks }`, `{ taken }`, the second
// thorn's `{ followTick, followId, followBuilding }`, `{ breathScale }`), given when the soldier is created
// (StrategySim.spawnUnit) and only in a match where the upgrade is on. `chainCharge` adds `chaining` to a soldier the
// first time it chains (UpgradeChainCharge).
export class CampaignUpgrades {
    static none() {
        return [[], []];
    }

    // The canonical pair: each side a sorted, duplicate-free list of card ids; anything else is an error.
    static normalizePair(pair, campaign) {
        if (!Array.isArray(pair) || pair.length !== 2)
            throw new Error('양쪽 편의 병종 강화 목록이 필요합니다.');
        const normalized = pair.map((cards) => {
            if (
                !Array.isArray(cards) ||
                !cards.every(
                    (type) => LaunchRules.deck.includes(type) || LaunchRules.isHeroType(type),
                )
            )
                throw new Error('병종 강화는 카드 id 목록이어야 합니다.');
            return [...new Set(cards)].sort();
        });
        if (!campaign && normalized.some((cards) => cards.length))
            throw new Error('병종 강화는 캠페인 경기에서만 켤 수 있습니다.');
        return normalized;
    }

    // Builds the per-side lookup sets from `sim.campaignUpgrades` (derived; rebuilt on construction and import).
    static index(sim) {
        sim.campaignUpgradeSets = sim.campaignUpgrades.map((cards) => new Set(cards));
    }

    // Is the card's upgrade on for this side in this match? Allocation-free, safe in the tick path.
    static has(sim, side, type) {
        return sim.campaignUpgradeSets[side].has(type);
    }

    // The card's declared `effect` spec whether or not any match has it on (card copy, drawing), or null.
    static declared(type, effect) {
        return DECLARED[type]?.[effect] ?? null;
    }

    // The `effect` spec of the card's upgrade when it is on for this side in this match, else null.
    static effect(sim, side, type, effect) {
        return sim.campaignUpgradeSets[side].has(type) ? (DECLARED[type]?.[effect] ?? null) : null;
    }

    // The per-soldier state of a soldier created now, or null (off, or an effect that keeps nothing per soldier).
    static soldierState(sim, side, type) {
        const start = this.has(sim, side, type) ? SOLDIER_START[type] : null;
        return start ? { ...start } : null;
    }
}
