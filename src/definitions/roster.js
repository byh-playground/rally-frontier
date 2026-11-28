// What the player owns and the new campaign's sunshine economy. The roster record of src/ui/player-saves.js
// holds these; this file is where the starting set and the amounts are defined.
import { CAMPAIGN_ACT_STAGES } from './campaign.js';
import { DEFAULT_DIFFICULTY } from './campaign-pace.js';

// Sunshine paid once per item: the first clear of a stage, its side goal, and its first clear on hard.
export const SUNSHINE = Object.freeze({
    firstClear: 50,
    sideGoal: 25,
    hardFirstClear: 25,
    openUpgrade: 100,
});

// Cards available from the beginning, including new cards that have no campaign reward stage yet.
// Campaign rewards grant the rest of the roster.
export function startingOwned() {
    return [CAMPAIGN_ACT_STAGES[0].rewardCard, 'ginkgo', 'plum', 'pine-nut'];
}

export function newRosterRecord() {
    return {
        owned: startingOwned(),
        campaign: {
            firstCleared: [], // stage ids cleared at least once
            sideGoalCleared: [], // stage ids whose side goal was met
            hardCleared: [], // stage ids cleared on hard
            sunshine: 0,
            upgrades: [], // card ids whose upgrade is open
            regionOrder: [], // region ids in the order the player first cleared their first stage
            difficulty: DEFAULT_DIFFICULTY, // the enemy's difficulty the player picked last (campaign-pace.js)
            decks: {}, // stage id -> the card ids the player picked for it (campaign-deck.js)
        },
    };
}
