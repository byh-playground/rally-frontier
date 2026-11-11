/**
 * 주소로 여는 확인·측정용 장면(`?debug=1&scene=이름&tick=N&…`, GameKit debug-tools installDebugHost).
 * 일반 실행에서는 불러오지 않는다. 호스트는 debug·scene·tick만 읽고 나머지는 문자열 그대로 넘기므로
 * 값의 형식은 각 장면이 정하고, 틀리면 그대로 실패한다. 장면 목록·예시 주소는 AGENTS.md "디버그 장면"에 있다.
 *
 * 모든 장면은 카드 시연과 같은 경로(src/ui/sim-scene.js prepareSimScene: GameKit scenario + 경기 렌더러 + 경기
 * 연출)로 돈다. 표시는 가상 시계로 틱에서만 시간을 읽어 같은 주소가 같은 그림을 만들고, 시뮬레이션 틱
 * 시간은 실제 시계로 잰다(StrategySim.step의 기존 계측).
 */
import { FP } from './core/config.js';
import { GameRuleRuntime } from './core/game-rules.js';
import { BotController } from './ai/bot-controller.js';
import { UnitDefinition } from './definitions/units.js';
import { StableSerializationUtil } from './net/lobby-codec.js';
import { RollingBody } from './sim/capabilities/rolling-body.js';
import { StrategySim } from './sim/strategy-sim.js';
import { createShowcaseSurface } from './ui/showcase-host.js';
import { battleFocus, centerCamera, prepareSimScene } from './ui/sim-scene.js';
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

// The axis between the two main bases: the way each side's units walk by default.
function baseAxis(sim) {
    const host = sim.buildings.find((b) => b.id === 'base0'),
        guest = sim.buildings.find((b) => b.id === 'base1');
    const length = Math.hypot(guest.x - host.x, guest.y - host.y);
    return {
        host,
        guest,
        center: { x: (host.x + guest.x) / 2, y: (host.y + guest.y) / 2 },
        dir: { x: (guest.x - host.x) / length, y: (guest.y - host.y) / length },
    };
}

// Fills a block of `count` units around `center`, rows across `dir` (the side's facing), types taken in turn.
// A rolling unit starts rolling along `dir`, as one landing from a shell fired that way.
function placeBlock(sim, side, types, count, center, dir) {
    const spacing = 2 * Math.max(...types.map((type) => sim.unitRadius(type))) + 4;
    const columns = Math.ceil(Math.sqrt(count)),
        rows = Math.ceil(count / columns);
    for (let i = 0; i < count; i++) {
        const along = (Math.floor(i / columns) - (rows - 1) / 2) * spacing,
            across = ((i % columns) - (columns - 1) / 2) * spacing;
        const unit = sim.spawnUnit(
            side,
            types[i % types.length],
            center.x + dir.x * along - dir.y * across,
            center.y + dir.y * along + dir.x * across,
        );
        RollingBody.aim(unit, dir.x, dir.y);
    }
    return rows * spacing;
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
        const outpost = sim.spawnOutpost(point, side);
        sim.completeConstruction(outpost);
        outpost.hp = outpost.maxHp;
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
        contacts = { skippedPairs: 0, maxSkippedPairs: 0, maxPairContacts: 0, maxCasts: 0 };
    let last = null;
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
                ...(times ? { tickTimes: tickMs.map(round) } : {}),
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
    return { pairs, depth: round(depth) };
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
        try {
            run = open(
                () => {
                    stage.realTime(() => run.sim.step());
                    log.record(run.sim);
                },
                (error) => {
                    failure = error;
                },
            );
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
        return matchScene(scene, params, sim, { zoom: 1.4, focus: () => center });
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
            return matchScene(scene, params, sim, { zoom: 1.4, focus: followUnits(sim, start) });
        },
        /**
         * `count`명의 `unit`을 (`x`,`y`)에 세운다. 평소처럼 적 본진으로 가고, `enemy`·`enemyCount`가 있으면 그 적
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
            placeBlock(
                sim,
                0,
                [unitType(scene, 'unit', params.unit)],
                integer(scene, 'count', params.count),
                at,
                dir,
            );
            if (params.enemy !== undefined || params.enemyCount !== undefined)
                placeBlock(
                    sim,
                    1,
                    [unitType(scene, 'enemy', params.enemy)],
                    integer(scene, 'enemyCount', params.enemyCount),
                    { x: at.x + dir.x * 300, y: at.y + dir.y * 300 },
                    { x: -dir.x, y: -dir.y },
                );
            return matchScene(scene, params, sim, { zoom: 1.6, focus: followUnits(sim, at) });
        },
        /**
         * 양쪽을 경기 AI(BotController)가 둔다. 덱은 둘 다 기본 덱이고, 한쪽 본진이 무너지면 끝난다.
         * 예: `?debug=1&scene=ai-match&map=standard&seed=7&tick=900`
         */
        'ai-match'(params) {
            const sim = createMatchSim('ai-match', params.map, params.seed);
            return matchScene('ai-match', params, sim, {
                zoom: 1,
                focus: () => battleFocus(sim),
                beforeStep: attachBots(sim),
                isComplete: () => sim.baseOutcome() !== null,
                extra: () => ({
                    winner: sim.baseOutcome(),
                    wallet: sim.wallet.slice(),
                    launches: sim.launchStats.launches.slice(),
                }),
            });
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
