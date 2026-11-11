import { drawUnitQuads } from '../../render/dead-unit-look.js';
const ROOT = new URL('../../../assets/sprites/potato/', import.meta.url);
const SHEET_SIZE = [680, 360];
// Body top to the feet's ground contact in sheet units. A standing potato is as tall as rice's 343.5 (초안).
const STANDING_HEIGHT = 188;
export const POTATO_ART_SCALE = 343.5 / STANDING_HEIGHT;
const DEGREE = Math.PI / 180;

const cells = {
    body: { slot: [10, 10, 196, 186], pivot: [98, 178] },
    foot: { slot: [215, 12, 56, 42], pivot: [28, 14] },
    arm: { slot: [278, 8, 50, 60], pivot: [24, 10] },
    shovel: { slot: [334, 4, 60, 156], pivot: [30, 62] },
    sprout: { slot: [400, 6, 74, 72], pivot: [32, 66] },
    bud: { slot: [478, 8, 84, 84], pivot: [20, 42] },
    vine: { slot: [566, 4, 104, 176], pivot: [52, 170] },
    neutral: { slot: [10, 206, 98, 45], pivot: [49, 22] },
    attack: { slot: [115, 206, 98, 45], pivot: [49, 22] },
    hurt: { slot: [220, 206, 98, 45], pivot: [49, 22] },
    effort: { slot: [325, 206, 98, 45], pivot: [49, 22] },
    moundBack: { slot: [10, 262, 224, 90], pivot: [112, 70] },
    moundFront: { slot: [242, 276, 224, 76], pivot: [112, 40] },
    ammo: { slot: [474, 186, 124, 106], pivot: [62, 60] },
};
// Pose channels, shared by the three stages (GameKit allows 16). The trunk carries the body and
// everything that leans with it; each stage gives every channel its own base pose.
const channels = [
    { id: 'trunk', parent: null, pivot: [0, 0] },
    { id: 'sprout', parent: 'trunk', pivot: [8, -164] },
    { id: 'face', parent: 'trunk', pivot: [0, -92] },
    { id: 'leftFoot', parent: 'trunk', pivot: [-36, -12] },
    { id: 'rightFoot', parent: 'trunk', pivot: [36, -12] },
    { id: 'shovel', parent: 'trunk', pivot: [82, -102] },
    { id: 'leftArm', parent: 'trunk', pivot: [-86, -74] },
    { id: 'rightArm', parent: 'trunk', pivot: [84, -82] },
    { id: 'bud', parent: 'trunk', pivot: [70, -110] },
    { id: 'plantedShovel', parent: null, pivot: [-118, -56] },
    { id: 'moundBack', parent: null, pivot: [0, 10] },
    { id: 'moundFront', parent: null, pivot: [0, 14] },
    { id: 'vine', parent: null, pivot: [2, 12] },
];
// A trunk turned by `rotation` about `center` and then moved by `offset`, as a pose about (0, 0).
const leaning = (rotation, center, offset) => ({
    rotation,
    x: center[0] + offset[0] - (Math.cos(rotation) * center[0] - Math.sin(rotation) * center[1]),
    y: center[1] + offset[1] - (Math.sin(rotation) * center[0] + Math.cos(rotation) * center[1]),
});
// The approved stage assemblies, ground point at the origin, in draw order. A piece names its
// channel, its cell (null: the expression face) and its place inside its parent.
const piece = (channel, cell, position, pose = {}) => ({ channel, cell, position, ...pose });
const stages = {
    standing: {
        trunk: {},
        body: [
            piece('leftFoot', 'foot', [-36, -12], { scaleX: -1 }),
            piece('rightFoot', 'foot', [36, -12]),
            piece('sprout', 'sprout', [8, -164]),
            piece('shovel', 'shovel', [82, -102], {
                rotation: -150 * DEGREE,
                scaleX: 1.12,
                scaleY: 1.12,
            }),
            piece('trunk', 'body', [0, 0]),
        ],
        front: [
            piece('face', null, [0, -92]),
            piece('leftArm', 'arm', [-86, -74], { scaleX: -1 }),
            piece('rightArm', 'arm', [84, -82], { rotation: -30 * DEGREE }),
        ],
    },
    // 0–2 s: the shovel stuck beside it, half sunk in a mound, the sprout growing.
    dig: {
        trunk: { y: 40, rotation: -5 * DEGREE },
        body: [
            piece('moundBack', 'moundBack', [0, 10], { scaleX: 1.1 }),
            piece('plantedShovel', 'shovel', [-118, -56], {
                rotation: -14 * DEGREE,
                scaleX: 0.9,
                scaleY: 0.9,
            }),
            piece('sprout', 'sprout', [8, -164], { scaleX: 1.4, scaleY: 1.4 }),
            piece('trunk', 'body', [0, 0]),
        ],
        front: [
            piece('face', 'effort', [0, -92]),
            piece('moundFront', 'moundFront', [0, 14], { scaleX: 1.15 }),
        ],
    },
    // 2 s until the cannon: tipped back on a vine cradle with a short barrel bud.
    root: {
        trunk: leaning(-18 * DEGREE, [0, -83], [4, -5]),
        body: [
            piece('moundBack', 'moundBack', [0, 10], { scaleX: 1.15, scaleY: 1.1 }),
            piece('sprout', 'sprout', [-86, -96], {
                rotation: -78 * DEGREE,
                scaleX: 1.4,
                scaleY: 1.4,
            }),
            piece('trunk', 'body', [0, 0]),
            piece('bud', 'bud', [70, -110], {
                rotation: -24 * DEGREE,
                scaleX: 1.3,
                scaleY: 1.3,
            }),
            piece('vine', 'vine', [2, 12], { scaleX: 0.85, scaleY: 0.62 }),
            piece('moundFront', 'moundFront', [0, 14], { scaleX: 1.15 }),
        ],
        front: [],
    },
};
const channelIndex = new Map(channels.map(({ id }, index) => [id, index]));
const stagePoses = Object.fromEntries(
    Object.entries(stages).map(([stage, { trunk, body, front }]) => {
        const poses = channels.map(() => ({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }));
        for (const { channel, position, rotation = 0, scaleX = 1, scaleY = 1 } of [
            ...body,
            ...front,
        ]) {
            if (channel === 'trunk') continue;
            const { pivot } = channels[channelIndex.get(channel)];
            Object.assign(poses[channelIndex.get(channel)], {
                x: position[0] - pivot[0],
                y: position[1] - pivot[1],
                rotation,
                scaleX,
                scaleY,
            });
        }
        Object.assign(poses[0], trunk);
        return [stage, poses];
    }),
);
// Squirm while it turns into the cannon, a pure function of the milliseconds spent rooting (cannonTick
// in the simulation, interpolated by the renderer) so replays and pauses show the same frame. Every
// channel gets its own phase and size on top of its stage pose, and the shape progresses inside each
// stage: the mound heaps up and the body sinks in while digging; the bud, vine and leaf grow while
// rooting; the body pulses and sways; the last 0.5 s swells into a pop that shrinks away at the end.
const DIG_MS = 2000,
    ROOT_MS = 5000,
    DEG = Math.PI / 180;
