// Contract (HeroLandingStrike):
// - 영웅 포탄(payload.landingStrike)은 일반 착탄 충격(impact·splash)이 없다. 그 대신 영웅이 포탄에서 나와 땅에 닿는
//   순간(LaunchImpact.deploy) 한 번, 포탄이 닿은 자리에서 자기 범위 공격을 하고 자기 본진 쪽으로 빠진다.
// - 공격은 원 하나(가운데) 또는 가운데 하나와 `scatter.ring` 고리 위 `scatter.count`개의 원이고, 원마다 따로
//   `radius` 안의 지상 적 병력에게 `damage`(또는 영웅 레벨 공격 × `atkRatio`)를 준다. `knockback`(KnockbackRules.gain의 이름)이 있으면 피해 전에
//   영웅 몸무게로 밀어낸다. 처치는 영웅의 막타다(HeroGrowth).
// - 빠지기는 `retreat.motion`이 'roll'이면 영웅의 구르기(HeroRollAttack)를 본진 쪽으로 `distance`만큼, 'hop'이면
//   본진 쪽으로 뛰어 `distance`만큼 간다. 공격은 한 틱에 끝나므로 따로 저장할 상태가 없다.
import { FP } from '../../core/config.js';
import { BuildingDefinition } from '../../definitions/buildings.js';
import { KnockbackRules } from '../../definitions/knockback-rules.js';
import { LaunchImpactRules } from '../../definitions/launch-impact-rules.js';
import { UnitDefinition } from '../../definitions/units.js';
import { Knockback } from '../knockback.js';
import { HeroGrowth } from '../hero-growth.js';
import { HeroRollAttack } from './hero-roll-attack.js';

export class HeroLandingStrike {
    // The strike's circles: the middle one, then the ring starting straight away from the retreat.
    static points(strike, x, y, dx, dy) {
        const points = [{ x, y }],
            scatter = strike.scatter;
        if (!scatter) return points;
        const start = Math.atan2(-dy, -dx);
        for (let i = 0; i < scatter.count; i++) {
            const angle = start + (i * 2 * Math.PI) / scatter.count;
            points.push({
                x: Math.round((x + Math.cos(angle) * scatter.ring) * FP) / FP,
                y: Math.round((y + Math.sin(angle) * scatter.ring) * FP) / FP,
            });
        }
        return points;
    }

    // Unit direction from (x, y) to the side's main base; straight down the map when it has none or stands on it.
    static homeDirection(sim, side, x, y) {
        const base = sim.buildings.find(
            (b) => b.side === side && b.alive !== false && BuildingDefinition.isMainBase(b.type),
        );
        const dx = base ? base.x - x : 0,
            dy = base ? base.y - y : side === 0 ? 1 : -1,
            length = Math.hypot(dx, dy) || 1;
        return { dx: dx / length, dy: dy / length };
    }

    // One damage circle of a hero's landing (this strike, or the watermelon's hop landing): an optional shove from
    // the hero's body first, then the damage. Returns how many enemies it hit.
    static blast(sim, unit, { x, y, radius, damage, knockback, impactHeightFP }) {
        if (knockback)
            Knockback.area(sim, {
                side: unit.side,
                sourceId: unit.id,
                x,
                y,
                radius,
                impactHeightFP,
                mass: sim.mass(unit),
                speed: KnockbackRules.impactSpeed,
                gain: KnockbackRules.gain[knockback],
            });
        return sim.applyAreaDamage({
            sourceSide: unit.side,
            sourceType: unit.type,
            sourceEntityId: unit.id,
            x,
            y,
            radius,
            damage,
            damageClass: UnitDefinition.damageClass(unit.type),
            impactHeightFP,
        }).hits;
    }

    // A fixed `damage`, or `atkRatio` times the hero's attack at its level (HeroGrowth.atk).
    static damage(unit, strike) {
        return strike.atkRatio ? Math.floor(HeroGrowth.atk(unit) * strike.atkRatio) : strike.damage;
    }

    // The hero just came out of its shell at the landing point (x, y). `release` is the height it was let out at
    // and its vertical speed then, as LaunchImpact.deploy gives every released soldier.
    static land(sim, unit, strike, x, y, impactHeightFP, release) {
        const { dx, dy } = this.homeDirection(sim, unit.side, x, y);
        const damage = this.damage(unit, strike);
        const blasts = this.points(strike, x, y, dx, dy).map((point) => ({
            ...point,
            radius: strike.radius,
            hits: this.blast(sim, unit, {
                ...point,
                radius: strike.radius,
                damage,
                knockback: strike.knockback,
                impactHeightFP,
            }),
        }));
        sim.events.push({
            type: 'heroLandingStrike',
            side: unit.side,
            sourceId: unit.id,
            unit: unit.type,
            x,
            y,
            impactHeightFP,
            damage,
            hits: blasts.reduce((sum, blast) => sum + blast.hits, 0),
            blasts,
        });
        if (!unit.alive) return;
        const { motion, distance } = strike.retreat;
        if (motion === 'roll') {
            HeroRollAttack.retreat(sim, unit, dx, dy, distance);
            return;
        }
        // A hop back: the release lift, and the ground speed that carries the body `distance` before it settles.
        const mass = sim.mass(unit),
            lift = LaunchImpactRules.deploymentLift,
            speed = LaunchImpactRules.speedForDistance(distance, lift, sim.tps);
        sim.navigation.motion.applyImpulse(
            unit,
            {
                x: dx * speed * mass,
                y: dy * speed * mass,
                z: lift * mass + (release.vzFP / FP) * mass,
            },
            {
                kind: 'deploy',
                sourceId: unit.id,
                originX: unit.x,
                originY: unit.y,
                initialHeightFP: release.heightFP,
            },
        );
    }
}
