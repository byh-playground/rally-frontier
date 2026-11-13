// The cotton (assets/sprites/cotton/parts.svg, approved sheet G1, docs/handoff/cotton-art). A rice-family figure in
// the sticky rice's format: the ground between its feet is the origin, its height (stem tip to ground, 203.4 sheet
// units) is 0.94 of rice's 343.5. Walk, idle, attack and hurt follow the sticky rice's poses. While it channels its
// chain (UnitChainAttack) it shows the attack face and its body swells a little and trembles (part transforms only,
// no new art); just before a channel (the end of its cooldown) it swells a touch less.
// Its lightning (drawBolt, the approved L1 "푸른 흰 굵은 줄기") is painted on main.js's 2D effect canvas like the
// chili's flame: nothing is kept between frames for the shape, every bend, branch and spark is hashed from the clock
// bucket and a per-link seed, so the same clock paints the same bolt, and nothing is allocated per frame.
import { drawUnitQuads } from '../../render/dead-unit-look.js';

const ROOT = new URL('../../../assets/sprites/cotton/', import.meta.url);
const SHEET_SIZE = [514, 236];
// Stem tip to the feet's ground contact in sheet units; the cotton stands 0.94 of rice's 343.5.
const STANDING_HEIGHT = 203.4;
export const COTTON_ART_SCALE = (0.94 * 343.5) / STANDING_HEIGHT;
const DEGREE = Math.PI / 180;

const cells = {
    body: { slot: [10, 10, 196, 160], pivot: [98, 172] },
    cap: { slot: [216, 6, 170, 118], pivot: [80, 214] },
    foot: { slot: [396, 12, 52, 40], pivot: [26, 14] },
    arm: { slot: [456, 8, 48, 60], pivot: [20, 10] },
    neutral: { slot: [10, 182, 98, 45], pivot: [49, 22] },
    attack: { slot: [115, 182, 98, 45], pivot: [49, 22] },
    hurt: { slot: [220, 182, 98, 45], pivot: [49, 22] },
};
// Approved standing assembly (the sheet's header): the ground point is the origin.
const bodyParts = [
    { cell: 'foot', id: 'leftFoot', position: [-24, -12], scaleX: -1 },
    { cell: 'foot', id: 'rightFoot', position: [24, -12] },
    { cell: 'body', id: 'body', position: [0, 0] },
    { cell: 'cap', id: 'cap', position: [0, 0] },
];
const frontParts = [
    { id: 'face', position: [0, -88] },
    {
        cell: 'arm',
        id: 'leftArm',
        position: [-80, -64],
        rotation: 8 * DEGREE,
        scaleX: -0.85,
        scaleY: 0.85,
    },
    {
        cell: 'arm',
        id: 'rightArm',
        position: [80, -64],
        rotation: -8 * DEGREE,
        scaleX: 0.85,
        scaleY: 0.85,
    },
];
const parts = [...bodyParts, ...frontParts];
const PART_BODY = parts.findIndex((part) => part.id === 'body');
const PART_LEFT_ARM = parts.findIndex((part) => part.id === 'leftArm');
const PART_RIGHT_ARM = parts.findIndex((part) => part.id === 'rightArm');
// Where the lightning leaves the cotton (art units): just above its head, between the stem and the tuft.
const BOLT_TIP = [0, -150];
const key = (timeMs, parts = {}) => ({ timeMs, parts, easing: 'inOutSine' });
const clip = (durationMs, loop, keyframes) => ({ durationMs, loop, keyframes });
const rig = {
    parts: parts.map(({ id, position }) => ({
        id,
        parent: id === 'body' ? null : 'body',
        pivot: position,
    })),
    clips: {
        idle: clip(1200, 'repeat', [
            key(0),
            key(600, { body: { y: -2, scaleY: 1.02 } }),
            key(1200),
        ]),
        walk: clip(600, 'repeat', [
            key(0, { body: { rotation: -0.045 }, leftFoot: { y: -11, rotation: 0.16 } }),
            key(150, { body: { y: -5 } }),
            key(300, { body: { rotation: 0.045 }, rightFoot: { y: -11, rotation: -0.16 } }),
            key(450, { body: { y: -5 } }),
            key(600, { body: { rotation: -0.045 }, leftFoot: { y: -11, rotation: 0.16 } }),
        ]),
        fire: clip(280, 'once', [
            key(0, { body: { y: 5, scaleX: 1.07, scaleY: 0.92 } }),
            key(85, { body: { y: -13, scaleX: 0.96, scaleY: 1.1 } }),
            key(180, { body: { y: 5, scaleX: 1.05, scaleY: 0.93 } }),
            key(280),
        ]),
        hit: clip(240, 'once', [
            key(0, { body: { rotation: -0.12, y: 4, scaleX: 1.06, scaleY: 0.92 } }),
            key(240),
        ]),
        // Channelling: arms up, a fast tremble about the swollen body (the swell itself is the base pose).
        channel: clip(120, 'repeat', [
            key(0, {
                body: { x: -1.6, rotation: -0.012 },
                leftArm: { rotation: 0.5 },
                rightArm: { rotation: -0.5 },
            }),
            key(30, {
                body: { x: 1.4, y: -1, rotation: 0.01 },
                leftArm: { rotation: 0.56 },
                rightArm: { rotation: -0.44 },
            }),
            key(60, {
                body: { x: -1, y: 0.6, rotation: -0.008 },
                leftArm: { rotation: 0.46 },
                rightArm: { rotation: -0.56 },
            }),
            key(90, {
                body: { x: 1.6, y: -0.6, rotation: 0.012 },
                leftArm: { rotation: 0.54 },
                rightArm: { rotation: -0.48 },
            }),
            key(120, {
                body: { x: -1.6, rotation: -0.012 },
                leftArm: { rotation: 0.5 },
                rightArm: { rotation: -0.5 },
            }),
        ]),
    },
};
// The swell while channelling and while the telegraph runs (scale over the rest pose), and how fast it comes and goes.
const CHANNEL_SWELL = 0.06;
const TELEGRAPH_SWELL = 0.04;
const SWELL_MS = 90;

