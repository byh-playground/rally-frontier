/**
 * 주소로 여는 확인·측정용 장면(`?debug=1&scene=이름&tick=N&…`, GameKit debug-tools installDebugHost).
 * 일반 실행에서는 불러오지 않는다. 호스트는 debug·scene·tick만 읽고 나머지는 문자열 그대로 넘기므로
 * 값의 형식은 각 장면이 정하고, 틀리면 그대로 실패한다. 장면 목록·예시 주소는 AGENTS.md "디버그 장면"에 있다.
 *
 * 모든 장면은 카드 시연과 같은 경로(src/ui/sim-scene.js prepareSimScene: GameKit scenario + 경기 렌더러 + 경기
 * 연출)로 돈다. 표시는 가상 시계로 틱에서만 시간을 읽어 같은 주소가 같은 그림을 만들고, 시뮬레이션 틱
 * 시간은 실제 시계로 잰다(StrategySim.step의 기존 계측).
 */
import { BuildingDefinition } from './definitions/buildings.js';
import { FP } from './core/config.js';
import { GameRuleRuntime } from './core/game-rules.js';
import { campaignStage } from './definitions/campaign.js';
import { LaunchRules } from './sim/launch-rules.js';
import { HashUtil } from './sim/map-generation.js';
import { RESOURCE_SCALE } from './units/baseline.js';
import { BotController } from './ai/bot-controller.js';
import { UnitDefinition } from './definitions/units.js';
import { StableSerializationUtil } from './net/lobby-codec.js';
import { RollingBody } from './sim/capabilities/rolling-body.js';
import { UnitFlight } from './sim/capabilities/unit-flight.js';
import { UnitBreathAttack } from './sim/capabilities/unit-breath-attack.js';
import { UnitChainAttack } from './sim/capabilities/unit-chain-attack.js';
import { Knockback } from './sim/knockback.js';
import { StrategySim } from './sim/strategy-sim.js';
import { createShowcaseSurface } from './ui/showcase-host.js';
import {
    baseAxis,
    battleFocus,
    blockSpacing,
    buildOutpost,
    centerCamera,
    placeBlock,
    prepareSimScene,
    queueLaunch,
} from './ui/sim-scene.js';
import { prepareTitleScenes } from './ui/title-scenes.js';
import { prepareUnitShowcase } from './ui/unit-showcase.js';

// The virtual clock starts here, so absolute-time animation is the same on every open. A page must open its
// scene before this much real time has passed, or a published presentation time would run backwards.
const EPOCH_MS = 10_000_000;
// Stage names of StrategySim's once-a-second profile sample (src/diagnostics/simulation-stats.js).
const STAGES = Object.freeze({
    total: 'totalMs',
    index: 'indexMs',
    world: 'worldMs',
    vision: 'visionMs',
    combat: 'combatMs',
    targetPick: 'combatTargetPickMs',
    collision: 'collisionMs',
    collisionSolve: 'collisionSolveMs',
    projectile: 'projectileMs',
    post: 'postMs',
});
const round = (value) => Math.round(value * 100) / 100;
// The `mix-battle` cards: the ordinary deck (no hero) without the builder sesame, whose edge is outpost work, and
// without the cards that cannot hit a ground unit (peanut, sticky rice: buildings and cannons only).
const MIX_POOL = Object.freeze(
    LaunchRules.deck.filter(
        (type) => type !== 'sesame' && !UnitDefinition.onlyAttacksBuildings(type),
    ),
);
// How quickly the launch scene's following camera catches up with the squad (ms, exponential).
const FOLLOW_MS = 400;

function integer(scene, name, text) {
    if (!/^\d+$/.test(text ?? '')) throw new Error(`${scene} needs an integer ${name}: ${text}`);
    return Number(text);
}
// A positive number such as 1.6 or 0.25 (a camera zoom below 1 shows more of the map).
function positive(scene, name, text) {
    if (!/^(\d+|\d*\.\d+)$/.test(text ?? '') || !(Number(text) > 0))
        throw new Error(`${scene} needs a positive number ${name}: ${text}`);
    return Number(text);
}
function unitType(scene, name, text) {
    if (!UnitDefinition.get(text))
        throw new Error(`${scene} needs a unit type for ${name}: ${text}`);
    return text;
}
function flag(scene, name, text) {
    if (text !== undefined && text !== '1')
        throw new Error(`${scene} takes ${name}=1 or nothing: ${text}`);
    return text === '1';
}

// A match on one of the PvP maps (game-rules.js presets), with both sides' decks at the starter deck, or both at
// `deck` (comma-separated cards, LaunchRules.normalizeDeck checks it).
function createMatchSim(scene, map, seed, deck = undefined) {
    const rules = GameRuleRuntime.resolveMatchRules({ presetId: map });
    if (deck === undefined) return new StrategySim(integer(scene, 'seed', seed), rules);
    const cards = String(deck).split(',');
    return new StrategySim(integer(scene, 'seed', seed), rules, [cards, cards]);
}

// Every capture point gets a completed outpost of the side whose main base is nearer.
function completeOutposts(sim) {
    const { host, guest } = baseAxis(sim);
    for (const point of sim.capturePoints) {
        const side =
            Math.hypot(point.x - host.x, point.y - host.y) <=
            Math.hypot(point.x - guest.x, point.y - guest.y)
                ? 0
                : 1;
        buildOutpost(sim, point, side);
    }
}

// The match AI plays the given sides through the session surface BotController reads (as in the Worker host);
// what it decides on a tick's state runs on the next tick. `fired[role]` counts each side's launched cards.
function attachBots(sim, roles = ['host', 'guest']) {
    let sequence = 0;
    const fired = { host: {}, guest: {} };
    const bots = roles.map((role) => {
        const session = {
            role,
            sim,
            disposed: false,
            simEnded: false,
            netcodeSession: null,
            lastCommandTicket: null,
            getPendingCommandTickets: () => [],
            command(action) {
                sequence++;
                if (action.type === 'LAUNCH')
                    fired[role][action.unitType] = (fired[role][action.unitType] || 0) + 1;
                sim.queueCommand({
                    tick: sim.tick + 1,
                    seq: sequence,
                    netcodeSequence: sequence,
                    actor: role,
                    action,
                });
                this.lastCommandTicket = {
                    actor: role,
                    key: StableSerializationUtil.stableStringify(action),
                    sequence,
                };
                return true;
            },
        };
        return new BotController(session, { role });
    });
    const decide = () => {
        const snapshot = sim.snapshot();
        for (const bot of bots) bot.handleSnapshot(snapshot);
    };
    decide.fired = fired;
    return decide;
}

// Card ammo (CardAmmo), read by `state().ammo` of `ai-match`·`campaign`: per side, per ammo card, `uses` (rounds
// spent), `empties` (uses that left 0), `waits` (ticks from a use that left 0 to the card's next use, first 12),
// `rejected` (launches refused as card-out-of-ammo). An independent model replays the observed spends with the
// card's max and recharge ticks: `overdrawn` counts spends the model had no round for and `mismatches` the ticks
// whose sim rounds differ from the model (both must be 0).
function createAmmoProbe(sim) {
    const cards = sim.decks.map((deck) =>
        deck.map((type) => {
            const spec = LaunchRules.ammo(type);
            return (
                spec && {
                    type,
                    max: spec.max,
                    ticks: Math.floor((spec.rechargeMs * sim.tps) / 1000),
                    rounds: spec.max,
                    ready: 0,
                    uses: 0,
                    empties: 0,
                    emptyTick: null,
                    waits: [],
                }
            );
        }),
    );
    const rejected = [0, 0];
    let seen = sim.tick,
        overdrawn = 0,
        mismatches = 0;
    return {
        // Before a step: sim.events are the last tick's (its commands, then its recharge).
        observe() {
            if (sim.tick === seen) return;
            seen = sim.tick;
            for (const event of sim.events) {
                if (event.type === 'launchRejected' && event.reason === 'card-out-of-ammo')
                    rejected[event.side]++;
                if (event.type !== 'cardAmmoSpent') continue;
                const card = cards[event.side][sim.decks[event.side].indexOf(event.unitType)];
                if (card.rounds <= 0) overdrawn++;
                if (card.emptyTick !== null && card.waits.length < 12)
                    card.waits.push(sim.tick - card.emptyTick);
                card.emptyTick = null;
                card.rounds--;
                card.uses++;
                if (!card.ready) card.ready = sim.tick + card.ticks;
                if (card.rounds === 0) {
                    card.empties++;
                    card.emptyTick = sim.tick;
                }
            }
            for (const [side, list] of cards.entries())
                for (const [index, card] of list.entries()) {
                    if (!card) continue;
                    if (card.ready && sim.tick >= card.ready) {
                        card.rounds++;
                        card.ready = card.rounds < card.max ? card.ready + card.ticks : 0;
                    }
                    if (sim.cardAmmo[side].rounds[index] !== card.rounds) mismatches++;
                }
        },
        state: () => ({
            sides: cards.map((list) =>
                Object.fromEntries(
                    list
                        .filter(Boolean)
                        .map(({ type, max, ticks, uses, empties, waits }) => [
                            type,
                            { max, rechargeTicks: ticks, uses, empties, waits },
                        ]),
                ),
            ),
            rejected: rejected.slice(),
            overdrawn,
            mismatches,
        }),
    };
}

// Reads what the game already measures after every tick: StrategySim.step's tick time, its once-a-second stage
// sample and the contact solver's counts.
function createTickLog() {
    const ticks = [],
        tickMs = [],
        samples = [],
        contacts = { skippedPairs: 0, maxSkippedPairs: 0, maxPairContacts: 0, maxCasts: 0 },
        // A dead unit stays in the sim (and on screen) while it still has impact motion: ticks in the air, sliding
        // on the ground, and lying still until its recovery tick, per unit id.
        corpses = new Map();
    let last = null,
        deaths = 0;
    const summary = (values) => {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        return {
            mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
            p95: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]),
            max: round(sorted[sorted.length - 1]),
        };
    };
    return {
        record(sim) {
            const perf = sim.perfStats;
            ticks.push(sim.tick);
            tickMs.push(perf.lastStepMs);
            if (perf.sampleTick === sim.tick)
                samples.push(
                    Object.fromEntries([
                        ['tick', sim.tick],
                        ...Object.entries(STAGES).map(([name, key]) => [name, perf[key]]),
                    ]),
                );
            const stats = sim.navigation.motion.contacts.stats;
            contacts.skippedPairs += stats.skippedPairs;
            contacts.maxSkippedPairs = Math.max(contacts.maxSkippedPairs, stats.skippedPairs);
            contacts.maxPairContacts = Math.max(contacts.maxPairContacts, stats.pairContacts);
            contacts.maxCasts = Math.max(contacts.maxCasts, stats.casts);
            last = { ...stats };
            for (const event of sim.events) if (event.type === 'death') deaths++;
            for (const unit of sim.units) {
                const motion = unit.impactMotion;
                if (unit.alive || !motion) continue;
                let corpse = corpses.get(unit.id);
                if (!corpse) corpses.set(unit.id, (corpse = { air: 0, slide: 0, rest: 0 }));
                if (motion.heightFP > 0 || motion.vzFP > 0) corpse.air++;
                else if (motion.vxFP || motion.vyFP) corpse.slide++;
                else corpse.rest++;
            }
        },
        state(times) {
            const slowest = tickMs.indexOf(Math.max(...tickMs));
            const stage = (pick) =>
                Object.fromEntries(
                    Object.keys(STAGES).map((name) => [
                        name,
                        pick(samples.map((sample) => sample[name])),
                    ]),
                );
            return {
                tickMs: tickMs.length
                    ? { ticks: tickMs.length, ...summary(tickMs), maxTick: ticks[slowest] }
                    : null,
                stageMs: samples.length
                    ? {
                          samples: samples.length,
                          mean: stage((values) => summary(values).mean),
                          max: stage((values) => summary(values).max),
                          slowestTick: samples.reduce((a, b) => (b.total > a.total ? b : a)).tick,
                      }
                    : null,
                contacts: { ...contacts, last },
                corpses: {
                    deaths,
                    moving: corpses.size,
                    ...Object.fromEntries(
                        ['air', 'slide', 'rest', 'total'].map((phase) => {
                            const values = [...corpses.values()].map((corpse) =>
                                phase === 'total'
                                    ? corpse.air + corpse.slide + corpse.rest
                                    : corpse[phase],
                            );
                            return [phase, values.length ? summary(values) : null];
                        }),
                    ),
                },
                ...(times ? { tickTimes: tickMs.map(round) } : {}),
            };
        },
    };
}

