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
        // Freed: this many motes are swept off sideways and up, as far as `reach`. Units freed on one tick (a spore
        // sac's captives) share `crowd` units' worth of motes, never fewer than `minCount` each, so a freed crowd
        // is not covered in soot.
        free: Object.freeze({ count: 9, crowd: 4, minCount: 3, reach: 1.7, minReachPx: 26 }),
    }),
    // The spore sac (sim/spore-sac.js), a placeholder: a lumpy near-black violet pouch. Each lump is a disc
    // (x, y, radius in sac radii from the sac's middle, colour); the blight's soot rises from it like from a body.
    sac: Object.freeze({
        // The sac's middle stands this many radii above its ground point.
        lift: 0.8,
        shadow: Object.freeze([0.06, 0.03, 0.09, 0.32]),
        // The thread from the sac to each captive's feet (colour, width in view units).
        tether: Object.freeze([0.165, 0.067, 0.251, 0.6]),
        tetherWidth: 2,
        lumps: Object.freeze([
            [0, 0, 1.08, '#1a0f22'],
            [-0.62, 0.34, 0.6, '#1a0f22'],
            [0.66, 0.3, 0.56, '#1a0f22'],
            [0.1, -0.7, 0.52, '#1a0f22'],
            [0, 0, 1, '#2a1140'],
            [-0.6, 0.32, 0.52, '#2a1140'],
            [0.64, 0.28, 0.48, '#2a1140'],
            [0.1, -0.68, 0.44, '#2a1140'],
            [-0.26, -0.24, 0.52, '#3b2152'],
            [-0.36, -0.36, 0.2, '#8a4a96'],
            [0.42, 0.18, 0.14, '#3b2152'],
        ]),
    }),
    // The blight field's ground (sim/blight-field.js), a placeholder. Radii are in cells, colours are RGBA.
    field: Object.freeze({
        // Every blighted cell is one dark blot wide enough to close over its neighbours, with a smaller violet lump
        // and, on some cells, a dull glint: at a hashed place in the cell, so the ground reads as one stain.
        blot: 0.9,
        blotColor: Object.freeze([0.115, 0.055, 0.16, 0.94]),
        lump: Object.freeze({
            radius: 0.34,
            spread: 0.3,
            color: Object.freeze([0.23, 0.13, 0.32, 0.9]),
        }),
        glint: Object.freeze({
            chance: 0.22,
            radius: 0.11,
            spread: 0.36,
            color: Object.freeze([0.54, 0.29, 0.59, 0.85]),
        }),
        // A cell the field has just spread to swells up from a small blot over this long, under a violet flash.
        spreadMs: 700,
        spreadFrom: 0.25,
        spreadFlash: Object.freeze([0.62, 0.3, 0.72, 0.7]),
        // A cell fire has just purified glows as an ember for this long, then stays as a pale ash mark (a cell a
        // brazier kept clean has only the fainter mark).
        burnMs: 600,
        ember: Object.freeze([1, 0.52, 0.12, 0.9]),
        emberCore: Object.freeze([1, 0.86, 0.4, 0.9]),
        ash: Object.freeze({
            radius: 0.4,
            spread: 0.2,
            color: Object.freeze([0.3, 0.27, 0.24, 0.3]),
        }),
        keptAlpha: 0.16,
    }),
    // The spore cloud (sim/spore-cloud.js), a placeholder: soot drifting in on the wind to where blighted soldiers
    // are about to stand. Distances are world units.
    cloud: Object.freeze({
        // The wind blows along this unit vector on the ground (toward the player's end of the map and across it),
        // and the cloud starts `drift` upwind of its place and `lift` above the ground.
        wind: Object.freeze([-0.5, 0.866]),
        drift: 420,
        lift: 70,
        // Its body is `puffs` large dim motes and its soot `motes` small ones when it is thickest, `thin` of them
        // when it first shows. Each lives `lifeMs` and streams `streak` downwind while it does; sizes are a share
        // of the cloud's radius, alphas run from the thin cloud's to the thick one's.
        thin: 0.35,
        streak: 110,
        puffs: Object.freeze({
            count: 22,
            lifeMs: Object.freeze([2200, 3400]),
            size: Object.freeze([0.7, 1.25]),
            alpha: Object.freeze([0.22, 0.6]),
        }),
        motes: Object.freeze({
            count: 70,
            lifeMs: Object.freeze([1300, 2100]),
            size: Object.freeze([0.14, 0.42]),
            alpha: Object.freeze([0.4, 0.9]),
        }),
        // The ground it will settle on: a stain that darkens, inside a ring that closes in from `ringFrom` radii
        // as the arrival nears.
        stain: Object.freeze([0.115, 0.055, 0.16]),
        stainAlpha: Object.freeze([0.22, 0.6]),
        ring: Object.freeze([0.54, 0.29, 0.59]),
        ringAlpha: Object.freeze([0.45, 0.95]),
        ringFrom: 2,
        ringWidth: 4,
        ringSegments: 40,
    }),
    // The field's brazier, a placeholder. Radii are world units: a stone ring, its bowl, coals; a line marks the
    // ground it purifies. Lit, the coals glow, the ground inside the line is warm and a flame flickers.
    brazier: Object.freeze({
        stone: Object.freeze({ radius: 30, color: Object.freeze([0.2, 0.19, 0.18, 0.92]) }),
        bowl: Object.freeze({ radius: 22, color: Object.freeze([0.36, 0.33, 0.3, 1]) }),
        coal: Object.freeze({
            radius: 15,
            unlit: Object.freeze([0.1, 0.09, 0.09, 1]),
            lit: Object.freeze([1, 0.5, 0.1, 1]),
        }),
        reach: Object.freeze({
            width: 2,
            unlit: Object.freeze([1, 0.72, 0.3, 0.65]),
            lit: Object.freeze([1, 0.6, 0.18, 0.8]),
            // The line is this many straight pieces, and this many times as wide once lit.
            segments: 48,
            litWidth: 2,
        }),
        // The flame: tongues `width` wide and up to `height` tall (world units), swaying every `swayMs`.
        flame: Object.freeze({
            width: 13,
            height: 46,
            swayMs: 420,
            outer: Object.freeze([1, 0.45, 0.08, 0.95]),
            inner: Object.freeze([1, 0.85, 0.35, 0.95]),
        }),
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
    // How many motes each of `together` units freed on one tick blows off.
    static freeMotes(together) {
        const { count, crowd, minCount } = BLIGHT_LOOK.motes.free;
        return together <= crowd
            ? count
            : Math.max(minCount, Math.round((count * crowd) / together));
    }
    constructor(context) {
        this.sacLumps = BLIGHT_LOOK.sac.lumps.map(([x, y, r, color]) => [x, y, r, rgb(color)]);
        const { soot, violet, glint, ring } = BLIGHT_LOOK.colors;
        this.ringColor = rgb(ring);
        this.moteColors = [rgb(soot), rgb(violet), rgb(glint)];
        this.ring = context.createMesh(buildRing());
        this.matrix = new Float32Array(6);
        // One options record for every ring draw (nothing is allocated per ring).
        this.ringDraw = { transform: this.matrix };
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
        C.drawMesh(this.ring, this.ringDraw);
    }
    // The motes of one body at `timeMs`. `art` is the shared particle (drawParticle(matrix, depth, color, alpha)).
    // (cx, cy): the body's middle on screen, half: its half height in canvas pixels, px: one CSS pixel, unit: one
    // view unit (so a threshold means the same body at any zoom and canvas size). `freeMotes`: the motes a freed
    // unit blows off (BlightLook.freeMotes).
    drawMotes(
        art,
        depth,
        type,
        seed,
        cx,
        cy,
        half,
        px,
        unit,
        timeMs,
        freeing,
        freeMotes = BLIGHT_LOOK.motes.free.count,
    ) {
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
            for (let i = 0; i < freeMotes; i++) {
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
    // A spore cloud at `timeMs`, `thick` 0..1 (0 as its warning begins, 1 as its soldiers appear). (cx, cy): its
    // middle on screen now, (rx, ry): its radii in canvas pixels, (sx, sy): how far a mote streams downwind over
    // its life, in canvas pixels. Every mote is a function of (seed, time), as a body's soot is.
    drawCloud(art, depth, seed, cx, cy, rx, ry, sx, sy, timeMs, thick) {
        const spec = BLIGHT_LOOK.cloud,
            share = spec.thin + (1 - spec.thin) * thick;
        // The large dim motes first, so the small ones lie over them. A large one is never the glint colour.
        this.cloudLayer(
            art,
            depth,
            seed,
            cx,
            cy,
            rx,
            ry,
            sx,
            sy,
            timeMs,
            thick,
            share,
            spec.puffs,
            0.9,
        );
        this.cloudLayer(
            art,
            depth,
            seed + 1,
            cx,
            cy,
            rx,
            ry,
            sx,
            sy,
            timeMs,
            thick,
            share,
            spec.motes,
            1,
        );
    }
    cloudLayer(art, depth, seed, cx, cy, rx, ry, sx, sy, timeMs, thick, share, layer, colors) {
        const count = Math.round(layer.count * share),
            alpha = layer.alpha[0] + (layer.alpha[1] - layer.alpha[0]) * thick;
        for (let i = 0; i < count; i++) {
            const life =
                    layer.lifeMs[0] + (layer.lifeMs[1] - layer.lifeMs[0]) * chance(seed, 60, i),
                at = timeMs + chance(seed, 61, i) * life,
                cycle = Math.floor(at / life),
                u = at / life - cycle,
                r1 = chance(seed, 62 + i, cycle),
                r2 = chance(seed, 162 + i, cycle),
                r3 = chance(seed, 262 + i, cycle),
                // Its home in the cloud: even over the disc.
                far = Math.sqrt(r1) * 0.95,
                angle = r2 * Math.PI * 2,
                fadeOut = Math.min(1, Math.max(0, (u - 0.6) / 0.4));
            this.mote(
                art,
                depth,
                cx + Math.cos(angle) * far * rx + sx * (u - 0.6),
                cy + Math.sin(angle) * far * ry + sy * (u - 0.6) - ry * 0.6 * r3,
                rx * (layer.size[0] + (layer.size[1] - layer.size[0]) * r3 * r3),
                alpha * Math.min(1, u / 0.15) * (1 - fadeOut * fadeOut),
                r3 * colors,
            );
        }
    }
    // The spore sac at (x, y) on screen, `radius` canvas pixels: `disc(x, y, radius, colour)` draws one lump.
    drawSac(disc, x, y, radius) {
        for (const [dx, dy, r, color] of this.sacLumps)
            disc(x + dx * radius, y + dy * radius, r * radius, color);
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

// The blight field's ground on screen (sim/blight-field.js, the snapshot's `blightField`), a placeholder made of
// plain discs. It keeps which state each cell was last shown in and when that changed (the tick's time), so a cell the
// field spread to swells in and a purified one glows out; a cell's lump, glint and ash places are hashes of its grid
// position, so the same tick draws the same stain. Nothing is drawn per cell on its own: every disc goes into the
// ground pass's one triangle stream.
class BlightFieldLook {
    constructor() {
        this.cells = null;
        this.grid = -1;
        this.shown = new Uint8Array(0);
        this.from = new Uint8Array(0);
        this.changedAt = new Float64Array(0);
        // The cells that are not clean, in index order: marked[0 .. markedCount). Remade when a cell changes, so a
        // frame walks only the stained cells.
        this.marked = new Int32Array(0);
        this.markedCount = 0;
        this.color = [0, 0, 0, 0];
    }
    mark() {
        const shown = this.shown;
        if (this.marked.length < shown.length) this.marked = new Int32Array(shown.length);
        let count = 0;
        for (let i = 0; i < shown.length; i++) if (shown[i] !== CLEAN) this.marked[count++] = i;
        this.markedCount = count;
    }
    // The next grid followed starts unchanged (a match restarted or wound back).
    reset() {
        this.cells = null;
        this.grid = -1;
    }
    // Each new snapshot: notes the cells that changed since the last one, at `now` (the snapshot's own time on the
    // display clock). A new grid (another match) starts unchanged.
    follow(field, now) {
        const cells = field.cells;
        if (cells === this.cells) return;
        this.cells = cells;
        // One number for the grid's place and width (cells are 25 units, a map is a few hundred cells a side).
        const grid = (field.col0 * 4096 + field.row0) * 4096 + field.cols;
        if (grid !== this.grid || cells.length !== this.shown.length) {
            this.grid = grid;
            this.shown = Uint8Array.from(cells);
            this.from = Uint8Array.from(cells);
            this.changedAt = new Float64Array(cells.length).fill(-Infinity);
            this.mark();
            return;
        }
        let changed = false;
        for (let i = 0; i < cells.length; i++) {
            if (cells[i] === this.shown[i]) continue;
            this.from[i] = this.shown[i];
            this.shown[i] = cells[i];
            this.changedAt[i] = now;
            changed = true;
        }
        if (changed) this.mark();
    }
    tint(color, alpha) {
        const c = this.color;
        c[0] = color[0];
        c[1] = color[1];
        c[2] = color[2];
        c[3] = color[3] * alpha;
        return c;
    }
    // `disc(wx, wy, radius, colour)` draws a disc lying on the ground at a world point, `radius` world units.
    draw(field, now, disc) {
        if (field.cells !== this.cells) return;
        const look = BLIGHT_LOOK.field,
            { cellSize: size, col0, row0, cols } = field,
            { shown, from, changedAt, marked, markedCount } = this;
        // The blots first, so no lump is covered by the next cell's blot.
        for (let k = 0; k < markedCount; k++) {
            const i = marked[k];
            if (shown[i] !== BLIGHTED) continue;
            const col = i % cols,
                age = now - changedAt[i],
                grown =
                    age < look.spreadMs
                        ? look.spreadFrom +
                          (1 - look.spreadFrom) * easeOut(Math.max(0, age) / look.spreadMs)
                        : 1;
            disc(
                (col0 + col + 0.5) * size,
                (row0 + (i - col) / cols + 0.5) * size,
                size * look.blot * grown,
                look.blotColor,
            );
        }
        for (let k = 0; k < markedCount; k++) {
            const i = marked[k],
                state = shown[i],
                col = i % cols,
                gx = col0 + col,
                gy = row0 + (i - col) / cols,
                age = now - changedAt[i];
            if (state === BLIGHTED) {
                const spreading = age < look.spreadMs ? 1 - Math.max(0, age) / look.spreadMs : 0;
                disc(
                    (gx + 0.5 + (chance(gx, gy, 1) - 0.5) * look.lump.spread) * size,
                    (gy + 0.5 + (chance(gx, gy, 2) - 0.5) * look.lump.spread) * size,
                    size * look.lump.radius * (1 - spreading * 0.5),
                    look.lump.color,
                );
                if (spreading > 0)
                    disc(
                        (gx + 0.5) * size,
                        (gy + 0.5) * size,
                        size * look.blot * 0.7,
                        this.tint(look.spreadFlash, spreading),
                    );
                if (chance(gx, gy, 3) < look.glint.chance)
                    disc(
                        (gx + 0.5 + (chance(gx, gy, 4) - 0.5) * look.glint.spread) * size,
                        (gy + 0.5 + (chance(gx, gy, 5) - 0.5) * look.glint.spread) * size,
                        size * look.glint.radius,
                        look.glint.color,
                    );
                continue;
            }
            // Purified: the ash mark, and over it the ember while the burn is fresh.
            const x = (gx + 0.5 + (chance(gx, gy, 6) - 0.5) * look.ash.spread) * size,
                y = (gy + 0.5 + (chance(gx, gy, 7) - 0.5) * look.ash.spread) * size,
                burned = from[i] === BLIGHTED,
                burning = burned && age < look.burnMs ? 1 - Math.max(0, age) / look.burnMs : 0;
            disc(
                x,
                y,
                size * look.ash.radius,
                this.tint(
                    look.ash.color,
                    burned ? 1 - burning : look.keptAlpha / look.ash.color[3],
                ),
            );
            if (burning > 0) {
                disc(
                    x,
                    y,
                    size * look.blot * (0.55 + 0.45 * burning),
                    this.tint(look.ember, burning),
                );
                disc(x, y, size * look.blot * 0.45 * burning, this.tint(look.emberCore, burning));
            }
        }
    }
}
// The cell states of sim/blight-field.js (BlightField.CLEAN, BLIGHTED; anything else is purified), as the snapshot
// carries them.
const CLEAN = 0,
    BLIGHTED = 1;

export { BLIGHT_LOOK, BlightFieldLook, BlightLook };
