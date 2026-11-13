// The chili (assets/sprites/chili/parts.svg, approved final v5 body, docs/handoff/chili-art/v5; flame F-C). Art
// units are rice's (standing height 343.5 = artScale 1); the origin is the ground between its two short feet. It lies
// low on its side facing +x with its mouth on the flank; the whole figure mirrors to face left. The body never tilts
// toward the aim (it lies too low): only the mouth flame (muzzle) turns up or down, at most 35°, and the flame
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
// The flame starts this far from the mouth along the muzzle.
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

// The F-C flame ("만화풍 덩어리 + 불씨 강조", the approved vfx review): blobs that really flow from the mouth to the
// breath's reach and grow on the way, painted in four passes (dark rim, heat colour, bright inside, white core in the
// near half) so they read as one cartoon silhouette, over a heat glow on the ground, with embers falling off its
// edges and tip. It bursts out when breathing starts (mouth flash, twice the blobs, faster), and when it stops the
// stream burns down from its tip, some cut blobs turning to smoke, with a spray of embers off the tip.
// Presentation only, and stateless: nothing is kept between frames. Every blob and ember is the k-th one emitted on a
// fixed per-second grid, its birth time, speed, angle and size hashed from (k, seed), so only the emissions still alive
// at clockMs are visited and the same clock always paints the same flame (pause, replay, debug scenes) without garbage.
// The judgment (length, arc, ticks) is the simulation's; this only draws inside it.
const TAU = Math.PI * 2;
// The flame drops from the muzzle's height to the ground over this distance (world units).
const FLAME_DROP = 110;
// Blob speed (world units a second, ±10%) and emission rate (a second). The review had 56 a second of radius 5..15;
// fewer, larger blobs keep its silhouette at about two thirds of the shapes (many chilis can breathe at once).
const FLAME_SPEED = 430;
const FLAME_RATE = 36;
const BLOB_R0 = 5.8;
const BLOB_R1 = 17.2;
// Rim width (world units), never thinner than a pixel so the cartoon outline survives zooming out.
const BLOB_RIM = 1.6;
// Breathing starts with a burst: twice the blobs, 1.25× faster, a flash at the mouth.
const BURST_S = 0.12;
const BURST_SPEED = 1.25;
// When it stops the stream burns down from its tip over this long; this share of the cut blobs turns to smoke.
const FADE_S = 0.25;
const CUT_SMOKE_SHARE = 0.3;
const CUT_SMOKE_LIFE_MAX = 1.1;
// The heat glow under the stream: comes in over GLOW_IN_S, goes over GLOW_OUT_S after it stops.
const GLOW_IN_S = 0.1;
const GLOW_OUT_S = 0.3;
// Embers off the edges (a second, the review's 42 with larger embers) and the spray off the tip when it stops.
const EMBER_RATE = 28;
const EMBER_SIZE = 2.2;
const EMBER_LIFE_MAX = 0.8;
const STOP_EMBERS = 6;
// Colours: the heat ramp (white-hot at the mouth to deep red at the tip) as a table built once, so nothing is
// formatted per frame.
const HEAT_STEPS = 14;
const HEAT = Object.freeze(
    (() => {
        const stops = [
            [0, [255, 252, 232]],
            [0.14, [255, 232, 110]],
            [0.42, [255, 152, 34]],
            [0.72, [232, 66, 26]],
            [1, [178, 34, 24]],
        ];
        const out = [];
        for (let s = 0; s < HEAT_STEPS; s++) {
            const u = s / (HEAT_STEPS - 1);
            let i = 1;
            while (i < stops.length - 1 && stops[i][0] < u) i++;
            const [u0, c0] = stops[i - 1],
                [u1, c1] = stops[i],
                k = (u - u0) / (u1 - u0);
            out.push(
                'rgb(' +
                    Math.round(lerp(c0[0], c1[0], k)) +
                    ',' +
                    Math.round(lerp(c0[1], c1[1], k)) +
                    ',' +
                    Math.round(lerp(c0[2], c1[2], k)) +
                    ')',
            );
        }
        return out;
    })(),
);
const heatIndex = (u) => Math.round(clamp01(u) * (HEAT_STEPS - 1));
const RIM = '#b3200f';
const CORE = '#fffbe6';
const MOUTH_FLASH = '#fff4c2';
const MOUTH_GLOW = '#fffbe8';
const EMBER_TRAIL = '#ff9d2a';
const EMBER_SPARK = '#fff1a8';
const CUT_SMOKE = '#8f8781';
// The glow's radial gradient (unit radius, placed by a transform), made once per canvas.
const glowGradients = new WeakMap();
function glowGradient(ctx) {
    let gradient = glowGradients.get(ctx);
    if (!gradient) {
        gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        gradient.addColorStop(0, 'rgba(255,170,60,0.35)');
        gradient.addColorStop(1, 'rgba(255,120,40,0)');
        glowGradients.set(ctx, gradient);
    }
    return gradient;
}

