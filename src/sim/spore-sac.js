// The blight's spore sac (포자 주머니): an enemy building (BuildingDefinition 'spore-sac', health 100) that does
// not attack. A blighted stage declares its sacs (campaign.js `sporeSacs: [{ x, y, captives: [{ type, count }] }]`)
// and each stands from the first tick with its captives around it: blighted soldiers bound to that sac.
// `unit.sporeSac` (the sac's id) is the only record of the binding and exists exactly while the sac stands, so
// `SporeSac.bound(unit)` is one cell read. A bound soldier takes no part in the fight: it does not move, pick a
// target, attack, capture or build, nobody targets it, and no hit, area damage, landing shock, sustained damage,
// knockback or body contact hurts or moves it. The exclusions sit at the shared entry points (the unit's turn in
// StrategySim.stepSimulation, canTargetUnit / isHostileCombatUnit / canSeeCombatTarget, applyDamage, capture and
// construction presence, UnitMotion.locked and the contact commit, LaunchRules.population), not per unit type.
// When the sac is destroyed (StrategySim.destroyBuilding) every living captive is freed and joins the other side
// (Blight.convert), wherever it stands. A blighted soldier bound to no sac and every hero stay as they are. A
// freed soldier is nobody's kill: no hero growth, no kill count.
import { BuildingDefinition } from '../definitions/buildings.js';
import { UnitDefinition } from '../definitions/units.js';
import { Blight } from './blight.js';
import { Building } from './entities.js';
import { LaunchRules } from './launch-rules.js';

const TYPE = 'spore-sac';

export class SporeSac {
    // Is this unit bound to a standing spore sac?
    static bound(unit) {
        return unit.sporeSac !== undefined;
    }

    // A soldier a sac can hold: any card's soldier but a hero, whose deployment slot belongs to its side.
    static canBind(type) {
        return !!UnitDefinition.get(type) && !LaunchRules.isHeroType(type);
    }

    // The stage's declared sacs, checked: only a blighted stage has them, each with a place and its captives.
    static declared(sim) {
        const sacs = sim.rules.campaign?.sporeSacs;
        if (sacs === undefined) return [];
        if (!Blight.declared(sim))
            throw new Error('포자 주머니는 감염(blight: true)을 선언한 판에만 둘 수 있습니다.');
        if (!Array.isArray(sacs) || !sacs.length)
            throw new Error('포자 주머니 선언은 비어 있지 않은 목록이어야 합니다.');
        for (const sac of sacs) {
            if (
                !Number.isFinite(sac?.x) ||
                !Number.isFinite(sac?.y) ||
                !Array.isArray(sac.captives)
            )
                throw new Error('포자 주머니 선언에는 x, y와 captives 목록이 필요합니다.');
            for (const group of sac.captives)
                if (
                    !this.canBind(group?.type) ||
                    !Number.isSafeInteger(group.count) ||
                    group.count < 1
                )
                    throw new Error(
                        `포자 주머니에 묶을 수 없는 병사 선언입니다: ${group?.type} × ${group?.count}`,
                    );
        }
        return sacs;
    }

    // Match start (StrategySim constructor): every declared sac and its captives.
    static initialize(sim) {
        for (const sac of this.declared(sim)) this.place(sim, sac);
    }

    // One sac at (x, y) for the blight's side, its captives in rings around it: the first `ringRadius` out, each
    // next one `spacing` farther, soldiers `spacing` apart.
    static place(sim, { x, y, captives }) {
        const d = BuildingDefinition.get(TYPE),
            spec = d.sporeSac,
            sac = sim.addBuilding(
                new Building({
                    id: 'spore-sac-' + ++sim.seq,
                    type: TYPE,
                    side: Blight.ENEMY_SIDE,
                    x,
                    y,
                    hp: d.hp,
                    maxHp: d.hp,
                }),
            );
        sim.releaseUnitsInside(sac);
        let total = 0;
        for (const group of captives) total += group.count;
        let radius = spec.ringRadius,
            placed = 0,
            inRing = 0,
            ringCount = 0;
        for (const { type, count } of captives)
            for (let i = 0; i < count; i++) {
                if (inRing === ringCount) {
                    if (placed) radius += spec.spacing;
                    ringCount = Math.min(
                        total - placed,
                        Math.floor((2 * Math.PI * radius) / spec.spacing),
                    );
                    inRing = 0;
                }
                const angle = (2 * Math.PI * inRing) / ringCount;
                this.bind(
                    sim,
                    sac,
                    sim.spawnUnit(
                        sac.side,
                        type,
                        x + Math.cos(angle) * radius,
                        y + Math.sin(angle) * radius,
                    ),
                );
                inRing++;
                placed++;
            }
        return sac;
    }

    // Binds a blighted soldier of the sac's side to it, where it stands.
    static bind(sim, sac, unit) {
        if (!this.canBind(unit.type) || unit.side !== sac.side || !Blight.is(unit))
            throw new Error(`포자 주머니에 묶을 수 없는 병사입니다: ${unit.type}`);
        unit.sporeSac = sac.id;
    }

    // The sac was destroyed: every captive is unbound and the living ones are freed and join the side the sac
    // stood against, in unit order.
    static burst(sim, sac) {
        const side = 1 - sac.side;
        for (const unit of sim.units) {
            if (unit.sporeSac !== sac.id) continue;
            delete unit.sporeSac;
            if (unit.alive) Blight.convert(sim, unit, side);
        }
    }
}
