// Campaign upgrade `interceptFan { shots, arcDegrees }` (해바라기씨 · 요격 부채):
// - 강화가 켜진 편의 연사(UnitBurstAttack)가 공중 표적(적 투입탄·나는 적)을 쏘는 발마다 씨앗이 모두 `shots`발 나간다.
//   가운데 한 발은 지금까지의 그 한 발이고, 나머지는 조준 방향 좌우 `arcDegrees` 부채꼴 안, 대공 사거리(burstAttack.
//   airRange) 안에 보이는 다른 공중 표적 가운데 가까운 순서로 하나씩 맞힌다(피해는 가운데 발과 같음,
//   LaunchInterception.hit). 표적이 없는 씨앗은 부채꼴 안으로 빗나간다(표시만). 지상 표적을 쏠 때는 그대로다.
// - 상태를 두지 않는다. 씨앗마다 `upgradeFanShot` 이벤트를 낸다(표시 전용, 맞힌 씨앗은 targetId 또는 projectileId).
import { CampaignUpgrades } from '../campaign-upgrades.js';
import { IndexList } from '../index-list.js';
import { LaunchInterception } from '../launch-interception.js';
import { UnitBurstAttack } from './unit-burst-attack.js';
import { UnitFlight } from './unit-flight.js';
import { FP } from '../../core/config.js';

const FLYER_QUERY = new IndexList();
// The extra seeds' targets of the shot being fired; read before the next call.
const PICKED = [];

export class UpgradeInterceptFan {
    // The burst unit just shot the air target `main` (a shell or a flying unit) for `damage`.
    static fire(sim, unit, main, definition, vision, damage) {
        const spec = CampaignUpgrades.effect(sim, unit.side, unit.type, 'interceptFan');
        if (!spec) return;
        const burst = unit.combat.burstAttack,
            range = definition.burstAttack.airRange,
            aimX = burst.aimX - unit.x,
            aimY = burst.aimY - unit.y,
            aim = Math.hypot(aimX, aimY) || 1,
            half = (spec.arcDegrees * Math.PI) / 360,
            extra = spec.shots - 1;
        PICKED.length = 0;
        for (let k = 0; k < extra; k++) {
            const target = this.next(sim, unit, main, vision, range, aimX / aim, aimY / aim, half);
            if (!target) break;
            PICKED.push(target);
        }
        for (let k = 0; k < extra; k++) {
            const target = PICKED[k],
                // A seed without a target leaves along its own place in the fan: evenly spread either side of the aim.
                turn =
                    (k % 2 ? 1 : -1) *
                    ((Math.floor(k / 2) + 1) / (Math.floor(extra / 2) + 1)) *
                    half,
                cos = Math.cos(turn),
                sin = Math.sin(turn);
            sim.events.push({
                type: 'upgradeFanShot',
                sourceId: unit.id,
                sourceType: unit.type,
                side: unit.side,
                fromX: unit.x,
                fromY: unit.y,
                fromHeightFP: Math.round(
                    (sim.world.terrain.surfaces.heightAt(unit.x, unit.y) + definition.size) * FP,
                ),
                x: target ? target.x : unit.x + aimX * cos - aimY * sin,
                y: target ? target.y : unit.y + aimX * sin + aimY * cos,
                heightFP: target
                    ? UnitBurstAttack.aimHeightFP(sim, target, 'projectile')
                    : burst.aimHeightFP,
                targetId: target && !target.payload ? target.id : null,
                projectileId: target?.payload ? target.id : null,
            });
            if (target) LaunchInterception.hit(sim, unit, target, damage);
        }
        PICKED.length = 0;
    }
    // The nearest visible air target inside the fan that is neither the main one nor picked already, or null.
    static next(sim, unit, main, vision, range, ux, uy, half) {
        const cos = Math.cos(half),
            rangeSquared = range * range;
        let best = null,
            bestDistance = Infinity;
        for (const shell of sim.projectiles) {
            if (!shell.alive || !shell.payload || !(shell.hp > 0) || shell.side === unit.side)
                continue;
            if (shell === main || PICKED.includes(shell)) continue;
            const dx = shell.x - unit.x,
                dy = shell.y - unit.y,
                distance = dx * dx + dy * dy;
            if (
                distance > rangeSquared ||
                dx * ux + dy * uy < cos * Math.sqrt(distance) ||
                !sim.canSeeCombatTarget(unit.side, shell, vision)
            )
                continue;
            if (sim.targetChoiceBetter(distance, shell.id, bestDistance, best)) {
                best = shell;
                bestDistance = distance;
            }
        }
        const count = sim.nearbyUnits(unit.x, unit.y, range, 1 - unit.side, FLYER_QUERY, true),
            items = FLYER_QUERY.items;
        for (let k = 0; k < count; k++) {
            const flyer = sim.units[items[k]];
            if (!flyer?.alive || !UnitFlight.airborne(flyer)) continue;
            if (flyer === main || PICKED.includes(flyer)) continue;
            const dx = flyer.x - unit.x,
                dy = flyer.y - unit.y,
                distance = dx * dx + dy * dy;
            if (
                distance > rangeSquared ||
                dx * ux + dy * uy < cos * Math.sqrt(distance) ||
                !sim.canSeeCombatTarget(unit.side, flyer, vision)
            )
                continue;
            if (sim.targetChoiceBetter(distance, flyer.id, bestDistance, best)) {
                best = flyer;
                bestDistance = distance;
            }
        }
        return best;
    }
}
