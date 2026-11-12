// The dandelion seed (assets/sprites/dandelion/parts.svg, approved variant B). Art units are rice's (standing
// height 343.5 = artScale 1); the body's origin is the ground between its feet. On the ground it is a seed with a
// stalk stub. It leaves the shell bare; its stalk and fluff (canopy) open as it takes off and, while flying, it hangs
// under the fluff's hub and sways. When it lands the fluff tears off with the stalk, rises and fades while bits of fluff
// scatter, and the body drops and squashes. The torn-off fluff is presentation only (actor.setFlight clocks).
import { drawUnitQuads } from '../../render/dead-unit-look.js';

const ROOT = new URL('../../../assets/sprites/dandelion/', import.meta.url);
const SHEET_WIDTH = 760;
const SHEET_HEIGHT = 731;
// The sheet is rasterised at this fraction of its art size: a battle shows a soldier at well under a tenth of its art
// size and the atlas has no mipmaps, so the browser's own antialiasing of the thin fluff strands at a smaller size reads
// as the approved soft disc where a full-size raster would shimmer into grey speckle.
const SHEET_SCALE = 0.25;
const portraitSheets = new WeakMap();
const DEGREE = Math.PI / 180;

const CELL = Object.freeze({
    body: { slot: [12, 12, 190, 340], pivot: [95, 326] },
    canopy: { slot: [214, 12, 468, 497], pivot: [234, 483] },
    foot: { slot: [12, 521, 60, 64], pivot: [30, 32] },
    hand: { slot: [84, 521, 44, 60], pivot: [22, 30] },
    stub: { slot: [140, 521, 36, 48], pivot: [18, 40] },
    bits: { slot: [188, 521, 120, 120], pivot: [60, 60] },
    neutral: { slot: [320, 521, 132, 66], pivot: [66, 30] },
    attack: { slot: [464, 521, 132, 66], pivot: [66, 30] },
    hurt: { slot: [608, 521, 132, 66], pivot: [66, 30] },
    float: { slot: [12, 653, 132, 66], pivot: [66, 30] },
});
// Sockets on the body, from the approved assembly (docs/handoff/dandelion-art/v2).
const STALK = [0, -310];
const HUB = [0, -600];
const FACE = [0, -110];
const LEAN_CENTER = -100;
const REST_FEET = [
    [-30, -12],
    [30, -12],
];
const REST_HANDS = [
    [-80, -70],
    [80, -70],
];