// Every knockback (`unit` and `ai-match` scenes), read by `state().knockback`: for each unit the first impulse that
// throws it (kind 'knockback'), as the change of its impact velocity (speed along the ground, lift), labelled by
// what gave it: 'blast' (self-destruct), 'spin', 'splash' (a basic attack's splash), 'heroRoll', 'heroLand' (a hero's
// hop landing), 'leap', 'roll' (a rolling coconut, with the coconut's speed just before as `sourceSpeed`), 'shell' (a
// launch shell's landing), 'lob' (a lobbed ball), 'egg' (a lobbed ball's burst) or 'contact' (a flying body bumping
// into it). Then the highest point, the top ground speed it reached (later impulses add up),
// the first landing (`airTicks`, `airDist`), how far it travels from where it stood and how many ticks until it
// settles. `trace=1` adds each entry's side view per tick, [ground distance, height]. `outside()` is the most units
// (living or a flying corpse) seen outside the map at once.
function createKnockbackProbe(sim, trace = false) {
    let outside = 0;
    const entries = new Map(),
        previous = new Map(),
        sourceSpeed = new Map();
    const blasts = new Set(),
        eggs = new Set(),
        landings = new Set(),
        splashes = new Set();
    const label = (sourceId) => {
        if (blasts.has(sourceId)) return 'blast';
        if (eggs.has(sourceId)) return 'egg';
        if (landings.has(sourceId)) return 'heroLand';
        if (splashes.has(sourceId)) return 'splash';
        const source = sim.units.find((o) => o.id === sourceId);
        if (source) {
            const d = UnitDefinition.get(source.type);
            if (source.heroRoll) return 'heroRoll';
            if (d?.rolling) return 'roll';
            if (d?.spinAttack) return 'spin';
            if (d?.leapAttack) return 'leap';
            return 'contact';
        }
        if (sim.projectiles.some((p) => p.id === sourceId) || /^p\d+$/.test(String(sourceId)))
            return 'shell';
        if (String(sourceId).includes('|')) return 'lob';
        return 'other';
    };
    return {
        observe() {
            blasts.clear();
            eggs.clear();
            landings.clear();
            splashes.clear();
            for (const event of sim.events)
                if (event.type === 'unitSelfDestruct') blasts.add(event.sourceId);
                else if (event.type === 'unitLobExplosion') eggs.add(event.projectileId);
                else if (event.type === 'heroRollLand') landings.add(event.sourceId);
                else if (event.type === 'basicSplashImpact') splashes.add(event.sourceId);
            for (const unit of sim.units) {
                const m = unit.impactMotion,
                    before = previous.get(unit.id);
                if (!m) {
                    previous.delete(unit.id);
                    continue;
                }
                let entry = entries.get(unit.id);
                if (!entry && m.kind === 'knockback' && before?.startTick !== m.startTick) {
                    const source = sim.units.find((o) => o.id === m.sourceId);
                    const kind = label(m.sourceId);
                    entry = {
                        source: kind,
                        sourceType: source?.type ?? null,
                        sourceSpeed:
                            kind === 'roll' ? round(sourceSpeed.get(m.sourceId) ?? 0) : null,
                        target: unit.type,
                        mass: sim.mass(unit),
                        tick: m.startTick,
                        x0: before?.x ?? unit.x,
                        y0: before?.y ?? unit.y,
                        speed: round(
                            Math.hypot(m.vxFP - (before?.vx ?? 0), m.vyFP - (before?.vy ?? 0)) / FP,
                        ),
                        lift: round((m.vzFP - (before?.vz ?? 0)) / FP),
                        peak: 0,
                        top: 0,
                        airTicks: null,
                        airDist: null,
                        dist: 0,
                        ticks: 0,
                        done: false,
                        ...(trace ? { path: [] } : {}),
                    };
                    entries.set(unit.id, entry);
                }
                if (entry && !entry.done) {
                    const d = Math.hypot(unit.x - entry.x0, unit.y - entry.y0);
                    entry.peak = Math.max(entry.peak, m.heightFP / FP);
                    entry.top = Math.max(entry.top, Math.hypot(m.vxFP, m.vyFP) / FP);
                    entry.dist = round(d);
                    entry.ticks = sim.tick - entry.tick;
                    if (
                        entry.airTicks === null &&
                        sim.tick > entry.tick &&
                        m.heightFP === 0 &&
                        m.vzFP <= 0
                    ) {
                        entry.airTicks = entry.ticks;
                        entry.airDist = round(d);
                    }
                    if (trace) entry.path.push([round(d), round(m.heightFP / FP)]);
                    if (
                        sim.tick > entry.tick + 2 &&
                        m.heightFP === 0 &&
                        Math.hypot(m.vxFP, m.vyFP) < FP
                    )
                        entry.done = true;
                }
                previous.set(unit.id, {
                    startTick: m.startTick,
                    x: unit.x,
                    y: unit.y,
                    vx: m.vxFP,
                    vy: m.vyFP,
                    vz: m.vzFP,
                });
            }
            let out = 0;
            for (const unit of sim.units)
                if (
                    unit.x < 0 ||
                    unit.y < 0 ||
                    unit.x > sim.world.width ||
                    unit.y > sim.world.height
                )
                    out++;
            outside = Math.max(outside, out);
            for (const unit of sim.units)
                if (UnitDefinition.get(unit.type)?.rolling && unit.impactMotion)
                    sourceSpeed.set(
                        unit.id,
                        Math.hypot(unit.impactMotion.vxFP, unit.impactMotion.vyFP) / FP,
                    );
        },
        state() {
            return [...entries.values()].map((e) => ({
                ...e,
                peak: round(e.peak),
                top: round(e.top),
                angle: round((Math.atan2(e.lift, e.speed) * 180) / Math.PI),
            }));
        },
        outside: () => outside,
    };
}

// One row of `count` units across `dir`, `spacing` apart. Returns the row's depth along `dir` (as placeBlock).
function placeLine(sim, side, type, count, center, dir, spacing) {
    for (let i = 0; i < count; i++) {
        const across = (i - (count - 1) / 2) * spacing;
        const unit = sim.spawnUnit(
            side,
            type,
            center.x - dir.y * across,
            center.y + dir.x * across,
        );
        RollingBody.aim(unit, dir.x, dir.y);
        UnitBreathAttack.aim(unit, dir.x, dir.y);
    }
    return blockSpacing(sim, [type]);
}

// Outposts being built (`unit` and `ai-match` scenes), read by `state().outposts`: for each capture point the tick its
// outpost first stood finished (`doneTick`, null while it is still a construction site or was never started), its
// resource, the sides that have owned it (`heldBy`) and how many times a side took it from the other (`turnovers`).
function createOutpostProbe(sim) {
    const done = new Map(),
        held = new Map(),
        turnovers = new Map();
    return {
        observe() {
            for (const point of sim.capturePoints) {
                if (point.owner !== null) {
                    const sides = held.get(point.id) ?? [];
                    if (sides.length && sides.at(-1) !== point.owner)
                        turnovers.set(point.id, (turnovers.get(point.id) ?? 0) + 1);
                    if (sides.at(-1) !== point.owner) held.set(point.id, [...sides, point.owner]);
                }
                if (done.has(point.id) || !point.outpostId) continue;
                const outpost = sim.buildings.find((b) => b.id === point.outpostId);
                if (outpost && outpost.alive !== false && !outpost.construction)
                    done.set(point.id, sim.tick);
            }
        },
        state() {
            const points = sim.capturePoints.map((point) => {
                const outpost =
                    point.outpostId && sim.buildings.find((b) => b.id === point.outpostId);
                return {
                    id: point.id,
                    x: Math.round(point.x),
                    y: Math.round(point.y),
                    started: !!point.outpostId,
                    side: outpost ? outpost.side : null,
                    workDone: outpost?.construction?.workDone ?? null,
                    doneTick: done.get(point.id) ?? null,
                    resourceType: point.resourceType,
                    heldBy: [...new Set(held.get(point.id) ?? [])].sort(),
                    turnovers: turnovers.get(point.id) ?? 0,
                };
            });
            return {
                built: points.filter((point) => point.doneTick !== null).length,
                firstDone: Math.min(...points.map((point) => point.doneTick ?? Infinity)),
                points,
            };
        },
    };
}

// A fight in the `unit` scene, read by `state().fight`: the tick one side first has no live unit (with who is left
// and their health then), and every lobbed egg thrown (`unitLobLaunch`), every explosion (`unitLobExplosion`) and
// how many enemies each explosion hit (the area damage's own hit count). Eggs count until 20 ticks after the end.
// `throws`: thorn shots (thornAttack: chestnut, buckwheat) before the end, how many, and the first ones as [tick, thrower,
// gap] (gap: centre distance to the target minus both body radii when it left the hand). `taken`: the damage of each
// hit on a unit before the end, by the target's type, split by whether it was building then (`building`, an assigned
// project under way) or not (`other`), as { damage: hits }.
// The events that mark a sustained attack's start, damage ticks and end (fight.beats); BEAT_LOG first ones kept.
const BEAT_EVENTS = [
        'spinStart',
        'spinPulse',
        'spinEnd',
        'unitBurstShot',
        'breathPulse',
        'chainPulse',
    ],
    BEAT_LOG = 24;
function createFightProbe(sim) {
    const lobs = { thrown: 0, explosions: 0, hits: 0, empty: 0, log: [] };
    let end = null;
    // Damage dealt before the end, by the type of the unit that dealt it.
    const dealt = {},
        thrown = new Set(),
        landed = new Map(),
        throws = { count: 0, first: [] },
        taken = {};
    const damage = sim.applyDamage.bind(sim);
    sim.applyDamage = (side, type, target, building, amount, ...rest) => {
        const hpBefore = target.hp;
        const working =
            !building && !!target.constructionWork && !!sim.constructionSite(target)?.construction;
        const result = damage(side, type, target, building, amount, ...rest);
        if (!end) dealt[type] = (dealt[type] ?? 0) + Math.max(0, hpBefore - target.hp);
        if (!end && !building && hpBefore > target.hp) {
            const byType = (taken[target.type] ??= { building: {}, other: {} }),
                slot = byType[working ? 'building' : 'other'],
                hit = hpBefore - target.hp;
            slot[hit] = (slot[hit] ?? 0) + 1;
        }
        return result;
    };
    const areaDamage = sim.applyAreaDamage.bind(sim);
    sim.applyAreaDamage = (options) => {
        // The explosion event is the last one pushed just before its area damage.
        const blast = sim.events.at(-1);
        const result = areaDamage(options);
        if (blast?.type === 'unitLobExplosion' && (!end || sim.tick <= end.tick + 20)) {
            lobs.explosions++;
            lobs.hits += result.hits;
            lobs.log.push({
                tick: sim.tick,
                hits: result.hits,
                rolled: round(
                    Math.hypot(
                        blast.x - (landed.get(blast.projectileId)?.x ?? blast.x),
                        blast.y - (landed.get(blast.projectileId)?.y ?? blast.y),
                    ),
                ),
                nearest: round(
                    Math.min(
                        ...sim.units
                            .filter((unit) => unit.alive && unit.side !== blast.side)
                            .map((unit) => Math.hypot(unit.x - blast.x, unit.y - blast.y)),
                    ),
                ),
            });
            if (!result.hits) lobs.empty++;
        }
        return result;
    };
    const tally = () =>
        [0, 1].map((side) => {
            const live = sim.units.filter((unit) => unit.alive && unit.side === side);
            return { alive: live.length, hp: live.reduce((sum, unit) => sum + unit.hp, 0) };
        });
    // Sustained attacks' beats before the end: how many, and the first ones as [tick, hits] (hits where the event
    // counts them).
    const beats = Object.fromEntries(BEAT_EVENTS.map((type) => [type, { count: 0, first: [] }]));
    return {
        observe() {
            if (!end)
                for (const event of sim.events) {
                    if (event.type !== 'unitThornLaunch') continue;
                    throws.count++;
                    if (throws.first.length >= BEAT_LOG) continue;
                    const shot = sim.unitThornProjectiles.find(
                            (entry) => entry.id === event.projectileId,
                        ),
                        source = sim.unitById.get(event.sourceId),
                        target =
                            shot &&
                            (shot.targetIsBuilding
                                ? sim.buildingById.get(shot.targetId)
                                : sim.unitById.get(shot.targetId));
                    throws.first.push([
                        sim.tick,
                        event.sourceId,
                        source && target && !shot.targetIsBuilding
                            ? round(
                                  Math.hypot(target.x - source.x, target.y - source.y) -
                                      sim.unitRadius(source.type) -
                                      sim.unitRadius(target.type),
                              )
                            : null,
                    ]);
                }
            if (!end)
                for (const event of sim.events) {
                    const beat = beats[event.type];
                    if (!beat) continue;
                    beat.count++;
                    if (beat.first.length < BEAT_LOG)
                        beat.first.push(
                            event.hits === undefined ? sim.tick : [sim.tick, event.hits],
                        );
                }
            for (const event of sim.events)
                if (event.type === 'unitLobLand') landed.set(event.projectileId, event);
            if (!end)
                for (const event of sim.events)
                    if (event.type === 'unitLobLaunch' && !thrown.has(event.projectileId)) {
                        thrown.add(event.projectileId);
                        lobs.thrown++;
                    }
            if (end) return;
            const sides = tally();
            if (sides.some((side) => !side.alive))
                end = { tick: sim.tick, host: sides[0], guest: sides[1] };
        },
        state() {
            const now = tally();
            return {
                end,
                dealt,
                beats,
                throws,
                taken,
                now: { host: now[0], guest: now[1] },
                lobs: {
                    ...lobs,
                    hitsPerExplosion: lobs.explosions ? round(lobs.hits / lobs.explosions) : null,
                    hitsPerThrown: lobs.thrown ? round(lobs.hits / lobs.thrown) : null,
                },
            };
        },
    };
}

