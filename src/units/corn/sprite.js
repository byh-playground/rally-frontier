// Approved corn character, kernel and popcorn remain separate components in one GPU atlas.
import { GRAIN_RIG as RICE_RIG } from '../../render/grain-rig.js';

const ROOT = new URL('../../../assets/sprites/corn/', import.meta.url);
const FRIENDLY_MARKER = Object.freeze([0.3, 0.55, 1, 1]);
const ENEMY_MARKER = Object.freeze([1, 0.36, 0.32, 1]);
const FILES = Object.freeze(['parts.png', 'kernel.png', 'popcorn-particles.png', 'cob.png']);
const PIECES = Object.freeze({
    body: {
        file: 'parts.png',
        crop: [55, 210, 610, 620],
        slot: [1, 1, 260, 265],
        rect: [-130, -150.5, 260, 265],
        part: 0,
    },
    legL: {
        file: 'parts.png',
        crop: [680, 700, 155, 170],
        slot: [265, 1, 65, 72],
        rect: [-82.5, 76, 65, 72],
        part: 1,
    },
    legR: {
        file: 'parts.png',
        crop: [890, 700, 165, 170],
        slot: [332, 1, 65, 72],
        rect: [17.5, 76, 65, 72],
        part: 2,
    },
    armL: {
        file: 'parts.png',
        crop: [680, 345, 165, 205],
        slot: [399, 1, 70, 86],
        rect: [-145, -15, 70, 86],
        part: 3,
    },
    armR: {
        file: 'parts.png',
        crop: [900, 345, 165, 205],
        slot: [471, 1, 70, 78],
        rect: [102, -32, 70, 78],
        part: 5,
    },
    neutral: {
        file: 'parts.png',
        crop: [1120, 120, 360, 155],
        slot: [1, 270, 154, 67],
        rect: [-77, -83.5, 154, 67],
        part: 7,
    },
    attack: {
        file: 'parts.png',
        crop: [1120, 750, 360, 150],
        slot: [157, 270, 154, 67],
        rect: [-77, -83.5, 154, 67],
        part: 7,
    },
    kernel: {
        file: 'kernel.png',
        crop: [600, 385, 330, 260],
        slot: [543, 1, 165, 130],
        rect: [-0.5, -0.4, 1, 0.8],
    },
    cone: {
        file: 'cob.png',
        crop: [320, 72, 950, 890],
        slot: [710, 1, 300, 281],
        rect: [-0.5, -0.468, 1, 0.936],
    },
    pop0: {
        file: 'popcorn-particles.png',
        crop: [180, 137, 498, 425],
        slot: [1, 350, 150, 135],
        rect: [-0.5, -0.5, 1, 1],
    },
    pop1: {
        file: 'popcorn-particles.png',
        crop: [986, 214, 361, 315],
        slot: [153, 350, 150, 135],
        rect: [-0.5, -0.5, 1, 1],
    },
    pop2: {
        file: 'popcorn-particles.png',
        crop: [1678, 288, 253, 233],
        slot: [305, 350, 150, 135],
        rect: [-0.5, -0.5, 1, 1],
    },
    teamMarker: {
        slot: [460, 350, 32, 32],
        rect: [-0.5, -0.5, 1, 1],
    },
});
const CORN_PARTS = [
    { id: 'body', parent: null, pivot: [0, 0] },
    { id: 'legL', parent: 'body', pivot: [-50, 112] },
    { id: 'legR', parent: 'body', pivot: [50, 112] },
    { id: 'armL', parent: 'body', pivot: [-110, 28] },
    { id: 'hand', parent: 'body', pivot: [112, 0] },
    { id: 'armR', parent: 'hand', pivot: [112, 0] },
    { id: 'sickle', parent: 'hand', pivot: [112, 0] },
    { id: 'face', parent: 'body', pivot: [0, -50] },
];
const fireKey = (timeMs, rotation) => ({
    timeMs,
    easing: 'inOutSine',
    parts: { hand: { rotation } },
});
// Keep fixed limb placement inside the GPU clip, avoiding per-instance override uploads.
const withLimbRest = (clip) => ({
    ...clip,
    keyframes: clip.keyframes.map((key) => ({
        ...key,
        parts: {
            ...key.parts,
            armL: { ...key.parts.armL, rotation: (key.parts.armL?.rotation ?? 0) - 0.15 },
            armR: { ...key.parts.armR, rotation: (key.parts.armR?.rotation ?? 0) + 0.15 },
        },
    })),
});
export const CORN_RIG = Object.freeze({
    parts: CORN_PARTS,
    clips: Object.fromEntries(
        Object.entries({
            ...RICE_RIG.clips,
            hit: {
                ...RICE_RIG.clips.hit,
                keyframes: [
                    ...RICE_RIG.clips.hit.keyframes.slice(0, 4).map((key) => ({
                        ...key,
                        parts: { ...key.parts, face: { scaleY: 0.18 } },
                    })),
                    { timeMs: 220, easing: 'linear', parts: { face: { scaleY: 0.18 } } },
                    { timeMs: 221, easing: 'linear', parts: { face: { scaleY: 1 } } },
                    RICE_RIG.clips.hit.keyframes[4],
                ],
            },
            fire: {
                durationMs: 950,
                loop: 'once',
                keyframes: [
                    fireKey(0, 0),
                    fireKey(320, -1.15),
                    fireKey(620, 0.65),
                    fireKey(950, 0),
                ],
            },
        }).map(([name, clip]) => [name, withLimbRest(clip)]),
    ),
});

