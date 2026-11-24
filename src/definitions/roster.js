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

// The one place that says what a player with no save owns: the first card of the campaign (rice). Every other card
// joins when a stage that rewards it (`rewardCard`) is first cleared.
export function startingOwned() {
    return [CAMPAIGN_ACT_STAGES[0].rewardCard];
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