const clamp01 = (value) => Math.min(1, Math.max(0, value));
const smooth = (value) => value * value * (3 - 2 * value);
// Squash and stretch that keeps the volume: stretching narrows, squashing widens.
const volume = (pose, stretch) => {
    pose.scaleY *= 1 + stretch;
    pose.scaleX /= 1 + stretch;
};
function squirm(poses, stage, ms) {
    const at = (id) => poses[channelIndex.get(id)];
    const trunk = at('trunk');
    // 0.5 s per spade stroke while digging; the breathing speeds up from 1.2 to 2.4 Hz while rooting.
    const stroke = (ms / 500) * Math.PI * 2;
    const rootAge = Math.max(0, ms - DIG_MS) / 1000,
        progress = clamp01((ms - DIG_MS) / (ROOT_MS - DIG_MS)),
        breath = Math.PI * 2 * (1.2 * rootAge + 0.2 * rootAge * rootAge),
        urgency = progress * progress;
    // The pop: a small squash, then a swell; the soldier shrinks away on its very last frames.
    const popAge = clamp01((ms - 4400) / 400),
        pop =
            (1 -
                (popAge < 0.35 ? 0.1 * Math.sin((Math.PI * popAge) / 0.35) : 0) +
                0.35 * smooth(clamp01((popAge - 0.35) / 0.65)) ** 2) *
            (1 - 0.85 * smooth(clamp01((ms - 4800) / 180)));
    // Crossing from digging to rooting swells up and springs back, so the change of poses is covered.
    const hop =
        ms < DIG_MS
            ? 0.14 * smooth(clamp01((ms - 1800) / 200))
            : 0.14 * Math.exp(-rootAge * 6) * Math.cos(rootAge * 11);
    if (stage === 'dig') {
        const grow = clamp01(ms / DIG_MS),
            s = Math.sin(stroke),
            lag = Math.sin(stroke - 1.1);
        volume(trunk, (s > 0 ? 0.2 : 0.14) * s + hop);
        // Lift on the up stroke, drop on the down stroke, sinking into the ground as it goes.
        trunk.y += -16 * s - 28 * (1 - grow) + 8 * grow;
        trunk.x += 5 * Math.sin(stroke * 0.5 + 0.4);
        trunk.rotation += 8 * DEG * Math.sin(stroke * 0.5 + 0.9);
        const sprout = at('sprout');
        sprout.rotation += 20 * DEG * lag;
        sprout.scaleY *= 1 + 0.2 * lag;
        sprout.scaleX *= 1 - 0.1 * lag;
        const shovel = at('plantedShovel');
        shovel.rotation += 12 * DEG * Math.sin(stroke + 0.5);
        shovel.y += -9 * Math.max(0, Math.sin(stroke + 0.5));
        for (const [id, size] of [
            ['moundBack', 1],
            ['moundFront', 1.3],
        ]) {
            const mound = at(id),
                heap = 0.12 + 0.88 * smooth(grow),
                puff = Math.max(0, Math.sin(stroke - 0.4)) * size;
            mound.scaleX *= heap * (1 + 0.06 * puff);
            mound.scaleY *= heap * (1 + 0.14 * puff);
        }
        return;
    }
    const wave = Math.sin(breath),
        lag = Math.sin(breath - 0.9),
        grow = smooth(progress),
        shake = Math.PI * 2 * 15 * rootAge;
    // A pulse of 12-15 % that slowly gets bigger, on a body that keeps growing.
    volume(trunk, (0.12 + 0.04 * progress) * wave + hop);
    trunk.scaleX *= (1 + 0.12 * grow) * pop;
    trunk.scaleY *= (1 + 0.12 * grow) * pop;
    trunk.x += 4 * urgency * Math.sin(shake) + 3 * Math.sin(breath * 0.5 + 1.3);
    // A slow sway that the 0.1 s frames can see, and a fast tremble on top of it near the end.
    trunk.rotation +=
        DEG *
        ((4 + 5 * progress) * Math.sin(breath * 0.5 + 0.7) + 3 * urgency * Math.sin(shake * 1.3));
    const sprout = at('sprout');
    sprout.rotation += DEG * (10 + 8 * progress) * lag;
    const leaf = 0.7 + 0.5 * grow;
    sprout.scaleX *= leaf * (1 + 0.14 * Math.sin(breath - 1.6));
    sprout.scaleY *= leaf * (1 + 0.14 * lag);
    // The barrel bud starts as a small lump and ends fully grown, pushing out as it does.
    const bud = at('bud'),
        size = 0.4 + 0.85 * grow;
    bud.scaleX *= size * (1 + 0.08 * Math.sin(breath - 0.4));
    bud.scaleY *= size * (1 + 0.08 * wave);
    bud.x += 10 * grow;
    bud.rotation += DEG * (4 + 4 * progress) * Math.sin(breath + 1.4);
    const vine = at('vine');
    vine.scaleY *= 0.4 + 0.85 * grow + 0.08 * Math.sin(breath - 0.5);
    vine.scaleX *= 0.55 + 0.5 * grow - 0.05 * wave;
    vine.rotation += DEG * 3 * Math.sin(breath * 0.5 + 2);
    for (const id of ['moundBack', 'moundFront']) {
        const mound = at(id);
        mound.scaleX *= 1 + 0.1 * (pop - 1) + 0.03 * Math.sin(breath + 2);
        mound.scaleY *= 1 + 0.08 * Math.sin(breath + 2.4) + 0.3 * (pop - 1);
    }
}
const key = (timeMs, parts = {}) => ({ timeMs, parts, easing: 'inOutSine' });
const clip = (durationMs, loop, keyframes) => ({ durationMs, loop, keyframes });
const rig = {
    parts: channels,
    clips: {
        idle: clip(1200, 'repeat', [
            key(0),
            key(600, { trunk: { y: -2, scaleY: 1.02 } }),
            key(1200),
        ]),
        hit: clip(240, 'once', [
            key(0, { trunk: { rotation: -0.12, y: 4, scaleX: 1.06, scaleY: 0.92 } }),
            key(240),
        ]),
    },
};

