import { campaignStage } from '../definitions/campaign.js';
// Command lockstep session around the simulation.
import { GameRuleRuntime, RangeUtil, SIM_TPS } from '../core/game-rules.js';
import { StrategySim } from '../sim/strategy-sim.js';
import { CampaignMission } from '../sim/campaign-mission.js';
import { Building, Projectile, Unit } from '../sim/entities.js';
import { HeroDeployment } from '../sim/hero-deployment.js';
import { HeroRollAttack } from '../sim/hero-roll-attack.js';
import { FruitHeroAttack } from '../sim/fruit-hero-attack.js';
import { CannonRider } from '../sim/cannon-rider.js';
import { LaunchRules } from '../sim/launch-rules.js';
import { StateValue } from '../sim/components.js';
import { ReplayRecorder } from './replay-recording.js';
import {
    matchesDeckSelection,
    normalizeDeckSelection,
    resolveDeckSelection,
} from './friend-decks.js';
import { recordRecovery } from '../diagnostics/recovery-flight-recorder.js';
import { StableSerializationUtil } from '../net/lobby-codec.js';
import { HashUtil } from '../sim/map-generation.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { UnitDefinition } from '../definitions/units.js';
import { balanceTelemetrySnapshot, recordTiming } from '../diagnostics/simulation-stats.js';
import {
    DISCONNECT_GRACE_MS,
    LOCKSTEP_INPUT_DELAY_BASE_MS,
    LOCKSTEP_INPUT_DELAY_MAX_MS,
    MAX_CATCHUP_STEPS_PER_PULSE,
    NETWORK_HEALTH_POLL_MS,
    SIM_SUSPENSION_THRESHOLD_MS,
    SNAPSHOT_EMIT_INTERVAL_MS,
} from '../core/session-timing.js';
import { netcodeMode } from '../core/config.js';
import { PRODUCT_VERSION } from '../core/product-version.js';
import { RallyStateCodec } from '../core/rally-state-codec.js';
import { SimulationTiming } from '../core/simulation-timing.js';
import {
    createFramePresentationJournal,
    configureFramePresentationJournal,
    emitFramePresentationEvents,
    captureFramePresentationEvents,
    attachPublishedVisibility,
} from '../core/presentation-frame-event.js';
import { UnitResultStats } from '../sim/unit-result-stats.js';
import { RallyGamekit, RallyNetcode } from '../core/gamekit.js';

/* =========================
   4. Session / command lockstep
   ========================= */
