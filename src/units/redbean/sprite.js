import {
    beanSpritePortrait,
    BeanSpriteRenderer,
    loadBeanSpriteCanvases,
} from '../../render/bean-sprite.js';

// Red bean's place on the shared bean sheet.
const RED_BEAN = Object.freeze({
    prefix: 'red',
    body: [-110, -141.5, 220, 265],
    legY: 117,
    face: [-61, -64, 148, 72],
});

// This unit's sprite contract (src/units/define-unit.js), loaded only by the page, never the Worker.
export const SPRITE = Object.freeze({
    load: loadBeanSpriteCanvases,
    renderer: BeanSpriteRenderer,
    art: RED_BEAN,
    portrait: (canvas, width) => beanSpritePortrait(canvas, RED_BEAN, width),
    groundY: 145,
});
