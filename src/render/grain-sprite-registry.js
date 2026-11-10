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
import { loadFruitSpriteCanvas, fruitSpritePortrait, FruitSpriteRenderer } from './fruit-sprite.js';
import {
    loadPeanutSpriteCanvas,
    peanutSpritePortrait,
    PeanutSpriteRenderer,
    PEANUT_ART_SCALE,
} from './peanut-sprite.js';
import {
    loadStickyRiceSpriteCanvas,
    stickyRiceSpritePortrait,
    StickyRiceSpriteRenderer,
    STICKY_RICE_ART_SCALE,
} from './sticky-rice-sprite.js';
import {
    loadPotatoSpriteCanvas,
    potatoSpritePortrait,
    PotatoSpriteRenderer,
    POTATO_ART_SCALE,
} from './potato-sprite.js';
import {
    loadBlackBeanSpriteCanvas,
    blackBeanSpritePortrait,
    BlackBeanSpriteRenderer,
    BLACK_BEAN_ART_SCALE,
} from './black-bean-sprite.js';
import {
    loadSunflowerSeedSpriteCanvas,
    SUNFLOWER_SEED_ART_SCALE,
    SUNFLOWER_SEED_GROUND_Y,
    sunflowerSeedSpritePortrait,
    SunflowerSeedSpriteRenderer,
} from './sunflower-seed-sprite.js';

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
    banana: () => loadFruitSpriteCanvas('banana'),
    grape: () => loadFruitSpriteCanvas('grape'),
    'sunflower-seed': loadSunflowerSeedSpriteCanvas,
    peanut: loadPeanutSpriteCanvas,
    'sticky-rice': loadStickyRiceSpriteCanvas,
    potato: loadPotatoSpriteCanvas,
    'black-bean': loadBlackBeanSpriteCanvas,
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
        heroBasic: true,
        cannonAmmo: true,
        groundY: 121,
    },
    banana: {
        source: 'banana',
        renderer: FruitSpriteRenderer,
        portrait: fruitSpritePortrait,
        cannonAmmo: true,
        heroBasic: true,
        fruitAttack: true,
        groundY: 0,
    },
    grape: {
        source: 'grape',
        renderer: FruitSpriteRenderer,
        portrait: fruitSpritePortrait,
        cannonAmmo: true,
        heroBasic: true,
        fruitAttack: true,
        groundY: 0,
    },
    'sunflower-seed': {
        source: 'sunflower-seed',
        renderer: SunflowerSeedSpriteRenderer,
        portrait: sunflowerSeedSpritePortrait,
        cannonAmmo: true,
        groundY: SUNFLOWER_SEED_GROUND_Y,
        artScale: SUNFLOWER_SEED_ART_SCALE,
    },
    peanut: {
        source: 'peanut',
        renderer: PeanutSpriteRenderer,
        portrait: peanutSpritePortrait,
        cannonAmmo: true,
        groundY: 0,
        artScale: PEANUT_ART_SCALE,
    },
    'sticky-rice': {
        source: 'sticky-rice',
        renderer: StickyRiceSpriteRenderer,
        portrait: stickyRiceSpritePortrait,
        cannonAmmo: true,
        groundY: 0,
        artScale: STICKY_RICE_ART_SCALE,
    },
    potato: {
        source: 'potato',
        renderer: PotatoSpriteRenderer,
        portrait: potatoSpritePortrait,
        cannonAmmo: true,
        groundY: 0,
        artScale: POTATO_ART_SCALE,
    },
    'black-bean': {
        source: 'black-bean',
        renderer: BlackBeanSpriteRenderer,
        portrait: blackBeanSpritePortrait,
        cannonAmmo: true,
        groundY: 0,
        artScale: BLACK_BEAN_ART_SCALE,
    },
});

// `boot` is the GameKit startup progress: one item per sprite source.
export async function loadGrainSpriteCanvases(boot) {
    const entries = Object.entries(SPRITE_SOURCES);
    boot.begin('sprites', entries.length);
    const sources = Object.fromEntries(
        await Promise.all(
            entries.map(async ([id, load]) => {
                const canvas = await load();
                boot.advance('sprites');
                return [id, canvas];
            }),
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
