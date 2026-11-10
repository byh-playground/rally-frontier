const ROOT = new URL('../../../assets/sprites/sunflower-seed/', import.meta.url);
const SHEET_WIDTH = 624;
const SHEET_HEIGHT = 282;
const DEGREE = Math.PI / 180;
const REST_ANGLE = -13 * DEGREE;
const BELT_ANGLE = -14 * DEGREE;
const BELT_MOUNT = [5, 13];
const MUZZLE = [83, -0.5];
const RECOIL_MS = 120;
const BELT_SWAY_MS = 180;
const BODY_HEIGHT = 224;

export const SUNFLOWER_SEED_GROUND_Y = 10;
// Match the standing scale of the other grain sprites. The renderer still applies unit size.
export const SUNFLOWER_SEED_ART_SCALE = 343.5 / BODY_HEIGHT;

const CELL = Object.freeze({
    body: { slot: [24, 26, 178, 210], pivot: [87, 219] },
    foot: { slot: [227, 41, 40, 46], pivot: [20, 22] },
    hand: { slot: [323, 36, 32, 44], pivot: [16, 22] },
    weapon: { slot: [402, 49, 160, 55], pivot: [70, 21] },
    beltLink: { slot: [429, 231, 34, 16], pivot: [16, 8] },
    neutral: { slot: [215, 150, 84, 47], pivot: [42, 21] },
    attack: { slot: [351, 150, 84, 47], pivot: [42, 21] },
    hurt: { slot: [487, 150, 84, 47], pivot: [42, 21] },
    bullet: { slot: [229, 223, 57, 32], pivot: [26, 16] },
    shell: { slot: [492, 201, 89, 70], pivot: [41, 35] },
});
const LEFT_FOOT = [-36, -9];
const RIGHT_FOOT = [36, -9];
const REAR_HAND = [-23, 15];
const FRONT_HAND = [31, 11];
const FACE = [0, -114];
const loadedBelt = new WeakMap();

const key = (timeMs, parts = {}) => ({ timeMs, parts, easing: 'inOutSine' });
const clip = (durationMs, loop, keyframes) => ({ durationMs, loop, keyframes });
const planted = {
    leftFoot: { x: -7, rotation: 8 * DEGREE },
    rightFoot: { x: 7, rotation: -8 * DEGREE },
};

function makeRig(links) {
    return {
        parts: [
            { id: 'body', parent: null, pivot: [0, 0] },
            { id: 'leftFoot', parent: null, pivot: LEFT_FOOT },
            { id: 'rightFoot', parent: null, pivot: RIGHT_FOOT },
            { id: 'weapon', parent: 'body', pivot: [0, 0] },
            { id: 'rearHand', parent: 'weapon', pivot: REAR_HAND },
            { id: 'frontHand', parent: 'weapon', pivot: FRONT_HAND },
            { id: 'belt', parent: 'weapon', pivot: BELT_MOUNT },
            ...links.map(({ position }, index) => ({
                id: `beltLink${index}`,
                parent: 'belt',
                pivot: position,
            })),
        ],
        clips: {
            idle: clip(1200, 'repeat', [key(0), key(1200)]),
            walk: clip(700, 'repeat', [
                key(0, { rightFoot: { x: -3, y: -8, rotation: -7 * DEGREE } }),
                key(175, { rightFoot: { x: 0, y: 0, rotation: 0 } }),
                key(350, { leftFoot: { x: 3, y: -8, rotation: 7 * DEGREE } }),
                key(525, { leftFoot: { x: 0, y: 0, rotation: 0 } }),
                key(700, { rightFoot: { x: -3, y: -8, rotation: -7 * DEGREE } }),
            ]),
            fire: clip(250, 'once', [key(0, planted), key(250, planted)]),
            hit: clip(250, 'once', [key(0), key(250)]),
        },
    };
}

function restingWeapon() {
    return { x: 9, y: -51, rotation: REST_ANGLE };
}

