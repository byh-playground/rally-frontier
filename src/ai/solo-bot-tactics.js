import { FP } from '../core/config.js';
import { LaunchRules } from '../sim/launch-rules.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { UnitDefinition } from '../definitions/units.js';

const FRONT_RADIUS = 240;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const toward = (from, to, length) => {
    const span = Math.max(1, distance(from, to));
    return {
        x: from.x + ((to.x - from.x) * length) / span,
        y: from.y + ((to.y - from.y) * length) / span,
    };
};
const enemiesNear = (ctx, point, range = FRONT_RADIUS) =>
    ctx.enemies.filter((unit) => distance(unit, point) <= range);
const exists = (ctx, id) => ctx.hostile.some((building) => building.id === id);
const pointOf = (ctx, goal) => ctx.state.capturePoints.find((point) => point.id === goal.pointId);
const near = (ctx, type, point, range = FRONT_RADIUS) =>
    ctx.state.units.some(
        (unit) =>
            unit.alive &&
            unit.side === ctx.side &&
            unit.type === type &&
            distance(unit, point) <= range,
    );
function closest(pool, at) {
    return pool.reduce(
        (best, entry) => (!best || distance(at, entry) < distance(at, best) ? entry : best),
        null,
    );
}

// Check the actual locked aim. Min range, range upgrades and map bounds can all move it.
export function operationShot(ctx, type, at, sources = ctx.cannons, tolerance = 135) {
    const unit = ctx.cards.find((card) => card.type === type);
    if (!unit) return null;
    let best = null;
    for (const cannon of sources) {
        const span = distance(cannon, at);
        const hold = Math.round(LaunchRules.holdFor(span, type, ctx.level));
        const aim = LaunchRules.target(
            cannon,
            at.x,
            at.y,
            hold,
            ctx.world,
            ctx.state.flags[ctx.side],
            type,
            ctx.level,
        );
        const miss = distance(aim, at);
        if (
            miss <= tolerance &&
            (!best || miss < best.miss || (miss === best.miss && span < best.distance))
        )
            best = { cannon, target: at, distance: span, miss, unit };
    }
    return best;
}

function enemyOutposts(ctx) {
    return ctx.hostile.filter((b) => !b.construction && BuildingDefinition.get(b.type)?.isOutpost);
}

function demolitionGoal(ctx) {
    for (const target of enemyOutposts(ctx).sort(
        (a, b) => distance(a, ctx.base) - distance(b, ctx.base),
    )) {
        const assault = operationShot(ctx, 'peanut', target);
        const point = ctx.state.capturePoints.find((p) => p.outpostId === target.id);
        if (!assault || !point) continue;
        // Send the escort to the defenders, or onto the approach when the outpost stands alone.
        const cover =
            closest(enemiesNear(ctx, target, 225), assault.cannon) ??
            toward(target, assault.cannon, 110);
        if (operationShot(ctx, 'millet', cover))
            return { focus: target, targetId: target.id, pointId: point.id, cover };
    }
    return null;
}

function forwardGoal(ctx) {
    const targets = [...enemyOutposts(ctx), ctx.enemyBase].filter(Boolean);
    const infantryReach = LaunchRules.maxReachOf('peanut', ctx.level);
    const seedReach = LaunchRules.maxReachOf('potato', ctx.level);
    for (const target of targets) {
        const source = closest(
            ctx.buildings.filter((b) => LaunchRules.isLaunchCannon(b, ctx.side)),
            target,
        );
        if (!source) continue;
        const span = distance(source, target);
        if (span <= infantryReach + 75 || span > infantryReach + seedReach - 50) continue;
        const staging = toward(source, target, seedReach - 16);
        if (!ctx.world.terrain.field.polygonCircleClear(staging.x, staging.y, 22)) continue;
        if (operationShot(ctx, 'walnut', staging))
            return { focus: target, targetId: target.id, staging };
    }
    return null;
}

function newBattery(ctx, goal) {
    const type = UnitDefinition.get('potato').growsCannon.building;
    return ctx.buildings.find(
        (b) => b.type === type && !b.construction && distance(b, goal.staging) <= 145,
    );
}