async function readAsset(name) {
    const response = await fetch(new URL(name, ROOT), { cache: 'no-cache' });
    if (!response.ok) throw new Error('감자 스프라이트를 불러오지 못했습니다: ' + name);
    return response;
}

export async function loadPotatoSpriteCanvas() {
    const [manifest, bytes] = await Promise.all([
        readAsset('manifest.json').then((response) => response.json()),
        readAsset('parts.svg').then((response) => response.arrayBuffer()),
    ]);
    const spec = manifest?.assets?.['parts.svg'];
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
        value.toString(16).padStart(2, '0'),
    ).join('');
    if (manifest?.schemaVersion !== 1 || spec?.bytes !== bytes.byteLength || spec.sha256 !== hash)
        throw new Error('감자 SVG 무결성 오류');
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const [width, height] = SHEET_SIZE;
        if (image.naturalWidth !== width || image.naturalHeight !== height)
            throw new Error('감자 스프라이트 시트 크기가 다릅니다.');
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(image, 0, 0);
        return canvas;
    } finally {
        URL.revokeObjectURL(url);
    }
}

// The standing soldier, in the approved draw order: feet, sprout, shovel, body, face, arms.
export function potatoSpritePortrait(source, width) {
    const canvas = document.createElement('canvas');
    const scale = width / 270;
    canvas.width = width;
    canvas.height = width;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, width / 2 - 6 * scale, width - 24 * scale);
    const { body, front } = stages.standing;
    for (const { cell, position, rotation = 0, scaleX = 1, scaleY = 1 } of [...body, ...front]) {
        const {
            slot,
            pivot: [px, py],
        } = cells[cell ?? 'neutral'];
        ctx.save();
        ctx.translate(...position);
        ctx.rotate(rotation);
        ctx.scale(scaleX, scaleY);
        ctx.drawImage(source, ...slot, -px, -py, slot[2], slot[3]);
        ctx.restore();
    }
    return canvas.toDataURL('image/png');
}

