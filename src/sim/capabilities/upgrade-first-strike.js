// Campaign upgrade `firstStrike { hits, damageScale }` (조 · 첫 일격):
// - 강화가 켜진 편의 병사는 생성될 때 `hits`번의 강한 일격을 가진다(`unit.campaignUpgrade.charges`).
// - 접촉 근접(ContactMelee)의 유효타가 들어가는 순간 그 한 번의 피해가 `damageScale`배가 되고 하나를 쓴다.
//   따로 더하는 피해가 아니라 같은 한 번의 피격이다(쌀 왕겨 갑옷의 '피격 한 번'과 같은 단위). 병사·건물을 가리지 않는다.
// - 쓴 순간 `upgradeFirstStrike` 이벤트를 낸다(표시 전용).
import { CampaignUpgrades } from '../campaign-upgrades.js';

export class UpgradeFirstStrike {
    // The damage share of the hit `unit` lands on `target` now: `damageScale` while a strike is left (using one), else 1.
    static damageScale(sim, unit, target) {
        const state = unit.campaignUpgrade;
        if (!state || state.charges <= 0) return 1;
        const spec = CampaignUpgrades.effect(sim, unit.side, unit.type, 'firstStrike');
        if (!spec) return 1;
        state.charges--;
        sim.events.push({
            type: 'upgradeFirstStrike',
            side: unit.side,
            sourceId: unit.id,
            targetId: target.id,
            x: target.x,
            y: target.y,
        });
        return spec.damageScale;
    }
}
