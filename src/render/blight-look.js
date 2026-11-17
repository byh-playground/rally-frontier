// How a living unit under the blight (깜부기, a black smut; sim/blight.js `unit.blighted`) is marked. The body,
// silhouette and face stay as authored. The mark is particles: a few near-black violet soot motes rise from the head
// and shoulders, sway and fade, and every few seconds a small puff bursts from one shoulder. A broken dark violet
// ring lies outside the team ring. Nothing sticks to the body. When the unit is freed (`freeing` 0..1 over
// `freeMs`) the soot is blown off to one side and the ring widens and fades.
// Presentation only: every mote is a function of (unit id hash, display time), so the same tick draws the same
// picture and nothing is stored per mote. Not the corpse paint (dead-unit-look.js) and not a faction colour.
// Motes reuse the shared tintable atlas particle (effect art `thorn`) and the ring is one mesh on the team ring's
// pipeline, both prepared at boot: no new art, atlas, program or shader during a match.
import { HashUtil } from '../sim/map-generation.js';

const rgb = (hex, alpha = 1) => [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
    alpha,
];

const BLIGHT_LOOK = Object.freeze({
    colors: Object.freeze({
        // Motes: mostly soot, some dark violet, a rare dull magenta glint.
        soot: '#1a0f22',
        violet: '#3b2152',
        glint: '#8a4a96',
        ring: '#2a1140',
    }),
    // Being freed takes this long (the soot leaves, the ring widens and fades).
    freeMs: 700,
    // A unit whose state is already free keeps its mark this long at most while its `blightFreed` event has not
    // reached the display yet.
    eventWaitMs: 300,
    ringAlpha: 0.9,
    ringHalfPx: 1.25,
    // The ring's radius over the team ring's, how much wider it ends when freed, and its arcs (start, length in
    // degrees): three unequal dashes.
    ringScale: 1.42,
    ringFreeGrow: 0.35,
    arcs: Object.freeze([
        [8, 78],
        [128, 52],
        [222, 96],
    ]),
    // The emitting width of a body, in body half-heights (a species may give its own).
    width: Object.freeze({ default: 0.7, rice: 0.6, chestnut: 1, walnut: 0.85, dandelion: 0.4 }),
    motes: Object.freeze({
        // Motes rising at once, by the body's half height in view units (the 1x view is VIEW_W of them wide): 4 on
        // a soldier, more on a large body (walnut, coconut) and on a hero.
        counts: Object.freeze([
            [0, 4],
            [32, 6],
            [55, 8],
        ]),
        // One mote's life.
        lifeMs: Object.freeze([1500, 2300]),
        // Sizes are a share of the body's half height with a floor in CSS pixels, so a small soldier's soot is
        // never too small to see.
        size: 0.24,
        minSizePx: 4.5,
        // A body taller than this half height (view units) gets more motes, not larger ones: soot stays a powder.
        sizeHalfCap: 48,
        rise: 0.9,
        minRisePx: 14,
        sway: 0.12,
        minSwayPx: 2,
        alpha: 0.92,
        // The puff: every `everyMs` (each unit at its own moment) `count` motes burst from one shoulder for `ms`.
        puff: Object.freeze({ everyMs: 3200, ms: 600, count: 4, reach: 0.7, minReachPx: 11 }),
        // Freed: this many motes are swept off sideways and up, as far as `reach`.
        free: Object.freeze({ count: 9, reach: 1.7, minReachPx: 26 }),
    }),
});

