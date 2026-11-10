// Contract (moved from the index.html Development Contract):
// - 감자(Unit Definition growsCannon)는 대포 하나당 한 알을 싣는 단발 투입탄이다(일제사격도 참여 대포마다
//   한 알, 비용은 한 번). 병사가 생기는 틱에 Unit.cannonTick(전진 대포가 서는 틱)만 정하고, 그때까지 이동·공격하지
//   않으며 피격될 수 있다. 그 전에 쓰러지면 아무것도 남지 않는다. 공중에 떠 있으면 착지한 뒤에 선다.
//   파기·뿌리 단계는 cannonTick에서 계산하는 연출일 뿐 권위 상태가 아니다(ForwardCannon.stage).
// - 전진 대포는 Building Definition 'forward-cannon'의 일반 건물이다. 거점 대포와 같은 발사 규칙(재장전·비용·연쇄)을
//   쓰고 포탑·생산·점령·수입·승패 판정이 없다. 선 틱(Building.decayStartTick)부터 정수 단위로 체력이 줄어
//   0이 되면 파괴되며 적 피해도 받는다. 찹쌀은 붙지 않는다. 영웅은 발사 대포인 전진 대포로도 회수된다.
//   봇은 다른 표적이 없을 때 사거리 안에서 적 본진 쪽 가장 먼 지점으로 감자를 쏜다.
// A potato roots where it landed and stands up as a forward cannon (Unit Definition growsCannon).
// Unit.cannonTick, set when the soldier spawns, is the only rooting state: the tick the cannon appears.
// Until then the soldier neither moves nor attacks and can be hit; a soldier that dies first leaves nothing.
// The cannon is an ordinary launch building whose health drains from the moment it stands
// (Building Definition decay); Building.decayStartTick is that moment.
import { BuildingDefinition } from '../../definitions/buildings.js';
import { UnitDefinition } from '../../definitions/units.js';
import { Building } from '../entities.js';
import { UnitMotion } from '../navigation.js';

class ForwardCannon {
    static plant(sim, unit, spec) {
        unit.cannonTick = sim.tick + sim.msTicks(spec.delayMs);
    }
    // Presentation: milliseconds the soldier has been rooting, from its cannonTick in any snapshot. Null for every other unit.
    static rootingMs(type, cannonTick, tick, tps) {
        const spec = UnitDefinition.get(type)?.growsCannon;
        if (!spec || cannonTick == null) return null;
        return spec.delayMs - ((cannonTick - tick) * 1000) / tps;
    }
    // Presentation: 'dig' then 'root' from the soldier's cannonTick in any snapshot. Null for every other unit.
    static stage(type, cannonTick, tick, tps) {
        const rootingMs = ForwardCannon.rootingMs(type, cannonTick, tick, tps);
        if (rootingMs === null) return null;
        return rootingMs < UnitDefinition.get(type).growsCannon.digMs ? 'dig' : 'root';
    }
    // The rooting soldier's whole turn. A soldier knocked into the air stands up once it is down again.
    static root(sim, unit, spec) {
        if (sim.tick < unit.cannonTick || !UnitMotion.isGrounded(unit)) return;
        const definition = BuildingDefinition.get(spec.building);
        unit.alive = false;
        const cannon = sim.addBuilding(
            new Building({
                id: spec.building + '-' + ++sim.seq,
                type: spec.building,
                side: unit.side,
                x: Math.round(unit.x),
                y: Math.round(unit.y),
                hp: definition.hp,
                maxHp: definition.hp,
                decayStartTick: sim.tick,
            }),
        );
        sim.events.push({
            type: 'forwardCannonRooted',
            side: unit.side,
            unitId: unit.id,
            buildingId: cannon.id,
            x: cannon.x,
            y: cannon.y,
        });
    }
    // Integer health steps: the total drained after `age` ticks is floor(age × rate / tps).
    static decay(sim) {
        for (const building of sim.buildings) {
            const spec = BuildingDefinition.get(building.type)?.decay;
            if (!spec || building.alive === false) continue;
            const age = sim.tick - building.decayStartTick,
                lost =
                    Math.floor((age * spec.hpPerSecond) / sim.tps) -
                    Math.floor(((age - 1) * spec.hpPerSecond) / sim.tps);
            if (lost <= 0) continue;
            building.hp -= lost;
            if (building.hp <= 0) sim.destroyBuilding(building, null, null);
        }
    }
}

// Bot launch rule (src/sim/capabilities/bot-launch-rules.js): a potato roots where it lands, so it
// never joins ordinary targeting (ownShotOnly). With nothing else to hit, it goes as far toward the
// enemy base as the nearest cannon reaches.
ForwardCannon.botLaunch = Object.freeze({
    capability: 'growsCannon',
    stage: 'fallback',
    ownShotOnly: true,
    shot({ state, side, units, cannons, enemyBase, budget, level, distance, maxReachOf }) {
        const planter =
            enemyBase &&
            units.find(
                ({ cost, premiumCost }) =>
                    cost <= budget && premiumCost <= state.premiumWallet[side],
            );
        if (!planter) return null;
        const cannon = cannons.reduce((best, candidate) =>
            distance(candidate, enemyBase) < distance(best, enemyBase) ? candidate : best,
        );
        return {
            shot: {
                cannon,
                target: enemyBase,
                distance: Math.min(distance(cannon, enemyBase), maxReachOf(planter.type, level)),
            },
            unit: planter,
        };
    },
});

export { ForwardCannon };
