// Approved millet parts; forward charge position comes from authoritative unit movement.
const ROOT = new URL('../../../assets/sprites/millet/', import.meta.url);
const FILES = Object.freeze(['parts.png', 'ear.png']);
const PIECES = Object.freeze({
    body: {
        crop: [43, 19, 541, 699],
        slot: [1, 1, 235, 275],
        rect: [-117.5, -159.5, 235, 275],
        part: 0,
    },
    legL: {
        crop: [656, 464, 158, 165],
        slot: [240, 1, 53, 65],
        rect: [-69.5, 86.5, 53, 65],
        part: 1,
    },
    legR: {
        crop: [902, 464, 156, 165],
        slot: [295, 1, 53, 65],
        rect: [16.5, 86.5, 53, 65],
        part: 2,
    },
    armL: { crop: [648, 158, 146, 169], slot: [350, 1, 56, 64], rect: [-133, -6, 56, 64], part: 3 },
    armR: { crop: [926, 159, 144, 168], slot: [408, 1, 56, 64], rect: [77, -6, 56, 64], part: 4 },
    neutral: {
        crop: [1169, 127, 421, 170],
        slot: [1, 280, 132, 66],
        rect: [-66, -81, 132, 66],
        part: 5,
    },
    hurt: {
        crop: [1172, 442, 419, 182],
        slot: [135, 280, 132, 66],
        rect: [-66, -81, 132, 66],
        part: 5,
    },
    attack: {
        crop: [1699, 421, 427, 205],
        slot: [269, 280, 132, 66],
        rect: [-66, -81, 132, 66],
        part: 5,
    },
    ear: {
        file: 'ear.png',
        crop: [375, 180, 794, 737],
        slot: [1, 350, 160, 148],
        rect: [-0.5, -0.464, 1, 0.928],
    },
});
const PARTS = [
    { id: 'body', parent: null, pivot: [0, 0] },
    { id: 'legL', parent: 'body', pivot: [-43, 119] },
    { id: 'legR', parent: 'body', pivot: [43, 119] },
    { id: 'armL', parent: 'body', pivot: [-105, 26] },
    { id: 'armR', parent: 'body', pivot: [105, 26] },
    { id: 'face', parent: 'body', pivot: [0, 0] },
];
const key = (timeMs, body, armL = 0, armR = 0, legL = 0, legR = 0, easing = 'inOutSine') => ({
    timeMs,
    easing,
    parts: {
        body,
        armL: { rotation: armL - 0.1 },
        armR: { rotation: armR + 0.1 },
        legL: { rotation: legL },
        legR: { rotation: legR },
    },
});
const body = (x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1) => ({
    x,
    y,
    rotation,
    scaleX,
    scaleY,
});
export const MILLET_RIG = Object.freeze({
    parts: PARTS,
    clips: {
        idle: {
            durationMs: 1257,
            loop: 'repeat',
            keyframes: [
                key(0, body()),
                key(314, body(0, 3, 0, 1.015, 0.98)),
                key(628, body()),
                key(942, body(0, -3, 0, 0.985, 1.02)),
                key(1257, body()),
            ],
        },
        walk: {
            durationMs: 483,
            loop: 'repeat',
            keyframes: [
                key(0, body()),
                key(121, body(0, -11, 0.04), -0.2, 0.2, 0.25, -0.25),
                key(242, body()),
                key(362, body(0, -11, -0.04), 0.2, -0.2, -0.25, 0.25),
                key(483, body()),
            ],
        },
        fire: {
            durationMs: 1500,
            loop: 'once',
            keyframes: [
                key(0, body()),
                key(300, body(0, 0, -0.08)),
                key(900, body(0, 0, 0.1), -0.1, 0.1),
                key(1100, body(0, 0, 0.1)),
                key(1500, body()),
            ],
        },
        hit: {
            durationMs: 300,
            loop: 'once',
            keyframes: [
                key(0, body(), 0, 0, 0, 0, 'outQuad'),
                key(50, body(7, -5, 0.1, 0.96, 1.04), 0, 0, 0, 0, 'outQuad'),
                key(150, body(-3, 3, -0.06, 1.04, 0.96), 0, 0, 0, 0, 'outQuad'),
                key(300, body(), 0, 0, 0, 0, 'outQuad'),
            ],
        },
    },
});
export async function loadMilletSpriteCanvas() {
    const response = await fetch(new URL('manifest.json', ROOT), { cache: 'no-store' });
    if (!response.ok) throw new Error('조 스프라이트 목록을 불러오지 못했습니다.');
    const manifest = await response.json();
    if (
        manifest?.schemaVersion !== 1 ||
        !manifest.assets ||
        JSON.stringify(Object.keys(manifest.assets).sort()) !== JSON.stringify([...FILES].sort())
    )
        throw new Error('조 스프라이트 목록이 올바르지 않습니다.');
    const images = Object.fromEntries(
        await Promise.all(
            FILES.map(async (file) => {
                const entry = manifest.assets[file];
                if (
                    !entry ||
                    !Number.isSafeInteger(entry.bytes) ||
                    entry.bytes < 1 ||
                    entry.bytes > 3 * 1024 * 1024 ||
                    !/^[a-f0-9]{64}$/.test(entry.sha256 || '')
                )
                    throw new Error('조 스프라이트 정보가 잘못되었습니다: ' + file);
                const res = await fetch(new URL(file, ROOT), { cache: 'no-cache' });
                if (!res.ok) throw new Error('조 스프라이트를 불러오지 못했습니다: ' + file);
                const bytes = await res.arrayBuffer();
                const hash = Array.from(
                    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
                    (b) => b.toString(16).padStart(2, '0'),
                ).join('');
                if (bytes.byteLength !== entry.bytes || hash !== entry.sha256)
                    throw new Error('조 스프라이트 무결성 오류: ' + file);
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
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    for (const piece of Object.values(PIECES))
        ctx.drawImage(images[piece.file || 'parts.png'], ...piece.crop, ...piece.slot);
    return canvas;
}
export function milletSpritePortrait(canvas, width) {
    const output = document.createElement('canvas'),
        scale = width / 320;
    output.width = width;
    output.height = Math.round(360 * scale);
    const ctx = output.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, width / 2, 200 * scale);
    for (const name of ['legL', 'legR', 'armL', 'armR', 'body', 'neutral']) {
        const part = PIECES[name];
        ctx.drawImage(canvas, ...part.slot, ...part.rect);
    }
    return output.toDataURL('image/png');
}
export class MilletSpriteRenderer {
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
            this.source = this.mesh.createPoseSource(gamekit.compilePoseChannels(MILLET_RIG));
        } catch (error) {
            context.device.textureAtlas.release(region);
            throw error;
        }
        this.atlas = { region };
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
                    atlas = region.atlas;
                uv.push(
                    (region.x + x) / atlas.width,
                    (region.y + y) / atlas.height,
                    w / atlas.width,
                    h / atlas.height,
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
        this.atlas.back = build(['legL', 'legR', 'armL', 'armR', 'body']);
        this.atlas.ear = build(['ear']);
        this.atlas.front = {
            neutral: build(['neutral']),
            attack: build(['attack']),
            hurt: build(['hurt']),
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
                if (!this.pose) throw new Error('조 스프라이트에 GPU 포즈를 사용할 수 없습니다.');
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
    draw(data, actor, matrix, depth, threshold = 0, alpha = 1) {
        const c = this.context;
        c.depth = depth;
        c.drawQuads({
            layer: this.atlas.region.layer,
            filter: this.atlas.region.filter,
            ...data,
            ...(actor ? { pose: actor.pose } : {}),
            matrix,
            alpha,
            depthWriteAlphaThreshold: threshold,
        });
    }
    drawBody(actor, matrix, depth) {
        this.draw(this.atlas.back, actor, matrix, depth, 0.05);
    }
    drawFace(actor, matrix, depth, face) {
        this.draw(this.atlas.front[face] || this.atlas.front.neutral, actor, matrix, depth);
    }
    drawEar(matrix, depth, alpha = 1) {
        this.draw(this.atlas.ear, null, matrix, depth, 0, alpha);
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

// Approved idle artwork bounds from hat top to feet: rice 343.5, millet 311.
const MILLET_ART_SCALE = 343.5 / 311;

// This unit's sprite contract (src/units/define-unit.js), loaded only by the page, never the Worker.
export const SPRITE = Object.freeze({
    load: loadMilletSpriteCanvas,
    renderer: MilletSpriteRenderer,
    portrait: milletSpritePortrait,
    groundY: 151.5,
    artScale: MILLET_ART_SCALE,
    shell: { draw: 'drawEar', turn: 0.6, flight: 'ear', particleTrail: true },
    pose: 'body-charge',
    // The ear scatters its soldiers instead of a blast ring and husk.
    landing: 'ear-burst',
});