// The SDK owns command resolution and rollback timelines. These codecs expose
// only opaque game data; they never inspect SDK queues, checkpoints or internals.
class RallyCommandCodec {
    static maxBytes = 16 * 1024;
    static fields = Object.freeze({
        MATCH_SURRENDER: [],
        UPGRADE_LAUNCH_RANGE: [],
        TOGGLE_HERO: ['sortieId'],
        ACTIVATE_HERO_SKILL: ['sortieId'],
        LAUNCH: ['cannonId', 'x', 'y', 'holdMs', 'unitType'],
    });
    static validate(action) {
        RallyStateCodec.assertData(action, { maxNodes: 2048, maxArray: 512, maxString: 4096 });
        if (
            !action ||
            Array.isArray(action) ||
            typeof action !== 'object' ||
            typeof action.type !== 'string' ||
            !action.type ||
            action.type.length > 80
        )
            throw new Error('올바른 게임 action이 필요합니다.');
        const fields = this.fields[action.type];
        if (!fields) throw new Error('지원하지 않는 게임 명령입니다.');
        if (Object.keys(action).some((key) => key !== 'type' && !fields.includes(key)))
            throw new Error('게임 명령에 권위 계약 밖의 필드가 있습니다.');
        if (
            action.type === 'LAUNCH' &&
            (['cannonId', 'unitType'].some(
                (key) => typeof action[key] !== 'string' || !action[key],
            ) ||
                ['x', 'y', 'holdMs'].some((key) => !Number.isFinite(action[key])))
        )
            throw new Error('발사 명령의 필드가 잘못되었습니다.');
        if (
            ['TOGGLE_HERO', 'ACTIVATE_HERO_SKILL'].includes(action.type) &&
            !HeroDeployment.validSortieId(action.sortieId)
        )
            throw new Error('영웅 명령의 출격 식별자가 잘못되었습니다.');
        return action;
    }
    static encode(action) {
        const bytes = RallyStateCodec.encode(this.validate(action));
        if (bytes.byteLength > this.maxBytes) throw new Error('게임 명령이 너무 큽니다.');
        return bytes;
    }
    static decode(bytes) {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > this.maxBytes)
            throw new Error('올바른 게임 command bytes가 필요합니다.');
        return this.validate(RallyStateCodec.decode(bytes));
    }
}
class RallySimulationAdapter {
    static commandsPerFrame = 4096;
    static maxFrameTick = Math.floor(Number.MAX_SAFE_INTEGER / this.commandsPerFrame) - 1;
    constructor(session) {
        if (!(session?.sim instanceof StrategySim))
            throw new Error('StrategySim 경기 session이 필요합니다.');
        this.session = session;
        const sim = session.sim;
        this.identity = { seed: sim.seed, rules: sim.rules, mapDescriptor: sim.mapDescriptor };
        StateValue.freeze(this.identity.rules);
        this.deckSignature = JSON.stringify(LaunchRules.normalizeDeckPair(sim.decks));
        const encoded = StableSerializationUtil.stableStringify({
            ...this.identity,
            decks: sim.decks,
        });
        this.matchId = `${PRODUCT_VERSION}:${encoded.length}:${HashUtil.hash(encoded)}:${HashUtil.hash('ssalkongpang-state|' + encoded)}`;
        this.mapFingerprint = sim.mapFingerprint();
        const state = this.stateData();
        // Required root fields come from the authoritative owner, not another save list.
        const kind = (value) =>
            value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
        this.rootShape = Object.fromEntries(
            Object.entries(state).map(([key, value]) => [
                key,
                {
                    kind: kind(value),
                    items:
                        Array.isArray(value) &&
                        value.length === 2 &&
                        ![
                            'units',
                            'buildings',
                            'projectiles',
                            'capturePoints',
                            'scheduled',
                        ].includes(key)
                            ? value.map(kind)
                            : null,
                },
            ]),
        );
    }
    stateData() {
        const sim = this.session.sim;
        if (
            sim.seed !== this.identity.seed ||
            sim.rules !== this.identity.rules ||
            sim.mapDescriptor !== this.identity.mapDescriptor
        )
            throw new Error('경기 정의가 변경되면 새 simulation Adapter가 필요합니다.');
        return sim.exportState({ includeIdentity: false });
    }
    save() {
        const started = performance.now();
        try {
            const state = this.stateData();
            return RallyStateCodec.encode({
                gameVersion: PRODUCT_VERSION,
                matchId: this.matchId,
                mapFingerprint: this.mapFingerprint,
                state,
            });
        } finally {
            if (this.session.performanceStats)
                recordTiming(
                    this.session.performanceStats.timings,
                    'save',
                    performance.now() - started,
                );
        }
    }
    readSnapshot(bytes, { tick } = {}) {
        const budget = {},
            envelope = RallyStateCodec.decode(bytes, { budget }),
            state = envelope?.state;
        if (
            envelope.gameVersion !== PRODUCT_VERSION ||
            envelope.matchId !== this.matchId ||
            envelope.mapFingerprint !== this.mapFingerprint ||
            !state ||
            Array.isArray(state) ||
            typeof state !== 'object'
        )
            throw new Error('게임 snapshot의 경기 정의가 다릅니다.');
        if (budget.nodes > budget.maxNodes) throw new Error('Snapshot exceeds the state budget');
        if (
            !Number.isSafeInteger(state.tick) ||
            state.tick < 0 ||
            state.tick > RallySimulationAdapter.maxFrameTick ||
            (tick !== undefined && state.tick !== tick) ||
            !Number.isSafeInteger(state.seq) ||
            state.seq < 0 ||
            state.seed !== this.identity.seed
        )
            throw new Error('게임 snapshot의 tick/seed가 잘못되었습니다.');
        if (JSON.stringify(LaunchRules.normalizeDeckPair(state.decks)) !== this.deckSignature)
            throw new Error('게임 snapshot의 덱이 경기 시작과 다릅니다.');
        UnitResultStats.validate(state.unitResultStats);
        for (const [key, shape] of Object.entries(this.rootShape)) {
            if (!Object.prototype.hasOwnProperty.call(state, key))
                throw new Error(`게임 snapshot의 ${key} 필드가 없습니다.`);
            const value = state[key],
                kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
            if (
                (shape.kind !== 'null' && kind !== shape.kind) ||
                (shape.items &&
                    (value.length !== 2 ||
                        shape.items.some(
                            (type, i) =>
                                type !== 'null' &&
                                (type === 'array'
                                    ? !Array.isArray(value[i])
                                    : type === 'object'
                                      ? !value[i] ||
                                        Array.isArray(value[i]) ||
                                        typeof value[i] !== 'object'
                                      : typeof value[i] !== type),
                        )))
            )
                throw new Error(`게임 snapshot의 ${key} 형식이 잘못되었습니다.`);
        }
        for (const key of Object.keys(state))
            if (
                StrategySim.stateContract.derived.has(key) ||
                StrategySim.stateContract.presentation.has(key) ||
                (Object.prototype.hasOwnProperty.call(this.identity, key) && key !== 'seed')
            )
                throw new Error(`게임 snapshot에 runtime 필드 ${key}가 있습니다.`);
        for (const key of ['units', 'buildings', 'projectiles']) {
            const ids = new Set();
            for (const entity of state[key]) {
                if (
                    !entity ||
                    Array.isArray(entity) ||
                    typeof entity !== 'object' ||
                    typeof entity.id !== 'string' ||
                    !entity.id ||
                    entity.id.length > 256 ||
                    ids.has(entity.id) ||
                    ![0, 1].includes(entity.side) ||
                    typeof entity.type !== 'string' ||
                    !Number.isFinite(entity.x) ||
                    !Number.isFinite(entity.y) ||
                    (typeof entity.alive !== 'boolean' &&
                        !(key === 'buildings' && entity.alive === undefined))
                )
                    throw new Error(`게임 snapshot의 ${key} 엔티티가 잘못되었습니다.`);
                ids.add(entity.id);
                if (key === 'units') {
                    if (
                        !Object.prototype.hasOwnProperty.call(UnitDefinition.all, entity.type) ||
                        !Number.isFinite(entity.fx) ||
                        !Number.isFinite(entity.fy) ||
                        !Number.isFinite(entity.hp) ||
                        !Number.isFinite(entity.maxHp)
                    )
                        throw new Error('게임 snapshot의 유닛 정의가 잘못되었습니다.');
                    const rhythm = UnitDefinition.get(entity.type).spinAttack?.rhythm;
                    const basicHits = entity.spinAttackBasicHits;
                    if (
                        rhythm &&
                        (!Number.isSafeInteger(basicHits) ||
                            basicHits < 0 ||
                            basicHits > rhythm.basicsPerSweep)
                    )
                        throw new Error('게임 snapshot의 회전 공격 횟수가 잘못되었습니다.');
                    RallyStateCodec.assertContract(entity, Unit.stateContract);
                    if (
                        ![null, 'unit', 'building', 'projectile'].includes(
                            entity.combat.attackWindupTargetKind,
                        ) ||
                        (entity.combat.attackWindupTargetKind === null) !==
                            (entity.combat.attackWindupTargetId === null)
                    )
                        throw new Error('게임 snapshot의 공격 준비 표적이 잘못되었습니다.');
                    HeroRollAttack.validateState(entity, state, this.session.sim.tps);
                    FruitHeroAttack.validateState(entity, state, this.session.sim.tps);
                    CannonRider.validateState(entity);
                }
                if (key === 'projectiles') {
                    if (
                        [...Projectile.stateContract.presentation].some((field) =>
                            Object.prototype.hasOwnProperty.call(entity, field),
                        )
                    )
                        throw new Error('게임 projectile snapshot에 렌더 필드가 있습니다.');
                    if (entity.payload) {
                        const shellHp = LaunchRules.grain(entity.payload.type)?.shellHp;
                        if (
                            entity.payload.type !== entity.type ||
                            !Number.isSafeInteger(shellHp) ||
                            !Number.isSafeInteger(entity.hp) ||
                            entity.hp < (entity.alive ? 1 : 0) ||
                            entity.hp > shellHp ||
                            (entity.payload.passengerHp !== undefined &&
                                (entity.payload.count !== 1 ||
                                    !UnitDefinition.get(entity.payload.type)?.cannonRider ||
                                    !Number.isFinite(entity.payload.passengerHp) ||
                                    entity.payload.passengerHp <= 0))
                        )
                            throw new Error('게임 snapshot의 투입탄 체력이 잘못되었습니다.');
                    } else if (entity.hp !== undefined) {
                        throw new Error('게임 snapshot의 투사체에 불필요한 체력이 있습니다.');
                    }
                }
                if (key === 'buildings') {
                    if (
                        !Object.prototype.hasOwnProperty.call(
                            BuildingDefinition.all,
                            entity.type,
                        ) ||
                        !Number.isFinite(entity.hp) ||
                        !Number.isFinite(entity.maxHp)
                    )
                        throw new Error('게임 snapshot의 건물 정의가 잘못되었습니다.');
                    RallyStateCodec.assertContract(entity, Building.stateContract);
                    const mortar = BuildingDefinition.get(entity.type).mortar;
                    if (
                        !Number.isSafeInteger(entity.attacksSinceMortar) ||
                        entity.attacksSinceMortar < 0 ||
                        entity.attacksSinceMortar >= (mortar?.attackInterval ?? 1)
                    )
                        throw new Error('게임 snapshot의 박격포 공격 횟수가 잘못되었습니다.');
                }
                if (
                    key === 'projectiles' &&
                    entity.mortar !== undefined &&
                    (entity.mortar !== true ||
                        entity.payload ||
                        !BuildingDefinition.get(entity.type)?.mortar)
                )
                    throw new Error('게임 snapshot의 박격포 투사체가 잘못되었습니다.');
            }
        }
        for (const group of state.launchDeployments) {
            const dropHeight = group?.emergencyDropHeightFP;
            if (
                dropHeight !== undefined &&
                (!Number.isSafeInteger(dropHeight) ||
                    dropHeight < 0 ||
                    !Number.isSafeInteger(group.heightFP) ||
                    group.heightFP < 0 ||
                    group.heightFP > dropHeight)
            )
                throw new Error('게임 snapshot의 비상 착지 높이가 잘못되었습니다.');
        }
        HeroDeployment.validate(state);
        CampaignMission.validate(state, this.session.sim.rules.campaign?.mission);
        const practice = state.campaignVolleyPractice,
            volleyGoals = this.session.sim.rules.campaign?.volleyGoals;
        const validIds = (ids) =>
            Array.isArray(ids) &&
            ids.every((id) => typeof id === 'string' && id) &&
            new Set(ids).size === ids.length;
        if (
            volleyGoals
                ? !practice ||
                  !Array.isArray(practice.goals) ||
                  practice.goals.length !== volleyGoals.length ||
                  typeof practice.complete !== 'boolean' ||
                  practice.goals.some(
                      (progress, index) =>
                          !progress ||
                          !validIds(progress.projectileIds) ||
                          !validIds(progress.garrisonIds) ||
                          progress.garrisonIds.length !== volleyGoals[index].garrison.count ||
                          typeof progress.landed !== 'boolean' ||
                          (practice.complete &&
                              (!progress.landed ||
                                  progress.projectileIds.length > 0 ||
                                  state.units.some(
                                      (unit) =>
                                          unit.alive && progress.garrisonIds.includes(unit.id),
                                  ))),
                  ) ||
                  !validIds(practice.goals.flatMap((progress) => progress.garrisonIds)) ||
                  !validIds(practice.goals.flatMap((progress) => progress.projectileIds))
                : practice !== null
        )
            throw new Error('게임 snapshot의 일제사격 연습 상태가 잘못되었습니다.');
        if (
            state.netcodeMatchResult !== undefined &&
            (!state.netcodeMatchResult ||
                !['host', 'guest'].includes(state.netcodeMatchResult.winner) ||
                state.netcodeMatchResult.reason !== 'surrender' ||
                !Number.isSafeInteger(state.netcodeMatchResult.tick) ||
                state.netcodeMatchResult.tick < 0 ||
                state.netcodeMatchResult.tick > state.tick)
        )
            throw new Error('게임 snapshot의 경기 결과가 잘못되었습니다.');
        const scheduledTicks = new Set();
        for (const entry of state.scheduled) {
            if (
                !Array.isArray(entry) ||
                entry.length !== 2 ||
                !Number.isSafeInteger(entry[0]) ||
                entry[0] <= state.tick ||
                scheduledTicks.has(entry[0]) ||
                !Array.isArray(entry[1]) ||
                entry[1].length > RallySimulationAdapter.commandsPerFrame
            )
                throw new Error('게임 snapshot의 예약 명령이 잘못되었습니다.');
            scheduledTicks.add(entry[0]);
            for (const command of entry[1]) {
                if (
                    !command ||
                    command.tick !== entry[0] ||
                    !Number.isSafeInteger(command.seq) ||
                    command.seq < 1 ||
                    !['host', 'guest'].includes(command.actor) ||
                    (command.netcodeSequence !== undefined &&
                        (!Number.isSafeInteger(command.netcodeSequence) ||
                            command.netcodeSequence < 1))
                )
                    throw new Error('게임 snapshot의 command가 잘못되었습니다.');
                RallyCommandCodec.validate(command.action);
            }
        }
        return { ...state, ...this.identity };
    }
    validateSnapshot(bytes, context) {
        try {
            this.readSnapshot(bytes, context);
            return true;
        } catch {
            return false;
        }
    }
    load(bytes) {
        const state = this.readSnapshot(bytes);
        this.session.sim.importState(state, { rollback: true });
    }
    step({
        tick,
        tickRate,
        inputs = [],
        resimulating = false,
        recovering = false,
        synctesting = false,
    }) {
        const sim = this.session.sim;
        if (
            !Number.isSafeInteger(tick) ||
            tick < 0 ||
            tick > RallySimulationAdapter.maxFrameTick ||
            sim.tick !== tick ||
            tickRate !== sim.tps ||
            !Array.isArray(inputs)
        )
            throw new Error('SDK frame과 게임 simulation tick이 다릅니다.');
        const commands = [];
        // Decode the entire resolved frame before mutating the simulation.
        for (const input of inputs) {
            if (
                !input ||
                !['host', 'guest'].includes(input.playerId) ||
                !Array.isArray(input.commands)
            )
                throw new Error('SDK 플레이어 입력이 잘못되었습니다.');
            for (const command of input.commands) {
                if (
                    commands.length >= RallySimulationAdapter.commandsPerFrame ||
                    !Number.isSafeInteger(command.sequence) ||
                    command.sequence < 1 ||
                    !Number.isSafeInteger(command.executeTick) ||
                    command.executeTick !== tick
                )
                    throw new Error('SDK resolved command가 잘못되었습니다.');
                commands.push({
                    tick: tick + 1,
                    seq: tick * RallySimulationAdapter.commandsPerFrame + commands.length + 1,
                    netcodeSequence: command.sequence,
                    actor: input.playerId,
                    action: RallyCommandCodec.decode(command.payload),
                });
            }
        }
        for (const command of commands) sim.queueCommand(command);
        const winner = sim.step();
        if (!synctesting)
            this.session.onNetcodeFrameApplied?.({
                frameTick: tick,
                gameTick: sim.tick,
                commands: StateValue.copy(commands),
                events: StateValue.copy(sim.events),
                winner,
                resimulating,
                recovering,
            });
        return winner;
    }
}

