import {
    fruitSpritePortrait,
    FruitSpriteRenderer,
    loadFruitSpriteCanvas,
} from '../../render/fruit-sprite.js';

// Banana's rig for the shared fruit hero renderer (src/render/fruit-sprite.js).
function bananaLayers(data) {
    const { ground, parts, rest, restAngles, mirrored } = data;
    const shapes = {
        farBoot: 'boot',
        nearBoot: 'boot',
        farArm: 'arm',
        nearArm: 'arm',
        face: 'neutral',
        heldBoomerang: 'boomerang',
        body: 'body',
    };
    const gripOffset = parts.arm.grip.map((value, index) => value - parts.arm.pivot[index]);
    return data.layers.map((id) => ({
        id,
        part: shapes[id],
        parent: id === 'heldBoomerang' ? 'nearArm' : null,
        position: (id === 'heldBoomerang'
            ? rest.nearArm.map((v, i) => v + gripOffset[i])
            : rest[id]
        ).map((v, i) => v - ground[i]),
        rotation: restAngles[id] ?? 0,
        mirror: mirrored.includes(id),
        pivot: id === 'heldBoomerang' ? parts.boomerang.grip : undefined,
    }));
}

export const BANANA_RIG = Object.freeze({
    file: 'rig.json',
    layers: bananaLayers,
    arm: 'nearArm',
    combatAmmo: 'boomerang',
});

// This unit's sprite contract (src/units/define-unit.js), loaded only by the page, never the Worker.
export const SPRITE = Object.freeze({
    load: () => loadFruitSpriteCanvas('banana', BANANA_RIG),
    renderer: FruitSpriteRenderer,
    portrait: fruitSpritePortrait,
    shell: { draw: 'drawAmmo', depthTest: true },
    heroBasic: true,
    fruitAttack: true,
    groundY: 0,
});
