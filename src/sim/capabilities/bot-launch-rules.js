// Capability-owned bot launch rules. BotController.runLaunch decides in this order:
//   1. threat defense near the own base
//   2. stage 'opening' rules      — StickyCling (sticky rice onto an enemy outpost muzzle)
//   3. range upgrade · capture · oil-outpost attack
//   4. the nearest ordinary shot (units, oil targets, buildings)
//   5. stage 'fallback' rules     — ForwardCannon (a potato toward the enemy base), only with no shot
//   6. the enemy base itself
// Within a stage, rules run in this list's order. A rule's units are the deck cards whose Unit
// Definition has its `capability`; `ownShotOnly` cards fire only through their rule.
import { ForwardCannon } from './forward-cannon.js';
import { StickyCling } from './sticky-cling.js';

export const BOT_LAUNCH_RULES = Object.freeze([StickyCling.botLaunch, ForwardCannon.botLaunch]);