class RallySynctestDiagnostics {
    static reports = new WeakMap();
    static maxFrames = 32;
    static report(session) {
        return this.reports.get(session) || null;
    }
    static clear(session) {
        const report = this.reports.get(session);
        report?.controller?.abort();
        if (session) this.reports.delete(session);
    }
    static async run(session) {
        const core = session?.netcodeSession;
        if (!core || core.resimulating || session.disposed)
            throw new Error('활성 경기가 안정된 뒤 검사해 주세요.');
        const replay = core.exportSyncTestFrames({ maxFrames: this.maxFrames }),
            frames = replay.frames;
        if (!frames.length) throw new Error('검사할 확정 입력이 없습니다.');
        const record = { status: 'running', metrics: null, controller: new AbortController() };
        this.reports.set(session, record);
        let sim, report;
        try {
            sim = StrategySim.createForMatch({
                seed: session.sim.seed,
                rules: session.sim.rules,
                decks: session.sim.decks,
            });
            const adapter = new RallySimulationAdapter({ sim });
            adapter.load(replay.initialState);
            const result = await RallyNetcode.runSyncTestAsync({
                adapter,
                players: replay.players,
                inputSize: replay.inputSize,
                tickRate: replay.tickRate,
                initialTick: 0,
                checkDistance: Math.max(1, Math.min(6, core.profile.rollbackWindowTicks)),
                maxSnapshotBytes: RallyStateCodec.maxBytes,
                maxHistoryBytes: core.profile.maxHistoryBytes,
                frames,
                signal: record.controller.signal,
            });
            report = { status: 'passed', metrics: result.metrics };
        } catch (error) {
            report = {
                status: 'failed',
                metrics: error.syncTestMetrics || null,
                error: String(error.message || error),
            };
        } finally {
            try {
                sim?.dispose('synctest-complete');
            } catch (error) {
                report = {
                    status: 'failed',
                    metrics: report?.metrics || null,
                    error: '진단 시뮬레이션 정리 실패: ' + String(error.message || error),
                };
            }
        }
        if (this.reports.get(session) === record && !session.disposed)
            this.reports.set(session, report);
        return report;
    }
    static request(session, onUpdate) {
        if (!session || this.report(session)?.status === 'running') return;
        const queued = { status: 'running', metrics: null };
        this.reports.set(session, queued);
        onUpdate();
        setTimeout(async () => {
            if (this.reports.get(session) !== queued || session.disposed) return;
            try {
                await this.run(session);
            } catch (error) {
                if (!session.disposed && this.reports.get(session) === queued)
                    this.reports.set(session, {
                        status: 'failed',
                        metrics: error.syncTestMetrics || null,
                        error: String(error.message || error),
                    });
            }
            onUpdate();
        }, 0);
    }
}

