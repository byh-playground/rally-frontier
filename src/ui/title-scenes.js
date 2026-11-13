import { BuildingDefinition } from '../definitions/buildings.js';
import { RollingBody } from '../sim/capabilities/rolling-body.js';
import { LaunchRules } from '../sim/launch-rules.js';
import { StrategySim } from '../sim/strategy-sim.js';
import {
    baseAxis,
    blockSpacing,
    buildOutpost,
    centerCamera,
    prepareSimScene,
    queueLaunch,
} from './sim-scene.js';

// The battle behind the title: one battle staged on one map and played once through, looping. Its fights stand
// in different parts of the map and the camera cuts between them; each fight is placed (or its troops launched)
// just before its turn on screen, so it is in full swing when shown and the battle stays near the size of a
// match's. Same seed, same placement: the same pictures.
const SEED = 12349;
// The cards the battle launches (a launch command needs its card in the side's hand); placed units need none. With
// SEED this order deals corn into both hands and brings each later card of the host's script into its hand in time.
const DECK = Object.freeze(['watermelon', 'corn', 'rice', 'peanut']);
const RANGE_LEVEL = 2;
// Battle ticks run unseen before the first frame (ticks 1 - LEAD to 0), so the first fight has met when the title
// opens. Only that fight and its cannons exist this early, eight ticks before the title opens.
const LEAD = 8;
// When the potato and the black beans of the last shot are placed: the potato's cannon grows and the beans pick
// a cannon to ride about two and a half seconds later. And when the watermelon hero is told to use its skill.
const BEANS_TICK = 28;
const SKILL_TICK = 64;
// The shots, as tick ranges of the battle (1-based, after the lead).
const SHOTS = Object.freeze([
    { from: 1, to: 42 },
    { from: 43, to: 72 },
    { from: 73, to: 102 },
]);
const END_TICK = SHOTS[SHOTS.length - 1].to;
// A match's usual mix, mostly line infantry.
const ARMY = Object.freeze([
    'rice',
    'pea',
    'millet',
    'rice',
    'pea',
    'corn',
    'rice',
    'pea',
    'millet',
    'redbean',
    'rice',
    'pea',
    'chestnut',
    'corn',
]);
// The opening's host line adds sunflower seeds, which shoot down enemy shells, and popcorn.
const VANGUARD = Object.freeze([
    'rice',
    'pea',
    'sunflower-seed',
    'corn',
    'millet',
    'popcorn',
    'pea',
    'redbean',
    'rice',
    'chestnut',
]);
// The flank fight: heavier hitters, so the walnuts' victims fly among chestnuts, red beans and popcorn.
const FLANK = Object.freeze(['chestnut', 'pea', 'millet', 'popcorn', 'rice', 'redbean', 'corn']);
// The last shot's attackers: few of each, every one doing something of its own.
const ASSAULT = Object.freeze(['redbean', 'rice', 'popcorn', 'chestnut', 'pea', 'millet', 'corn']);

const smooth = (t) => {
    const k = Math.min(1, Math.max(0, t));
    return k * k * (3 - 2 * k);
};
const along = (point, dir, distance) => ({
    x: point.x + dir.x * distance,
    y: point.y + dir.y * distance,
});
const across = (point, dir, distance) => ({
    x: point.x - dir.y * distance,
    y: point.y + dir.x * distance,
});
const toward = (from, to) => {
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
};
const capturePoint = (sim, id) => sim.capturePoints.find((point) => point.id === id);
// The R2 low-discrepancy sequence: evenly spread points that never line up in rows.
const R2 = Object.freeze([0.7548776662466927, 0.5698402909980532]);
// Scatters `count` units of `types` (in turn) over a patch `width` across `dir` behind `front` (its front edge),
// as thick as a block of them `loose` times as far apart; a spot on a building is left empty.
const army = (sim, side, count, front, dir, width, { types = ARMY, loose = 1 } = {}) => {
    const spacing = blockSpacing(sim, types);
    const depth = (count * (spacing * loose) ** 2) / width;
    for (let i = 0; i < count; i++) {
        const spot = across(
            along(front, dir, -((0.5 + i * R2[1]) % 1) * depth),
            dir,
            (((0.5 + i * R2[0]) % 1) - 0.5) * width,
        );
        const onBuilding = sim.buildings.some(
            (building) =>
                Math.hypot(spot.x - building.x, spot.y - building.y) <
                BuildingDefinition.get(building.type).size + spacing,
        );
        if (!onBuilding) sim.spawnUnit(side, types[i % types.length], spot.x, spot.y);
    }
};
// Two armies meeting along a front through `point` across `dir` (the host's facing).
const clash = (sim, point, dir, counts, width, options = [{}, {}]) => {
    army(sim, 0, counts[0], along(point, dir, 8), dir, width, options[0]);
    const back = { x: -dir.x, y: -dir.y };
    army(sim, 1, counts[1], along(point, back, 8), back, width, options[1]);
};

