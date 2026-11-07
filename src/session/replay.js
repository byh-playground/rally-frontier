// Deterministic replay recording and playback.
import { GameRuleDefinition, RangeUtil, SIM_TPS } from '../core/game-rules.js';
import { StrategySim } from '../sim/strategy-sim.js';
import { RallyStateCodec } from '../core/rally-state-codec.js';
import { ActiveViewState } from './runtime-state.js';
import { CloneUtil } from '../sim/map-generation.js';
import { PRODUCT_VERSION } from '../core/product-version.js';
import { BUILD_META } from '../core/build-info.js';
import { RallyNetcode } from '../core/gamekit.js';
import { ReplayPresentation } from '../main.js';
import { SimulationTiming } from '../core/simulation-timing.js';

/* =========================
   3.8 Deterministic replay
   - Records only authoritative runtime commits + periodic authoritative checkpoints.
   - Network/recovery/presentation state is deliberately excluded.
   ========================= */
const REPLAY_PROTOCOL = 'ssalkongpang-replay/1';
const REPLAY_CHECKPOINT_MS = 60000;

class ReplayPolicy {
    static replayStateWithoutScheduled(sim) {
        const state = sim.exportState();
        state.scheduled = [];
        return state;
    }
    static replayChecksumForState(state) {
        return RallyNetcode.hashBytes(RallyStateCodec.encode({ ...state, scheduled: [] }))
            .toString(16)
            .padStart(8, '0');
    }
    static replayCheckpointSnapshot(sim) {
        const state = ReplayPolicy.replayStateWithoutScheduled(sim);
        return {
            state,
            checksum: ReplayPolicy.replayChecksumForState(state),
            checksumScope: 'complete-state-without-scheduled-v2',
        };
    }
    static validateReplayPayload(data) {
        if (!data || data.protocol !== REPLAY_PROTOCOL)
            throw new Error('쌀콩팡! 리플레이 파일이 아닙니다.');
        if (data.gameVersion !== PRODUCT_VERSION)
            throw new Error(
                `리플레이 게임 버전이 다릅니다. replay ${data.gameVersion ?? '확인 불가'} / current ${PRODUCT_VERSION}`,
            );
        if (!Array.isArray(data.commands) || !Number.isFinite(Number(data.seed)))
            throw new Error('리플레이 데이터가 손상되었습니다.');
        return data;
    }
}

// Replay checkpoints intentionally exclude future scheduled commands because
// authoritative RUNTIME_COMMIT entries are re-queued from the replay command log.
// The checkpoint checksum MUST therefore be computed from that same logical state,
// never from the live simulation whose `scheduled` map may still contain future work.

class ReplayRecorder {
    constructor({ seed, roomCode, sim, rules = null }) {
        this.seed = seed >>> 0;
        this.roomCode = roomCode || null;
        this.rules = CloneUtil.clone(rules || sim?.rules || GameRuleDefinition.current);
        this.commands = [];
        this.checkpoints = [];
        this.result = null;
        this.nextCheckpointTick = SimulationTiming.msToTicks(
            REPLAY_CHECKPOINT_MS,
            sim?.tps || SIM_TPS,
        );
        if (sim) this.captureCheckpoint(sim, true);
    }
    recordCommand(cmd) {
        if (this.result || !cmd || cmd.type !== 'RUNTIME_COMMIT') return;
        this.commands.push(
            CloneUtil.clone({
                type: 'RUNTIME_COMMIT',
                seq: cmd.seq,
                tick: cmd.tick,
                actor: cmd.actor,
                action: cmd.action,
                proposalId: cmd.proposalId ?? null,
                authorityTick: cmd.authorityTick ?? null,
            }),
        );
    }
    captureCheckpoint(sim, force = false) {
        if (!sim) return;
        if (!force && sim.tick < this.nextCheckpointTick) return;
        const checkpoint = ReplayPolicy.replayCheckpointSnapshot(sim);
        const entry = {
            tick: sim.tick,
            checksum: checkpoint.checksum,
            checksumScope: checkpoint.checksumScope,
            state: checkpoint.state,
        };
        if (
            this.checkpoints.length &&
            Number(this.checkpoints[this.checkpoints.length - 1].tick) === sim.tick
        )
            this.checkpoints[this.checkpoints.length - 1] = entry;
        else this.checkpoints.push(entry);
        const checkpointTicks = SimulationTiming.msToTicks(
            REPLAY_CHECKPOINT_MS,
            sim?.tps || SIM_TPS,
        );
        this.nextCheckpointTick = (Math.floor(sim.tick / checkpointTicks) + 1) * checkpointTicks;
    }
    finalize(winner, sim, reason = 'base-destroyed') {
        if (sim) this.captureCheckpoint(sim, true);
        this.result = {
            winner: winner || null,
            reason,
            endTick: sim?.tick || 0,
            checksum: sim?.checksum?.() || null,
        };
    }
    payload(liveSim = null) {
        const result = this.result
            ? CloneUtil.clone(this.result)
            : liveSim
              ? {
                    winner: null,
                    reason: 'in-progress',
                    endTick: liveSim.tick,
                    checksum: liveSim.checksum(),
                }
              : null;
        return {
            protocol: REPLAY_PROTOCOL,
            gameVersion: PRODUCT_VERSION,
            buildId: BUILD_META.id,
            createdAt: new Date().toISOString(),
            roomCode: this.roomCode,
            seed: this.seed,
            rules: CloneUtil.clone(this.rules),
            commands: CloneUtil.clone(this.commands),
            checkpoints: CloneUtil.clone(this.checkpoints),
            result: CloneUtil.clone(result),
        };
    }
}