async function readAsset(name) {
    const response = await fetch(new URL(name, ROOT), { cache: 'no-cache' });
    if (!response.ok) throw new Error('목화솜 스프라이트를 불러오지 못했습니다: ' + name);
    return response;
}

export async function loadCottonSpriteCanvas() {
    const [manifest, bytes] = await Promise.all([
        readAsset('manifest.json').then((response) => response.json()),
        readAsset('parts.svg').then((response) => response.arrayBuffer()),
    ]);
    const spec = manifest?.assets?.['parts.svg'];
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
        value.toString(16).padStart(2, '0'),
    ).join('');
    if (manifest?.schemaVersion !== 1 || spec?.bytes !== bytes.byteLength || spec.sha256 !== hash)
        throw new Error('목화솜 SVG 무결성 오류');
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const [width, height] = SHEET_SIZE;
        if (image.naturalWidth !== width || image.naturalHeight !== height)
            throw new Error('목화솜 스프라이트 시트 크기가 다릅니다.');
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(image, 0, 0);
        return canvas;
    } finally {
        URL.revokeObjectURL(url);
    }
}

// The card portrait: the standing figure in the painter order of the sheet (feet, body, cap, face, arms).
export function cottonSpritePortrait(source, width) {
    const canvas = document.createElement('canvas');
    const scale = width / 240;
    canvas.width = width;
    canvas.height = width;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, width / 2, width - 22 * scale);
    for (const { cell = 'neutral', position, rotation = 0, scaleX = 1, scaleY = 1 } of parts) {
        const {
            slot,
            pivot: [px, py],
        } = cells[cell];
        ctx.save();
        ctx.translate(...position);
        ctx.rotate(rotation);
        ctx.scale(scaleX, scaleY);
        ctx.drawImage(source, ...slot, -px, -py, slot[2], slot[3]);
        ctx.restore();
    }
    return canvas.toDataURL('image/png');
}