// Cannon riders' own shells (`unit` scene), read by `state().rider`: launches by flight (`fired`), on the same cannon
// the gaps from one enemy-bound rider shell's strike to the next enemy-bound launch (`gaps`: count, how many left
// before the shell ahead struck `early`, min and mean ticks), and at each strike the distance to the nearest live
// enemy unit (`strikeEnemyDistance` mean of enemy-bound shells, null when none).
function createRiderProbe(sim) {
    const fired = { enemy: 0, hop: 0, front: 0 },
        shells = new Map(),
        lastStrike = new Map(),
        gaps = [],
        distances = [];
    let early = 0;
    return {
        observe() {
            for (const event of sim.events) {
                if (event.type === 'launchFire') {
                    const ride = sim.projectiles.find((p) => p.id === event.projectileId)?.payload
                        ?.ride;
                    if (!ride) continue;
                    fired[ride]++;
                    shells.set(event.projectileId, { cannonId: event.cannonId, ride });
                    if (ride !== 'enemy') continue;
                    const last = lastStrike.get(event.cannonId);
                    if (last?.pending) early++;
                    else if (last) gaps.push(sim.tick - last.tick);
                    lastStrike.set(event.cannonId, { tick: last?.tick ?? null, pending: true });
                } else if (event.type === 'launchImpact') {
                    const shell = shells.get(event.projectileId);
                    if (shell?.ride !== 'enemy') continue;
                    lastStrike.set(shell.cannonId, { tick: sim.tick, pending: false });
                    let best = Infinity;
                    for (const u of sim.units)
                        if (u.alive && u.side !== event.side && (u.side === 0 || u.side === 1))
                            best = Math.min(best, Math.hypot(u.x - event.x, u.y - event.y));
                    if (best < Infinity) distances.push(best);
                }
            }
        },
        state() {
            return {
                fired,
                gaps: {
                    count: gaps.length,
                    early,
                    min: gaps.length ? Math.min(...gaps) : null,
                    mean: gaps.length ? round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
                },
                strikeEnemyDistance: distances.length
                    ? round(distances.reduce((a, b) => a + b, 0) / distances.length)
                    : null,
            };
        },
    };
}

// Flying units (`unit` and `ai-match` scenes, units whose Definition has `flight`), read by `state().flight`: how many
// took off and landed, the first and last landing tick and the mean distance from a landing to the nearest live
// enemy (unit or building) then, how many landed on a wall, cliff or building (`landedBlocked`) and how many had to
// fly on to open ground first because the spot was blocked (`movedToOpen`), how many took off
// again after landing (`reflights`, 0 by the rule), how many died in
// the air, and every hit and push tried on a unit while it flew, by the source type: `air` the damage that reached it
// (anti-air only), `blocked` the hits that did not, `pushes` the impulses tried (all refused). `exposure` is how often
// a flyer was where a ground effect would have reached it: `area` (area damage) and `knockback` (area throws) count
// flyers inside the circle when it went off, `inRange` unit-ticks inside an enemy's attack reach, `under` unit-ticks
// overlapping a rolling enemy body, all by the enemy's type. `firstBuildingHit` is
// the tick any unit first damaged a building (a squad's arrival at the enemy base, flying or walking alike).
// `longestAir` is the longest time (s) any flyer has spent in the air so far, finished or not; `longAir` how many
// flyers have been up longer than LONG_AIR_SECONDS and `stuckAir` how many have hung in place in the air for
// STUCK_AIR_SECONDS (both 0 by the rule: a flyer lands on reaching its goal). `airNearest` is the mean distance from
// each flyer in the air to the nearest other flyer of its side now, `airNearestMin` the smallest such mean over the
// run while two or more flew (how tight the flock ever got).
const LONG_AIR_SECONDS = 30,
    STUCK_AIR_SECONDS = 2;
function createFlightProbe(sim) {
    const flying = new Set(),
        upSince = new Map(),
        still = new Map(),
        stuck = new Set(),
        long = new Set(),
        landedIds = new Set(),
        movedToOpen = new Set(),
        air = {},
        blocked = {},
        pushes = { tried: 0 };
    let takeoffs = 0,
        reflights = 0,
        airDeaths = 0,
        firstBuildingHit = null,
        longestTicks = 0,
        airNearest = null,
        airNearestMin = null;
    const landings = [];
    const damage = sim.applyDamage.bind(sim);
    sim.applyDamage = (side, type, target, building, amount, ...rest) => {
        const inAir = !building && UnitFlight.airborne(target),
            hpBefore = target.hp;
        const result = damage(side, type, target, building, amount, ...rest);
        const dealt = Math.max(0, hpBefore - target.hp);
        if (inAir) {
            if (dealt > 0) air[type] = (air[type] ?? 0) + dealt;
            else blocked[type] = (blocked[type] ?? 0) + 1;
        }
        if (building && dealt > 0 && firstBuildingHit === null && UnitDefinition.get(type))
            firstBuildingHit = sim.tick;
        return result;
    };
    const motion = sim.navigation.motion,
        impulse = motion.applyImpulse.bind(motion);
    motion.applyImpulse = (u, ...rest) => {
        if (UnitFlight.airborne(u)) pushes.tried++;
        return impulse(u, ...rest);
    };
    // Exposure: a flying enemy of `side` that the circle reaches (in the plane) when an area hit or throw goes off.
    const exposure = { area: {}, knockback: {}, inRange: {}, under: {} };
    const reached = (side, x, y, radius) => {
        let count = 0;
        for (const u of sim.units)
            if (
                u.alive &&
                u.side !== side &&
                UnitFlight.airborne(u) &&
                Math.hypot(u.x - x, u.y - y) <= radius + sim.unitRadius(u.type)
            )
                count++;
        return count;
    };
    const areaDamage = sim.applyAreaDamage.bind(sim);
    sim.applyAreaDamage = (options) => {
        const count = reached(options.sourceSide, options.x, options.y, options.radius);
        if (count)
            exposure.area[options.sourceType] = (exposure.area[options.sourceType] ?? 0) + count;
        return areaDamage(options);
    };
    const area = Knockback.area;
    Knockback.area = function (target, options) {
        if (target === sim) {
            const count = reached(options.side, options.x, options.y, options.radius),
                source = sim.units.find((u) => u.id === options.sourceId)?.type ?? 'shell';
            if (count) exposure.knockback[source] = (exposure.knockback[source] ?? 0) + count;
        }
        return area.call(this, target, options);
    };
    const nearestEnemy = (event) => {
        let best = Infinity;
        for (const u of sim.units)
            if (u.alive && u.side !== event.side && (u.side === 0 || u.side === 1))
                best = Math.min(best, Math.hypot(u.x - event.x, u.y - event.y));
        for (const b of sim.buildings)
            if (b.alive !== false && b.side !== event.side && (b.side === 0 || b.side === 1))
                best = Math.min(best, Math.hypot(b.x - event.x, b.y - event.y));
        return best;
    };
    return {
        observe() {
            for (const event of sim.events)
                if (event.type === 'flightLand')
                    landings.push({
                        tick: sim.tick,
                        enemy: nearestEnemy(event),
                        // Landed on a wall, cliff or building (0 by the rule: it moves to open ground first).
                        blocked: embeddedAt(sim, event.x, event.y, event.sourceId),
                    });
            for (const u of sim.units) {
                if (!UnitDefinition.get(u.type)?.flight) continue;
                const now = UnitFlight.airborne(u);
                if (u.flight.phase === 'alight') movedToOpen.add(u.id);
                // Unit-ticks a flyer spent inside a live enemy's attack reach, or under a rolling enemy body.
                if (now && u.alive)
                    for (const e of sim.units) {
                        if (!e.alive || e.side === u.side || UnitFlight.airborne(e)) continue;
                        const d = Math.hypot(e.x - u.x, e.y - u.y),
                            radii = sim.unitRadius(e.type) + sim.unitRadius(u.type);
                        if (d <= sim.basicAttackRange(e) + radii)
                            exposure.inRange[e.type] = (exposure.inRange[e.type] ?? 0) + 1;
                        if (d < radii && (e.rolling || e.heroRoll))
                            exposure.under[e.type] = (exposure.under[e.type] ?? 0) + 1;
                    }
                if (now && !flying.has(u.id)) {
                    takeoffs++;
                    if (landedIds.has(u.id)) reflights++;
                    flying.add(u.id);
                    upSince.set(u.id, sim.tick);
                    still.set(u.id, { fx: u.fx, fy: u.fy, tick: sim.tick });
                } else if (!now && flying.has(u.id)) {
                    flying.delete(u.id);
                    landedIds.add(u.id);
                    if (!u.alive) airDeaths++;
                }
                if (now) {
                    const up = sim.tick - upSince.get(u.id),
                        rest = still.get(u.id);
                    longestTicks = Math.max(longestTicks, up);
                    if (up > LONG_AIR_SECONDS * sim.tps) long.add(u.id);
                    if (rest.fx !== u.fx || rest.fy !== u.fy) {
                        rest.fx = u.fx;
                        rest.fy = u.fy;
                        rest.tick = sim.tick;
                    } else if (sim.tick - rest.tick >= STUCK_AIR_SECONDS * sim.tps) stuck.add(u.id);
                }
            }
            let sum = 0,
                count = 0;
            for (const u of sim.units) {
                if (!u.alive || !UnitFlight.airborne(u)) continue;
                let best = Infinity;
                for (const o of sim.units)
                    if (o !== u && o.alive && o.side === u.side && UnitFlight.airborne(o))
                        best = Math.min(best, Math.hypot(o.x - u.x, o.y - u.y));
                if (best < Infinity) {
                    sum += best;
                    count++;
                }
            }
            airNearest = count ? round(sum / count) : null;
            if (count >= 2) airNearestMin = Math.min(airNearestMin ?? Infinity, airNearest);
        },
        state() {
            const ticks = landings.map((l) => l.tick);
            return {
                takeoffs,
                inAir: flying.size,
                landed: landings.length,
                firstLand: ticks.length ? Math.min(...ticks) : null,
                lastLand: ticks.length ? Math.max(...ticks) : null,
                landEnemyDistance: landings.length
                    ? round(landings.reduce((sum, l) => sum + l.enemy, 0) / landings.length)
                    : null,
                landedBlocked: landings.filter((l) => l.blocked).length,
                movedToOpen: movedToOpen.size,
                reflights,
                airDeaths,
                air,
                blocked,
                pushes: pushes.tried,
                exposure,
                firstBuildingHit,
                longestAir: round(longestTicks / sim.tps),
                longAir: long.size,
                stuckAir: stuck.size,
                airNearest,
                airNearestMin,
            };
        },
    };
}

