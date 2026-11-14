// Contract (index.html Development Contract의 지속 피해형 공격 문법을 따르는 능력):
// - 연쇄 번개(Unit Definition `chainAttack`, 목화솜)는 지속 피해형 공격이다(`sustain`, SustainedAttack): 공격 사거리
//   (Definition range, 다른 원거리 병종과 같은 InteractionGeometry.reach) 안의 첫 표적에 번개를 잇고, 그 표적에서
//   중심 거리 `bounceRange` 안의 가장 가까운 적으로 튀어 모두 `links`명까지 잇는다. `sustain.durationMs` 동안
//   `sustain.tickMs`마다 이어진 표적 모두에게 `atk`를 준다(튀어도 감쇠 없음, 건물은 `buildingDamageScale`배를 회차마다
//   누적해 내림). 끝나면 `sustain.cooldownMs` 동안 다시 잇지 못한다.
// - 첫 표적은 평소 표적 선택(pickCombatTarget, 다른 원거리 병종과 같은 우선순위)이 고른 지상 유닛·건물이 사거리 안이면
//   그것이고, 아니면 사거리 안의 가장 가까운 나는 적(UnitFlight, 민들레씨)이다. 튀는 표적은 유닛만이고 땅·공중 층을
//   모두 본다(땅↔공중으로 튐). 동률은 기존 규칙(StrategySim.targetChoiceBetter)이다. 적 투입탄은 노리지 않는다.
//   튀는 거리는 지형선을 보지 않는다(번개가 벽을 넘음). 첫 표적의 사거리는 원거리 공격과 같은 판정이다.
// - 채널링 중에는 멈춰 서서(걷지 않음) 매 틱 연결을 다시 확인한다. k번째 표적이 죽거나, 보이지 않거나, 사거리(첫
//   표적) 또는 앞 표적에서 튀는 거리(그 뒤 표적) 밖으로 나가면 그 줄부터 뒤를 모두 끊고, 끊긴 자리에서 가까운 다른
//   적으로 다시 잇는다(`relinks`에 센다). 첫 표적이 끊기면 사거리 안의 가장 가까운 적(땅·공중 유닛, 없으면 건물)으로
//   다시 시작한다. 이을 적이 없어도 채널링은 지속 시간을 끝까지 채운다(고추와 같음, 다시 이을 적을 기다림).
// - 넘어지면(지면을 떠나면) 그 틱에 채널링이 끝나고(SustainedAttack.cut) 연결을 지우며 재사용 대기를 처음부터 센다.
//   재사용 대기 중에는 다른 원거리 병종처럼 표적이 사거리 안이면 서 있고 밖이면 다가간다.
// - 피해는 applyDamage를 지난다(피해 종류·통계·숫자). 지상 유닛·건물은 일반 경로, 나는 적은 대공 경로
//   (damageDelivery 'anti-air', LaunchInterception.hitFlyer와 같음)다. 아군·투입탄에는 닿지 않는다. 넉백은 없다.
// - Unit.chain { ids (links 길이 고정 배열, 앞에서부터 count개), count, building (ids[0]이 건물), pulses, relinks }과
//   Unit.sustain이 권위 상태다(저장·해시·snapshot). 틱 경로는 배열·객체를 새로 만들지 않는다(ids를 제자리에서 고침).
//   피해 틱마다 chainPulse 사건(첫 표적 자리, 맞힌 수, 공중 맞힌 수)을 그 회차의 hit보다 먼저 낸다(피해 숫자 합치기).
// - 그림: 번개는 sprite 계약의 `chain.drawBolt`로 main.js가 그린다(Unit.chain의 연결을 읽음). 대기 끝 직전
//   (readyTick 전 telegraphMs)에는 예고, 채널링 중에는 공격 얼굴과 부풀며 떨리는 몸(actor.setChannel)이다.
import { UnitFlight } from './unit-flight.js';
import { IndexList } from '../index-list.js';
import { SustainedAttack } from './sustained-attack.js';

const QUERY = new IndexList();
// Ground units and buildings take the shared damage path; a flying unit takes it as anti-air (LaunchInterception).
const HIT = Object.freeze({ suppressImpactFx: true });
const AIR_HIT = Object.freeze({
    suppressImpactFx: true,
    damageDelivery: 'anti-air',
    sourceDamageResolved: true,
});

