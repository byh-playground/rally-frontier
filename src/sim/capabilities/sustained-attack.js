// Contract (index.html Development Contract의 지속 피해형 공격 문법):
// - 지속 피해형 공격은 공격 주기와 그 안의 피해 틱을 나눈다. Unit Definition `sustain { durationMs, tickMs,
//   cooldownMs }`: 한 번의 공격은 durationMs 동안 이어지고, 그동안 tickMs마다 피해 틱이 온다(첫 틱은 시작한 틱).
//   공격이 끝나면 cooldownMs 동안 다시 시작하지 못한다(재사용 대기는 끝난 때부터 센다).
// - 이 모듈은 시간만 맡는다. 무엇이 맞는지(범위 모양·대상·피해)는 공격 능력(UnitBreathAttack 등)이 정하고, 능력은
//   "지금 공격 중인가(active)", "시작할 수 있는가(ready)", "이번 틱이 피해 틱인가(takeTick)"만 묻는다.
// - 틱 수는 일반 공격의 재사용 대기와 같은 누적 방식(SimulationTiming.timerTicksWithPhase)으로 바꾼다: 지속 시간·
//   피해 간격·재사용 대기마다 틱에 못 미친 나머지(phase, ms×TPS 단위)를 다음 번으로 넘겨 평균이 정의값과 같다(10TPS의
//   350ms 간격은 3·4틱 교대). 10TPS에서 1000ms는 10틱, 200ms는 2틱이라 한 번의 공격에 피해 틱 5회(시작 틱, +2, +4,
//   +6, +8)이고, 다음 공격은 시작 20틱 뒤부터다. 다음 피해 틱은 앞 피해 틱에 간격을 더해 정하므로 공격 도중 갱신이
//   한 틱 늦어도 박자가 밀리지 않는다.
// - Unit.sustain { active, startTick, endTick, nextTick, readyTick, uses, ticks, durationPhase, tickPhase,
//   cooldownPhase }가 권위 상태다(저장·해시).
//   중간에 끊기면(넘어짐 등) active만 내리고, 재사용 대기는 시작할 때 정한 readyTick을 그대로 따른다.
import { SimulationTiming } from '../../core/simulation-timing.js';

class SustainedAttack {
    static initialState() {
        return {
            active: false,
            startTick: 0,
            endTick: 0,
            nextTick: 0,
            readyTick: 0,
            uses: 0,
            ticks: 0,
            durationPhase: 0,
            tickPhase: 0,
            cooldownPhase: 0,
        };
    }
    // The Definition block's checks (define-unit.js): every time positive and the damage step within the attack.
    static validate(id, spec) {
        if (!spec || typeof spec !== 'object') throw new Error(`병종 ${id}에 sustain이 없습니다.`);
        for (const key of ['durationMs', 'tickMs', 'cooldownMs'])
            if (!(Number(spec[key]) > 0))
                throw new Error(`병종 ${id}의 sustain.${key}는 양수여야 합니다.`);
        if (spec.tickMs > spec.durationMs)
            throw new Error(`병종 ${id}의 sustain.tickMs는 durationMs보다 길 수 없습니다.`);
    }
    // Ends an attack whose time is up; true while it still runs this tick.
    static advance(sim, state) {
        if (state.active && sim.tick >= state.endTick) state.active = false;
        return state.active;
    }
    static ready(sim, state) {
        return !state.active && sim.tick >= state.readyTick;
    }
    static start(sim, state, spec) {
        state.active = true;
        state.startTick = sim.tick;
        state.endTick = sim.tick + this.span(sim, state, 'durationPhase', spec.durationMs);
        state.nextTick = sim.tick;
        state.readyTick = state.endTick + this.span(sim, state, 'cooldownPhase', spec.cooldownMs);
        state.uses++;
    }
    // True once per damage tick while the attack runs (consumes it).
    static takeTick(sim, state, spec) {
        if (!state.active || sim.tick < state.nextTick) return false;
        const step = this.span(sim, state, 'tickPhase', spec.tickMs);
        state.nextTick += step;
        if (state.nextTick <= sim.tick) state.nextTick = sim.tick + step;
        state.ticks++;
        return true;
    }
    static interrupt(state) {
        state.active = false;
    }
    // Ticks for one span of ms, carrying the remainder in state[key] (as the basic attack's cooldown phase does).
    static span(sim, state, key, ms) {
        const timer = SimulationTiming.timerTicksWithPhase(ms, sim.tps, state[key], { min: 1 });
        state[key] = timer.phase;
        return timer.ticks;
    }
}

export { SustainedAttack };