export class PotatoSpriteRenderer {
    constructor(context, canvas, gamekit) {
        this.context = context;
        this.mesh = context.acquireMeshRenderer();
        this.actors = new Set();
        const region = context.device.textureAtlas.allocate(canvas.width, canvas.height, {
            filter: 'linear',
        });
        try {
            context.device.textureAtlas.upload(region, canvas);
            this.source = this.mesh.createPoseSource(gamekit.compilePoseChannels(rig));
        } catch (error) {
            context.device.textureAtlas.release(region);
            throw error;
        }
        this.region = region;

        // Posed quads sit on their channel's pivot in standing-art units; the stage pose moves them.
        // The ammo quad is unposed, in sheet units around its pivot.
        const build = (pieces, posed = true) => {
            const uvRects = [],
                localRects = [],
                channelIds = [];
            for (const { cell, channel, position } of pieces) {
                const {
                    slot: [sx, sy, w, h],
                    pivot: [px, py],
                } = cells[cell];
                const [x, y] = posed ? channels[channelIndex.get(channel)].pivot : position;
                uvRects.push(
                    (region.x + sx) / region.atlas.width,
                    (region.y + sy) / region.atlas.height,
                    w / region.atlas.width,
                    h / region.atlas.height,
                );
                localRects.push(x - px, y - py, w, h);
                if (posed) channelIds.push(channelIndex.get(channel));
            }
            return {
                uvRects: Float32Array.from(uvRects),
                localRects: Float32Array.from(localRects),
                ...(posed ? { parts: Float32Array.from(channelIds) } : {}),
            };
        };
        // Each stage draws only its own pieces: body first, then the face layer.
        this.stages = Object.fromEntries(
            Object.entries(stages).map(([stage, { body, front }]) => [
                stage,
                {
                    body: build(body),
                    front: Object.fromEntries(
                        ['neutral', 'attack', 'hurt'].map((face) => [
                            face,
                            front.length
                                ? build(front.map((p) => ({ ...p, cell: p.cell ?? face })))
                                : null,
                        ]),
                    ),
                },
            ]),
        );
        const ammo = cells.ammo.slot;
        this.ammo = build([{ cell: 'ammo', position: [0, 0] }], false);
        // Cannon ammo is drawn with a matrix whose unit is the shell width.
        for (let i = 0; i < 4; i++) this.ammo.localRects[i] /= ammo[2];
        context.onDispose(() => this.dispose());
    }