// Flame breathers (`unit`, `melee` and `ai-match` scenes when a card has `breathAttack`, the chili), read by
// `state().breath`. `pulses` burns and their unit hits per burn (`perPulse` mean·max), damage dealt to units and to
// buildings (`buildingPerPulse`: each building hit's amount), `activeTicks` unit-ticks breathing, `turnTicks` unit-ticks
// whose aim changed, `fullTurnTicks` those that turned by the full rate, `maxTurnPerTick` the largest turn in one tick
// (degrees), `moveWhileBreathing` the largest step a breathing unit took in one tick (pushes only: it does not
// walk), `firstPulse` the first burn's tick. `geometry` checks every burn against an independent test made with
// atan2 (the body circle against the 30° fan, the terrain line), at the moment the burn hits: `checked` enemies looked
// at, `misses` touching enemies not hit and `falseHits` hits not touching (both 0 by the rule), `edgeHits` hits whose
// body reaches less than 2 into the fan and `nearMisses` enemies within 2 outside it (how much of the edge a scene
// exercised), `blockedLine` hits through a wall, `shielded` enemies inside the fan but behind a wall or cliff (not hit). `allies` allied unit-ticks inside a burning fan (they never burn:
// `allyHits`), `airHits` hits on a flying unit (0). `kills` time from a target's first burn to its death, by type.
// `burns` is the sustained-attack rhythm (SustainedAttack): `count` breaths started, `ticksPerBurn` damage ticks in
// each finished breath, `tickOffsets` the first finished breath's damage ticks counted from its start, `cycleTicks`
// one unit's breath start to its next and `restTicks` its breath end to its next start; `coolingTicks` unit-ticks
// waiting out the cooldown. `pulses` counts only burns that hit something.
function createBreathProbe(sim) {
    const out = {
        pulses: 0,
        unitHits: 0,
        dealt: { units: 0, buildings: 0 },
        buildingPerPulse: [],
        activeTicks: 0,
        turnTicks: 0,
        fullTurnTicks: 0,
        maxTurnPerTick: 0,
        moveWhileBreathing: 0,
        firstPulse: null,
        geometry: {
            checked: 0,
            misses: 0,
            falseHits: 0,
            edgeHits: 0,
            nearMisses: 0,
            blockedLine: 0,
            shielded: 0,
        },
        coolingTicks: 0,
        allies: 0,
        allyHits: 0,
        airHits: 0,
    };
    // The sustain timing (SustainedAttack) of every breath: starts, its damage ticks (offsets from the start),
    // start-to-start cycles and the rest from one breath's end to the next start, per unit.
    let burnStarts = 0,
        firstOffsets = null;
    const ticksPerBurn = [],
        cycles = [],
        rests = [],
        offsets = new Map();
    const burns = (u, s, before) => {
        if (!before) return;
        if (s.uses > before.uses) {
            burnStarts++;
            if (before.uses > 0) {
                cycles.push(s.startTick - before.startTick);
                rests.push(s.startTick - before.endTick);
            }
            offsets.set(u.id, s.ticks > before.ticks ? [0] : []);
            return;
        }
        const list = offsets.get(u.id);
        if (s.ticks > before.ticks) list?.push(before.nextTick - s.startTick);
        // A breath ended (its time ran out or it was knocked down): its damage ticks are complete.
        if (before.active && !s.active && list) {
            ticksPerBurn.push(list.length);
            firstOffsets ??= [...list];
        }
    };
    const perPulse = [],
        firstHit = new Map(),
        kills = {},
        last = new Map();
    let pulse = null;
    // Signed distance (negative inside) from a circle's edge to the fan of `source`, by angles.
    const margin = (source, spec, x, y, r) => {
        const aim = Math.atan2(source.breath.aimY, source.breath.aimX),
            dx = x - source.x,
            dy = y - source.y,
            dist = Math.hypot(dx, dy),
            half = (spec.arcDegrees * Math.PI) / 360;
        let offset = Math.abs(
            Math.atan2(Math.sin(Math.atan2(dy, dx) - aim), Math.cos(Math.atan2(dy, dx) - aim)),
        );
        if (offset <= half) return dist - spec.length - r;
        offset -= half;
        if (offset >= Math.PI / 2) return dist - r;
        const along = dist * Math.cos(offset),
            across = dist * Math.sin(offset);
        return (along <= spec.length ? across : Math.hypot(along - spec.length, across)) - r;
    };
    const finish = () => {
        if (!pulse) return;
        for (const [id, m] of pulse.expected) {
            if (pulse.hit.has(id)) continue;
            if (m <= 0) out.geometry.misses++;
            else if (m < 2) out.geometry.nearMisses++;
        }
        for (const id of pulse.hit) {
            const m = pulse.expected.get(id);
            if (m === undefined || m > 0) out.geometry.falseHits++;
            else if (m > -2) out.geometry.edgeHits++;
        }
        perPulse.push(pulse.hit.size);
        pulse = null;
    };
    // The first hit of a burn opens it: every enemy ground unit is measured where it stands as the burn starts.
    const open = (source, spec) => {
        finish();
        out.pulses++;
        out.firstPulse ??= sim.tick;
        pulse = { key: `${source.id}|${sim.tick}`, expected: new Map(), hit: new Set() };
        const clear = (u) =>
            sim.world.terrain.field.polygonSegmentClear(source.x, source.y, u.x, u.y, 0);
        for (const u of sim.units) {
            if (!u.alive || u === source || UnitFlight.airborne(u)) continue;
            const m = margin(source, spec, u.x, u.y, sim.unitRadius(u.type));
            if (u.side === source.side) {
                if (m <= 0 && clear(u)) out.allies++;
                continue;
            }
            out.geometry.checked++;
            if (m >= 2) continue;
            if (clear(u)) pulse.expected.set(u.id, m);
            else if (m <= 0) out.geometry.shielded++;
        }
    };
    const damage = sim.applyDamage.bind(sim);
    sim.applyDamage = (side, type, target, building, amount, sourceId, ...rest) => {
        // Only a breathing unit's burn (its launch shell's blast has the same type but a cannon as source).
        const spec = UnitDefinition.get(type)?.breathAttack,
            source = spec && sim.unitById.get(sourceId);
        if (!source?.breath) return damage(side, type, target, building, amount, sourceId, ...rest);
        if (pulse?.key !== `${sourceId}|${sim.tick}`) open(source, spec);
        const hpBefore = target.hp;
        const result = damage(side, type, target, building, amount, sourceId, ...rest);
        const dealt = Math.max(0, hpBefore - target.hp);
        if (building) {
            out.dealt.buildings += dealt;
            out.buildingPerPulse.push(dealt);
            return result;
        }
        out.unitHits++;
        out.dealt.units += dealt;
        pulse.hit.add(target.id);
        if (target.side === side) out.allyHits++;
        if (UnitFlight.airborne(target)) out.airHits++;
        if (!sim.world.terrain.field.polygonSegmentClear(source.x, source.y, target.x, target.y, 0))
            out.geometry.blockedLine++;
        if (!firstHit.has(target.id)) firstHit.set(target.id, sim.tick);
        if (target.hp <= 0 && hpBefore > 0)
            (kills[target.type] ??= []).push(sim.tick - firstHit.get(target.id));
        return result;
    };
    return {
        observe() {
            finish();
            for (const u of sim.units) {
                if (!u.alive || !u.breath) continue;
                const before = last.get(u.id),
                    s = u.sustain;
                burns(u, s, before);
                if (!s.active && sim.tick < s.readyTick) out.coolingTicks++;
                if (s.active) {
                    out.activeTicks++;
                    if (before?.active)
                        out.moveWhileBreathing = Math.max(
                            out.moveWhileBreathing,
                            round(Math.hypot(u.x - before.x, u.y - before.y)),
                        );
                }
                if (before && (before.aimX !== u.breath.aimX || before.aimY !== u.breath.aimY)) {
                    const turned =
                        (Math.abs(
                            Math.atan2(
                                before.aimX * u.breath.aimY - before.aimY * u.breath.aimX,
                                before.aimX * u.breath.aimX + before.aimY * u.breath.aimY,
                            ),
                        ) *
                            180) /
                        Math.PI;
                    out.turnTicks++;
                    out.maxTurnPerTick = Math.max(out.maxTurnPerTick, round(turned));
                    // A tick turned by the full rate (the aim was still swinging toward its goal).
                    if (
                        turned >=
                        (0.99 * UnitDefinition.get(u.type).breathAttack.turnDegreesPerSecond) /
                            sim.tps
                    )
                        out.fullTurnTicks++;
                }
                last.set(u.id, {
                    x: u.x,
                    y: u.y,
                    aimX: u.breath.aimX,
                    aimY: u.breath.aimY,
                    active: s.active,
                    uses: s.uses,
                    ticks: s.ticks,
                    nextTick: s.nextTick,
                    startTick: s.startTick,
                    endTick: s.endTick,
                });
            }
        },
        state() {
            finish();
            const summary = (values) =>
                values.length
                    ? {
                          count: values.length,
                          mean: round(values.reduce((sum, v) => sum + v, 0) / values.length),
                          min: Math.min(...values),
                          max: Math.max(...values),
                      }
                    : null;
            return {
                ...out,
                perPulse: summary(perPulse),
                burns: {
                    count: burnStarts,
                    ticksPerBurn: summary(ticksPerBurn),
                    tickOffsets: firstOffsets,
                    cycleTicks: summary(cycles),
                    restTicks: summary(rests),
                },
                buildingPerPulse: summary(out.buildingPerPulse),
                kills: Object.fromEntries(
                    Object.entries(kills).map(([type, ticks]) => [type, summary(ticks)]),
                ),
            };
        },
    };
}
// A breath probe only where a breathing card can appear, so other scenes keep their plain damage path.
function breathProbe(sim, types) {
    return types.some((type) => UnitDefinition.get(type)?.breathAttack)
        ? createBreathProbe(sim)
        : null;
}

// Chain lightning (`unit`, `melee`, `launch` and `ai-match` scenes when a card has `chainAttack`, the cotton), read by
// `state().chain`. `burns` is the channel's sustained-attack rhythm as for the breath (`count` channels started,
// `ticksPerBurn` damage ticks in each finished channel, `tickOffsets` the first finished one's, `cycleTicks` start to
// start and `restTicks` end to next start per unit), `cuts` channels that ended early while knocked off their feet
// (with their damage ticks so far in `cutTicks`), `activeTicks`·`coolingTicks` unit-ticks channelling and cooling down,
// `moveWhileChannelling` the largest one-tick step of a channelling unit. `links` the unit-ticks of a channel by how
// many links it held (index 0..links), `maxLinks` the most held at once, `relinks` links made again after a cut
// (Unit.chain.relinks), `lostToDeath` links whose enemy died while held, `pulses` damage ticks and `perPulse` targets
// hit per damage tick (mean·max), `unitHits`·`airHits` (flying targets hit)·`buildingHits`, `dealt` units·buildings,
// `buildingPerPulse` each building hit's amount, `allyHits` (0 by the rule), `geometry` every held link against the
// rule at each damage tick: `firstOutOfReach` (first link past the attack reach) and `bounceTooFar` (a link farther
// than bounceRange from the one before), both 0 by the rule, and `bounceDistance` (mean·max of the bounces held).
function createChainProbe(sim) {
    const out = {
        activeTicks: 0,
        coolingTicks: 0,
        moveWhileChannelling: 0,
        maxLinks: 0,
        lostToDeath: 0,
        pulses: 0,
        unitHits: 0,
        airHits: 0,
        buildingHits: 0,
        allyHits: 0,
        dealt: { units: 0, buildings: 0 },
        cuts: 0,
        geometry: { firstOutOfReach: 0, bounceTooFar: 0 },
    };
    const linkTicks = [],
        perPulse = [],
        buildingPerPulse = [],
        cutTicks = [],
        bounces = [],
        ticksPerBurn = [],
        cycles = [],
        rests = [],
        last = new Map(),
        offsets = new Map();
    let burnStarts = 0,
        firstOffsets = null;
    const damage = sim.applyDamage.bind(sim);
    sim.applyDamage = (side, type, target, building, amount, sourceId, ...rest) => {
        const source = UnitDefinition.get(type)?.chainAttack && sim.unitById.get(sourceId);
        if (!source?.chain) return damage(side, type, target, building, amount, sourceId, ...rest);
        const hpBefore = target.hp,
            air = !building && UnitFlight.airborne(target);
        const result = damage(side, type, target, building, amount, sourceId, ...rest);
        const dealt = Math.max(0, hpBefore - target.hp);
        if (target.side === side) out.allyHits++;
        if (building) {
            out.buildingHits++;
            out.dealt.buildings += dealt;
            buildingPerPulse.push(dealt);
        } else {
            out.unitHits++;
            out.dealt.units += dealt;
            if (air) out.airHits++;
        }
        return result;
    };
    return {
        observe() {
            for (const event of sim.events)
                if (event.type === 'chainPulse') {
                    out.pulses++;
                    perPulse.push(event.hits);
                    // Every held link against the rule at this damage tick.
                    const source = sim.unitById.get(event.sourceId),
                        d = UnitDefinition.get(source.type);
                    for (let k = 0; k < source.chain.count; k++) {
                        const e = UnitChainAttack.entity(sim, source.chain, k);
                        if (!e) continue;
                        if (k === 0) {
                            const reach = sim.interactionDistance(source, e, 'attack', d.range);
                            if (Math.hypot(e.x - source.x, e.y - source.y) > reach + 1e-6)
                                out.geometry.firstOutOfReach++;
                            continue;
                        }
                        const from = UnitChainAttack.entity(sim, source.chain, k - 1),
                            gap = Math.hypot(e.x - from.x, e.y - from.y);
                        bounces.push(gap);
                        if (gap > d.chainAttack.bounceRange + 1e-6) out.geometry.bounceTooFar++;
                    }
                }
            for (const u of sim.units) {
                if (!u.chain) continue;
                const s = u.sustain,
                    before = last.get(u.id);
                if (u.alive) {
                    if (s.active) {
                        out.activeTicks++;
                        linkTicks[u.chain.count] = (linkTicks[u.chain.count] ?? 0) + 1;
                        out.maxLinks = Math.max(out.maxLinks, u.chain.count);
                        if (before?.active)
                            out.moveWhileChannelling = Math.max(
                                out.moveWhileChannelling,
                                round(Math.hypot(u.x - before.x, u.y - before.y)),
                            );
                    } else if (sim.tick < s.readyTick) out.coolingTicks++;
                }
                if (before) {
                    // Links held last tick whose enemy has died since.
                    for (const id of before.ids)
                        if (id && sim.unitById.get(id)?.alive === false) out.lostToDeath++;
                    if (s.uses > before.uses) {
                        burnStarts++;
                        if (before.uses > 0) {
                            cycles.push(s.startTick - before.startTick);
                            rests.push(s.startTick - before.endTick);
                        }
                        offsets.set(u.id, s.ticks > before.ticks ? [0] : []);
                    } else {
                        const list = offsets.get(u.id);
                        if (s.ticks > before.ticks) list?.push(before.nextTick - s.startTick);
                        if (before.active && !s.active && list) {
                            // Knocked off its feet before its time ran out: a cut.
                            if (s.endTick < before.endTick) {
                                out.cuts++;
                                cutTicks.push(list.length);
                            } else {
                                ticksPerBurn.push(list.length);
                                firstOffsets ??= [...list];
                            }
                        }
                    }
                }
                last.set(u.id, {
                    x: u.x,
                    y: u.y,
                    active: s.active,
                    uses: s.uses,
                    ticks: s.ticks,
                    nextTick: s.nextTick,
                    startTick: s.startTick,
                    endTick: s.endTick,
                    ids: u.alive && s.active ? u.chain.ids.slice(0, u.chain.count) : [],
                });
            }
        },
        state() {
            const summary = (values) =>
                values.length
                    ? {
                          count: values.length,
                          mean: round(values.reduce((sum, v) => sum + v, 0) / values.length),
                          min: round(Math.min(...values)),
                          max: round(Math.max(...values)),
                      }
                    : null;
            return {
                ...out,
                relinks: sim.units.reduce((sum, u) => sum + (u.chain?.relinks ?? 0), 0),
                links: Array.from({ length: out.maxLinks + 1 }, (_, k) => linkTicks[k] ?? 0),
                perPulse: summary(perPulse),
                buildingPerPulse: summary(buildingPerPulse),
                cutTicks,
                bounceDistance: summary(bounces),
                burns: {
                    count: burnStarts,
                    ticksPerBurn: summary(ticksPerBurn),
                    tickOffsets: firstOffsets,
                    cycleTicks: summary(cycles),
                    restTicks: summary(rests),
                },
            };
        },
    };
}
// A chain probe only where a chain card can appear, so other scenes keep their plain damage path.
function chainProbe(sim, types) {
    return types.some((type) => UnitDefinition.get(type)?.chainAttack)
        ? createChainProbe(sim)
        : null;
}

