import { BuildingDefinition } from '../definitions/buildings.js';
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
        siege = UnitDefinition.onlyAttacksBuildings(type),
        shots = LaunchRules.volleyStats(type),
        payload = LaunchRules.payload(type),
        burst = unit.burstAttack,
        suicide = unit.selfDestruct,
        spin = unit.spinAttack,
        active = unit.heroActive || unit.fruitAttack?.active;

    const movement = [
        ['체력', number.format(unit.hp)],
        ['이동속도', number.format(unit.speed)],
    ];
    if (unit.outOfCombatMoveMultiplier)
        movement.push([
            '비전투 이동속도',
            number.format(unit.speed * unit.outOfCombatMoveMultiplier),
        ]);
    movement.push(['시야', number.format(unit.sight)]);

    const attack = [
        [
            suicide ? '자폭 피해' : siege ? '건물 공격력' : '기본 공격력',
            number.format(suicide?.damage ?? unit.atk),
        ],
        [
            suicide ? '자폭 반경' : siege ? '건물 돌격 거리' : '지상 공격 사거리',
            number.format(suicide?.radius ?? unit.range),
        ],
    ];
    if (unit.canAttackAir)
        attack.push(
            ['대공 공격력', number.format(unit.atk * (burst?.airDamageMultiplier ?? 1))],
            ['대공 사거리', number.format(burst?.airRange ?? unit.range)],
        );
    if (burst)
        attack.push(
            ['최대 연사', `${number.format(burst.shots)}발`],
            ['연사 간격', seconds(burst.shotGapMs)],
            ['재장전', seconds(unit.cooldownMs)],
        );
    else if (spin?.pulseMs)
        attack.push(
            ['회전 공격 반경', number.format(spin.radius)],
            ['회전 타격 간격', seconds(spin.pulseMs)],
        );
    else if (!suicide)
        attack.push(['기본 공격 주기', seconds(unit.attackIntervalMs ?? unit.cooldownMs)]);
    if (unit.leapAttack) attack.push(['도약 발동 거리', number.format(unit.leapAttack.range)]);

    const grows = unit.growsCannon,
        cannon = grows && BuildingDefinition.get(grows.building);
    // A potato neither walks nor fights: it roots where it lands and becomes a forward cannon.
    const troop = grows
        ? [
              [
                  '생존',
                  [
                      ['체력', number.format(unit.hp)],
                      ['시야', number.format(unit.sight)],
                  ],
              ],
              [
                  '변신',
                  [
                      [cannon.name + '까지', seconds(grows.delayMs)],
                      ['대포 체력', number.format(cannon.hp)],
                      ['초당 체력 감소', number.format(cannon.decay.hpPerSecond)],
                      ['유지 시간', seconds((cannon.hp / cannon.decay.hpPerSecond) * 1000)],
                  ],
                  copy.notes.slice(1),
              ],
          ]
        : [
              ['생존·기동', movement],
              ['공격', attack],
          ];
    if (active)
        troop.push([
            '스킬',
            [
                ['사거리', number.format(active.range)],
                ['비용', ResourceDisplay.costText({ cost: active.cost }, true)],
            ],
            copy.notes.slice(1),
        ]);
    if (unit.stickyCling)
        troop.push([
            '스킬',
            [
                ['포구 붙기', seconds(unit.stickyCling.durationMs)],
                ['재사용 대기', seconds(unit.stickyCling.cooldownMs)],
            ],
            copy.notes.slice(1),
        ]);
    const rider = unit.cannonRider;
    if (rider)
        troop.push([
            '스킬',
            [
                ['적에게 떨어진 뒤 재탑승까지', seconds(rider.reboardDelayMs)],
                ['탑승 시간', seconds(rider.boardMs)],
                ['복귀 이동속도', number.format(unit.speed * rider.returnSpeedMultiplier)],
                [
                    '대포 탐색 거리',
                    number.format(
                        LaunchRules.maxReachOf(type, rangeLevel) *
                            rider.cannonSearchReachMultiplier,
                    ),
                ],
                ['재발사 인원', '1명'],
                ['재발사 비용', '무료'],
            ],
            copy.notes.slice(1),
        ]);

    const deployment = [
        ['투입 비용', ResourceDisplay.costText(payload, true)],
        ['투입 인원', `${number.format(payload.count)}명`],
        ['착지 배치', copy.land],
    ];
    const firing = [
        ['발사 방식', copy.fire],
        ['포탄 수', `${number.format(shots.length)}발`],
        ['최대 발사 거리', number.format(LaunchRules.maxReachOf(type, rangeLevel))],
    ];
    if (grain.fire.mode === 'burst') firing.push(['발사 간격', seconds(grain.fire.gapMs)]);
    const shellStats = [
        ['포탄 체력 · 발당', number.format(grain.shellHp)],
        ['기준 비행 속도', number.format(LaunchRules.shellSpeed(type))],
        ['착탄 위력 · 발당', perShell(shots, 'impact')],
        ['착탄 반경 · 발당', perShell(shots, 'splash')],
    ];
    const shell = [
        ['투입', deployment],
        ['발사', firing],
        ['포탄 성능', shellStats],
    ];
    return { troop, shell };
}