function weaponPose(angle, recoilAgeMs) {
    if (angle == null) return restingWeapon();
    const dx = Math.cos(angle),
        dy = Math.sin(angle),
        kick = 7 * Math.max(0, 1 - recoilAgeMs / RECOIL_MS) ** 2;
    // Keep the stock above the ground when the gun is raised near vertical.
    const height = Math.max(45, dy < 0 ? -dy * 66 - 4 : dy * 87 - 4);
    return { x: 23 - dx * kick, y: -height - dy * kick, rotation: angle };
}

async function readAsset(name) {
    const response = await fetch(new URL(name, ROOT), { cache: 'no-cache' });
    if (!response.ok) throw new Error('해바라기씨 스프라이트를 불러오지 못했습니다: ' + name);
    return response;
}

export async function loadSunflowerSeedSpriteCanvas() {
    const [manifest, bytes] = await Promise.all([
        readAsset('manifest.json').then((response) => response.json()),
        readAsset('parts.svg').then((response) => response.arrayBuffer()),
    ]);
    const spec = manifest?.assets?.['parts.svg'];
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
        value.toString(16).padStart(2, '0'),
    ).join('');
    if (manifest?.schemaVersion !== 1 || spec?.bytes !== bytes.byteLength || spec.sha256 !== hash)
        throw new Error('해바라기씨 SVG 무결성 오류');

    // The original sheet owns the chain layout. Read its transforms once before upload.
    const svg = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'image/svg+xml');
    const links = [...svg.querySelectorAll('#ammo-belt > use')].map((element) => {
        const { a, b, e, f } = element.transform.baseVal.consolidate().matrix;
        return {
            position: [BELT_MOUNT[0] + e, BELT_MOUNT[1] + f],
            rotation: Math.atan2(b, a),
        };
    });
    if (links.length !== 7) throw new Error('해바라기씨 탄띠 파츠 수가 다릅니다.');

    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        if (image.naturalWidth !== SHEET_WIDTH || image.naturalHeight !== SHEET_HEIGHT)
            throw new Error('해바라기씨 스프라이트 시트 크기가 다릅니다.');
        const canvas = document.createElement('canvas');
        canvas.width = SHEET_WIDTH;
        canvas.height = SHEET_HEIGHT;
        canvas.getContext('2d').drawImage(image, 0, 0);
        loadedBelt.set(canvas, links);
        return canvas;
    } finally {
        URL.revokeObjectURL(url);
    }
}

export function sunflowerSeedSpritePortrait(source, width) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.round(width * 0.83);
    const ctx = canvas.getContext('2d'),
        scale = width / 296;
    ctx.setTransform(scale, 0, 0, scale, width / 2, canvas.height - 15 * scale);
    const draw = (cell, [x, y], angle = 0, scaleX = 1, scaleY = 1) => {
        const [px, py] = cell.pivot;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.scale(scaleX, scaleY);
        ctx.drawImage(source, ...cell.slot, -px, -py, cell.slot[2], cell.slot[3]);
        ctx.restore();
    };
    draw(CELL.foot, LEFT_FOOT);
    draw(CELL.foot, RIGHT_FOOT, 0, -1);
    draw(CELL.body, [0, 0]);
    draw(CELL.neutral, FACE);
    const { x, y, rotation } = restingWeapon();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    draw(CELL.weapon, [0, 0]);
    draw(CELL.hand, REAR_HAND, -32 * DEGREE, 0.84, 0.84);
    draw(CELL.hand, FRONT_HAND, 55 * DEGREE, 0.84, 0.84);
    ctx.translate(...BELT_MOUNT);
    ctx.rotate(BELT_ANGLE - rotation);
    for (const { position, rotation } of loadedBelt.get(source))
        draw(CELL.beltLink, [position[0] - BELT_MOUNT[0], position[1] - BELT_MOUNT[1]], rotation);
    return canvas.toDataURL('image/png');
}

