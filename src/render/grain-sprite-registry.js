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
    loadPopcornSpriteCanvas,
    popcornSpritePortrait,
    PopcornSpriteRenderer,
} from './popcorn-sprite.js';
import {
    loadMilletSpriteCanvas,
    milletSpritePortrait,
    MilletSpriteRenderer,
} from './millet-sprite.js';
import {
    loadChestnutSpriteCanvas,
    chestnutSpritePortrait,
    ChestnutSpriteRenderer,
} from './chestnut-sprite.js';
import {
    loadWatermelonSpriteCanvas,
    watermelonSpritePortrait,
    WatermelonSpriteRenderer,
} from './watermelon-sprite.js';

// Approved idle artwork bounds from hat top to feet: rice 343.5, millet 311.
const MILLET_ART_SCALE = 343.5 / 311;

// Sources load concurrently. The two bean variants share one canvas and one
// atlas allocation.
const SPRITE_SOURCES = Object.freeze({
    rice: async () => buildRiceSpriteCanvas(await loadRiceSpriteImages()),
    beans: loadBeanSpriteCanvases,
    acorn: loadAcornSpriteCanvas,
    corn: loadCornSpriteCanvas,
    popcorn: loadPopcornSpriteCanvas,
    chestnut: loadChestnutSpriteCanvas,
    millet: loadMilletSpriteCanvas,
    watermelon: loadWatermelonSpriteCanvas,
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
    millet: {
        source: 'millet',
        renderer: MilletSpriteRenderer,
        portrait: milletSpritePortrait,
        groundY: 151.5,
        artScale: MILLET_ART_SCALE,
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
    popcorn: {
        source: 'popcorn',
        renderer: PopcornSpriteRenderer,
        portrait: popcornSpritePortrait,
        groundY: 145,
    },
    corn: {
        source: 'corn',
        renderer: CornSpriteRenderer,
        portrait: cornSpritePortrait,
        groundY: 148,
    },
    watermelon: {
        source: 'watermelon',
        renderer: WatermelonSpriteRenderer,
        portrait: watermelonSpritePortrait,
        groundY: 121,
    },
});

export async function loadGrainSpriteCanvases() {
    const sources = Object.fromEntries(
        await Promise.all(
            Object.entries(SPRITE_SOURCES).map(async ([id, load]) => [id, await load()]),
        ),
    );
    return Object.freeze(
        Object.fromEntries(
            Object.entries(GRAIN_SPRITES).map(([type, definition]) => {
                const source = sources[definition.source];
                return [type, source?.[type] || source];
            }),
        ),
    );
}
