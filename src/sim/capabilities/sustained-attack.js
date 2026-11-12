// Contract (index.html Development Contract의 지속 피해형 공격 문법):
// - 지속 피해형 공격은 공격 주기와 그 안의 피해 틱을 나눈다. Unit Definition `sustain { durationMs, tickMs,
//   cooldownMs }`: 한 번의 공격은 durationMs 동안 이어지고, 그동안 tickMs마다 피해 틱이 온다(첫 틱은 지속이
//   시작한 틱). 공격이 끝나면 cooldownMs 동안 다시 시작하지 못한다(재사용 대기는 끝난 때부터 센다). 한 번의 공격에
//   피해 틱이 몇 번인지는 따로 적지 않고 durationMs와 tickMs에서 나온다(1000/200이면 5회, 1400/200이면 7회).
// - 선택 단계 `windupMs`·`recoverMs`: 지속 앞의 준비와 뒤의 회복. 그동안 공격은 이어져(병사를 세워 둠) 피해는 없다.
//   공격 전체는 준비 → 지속(피해 틱) → 회복이고 재사용 대기는 회복이 끝난 때부터 센다. 두 단계의 틱은 일반 전투의
//   준비·이동 회복과 같은 반올림(SimulationTiming.msToTicks, 최소 1틱)으로 바꿔 같은 ms면 일반 근접 병종과 같은 틱이다.
//   전투 준비(attackWindupMs)는 표적을 고정하고 표적이 사거리를 벗어나면 취소되는 표적 조준이고, sustain.windupMs는
//   시작한 공격의 일부라 취소되지 않는다. 표적을 조준한 뒤 지속을 시작하는 병종(해바라기씨)은 attackWindupMs를,
//   시작하면 끝까지 도는 병종(도토리)은 sustain.windupMs를 쓴다.
// - 이 모듈은 시간만 맡는다. 무엇이 맞는지(범위 모양·대상·피해·발사)는 공격 능력(UnitBreathAttack·UnitSpinAttack·
//   UnitBurstAttack)이 정하고, 능력은 "지금 공격 중인가(advance)", "시작할 수 있는가(ready)", "이번 틱이 피해
//   틱인가(takeTick)"만 묻는다.
// - 지속 시간·피해 간격·재사용 대기의 틱 수는 일반 공격의 재사용 대기와 같은 누적 방식(SimulationTiming.
//   timerTicksWithPhase)으로 바꾼다: 틱에 못 미친 나머지(phase, ms×TPS 단위)를 다음 번으로 넘겨 평균이 정의값과
//   같다(10TPS의 350ms 간격은 3·4틱 교대). 10TPS에서 1000ms는 10틱, 200ms는 2틱이라 한 번의 공격에 피해 틱 5회(시작
//   틱, +2, +4, +6, +8)이고, 다음 공격은 시작 20틱 뒤부터다. 다음 피해 틱은 앞 피해 틱에 간격을 더해 정하므로 공격
//   도중 갱신이 한 틱 늦어도 박자가 밀리지 않는다.
// - Unit.sustain { active, startTick, endTick, nextTick, readyTick, uses, ticks, durationPhase, tickPhase,
//   cooldownPhase }가 권위 상태다(저장·해시). active는 준비부터 회복까지 공격 전체, startTick·endTick은 그 처음과
//   끝, nextTick은 다음 피해 틱이다. 지속 구간은 startTick + 준비 틱부터 endTick - 회복 틱까지다(phases).
// - 일찍 끝내기는 하나다(cut): 넘어짐·고정한 표적을 잃음·죽음·영웅 복귀처럼 공격자가 더는 이어 갈 수 없으면 그 틱에
//   공격이 끝나고(준비·지속·회복 어느 단계든) 재사용 대기 cooldownMs를 그 틱부터 처음부터 센다. 시작할 때 정해 둔
//   readyTick은 버리고, 대기 틱은 시작 때와 같은 누적 방식(cooldownPhase)으로 구한다. 표적을 잃은 것도 같은 규칙이다
//   (남은 한 발 간격을 더 쓰지 않는다). 죽은 유닛은 대기를 쓰지 않으니 정리만 된다. 공격 중이 아니면 아무것도 바꾸지 않는다.
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
        for (const key of ['windupMs', 'recoverMs'])
            if (spec[key] !== undefined && !(Number(spec[key]) > 0))
                throw new Error(`병종 ${id}의 sustain.${key}는 있으면 양수여야 합니다.`);
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
        state.nextTick = sim.tick + this.windupTicks(sim.tps, spec);
        state.endTick =
            state.nextTick +
            this.span(sim, state, 'durationPhase', spec.durationMs) +
            this.recoverTicks(sim.tps, spec);
        state.readyTick = state.endTick + this.span(sim, state, 'cooldownPhase', spec.cooldownMs);
        state.uses++;
    }
    // True once per damage tick while the attack's duration runs (consumes it).
    static takeTick(sim, state, spec) {
        if (
            !state.active ||
            sim.tick < state.nextTick ||
            sim.tick >= state.endTick - this.recoverTicks(sim.tps, spec)
        )
            return false;
        const step = this.span(sim, state, 'tickPhase', spec.tickMs);
        state.nextTick += step;
        if (state.nextTick <= sim.tick) state.nextTick = sim.tick + step;
        state.ticks++;
        return true;
    }
    // Does the running attack still have a damage tick to come (its duration not yet over)? A query: no state changes.
    static ticking(sim, state, spec) {
        return (
            state.active &&
            sim.tick < state.endTick &&
            state.nextTick < state.endTick - this.recoverTicks(sim.tps, spec)
        );
    }
    // Ends a running attack here (knocked off its feet, its locked target lost, dead): its cooldown counts in full from
    // this tick, whatever stage it was in. Nothing happens when no attack runs.
    static cut(sim, state, spec) {
        if (!state.active) return;
        state.active = false;
        state.endTick = sim.tick;
        state.readyTick = sim.tick + this.span(sim, state, 'cooldownPhase', spec.cooldownMs);
    }
    // The running attack's stages in ticks (presentation): start, duration start and end, end. Fills `out`.
    static phases(state, spec, tps, out) {
        out.startTick = state.startTick;
        out.durationStartTick = state.startTick + this.windupTicks(tps, spec);
        out.durationEndTick = state.endTick - this.recoverTicks(tps, spec);
        out.endTick = state.endTick;
        return out;
    }
    // Presentation of the latest attack (as its damage step's whole ticks): the tick of its last damage tick so far and
    // how many it has taken. Exact when tickMs is a whole number of ticks; otherwise within a tick.
    static lastTick(state, spec, tps) {
        return state.nextTick - SimulationTiming.msToTicks(spec.tickMs, tps);
    }
    static tickCount(state, spec, tps) {
        const first = state.startTick + this.windupTicks(tps, spec),
            step = SimulationTiming.msToTicks(spec.tickMs, tps);
        return Math.max(0, Math.round((this.lastTick(state, spec, tps) - first) / step) + 1);
    }
    static windupTicks(tps, spec) {
        return spec.windupMs ? SimulationTiming.msToTicks(spec.windupMs, tps) : 0;
    }
    static recoverTicks(tps, spec) {
        return spec.recoverMs ? SimulationTiming.msToTicks(spec.recoverMs, tps) : 0;
    }
    // Ticks for one span of ms, carrying the remainder in state[key] (as the basic attack's cooldown phase does).
    static span(sim, state, key, ms) {
        const timer = SimulationTiming.timerTicksWithPhase(ms, sim.tps, state[key], { min: 1 });
        state[key] = timer.phase;
        return timer.ticks;
    }
}

export { SustainedAttack };
