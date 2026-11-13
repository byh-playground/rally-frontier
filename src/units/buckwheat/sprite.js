// The buckwheat (assets/sprites/buckwheat/parts.svg, approved sheet BB2, docs/handoff/sesame-buckwheat-art). A
// rice-family figure in the sticky rice's format: the ground between its feet is the origin, its height (body top to
// the feet's ground contact, 174 sheet units) is 0.96 of rice's 343.5 at its own body size. Idle, walk and hurt follow
// the sticky rice's poses. Its throw (pose 'thorn-thrower': main.js times it like the chestnut's, the windup is 0..550 ms
// of the fire clip and the release is at 550) raises the right arm with a seed (the sheet's tool cell) at the
// fingertips and swings it forward; the seed shows only while it is held. The thrown seed is the same cell (drawThorn).
import { drawUnitQuads } from '../../render/dead-unit-look.js';

const ROOT = new URL('../../../assets/sprites/buckwheat/', import.meta.url);
const SHEET_SIZE = [560, 262];
// Body top to the feet's ground contact in sheet units; it stands 0.96 of rice's 343.5 at its size.
const STANDING_HEIGHT = 174;
export const BUCKWHEAT_ART_SCALE = (0.96 * 343.5) / STANDING_HEIGHT;
const DEGREE = Math.PI / 180;

const cells = {
    body: { slot: [10, 10, 180, 190], pivot: [90, 190] },
    tool: { slot: [370, 4, 64, 100], pivot: [32, 80] },
    foot: { slot: [444, 12, 52, 40], pivot: [26, 14] },
    arm: { slot: [504, 8, 48, 60], pivot: [20, 10] },
    neutral: { slot: [10, 210, 98, 45], pivot: [49, 22] },
    attack: { slot: [115, 210, 98, 45], pivot: [49, 22] },
    hurt: { slot: [220, 210, 98, 45], pivot: [49, 22] },
};
// Approved standing assembly (the sheet's header): the ground point is the origin. Painter order: feet, body, face,
// arms, then the held seed at its approved throwing placement (hidden unless held).
const bodyParts = [
    { cell: 'foot', id: 'leftFoot', position: [-20, -8], scaleX: -1 },
    { cell: 'foot', id: 'rightFoot', position: [20, -8] },
    { cell: 'body', id: 'body', position: [0, 0] },
];
const frontParts = [
    { id: 'face', position: [-8, -64], scaleX: 0.7, scaleY: 0.7 },
    {
        cell: 'arm',
        id: 'leftArm',
        position: [-60, -60],
        rotation: 8 * DEGREE,
        scaleX: -0.76,
        scaleY: 0.76,
    },
    {
        cell: 'arm',
        id: 'rightArm',
        position: [60, -60],
        rotation: -8 * DEGREE,
        scaleX: 0.76,
        scaleY: 0.76,
    },
    {
        cell: 'tool',
        id: 'seed',
        position: [68, -118],
        rotation: 10 * DEGREE,
        scaleX: 1.3,
        scaleY: 1.3,
    },
];
const parts = [...bodyParts, ...frontParts];
const PART_SEED = parts.findIndex((part) => part.id === 'seed');
// The throw on the fire clip's clock (main.js 'thorn-thrower'): the seed is in the hand from when the arm is up until
// the release.
const SEED_SHOWN_MS = 200;
const RELEASE_MS = 550;
// The raised throwing arm (the sheet's attack placement (52, -70) at 205 degrees) over the standing one (60, -60) at
// -8 degrees: the arm swings out and up on its own side, so -147 degrees rather than +213.
const RAISED_ARM = { x: -8, y: -10, rotation: -147 * DEGREE };
// The seed's length in the sheet (tip to tip of the tool cell's grain) and in flight (world units).
const SEED_SHEET = 27;
const SEED_WORLD = 7;
const key = (timeMs, parts = {}) => ({ timeMs, parts, easing: 'inOutSine' });
const clip = (durationMs, loop, keyframes) => ({ durationMs, loop, keyframes });
const rig = {
    parts: parts.map(({ id, position }) => ({
        id,
        parent: id === 'body' ? null : 'body',
        pivot: position,
    })),
    clips: {
        idle: clip(1200, 'repeat', [
            key(0),
            key(600, { body: { y: -2, scaleY: 1.02 } }),
            key(1200),
        ]),
        walk: clip(600, 'repeat', [
            key(0, { body: { rotation: -0.045 }, leftFoot: { y: -11, rotation: 0.16 } }),
            key(150, { body: { y: -5 } }),
            key(300, { body: { rotation: 0.045 }, rightFoot: { y: -11, rotation: -0.16 } }),
            key(450, { body: { y: -5 } }),
            key(600, { body: { rotation: -0.045 }, leftFoot: { y: -11, rotation: 0.16 } }),
        ]),
        // The throw: wind the arm up and back (0..550, the windup), fling it forward at the release, settle.
        fire: clip(1400, 'once', [
            key(0),
            key(SEED_SHOWN_MS, { body: { rotation: -0.05, y: 1 }, rightArm: RAISED_ARM }),
            key(RELEASE_MS - 20, {
                body: { rotation: -0.09, y: 2, scaleX: 0.98, scaleY: 1.02 },
                rightArm: { ...RAISED_ARM, rotation: RAISED_ARM.rotation - 0.2 },
            }),
            key(RELEASE_MS + 110, {
                body: { rotation: 0.1, y: -2, scaleX: 1.03, scaleY: 0.97 },
                rightArm: { x: -2, y: -4, rotation: -0.8 },
            }),
            key(950),
            key(1400),
        ]),
        hit: clip(240, 'once', [
            key(0, { body: { rotation: -0.12, y: 4, scaleX: 1.06, scaleY: 0.92 } }),
            key(240),
        ]),
    },
};

