import { FP } from '../core/config.js';
import { LaunchImpactRules } from '../definitions/launch-impact-rules.js';
import { LaunchImpact } from './launch-impact.js';

// Uses the same physical motion as other impulses; the unit owns the leap state.
export class UnitLeapAttack {
    // Ordinary ground collisions keep their existing policy. A leaping body only
    // collides with a body whose actual vertical interval overlaps its own.
    static separated(sim, a, b) {
        if (a.leapAttack?.phase !== 'airborne' && b.leapAttack?.phase !== 'airborne') return false;
        const bottom = (u) =>
            sim.world.terrain.surfaces.heightAt(u.x, u.y) + (u.impactMotion?.heightFP || 0) / FP;
        const az = bottom(a),
            bz = bottom(b);
        return az >= bz + 2 * sim.unitRadius(b.type) || bz >= az + 2 * sim.unitRadius(a.type);
    }
    static start(sim, unit, target, spec, attackDistance) {
        const state = unit.leapAttack;
        const dx = target.x - unit.x;
        const dy = target.y - unit.y;
        const distance = Math.hypot(dx, dy);
        if (
            !state ||
            state.phase !== 'ready' ||
            sim.tick < state.cooldownUntil ||
            unit.impactMotion ||
            !target.alive ||
            distance <= attackDistance ||
            distance > attackDistance + spec.range
        )
            return false;
        // Aim short of the target so physical contact remains authoritative.
        const travel = Math.max(
            0,
            distance - sim.interactionDistance(unit, target, 'combat-contact'),
        );
        const flightSeconds = (2 * spec.lift) / LaunchImpactRules.gravity;
        const speed = travel / flightSeconds;
        state.phase = 'launchPending';
        state.velocityX = (dx / distance) * speed;
        state.velocityY = (dy / distance) * speed;
        unit.combat.cancelWindup();
        return true;
    }

    // Commit impulses after collision so XYZ integration starts together. Report completed landings.
    static flush(sim, unit, spec, damage) {
        const state = unit.leapAttack;
        if (!state || !unit.alive) return;
        if (state.phase === 'landPending') {
            this.land(sim, unit, spec, damage);
            return true;
        }
        if (state.phase !== 'launchPending') return;
        const mass = sim.mass(unit);
        sim.navigation.motion.applyImpulse(
            unit,
            {
                x: state.velocityX * mass,
                y: state.velocityY * mass,
                z: spec.lift * mass,
            },
            { kind: 'leap', sourceId: unit.id },
        );
        state.phase = 'airborne';
        state.startTick = sim.tick;
        delete state.velocityX;
        delete state.velocityY;
    }

    static update(sim, unit) {
        const state = unit.leapAttack;
        if (!state || state.phase !== 'airborne') return false;
        const motion = unit.impactMotion;
        if (sim.tick === state.startTick || (motion && (motion.heightFP > 0 || motion.vzFP > 0)))
            return true;
        state.phase = 'landPending';
        return true;
    }

    static land(sim, unit, spec, damage) {
        const state = unit.leapAttack;
        state.phase = 'ready';
        state.cooldownUntil = sim.tick + sim.msTicks(spec.cooldownMs);
        const impact = spec.impact;
        if (!impact) return;
        const heightFP = Math.round(sim.world.terrain.surfaces.heightAt(unit.x, unit.y) * FP);
        sim.withNearbyUnits(
            unit.x,
            unit.y,
            impact.radius + sim.maxUnitRadius,
            1 - unit.side,
            (indices) => {
                for (const index of indices) {
                    const target = sim.units[index];
                    if (
                        !target?.alive ||
                        target.side === unit.side ||
                        !sim.canAttackEntity(unit.type, target)
                    )
                        continue;
                    if (
                        LaunchImpact.distanceToBody(sim, target, unit.x, unit.y, heightFP)
                            .surfaceDistance > impact.radius
                    )
                        continue;
                    LaunchImpact.start(sim, target, {
                        dx: target.x - unit.x,
                        dy: target.y - unit.y,
                        speed: impact.knockbackSpeed,
                        lift: impact.knockbackLift,
                        sourceId: unit.id,
                        originX: unit.x,
                        originY: unit.y,
                    });
                    sim.applyDamage(
                        unit.side,
                        unit.type,
                        target,
                        false,
                        Math.floor(damage * impact.damageScale),
                        unit.id,
                    );
                }
            },
        );
        sim.events.push({
            type: 'leapLand',
            side: unit.side,
            sourceId: unit.id,
            x: unit.x,
            y: unit.y,
            radius: impact.radius,
        });
    }
}