export class SunflowerSeedSpriteRenderer {
    constructor(context, canvas, gamekit) {
        this.context = context;
        this.mesh = context.acquireMeshRenderer();
        this.actors = new Set();
        this.links = loadedBelt.get(canvas);
        this.rig = makeRig(this.links);
        const region = context.device.textureAtlas.allocate(canvas.width, canvas.height, {
            filter: 'linear',
        });
        try {
            context.device.textureAtlas.upload(region, canvas);
            this.source = this.mesh.createPoseSource(gamekit.compilePoseChannels(this.rig));
        } catch (error) {
            context.device.textureAtlas.release(region);
            throw error;
        }
        this.region = region;

        const build = (pieces, posed = true) => {
            const uvRects = [],
                localRects = [],
                parts = [];
            for (const [cell, [x, y], part] of pieces) {
                const [sx, sy, w, h] = cell.slot;
                const [px, py] = cell.pivot;
                const divisor = posed ? 1 : w;
                uvRects.push(
                    (region.x + sx) / region.atlas.width,
                    (region.y + sy) / region.atlas.height,
                    w / region.atlas.width,
                    h / region.atlas.height,
                );
                localRects.push((x - px) / divisor, (y - py) / divisor, w / divisor, h / divisor);
                parts.push(part);
            }
            return {
                uvRects: Float32Array.from(uvRects),
                localRects: Float32Array.from(localRects),
                ...(posed ? { parts: Float32Array.from(parts) } : {}),
            };
        };
        this.body = build([
            [CELL.foot, LEFT_FOOT, 1],
            [CELL.foot, RIGHT_FOOT, 2],
            [CELL.body, [0, 0], 0],
        ]);
        const equipment = [
            [CELL.weapon, [0, 0], 3],
            [CELL.hand, REAR_HAND, 4],
            [CELL.hand, FRONT_HAND, 5],
            ...this.links.map(({ position }, index) => [CELL.beltLink, position, 7 + index]),
        ];
        this.front = Object.fromEntries(
            ['neutral', 'attack', 'hurt'].map((face) => [
                face,
                build([[CELL[face], FACE, 0], ...equipment]),
            ]),
        );
        this.ammo = build([[CELL.shell, [0, 0]]], false);
        this.combatAmmo = build([[CELL.bullet, [0, 0]]], false);
        context.onDispose(() => this.dispose());
    }