function mesh(vertices, indices) {
    return {
        vertices: new Float32Array(vertices),
        indices: new Uint16Array(indices),
        strideFloats: 11,
        partCount: 1,
        morphCount: 0,
        nonScalingStroke: true,
    };
}
// The broken ring on a unit circle; the stroke width is in CSS pixels (as the team ring's).
function buildRing() {
    const vertices = [],
        indices = [];
    for (const [start, length] of BLIGHT_LOOK.arcs) {
        const steps = Math.max(2, Math.round(length / 14));
        for (let i = 0; i <= steps; i++) {
            const angle = ((start + (length * i) / steps) * Math.PI) / 180,
                x = Math.cos(angle),
                y = Math.sin(angle),
                at = vertices.length / 11;
            for (const offset of [BLIGHT_LOOK.ringHalfPx, -BLIGHT_LOOK.ringHalfPx])
                vertices.push(x, y, 1, 1, 1, 1, -y, x, 0, offset, 0);
            if (i) indices.push(at - 2, at, at + 1, at - 2, at + 1, at - 1);
        }
    }
    return mesh(vertices, indices);
}

// Three integers to a number in [0, 1), without building a string.
function chance(a, b, c) {
    const h = HashUtil.word(HashUtil.word(HashUtil.word(HashUtil.OFFSET, a), b), c);
    return HashUtil.finish(h) / 4294967296;
}
const easeOut = (t) => 1 - (1 - t) * (1 - t);

