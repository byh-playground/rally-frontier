import { SIM_TPS } from './game-rules.js';

class SimulationTiming {
    static timerTicksWithPhase(durationMs, tps, phase = 0, { min = 1 } = {}) {
        const hz = Math.max(1, Math.round(Number(tps) || SIM_TPS));
        const total =
            Math.max(0, Math.round(Number(durationMs) || 0)) * hz +
            Math.max(0, Math.round(Number(phase) || 0));
        const ticks = Math.floor(total / 1000);
        return { ticks: Math.max(min, ticks), phase: total % 1000 };
    }

    static ticksToMs(ticks, tps = SIM_TPS) {
        return Math.round((Math.max(0, Number(ticks) || 0) * 1000) / tps);
    }

    static msToTicks(ms, tps = SIM_TPS, { min = 1 } = {}) {
        const value = Math.max(0, Math.round(Number(ms) || 0));
        return Math.max(min, Math.round((value * tps) / 1000));
    }
}

export { SimulationTiming };
