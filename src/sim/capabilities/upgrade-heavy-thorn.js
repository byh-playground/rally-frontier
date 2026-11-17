// Campaign upgrade `heavyThorn { every, radiusScale, knockbackSpeed }` (밤톨 · 굵은 가시):
// - 강화가 켜진 편의 병사는 던진 가시를 센다(`unit.campaignUpgrade.attacks`, 병사가 생길 때 0). `every`번째 가시마다
//   굵은 가시가 나간다: 몸 반경이 `radiusScale`배이고(`shot.heavy`가 그 배수, 그림도 그만큼 크다) 피해는 보통 가시와 같다.
// - 굵은 가시가 맞으면 땅에 선 그 적 병사 하나를 가시가 날아온 방향으로 민다(공용 넉백 Knockback.hit: 던진 병사의
//   질량이 `knockbackSpeed`로 친 것, 기본 공격 배수). 건물과 공중의 적은 밀지 않는다. 맞은 가시의 `unitThornHit`
//   이벤트는 `heavy`를 가진다(표시 전용).
import { KnockbackRules } from '../../definitions/knockback-rules.js';
import { FP } from '../../core/config.js';
import { CampaignUpgrades } from '../campaign-upgrades.js';
import { Knockback } from '../knockback.js';
import { UnitMotion } from '../navigation.js';

// The thrower as the body that hits (StrategySim.mass reads the type).
const THROWER = { type: '' };

export class UpgradeHeavyThorn {
    // The thorn `unit` just threw: counted, and every `every`th one made heavy.
    static arm(sim, unit, shot) {
        const state = unit.campaignUpgrade;
        if (!state) return;
        const spec = CampaignUpgrades.effect(sim, unit.side, unit.type, 'heavyThorn');
        if (!spec || ++state.attacks < spec.every) return;
        state.attacks = 0;
        shot.radius *= spec.radiusScale;
        shot.heavy = spec.radiusScale;
    }
    // A heavy thorn reached its target: a grounded soldier is shoved along the thorn's flight.
    static strike(sim, shot, target) {
        if (shot.targetIsBuilding || !UnitMotion.isGrounded(target)) return;
        const spec = CampaignUpgrades.effect(sim, shot.side, shot.sourceType, 'heavyThorn');
        if (!spec) return;
        THROWER.type = shot.sourceType;
        Knockback.hit(sim, target, {
            dx: shot.toFx - shot.fromFx,
            dy: shot.toFy - shot.fromFy,
            mass: sim.mass(THROWER),
            speed: spec.knockbackSpeed,
            gain: KnockbackRules.gain.basic,
            sourceId: shot.sourceId,
            originX: shot.fromFx / FP,
            originY: shot.fromFy / FP,
        });
    }
}
