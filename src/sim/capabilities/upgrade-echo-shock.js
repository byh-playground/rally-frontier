// Campaign upgrade `echoShock { delayMs, ratio }` (콩 · 두 번째 충격파):
// - 강화가 켜진 편의 병력 포탄이 착탄 충격을 낸 자리에 `delayMs` 뒤 같은 충격(StrategySim.landingShock: 넉백,
//   병력·건물 범위 피해, 중심 강타)이 `ratio` 세기로 한 번 더 난다. 포탄은 이미 사라졌으므로 충격에 필요한 값만
//   `sim.upgradeEchoShocks`에 적어 둔다(저장·복원·해시에 포함, 강화가 켜진 경기에서 처음 쓸 때 생긴다).
// - 두 번째 충격은 `upgradeEchoShock` 이벤트를 낸다(표시 전용). 다시 울리지는 않는다.
import { CampaignUpgrades } from '../campaign-upgrades.js';

export class UpgradeEchoShock {
    // The shell `p` just landed its shock of `radius` at (x, y).
    static queue(sim, p, x, y, radius, impactHeightFP) {
        const spec = p.payload && CampaignUpgrades.effect(sim, p.side, p.payload.type, 'echoShock');
        if (!spec) return;
        (sim.upgradeEchoShocks ||= []).push({
            dueTick: sim.tick + sim.time.ceilTicks(spec.delayMs),
            x,
            y,
            radius,
            impactHeightFP,
            ratio: spec.ratio,
            // What a landing shock reads of its shell.
            shell: {
                id: p.id,
                owner: p.owner,
                side: p.side,
                type: p.type,
                damage: p.damage,
                splashUnitDamage: p.splashUnitDamage,
                splashBuildingDamage: p.splashBuildingDamage,
                damageClass: p.damageClass,
                payload: { type: p.payload.type, count: p.payload.count },
            },
        });
    }
    // Lands every shock that is due. They wait in landing order and share one delay, so the due ones are in front.
    // That holds while every echoShock card has the same delayMs (pea alone now): a second delay needs the queue
    // read by dueTick first.
    static update(sim) {
        const shocks = sim.upgradeEchoShocks;
        while (shocks?.length && shocks[0].dueTick <= sim.tick) {
            const { x, y, radius, impactHeightFP, ratio, shell } = shocks.shift();
            const blast = sim.landingShock(shell, x, y, radius, impactHeightFP, ratio);
            sim.events.push({
                type: 'upgradeEchoShock',
                side: shell.side,
                unit: shell.type,
                x,
                y,
                radius: blast.radius,
                impactProfile: blast.impactProfile,
                hits: blast.hits,
                peak: Math.round(blast.peak * 100) / 100,
                projectileId: shell.id,
                impactHeightFP,
            });
        }
    }
}