// A float in [0, 1) from an emission number and a channel (integer avalanche hash; no state).
function hash01(n, salt) {
    let h = Math.imul(n | 0, 0x27d4eb2d) ^ Math.imul((salt | 0) + 0x3c6ef372, 0x165667b1);
    h ^= h >>> 15;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}
// Hash channels per unit seed (salt = seed * 32 + channel): blob streams 0 (steady) and 1 (the burst) use 0..7 and
// 8..15, embers 16..22, the stop spray 24..29.
const CH_BORN = 0,
    CH_SPEED = 1,
    CH_SPREAD = 2, // 2, 3, 4: three draws averaged (crowds the blobs to the middle)
    CH_WOBBLE = 5,
    CH_SIZE = 6,
    CH_SMOKE = 7,
    CH_EMBER = 16,
    CH_SPRAY = 24;

// Scratch for one frame's blobs (screen x, y, radius in pixels, u along the flame, alpha) and their far-first order,
// allocated once.
const MAX_BLOBS = 128;
const blobX = new Float64Array(MAX_BLOBS);
const blobY = new Float64Array(MAX_BLOBS);
const blobR = new Float64Array(MAX_BLOBS);
const blobU = new Float64Array(MAX_BLOBS);
const blobA = new Float64Array(MAX_BLOBS);
const blobOrder = new Uint8Array(MAX_BLOBS);
// The flame being drawn (set by drawFlame) and the last projected point.
let flame = null,
    flameOffset = 0,
    flameHeight = 0,
    px = 0,
    py = 0;
// (d along the aim from the mouth, lat across it) in world units -> (px, py) on screen: it leaves the muzzle at its
// height, drops to the ground over FLAME_DROP and ends at the breath's reach from the unit's ground point.
function project(d, lat) {
    const f = flame,
        along = Math.min(1, d / f.length),
        h = flameHeight * Math.max(0, 1 - d / FLAME_DROP);
    px = f.groundX + flameOffset * (1 - along) + f.forwardX * d + f.sideX * lat;
    py = f.groundY + f.forwardY * d + f.sideY * lat - h;
}

// Same-style circles share one path (one fill) until the style or alpha changes.
let batchOpen = false,
    batchStyle = null,
    batchAlpha = -1;
function circle(ctx, style, alpha, x, y, r) {
    if (!batchOpen || style !== batchStyle || alpha !== batchAlpha) {
        if (batchOpen) ctx.fill();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = style;
        ctx.beginPath();
        batchOpen = true;
        batchStyle = style;
        batchAlpha = alpha;
    }
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, TAU);
}
function endCircles(ctx) {
    if (batchOpen) ctx.fill();
    batchOpen = false;
    batchStyle = null;
}

