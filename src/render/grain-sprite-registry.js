import {
    loadRiceSpriteImages,
    buildRiceSpriteCanvas,
    riceSpritePortrait,
    RiceSpriteRenderer,
} from './rice-sprite.js';
import { loadBeanSpriteCanvases, beanSpritePortrait, BeanSpriteRenderer } from './bean-sprite.js';
import { loadAcornSpriteCanvas, acornSpritePortrait, AcornSpriteRenderer } from './acorn-sprite.js';
import { loadCornSpriteCanvas, cornSpritePortrait, CornSpriteRenderer } from './corn-sprite.js';
import {
    loadChestnutSpriteCanvas,
    chestnutSpritePortrait,
    ChestnutSpriteRenderer,
} from './chestnut-sprite.js';

// Source order preserves the existing verified asset-loading sequence. The two
// bean variants share one canvas and one atlas allocation.
const SPRITE_SOURCES = Object.freeze({
    rice: async () => buildRiceSpriteCanvas(await loadRiceSpriteImages()),
    beans: loadBeanSpriteCanvases,
    acorn: loadAcornSpriteCanvas,
    corn: loadCornSpriteCanvas,
    chestnut: loadChestnutSpriteCanvas,
});

// Insertion order is the actual atlas allocation order and is also used by the
// initial GPU layer estimator. Visual-specific draw behavior remains on each renderer.
export const GRAIN_SPRITES = Object.freeze({
    rice: {
        source: 'rice',
        renderer: RiceSpriteRenderer,
        portrait: riceSpritePortrait,
        groundY: 145,
    },
    acorn: {
        source: 'acorn',
        renderer: AcornSpriteRenderer,
        portrait: acornSpritePortrait,
        groundY: 145,
    },
    chestnut: {
        source: 'chestnut',
        renderer: ChestnutSpriteRenderer,
        portrait: chestnutSpritePortrait,
        groundY: 145,
    },
    pea: {
        source: 'beans',
        renderer: BeanSpriteRenderer,
        portrait: (canvas, width) => beanSpritePortrait(canvas, 'pea', width),
        groundY: 145,
    },
    redbean: {
        source: 'beans',
        renderer: BeanSpriteRenderer,
        portrait: (canvas, width) => beanSpritePortrait(canvas, 'redbean', width),
        groundY: 145,
    },
    corn: {
        source: 'corn',
        renderer: CornSpriteRenderer,
        portrait: cornSpritePortrait,
        groundY: 148,
    },
});

export async function loadGrainSpriteCanvases() {
    const sources = {};
    for (const [id, load] of Object.entries(SPRITE_SOURCES)) sources[id] = await load();
    return Object.freeze(
        Object.fromEntries(
            Object.entries(GRAIN_SPRITES).map(([type, definition]) => {
                const source = sources[definition.source];
                return [type, source?.[type] || source];
            }),
        ),
    );
}
