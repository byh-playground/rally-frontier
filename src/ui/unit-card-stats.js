import { UnitDefinition } from '../definitions/units.js';
import { LaunchRules } from '../sim/launch-rules.js';
import { ResourceDisplay } from './resource-display.js';

const number = new Intl.NumberFormat('ko-KR');
const seconds = (ms) => `${number.format(ms / 1000)}초`;
const perShell = (shots, key) => {
    const values = shots.map((shot) => shot[key]);
    return values.every((value) => value === values[0])
        ? number.format(values[0])
        : values.map((value) => number.format(value)).join(' / ');
};

export function unitCardStats(type, rangeLevel, copy) {
    const unit = UnitDefinition.get(type),
        grain = LaunchRules.grain(type),
        shots = LaunchRules.volleyStats(type),
        payload = LaunchRules.payload(type),
        burst = unit.burstAttack,
        suicide = unit.selfDestruct,
        spin = unit.spinAttack,
        active = unit.heroActive || unit.fruitAttack?.active;

    const troop = [
        ['체력', number.format(unit.hp)],
        [suicide ? '자폭 피해' : '기본 공격력', number.format(suicide?.damage ?? unit.atk)],
        ['이동속도', number.format(unit.speed)],
        ['시야', number.format(unit.sight)],
        [suicide ? '자폭 반경' : '지상 공격 사거리', number.format(suicide?.radius ?? unit.range)],
    ];
    if (unit.outOfCombatMoveMultiplier)
        troop.push(['비전투 이동속도', number.format(unit.speed * unit.outOfCombatMoveMultiplier)]);
    if (unit.canAttackAir)
        troop.push(
            ['대공 공격력', number.format(unit.atk * (burst?.airDamageMultiplier ?? 1))],
            ['대공 사거리', number.format(burst?.airRange ?? unit.range)],
        );
    if (burst)
        troop.push(
            ['최대 연사', `${number.format(burst.shots)}발`],
            ['연사 간격', seconds(burst.shotGapMs)],
            ['재장전', seconds(unit.cooldownMs)],
        );
    else if (spin?.pulseMs)
        troop.push(
            ['회전 공격 반경', number.format(spin.radius)],
            ['회전 타격 간격', seconds(spin.pulseMs)],
        );
    else if (!suicide)
        troop.push(['기본 공격 주기', seconds(unit.attackIntervalMs ?? unit.cooldownMs)]);
    if (unit.leapAttack) troop.push(['도약 발동 거리', number.format(unit.leapAttack.range)]);
    if (active)
        troop.push(
            ['스킬 사거리', number.format(active.range)],
            ['스킬 비용', ResourceDisplay.costText({ cost: active.cost }, true)],
        );

    const shell = [
        ['투입 비용', ResourceDisplay.costText(payload, true)],
        ['투입 인원', `${number.format(payload.count)}명`],
        ['발사 방식', copy.fire],
        ['착지 배치', copy.land],
        ['포탄 수', `${number.format(shots.length)}발`],
        ['포탄 체력 · 발당', number.format(grain.shellHp)],
        ['착탄 위력 · 발당', perShell(shots, 'impact')],
        ['착탄 반경 · 발당', perShell(shots, 'splash')],
        ['최대 발사 거리', number.format(LaunchRules.maxReachOf(type, rangeLevel))],
        ['기준 비행 속도', number.format(LaunchRules.shellSpeed(type))],
    ];
    if (grain.fire.mode === 'burst') shell.push(['발사 간격', seconds(grain.fire.gapMs)]);
    return { troop, shell };
}
