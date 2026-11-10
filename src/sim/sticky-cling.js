// A sticky-rice soldier wraps a completed enemy outpost's muzzle for a short time.
// Unit.stickyCling { buildingId, endTick } is the only authoritative state. Whether an outpost
// is jammed is always computed from its living clinger, so death, destruction, capture and
// construction changes release it without a second record.
import { BuildingDefinition } from '../definitions/buildings.js';
import { UnitDefinition } from '../definitions/units.js';

class StickyCling {
    static initialState() {
        return { buildingId: null, endTick: 0 };
    }
    // Completed enemy outposts only; the main base and construction sites cannot be held.
    static canHold(unit, building) {
        return (
            !!building &&
            building.alive !== false &&
            !building.construction &&
            building.side !== unit.side &&
            BuildingDefinition.get(building.type)?.isOutpost === true
        );
    }
    static holds(state, unit, building) {
        const cling = unit.stickyCling;
        return (
            unit.alive !== false &&
            cling?.buildingId === building.id &&
            Number(state.tick) < cling.endTick &&
            this.canHold(unit, building)
        );
    }
    // Works on the live simulation and on any snapshot: the soldier currently holding this cannon.
    static clingerOf(state, building) {
        if (!building) return null;
        for (const unit of state?.units || []) if (this.holds(state, unit, building)) return unit;
        return null;
    }
    static heldBuilding(state, unit) {
        const id = unit.stickyCling?.buildingId;
        if (id == null) return null;
        const building = (state?.buildings || []).find((candidate) => candidate.id === id);
        return building && this.holds(state, unit, building) ? building : null;
    }
    // A confirmed building contact becomes a cling when the soldier is ready and the muzzle is free.
    static tryBegin(sim, unit, building) {
        const spec = UnitDefinition.get(unit.type)?.stickyCling;
        if (!spec || !this.canHold(unit, building) || this.clingerOf(sim, building)) return false;
        const cling = unit.stickyCling;
        if (cling.buildingId != null && sim.tick < cling.endTick + sim.msTicks(spec.cooldownMs))
            return false;
        unit.stickyCling = {
            buildingId: building.id,
            endTick: sim.tick + sim.msTicks(spec.durationMs),
        };
        unit.contactAttack = null;
        return true;
    }
}

export { StickyCling };