// Builds the battle on a new sim: the map, the fights and the launches. Returns the sim, `placements` (what is
// placed before a battle tick, by tick) and `shots` (each shot's camera, given the ticks since it came on screen
// and the renderer, as { x, y, zoom, height? }).
function stageBattle() {
    const sim = new StrategySim(SEED, undefined, [DECK, DECK]);
    for (const side of [0, 1]) {
        for (let level = 0; level < RANGE_LEVEL; level++) {
            sim.creditResources(side, LaunchRules.walletCap);
            if (!sim.upgradeLaunchRange(side))
                throw new Error('타이틀 사거리 강화를 적용하지 못했습니다.');
        }
        sim.creditResources(side, LaunchRules.walletCap);
        sim.creditResources(side, LaunchRules.premiumWalletCap, 'premium');
    }
    const { dir, guest: guestBase } = baseAxis(sim);
    const back = { x: -dir.x, y: -dir.y };
    const cannon = buildOutpost(sim, capturePoint(sim, 'front-1'), 0);
    const guestCannon = buildOutpost(sim, capturePoint(sim, 'front-2'), 1);
    // The enemy outpost in the middle, already worn down.
    const outpost = buildOutpost(sim, capturePoint(sim, 'mid-center'), 1);
    outpost.hp = Math.round(outpost.maxHp * 0.9);
    let seq = 0;
    const launch = (tick, side, from, unitType, target) =>
        queueLaunch(sim, {
            tick: LEAD + tick,
            seq: ++seq,
            side,
            cannon: from,
            unitType,
            ...target,
        });
    const placements = new Map();
    const place = (tick, placement) =>
        placements.set(tick, [...(placements.get(tick) ?? []), placement]);

    // Shot 0: the front line below the middle outpost. The host's front cannon fires corn at its far end and the
    // camera rides the shell over the plateau; the guest's front cannon answers.
    const impact = { x: 2415, y: 2676 };
    place(-7, () => {
        clash(sim, across(impact, dir, 40), dir, [80, 80], 320, [{ types: VANGUARD }, {}]);
        army(sim, 0, 6, along(cannon, dir, 200), dir, 90, { types: ['corn'] });
    });
    launch(6, 0, cannon, 'corn', impact);
    launch(6, 1, guestCannon, 'corn', { x: 2342, y: 2626 });
    let opening;
    const openingShot = (ticks, renderer) => {
        const start = { x: cannon.x, y: cannon.y, zoom: 2.2 };
        const age = ticks - (opening?.tick ?? Infinity);
        if (!(age >= 2)) return start;
        const shell = renderer.snapshot.projectiles.find(
            (projectile) => projectile.id === opening.fire.projectileId,
        );
        const point = shell && renderer.resolveRenderWorldPosition(shell, 'projectile');
        const x = point?.x ?? opening.impact?.x ?? opening.fire.aimX;
        const y = point?.z ?? opening.impact?.y ?? opening.fire.aimY;
        const terrain = sim.world.terrain.surfaces;
        const height = point?.y ?? terrain.heightAt(x, y);
        const startHeight = terrain.heightAt(start.x, start.y);
        const k = smooth((age - 2) / 4);
        return {
            x: start.x + (x - start.x) * k,
            y: start.y + (y - start.y) * k,
            zoom: 2.2 + (1.35 - 2.2) * k,
            height: startHeight + (height - startHeight) * k,
        };
    };

    // Shot 1: a loose fight out on the east flank. Three walnuts set off far out on three sides of the host's half
    // (left, below, lower right) and come in near full speed, one after another, into the enemy ranks. A walnut
    // with no enemy in sight rolls for the enemy main base, so none can come from the enemy's side.
    const flank = { x: 3400, y: 2700 };
    const charge = toward(flank, guestBase);
    place(10, () =>
        clash(sim, flank, charge, [70, 70], 300, [
            { types: FLANK, loose: 1.35 },
            { types: FLANK, loose: 1.35 },
        ]),
    );
    // Degrees from the fight to the start (0 east, 90 south) and the tick it sets off.
    for (const [degrees, tick] of [
        [135, 7],
        [95, 17],
        [70, 21],
    ])
        place(tick, () => {
            const angle = (degrees * Math.PI) / 180;
            const start = {
                x: flank.x + Math.cos(angle) * 900,
                y: flank.y + Math.sin(angle) * 900,
            };
            const heading = toward(start, flank);
            RollingBody.aim(sim.spawnUnit(0, 'walnut', start.x, start.y), heading.x, heading.y);
        });

    // Shot 2: the host storms the middle outpost from the west. The outpost's mortar answers; peanuts ram its
    // wall, black beans hop onto the potato's young cannon and fly in, and the watermelon hero jumps into the
    // defenders and rolls through them.
    const storm = along(across(impact, dir, -600), back, 30);
    const sprout = { x: 1720, y: 2380 };
    place(BEANS_TICK, () => {
        sim.spawnUnit(0, 'potato', sprout.x, sprout.y);
        // The beans walk up behind the cannon while they wait to ride.
        const start = along(sprout, dir, -190);
        for (let k = 0; k < 4; k++) {
            const spot = across(start, dir, (k - 1.5) * 26);
            sim.spawnUnit(0, 'black-bean', spot.x, spot.y);
        }
    });
    place(52, () => clash(sim, storm, dir, [36, 38], 380, [{ types: ASSAULT }, {}]));
    launch(46, 0, cannon, 'watermelon', along(storm, back, 240));
    launch(70, 0, cannon, 'peanut', along(outpost, back, 150));
    launch(84, 0, cannon, 'rice', { x: 1840, y: 2380 });

    return {
        sim,
        placements,
        shots: [
            openingShot,
            () => ({ ...along(flank, charge, -50), zoom: 1.25 }),
            () => ({ x: 1885, y: 2310, zoom: 1.65 }),
        ],
        // Called before every battle tick: the watermelon hero uses its skill through the player's command.
        command(tick) {
            if (tick !== SKILL_TICK) return;
            const hero = sim.heroes[0].watermelon;
            if (!hero?.unitId) return;
            sim.queueCommand({
                tick: sim.tick + 1,
                seq: ++seq,
                actor: 'host',
                action: { type: 'ACTIVATE_HERO_SKILL', sortieId: hero.sortieId },
            });
        },
        // Called after every battle tick: catches the opening shell's launch and landing for its camera.
        watch(tick) {
            if (tick === 1) opening = null;
            for (const event of sim.events) {
                if (!opening && event.type === 'launchFire' && event.cannonId === cannon.id)
                    opening = { fire: event, tick };
                else if (
                    opening &&
                    !opening.impact &&
                    event.type === 'launchImpact' &&
                    event.projectileId === opening.fire.projectileId
                )
                    opening.impact = event;
            }
        },
    };
}