function relayGoal(ctx) {
    const base = ctx.enemyBase;
    if (!base) return null;
    const range = LaunchRules.maxReachOf('black-bean', ctx.level);
    const sources = ctx.buildings.filter(
        (b) => LaunchRules.isLaunchCannon(b, ctx.side) && !LaunchRules.jammed(ctx.state, b),
    );
    for (const rear of sources) {
        if (
            enemiesNear(ctx, rear, range).length ||
            ctx.hostile.some((b) => distance(rear, b) <= range)
        )
            continue;
        for (const front of sources) {
            if (distance(front, base) >= distance(rear, base) || distance(front, rear) > range)
                continue;
            const staging = toward(rear, front, -range + 22);
            const field = ctx.world.terrain.field;
            if (
                !field.polygonCircleClear(staging.x, staging.y, 24) ||
                !field.polygonSegmentClear(staging.x, staging.y, rear.x, rear.y, 0)
            )
                continue;
            if (
                !operationShot(
                    ctx,
                    'black-bean',
                    staging,
                    ctx.cannons.filter((b) => b.id === rear.id),
                )
            )
                continue;
            const cover = toward(front, base, 250);
            if (operationShot(ctx, 'pea', cover))
                return { focus: front, frontId: front.id, rearId: rear.id, staging, cover };
        }
    }
    return null;
}

function pressureGoal(ctx) {
    const cannon = ctx.enemyBase && closest(ctx.cannons, ctx.enemyBase);
    if (!cannon || ctx.state.launchStats.launches[ctx.side] > 3) return null;
    return {
        focus: toward(cannon, ctx.enemyBase, LaunchRules.maxReachOf('millet', ctx.level) - 18),
        origin: cannon,
    };
}

function pressureFollowUp(ctx, goal, type) {
    const target = closest(enemiesNear(ctx, goal.focus, 310), goal.focus);
    if (!target) return null;
    const along = toward(target, goal.origin, 60);
    const span = Math.max(1, distance(goal.origin, target));
    for (const sign of [1, -1]) {
        const flank = {
            x: along.x + ((target.y - goal.origin.y) * 90 * sign) / span,
            y: along.y - ((target.x - goal.origin.x) * 90 * sign) / span,
        };
        const shot = operationShot(ctx, type, flank, ctx.cannons, 85);
        if (shot) return shot;
    }
    return null;
}

function chokeGoal(ctx) {
    const gates = [...ctx.world.terrain.surfaces.ramps, ...ctx.world.terrain.surfaces.bridges];
    for (const gate of gates) {
        if (!gate.points?.length) continue;
        const focus = {
            x: gate.points.reduce((sum, point) => sum + point.x, 0) / gate.points.length,
            y: gate.points.reduce((sum, point) => sum + point.y, 0) / gate.points.length,
        };
        if (enemiesNear(ctx, focus, 235).length < 4 || !operationShot(ctx, 'walnut', focus))
            continue;
        const rear = toward(focus, closest(ctx.cannons, focus), 100);
        if (operationShot(ctx, 'chili', rear)) return { focus, rear };
    }
    return null;
}

function safeFlightTarget(ctx, target) {
    return !enemiesNear(ctx, target, 360).some((u) => {
        const definition = UnitDefinition.get(u.type);
        return definition.canAttackAir || definition.chainAttack;
    });
}

function flankGoal(ctx) {
    const terrain = ctx.world.terrain.field;
    const targets = [...enemyOutposts(ctx), ...ctx.enemies];
    for (const target of targets) {
        const source = closest(ctx.cannons, target);
        if (!source) continue;
        const span = distance(source, target);
        if (span < 250 || span > 800 || !safeFlightTarget(ctx, target)) continue;

        const reach = LaunchRules.maxReachOf('dandelion', ctx.level);
        const towardTarget = Math.min(span - 120, reach - 20);
        for (const along of [towardTarget, towardTarget - 70, towardTarget - 140]) {
            if (along < 100) break;
            const center = toward(source, target, along);
            for (const sideways of [0, 90, -90, 165, -165]) {
                const staging = {
                    x: center.x + ((target.y - source.y) * sideways) / span,
                    y: center.y - ((target.x - source.x) * sideways) / span,
                };
                const flight = operationShot(ctx, 'dandelion', staging, [source], 55);
                if (
                    !flight ||
                    distance(staging, target) < 160 ||
                    !terrain.polygonCircleClear(staging.x, staging.y, 24) ||
                    !terrain.polygonSegmentClear(source.x, source.y, staging.x, staging.y, 0) ||
                    terrain.polygonSegmentClear(staging.x, staging.y, target.x, target.y, 0)
                )
                    continue;

                const cover = toward(target, source, 95);
                if (operationShot(ctx, 'pea', cover))
                    return {
                        focus: target,
                        targetId: target.id,
                        staging,
                        cover,
                        sourceId: source.id,
                    };
            }
        }
    }
    return null;
}

