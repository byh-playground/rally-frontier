// Blow and death effects of the units whose sprite contract declares `motion`: a bladed swing arc, an outlined
// spark, juice thrown away from the blow, and, on death, husk shards and a stain left on the ground. Every shape is
// a white mask in one small atlas, tinted per quad, so they go through the sprites' own GPU quad path (no new
// program during a match). Presentation only.
import { EffectObjectFactory } from './presentation-effects.js';

const CELL = 64;
// Atlas cells, in order. A `...Rim` cell is the same shape grown by a stroke, drawn first in a dark tint.
const SHAPES = Object.freeze([
    'star',
    'starRim',
    'drop',
    'dropRim',
    'shard',
    'shardRim',
    'arc',
    'arcRim',
    'splat',
]);
// The most live effects of each kind; the oldest give way.
const CAPS = Object.freeze({ spark: 48, spray: 70, slash: 48, shards: 40, stain: 90 });
const LIFE = Object.freeze({
    spark: 110,
    spray: 340,
    slash: 130,
    // Death effects start after the body's swell (popMs).
    popMs: 170,
    shards: 1500,
    stain: 4500,
});
const SLASH_RIM = Object.freeze([0.36, 0.23, 0.06, 1]),
    SLASH_FILL = Object.freeze([1, 0.98, 0.89, 1]),
    SPARK_RIM = Object.freeze([0.29, 0.13, 0.03, 1]),
    SPARK_FILL = Object.freeze([1, 0.99, 0.94, 1]);
const DROPS = 6,
    SHARDS = 7;

function trace(c, shape) {
    c.beginPath();
    if (shape === 'star') {
        for (let i = 0; i < 12; i++) {
            const a = (i * Math.PI) / 6,
                d = i % 2 ? 9 : i % 4 ? 18 : 26;
            c.lineTo(Math.cos(a) * d, Math.sin(a) * d);
        }
    } else if (shape === 'drop') c.ellipse(0, 0, 22, 8, 0, 0, Math.PI * 2);
    else if (shape === 'shard') {
        c.moveTo(-24, 0);
        c.quadraticCurveTo(0, -30, 24, 0);
        c.quadraticCurveTo(0, -4, -24, 0);
    } else if (shape === 'arc') {
        c.arc(-8, 4, 34, -1.6, 0.9);
        c.arc(-17, 8, 27, 0.9, -1.6, true);
    } else {
        for (let i = 0; i <= 12; i++) {
            const a = (i / 12) * Math.PI * 2,
                d = 13 + ((i * 7) % 5),
                mid = a - Math.PI / 12;
            if (i)
                c.quadraticCurveTo(
                    Math.cos(mid) * 21,
                    Math.sin(mid) * 21,
                    Math.cos(a) * d,
                    Math.sin(a) * d,
                );
            else c.moveTo(d, 0);
        }
        for (const [x, y, r] of [
            [24, -8, 4],
            [26, 10, 3],
            [-24, 12, 3],
            [18, 22, 2.5],
        ]) {
            c.moveTo(x + r, y);
            c.arc(x, y, r, 0, Math.PI * 2);
        }
    }
    c.closePath();
}

function atlasCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = CELL * SHAPES.length;
    canvas.height = CELL;
    const c = canvas.getContext('2d');
    c.fillStyle = c.strokeStyle = '#fff';
    c.lineJoin = c.lineCap = 'round';
    SHAPES.forEach((name, i) => {
        const rim = name.endsWith('Rim');
        c.save();
        c.translate(i * CELL + CELL / 2, CELL / 2);
        trace(c, rim ? name.slice(0, -3) : name);
        c.fill();
        if (rim) {
            c.lineWidth = 6;
            c.stroke();
        }
        c.restore();
    });
    return canvas;
}

