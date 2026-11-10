// A potato roots where it landed and stands up as a forward cannon (Unit Definition growsCannon).
// Unit.cannonTick, set when the soldier spawns, is the only rooting state: the tick the cannon appears.
// Until then the soldier neither moves nor attacks and can be hit; a soldier that dies first leaves nothing.
// The cannon is an ordinary launch building whose health drains from the moment it stands
// (Building Definition decay); Building.decayStartTick is that moment.
import { BuildingDefinition } from '../definitions/buildings.js';
import { UnitDefinition } from '../definitions/units.js';
import { Building } from './entities.js';
import { UnitMotion } from './navigation.js';

class ForwardCannon {
    static plant(sim, unit, spec) {
        unit.cannonTick = sim.tick + sim.msTicks(spec.delayMs);
    }
    // Presentation: milliseconds the soldier has been rooting, from its cannonTick in any snapshot. Null for every other unit.
    static rootingMs(type, cannonTick, tick, tps) {
        const spec = UnitDefinition.get(type)?.growsCannon;
        if (!spec || cannonTick == null) return null;
        return spec.delayMs - ((cannonTick - tick) * 1000) / tps;
    }
    // Presentation: 'dig' then 'root' from the soldier's cannonTick in any snapshot. Null for every other unit.
    static stage(type, cannonTick, tick, tps) {
        const rootingMs = ForwardCannon.rootingMs(type, cannonTick, tick, tps);
        if (rootingMs === null) return null;
        return rootingMs < UnitDefinition.get(type).growsCannon.digMs ? 'dig' : 'root';
    }
    // The rooting soldier's whole turn. A soldier knocked into the air stands up once it is down again.
    static root(sim, unit, spec) {
        if (sim.tick < unit.cannonTick || !UnitMotion.isGrounded(unit)) return;
        const definition = BuildingDefinition.get(spec.building);
        unit.alive = false;
        const cannon = sim.addBuilding(
            new Building({
                id: spec.building + '-' + ++sim.seq,
                type: spec.building,
                side: unit.side,
                x: Math.round(unit.x),
                y: Math.round(unit.y),
                hp: definition.hp,
                maxHp: definition.hp,
                decayStartTick: sim.tick,
            }),
        );
        sim.events.push({
            type: 'forwardCannonRooted',
            side: unit.side,
            unitId: unit.id,
            buildingId: cannon.id,
            x: cannon.x,
            y: cannon.y,
        });
    }
    // Integer health steps: the total drained after `age` ticks is floor(age × rate / tps).
    static decay(sim) {
        for (const building of sim.buildings) {
            const spec = BuildingDefinition.get(building.type)?.decay;
            if (!spec || building.alive === false) continue;
            const age = sim.tick - building.decayStartTick,
                lost =
                    Math.floor((age * spec.hpPerSecond) / sim.tps) -
                    Math.floor(((age - 1) * spec.hpPerSecond) / sim.tps);
            if (lost <= 0) continue;
            building.hp -= lost;
            if (building.hp <= 0) sim.destroyBuilding(building, null, null);
        }
    }
}

export { ForwardCannon };
