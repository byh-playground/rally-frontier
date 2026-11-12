// The chili (assets/sprites/chili/parts.svg, approved final v5 body and flame F1, docs/handoff/chili-art/v5). Art
// units are rice's (standing height 343.5 = artScale 1); the origin is the ground between its two short feet. It lies
// low on its side facing +x with its mouth on the flank; the whole figure mirrors to face left. The body never tilts
// toward the aim (it lies too low): only the mouth flame (muzzle) turns up or down, at most 35°, and the F1 flame
// (drawFlame) leaves the muzzle's tip along the simulation's aim itself.
// The fists are separate parts with their own pose values (HANDS) so their placement can be swapped on its own.
import { drawUnitQuads } from '../../render/dead-unit-look.js';

const ROOT = new URL('../../../assets/sprites/chili/', import.meta.url);
const SHEET_WIDTH = 760;
const SHEET_HEIGHT = 613;
// A battle shows the body about 26 px tall from about 300 art units and the atlas has no mipmaps: half size keeps
// the outline and the face clean without the full sheet's memory. The card portrait reads the full-size raster.
const SHEET_SCALE = 0.5;
const portraitSheets = new WeakMap();
const DEGREE = Math.PI / 180;

const CELL = Object.freeze({
    body: { slot: [12, 12, 525, 225], pivot: [298, 273] },
    cap: { slot: [12, 249, 260, 260], pivot: [170, 130] },
    muzzle: { slot: [284, 249, 150, 92], pivot: [18, 46] },
    foot: { slot: [446, 249, 60, 64], pivot: [30, 32] },
    hand: { slot: [518, 249, 56, 62], pivot: [25, 6] },
    neutral: { slot: [574, 249, 140, 80], pivot: [70, 34] },
    attack: { slot: [12, 521, 140, 80], pivot: [70, 34] },
    hurt: { slot: [164, 521, 140, 80], pivot: [70, 34] },
    fire: { slot: [316, 521, 140, 80], pivot: [70, 34] },
});
// Where each part goes, in ground coordinates (the sheet's header): the body lowered 44 onto its feet, its stalk
// cap, the face and the mouth (the muzzle points +x at rest).
const BODY = [0, 44];
const CAP = [-186, -116];
const FACE = [12, -107];
const MOUTH = [22, -83];
// The body group lifts and tilts (a hit) about this point; the feet stay on the ground outside it.
const BODY_CENTER = [0, -86];
// The F1 flame starts this far from the mouth along the muzzle.
const FLAME_START = 118;
// The approved aim: the muzzle turns toward the aim on screen by at most this much.
const MAX_MUZZLE = 35;
// The muzzle eases to its aim and the figure into and out of the breathing pose over these (ms).
const MUZZLE_MS = 90;
const BREATH_POSE_MS = 110;

const REST_FEET = [
    [-66, -14],
    [70, -14],
];
// The fists: [x, y, degrees] on the body for each pose (degrees as drawn, after the back fist's mirror). Only this
// table and REST_HANDS place them, so a new fist placement replaces just these.
const REST_HANDS = [
    [-136, -48],
    [126, -56],
];
const HANDS = Object.freeze({
    rest: [
        [-136, -48, 82],
        [126, -56, -76],
    ],
    // Walking swings them opposite to the lifted foot (step A lifts the front foot, step B the back one).
    walkA: [
        [-136, -48, 98],
        [126, -56, -60],
    ],
    walkB: [
        [-136, -48, 66],
        [126, -56, -92],
    ],
    fire: [
        [-136, -54, 96],
        [126, -62, -90],
    ],
    hurt: [
        [-148, -56, 132],
        [138, -64, -126],
    ],
});