export async function loadCornSpriteCanvas() {
    const response = await fetch(new URL('manifest.json', ROOT), { cache: 'no-store' });
    if (!response.ok) throw new Error('옥수수 스프라이트 목록을 불러오지 못했습니다.');
    const manifest = await response.json();
    if (
        manifest?.schemaVersion !== 1 ||
        !manifest.assets ||
        JSON.stringify(Object.keys(manifest.assets).sort()) !== JSON.stringify([...FILES].sort())
    )
        throw new Error('옥수수 스프라이트 목록이 올바르지 않습니다.');
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
                    throw new Error('옥수수 스프라이트 정보가 잘못되었습니다: ' + file);
                const res = await fetch(new URL(file, ROOT), { cache: 'no-cache' });
                if (!res.ok) throw new Error('옥수수 스프라이트를 불러오지 못했습니다: ' + file);
                const bytes = await res.arrayBuffer();
                const hash = Array.from(
                    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
                    (b) => b.toString(16).padStart(2, '0'),
                ).join('');
                if (bytes.byteLength !== entry.bytes || hash !== entry.sha256)
                    throw new Error('옥수수 스프라이트 무결성 오류: ' + file);
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
        if (piece.file) ctx.drawImage(images[piece.file], ...piece.crop, ...piece.slot);
    const [markerX, markerY, markerW, markerH] = PIECES.teamMarker.slot;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(markerX + markerW / 2, markerY + markerH / 2, 14.5, 0, Math.PI * 2);
    ctx.fill();
    return canvas;
}

export function cornSpritePortrait(canvas, width) {
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

export class CornSpriteRenderer {
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
            this.source = this.mesh.createPoseSource(gamekit.compilePoseChannels(CORN_RIG));
        } catch (error) {
            context.device.textureAtlas.release(region);
            throw error;
        }
        this.atlas = { region };
        this.base = CORN_PARTS.map(() => ({
            x: 0,
            y: 0,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            opacity: 1,
        }));
        this.visible = CORN_PARTS.map(() => true);
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
            hurt: build(['armR', 'neutral']),
        };
        this.atlas.kernel = build(['kernel']);
        this.atlas.cone = build(['cone']);
        this.atlas.teamMarker = build(['teamMarker']);
        this.atlas.heldKernel = {
            uvRects: this.atlas.kernel.uvRects,
            localRects: Float32Array.from([117, -9, 60, 48]),
            parts: Float32Array.of(4),
        };
        this.atlas.popcorn = [build(['pop0']), build(['pop1']), build(['pop2'])];
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
                if (!this.pose)
                    throw new Error('옥수수 스프라이트에 GPU 포즈를 사용할 수 없습니다.');
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
    drawKernel(matrix, depth) {
        this.draw(this.atlas.kernel, null, matrix, depth);
    }
    drawCone(matrix, depth) {
        this.draw(this.atlas.cone, null, matrix, depth);
    }
    drawTeamMarker(matrix, depth, own) {
        const c = this.context;
        c.depth = depth;
        c.drawQuads({
            layer: this.atlas.region.layer,
            filter: this.atlas.region.filter,
            ...this.atlas.teamMarker,
            matrix,
            color: own ? FRIENDLY_MARKER : ENEMY_MARKER,
        });
    }
    drawHeldKernel(actor, matrix, depth) {
        this.draw(this.atlas.heldKernel, actor, matrix, depth);
    }
    drawPopcorn(index, matrix, depth, alpha = 1) {
        if (!Number.isInteger(index) || index < 0 || index >= this.atlas.popcorn.length)
            throw new RangeError('옥수수 파편 인덱스가 잘못되었습니다.');
        this.draw(this.atlas.popcorn[index], null, matrix, depth, alpha);
    }
    // Start-screen warm-up of the shared particle art.
    prepareExtraArt(matrix) {
        this.drawKernel(matrix, 0);
        this.drawTeamMarker(matrix, 0, true);
        for (let i = 0; i < 3; i++) this.drawPopcorn(i, matrix, 0);
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
    load: loadCornSpriteCanvas,
    renderer: CornSpriteRenderer,
    portrait: cornSpritePortrait,
    groundY: 148,
    shell: {
        draw: 'drawCone',
        turn: Math.PI / 4,
        flight: 'cone',
        particleTrail: true,
        aimFallback: true,
        depthTest: true,
    },
    pose: 'kernel-thrower',
    // Shell team markers, kernel and popcorn particles and their trails for every grain.
    effectArt: ['grain-particles'],
});