const smooth01 = (value) => {
    const t = value < 0 ? 0 : value > 1 ? 1 : value;
    return t * t * (3 - 2 * t);
};

export class CottonSpriteRenderer {
    constructor(context, canvas, gamekit) {
        this.context = context;
        this.mesh = context.acquireMeshRenderer();
        this.actors = new Set();
        const region = context.device.textureAtlas.allocate(canvas.width, canvas.height, {
            filter: 'linear',
        });
        try {
            context.device.textureAtlas.upload(region, canvas);
            this.source = this.mesh.createPoseSource(gamekit.compilePoseChannels(rig));
        } catch (error) {
            context.device.textureAtlas.release(region);
            throw error;
        }
        this.region = region;

        // Posed quads are in standing-art units; the shell's quads are around `origin` in units of `unit`.
        const build = (pieces, { origin = null, unit = 1 } = {}) => {
            const uvRects = [],
                localRects = [],
                channels = [];
            for (const {
                cell,
                id,
                position: [x, y],
            } of pieces) {
                const {
                    slot: [sx, sy, w, h],
                    pivot: [px, py],
                } = cells[cell];
                uvRects.push(
                    (region.x + sx) / region.atlas.width,
                    (region.y + sy) / region.atlas.height,
                    w / region.atlas.width,
                    h / region.atlas.height,
                );
                const [ox, oy] = origin || [0, 0];
                localRects.push((x - px - ox) / unit, (y - py - oy) / unit, w / unit, h / unit);
                if (!origin) channels.push(parts.findIndex((part) => part.id === id));
            }
            return {
                uvRects: Float32Array.from(uvRects),
                localRects: Float32Array.from(localRects),
                ...(origin ? {} : { parts: Float32Array.from(channels) }),
            };
        };
        this.body = build(bodyParts);
        this.front = Object.fromEntries(
            ['neutral', 'attack', 'hurt'].map((face) => [
                face,
                build(frontParts.map((part) => ({ ...part, cell: part.cell || face }))),
            ]),
        );
        // The launch shell: the cotton puff without feet and arms, about one unit wide.
        this.ammo = build(
            [
                { cell: 'body', position: [0, 0] },
                { cell: 'cap', position: [0, 0] },
                { cell: 'neutral', position: [0, -88] },
            ],
            { origin: [0, -108], unit: 190 },
        );
        context.onDispose(() => this.dispose());
    }

