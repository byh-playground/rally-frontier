// Livelier motion from deformation only, for the units whose sprite contract declares `motion`
// (src/units/define-unit.js): the attack swing timed to the simulation's windup, a walk cycle driven by the distance
// travelled, and damped springs that lean, squash and shove the whole sprite about its ground point. Presentation
// only: it reads displayed state and never changes the simulation.

// The grain rig's fire clip (grain-rig.js): the blade is back at 280ms and has swung through at this key.
const SWING_END_MS = 605;
// One walk cycle (the rig's walk clip) per this many world units, so the feet follow the ground speed.
const WALK_CYCLE_MS = 480,
    STRIDE = 40,
    // A jump this long in one frame is a re-entry or a teleport, not a step.
    STRIDE_LIMIT = 80;
const SPRINGS = Object.freeze({
    lean: Object.freeze({ hz: 3.2, damp: 0.35 }),
    squash: Object.freeze({ hz: 5, damp: 0.28 }),
    // In rig-art pixels at the mockup's display scale (see `unit` in compose).
    push: Object.freeze({ hz: 4.5, damp: 0.4 }),
});
const WALK_LEAN = 0.16,
    SQUASH_LIMIT = 0.28,
    STEP_S = 1 / 120,
    // A longer gap (hidden, paused tab) restarts the springs at rest.
    REST_AFTER_MS = 250;

export class UnitMotionLook {
    // The fire clip time of a declared unit: the windup plays the backswing and swing so the blade lands on the
    // tick the simulation commits the hit, then the clip runs on from there. null: not attacking.
    static attackClipMs(combat, renderTick, contactAgeMs) {
        const start = combat?.attackWindupStartedAt,
            end = combat?.attackWindupUntil;
        if (end > start && renderTick >= start && renderTick < end)
            return ((renderTick - start) / (end - start)) * SWING_END_MS;
        return contactAgeMs >= 0 ? SWING_END_MS + contactAgeMs : null;
    }

    static createState() {
        return {
            lean: 0,
            leanV: 0,
            squash: 0,
            squashV: 0,
            push: 0,
            pushV: 0,
            at: null,
            moving: false,
            x: 0,
            z: 0,
            walked: 0,
        };
    }

    // Advances one unit's springs and walked distance to `now`. `heading` is the screen side it moves to (-1|0|1).
    static advance(state, now, x, z, moving, heading) {
        const gap = state.at === null ? Infinity : now - state.at;
        if (gap < 0 || gap > REST_AFTER_MS) {
            state.lean = state.leanV = state.squash = state.squashV = state.push = state.pushV = 0;
        } else {
            const step = Math.hypot(x - state.x, z - state.z);
            if (step < STRIDE_LIMIT) state.walked += step;
            // Setting off stretches the body, stopping squashes it.
            if (moving !== state.moving) state.squashV += moving ? -1.6 : 2.4;
            let left = gap / 1000;
            while (left > 0) {
                const dt = Math.min(STEP_S, left);
                left -= dt;
                this.spring(
                    state,
                    'lean',
                    'leanV',
                    moving ? WALK_LEAN * heading : 0,
                    SPRINGS.lean,
                    dt,
                );
                this.spring(state, 'squash', 'squashV', 0, SPRINGS.squash, dt);
                this.spring(state, 'push', 'pushV', 0, SPRINGS.push, dt);
            }
        }
        state.at = now;
        state.x = x;
        state.z = z;
        state.moving = moving;
    }

    static spring(state, value, velocity, target, { hz, damp }, dt) {
        const w = 2 * Math.PI * hz;
        state[velocity] += (w * w * (target - state[value]) - 2 * damp * w * state[velocity]) * dt;
        state[value] += state[velocity] * dt;
    }

    // Its own blow lands: a short lunge toward the target (`dir`: screen side).
    static strike(state, dir) {
        state.pushV += dir * 120;
        state.squashV -= 1.8;
    }

    // It is hit by a blow travelling to screen side `dir`.
    static struck(state, dir) {
        state.pushV += dir * 190;
        state.squashV += 3.2;
        state.leanV += dir * 3.5;
    }

    static walkMs(state) {
        return ((state.walked / STRIDE) * WALK_CYCLE_MS) % WALK_CYCLE_MS;
    }

    // Applies the springs to a sprite matrix [a, b, c, d, e, f] about the ground point (gx, gy) on screen.
    // `unit` is the screen size of one push step.
    static compose(m, gx, gy, state, unit) {
        const squash = Math.max(-SQUASH_LIMIT, Math.min(SQUASH_LIMIT, state.squash)),
            cos = Math.cos(state.lean),
            sin = Math.sin(state.lean),
            a = cos * (1 + squash),
            b = sin * (1 + squash),
            c = -sin * (1 - squash),
            d = cos * (1 - squash),
            m0 = m[0],
            m1 = m[1],
            m2 = m[2],
            m3 = m[3],
            tx = m[4] - gx,
            ty = m[5] - gy;
        m[0] = a * m0 + c * m1;
        m[1] = b * m0 + d * m1;
        m[2] = a * m2 + c * m3;
        m[3] = b * m2 + d * m3;
        m[4] = a * tx + c * ty + gx + state.push * unit;
        m[5] = b * tx + d * ty + gy;
    }
}
