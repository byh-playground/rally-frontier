// Every unit's sprite contract, read from the unit folders (src/units) during boot. The contracts are
// lazy imports so the simulation Worker, which also reads UNITS, never loads art. UNITS order is the
// actual atlas allocation order and is also used by the initial GPU layer estimator. Visual-specific
// draw behavior remains on each renderer.
import { UNITS } from '../units/index.js';

// Filled once by loadGrainSpriteCanvases before any renderer, portrait or showcase reads it.
export const GRAIN_SPRITES = {};

// `boot` is the GameKit startup progress: one item per sprite source. Sources load concurrently;
// cards that share a loader (the two beans) share one canvas and one atlas allocation.
export async function loadGrainSpriteCanvases(boot) {
    const specs = await Promise.all(UNITS.map((card) => card.sprite()));
    UNITS.forEach((card, index) => (GRAIN_SPRITES[card.id] = specs[index]));
    Object.freeze(GRAIN_SPRITES);
    const loaders = [...new Set(specs.map((spec) => spec.load))];
    boot.begin('sprites', loaders.length);
    const canvases = new Map(
        await Promise.all(
            loaders.map(async (load) => {
                const canvas = await load();
                boot.advance('sprites');
                return [load, canvas];
            }),
        ),
    );
    return Object.freeze(
        Object.fromEntries(UNITS.map((card, index) => [card.id, canvases.get(specs[index].load)])),
    );
}