// How widely one side's live units are scattered: their count, and the mean and largest distance from their centre.
function spread(sim, side) {
    let count = 0,
        sumX = 0,
        sumY = 0;
    for (const u of sim.units)
        if (u.alive && u.side === side) {
            count++;
            sumX += u.x;
            sumY += u.y;
        }
    if (!count) return { count, mean: 0, max: 0 };
    let sum = 0,
        max = 0;
    for (const u of sim.units)
        if (u.alive && u.side === side) {
            const d = Math.hypot(u.x - sumX / count, u.y - sumY / count);
            sum += d;
            max = Math.max(max, d);
        }
    return { count, mean: round(sum / count), max: round(max) };
}

// A unit's disc at (x, y) reaches more than half a unit into terrain or into a building's body (overlap.embedded).
function embeddedAt(sim, x, y, unitId) {
    const unit = sim.units.find((u) => u.id === unitId),
        radius = sim.radiusFP(unit) / FP - 0.5;
    if (!sim.world.terrain.field.polygonCircleClear(x, y, radius)) return true;
    return sim.buildings.some(
        (building) =>
            building.alive !== false &&
            Math.hypot(x - building.x, y - building.y) <
                radius + (BuildingDefinition.get(building.type)?.size || 0),
    );
}

// Pairs of live units whose collision discs overlap now, and the summed overlap depth (world units).
function overlap(sim) {
    const units = sim.units.filter((unit) => unit.alive);
    let pairs = 0,
        depth = 0;
    for (let i = 0; i < units.length; i++)
        for (let j = i + 1; j < units.length; j++) {
            const reach = sim.radiusFP(units[i]) + sim.radiusFP(units[j]),
                distance = Math.hypot(units[i].fx - units[j].fx, units[i].fy - units[j].fy);
            if (distance >= reach) continue;
            pairs++;
            depth += (reach - distance) / FP;
        }
    // Live units whose disc reaches more than half a unit into terrain or into a building's body.
    let terrain = 0,
        buildings = 0;
    for (const unit of units) {
        const radius = sim.radiusFP(unit) / FP - 0.5;
        if (!sim.world.terrain.field.polygonCircleClear(unit.x, unit.y, radius)) terrain++;
        for (const building of sim.buildings)
            if (
                building.alive !== false &&
                Math.hypot(unit.x - building.x, unit.y - building.y) <
                    radius + (BuildingDefinition.get(building.type)?.size || 0)
            ) {
                buildings++;
                break;
            }
    }
    return { pairs, depth: round(depth), embedded: { terrain, buildings } };
}

// The coconuts still rolling: how many, and their mean and top speed (world units per second).
function coconutSpeeds(sim) {
    let rolling = 0,
        sum = 0,
        top = 0;
    for (const unit of sim.units) {
        if (!unit.alive || !unit.rolling) continue;
        const motion = unit.impactMotion,
            speed = motion ? Math.hypot(motion.vxFP || 0, motion.vyFP || 0) / FP : 0;
        rolling++;
        sum += speed;
        top = Math.max(top, speed);
    }
    return {
        coconuts: {
            alive: rolling,
            meanSpeed: rolling ? round(sum / rolling) : 0,
            topSpeed: round(top),
        },
    };
}