// Rig parts. The back foot and the back fist are the front ones mirrored.
const PART = Object.freeze({
    leftFoot: 0,
    rightFoot: 1,
    body: 2,
    cap: 3,
    face: 4,
    muzzle: 5,
    leftHand: 6,
    rightHand: 7,
});
const RIG = {
    parts: [
        { id: 'leftFoot', parent: null, pivot: REST_FEET[0] },
        { id: 'rightFoot', parent: null, pivot: REST_FEET[1] },
        { id: 'body', parent: null, pivot: BODY_CENTER },
        { id: 'cap', parent: 'body', pivot: CAP },
        { id: 'face', parent: 'body', pivot: FACE },
        { id: 'muzzle', parent: 'body', pivot: MOUTH },
        { id: 'leftHand', parent: 'body', pivot: REST_HANDS[0] },
        { id: 'rightHand', parent: 'body', pivot: REST_HANDS[1] },
    ],
    // Every motion is procedural (preparePose); the clips only name the state and its clock.
    clips: Object.fromEntries(
        [
            ['idle', 1200, 'repeat'],
            ['walk', 600, 'repeat'],
            ['fire', 250, 'once'],
            ['hit', 295, 'once'],
        ].map(([name, durationMs, loop]) => [
            name,
            {
                durationMs,
                loop,
                keyframes: [
                    { timeMs: 0, parts: {}, easing: 'linear' },
                    { timeMs: durationMs, parts: {}, easing: 'linear' },
                ],
            },
        ]),
    ),
};

// Whole-figure poses from the sheet's header: feet and fists [x, y, degrees], the body group's tilt (degrees,
// + = front down) and lift (art units up), and its recoil along -x while breathing.
const pose = (feet, hands, tilt = 0, lift = 0) => ({ feet, hands, tilt, lift, recoil: 0 });
const POSE = Object.freeze({
    stand: pose(
        [
            [-66, -14, 0],
            [70, -14, 0],
        ],
        HANDS.rest,
    ),
    walkA: pose(
        [
            [-70, -14, 6],
            [76, -28, -14],
        ],
        HANDS.walkA,
        0,
        6,
    ),
    walkB: pose(
        [
            [-60, -28, -14],
            [66, -14, 6],
        ],
        HANDS.walkB,
        0,
        6,
    ),
    // Feet braced apart, fists out, the muzzle showing.
    fire: pose(
        [
            [-74, -14, -8],
            [78, -14, 8],
        ],
        HANDS.fire,
    ),
    hurt: pose(
        [
            [-66, -20, 16],
            [70, -32, -24],
        ],
        HANDS.hurt,
        7,
        10,
    ),
});
// While breathing the body is pushed back a little by the flame and shakes with it (art units, ms).
const RECOIL = 5;
const SHAKE = 2;
const SHAKE_MS = 70;
const MUZZLE_FLICKER_MS = 90;

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const smooth = (value) => {
    const t = clamp01(value);
    return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

// out = a..b at t, for the pose records above (out is a pose the caller owns).
function mixPose(out, a, b, t) {
    for (let side = 0; side < 2; side++)
        for (let axis = 0; axis < 3; axis++) {
            out.feet[side][axis] = lerp(a.feet[side][axis], b.feet[side][axis], t);
            out.hands[side][axis] = lerp(a.hands[side][axis], b.hands[side][axis], t);
        }
    out.tilt = lerp(a.tilt, b.tilt, t);
    out.lift = lerp(a.lift, b.lift, t);
    out.recoil = lerp(a.recoil, b.recoil, t);
    return out;
}
const emptyPose = () =>
    pose(
        [
            [0, 0, 0],
            [0, 0, 0],
        ],
        [
            [0, 0, 0],
            [0, 0, 0],
        ],
    );

async function readAsset(name) {
    const response = await fetch(new URL(name, ROOT), { cache: 'no-cache' });
    if (!response.ok) throw new Error('고추 스프라이트를 불러오지 못했습니다: ' + name);
    return response;
}

export async function loadChiliSpriteCanvas() {
    const [manifest, bytes] = await Promise.all([
        readAsset('manifest.json').then((response) => response.json()),
        readAsset('parts.svg').then((response) => response.arrayBuffer()),
    ]);
    const spec = manifest?.assets?.['parts.svg'];
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
        value.toString(16).padStart(2, '0'),
    ).join('');
    if (manifest?.schemaVersion !== 1 || spec?.bytes !== bytes.byteLength || spec.sha256 !== hash)
        throw new Error('고추 SVG 무결성 오류');
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        if (image.naturalWidth !== SHEET_WIDTH || image.naturalHeight !== SHEET_HEIGHT)
            throw new Error('고추 스프라이트 시트 크기가 다릅니다.');
        const raster = (scale) => {
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(SHEET_WIDTH * scale);
            canvas.height = Math.round(SHEET_HEIGHT * scale);
            canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
            return canvas;
        };
        const canvas = raster(SHEET_SCALE);
        portraitSheets.set(canvas, raster(1));
        return canvas;
    } finally {
        URL.revokeObjectURL(url);
    }
}

