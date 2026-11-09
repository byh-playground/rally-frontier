import { WATERMELON_RIND_RADIUS_X } from '../definitions/units.js';
import { createHeroBasicAttackClip } from './hero-basic-motion.js';

const PARTS = [
    { id: 'body', parent: null, pivot: [0, 0] },
    { id: 'leftFoot', parent: 'body', pivot: [-46, 93] },
    { id: 'rightFoot', parent: 'body', pivot: [46, 93] },
    { id: 'leftHand', parent: 'body', pivot: [0, 0] },
    { id: 'rightHand', parent: 'body', pivot: [0, 0] },
];

const BODY = { slot: [2, 2, 240, 214], rect: [-120, -116, 240, 214], part: 0 };
// Rind bounds around the roll pivot in source pixels.
const ROLL_CENTER_Y = -9;
const ROLL_RADIUS_Y = 108;
const STANDING_GROUND_Y = 121;
const FOOT = { slot: [320, 2, 46, 58], rect: [-23, -29, 46, 58] };
const HAND = { slot: [246, 2, 70, 70], rect: [-35, -35, 70, 70] };
const HAND_REST_X = 110;
const HAND_REST_Y = 48;
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
const walkPose = (swing) => {
    const body = { x: swing * 12, y: swing ? -14 : 5, rotation: swing * 0.12 };
    const sin = Math.sin(body.rotation),
        cos = Math.cos(body.rotation);
    const foot = (side, [px, py]) => {
        const lifted = side === swing;
        const x = px - body.x + (lifted ? side * 8 : 0),
            y = py - body.y - (lifted ? 23 : 0);
        // Feet are children of the body. Keep the planted foot at ground height while the rind rocks.
        return {
            x: x * cos + y * sin - px,
            y: y * cos - x * sin - py,
            rotation: (lifted ? side * 0.28 : 0) - body.rotation,
        };
    };
    return {
        body,
        leftFoot: foot(-1, PARTS[1].pivot),
        rightFoot: foot(1, PARTS[2].pivot),
        leftHand: { y: -swing * 8 },
        rightHand: { y: swing * 8 },
    };
};
const PLANTED_WALK_POSE = walkPose(0);
const RIG = {
    parts: PARTS,
    clips: {
        idle: clip(1200, 'repeat', [
            key(0),
            key(600, { body: { y: -3, scaleX: 0.99, scaleY: 1.025 } }),
            key(1200),
        ]),
        walk: clip(680, 'repeat', [
            key(0, PLANTED_WALK_POSE),
            key(170, walkPose(-1)),
            key(340, PLANTED_WALK_POSE),
            key(510, walkPose(1)),
            key(680, PLANTED_WALK_POSE),
        ]),
        fire: createHeroBasicAttackClip({
            windup: {
                body: { x: -8, y: -3, rotation: -0.07, scaleX: 0.96, scaleY: 1.05 },
                leftHand: { x: 8, y: 6 },
                rightHand: { x: -24, y: -27, rotation: -0.48 },
            },
            strike: {
                body: { x: 12, y: 6, rotation: 0.08, scaleX: 1.08, scaleY: 0.94 },
                leftHand: { x: 12, y: 9 },
                rightHand: { x: 37, y: -12, rotation: 0.32, scaleX: 1.12, scaleY: 1.12 },
            },
            followThrough: {
                body: { x: 6, y: 4, rotation: 0.035, scaleX: 1.03, scaleY: 0.97 },
                rightHand: { x: 16, y: 8, rotation: 0.18 },
            },
        }),
        hit: clip(260, 'once', [
            key(0, { body: { scaleX: 1.08, scaleY: 0.9, rotation: -0.09 } }),
            key(260),
        ]),
        roll: clip(1, 'once', [key(0), key(1)]),
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
    const [handX, handY, handWidth, handHeight] = HAND.rect;
    for (const x of [-HAND_REST_X, HAND_REST_X])
        ctx.drawImage(source, ...HAND.slot, x + handX, HAND_REST_Y + handY, handWidth, handHeight);
    ctx.drawImage(source, ...BODY.slot, ...BODY.rect);
    ctx.drawImage(source, ...FACES.neutral.slot, ...FACES.neutral.rect);
    return canvas.toDataURL('image/png');
}

export function watermelonRollProgress(roll, renderTick) {
    if (roll.phase === 'roll') return 0;
    const duration = Math.max(1, roll.phaseEndTick - roll.phaseStartTick);
    return Math.min(1, Math.max(0, (renderTick - roll.phaseStartTick) / duration));
}

export function watermelonRollTuck(phase, progress) {
    if (phase === 'roll') return 1;
    const p = phase === 'hop' ? Math.min(1, Math.max(0, (progress - 0.18) / 0.5)) : 1 - progress;
    return p * p * (3 - 2 * p);
}

export function setWatermelonRollMatrix(
    matrix,
    x,
    groundY,
    scale,
    heading,
    turns,
    tuck = 1,
    unfoldProgress = 0,
) {
    let angle = heading * turns * 2 * Math.PI;
    if (unfoldProgress > 0) {
        // Resolve the nearest upright angle so the body does not unwind through past turns.
        angle = Math.atan2(Math.sin(angle), Math.cos(angle)) * (1 - unfoldProgress);
    }
    const cos = Math.cos(angle),
        sin = Math.sin(angle);
    matrix[0] = cos * scale;
    matrix[1] = sin * scale;
    matrix[2] = -sin * scale;
    matrix[3] = cos * scale;
    matrix[4] = x - matrix[2] * ROLL_CENTER_Y;
    // The short side and long side of the rind both rest on the same ground line.
    const rind = Math.hypot(WATERMELON_RIND_RADIUS_X * sin, ROLL_RADIUS_Y * cos);
    const standing = STANDING_GROUND_Y - ROLL_CENTER_Y;
    const support = (standing + (rind - standing) * tuck) * scale;
    matrix[5] = groundY - support - matrix[3] * ROLL_CENTER_Y;
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
        this.rollBody = build([BODY]);
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
            rollTuck: 0,
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
                    tuck = this.currentClip === 'roll' ? this.rollTuck : 0,
                    windup = spin ? Math.min(1, this.elapsed / 1000) : 0,
                    recovery = spin ? Math.max(0, 1 - (this.elapsed - 3000) / 1000) : 0,
                    reach = Math.min(windup, recovery),
                    angle =
                        spin && this.elapsed < 3000
                            ? Math.max(0, (this.elapsed - 1000) / 2000) * Math.PI
                            : 0;
                // The identical hands exchange sides at the end of the half-turn.
                // Recover from the nearest rest positions on the new sides.
                for (const index of [1, 2]) {
                    const foot = basePoses[index];
                    foot.y = -45 * tuck;
                    foot.scaleX = foot.scaleY = 1 - 0.45 * tuck;
                }
                for (const index of [3, 4]) {
                    const pose = basePoses[index],
                        side = index === 3 ? -1 : 1;
                    pose.x =
                        side *
                        ((HAND_REST_X - 51 * tuck) * (1 - reach) + 144 * Math.cos(angle) * reach);
                    pose.y =
                        (HAND_REST_Y - 24 * tuck) * (1 - reach) +
                        (4 + side * 76 * Math.sin(angle)) * reach;
                    pose.rotation = side * 0.19 * Math.cos(angle) + Math.sin(angle) * reach;
                    pose.scaleX = 1 + 0.22 * reach - 0.45 * tuck;
                    pose.scaleY = pose.scaleX;
                }
                this.frontHand =
                    this.currentClip === 'fire' ||
                    (spin && this.elapsed > 1000 && this.elapsed < 3000);
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
        const body =
            actor.currentClip === 'roll' && actor.rollTuck >= 1
                ? this.rollBody
                : this.body[Number(actor.frontHand)];
        this.draw(body, matrix, depth, actor, 0.05);
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
