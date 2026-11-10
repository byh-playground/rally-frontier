const ROOT = new URL('../../assets/sprites/sticky-rice/', import.meta.url);
const SHEET_SIZE = [640, 470];
// Body top to the feet's ground contact in sheet units. A standing sticky rice is 80% of rice's 343.5.
const STANDING_HEIGHT = 172;
export const STICKY_RICE_ART_SCALE = (0.8 * 343.5) / STANDING_HEIGHT;
// One sheet unit is 0.674 cannon SVG units: the barrel's 90 diameter spans 134 sheet units.
const WRAP_SCALE = 0.674;
// The wrapped body sits this many cannon SVG units outside the muzzle socket.
const WRAP_BODY_REACH = 14;
const DEGREE = Math.PI / 180;

const cells = {
    body: { slot: [10, 10, 180, 185], pivot: [90, 164] },
    foot: { slot: [455, 12, 52, 40], pivot: [26, 14] },
    arm: { slot: [515, 8, 48, 60], pivot: [20, 10] },
    ribbon: { slot: [568, 8, 66, 62], pivot: [6, 14] },
    neutral: { slot: [10, 205, 98, 45], pivot: [49, 22] },
    attack: { slot: [115, 205, 98, 45], pivot: [49, 22] },
    hurt: { slot: [220, 205, 98, 45], pivot: [49, 22] },
    hug: { slot: [325, 205, 98, 45], pivot: [49, 22] },
    ammo: { slot: [450, 186, 120, 96], pivot: [60, 50] },
    wrapSleeve: { slot: [10, 262, 140, 196], pivot: [102, 98] },
    wrapBody: { slot: [200, 4, 176, 192], pivot: [88, 100] },
};
// Approved standing assembly: the ground point is the origin.
const bodyParts = [
    { cell: 'foot', id: 'leftFoot', position: [-34, -12], scaleX: -1 },
    { cell: 'foot', id: 'rightFoot', position: [34, -12] },
    { cell: 'body', id: 'body', position: [0, 0] },
];
const frontParts = [
    { id: 'face', position: [0, -52] },
    { cell: 'ribbon', id: 'ribbon', position: [74, -108] },
    {
        cell: 'arm',
        id: 'leftArm',
        position: [-78, -54],
        rotation: 8 * DEGREE,
        scaleX: -0.85,
        scaleY: 0.85,
    },
    {
        cell: 'arm',
        id: 'rightArm',
        position: [78, -54],
        rotation: -8 * DEGREE,
        scaleX: 0.85,
        scaleY: 0.85,
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
    if (!response.ok) throw new Error('찹쌀 스프라이트를 불러오지 못했습니다: ' + name);
    return response;
}

export async function loadStickyRiceSpriteCanvas() {
    const [manifest, bytes] = await Promise.all([
        readAsset('manifest.json').then((response) => response.json()),
        readAsset('parts.svg').then((response) => response.arrayBuffer()),
    ]);
    const spec = manifest?.assets?.['parts.svg'];
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
        value.toString(16).padStart(2, '0'),
    ).join('');
    if (manifest?.schemaVersion !== 1 || spec?.bytes !== bytes.byteLength || spec.sha256 !== hash)
        throw new Error('찹쌀 SVG 무결성 오류');
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const [width, height] = SHEET_SIZE;
        if (image.naturalWidth !== width || image.naturalHeight !== height)
            throw new Error('찹쌀 스프라이트 시트 크기가 다릅니다.');
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(image, 0, 0);
        return canvas;
    } finally {
        URL.revokeObjectURL(url);
    }
}

export function stickyRiceSpritePortrait(source, width) {
    const canvas = document.createElement('canvas');
    const scale = width / 230;
    canvas.width = width;
    canvas.height = width;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, width / 2, width - 24 * scale);
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

// Affine [a, b, c, d, e, f] products in screen space.
const multiply = (m, n) => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
];
const placed = (x, y, degrees, scale) => {
    const c = Math.cos(degrees * DEGREE) * scale,
        s = Math.sin(degrees * DEGREE) * scale;
    return [c, s, -s, c, x, y];
};

export class StickyRiceSpriteRenderer {
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

        // Posed quads are in standing-art units; unposed quads are in sheet units around their pivot.
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
                uvRects.push(
                    (region.x + sx) / region.atlas.width,
                    (region.y + sy) / region.atlas.height,
                    w / region.atlas.width,
                    h / region.atlas.height,
                );
                localRects.push(x - px, y - py, w, h);
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
        const ammo = cells.ammo.slot;
        this.ammo = build([{ cell: 'ammo', position: [0, 0] }], false);
        // Cannon ammo is drawn with a matrix whose unit is the shell width.
        for (let i = 0; i < 4; i++) this.ammo.localRects[i] /= ammo[2];
        // The muzzle wrap reads the same sheet on the 2D overlay (drawWrapOverlay).
        this.sheet = canvas;
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
                if (!this.pose) throw new Error('찹쌀 GPU 포즈를 준비하지 못했습니다.');
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

    // A soldier wrapped over a cannon's muzzle, from BuildingArt.pose: the sleeve turns with the
    // barrel around the muzzle socket, the round body stays upright just outside it.
    // The wrap is the only sign that an outpost cannot fire, so it is drawn on the 2D overlay above
    // the outpost marker and name label, from the same sheet cells with the v3 placements.
    drawWrapOverlay(ctx, cannon) {
        const unit = cannon.scale * WRAP_SCALE,
            { muzzle, muzzleDir } = cannon;
        const sleeve = [
            muzzleDir.x * unit,
            muzzleDir.y * unit,
            -muzzleDir.y * unit,
            muzzleDir.x * unit,
            muzzle.x,
            muzzle.y,
        ];
        const reach = WRAP_BODY_REACH * cannon.scale,
            body = [
                unit,
                0,
                0,
                unit,
                muzzle.x + muzzleDir.x * reach,
                muzzle.y + muzzleDir.y * reach,
            ];
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        for (const [cell, matrix] of [
            ['wrapSleeve', sleeve],
            ['ribbon', multiply(body, placed(72, -44, 18, 0.85))],
            ['wrapBody', body],
            ['hug', multiply(body, placed(0, 4, 0, 0.9))],
        ]) {
            const {
                slot: [sx, sy, w, h],
                pivot: [px, py],
            } = cells[cell];
            ctx.setTransform(...matrix);
            ctx.drawImage(this.sheet, sx, sy, w, h, -px, -py, w, h);
        }
        ctx.restore();
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const actor of this.actors) actor.dispose();
        this.mesh.deletePoseSource(this.source);
        this.context.device.textureAtlas.release(this.region);
    }
}
