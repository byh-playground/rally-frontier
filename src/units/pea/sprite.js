import {
    beanSpritePortrait,
    BeanSpriteRenderer,
    loadBeanSpriteCanvases,
} from '../../render/bean-sprite.js';

// Pea's place on the shared bean sheet.
const PEA_BEAN = Object.freeze({
    prefix: 'pea',
    body: [-145, -163, 290, 270],
    legY: 105,
    face: [-74, -45, 148, 72],
});

// This unit's sprite contract (src/units/define-unit.js), loaded only by the page, never the Worker.
export const SPRITE = Object.freeze({
    load: loadBeanSpriteCanvases,
    renderer: BeanSpriteRenderer,
    art: PEA_BEAN,
    portrait: (canvas, width) => beanSpritePortrait(canvas, PEA_BEAN, width),
    groundY: 145,
    motion: Object.freeze({
        juice: [0.66, 0.83, 0.25],
        stain: [0.43, 0.6, 0.12],
        lunge: 1.5,
        swing: 'smash',
        spark: [0.84, 1, 0.22],
    }),
});
