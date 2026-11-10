// Approved popcorn character parts from the reviewed movement mockup.
import { GRAIN_RIG as RICE_RIG } from '../../render/grain-rig.js';

const ROOT = new URL('../../../assets/sprites/popcorn/', import.meta.url);
const FILES = Object.freeze(['parts.png']);
// Coordinates reproduce the reviewed mockup at 2.5× its local scale, so its
// height matches the existing character scale. Atlas slots have gutters.
const PIECES = Object.freeze({
    body: {
        file: 'parts.png',
        crop: [70, 70, 360, 440],
        slot: [1, 1, 235, 285],
        rect: [-117.5, -147.5, 235, 285],
        part: 0,
    },
    legL: {
        file: 'parts.png',
        crop: [485, 398, 105, 122],
        slot: [238, 1, 68, 80],
        rect: [-95, 67.5, 67.5, 80],
        part: 1,
    },
    legR: {
        file: 'parts.png',
        crop: [620, 398, 110, 122],
        slot: [308, 1, 68, 80],
        rect: [27.5, 67.5, 67.5, 80],
        part: 2,
    },
    armL: {
        file: 'parts.png',
        crop: [470, 180, 120, 120],
        slot: [378, 1, 75, 78],
        rect: [-142.5, -35, 75, 77.5],
        part: 3,
    },
    armR: {
        file: 'parts.png',
        crop: [625, 180, 120, 120],
        slot: [238, 83, 75, 78],
        rect: [72.5, -35, 75, 77.5],
        part: 5,
    },
    neutral: {
        file: 'parts.png',
        crop: [805, 235, 285, 125],
        slot: [1, 288, 170, 75],
        rect: [-85, -65, 170, 75],
        part: 7,
    },
    attack: {
        file: 'parts.png',
        crop: [1480, 225, 295, 145],
        slot: [173, 288, 170, 75],
        rect: [-85, -65, 170, 75],
        part: 7,
    },
    hurt: {
        file: 'parts.png',
        crop: [1140, 215, 295, 155],
        slot: [1, 365, 170, 75],
        rect: [-85, -65, 170, 75],
        part: 7,
    },
    // Reuse the body texture without a pose channel for the flying shell.
    ammo: {
        slot: [1, 1, 235, 285],
        rect: [-0.4125, -0.5, 0.825, 1],
    },
    burst: {
        file: 'parts.png',
        crop: [145, 520, 200, 165],
        slot: [174, 365, 160, 132],
        rect: [-0.5, -0.4125, 1, 0.825],
    },
});
const POPCORN_PARTS = [
    { id: 'body', parent: null, pivot: [0, 0] },
    { id: 'legL', parent: 'body', pivot: [-60, 95] },
    { id: 'legR', parent: 'body', pivot: [60, 95] },
    { id: 'armL', parent: 'body', pivot: [-100, 5] },
    { id: 'hand', parent: 'body', pivot: [100, 5] },
    { id: 'armR', parent: 'hand', pivot: [100, 5] },
    { id: 'sickle', parent: 'hand', pivot: [100, 5] },
    { id: 'face', parent: 'body', pivot: [0, -30] },
];
// The renderer owner starts this once for the authoritative 1 s windup.
export const POPCORN_RIG = Object.freeze({
    parts: POPCORN_PARTS,
    clips: {
        ...RICE_RIG.clips,
        windup: {
            durationMs: 1000,
            loop: 'once',
            keyframes: [
                { timeMs: 0, easing: 'linear', parts: { body: { scaleX: 1, scaleY: 1 } } },
                {
                    timeMs: 500,
                    easing: 'inOutSine',
                    parts: { body: { scaleX: 1.085, scaleY: 0.915 } },
                },
                {
                    timeMs: 1000,
                    easing: 'inOutSine',
                    parts: { body: { scaleX: 1.17, scaleY: 0.83 } },
                },
            ],
        },
    },
});