class BlightLook {
    static freeMs = BLIGHT_LOOK.freeMs;
    static eventWaitMs = BLIGHT_LOOK.eventWaitMs;
    constructor(context) {
        const { soot, violet, glint, ring } = BLIGHT_LOOK.colors;
        this.ringColor = rgb(ring);
        this.moteColors = [rgb(soot), rgb(violet), rgb(glint)];
        this.ring = context.createMesh(buildRing());
        this.matrix = new Float32Array(6);
    }
    // Boot: the ring mesh is uploaded and drawn once, so a match never prepares it.
    prepare(C) {
        C.drawMesh(this.ring);
    }
    // The emitting half width of a body whose half height is `half`.
    static halfWidth(type, half) {
        return half * (BLIGHT_LOOK.width[type] ?? BLIGHT_LOOK.width.default);
    }
    // The broken ring around the team ring (rx, ry: the team ring's radii on screen). `freeing` 0: whole.
    drawRing(C, x, y, rx, ry, seed, freeing) {
        const m = this.matrix,
            turn = chance(seed, 1, 0) * Math.PI * 2,
            grow = BLIGHT_LOOK.ringScale * (1 + BLIGHT_LOOK.ringFreeGrow * freeing),
            cos = Math.cos(turn),
            sin = Math.sin(turn);
        m[0] = rx * grow * cos;
        m[1] = ry * grow * sin;
        m[2] = -rx * grow * sin;
        m[3] = ry * grow * cos;
        m[4] = x;
        m[5] = y;
        C.forceColor = this.ringColor;
        C.globalAlpha = BLIGHT_LOOK.ringAlpha * (1 - freeing);
        C.drawMesh(this.ring, { transform: m });
    }
    // The motes of one body at `timeMs`. `art` is the shared particle (drawParticle(matrix, depth, color, alpha)).
    // (cx, cy): the body's middle on screen, half: its half height in canvas pixels, px: one CSS pixel, unit: one
    // view unit (so a threshold means the same body at any zoom and canvas size).
    drawMotes(art, depth, type, seed, cx, cy, half, px, unit, timeMs, freeing) {
        const spec = BLIGHT_LOOK.motes,
            halfW = BlightLook.halfWidth(type, half),
            base = Math.max(
                spec.minSizePx * px,
                Math.min(half, spec.sizeHalfCap * unit) * spec.size,
            );
        if (freeing > 0) {
            if (freeing >= 1) return;
            // Blown off: every mote leaves sideways and up in the unit's own wind direction.
            const wind = chance(seed, 3, 0) < 0.5 ? -1 : 1,
                reach = Math.max(spec.free.minReachPx * px, half * spec.free.reach),
                go = easeOut(freeing);
            for (let i = 0; i < spec.free.count; i++) {
                const r1 = chance(seed, 4, i),
                    r2 = chance(seed, 5, i),
                    r3 = chance(seed, 6, i),
                    angle = ((-38 + (r1 * 2 - 1) * 46) * Math.PI) / 180,
                    far = reach * (0.45 + 0.75 * r2) * go,
                    // It leaves from the body's upper outline, never from over the face.
                    from = ((-165 + 150 * r3) * Math.PI) / 180;
                this.mote(
                    art,
                    depth,
                    cx + Math.cos(from) * halfW * 0.9 + wind * Math.cos(angle) * far,
                    cy + Math.sin(from) * half * 0.85 + Math.sin(angle) * far,
                    base * (0.8 + 0.6 * r2) * (1 + 0.3 * freeing),
                    spec.alpha * (1 - freeing) ** 1.3,
                    r1,
                );
            }
            return;
        }
        let count = spec.counts[0][1];
        for (const [fromHalf, motes] of spec.counts) if (half >= fromHalf * unit) count = motes;
        const rise = Math.max(spec.minRisePx * px, half * spec.rise),
            sway = Math.max(spec.minSwayPx * px, half * spec.sway);
        for (let i = 0; i < count; i++) {
            const life = spec.lifeMs[0] + (spec.lifeMs[1] - spec.lifeMs[0]) * chance(seed, 7, i),
                at = timeMs + chance(seed, 8, i) * life,
                cycle = Math.floor(at / life),
                u = at / life - cycle,
                r1 = chance(seed, 10 + i, cycle),
                r2 = chance(seed, 20 + i, cycle),
                r3 = chance(seed, 30 + i, cycle),
                // Born on the body's upper outline (head and shoulders), never over the face.
                from = ((-165 + 150 * r1) * Math.PI) / 180,
                fadeOut = Math.min(1, Math.max(0, (u - 0.55) / 0.45));
            this.mote(
                art,
                depth,
                cx + Math.cos(from) * halfW * 0.9 + Math.sin(u * 7 * (0.7 + r2) + r1 * 6.28) * sway,
                cy + Math.sin(from) * half * 0.85 - rise * (0.75 + 0.5 * r3) * u,
                base * (0.6 + 0.75 * r3 * r3) * (0.9 + 0.25 * u),
                spec.alpha * Math.min(1, u / 0.12) * (1 - fadeOut * fadeOut),
                r3,
            );
        }
        // The puff.
        const puff = spec.puff,
            when = timeMs + chance(seed, 9, 0) * puff.everyMs,
            burst = Math.floor(when / puff.everyMs),
            t = (when - burst * puff.everyMs) / puff.ms;
        if (t >= 1) return;
        const side = chance(seed, 40, burst) < 0.5 ? -1 : 1,
            reach = Math.max(puff.minReachPx * px, half * puff.reach) * easeOut(t),
            ox = cx + side * halfW * 0.55,
            oy = cy - half * 0.55;
        for (let i = 0; i < puff.count; i++) {
            const r1 = chance(seed, 41 + i, burst),
                r2 = chance(seed, 51 + i, burst),
                angle = ((-90 + side * 25 + (r1 * 2 - 1) * 60) * Math.PI) / 180;
            this.mote(
                art,
                depth,
                ox + Math.cos(angle) * reach * (0.5 + 0.6 * r2),
                oy + Math.sin(angle) * reach * (0.5 + 0.6 * r2),
                base * (0.8 + 0.5 * r2) * (0.9 + 0.3 * t),
                spec.alpha * (1 - t * t),
                r1,
            );
        }
    }
    mote(art, depth, x, y, size, alpha, pick) {
        if (alpha <= 0.02) return;
        const m = this.matrix;
        m[0] = size;
        m[1] = 0;
        m[2] = 0;
        m[3] = size;
        m[4] = x;
        m[5] = y;
        art.drawParticle(m, depth, this.moteColors[pick < 0.62 ? 0 : pick < 0.93 ? 1 : 2], alpha);
    }
}

export { BLIGHT_LOOK, BlightLook };
