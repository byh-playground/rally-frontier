import { FP } from '../core/config.js';
import { LaunchImpact } from './launch-impact.js';

// Air defense shares target priority and emergency deployment across units and buildings.
export class LaunchInterception {
    static target(sim, attacker, range, vision, lockedId = null) {
        const rangeSquared = range * range;
        let best = null,
            bestDistance = Infinity;
        for (const shell of sim.projectiles) {
            if (!shell.alive || !shell.payload || !(shell.hp > 0) || shell.side === attacker.side)
                continue;
            const distance = (shell.x - attacker.x) ** 2 + (shell.y - attacker.y) ** 2;
            if (distance > rangeSquared || !sim.canSeeCombatTarget(attacker.side, shell, vision))
                continue;
            if (shell.id === lockedId) return shell;
            if (sim.targetChoiceBetter(distance, shell.id, bestDistance, best)) {
                best = shell;
                bestDistance = distance;
            }
        }
        return best;
    }

    static hit(sim, attacker, shell, attack) {
        const { x, y } = shell;
        const amount = Math.min(shell.hp, Math.floor(attack));
        shell.hp -= amount;
        const destroyed = shell.hp === 0;
        const heightFP = Math.round(LaunchImpact.projectileHeight(sim, shell, x, y) * FP);
        sim.events.push({
            type: 'antiAirHit',
            side: attacker.side,
            targetSide: shell.side,
            sourceId: attacker.id,
            sourceType: attacker.type,
            fromX: attacker.x,
            fromY: attacker.y,
            x,
            y,
            heightFP,
            projectileId: shell.id,
            amount,
            destroyed,
        });
        if (destroyed) {
            sim.retireProjectile(shell, x, y);
            LaunchImpact.enqueue(sim, shell, x, y, heightFP, { emergencyDrop: true });
        }
    }
}
