// Every card in the game. Adding a unit: create its folder (see ./define-unit.js) and list it here.
// Order is the deck order (heroes first), the starter deck, the result-stat rows and the sprite atlas order.
import { Watermelon } from './watermelon/index.js';
import { Banana } from './banana/index.js';
import { Grape } from './grape/index.js';
import { Rice } from './rice/index.js';
import { Pea } from './pea/index.js';
import { Corn } from './corn/index.js';
import { Popcorn } from './popcorn/index.js';
import { Millet } from './millet/index.js';
import { Chestnut } from './chestnut/index.js';
import { Redbean } from './redbean/index.js';
import { Acorn } from './acorn/index.js';
import { SunflowerSeed } from './sunflower-seed/index.js';
import { Peanut } from './peanut/index.js';
import { StickyRice } from './sticky-rice/index.js';
import { Potato } from './potato/index.js';
import { BlackBean } from './black-bean/index.js';
import { Walnut } from './walnut/index.js';
import { Dandelion } from './dandelion/index.js';

export const UNITS = Object.freeze([
    Watermelon,
    Banana,
    Grape,
    Rice,
    Pea,
    Corn,
    Popcorn,
    Millet,
    Chestnut,
    Redbean,
    Acorn,
    SunflowerSeed,
    Peanut,
    StickyRice,
    Potato,
    BlackBean,
    Walnut,
    Dandelion,
]);

const byId = new Map();
for (const card of UNITS) {
    if (byId.has(card.id)) throw new Error('병종 id가 겹칩니다: ' + card.id);
    byId.set(card.id, card);
}

export function unitCard(id) {
    return byId.get(id) || null;
}