class UnitChainAttack {
    static initialState(spec) {
        return {
            ids: new Array(spec.links).fill(null),
            count: 0,
            building: false,
            pulses: 0,
            relinks: 0,
        };
    }
    // Is a channel still running this tick? An ended one drops its links.
    static channeling(sim, unit) {
        if (SustainedAttack.advance(sim, unit.sustain)) return true;
        if (unit.chain.count) this.clear(unit.chain);
        return false;
    }
    static clear(chain) {
        for (let k = 0; k < chain.count; k++) chain.ids[k] = null;
        chain.count = 0;
        chain.building = false;
    }
    // Knocked off its feet: the channel ends here, its cooldown counts in full from this tick.
    static stop(sim, unit, d) {
        SustainedAttack.cut(sim, unit.sustain, d.sustain);
        if (unit.chain.count) this.clear(unit.chain);
    }
    // A running channel: it stands, re-checks its links, and damages them on a damage tick.
    static channel(sim, unit, d, vision) {
        this.relink(sim, unit, d, vision, true);
        return SustainedAttack.takeTick(sim, unit.sustain, d.sustain)
            ? this.pulse(sim, unit, d)
            : null;
    }
    // `target` (a unit or building in attack reach) is the first link of a ready channel; on cooldown it only stands.
    static update(sim, unit, target, isBuilding, d, vision) {
        if (!SustainedAttack.advance(sim, unit.sustain)) {
            if (!SustainedAttack.ready(sim, unit.sustain)) return null;
            SustainedAttack.start(sim, unit.sustain, d.sustain);
            const chain = unit.chain;
            this.clear(chain);
            chain.ids[0] = target.id;
            chain.building = !!isBuilding;
            chain.count = 1;
            this.fill(sim, unit, d, vision, false);
        }
        return this.channel(sim, unit, d, vision);
    }
    static entity(sim, chain, k) {
        const id = chain.ids[k];
        return k === 0 && chain.building ? sim.buildingById.get(id) : sim.unitById.get(id);
    }
    // A live, visible enemy unit the chain may hold (ground or flying).
    static linkable(sim, unit, e, vision) {
        return (
            sim.isHostileCombatUnit(unit.side, e) &&
            sim.canAttackEntity(unit.type, e, false) &&
            sim.canSeeCombatTarget(unit.side, e, vision)
        );
    }
    static inReach(sim, unit, e, d) {
        const dx = e.x - unit.x,
            dy = e.y - unit.y,
            reach = sim.interactionDistance(unit, e, 'attack', d.range);
        return reach >= 0 && dx * dx + dy * dy <= reach * reach;
    }
    static holds(sim, unit, chain, k, d, vision) {
        const e = this.entity(sim, chain, k);
        if (!e) return false;
        if (k === 0 && chain.building) {
            if (
                !sim.isHostileCombatBuilding(unit.side, e) ||
                !sim.isVisible(unit.side, e.x, e.y, vision)
            )
                return false;
        } else if (!this.linkable(sim, unit, e, vision)) return false;
        if (k === 0) return this.inReach(sim, unit, e, d);
        const from = this.entity(sim, chain, k - 1),
            dx = e.x - from.x,
            dy = e.y - from.y,
            r = d.chainAttack.bounceRange;
        return dx * dx + dy * dy <= r * r;
    }
    // Drops the first link that no longer holds and every one after it, then links again from there.
    static relink(sim, unit, d, vision, counting) {
        const chain = unit.chain;
        for (let k = 0; k < chain.count; k++) {
            if (this.holds(sim, unit, chain, k, d, vision)) continue;
            for (let j = k; j < chain.count; j++) chain.ids[j] = null;
            chain.count = k;
            if (k === 0) chain.building = false;
            break;
        }
        this.fill(sim, unit, d, vision, counting);
    }
    // Adds links until `links` or no enemy is left to reach: a first one in attack reach, then bounces.
    static fill(sim, unit, d, vision, counting) {
        const chain = unit.chain,
            links = d.chainAttack.links;
        while (chain.count < links) {
            const next =
                chain.count === 0
                    ? this.first(sim, unit, d, vision)
                    : this.bounce(sim, unit, d, vision);
            if (!next) return;
            if (chain.count === 0) chain.building = sim.buildingById.get(next.id) === next;
            chain.ids[chain.count++] = next.id;
            if (counting) chain.relinks++;
        }
    }
    static linked(chain, id) {
        for (let k = 0; k < chain.count; k++) if (chain.ids[k] === id) return true;
        return false;
    }
    // The nearest visible flying enemy in attack reach (a first link when no ground target is in reach), or null.
    static airTarget(sim, unit, d, vision) {
        const count = sim.nearbyUnits(
            unit.x,
            unit.y,
            d.range + sim.unitRadius(unit) + sim.maxUnitRadius,
            1 - unit.side,
            QUERY,
            true,
        );
        let best = null,
            bestD2 = Infinity;
        for (let k = 0; k < count; k++) {
            const e = sim.units[QUERY.items[k]];
            if (
                !UnitFlight.airborne(e) ||
                !this.linkable(sim, unit, e, vision) ||
                !this.inReach(sim, unit, e, d)
            )
                continue;
            const d2 = (e.x - unit.x) ** 2 + (e.y - unit.y) ** 2;
            if (sim.targetChoiceBetter(d2, e.id, bestD2, best)) {
                best = e;
                bestD2 = d2;
            }
        }
        return best;
    }
    // The nearest enemy unit (ground or flying) in attack reach, else the nearest hostile building in reach.
    static first(sim, unit, d, vision) {
        const r = d.range + sim.unitRadius(unit) + sim.maxUnitRadius;
        let best = null,
            bestD2 = Infinity;
        for (let layer = 0; layer < 2; layer++) {
            const count = sim.nearbyUnits(unit.x, unit.y, r, 1 - unit.side, QUERY, layer === 1);
            for (let k = 0; k < count; k++) {
                const e = sim.units[QUERY.items[k]];
                if (!this.linkable(sim, unit, e, vision) || !this.inReach(sim, unit, e, d))
                    continue;
                const d2 = (e.x - unit.x) ** 2 + (e.y - unit.y) ** 2;
                if (sim.targetChoiceBetter(d2, e.id, bestD2, best)) {
                    best = e;
                    bestD2 = d2;
                }
            }
        }
        if (best) return best;
        const count = sim.nearbyBuildingIndices(
            unit.x,
            unit.y,
            d.range + sim.unitRadius(unit) + sim.maxBuildingRadius,
            QUERY,
        );
        for (let k = 0; k < count; k++) {
            const b = sim.buildings[QUERY.items[k]];
            if (
                !sim.isHostileCombatBuilding(unit.side, b) ||
                !sim.canAttackEntity(unit.type, b, true) ||
                !sim.isVisible(unit.side, b.x, b.y, vision) ||
                !this.inReach(sim, unit, b, d)
            )
                continue;
            const d2 = (b.x - unit.x) ** 2 + (b.y - unit.y) ** 2;
            if (sim.targetChoiceBetter(d2, b.id, bestD2, best)) {
                best = b;
                bestD2 = d2;
            }
        }
        return best;
    }
    // The nearest enemy unit (ground or flying) within bounceRange of the last link, not linked yet.
    static bounce(sim, unit, d, vision) {
        const chain = unit.chain,
            from = this.entity(sim, chain, chain.count - 1),
            r = d.chainAttack.bounceRange;
        let best = null,
            bestD2 = r * r;
        for (let layer = 0; layer < 2; layer++) {
            const count = sim.nearbyUnits(from.x, from.y, r, 1 - unit.side, QUERY, layer === 1);
            for (let k = 0; k < count; k++) {
                const e = sim.units[QUERY.items[k]];
                if (!this.linkable(sim, unit, e, vision) || this.linked(chain, e.id)) continue;
                const d2 = (e.x - from.x) ** 2 + (e.y - from.y) ** 2;
                if (d2 > r * r) continue;
                if (sim.targetChoiceBetter(d2, e.id, bestD2, best)) {
                    best = e;
                    bestD2 = d2;
                }
            }
        }
        return best;
    }
    // One damage tick on every link.
    static pulse(sim, unit, d) {
        const chain = unit.chain,
            spec = d.chainAttack,
            pulse = chain.pulses++,
            // Fractional building damage carries over the pulses: floor((k + 1)·a·s) - floor(k·a·s).
            buildingDamage =
                Math.floor((pulse + 1) * d.atk * spec.buildingDamageScale) -
                Math.floor(pulse * d.atk * spec.buildingDamageScale);
        unit.attackFlash = 1;
        const first = chain.count ? this.entity(sim, chain, 0) : null;
        const event = {
            type: 'chainPulse',
            side: unit.side,
            sourceId: unit.id,
            x: first ? first.x : unit.x,
            y: first ? first.y : unit.y,
            hits: 0,
            air: 0,
        };
        sim.events.push(event);
        let winner = null;
        for (let k = 0; k < chain.count; k++) {
            const e = this.entity(sim, chain, k);
            if (!e || e.alive === false) continue;
            if (k === 0 && chain.building) {
                if (buildingDamage <= 0) continue;
                winner =
                    sim.applyDamage(unit.side, unit.type, e, true, buildingDamage, unit.id, HIT) ||
                    winner;
            } else if (UnitFlight.airborne(e)) {
                sim.applyDamage(unit.side, unit.type, e, false, d.atk, unit.id, AIR_HIT);
                event.air++;
            } else sim.applyDamage(unit.side, unit.type, e, false, d.atk, unit.id, HIT);
            event.hits++;
        }
        return winner;
    }
}

export { UnitChainAttack };
