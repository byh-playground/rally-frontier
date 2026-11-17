// Campaign upgrade `echoBurst { delayMs, damageRatio }` (팝콘 · 잔여 알):
// - 강화가 켜진 편의 자폭(Unit Definition selfDestruct)이 터진 자리에 `delayMs` 뒤 같은 반경의 폭발이 한 번 더 난다.
//   피해는 `damageRatio`배(내림)이고 넉백은 없다(첫 폭발이 밀어낸 적을 더 밀지 않는다). 병력·건물 모두 맞는다.
//   터진 몸은 이미 사라졌으므로 폭발에 필요한 값만 `sim.upgradeEchoBursts`에 적어 둔다(저장·복원·해시에 포함,
//   강화가 켜진 경기에서 처음 쓸 때 생긴다). 다시 울리지는 않는다.
// - 두 번째 폭발도 `unitSelfDestruct` 이벤트를 내며 `echo: true`를 가진다(표시 전용).
import { CampaignUpgrades } from '../campaign-upgrades.js';

export class UpgradeEchoBurst {
    // The burst of `sourceType` on `side` just went off at (x, y).
    static queue(sim, side, sourceId, sourceType, x, y, heightFP) {
        const spec = CampaignUpgrades.effect(sim, side, sourceType, 'echoBurst');
        if (!spec) return;
        const bursts = (sim.upgradeEchoBursts ||= []),
            dueTick = sim.tick + sim.time.ceilTicks(spec.delayMs);
        // Kept in dueTick order (ties in burst order), whatever each card's delay is.
        let at = bursts.length;
        while (at > 0 && bursts[at - 1].dueTick > dueTick) at--;
        bursts.splice(at, 0, {
            dueTick,
            side,
            sourceId,
            sourceType,
            x,
            y,
            heightFP,
            damageRatio: spec.damageRatio,
        });
    }
    // The next burst that is due, taken off the queue, or null.
    static takeDue(sim) {
        const bursts = sim.upgradeEchoBursts;
        return bursts?.length && bursts[0].dueTick <= sim.tick ? bursts.shift() : null;
    }
}
