// Campaign upgrade `extraShot { shots, soldiers }` (도토리 · 네 번째 포탄):
// - 강화가 켜진 편의 연사(payload.fire.mode 'burst')는 원래 포탄들을 그대로 쏜 뒤 같은 조준점에 `shots`발을 더 쏜다.
//   더 쏘는 발은 마지막 발과 위력·범위가 같고 발 사이 간격도 `fire.gapMs` 그대로다. 원래 포탄의 인원은 다시 나누지 않고
//   `soldiers`명이 더 나온다(더 쏘는 발에 고르게, 남는 인원은 앞 발부터).
// - 여러 대포가 함께 쏜 발사에서는 더 나오는 인원을 대포에 고르게 나누고(남는 인원은 앞 대포부터), 몫이 없는 발은
//   쏘지 않는다. 대포는 더 쏘는 발까지 나간 뒤에 재장전한다(`ms`).
import { CampaignUpgrades } from '../campaign-upgrades.js';
import { LaunchRules } from '../launch-rules.js';

export class UpgradeExtraShot {
    // `volley` is the launch's cannon groups (LaunchRules.sharedVolley); the extra shells are added to each.
    static apply(sim, side, type, volley) {
        const spec = CampaignUpgrades.effect(sim, side, type, 'extraShot');
        if (!spec) return;
        const gapMs = LaunchRules.grain(type).fire.gapMs;
        for (let g = 0; g < volley.length; g++) {
            const shots = volley[g].shots,
                last = shots[shots.length - 1],
                // This cannon's share of the extra soldiers, then each extra shell's share of that.
                soldiers =
                    Math.floor(spec.soldiers / volley.length) +
                    (g < spec.soldiers % volley.length ? 1 : 0);
            for (let k = 0; k < spec.shots; k++) {
                const count =
                    Math.floor(soldiers / spec.shots) + (k < soldiers % spec.shots ? 1 : 0);
                if (count > 0)
                    shots.push({ ...last, delayMs: last.delayMs + (k + 1) * gapMs, count });
            }
        }
    }
    // How much longer the volley keeps its cannons busy.
    static ms(sim, side, type) {
        const spec = CampaignUpgrades.effect(sim, side, type, 'extraShot');
        return spec ? spec.shots * LaunchRules.grain(type).fire.gapMs : 0;
    }
}
