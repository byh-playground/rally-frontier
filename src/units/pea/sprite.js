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
});
