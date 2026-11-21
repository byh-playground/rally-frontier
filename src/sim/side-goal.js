// A stage's side goal (보조 목표): one goal beside winning, paid once with sunshine (definitions/roster.js
// SUNSHINE.sideGoal). Winning is still winning without it. A stage declares at most one (campaign.js):
//     sideGoal: { kind: 'freeCaptives' }                 every captive of the stage's spore sacs freed
//     sideGoal: { kind: 'freeCaptives', count: 6 }       at least `count` of them
//     sideGoal: { kind: 'burnFields' }                   no blighted cell of the stage's blight fields left
//     sideGoal: { kind: 'withinMs', ms: 180_000 }        won within `ms` on the mission's clock
//     sideGoal: { kind: 'lossesAtMost', count: 12 }       won with no more than `count` of the player's soldiers lost
//     sideGoal: { kind: 'allReinforcements' }             every sac of a boss stage broken by the time the reinforcements
//                                                         come (SporeSac), and the stage won
//     sideGoal: { kind: 'keepAlive', hpRatio: 0.5 }      won with the main base never below `hpRatio` of its health
//     sideGoal: { kind: 'keepAlive', hpRatio: 0.5, point: 'advance' }   the same for the outpost on a capture point
//                                                                      the player holds at the start
// `KINDS` below is the one table of the kinds: what each declares and checks, and how the simulation judges it.
// The simulation judges it, deterministically, on every tick (StrategySim.stepSimulation, after the match's winner):
// - `freeCaptives` and `burnFields` are met the first tick their condition holds, whatever comes after;
// - `withinMs` is missed the first tick the mission's clock (CampaignMission.clock) passes `ms`, and met on the tick
//   the player wins before that;
// - `lossesAtMost` is missed the first tick more than `count` of the player's soldiers have died (the enemy's kills of
//   them, `launchStats.kills[1]`), and met on the tick the player wins before that;
// - `keepAlive` is missed the first tick the building is gone or below `hpRatio`, and met on the tick the player wins
//   before that.
// `sim.sideGoal { status, tick }` is the only state: status 'open', 'met' or 'missed', and the tick it stopped being
// open (null while open). It exists only in a stage that declares a side goal, so every other match's state and
// checksum are what they were. A met or missed goal stays as it is.
import { BuildingDefinition } from '../definitions/buildings.js';
import { BlightField } from './blight-field.js';
import { CampaignMission } from './campaign-mission.js';
import { SporeSac } from './spore-sac.js';

const PLAYER = 0;

// The building a `keepAlive` goal watches now: the player's main base, or the outpost on its capture point (null
// once it is gone or the point is lost). Loops only: it runs every tick.
function keptBuilding(sim, goal) {
    let id = null;
    if (goal.point !== undefined) {
        const point = CampaignMission.point(sim, goal.point);
        if (point.owner !== PLAYER || !point.outpostId) return null;
        id = point.outpostId;
    }
    for (const building of sim.buildings) {
        if (building.alive === false || building.side !== PLAYER) continue;
        if (id === null ? BuildingDefinition.isMainBase(building.type) : building.id === id)
            return building;
    }
    return null;
}

// How many captives the stage's spore sacs hold in all, and how many of them are free now (no longer bound).
function captiveTotal(sim) {
    let total = 0;
    for (const sac of SporeSac.declared(sim))
        for (const group of sac.captives) total += group.count;
    return total;
}
function freedCaptives(sim) {
    let bound = 0;
    for (const unit of sim.units) if (SporeSac.bound(unit)) bound++;
    return captiveTotal(sim) - bound;
}

function blightedCells(sim) {
    let count = 0;
    for (const cell of sim.blightField.cells) if (cell === BlightField.BLIGHTED) count++;
    return count;
}

