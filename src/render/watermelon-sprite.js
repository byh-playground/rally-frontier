const PARTS = [
    { id: 'body', parent: null, pivot: [0, 0] },
    { id: 'leftFoot', parent: 'body', pivot: [-46, 93] },
    { id: 'rightFoot', parent: 'body', pivot: [46, 93] },
    { id: 'leftHand', parent: 'body', pivot: [0, 0] },
    { id: 'rightHand', parent: 'body', pivot: [0, 0] },
];

const BODY = { slot: [2, 2, 240, 214], rect: [-120, -116, 240, 214], part: 0 };
const FOOT = { slot: [320, 2, 46, 58], rect: [-23, -29, 46, 58] };
const HAND = { slot: [246, 2, 70, 70], rect: [-35, -35, 70, 70] };
const FEET = [
    { ...FOOT, rect: [-69, 64, 46, 58], part: 1 },
    { ...FOOT, rect: [23, 64, 46, 58], part: 2 },
];
const LEFT = { ...HAND, part: 3 };
const RIGHT = { ...HAND, part: 4 };
const FACES = Object.fromEntries(
    ['neutral', 'attack', 'hurt'].map((name, index) => [
        name,
        { slot: [244, 75 + index * 47, 112, 45], rect: [-56, -39, 112, 45], part: 0 },
    ]),
);

const key = (timeMs, parts = {}) => ({ timeMs, parts, easing: 'inOutSine' });
const clip = (durationMs, loop, keyframes) => ({ durationMs, loop, keyframes });
const RIG = {
    parts: PARTS,
    clips: {
        idle: clip(1200, 'repeat', [
            key(0),
            key(600, { body: { y: -3, scaleX: 0.99, scaleY: 1.025 } }),
            key(1200),
        ]),
        walk: clip(650, 'repeat', [
            key(0, { leftFoot: { rotation: -0.24 }, rightFoot: { rotation: 0.24 } }),
            key(325, {
                body: { y: -6, rotation: 0.04 },
                leftFoot: { rotation: 0.24 },
                rightFoot: { rotation: -0.24 },
            }),
            key(650, { leftFoot: { rotation: -0.24 }, rightFoot: { rotation: 0.24 } }),
        ]),
        fire: clip(650, 'once', [
            key(0, { body: { scaleX: 0.92, scaleY: 1.08 } }),
            key(145, { body: { scaleX: 1.1, scaleY: 0.9 } }),
            key(650),
        ]),
        hit: clip(260, 'once', [
            key(0, { body: { scaleX: 1.08, scaleY: 0.9, rotation: -0.09 } }),
            key(260),
        ]),
        spin: clip(4000, 'once', [
            key(0),
            key(850, { body: { y: 7, scaleX: 1.08, scaleY: 0.91 } }),
            key(1000),
            key(1850, { body: { y: -7, scaleX: 0.985, scaleY: 1.05 } }),
            key(3000, { body: { y: 4, scaleX: 1.06, scaleY: 0.95 } }),
            key(4000),
        ]),
    },
};

export async function loadWatermelonSpriteCanvas() {
    const image = new Image();
    image.src = new URL('../../assets/sprites/watermelon/parts.svg', import.meta.url).href;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas;
}

export function watermelonSpritePortrait(source, width) {
    const canvas = document.createElement('canvas'),
        scale = width / 320;
    canvas.width = width;
    canvas.height = Math.round(265 * scale);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, width / 2, 130 * scale);
    for (const foot of FEET) ctx.drawImage(source, ...foot.slot, ...foot.rect);
    for (const x of [-118, 118]) ctx.drawImage(source, ...HAND.slot, x - 35, 13, 70, 70);
    ctx.drawImage(source, ...BODY.slot, ...BODY.rect);
    ctx.drawImage(source, ...FACES.neutral.slot, ...FACES.neutral.rect);
    return canvas.toDataURL('image/png');
}

