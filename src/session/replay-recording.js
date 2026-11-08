// Deterministic replay recording, checkpoints, and payload validation.
import { GameRuleDefinition, SIM_TPS } from '../core/game-rules.js';
import { LaunchRules } from '../sim/launch-rules.js';
import { RallyStateCodec } from '../core/rally-state-codec.js';
import { CloneUtil } from '../sim/map-generation.js';
import { PRODUCT_VERSION } from '../core/product-version.js';
import { BUILD_META } from '../core/build-info.js';
import { RallyNetcode } from '../core/gamekit.js';
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

export { ReplayPolicy, ReplayRecorder };