const flankActive = (ctx, goal) =>
    (exists(ctx, goal.targetId) || enemiesNear(ctx, goal.focus, 210).length > 0) &&
    safeFlightTarget(ctx, goal.focus);

function reclaimedWorkers(ctx, goal) {
    const source = closest(ctx.cannons, goal.focus);
    if (!source) return null;
    const front = toward(goal.focus, source, 105);
    const dx = front.x - goal.focus.x,
        dy = front.y - goal.focus.y;
    return [
        front,
        { x: goal.focus.x + dy, y: goal.focus.y - dx },
        { x: goal.focus.x - dy, y: goal.focus.y + dx },
        goal.focus,
    ]
        .filter((point) => ctx.world.terrain.field.polygonCircleClear(point.x, point.y, 45))
        .map((point) => ({
            shot: operationShot(ctx, 'sesame', point, ctx.cannons, 42),
            crowd: ctx.state.units.filter((u) => u.alive && distance(u, point) <= 90).length,
        }))
        .filter(({ shot }) => shot)
        .sort((a, b) => a.crowd - b.crowd)[0]?.shot;
}

const direct =
    (type, slot = 'focus') =>
    (ctx, goal) =>
        operationShot(ctx, type, goal[slot]);
const present =
    (type, slot = 'focus') =>
    (ctx, goal) =>
        near(ctx, type, goal[slot]);

