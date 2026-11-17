// Campaign upgrade `shellShards { takenRatio, radius, damage }` (호두 · 껍질 파편):
// - 강화가 켜진 편의 병사는 실제로 받은 피해를 쌓는다(`unit.campaignUpgrade.taken`, 병사가 생길 때 0). 최대 체력의
//   `takenRatio`만큼 쌓일 때마다 그만큼을 덜고 껍질 파편이 튄다: 몸 둘레 `radius` 안(몸 표면에서 잰 거리)의 땅 위 적
//   병사 모두에게 `damage`의 범위 피해(StrategySim.applyAreaDamage, 그 병종의 평타와 같은 피해 종류, 넉백 없음).
//   쓰러지는 피해로 찬 몫도 튄다.
// - 튈 때 `upgradeShellShards` 이벤트를 낸다(표시 전용).
import { UnitDefinition } from '../../definitions/units.js';
import { CampaignUpgrades } from '../campaign-upgrades.js';

export class UpgradeShellShards {
    // `unit` just lost `dealt` health (StrategySim.applyDamage).
    static onDamaged(sim, unit, dealt) {
        const state = unit.campaignUpgrade;
        if (!state || !(dealt > 0)) return;
        const spec = CampaignUpgrades.effect(sim, unit.side, unit.type, 'shellShards');
        if (!spec) return;
        const step = UnitDefinition.get(unit.type).hp * spec.takenRatio;
        state.taken += dealt;
        while (state.taken >= step) {
            state.taken -= step;
            const radius = sim.unitRadius(unit) + spec.radius,
                blast = sim.applyAreaDamage({
                    sourceSide: unit.side,
                    sourceType: unit.type,
                    sourceEntityId: unit.id,
                    x: unit.x,
                    y: unit.y,
                    radius,
                    damage: spec.damage,
                    damageClass: UnitDefinition.damageClass(unit.type),
                    suppressImpactFx: true,
                });
            sim.events.push({
                type: 'upgradeShellShards',
                side: unit.side,
                sourceId: unit.id,
                x: unit.x,
                y: unit.y,
                radius,
                hits: blast.hits,
            });
        }
    }
}
