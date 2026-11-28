// The ginkgo's standing pose shares the rice family's split body and expression passes.
// The sling reuses the lob presentation clock: the pouch opens at the visual release (620 ms).
import { fetchAsset, requireAsset } from '../../core/required-asset.js';
import { drawUnitQuads } from '../../render/dead-unit-look.js';

const ROOT = new URL('../../../assets/sprites/ginkgo/', import.meta.url);
const SHEET = [576, 304];
// The ImageGen original includes transparent margins. Keep the fruit centre on the flight trajectory.
const SHELL_CROP = [366, 260, 580, 692];
const RELEASE_MS = 620;
const FORK = [63, -69];
const TIPS = [
    [-21, -59],
    [24, -66],
];
const POUCH = [1, -62];
const BAND_LENGTH = 40;

const cells = {
    body: { slot: [8, 8, 156, 194], pivot: [78, 190] },
    crest: { slot: [172, 10, 80, 61], pivot: [40, 52] },
    foot: { slot: [260, 10, 56, 40], pivot: [26, 30] },
    arm: { slot: [319, 10, 52, 62], pivot: [21, 18] },
    bag: { slot: [374, 17, 61, 78], pivot: [31, 44] },
    fork: { slot: [13, 202, 72, 96], pivot: [37, 73] },
    band: { slot: [171, 174, 54, 14], pivot: [6, 7] },
    neutral: { slot: [168, 110, 100, 45], pivot: [50, 22] },
    attack: { slot: [280, 110, 100, 45], pivot: [50, 22] },
    hurt: { slot: [392, 110, 100, 45], pivot: [50, 22] },
    kernel: { slot: [442, 16, 52, 52], pivot: [26, 26] },
    pit: { slot: [513, 16, 52, 52], pivot: [26, 26] },
    husk: { slot: [442, 69, 52, 35], pivot: [26, 15] },
    shell: { slot: [338, 156, 122, 146], pivot: [53, 98] },
};
const atFork = ([x, y]) => [FORK[0] + x, FORK[1] + y];
const bodyParts = [
    { id: 'leftFoot', cell: 'foot', point: [-25, -5], flip: true },
    { id: 'rightFoot', cell: 'foot', point: [25, -5] },
    { id: 'body', cell: 'body', point: [0, 0] },
    { id: 'crest', cell: 'crest', point: [-19, -148], scale: 0.88, rotation: -0.28 },
];
const faceParts = [
    { id: 'bag', cell: 'bag', point: [-60, -64], scale: 0.8, rotation: -0.14 },
    { id: 'face', point: [-8, -79], scale: 0.78 },
    { id: 'bandNear', cell: 'band', point: atFork(TIPS[0]), parent: 'fork' },
    { id: 'bandFar', cell: 'band', point: atFork(TIPS[1]), parent: 'fork' },
    { id: 'fork', cell: 'fork', point: FORK, rotation: 0.14 },
    { id: 'pull', cell: 'arm', point: [-52, -61], scale: 0.86, rotation: -0.28 },
    { id: 'hold', cell: 'arm', point: [58, -65], scale: 0.86, rotation: -0.45 },
];
const loadedSeed = {
    id: 'seed',
    cell: 'kernel',
    point: atFork(POUCH),
    parent: 'fork',
    scale: 0.5,
};
const parts = [...bodyParts, ...faceParts, loadedSeed];
const partIds = new Map(parts.map(({ id }, index) => [id, index]));
const key = (timeMs, parts = {}) => ({ timeMs, parts, easing: 'inOutSine' });
const clip = (durationMs, loop, keyframes) => ({ durationMs, loop, keyframes });
const rig = {
    parts: parts.map(({ id, point, parent }) => ({
        id,
        parent: id === 'body' ? null : (parent ?? 'body'),
        pivot: point,
    })),
    clips: {
        idle: clip(1200, 'repeat', [
            key(0),
            key(600, { body: { y: -2, scaleY: 1.015 }, crest: { rotation: 0.065 } }),
            key(1200),
        ]),
        walk: clip(760, 'repeat', [
            key(0, { body: { rotation: -0.04 }, leftFoot: { y: -11, rotation: 0.14 } }),
            key(190, { body: { y: -4 }, fork: { rotation: 0.07 } }),
            key(380, { body: { rotation: 0.04 }, rightFoot: { y: -11, rotation: -0.14 } }),
            key(570, { body: { y: -4 }, fork: { rotation: -0.07 } }),
            key(760, { body: { rotation: -0.04 }, leftFoot: { y: -11, rotation: 0.14 } }),
        ]),
        fire: clip(950, 'once', [
            key(0, { pull: { rotation: -0.5 } }),
            key(250, {
                body: { rotation: -0.04, y: 2 },
                fork: { x: 7, y: -6, rotation: 0.15 },
                hold: { x: 6, y: -7, rotation: -0.35 },
                pull: { x: 65, y: -64, rotation: -1.43 },
            }),
            key(600, {
                body: { rotation: -0.09, scaleX: 1.025, scaleY: 0.96, y: 3 },
                crest: { rotation: -0.12 },
                fork: { x: 12, y: -8, rotation: 0.25 },
                hold: { x: 11, y: -10, rotation: -0.4 },
                pull: { x: 57, y: -52, rotation: -1.62 },
            }),
            key(RELEASE_MS + 60, {
                body: { rotation: 0.08, scaleX: 0.98, scaleY: 1.035, y: -4 },
                crest: { rotation: 0.2 },
                fork: { x: 15, y: -13, rotation: 0.38 },
                hold: { x: 14, y: -16, rotation: -0.7 },
                pull: { x: 12, y: -13, rotation: -0.95 },
            }),
            key(950),
        ]),
        hit: clip(280, 'once', [
            key(0, { body: { rotation: -0.12, y: 4, scaleX: 1.06, scaleY: 0.92 } }),
            key(280),
        ]),
    },
};

