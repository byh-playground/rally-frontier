// Campaign upgrade `contactShove { hits, knockback }` (조 · 돌파):
// - 강화가 켜진 편의 병사는 생성될 때 `hits`번의 밀치기를 가진다(`unit.campaignUpgrade.charges`).
// - 접촉 근접(ContactMelee)의 유효타가 적 병사에 들어가는 순간, 그 적을 돌진해 온 방향으로 공용 넉백
//   (Knockback.hit: 자기 질량, KnockbackRules.swingSpeed, `knockback` 이름의 배수)으로 던지고 하나를 쓴다.
//   건물 타격은 쓰지 않는다. 던진 순간 `upgradeContactShove` 이벤트를 낸다(표시 전용).
import { KnockbackRules } from '../../definitions/knockback-rules.js';
import { CampaignUpgrades } from '../campaign-upgrades.js';
import { Knockback } from '../knockback.js';

export class UpgradeContactShove {
    // `unit` just struck the enemy soldier `target` after charging along (dx, dy).
    static onContactHit(sim, unit, target, dx, dy) {
        const state = unit.campaignUpgrade;
        if (!state || state.charges <= 0) return;
        const spec = CampaignUpgrades.effect(sim, unit.side, unit.type, 'contactShove');
        if (!spec) return;
        state.charges--;
        Knockback.hit(sim, target, {
            dx,
            dy,
            mass: sim.mass(unit),
            speed: KnockbackRules.swingSpeed,
            gain: KnockbackRules.gain[spec.knockback],
            sourceId: unit.id,
            originX: unit.x,
            originY: unit.y,
        });
        sim.events.push({
            type: 'upgradeContactShove',
            side: unit.side,
            sourceId: unit.id,
            targetId: target.id,
            x: target.x,
            y: target.y,
        });
    }
}
