// The practice step (익히기 단계) of a stage where a new card joins: the player first tries the card on targets that
// stand still, and the stage's mission begins only when they are all down. A stage declares it (campaign.js):
//     practice: { card: 'pea', cue: '콩을 쏴서 허수아비를 쓰러뜨려요',
//                 targets: [{ type: 'rice', x: 1300, y: 2500, count: 6, columns: 3 }] }
// The targets are ordinary enemy soldiers (wave formations without `side` and `hold`, never a hero), blighted on a
// blighted stage as every enemy is (Blight.mark), standing from the first tick and seen through the fog. A target takes
// no turn (StrategySim.stepSimulation: no move, no target, no attack), the way a spore sac's captive takes none, but it
// stays an ordinary enemy: anything can target it, hit it, push it and kill it. `card` must be a card of the player's
// deck; `cue` is the battle screen's one line while the practice runs.
// Other goals a practice may declare instead of (or beside) targets, for the cards that do not kill soldiers; the
// practice ends on the tick every goal it declares has held (a goal that held stays held):
//     built: '<point id>'          the player's outpost on that empty capture point is complete (참깨)
//     forwardCannon: true          one of the player's forward cannons stands (감자)
//     clamp: '<point id>'          a sticky-rice soldier holds the muzzle of the enemy outpost on that point (찹쌀),
//                                  a point of the stage's `enemyOutposts`
// `sim.campaignPractice` then also holds `cannon` / `clamped` (set once), only in a stage declaring that goal.
// A practice may also name an enemy outpost to bring down (`building`, the id of a capture point in the stage's
// `enemyOutposts`): the one building of the enemy that takes damage while the practice runs (for a card that only
// attacks buildings), and the practice ends when it is destroyed and every target (if any) is down. `targets` may then
// be left out:
//     practice: { card: 'peanut', cue: '땅콩을 쏴서 훈련 거점을 부숴요', building: 'basin-natural-1' }
// Only the player brings the targets down: towers never aim at them (StrategySim.updateBuildingCombat), so they fall to
// the shells the player fires and the soldiers that come out of them.
// While the practice runs the mission's clock stands at 0 (CampaignMission.clock): no defence wave, spore cloud, blight
// field growth or survival countdown advances, the enemy AI makes no decision (BotController) and the boss and its
// escorts have not come out yet (BlightBoss.start). The enemy's buildings take no damage (`shields`) and the player
// cannot win (`resolve`): the practice cannot be skipped by going for the enemy's base. The player can still lose.
// The match's own ticks run on as always (the economy, ammunition, the field's harm), so the simulation stays one
// deterministic run. The tick the last target is down ends it: the mission's clock counts from that tick, so every
// timing the stage declares in ms runs as it would from a match start.
// No enemy soldier stands from the first tick but the targets: a practice cannot be declared with `introducedEnemy`,
// `mission.formations` or `volleyGoals` (their soldiers would march on or fight the player while it runs).
// `sim.campaignPractice { doneTick }` (null while it runs) is the only state and `unit.practiceTarget` marks a target.
// Both exist only in a stage that declares a practice, so every other match's state and checksum are what they were.
import { UnitDefinition } from '../definitions/units.js';
import { Blight } from './blight.js';
import { CampaignMission } from './campaign-mission.js';
import { LaunchRules } from './launch-rules.js';
import { StickyCling } from './capabilities/sticky-cling.js';

export class CampaignPractice {
    // The stage's declared practice, checked, or null.
    static declared(sim) {
        const practice = sim.rules.campaign?.practice;
        if (practice === undefined) return null;
        const { card, cue, building, built, forwardCannon, clamp } = practice ?? {};
        const targets = practice.targets ?? [];
        const campaign = sim.rules.campaign;
        if (campaign.introducedEnemy || campaign.mission?.formations || campaign.volleyGoals)
            throw new Error(
                '익히기는 경기 시작부터 서 있는 적 병사(introducedEnemy·mission.formations·volleyGoals)와 함께 둘 수 없습니다.',
            );
        if (!sim.decks[1 - Blight.ENEMY_SIDE].includes(card))
            throw new Error(`익히기 카드는 플레이어 덱(deck)에 있어야 합니다: ${card}`);
        if (typeof cue !== 'string' || !cue)
            throw new Error('익히기 선언에는 전투 화면에 띄울 안내 한 줄(cue)이 필요합니다.');
        if (built !== undefined) {
            CampaignMission.point(sim, built);
            if (
                campaign.enemyOutposts?.includes(built) ||
                campaign.friendlyOutposts?.includes(built)
            )
                throw new Error(`익히기로 지을 점령 지점(built)은 비어 있어야 합니다: ${built}`);
        }
        if (clamp !== undefined && !campaign.enemyOutposts?.includes(clamp))
            throw new Error(
                `익히기 포구 막기(clamp)는 적 거점(enemyOutposts)이어야 합니다: ${clamp}`,
            );
        if (forwardCannon !== undefined && forwardCannon !== true)
            throw new Error('익히기 forwardCannon은 true만 쓸 수 있습니다.');
        if (
            !Array.isArray(targets) ||
            (!targets.length &&
                building === undefined &&
                built === undefined &&
                clamp === undefined &&
                forwardCannon === undefined)
        )
            throw new Error(
                '익히기 선언에는 비어 있지 않은 targets 목록이나 building이 필요합니다.',
            );
        if (building !== undefined && !campaign.enemyOutposts?.includes(building))
            throw new Error(
                `익히기 거점(building)은 적 거점(enemyOutposts)이어야 합니다: ${building}`,
            );
        for (const formation of targets) {
            const { type, x, y, count, side, hold } = formation ?? {};
            if (
                !UnitDefinition.get(type) ||
                LaunchRules.isHeroType(type) ||
                !Number.isSafeInteger(count) ||
                count < 1 ||
                side !== undefined ||
                hold !== undefined
            )
                throw new Error(`익히기 표적으로 둘 수 없는 병사 선언입니다: ${type} × ${count}`);
            if (
                !Number.isFinite(x) ||
                !Number.isFinite(y) ||
                x < 0 ||
                y < 0 ||
                x > sim.world.width ||
                y > sim.world.height
            )
                throw new Error('익히기 표적의 targets에는 맵 안의 x, y가 필요합니다.');
        }
        return practice;
    }

