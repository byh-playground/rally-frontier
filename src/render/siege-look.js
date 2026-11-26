// How buildings move when they fire, are struck and fall (presentation only): a recoil spring on the cannon that
// fired, a shake and white flash on one that is hit, and a fallen one kept long enough to swell, burst and throw its
// own parts apart. main.js owns the events; BuildingArt draws the pose this gives it; the particles are
// CombatFxLook's.

const KICK_MS = 700,
    HIT_MS = 260,
    FLASH_MS = 55,
    // A building struck without pause flashes at most this often, so it keeps its own colours most of the time.
    FLASH_EVERY_MS = 400,
    // A building gone from the match stands as last drawn this long, until its fall is presented.
    PENDING_MS = 1000;
// A fallen building: it swells and shakes, then its parts fly and lie until they fade.
const SWELL_MS = 240,
    FADE_FROM_MS = 2300,
    WRECK_MS = 2900,
    GRAVITY = 640;
// Where each part is thrown, in world art units at sc() 1: [velocity x, velocity y (up is negative), how far
// below its start it lands, the angle it has turned when it lies]. `side` is the way the barrel pointed.
const THROWS = Object.freeze({
    base: Object.freeze([-34, -120, 20, 0.5]),
    cradle: Object.freeze([95, -170, 36, 1.9]),
    barrel: Object.freeze([-80, -250, 44, 0]),
});

// The flight of one thrown part after `s` seconds: its offset and turn; it stays where it lands.
function thrown([vx, vy, drop, rest], s) {
    const land = (-vy + Math.sqrt(vy * vy + 2 * GRAVITY * drop)) / GRAVITY,
        q = Math.min(s, land);
    return { x: vx * q, y: vy * q + 0.5 * GRAVITY * q * q, turn: (q / land) * rest };
}

export class SiegeLook {
    static swellMs = SWELL_MS;
    static wreckMs = WRECK_MS;

    constructor() {
        this.kicks = new Map();
        this.hits = new Map();
        this.wrecks = [];
        // The last drawn record of each building, so a fallen one can still be drawn.
        this.drawn = new Map();
        this.smokeAt = new Map();
        this.flashedAt = new Map();
    }

    reset() {
        this.flashedAt = new Map();
        this.kicks.clear();
        this.hits.clear();
        this.wrecks.length = 0;
        this.drawn.clear();
        this.smokeAt.clear();
    }

    // `dx`, `dy`: the way it fired; it is pushed back the other way.
    fired(id, clock, dx, dy) {
        this.kicks.set(id, { clock, dx, dy });
    }

    struck(id, clock, side, now) {
        const last = this.flashedAt.get(id),
            flash = last === undefined || now - last >= FLASH_EVERY_MS || now < last;
        if (flash) this.flashedAt.set(id, now);
        this.hits.set(id, { clock, side, flash });
    }

    // Records a standing building as it is drawn now. A newer one on the same ground replaces an older record.
    note(building, aim, now) {
        let record = this.drawn.get(building.id);
        if (!record) {
            for (const [id, other] of this.drawn)
                if (other.building.x === building.x && other.building.y === building.y)
                    this.drawn.delete(id);
            this.drawn.set(building.id, (record = { building, aim, seen: now }));
        }
        record.building = building;
        record.aim = aim;
        record.seen = now;
    }

    // The records of buildings no longer in `standing` (ids) whose fall has not been presented yet.
    pending(standing, now) {
        const out = [];
        for (const [id, record] of this.drawn) {
            if (standing.has(id)) continue;
            record.gone ??= now;
            if (now - record.gone >= PENDING_MS) this.drawn.delete(id);
            else out.push(record);
        }
        return out;
    }

    // `at` identifies the fallen building by where it stood. Returns its record, or null if it was never drawn.
    fell(x, y, clock) {
        for (const [id, record] of this.drawn)
            if (record.building.x === x && record.building.y === y) {
                this.drawn.delete(id);
                const wreck = { building: record.building, aim: record.aim, clock };
                this.wrecks.push(wreck);
                if (this.wrecks.length > 8) this.wrecks.shift();
                return wreck;
            }
        return null;
    }

    live() {
        let write = 0;
        for (const wreck of this.wrecks)
            if (!wreck.clock.expired && wreck.clock.ageMs < WRECK_MS) this.wrecks[write++] = wreck;
        this.wrecks.length = write;
        return this.wrecks;
    }

    // The pose of a standing building now: { body: { x, squash, lean }, flash }, in art units at sc() 1.
    pose(id) {
        let x = 0,
            squash = 0,
            flash = 0;
        const kick = this.kicks.get(id);
        if (kick) {
            const age = kick.clock.ageMs;
            if (kick.clock.expired || age >= KICK_MS) this.kicks.delete(id);
            else if (age >= 0) {
                const s = age / 1000;
                squash -= 0.14 * Math.exp(-s * 10) * Math.cos(s * 30);
                x -= kick.dx * 8 * Math.exp(-s * 9);
            }
        }
        const hit = this.hits.get(id);
        if (hit) {
            const age = hit.clock.ageMs;
            if (hit.clock.expired || age >= HIT_MS) this.hits.delete(id);
            else if (age >= 0) {
                const s = age / 1000;
                x += hit.side * 4 * Math.exp(-s * 16) * Math.sin(s * 70);
                squash += 0.06 * Math.exp(-s * 18);
                if (hit.flash && age < FLASH_MS) flash = 0.16;
            }
        }
        return { body: x || squash ? { x, squash, lean: 0 } : null, flash };
    }

    // The pose of a wreck at its age: { body, flash, fling: { part: { x, y, turn } } | null, alpha }.
    // `aim`: the barrel's direction when it stood; the thrown barrel comes to rest lying nearly flat.
    static wreckPose(age, aim) {
        if (age < SWELL_MS) {
            const u = Math.max(0, age) / SWELL_MS;
            return {
                body: {
                    x: 4 * Math.sin(age / 14),
                    squash: 0.18 * Math.sin(u * 9) * u + 0.08 * u,
                    lean: 0.09 * u * Math.sin(u * 14),
                },
                flash: u * 0.2,
                fling: null,
                alpha: 1,
            };
        }
        const s = (age - SWELL_MS) / 1000,
            tilt = Math.atan2(aim.dy, Math.abs(aim.dx)) * (aim.dx < 0 ? -1 : 1),
            flat = Math.PI * 2 * (aim.dx < 0 ? 1 : -1) - tilt + 0.14,
            barrel = [THROWS.barrel[0], THROWS.barrel[1], THROWS.barrel[2], flat];
        return {
            body: null,
            flash: 0,
            fling: {
                base: thrown(THROWS.base, s),
                cradle: thrown(THROWS.cradle, s),
                barrel: thrown(barrel, s),
            },
            alpha: age < FADE_FROM_MS ? 1 : 1 - (age - FADE_FROM_MS) / (WRECK_MS - FADE_FROM_MS),
        };
    }

    // Whether a badly damaged building should puff its next smoke now (`now`: presentation ms).
    smokeDue(id, now) {
        const last = this.smokeAt.get(id);
        if (last !== undefined && now - last >= 0 && now - last < 180) return false;
        this.smokeAt.set(id, now);
        return true;
    }
}
