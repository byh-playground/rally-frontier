// Single-player launch bot. It plays through the same GameSession command interface as a human,
// whether it runs in the page or in src/sim-worker.js. The old RTS bot lives in legacy/rts-sim/ai/.
import { RangeUtil, SIM_TPS } from '../core/game-rules.js';
import { StateValue } from '../sim/components.js';
import { LaunchRules } from '../sim/launch-rules.js';
import { ConnectionSideUtil, StableSerializationUtil } from '../net/lobby-codec.js';
import { HashUtil } from '../sim/map-generation.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { UnitDefinition } from '../definitions/units.js';
import { SimulationTiming } from '../core/simulation-timing.js';
import { BOT_LAUNCH_RULES } from '../sim/capabilities/bot-launch-rules.js';

// Tracks the bot's commands from offer to the sim's receipt, so a shot already paid for
// is not paid again from a snapshot that predates it.
class AiCommandExecutor {
    constructor(bot) {
        this.bot = bot;
        this.pending = [];
        this.queue = [];
        this.state = null;
        this.epoch = -1;
    }
    static key(action) {
        return StableSerializationUtil.stableStringify(action);
    }
    reservations(state = this.state) {
        const receipts = this.bot.session.sim?.commandReceipts || [];
        return this.pending
            .filter(
                (entry) =>
                    !receipts.some(
                        (r) =>
                            r.netcodeSequence === entry.netcodeSequence &&
                            r.actor === entry.actor &&
                            r.tick <= (state?.tick ?? -1),
                    ),
            )
            .concat(this.queue);
    }
    reconcile(state) {
        const session = this.bot.session,
            sim = session.sim,
            receipts = sim?.commandReceipts || [],
            epochChanged = this.epoch !== sim?.runtimeEpoch,
            confirmedTick = Math.min(state.tick, session.confirmedGameTick ?? state.tick);
        const matches = (entry, sequence, actor) =>
            entry.netcodeSequence === sequence && entry.actor === actor;
        const tickets = session.getPendingCommandTickets();
        this.pending = this.pending.filter((entry) => {
            const receipt = receipts.find((r) => matches(entry, r.netcodeSequence, r.actor));
            if (receipt && receipt.tick <= confirmedTick) return false;
            if (
                !epochChanged ||
                receipt ||
                tickets.some((ticket) => matches(entry, ticket.sequence, ticket.actor))
            )
                return true;
            for (const list of sim?.scheduled?.values?.() || [])
                if (list.some((c) => matches(entry, c.netcodeSequence, c.actor))) return true;
            return false;
        });
        this.epoch = sim?.runtimeEpoch;
    }
    begin(snapshot) {
        this.reconcile(snapshot);
        this.queue = [];
        // An isolated decision view, never a mutation of a published snapshot.
        const view = {
            ...snapshot,
            wallet: snapshot.wallet.slice(),
            premiumWallet: snapshot.premiumWallet.slice(),
            launchRangeLevel: snapshot.launchRangeLevel.slice(),
            aiPopulation: LaunchRules.population(snapshot, this.bot.side).total,
            aiReservedPopulation: 0,
        };
        for (const p of this.reservations(snapshot)) {
            view.wallet[this.bot.side] -= p.cost;
            view.premiumWallet[this.bot.side] -= p.premiumCost;
            if (p.action.type === 'UPGRADE_LAUNCH_RANGE') view.launchRangeLevel[this.bot.side]++;
            else if (p.action.type === 'LAUNCH')
                view.aiReservedPopulation += LaunchRules.payload(p.action.unitType)?.count || 0;
        }
        this.state = view;
        return view;
    }
    offer(action) {
        if (!this.state) return false;
        const session = this.bot.session;
        if (
            session.disposed ||
            session.simEnded ||
            session.netcodeSession?.resimulating ||
            (typeof session.inputAvailable === 'function' && !session.inputAvailable())
        )
            return false;
        const key = AiCommandExecutor.key(action),
            side = this.bot.side,
            cost =
                action.type === 'UPGRADE_LAUNCH_RANGE'
                    ? LaunchRules.upgradeCost(this.state.launchRangeLevel[side])
                    : LaunchRules.payload(action.unitType)?.cost,
            premiumCost =
                action.type === 'UPGRADE_LAUNCH_RANGE'
                    ? LaunchRules.upgradePremiumCost(this.state.launchRangeLevel[side])
                    : LaunchRules.payload(action.unitType)?.premiumCost;
        if (
            cost == null ||
            this.reservations().some((p) => p.key === key) ||
            this.state.wallet[side] < cost ||
            this.state.premiumWallet[side] < premiumCost ||
            (action.type === 'LAUNCH' &&
                this.state.aiPopulation + this.state.aiReservedPopulation >=
                    LaunchRules.populationLimit)
        )
            return false;
        this.queue.push({ key, action: StateValue.copy(action), cost, premiumCost });
        this.state.wallet[side] -= cost;
        this.state.premiumWallet[side] -= premiumCost;
        if (action.type === 'UPGRADE_LAUNCH_RANGE') this.state.launchRangeLevel[side]++;
        else if (action.type === 'LAUNCH')
            this.state.aiReservedPopulation += LaunchRules.payload(action.unitType).count;
        return true;
    }
    dispose() {
        const sim = this.bot.session.sim;
        if (sim) this.reconcile({ tick: sim.tick });
        this.pending = [];
        this.queue = [];
        this.state = null;
    }
    flush() {
        const session = this.bot.session;
        for (const entry of this.queue) {
            if (session.command(entry.action) !== true) continue;
            const ticket = session.lastCommandTicket;
            if (
                !ticket ||
                ticket.actor !== this.bot.role ||
                ticket.key !== entry.key ||
                !Number.isSafeInteger(ticket.sequence)
            )
                throw new Error('AI 명령의 Netcode 제출 영수증이 없습니다.');
            Object.assign(entry, { actor: ticket.actor, netcodeSequence: ticket.sequence });
            this.pending.push(entry);
        }
        this.queue = [];
        this.state = null;
    }
}

