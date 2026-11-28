import { fetchAsset, requireAsset } from '../../core/required-asset.js';
import { drawUnitQuads } from '../../render/dead-unit-look.js';

const ROOT = new URL('../../../assets/sprites/plum/', import.meta.url);
const SHEET = [512, 280];
// The renderer maps the unit's actual windup to the common lob pose's 620 ms release.
const RELEASE_MS = 620;
const BOTTLE = [59, -67];
const cells = {
    body: { slot: [8, 8, 156, 194], pivot: [78, 190] },
    crest: { slot: [169, 9, 83, 66], pivot: [25, 53] },
    foot: { slot: [260, 10, 49, 40], pivot: [25, 31] },
    arm: { slot: [311, 10, 46, 61], pivot: [21, 18] },
    bottle: { slot: [367, 11, 101, 97], pivot: [42, 66] },
    neutral: { slot: [172, 110, 100, 45], pivot: [50, 22] },
    attack: { slot: [278, 110, 100, 45], pivot: [50, 22] },
    hurt: { slot: [386, 110, 100, 45], pivot: [50, 22] },
    drop: { slot: [172, 163, 52, 48], pivot: [26, 28] },
    shell: { slot: [325, 156, 121, 119], pivot: [60, 65] },
};

const bodyParts = [
    { id: 'leftFoot', cell: 'foot', point: [-24, -4], flip: true },
    { id: 'rightFoot', cell: 'foot', point: [25, -4] },
    { id: 'body', cell: 'body', point: [0, 0] },
    { id: 'crest', cell: 'crest', point: [-13, -147], scale: 0.93, rotation: -0.13 },
];
const frontParts = [
    { id: 'face', point: [-11, -82], scale: 0.79 },
    { id: 'leftArm', cell: 'arm', point: [-61, -63], flip: true, scale: 0.83 },
    { id: 'bottle', cell: 'bottle', point: BOTTLE, rotation: 0.27 },
    { id: 'grip', cell: 'arm', point: [58, -68], rotation: 0.84, scale: 0.81 },
];
const heldDrop = {
    id: 'heldDrop',
    cell: 'drop',
    parent: 'bottle',
    point: [BOTTLE[0] + 51, BOTTLE[1] - 52],
    scale: 0.39,
};
const parts = [...bodyParts, ...frontParts, heldDrop];
const partIds = new Map(parts.map(({ id }, index) => [id, index]));
const key = (timeMs, parts = {}) => ({ timeMs, parts, easing: 'inOutSine' });
const clip = (durationMs, loop, keyframes) => ({ durationMs, loop, keyframes });
const rig = {
    parts: parts.map(({ id, parent, point }) => ({
        id,
        parent: id === 'body' ? null : (parent ?? 'body'),
        pivot: point,
    })),
    clips: {
        idle: clip(1200, 'repeat', [
            key(0),
            key(600, { body: { y: -2, scaleY: 1.018 }, crest: { rotation: 0.07 } }),
            key(1200),
        ]),
        walk: clip(660, 'repeat', [
            key(0, { body: { rotation: -0.045 }, leftFoot: { y: -10, rotation: 0.17 } }),
            key(165, { body: { y: -4 }, bottle: { rotation: 0.06 } }),
            key(330, { body: { rotation: 0.045 }, rightFoot: { y: -10, rotation: -0.17 } }),
            key(495, { body: { y: -4 }, bottle: { rotation: -0.08 } }),
            key(660, { body: { rotation: -0.045 }, leftFoot: { y: -10, rotation: 0.17 } }),
        ]),
        fire: clip(900, 'once', [
            key(0),
            key(250, {
                body: { y: 2, rotation: -0.04 },
                grip: { x: 4, y: -9, rotation: 0.2 },
                bottle: { x: 4, y: -10, rotation: -0.3 },
            }),
            key(560, {
                body: { y: 3, rotation: -0.08, scaleX: 1.03, scaleY: 0.96 },
                crest: { rotation: -0.12 },
                grip: { x: 5, y: -11, rotation: 0.38 },
                bottle: { x: 8, y: -11, rotation: -0.29, scaleX: 1.05, scaleY: 0.76 },
                heldDrop: { scaleX: 1.12, scaleY: 1.2 },
            }),
            key(RELEASE_MS + 30, {
                body: { x: 3, y: -2, rotation: 0.1, scaleY: 1.035 },
                grip: { x: 11, y: -13, rotation: 0.02 },
                bottle: { x: 13, y: -11, rotation: -0.23, scaleX: 1.02, scaleY: 0.86 },
                crest: { rotation: 0.12 },
            }),
            key(900),
        ]),
        hit: clip(260, 'once', [
            key(0, { body: { y: 4, rotation: -0.12, scaleX: 1.06, scaleY: 0.92 } }),
            key(260),
        ]),
    },
};

