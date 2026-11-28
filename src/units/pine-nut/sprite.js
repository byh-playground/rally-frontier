import { fetchAsset, requireAsset } from '../../core/required-asset.js';
import { drawUnitQuads } from '../../render/dead-unit-look.js';

const ROOT = new URL('../../../assets/sprites/pine-nut/', import.meta.url);
const SHEET = [512, 272];
const FIRE_MS = 145;
const CARBINE = [43, -65];
const cells = {
    body: { slot: [8, 8, 147, 194], pivot: [70, 187] },
    foot: { slot: [174, 12, 52, 42], pivot: [25, 27] },
    hand: { slot: [239, 13, 51, 55], pivot: [26, 23] },
    carbine: { slot: [304, 11, 144, 90], pivot: [59, 44] },
    neutral: { slot: [163, 107, 100, 44], pivot: [50, 22] },
    attack: { slot: [267, 107, 100, 44], pivot: [50, 22] },
    hurt: { slot: [371, 107, 100, 44], pivot: [50, 22] },
    shell: { slot: [173, 166, 130, 104], pivot: [64, 53] },
};

const bodyParts = [
    { id: 'leftFoot', cell: 'foot', point: [-24, -5], flip: true },
    { id: 'rightFoot', cell: 'foot', point: [24, -5] },
    { id: 'body', cell: 'body', point: [0, 0] },
];
const frontParts = [
    { id: 'face', point: [-8, -96], scale: 0.91 },
    { id: 'carbine', cell: 'carbine', point: CARBINE },
    {
        id: 'grip',
        cell: 'hand',
        point: [CARBINE[0] - 14, CARBINE[1] + 6],
        parent: 'carbine',
        rotation: -0.31,
        scale: 0.76,
    },
    {
        id: 'support',
        cell: 'hand',
        point: [CARBINE[0] + 43, CARBINE[1] + 6],
        parent: 'carbine',
        rotation: -0.6,
        scale: 0.58,
    },
];
const parts = [...bodyParts, ...frontParts];
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
        idle: clip(1300, 'repeat', [
            key(0),
            key(650, { body: { y: -1.5, scaleY: 1.01 }, carbine: { rotation: 0.018 } }),
            key(1300),
        ]),
        walk: clip(680, 'repeat', [
            key(0, { body: { rotation: -0.035 }, leftFoot: { y: -10, rotation: 0.13 } }),
            key(170, { body: { y: -3 }, carbine: { rotation: 0.055 } }),
            key(340, { body: { rotation: 0.036 }, rightFoot: { y: -10, rotation: -0.13 } }),
            key(510, { body: { y: -3 }, carbine: { rotation: -0.046 } }),
            key(680, { body: { rotation: -0.035 }, leftFoot: { y: -10, rotation: 0.13 } }),
        ]),
        fire: clip(FIRE_MS, 'once', [
            key(0, { body: { x: -3, rotation: -0.026 }, carbine: { x: -8, rotation: -0.035 } }),
            key(38, { body: { x: -2, rotation: -0.02 }, carbine: { x: -5, rotation: -0.015 } }),
            key(FIRE_MS),
        ]),
        hit: clip(240, 'once', [
            key(0, { body: { y: 4, rotation: -0.12, scaleX: 1.06, scaleY: 0.91 } }),
            key(240),
        ]),
    },
};

export async function loadPineNutSprite() {
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
            throw new Error('잣 스프라이트 목록이 올바르지 않습니다.');
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
            throw new Error('잣 스프라이트 무결성 오류');
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
        try {
            const image = new Image();
            image.src = url;
            await image.decode();
            const [width, height] = SHEET;
            if (image.naturalWidth !== width || image.naturalHeight !== height)
                throw new Error('잣 스프라이트 시트 크기가 다릅니다.');
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

export function pineNutPortrait(source, width) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = width;
    const scale = width / 225;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, width / 2 - 27 * scale, width - 22 * scale);
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

class PineNutSpriteRenderer {
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
            const uvRects = [],
                localRects = [],
                channels = [];
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
        this.shell = build([{ cell: 'shell', point: [0, 0] }], 116);
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
                if (!this.pose) throw new Error('잣 GPU 포즈를 준비하지 못했습니다.');
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
        drawUnitQuads(this.context, this.paint, {
            layer: this.region.layer,
            filter: this.region.filter,
            ...data,
            ...(actor ? { pose: actor.pose } : {}),
            matrix,
            alpha: 1,
            depthWriteAlphaThreshold,
        });
    }

    drawBody(actor, matrix, depth) {
        this.draw(this.body, matrix, depth, actor, 0.05);
    }

    drawFace(actor, matrix, depth, face) {
        this.draw(this.faces[face] || this.faces.neutral, matrix, depth, actor);
    }

    drawAmmo(matrix, depth) {
        this.draw(this.shell, matrix, depth);
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
    load: loadPineNutSprite,
    renderer: PineNutSpriteRenderer,
    portrait: pineNutPortrait,
    groundY: 0,
    artScale: 343.5 / 177,
    hitscanMuzzle: Object.freeze({ x: CARBINE[0] + 81, y: CARBINE[1] - 3 }),
    fireHoldMs: FIRE_MS,
    shell: Object.freeze({ draw: 'drawAmmo', depthTest: true }),
    motion: Object.freeze({
        juice: [0.86, 0.69, 0.45],
        stain: [0.59, 0.44, 0.3],
        spark: [0.99, 0.9, 0.65],
        walkMs: 680,
    }),
});
