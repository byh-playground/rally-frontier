// Deterministic replay recording and playback.
import { GameRuleDefinition, RangeUtil, SIM_TPS } from '../core/game-rules.js';
import { StrategySim } from '../sim/strategy-sim.js';
import { LaunchRules } from '../sim/launch-rules.js';
import { RallyStateCodec } from '../core/rally-state-codec.js';
import { ActiveViewState } from './runtime-state.js';
import { CloneUtil } from '../sim/map-generation.js';
import { PRODUCT_VERSION } from '../core/product-version.js';
import { BUILD_META } from '../core/build-info.js';
import { RallyNetcode } from '../core/gamekit.js';
import {
    attachPublishedVisibility,
    captureFramePresentationEvents,
    createFramePresentationJournal,
    configureFramePresentationJournal,
    emitFramePresentationEvents,
} from '../core/presentation-frame-event.js';
import { ReplayPresentation, createPresentationView } from '../main.js';
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
        LaunchRules.normalizeDeckPair(data.decks);
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
        this.decks = LaunchRules.normalizeDeckPair(
            sim?.decks ?? [LaunchRules.starterDeck, LaunchRules.starterDeck],
        );
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
            decks: this.decks.map((deck) => deck.slice()),
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
        this.playbackState = 'playing';
        this.speed = 1;
        this.acc = 0;
        this.last = performance.now();
        this.stopped = false;
        this.eventBuffer = [];
        this.renderEventBuffer = [];
        this.presentationPending = [];
        this.presentationView = createPresentationView(this, () => ActiveViewState.renderer);
        this.presentationJournal = null;
        this.onVisibilityChange = () => {
            this.presentationJournal?.setPresentationActive(!document.hidden);
            if (document.hidden) {
                this.flushPresentationEvents();
                this.eventBuffer = this.eventBuffer.filter((event) => !event.presentationAudio);
            }
            this.acc = 0;
            this.last = performance.now();
        };
        document.addEventListener('visibilitychange', this.onVisibilityChange);
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
    get playing() {
        return ['playing', 'draining', 'tail'].includes(this.playbackState);
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
            const decks = LaunchRules.normalizeDeckPair(cp.state.decks);
            if (JSON.stringify(decks) !== JSON.stringify(sim.decks))
                throw new Error('리플레이 체크포인트의 덱이 경기 시작과 다릅니다.');
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
        const resume = this.playing;
        this.validate();
        const candidate = new StrategySim(
            Number(this.data.seed) >>> 0,
            this.data.rules || GameRuleDefinition.current,
            this.data.decks,
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
        this.presentationJournal?.dispose();
        this.presentationJournal = createFramePresentationJournal({
            getView: () => this.presentationView,
            onImmediate: (record) => {
                if (record.kind === 'audio' && document.hidden) return;
                this.eventBuffer.push({
                    ...record.payload,
                    presentationTick: record.tick,
                    presentationAudio: record.kind === 'audio',
                });
            },
        });
        configureFramePresentationJournal(
            this.presentationJournal,
            this.presentationView,
            this.sim.tps,
            !document.hidden,
        );
        this.eventBuffer.length = 0;
        this.renderEventBuffer.length = 0;
        this.presentationPending.length = 0;
        this.playbackState = resume
            ? this.sim.tick >= this.endTick
                ? 'draining'
                : 'playing'
            : 'paused';
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
            this.playbackState = this.sim ? 'draining' : 'paused';
            return false;
        }
        const winner = this.sim.step();
        if (this.sim.events?.length) {
            for (const event of this.sim.events)
                this.renderEventBuffer.push({ ...event, presentationTick: this.sim.tick });
            this.presentationPending.push({
                tick: this.sim.tick,
                events: captureFramePresentationEvents(this.sim.events, this.sim),
            });
        }
        if (winner || this.sim.tick >= this.endTick) this.playbackState = 'draining';
        return true;
    }
    publish(options) {
        if (!this.sim) return;
        const s = this.sim.snapshot();
        s.events = this.eventBuffer.splice(0);
        s.renderEvents = this.renderEventBuffer.splice(0);
        try {
            ReplayPresentation.renderReplaySnapshot(s, options);
        } finally {
            // Presentation events are a synchronously consumed batch, not retained world state.
            s.events = [];
            s.renderEvents = [];
        }
    }
    presentFrame(frame) {
        if (!this.stopped && frame?.timeMs != null) this.presentationJournal?.present(frame);
    }
    flushPresentationEvents(snapshot = null) {
        if (!this.presentationJournal || !this.presentationPending.length) return;
        this.presentationJournal.update(performance.now());
        for (const batch of this.presentationPending.splice(0)) {
            emitFramePresentationEvents(
                this.presentationJournal,
                this.presentationView,
                batch.tick,
                attachPublishedVisibility(batch.events, this.presentationView),
            );
        }
        if (snapshot) snapshot.events.push(...this.eventBuffer.splice(0));
    }
    finishPresentationEvent(record) {
        return this.presentationJournal?.finish(record);
    }
    setPlaying(v) {
        const wasTail = ['tail', 'paused-tail', 'ended'].includes(this.playbackState);
        const resuming = !!v && !this.playing;
        this.playbackState = v
            ? this.playbackState === 'paused-tail'
                ? 'tail'
                : this.playbackState === 'paused-drain' || this.sim?.tick >= this.endTick
                  ? 'draining'
                  : 'playing'
            : this.playbackState === 'tail'
              ? 'paused-tail'
              : this.playbackState === 'draining'
                ? 'paused-drain'
                : 'paused';
        this.acc = 0;
        this.last = performance.now();
        if (resuming && !wasTail) this.publish();
        ReplayPresentation.syncReplayControls();
    }
    setSpeed(v) {
        this.speed = RangeUtil.clamp(Number(v) || 1, 0.5, 4);
        this.acc = 0;
        this.last = performance.now();
        this.refreshPresentation();
        ReplayPresentation.syncReplayControls();
    }
    refreshPresentation() {
        if (['tail', 'paused-tail', 'ended'].includes(this.playbackState)) {
            // No new authority can be captured after finish(); view changes are
            // presentation-only and the last authoritative snapshot is unchanged.
            ReplayPresentation.refreshReplayView();
        } else this.publish();
    }
    setViewMode(mode) {
        this.viewMode = ['host', 'guest', 'all'].includes(mode) ? mode : 'all';
        ReplayPresentation.applyReplayPerspective();
        this.refreshPresentation();
    }
    setOrientation(roleName) {
        this.orientationRole = roleName === 'guest' ? 'guest' : 'host';
        ReplayPresentation.applyReplayPerspective({ preserveCenter: true });
        this.refreshPresentation();
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
        this.playbackState = 'ended';
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        this.presentationJournal?.dispose();
        this.presentationJournal = null;
        this.presentationPending.length = 0;
        this.sim?.dispose('replay-stop');
    }
    loop(now) {
        if (this.stopped) return;
        const elapsed = Math.max(0, Math.min(250, now - this.last));
        this.last = now;
        if (this.playbackState === 'draining' && this.sim) {
            // The final snapshot is already captured. The shared presentation clock
            // holds its pose and advances through the finite remaining effect lifetime.
            const store = ActiveViewState.renderer?.renderState;
            if (store?.runtime) {
                store.finish(this.presentationView.tailMs);
                this.playbackState = 'tail';
            }
        } else if (this.playbackState === 'tail' && this.sim) {
            const frame = ActiveViewState.renderer?.renderState?.currentFrame;
            if (frame?.terminalComplete) {
                this.presentFrame(frame);
                this.presentationJournal?.setPresentationActive(false);
                this.playbackState = 'ended';
                this.acc = 0;
            }
        } else if (this.playbackState === 'playing' && this.sim) {
            this.acc += elapsed * this.speed;
            const replayTps = RangeUtil.clamp(
                Math.round(Number(this.sim?.tps || this.data?.rules?.simulation?.tps) || SIM_TPS),
                4,
                30,
            );
            const tickMs = 1000 / replayTps;
            let steps = 0;
            while (
                this.acc >= tickMs &&
                steps < 240 &&
                this.playbackState === 'playing' &&
                this.stepOnce()
            ) {
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