    createActor() {
        const owner = this;
        const instance = owner.mesh.createPoseInstance(owner.source);
        const basePoses = parts.map(({ rotation = 0, scaleX = 1, scaleY = 1 }) => ({
            x: 0,
            y: 0,
            rotation,
            scaleX,
            scaleY,
            opacity: 1,
        }));
        const visible = parts.map(() => true);
        const actor = {
            currentClip: 'idle',
            startedAt: 0,
            elapsed: 0,
            pose: null,
            disposed: false,
            // Chain presentation (setChannel): 'channel' while it channels, 'telegraph' just before, else null; the
            // swell now (0..1 of the channel swell) and the render clock (ms).
            channel: null,
            swell: 0,
            clock: null,
            alive: true,
            play(name) {
                this.currentClip = Object.hasOwn(rig.clips, name) ? name : 'idle';
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
            // From main.js each frame (UnitChainAttack): its channel state, the render clock (ms), whether it is alive.
            setChannel(state, clockMs, alive) {
                const want =
                    !alive || !state
                        ? 0
                        : state === 'channel'
                          ? 1
                          : TELEGRAPH_SWELL / CHANNEL_SWELL;
                const step = this.clock === null ? Infinity : Math.max(0, clockMs - this.clock);
                this.swell =
                    step === Infinity
                        ? want
                        : want > this.swell
                          ? Math.min(want, this.swell + step / SWELL_MS)
                          : Math.max(want, this.swell - step / SWELL_MS);
                this.channel = alive ? state : null;
                this.alive = alive;
                this.clock = clockMs;
                return this;
            },
            faceFor(face) {
                if (face === 'hurt' || !this.alive) return 'hurt';
                return this.channel === 'channel' ? 'attack' : face;
            },
            preparePose() {
                const channelling = this.channel === 'channel',
                    swell = smooth01(this.swell) * CHANNEL_SWELL,
                    body = basePoses[PART_BODY];
                body.scaleX = 1 + swell;
                body.scaleY = 1 + swell * 1.15;
                // The arms rise with the swell (the channel clip trembles them about this).
                basePoses[PART_LEFT_ARM].rotation = 8 * DEGREE + (channelling ? 0 : swell * 3);
                basePoses[PART_RIGHT_ARM].rotation = -8 * DEGREE - (channelling ? 0 : swell * 3);
                this.pose = owner.mesh.preparePose(instance, {
                    clipName: channelling ? 'channel' : this.currentClip,
                    elapsedMs: channelling ? (this.clock ?? 0) : this.elapsed,
                    basePoses,
                    visible,
                    morph: [0, 0],
                });
                if (!this.pose) throw new Error('목화솜 GPU 포즈를 준비하지 못했습니다.');
                return this.pose;
            },
            // Where the lightning leaves the cotton this frame, in art units (main.js transforms it with the figure).
            boltTip(out) {
                const s = 1 + smooth01(this.swell) * CHANNEL_SWELL * 1.15;
                out.x = BOLT_TIP[0];
                // The body swells about the ground point (its pivot), so the tip rises with it.
                out.y = BOLT_TIP[1] * s;
                return out;
            },
            dispose() {
                if (this.disposed) return false;
                this.disposed = true;
                owner.actors.delete(this);
                return owner.mesh.deletePoseInstance(instance);
            },
        };
        owner.actors.add(actor);
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

// ---------------------------------------------------------------------------------------------------------------
// The L1 lightning ("푸른 흰 굵은 줄기", the approved vfx review LV[0]): per link a bent bolt in four layers (two
// faint glow strokes, the main shape thick at its bends and thin at the joints between them, a white core line,
// two small branches), re-shaped every RESHAPE_S. The links light one after another (IGNITE_GAP_MS apart, each
// stretching out over STRETCH_MS), every damage tick flashes on its targets, a cut link breaks into fading pieces
// over FADE_MS, the cooldown's last TELEGRAPH_MS shows a ring and sparks around the cotton, and sparks jump off it
// while it channels. The glow is thinner and fainter than the review's (its known weakness: overlapping glows
// turned a crowd into one blue blot).
// Sizes are the review's, in world units (its pixels were world units), times the screen's pixels per world unit.
// ---------------------------------------------------------------------------------------------------------------
const TAU = Math.PI * 2;
const MAIN = '#dbe9ff';
const GLOW = '#4f8fff';
const CORE = '#ffffff';
const WIDTH = 4.2;
const AMP = 12;
const BRANCHES = 2;
const RESHAPE_MS = 80;
const SPARKS = 2;
const SPARK_MS = 70;
export const IGNITE_GAP_MS = 60;
const STRETCH_MS = 35;
const BOOST_MS = 80;
export const FADE_MS = 240;
export const TELEGRAPH_MS = 220;
const HIT_MS = 130;
// The glow's two strokes: alpha and width (w·k + c), lighter than the review's 0.16·(4w + 8) and 0.34·(1.8w + 3).
const GLOW_OUTER_ALPHA = 0.1;
const GLOW_OUTER_K = 3;
const GLOW_OUTER_C = 5;
const GLOW_INNER_ALPHA = 0.3;
const GLOW_INNER_K = 1.6;
const GLOW_INNER_C = 2;
const TARGET_GLOW_R = 7;
const TARGET_GLOW_ALPHA = 0.35;

// A float in [0, 1) from an integer and a channel (integer avalanche hash; no state).
function hash01(n, salt) {
    let h = Math.imul(n | 0, 0x27d4eb2d) ^ Math.imul((salt | 0) + 0x3c6ef372, 0x165667b1);
    h ^= h >>> 15;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

// Scratch for one bolt's points (screen) and their widths, allocated once. A bolt has at most MAX_POINTS points
// (a 250-unit link bends about every 17 units; longer links on screen keep the cap).
const MAX_POINTS = 40;
const ptX = new Float64Array(MAX_POINTS);
const ptY = new Float64Array(MAX_POINTS);
const ptW = new Float64Array(MAX_POINTS);
let ptCount = 0;

// Fills the scratch with the bolt from (ax, ay) to (bx, by) (screen), shaped by `seed` (one or two big bends plus
// irregular small kinks that do not grow with length), cut at `cut` (0..1 of the way). ppu: pixels per world unit.
// Returns the number of points (the cut end included).
function boltPoints(ax, ay, bx, by, seed, cut, ppu) {
    const dx = bx - ax,
        dy = by - ay,
        lenPx = Math.hypot(dx, dy) || 1,
        len = lenPx / ppu,
        nx = -dy / lenPx,
        ny = dx / lenPx,
        n = Math.min(MAX_POINTS - 2, Math.max(3, Math.round(len / 17))),
        big = (hash01(seed, 1) * 2 - 1) * Math.min(len * 0.12, AMP * 1.4),
        big2 = (hash01(seed, 2) * 2 - 1) * Math.min(len * 0.06, AMP * 0.7);
    let side = hash01(seed, 3) < 0.5 ? -1 : 1;
    ptCount = 0;
    ptX[ptCount] = ax;
    ptY[ptCount++] = ay;
    for (let i = 1; i <= n; i++) {
        let u = 1,
            off = 0;
        if (i < n) {
            u = (i + (hash01(seed, 10 + i * 3) - 0.5) * 0.6) / n;
            const env = Math.pow(Math.sin(u * Math.PI), 0.6),
                macro = big * Math.sin(u * Math.PI) + big2 * Math.sin(u * Math.PI * 2);
            off =
                (macro + side * (0.25 + 0.75 * hash01(seed, 11 + i * 3)) * AMP * 0.55 * env) * ppu;
            if (hash01(seed, 12 + i * 3) < 0.7) side = -side;
        }
        if (u > cut) {
            ptX[ptCount] = ax + dx * cut;
            ptY[ptCount++] = ay + dy * cut;
            return ptCount;
        }
        ptX[ptCount] = ax + dx * u + nx * off;
        ptY[ptCount++] = ay + dy * u + ny * off;
    }
    return ptCount;
}

// Widths at each scratch point: thick at a bend, thin at the ends (the review's widthsOf).
function boltWidths(w) {
    for (let i = 0; i < ptCount; i++) {
        if (i === 0 || i === ptCount - 1) {
            ptW[i] = w * 0.45;
            continue;
        }
        const a = Math.atan2(ptY[i] - ptY[i - 1], ptX[i] - ptX[i - 1]),
            b = Math.atan2(ptY[i + 1] - ptY[i], ptX[i + 1] - ptX[i]);
        let d = Math.abs(a - b);
        if (d > Math.PI) d = TAU - d;
        ptW[i] = w * (0.8 + 0.7 * Math.min(1, d / 1.2));
    }
}

function polyline(ctx) {
    ctx.moveTo(ptX[0], ptY[0]);
    for (let i = 1; i < ptCount; i++) ctx.lineTo(ptX[i], ptY[i]);
}

// The main shape of segment i-1 → i as one quad pinched in the middle (thick at its bends, thin at the joint),
// added to the current path (the caller fills every segment at once).
function segmentPath(ctx, i, wm) {
    const px = ptX[i - 1],
        py = ptY[i - 1],
        qx = ptX[i],
        qy = ptY[i],
        dx = qx - px,
        dy = qy - py,
        len = Math.hypot(dx, dy) || 1,
        nx = -dy / len,
        ny = dx / len,
        mx = (px + qx) / 2,
        my = (py + qy) / 2,
        wp = ptW[i - 1] / 2,
        wq = ptW[i] / 2,
        h = wm / 2;
    ctx.moveTo(px + nx * wp, py + ny * wp);
    ctx.lineTo(mx + nx * h, my + ny * h);
    ctx.lineTo(qx + nx * wq, qy + ny * wq);
    ctx.lineTo(qx - nx * wq, qy - ny * wq);
    ctx.lineTo(mx - nx * h, my - ny * h);
    ctx.lineTo(px - nx * wp, py - ny * wp);
    ctx.closePath();
}

// One live bolt over the scratch points: glow (two strokes), main shape (one fill), core (one stroke), branches
// (glow, inner and tip strokes, each one path for both branches). 7 draws.
function drawBoltShape(ctx, seed, alpha, w, ppu) {
    if (ptCount < 2) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = GLOW;
    ctx.globalAlpha = alpha * GLOW_OUTER_ALPHA;
    ctx.lineWidth = w * GLOW_OUTER_K + GLOW_OUTER_C * ppu;
    ctx.beginPath();
    polyline(ctx);
    ctx.stroke();
    ctx.globalAlpha = alpha * GLOW_INNER_ALPHA;
    ctx.lineWidth = w * GLOW_INNER_K + GLOW_INNER_C * ppu;
    ctx.stroke();
    boltWidths(w);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = MAIN;
    ctx.beginPath();
    for (let i = 1; i < ptCount; i++) segmentPath(ctx, i, w * 0.3);
    ctx.fill();
    ctx.lineJoin = 'miter';
    ctx.strokeStyle = CORE;
    ctx.lineWidth = Math.max(0.7, w * 0.28);
    ctx.beginPath();
    polyline(ctx);
    ctx.stroke();
    ctx.lineJoin = 'round';
    if (ptCount < 3) return;
    // Branches: off a bend, angled away from the bolt, kinked once. Three passes share their paths.
    for (let pass = 0; pass < 3; pass++) {
        ctx.beginPath();
        for (let k = 0; k < BRANCHES; k++) {
            const i = 1 + Math.floor(hash01(seed, 50 + k * 5) * (ptCount - 2));
            if (i >= ptCount - 1) continue;
            const sideSign = hash01(seed, 51 + k * 5) < 0.5 ? -1 : 1,
                spread = 0.5 + hash01(seed, 52 + k * 5) * 0.6,
                length = (7 + hash01(seed, 53 + k * 5) * 11) * ppu,
                kink = (hash01(seed, 54 + k * 5) - 0.5) * 1.2,
                d = Math.atan2(ptY[i + 1] - ptY[i - 1], ptX[i + 1] - ptX[i - 1]),
                a = d + sideSign * spread,
                x0 = ptX[i],
                y0 = ptY[i],
                x1 = x0 + Math.cos(a) * length * 0.55,
                y1 = y0 + Math.sin(a) * length * 0.55;
            if (pass === 2) {
                ctx.moveTo(x1, y1);
                ctx.lineTo(
                    x1 + Math.cos(a + kink) * length * 0.45,
                    y1 + Math.sin(a + kink) * length * 0.45,
                );
                continue;
            }
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            if (pass === 0)
                ctx.lineTo(
                    x1 + Math.cos(a + kink) * length * 0.45,
                    y1 + Math.sin(a + kink) * length * 0.45,
                );
        }
        if (pass === 0) {
            ctx.globalAlpha = alpha * 0.3;
            ctx.strokeStyle = GLOW;
            ctx.lineWidth = w * 0.8 + 2 * ppu;
        } else {
            ctx.globalAlpha = alpha * 0.85;
            ctx.strokeStyle = MAIN;
            ctx.lineWidth = Math.max(pass === 1 ? 0.6 : 0.4, w * (pass === 1 ? 0.4 : 0.22));
        }
        ctx.stroke();
    }
}

// Sparks jumping off the cotton (a small kinked line each, glow under main): two strokes for all of them.
function drawSparks(ctx, x, y, seed, clockMs, power, ppu) {
    const bucket = Math.floor(clockMs / SPARK_MS);
    for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        for (let k = 0; k < SPARKS; k++) {
            const s = seed * 131 + bucket * 31 + k * 7;
            if (hash01(s, 0) > 0.55 + 0.4 * (1 - power)) continue;
            const a = hash01(s, 1) * TAU,
                r0 = 10 * ppu,
                r1 = (16 + hash01(s, 2) * 6) * ppu,
                kink = (hash01(s, 3) - 0.5) * 1.4,
                rm = (r0 + r1) / 2;
            ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
            ctx.lineTo(
                x + Math.cos(a + kink * 0.2) * rm + Math.cos(a + 1.57) * kink * 3 * ppu,
                y + Math.sin(a + kink * 0.2) * rm + Math.sin(a + 1.57) * kink * 3 * ppu,
            );
            ctx.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
        }
        ctx.globalAlpha = pass ? 1 : 0.35;
        ctx.strokeStyle = pass ? MAIN : GLOW;
        ctx.lineWidth = (pass ? 1.1 : 3) * ppu;
        ctx.stroke();
    }
}

// Paints one cotton's lightning on main.js's 2D effect canvas. bolt (main.js fills and reuses it):
//   clockMs, ppu (screen pixels per world unit), seed (a stable number per unit)
//   points: x[0..count], y[0..count] — x[0], y[0] the cotton's bolt tip, then each link's body on screen
//   count (links drawn), linkSeed[k] and igniteMs[k] (when link k lit, on the clock) for the segment into point k + 1
//   hitAgeMs since the last damage tick (Infinity when none in this channel)
//   telegraph (0..1 while its cooldown's last TELEGRAPH_MS run with a target, else -1), channel (it channels now)
//   centerX, centerY (the cotton's body middle on screen, for the ring and the sparks)
//   fades: fadeCount, fadeAx/Ay/Bx/By[k] (a cut link's last ends on screen), fadeAtMs[k], fadeSeed[k]
function drawBolt(ctx, bolt) {
    const now = bolt.clockMs,
        ppu = bolt.ppu,
        w = WIDTH * ppu;
    ctx.save();

    // The telegraph: a ring tightening around the cotton and its first sparks.
    if (bolt.telegraph >= 0) {
        const k = bolt.telegraph;
        ctx.globalAlpha = 0.25 + 0.35 * k;
        ctx.strokeStyle = GLOW;
        ctx.lineWidth = 2 * ppu;
        ctx.beginPath();
        ctx.ellipse(
            bolt.centerX,
            bolt.centerY,
            (16 - 5 * k) * ppu,
            (16 - 5 * k) * ppu * 0.8,
            0,
            0,
            TAU,
        );
        ctx.stroke();
        drawSparks(ctx, bolt.centerX, bolt.centerY, bolt.seed, now, k, ppu);
    }

    // Cut links break into fading pieces: each sub-segment drops out by its hash as the fade runs.
    for (let f = 0; f < bolt.fadeCount; f++) {
        const age = now - bolt.fadeAtMs[f];
        if (age < 0 || age >= FADE_MS) continue;
        const p = age / FADE_MS,
            seed = bolt.fadeSeed[f],
            bucket = Math.floor(age / 40);
        boltPoints(bolt.fadeAx[f], bolt.fadeAy[f], bolt.fadeBx[f], bolt.fadeBy[f], seed, 1, ppu);
        boltWidths(w * (1 - 0.5 * p));
        ctx.lineCap = 'round';
        ctx.globalAlpha = (1 - p) * 0.3;
        ctx.strokeStyle = GLOW;
        ctx.lineWidth = 6 * ppu;
        ctx.beginPath();
        for (let i = 1; i < ptCount; i++) {
            if (hash01(seed + i * 31, bucket) < p * 1.15) continue;
            ctx.moveTo(ptX[i - 1], ptY[i - 1]);
            ctx.lineTo(ptX[i], ptY[i]);
        }
        ctx.stroke();
        ctx.globalAlpha = 1 - p;
        ctx.fillStyle = MAIN;
        ctx.beginPath();
        for (let i = 1; i < ptCount; i++) {
            if (hash01(seed + i * 31, bucket) < p * 1.15) continue;
            segmentPath(ctx, i, WIDTH * 0.25 * ppu);
        }
        ctx.fill();
    }

    if (bolt.channel) {
        // The live chain: a global flicker, each link re-shaped every RESHAPE_MS from its seed.
        const flicker = Math.floor(now / 71.4) % 3 === 0 ? 0.8 : 1,
            bucket = Math.floor(now / RESHAPE_MS);
        for (let k = 0; k < bolt.count; k++) {
            const age = now - bolt.igniteMs[k];
            if (age < 0) break;
            const ax = bolt.x[k],
                ay = bolt.y[k],
                bx = bolt.x[k + 1],
                by = bolt.y[k + 1],
                seed = bolt.linkSeed[k] + bucket * 977,
                cut = Math.min(1, age / STRETCH_MS),
                boost = age < BOOST_MS ? 1 + 0.8 * (1 - age / BOOST_MS) : 1;
            boltPoints(ax, ay, bx, by, seed, cut, ppu);
            drawBoltShape(ctx, seed, flicker, w * boost, ppu);
            if (cut < 1) continue;
            ctx.globalAlpha = TARGET_GLOW_ALPHA * flicker;
            ctx.fillStyle = GLOW;
            ctx.beginPath();
            ctx.arc(bx, by, TARGET_GLOW_R * ppu, 0, TAU);
            ctx.fill();
        }
        // Each damage tick flashes on the targets it lit (glow ring then a white core, all in two fills).
        const hit = bolt.hitAgeMs / HIT_MS;
        if (hit >= 0 && hit < 1) {
            for (let pass = 0; pass < 2; pass++) {
                ctx.beginPath();
                for (let k = 0; k < bolt.count; k++) {
                    if (now - bolt.igniteMs[k] < STRETCH_MS) break;
                    const x = bolt.x[k + 1],
                        y = bolt.y[k + 1],
                        r = (pass ? 5 * (1 - hit) + 2 : 7 + 9 * hit) * ppu;
                    ctx.moveTo(x + r, y);
                    ctx.arc(x, y, r, 0, TAU);
                }
                ctx.globalAlpha = pass ? 1 - hit : (1 - hit) * 0.5;
                ctx.fillStyle = pass ? CORE : GLOW;
                ctx.fill();
            }
        }
        drawSparks(ctx, bolt.centerX, bolt.centerY, bolt.seed + 7, now, 1, ppu);
    }
    ctx.restore();
}

// This unit's sprite contract (src/units/define-unit.js), loaded only by the page, never the Worker.
export const SPRITE = Object.freeze({
    load: loadCottonSpriteCanvas,
    renderer: CottonSpriteRenderer,
    portrait: cottonSpritePortrait,
    shell: { draw: 'drawAmmo', depthTest: true },
    groundY: 0,
    artScale: COTTON_ART_SCALE,
    chain: { drawBolt, igniteGapMs: IGNITE_GAP_MS, fadeMs: FADE_MS, telegraphMs: TELEGRAPH_MS },
});