    // Match start (StrategySim constructor): the targets stand, seen through the fog, and the practice runs.
    static initialize(sim) {
        const practice = this.declared(sim);
        if (!practice) return;
        sim.campaignPractice = {
            doneTick: null,
            ...(practice.forwardCannon && { cannon: false }),
            ...(practice.clamp !== undefined && { clamped: false }),
        };
        const ids = new Set(CampaignMission.spawnFormations(sim, practice.targets ?? []));
        for (const unit of sim.units) {
            if (!ids.has(unit.id)) continue;
            unit.practiceTarget = true;
            unit.status.terrainRevealUntil0 = Number.MAX_SAFE_INTEGER;
        }
    }

    // Does this unit stand still as a practice target? (StrategySim.stepSimulation: it takes no turn.)
    static target(unit) {
        return unit.practiceTarget === true;
    }

    // Is a practice running now? (Never in a match without one.)
    static running(sim) {
        return !!sim.campaignPractice && sim.campaignPractice.doneTick === null;
    }

    // The goals beside the targets that still have not held (see the top): the player's outpost not complete yet, the
    // forward cannon not up, the muzzle not held. Latches `cannon` and `clamped` once they hold.
    static goalsLeft(sim, latch = false) {
        const practice = sim.rules.campaign.practice,
            state = sim.campaignPractice;
        let left = 0;
        if (practice.built !== undefined) {
            const point = CampaignMission.point(sim, practice.built),
                outpost = sim.buildings.find((candidate) => candidate.id === point.outpostId);
            if (!(point.owner === 0 && outpost && outpost.alive !== false && !outpost.construction))
                left++;
        }
        if (state.cannon === false) {
            const stands = sim.buildings.some(
                (b) => b.type === 'forward-cannon' && b.side === 0 && b.alive !== false,
            );
            if (stands && latch) state.cannon = true;
            else if (!stands) left++;
        }
        if (state.clamped === false) {
            const point = CampaignMission.point(sim, practice.clamp),
                outpost = sim.buildings.find((candidate) => candidate.id === point.outpostId);
            if (outpost && StickyCling.clingerOf(sim, outpost)) {
                if (latch) state.clamped = true;
            } else left++;
        }
        return left;
    }

    // The enemy outpost the practice asks to bring down, or null (alive or not).
    static building(sim) {
        const id = sim.rules.campaign?.practice?.building;
        if (id === undefined) return null;
        const outpostId = CampaignMission.point(sim, id).outpostId;
        return sim.buildings.find((candidate) => candidate.id === outpostId) ?? null;
    }

    // Does this building take no damage now? The enemy's buildings, while the practice runs (StrategySim.applyDamage),
    // but for the outpost the practice asks to bring down.
    static shields(sim, building) {
        return (
            building.side === Blight.ENEMY_SIDE &&
            this.running(sim) &&
            building !== this.building(sim)
        );
    }

    // The match's winner with the practice counted (StrategySim.stepSimulation, last): no win while it runs. A read.
    static resolve(sim, winner) {
        return winner === 'host' && this.running(sim) ? null : winner;
    }

    // One tick (StrategySim.stepSimulation, before the match's winner): the tick no target is left alive ends the
    // practice and starts the mission's clock. Returns true on that tick only (the mission starts: BlightBoss.start).
    static update(sim) {
        const state = sim.campaignPractice;
        if (!state || state.doneTick !== null) return false;
        // Latched first: a goal that holds for a moment (a cannon that stands, a held muzzle) must not be missed.
        const goalsLeft = this.goalsLeft(sim, true);
        for (const unit of sim.units) if (unit.alive && unit.practiceTarget) return false;
        const outpost = this.building(sim);
        if (outpost && outpost.alive !== false) return false;
        if (goalsLeft) return false;
        state.doneTick = sim.tick;
        return true;
    }

    // What the battle screen and the enemy AI read (StrategySim.snapshot): the tick it ended (null while it runs)
    // and the targets still standing. Undefined without a practice.
    static view(sim) {
        const state = sim.campaignPractice;
        if (!state) return undefined;
        let left = 0;
        for (const unit of sim.units) if (unit.alive && unit.practiceTarget) left++;
        const outpost = this.building(sim);
        if (outpost && outpost.alive !== false) left++;
        if (state.doneTick === null) left += this.goalsLeft(sim);
        return { doneTick: state.doneTick, left };
    }
}