async function readAsset(name) {
    const response = await fetch(new URL(name, ROOT), { cache: 'no-cache' });
    if (!response.ok) throw new Error('메밀 스프라이트를 불러오지 못했습니다: ' + name);
    return response;
}

export async function loadBuckwheatSpriteCanvas() {
    const [manifest, bytes] = await Promise.all([
        readAsset('manifest.json').then((response) => response.json()),
        readAsset('parts.svg').then((response) => response.arrayBuffer()),
    ]);
    const spec = manifest?.assets?.['parts.svg'];
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
        value.toString(16).padStart(2, '0'),
    ).join('');
    if (manifest?.schemaVersion !== 1 || spec?.bytes !== bytes.byteLength || spec.sha256 !== hash)
        throw new Error('메밀 SVG 무결성 오류');
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const [width, height] = SHEET_SIZE;
        if (image.naturalWidth !== width || image.naturalHeight !== height)
            throw new Error('메밀 스프라이트 시트 크기가 다릅니다.');
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(image, 0, 0);
        return canvas;
    } finally {
        URL.revokeObjectURL(url);
    }
}

// The card portrait: the standing figure in the painter order of the sheet (no seed in hand).
export function buckwheatSpritePortrait(source, width) {
    const canvas = document.createElement('canvas');
    const scale = width / 220;
    canvas.width = width;
    canvas.height = width;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, width / 2, width - 26 * scale);
    for (const { cell = 'neutral', id, position, rotation = 0, scaleX = 1, scaleY = 1 } of parts) {
        if (id === 'seed') continue;
        const {
            slot,
            pivot: [px, py],
        } = cells[cell];
        ctx.save();
        ctx.translate(...position);
        ctx.rotate(rotation);
        ctx.scale(scaleX, scaleY);
        ctx.drawImage(source, ...slot, -px, -py, slot[2], slot[3]);
        ctx.restore();
    }
    return canvas.toDataURL('image/png');
}

export class BuckwheatSpriteRenderer {
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