class ReplayPlayer {
    constructor(data) {
        this.role = 'host';
        this.data = data;
        this.sim = null;
        this.playing = true;
        this.speed = 1;
        this.acc = 0;
        this.last = performance.now();
        this.stopped = false;
        this.eventBuffer = [];
        this.viewMode = 'all';
        this.orientationRole =
            (data?.defaultOrientationRole || data?.savedByRole) === 'guest' ? 'guest' : 'host';
        this.zoom = 1;
        const recordedEnd = Number(data?.result?.endTick);
        this.endTick =
            data?.result?.endTick != null && Number.isFinite(recordedEnd)
                ? Math.max(0, Math.round(recordedEnd))
                : (data?.commands || []).reduce((end, c) => Math.max(end, Number(c.tick) || 0), 0);
        this.loop = this.loop.bind(this);
        try {
            this.seek(0, { render: false });
        } catch (error) {
            this.stop();
            throw error;
        }
    }
    command() {
        return false;
    }
    inputAvailable() {
        return false;
    }
    validate() {
        ReplayPolicy.validateReplayPayload(this.data);
        return true;
    }
    queueCommandsAfter(sim, tick) {
        for (const cmd of this.data.commands || []) {
            // A commit scheduled after the recorded end is still part of the final
            // authoritative queue. Restore it, but stepOnce/seek never execute past endTick.
            if (Number(cmd.tick) > tick) sim.queueCommand(CloneUtil.clone(cmd));
        }
    }
    checkpointFor(targetTick) {
        let best = null;
        for (const cp of this.data.checkpoints || []) {
            if (Number(cp.tick) <= targetTick && (!best || Number(cp.tick) > Number(best.tick)))
                best = cp;
        }
        return best;
    }
    validateImportedCheckpoint(sim, cp, baseTick) {
        if (!cp?.checksum) return true;
        if (cp.checksumScope !== 'complete-state-without-scheduled-v2')
            throw new Error('지원하지 않는 체크포인트 형식입니다.');
        const actual = ReplayPolicy.replayChecksumForState(sim.exportState());
        if (actual !== String(cp.checksum))
            throw new Error(`리플레이 체크포인트 손상 · tick ${baseTick}`);
        return true;
    }
    resetAtCheckpoint(sim, targetTick) {
        const cp = this.checkpointFor(targetTick);
        let baseTick = 0;
        if (cp?.state) {
            sim.importState(cp.state);
            sim.scheduled = new Map();
            const stateTick = Number(sim.tick) || 0;
            baseTick = Number(cp.tick) || stateTick;
            if (stateTick !== baseTick)
                throw new Error(
                    `리플레이 체크포인트 tick 불일치 · index ${baseTick} / state ${stateTick}`,
                );
            this.validateImportedCheckpoint(sim, cp, baseTick);
        }
        // captureCheckpoint() runs immediately after sim.step(), so every command at
        // baseTick has already executed and was removed from `scheduled`. Re-queue only
        // strictly-future commands; using >= would execute the checkpoint tick twice.
        this.queueCommandsAfter(sim, baseTick);
        return baseTick;
    }
    seek(targetTick, { render = true } = {}) {
        targetTick = RangeUtil.clamp(Math.round(Number(targetTick) || 0), 0, this.endTick || 0);
        this.validate();
        const candidate = new StrategySim(
            Number(this.data.seed) >>> 0,
            this.data.rules || GameRuleDefinition.current,
        );
        try {
            this.resetAtCheckpoint(candidate, targetTick);
            while (candidate.tick < targetTick) {
                const previous = candidate.tick,
                    winner = candidate.step();
                if (candidate.tick <= previous || (winner && candidate.tick < targetTick))
                    throw new Error(
                        `리플레이가 기록된 종료 시각 전에 멈췄습니다 · tick ${candidate.tick} / ${targetTick}`,
                    );
            }
        } catch (error) {
            candidate.dispose('replay-seek-failed');
            throw error;
        }
        const previousSim = this.sim;
        this.sim = candidate;
        previousSim?.dispose('replay-seek');
        this.eventBuffer.length = 0;
        this.acc = 0;
        this.last = performance.now();
        if (render) {
            ActiveViewState.renderer?.resetFogTransition?.();
            this.publish({ snapTargets: true });
        }
        return this.sim.tick;
    }
    stepOnce() {
        if (!this.sim || this.sim.tick >= this.endTick) {
            this.playing = false;
            return false;
        }
        const winner = this.sim.step();
        if (this.sim.events?.length) {
            const eventTick = this.sim.tick;
            for (const e of this.sim.events)
                this.eventBuffer.push({ ...e, presentationTick: eventTick });
        }
        if (winner || this.sim.tick >= this.endTick) this.playing = false;
        return true;
    }
    publish(options) {
        if (!this.sim) return;
        const s = this.sim.snapshot();
        s.events = this.eventBuffer.splice(0);
        ReplayPresentation.renderReplaySnapshot(s, options);
    }
    setPlaying(v) {
        const resuming = !!v && !this.playing;
        this.playing = !!v;
        this.acc = 0;
        this.last = performance.now();
        if (resuming) this.publish({ snapTargets: true });
        ReplayPresentation.syncReplayControls();
    }
    setSpeed(v) {
        this.speed = RangeUtil.clamp(Number(v) || 1, 0.5, 4);
        this.acc = 0;
        this.last = performance.now();
        this.publish({ snapTargets: true });
    }
    setViewMode(mode) {
        this.viewMode = ['host', 'guest', 'all'].includes(mode) ? mode : 'all';
        ReplayPresentation.applyReplayPerspective();
        this.publish();
    }
    setOrientation(roleName) {
        this.orientationRole = roleName === 'guest' ? 'guest' : 'host';
        ReplayPresentation.applyReplayPerspective({ preserveCenter: true });
        this.publish();
    }
    setZoom(value) {
        this.zoom = RangeUtil.clamp(Number(value) || 1, 0.6, 1.8);
        ReplayPresentation.applyReplayZoom(this.zoom);
        ReplayPresentation.syncReplayControls();
    }
    start() {
        this.stopped = false;
        this.last = performance.now();
        requestAnimationFrame(this.loop);
    }
    stop() {
        this.stopped = true;
        this.playing = false;
        this.sim?.dispose('replay-stop');
    }
    loop(now) {
        if (this.stopped) return;
        const elapsed = Math.max(0, Math.min(250, now - this.last));
        this.last = now;
        if (this.playing && this.sim) {
            this.acc += elapsed * this.speed;
            const replayTps = RangeUtil.clamp(
                Math.round(Number(this.sim?.tps || this.data?.rules?.simulation?.tps) || SIM_TPS),
                4,
                30,
            );
            const tickMs = 1000 / replayTps;
            let steps = 0;
            while (this.acc >= tickMs && steps < 240 && this.stepOnce()) {
                this.acc -= tickMs;
                steps++;
            }
            if (steps) this.publish();
        }
        ReplayPresentation.syncReplayControls();
        requestAnimationFrame(this.loop);
    }
}

export { ReplayPlayer, ReplayPolicy, ReplayRecorder };
