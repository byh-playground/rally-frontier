import { LaunchRules } from './launch-rules.js';

// Campaign-only card upgrades (the roster's `campaign.upgrades`, opened with sunshine). A match carries which upgrades
// are on for each side as `sim.campaignUpgrades = [hostCards, guestCards]`: sorted card ids, copied once when the
// match starts and never changed by the sim, so a save opened mid-match cannot reach it. It is part of the match
// identity (snapshot, replay and rollback check it the way they check the decks) and only a campaign stage may
// carry any. Ability code asks `CampaignUpgrades.has(sim, side, type)`; this class is the only reader.
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
}
