// Campaign upgrade `heavyThorn { every, radiusScale, damageScale }` (밤톨 · 굵은 가시):
// - 강화가 켜진 편의 병사는 던진 가시를 센다(`unit.campaignUpgrade.attacks`, 병사가 생길 때 0). `every`번째 가시마다
//   굵은 가시가 나간다: 몸 반경이 `radiusScale`배이고(`shot.heavy`가 그 배수, 그림도 그만큼 크다) 피해가
//   `damageScale`배다(내림). 맞은 가시의 `unitThornHit` 이벤트는 `heavy`를 가진다(표시 전용).
import { CampaignUpgrades } from '../campaign-upgrades.js';

export class UpgradeHeavyThorn {
    // The thorn `unit` just threw: counted, and every `every`th one made heavy.
    static arm(sim, unit, shot) {
        const state = unit.campaignUpgrade;
        if (!state) return;
        const spec = CampaignUpgrades.effect(sim, unit.side, unit.type, 'heavyThorn');
        if (!spec || ++state.attacks < spec.every) return;
        state.attacks = 0;
        shot.radius *= spec.radiusScale;
        shot.damage = Math.floor(shot.damage * spec.damageScale);
        shot.heavy = spec.radiusScale;
    }
}
