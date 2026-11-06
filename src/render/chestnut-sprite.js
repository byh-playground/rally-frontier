// Approved chestnut body, limbs, face and thorn occupy one GPU atlas.
const ROOT = new URL('../../assets/sprites/chestnut/', import.meta.url);
const FILES = Object.freeze(['parts.png', 'thorn.png', 'burr.png']);
// A separate reusable particle, not baked into the thorn artwork.
const PARTICLE_SLOT = [845, 1, 16, 16];
const PIECES = Object.freeze({
    body: {
        file: 'parts.png',
        crop: [25, 20, 700, 700],
        slot: [1, 1, 295, 270],
        rect: [-147.5, -147, 295, 270],
        part: 0,
    },
    legL: {
        file: 'parts.png',
        crop: [770, 410, 165, 215],
        slot: [300, 1, 62, 72],
        rect: [-81, 84, 62, 72],
        part: 1,
    },
    legR: {
        file: 'parts.png',
        crop: [970, 410, 165, 215],
        slot: [364, 1, 62, 72],
        rect: [19, 84, 62, 72],
        part: 2,
    },
    armL: {
        file: 'parts.png',
        crop: [755, 145, 165, 180],
        slot: [428, 1, 64, 72],
        rect: [-172, 2, 64, 72],
        part: 3,
    },
    armR: {
        file: 'parts.png',
        crop: [985, 145, 165, 180],
        slot: [494, 1, 64, 72],
        rect: [108, 2, 64, 72],
        part: 4,
    },
    neutral: {
        file: 'parts.png',
        crop: [1220, 110, 430, 210],
        slot: [1, 278, 152, 74],
        rect: [-76, -46, 152, 74],
        part: 5,
    },
    hurt: {
        file: 'parts.png',
        crop: [1220, 395, 430, 210],
        slot: [155, 278, 152, 74],
        rect: [-76, -46, 152, 74],
        part: 5,
    },
    thorn: {
        file: 'thorn.png',
        crop: [300, 200, 950, 300],
        slot: [310, 278, 190, 60],
        rect: [-0.5, -0.158, 1, 0.316],
    },
    burr: {
        file: 'burr.png',
        crop: [325, 116, 870, 785],
        slot: [560, 1, 280, 253],
        rect: [-0.5, -0.451, 1, 0.902],
    },
});
const PARTS = [
    { id: 'body', parent: null, pivot: [0, 0] },
    { id: 'legL', parent: 'body', pivot: [-50, 120] },
    { id: 'legR', parent: 'body', pivot: [50, 120] },
    { id: 'armL', parent: 'body', pivot: [-140, 38] },
    { id: 'armR', parent: 'body', pivot: [140, 38] },
    { id: 'face', parent: 'body', pivot: [0, 0] },
];
const key = (timeMs, body, armL = 0, armR = 0, legL = 0, legR = 0, easing = 'inOutSine') => ({
    timeMs,
    easing,
    parts: {
        body,
        armL: { rotation: armL - 0.15 },
        armR: { rotation: armR + 0.15 },
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
export const CHESTNUT_RIG = Object.freeze({
    parts: PARTS,
    clips: {
        idle: {
            durationMs: 1200,
            loop: 'repeat',
            keyframes: [
                key(0, body(0, 2, 0, 1.01, 0.98), -0.04, 0.04),
                key(600, body(1, -3, 0.012, 0.99, 1.03), 0.04, -0.04),
                key(1200, body(0, 2, 0, 1.01, 0.98), -0.04, 0.04),
            ],
        },
        walk: {
            durationMs: 480,
            loop: 'repeat',
            keyframes: [
                key(0, body(-4, 4, -0.04, 1.04, 0.95), -0.15, 0.15),
                key(120, body(-1, -12, -0.02, 0.96, 1.06), 0.05, -0.05, 0.22, -0.22),
                key(240, body(4, 4, 0.04, 1.04, 0.95), 0.15, -0.15),
                key(360, body(1, -12, 0.02, 0.96, 1.06), -0.05, 0.05, -0.22, 0.22),
                key(480, body(-4, 4, -0.04, 1.04, 0.95), -0.15, 0.15),
            ],
        },
        fire: {
            durationMs: 1400,
            loop: 'once',
            keyframes: [
                key(0, body()),
                key(300, body(0, 2, -0.02, 0.98, 1.02), -0.12, -0.35),
                key(550, body(0, -3, 0.02, 1.02, 0.98), 0.1, 0.55),
                key(720, body(0, -2, 0.01, 1.01, 0.99), 0.05, 0.28),
                key(1000, body()),
                key(1400, body()),
            ],
        },
        hit: {
            durationMs: 295,
            loop: 'once',
            keyframes: [
                key(0, body(), 0, 0, 0, 0, 'outQuad'),
                key(35, body(12, -14, 0.13, 0.9, 1.1), -0.2, 0.2, 0, 0, 'outQuad'),
                key(113, body(-7, 8, -0.08, 1.08, 0.92), 0.14, -0.14, 0, 0, 'outQuad'),
                key(204, body(2, -2, 0.025, 0.99, 1.01), -0.03, 0.03, 0, 0, 'outQuad'),
                key(295, body(), 0, 0, 0, 0, 'outQuad'),
            ],
        },
    },
});

export async function loadChestnutSpriteCanvas() {
    const response = await fetch(new URL('manifest.json', ROOT), { cache: 'no-store' });
    if (!response.ok) throw new Error('밤톨 스프라이트 목록을 불러오지 못했습니다.');
    const manifest = await response.json();
    if (
        manifest?.schemaVersion !== 1 ||
        !manifest.assets ||
        JSON.stringify(Object.keys(manifest.assets).sort()) !== JSON.stringify([...FILES].sort())
    )
        throw new Error('밤톨 스프라이트 목록이 올바르지 않습니다.');
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
                    throw new Error('밤톨 스프라이트 정보가 잘못되었습니다: ' + file);
                const res = await fetch(new URL(file, ROOT), { cache: 'no-cache' });
                if (!res.ok) throw new Error('밤톨 스프라이트를 불러오지 못했습니다: ' + file);
                const bytes = await res.arrayBuffer();
                const hash = Array.from(
                    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
                    (b) => b.toString(16).padStart(2, '0'),
                ).join('');
                if (bytes.byteLength !== entry.bytes || hash !== entry.sha256)
                    throw new Error('밤톨 스프라이트 무결성 오류: ' + file);
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
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    for (const piece of Object.values(PIECES))
        ctx.drawImage(images[piece.file], ...piece.crop, ...piece.slot);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(853, 9, 7, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    return canvas;
}
export function chestnutSpritePortrait(canvas, width) {
    const output = document.createElement('canvas'),
        scale = width / 360;
    output.width = width;
    output.height = Math.round(360 * scale);
    const ctx = output.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, width / 2, 190 * scale);
    for (const name of ['legL', 'legR', 'armL', 'armR', 'body', 'neutral']) {
        const part = PIECES[name];
        ctx.drawImage(canvas, ...part.slot, ...part.rect);
    }
    return output.toDataURL('image/png');
}
export class ChestnutSpriteRenderer {
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
            this.source = this.mesh.createPoseSource(gamekit.compilePoseChannels(CHESTNUT_RIG));
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
        this.atlas.front = {
            neutral: build(['neutral']),
            attack: build(['neutral']),
            hurt: build(['hurt']),
        };
        this.atlas.thorn = build(['thorn']);
        this.atlas.burr = build(['burr']);
        const [particleX, particleY, particleW, particleH] = PARTICLE_SLOT,
            atlas = region.atlas;
        this.atlas.particle = {
            uvRects: Float32Array.of(
                (region.x + particleX) / atlas.width,
                (region.y + particleY) / atlas.height,
                particleW / atlas.width,
                particleH / atlas.height,
            ),
            localRects: Float32Array.of(-0.5, -0.5, 1, 1),
        };
        this.atlas.trail = Array.from({ length: 4 }, (_, index) => {
            const uv = [],
                local = [];
            for (let i = 1; i <= index + 1; i++) {
                const width = (12 - i * 1.5) / 32,
                    height = (6 - i * 0.8) / 32,
                    center = -0.5 - i / 8;
                uv.push(...this.atlas.particle.uvRects);
                local.push(center - width / 2, -height / 2, width, height);
            }
            return { uvRects: Float32Array.from(uv), localRects: Float32Array.from(local) };
        });
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
                if (!this.pose) throw new Error('밤톨 스프라이트에 GPU 포즈를 사용할 수 없습니다.');
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
    draw(data, actor, matrix, depth, alpha = 1, threshold = 0, color = [1, 1, 1, 1]) {
        const c = this.context;
        c.depth = depth;
        c.drawQuads({
            layer: this.atlas.region.layer,
            filter: this.atlas.region.filter,
            ...data,
            ...(actor ? { pose: actor.pose } : {}),
            matrix,
            alpha,
            color,
            depthWriteAlphaThreshold: threshold,
        });
    }
    drawBody(actor, matrix, depth) {
        this.draw(this.atlas.back, actor, matrix, depth, 1, 0.05);
    }
    drawFace(actor, matrix, depth, face) {
        this.draw(this.atlas.front[face] || this.atlas.front.neutral, actor, matrix, depth);
    }
    drawThorn(matrix, depth, alpha = 1) {
        this.draw(this.atlas.thorn, null, matrix, depth, alpha);
    }
    drawParticle(matrix, depth, color, alpha = 1) {
        this.draw(this.atlas.particle, null, matrix, depth, alpha, 0, color);
    }
    drawTrail(matrix, depth, count, color, alpha = 1) {
        if (count > 0)
            this.draw(
                this.atlas.trail[Math.min(4, count) - 1],
                null,
                matrix,
                depth,
                alpha,
                0,
                color,
            );
    }
    drawBurr(matrix, depth, alpha = 1) {
        this.draw(this.atlas.burr, null, matrix, depth, alpha);
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
