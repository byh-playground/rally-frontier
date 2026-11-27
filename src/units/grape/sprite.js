import {
    fruitSpritePortrait,
    FruitSpriteRenderer,
    loadFruitSpriteCanvas,
} from '../../render/fruit-sprite.js';

// Grape's rig for the shared fruit hero renderer (src/render/fruit-sprite.js).
export const GRAPE_RIG = Object.freeze({
    file: 'layout.json',
    layers: (layout) => layout.standing,
    arm: 'rightHand',
    combatAmmo: 'berry',
});

// This unit's sprite contract (src/units/define-unit.js), loaded only by the page, never the Worker.
export const SPRITE = Object.freeze({
    load: () => loadFruitSpriteCanvas('grape', GRAPE_RIG),
    renderer: FruitSpriteRenderer,
    portrait: fruitSpritePortrait,
    heroBasic: true,
    fruitAttack: true,
    groundY: 0,
    motion: Object.freeze({
        juice: [0.6, 0.32, 0.75],
        stain: [0.4, 0.16, 0.55],
        spark: [0.68, 0.38, 1],
        ownFacing: true,
        walkMs: 600,
    }),
});
