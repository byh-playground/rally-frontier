// Blow and death effects of the units whose sprite contract declares `motion`: a bladed swing arc, an outlined
// spark, juice thrown away from the blow, and, on death, husk shards and a stain left on the ground. Every shape is
// a white mask in one small atlas, tinted per quad, so they go through the sprites' own GPU quad path (no new
// program during a match). Presentation only.
import { EffectObjectFactory } from './presentation-effects.js';

const CELL = 64;
// Atlas cells, in order. White fills tint per quad; a dark outline baked into the cell stays dark under any tint,
// so a fading shape never turns into a dark blot (an outline drawn as a second quad showed through its fill).
const SHAPES = Object.freeze(['star', 'drop', 'shard', 'arc', 'splat', 'ring', 'chunk', 'puff']);
const OUTLINE = '#4a2c14';
// The most live effects of each kind; the oldest give way.
const CAPS = Object.freeze({
    spark: 48,
    spray: 70,
    slash: 48,
    thud: 36,
    shards: 40,
    stain: 90,
    burst: 24,
    boom: 24,
    chips: 60,
    puffs: 60,
    scorch: 12,
    shock: 16,
});
const LIFE = Object.freeze({
    spark: 130,
    spray: 340,
    slash: 150,
    thud: 240,
    // Death effects start after the body's swell (popMs).
    popMs: 170,
    burst: 220,
    shards: 1500,
    stain: 4500,
    chips: 1300,
    scorch: 3500,
    shock: 560,
});
// The smallest effect unit on a 540px wide canvas: below it the shapes turn into specks at the default zoom.
const MIN_UNIT = 0.68;
const SCORCH_FILL = Object.freeze([0.38, 0.3, 0.17, 1]),
    DUST_LIGHT = Object.freeze([0.96, 0.9, 0.76, 1]),
    SPARK_FILL = Object.freeze([1, 0.98, 0.86, 1]),
    SLASH_FILL = Object.freeze([1, 0.99, 0.92, 1]);