        // Posed quads are in standing-art units; the shell's quads are around `origin` in units of `unit`, each
        // scaled by its own `scale` about its position.
        const build = (pieces, { origin = null, unit = 1 } = {}) => {
            const uvRects = [],
                localRects = [],
                channels = [];
            for (const {
                cell,
                id,
                position: [x, y],
                scale = 1,
            } of pieces) {
                const {
                    slot: [sx, sy, w, h],
                    pivot: [px, py],
                } = cells[cell];
                uvRects.push(
                    (region.x + sx) / region.atlas.width,
                    (region.y + sy) / region.atlas.height,
                    w / region.atlas.width,
                    h / region.atlas.height,
                );
                const [ox, oy] = origin || [0, 0];
                localRects.push(
                    (x - px * scale - ox) / unit,
                    (y - py * scale - oy) / unit,
                    (w * scale) / unit,
                    (h * scale) / unit,
                );
                if (!origin) channels.push(parts.findIndex((part) => part.id === id));
            }
            return {
                uvRects: Float32Array.from(uvRects),
                localRects: Float32Array.from(localRects),
                ...(origin ? {} : { parts: Float32Array.from(channels) }),
            };
        };
        this.body = build(bodyParts);
        this.front = Object.fromEntries(
            ['neutral', 'attack', 'hurt'].map((face) => [
                face,
                build(frontParts.map((part) => ({ ...part, cell: part.cell || face }))),
            ]),
        );
        // The launch shell: the buckwheat grain without feet and arms, about one unit wide.
        this.ammo = build(
            [
                { cell: 'body', position: [0, 0] },
                { cell: 'neutral', position: [-8, -64], scale: 0.7 },
            ],
            { origin: [0, -84], unit: 136 },
        );
        // The thrown seed, drawn with main.js drawThorn's matrix: its x axis runs along the flight and its unit is 32
        // world units. The seed is SEED_WORLD world units long.
        this.seed = build([{ cell: 'tool', position: [0, 0] }], {
            origin: [0, 0],
            unit: (SEED_SHEET * 32) / SEED_WORLD,
        });
        this.seedMatrix = new Float64Array(6);
        context.onDispose(() => this.dispose());
    }

    createActor() {
        const owner = this;
        const instance = owner.mesh.createPoseInstance(owner.source);
        const basePoses = parts.map(({ rotation = 0, scaleX = 1, scaleY = 1 }) => ({
            x: 0,
            y: 0,
            rotation,
            scaleX,
            scaleY,
            opacity: 1,
        }));
        const visible = parts.map(() => true);
        const actor = {
            currentClip: 'idle',
            startedAt: 0,
            elapsed: 0,
            pose: null,
            disposed: false,
            play(name) {
                this.currentClip = Object.hasOwn(rig.clips, name) ? name : 'idle';
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
            preparePose() {
                visible[PART_SEED] =
                    this.currentClip === 'fire' &&
                    this.elapsed >= SEED_SHOWN_MS &&
                    this.elapsed < RELEASE_MS;
                this.pose = owner.mesh.preparePose(instance, {
                    clipName: this.currentClip,
                    elapsedMs: this.elapsed,
                    basePoses,
                    visible,
                    morph: [0, 0],
                });
                if (!this.pose) throw new Error('메밀 GPU 포즈를 준비하지 못했습니다.');
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
        this.draw(this.body, matrix, depth, actor, 0.05);
    }

    drawFace(actor, matrix, depth, face) {
        this.draw(this.front[face] || this.front.neutral, matrix, depth, actor);
    }

    drawAmmo(matrix, depth) {
        this.draw(this.ammo, matrix, depth);
    }

    // Its own thornAttack shot (main.js drawThorn): the seed, tip up in the sheet, turned a quarter so its tip leads.
    drawThorn(matrix, depth) {
        const m = this.seedMatrix;
        m[0] = matrix[2];
        m[1] = matrix[3];
        m[2] = -matrix[0];
        m[3] = -matrix[1];
        m[4] = matrix[4];
        m[5] = matrix[5];
        this.draw(this.seed, m, depth);
    }

    // Start-screen warm-up of the thrown seed.
    prepareExtraArt() {
        this.drawThorn([32, 0, 0, 32, 0, 0], 0);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const actor of [...this.actors]) actor.dispose();
        this.mesh.deletePoseSource(this.source);
        this.context.device.textureAtlas.release(this.region);
    }
}

// This unit's sprite contract (src/units/define-unit.js), loaded only by the page, never the Worker.
export const SPRITE = Object.freeze({
    load: loadBuckwheatSpriteCanvas,
    renderer: BuckwheatSpriteRenderer,
    portrait: buckwheatSpritePortrait,
    shell: { draw: 'drawAmmo', depthTest: true },
    groundY: 0,
    pose: 'thorn-thrower',
    artScale: BUCKWHEAT_ART_SCALE,
});