class GameSession {
    // Is-a 경기 Coordinator. Has-a Core/Simulation Adapter/Transport.
    // tick, command executeTick, prediction, pacing, rollback, recovery는 Core의 책임이다.
    constructor(
        role,
        transport,
        roomCode,
        matchConfig = null,
        localDeck,
        { deckMode = 'own' } = {},
    ) {
        if (!['host', 'guest'].includes(role))
            throw new Error('경기 플레이어 역할이 잘못되었습니다.');
        this.role = role;
        this.transport = transport;
        this.roomCode = roomCode;
        this.deckSelection = normalizeDeckSelection(
            deckMode,
            deckMode === 'own' && localDeck === undefined ? LaunchRules.starterDeck : localDeck,
        );
        this.guestDeckMode = null;
        this.matchDecks = null;
        this.netcodeMode = netcodeMode();
        this.matchConfig = GameRuleRuntime.normalizeMatchConfig(matchConfig);
        this.matchPresetId = this.matchConfig.presetId;
        this.matchRuleOverrides = this.matchConfig.overrides;
        this.roundRules = GameRuleRuntime.resolveMatchRules({
            presetId: this.matchPresetId,
            matchOverrides: GameRuleRuntime.mergeGameRules(this.matchRuleOverrides || {}, {
                simulation: { tps: this.matchConfig.simulationTps },
            }),
        });
        if (this.matchConfig.campaignStage) {
            const stage = campaignStage(this.matchConfig.campaignStage);
            if (!stage) throw new Error('알 수 없는 캠페인 스테이지입니다.');
            this.roundRules.campaign = stage;
        }
        this.runtimeSeq = 0;
        this.sim = null;
        this.simulationAdapter = null;
        this.netcodeSession = null;
        this.detachNetcodeTransport = null;
        this.netcodeNow = performance.now();
        this.neutralInput = new Uint8Array(1);
        this.replayRecorder = null;
        this.pendingNetcodeCommands = new Map();
        this.lastCommandTicket = null;
        this.frameOutputs = new Map();
        this.candidateFrameOutputs = new Map();
        this.publishedGameTick = 0;
        this.publishConfirmedSnapshots = false;
        this.latestConfirmedSnapshot = null;
        this.pendingTerminalFrame = null;
        this.remoteTerminalReceipt = null;
        this.lastTerminalReceiptAt = 0;
        this.terminalRecoveryKey = '';
        this.recoveredJournalFrom = null;
        this.transportConnected = false;
        this.everTransportOpened = false;
        this.syncHold = true;
        this.deferredActions = [];
        this.recoveryPhase = 'idle';
        this.simpleRecoveryNeedsManual = false;
        this.simpleRecoveryToken = '';
        this.simpleRecoverySeq = 0;
        this.recoveryAttempt = 0;
        this.fullConnectionResetCount = 0;
        this.postRecoveryResumeAt = 0;
        this.postRecoveryTimer = 0;
        this.pendingResumeProbeToken = '';
        this.lastResumeProbeAckAt = 0;
        this.localVisible = true;
        this.netcodeLoop = null;
        this.last = 0;
        this.raf = 0;
        this.lastDriverPulseAt = performance.now();
        this.lastSnapshotEmitAt = 0;
        this.lastRenderedSimulationTick = -1;
        this.presentationStartPending = true;
        this.performanceStats = {
            timings: {},
            lastPulseAt: null,
            icePending: false,
            iceRequestedAt: -1000,
            iceRttMs: null,
            iceFetchedAt: null,
            iceError: null,
        };
        this.presentationEventBuffer = [];
        this.presentationPending = [];
        this.presentationEventsBuffered = 0;
        this.presentationEventsPublished = 0;
        this.presentationView = null;
        this.presentationDisplayConfigured = false;
        this.presentationJournal = createFramePresentationJournal({
            getView: () => this.presentationView,
            onImmediate: (record) => {
                if (record.kind === 'audio' && !this.localVisible) return;
                this.presentationEventBuffer.push({
                    ...record.payload,
                    presentationTick: record.tick,
                    presentationAudio: record.kind === 'audio',
                });
                this.presentationEventsBuffered++;
            },
        });
        this.simEnded = false;
        this.matchResult = null;
        this.simulationFatal = false;
        this.simulationFatalInfo = null;
        this.disconnectGraceDeadlineAt = 0;
        this.disconnectGraceReason = '';
        this.disconnectGraceTimer = 0;
        this.onSimulationStarted = null;
        this.onSimulationStopped = null;
        this.onSimulationFatal = null;
        this.onSnapshot = () => {};
        this.onRenderTargets = () => {};
        this.onLog = () => {};
        this.onResult = () => {};
        this.onNetworkHealth = () => {};
        this.networkOpened = false;
        this.heartbeatTimer = 0;
        this.lastPingAt = 0;
        this.lastPongAt = 0;
        this.lastRtt = null;
        this.networkState = 'hidden';
        transport.onMessage = (m) => this.handle(m);
    }
    get confirmedGameTick() {
        return this.netcodeSession
            ? Math.min(this.sim?.tick || 0, this.netcodeSession.confirmedTick + 1)
            : 0;
    }
    getPendingCommandTickets() {
        return [...this.pendingNetcodeCommands.values()].map((ticket) => StateValue.copy(ticket));
    }
    cancelScheduledWork() {
        this.clearDisconnectGrace();
        this.clearPostRecoveryCountdown();
        this.stopHeartbeat(false);
        this.netcodeLoop?.stop();
        this.onSimulationStopped?.(this);
    }
    dispose(reason = 'session-replaced') {
        this.presentationJournal?.dispose();
        this.presentationPending.length = 0;
        if (this.disposed) return false;
        this.disposed = true;
        RallySynctestDiagnostics.clear(this);
        this.simEnded = true;
        this.syncHold = true;
        this.cancelScheduledWork();
        this.netcodeSession?.close();
        this.detachNetcodeTransport?.();
        this.detachNetcodeTransport = null;
        this.deferredActions.length = 0;
        this.pendingNetcodeCommands.clear();
        this.frameOutputs.clear();
        this.candidateFrameOutputs.clear();
        try {
            this.sim?.dispose(reason);
        } finally {
            this.transport.onMessage = () => {};
            this.transport.onOpen = () => {};
            this.transport.onClose = () => {};
            this.transport.onPeerReady = () => {};
            this.transport.onError = () => {};
            this.transport.close();
        }
        return true;
    }
    resolveDisconnectGrace() {
        if (this.simEnded || !this.disconnectGraceDeadlineAt) {
            this.clearDisconnectGrace();
            return false;
        }
        const remain = this.disconnectGraceDeadlineAt - Date.now();
        if (remain > 20) {
            this.disconnectGraceTimer = setTimeout(
                () => this.resolveDisconnectGrace(),
                remain + 20,
            );
            return false;
        }
        this.clearDisconnectGrace();
        // 연결 만료는 로컬 경기 중단이다. wall-clock으로 simulation 승자를 만들지 않는다.
        return this.endMatch(null, 'disconnect-timeout');
    }
    endMatch(winner, reason = 'base-destroyed') {
        if (this.simEnded) return false;
        this.simEnded = true;
        this.presentationJournal?.dispose();
        this.presentationDisplayConfigured = false;
        this.presentationPending.length = 0;
        this.matchResult = { winner: winner || null, reason, tick: this.sim?.tick || 0 };
        this.cancelScheduledWork();
        this.syncHold = true;
        this.netcodeLoop?.resetTiming();
        this.replayRecorder?.finalize(winner, this.sim, reason);
        this.netcodeSession?.close();
        this.sim?.dispose('match-ended');
        this.onResult(winner, reason);
        return true;
    }
    surrender() {
        if (this.simEnded) return false;
        if (!this.sim) {
            this.transport.send({ type: 'LOBBY_LEAVE' });
            return this.endMatch(this.role === 'host' ? 'guest' : 'host', 'surrender');
        }
        return this.command({ type: 'MATCH_SURRENDER' });
    }
    onTransportOpen() {
        if (this.disposed) return;
        const reconnect = this.everTransportOpened;
        this.transportConnected = true;
        this.everTransportOpened = true;
        this.syncHold = this.simEnded || !!this.sim;
        if (!reconnect || !this.sim) {
            this.simpleRecoveryNeedsManual = false;
            this.recoveryPhase = 'idle';
            this.clearDisconnectGrace();
        }
        this.netcodeLoop?.resetTiming();
        this.startHeartbeat();
        if (!reconnect) this.start();
        else if (!this.sim) {
            if (this.role === 'guest') this.start();
        } else this.onLog('P2P 재연결 · 공통 코어의 입력 이력으로 재개');
        this.flushDeferredActions();
    }
    onTransportClosed() {
        if (this.disposed || this.simulationFatal || !this.everTransportOpened || this.simEnded)
            return;
        if (this.netcodeSession) return; // Core transport status events own in-game liveness.
        this.markManualRecoveryNeeded('transport-close');
        this.startDisconnectGrace('transport-close');
        this.onLog('P2P 연결 끊김 · 입력 대기 · 60초 안에 재접속 필요');
    }
    markManualRecoveryNeeded(reason = 'connection-lost') {
        if (this.simEnded) return false;
        this.transportConnected = false;
        this.syncHold = true;
        this.netcodeLoop?.resetTiming();
        this.simpleRecoveryReason = reason;
        this.simpleRecoveryNeedsManual = true;
        this.recoveryPhase = 'needs-manual';
        this.stopHeartbeat(true);
        recordRecovery('netcode.connection-lost', this, this.transport, {
            reason,
        });
        return true;
    }
    prepareSimpleRecovery(token, reason = 'manual-reconnect') {
        if (!this.sim || this.simEnded) return false;
        this.simpleRecoveryToken = String(token || '');
        this.simpleRecoveryReason = reason;
        this.transportConnected = false;
        this.syncHold = true;
        this.netcodeLoop?.resetTiming();
        this.simpleRecoveryNeedsManual = false;
        this.recoveryPhase = 'reconnecting';
        this.stopHeartbeat(false);
        return true;
    }
    startSimpleRecovery(reason = 'manual-reconnect') {
        if (!this.sim || this.simEnded) return false;
        if (this.transportConnected && this.transport.isNetcodeOpen?.()) {
            if (this.role === 'guest')
                return this.netcodeSession.requestResync(Math.max(0, this.confirmedGameTick - 1));
            return this.transport.send({
                type: 'NETCODE_RESYNC_REQUEST',
                gameVersion: PRODUCT_VERSION,
            });
        }
        this.prepareSimpleRecovery(String(++this.simpleRecoverySeq), reason);
        const ok =
            this.role === 'host'
                ? this.transport.prepareRecoveryHost?.(reason)
                : this.transport.rebuildRecoveryGuest?.(reason);
        if (!ok) {
            this.simpleRecoveryNeedsManual = true;
            this.recoveryPhase = 'needs-manual';
        }
        return !!ok;
    }
    balanceTelemetry() {
        return balanceTelemetrySnapshot(this.sim);
    }
    presentFrame(frame) {
        if (this.presentationDisplayConfigured && !this.disposed)
            this.presentationJournal.present(frame);
    }
    flushPresentationEvents(snapshot) {
        if (!this.presentationView) return;
        for (const frame of this.presentationPending.splice(0))
            emitFramePresentationEvents(
                this.presentationJournal,
                this.presentationView,
                frame.tick,
                attachPublishedVisibility(frame.events, this.presentationView),
            );
        if (snapshot) {
            const immediate = this.presentationEventBuffer.splice(0);
            this.presentationEventsPublished += immediate.length;
            snapshot.events.push(...immediate);
        }
    }
    finishPresentationEvent(record) {
        return this.presentationJournal.finish(record);
    }
    setLocalVisibility(visible) {
        const resumed = !this.localVisible && !!visible;
        this.localVisible = !!visible;
        if (this.presentationDisplayConfigured)
            this.presentationJournal.setPresentationActive(this.localVisible);
        if (!this.localVisible && this.presentationDisplayConfigured) {
            this.flushPresentationEvents(null);
            this.presentationEventBuffer = this.presentationEventBuffer.filter(
                (event) => !event.presentationAudio,
            );
        }
        if (!visible) this.netcodeSession?.releaseInput();
        else if (resumed && this.sim?.tick > 0) this.renderTimelineChanged = true;
    }
    onBacklogDrop({
        elapsedMs = 0,
        droppedMs = 0,
        droppedTicks = 0,
        timestamp = performance.now(),
        reason = 'backlog-overflow',
    } = {}) {
        // This discards wall-clock debt, not confirmed simulation ticks. The Core's
        // authoritative tick sequence and recovery history remain untouched.
        this.lastDriverPulseAt = timestamp;
        this.netcodeNow = Math.max(this.netcodeNow, timestamp);
        // The authoritative tick is unchanged, but the delayed display clock must
        // rebase after discarded wall time instead of remaining ahead of every target.
        if (this.sim?.tick > 0) this.renderTimelineChanged = true;
        const activeSession =
            !!this.netcodeSession?.ready &&
            this.transportConnected &&
            this.sim?.tick > 0 &&
            this.confirmedGameTick > 0;
        recordRecovery('simulation.backlog-drop', this, this.transport, {
            elapsedMs,
            droppedMs,
            droppedTicks,
            reason,
            phase: activeSession ? 'timing-rebase' : 'bootstrap',
        });
    }
    emitNetworkHealth(state = this.networkState) {
        if (this.simulationFatal) state = 'fatal';
        this.networkState = state;
        this.lastRtt = this.netcodeSession?.metrics.smoothedRTT ?? this.lastRtt;
        this.onNetworkHealth({
            state,
            simulationFatal: this.simulationFatal,
            simulationFatalInfo: this.simulationFatalInfo,
            rtt: this.lastRtt,
            silence: this.sim ? 0 : this.lastPongAt ? Date.now() - this.lastPongAt : 0,
            recoveryPhase: this.recoveryPhase,
            recoveryAttempt: this.recoveryAttempt,
            connectionSerial: this.transport?.connectionSerial || 0,
            acceptedConnectionSerial: this.transport?.lastAcceptedConnectionSerial || 0,
            transportLastDataAt: this.transport?.lastDataAt || 0,
        });
    }
    startHeartbeat() {
        this.stopHeartbeat(false);
        if (this.sim) return;
        this.networkOpened = true;
        this.lastPongAt = Date.now();
        this.emitNetworkHealth('connected');
        this.heartbeatTimer = setInterval(() => {
            if (!this.networkOpened || this.simEnded || this.sim) return;
            const silence = Date.now() - this.lastPongAt;
            this.emitNetworkHealth(silence >= 4000 ? 'unstable' : 'connected');
            // 로비 생존 확인일 뿐 simulation clock과 입력 지연은 Core가 측정한다.
            if (Date.now() - this.lastPingAt >= 1000) {
                this.lastPingAt = Date.now();
                this.transport.send({ type: 'LOBBY_PING', ts: this.lastPingAt });
            }
        }, NETWORK_HEALTH_POLL_MS);
    }
    inputAvailable() {
        return (
            !this.disposed &&
            !this.simEnded &&
            !this.simulationFatal &&
            !this.pendingTerminalFrame &&
            this.transportConnected &&
            !this.syncHold
        );
    }
    command(action) {
        if (
            !this.inputAvailable() ||
            !this.sim ||
            !this.netcodeSession ||
            this.netcodeSession.resimulating ||
            this.pendingNetcodeCommands.size >= 128
        )
            return false;
        try {
            this.netcodeNow = Math.max(this.netcodeNow, performance.now());
            const sequence = this.netcodeSession.queueCommand(RallyCommandCodec.encode(action));
            const ticket = {
                sequence,
                actor: this.role,
                key: StableSerializationUtil.stableStringify(action),
                submittedTick: this.sim.tick,
                submittedAt: performance.now(),
                action: StateValue.copy(action),
            };
            this.lastCommandTicket = ticket;
            this.pendingNetcodeCommands.set(sequence, ticket);
            return true;
        } catch (error) {
            this.onLog('명령 접수 실패 · ' + error.message);
            return false;
        }
    }
    handle(m) {
        if (this.disposed || !m || typeof m !== 'object') return;
        if (
            m.type === 'VERSION_MISMATCH' ||
            (['HELLO', 'GAME_START', 'NETCODE_RESYNC_REQUEST', 'MATCH_TERMINAL_ACK'].includes(
                m.type,
            ) &&
                m.gameVersion !== PRODUCT_VERSION)
        ) {
            if (m.type !== 'VERSION_MISMATCH')
                this.transport.send({ type: 'VERSION_MISMATCH', gameVersion: PRODUCT_VERSION });
            this.syncHold = true;
            this.transport.onError({
                type: 'version-mismatch',
                nonFatal: true,
                expectedVersion: PRODUCT_VERSION,
                remoteVersion: m.gameVersion,
                message: `게임 버전이 다릅니다. 내 v${PRODUCT_VERSION} / 상대 ${m.gameVersion ?? '확인 불가'}. 양쪽 모두 같은 최신 게임으로 새로고침하세요.`,
            });
            return;
        }
        if (!this.sim) this.lastPongAt = Date.now();
        if (m.type === 'SIMULATION_FATAL') {
            this.enterSimulationFatal(new Error(m.message || '상대 simulation 오류'), {
                source: 'peer-simulation-fatal',
                notifyPeer: false,
                remoteInfo: m,
            });
            return;
        }
        if (m.type === 'LOBBY_PING') {
            this.transport.send({ type: 'LOBBY_PONG', ts: m.ts });
            return;
        }
        if (m.type === 'LOBBY_PONG') {
            if (!this.sim) this.lastRtt = Math.max(0, Date.now() - Number(m.ts));
            return;
        }
        if (m.type === 'LOBBY_LEAVE' && !this.sim) {
            this.endMatch(this.role, 'surrender');
            return;
        }
        if (m.type === 'MATCH_TERMINAL_ACK' && this.sim && !this.simEnded) {
            if (
                !Number.isSafeInteger(m.tick) ||
                m.tick < 1 ||
                !Number.isInteger(m.hash) ||
                m.hash < 0 ||
                m.hash > 0xffffffff ||
                !['host', 'guest', 'draw'].includes(m.winner)
            )
                return;
            this.remoteTerminalReceipt = {
                tick: m.tick,
                hash: m.hash,
                winner: m.winner,
                reason: String(m.reason || ''),
            };
            this.tryFinishTerminalBarrier();
            return;
        }
        if (m.type === 'NETCODE_RESYNC_REQUEST' && this.role === 'guest' && this.netcodeSession) {
            this.netcodeSession.requestResync(Math.max(0, this.confirmedGameTick - 1));
            return;
        }
        if (m.type === 'GAME_START' && this.role === 'guest') {
            if (this.sim || this.simEnded) return;
            let decks;
            try {
                decks = LaunchRules.normalizeDeckPair(m.decks);
            } catch {
                return;
            }
            if (!matchesDeckSelection(this.deckSelection, decks[1])) return;
            this.matchDecks = decks;
            if (m.matchConfig) this.applyMatchConfig(m.matchConfig, { authoritative: true });
            if (m.roundRules && typeof m.roundRules === 'object')
                this.roundRules = StateValue.copy(m.roundRules);
            this.netcodeMode = netcodeMode(m.netcodeMode);
            this.startSim(m.seed);
            return;
        }
        if (m.type === 'HELLO' && this.role === 'host') {
            let guestSelection;
            try {
                guestSelection = normalizeDeckSelection(m.deckMode, m.deck);
            } catch {
                return;
            }
            if (!this.matchDecks) {
                this.matchDecks = [
                    resolveDeckSelection(this.deckSelection),
                    resolveDeckSelection(guestSelection),
                ];
                this.guestDeckMode = guestSelection.deckMode;
            } else if (
                guestSelection.deckMode !== this.guestDeckMode ||
                !matchesDeckSelection(guestSelection, this.matchDecks[1])
            )
                return;
            // Resolve once so an interrupted START or a reconnect receives the same decks.
            if (this.sim) this.sendGameStart();
            else this.beginGame();
        }
    }
    static matchSeed(roomCode) {
        return HashUtil.hash(`${roomCode}|launch`);
    }
    sendGameStart() {
        return this.transport.send({
            type: 'GAME_START',
            gameVersion: PRODUCT_VERSION,
            seed: this.roundRules.campaign?.seed ?? GameSession.matchSeed(this.roomCode),
            matchConfig: this.matchConfig,
            roundRules: this.roundRules,
            netcodeMode: this.netcodeMode,
            decks: this.matchDecks,
        });
    }
    beginGame() {
        if (this.sim || !this.sendGameStart()) return false;
        this.startSim(this.roundRules.campaign?.seed ?? GameSession.matchSeed(this.roomCode));
        return true;
    }
    startSim(seed) {
        if (this.disposed || this.sim) return false;
        if (!globalThis.RallyNetcode) throw new Error('URL Netcode가 로딩되지 않았습니다.');
        this.clearDisconnectGrace();
        this.clearPostRecoveryCountdown();
        this.sim = StrategySim.createForMatch({
            seed,
            rules: this.roundRules,
            decks: this.matchDecks,
        });
        this.presentationDisplayConfigured = configureFramePresentationJournal(
            this.presentationJournal,
            this.presentationView,
            this.sim.tps,
            this.localVisible,
        );
        this.simulationAdapter = new RallySimulationAdapter(this);
        this.replayRecorder = new ReplayRecorder({
            seed,
            roomCode: this.roomCode,
            sim: this.sim,
            rules: this.roundRules,
        });
        this.simEnded = false;
        this.matchResult = null;
        this.publishedGameTick = 0;
        this.netcodeLoop?.resetTiming();
        this.emitSnapshot(this.sim.snapshot());
        this.emitRenderTargets(this.sim, true);
        this.netcodeNow = performance.now();
        // Express Rally's lockstep command lead in milliseconds across the TPS choices.
        // Core adapts within these bounds and waits for late inputs; no missing input is predicted.
        const baseInputDelay = Math.max(
            1,
            Math.ceil((LOCKSTEP_INPUT_DELAY_BASE_MS * this.sim.tps) / 1000),
        );
        const inputDelayProfile =
            this.netcodeMode === 'lockstep'
                ? {
                      baseInputDelayTicks: baseInputDelay,
                      minInputDelayTicks: baseInputDelay,
                      maxInputDelayTicks: Math.floor(
                          (LOCKSTEP_INPUT_DELAY_MAX_MS * this.sim.tps) / 1000,
                      ),
                  }
                : {};
        this.netcodeSession = RallyNetcode.createSession({
            players: ['host', 'guest'],
            localPlayerId: this.role,
            authorityPlayerId: 'host',
            sessionId: String(this.roomCode),
            simulationVersion: PRODUCT_VERSION,
            seed: seed >>> 0,
            inputSize: 1,
            profile: {
                ...RallyNetcode.profiles.rts,
                mode: this.netcodeMode,
                rollbackWindowTicks:
                    this.netcodeMode === 'lockstep'
                        ? 0
                        : RallyNetcode.profiles.rts.rollbackWindowTicks,
                ...inputDelayProfile,
                tickRate: this.sim.tps,
                maxCatchupSteps: MAX_CATCHUP_STEPS_PER_PULSE,
                checksumInterval: 20,
                maxCommandBytes: 12 * 1024,
                maxHistoryBytes: 64 * 1024 * 1024,
                maxSnapshotBytes: RallyStateCodec.maxBytes,
            },
            adapter: this.simulationAdapter,
            clock: () => this.netcodeNow,
            onEvent: (event) => this.onNetcodeEvent(event),
        });
        const statusTransport = this.transport;
        this.detachNetcodeTransport = this.netcodeSession.attachTransport(
            this.role === 'host' ? 'guest' : 'host',
            {
                send: (bytes) => this.transport.sendNetcode(bytes),
                // Stamp arrivals with the current time; the loop's frame clock may not have run yet.
                subscribe: (listener) =>
                    this.transport.subscribeNetcode((bytes) => {
                        this.netcodeNow = Math.max(this.netcodeNow, performance.now());
                        listener(bytes);
                    }),
                ...(typeof statusTransport.subscribeNetcodeStatus === 'function'
                    ? {
                          subscribeStatus: (listener) =>
                              statusTransport.subscribeNetcodeStatus(listener),
                          get state() {
                              return statusTransport.netcodeState;
                          },
                      }
                    : {}),
            },
        );
        this.netcodeNow = performance.now();
        this.lastDriverPulseAt = this.netcodeNow;
        this.lastSnapshotEmitAt = this.netcodeNow;
        this.stopHeartbeat(false);
        // A slow CPU pulse is not a suspended page. Core runs fixed ticks in order,
        // within the per-pulse budget, and retains at most three seconds of debt.
        this.netcodeLoop = RallyNetcode.createLoop({
            session: this.netcodeSession,
            getInput: () => this.neutralInput,
            backlogPolicy: 'defer',
            maxBacklogTicks: Math.ceil(this.sim.tps * 3),
            onBacklogDrop: (event) => this.onBacklogDrop(event),
            beforeFrame: (now) => {
                // Keep presentation history through recoverable rAF/CPU gaps. Core's
                // accumulator preserves their ordered fixed ticks; discarded debt is
                // rebased by onBacklogDrop. Only a real page suspension needs this guard.
                const gap = Math.max(0, now - this.lastDriverPulseAt);
                if (this.sim.tick > 0 && gap >= SIM_SUSPENSION_THRESHOLD_MS)
                    this.renderTimelineChanged = true;
                this.lastDriverPulseAt = now;
                this.netcodeNow = Math.max(this.netcodeNow, now);
                this.driverPulseStartedAt = performance.now();
                this.driverPulseAdvances = 0;
            },
            // Poll/rollback remains synchronous and atomic inside Core. Always permit
            // the first due ordinary step, then yield catchup after 12 ms of CPU work.
            canAdvance: () => {
                if (
                    this.simEnded ||
                    this.simulationFatal ||
                    this.pendingTerminalFrame ||
                    this.syncHold ||
                    this.frameOutputs.get(this.sim.tick)?.winner
                )
                    return false;
                // Yielding ordinary catchup defers a fixed tick; it does not reset presentation history.
                if (
                    this.driverPulseAdvances > 0 &&
                    performance.now() - this.driverPulseStartedAt >= 12
                )
                    return false;
                return true;
            },
            onAdvance: () => {
                this.driverPulseAdvances++;
                this.reconcileNetcodeProgress();
            },
            render: (frame) => {
                this.driverLastAlpha = frame.alpha;
                this.reconcileNetcodeProgress();
                this.reconcileNetcodePresentation();
                this.publishNetcodeSnapshot(this.netcodeNow);
            },
            onError: (error) => this.enterSimulationFatal(error, { source: 'netcode-loop' }),
        });
        this.syncHold = !this.transportConnected;
        this.onSimulationStarted?.(this);
        return true;
    }
    onNetcodeFrameApplied(frame) {
        frame.presentationEvents = this.presentationView
            ? captureFramePresentationEvents(frame.events, this.sim)
            : frame.events;
        // Candidate resimulation은 commit 전까지 UI/AI/replay/VFX에 공개하지 않는다.
        if (frame.winner) {
            frame.terminalState = this.simulationAdapter.save();
            frame.reason =
                this.sim.netcodeMatchResult?.reason ||
                (frame.winner === 'draw'
                    ? 'draw'
                    : frame.winner === 'host' && this.sim.campaignVolleyPractice?.complete
                      ? 'volley-practice'
                      : 'base-destroyed');
        }
        if (
            this.publishConfirmedSnapshots &&
            frame.gameTick %
                Math.max(1, Math.round((this.sim.tps * SNAPSHOT_EMIT_INTERVAL_MS) / 1000)) ===
                0
        )
            frame.snapshot = this.sim.snapshot();
        (frame.recovering ? this.candidateFrameOutputs : this.frameOutputs).set(
            frame.gameTick,
            frame,
        );
    }
    onNetcodeEvent(event) {
        if (event.type === 'peer-interrupted') {
            this.syncHold = true;
            this.recoveryPhase = 'interrupted';
            this.emitNetworkHealth('unstable');
            this.onLog('공통 코어 입력 통신 중단 · 유효 패킷 수신을 기다립니다.');
        } else if (['peer-timeout', 'peer-disconnected'].includes(event.type)) {
            this.markManualRecoveryNeeded(event.type);
            this.startDisconnectGrace(event.type);
            this.onLog('공통 코어 연결 끊김 · 60초 안에 재접속 필요');
        } else if (event.type === 'peer-resumed') {
            this.transportConnected = true;
            this.simpleRecoveryNeedsManual = false;
            this.recoveryPhase = 'idle';
            this.clearDisconnectGrace();
            this.syncHold = !!this.pendingTerminalFrame || this.simEnded || this.simulationFatal;
            // Rebase if the presentation clock advanced while simulation was held.
            if (this.sim?.tick > 0) this.renderTimelineChanged = true;
            this.netcodeLoop?.resetTiming();
            this.emitNetworkHealth('connected');
            this.flushDeferredActions();
        } else if (event.type === 'rollback') {
            for (const tick of this.frameOutputs.keys())
                if (tick > event.from) this.frameOutputs.delete(tick);
            this.renderTimelineChanged = true;
        } else if (event.type === 'reconciled') {
            this.renderTimelineChanged = true;
            this.reconcileNetcodeProgress();
        } else if (event.type === 'desync') {
            this.onLog('상태 해시 불일치 · 공통 코어의 과거 snapshot 검증/재실행');
        } else if (event.type === 'recovered') {
            const terminal = [...this.candidateFrameOutputs.values()]
                .filter((frame) => frame.winner)
                .sort((a, b) => a.gameTick - b.gameTick)[0];
            if (terminal || this.pendingTerminalFrame) this.recoveredJournalFrom = event.from;
            for (const [tick, frame] of this.candidateFrameOutputs)
                this.frameOutputs.set(tick, frame);
            this.candidateFrameOutputs.clear();
            this.terminalRecoveryKey = '';
            this.recoveryAttempt = 0;
            this.renderTimelineChanged = true;
            this.recoveryPhase = 'idle';
        } else if (['recovery-rejected', 'recovery-timeout'].includes(event.type)) {
            this.candidateFrameOutputs.clear();
            this.terminalRecoveryKey = '';
            this.onLog('Snapshot 복구 후보 거부 · ' + (event.reason || '시간 초과'));
        } else if (
            ['version-mismatch', 'handshake-mismatch'].includes(event.type) ||
            (event.type === 'protocol-error' && !this.netcodeSession?.ready)
        ) {
            this.enterSimulationFatal(
                new Error(
                    '게임 버전 또는 동기화 설정이 다릅니다. 양쪽 모두 새로고침하고 같은 동기화 모드를 선택하세요. (' +
                        event.type +
                        ')',
                ),
                { source: 'netcode-handshake' },
            );
        } else if (event.type === 'desync-unrecoverable')
            this.enterSimulationFatal(new Error('공통 넷코드 복구 시도를 소진했습니다.'), {
                source: 'netcode-recovery',
            });
        else if (event.type === 'fatal')
            this.enterSimulationFatal(event.error, { source: 'netcode-adapter' });
    }
    publishConfirmedFrames() {
        if (!this.netcodeSession || this.netcodeSession.resimulating) return;
        if (this.recoveredJournalFrom !== null) {
            const from = this.recoveredJournalFrom;
            this.recoveredJournalFrom = null;
            this.publishedGameTick = Math.min(this.publishedGameTick, from);
            // Recovered frames replace only batches that have not reached the
            // presentation journal yet. Its confirmed watermark still owns events
            // already delivered before this rollback.
            this.presentationPending = this.presentationPending.filter(
                (frame) => frame.tick <= from,
            );
            this.replayRecorder.commands = this.replayRecorder.commands.filter(
                (command) => command.tick <= from,
            );
            this.replayRecorder.checkpoints = this.replayRecorder.checkpoints.filter(
                (checkpoint) => checkpoint.tick <= from,
            );
            // 복구가 잘못된 조기 승패를 제거할 수도 있다. 정확한 frame journal을
            // 다시 확정하며, 승패가 없다면 같은 Core의 정상 진행으로 복귀한다.
            this.pendingTerminalFrame = null;
            this.syncHold = !this.transportConnected || this.simulationFatal || this.simEnded;
        }
        if (this.pendingTerminalFrame) return;
        const through = this.confirmedGameTick;
        while (this.publishedGameTick < through) {
            const tick = this.publishedGameTick + 1,
                frame = this.frameOutputs.get(tick);
            if (!frame) throw new Error('확정 frame journal 누락: ' + tick);
            for (const command of frame.commands) {
                // 기존 replay 파일의 command schema에만 변환한다. 이 메시지는 네트워크로 보내지 않는다.
                this.replayRecorder?.recordCommand({
                    type: 'RUNTIME_COMMIT',
                    ...command,
                    authorityTick: frame.frameTick,
                });
                this.runtimeSeq++;
                if (command.actor === this.role) {
                    const ticket = this.pendingNetcodeCommands.get(command.netcodeSequence);
                    if (Number.isFinite(ticket?.submittedAt))
                        recordTiming(
                            this.performanceStats.timings,
                            'commandConfirm',
                            performance.now() - ticket.submittedAt,
                        );
                    this.pendingNetcodeCommands.delete(command.netcodeSequence);
                }
            }
            this.presentationJournal.update(performance.now());
            // Recovery may republish the authoritative journal, but already heard timeline
            // intervals must stay silent even when corrected events have different identities.
            if (tick > this.presentationJournal.confirmedTick) {
                if (this.presentationView && this.localVisible)
                    this.presentationPending.push({ tick, events: frame.presentationEvents });
                else
                    emitFramePresentationEvents(
                        this.presentationJournal,
                        this.presentationView,
                        tick,
                        frame.presentationEvents,
                    );
            }
            if (frame.snapshot) this.latestConfirmedSnapshot = frame.snapshot;
            this.publishedGameTick = tick;
            if (frame.winner) {
                this.beginTerminalBarrier(frame);
                break;
            }
        }
        // History는 Core가 소유한다. 이 작은 journal은 외부 효과 중복 방지용이다.
        const before = this.publishedGameTick - 2;
        for (const tick of this.frameOutputs.keys())
            if (tick < before) this.frameOutputs.delete(tick);
        if (this.sim.tick <= through && !this.simEnded)
            this.replayRecorder?.captureCheckpoint(this.sim);
    }
    beginTerminalBarrier(frame) {
        // 이 ACK는 상대의 동일한 확정 판정 확인이다. 수신 메시지로 승자를 정하지 않는다.
        this.pendingTerminalFrame = frame;
        this.syncHold = true;
        this.netcodeLoop?.resetTiming();
        this.sendTerminalReceipt();
        this.tryFinishTerminalBarrier();
    }
    sendTerminalReceipt() {
        const frame = this.pendingTerminalFrame;
        if (!frame || this.simEnded) return;
        if (
            this.transport.send({
                type: 'MATCH_TERMINAL_ACK',
                gameVersion: PRODUCT_VERSION,
                tick: frame.gameTick,
                hash: RallyNetcode.hashBytes(frame.terminalState),
                winner: frame.winner,
                reason: frame.reason,
            })
        )
            this.lastTerminalReceiptAt = this.netcodeNow;
    }
    tryFinishTerminalBarrier() {
        const frame = this.pendingTerminalFrame,
            receipt = this.remoteTerminalReceipt;
        if (!receipt || this.simEnded || this.netcodeSession.resimulating) return;
        if (!frame) {
            if (this.role === 'guest' && this.confirmedGameTick >= receipt.tick)
                this.requestTerminalResync(receipt);
            return;
        }
        if (
            receipt.tick !== frame.gameTick ||
            receipt.hash !== RallyNetcode.hashBytes(frame.terminalState) ||
            receipt.winner !== frame.winner ||
            receipt.reason !== frame.reason
        ) {
            // 종료 경계의 실제 DESYNC도 동일 public snapshot 복구를 사용한다.
            // Host는 ACK를 계속 전송하며, Guest는 과거 state를 검증·재실행한다.
            if (this.role === 'guest') this.requestTerminalResync(receipt);
            return;
        }
        this.finishConfirmedOutcome(frame);
    }
    requestTerminalResync(receipt) {
        const key = receipt.tick + ':' + receipt.hash;
        if (this.terminalRecoveryKey === key) return;
        if (this.recoveryAttempt >= 3) {
            this.enterSimulationFatal(new Error('확정 종료 상태를 복구하지 못했습니다.'), {
                source: 'terminal-recovery-exhausted',
            });
            return;
        }
        const past = Math.max(0, Math.min(receipt.tick - 1, this.confirmedGameTick - 1));
        if (this.netcodeSession.requestResync(past)) {
            this.terminalRecoveryKey = key;
            this.recoveryAttempt++;
            this.onLog('종료 상태 해시 불일치 · 과거 snapshot 검증/재실행');
        }
    }
    finishConfirmedOutcome(frame) {
        if (this.simEnded) return;
        // 늦은 실제 입력의 승패가 rollback target보다 이른 경우에도 양쪽 모두
        // 동일한 종료 frame을 보존한다. Core를 종료한 뒤에만 terminal state를 복원한다.
        this.netcodeSession.close();
        this.simulationAdapter.load(frame.terminalState);
        this.emitRenderTargets(this.sim, true);
        const snapshot = this.sim.snapshot();
        // Confirmed journal batches are the sole owner of presentation events.
        // The restored terminal state can still contain an already-published sim event.
        snapshot.events = StateValue.copy(this.presentationEventBuffer.splice(0));
        this.presentationEventsPublished += snapshot.events.length;
        this.emitSnapshot(snapshot);
        this.endMatch(frame.winner === 'draw' ? null : frame.winner, frame.reason);
    }
    reconcileNetcodeProgress() {
        if (this.simEnded || this.simulationFatal) return;
        this.publishConfirmedFrames();
        if (this.pendingTerminalFrame && this.netcodeNow - this.lastTerminalReceiptAt >= 500)
            this.sendTerminalReceipt();
        this.tryFinishTerminalBarrier();
    }
    reconcileNetcodePresentation() {
        if (this.simEnded || this.simulationFatal) return;
        // The first capture can predate peer readiness, so reanchor on the first advancing tick.
        const startPresentationTimeline = this.presentationStartPending && this.sim.tick > 0;
        if (
            !this.netcodeSession.resimulating &&
            !this.simEnded &&
            (this.renderTimelineChanged ||
                this.lastRenderedSimulationTick !== this.sim.tick ||
                startPresentationTimeline)
        ) {
            this.emitRenderTargets(
                this.sim,
                !!this.renderTimelineChanged || startPresentationTimeline,
            );
            this.lastRenderedSimulationTick = this.sim.tick;
            this.renderTimelineChanged = false;
            if (startPresentationTimeline) this.presentationStartPending = false;
        }
    }
    emitSnapshot(snapshot) {
        const started = performance.now();
        try {
            const result = this.onSnapshot(snapshot);
            this.lastSnapshotPublication = {
                sim: this.sim,
                tick: this.sim?.tick,
                epoch: this.sim?.runtimeEpoch,
                publishedTick: this.publishedGameTick,
                confirmed: this.latestConfirmedSnapshot,
            };
            return result;
        } finally {
            // Presentation batches are consumed at most once, not persistent world state.
            // The renderer, audio and HUD synchronously consume them in onSnapshot.
            snapshot.events = [];
            recordTiming(this.performanceStats.timings, 'snapshotUi', performance.now() - started);
        }
    }
    emitRenderTargets(sim, snap) {
        const started = performance.now();
        try {
            return this.onRenderTargets(sim, snap);
        } finally {
            recordTiming(
                this.performanceStats.timings,
                'renderTargets',
                performance.now() - started,
            );
        }
    }
    publishNetcodeSnapshot(now = this.netcodeNow) {
        const previous = this.lastSnapshotPublication;
        const presentationChanged =
            !previous ||
            previous.sim !== this.sim ||
            previous.tick !== this.sim.tick ||
            previous.epoch !== this.sim.runtimeEpoch ||
            previous.publishedTick !== this.publishedGameTick ||
            this.presentationEventBuffer.length > 0 ||
            this.presentationPending.length > 0 ||
            (this.publishConfirmedSnapshots && previous.confirmed !== this.latestConfirmedSnapshot);
        if (
            presentationChanged &&
            !this.netcodeSession.resimulating &&
            now - this.lastSnapshotEmitAt >= SNAPSHOT_EMIT_INTERVAL_MS
        ) {
            this.lastSnapshotEmitAt = now;
            const snapshot = this.publishConfirmedSnapshots
                ? this.latestConfirmedSnapshot
                : this.sim.snapshot();
            if (snapshot) {
                snapshot.events = StateValue.copy(this.presentationEventBuffer.splice(0));
                this.presentationEventsPublished += snapshot.events.length;
                this.emitSnapshot(snapshot);
            }
        }
    }
    advanceSimulation(now = performance.now()) {
        if (!this.sim || this.simEnded || this.simulationFatal) return;
        // Library owns pacing, accumulation, bounded catchup, and polling during holds.
        this.netcodeLoop.pulse(now);
    }
    enterSimulationFatal(
        err,
        { source = 'simulation', notifyPeer = true, remoteInfo = null } = {},
    ) {
        if (this.simulationFatal) return false;

        const wasConnected = !!this.transportConnected;
        const localTick = this.sim?.tick ?? null;
        const localChecksum = this.simulationChecksumSafe();
        const message = String(
            remoteInfo?.message || err?.message || err || 'Unknown simulation error',
        );
        const stack = String(err?.stack || '').slice(0, 12000);
        const info = {
            message,
            stack,
            source: String(remoteInfo?.source || source || 'simulation'),
            tick: Number.isFinite(Number(remoteInfo?.tick)) ? Number(remoteInfo.tick) : localTick,
            localTick,
            role: this.role,
            originRole: String(remoteInfo?.originRole || this.role),
            roomCode: this.roomCode,
            runtimeSeq: Number.isFinite(Number(remoteInfo?.runtimeSeq))
                ? Number(remoteInfo.runtimeSeq)
                : this.runtimeSeq,
            localRuntimeSeq: this.runtimeSeq,
            checksum: remoteInfo?.checksum != null ? String(remoteInfo.checksum) : localChecksum,
            localChecksum,
            recoveryPhase: this.recoveryPhase,
            syncHold: !!this.syncHold,
            transportConnected: wasConnected,
            remote: !!remoteInfo,
            at: new Date().toISOString(),
        };

        this.simulationFatal = true;
        this.simulationFatalInfo = info;
        this.syncHold = true;
        this.transportConnected = false;
        this.netcodeLoop?.resetTiming();

        this.recoveryPhase = 'simulation-fatal';
        this.deferredActions.length = 0;
        this.pendingNetcodeCommands.clear();
        this.clearDisconnectGrace();
        this.clearPostRecoveryCountdown();
        this.netcodeSession?.close();
        this.stopHeartbeat(false);
        this.onSimulationStopped?.(this);

        recordRecovery('simulation.fatal', this, this.transport, {
            fatal: { ...info, stack: undefined },
            error: { message, stack },
        });
        this.onSimulationFatal?.(info, err);
        console.error('simulation fatal', info, err);
        this.onLog(`시뮬레이션 오류로 중단 · tick ${localTick ?? '-'} · ${message}`);

        if (notifyPeer && wasConnected) {
            try {
                this.transport.send({
                    type: 'SIMULATION_FATAL',
                    source: info.source,
                    message,
                    tick: localTick,
                    runtimeSeq: this.runtimeSeq,
                    checksum: localChecksum,
                    originRole: this.role,
                });
            } catch {}
        }

        this.emitNetworkHealth('fatal');

        // Closing the channel is a second safety barrier: even an older peer that does
        // not understand SIMULATION_FATAL will enter its existing transport sync hold.
        if (wasConnected) {
            queueMicrotask(() => {
                try {
                    this.transport?.close?.();
                } catch {}
            });
        }
        return true;
    }
    applyMatchConfig(config, { authoritative = false } = {}) {
        if (this.sim) return false;
        if (this.role === 'host' && !authoritative && config == null) return false;
        this.matchConfig = GameRuleRuntime.normalizeMatchConfig(config);
        this.matchPresetId = this.matchConfig.presetId;
        this.matchRuleOverrides = this.matchConfig.overrides;
        this.roundRules = GameRuleRuntime.resolveMatchRules({
            presetId: this.matchPresetId,
            matchOverrides: GameRuleRuntime.mergeGameRules(this.matchRuleOverrides || {}, {
                simulation: { tps: this.matchConfig.simulationTps },
            }),
        });
        return true;
    }
    // The host waits for a real guest HELLO; a guest can repeat it after reconnect.
    start() {
        if (this.role === 'guest')
            return this.transport.send({
                type: 'HELLO',
                gameVersion: PRODUCT_VERSION,
                ...this.deckSelection,
            });
        return true;
    }
    simulationChecksumSafe() {
        try {
            return this.sim?.checksum?.() ?? null;
        } catch {
            return null;
        }
    }
    clearDisconnectGrace() {
        if (this.disconnectGraceTimer) {
            clearTimeout(this.disconnectGraceTimer);
            this.disconnectGraceTimer = 0;
        }
        this.disconnectGraceDeadlineAt = 0;
        this.disconnectGraceReason = '';
    }
    startDisconnectGrace(reason = 'connection-lost') {
        if (this.simEnded) return false;
        if (!this.disconnectGraceDeadlineAt)
            this.disconnectGraceDeadlineAt = Date.now() + DISCONNECT_GRACE_MS;
        this.disconnectGraceReason = reason;
        if (this.disconnectGraceTimer) clearTimeout(this.disconnectGraceTimer);
        const delay = Math.max(0, this.disconnectGraceDeadlineAt - Date.now());
        this.disconnectGraceTimer = setTimeout(() => this.resolveDisconnectGrace(), delay + 20);
        this.emitNetworkHealth('disconnected');
        return true;
    }
    clearPostRecoveryCountdown() {
        if (this.postRecoveryTimer) {
            clearTimeout(this.postRecoveryTimer);
            this.postRecoveryTimer = 0;
        }
        this.postRecoveryResumeAt = 0;
    }
    flushDeferredActions() {
        if (!this.transportConnected || this.syncHold || !this.sim || !this.deferredActions.length)
            return;

        const queued = this.deferredActions.splice(0, 16);
        for (const action of queued) this.command(action);
    }
    stopHeartbeat(markDisconnected = true) {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = 0;
        }
        const hadConnection = this.networkOpened;
        this.networkOpened = false;
        if (markDisconnected && hadConnection) this.emitNetworkHealth('disconnected');
    }
    simulationTps() {
        return RangeUtil.clamp(
            Math.round(
                Number(
                    this.sim?.tps ||
                        this.roundRules?.simulation?.tps ||
                        this.matchConfig?.simulationTps,
                ) || SIM_TPS,
            ),
            10,
            30,
        );
    }
    msTicks(ms, options) {
        return SimulationTiming.msToTicks(ms, this.simulationTps(), options);
    }
    ticksMs(ticks) {
        return SimulationTiming.ticksToMs(ticks, this.simulationTps());
    }
}

export { GameSession, RallySynctestDiagnostics };
