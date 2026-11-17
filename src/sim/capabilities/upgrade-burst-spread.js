// Campaign upgrade `burstSpread { spacing }` (도토리 · 분산 포격):
// - 강화가 켜진 편의 연사(payload.fire.mode 'burst')는 포탄들이 한 점이 아니라 조준점을 가운데로 발사 방향의 좌우 한 줄에
//   `spacing` 간격으로 떨어진다(첫 발이 왼쪽 끝, 마지막 발이 오른쪽 끝). 발마다 싣는 인원·위력·범위와 발사 간격은 그대로다.
// - 착탄점은 맵 가장자리 안쪽으로 맞춘다(갈라지는 포탄 LaunchRules.volley 'split'과 같은 여백).
import { RangeUtil } from '../../core/game-rules.js';
import { CampaignUpgrades } from '../campaign-upgrades.js';

const EDGE = 40;

export class UpgradeBurstSpread {
    // `volley` is the launch's cannon groups (LaunchRules.sharedVolley), every shot still on the aim point.
    static apply(sim, side, type, volley, aim) {
        const spec = CampaignUpgrades.effect(sim, side, type, 'burstSpread');
        if (!spec) return;
        const { width, height } = sim.world;
        for (const { cannon, shots } of volley) {
            const dx = aim.x - cannon.x,
                dy = aim.y - cannon.y,
                length = Math.hypot(dx, dy) || 1,
                middle = (shots.length - 1) / 2;
            for (let i = 0; i < shots.length; i++) {
                const across = (i - middle) * spec.spacing;
                shots[i].x = RangeUtil.clamp(
                    Math.round(aim.x - (dy / length) * across),
                    EDGE,
                    width - EDGE,
                );
                shots[i].y = RangeUtil.clamp(
                    Math.round(aim.y + (dx / length) * across),
                    EDGE,
                    height - EDGE,
                );
            }
        }
    }
}