// Rig parts. Left foot and left hand are the right ones mirrored.
const PART = Object.freeze({
    swing: 0,
    leftFoot: 1,
    rightFoot: 2,
    body: 3,
    stub: 4,
    face: 5,
    leftHand: 6,
    rightHand: 7,
    canopy: 8,
    bit: 9,
});
const BIT_COUNT = 3;
const RIG = {
    parts: [
        { id: 'swing', parent: null, pivot: HUB },
        { id: 'leftFoot', parent: 'swing', pivot: REST_FEET[0] },
        { id: 'rightFoot', parent: 'swing', pivot: REST_FEET[1] },
        { id: 'body', parent: 'swing', pivot: [0, 0] },
        { id: 'stub', parent: 'body', pivot: STALK },
        { id: 'face', parent: 'body', pivot: FACE },
        { id: 'leftHand', parent: 'body', pivot: REST_HANDS[0] },
        { id: 'rightHand', parent: 'body', pivot: REST_HANDS[1] },
        { id: 'canopy', parent: 'swing', pivot: STALK },
        ...Array.from({ length: BIT_COUNT }, (_, index) => ({
            id: `bit${index}`,
            parent: null,
            pivot: STALK,
        })),
    ],
    // Every motion is procedural (preparePose); the clips only name the state and its clock.
    clips: Object.fromEntries(
        [
            ['idle', 1200, 'repeat'],
            ['walk', 600, 'repeat'],
            ['fire', 425, 'once'],
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

// Whole-figure poses from the approved assembly: feet and hands [x, y, degrees] in body units, the body's lean
// (degrees about y −100), squash (sx, sy) and the swing about the fluff hub (degrees).
const pose = (feet, hands, lean = 0, sx = 1, sy = 1, swing = 0) => ({
    feet,
    hands,
    lean,
    sx,
    sy,
    swing,
});
const HANDS = Object.freeze({
    rest: [
        [-80, -70, 20],
        [80, -70, -20],
    ],
    fists: [
        [-54, -52, -30],
        [86, -116, -50],
    ],
    up: [
        [-84, -150, 50],
        [84, -150, -50],
    ],
    throw: [
        [-108, -40, -60],
        [108, -40, 60],
    ],
});
const FEET = [
    [-30, -12, 0],
    [30, -12, 0],
];
const POSE = Object.freeze({
    ground: pose(FEET, HANDS.rest),
    attack: pose(FEET, HANDS.fists, 6),
    hurt: pose(FEET, HANDS.up, -8),
    fly: pose(
        [
            [-15, 4, 16],
            [17, 8, -12],
        ],
        [
            [-80, -134, 34],
            [80, -134, -34],
        ],
    ),
    // The fluff pops off (detach shot 1), then the body drops with its arms flung out (shot 2).
    pop: pose(
        [
            [-30, 8, 30],
            [30, 10, -30],
        ],
        [
            [-88, -128, 60],
            [88, -128, -60],
        ],
        0,
        1,
        1,
        -9,
    ),
    drop: pose(
        [
            [-24, -2, 30],
            [26, 0, -24],
        ],
        HANDS.throw,
    ),
    // It lands squashed, fists up (shot 3).
    land: pose(
        [
            [-36, -12, -8],
            [36, -12, 8],
        ],
        HANDS.fists,
        0,
        1.07,
        0.92,
    ),
});
const SWAY_DEGREES = 6;
const SWAY_MS = 1700;
// Take-off: the figure turns from standing to hanging over its first climb (world units), and is excited until here.
const TAKE_OFF_HEIGHT = 40;
const FLOAT_FACE_HEIGHT = 100;
// The fluff leaves the shell folded to this size and is fully open at this altitude.
const FLUFF_CLOSED = 0.15;
const FLUFF_OPEN_HEIGHT = 35;
const POP_MS = 100;
const DROP_MS = 120;
const LAND_SQUASH_MS = 90;
const LAND_RECOVER_MS = 330;
// The torn-off fluff and its bits, relative to the stalk socket where it came off:
// [ms, x, y, degrees, scale, opacity] (detach shots 2 and 3 at 150 and 450 ms).
const LOOSE_MS = 900;
const LOOSE_CANOPY = [
    [0, 0, 0, 0, 1, 1],
    [150, 18, -90, 10, 1, 1],
    [450, -40, -230, -16, 0.8, 0.55],
    [900, -80, -380, -26, 0.7, 0],
];
const LOOSE_BITS = [
    [
        [0, 0, 0, 0, 0.3, 0],
        [150, -70, -20, -30, 0.8, 1],
        [450, -120, -60, -30, 0.6, 0.7],
        [800, -150, -100, -40, 0.5, 0],
    ],
    [
        [0, 0, 0, 0, 0.3, 0],
        [150, 76, -44, 40, 0.7, 1],
        [450, 110, -130, 30, 0.55, 0.6],
        [800, 130, -200, 25, 0.5, 0],
    ],
    [
        [0, 0, 0, 0, 0.3, 0],
        [150, -40, -110, 10, 0.6, 0.9],
        [450, -55, -190, 0, 0.5, 0.4],
        [750, -60, -250, -5, 0.45, 0],
    ],
];

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
    out.lean = lerp(a.lean, b.lean, t);
    out.sx = lerp(a.sx, b.sx, t);
    out.sy = lerp(a.sy, b.sy, t);
    out.swing = lerp(a.swing, b.swing, t);
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

// One base pose from a keyframe track at `ms`, as an offset from the part's pivot.
function sampleTrack(base, track, ms) {
    let index = 1;
    while (index < track.length - 1 && track[index][0] < ms) index++;
    const from = track[index - 1],
        to = track[index],
        t = smooth((ms - from[0]) / (to[0] - from[0]));
    base.x = lerp(from[1], to[1], t);
    base.y = lerp(from[2], to[2], t);
    base.rotation = lerp(from[3], to[3], t) * DEGREE;
    base.scaleX = base.scaleY = lerp(from[4], to[4], t);
    base.opacity = lerp(from[5], to[5], t);
}

async function readAsset(name) {
    const response = await fetch(new URL(name, ROOT), { cache: 'no-cache' });
    if (!response.ok) throw new Error('민들레씨 스프라이트를 불러오지 못했습니다: ' + name);
    return response;
}

export async function loadDandelionSpriteCanvas() {
    const [manifest, bytes] = await Promise.all([
        readAsset('manifest.json').then((response) => response.json()),
        readAsset('parts.svg').then((response) => response.arrayBuffer()),
    ]);
    const spec = manifest?.assets?.['parts.svg'];
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
        value.toString(16).padStart(2, '0'),
    ).join('');
    if (manifest?.schemaVersion !== 1 || spec?.bytes !== bytes.byteLength || spec.sha256 !== hash)
        throw new Error('민들레씨 SVG 무결성 오류');
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        if (image.naturalWidth !== SHEET_WIDTH || image.naturalHeight !== SHEET_HEIGHT)
            throw new Error('민들레씨 스프라이트 시트 크기가 다릅니다.');
        const raster = (scale) => {
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(SHEET_WIDTH * scale);
            canvas.height = Math.round(SHEET_HEIGHT * scale);
            canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
            return canvas;
        };
        const canvas = raster(SHEET_SCALE);
        // The card portrait is drawn far larger than a soldier: it reads the full-size raster.
        portraitSheets.set(canvas, raster(1));
        return canvas;
    } finally {
        URL.revokeObjectURL(url);
    }
}

// The card portrait: the approved flying pose (neutral face, swung 6 degrees under its fluff), square like the
// other cards' portraits. The frame keeps only the lower part of the fluff disc so the body fills most of the
// height, as large as the other soldiers' portraits allow.
export function dandelionSpritePortrait(atlasSheet, width) {
    const source = portraitSheets.get(atlasSheet),
        canvas = document.createElement('canvas');
    canvas.width = canvas.height = width;
    const ctx = canvas.getContext('2d'),
        scale = width / 600;
    ctx.setTransform(scale, 0, 0, scale, width / 2 + 45 * scale, width - 18 * scale);
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
    const { feet, hands } = POSE.fly;
    ctx.translate(...HUB);
    ctx.rotate(SWAY_DEGREES * DEGREE);
    ctx.translate(-HUB[0], -HUB[1]);
    draw(CELL.foot, feet[0], feet[0][2], true);
    draw(CELL.foot, feet[1], feet[1][2]);
    draw(CELL.body, [0, 0]);
    draw(CELL.canopy, STALK);
    draw(CELL.neutral, FACE);
    draw(CELL.hand, hands[0], hands[0][2], true);
    draw(CELL.hand, hands[1], hands[1][2]);
    return canvas.toDataURL('image/png');
}

export class DandelionSpriteRenderer {
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
        const feet = [
            [CELL.foot, REST_FEET[0], PART.leftFoot],
            [CELL.foot, REST_FEET[1], PART.rightFoot],
            [CELL.body, [0, 0], PART.body],
        ];
        // Depth-written bodies: with the fluff on, and with only its stalk stub left.
        this.body = build(feet);
        this.bareBody = build([...feet, [CELL.stub, STALK, PART.stub]]);
        // The fluff is see-through (its halo): it is drawn under every body and face, never writing depth.
        this.canopy = build([[CELL.canopy, STALK, PART.canopy]]);
        this.loose = build([
            [CELL.canopy, STALK, PART.canopy],
            ...Array.from({ length: BIT_COUNT }, (_, index) => [
                CELL.bits,
                STALK,
                PART.bit + index,
            ]),
        ]);
        this.front = Object.fromEntries(
            ['neutral', 'attack', 'hurt', 'float'].map((face) => [
                face,
                build([
                    [CELL[face], FACE, PART.face],
                    [CELL.hand, REST_HANDS[0], PART.leftHand],
                    [CELL.hand, REST_HANDS[1], PART.rightHand],
                ]),
            ]),
        );
        // The launch shell: the seed itself, stalk stub first along the flight (sprite.shell.turn), one unit long.
        this.ammo = build(
            [
                [CELL.body, [0, 0]],
                [CELL.stub, STALK],
                [CELL.neutral, FACE],
            ],
            { origin: [0, -175], unit: 350 },
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
            // Flight presentation (setFlight). fluff: whether it wears its fluff (null: not seen yet).
            fluff: null,
            airborne: false,
            alive: true,
            clock: 0,
            heightPx: 0,
            altitude: 0,
            detachedAt: null,
            detachHeightPx: 0,
            groundedAt: null,
            looseMatrix: new Float32Array(6),
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
            // From main.js each frame, on the render tick's clock (ms): Unit.flight.phase, alive, altitude (world
            // units), heightPx (the body's drawn height above its ground point) and, while the landing fall runs, its
            // start and end and the drawn height it fell from. The seed leaves the shell bare; its fluff opens as it
            // takes off and stays on until it lands for good, when it tears off. One killed in the air keeps it.
            setFlight({
                phase,
                alive,
                altitude,
                clockMs,
                heightPx,
                landStartMs,
                landEndMs,
                dropFromPx,
            }) {
                const airborne = phase === 'fly' || phase === 'alight',
                    falling = Number.isFinite(landStartMs);
                if (airborne || phase === 'wait') {
                    this.fluff = airborne;
                    this.detachedAt = this.groundedAt = null;
                } else if (!alive) {
                    // Seen for the first time already dead in a fall: it was shot down.
                    if (this.fluff === null) this.fluff = falling;
                } else {
                    if (this.fluff === true || (this.fluff === null && falling)) {
                        if (falling) {
                            this.detachedAt = landStartMs;
                            this.groundedAt = landEndMs;
                        }
                    }
                    this.fluff = false;
                }
                if (this.detachedAt !== null && falling) this.detachHeightPx = dropFromPx;
                this.airborne = airborne;
                this.alive = alive;
                this.altitude = altitude;
                this.heightPx = heightPx;
                this.clock = clockMs;
            },
            looseAge() {
                return this.detachedAt === null ? Infinity : this.clock - this.detachedAt;
            },
            faceFor(face) {
                if (face !== 'neutral') return face;
                if (this.airborne && this.altitude < FLOAT_FACE_HEIGHT) return 'float';
                if (this.looseAge() < LOOSE_MS) return 'attack';
                return face;
            },
            groundPose() {
                const e = this.elapsed;
                if (this.currentClip === 'fire') {
                    const t = e / RIG.clips.fire.durationMs;
                    return mixPose(
                        ground,
                        POSE.ground,
                        POSE.attack,
                        t < 0.3 ? smooth(t / 0.3) : 1 - smooth((t - 0.55) / 0.45),
                    );
                }
                if (this.currentClip === 'hit')
                    return mixPose(
                        ground,
                        POSE.ground,
                        POSE.hurt,
                        1 - smooth(e / RIG.clips.hit.durationMs),
                    );
                mixPose(ground, POSE.ground, POSE.ground, 0);
                if (this.currentClip === 'walk') {
                    const gait = Math.sin((e / RIG.clips.walk.durationMs) * Math.PI * 2),
                        lift = [Math.max(0, -gait), Math.max(0, gait)];
                    for (let side = 0; side < 2; side++) {
                        ground.feet[side][1] -= 9 * lift[side];
                        ground.feet[side][2] += (side ? -8 : 8) * lift[side];
                    }
                    ground.lean = 3 * gait;
                    ground.sy = 1 - 0.03 * Math.abs(gait);
                    ground.hands[0][2] += 10 * gait;
                    ground.hands[1][2] += 10 * gait;
                } else {
                    const breath = Math.sin((e / RIG.clips.idle.durationMs) * Math.PI * 2);
                    ground.sy = 1 + 0.012 * breath;
                }
                return ground;
            },
            // The whole figure's pose this frame, into `now`.
            figurePose() {
                if (this.fluff && !this.alive) return mixPose(now, POSE.fly, POSE.fly, 0);
                if (this.airborne) {
                    const t = smooth(this.altitude / TAKE_OFF_HEIGHT);
                    mixPose(now, this.groundPose(), POSE.fly, t);
                    const sway = Math.sin((this.elapsed / SWAY_MS) * Math.PI * 2);
                    now.swing = t * SWAY_DEGREES * sway;
                    now.feet[0][2] += t * 6 * Math.sin((this.elapsed / SWAY_MS) * Math.PI * 2 - 1);
                    now.feet[1][2] -= t * 6 * Math.sin((this.elapsed / SWAY_MS) * Math.PI * 2 - 2);
                    return now;
                }
                const age = this.looseAge(),
                    settled = this.groundedAt === null ? Infinity : this.clock - this.groundedAt;
                if (settled < 0)
                    return age < POP_MS
                        ? mixPose(now, POSE.pop, POSE.pop, 0)
                        : mixPose(now, POSE.pop, POSE.drop, smooth((age - POP_MS) / DROP_MS));
                const base = this.groundPose();
                if (settled >= LAND_SQUASH_MS + LAND_RECOVER_MS) return base;
                return mixPose(
                    now,
                    base,
                    POSE.land,
                    settled < LAND_SQUASH_MS
                        ? smooth(settled / LAND_SQUASH_MS)
                        : 1 - smooth((settled - LAND_SQUASH_MS) / LAND_RECOVER_MS),
                );
            },
            preparePose() {
                const figure = this.figurePose();
                basePoses[PART.swing].rotation = figure.swing * DEGREE;
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
                // Lean about the body's middle (y −100), squash about the ground between the feet.
                const lean = figure.lean * DEGREE,
                    sin = Math.sin(lean),
                    cos = Math.cos(lean),
                    body = basePoses[PART.body];
                body.rotation = lean;
                body.scaleX = figure.sx;
                body.scaleY = figure.sy;
                body.x = LEAN_CENTER * sin;
                body.y = LEAN_CENTER * (1 - cos);
                const canopy = basePoses[PART.canopy],
                    age = this.looseAge();
                if (this.fluff) {
                    // Carried on the stalk socket: it follows the body's lean and squash, and opens over the
                    // first climb (stalk and disc grow out of the socket).
                    const open = this.alive
                        ? FLUFF_CLOSED +
                          (1 - FLUFF_CLOSED) * smooth(this.altitude / FLUFF_OPEN_HEIGHT)
                        : 1;
                    canopy.rotation = lean;
                    canopy.scaleX = figure.sx * open;
                    canopy.scaleY = figure.sy * open;
                    canopy.x = body.x - STALK[1] * figure.sy * sin;
                    canopy.y = body.y + STALK[1] * figure.sy * cos - STALK[1];
                    canopy.opacity = 1;
                } else sampleTrack(canopy, LOOSE_CANOPY, Math.min(age, LOOSE_MS));
                for (let index = 0; index < BIT_COUNT; index++)
                    sampleTrack(
                        basePoses[PART.bit + index],
                        LOOSE_BITS[index],
                        Math.min(age, LOOSE_MS),
                    );
                this.pose = owner.mesh.preparePose(instance, {
                    clipName: this.currentClip,
                    elapsedMs: this.elapsed,
                    basePoses,
                    visible,
                    morph: [0, 0],
                });
                if (!this.pose) throw new Error('민들레씨 GPU 포즈를 준비하지 못했습니다.');
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
        this.draw(actor.fluff ? this.body : this.bareBody, matrix, depth, actor, 0.05);
    }

    // The see-through fluff (stalk and disc) lies under every body and face (main.js drawGrainUnderlays).
    drawUnderlay(actor, matrix, depth) {
        if (actor.fluff) this.draw(this.canopy, matrix, depth, actor);
        else if (actor.looseAge() < LOOSE_MS) {
            // The torn-off fluff stays where it came off while the body drops below it.
            const m = actor.looseMatrix;
            m.set(matrix);
            m[5] -= actor.detachHeightPx - actor.heightPx;
            this.draw(this.loose, m, depth, actor);
        }
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

// This unit's sprite contract (src/units/define-unit.js), loaded only by the page, never the Worker.
export const SPRITE = Object.freeze({
    load: loadDandelionSpriteCanvas,
    renderer: DandelionSpriteRenderer,
    portrait: dandelionSpritePortrait,
    // Stalk stub first along the flight.
    shell: { draw: 'drawAmmo', depthTest: true, turn: Math.PI / 2 },
    groundY: 0,
});
