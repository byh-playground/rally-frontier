// The practice step (익히기 단계) of a stage where a new card joins: the player first tries the card on targets that
// stand still, and the stage's mission begins only when they are all down. A stage declares it (campaign.js):
//     practice: { card: 'pea', cue: '콩을 쏴서 허수아비를 쓰러뜨려요',
//                 targets: [{ type: 'rice', x: 1300, y: 2500, count: 6, columns: 3 }] }
// The targets are ordinary enemy soldiers (wave formations without `side` and `hold`, never a hero), blighted on a
// blighted stage as every enemy is (Blight.mark), standing from the first tick and seen through the fog. A target takes
// no turn (StrategySim.stepSimulation: no move, no target, no attack), the way a spore sac's captive takes none, but it
// stays an ordinary enemy: anything can target it, hit it, push it and kill it. `card` must be a card of the player's
// deck; `cue` is the battle screen's one line while the practice runs.
// While the practice runs the mission's clock stands at 0 (CampaignMission.clock): no defence wave, spore cloud, blight
// field growth or survival countdown advances, and the enemy AI makes no decision (BotController). The match's own
// ticks run on as always (the economy, ammunition, the field's harm), so the simulation stays one deterministic run.
// The tick the last target is down ends it: the mission's clock counts from that tick, so every timing the stage
// declares in ms runs as it would from a match start.
// `sim.campaignPractice { doneTick }` (null while it runs) is the only state and `unit.practiceTarget` marks a target.
// Both exist only in a stage that declares a practice, so every other match's state and checksum are what they were.
import { UnitDefinition } from '../definitions/units.js';
import { Blight } from './blight.js';
import { CampaignMission } from './campaign-mission.js';
import { LaunchRules } from './launch-rules.js';

export class CampaignPractice {
    // The stage's declared practice, checked, or null.
    static declared(sim) {
        const practice = sim.rules.campaign?.practice;
        if (practice === undefined) return null;
        const { card, cue, targets } = practice ?? {};
        if (!sim.decks[1 - Blight.ENEMY_SIDE].includes(card))
            throw new Error(`익히기 카드는 플레이어 덱(deck)에 있어야 합니다: ${card}`);
        if (typeof cue !== 'string' || !cue)
            throw new Error('익히기 선언에는 전투 화면에 띄울 안내 한 줄(cue)이 필요합니다.');
        if (!Array.isArray(targets) || !targets.length)
            throw new Error('익히기 선언에는 비어 있지 않은 targets 목록이 필요합니다.');
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
        sim.campaignPractice = { doneTick: null };
        const ids = new Set(CampaignMission.spawnFormations(sim, practice.targets));
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

    // One tick (StrategySim.stepSimulation, before the match's winner): the tick no target is left alive ends the
    // practice and starts the mission's clock.
    static update(sim) {
        const state = sim.campaignPractice;
        if (!state || state.doneTick !== null) return;
        for (const unit of sim.units) if (unit.alive && unit.practiceTarget) return;
        state.doneTick = sim.tick;
    }

    // What the battle screen and the enemy AI read (StrategySim.snapshot): the tick it ended (null while it runs)
    // and the targets still standing. Undefined without a practice.
    static view(sim) {
        const state = sim.campaignPractice;
        if (!state) return undefined;
        let left = 0;
        for (const unit of sim.units) if (unit.alive && unit.practiceTarget) left++;
        return { doneTick: state.doneTick, left };
    }
}