// Each action has one observable completion. A plan can be abandoned from any phase.
export const soloBotTactics = {
    demolition: {
        name: '거점 철거형',
        signature: { millet: 8, peanut: 9, sesame: 3 },
        support: ['rice', 'pea', 'buckwheat', 'walnut', 'chestnut'],
        select: demolitionGoal,
        steps: [
            {
                card: 'millet',
                shot: direct('millet', 'cover'),
                done: present('millet', 'cover'),
                valid: (ctx, goal) => exists(ctx, goal.targetId),
            },
            {
                card: 'peanut',
                shot: direct('peanut'),
                done: (ctx, goal) => !exists(ctx, goal.targetId),
                valid: (ctx, goal) =>
                    exists(ctx, goal.targetId) && near(ctx, 'millet', goal.cover, 360),
                waitMs: 16000,
            },
            {
                card: 'sesame',
                shot: reclaimedWorkers,
                done: present('sesame'),
                waitMs: 18000,
                valid: (ctx, goal) =>
                    !exists(ctx, goal.targetId) && pointOf(ctx, goal)?.owner == null,
            },
        ],
    },
    'forward-battery': {
        name: '전진 대포형',
        signature: { walnut: 7, potato: 10, peanut: 9 },
        support: ['rice', 'sesame', 'pea', 'chestnut', 'sunflower-seed'],
        select: forwardGoal,
        steps: [
            {
                card: 'walnut',
                shot: direct('walnut', 'staging'),
                done: present('walnut', 'staging'),
            },
            {
                card: 'potato',
                shot: direct('potato', 'staging'),
                done: (ctx, goal) => !!newBattery(ctx, goal),
            },
            {
                card: 'peanut',
                valid: (ctx, goal) => exists(ctx, goal.targetId) && !!newBattery(ctx, goal),
                shot: (ctx, goal) =>
                    operationShot(
                        ctx,
                        'peanut',
                        goal.focus,
                        ctx.cannons.filter((b) => b.id === newBattery(ctx, goal)?.id),
                    ),
                done: present('peanut'),
            },
        ],
    },
    relay: {
        name: '대포 릴레이형',
        once: true,
        signature: { sesame: 3, pea: 7, 'black-bean': 12 },
        support: ['rice', 'millet', 'buckwheat', 'walnut', 'chestnut'],
        select: relayGoal,
        steps: [
            { card: 'pea', shot: direct('pea', 'cover'), done: present('pea', 'cover') },
            {
                card: 'black-bean',
                valid: (ctx, goal) =>
                    ctx.buildings.some(
                        (b) => b.id === goal.frontId && !LaunchRules.jammed(ctx.state, b),
                    ),
                shot: (ctx, goal) =>
                    operationShot(
                        ctx,
                        'black-bean',
                        goal.staging,
                        ctx.cannons.filter((cannon) => cannon.id === goal.rearId),
                    ),
                observe: (state, goal, side) =>
                    state.projectiles.some(
                        (p) =>
                            p.side === side &&
                            p.owner === goal.rearId &&
                            p.payload?.ride === 'hop' &&
                            distance({ x: p.lockedAimX, y: p.lockedAimY }, goal.focus) < 120,
                    ),
                done: (ctx, goal, observedHop) =>
                    observedHop &&
                    ctx.state.projectiles.some((p) => p.owner === goal.frontId && p.payload?.ride),
                waitMs: 20000,
            },
        ],
    },
    pressure: {
        name: '초반 돌격형',
        once: true,
        decisionIntervalMs: 800,
        signature: { millet: 10, redbean: 9, popcorn: 7 },
        support: ['pea', 'rice', 'black-bean', 'chili', 'cotton'],
        select: pressureGoal,
        steps: [
            { card: 'millet', shot: direct('millet'), done: present('millet') },
            {
                card: 'redbean',
                shot: (ctx, goal) => pressureFollowUp(ctx, goal, 'redbean'),
                done: present('redbean'),
            },
            {
                card: 'popcorn',
                shot: (ctx, goal) => pressureFollowUp(ctx, goal, 'popcorn'),
                valid: (ctx, goal) => enemiesNear(ctx, goal.focus, 270).length >= 3,
                optional: true,
            },
        ],
    },
    choke: {
        name: '길목 방어형',
        signature: { walnut: 9, chili: 9, corn: 7 },
        support: ['rice', 'pea', 'sesame', 'buckwheat', 'chestnut'],
        select: chokeGoal,
        steps: [
            { card: 'walnut', shot: direct('walnut'), done: present('walnut') },
            { card: 'chili', shot: direct('chili', 'rear'), done: present('chili', 'rear') },
            {
                card: 'corn',
                shot: (ctx, goal) =>
                    enemiesNear(ctx, goal.focus, 230).length >= 4
                        ? operationShot(ctx, 'corn', goal.focus)
                        : null,
            },
        ],
    },
    flank: {
        name: '비행 우회형',
        signature: { pea: 5, dandelion: 10, millet: 7 },
        support: ['rice', 'sesame', 'walnut', 'sunflower-seed', 'popcorn'],
        select: flankGoal,
        steps: [
            { card: 'pea', shot: direct('pea', 'cover'), done: present('pea', 'cover') },
            {
                card: 'dandelion',
                valid: flankActive,
                shot: (ctx, goal) =>
                    operationShot(
                        ctx,
                        'dandelion',
                        goal.staging,
                        ctx.cannons.filter((cannon) => cannon.id === goal.sourceId),
                        55,
                    ),
                done: (ctx, goal) =>
                    ctx.state.units.some(
                        (unit) =>
                            unit.alive &&
                            unit.type === 'dandelion' &&
                            unit.side === ctx.side &&
                            unit.flight?.phase === 'landed' &&
                            unit.flight.originFx != null &&
                            !ctx.world.terrain.field.polygonSegmentClear(
                                unit.flight.originFx / FP,
                                unit.flight.originFy / FP,
                                unit.x,
                                unit.y,
                                0,
                            ) &&
                            distance(unit, goal.focus) <= 200,
                    ),
                waitMs: 16000,
            },
            {
                card: 'millet',
                valid: flankActive,
                shot: direct('millet'),
            },
        ],
    },
};
