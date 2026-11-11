// One knockback for every attack (Knockback in src/sim/knockback.js). Every hit is a body of mass M striking at
// speed v: the struck body of mass m takes J = (1 + restitution)·v·M·m/(M + m)·gain·strength, J/m along the
// ground and liftRatio of that upward, so every knockback leaves at the same angle and heavier targets fly less.
// An attack only says which body hit (its mass and speed) and what kind of hit it was (gain).
import { BASIC_MELEE } from '../units/baseline.js';

class KnockbackRules {
    // The bounce of a hit; the walnut's contact exchange reads the same value.
    static restitution = 0.5;
    // Lift per ground speed of every knockback: about 32 degrees, the walnut's launch angle.
    static liftRatio = 0.625;
    // How hard each kind of hit throws:
    // - roll: a rolling body (walnut, watermelon's roll), three times the plain exchange.
    // - area: a body landing on an area (a launch shell, a leap's landing).
    // - basic: a repeated basic attack (acorn's and watermelon's spin).
    // - burst: an explosion (popcorn's self-destruct, corn's egg); a small light body that bursts throws
    //   twice what its mass alone would.
    // - splash: the shock that comes with a damage area (watermelon's hop landing, its basic attack's
    //   splash), a quarter of an area hit.
    static gain = Object.freeze({ roll: 3, area: 1, basic: 1, burst: 2, splash: 0.25 });
    // An area hit fades with the distance d from its centre to max(edgeStrength, 1 - d / reach).
    static edgeStrength = 0.25;
    // A swinging arm: a plain soldier's walk times four, the walnut's top speed.
    static swingSpeed = BASIC_MELEE.speed * 4;
    // A shell, an explosion or a shockwave meeting the ground.
    static impactSpeed = 400;

    // The impulse a body of `mass` striking at `speed` gives a target of `targetMass`.
    static impulse(mass, speed, targetMass, gain, strength = 1) {
        return (
            (1 + this.restitution) *
            speed *
            ((mass * targetMass) / (mass + targetMass)) *
            gain *
            strength
        );
    }
    // The strength of an area hit at `distance` from its centre, for a target it reaches at `reach`.
    static strength(distance, reach) {
        return Math.max(this.edgeStrength, 1 - distance / reach);
    }
}

export { KnockbackRules };
