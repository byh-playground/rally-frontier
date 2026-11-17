// The blight (깜부기, a black smut): a living soldier or hero it rules carries `unit.blighted = true`. A campaign
// stage declares `blight: true` (campaign.js) and every unit then created for the enemy side (ENEMY_SIDE) is
// blighted; the declaration rides in `sim.rules.campaign`, so the match start, snapshot, replay and rollback carry
// it as they carry the stage. No other match has the cell (a plain match's state is unchanged), and buildings are
// never blighted. Being blighted is not being hostile: a versus opponent is hostile and not blighted.
// This class is the only writer of the cell. `free` is where a soldier leaves the blight; `convert` frees it and
// has it join the freeing side (a spore sac's captives, sim/spore-sac.js).
export class Blight {
    // The side a blighted stage's enemy plays (the campaign player is side 0).
    static ENEMY_SIDE = 1;

    // Does this match's stage declare its enemy blighted?
    static declared(sim) {
        return sim.rules.campaign?.blight === true;
    }

    static is(unit) {
        return unit.blighted === true;
    }

    // A unit created now (StrategySim.spawnUnit): blighted when the stage says so and it is the enemy's.
    static mark(sim, unit) {
        if (unit.side === this.ENEMY_SIDE && this.declared(sim)) unit.blighted = true;
    }

    // Frees one unit from the blight: the cell is removed and `blightFreed` tells the presentation. Returns whether
    // it freed anything (false for a unit that is dead or was not blighted), so a caller may act only on true.
    static free(sim, unit) {
        if (!unit.alive || !this.is(unit)) return false;
        delete unit.blighted;
        sim.events.push({
            type: 'blightFreed',
            id: unit.id,
            unitType: unit.type,
            side: unit.side,
            x: unit.x,
            y: unit.y,
        });
        return true;
    }

    // Frees one blighted soldier and has it join `side` where it stands (StrategySim.changeUnitSide keeps its id,
    // health and place and ends what tied it to its old side). Returns whether it did; a unit that is dead or not
    // blighted stays as it is. It is not a kill: no death, no kill count, no hero growth.
    static convert(sim, unit, side) {
        if (!this.free(sim, unit)) return false;
        sim.changeUnitSide(unit, side);
        return true;
    }
}