    createActor() {
        const owner = this;
        const instance = owner.mesh.createPoseInstance(owner.source);
        const basePoses = stagePoses.standing.map((pose) => ({ ...pose, opacity: 1 }));
        const visible = channels.map(() => true);
        const actor = {
            currentClip: 'idle',
            startedAt: 0,
            elapsed: 0,
            pose: null,
            disposed: false,
            rootStage: 'standing',
            squirming: false,
            // 'standing', 'dig' or 'root'; main.js derives it from the soldier's cannonTick, with the
            // milliseconds spent rooting (null when standing) that the squirming follows.
            setRootStage(stage, rootingMs = null) {
                if (!stagePoses[stage]) return this;
                const squirming = stage !== 'standing' && rootingMs !== null;
                if (stage === this.rootStage && !squirming && !this.squirming) return this;
                this.rootStage = stage;
                this.squirming = squirming;
                stagePoses[stage].forEach((pose, index) => Object.assign(basePoses[index], pose));
                if (squirming) squirm(basePoses, stage, rootingMs);
                return this;
            },
            play(name) {
                this.currentClip = Object.hasOwn(rig.clips, name) ? name : 'idle';
                this.startedAt = this.currentClip === 'idle' ? 0 : null;
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
            preparePose() {
                this.pose = owner.mesh.preparePose(instance, {
                    clipName: this.currentClip,
                    elapsedMs: this.elapsed,
                    basePoses,
                    visible,
                    morph: [0, 0],
                });
                if (!this.pose) throw new Error('감자 GPU 포즈를 준비하지 못했습니다.');
                return this.pose;
            },
            dispose() {
                if (this.disposed) return false;
                this.disposed = true;
                owner.actors.delete(this);
                return owner.mesh.deletePoseInstance(instance);
            },
        };
        owner.actors.add(actor);
        return actor;
    }

    draw(data, matrix, depth, actor = null, depthWriteAlphaThreshold = 0) {
        this.context.depth = depth;
        drawUnitQuads(this.context, this.paint, {
            layer: this.region.layer,
            filter: this.region.filter,
            ...data,
            ...(actor ? { pose: actor.pose } : {}),
            matrix,
            depthWriteAlphaThreshold,
        });
    }

    drawBody(actor, matrix, depth) {
        this.draw(this.stages[actor.rootStage].body, matrix, depth, actor, 0.05);
    }

    drawFace(actor, matrix, depth, face) {
        const front = this.stages[actor.rootStage].front;
        const data = front[face] || front.neutral;
        if (data) this.draw(data, matrix, depth, actor);
    }

    drawAmmo(matrix, depth) {
        this.draw(this.ammo, matrix, depth);
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
    load: loadPotatoSpriteCanvas,
    renderer: PotatoSpriteRenderer,
    portrait: potatoSpritePortrait,
    shell: { draw: 'drawAmmo', depthTest: true },
    groundY: 0,
    artScale: POTATO_ART_SCALE,
});
