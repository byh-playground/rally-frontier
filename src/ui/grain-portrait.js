import { RallyGamekit } from '../core/gamekit.js';
import { riceSpritePortrait } from '../render/rice-sprite.js';
import { beanSpritePortrait } from '../render/bean-sprite.js';
import { acornSpritePortrait } from '../render/acorn-sprite.js';
import { cornSpritePortrait } from '../render/corn-sprite.js';
import { chestnutSpritePortrait } from '../render/chestnut-sprite.js';

const { drawFacePaths } = RallyGamekit;

// Title and card portraits use the same artwork as the battlefield.
const PORTRAITS = new Map();

export function grainPortrait(type, compiled, width = 160) {
    const KEY = type + ':' + width;
    if (!PORTRAITS.has(KEY)) {
        PORTRAITS.set(KEY, renderPortrait(type, compiled, width));
    }
    return PORTRAITS.get(KEY);
}

async function renderPortrait(type, compiled, width) {
    if (type === 'rice') return riceSpritePortrait(globalThis.RiceSpriteCanvas, width);
    if (type === 'acorn') return acornSpritePortrait(globalThis.AcornSpriteCanvas, width);
    if (type === 'corn') return cornSpritePortrait(globalThis.CornSpriteCanvas, width);
    if (type === 'chestnut') return chestnutSpritePortrait(globalThis.ChestnutSpriteCanvas, width);
    if (globalThis.BeanSpriteCanvases?.[type])
        return beanSpritePortrait(globalThis.BeanSpriteCanvases[type], type, width);
    const [VX, VY, VW, VH] = compiled.viewBox,
        SCALE = width / VW,
        BODY = new Image();
    BODY.src = new URL('../../assets/units/' + type + '.svg', import.meta.url).href;
    await BODY.decode();
    const CANVAS = document.createElement('canvas');
    CANVAS.width = width;
    CANVAS.height = Math.round(VH * SCALE);
    const C = CANVAS.getContext('2d');
    C.drawImage(BODY, 0, 0, CANVAS.width, CANVAS.height);
    C.setTransform(SCALE, 0, 0, SCALE, -VX * SCALE, -VY * SCALE);
    drawFacePaths(C, compiled, 'neutral');
    return CANVAS.toDataURL('image/png');
}
