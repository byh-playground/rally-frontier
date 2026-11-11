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
import { BotController } from './ai/bot-controller.js';
import { UnitDefinition } from './definitions/units.js';
import { StableSerializationUtil } from './net/lobby-codec.js';
import { RollingBody } from './sim/capabilities/rolling-body.js';
import { LaunchRules } from './sim/launch-rules.js';
import { StrategySim } from './sim/strategy-sim.js';
import { createShowcaseSurface } from './ui/showcase-host.js';
import {
    baseAxis,
    battleFocus,
    buildOutpost,
    centerCamera,
    placeBlock,
    prepareSimScene,
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

function integer(scene, name, text) {
    if (!/^\d+$/.test(text ?? '')) throw new Error(`${scene} needs an integer ${name}: ${text}`);
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

// A match on one of the PvP maps (game-rules.js presets), with both sides' decks at the starter deck.
function createMatchSim(scene, map, seed) {
    return new StrategySim(
        integer(scene, 'seed', seed),
        GameRuleRuntime.resolveMatchRules({ presetId: map }),
    );
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

// The match AI plays both sides through the session surface BotController reads (as in the Worker host);
// what it decides on a tick's state runs on the next tick.
function attachBots(sim) {
    let sequence = 0;
    const bots = ['host', 'guest'].map((role) => {
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
    return () => {
        const snapshot = sim.snapshot();
        for (const bot of bots) bot.handleSnapshot(snapshot);
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
// what gave it: 'blast' (self-destruct), 'spin', 'heroRoll', 'leap', 'roll' (a rolling walnut, with the walnut's
// speed just before as `sourceSpeed`), 'shell' (a launch shell's landing), 'lob' (a lobbed ball) or 'contact' (a
// flying body bumping into it). Then the highest point, the top ground speed it reached (later impulses add up),
// the first landing (`airTicks`, `airDist`), how far it travels from where it stood and how many ticks until it
// settles. `trace=1` adds each entry's side view per tick, [ground distance, height].
function createKnockbackProbe(sim, trace = false) {
    const entries = new Map(),
        previous = new Map(),
        sourceSpeed = new Map();
    const blasts = new Set();
    const label = (sourceId) => {
        if (blasts.has(sourceId)) return 'blast';
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
            for (const event of sim.events)
                if (event.type === 'unitSelfDestruct') blasts.add(event.sourceId);
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
    };
}

// One row of `count` units across `dir`, `spacing` apart: a transverse landing line (chestnut's).
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
    }
}

// A fight in the `unit` scene, read by `state().fight`: the tick one side first has no live unit (with who is left
// and their health then), and every lobbed egg thrown (`unitLobLaunch`), every explosion (`unitLobExplosion`) and
// how many enemies each explosion hit (the area damage's own hit count). Eggs count until 20 ticks after the end.
function createFightProbe(sim) {
    const lobs = { thrown: 0, explosions: 0, hits: 0, empty: 0, log: [] };
    let end = null;
    // Damage dealt before the end, by the type of the unit that dealt it.
    const dealt = {},
        thrown = new Set(),
        landed = new Map();
    const damage = sim.applyDamage.bind(sim);
    sim.applyDamage = (side, type, target, building, amount, ...rest) => {
        const hpBefore = target.hp;
        const result = damage(side, type, target, building, amount, ...rest);
        if (!end) dealt[type] = (dealt[type] ?? 0) + Math.max(0, hpBefore - target.hp);
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
    return {
        observe() {
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

// The walnuts still rolling: how many, and their mean and top speed (world units per second).
function walnutSpeeds(sim) {
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
        walnuts: {
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
    function followUnits(sim, from) {
        let focus = from;
        return () => {
            const units = sim.units.filter((unit) => unit.alive);
            if (units.length)
                focus = {
                    x: units.reduce((sum, unit) => sum + unit.x, 0) / units.length,
                    y: units.reduce((sum, unit) => sum + unit.y, 0) / units.length,
                };
            return focus;
        };
    }

    function melee(scene, params, walnuts) {
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
        // Each side's walnuts stand in a row behind its block and roll into the fight.
        for (const [side, facing] of [
            [0, dir],
            [1, back],
        ])
            for (let k = 0; k < walnuts; k++) {
                const across = (k - (walnuts - 1) / 2) * 60,
                    behind = 250 + depth / 2 + 80;
                const walnut = sim.spawnUnit(
                    side,
                    'walnut',
                    center.x - facing.x * behind - facing.y * across,
                    center.y - facing.y * behind + facing.x * across,
                );
                RollingBody.aim(walnut, facing.x, facing.y);
            }
        return matchScene(scene, params, sim, {
            zoom: 1.4,
            focus: () => center,
            extra: walnutSpeeds,
        });
    }

    return {
        /**
         * 양쪽 걷는 병사 무리가 맵 가운데에서 맞부딪친다. 본진을 잇는 축 위 가운데 앞뒤 250에 진영마다 `units`명을
         * 사각형으로 세우고, `mix`(쉼표로 나눈 병종)를 차례로 채운다. 병사는 평소처럼 적 본진으로 걷는다.
         * 예: `?debug=1&scene=melee&map=artillery-basin&seed=1&units=150&mix=rice,pea&tick=100`
         */
        melee: (params) => melee('melee', params, 0),
        /**
         * melee에 더해 진영마다 호두 `walnuts`개가 자기 무리 뒤에서 적 쪽으로 굴러 들어간다(PR #327 재현 구성).
         * 예: `?debug=1&scene=walnut-melee&map=artillery-basin&seed=1&units=150&mix=rice,pea&walnuts=5&tick=300`
         */
        'walnut-melee': (params) =>
            melee('walnut-melee', params, integer('walnut-melee', 'walnuts', params.walnuts)),
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
         * 무리가 적 본진 쪽 300 앞에 선다. `outposts=1`이면 모든 점령 지점에 더 가까운 본진 쪽의 완성된 거점을 둔다
         * (검은콩 앞쪽 대포 탑승, 찹쌀 거점 포구 막기). 예:
         * `?debug=1&scene=unit&map=twin-gates&seed=1&unit=walnut&count=1&x=1400&y=2900&tick=150`
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
            if (params.line === undefined) placeBlock(sim, 0, group, count, at, dir);
            else placeLine(sim, 0, group[0], count, at, dir, integer(scene, 'line', params.line));
            if (params.enemy !== undefined || params.enemyCount !== undefined)
                placeBlock(
                    sim,
                    1,
                    [unitType(scene, 'enemy', params.enemy)],
                    integer(scene, 'enemyCount', params.enemyCount),
                    {
                        x:
                            at.x +
                            dir.x *
                                (params.gap === undefined
                                    ? 300
                                    : integer(scene, 'gap', params.gap)),
                        y:
                            at.y +
                            dir.y *
                                (params.gap === undefined
                                    ? 300
                                    : integer(scene, 'gap', params.gap)),
                    },
                    { x: -dir.x, y: -dir.y },
                );
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
                fight = createFightProbe(sim);
            return matchScene(scene, params, sim, {
                zoom: 1.6,
                focus: followUnits(sim, at),
                beforeStep: () => {
                    probe.observe();
                    fight.observe();
                },
                extra: () => ({ knockback: probe.state(), fight: fight.state() }),
            });
        },
        /**
         * 양쪽을 경기 AI(BotController)가 둔다. 덱은 둘 다 기본 덱이고, 한쪽 본진이 무너지면 끝난다.
         * 예: `?debug=1&scene=ai-match&map=standard&seed=7&tick=900`
         */
        'ai-match'(params) {
            const sim = createMatchSim('ai-match', params.map, params.seed);
            const bots = attachBots(sim),
                probe = createKnockbackProbe(sim, flag('ai-match', 'trace', params.trace));
            return matchScene('ai-match', params, sim, {
                zoom: 1,
                focus: () => battleFocus(sim),
                beforeStep: () => {
                    probe.observe();
                    bots();
                },
                isComplete: () => sim.baseOutcome() !== null,
                extra: () => ({
                    winner: sim.baseOutcome(),
                    wallet: sim.wallet.slice(),
                    launches: sim.launchStats.launches.slice(),
                    knockback: probe.state(),
                }),
            });
        },
        /**
         * 타이틀 뒤 전투(src/ui/title-scenes.js)를 반복한다. 장면은 틱 1~42, 43~72, 73~102이고 굴러가는 호두
         * 속도(`walnuts`)를 함께 낸다. 예: `?debug=1&scene=title&tick=50`
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
                walnutSpeeds,
            );
        },
        /**
         * 카드 시연(src/ui/unit-showcase.js)을 그대로 연다. 시연처럼 끝나면 처음부터 다시 돈다.
         * 예: `?debug=1&scene=card&unit=walnut&tick=60`
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