export async function loadGinkgoSprite() {
    const manifestUrl = new URL('manifest.json', ROOT);
    const assets = await requireAsset(manifestUrl, async () => {
        const response = await fetchAsset(manifestUrl, { cache: 'no-cache' });
        const manifest = await response.json();
        if (
            manifest?.schemaVersion !== 1 ||
            !['parts.svg', 'shell.png'].every((name) => {
                const asset = manifest?.assets?.[name];
                return Number.isSafeInteger(asset?.bytes) && /^[a-f0-9]{64}$/.test(asset.sha256);
            })
        )
            throw new Error('은행 스프라이트 목록이 올바르지 않습니다.');
        return manifest.assets;
    });
    const load = (name, mime, size) => {
        const assetUrl = new URL(name, ROOT);
        return requireAsset(assetUrl, async () => {
            const response = await fetchAsset(assetUrl, { cache: 'no-cache' });
            const bytes = await response.arrayBuffer();
            const hash = Array.from(
                new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
                (value) => value.toString(16).padStart(2, '0'),
            ).join('');
            if (assets[name].bytes !== bytes.byteLength || assets[name].sha256 !== hash)
                throw new Error('은행 스프라이트 무결성 오류');
            const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
            try {
                const image = new Image();
                image.src = url;
                await image.decode();
                if (image.naturalWidth !== size[0] || image.naturalHeight !== size[1])
                    throw new Error('은행 스프라이트 크기가 다릅니다.');
                return image;
            } finally {
                URL.revokeObjectURL(url);
            }
        });
    };
    const [sheet, shell] = await Promise.all([
        load('parts.svg', 'image/svg+xml', SHEET),
        load('shell.png', 'image/png', [1261, 1247]),
    ]);
    const canvas = document.createElement('canvas');
    [canvas.width, canvas.height] = SHEET;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(sheet, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(shell, ...SHELL_CROP, ...cells.shell.slot);
    return canvas;
}

// Bend both halves of the elastic toward the same pouch. Coordinates are in the sling's
// local plane so the endpoints stay on their bindings while the grip turns.
function bandPose(pose, tip, x, y) {
    const dx = x - tip[0];
    const dy = y - tip[1];
    pose.rotation = Math.atan2(dy, dx);
    pose.scaleX = Math.hypot(dx, dy) / BAND_LENGTH;
}

export function ginkgoPortrait(source, width) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = width;
    const scale = width / 243;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, width / 2 - 3 * scale, width - 22 * scale);
    for (const part of [...bodyParts, ...faceParts]) {
        const { id, point, scale: size = 1, rotation = 0, flip = false } = part;
        const {
            slot,
            pivot: [px, py],
        } = cells[part.cell || 'neutral'];
        ctx.save();
        if (id === 'bandNear' || id === 'bandFar') {
            const tip = id === 'bandNear' ? TIPS[0] : TIPS[1];
            const pose = {};
            bandPose(pose, tip, ...POUCH);
            ctx.translate(...FORK);
            ctx.rotate(faceParts.find((p) => p.id === 'fork').rotation);
            ctx.translate(...tip);
            ctx.rotate(pose.rotation);
            ctx.scale(pose.scaleX, 1);
        } else {
            ctx.translate(...point);
            ctx.rotate(rotation);
            ctx.scale(flip ? -size : size, size);
        }
        ctx.drawImage(source, ...slot, -px, -py, slot[2], slot[3]);
        ctx.restore();
    }
    return canvas.toDataURL('image/png');
}

