// The deck a player takes into a campaign stage. A stage declares a recommended deck (`deck`); the player may change
// it, so the sunshine-bought upgrades (roster.js) reach the cards they chose. The stage keeps the card it teaches in
// the deck. Everything here is a pure rule of the stage, the player's picks and the cards the player owns; the saved
// picks live in the roster record (Roster.savedDeck) and a match copies the resolved deck at its start.
import { LaunchRules } from '../sim/launch-rules.js';

export const CAMPAIGN_DECK_LIMIT = LaunchRules.deckLimit;
export const CAMPAIGN_DECK_HERO_LIMIT = LaunchRules.deckHeroLimit;

// The cards the stage keeps in the deck whatever the player picks: the one it teaches (its practice card, else its
// reward card) when its recommended deck carries it. A boss stage teaches no card of its deck.
export function campaignDeckRequired(stage) {
    const taught = [stage.practice?.card, stage.rewardCard];
    return stage.deck.filter((type) => taught.includes(type));
}

// Every card the player may bring to the stage, in the order the editor lists them: the recommended deck first
// (a card the stage lends before the first clear is in it), then the other cards the player owns.
// `owns(type)` says whether the player owns the card.
export function campaignDeckPool(stage, owns) {
    const rest = [...LaunchRules.heroTypes, ...LaunchRules.deck].filter(
        (type) => owns(type) && !stage.deck.includes(type),
    );
    return [...stage.deck, ...rest];
}

// The deck a match starts with: the saved picks cleaned up (a card no longer allowed, a duplicate, an extra hero or
// a card past the limit is dropped, the required cards come first), or the recommended deck when nothing is saved.
export function resolveCampaignDeck(stage, saved, owns) {
    if (!Array.isArray(saved)) return [...stage.deck];
    const pool = new Set(campaignDeckPool(stage, owns)),
        seen = new Set(),
        cards = [];
    let heroes = 0;
    for (const type of [...campaignDeckRequired(stage), ...saved]) {
        if (!pool.has(type) || seen.has(type) || cards.length >= CAMPAIGN_DECK_LIMIT) continue;
        if (LaunchRules.isHeroType(type) && ++heroes > CAMPAIGN_DECK_HERO_LIMIT) continue;
        seen.add(type);
        cards.push(type);
    }
    return cards.length ? cards : [...stage.deck];
}