const random = (seed, i) => {
    let h = Math.imul(seed ^ Math.imul(i + 1, 0x9e3779b1), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return h / 4294967296;
};
const shade = (color, k) => [color[0] * k, color[1] * k, color[2] * k, 1];
const tint = (color, mix) => [
    color[0] + (1 - color[0]) * mix,
    color[1] + (1 - color[1]) * mix,
    color[2] + (1 - color[2]) * mix,
    1,
];

export class CombatFxLook {
    static popMs = LIFE.popMs;
    static lifeMs = LIFE.popMs + LIFE.stain;

    constructor(context) {
        this.context = context;
        this.region = null;
        this.quads = null;
        this.lists = { spark: [], spray: [], slash: [], shards: [], stain: [] };
        this.matrix = new Float64Array(6);
        this.options = { matrix: this.matrix };
    }

    // Uploads the shape atlas (loading time, never on the first blow).
    prepare() {
        if (this.region) return;
        const canvas = atlasCanvas(),
            device = this.context.device,
            region = device.textureAtlas.allocate(canvas.width, canvas.height, {
                filter: 'linear',
            });
        device.textureAtlas.upload(region, canvas);
        const atlas = region.atlas,
            localRects = Float32Array.from([-0.5, -0.5, 1, 1]);
        this.region = region;
        this.quads = Object.fromEntries(
            SHAPES.map((name, i) => [
                name,
                {
                    uvRects: Float32Array.from([
                        (region.x + i * CELL) / atlas.width,
                        region.y / atlas.height,
                        CELL / atlas.width,
                        CELL / atlas.height,
                    ]),
                    localRects,
                },
            ]),
        );
    }

    release() {
        if (this.region) this.context.device.textureAtlas.release(this.region);
        this.region = null;
        this.reset();
    }

    reset() {
        for (const list of Object.values(this.lists)) list.length = 0;
    }

    add(kind, effect, clock, lifeMs) {
        const list = this.lists[kind];
        EffectObjectFactory.attachClock(effect, clock, lifeMs);
        // Tints are made once here, never per frame.
        const juice = [effect.juice[0], effect.juice[1], effect.juice[2], 1];
        effect.juice = juice;
        effect.rim = shade(juice, 0.36);
        effect.mid = tint(juice, 0.15);
        effect.bright = tint(juice, 0.6);
        list.push(effect);
        if (list.length > CAPS[kind]) list.shift();
    }

    // One landed blow. `at`: ground position of the struck body { x, y, side }, `size`: its screen size at sc() 1,
    // `dir`: unit screen vector from the attacker, `juice`: the struck body's colour.
    hit({ at, size, dir, juice, slash, clock, seed }) {
        const effect = { at, size, dir, juice, seed };
        this.add('spark', { ...effect }, clock, LIFE.spark);
        this.add('spray', { ...effect }, clock, LIFE.spray);
        if (slash) this.add('slash', { ...effect }, clock, LIFE.slash);
    }

    death({ at, size, dir, juice, stain, clock, seed }) {
        this.add('shards', { at, size, dir, juice, seed }, clock, LIFE.popMs + LIFE.shards);
        this.add('stain', { at, size, dir, juice: stain, seed }, clock, LIFE.popMs + LIFE.stain);
    }

    // Draws every live effect of a list: `paint(effect, ageMs, screenX, screenY, size)`.
    each(renderer, kind, lifeMs, bias, paint) {
        const list = this.lists[kind];
        let write = 0;
        for (const effect of list) {
            const clock = effect.clock,
                age = clock.ageMs;
            if (clock.expired || age >= lifeMs) continue;
            list[write++] = effect;
            if (age < 0 || !renderer.combatFxVisible(effect.at)) continue;
            const world = { x: effect.at.x, y: 0, z: effect.at.y },
                point = renderer.projectRenderWorldPosition(world);
            this.context.depth = renderer.spriteDepthForWorld(point.world, bias);
            paint(effect, age, point.x, point.y, effect.size * renderer.sc());
        }
        list.length = write;
    }

    quad(name, x, y, width, height, angle, color, alpha) {
        const m = this.matrix,
            cos = Math.cos(angle),
            sin = Math.sin(angle),
            options = this.options,
            shape = this.quads[name];
        m[0] = cos * width;
        m[1] = sin * width;
        m[2] = -sin * height;
        m[3] = cos * height;
        m[4] = x;
        m[5] = y;
        options.layer = this.region.layer;
        options.filter = this.region.filter;
        options.uvRects = shape.uvRects;
        options.localRects = shape.localRects;
        options.color = color;
        options.alpha = Math.max(0, Math.min(1, alpha));
        this.context.drawQuads(options);
    }

    begin(renderer) {
        const C = this.context;
        C.depthTest = !!renderer.passState.depthEnabled;
        C.depthWrite = false;
        C.depthFunc = renderer.passState.depthFunc || 'lequal';
    }

    end() {
        const C = this.context;
        C.depth = 0;
        C.depthTest = false;
        C.depthFunc = 'lequal';
    }

    active(...kinds) {
        return !!this.region && kinds.some((kind) => this.lists[kind].length);
    }

    // The stains, on the ground under every ring and body.
    drawGround(renderer) {
        if (!this.active('stain')) return;
        this.begin(renderer);
        this.each(renderer, 'stain', LIFE.popMs + LIFE.stain, 0.0002, (e, raw, x, y, s) => {
            const age = raw - LIFE.popMs;
            if (age < 0) return;
            const grow = Math.min(1, age / 90),
                fade = age > 3000 ? 1 - (age - 3000) / (LIFE.stain - 3000) : 1,
                width = (50 + random(e.seed, 1) * 18) * s * grow;
            this.quad(
                'splat',
                x + (random(e.seed, 2) - 0.5) * 18 * s + e.dir.x * 8 * s,
                y + (random(e.seed, 4) - 0.5) * 8 * s,
                width * (random(e.seed, 5) < 0.5 ? -1 : 1),
                width * 0.5,
                0,
                e.juice,
                fade * 0.65,
            );
        });
        this.end();
    }

    // Everything above the ground, after the bodies.
    drawAir(renderer) {
        if (!this.active('spark', 'spray', 'slash', 'shards')) return;
        this.begin(renderer);
        this.each(renderer, 'slash', LIFE.slash, 0.003, (e, age, x, y, s) => {
            const angle = Math.atan2(e.dir.y, e.dir.x),
                size = (46 + 12 * Math.min(1, age / 60)) * s,
                alpha = age < 50 ? 1 : 1 - (age - 50) / (LIFE.slash - 50),
                cx = x - e.dir.x * 12 * s,
                cy = y - 28 * s - e.dir.y * 12 * s,
                // The blade keeps cutting downward on either side.
                height = e.dir.x < 0 ? -size : size;
            this.quad('arcRim', cx, cy, size, height, angle, SLASH_RIM, alpha);
            this.quad('arc', cx, cy, size, height, angle, SLASH_FILL, alpha);
        });
        this.each(renderer, 'spray', LIFE.spray, 0.0032, (e, age, x, y, s) => {
            const t = age / 1000,
                life = LIFE.spray / 1000,
                base = Math.atan2(e.dir.y, e.dir.x),
                alpha = 1 - (t / life) ** 2,
                length = (9 * (1 - t / life) + 5) * s;
            for (let i = 0; i < DROPS; i++) {
                const a = base + (random(e.seed, i) - 0.5) * 1.7,
                    v = 90 + random(e.seed, i + 20) * 190,
                    vx = Math.cos(a) * v,
                    vy = Math.sin(a) * v * 0.55 - 90 - random(e.seed, i + 40) * 70,
                    px = x + (vx * t - e.dir.x * 14) * s,
                    py = y + (vy * t + 520 * t * t - 26) * s,
                    angle = Math.atan2(vy + 1040 * t, vx);
                this.quad('dropRim', px, py, length * 1.5, length, angle, e.rim, alpha);
                this.quad(
                    'drop',
                    px,
                    py,
                    length * 1.5,
                    length,
                    angle,
                    i % 3 ? e.mid : e.bright,
                    alpha,
                );
            }
        });
        this.each(renderer, 'spark', LIFE.spark, 0.0034, (e, age, x, y, s) => {
            const t = age / LIFE.spark,
                size = (28 + 20 * t) * s,
                angle = random(e.seed, 7) * 3,
                px = x - e.dir.x * 14 * s,
                py = y - 26 * s,
                alpha = 1 - t * 0.6;
            this.quad('starRim', px, py, size, size, angle, SPARK_RIM, alpha);
            this.quad('star', px, py, size, size, angle, SPARK_FILL, alpha);
        });
        this.each(renderer, 'shards', LIFE.popMs + LIFE.shards, 0.0031, (e, raw, x, y, s) => {
            const t = (raw - LIFE.popMs) / 1000;
            if (t < 0) return;
            const base = Math.atan2(e.dir.y, e.dir.x),
                alpha = t > 1 ? 1 - (t - 1) / 0.5 : 1,
                g = 620;
            for (let i = 0; i < SHARDS; i++) {
                const a = base + (random(e.seed, i + 60) - 0.5) * 3,
                    v = 50 + random(e.seed, i + 70) * 120,
                    up = 130 + random(e.seed, i + 80) * 110,
                    land = (up + Math.sqrt(up * up + 2 * g * 24)) / g,
                    q = Math.min(t, land),
                    px = x + Math.cos(a) * v * q * s,
                    py = y + (-24 + Math.sin(a) * v * 0.4 * q - up * q + 0.5 * g * q * q) * s,
                    angle = q * (random(e.seed, i) - 0.5) * 22,
                    size = (14 + random(e.seed, i + 90) * 10) * s;
                this.quad('shardRim', px, py, size, size, angle, e.rim, alpha);
                this.quad('shard', px, py, size, size, angle, i % 3 ? e.juice : e.bright, alpha);
            }
        });
        this.end();
    }
}
