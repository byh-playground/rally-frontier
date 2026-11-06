// Approved acorn artwork and motion, prepared once for GameKit GPU poses.
const ROOT = new URL('../../assets/sprites/acorn/', import.meta.url);
const FILES = Object.freeze(['parts.png', 'ammo.png']);
const PIECES = Object.freeze({
    body: {
        crop: [45, 45, 480, 610],
        slot: [1, 1, 225, 285],
        rect: [-112.5, -162.5, 225, 285],
        part: 0,
    },
    legL: {
        crop: [1085, 465, 130, 140],
        slot: [230, 1, 55, 65],
        rect: [-71.5, 80.5, 55, 65],
        part: 1,
    },
    legR: {
        crop: [1320, 465, 130, 140],
        slot: [287, 1, 55, 65],
        rect: [16.5, 80.5, 55, 65],
        part: 2,
    },
    armL: { crop: [1065, 235, 135, 155], slot: [345, 1, 60, 70], rect: [-135, 5, 60, 70], part: 3 },
    armR: { crop: [1320, 235, 135, 155], slot: [408, 1, 60, 70], rect: [75, 5, 60, 70], part: 4 },
    eyeL: { crop: [99, 778, 64, 65], slot: [1, 290, 26, 30], rect: [-47, 0, 26, 30], part: 5 },
    eyeR: { crop: [245, 778, 64, 65], slot: [29, 290, 26, 30], rect: [21, 0, 26, 30], part: 5 },
    cheekL: {
        crop: [48, 840, 80, 62],
        slot: [57, 290, 32, 23],
        rect: [-68, 23.5, 32, 23],
        part: 5,
    },
    cheekR: {
        crop: [275, 840, 80, 62],
        slot: [91, 290, 32, 23],
        rect: [36, 23.5, 32, 23],
        part: 5,
    },
    mouth: { crop: [165, 827, 82, 48], slot: [125, 290, 32, 20], rect: [-16, 19, 32, 20], part: 5 },
    attack: {
        crop: [430, 750, 340, 150],
        slot: [160, 290, 155, 70],
        rect: [-77.5, -15, 155, 70],
        part: 5,
    },
    hurt: {
        crop: [1170, 750, 340, 150],
        slot: [318, 290, 155, 70],
        rect: [-77.5, -15, 155, 70],
        part: 5,
    },
    ammo: {
        file: 'ammo.png',
        crop: [500, 195, 560, 630],
        slot: [230, 76, 128, 144],
        rect: [-4 / 9, -0.5, 8 / 9, 1],
    },
    teamMarker: { slot: [362, 76, 32, 32], rect: [-0.5, -0.5, 1, 1] },
});
const PARTS = [
    { id: 'body', parent: null, pivot: [0, 0] },
    { id: 'legL', parent: 'body', pivot: [-44, 113] },
    { id: 'legR', parent: 'body', pivot: [44, 113] },
    { id: 'armL', parent: 'body', pivot: [-105, 40] },
    { id: 'armR', parent: 'body', pivot: [105, 40] },
    { id: 'face', parent: 'body', pivot: [0, 0] },
];
const frame = (
    timeMs,
    body,
    legL = 0,
    legR = 0,
    armL = { rotation: -0.15 },
    armR = { rotation: 0.15 },
    easing = 'inOutSine',
) => ({
    timeMs,
    easing,
    parts: { body, legL: { rotation: legL }, legR: { rotation: legR }, armL, armR },
});
const body = (x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1) => ({
    x,
    y,
    rotation,
    scaleX,
    scaleY,
});
const walkRaw = [
    [0, -4.9, 5.88, -0.05, 1.06, 0.94],
    [120, -1.96, -15.86, -0.02, 0.95, 1.07],
    [240, 4.9, 5.88, 0.05, 1.06, 0.94],
    [360, 1.96, -15.86, 0.02, 0.95, 1.07],
    [480, -4.9, 5.88, -0.05, 1.06, 0.94],
];
const walkFrames = walkRaw.map(([t, x, y, rotation, sx, sy], i) => {
    const swing = [0, 1, 0, -1, 0][i];
    return frame(
        t,
        body(x * 0.4, y * 0.4, rotation * 0.7, 1 + (sx - 1) * 0.65, 1 + (sy - 1) * 0.65),
        swing * 0.2,
        -swing * 0.2,
        { rotation: -0.15 - swing * 0.12 },
        { rotation: 0.15 + swing * 0.12 },
    );
});
const orbit = (timeMs, theta, amplitude = 1, bodyPose = body()) => {
    const lx = -Math.cos(theta) * 160,
        ly = 0.62 * 160 * Math.sin(theta),
        rx = Math.cos(theta) * 160,
        ry = -0.62 * 160 * Math.sin(theta);
    return frame(
        timeMs,
        bodyPose,
        0,
        0,
        { x: (lx + 105) * amplitude, y: ly * amplitude, rotation: -0.15 },
        { x: (rx - 105) * amplitude, y: ry * amplitude, rotation: 0.15 },
        'linear',
    );
};
const spinFrames = [frame(0, body()), orbit(1000, 0, 1, body(0, 4, 0, 0.965, 1.06))];
for (let i = 1; i <= 36; i++) {
    const theta = (2 * Math.PI * 3 * i) / 36;
    spinFrames.push(orbit(1000 + (2000 * i) / 36, theta, 1, body(0, 0, 0.08 * Math.sin(theta))));
}
spinFrames.push(frame(3400, body()), frame(4000, body()));
export const ACORN_RIG = Object.freeze({
    parts: PARTS,
    clips: {
        idle: {
            durationMs: 1200,
            loop: 'repeat',
            keyframes: [
                frame(0, body(0, 3, 0, 1.012, 0.97)),
                frame(600, body(1, -3, 0.012, 0.985, 1.03)),
                frame(1200, body(0, 3, 0, 1.012, 0.97)),
            ],
        },
        walk: { durationMs: 480, loop: 'repeat', keyframes: walkFrames },
        hit: {
            durationMs: 295,
            loop: 'once',
            keyframes: [
                frame(0, body(), 0, 0, undefined, undefined, 'outQuad'),
                frame(
                    35,
                    body(9.366, -10.632, 0.16, 0.88, 1.14),
                    0,
                    0,
                    undefined,
                    undefined,
                    'outQuad',
                ),
                frame(
                    113,
                    body(-5.286, 5.88, -0.09, 1.1, 0.9),
                    0,
                    0,
                    undefined,
                    undefined,
                    'outQuad',
                ),
                frame(
                    204,
                    body(1.764, -1.176, 0.03, 0.98, 1.02),
                    0,
                    0,
                    undefined,
                    undefined,
                    'outQuad',
                ),
                frame(295, body(), 0, 0, undefined, undefined, 'outQuad'),
            ],
        },
        spin: { durationMs: 4000, loop: 'once', keyframes: spinFrames },
        fire: { durationMs: 4000, loop: 'once', keyframes: spinFrames },
    },
});
export async function loadAcornSpriteCanvas() {
    const response = await fetch(new URL('manifest.json', ROOT), { cache: 'no-store' });
    if (!response.ok) throw new Error('도토리 스프라이트 목록을 불러오지 못했습니다.');
    const manifest = await response.json();
    if (
        manifest?.schemaVersion !== 1 ||
        JSON.stringify(Object.keys(manifest.assets || {}).sort()) !==
            JSON.stringify([...FILES].sort())
    )
        throw new Error('도토리 스프라이트 목록이 올바르지 않습니다.');
    const images = Object.fromEntries(
        await Promise.all(
            FILES.map(async (file) => {
                const entry = manifest.assets[file];
                if (
                    !Number.isSafeInteger(entry?.bytes) ||
                    entry.bytes < 1 ||
                    entry.bytes > 2 * 1024 * 1024 ||
                    !/^[a-f0-9]{64}$/.test(entry.sha256 || '')
                )
                    throw new Error('도토리 스프라이트 정보가 올바르지 않습니다: ' + file);
                const imageResponse = await fetch(new URL(file, ROOT), { cache: 'no-cache' });
                if (!imageResponse.ok)
                    throw new Error('도토리 스프라이트를 불러오지 못했습니다: ' + file);
                const bytes = await imageResponse.arrayBuffer();
                const hash = Array.from(
                    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
                    (v) => v.toString(16).padStart(2, '0'),
                ).join('');
                if (bytes.byteLength !== entry.bytes || hash !== entry.sha256)
                    throw new Error('도토리 스프라이트 무결성 오류: ' + file);
                const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
                try {
                    const image = new Image();
                    image.src = url;
                    await image.decode();
                    return [file, image];
                } finally {
                    URL.revokeObjectURL(url);
                }
            }),
        ),
    );
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 364;
    const ctx = canvas.getContext('2d');
    for (const piece of Object.values(PIECES))
        if (piece.crop)
            ctx.drawImage(images[piece.file || 'parts.png'], ...piece.crop, ...piece.slot);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    const [markerX, markerY, markerW, markerH] = PIECES.teamMarker.slot;
    ctx.arc(markerX + markerW / 2, markerY + markerH / 2, 14.5, 0, Math.PI * 2);
    ctx.fill();
    return canvas;
}
export function acornSpritePortrait(canvas, width) {
    const output = document.createElement('canvas'),
        scale = width / 320;
    output.width = width;
    output.height = Math.round(360 * scale);
    const ctx = output.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, width / 2, 200 * scale);
    for (const name of [
        'legL',
        'legR',
        'armL',
        'body',
        'eyeL',
        'eyeR',
        'cheekL',
        'cheekR',
        'mouth',
        'armR',
    ]) {
        const p = PIECES[name];
        ctx.drawImage(canvas, ...p.slot, ...p.rect);
    }
    return output.toDataURL('image/png');
}
export class AcornSpriteRenderer {
    constructor(context, canvas, gamekit) {
        this.context = context;
        this.mesh = context.acquireMeshRenderer();
        this.actors = new Set();
        this.disposed = false;
        const region = context.device.textureAtlas.allocate(canvas.width, canvas.height, {
            filter: 'linear',
        });
        try {
            context.device.textureAtlas.upload(region, canvas);
            this.source = this.mesh.createPoseSource(gamekit.compilePoseChannels(ACORN_RIG));
        } catch (error) {
            context.device.textureAtlas.release(region);
            throw error;
        }
        this.base = PARTS.map(() => ({
            x: 0,
            y: 0,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
        }));
        this.visible = PARTS.map(() => true);
        this.morph = [0, 0];
        const build = (names) => {
            const uv = [],
                local = [],
                parts = [];
            for (const name of names) {
                const item = PIECES[name],
                    [x, y, w, h] = item.slot,
                    a = region.atlas;
                uv.push(
                    (region.x + x) / a.width,
                    (region.y + y) / a.height,
                    w / a.width,
                    h / a.height,
                );
                local.push(...item.rect);
                if (item.part != null) parts.push(item.part);
            }
            return {
                uvRects: Float32Array.from(uv),
                localRects: Float32Array.from(local),
                ...(parts.length ? { parts: Float32Array.from(parts) } : {}),
            };
        };
        const faces = {
            neutral: ['eyeL', 'eyeR', 'cheekL', 'cheekR', 'mouth'],
            attack: ['attack'],
            hurt: ['hurt'],
        };
        this.atlas = {
            region,
            back: {
                left: build(['legL', 'legR', 'armL', 'body']),
                right: build(['legL', 'legR', 'armR', 'body']),
            },
            front: {},
            ammo: build(['ammo']),
            teamMarker: build(['teamMarker']),
        };
        for (const [name, list] of Object.entries(faces))
            this.atlas.front[name] = {
                left: build([...list, 'armL']),
                right: build([...list, 'armR']),
            };
        context.onDispose(() => this.dispose());
    }
    createActor() {
        const owner = this,
            instance = this.mesh.createPoseInstance(this.source);
        const actor = {
            currentClip: 'idle',
            startedAt: 0,
            elapsed: 0,
            pose: null,
            disposed: false,
            play(clip) {
                this.currentClip = clip;
                this.startedAt = clip === 'idle' || clip === 'walk' ? 0 : null;
                return this;
            },
            seek(time) {
                if (this.startedAt === null) this.startedAt = time;
                this.elapsed = Math.max(0, time - this.startedAt);
                return this;
            },
            seekElapsed(ms) {
                this.elapsed = Math.max(0, Number(ms) || 0);
                return this;
            },
            preparePose() {
                this.pose = owner.mesh.preparePose(instance, {
                    clipName: this.currentClip,
                    elapsedMs: this.elapsed,
                    basePoses: owner.base,
                    visible: owner.visible,
                    morph: owner.morph,
                });
                if (!this.pose) throw new Error('도토리에 GPU 포즈를 사용할 수 없습니다.');
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
    armBehind(actor) {
        if (
            (actor.currentClip === 'spin' || actor.currentClip === 'fire') &&
            actor.elapsed >= 1000 &&
            actor.elapsed < 3000
        )
            return Math.sin(((actor.elapsed - 1000) / 2000) * Math.PI * 6) > 0 ? 'right' : 'left';
        return 'left';
    }
    draw(data, actor, matrix, depth, threshold = 0) {
        const c = this.context;
        c.depth = depth;
        c.drawQuads({
            layer: this.atlas.region.layer,
            filter: this.atlas.region.filter,
            ...data,
            ...(actor ? { pose: actor.pose } : {}),
            matrix,
            depthWriteAlphaThreshold: threshold,
        });
    }
    drawBody(actor, matrix, depth) {
        this.draw(this.atlas.back[this.armBehind(actor)], actor, matrix, depth, 0.05);
    }
    drawAmmo(matrix, depth) {
        this.draw(this.atlas.ammo, null, matrix, depth);
    }
    drawTeamMarker(matrix, depth, own) {
        this.context.depth = depth;
        this.context.drawQuads({
            layer: this.atlas.region.layer,
            filter: this.atlas.region.filter,
            ...this.atlas.teamMarker,
            matrix,
            color: own ? [0.3, 0.55, 1, 1] : [1, 0.36, 0.32, 1],
        });
    }
    drawFace(actor, matrix, depth, face) {
        const front = this.armBehind(actor) === 'left' ? 'right' : 'left';
        this.draw(
            (this.atlas.front[face] || this.atlas.front.neutral)[front],
            actor,
            matrix,
            depth,
        );
    }
    dispose() {
        if (this.disposed) return false;
        this.disposed = true;
        for (const actor of [...this.actors]) actor.dispose();
        this.mesh.deletePoseSource(this.source);
        this.context.device.textureAtlas.release(this.atlas.region);
        return true;
    }
}