export async function loadPlumSprite() {
    const manifestUrl = new URL('manifest.json', ROOT);
    const entry = await requireAsset(manifestUrl, async () => {
        const response = await fetchAsset(manifestUrl, { cache: 'no-cache' });
        const manifest = await response.json();
        const asset = manifest?.assets?.['parts.svg'];
        if (
            manifest?.schemaVersion !== 1 ||
            !Number.isSafeInteger(asset?.bytes) ||
            !/^[a-f0-9]{64}$/.test(asset?.sha256 || '')
        )
            throw new Error('매실 스프라이트 목록이 올바르지 않습니다.');
        return asset;
    });
    const sheetUrl = new URL('parts.svg', ROOT);
    return requireAsset(sheetUrl, async () => {
        const response = await fetchAsset(sheetUrl, { cache: 'no-cache' });
        const bytes = await response.arrayBuffer();
        const hash = Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
            (value) => value.toString(16).padStart(2, '0'),
        ).join('');
        if (entry.bytes !== bytes.byteLength || entry.sha256 !== hash)
            throw new Error('매실 스프라이트 무결성 오류');
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
        try {
            const image = new Image();
            image.src = url;
            await image.decode();
            const [width, height] = SHEET;
            if (image.naturalWidth !== width || image.naturalHeight !== height)
                throw new Error('매실 스프라이트 시트 크기가 다릅니다.');
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(image, 0, 0);
            return canvas;
        } finally {
            URL.revokeObjectURL(url);
        }
    });
}

export function plumPortrait(source, width) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = width;
    const scale = width / 244;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, width / 2 - 14 * scale, width - 22 * scale);
    for (const { cell = 'neutral', point, scale: size = 1, rotation = 0, flip = false } of [
        ...bodyParts,
        ...frontParts,
    ]) {
        const {
            slot,
            pivot: [px, py],
        } = cells[cell];
        ctx.save();
        ctx.translate(...point);
        ctx.rotate(rotation);
        ctx.scale(flip ? -size : size, size);
        ctx.drawImage(source, ...slot, -px, -py, slot[2], slot[3]);
        ctx.restore();
    }
    return canvas.toDataURL('image/png');
}

class PlumSpriteRenderer {
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
        const build = (pieces, sheetUnits = 1) => {
            const uvRects = [];
            const localRects = [];
            const channels = [];
            for (const {
                cell,
                id,
                point: [x, y],
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
                localRects.push(
                    (x - px) / sheetUnits,
                    (y - py) / sheetUnits,
                    w / sheetUnits,
                    h / sheetUnits,
                );
                if (id) channels.push(partIds.get(id));
            }
            return {
                uvRects: Float32Array.from(uvRects),
                localRects: Float32Array.from(localRects),
                ...(channels.length ? { parts: Float32Array.from(channels) } : {}),
            };
        };
        this.body = build(bodyParts);
        this.faces = Object.fromEntries(
            ['neutral', 'attack', 'hurt'].map((face) => [
                face,
                build(frontParts.map((part) => ({ ...part, cell: part.cell || face }))),
            ]),
        );
        this.held = build([heldDrop]);
        this.drop = build([{ cell: 'drop', point: [0, 0] }], 45);
        this.shell = build([{ cell: 'shell', point: [0, 0] }], 112);
        context.onDispose(() => this.dispose());
    }

    createActor() {
        const owner = this;
        const instance = this.mesh.createPoseInstance(this.source);
        const basePoses = parts.map(({ rotation = 0, scale = 1, flip = false }) => ({
            x: 0,
            y: 0,
            rotation,
            scaleX: flip ? -scale : scale,
            scaleY: scale,
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
                if (!this.pose) throw new Error('매실 GPU 포즈를 준비하지 못했습니다.');
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

    draw(data, matrix, depth, actor = null, alpha = 1, depthWriteAlphaThreshold = 0) {
        this.context.depth = depth;
        drawUnitQuads(this.context, this.paint, {
            layer: this.region.layer,
            filter: this.region.filter,
            ...data,
            ...(actor ? { pose: actor.pose } : {}),
            matrix,
            alpha,
            depthWriteAlphaThreshold,
        });
    }

    drawBody(actor, matrix, depth) {
        this.draw(this.body, matrix, depth, actor, 1, 0.05);
    }

    drawFace(actor, matrix, depth, face) {
        this.draw(this.faces[face] || this.faces.neutral, matrix, depth, actor);
    }

    drawHeldKernel(actor, matrix, depth) {
        this.draw(this.held, matrix, depth, actor);
    }

    drawJuiceDrop(matrix, depth, alpha = 1) {
        this.draw(this.drop, matrix, depth, null, alpha);
    }

    drawKernel(matrix, depth) {
        this.drawJuiceDrop(matrix, depth);
    }

    drawAmmo(matrix, depth) {
        this.draw(this.shell, matrix, depth);
    }

    prepareExtraArt(matrix) {
        this.drawJuiceDrop(matrix, 0);
    }

    dispose() {
        if (this.disposed) return false;
        this.disposed = true;
        for (const actor of [...this.actors]) actor.dispose();
        this.mesh.deletePoseSource(this.source);
        this.context.device.textureAtlas.release(this.region);
        return true;
    }
}

export const SPRITE = Object.freeze({
    load: loadPlumSprite,
    renderer: PlumSpriteRenderer,
    portrait: plumPortrait,
    groundY: 0,
    artScale: 343.5 / 187,
    pose: 'kernel-thrower',
    shell: Object.freeze({ draw: 'drawAmmo', depthTest: true }),
    motion: Object.freeze({
        juice: [0.72, 0.82, 0.32],
        stain: [0.41, 0.54, 0.22],
        spark: [0.91, 0.9, 0.43],
        walkMs: 660,
    }),
});
