// Campaign upgrade `doubleShot { gapMs }` (메밀 · 두 발 연사):
// - 강화가 켜진 편의 병사는 가시(thornAttack)를 던질 때마다 `gapMs` 뒤 같은 표적에게 한 발을 더 던진다. 더 던지는
//   발은 그때 표적이 있는 곳을 다시 겨누고 피해가 같다. 공격 간격(attackIntervalMs·cooldownMs)은 그대로라 두 발을
//   이어 던지고 쉰다. 그때 표적이 죽었거나 병사가 땅에 서 있지 않으면 그 발은 나가지 않는다.
// - 병사는 `unit.campaignUpgrade { followTick, followId, followBuilding }`를 가진다(병사가 생길 때 0·null·false,
//   followTick 0은 대기 중인 발이 없다는 뜻). 더 던진 가시는 `shot.follow`를 가지고 `unitThornLaunch` 이벤트도
//   `follow`를 가진다(표시 전용).
import { CampaignUpgrades } from '../campaign-upgrades.js';
import { UnitThornAttack } from './unit-thorn-attack.js';

// The second thorn's id is told apart from a thorn the soldier may throw in the same tick.
const FOLLOW_SHOT = Object.freeze({ index: 1 });

export class UpgradeDoubleShot {
    // `unit` just threw a thorn at `target`: the second one is due `gapMs` later.
    static arm(sim, unit, target, isBuilding) {
        const state = unit.campaignUpgrade;
        if (!state) return;
        const spec = CampaignUpgrades.effect(sim, unit.side, unit.type, 'doubleShot');
        if (!spec) return;
        state.followTick = sim.tick + sim.time.ceilTicks(spec.gapMs);
        state.followId = target.id;
        state.followBuilding = !!isBuilding;
    }
    // A standing soldier's turn: throws the second thorn on the tick it is due (`d` is its Unit Definition).
    static update(sim, unit, d) {
        const state = unit.campaignUpgrade;
        if (!state?.followTick || sim.tick < state.followTick) return;
        const due = sim.tick === state.followTick,
            building = state.followBuilding,
            target = building
                ? sim.buildingById.get(state.followId)
                : sim.unitById.get(state.followId);
        state.followTick = 0;
        state.followId = null;
        state.followBuilding = false;
        if (!due || !target || target.alive === false || !(target.hp > 0)) return;
        if (target.side === unit.side) return;
        UnitThornAttack.launch(
            sim,
            unit,
            target,
            building,
            { ...d.thornAttack, damage: Math.floor(d.atk) },
            FOLLOW_SHOT,
        ).follow = true;
    }
}