/**
 * Prepares the title battle, looping. `advanceTick` steps the sim (the debug host times it); the returned handle
 * is prepareSimScene's.
 */
export function prepareTitleScenes({
    renderer,
    createScenario,
    createPresentationView,
    advanceTick,
    onError,
}) {
    const battle = stageBattle();
    const { sim } = battle;
    const before = (tick) => {
        for (const placement of battle.placements.get(tick) ?? []) placement();
        battle.command(tick);
    };
    for (let tick = 1 - LEAD; tick <= 0; tick++) {
        before(tick);
        sim.step();
    }
    const shotAt = (tick) => SHOTS.findIndex((shot) => tick <= shot.to);
    const camera = (tick) => {
        const index = Math.max(0, shotAt(Math.ceil(tick)));
        const { x, y, zoom, height } = battle.shots[index](tick - SHOTS[index].from + 1, renderer);
        renderer.replayZoom = zoom;
        centerCamera(renderer, x, y, height ?? sim.world.terrain.surfaces.heightAt(x, y));
    };
    renderer.role = 'host';
    renderer.replayObserverAll = true;
    return prepareSimScene({
        renderer,
        createScenario,
        createPresentationView,
        sim,
        seed: SEED,
        endTick: END_TICK,
        loop: true,
        advanceTick() {
            (advanceTick ?? (() => sim.step()))();
            battle.watch(sim.tick - LEAD);
        },
        start() {
            camera(0);
        },
        beforeStep(frame) {
            before(frame.tick);
        },
        render(frame) {
            camera(frame.tick + (frame.alpha ?? 0));
        },
        onError,
    });
}