class GinkgoSpriteRenderer {
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
        this.face = Object.fromEntries(
            ['neutral', 'attack', 'hurt'].map((face) => [
                face,
                build(faceParts.map((part) => ({ ...part, cell: part.cell || face }))),
            ]),
        );
        this.loaded = build([loadedSeed]);
        this.kernel = build([{ cell: 'kernel', point: [0, 0] }], 45);
        this.pit = build([{ cell: 'pit', point: [0, 0] }], 45);
        this.husk = build([{ cell: 'husk', point: [0, 0] }], 45);
        this.shell = build([{ cell: 'shell', point: [0, 0] }], 125);
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
        const bands = [basePoses[partIds.get('bandNear')], basePoses[partIds.get('bandFar')]];
        const seed = basePoses[partIds.get('seed')];
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
                const fire = this.currentClip === 'fire';
                const time = this.elapsed;
                const tension = fire && time < RELEASE_MS ? Math.min(1, time / 550) ** 1.5 : 0;
                const snap =
                    fire && time >= RELEASE_MS
                        ? Math.sin((time - RELEASE_MS) / 14) *
                          Math.max(0, 1 - (time - RELEASE_MS) / 125)
                        : 0;
                seed.x = -42 * tension + 8 * snap;
                seed.y = 15 * tension - 7 * snap;
                for (let i = 0; i < bands.length; i++)
                    bandPose(bands[i], TIPS[i], POUCH[0] + seed.x, POUCH[1] + seed.y);
                this.pose = owner.mesh.preparePose(instance, {
                    clipName: this.currentClip,
                    elapsedMs: time,
                    basePoses,
                    visible,
                    morph: [0, 0],
                });
                if (!this.pose) throw new Error('은행 GPU 포즈를 준비하지 못했습니다.');
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
        this.draw(this.face[face] || this.face.neutral, matrix, depth, actor);
    }

    drawHeldKernel(actor, matrix, depth) {
        this.draw(this.loaded, matrix, depth, actor);
    }

    drawKernel(matrix, depth) {
        this.draw(this.kernel, matrix, depth);
    }

    drawPit(matrix, depth, alpha = 1) {
        this.draw(this.pit, matrix, depth, null, alpha);
    }

    drawHusk(matrix, depth, alpha = 1) {
        this.draw(this.husk, matrix, depth, null, alpha);
    }

    drawAmmo(matrix, depth) {
        this.draw(this.shell, matrix, depth);
    }

    prepareExtraArt(matrix) {
        this.drawKernel(matrix, 0);
        this.drawPit(matrix, 0);
        this.drawHusk(matrix, 0);
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
    load: loadGinkgoSprite,
    renderer: GinkgoSpriteRenderer,
    portrait: ginkgoPortrait,
    groundY: 0,
    artScale: 343.5 / 184,
    pose: 'kernel-thrower',
    shell: Object.freeze({ draw: 'drawAmmo', depthTest: true }),
    motion: Object.freeze({
        juice: [0.94, 0.73, 0.28],
        stain: [0.57, 0.4, 0.19],
        spark: [1, 0.86, 0.47],
        walkMs: 760,
    }),
});