    createActor() {
        const owner = this,
            instance = this.mesh.createPoseInstance(this.source),
            basePoses = this.rig.parts.map(() => ({
                x: 0,
                y: 0,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                opacity: 1,
            })),
            visible = this.rig.parts.map(() => true);
        basePoses[2].scaleX = -1;
        for (const [index, rotation] of [
            [4, -32],
            [5, 55],
        ])
            Object.assign(basePoses[index], {
                rotation: rotation * DEGREE,
                scaleX: 0.84,
                scaleY: 0.84,
            });
        for (const [index, { rotation }] of this.links.entries())
            basePoses[7 + index].rotation = rotation;
        const actor = {
            currentClip: 'idle',
            startedAt: 0,
            elapsed: 0,
            disposed: false,
            aimAngle: null,
            shotsSpent: 0,
            recoilAgeMs: Infinity,
            pose: null,
            muzzle: [0, 0],
            play(name) {
                this.currentClip = name in owner.rig.clips ? name : 'idle';
                this.startedAt = name === 'idle' || name === 'walk' ? 0 : null;
                return this;
            },
            seek(time) {
                if (this.startedAt === null) this.startedAt = time;
                return this.seekElapsed(time - this.startedAt);
            },
            seekElapsed(elapsed) {
                this.elapsed = Math.max(0, elapsed);
                return this;
            },
            setWeaponState({ aimAngle = null, shotsSpent = 0, recoilAgeMs = Infinity }) {
                this.aimAngle = Number.isFinite(aimAngle) ? aimAngle : null;
                this.shotsSpent = Math.max(0, Math.min(owner.links.length, Math.floor(shotsSpent)));
                this.recoilAgeMs = Math.max(0, recoilAgeMs);
            },
            preparePose() {
                const { x, y, rotation } = weaponPose(this.aimAngle, this.recoilAgeMs);
                Object.assign(basePoses[3], { x, y, rotation });
                const sway = this.recoilAgeMs / BELT_SWAY_MS;
                basePoses[6].rotation =
                    BELT_ANGLE -
                    rotation +
                    (sway < 1 ? 17 * DEGREE * (1 - sway) * Math.sin(2 * Math.PI * sway) : 0);
                for (let index = 0; index < owner.links.length; index++)
                    visible[7 + index] = index < owner.links.length - this.shotsSpent;

                const gait =
                    this.currentClip === 'walk'
                        ? Math.sin((this.elapsed / owner.rig.clips.walk.durationMs) * Math.PI * 2)
                        : 0;
                const flinch =
                    this.currentClip === 'hit'
                        ? Math.max(0, 1 - this.elapsed / owner.rig.clips.hit.durationMs)
                        : 0;
                const body = basePoses[0];
                body.y = -4 * Math.abs(gait);
                body.rotation = gait * -2 * DEGREE - flinch * 5 * DEGREE;
                body.scaleX = 1 + 0.08 * flinch;
                body.scaleY = 1 - 0.1 * flinch;

                const [mx, my] = MUZZLE;
                const weaponX =
                    (x + mx * Math.cos(rotation) - my * Math.sin(rotation)) * body.scaleX;
                const weaponY =
                    (y + mx * Math.sin(rotation) + my * Math.cos(rotation)) * body.scaleY;
                this.muzzle[0] =
                    weaponX * Math.cos(body.rotation) - weaponY * Math.sin(body.rotation);
                this.muzzle[1] =
                    weaponX * Math.sin(body.rotation) + weaponY * Math.cos(body.rotation) + body.y;
                this.pose = owner.mesh.preparePose(instance, {
                    clipName: this.currentClip,
                    elapsedMs: this.elapsed,
                    basePoses,
                    visible,
                    morph: [0, 0],
                });
                if (!this.pose) throw new Error('해바라기씨 GPU 포즈를 준비하지 못했습니다.');
                return this.pose;
            },
            dispose() {
                if (this.disposed) return false;
                this.disposed = true;
                owner.actors.delete(this);
                return owner.mesh.deletePoseInstance(instance);
            },
        };
        this.actors.add(actor);
        return actor;
    }

    draw(data, matrix, depth, actor = null, depthWriteAlphaThreshold = 0) {
        this.context.depth = depth;
        this.context.drawQuads({
            layer: this.region.layer,
            filter: this.region.filter,
            ...data,
            ...(actor ? { pose: actor.pose } : {}),
            matrix,
            depthWriteAlphaThreshold,
        });
    }

    drawBody(actor, matrix, depth) {
        this.draw(this.body, matrix, depth, actor, 0.05);
    }

    drawFace(actor, matrix, depth, face) {
        this.draw(this.front[face] || this.front.neutral, matrix, depth, actor);
    }

    drawAmmo(matrix, depth) {
        this.draw(this.ammo, matrix, depth);
    }

    drawCombatAmmo(matrix, depth) {
        this.draw(this.combatAmmo, matrix, depth);
    }

    weaponSocket(matrix, actor) {
        const [x, y] = actor.muzzle;
        return [
            matrix[0] * x + matrix[2] * y + matrix[4],
            matrix[1] * x + matrix[3] * y + matrix[5],
        ];
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const actor of this.actors) actor.dispose();
        this.mesh.deletePoseSource(this.source);
        this.context.device.textureAtlas.release(this.region);
    }
}

// This unit's sprite contract (src/units/define-unit.js), loaded only by the page, never the Worker.
export const SPRITE = Object.freeze({
    load: loadSunflowerSeedSpriteCanvas,
    renderer: SunflowerSeedSpriteRenderer,
    portrait: sunflowerSeedSpritePortrait,
    shell: { draw: 'drawAmmo', depthTest: true },
    groundY: SUNFLOWER_SEED_GROUND_Y,
    artScale: SUNFLOWER_SEED_ART_SCALE,
});