// The card portrait: the standing pose, square like the other cards' portraits, the long body across the frame.
export function chiliSpritePortrait(atlasSheet, width) {
    const source = portraitSheets.get(atlasSheet),
        canvas = document.createElement('canvas');
    canvas.width = canvas.height = width;
    const ctx = canvas.getContext('2d'),
        scale = width / 560;
    ctx.setTransform(scale, 0, 0, scale, width / 2 + 70 * scale, width / 2 + 120 * scale);
    const draw = (cell, [x, y], degrees = 0, mirror = false) => {
        const [px, py] = cell.pivot;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(degrees * DEGREE);
        if (mirror) ctx.scale(-1, 1);
        const [sx, sy, w, h] = cell.slot;
        ctx.drawImage(source, sx, sy, w, h, -px, -py, w, h);
        ctx.restore();
    };
    const { feet, hands } = POSE.stand;
    draw(CELL.foot, feet[0], feet[0][2], true);
    draw(CELL.foot, feet[1], feet[1][2]);
    draw(CELL.body, BODY);
    draw(CELL.cap, CAP);
    draw(CELL.neutral, FACE);
    draw(CELL.hand, hands[0], hands[0][2], true);
    draw(CELL.hand, hands[1], hands[1][2]);
    return canvas.toDataURL('image/png');
}

export class ChiliSpriteRenderer {
    constructor(context, canvas, gamekit) {
        this.context = context;
        this.mesh = context.acquireMeshRenderer();
        this.actors = new Set();
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

        // pieces: [cell, art position of its pivot, rig part]. Unposed quads (the shell) are placed around
        // `origin` in units of `unit` art units.
        const build = (pieces, { origin = null, unit = 1 } = {}) => {
            const uvRects = [],
                localRects = [],
                parts = [];
            for (const [cell, [x, y], part] of pieces) {
                const [sx, sy, w, h] = cell.slot;
                const [px, py] = cell.pivot;
                uvRects.push(
                    (region.x + sx * SHEET_SCALE) / region.atlas.width,
                    (region.y + sy * SHEET_SCALE) / region.atlas.height,
                    (w * SHEET_SCALE) / region.atlas.width,
                    (h * SHEET_SCALE) / region.atlas.height,
                );
                const [ox, oy] = origin || [0, 0];
                localRects.push((x - px - ox) / unit, (y - py - oy) / unit, w / unit, h / unit);
                parts.push(part);
            }
            return {
                uvRects: Float32Array.from(uvRects),
                localRects: Float32Array.from(localRects),
                ...(origin ? {} : { parts: Float32Array.from(parts) }),
            };
        };
        // Depth-written: the feet, the body and its stalk cap.
        this.body = build([
            [CELL.foot, REST_FEET[0], PART.leftFoot],
            [CELL.foot, REST_FEET[1], PART.rightFoot],
            [CELL.body, BODY, PART.body],
            [CELL.cap, CAP, PART.cap],
        ]);
        // In painter order over the body: the face, the muzzle (shown while breathing) and the fists.
        this.front = Object.fromEntries(
            ['neutral', 'attack', 'hurt', 'fire'].map((face) => [
                face,
                build([
                    [CELL[face], FACE, PART.face],
                    [CELL.muzzle, MOUTH, PART.muzzle],
                    [CELL.hand, REST_HANDS[0], PART.leftHand],
                    [CELL.hand, REST_HANDS[1], PART.rightHand],
                ]),
            ]),
        );
        // The launch shell: the chili without feet and fists, nose first, about one unit long.
        this.ammo = build(
            [
                [CELL.body, BODY],
                [CELL.cap, CAP],
                [CELL.neutral, FACE],
            ],
            { origin: [-70, -116], unit: 520 },
        );
        context.onDispose(() => this.dispose());
    }