// One ember born `age` seconds ago at (x0, y0) on screen: it drifts along the aim at vx (world units a second, slowing
// as e^-t) and rises at vy (world units a second, screen up) under a pull back down, a short streak behind a spark.
function drawEmber(ctx, x0, y0, vx, vy, age, life, size) {
    const k = age / life,
        alpha = (1 - k) * clamp01(k * 10);
    if (alpha <= 0) return;
    const f = flame,
        ppu = f.pixelsPerUnit,
        drift = vx * (1 - Math.exp(-age)),
        x = x0 + f.forwardX * drift,
        y = y0 + f.forwardY * drift + (vy * age + 35 * age * age) * ppu,
        vxNow = vx * Math.exp(-age) * 0.035,
        vyNow = (vy + 70 * age) * ppu * 0.035,
        width = Math.max(1, size * ppu);
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - f.forwardX * vxNow, y - f.forwardY * vxNow - vyNow);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, width * 0.8, 0, TAU);
    ctx.fill();
}

// Paints one flame on main.js's 2D effect canvas. f: mouthX/mouthY (the muzzle's tip on screen), groundX/groundY
// (the unit's ground point), forwardX/forwardY and sideX/sideY (screen pixels per world unit along the aim and across
// it), pixelsPerUnit, length and halfArc (the breath's reach), ageMs since it started breathing (Infinity when first
// seen already breathing), stopMs since it stopped (null while it breathes, Infinity when never seen breathing),
// clockMs, seed (a stable number per unit for the hashes) and cooling (between breaths: a thin wisp of smoke rises from
// the shut mouth).
function drawFlame(ctx, f) {
    if (f.cooling) drawCoolingSmoke(ctx, f);
    const t = f.clockMs / 1000,
        start = t - f.ageMs / 1000,
        stop = f.stopMs === null ? Infinity : t - f.stopMs / 1000,
        on = f.stopMs === null,
        since = on ? 0 : t - stop;
    // Never seen breathing, or long burnt out (embers, cut smoke) after it stopped.
    if (!(stop >= start) || since > FADE_S + CUT_SMOKE_LIFE_MAX) return;
    const length = f.length,
        tan = Math.tan(f.halfArc),
        ppu = f.pixelsPerUnit,
        age = t - start,
        // The stream has reached this far (grows at the blob speed from the mouth, burns down from the tip).
        reach = on ? Math.min(length, age * FLAME_SPEED) : length * Math.max(0, 1 - since / FADE_S),
        lifeMax = length / (FLAME_SPEED * 0.9),
        salt = f.seed * 32;
    flame = f;
    flameOffset = f.mouthX - f.groundX;
    flameHeight = f.groundY - f.mouthY;
    ctx.save();

    // The heat glow on the ground under the stream: an ellipse along the aim filled with the cached gradient.
    const glow = on ? clamp01(age / GLOW_IN_S) : clamp01(1 - since / GLOW_OUT_S);
    if (glow > 0) {
        const glowReach = on ? reach : length * Math.max(0.2, 1 - since / FADE_S),
            d = glowReach * 0.5,
            rx = glowReach * 0.58 + 6,
            ry = glowReach * tan * 0.9 + 12;
        project(d, 0);
        ctx.save();
        ctx.transform(
            f.forwardX * rx,
            f.forwardY * rx,
            f.sideX * ry,
            f.sideY * ry,
            px,
            py + flameHeight * Math.max(0, 1 - d / FLAME_DROP) - 2 * ppu,
        );
        ctx.globalAlpha = glow;
        ctx.fillStyle = glowGradient(ctx);
        ctx.beginPath();
        ctx.arc(0, 0, 1, 0, TAU);
        ctx.fill();
        ctx.restore();
    }

    // The blobs alive now (and, once it stopped, the ones it cut, some of which are smoke now), oldest first. Two
    // emission streams on the same grid: the steady one and the burst's extra blobs.
    const end = Math.min(t, stop),
        kFrom = Math.floor(Math.max(start, end - lifeMax) * FLAME_RATE) - 1,
        kTo = Math.floor(end * FLAME_RATE);
    let blobs = 0;
    for (let k = kFrom; k <= kTo; k++)
        for (let stream = 0; stream < 2; stream++) {
            const s = salt + stream * 8,
                born = (k + hash01(k, s + CH_BORN)) / FLAME_RATE;
            if (born < start || born > end) continue;
            const burst = born - start < BURST_S;
            if (stream === 1 && !burst) continue;
            const speed =
                    FLAME_SPEED * (0.9 + 0.2 * hash01(k, s + CH_SPEED)) * (burst ? BURST_SPEED : 1),
                spread =
                    (hash01(k, s + CH_SPREAD) +
                        hash01(k, s + CH_SPREAD + 1) +
                        hash01(k, s + CH_SPREAD + 2)) /
                        3 -
                    0.5,
                slope = Math.tan(spread * 2 * f.halfArc * 0.95),
                wobble = hash01(k, s + CH_WOBBLE) * TAU,
                d = (t - born) * speed;
            if (d <= length && (on || d <= reach)) {
                if (blobs === MAX_BLOBS) continue;
                const u = d / length;
                project(d, d * slope + Math.sin(t * 18 + wobble) * u * 3);
                blobX[blobs] = px;
                blobY[blobs] = py;
                blobU[blobs] = u;
                blobR[blobs] =
                    lerp(BLOB_R0, BLOB_R1, Math.pow(u, 0.8)) *
                    (0.8 + 0.4 * hash01(k, s + CH_SIZE)) *
                    ppu;
                blobA[blobs] = clamp01(d / 10) * (u > 0.86 ? clamp01((1 - u) / 0.14) : 1);
                // Insert far-first (larger u first).
                let i = blobs++;
                while (i > 0 && blobU[blobOrder[i - 1]] < u) {
                    blobOrder[i] = blobOrder[i - 1];
                    i--;
                }
                blobOrder[i] = blobs - 1;
                continue;
            }
            // Cut by the burn-down after it stopped (not run out at the tip): when the falling reach met it.
            if (on || (stop - born) * speed > length || hash01(k, s + CH_SMOKE) >= CUT_SMOKE_SHARE)
                continue;
            const cutAt =
                    (length + (length * stop) / FADE_S + born * speed) / (speed + length / FADE_S),
                smokeAge = t - cutAt,
                smokeLife = 0.8 + 0.3 * hash01(k, s + CH_SIZE);
            if (smokeAge < 0 || smokeAge >= smokeLife) continue;
            const dc = (cutAt - born) * speed,
                p = smokeAge / smokeLife;
            project(dc, dc * slope + Math.sin(cutAt * 18 + wobble) * (dc / length) * 3);
            ctx.globalAlpha = 0.32 * (1 - p) * clamp01(p * 8);
            ctx.fillStyle = CUT_SMOKE;
            ctx.beginPath();
            ctx.arc(
                px + f.forwardX * 6 * smokeAge,
                py - 18 * smokeAge * ppu,
                (3 + 3 * hash01(k, s + CH_WOBBLE) + 8 * p) * ppu,
                0,
                TAU,
            );
            ctx.fill();
        }

    // The four passes over the blobs, far first: dark rim, heat colour, bright inside, white core in the near half.
    const rim = Math.max(1, BLOB_RIM * ppu);
    for (let n = 0; n < blobs; n++) {
        const i = blobOrder[n];
        circle(ctx, RIM, blobA[i] * 0.9, blobX[i], blobY[i], blobR[i] + rim);
    }
    for (let n = 0; n < blobs; n++) {
        const i = blobOrder[n];
        circle(ctx, HEAT[heatIndex(blobU[i] + 0.12)], blobA[i], blobX[i], blobY[i], blobR[i]);
    }
    for (let n = 0; n < blobs; n++) {
        const i = blobOrder[n],
            r = blobR[i];
        circle(
            ctx,
            HEAT[heatIndex(blobU[i] - 0.3)],
            blobA[i],
            blobX[i] - r * 0.1,
            blobY[i] - r * 0.18,
            r * 0.62,
        );
    }
    for (let n = 0; n < blobs; n++) {
        const i = blobOrder[n],
            u = blobU[i],
            r = blobR[i];
        if (u > 0.55) continue;
        // Its fade in quarter steps so neighbouring cores share a fill.
        const fade = Math.ceil((1 - u / 0.55) * 4) / 4;
        circle(ctx, CORE, blobA[i] * fade, blobX[i] - r * 0.15, blobY[i] - r * 0.25, r * 0.3);
    }
    endCircles(ctx);

    // The mouth while breathing: white-hot, with a flash as it bursts out.
    if (on) {
        const mx = f.mouthX + f.forwardX * 2,
            my = f.mouthY + f.forwardY * 2,
            flash = age < BURST_S ? 1 - age / BURST_S : 0;
        if (flash > 0) {
            ctx.globalAlpha = 0.85 * flash;
            ctx.fillStyle = MOUTH_FLASH;
            ctx.beginPath();
            ctx.arc(mx + f.forwardX * 3, my + f.forwardY * 3, (6 + 8 * flash) * ppu, 0, TAU);
            ctx.fill();
        }
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = MOUTH_GLOW;
        ctx.beginPath();
        ctx.ellipse(
            mx + f.forwardX * 2,
            my + f.forwardY * 2,
            4.5 * ppu,
            3 * ppu,
            Math.atan2(f.forwardY, f.forwardX),
            0,
            TAU,
        );
        ctx.fill();
    }

    // Embers off the edges of the stream while it breathed (born where it had reached by then), then the spray off
    // the tip at the moment it stopped. They rise up the screen and fall back as they die.
    ctx.lineCap = 'round';
    ctx.strokeStyle = EMBER_TRAIL;
    ctx.fillStyle = EMBER_SPARK;
    const jFrom = Math.floor(Math.max(start, t - EMBER_LIFE_MAX) * EMBER_RATE) - 1,
        jTo = Math.floor(end * EMBER_RATE);
    for (let j = jFrom; j <= jTo; j++) {
        const s = salt + CH_EMBER,
            born = (j + hash01(j, s)) / EMBER_RATE;
        if (born < start || born > end) continue;
        const life = 0.35 + 0.45 * hash01(j, s + 1),
            emberAge = t - born;
        if (emberAge >= life) continue;
        const d = Math.min(length, (born - start) * FLAME_SPEED) * (0.35 + 0.65 * hash01(j, s + 2)),
            edge = hash01(j, s + 3) < 0.5 ? -1 : 1;
        project(d, edge * d * tan * (0.7 + 0.3 * hash01(j, s + 4)));
        drawEmber(
            ctx,
            px,
            py,
            30 + 70 * hash01(j, s + 5),
            -(25 + 60 * hash01(j, s + 6)),
            emberAge,
            life,
            EMBER_SIZE * (0.7 + 0.6 * hash01(j, s + 7)),
        );
    }
    if (!on && since < EMBER_LIFE_MAX)
        for (let j = 0; j < STOP_EMBERS; j++) {
            const s = salt + CH_SPRAY,
                life = 0.35 + 0.45 * hash01(j, s + 1);
            if (since >= life) continue;
            project(
                length * (0.75 + 0.25 * hash01(j, s + 2)),
                (hash01(j, s + 3) - 0.5) * 2 * length * tan * 0.8,
            );
            drawEmber(
                ctx,
                px,
                py,
                (30 + 70 * hash01(j, s + 5)) * 0.5,
                -(25 + 60 * hash01(j, s + 6)),
                since,
                life,
                EMBER_SIZE * (0.7 + 0.6 * hash01(j, s + 4)),
            );
        }
    ctx.restore();
    flame = null;
}

// Cooling down: three small puffs rise from the mouth one after another and fade, coming in as the flame runs out.
const COOL_FADE_MS = 220;
const COOL_PUFFS = 3;
const COOL_PUFF_MS = 900;
const COOL_RISE = 22;
const COOL_SMOKE = '#a39a94';
function drawCoolingSmoke(ctx, f) {
    const since = f.stopMs === null ? 0 : Math.min(f.stopMs, 1e6),
        fadeIn = clamp01((since - COOL_FADE_MS * 0.5) / COOL_FADE_MS);
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
