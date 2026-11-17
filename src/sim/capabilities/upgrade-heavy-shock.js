// Campaign upgrade `heavyShock { damageScale, radiusScale }` (검은콩 · 묵직한 착탄):
// - 강화가 켜진 편의 그 카드 포탄(처음 쏜 묶음, 병사가 대포를 타고 혼자 다시 날아간 포탄 모두)이 내는 착탄 충격
//   (StrategySim.landingShock)의 범위 피해가 `damageScale`배이고 피해 반경이 `radiusScale`배다. 병력·건물 모두 같다.
// - 넉백(LaunchImpact.blast)은 그대로다: 미는 범위와 세기는 늘지 않아 표적이 더 흩어지지 않는다.
// - 상태를 두지 않는다. 착탄 이벤트(`launchImpact`)의 `radius`가 늘어난 피해 반경이고 `heavy`가 붙는다(표시 전용).
import { CampaignUpgrades } from '../campaign-upgrades.js';

export class UpgradeHeavyShock {
    // The spec for this shell's landing shock when the upgrade is on for its side, else null.
    static spec(sim, p) {
        return p.payload
            ? CampaignUpgrades.effect(sim, p.side, p.payload.type, 'heavyShock')
            : null;
    }
}
