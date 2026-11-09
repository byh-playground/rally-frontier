const ROOT = new URL('../../assets/sprites/peanut/', import.meta.url);
const SHEET_SIZE = [500, 248];
const STANDING_HEIGHT = 228;
export const PEANUT_ART_SCALE = 343.5 / STANDING_HEIGHT;

const cells = {
    body: { slot: [12, 8, 165, 228], pivot: [82, 222] },
    boot: { slot: [190, 16, 64, 46], pivot: [30, 16] },
    arm: { slot: [267, 12, 64, 66], pivot: [30, 14] },
    neutral: { slot: [189, 91, 98, 45], pivot: [48, 22] },
    attack: { slot: [292, 91, 98, 45], pivot: [48, 22] },
    hurt: { slot: [395, 91, 98, 45], pivot: [48, 22] },
    ammo: { slot: [325, 151, 165, 82], pivot: [82, 41] },
};
const bodyParts = [
    { cell: 'boot', id: 'leftBoot', position: [-40, -16], mirror: true },
    { cell: 'boot', id: 'rightBoot', position: [40, -16] },
    { cell: 'body', id: 'body', position: [0, 0] },
];
const frontParts = [
    { id: 'face', position: [0, -166] },
    { cell: 'arm', id: 'leftArm', position: [-56, -77], mirror: true },
    { cell: 'arm', id: 'rightArm', position: [56, -77] },
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
            key(0, { body: { rotation: -0.045 }, leftBoot: { y: -11, rotation: 0.16 } }),
            key(150, { body: { y: -5 } }),
            key(300, { body: { rotation: 0.045 }, rightBoot: { y: -11, rotation: -0.16 } }),
            key(450, { body: { y: -5 } }),
            key(600, { body: { rotation: -0.045 }, leftBoot: { y: -11, rotation: 0.16 } }),
        ]),
        fire: clip(280, 'once', [
            key(0, { body: { y: 5, scaleX: 1.07, scaleY: 0.92 } }),
            key(85, { body: { y: -13, scaleX: 0.96, scaleY: 1.1 } }),
            key(180, { body: { y: 5, scaleX: 1.05, scaleY: 0.93 } }),
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
    if (!response.ok) throw new Error('땅콩 스프라이트를 불러오지 못했습니다: ' + name);
    return response;
}

export async function loadPeanutSpriteCanvas() {
    const [manifest, bytes] = await Promise.all([
        readAsset('manifest.json').then((response) => response.json()),
        readAsset('parts.svg').then((response) => response.arrayBuffer()),
    ]);
    const spec = manifest?.assets?.['parts.svg'];
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
        value.toString(16).padStart(2, '0'),
    ).join('');
    if (manifest?.schemaVersion !== 1 || spec?.bytes !== bytes.byteLength || spec.sha256 !== hash)
        throw new Error('땅콩 SVG 무결성 오류');
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const [width, height] = SHEET_SIZE;
        if (image.naturalWidth !== width || image.naturalHeight !== height)
            throw new Error('땅콩 스프라이트 시트 크기가 다릅니다.');
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(image, 0, 0);
        return canvas;
    } finally {
        URL.revokeObjectURL(url);
    }
}

export function peanutSpritePortrait(source, width) {
    const canvas = document.createElement('canvas');
    const scale = width / 250;
    canvas.width = width;
    canvas.height = width;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, width / 2, width - 14 * scale);
    for (const { cell = 'neutral', position, mirror } of parts) {
        const {
            slot,
            pivot: [px, py],
        } = cells[cell];
        ctx.save();
        ctx.translate(...position);
        if (mirror) ctx.scale(-1, 1);
        ctx.drawImage(source, ...slot, -px, -py, slot[2], slot[3]);
        ctx.restore();
    }
    return canvas.toDataURL('image/png');
}

export class PeanutSpriteRenderer {
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

        const build = (pieces, posed = true) => {
            const uvRects = [],
                localRects = [],
                channels = [];
            for (const {
                cell,
                id,
                position: [x, y],
            } of pieces) {
                const {
                    slot: [sx, sy, w, h],
                    pivot: [px, py],
                } = cells[cell];
                const divisor = posed ? 1 : w;
                uvRects.push(
                    (region.x + sx) / region.atlas.width,
                    (region.y + sy) / region.atlas.height,
                    w / region.atlas.width,
                    h / region.atlas.height,
                );
                localRects.push((x - px) / divisor, (y - py) / divisor, w / divisor, h / divisor);
                if (posed) channels.push(parts.findIndex((part) => part.id === id));
            }
            return {
                uvRects: Float32Array.from(uvRects),
                localRects: Float32Array.from(localRects),
                ...(posed ? { parts: Float32Array.from(channels) } : {}),
            };
        };
        this.body = build(bodyParts);
        this.front = Object.fromEntries(
            ['neutral', 'attack', 'hurt'].map((face) => [
                face,
                build(frontParts.map((part) => ({ ...part, cell: part.cell || face }))),
            ]),
        );
        this.ammo = build([{ cell: 'ammo', position: [0, 0] }], false);
        context.onDispose(() => this.dispose());
    }

    createActor() {
        const owner = this;
        const instance = owner.mesh.createPoseInstance(owner.source);
        const basePoses = parts.map(({ mirror }) => ({
            x: 0,
            y: 0,
            rotation: 0,
            scaleX: mirror ? -1 : 1,
            scaleY: 1,
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
                if (!this.pose) throw new Error('땅콩 GPU 포즈를 준비하지 못했습니다.');
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

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const actor of this.actors) actor.dispose();
        this.mesh.deletePoseSource(this.source);
        this.context.device.textureAtlas.release(this.region);
    }
}
