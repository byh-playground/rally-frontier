// Campaign upgrade `firstHitBlock { hits }` (쌀 · 왕겨 갑옷):
// - 강화가 켜진 편의 병사는 생성될 때 `hits`번의 막기를 가진다(`unit.campaignUpgrade.charges`).
// - 적의 피해가 실제로 들어가려는 순간(StrategySim.applyDamage: 공중·고지대 빗나감·아군 판정을 지난 뒤) 한 번을
//   통째로 막고 하나를 쓴다. 피해 종류를 가리지 않으므로 지속 피해의 한 틱도 한 번이다. 넉백은 막지 않는다.
// - `whileFlying`(민들레씨 · 솜털막)이면 나는 동안(UnitFlight.airborne)에만 막는다: 나는 동안 맞는 것은 대공 공격뿐이라
//   대공 한 발을 막는 셈이다. 내려앉은 뒤에는 남은 막기가 있어도 쓰지 않는다.
// - 막은 순간 `upgradeHitBlock` 이벤트를 낸다(표시 전용, 나는 동안이면 몸 높이 `heightFP`와 `flying`).
import { FP } from '../../core/config.js';
import { CampaignUpgrades } from '../campaign-upgrades.js';
import { UnitMotion } from '../navigation.js';
import { UnitFlight } from './unit-flight.js';

export class UpgradeHitBlock {
    // True when the soldier's upgrade swallowed this hit.
    static absorb(sim, target) {
        const state = target.campaignUpgrade;
        if (!state || state.charges <= 0) return false;
        const spec = CampaignUpgrades.effect(sim, target.side, target.type, 'firstHitBlock');
        if (!spec || (spec.whileFlying && !UnitFlight.airborne(target))) return false;
        state.charges--;
        const event = {
            type: 'upgradeHitBlock',
            side: target.side,
            x: target.x,
            y: target.y,
            targetId: target.id,
        };
        if (spec.whileFlying) {
            event.flying = true;
            event.heightFP =
                UnitMotion.bottomFP(sim, target) + Math.round(sim.unitRadius(target) * FP);
        }
        sim.events.push(event);
        return true;
    }
}