// Each kind: `check(sim, goal)` throws on a declaration it cannot judge; `judge(sim, goal, won)` returns 'met',
// 'missed' or null (still open) for one tick; `progress(sim, goal)` is what the battle screen shows.
const KINDS = Object.freeze({
    freeCaptives: {
        check(sim, goal) {
            const total = captiveTotal(sim);
            if (!total)
                throw new Error(
                    '포로 구하기 보조 목표는 포자 주머니(sporeSacs)를 선언한 판에만 둘 수 있습니다.',
                );
            if (
                goal.count !== undefined &&
                (!Number.isSafeInteger(goal.count) || goal.count < 1 || goal.count > total)
            )
                throw new Error(
                    `포로 구하기의 count는 1~${total}의 정수여야 합니다: ${goal.count}`,
                );
        },
        judge: (sim, goal) =>
            freedCaptives(sim) >= (goal.count ?? captiveTotal(sim)) ? 'met' : null,
        progress: (sim, goal) => ({
            freed: freedCaptives(sim),
            need: goal.count ?? captiveTotal(sim),
        }),
    },
    burnFields: {
        check(sim) {
            if (!sim.blightField)
                throw new Error(
                    '감염 밭 정화 보조 목표는 감염 밭(blightFields)을 선언한 판에만 둘 수 있습니다.',
                );
        },
        judge: (sim) => (blightedCells(sim) === 0 ? 'met' : null),
        progress: (sim) => ({ blighted: blightedCells(sim) }),
    },
    withinMs: {
        check(sim, goal) {
            if (!Number.isFinite(goal.ms) || goal.ms <= 0)
                throw new Error(`제한 시간 보조 목표의 ms는 양수여야 합니다: ${goal.ms}`);
        },
        judge(sim, goal, won) {
            if (CampaignMission.clock(sim) > sim.time.ceilTicks(goal.ms)) return 'missed';
            return won ? 'met' : null;
        },
        // The match tick the time runs out (null while a practice holds the mission's clock).
        progress(sim, goal) {
            const start = CampaignMission.startTick(sim);
            return { deadlineTick: start === null ? null : start + sim.time.ceilTicks(goal.ms) };
        },
    },
    lossesAtMost: {
        check(sim, goal) {
            if (!Number.isSafeInteger(goal.count) || goal.count < 0)
                throw new Error(
                    `병력 손실 보조 목표의 count는 0 이상의 정수여야 합니다: ${goal.count}`,
                );
        },
        judge(sim, goal, won) {
            if (sim.launchStats.kills[1] > goal.count) return 'missed';
            return won ? 'met' : null;
        },
        progress: (sim) => ({ lost: sim.launchStats.kills[1] }),
    },
    allReinforcements: {
        check(sim) {
            if (!sim.sporeReinforce)
                throw new Error(
                    '증원 모두 받기 보조 목표는 증원 주머니(sporeReinforceMs)를 선언한 판에만 둘 수 있습니다.',
                );
        },
        // Missed the tick the reinforcements come with a sac standing, or when the stage is won with one standing.
        judge(sim, goal, won) {
            const { done, broken, total } = SporeSac.view(sim);
            if (broken < total && (done || won)) return 'missed';
            return won ? 'met' : null;
        },
        progress: (sim) => {
            const { broken, total } = SporeSac.view(sim);
            return { broken, total };
        },
    },
    keepAlive: {
        check(sim, goal) {
            if (!Number.isFinite(goal.hpRatio) || goal.hpRatio <= 0 || goal.hpRatio > 1)
                throw new Error(
                    `지키기 보조 목표의 hpRatio는 0보다 크고 1 이하여야 합니다: ${goal.hpRatio}`,
                );
            if (!keptBuilding(sim, goal))
                throw new Error(
                    `지키기 보조 목표의 건물은 아군 시작 거점이어야 합니다: ${goal.point}`,
                );
        },
        judge(sim, goal, won) {
            const building = keptBuilding(sim, goal);
            if (!building || building.hp < building.maxHp * goal.hpRatio) return 'missed';
            return won ? 'met' : null;
        },
        progress(sim, goal) {
            const building = keptBuilding(sim, goal);
            return { hpNow: building ? building.hp / building.maxHp : 0 };
        },
    },
});

export class SideGoal {
    static KINDS = Object.keys(KINDS);

    // The stage's declared side goal, checked, or null.
    static declared(sim) {
        const goal = sim.rules.campaign?.sideGoal;
        if (goal === undefined) return null;
        if (!Object.hasOwn(KINDS, goal?.kind))
            throw new Error(
                `보조 목표의 종류(kind)는 ${SideGoal.KINDS.join('·')} 중 하나여야 합니다: ${goal?.kind}`,
            );
        KINDS[goal.kind].check(sim, goal);
        return goal;
    }

    // Match start (StrategySim constructor, after every device the goal reads): the goal is open.
    static initialize(sim) {
        if (this.declared(sim)) sim.sideGoal = { status: 'open', tick: null };
    }

    // One tick (StrategySim.stepSimulation, once the tick's winner is known): an open goal is met or missed.
    static update(sim, winner) {
        const state = sim.sideGoal;
        if (!state || state.status !== 'open') return;
        const goal = sim.rules.campaign.sideGoal,
            status = KINDS[goal.kind].judge(sim, goal, winner === 'host');
        if (!status) return;
        state.status = status;
        state.tick = sim.tick;
    }

    // What the battle screen and the result read (StrategySim.snapshot): the kind, status, the tick it stopped being
    // open and the kind's progress. Undefined without a side goal.
    static view(sim) {
        const state = sim.sideGoal;
        if (!state) return undefined;
        const goal = sim.rules.campaign.sideGoal;
        return { ...goal, ...KINDS[goal.kind].progress(sim, goal), ...state };
    }
}