export function createDebugScenes({ createRenderer, createScenario, createPresentationView }) {
    // A full-window surface drawn by the match renderer under the virtual clock. `fog` (host|guest) draws that
    // side's fog of war; without it the scene shows everything, as the card previews do.
    function openStage(fog) {
        if (fog !== undefined && fog !== 'host' && fog !== 'guest')
            throw new Error(`fog must be host or guest: ${fog}`);
        const realNow = performance.now.bind(performance);
        if (realNow() >= EPOCH_MS) throw new Error(`a scene must open within ${EPOCH_MS} ms`);
        let clock = EPOCH_MS;
        const virtualNow = () => clock;
        performance.now = virtualNow;
        const container = document.createElement('div');
        container.className = 'debug-scene';
        container.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#000';
        document.body.append(container);
        let surface;
        try {
            surface = createShowcaseSurface(createRenderer);
            container.append(surface.element);
            surface.renderer.prepareGameResources();
            surface.renderer.resize();
        } catch (error) {
            surface?.dispose();
            container.remove();
            performance.now = realNow;
            throw error;
        }
        const { renderer } = surface;
        renderer.role = fog ?? 'host';
        renderer.replayOrientationRole = 'host';
        renderer.replayObserverAll = !fog;
        return {
            renderer,
            realNow,
            realTime(operation) {
                performance.now = realNow;
                try {
                    return operation();
                } finally {
                    performance.now = virtualNow;
                }
            },
            advance(ms) {
                clock += ms;
            },
            dispose() {
                surface.dispose();
                container.remove();
                performance.now = realNow;
            },
        };
    }

    // The last drawn frame's submission (`render()` draws one after each step). `deviceDraws` is every draw call the GL
    // device made; `draws` is the renderer's own `perfStats` sum, which leaves out the GameKit sprite submits.
    function renderStats(renderer) {
        const rp = renderer.perfStats,
            mesh = renderer.vectorContext.stats().mesh;
        return {
            draws: rp.drawCalls,
            deviceDraws: renderer.device.stats.drawCalls,
            instancedDraws: renderer.device.stats.instancedDrawCalls,
            vertices: renderer.device.stats.vertices,
            vectorDraws: rp.vectorAssetDrawCalls,
            vectorInstances: rp.vectorAssetInstances,
            uploadBytes: rp.bufferUploadBytes,
            flushReasons: mesh.flushReasons,
            drawDispatchReasons: mesh.drawDispatchReasons,
        };
    }

    // The debug-host handle of one scene. `open(advanceTick, onError)` builds the prepareSimScene handle.
    function host(stage, name, params, open, extra = () => ({})) {
        const log = createTickLog();
        const times = flag(name, 'times', params.times);
        let failure = null;
        let run;
        // Real time to build the scene (staging, any ticks run before it shows, the first snapshot).
        let openMs;
        try {
            const opened = stage.realNow();
            run = open(
                () => {
                    stage.realTime(() => run.sim.step());
                    log.record(run.sim);
                },
                (error) => {
                    failure = error;
                },
            );
            openMs = round(stage.realNow() - opened);
            run.play({ automatic: false });
        } catch (error) {
            run?.dispose();
            stage.dispose();
            throw error;
        }
        const alive = (side) =>
            run.sim.units.filter((unit) => unit.alive && unit.side === side).length;
        return {
            step() {
                stage.advance(1000 / run.sim.tps);
                const result = run.step();
                if (failure) throw failure;
                if (result.status !== 'advanced')
                    throw new Error(`${name} ended at tick ${run.sim.tick}`);
            },
            render() {
                run.render();
                stage.renderer.loop();
            },
            state: () => ({
                simTick: run.sim.tick,
                checksum: run.sim.checksum(),
                openMs,
                units: { host: alive(0), guest: alive(1) },
                render: renderStats(stage.renderer),
                ...extra(run.sim),
                ...log.state(times),
                overlap: overlap(run.sim),
            }),
            hash: () => run.sim.checksum(),
            dispose() {
                run.dispose();
                stage.dispose();
            },
        };
    }

    // A scene on a match map: the camera holds `zoom` and follows `focus()` at its terrain height.
    function matchScene(name, params, sim, { zoom, focus, beforeStep, isComplete, extra }) {
        const stage = openStage(params.fog);
        const camera = () => {
            const { x, y } = focus();
            centerCamera(stage.renderer, x, y, sim.world.terrain.surfaces.heightAt(x, y));
        };
        stage.renderer.replayZoom = zoom;
        return host(
            stage,
            name,
            params,
            (advanceTick, onError) =>
                prepareSimScene({
                    renderer: stage.renderer,
                    createScenario,
                    createPresentationView,
                    sim,
                    seed: sim.seed,
                    endTick: Number.MAX_SAFE_INTEGER,
                    loop: false,
                    advanceTick,
                    start: camera,
                    beforeStep,
                    render: camera,
                    isComplete,
                    onError,
                }),
            extra,
        );
    }

    // The mean position of the live units, held where they were last seen once none is left.
    function followUnits(sim, from, keep = () => true) {
        let focus = from;
        return () => {
            const units = sim.units.filter((unit) => unit.alive && keep(unit));
            if (units.length)
                focus = {
                    x: units.reduce((sum, unit) => sum + unit.x, 0) / units.length,
                    y: units.reduce((sum, unit) => sum + unit.y, 0) / units.length,
                };
            return focus;
        };
    }

    function melee(scene, params, coconuts) {
        const sim = createMatchSim(scene, params.map, params.seed);
        const count = integer(scene, 'units', params.units);
        const types = String(params.mix)
            .split(',')
            .map((type) => unitType(scene, 'mix', type));
        const { center, dir } = baseAxis(sim);
        const back = { x: -dir.x, y: -dir.y };
        const depth = placeBlock(
            sim,
            0,
            types,
            count,
            { x: center.x - dir.x * 250, y: center.y - dir.y * 250 },
            dir,
        );
        placeBlock(
            sim,
            1,
            types,
            count,
            { x: center.x + dir.x * 250, y: center.y + dir.y * 250 },
            back,
        );
        // Each side's coconuts stand in a row behind its block and roll into the fight.
        for (const [side, facing] of [
            [0, dir],
            [1, back],
        ])
            for (let k = 0; k < coconuts; k++) {
                const across = (k - (coconuts - 1) / 2) * 60,
                    behind = 250 + depth / 2 + 80;
                const coconut = sim.spawnUnit(
                    side,
                    'coconut',
                    center.x - facing.x * behind - facing.y * across,
                    center.y - facing.y * behind + facing.x * across,
                );
                RollingBody.aim(coconut, facing.x, facing.y);
            }
        const breath = breathProbe(sim, types),
            chain = chainProbe(sim, types);
        return matchScene(scene, params, sim, {
            zoom: 1.4,
            focus: () => center,
            beforeStep:
                breath || chain
                    ? () => {
                          breath?.observe();
                          chain?.observe();
                      }
                    : undefined,
            extra:
                breath || chain
                    ? () => ({
                          ...coconutSpeeds(sim),
                          ...(breath ? { breath: breath.state() } : {}),
                          ...(chain ? { chain: chain.state() } : {}),
                      })
                    : coconutSpeeds,
        });
    }

    // Seeded random mixes of the ordinary cards, the same resources a side, crash in the middle of the map.
    function mixBattle(params) {
        const scene = 'mix-battle';
        const sim = createMatchSim(scene, params.map, params.seed);
        const budget = integer(scene, 'budget', params.budget);
        const roll = (side, k) =>
            HashUtil.finish(
                HashUtil.word(HashUtil.word(HashUtil.word(HashUtil.OFFSET, sim.seed), side), k),
            );
        // Without `kinds`, the seed picks 3 or 4 kinds (the same for both sides).
        const kinds =
            params.kinds === undefined
                ? 3 + (roll(2, 0) & 1)
                : integer(scene, 'kinds', params.kinds);
        if (kinds < 1 || kinds > MIX_POOL.length)
            throw new Error(`${scene} needs kinds between 1 and ${MIX_POOL.length}: ${kinds}`);
        const { center, dir } = baseAxis(sim);
        const back = { x: -dir.x, y: -dir.y };
        // Each side: `kinds` cards drawn from the pool (Fisher-Yates on the seeded hash), the budget split evenly,
        // and each share turned into whole soldiers at the card's resources per soldier (food + oil) / count.
        const sides = [0, 1].map((side) => {
            const pool = MIX_POOL.slice();
            for (let i = pool.length - 1; i > 0; i--) {
                const j = roll(side, i + 1) % (i + 1);
                [pool[i], pool[j]] = [pool[j], pool[i]];
            }
            const units = pool.slice(0, kinds).map((type) => {
                const card = LaunchRules.payload(type);
                const each = (card.cost + card.premiumCost) / RESOURCE_SCALE / card.count;
                const count = Math.floor(budget / kinds / each);
                return { type, count, each: round(each), spent: round(count * each) };
            });
            return { units, spent: round(units.reduce((sum, unit) => sum + unit.spent, 0)) };
        });
        // Interleave the soldiers so each kind spreads through the block, then place both blocks 150 apart.
        const placed = new Map();
        for (const [side, facing] of [
            [0, dir],
            [1, back],
        ]) {
            const order = sides[side].units
                .flatMap((unit, k) =>
                    Array.from({ length: unit.count }, (_, j) => ({
                        type: unit.type,
                        at: (j + 0.5) / unit.count,
                        k,
                    })),
                )
                .sort((a, b) => a.at - b.at || a.k - b.k)
                .map((entry) => entry.type);
            if (!order.length) throw new Error(`${scene} budget ${budget} buys no soldier`);
            const columns = Math.ceil(Math.sqrt(order.length)),
                depth = Math.ceil(order.length / columns) * blockSpacing(sim, order),
                gap = 75 + depth / 2;
            const before = sim.units.length;
            placeBlock(
                sim,
                side,
                order,
                order.length,
                { x: center.x - facing.x * gap, y: center.y - facing.y * gap },
                facing,
            );
            // By id: the scene restores the staged state, so the unit objects are replaced.
            for (const unit of sim.units.slice(before)) {
                const card = sides[unit.side].units.find((entry) => entry.type === unit.type);
                placed.set(unit.id, {
                    side: unit.side,
                    type: unit.type,
                    each: card.each,
                    deathTick: null,
                    firstHitTick: null,
                });
            }
        }
        const startTick = sim.tick;
        // Display only, until one side has no placed soldier left: every record reads hp, `alive` and the sim's own
        // `hit` event around the sim's call (or the impulse it applied) and changes nothing the sim reads.
        // Per side and type: unit damage dealt and building damage, damage its soldiers took, the resources of the
        // enemies it finished, damage past the target's last hp (`over` of `applied`), and per attack (one source id
        // in one tick) the units it hit (`hits` over `attacks`), knockbacks it gave.
        const dealt = [{}, {}],
            dealtBuildings = [{}, {}],
            taken = [{}, {}],
            killValue = [{}, {}],
            over = [{}, {}],
            applied = [{}, {}],
            hits = [{}, {}],
            attacks = [{}, {}],
            knockbacks = [{}, {}];
        const add = (into, side, type, value) => {
            into[side][type] = (into[side][type] ?? 0) + value;
        };
        // The attack being counted per source id: its tick and units hit so far.
        const attack = new Map();
        const closeAttack = (record) => {
            add(attacks, record.side, record.type, 1);
            add(hits, record.side, record.type, record.hits);
        };
        let end = null;
        const damage = sim.applyDamage.bind(sim);
        sim.applyDamage = (side, type, target, building, amount, sourceId, ...rest) => {
            const hpBefore = target.hp,
                wasAlive = target.alive !== false,
                firstEvent = sim.events.length;
            const result = damage(side, type, target, building, amount, sourceId, ...rest);
            if (end || (side !== 0 && side !== 1)) return result;
            const hit = Math.max(0, hpBefore - target.hp);
            if (hit > 0) add(building ? dealtBuildings : dealt, side, type, hit);
            if (building) return result;
            let event = null;
            for (let i = firstEvent; i < sim.events.length && !event; i++)
                if (sim.events[i].type === 'hit' && sim.events[i].targetId === target.id)
                    event = sim.events[i];
            if (!event) return result;
            const victim = placed.get(target.id);
            if (victim) add(taken, victim.side, victim.type, hit);
            if (victim && wasAlive && target.alive === false) {
                victim.deathTick ??= sim.tick;
                add(killValue, side, type, victim.each);
            }
            add(applied, side, type, event.amount);
            add(over, side, type, Math.max(0, event.amount - hit));
            const dealer = placed.get(sourceId);
            if (dealer && dealer.type === type && hit > 0) dealer.firstHitTick ??= sim.tick;
            if (sourceId !== null && sourceId !== undefined) {
                let record = attack.get(sourceId);
                if (record && record.tick !== sim.tick) {
                    closeAttack(record);
                    record = null;
                }
                if (!record)
                    attack.set(sourceId, (record = { tick: sim.tick, side, type, hits: 0 }));
                record.hits++;
            }
            return result;
        };
        // Knockbacks on placed soldiers, credited to the enemy unit (or the unit whose lobbed ball it was). Restoring
        // a state makes a new UnitMotion, so the wrap is checked again before every step.
        let watchedMotion = null;
        const watchMotion = () => {
            const motion = sim.navigation.motion;
            if (motion === watchedMotion) return;
            watchedMotion = motion;
            const impulse = motion.applyImpulse.bind(motion);
            motion.applyImpulse = (u, value, impact, ...rest) => {
                const m = impulse(u, value, impact, ...rest);
                const victim = placed.get(u.id);
                if (end || !m || !victim || (impact?.kind ?? 'knockback') !== 'knockback') return m;
                const sourceId = impact?.sourceId;
                const source =
                    placed.get(sourceId) ??
                    placed.get(
                        sim.unitLobProjectiles?.find((shot) => shot.id === sourceId)?.sourceId,
                    );
                add(knockbacks, 1 - victim.side, source?.type ?? 'other', 1);
                return m;
            };
        };
        const count = (side) => {
            const alive = {};
            let left = 0;
            for (const [id, unit] of placed)
                if (unit.side === side && sim.unitById.get(id)?.alive) {
                    alive[unit.type] = (alive[unit.type] ?? 0) + 1;
                    left++;
                }
            return { alive, left };
        };
        const tally = () => [count(0), count(1)];
        const ROLES = ['host', 'guest'];
        // Resources still standing: the live placed soldiers at their resources per soldier, over the side's spend.
        const remaining = (side, alive) =>
            round(
                sides[side].units.reduce(
                    (sum, unit) => sum + (alive[unit.type] ?? 0) * unit.each,
                    0,
                ) / Math.max(1, sides[side].spent),
            );
        const state = () => {
            const now = end?.sides ?? tally();
            const left = [remaining(0, now[0].alive), remaining(1, now[1].alive)];
            const winner = end
                ? {
                      by: 'wipe',
                      tick: end.tick,
                      side: now[0].left ? 'host' : now[1].left ? 'guest' : 'draw',
                  }
                : {
                      by: 'resources',
                      tick: sim.tick,
                      side: left[0] > left[1] ? 'host' : left[1] > left[0] ? 'guest' : 'draw',
                  };
            const lastTick = end?.tick ?? sim.tick;
            // Survival and engagement per type, over the placed soldiers.
            const soldiers = (side, type) => {
                let lived = 0,
                    engaged = 0,
                    firstHit = 0;
                for (const unit of placed.values())
                    if (unit.side === side && unit.type === type) {
                        lived += (unit.deathTick ?? lastTick) - startTick;
                        if (unit.firstHitTick !== null) {
                            engaged++;
                            firstHit += unit.firstHitTick - startTick;
                        }
                    }
                return { lived, engaged, firstHit };
            };
            const open = [{}, {}];
            for (const record of attack.values()) {
                open[record.side][record.type] ??= { attacks: 0, hits: 0 };
                open[record.side][record.type].attacks++;
                open[record.side][record.type].hits += record.hits;
            }
            const per100 = (value, spent) => (spent ? round((value * 100) / spent) : null);
            const byType = (side) =>
                Object.fromEntries(
                    sides[side].units.map((unit) => {
                        const type = unit.type,
                            hit = dealt[side][type] ?? 0,
                            got = taken[side][type] ?? 0,
                            alive = now[side].alive[type] ?? 0,
                            lost = round((unit.count - alive) * unit.each),
                            killed = round(killValue[side][type] ?? 0),
                            life = soldiers(side, type),
                            attackCount =
                                (attacks[side][type] ?? 0) + (open[side][type]?.attacks ?? 0),
                            hitCount = (hits[side][type] ?? 0) + (open[side][type]?.hits ?? 0),
                            appliedTotal = applied[side][type] ?? 0;
                        return [
                            type,
                            {
                                placed: unit.count,
                                alive,
                                spent: unit.spent,
                                dealt: hit,
                                dealtBuildings: dealtBuildings[side][type] ?? 0,
                                per100: per100(hit, unit.spent),
                                taken: got,
                                takenPer100: per100(got, unit.spent),
                                lifeSeconds: unit.count
                                    ? round(life.lived / unit.count / sim.tps)
                                    : null,
                                killValue: killed,
                                killPer100: per100(killed, unit.spent),
                                lost,
                                exchange: lost ? round(killed / lost) : null,
                                overkill: appliedTotal
                                    ? round((over[side][type] ?? 0) / appliedTotal)
                                    : null,
                                engaged: unit.count ? round(life.engaged / unit.count) : null,
                                firstHitSeconds: life.engaged
                                    ? round(life.firstHit / life.engaged / sim.tps)
                                    : null,
                                hitsPerAttack: attackCount ? round(hitCount / attackCount) : null,
                                knockbacks: knockbacks[side][type] ?? 0,
                                knockbacksPer100: per100(knockbacks[side][type] ?? 0, unit.spent),
                            },
                        ];
                    }),
                );
            return {
                mix: {
                    budget,
                    kinds,
                    pool: MIX_POOL,
                    winner: { ...winner, remaining: { host: left[0], guest: left[1] } },
                    sides: Object.fromEntries(
                        [0, 1].map((side) => [
                            ROLES[side],
                            { spent: sides[side].spent, units: byType(side) },
                        ]),
                    ),
                    // Knockbacks whose source was not a placed soldier or its lobbed ball.
                    otherKnockbacks: [knockbacks[0].other ?? 0, knockbacks[1].other ?? 0],
                    // Damage from types not placed (spawned by another unit, buildings).
                    other: [0, 1].map((side) =>
                        Object.fromEntries(
                            Object.entries(dealt[side]).filter(
                                ([type]) => !sides[side].units.some((unit) => unit.type === type),
                            ),
                        ),
                    ),
                },
            };
        };
        return matchScene(scene, params, sim, {
            zoom: 1.4,
            focus: () => center,
            beforeStep: () => {
                if (end) return;
                watchMotion();
                // Deaths the damage wrapper did not see (no applyDamage call): the tick they were first seen dead.
                for (const [id, unit] of placed)
                    if (unit.deathTick === null && !sim.unitById.get(id)?.alive)
                        unit.deathTick = sim.tick;
                const now = tally();
                if (!now[0].left || !now[1].left) end = { tick: sim.tick, sides: now };
            },
            extra: () => ({ ...coconutSpeeds(sim), ...state() }),
        });
    }

    return {
        /**
         * 진영마다 seed로 일반 병종 `kinds`개(없으면 seed가 3 또는 4)를 뽑아 같은 자원 `budget`(식량+기름, 카드 표시
         * 단위)을 똑같이 나눠 인원으로 바꾸고(카드 자원 ÷ 카드 인원), 섞어서 맵 가운데에서 맞부딪친다. 영웅·참깨는
         * 뺀다. 상태의 `mix`는 진영별 편성·병종별 남은 인원·준 피해(`dealt`, 자원 100당 `per100`)·받은 피해
         * (`taken`)·평균 생존 초(`lifeSeconds`)·처치한 적 자원(`killValue`)과 교환비(`exchange`)·넘친 피해 비율
         * (`overkill`)·피해를 준 병사 비율(`engaged`)과 첫 피해 초(`firstHitSeconds`)·공격 한 번에 맞힌 수
         * (`hitsPerAttack`)·넉백 수(`knockbacks`)·승자(전멸 `wipe` 또는 지금 남은 자원 비율 `resources`)다.
         * 예: `?debug=1&scene=mix-battle&map=standard&seed=1&budget=400&tick=1800`
         */
        'mix-battle': mixBattle,
        /**
         * 양쪽 걷는 병사 무리가 맵 가운데에서 맞부딪친다. 본진을 잇는 축 위 가운데 앞뒤 250에 진영마다 `units`명을
         * 사각형으로 세우고, `mix`(쉼표로 나눈 병종)를 차례로 채운다. 병사는 평소처럼 적 본진으로 걷는다.
         * 예: `?debug=1&scene=melee&map=artillery-basin&seed=1&units=150&mix=rice,pea&tick=100`
         */
        melee: (params) => melee('melee', params, 0),
        /**
         * melee에 더해 진영마다 코코넛 `coconuts`개가 자기 무리 뒤에서 적 쪽으로 굴러 들어간다(PR #327 재현 구성).
         * 예: `?debug=1&scene=coconut-melee&map=artillery-basin&seed=1&units=150&mix=rice,pea&coconuts=5&tick=300`
         */
        'coconut-melee': (params) =>
            melee('coconut-melee', params, integer('coconut-melee', 'coconuts', params.coconuts)),
        /**
         * `count`명의 `unit`이 아군 본진 앞에서 적 본진으로 행군한다(길찾기·아군 밀어내기).
         * 예: `?debug=1&scene=march&map=twin-gates&seed=1&unit=rice&count=60&tick=300`
         */
        march(params) {
            const scene = 'march';
            const sim = createMatchSim(scene, params.map, params.seed);
            const { host: base, dir } = baseAxis(sim);
            const start = { x: base.x + dir.x * 300, y: base.y + dir.y * 300 };
            placeBlock(
                sim,
                0,
                [unitType(scene, 'unit', params.unit)],
                integer(scene, 'count', params.count),
                start,
                dir,
            );
            const goal = sim.buildings.find((b) => b.id === 'base1');
            return matchScene(scene, params, sim, {
                zoom: 1.4,
                focus: followUnits(sim, start),
                // How far the column got: along the start direction (mean, front) and to the enemy base (nearest).
                extra: () => {
                    let sum = 0,
                        front = -Infinity,
                        nearest = Infinity,
                        alive = 0;
                    for (const u of sim.units) {
                        if (!u.alive || u.side !== 0) continue;
                        const along = (u.x - start.x) * dir.x + (u.y - start.y) * dir.y;
                        sum += along;
                        front = Math.max(front, along);
                        nearest = Math.min(nearest, Math.hypot(u.x - goal.x, u.y - goal.y));
                        alive++;
                    }
                    return {
                        march: {
                            meanProgress: alive ? Math.round((sum / alive) * 100) / 100 : 0,
                            frontProgress: Math.round(front * 100) / 100,
                            nearestToBase: Math.round(nearest * 100) / 100,
                        },
                    };
                },
            });
        },
        /**
         * `count`명의 `unit`을 (`x`,`y`)에 세운다(`line=N`이면 N 간격의 가로 한 줄). 평소처럼 적 본진으로 가고, `enemy`·`enemyCount`가 있으면 그 적
         * 무리가 적 본진 쪽 300(`gap`) 앞에 서고, `support`·`supportCount`는 그 뒤 100에 두 번째 적 무리를 세운다.
         * 나는 병종(민들레씨)은 상태의 `flight`에 이륙·착지·공중 피해·공중 밀림을 낸다. `outposts=1`이면 모든 점령 지점에 더 가까운 본진 쪽의 완성된 거점을 둔다
         * (검은콩 앞쪽 대포 탑승, 찹쌀 거점 포구 막기). `enemyLine=N`은 적을 N 간격 가로 한 줄로, `behind=1`은 적 무리를 아군 본진
         * 쪽에, `front`·`frontCount`는 아군 앞줄을 세운다. 불 뿜는 병종(고추)은 상태의 `breath`에 불줄기 기록을 낸다. 예:
         * `?debug=1&scene=unit&map=twin-gates&seed=1&unit=coconut&count=1&x=1400&y=2900&tick=150`
         */
        unit(params) {
            const scene = 'unit';
            const sim = createMatchSim(scene, params.map, params.seed);
            if (flag(scene, 'outposts', params.outposts)) completeOutposts(sim);
            const { guest } = baseAxis(sim);
            const at = { x: integer(scene, 'x', params.x), y: integer(scene, 'y', params.y) };
            const length = Math.hypot(guest.x - at.x, guest.y - at.y);
            const dir = { x: (guest.x - at.x) / length, y: (guest.y - at.y) / length };
            const group = [unitType(scene, 'unit', params.unit)],
                count = integer(scene, 'count', params.count);
            // point=N: the soldiers stand in a ring (radius `ring`, default 160) around capture point N, so they
            // build its outpost (read `state().outposts`); `x`·`y` are then ignored for the block.
            if (params.point !== undefined) {
                const point = sim.capturePoints[integer(scene, 'point', params.point)];
                if (!point) throw new Error(`unit: point ${params.point} does not exist`);
                const radius =
                    params.ring === undefined ? 160 : integer(scene, 'ring', params.ring);
                for (let i = 0; i < count; i++) {
                    const angle = (i * Math.PI * 2) / count;
                    sim.spawnUnit(
                        0,
                        group[0],
                        point.x + Math.cos(angle) * radius,
                        point.y + Math.sin(angle) * radius,
                    );
                }
            }
            const depth =
                params.point !== undefined
                    ? 0
                    : params.line === undefined
                      ? placeBlock(sim, 0, group, count, at, dir)
                      : placeLine(
                            sim,
                            0,
                            group[0],
                            count,
                            at,
                            dir,
                            integer(scene, 'line', params.line),
                        );
            // front=<type>&frontCount=N: a friendly block just in front of the first (a front line ahead of breathers).
            if (params.front !== undefined || params.frontCount !== undefined) {
                const types = [unitType(scene, 'front', params.front)],
                    frontCount = integer(scene, 'frontCount', params.frontCount),
                    columns = Math.ceil(Math.sqrt(frontCount)),
                    ahead =
                        (depth + Math.ceil(frontCount / columns) * blockSpacing(sim, types)) / 2;
                placeBlock(
                    sim,
                    0,
                    types,
                    frontCount,
                    { x: at.x + dir.x * ahead, y: at.y + dir.y * ahead },
                    dir,
                );
            }
            // behind=1: the enemy blocks stand on the far side of the units, toward the friendly base.
            const toward = flag(scene, 'behind', params.behind) ? -1 : 1,
                gap = params.gap === undefined ? 300 : integer(scene, 'gap', params.gap),
                facing = { x: -dir.x * toward, y: -dir.y * toward };
            if (params.enemy !== undefined || params.enemyCount !== undefined) {
                const enemy = unitType(scene, 'enemy', params.enemy),
                    enemyCount = integer(scene, 'enemyCount', params.enemyCount),
                    center = { x: at.x + dir.x * gap * toward, y: at.y + dir.y * gap * toward };
                // enemyLine=N: the enemies stand in one row across, N apart (edge checks against still targets).
                if (params.enemyLine === undefined)
                    placeBlock(sim, 1, [enemy], enemyCount, center, facing);
                else
                    placeLine(
                        sim,
                        1,
                        enemy,
                        enemyCount,
                        center,
                        facing,
                        integer(scene, 'enemyLine', params.enemyLine),
                    );
            }
            // support=<type>&supportCount=N: a second enemy block 100 behind the first (anti-air escorts behind a front).
            if (params.support !== undefined || params.supportCount !== undefined) {
                const behind = (gap + 100) * toward;
                placeBlock(
                    sim,
                    1,
                    [unitType(scene, 'support', params.support)],
                    integer(scene, 'supportCount', params.supportCount),
                    { x: at.x + dir.x * behind, y: at.y + dir.y * behind },
                    facing,
                );
            }
            // shell=<type>: the host base fires one launch shell of that card (its payload's impact, splash and count)
            // at the enemy block, so the shell's landing knockback can be measured.
            if (params.shell !== undefined) {
                const type = unitType(scene, 'shell', params.shell),
                    payload = LaunchRules.grain(type),
                    gap = params.gap === undefined ? 300 : integer(scene, 'gap', params.gap),
                    base = sim.buildings.find((b) => b.id === 'base0'),
                    walk = UnitDefinition.get(params.enemy)?.speed || 0;
                // Lead the aim by how far the enemy block walks toward the host while the shell flies.
                let lead = 0;
                for (let k = 0; k < 3; k++) {
                    const ax = at.x + dir.x * (gap - lead),
                        ay = at.y + dir.y * (gap - lead);
                    lead =
                        (walk * Math.hypot(ax - base.x, ay - base.y)) /
                        LaunchRules.shellSpeed(type);
                }
                sim.fireLaunchShell({
                    side: 0,
                    cannonId: 'base0',
                    type,
                    mode: 'single',
                    shot: 0,
                    shots: 1,
                    power: 1,
                    holdMs: 0,
                    arcDistance: null,
                    x: at.x + dir.x * (gap - lead),
                    y: at.y + dir.y * (gap - lead),
                    count: payload.count,
                    impact: payload.impact,
                    splash: payload.splash,
                });
            }
            // heroSkill=1: the placed heroes are sortied and their active skill (hero roll) is queued.
            if (flag(scene, 'heroSkill', params.heroSkill))
                for (const u of sim.units)
                    if (u.side === 0 && UnitDefinition.get(u.type)?.heroActive) {
                        sim.heroes[0][u.type] = { sortieId: 'p1', mode: 'advance', unitId: u.id };
                        u.heroRollQueued = true;
                    }
            const probe = createKnockbackProbe(sim, flag(scene, 'trace', params.trace)),
                fight = createFightProbe(sim),
                flight = createFlightProbe(sim),
                rider = createRiderProbe(sim),
                outposts = createOutpostProbe(sim),
                breath = breathProbe(sim, [...new Set(sim.units.map((u) => u.type))]),
                chain = chainProbe(sim, [...new Set(sim.units.map((u) => u.type))]);
            return matchScene(scene, params, sim, {
                zoom: params.zoom === undefined ? 1.6 : positive(scene, 'zoom', params.zoom),
                focus: followUnits(sim, at),
                beforeStep: () => {
                    probe.observe();
                    fight.observe();
                    flight.observe();
                    rider.observe();
                    outposts.observe();
                    breath?.observe();
                    chain?.observe();
                },
                extra: () => ({
                    knockback: probe.state(),
                    outside: probe.outside(),
                    fight: fight.state(),
                    flight: flight.state(),
                    rider: rider.state(),
                    outposts: outposts.state(),
                    enemySpread: spread(sim, 1),
                    ...(breath ? { breath: breath.state() } : {}),
                    ...(chain ? { chain: chain.state() } : {}),
                }),
            });
        },
        /**
         * 완성된 아군 거점 대포 하나가 `unit` 한 발을 쏘아 착지시킨다. 착지점은 맵 가운데에서 본진 축의 옆으로
         * `across`(기본 400) 비킨 곳(가운데 점령 지점과 맵 가장자리를 피함)이고, 대포는 그 아군 본진 쪽
         * `distance`(기본 300)에 있다. `x`·`y`를 주면 그곳에 착지하고 대포는 그 아군 본진 쪽에 선다. 발사는 10틱이고
         * 그 한 발 값은 지갑에 채워 둔다. `enemy`·`enemyCount`가 있으면 그 적 무리가 착지점에 서 있다(난전 한가운데
         * 착지). `enemyX`·`enemyY`를 주면 그 적 무리는 그곳에 선다(나는 병종이 날아갈 거리). 카메라는 착지점에
         * `zoom`(기본 3)으로 고정하고 `follow=1`이면 대포에서 시작해 쏜 병종의 아군 무리를 부드럽게 따라간다. 상태의 `landing`은 첫 병사가 나온 틱과
         * 살아 있는 그 병종 아군 수, 그 무리의 퍼짐(`nearest`·`pair`·`radius`·`ahead`)이고, `flight`는 `unit`
         * 장면과 같은 나는 병종 기록이다. 예: `?debug=1&scene=launch&map=standard&seed=1&unit=chestnut&zoom=2&tick=20`,
         * 절벽 옆: `?debug=1&scene=launch&map=twin-gates&seed=1&unit=chestnut&zoom=2&x=820&y=1300&tick=30`
         */
        launch(params) {
            const scene = 'launch';
            const type = unitType(scene, 'unit', params.unit);
            const enemy =
                params.enemy === undefined ? undefined : unitType(scene, 'enemy', params.enemy);
            const sim = new StrategySim(
                integer(scene, 'seed', params.seed),
                GameRuleRuntime.resolveMatchRules({ presetId: params.map }),
                [[type], [enemy ?? type]],
            );
            const { host, center, dir } = baseAxis(sim);
            const across =
                params.across === undefined ? 400 : integer(scene, 'across', params.across);
            const distance =
                params.distance === undefined ? 300 : integer(scene, 'distance', params.distance);
            // `x`·`y` name the landing point instead; the cannon then stands toward the friendly main base.
            const target =
                params.x === undefined && params.y === undefined
                    ? { x: center.x - dir.y * across, y: center.y + dir.x * across }
                    : { x: integer(scene, 'x', params.x), y: integer(scene, 'y', params.y) };
            const back =
                params.x === undefined
                    ? { x: -dir.x, y: -dir.y }
                    : {
                          x: (host.x - target.x) / Math.hypot(host.x - target.x, host.y - target.y),
                          y: (host.y - target.y) / Math.hypot(host.x - target.x, host.y - target.y),
                      };
            const cannon = buildOutpost(
                sim,
                { id: 'launch', x: target.x + back.x * distance, y: target.y + back.y * distance },
                0,
            );
            const grain = LaunchRules.grain(type);
            sim.wallet[0] = Math.max(sim.wallet[0], grain.cost);
            sim.premiumWallet[0] = Math.max(sim.premiumWallet[0], grain.premiumCost || 0);
            if (enemy !== undefined)
                placeBlock(
                    sim,
                    1,
                    [enemy],
                    integer(scene, 'enemyCount', params.enemyCount),
                    params.enemyX === undefined && params.enemyY === undefined
                        ? target
                        : {
                              x: integer(scene, 'enemyX', params.enemyX),
                              y: integer(scene, 'enemyY', params.enemyY),
                          },
                    { x: back.x, y: back.y },
                );
            queueLaunch(sim, { tick: 10, seq: 1, side: 0, cannon, unitType: type, ...target });
            // The tick the first soldier of the shot came out (its launchLand event).
            let landTick = null;
            // How the squad stands: mean distance to the nearest and to every other soldier, the farthest
            // soldier from the squad's centre, and how far past the impact toward the enemy one went.
            const spreadOf = (squad) => {
                if (!squad.length) return {};
                const n = squad.length,
                    cx = squad.reduce((sum, u) => sum + u.x, 0) / n,
                    cy = squad.reduce((sum, u) => sum + u.y, 0) / n;
                let nearest = 0,
                    pair = 0,
                    radius = 0,
                    ahead = 0;
                for (const u of squad) {
                    let closest = Infinity;
                    for (const o of squad) {
                        if (o === u) continue;
                        const d = Math.hypot(o.x - u.x, o.y - u.y);
                        closest = Math.min(closest, d);
                        pair += d;
                    }
                    if (n > 1) nearest += closest;
                    radius = Math.max(radius, Math.hypot(u.x - cx, u.y - cy));
                    ahead = Math.max(
                        ahead,
                        -((u.x - target.x) * back.x + (u.y - target.y) * back.y),
                    );
                }
                const round = (v) => Math.round(v * 10) / 10;
                return {
                    nearest: round(nearest / n),
                    pair: round(n > 1 ? pair / (n * (n - 1)) : 0),
                    radius: round(radius),
                    ahead: round(ahead),
                };
            };
            const flight = createFlightProbe(sim),
                breath = breathProbe(sim, [type]),
                chain = chainProbe(sim, [type]);
            // follow=1: the camera eases toward the squad's centre on the clock (time constant FOLLOW_MS), so frames
            // drawn between ticks do not jump with the tick-rate centre.
            // It starts on the cannon, and holds there until the shot's first soldier is out.
            const squadCentre = followUnits(
                sim,
                { x: cannon.x, y: cannon.y },
                (u) => u.side === 0 && u.type === type,
            );
            let shown = null,
                shownAt = 0;
            const follow = () => {
                const goal = squadCentre(),
                    now = performance.now();
                if (!shown) shown = { x: goal.x, y: goal.y };
                else {
                    const k = 1 - Math.exp(-(now - shownAt) / FOLLOW_MS);
                    shown.x += (goal.x - shown.x) * k;
                    shown.y += (goal.y - shown.y) * k;
                }
                shownAt = now;
                return shown;
            };
            return matchScene(scene, params, sim, {
                zoom: params.zoom === undefined ? 3 : positive(scene, 'zoom', params.zoom),
                focus: flag(scene, 'follow', params.follow) ? follow : () => target,
                beforeStep: () => {
                    if (landTick === null && sim.events.some((e) => e.type === 'launchLand'))
                        landTick = sim.tick;
                    flight.observe();
                    breath?.observe();
                    chain?.observe();
                },
                extra: () => {
                    const squad = sim.units.filter(
                        (u) => u.alive && u.side === 0 && u.type === type,
                    );
                    return {
                        landing: { tick: landTick, units: squad.length, ...spreadOf(squad) },
                        flight: flight.state(),
                        ...(breath ? { breath: breath.state() } : {}),
                        ...(chain ? { chain: chain.state() } : {}),
                    };
                },
            });
        },
        /**
         * 양쪽을 경기 AI(BotController)가 둔다. 덱은 둘 다 기본 덱(`deck`이 있으면 둘 다 그 카드들)이고, 한쪽 본진이
         * 무너지면 끝난다. 예: `?debug=1&scene=ai-match&map=standard&seed=7&tick=900`,
         * 민들레씨 포함: `?debug=1&scene=ai-match&map=standard&seed=7&deck=watermelon,rice,pea,corn,popcorn,chestnut,sunflower-seed,dandelion&tick=6000`
         */
        'ai-match'(params) {
            const sim = createMatchSim('ai-match', params.map, params.seed, params.deck);
            const bots = attachBots(sim),
                probe = createKnockbackProbe(sim, flag('ai-match', 'trace', params.trace)),
                flight = createFlightProbe(sim),
                rider = createRiderProbe(sim),
                outposts = createOutpostProbe(sim),
                ammo = createAmmoProbe(sim),
                breath = breathProbe(sim, sim.decks.flat()),
                chain = chainProbe(sim, sim.decks.flat());
            return matchScene('ai-match', params, sim, {
                zoom: 1,
                focus: () => battleFocus(sim),
                beforeStep: () => {
                    ammo.observe();
                    probe.observe();
                    flight.observe();
                    rider.observe();
                    outposts.observe();
                    breath?.observe();
                    chain?.observe();
                    bots();
                },
                isComplete: () => sim.baseOutcome() !== null,
                extra: () => ({
                    winner: sim.baseOutcome(),
                    wallet: sim.wallet.slice(),
                    premiumWallet: sim.premiumWallet.slice(),
                    launches: sim.launchStats.launches.slice(),
                    ammo: ammo.state(),
                    knockback: probe.state(),
                    outside: probe.outside(),
                    flight: flight.state(),
                    rider: rider.state(),
                    outposts: outposts.state(),
                    ...(breath ? { breath: breath.state() } : {}),
                    ...(chain ? { chain: chain.state() } : {}),
                }),
            });
        },
        /**
         * 캠페인 스테이지 `stage`(campaign.js id)를 실제 경기와 같은 규칙(스테이지 맵·seed·양쪽 덱·임무)으로 연다.
         * 적은 경기 AI가 스테이지 발사 주기로 두고, 플레이어는 아무것도 하지 않는다. `player=bot`이면 플레이어 덱도
         * 경기 AI(기본 결정 간격)가 둔다. 상태의 `result`는 처음 정해진 승패와 그 틱, `fired`는 양쪽이 쏜 카드별 발사
         * 수, `points`는 점령 지점별 소유(0 플레이어, 1 적), `mission`은 캠페인 임무 상태다. 승패가 난 뒤에도 틱은
         * 계속 돈다. 예: `?debug=1&scene=campaign&stage=potato-uproot&tick=600`
         */
        campaign(params) {
            const stage = campaignStage(params.stage);
            if (!stage) throw new Error(`campaign needs a stage id: ${params.stage}`);
            if (params.player !== undefined && params.player !== 'bot')
                throw new Error(`campaign takes player=bot or nothing: ${params.player}`);
            const rules = GameRuleRuntime.resolveMatchRules({ presetId: stage.map ?? 'standard' });
            rules.campaign = stage;
            const sim = new StrategySim(stage.seed, rules, [stage.deck, stage.enemyDeck]);
            const bots = attachBots(sim, params.player === 'bot' ? ['host', 'guest'] : ['guest']),
                ammo = createAmmoProbe(sim);
            let result = null;
            const step = sim.step.bind(sim);
            sim.step = () => {
                const winner = step();
                if (winner && !result) result = { winner, tick: sim.tick };
                return winner;
            };
            return matchScene('campaign', params, sim, {
                zoom: 1,
                focus: () => battleFocus(sim),
                beforeStep: () => {
                    ammo.observe();
                    bots();
                },
                extra: () => ({
                    stage: stage.id,
                    map: sim.mapDescriptor.topology,
                    result,
                    fired: bots.fired,
                    ammo: ammo.state(),
                    launches: sim.launchStats.launches.slice(),
                    wallet: sim.wallet.slice(),
                    premiumWallet: sim.premiumWallet.slice(),
                    points: Object.fromEntries(
                        sim.capturePoints.map((p) => [
                            p.id,
                            [p.owner, Math.round(p.x), Math.round(p.y), p.resourceType],
                        ]),
                    ),
                    mission: sim.campaignMission && {
                        phase: sim.campaignMission.phase,
                        waveIndex: sim.campaignMission.waveIndex,
                        endTick: sim.campaignMission.endTick,
                        guardLost: sim.campaignMission.guardLost,
                    },
                }),
            });
        },
        /**
         * 타이틀 뒤 전투(src/ui/title-scenes.js)를 반복한다. 장면은 틱 1~42, 43~72, 73~102이고 굴러가는 코코넛
         * 속도(`coconuts`)를 함께 낸다. 예: `?debug=1&scene=title&tick=50`
         */
        title(params) {
            const stage = openStage(undefined);
            return host(
                stage,
                'title',
                params,
                (advanceTick, onError) =>
                    prepareTitleScenes({
                        renderer: stage.renderer,
                        createScenario,
                        createPresentationView,
                        advanceTick,
                        onError,
                    }),
                coconutSpeeds,
            );
        },
        /**
         * 카드 시연(src/ui/unit-showcase.js)을 그대로 연다. 시연처럼 끝나면 처음부터 다시 돈다.
         * 예: `?debug=1&scene=card&unit=coconut&tick=60`
         */
        card(params) {
            const type = params.unit;
            const stage = openStage(undefined);
            return host(stage, 'card', params, (advanceTick, onError) =>
                prepareUnitShowcase({
                    renderer: stage.renderer,
                    createScenario,
                    createPresentationView,
                    unitType: type,
                    advanceTick,
                    onError,
                }),
            );
        },
    };
}
