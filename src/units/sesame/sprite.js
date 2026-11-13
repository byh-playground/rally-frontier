// The sesame (assets/sprites/sesame/parts.svg, approved sheet SB2, docs/handoff/sesame-buckwheat-art). A rice-family
// figure in the sticky rice's format holding a small hammer: the ground between its feet is the origin, its height
// (body top to the feet's ground contact, 164 sheet units) shows rice's 343.5 at its own body size. Idle, walk and hurt
// follow the sticky rice's poses; its attack swings the hammer. While it builds it takes the shared construction pose
// (main.js constructionWorkPose: lean and squash toward the site), hammer in hand. No new art: part transforms only.
import { drawUnitQuads } from '../../render/dead-unit-look.js';

const ROOT = new URL('../../../assets/sprites/sesame/', import.meta.url);
const SHEET_SIZE = [560, 262];
// Body top to the feet's ground contact in sheet units; it stands as tall as rice's 343.5 at its size.
const STANDING_HEIGHT = 164;
export const SESAME_ART_SCALE = 343.5 / STANDING_HEIGHT;
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
// hammer, arms.
const bodyParts = [
    { cell: 'foot', id: 'leftFoot', position: [-21, -12], scaleX: -1 },
    { cell: 'foot', id: 'rightFoot', position: [21, -12] },
    { cell: 'body', id: 'body', position: [0, 0] },
];
const frontParts = [
    { id: 'face', position: [0, -62], scaleX: 0.72, scaleY: 0.72 },
    { cell: 'tool', id: 'hammer', position: [60, -42], rotation: 14 * DEGREE },
    {
        cell: 'arm',
        id: 'leftArm',
        position: [-54, -56],
        rotation: 8 * DEGREE,
        scaleX: -0.8,
        scaleY: 0.8,
    },
    {
        cell: 'arm',
        id: 'rightArm',
        position: [54, -56],
        rotation: -8 * DEGREE,
        scaleX: 0.8,
        scaleY: 0.8,
    },
];
const parts = [...bodyParts, ...frontParts];
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
        // A hammer blow: raise it back over the shoulder, bring it down, settle.
        fire: clip(280, 'once', [
            key(0),
            key(90, {
                body: { y: -3, rotation: -0.06 },
                hammer: { rotation: -1.1 },
                rightArm: { y: -6, rotation: -0.5 },
            }),
            key(170, {
                body: { y: 3, rotation: 0.08, scaleX: 1.05, scaleY: 0.94 },
                hammer: { rotation: 0.7 },
                rightArm: { rotation: 0.35 },
            }),
            key(280),
        ]),
        hit: clip(240, 'once', [
            key(0, { body: { rotation: -0.12, y: 4, scaleX: 1.06, scaleY: 0.92 } }),
            key(240),
        ]),
    },
};

async function readAsset(name) {
    const response = await fetch(new URL(name, ROOT), { cache: 'no-cache' });
    if (!response.ok) throw new Error('참깨 스프라이트를 불러오지 못했습니다: ' + name);
    return response;
}

export async function loadSesameSpriteCanvas() {
    const [manifest, bytes] = await Promise.all([
        readAsset('manifest.json').then((response) => response.json()),
        readAsset('parts.svg').then((response) => response.arrayBuffer()),
    ]);
    const spec = manifest?.assets?.['parts.svg'];
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
        value.toString(16).padStart(2, '0'),
    ).join('');
    if (manifest?.schemaVersion !== 1 || spec?.bytes !== bytes.byteLength || spec.sha256 !== hash)
        throw new Error('참깨 SVG 무결성 오류');
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const [width, height] = SHEET_SIZE;
        if (image.naturalWidth !== width || image.naturalHeight !== height)
            throw new Error('참깨 스프라이트 시트 크기가 다릅니다.');
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(image, 0, 0);
        return canvas;
    } finally {
        URL.revokeObjectURL(url);
    }
}

// The card portrait: the standing figure in the painter order of the sheet.
export function sesameSpritePortrait(source, width) {
    const canvas = document.createElement('canvas');
    const scale = width / 210;
    canvas.width = width;
    canvas.height = width;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, width / 2, width - 26 * scale);
    for (const { cell = 'neutral', position, rotation = 0, scaleX = 1, scaleY = 1 } of parts) {
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

export class SesameSpriteRenderer {
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
        // The launch shell: the sesame seed without feet, arms and hammer, about one unit wide.
        this.ammo = build(
            [
                { cell: 'body', position: [0, 0] },
                { cell: 'neutral', position: [0, -62], scale: 0.72 },
            ],
            { origin: [0, -83], unit: 120 },
        );
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
                this.pose = owner.mesh.preparePose(instance, {
                    clipName: this.currentClip,
                    elapsedMs: this.elapsed,
                    basePoses,
                    visible,
                    morph: [0, 0],
                });
                if (!this.pose) throw new Error('참깨 GPU 포즈를 준비하지 못했습니다.');
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
    load: loadSesameSpriteCanvas,
    renderer: SesameSpriteRenderer,
    portrait: sesameSpritePortrait,
    shell: { draw: 'drawAmmo', depthTest: true },
    groundY: 0,
    artScale: SESAME_ART_SCALE,
});