// The original SVG is sampled once into the shared sprite atlas. The same pieces
// serve the battlefield, card portrait and artillery shell.
export class WatermelonSpriteRenderer {
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
            this.source = this.mesh.createPoseSource(gamekit.compilePoseChannels(RIG));
        } catch (error) {
            context.device.textureAtlas.release(region);
            throw error;
        }
        this.region = region;
        this.visible = PARTS.map(() => true);
        this.morph = [0, 0];
        const build = (pieces, posed = true) => {
            const uv = [],
                local = [],
                parts = [];
            for (const { slot, rect, part } of pieces) {
                const [x, y, w, h] = slot;
                const atlas = region.atlas;
                uv.push(
                    (region.x + x) / atlas.width,
                    (region.y + y) / atlas.height,
                    w / atlas.width,
                    h / atlas.height,
                );
                local.push(...rect);
                parts.push(part);
            }
            return {
                uvRects: Float32Array.from(uv),
                localRects: Float32Array.from(local),
                ...(posed ? { parts: Float32Array.from(parts) } : {}),
            };
        };
        this.body = [build([...FEET, LEFT, RIGHT, BODY]), build([...FEET, LEFT, BODY])];
        this.faces = Object.fromEntries(
            Object.entries(FACES).map(([name, part]) => [
                name,
                [build([part]), build([part, RIGHT])],
            ]),
        );
        this.ammo = build([{ ...BODY, rect: [-0.5, -0.45, 1, 0.9] }], false);
        context.onDispose(() => this.dispose());
    }

    createActor() {
        const owner = this,
            instance = this.mesh.createPoseInstance(this.source),
            basePoses = PARTS.map(() => ({
                x: 0,
                y: 0,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                opacity: 1,
            }));
        const actor = {
            currentClip: 'idle',
            startedAt: 0,
            elapsed: 0,
            pose: null,
            frontHand: false,
            disposed: false,
            play(name) {
                this.currentClip = name in RIG.clips ? name : 'idle';
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
                const spin = this.currentClip === 'spin',
                    windup = spin ? Math.min(1, this.elapsed / 1000) : 0,
                    recovery = spin ? Math.max(0, 1 - (this.elapsed - 3000) / 1000) : 0,
                    reach = Math.min(windup, recovery),
                    angle =
                        spin && this.elapsed < 3000
                            ? Math.max(0, (this.elapsed - 1000) / 2000) * Math.PI
                            : 0;
                // The identical fists exchange sides at the end of the half-turn.
                // Recover from the nearest rest positions on the new sides.
                for (const index of [3, 4]) {
                    const pose = basePoses[index],
                        side = index === 3 ? -1 : 1;
                    pose.x = side * (118 * (1 - reach) + 144 * Math.cos(angle) * reach);
                    pose.y = 48 * (1 - reach) + (4 + side * 76 * Math.sin(angle)) * reach;
                    pose.rotation = side * 0.19 * Math.cos(angle) + Math.sin(angle) * reach;
                    pose.scaleX = 1 + 0.22 * reach;
                    pose.scaleY = pose.scaleX;
                }
                this.frontHand = spin && this.elapsed > 1000 && this.elapsed < 3000;
                this.pose = owner.mesh.preparePose(instance, {
                    clipName: this.currentClip,
                    elapsedMs: this.elapsed,
                    basePoses,
                    visible: owner.visible,
                    morph: owner.morph,
                });
                if (!this.pose) throw new Error('수박에 GPU 포즈를 사용할 수 없습니다.');
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
        this.draw(this.body[Number(actor.frontHand)], matrix, depth, actor, 0.05);
    }

    drawFace(actor, matrix, depth, face) {
        this.draw(
            (this.faces[face] || this.faces.neutral)[Number(actor.frontHand)],
            matrix,
            depth,
            actor,
        );
    }

    drawAmmo(matrix, depth) {
        this.draw(this.ammo, matrix, depth);
    }

    dispose() {
        if (this.disposed) return false;
        this.disposed = true;
        for (const actor of this.actors) actor.dispose();
        this.mesh.deletePoseSource(this.source);
        this.context.device.textureAtlas.release(this.region);
        return true;
    }
}