const DECISION_INTERVAL_MS = 1_000;

class BotController {
    static attach(session, role) {
        const bot = new BotController(session, { role });
        session.publishConfirmedSnapshots = true;
        session.onSnapshot = (state) => bot.handleSnapshot(state);
        session.onLog = () => {};
        session.onResult = () => bot.stop();
        session.onNetworkHealth = () => {};
        return bot;
    }
    constructor(session, options = {}) {
        this.session = session;
        this.commandExecutor = new AiCommandExecutor(this);
        this.role = options.role || session.role || 'guest';
        this.side = ConnectionSideUtil.roleSide(this.role);
        this.enabled = true;
        this.lastLaunchTick = -99999;
    }

    stop() {
        this.enabled = false;
        this.commandExecutor.dispose();
    }

    handleSnapshot(snapshot) {
        if (!this.enabled || !snapshot || this.session.netcodeSession?.resimulating) return;
        if (snapshot.tick > (this.session.confirmedGameTick ?? snapshot.tick)) {
            this.commandExecutor.reconcile(snapshot);
            return;
        }
        const tps = snapshot.tps || SIM_TPS;
        const pacing = this.side === 1 ? this.session.sim?.rules?.campaign?.enemyPacing : null;
        if (pacing?.disabled) return;
        if (
            pacing &&
            snapshot.tick < SimulationTiming.msToTicks(pacing.firstDecisionMs, tps, { min: 0 })
        )
            return;

        const state = this.commandExecutor.begin(snapshot);
        try {
            const intervalMs = BotController.decisionIntervalMs(
                pacing,
                state.tick,
                tps,
                state.wallet[this.side] >= LaunchRules.walletCap,
            );
            if (state.tick - this.lastLaunchTick >= SimulationTiming.msToTicks(intervalMs, tps)) {
                this.lastLaunchTick = state.tick;
                this.runLaunch(state);
            }
        } finally {
            this.commandExecutor.flush();
        }
    }
    // 모든 AI 공통 결정 간격. 캠페인 적은 첫 결정 뒤 이 값에서 시작해 `endIntervalMs`까지 `rampMs`에 걸쳐 선형으로 길어진다.
    // 지갑이 가득 차면(수입이 버려지는 상태) 어떤 설정이든 기본 간격으로 결정한다.
    static decisionIntervalMs(pacing, tick, tps, walletFull) {
        if (walletFull || !pacing?.rampMs) return DECISION_INTERVAL_MS;
        const elapsedMs = (tick / tps) * 1000 - pacing.firstDecisionMs;
        const t = Math.min(1, Math.max(0, elapsedMs / pacing.rampMs));
        return DECISION_INTERVAL_MS + (pacing.endIntervalMs - DECISION_INTERVAL_MS) * t;
    }
    static distance(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    static shotAt(cannons, target, deck, level, support = 0) {
        let shot = null;
        for (const cannon of cannons) {
            const distance = this.distance(cannon, target);
            if (shot && distance >= shot.distance) continue;
            const units = deck.filter(
                ({ type }) => distance <= LaunchRules.maxReachOf(type, level) + support,
            );
            if (units.length) shot = { cannon, target, units, distance };
        }
        return shot;
    }

    captureObjectives(state) {
        const side = this.side,
            distance = BotController.distance,
            reserved = this.commandExecutor.reservations(),
            ownUnits = state.units.filter(
                (unit) =>
                    unit.alive &&
                    unit.side === side &&
                    !UnitDefinition.onlyAttacksBuildings(unit.type),
            );
        return state.capturePoints
            .filter((point) => point.owner == null)
            .flatMap((point) => {
                const project = state.buildings.find(
                    (building) =>
                        building.id === point.outpostId &&
                        building.alive !== false &&
                        building.construction,
                );
                if (project ? project.side !== side : point.enabled === false) return [];
                const inTransit =
                    reserved.some(
                        ({ action }) =>
                            action.type === 'LAUNCH' &&
                            !UnitDefinition.onlyAttacksBuildings(action.unitType) &&
                            action.x === point.x &&
                            action.y === point.y,
                    ) ||
                    state.projectiles.some(
                        (shot) =>
                            shot.side === side &&
                            shot.payload &&
                            !UnitDefinition.onlyAttacksBuildings(shot.payload.type) &&
                            distance({ x: shot.lockedAimX, y: shot.lockedAimY }, point) <=
                                LaunchRules.captureHoldRadius,
                    ) ||
                    state.launchDeployments.some(
                        (group) => group.side === side && group.holdPointId === point.id,
                    );
                const workers = ownUnits.filter(
                    (unit) =>
                        unit.launchHoldPointId === point.id ||
                        (project && unit.constructionWork?.targetId === project.id) ||
                        distance(unit, point) <= 200,
                ).length;
                return [{ point, project, supported: inTransit || workers >= 4 }];
            });
    }

    static hasOil(point) {
        return (point?.production.premium?.incomePerSecond ?? 0) > 0;
    }

    static captureShot(cannons, objectives, deck, level) {
        const support = LaunchRules.captureHoldRadius - 100;
        const workers = deck.filter(({ type }) => {
            const unit = UnitDefinition.get(type);
            return unit?.construction && !unit.captureExcluded;
        });
        return objectives
            .filter(({ supported }) => !supported)
            .flatMap(({ point, project }) => {
                const shot = this.shotAt(cannons, point, workers, level, support);
                return shot ? [{ ...shot, project }] : [];
            })
            .sort(
                (a, b) =>
                    Number(this.hasOil(b.target)) - Number(this.hasOil(a.target)) ||
                    a.distance - b.distance,
            )[0];
    }

    static nearestShot(cannons, targets, deck, level) {
        let best = null;
        for (const target of targets) {
            const shot = this.shotAt(cannons, target, deck, level);
            if (shot && (!best || shot.distance < best.distance)) best = shot;
        }
        return best;
    }

    fire(shot, unit, level, tick, aimExactly = false) {
        const { cannon, target, distance } = shot;
        const error = aimExactly
            ? 1
            : 1 + ((HashUtil.hash(`${tick}|${cannon.id}|err`) % 241) - 120) / 1000;
        this.commandExecutor.offer({
            type: 'LAUNCH',
            cannonId: cannon.id,
            x: Math.round(target.x),
            y: Math.round(target.y),
            holdMs: Math.round(
                RangeUtil.clamp(
                    LaunchRules.holdFor(distance, unit.type, level) * error,
                    0,
                    LaunchRules.chargeMs,
                ),
            ),
            unitType: unit.type,
        });
    }

    chooseCombatUnit(shot, state, budget, hasIncome, enemies, urgent = false) {
        const side = this.side,
            stats = state.unitResultStats[side],
            clustered =
                enemies.filter((unit) => BotController.distance(unit, shot.target) <= 120).length >=
                3;
        const suitable = shot.units.filter((unit) => unit.premiumCost <= state.premiumWallet[side]);
        const specialists = suitable.filter((unit) => unit.premiumCost > 0);
        const pool = !urgent && specialists.length ? specialists : suitable;
        const deployedVolleys = ({ type, count }) => (stats[type]?.deployed || 0) / count;
        const effect = ({ type }) => {
            const definition = UnitDefinition.get(type);
            if (
                BuildingDefinition.get(shot.target.type) &&
                UnitDefinition.onlyAttacksBuildings(type)
            )
                return 3;
            if (clustered && (definition.lobAttack || definition.spinAttack)) return 2;
            if (BuildingDefinition.get(shot.target.type) && definition.role === 'ranged') return 1;
            return 0;
        };
        const ranked = pool
            .filter((unit) => (urgent || !hasIncome ? unit.cost <= budget : true))
            .sort(
                (a, b) =>
                    effect(b) - effect(a) ||
                    deployedVolleys(a) - deployedVolleys(b) ||
                    b.cost - a.cost,
            );
        const unit = ranked[0];
        return unit?.cost <= budget ? unit : null;
    }

    // Runs the capability-owned launch rules of one stage (src/sim/capabilities/bot-launch-rules.js).
    runCapabilityLaunch(stage, context) {
        for (const rule of BOT_LAUNCH_RULES) {
            if (rule.stage !== stage) continue;
            const units = context.cards.filter(
                ({ type }) => UnitDefinition.get(type)[rule.capability],
            );
            if (!units.length) continue;
            const action = rule.shot({
                ...context,
                units,
                nearestShot: BOT_NEAREST_SHOT,
                maxReachOf: BOT_MAX_REACH_OF,
            });
            if (action) {
                this.fire(action.shot, action.unit, context.level, context.state.tick, true);
                return true;
            }
        }
        return false;
    }
    runLaunch(state) {
        const side = this.side,
            distance = BotController.distance,
            level = state.launchRangeLevel[side],
            main = BuildingDefinition.forRole('mainBase'),
            outpost = BuildingDefinition.forRole('outpost'),
            constructionCost = BuildingDefinition.get(outpost).construction.cost,
            cards = state.decks[side]
                .filter((type) => !LaunchRules.isHeroType(type))
                .map((type) => ({ type, ...LaunchRules.payload(type) })),
            // Cards whose capability rule owns their shot never join ordinary targeting.
            deck = cards.filter(
                ({ type }) =>
                    !BOT_LAUNCH_RULES.some(
                        (rule) => rule.ownShotOnly && UnitDefinition.get(type)[rule.capability],
                    ),
            ),
            groundDeck = deck.filter(({ type }) => UnitDefinition.get(type).canAttackGround);
        const busy = new Set(
            this.commandExecutor.reservations().map(({ action }) => action.cannonId),
        );
        const buildings = state.buildings.filter((b) => b.side === side && b.alive !== false);
        const cannons = buildings.filter(
            (b) => LaunchRules.readyToLaunch(state, b) && !busy.has(b.id),
        );
        if (!cannons.length) return;
        const base = buildings.find((b) => b.type === main),
            enemies = state.units.filter((u) => u.alive && u.side === 1 - side),
            hostile = state.buildings.filter((b) => b.alive !== false && b.side === 1 - side),
            enemyBase = hostile.find((b) => b.type === main),
            hasIncome =
                LaunchRules.incomePerSecondFor(
                    [...state.baseProducers, ...state.capturePoints],
                    side,
                ) > 0;
        const threat =
            base &&
            BotController.nearestShot(
                cannons,
                enemies.filter((unit) => distance(unit, base) <= 900),
                groundDeck,
                level,
            );
        if (threat) {
            const unit = this.chooseCombatUnit(
                threat,
                state,
                state.wallet[side],
                hasIncome,
                enemies,
                true,
            );
            if (unit) this.fire(threat, unit, level, state.tick, true);
            return;
        }
        const rules = { state, side, cards, cannons, hostile, enemyBase, level, distance };
        if (this.runCapabilityLaunch('opening', rules)) return;

        const budget =
            state.wallet[side] -
            buildings.reduce(
                (sum, b) =>
                    sum + (b.construction ? b.construction.cost - b.construction.invested : 0),
                0,
            );
        const objectives = this.captureObjectives(state);
        const capture = BotController.captureShot(cannons, objectives, deck, level);
        const premiumTargets = hostile.filter((b) =>
            state.capturePoints.some(
                (point) => point.outpostId === b.id && BotController.hasOil(point),
            ),
        );
        if (level < 2) {
            const nextCapture = BotController.captureShot(cannons, objectives, deck, level + 1);
            const unlocksCapture =
                nextCapture &&
                (!capture ||
                    (BotController.hasOil(nextCapture.target) &&
                        !BotController.hasOil(capture.target)));
            const unlocksPremiumAttack =
                !capture &&
                !BotController.nearestShot(cannons, premiumTargets, deck, level) &&
                BotController.nearestShot(cannons, premiumTargets, deck, level + 1);
            if (unlocksCapture || unlocksPremiumAttack) {
                const upgradeCost = LaunchRules.upgradeCost(level);
                if (budget >= upgradeCost) {
                    this.commandExecutor.offer({ type: 'UPGRADE_LAUNCH_RANGE' });
                    return;
                }
                if (hasIncome) return;
            }
        }
        const premiumShot = BotController.nearestShot(cannons, premiumTargets, deck, level);
        if (
            premiumShot &&
            !BotController.hasOil(capture?.target) &&
            LaunchRules.incomePerSecondFor(state.capturePoints, side, 'premium') === 0
        ) {
            const unit = this.chooseCombatUnit(premiumShot, state, budget, hasIncome, enemies);
            if (unit) this.fire(premiumShot, unit, level, state.tick);
            return;
        }
        if (capture) {
            const spendable = budget - (capture.project ? 0 : constructionCost);
            const contested = enemies.some((unit) => distance(unit, capture.target) <= 300);
            const priority = ({ type }) => {
                const definition = UnitDefinition.get(type);
                if (contested) return definition.hp;
                const walk = Math.max(0, capture.distance - LaunchRules.maxReachOf(type, level));
                return -walk / (definition.speed * (definition.outOfCombatMoveMultiplier || 1));
            };
            const unit = capture.units
                .filter(
                    (unit) =>
                        unit.cost <= spendable && unit.premiumCost <= state.premiumWallet[side],
                )
                .sort((a, b) => priority(b) - priority(a) || a.cost - b.cost)[0];
            if (unit) {
                this.fire(capture, unit, level, state.tick, true);
                return;
            }
            if (hasIncome) return;
        }

        let shot =
            BotController.nearestShot(cannons, enemies, groundDeck, level) ||
            premiumShot ||
            BotController.nearestShot(cannons, hostile, deck, level);
        if (!shot && this.runCapabilityLaunch('fallback', { ...rules, budget })) return;
        if (!shot && enemyBase && !objectives.some(({ supported }) => supported)) {
            const cannon = cannons.reduce((best, candidate) =>
                distance(candidate, enemyBase) < distance(best, enemyBase) ? candidate : best,
            );
            shot = {
                cannon,
                target: enemyBase,
                distance: distance(cannon, enemyBase),
                units: deck,
            };
        }
        if (!shot) return;
        const unit = this.chooseCombatUnit(shot, state, budget, hasIncome, enemies);
        if (unit) this.fire(shot, unit, level, state.tick);
    }
}

const BOT_NEAREST_SHOT = (...args) => BotController.nearestShot(...args);
const BOT_MAX_REACH_OF = (type, level) => LaunchRules.maxReachOf(type, level);

export { BotController };
