// Campaign upgrade `chainCharge { approachSpeedScale }` (땅콩 · 연쇄 돌진):
// - 강화가 켜진 편의 접촉 근접(ContactMelee) 병사의 유효타로 건물이 부서지면, 그 건물을 노리던 같은 강화의 병사가 모두
//   이어 달린다(`unit.campaignUpgrade.chaining`, 이때 처음 생긴다): 공격 대기와 타격 뒤 이동 대기가 바로 풀리고,
//   다음 유효타까지 표적으로 다가가는 걸음이 `approachSpeedScale`배이며, 돌진 거리에 들면 선딜 없이 바로 돌진한다.
//   부순 병사는 반동(contactRebound)으로 튀지 않는다. 먼저 들이받고 튀어 있던 병사는 착지한 뒤 이어 달린다.
// - 다음 유효타가 들어가면 끝난다(그 타격으로 또 부수면 다시 시작한다). 시작할 때 `upgradeChainCharge` 이벤트를 낸다(표시 전용).
import { CampaignUpgrades } from '../campaign-upgrades.js';

export class UpgradeChainCharge {
    // The upgrade's spec for a hit `unit` lands on a building now, or null.
    static spec(sim, unit, isBuilding) {
        return isBuilding
            ? CampaignUpgrades.effect(sim, unit.side, unit.type, 'chainCharge')
            : null;
    }
    // A contact hit landed: a running chain ends with it.
    static land(unit) {
        if (unit.campaignUpgrade?.chaining) unit.campaignUpgrade.chaining = false;
    }
    // The hit of `striker` destroyed `building`: every soldier of the upgrade that was after it charges on.
    static begin(sim, striker, building) {
        let count = 0;
        for (let i = 0; i < sim.units.length; i++) {
            const u = sim.units[i];
            if (
                !u.alive ||
                u.side !== striker.side ||
                u.target !== building.id ||
                !CampaignUpgrades.effect(sim, u.side, u.type, 'chainCharge')
            )
                continue;
            (u.campaignUpgrade ||= {}).chaining = true;
            u.combat.cooldownUntil = sim.tick;
            u.combat.moveRecoveryUntil = sim.tick;
            count++;
        }
        sim.events.push({
            type: 'upgradeChainCharge',
            side: striker.side,
            sourceId: striker.id,
            x: striker.x,
            y: striker.y,
            count,
        });
    }
    // The walking speed share of a soldier on its way to a target: `approachSpeedScale` while it chains, else 1.
    static approachScale(sim, unit) {
        return unit.campaignUpgrade?.chaining
            ? (CampaignUpgrades.effect(sim, unit.side, unit.type, 'chainCharge')
                  ?.approachSpeedScale ?? 1)
            : 1;
    }
    // A chaining soldier whose wind-up just started is already charging: the wind-up is over at once.
    static skipWindup(sim, unit) {
        if (unit.campaignUpgrade?.chaining) unit.combat.attackWindupUntil = sim.tick;
    }
}
