// Campaign upgrade `extraSoldiers { soldiers }` (참깨 · 일손 늘리기):
// - 강화가 켜진 편의 한 번 발사는 `soldiers`명을 더 싣는다. 원래 포탄의 인원은 다시 나누지 않고 더 타는 인원만
//   발사에 참여한 포탄에 고르게 나눈다(남는 인원은 앞 대포·앞 발부터). 비용·포탄 수·재장전은 그대로다.
import { CampaignUpgrades } from '../campaign-upgrades.js';

export class UpgradeExtraSoldiers {
    // `volley` is the launch's cannon groups (LaunchRules.sharedVolley); the extra soldiers board its shells.
    static apply(sim, side, type, volley) {
        const spec = CampaignUpgrades.effect(sim, side, type, 'extraSoldiers');
        if (!spec) return;
        let shells = 0;
        for (let g = 0; g < volley.length; g++) shells += volley[g].shots.length;
        const each = Math.floor(spec.soldiers / shells);
        let rest = spec.soldiers % shells;
        for (let g = 0; g < volley.length; g++)
            for (const shot of volley[g].shots) shot.count += each + (rest-- > 0 ? 1 : 0);
    }
}
