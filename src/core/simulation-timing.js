// The one place ms time values meet the tick rate (DEV-035): GameKit deterministic `tickTime`, one frozen instance per
// TPS. The sim keeps its own as `sim.time`; presentation reads the snapshot's TPS through `time(tps)`, so both convert
// with the same rule.
// - A one-off length (a delay, a duration, a cooldown after one use) is `time.ceilTicks(ms)` ticks: it ends on the first
//   tick past its ms, as tickTime's own durations do (`start`/`advance`).
// - A free-running period is a `time.every` accumulator in the authoritative state.
// - A repeating cooldown that restarts when the action happens (a basic attack, a sustained attack's stages, a card's
//   recharge, a tower's shot) keeps a deadline tick and carries what the tick grid cut off into the next one
//   (`carriedTicks`). tickTime has no one-call "deadline with carry"; the carry is in its units (ms × TPS, one tick =
//   1000), so the average period is the ms value exactly.
// GameKit is read at call time from the global gamekit.js sets: a static import would close an import cycle that
// gamekit.js's top-level await (sprite registry → unit definitions → here) never finishes.
const TICK_UNITS = 1000;
const CLOCKS = new Map();
const CARRIED = { ticks: 0, carry: 0 };

class SimulationTiming {
    static time(tps) {
        let clock = CLOCKS.get(tps);
        if (!clock) CLOCKS.set(tps, (clock = globalThis.RallyGamekit.tickTime({ tickRate: tps })));
        return clock;
    }

    // Whole ticks for `ms` plus the carry from the last span (at least one), and the new carry, in a shared result
    // object read at once (no allocation).
    static carriedTicks(time, ms, carry) {
        const total = time.start(ms) + carry,
            rest = total % TICK_UNITS;
        CARRIED.ticks = Math.max(1, (total - rest) / TICK_UNITS);
        CARRIED.carry = rest;
        return CARRIED;
    }
}

export { SimulationTiming };