const DROPS = 7,
    SHARDS = 9;

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
    } else if (shape === 'chunk') {
        c.moveTo(-24, -10);
        c.lineTo(7, -20);
        c.lineTo(24, 7);
        c.lineTo(-10, 20);
    } else if (shape === 'puff') {
        c.arc(0, 0, 27, 0, Math.PI * 2);
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
    c.lineJoin = c.lineCap = 'round';
    SHAPES.forEach((name, i) => {
        c.save();
        c.translate(i * CELL + CELL / 2, CELL / 2);
        c.fillStyle = c.strokeStyle = '#fff';
        if (name === 'ring') {
            c.lineWidth = 5;
            c.beginPath();
            c.arc(0, 0, 27, 0, Math.PI * 2);
            c.stroke();
        } else {
            trace(c, name);
            if (name === 'arc') {
                // The blade's trail: solid and outlined toward the edge that cuts, thinning out only over the
                // third where the swing started.
                const trail = (rgb) => {
                    const gradient = c.createLinearGradient(0, -32, 0, 26);
                    gradient.addColorStop(0, `rgba(${rgb},0)`);
                    gradient.addColorStop(0.34, `rgba(${rgb},1)`);
                    return gradient;
                };
                c.strokeStyle = trail('74,44,20');
                c.lineWidth = 7;
                c.stroke();
                c.fillStyle = trail('255,255,255');
                c.fill();
                c.restore();
                return;
            }
            if (name !== 'splat' && name !== 'puff') {
                c.strokeStyle = OUTLINE;
                c.lineWidth = 6;
                c.stroke();
            }
            c.fill();
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
        this.lists = {
            spark: [],
            spray: [],
            slash: [],
            thud: [],
            shards: [],
            stain: [],
            burst: [],
            boom: [],
            chips: [],
            puffs: [],
            scorch: [],
            shock: [],
        };
        this.matrix = new Float64Array(6);
        this.options = { matrix: this.matrix };
        this.ringColor = [1, 1, 1, 1];
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
        if (effect.juice) {
            const juice = [effect.juice[0], effect.juice[1], effect.juice[2], 1];
            effect.juice = juice;
            effect.mid = tint(juice, 0.15);
            effect.bright = tint(juice, 0.6);
        }
        list.push(effect);
        if (list.length > CAPS[kind]) list.shift();
    }

    // One landed blow. `at`: ground position of the struck body { x, y, side }, `size`: effect unit at sc() 1,
    // `shift`: from that ground point toward the attacker's side of the body (effect units), `dir`: unit screen
    // vector from the attacker, `juice`: the struck body's colour.
    // `color`: only a blow that does not cut passes it; its spark is the larger, in the attacker's own colour.
    hit({ at, size, shift, dir, juice, color, clock, seed }) {
        const effect = { at, size, shift, dir, juice, seed };
        this.add('spark', { ...effect, color: color && tint(color, 0) }, clock, LIFE.spark);
        this.add('spray', { ...effect }, clock, LIFE.spray);
    }

    // A blade sweeping in front of the attacker, started just before its blow lands. `side`: screen side (-1|1).
    slash({ at, size, side, clock }) {
        this.add('slash', { at, size, side, shift: null }, clock, LIFE.slash);
    }

    // Where a smash lands: a flat ring thrown out over the ground under the struck body.
    thud({ at, size, shift, color, clock }) {
        const fill = tint(color, 0),
            edge = [color[0] * 0.45, color[1] * 0.45, color[2] * 0.45, 1];
        this.add('thud', { at, size, shift, fill, edge }, clock, LIFE.thud);
    }

    death({ at, size, dir, juice, stain, clock, seed }) {
        const effect = { at, size, shift: null, dir, seed };
        this.add('burst', { ...effect, juice }, clock, LIFE.popMs + LIFE.burst);
        this.add('shards', { ...effect, juice }, clock, LIFE.popMs + LIFE.shards);
        this.add('stain', { ...effect, juice: stain }, clock, LIFE.popMs + LIFE.stain);
    }

    // The pieces of buildings and earth (siege): `at` a ground position, `shift` from it in effect units.
    // A big outlined flash of `reach` units for `life` ms.
    boom({ at, size, shift, reach, life, clock, delay = 0, seed = 1 }) {
        this.add('boom', { at, size, shift, reach, life, delay, seed }, clock, delay + life);
    }

    // `count` chunks thrown toward `dir` (-1|1; 0 all round) that fall to `drop` units below and lie there.
    // `life`: how long the pieces stay once thrown.
    chips({ at, size, shift, dir, color, count, speed, drop, clock, delay = 0, life, seed }) {
        const effect = { at, size, shift, dir, juice: color, count, speed, drop, delay, seed };
        effect.life = life ?? LIFE.chips;
        this.add('chips', effect, clock, delay + effect.life);
    }

    // `count` round puffs of dust or smoke spreading `spread` units and rising `rise` units over `life` ms.
    puffs({ at, size, shift, color, count, spread, rise, reach, life, clock, delay = 0, seed }) {
        const effect = { at, size, shift, color, count, spread, rise, reach, life, delay, seed };
        this.add('puffs', effect, clock, delay + life);
    }

    // A dark ragged mark left on the ground.
    scorch({ at, size, clock, delay = 0, width = 90 }) {
        this.add('scorch', { at, size, shift: null, delay, width }, clock, delay + LIFE.scorch);
    }

    // A flat ring racing out over the ground to `reach` units.
    shock({ at, size, reach, clock, delay = 0 }) {
        this.add('shock', { at, size, shift: null, reach, delay }, clock, delay + LIFE.shock);
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
            const unit = Math.max(
                    effect.size * renderer.sc(),
                    (MIN_UNIT * renderer.canvas.width) / 540,
                ),
                shift = effect.shift;
            paint(
                effect,
                age,
                point.x + (shift ? shift.x * unit : 0),
                point.y + (shift ? shift.y * unit : 0),
                unit,
            );
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
        if (!this.active('stain', 'shards', 'scorch', 'chips')) return;
        this.begin(renderer);
        this.each(renderer, 'scorch', Infinity, 0.0001, (e, raw, x, y, s) => {
            const age = raw - e.delay;
            if (age < 0) return;
            const width = e.width * s * Math.min(1, 0.3 + age / 160),
                fade = age > 2600 ? 1 - (age - 2600) / (LIFE.scorch - 2600) : 1;
            this.quad('splat', x, y, width, width * 0.48, 0, SCORCH_FILL, fade * 0.45);
        });
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
                fade * 0.75,
            );
        });
        this.drawShards(renderer, true, -0.03);
        this.drawChips(renderer, true, -0.03);
        this.end();
    }

    // The shards in the air (`landed` false) or those that have come down.
    drawShards(renderer, landed, bias) {
        this.each(renderer, 'shards', LIFE.popMs + LIFE.shards, bias, (e, raw, x, y, s) => {
            const t = (raw - LIFE.popMs) / 1000;
            if (t < 0) return;
            const base = Math.atan2(e.dir.y, e.dir.x),
                alpha = t > 1 ? 1 - (t - 1) / 0.5 : 1,
                g = 620;
            for (let i = 0; i < SHARDS; i++) {
                const a = base + (random(e.seed, i + 60) - 0.5) * 3,
                    v = 50 + random(e.seed, i + 70) * 120,
                    up = 130 + random(e.seed, i + 80) * 110,
                    land = (up + Math.sqrt(up * up + 2 * g * 24)) / g;
                if (t >= land !== landed) continue;
                const q = Math.min(t, land),
                    px = x + Math.cos(a) * v * q * s,
                    py = y + (-24 + Math.sin(a) * v * 0.4 * q - up * q + 0.5 * g * q * q) * s,
                    angle = q * (random(e.seed, i) - 0.5) * 22,
                    size = (17 + random(e.seed, i + 90) * 11) * s;
                this.quad('shard', px, py, size, size, angle, i % 3 ? e.juice : e.bright, alpha);
            }
        });
    }

    // The chips in the air (`landed` false) or those lying on the ground.
    drawChips(renderer, landed, bias) {
        this.each(renderer, 'chips', Infinity, bias, (e, raw, x, y, s) => {
            const age = raw - e.delay;
            if (age < 0 || age >= e.life) return;
            const t = age / 1000,
                g = 640,
                alpha = age > e.life - 350 ? (e.life - age) / 350 : 1;
            for (let i = 0; i < e.count; i++) {
                const side = e.dir || (random(e.seed, i + 3) < 0.5 ? -1 : 1),
                    vx = side * e.speed * (0.25 + random(e.seed, i + 20)),
                    up = e.speed * (0.7 + random(e.seed, i + 40) * 1.4),
                    drop = e.drop * (0.5 + random(e.seed, i + 60)),
                    land = (up + Math.sqrt(up * up + 2 * g * drop)) / g;
                if (t >= land !== landed) continue;
                const q = Math.min(t, land),
                    size = (7 + random(e.seed, i + 80) * 8) * s;
                this.quad(
                    'chunk',
                    x + vx * q * s,
                    y + (-up * q + 0.5 * g * q * q) * s,
                    size,
                    size,
                    q * (random(e.seed, i + 90) - 0.5) * 16,
                    e.juice,
                    alpha,
                );
            }
        });
    }

    // Everything above the ground, over every body: a blow or a death in the back row must still be seen.
    drawAir(renderer) {
        if (
            !this.active(
                'spark',
                'spray',
                'slash',
                'thud',
                'shards',
                'burst',
                'boom',
                'chips',
                'puffs',
                'shock',
            )
        )
            return;
        this.begin(renderer);
        this.context.depthTest = false;
        this.each(renderer, 'slash', LIFE.slash, 0.003, (e, age, x, y, s) => {
            // The blade travels from over the shoulder to the ground in front, growing as it goes.
            const t = Math.min(1, age / 95),
                swept = 1 - (1 - t) * (1 - t),
                fade = age < 105 ? 1 : 1 - (age - 105) / (LIFE.slash - 105);
            const angle = e.side * (-1.35 + 2.1 * swept),
                size = (32 + 14 * swept) * s;
            this.quad(
                'arc',
                x + e.side * 26 * s,
                y - 22 * s,
                size * e.side,
                size,
                angle,
                SLASH_FILL,
                fade,
            );
        });
        this.each(renderer, 'thud', LIFE.thud, 0.0033, (e, age, x, y, s) => {
            const t = age / LIFE.thud,
                eased = 1 - (1 - t) * (1 - t),
                width = (26 + 62 * eased) * s,
                alpha = 1 - t * t;
            // Two passes: a wider dark edge under the bright one, so it reads on grass.
            this.quad('ring', x, y, width * 1.12, width * 0.52, 0, e.edge, alpha * 0.8);
            this.quad('ring', x, y - 1.5 * s, width, width * 0.46, 0, e.fill, alpha);
        });
        this.each(renderer, 'burst', LIFE.popMs + LIFE.burst, 0.0033, (e, raw, x, y, s) => {
            const age = raw - LIFE.popMs;
            if (age < 0) return;
            const t = age / LIFE.burst,
                ring = (34 + 70 * t) * s,
                color = this.ringColor;
            color[0] = e.bright[0];
            color[1] = e.bright[1];
            color[2] = e.bright[2];
            this.quad('ring', x, y - 24 * s, ring, ring * 0.8, 0, color, 0.9 * (1 - t));
            if (t < 0.5) {
                const size = (58 + 30 * t) * s;
                this.quad('star', x, y - 26 * s, size, size, e.seed % 3, SPARK_FILL, 1 - t);
            }
        });
        this.each(renderer, 'spray', LIFE.spray, 0.0032, (e, age, x, y, s) => {
            const t = age / 1000,
                life = LIFE.spray / 1000,
                base = Math.atan2(e.dir.y, e.dir.x),
                alpha = 1 - (t / life) ** 2,
                length = (11 * (1 - t / life) + 7) * s;
            for (let i = 0; i < DROPS; i++) {
                const a = base + (random(e.seed, i) - 0.5) * 1.7,
                    v = 90 + random(e.seed, i + 20) * 190,
                    vx = Math.cos(a) * v,
                    vy = Math.sin(a) * v * 0.55 - 90 - random(e.seed, i + 40) * 70,
                    px = x + vx * t * s,
                    py = y + (vy * t + 520 * t * t - 26) * s,
                    angle = Math.atan2(vy + 1040 * t, vx);
                this.quad(
                    'drop',
                    px,
                    py,
                    length * 1.6,
                    length * 1.2,
                    angle,
                    i % 3 ? e.mid : e.bright,
                    alpha,
                );
            }
        });
        this.each(renderer, 'spark', LIFE.spark, 0.0034, (e, age, x, y, s) => {
            const t = age / LIFE.spark,
                size = (32 + 22 * t) * s * (e.color ? 1.3 : 1),
                alpha = t < 0.6 ? 1 : (1 - t) / 0.4,
                // A blunt blow lands low on the body.
                lift = e.color ? 16 : 26;
            this.quad(
                'star',
                x,
                y - lift * s,
                size,
                size,
                e.juice[0] * 3,
                e.color || SPARK_FILL,
                alpha,
            );
        });
        this.drawShards(renderer, false, 0.0031);
        this.each(renderer, 'shock', Infinity, 0.0031, (e, raw, x, y, s) => {
            const age = raw - e.delay;
            if (age < 0 || age >= LIFE.shock) return;
            const t = age / LIFE.shock,
                width = (36 + 2 * e.reach * (1 - (1 - t) ** 2)) * s;
            this.quad('ring', x, y, width, width * 0.5, 0, DUST_LIGHT, 0.9 * (1 - t));
        });
        this.each(renderer, 'puffs', Infinity, 0.0032, (e, raw, x, y, s) => {
            const age = raw - e.delay;
            if (age < 0 || age >= e.life) return;
            const t = age / e.life,
                out = 1 - (1 - t) ** 2,
                size = e.reach * (0.5 + out) * s;
            for (let i = 0; i < e.count; i++) {
                const a = ((i + random(e.seed, i)) / e.count) * Math.PI * 2,
                    far = e.spread * out * (0.6 + random(e.seed, i + 11) * 0.6) * s;
                this.quad(
                    'puff',
                    x + Math.cos(a) * far,
                    y + Math.sin(a) * far * 0.5 - e.rise * t * s,
                    size,
                    size,
                    0,
                    e.color,
                    0.72 * (1 - t),
                );
            }
        });
        this.drawChips(renderer, false, 0.0033);
        this.each(renderer, 'boom', Infinity, 0.0034, (e, raw, x, y, s) => {
            const age = raw - e.delay;
            if (age < 0 || age >= e.life) return;
            const t = age / e.life,
                size = e.reach * (1 + t) * s;
            this.quad('star', x, y, size, size, e.seed % 3, SPARK_FILL, 1 - t * 0.6);
        });
        this.end();
    }
}