export async function loadPopcornSpriteCanvas() {
    const response = await fetch(new URL('manifest.json', ROOT), { cache: 'no-store' });
    if (!response.ok) throw new Error('팝콘 스프라이트 목록을 불러오지 못했습니다.');
    const manifest = await response.json();
    if (
        manifest?.schemaVersion !== 1 ||
        !manifest.assets ||
        JSON.stringify(Object.keys(manifest.assets).sort()) !== JSON.stringify([...FILES].sort())
    )
        throw new Error('팝콘 스프라이트 목록이 올바르지 않습니다.');
    const images = Object.fromEntries(
        await Promise.all(
            FILES.map(async (file) => {
                const entry = manifest.assets[file];
                if (
                    !entry ||
                    !Number.isSafeInteger(entry.bytes) ||
                    entry.bytes < 1 ||
                    entry.bytes > 2 * 1024 * 1024 ||
                    !/^[a-f0-9]{64}$/.test(entry.sha256 || '')
                )
                    throw new Error('팝콘 스프라이트 정보가 잘못되었습니다: ' + file);
                const res = await fetch(new URL(file, ROOT), { cache: 'no-cache' });
                if (!res.ok) throw new Error('팝콘 스프라이트를 불러오지 못했습니다: ' + file);
                const bytes = await res.arrayBuffer();
                const hash = Array.from(
                    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
                    (b) => b.toString(16).padStart(2, '0'),
                ).join('');
                if (bytes.byteLength !== entry.bytes || hash !== entry.sha256)
                    throw new Error('팝콘 스프라이트 무결성 오류: ' + file);
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
        if (piece.file) ctx.drawImage(images[piece.file], ...piece.crop, ...piece.slot);
    return canvas;
}

export function popcornSpritePortrait(canvas, width) {
    const output = document.createElement('canvas'),
        scale = width / 320;
    output.width = width;
    output.height = Math.round(360 * scale);
    const ctx = output.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, width / 2, 200 * scale);
    for (const name of ['legL', 'legR', 'armL', 'body', 'armR', 'neutral']) {
        const part = PIECES[name];
        ctx.drawImage(canvas, ...part.slot, ...part.rect);
    }
    return output.toDataURL('image/png');
}

export class PopcornSpriteRenderer {
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
            this.source = this.mesh.createPoseSource(gamekit.compilePoseChannels(POPCORN_RIG));
        } catch (error) {
            context.device.textureAtlas.release(region);
            throw error;
        }
        this.atlas = { region };
        this.base = POPCORN_PARTS.map(() => ({
            x: 0,
            y: 0,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
        }));
        this.visible = POPCORN_PARTS.map(() => true);
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
        this.atlas.back = build(['legL', 'legR', 'armL', 'body']);
        this.atlas.front = {
            neutral: build(['armR', 'neutral']),
            attack: build(['armR', 'attack']),
            hurt: build(['armR', 'hurt']),
        };
        this.atlas.ammo = build(['ammo']);
        this.atlas.burst = build(['burst']);
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
                if (!this.pose) throw new Error('팝콘 스프라이트에 GPU 포즈를 사용할 수 없습니다.');
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
    draw(data, actor, matrix, depth, alpha = 1, threshold = 0) {
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
        this.draw(this.atlas.back, actor, matrix, depth, 1, 0.05);
    }
    drawFace(actor, matrix, depth, face) {
        this.draw(this.atlas.front[face] || this.atlas.front.neutral, actor, matrix, depth);
    }
    drawAmmo(matrix, depth) {
        this.draw(this.atlas.ammo, null, matrix, depth);
    }
    drawBurst(matrix, depth, alpha = 1) {
        this.draw(this.atlas.burst, null, matrix, depth, alpha);
    }
    // Start-screen warm-up of the self-destruct burst.
    prepareExtraArt(matrix) {
        this.drawBurst(matrix, 0);
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

// This unit's sprite contract (src/units/define-unit.js), loaded only by the page, never the Worker.
export const SPRITE = Object.freeze({
    load: loadPopcornSpriteCanvas,
    renderer: PopcornSpriteRenderer,
    portrait: popcornSpritePortrait,
    groundY: 145,
    shell: { draw: 'drawAmmo', flight: 'cone', particleTrail: true },
    effectArt: ['self-destruct-burst'],
});