    createActor() {
        const owner = this,
            instance = this.mesh.createPoseInstance(this.source),
            basePoses = RIG.parts.map(() => ({
                x: 0,
                y: 0,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                opacity: 1,
            })),
            visible = RIG.parts.map(() => true),
            now = emptyPose(),
            ground = emptyPose();
        const actor = {
            currentClip: 'idle',
            startedAt: 0,
            elapsed: 0,
            disposed: false,
            pose: null,
            // Aim presentation (setAim): which way it faces (+1 right, -1 left), the muzzle's angle now (degrees,
            // + = down), how far into the breathing pose it is (0..1), whether it is alive, the render clock (ms).
            facing: 1,
            muzzle: 0,
            breathing: 0,
            cooling: false,
            alive: true,
            clock: null,
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
            // From main.js each frame: the aim on screen (dx, dy in pixels, y down), whether it breathes now, whether
            // it is alive, the render clock (ms) and whether it is cooling down between breaths (SustainedAttack). It faces
            // the aim's side (an aim straight up or down keeps the side it had) and turns its muzzle toward the aim
            // within ±35°.
            setAim(dx, dy, breathing, alive, clockMs, cooling = false) {
                const length = Math.hypot(dx, dy);
                if (length > 0 && Math.abs(dx) > 0.1 * length) this.facing = dx < 0 ? -1 : 1;
                const want =
                    length > 0
                        ? Math.max(
                              -MAX_MUZZLE,
                              Math.min(MAX_MUZZLE, Math.atan2(dy, Math.abs(dx)) / DEGREE),
                          )
                        : 0;
                const step = this.clock === null ? Infinity : Math.max(0, clockMs - this.clock);
                this.muzzle =
                    step === Infinity
                        ? want
                        : lerp(this.muzzle, want, 1 - Math.exp(-step / MUZZLE_MS));
                const target = breathing ? 1 : 0;
                this.breathing =
                    step === Infinity
                        ? target
                        : target > this.breathing
                          ? Math.min(target, this.breathing + step / BREATH_POSE_MS)
                          : Math.max(target, this.breathing - step / BREATH_POSE_MS);
                this.alive = alive;
                this.cooling = cooling;
                this.clock = clockMs;
                return this;
            },
            faceFor(face) {
                if (face === 'hurt' || !this.alive) return 'hurt';
                // Cooling down between breaths: the mouth stays shut (not the attack face) while smoke rises from it.
                return this.breathing > 0.5
                    ? 'fire'
                    : this.cooling && face === 'attack'
                      ? 'neutral'
                      : face;
            },
            groundPose() {
                const e = this.elapsed;
                if (this.currentClip === 'hit')
                    return mixPose(
                        ground,
                        POSE.stand,
                        POSE.hurt,
                        1 - smooth(e / RIG.clips.hit.durationMs),
                    );
                if (this.currentClip === 'walk') {
                    // Steps A and B alternate each half cycle; both feet are down in between.
                    const gait = Math.sin((e / RIG.clips.walk.durationMs) * Math.PI * 2);
                    return mixPose(
                        ground,
                        POSE.stand,
                        gait > 0 ? POSE.walkA : POSE.walkB,
                        Math.abs(gait),
                    );
                }
                mixPose(ground, POSE.stand, POSE.stand, 0);
                ground.lift = 1.5 * Math.sin((e / RIG.clips.idle.durationMs) * Math.PI * 2);
                return ground;
            },
            // The whole figure's pose this frame, into `now`.
            figurePose() {
                if (!this.alive) return mixPose(now, POSE.hurt, POSE.hurt, 0);
                const b = smooth(this.breathing);
                mixPose(now, this.groundPose(), POSE.fire, b);
                const clock = this.clock ?? 0;
                now.recoil = b * (RECOIL + SHAKE * Math.sin((clock / SHAKE_MS) * Math.PI * 2));
                return now;
            },
            preparePose() {
                const figure = this.figurePose();
                for (let side = 0; side < 2; side++) {
                    const foot = basePoses[PART.leftFoot + side],
                        hand = basePoses[PART.leftHand + side],
                        [fx, fy, fr] = figure.feet[side],
                        [hx, hy, hr] = figure.hands[side];
                    foot.x = fx - REST_FEET[side][0];
                    foot.y = fy - REST_FEET[side][1];
                    foot.rotation = fr * DEGREE;
                    foot.scaleX = side ? 1 : -1;
                    hand.x = hx - REST_HANDS[side][0];
                    hand.y = hy - REST_HANDS[side][1];
                    hand.rotation = hr * DEGREE;
                    hand.scaleX = side ? 1 : -1;
                }
                const body = basePoses[PART.body];
                body.rotation = figure.tilt * DEGREE;
                body.x = -figure.recoil;
                body.y = -figure.lift;
                const muzzle = basePoses[PART.muzzle],
                    open = this.alive ? smooth(this.breathing) : 0;
                visible[PART.muzzle] = open > 0.02;
                muzzle.rotation = this.muzzle * DEGREE;
                muzzle.scaleX =
                    open *
                    (1 + 0.08 * Math.sin(((this.clock ?? 0) / MUZZLE_FLICKER_MS) * Math.PI * 2));
                muzzle.scaleY = open;
                this.pose = owner.mesh.preparePose(instance, {
                    clipName: this.currentClip,
                    elapsedMs: this.elapsed,
                    basePoses,
                    visible,
                    morph: [0, 0],
                });
                if (!this.pose) throw new Error('고추 GPU 포즈를 준비하지 못했습니다.');
                return this.pose;
            },
            // Where the flame leaves the muzzle this frame, in art units facing right (main.js mirrors it with the
            // figure): the muzzle's tip on the body group, drawn back into the mouth as the muzzle closes (the
            // cooling smoke rises from there).
            mouthTip(out) {
                const body = basePoses[PART.body],
                    cos = Math.cos(body.rotation),
                    sin = Math.sin(body.rotation),
                    turn = this.muzzle * DEGREE,
                    tip = FLAME_START * (this.alive ? smooth(this.breathing) : 0),
                    rx = MOUTH[0] + tip * Math.cos(turn) - BODY_CENTER[0],
                    ry = MOUTH[1] + tip * Math.sin(turn) - BODY_CENTER[1];
                out.x = BODY_CENTER[0] + body.x + rx * cos - ry * sin;
                out.y = BODY_CENTER[1] + body.y + rx * sin + ry * cos;
                return out;
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
        drawUnitQuads(this.context, this.paint, {
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
        this.draw(this.front[actor.faceFor(face)] || this.front.neutral, matrix, depth, actor);
    }

    drawAmmo(matrix, depth) {
        this.draw(this.ammo, matrix, depth);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const actor of [...this.actors]) actor.dispose();
        this.mesh.deletePoseSource(this.source);
        this.context.device.textureAtlas.release(this.region);
    }
}

// The F1 flame ("불덩이 줄", docs/handoff/chili-art/v5 index.html flame): a row of round fireballs that grow along
// the flame (red, orange, yellow core) ending in two puffs of smoke, flowing out of the muzzle while it breathes.
// Presentation only, on the render clock.
const FLAME_BALLS = 11;
const FLAME_SMOKE = 2;
// One fireball moves to the next one's place in this long (the flow), so the flame runs out at about 300 a second.
const FLAME_FLOW_MS = 50;
// The flame drops from the muzzle's height to the ground over this distance (world units).
const FLAME_DROP = 110;
// It grows out of the muzzle when breathing starts, and when it stops the last fireballs run out and fade.
const FLAME_GROW_MS = 120;
const FLAME_FADE_MS = 220;
const SMOKE = '#7d6a5e';
const FIRE = ['#e2361a', '#ff901f', '#ffe36b'];

// Paints one flame on main.js's 2D effect canvas. f: mouthX/mouthY (the muzzle's tip on screen), groundX/groundY
// (the unit's ground point), forwardX/forwardY and sideX/sideY (screen pixels per world unit along the aim and across
// it), pixelsPerUnit, length and halfArc (the breath's reach), ageMs since it started breathing, stopMs since it
// stopped (null while it breathes, Infinity when never seen breathing), clockMs, seed (a stable number per unit for the
// fireballs' wobble) and cooling (between breaths: a thin wisp of smoke rises from the shut mouth instead).
function drawFlame(ctx, f) {
    if (f.cooling) drawCoolingSmoke(ctx, f);
    const span = (f.length - 18) / (FLAME_BALLS - 1),
        flow = f.clockMs / FLAME_FLOW_MS,
        shift = flow - Math.floor(flow),
        cycle = Math.floor(flow),
        tan = Math.tan(f.halfArc),
        mouthHeight = f.groundY - f.mouthY,
        offset = f.mouthX - f.groundX,
        reach = clamp01(f.ageMs / FLAME_GROW_MS),
        gone = f.stopMs === null ? 0 : f.stopMs / FLAME_FADE_MS;
    if (gone >= 1) return;
    // Far fireballs first, so the nearer (smaller) ones lie over them as in the approved row.
    for (let k = FLAME_BALLS - 2; k >= 0; k--) {
        const slot = k + shift,
            d = 12 + slot * span,
            along = d / f.length;
        // Growing in: nothing past the reach yet. Running out: nothing behind the last ball that left the muzzle.
        if (along > reach || along < gone) continue;
        const wobble = Math.sin((cycle - k) * 12.9898 + f.seed) * 0.5,
            rad = Math.max(4, d * tan * 0.72) + 3,
            l = wobble * rad * 0.35,
            h = mouthHeight * Math.max(0, 1 - d / FLAME_DROP),
            // The flame leaves the muzzle and its tip ends at the breath's reach from the unit's centre.
            x = f.groundX + offset * (1 - along) + f.forwardX * d + f.sideX * l,
            y = f.groundY + f.forwardY * d + f.sideY * l - h,
            rx = rad * f.pixelsPerUnit,
            ry = rx * 0.66,
            // The first ball grows out of the muzzle, the last fades at the tip.
            alpha = (k === 0 ? shift : 1) * (k === FLAME_BALLS - 2 ? 1 - shift : 1),
            smoke = clamp01(slot - (FLAME_BALLS - FLAME_SMOKE - 1.5));
        if (smoke > 0) {
            ctx.globalAlpha = alpha * smoke * lerp(0.4, 0.28, clamp01(slot - (FLAME_BALLS - 2)));
            ctx.fillStyle = SMOKE;
            ctx.beginPath();
            ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
            ctx.fill();
        }
        if (smoke >= 1) continue;
        const fire = alpha * (1 - smoke);
        ctx.globalAlpha = fire * 0.86;
        ctx.fillStyle = FIRE[0];
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = fire * 0.92;
        ctx.fillStyle = FIRE[1];
        ctx.beginPath();
        ctx.ellipse(x - rx * 0.08, y - ry * 0.12, rx * 0.72, ry * 0.7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = fire;
        ctx.fillStyle = FIRE[2];
        ctx.beginPath();
        ctx.ellipse(x - rx * 0.14, y - ry * 0.22, rx * 0.4, ry * 0.38, 0, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

// Cooling down: three small puffs rise from the mouth one after another and fade, coming in as the flame runs out.
const COOL_PUFFS = 3;
const COOL_PUFF_MS = 900;
const COOL_RISE = 22;
const COOL_SMOKE = '#a39a94';
function drawCoolingSmoke(ctx, f) {
    const since = f.stopMs === null ? 0 : Math.min(f.stopMs, 1e6),
        fadeIn = clamp01((since - FLAME_FADE_MS * 0.5) / FLAME_FADE_MS);
    if (fadeIn <= 0) return;
    ctx.fillStyle = COOL_SMOKE;
    for (let k = 0; k < COOL_PUFFS; k++) {
        const phase = (f.clockMs / COOL_PUFF_MS + k / COOL_PUFFS + f.seed * 0.013) % 1,
            sway = Math.sin(phase * Math.PI * 2 + k * 2.1) * 2.5,
            r = (2.5 + 4 * phase) * f.pixelsPerUnit;
        ctx.globalAlpha = fadeIn * 0.75 * (1 - phase) * clamp01(phase * 6);
        ctx.beginPath();
        ctx.ellipse(
            f.mouthX + f.forwardX * 2 + sway * f.pixelsPerUnit,
            f.mouthY - phase * COOL_RISE * f.pixelsPerUnit,
            r,
            r * 0.8,
            0,
            0,
            Math.PI * 2,
        );
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

// This unit's sprite contract (src/units/define-unit.js), loaded only by the page, never the Worker.
export const SPRITE = Object.freeze({
    load: loadChiliSpriteCanvas,
    renderer: ChiliSpriteRenderer,
    portrait: chiliSpritePortrait,
    // Nose first along the flight.
    shell: { draw: 'drawAmmo', depthTest: true },
    groundY: 0,
    breath: { drawFlame },
});
