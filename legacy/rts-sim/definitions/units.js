// Unit definitions, runtime geometry and visual definitions.
import { RangeUtil, SIM_TPS } from '../core/game-rules.js';
import { BuildingDefinition } from './buildings.js';
import { COLLISION_RADIUS_SCALE, DANDY_RAMP_MS, ROGUE_BLINK_COOLDOWN_MS, ROGUE_BLINK_RANGE, ROGUE_LANDING_AIRBORNE_HEIGHT, ROGUE_LANDING_AIRBORNE_MS, ROGUE_LANDING_AIRBORNE_RADIUS, ROGUE_LANDING_TARGET_DAMAGE_MULTIPLIER, STARTING_WORKER_COUNT, WORKER_COST } from './world-rules.js';
import { FP } from '../core/config.js';
import { SimulationTiming } from '../main.js';

class UnitDefinition{
  static tierPool(tier){return Object.keys(this.all).filter(id=>this.get(id)?.tier===tier&&!this.get(id)?.economyWorker)}

  static cardInfo={
  rice:{icon:"🌾",desc:"볏단에 묶여 가장 멀리 날아가 넓게 흩어져 내리는 작은 쌀알 병사입니다. 먼 거점을 먼저 차지합니다."},
  soybean:{icon:"🫛",desc:"콩깍지에 담겨 날아가 깍지가 벌어지면 한 줄로 쏟아지는 기본 근접병입니다."},
  redbean:{icon:"🔴",desc:"꼬투리 다발로 날아가 착지하자마자 2초 동안 빠르게 돌격하는 팥알 병사입니다."},
  swordsman:{icon:"❯",desc:"단단한 씨앗 몸에서 자란 큰 칼잎으로 정면 전선을 밀어붙이는 기본 근접병입니다."},
  pikeman:{icon:"▲",desc:"긴 가시줄기를 뻗어 근중거리에서 적을 밀어내고 돌진 접근을 끊습니다."},
  archer:{icon:"❖",desc:"탄성 잎활에서 단단한 씨앗탄을 날려 후방에서 안정적으로 화력을 누적합니다."},
  fireant:{icon:"♨",desc:"산성 씨앗탄으로 소형 적을 집중 사냥하며, 연구 후 일정 확률로 평타 대신 좁은 산성 브레스를 분사합니다."},
  skirmisher:{icon:"✦",desc:"등의 포자낭을 압축 분사해 이동하면서도 빠른 포자탄을 연속 발사합니다."},
  shellbug:{icon:"⬣",desc:"값싼 전열 병사로, 연구 후 교전 중 자리를 잡고 웅크리면 고정 방어력으로 잔딜에 강해집니다."},
  stingbug:{icon:"⌁",desc:"짧은 사거리에서 강하게 찌르며, 연구 후 이동 없이 공격을 이어갈수록 공격속도가 누적되는 경량 공격병입니다."},
  dandelion:{icon:"✹",desc:"민들레 씨앗처럼 빠르게 떠밀리며 빈 공간과 후열을 노리는 초고속 경량병입니다."},
  thornfruit:{icon:"✺",desc:"HP는 낮지만 기본 고정 방어력으로 잔딜을 버티며, 연구 후 빠른 연타를 가시 폭발로 역카운터합니다."},
  kickhopper:{icon:"⌃",desc:"큰 뒷다리로 적 하나를 걷어 올려 짧게 에어본시키고 공격 선딜을 끊는 근접 제어병입니다."},
  tank:{icon:"⬢",desc:"여러 겹의 거대 씨앗껍질로 원거리 화력을 흡수하며 전선을 고정하는 정예 전열입니다."},
  rogue:{icon:"↯",desc:"벼룩처럼 도약해 후열에 달라붙고, 연구 후 착지 충격으로 단일 피해와 주변 에어본을 줍니다."},
  mage:{icon:"✺",desc:"꽃술에 압축한 폭발성 꽃가루를 터뜨려 밀집 진형을 원형 범위로 무너뜨립니다."},
  lancer:{icon:"♢",desc:"왕사슴벌레의 가속을 축적한 뒤 거대한 턱으로 후열과 전선을 들이받는 정예 돌격병입니다."},
  medic:{icon:"◍",desc:"이슬줄기로 마나를 소모해 아군을 회복하고 주변 은신 생물을 감지합니다."},
  mantis:{icon:"◖",desc:"잎사귀와 동화해 은신 정찰하고 낫 앞다리의 매복 첫타로 후열을 찌르는 베일 사마귀입니다."},
  pillbug:{icon:"◌",desc:"빛나는 폭낭을 품고 돌진해 자폭하며, 연구 후 그림자벼룩과 같은 도약으로 접근 성공률을 높입니다."},
  rootstalker:{icon:"╫",desc:"구근 몸체를 지면에 고정한 뒤 땅속 뿌리에서 직선 가시를 연속으로 솟구칩니다."},
  chainflower:{icon:"⌁",desc:"꽃 전류가 첫 대상에서 가까운 적으로 연쇄되어 밀집 진형을 갉아먹습니다."},
  guardshroom:{icon:"☂",desc:"주변의 보호막 없는 아군 여러 명에게 주기적으로 1회 타격 보호막을 부여하고 대상마다 마나를 사용합니다."},
  sporeherd:{icon:"❉",desc:"마나를 사용해 포자병을 일정 수까지 소환하며 연구 후 포자병이 도약합니다."},
  clawhunter:{icon:"⋔",desc:"자체 시야보다 먼 적도 아군이 확보한 시야를 활용해 갈고리로 후열을 끌어와 진형을 무너뜨립니다."},
  siege:{icon:"◉",desc:"뿌리 지지대를 전개한 뒤 초장거리에서 무거운 철갑씨앗탄 한 발을 좁고 강하게 꽂습니다."},
  rocket:{icon:"✾",desc:"봉선화 씨방 4개에서 고각 씨앗로켓을 연속 발사해 서로 다른 지점을 연쇄 폭격합니다."},
  shelltitan:{icon:"⬡",desc:"거대한 껍질과 충격파로 전선을 밀어붙이는 정예 거신입니다."},
  swarmbug:{icon:"⁙",desc:"이동 중에는 땅속으로 파고들어 공격을 피하고, 사거리 안에서 솟아올라 대량으로 달라붙는 군락 병종입니다."},
  aegisbeetle:{icon:"◉",desc:"빠른 전기 아크로 지속 피해를 주며, 충전된 마나를 소모해 주변 적 투사체를 직접 요격하는 지원 병종입니다."},
  burrowbeast:{icon:"⌄",desc:"잠복한 뒤 실제 지하 좌표로 빠르게 후방까지 이동하고, 분출하면서 주변 피해·에어본을 주는 근접 광역 생물입니다."},
  deepthorn:{icon:"♜",desc:"땅속 거대 뿌리를 대상 위치에서 솟구쳐 좁은 범위를 강타하고 주변 지상 유닛을 공중으로 띄우는 제어 거수입니다."},
  flowerbee:{icon:"✤",desc:"지상군 위를 넘어 곧장 합류하는 기본형 근접 공중 전투병입니다."},
  sporefly:{icon:"⁙",desc:"개체는 약하지만 많은 수가 지상군과 겹쳐 달라붙는 물량형 공중 근접병입니다."},
  gustmayfly:{icon:"≋",desc:"극단적인 비행 속도로 먼 전선에 빠르게 합류하는 속도형 공중 근접병입니다."},
  lanternmoth:{icon:"✧",desc:"넓은 시야와 Detection으로 은신을 밝히고 장거리 포병의 관측을 돕는 원거리 공중 유틸입니다."},
  sporemoth:{icon:"☁",desc:"공중에서 지상 밀집 병력에 포자탄을 떨어뜨리는 지상 전용 광역 폭격기입니다."},
  hunterwasp:{icon:"⌁",desc:"빠른 근접 전투로 지상·공중 적에게 달라붙는 정예 비행병입니다."},
  sailwing:{icon:"◒",desc:"큰 돛날개로 주변 아군 지상·공중 병력의 이동속도를 상시 높이는 기동 지원체입니다."},
  ancientmistray:{icon:"〰",desc:"자신과 같은 종류를 제외한 주변 아군 유닛을 지속 클로킹하는 거대 공중 지원체입니다."},
  hivecarrier:{icon:"◈",desc:"고속 선회·부상 귀환을 반복하는 공생 비행충을 운용하며, 격추된 공생충은 마나를 소비해 재생하는 거대 군락 모함입니다."},
  carriermite:{icon:"·",desc:"군락모함에서 출격하는 공생 비행충입니다."}
};
  static presentation(id){return this.cardInfo[id]||null}
  static icon(id){return this.presentation(id)?.icon||"◆"}
  

  static all={
  worker:{requiresContactTerrain:true,navigationPlanner:"adaptive",name:"일꾼콩",tier:1,mineralCost:WORKER_COST,supply:1,buildTimeMs:4000,hp:50,atk:5,range:25,speed:150,cooldownMs:750,size:10,sizeClass:"light",role:"worker",attackVisual:{sourceMotion:"smash",travel:"none",impact:"light"},sight:225,builderTargetPriority:true,economyWorker:true,captureExcluded:true,recallExcluded:true,spellHealExcluded:true},

  // Neutral PvE units - 생산/드래프트 대상이 아닌 맵 오브젝트
  wildhound:{requiresContactTerrain:true,name:"가시등 스프린터",tier:0,mineralCost:0,supply:0,buildTimeMs:0,hp:275,atk:40,range:25,speed:125,cooldownMs:750,size:20,sizeClass:"light",attackVisual:{sourceMotion:"slash",travel:"none",impact:"light"},role:"neutral",sight:0,leapRange:225,leapCooldownMs:2000,leapSplashRadius:75,leapSplashDamagePct:200,damageClass:"smallSpecialist"},
  boar:{requiresContactTerrain:true,name:"껍질멧돼지",tier:0,mineralCost:0,supply:0,buildTimeMs:0,hp:750,atk:90,range:25,speed:25,cooldownMs:750,size:30,sizeClass:"medium",attackVisual:{sourceMotion:"smash",travel:"none",impact:"light"},role:"neutral",sight:0,chargeDistance:175,chargeSpeed:325,chargeDamage:45,chargeEvery:3},
  sporetoad:{name:"포자두꺼비",tier:0,mineralCost:0,supply:0,buildTimeMs:0,hp:250,atk:30,range:100,speed:25,cooldownMs:750,size:20,sizeClass:"medium",attackVisual:{sourceMotion:null,travel:"projectile",impact:"light"},role:"neutral",sight:0,projectile:250,projectileArc:20,projectileRadius:5,splash:50,splashScale:.55,canAttackGround:true,canAttackAir:true,breathChance:0.5,breathRange:150,breathAngleDeg:30,breathContinuous:{dps:60,damageIntervalMs:250,durationMs:1000},damageClass:"area"},
  shellcrab:{requiresContactTerrain:true,name:"꽃게딱지",tier:0,mineralCost:0,supply:0,buildTimeMs:0,hp:500,atk:50,range:25,speed:25,cooldownMs:1000,size:25,sizeClass:"heavy",flatArmor:5,attackVisual:{sourceMotion:"smash",travel:"none",impact:"light"},role:"neutral",sight:0,canAttackGround:true,canAttackAir:false},
  queenwasp:{name:"씨앗날벌 여왕",tier:0,mineralCost:0,supply:0,buildTimeMs:0,hp:800,atk:25,range:100,speed:50,cooldownMs:1000,size:30,sizeClass:"medium",attackVisual:{sourceMotion:null,travel:"projectile",impact:"pierce"},role:"neutral",sight:0,layer:"AIR",airHeight:50,canAttackGround:true,canAttackAir:true,projectile:250,summonType:"seedwasp",summonIntervalMs:5000,summonBatch:2,summonMax:4,summonLifetimeMs:10000},
  seedwasp:{requiresContactTerrain:true,name:"씨앗날벌",tier:0,mineralCost:0,supply:0,buildTimeMs:0,hp:100,atk:15,range:25,speed:100,cooldownMs:500,size:10,sizeClass:"light",attackVisual:{sourceMotion:"thrust",travel:"none",impact:"pierce"},role:"neutralSummon",sight:0,layer:"AIR",airHeight:30,canAttackGround:true,canAttackAir:true,deathExplosionRadius:75,deathExplosionDamagePct:300},
  greatbear:{requiresContactTerrain:true,name:"고대 꽃등 곰",tier:0,mineralCost:0,supply:0,buildTimeMs:0,hp:2500,atk:150,range:50,speed:25,cooldownMs:1000,size:50,sizeClass:"heavy",attackVisual:{sourceMotion:"smash",travel:"none",impact:"light"},role:"neutral",sight:0},
  ancientbear:{name:"고대곰",tier:0,mineralCost:0,supply:0,buildTimeMs:0,hp:3000,atk:100,range:50,speed:25,cooldownMs:4000,size:60,sizeClass:"heavy",flatArmor:15,attackVisual:{sourceMotion:null,travel:"projectile",impact:"light"},role:"mainobjective",sight:450,canAttackGround:true,canAttackAir:true,objectiveKind:"bear",shockRadius:100,shockDamage:50,shockAirborneMs:2000,shockAirborneHeight:72,chargeEvery:3,chargeDistance:175,chargeDamage:75,chargeSpeed:325,airRange:225,airDamage:60,airCooldownMs:3000,airSplash:50,projectile:250,projectileArc:30,projectileRadius:5},
  // VISUAL CONTRACT: eyeless flesh-toned worm; circular tooth-ring maw; never green/eye-faced.
  deathworm:{name:"데스웜",tier:0,mineralCost:0,supply:0,buildTimeMs:0,hp:2000,atk:25,range:200,speed:25,cooldownMs:250,size:45,sizeClass:"heavy",flatArmor:10,attackVisual:{sourceMotion:null,travel:"projectile",impact:"pierce"},role:"mainobjective",sight:500,canAttackGround:true,canAttackAir:true,objectiveKind:"deathworm",projectile:625,projectileRadius:5,ruptureEvery:4,ruptureRadius:50,burrowEvery:20,burrowCapable:true,burrowTrail:true,burrowDiveMs:300,burrowMoveSpeed:425,burrowEmergeRadius:50,burrowEmergeDamage:50,burrowAirborneMs:1000,burrowAirborneHeight:60},
  dragon:{name:"드래곤",tier:0,mineralCost:0,supply:0,buildTimeMs:0,hp:500,atk:75,range:450,speed:25,cooldownMs:1500,size:55,sizeClass:"medium",flatArmor:5,attackVisual:{sourceMotion:null,travel:"projectile",impact:"explosive"},role:"mainobjective",sight:600,layer:"AIR",airHeight:80,canAttackGround:true,canAttackAir:true,objectiveKind:"dragon",projectile:250,projectileArc:40,projectileRadius:10,splash:100,breathEvery:5,breathRange:300,breathAngleDeg:45,breathContinuous:{dps:60,damageIntervalMs:250,durationMs:2000},damageClass:"area"},

  // T1 - 단순하고 읽기 쉬운 기본병. 전체 풀 중 매 판 일부만 드래프트
  rice:{requiresContactTerrain:true,name:"쌀",launchGrain:true,tier:0,mineralCost:0,supply:1,buildTimeMs:3000,hp:25,atk:5,range:25,speed:75,cooldownMs:1000,size:10,sizeClass:"light",role:"bruiser",attackVisual:{sourceMotion:"slash",travel:"none",impact:"light"},sight:275,counter:"먼 거점 선점 · 넓게 흩어지는 물량"},
  soybean:{requiresContactTerrain:true,name:"콩",launchGrain:true,tier:0,mineralCost:0,supply:1,buildTimeMs:3000,hp:75,atk:10,range:25,speed:50,cooldownMs:1000,size:15,sizeClass:"medium",role:"bruiser",attackVisual:{sourceMotion:"smash",travel:"none",impact:"light"},sight:275,counter:"기본 근접 전열"},
  redbean:{requiresContactTerrain:true,name:"팥",launchGrain:true,tier:0,mineralCost:0,supply:1,buildTimeMs:3000,hp:50,atk:15,range:25,speed:50,cooldownMs:1000,size:10,sizeClass:"light",role:"bruiser",attackVisual:{sourceMotion:"smash",travel:"none",impact:"light"},sight:275,counter:"착지 직후 돌격 · 돌파"},
  swordsman:{requiresContactTerrain:true,name:"칼잎 전사",production:{totalUnits:15,batchSize:3,productionSeconds:10,mineral:100,gas:0},tier:1,mineralCost:0,supply:2,buildTimeMs:3250,hp:125,atk:20,range:25,speed:50,cooldownMs:1000,size:15,sizeClass:"medium",role:"bruiser",attackVisual:{sourceMotion:"slash",travel:"none",impact:"light"},sight:275,counter:"고체력 기본 전열 · 원거리 사격을 버티며 접근해 전선을 밀어냄"},
  pikeman:{requiresContactTerrain:true,name:"가시창풀",production:{totalUnits:10,batchSize:2,productionSeconds:10,mineral:100,gas:0},abilityResearchGrade:"light",tier:1,mineralCost:0,supply:2,buildTimeMs:3500,hp:75,atk:20,range:100,speed:50,cooldownMs:750,size:15,sizeClass:"medium",attackVisual:{sourceMotion:"thrust",travel:"none",impact:"pierce"},role:"pikeman",sight:300,counter:"근중거리 접근 차단 · 매 공격 약한 넉백"},
  archer:{chargedSkill:{kind:"lob",minReach:100,maxReach:440,speed:300,damage:34,radius:35,arcHeight:100,recoveryMs:1000},name:"씨앗궁수",production:{totalUnits:10,batchSize:2,productionSeconds:15,mineral:125,gas:25},tier:1,mineralCost:0,supply:2,buildTimeMs:3750,hp:75,atk:20,range:175,speed:50,cooldownMs:750,size:15,sizeClass:"light",attackVisual:{sourceMotion:null,travel:"projectile",impact:"pierce"},role:"ranged",sight:350,projectile:250,counter:"안정 원거리",canAttackAir:true},
  fireant:{name:"불개미",production:{totalUnits:8,batchSize:2,productionSeconds:15,mineral:125,gas:50},projectileVisualTag:"fireAntEmber",tier:1,mineralCost:0,supply:2,buildTimeMs:4000,hp:75,atk:30,range:100,speed:50,cooldownMs:1000,size:10,sizeClass:"light",attackVisual:{sourceMotion:null,travel:"projectile",impact:"pierce"},role:"ranged",sight:325,projectile:300,canAttackGround:true,canAttackAir:false,counter:"소형 특화 원거리",damageClass:"smallSpecialist",basicAttack:{variants:[{id:"acidBreath",priority:100,requires:{research:"fireantBreath"},trigger:{type:"chance",chance:0.35},attack:{type:"breath",range:150,angleDeg:30,damageClass:"smallSpecialist",continuous:{dps:60,damageIntervalMs:250,durationMs:1000},vfxPreset:"fireAntBreath"}}]}},
  skirmisher:{name:"포자사수",production:{totalUnits:6,batchSize:3,productionSeconds:20,mineral:100,gas:25},vfxMuzzle:"gun",vfxImpact:"bullet",abilityResearchGrade:"standard",tier:1,mineralCost:0,supply:2,buildTimeMs:4000,hp:75,atk:15,range:125,speed:75,cooldownMs:750,attackWindupMs:150,attackMoveRecoveryMs:250,size:10,sizeClass:"light",attackVisual:{sourceMotion:null,travel:"projectile",impact:"pierce"},role:"skirmisher",sight:400,projectile:275,retreatRange:75,idealRange:100,maintainIdealRange:true,abilityImpactKnockback:true,counter:"짧은 사거리 기동사격 · 거리 조절",canAttackAir:true},
  shellbug:{requiresContactTerrain:true,name:"껍질딱정벌레",production:{totalUnits:16,batchSize:4,productionSeconds:10,mineral:100,gas:0},abilityResearchGrade:"light",tier:1,mineralCost:0,supply:2,buildTimeMs:3500,hp:100,atk:15,range:25,speed:50,cooldownMs:750,size:15,sizeClass:"medium",role:"bruiser",attackVisual:{sourceMotion:"smash",travel:"none",impact:"light"},sight:275,counter:"저가 전열",rangedReduction:50,abilityFlatArmor:5,abilityFlatArmorCondition:"crouched",crouchPrepMs:1500},
  stingbug:{requiresContactTerrain:true,name:"침벌레",production:{totalUnits:14,batchSize:2,productionSeconds:10,mineral:100,gas:0},tier:1,mineralCost:0,supply:2,buildTimeMs:3500,hp:75,atk:15,range:50,speed:75,cooldownMs:500,attackWindupMs:100,size:10,sizeClass:"light",role:"bruiser",attackVisual:{sourceMotion:"thrust",travel:"none",impact:"pierce"},sight:300,counter:"고속 성장형 근접 딜러"},
  dandelion:{requiresContactTerrain:true,name:"민들레 주자",production:{totalUnits:20,batchSize:5,productionSeconds:10,mineral:100,gas:0},abilityResearchGrade:"standard",tier:1,mineralCost:0,supply:1,buildTimeMs:3000,hp:50,atk:10,range:25,speed:100,cooldownMs:500,attackWindupMs:150,size:10,sizeClass:"light",role:"scout",attackVisual:{sourceMotion:"slash",travel:"none",impact:"light"},sight:400,counter:"초고속 빈틈 침투 · 저보급",outOfCombatRampMs:DANDY_RAMP_MS,outOfCombatMaxSpeedPct:155,outOfCombatRampRequiresAbility:true,outOfCombatResetOnCombat:true,formationProfile:"threeBand",formationRequiresAbility:true},
  thornfruit:{requiresContactTerrain:true,name:"가시열매",production:{totalUnits:12,batchSize:3,productionSeconds:10,mineral:100,gas:0},abilityResearchGrade:"core",tier:1,mineralCost:0,supply:2,buildTimeMs:3750,hp:75,atk:5,range:25,speed:50,cooldownMs:1000,size:15,sizeClass:"medium",role:"guardian",attackVisual:{sourceMotion:"smash",travel:"none",impact:"light"},sight:275,counter:"고정 방어력과 가시 반사로 연타를 받아내는 전열",flatArmor:10,meleeReflectFlatArmorPct:100,hitBurstWindowMs:1000,hitBurstThreshold:4,hitBurstCooldownMs:1500,hitBurstRadius:100,abilityHitBurstRadius:175},
  kickhopper:{requiresContactTerrain:true,name:"방아깨비",production:{totalUnits:10,batchSize:2,productionSeconds:10,mineral:100,gas:0},abilityResearchGrade:"advanced",tier:1,mineralCost:0,supply:2,buildTimeMs:3750,hp:125,atk:15,range:25,speed:50,cooldownMs:1000,attackWindupMs:250,size:10,sizeClass:"light",role:"controller",attackVisual:{sourceMotion:"smash",travel:"none",impact:"light"},sight:300,counter:"단일 짧은 에어본",canAttackGround:true,canAttackAir:false,airborneMs:200,airborneHeight:20,abilitySplashRadius:50,abilitySplashScale:.45,abilityAirborneMs:250,abilityAirborneHeight:28,leapAutoPolicy:"specialResearch:kickhopperLeap",leapTargetRoles:"backline",leapRange:ROGUE_BLINK_RANGE,leapCooldownMs:ROGUE_BLINK_COOLDOWN_MS},

  // T2 - 정예/물량/키유닛형으로 전투 규칙과 조합 방향을 바꾸는 단계
  tank:{requiresContactTerrain:true,name:"껍질수호자",production:{totalUnits:5,batchSize:1,productionSeconds:10,mineral:200,gas:0},abilityResearchGrade:"advanced",tier:2,mineralCost:0,supply:5,buildTimeMs:6000,hp:600,atk:30,range:25,speed:25,cooldownMs:750,size:20,sizeClass:"heavy",role:"guardian",attackVisual:{sourceMotion:"smash",travel:"none",impact:"heavy"},sight:250,taunt:true,tauntRadius:175,rangedReduction:50,abilityRangedReduction:25,counter:"초고내구 전열 고정"},
  rogue:{requiresContactTerrain:true,name:"그림자벼룩",production:{totalUnits:10,batchSize:5,productionSeconds:15,mineral:100,gas:0},abilityResearchGrade:"advanced",tier:2,mineralCost:0,supply:3,buildTimeMs:4750,hp:75,atk:60,range:25,speed:50,cooldownMs:500,attackWindupMs:150,size:10,sizeClass:"light",role:"assassin",attackVisual:{sourceMotion:"slash",travel:"none",impact:"light"},sight:425,leapRange:ROGUE_BLINK_RANGE,leapCooldownMs:ROGUE_BLINK_COOLDOWN_MS,leapAutoPolicy:"always",leapTargetRoles:"rogueBackline",leapLandingTargetDamageMultiplier:ROGUE_LANDING_TARGET_DAMAGE_MULTIPLIER,leapLandingAirborneRadius:ROGUE_LANDING_AIRBORNE_RADIUS,leapLandingAirborneMs:ROGUE_LANDING_AIRBORNE_MS,leapLandingAirborneHeight:ROGUE_LANDING_AIRBORNE_HEIGHT,counter:"소형 후열 암살",priority:{artillery:340,ranged:260,caster:300,skirmisher:275,support:360,controller:250,worker:150},damageClass:"smallSpecialist"},
  mage:{name:"폭발꽃",production:{totalUnits:5,batchSize:1,productionSeconds:15,mineral:75,gas:100},abilityResearchGrade:"standard",tier:2,mineralCost:0,supply:3,buildTimeMs:5250,hp:75,atk:35,range:150,speed:25,cooldownMs:1000,attackWindupMs:300,size:15,sizeClass:"light",attackVisual:{sourceMotion:null,travel:"projectile",impact:"arcane"},role:"caster",sight:325,projectile:200,splash:75,counter:"밀집·중장갑 폭발 집중",damageClass:"area",abilitySplashFalloff:"100-75-50",canAttackAir:true},
  lancer:{chargedSkill:{kind:"momentum",minReach:100,maxReach:460,speed:400,damage:55,recoveryMs:1200},requiresContactTerrain:true,name:"왕사슴 돌격대",production:{totalUnits:8,batchSize:2,productionSeconds:10,mineral:125,gas:25},abilityResearchGrade:"standard",tier:2,mineralCost:0,supply:4,buildTimeMs:5500,hp:225,atk:35,range:25,speed:50,cooldownMs:750,attackWindupMs:250,size:15,sizeClass:"medium",role:"charger",attackVisual:{sourceMotion:"thrust",travel:"none",impact:"pierce"},sight:300,momentumCharge:true,counter:"사슴벌레 탑승 가속 돌진 · 축적 이속 비례 첫타",priority:{skirmisher:195,ranged:165,artillery:155,support:170},outOfCombatRampMs:4000,outOfCombatMaxSpeedPct:200,outOfCombatWriteMomentum:true,outOfCombatHoldOnCombat:true},
  medic:{name:"이슬치유사",production:{totalUnits:4,batchSize:1,productionSeconds:5,mineral:75,gas:75},abilityResearchGrade:"light",tier:2,mineralCost:0,supply:3,buildTimeMs:5000,hp:100,atk:5,range:100,speed:25,cooldownMs:1000,size:10,sizeClass:"light",attackVisual:{sourceMotion:null,travel:"projectile",impact:"light"},role:"support",sight:350,detectRadius:175,projectile:200,healRange:150,healAmount:5,healCooldownMs:250,counter:"치유와 은신 탐지를 지원하며 연구로 전투력을 보강하는 의무병",usesMana:true,manaMax:250,manaRegenPerSecond:10,healManaPerPacket:5,healPerManaPacket:5,canAttackAir:true,basicAttack:{variants:[{id:"medicShockShot",priority:100,requires:{ability:"medic"},trigger:{type:"chance",chance:.35},attack:{type:"projectile",knockbackDistance:50,arcHeight:75,vfxPreset:"medicShock"}}]}},
  mantis:{requiresContactTerrain:true,name:"베일 사마귀",production:{totalUnits:4,batchSize:1,productionSeconds:5,mineral:25,gas:125},tier:2,mineralCost:0,supply:2,buildTimeMs:5000,hp:75,atk:25,range:25,speed:75,cooldownMs:750,attackWindupMs:150,size:10,sizeClass:"light",role:"scout",attackVisual:{sourceMotion:"slash",travel:"none",impact:"light"},sight:475,counter:"은신 정찰 · 매복 첫타 · 디텍터에 약함",stealth:true,ambushDamage:1.50,priority:{ranged:145,caster:150,support:165,artillery:140,worker:120}},
  pillbug:{requiresContactTerrain:true,name:"폭낭 콩벌레",production:{totalUnits:15,batchSize:1,productionSeconds:5,mineral:50,gas:100},abilityResearchGrade:"standard",tier:2,mineralCost:0,supply:2,buildTimeMs:4750,hp:100,atk:50,range:25,speed:75,cooldownMs:1000,size:15,sizeClass:"medium",attackVisual:{sourceMotion:null,travel:"none",impact:"explosive"},role:"controller",sight:325,counter:"콩벌레 자폭 돌진 · 연구 시 도약 접근",selfDestruct:true,attackSplash:100,deathSplash:75,deathDamageScale:.65,leapAutoPolicy:"ability",leapTargetRoles:"backline",leapRange:ROGUE_BLINK_RANGE,leapCooldownMs:ROGUE_BLINK_COOLDOWN_MS,priority:{ranged:150,skirmisher:155,support:150,caster:145,worker:120},damageClass:"area"},
  rootstalker:{requiresContactTerrain:true,name:"뿌리가시",production:{totalUnits:4,batchSize:1,productionSeconds:5,mineral:50,gas:125},abilityResearchGrade:"advanced",tier:2,mineralCost:0,supply:3,buildTimeMs:5500,hp:125,atk:30,range:225,speed:25,cooldownMs:1250,attackWindupMs:700,size:15,sizeClass:"medium",attackVisual:{sourceMotion:"thrust",travel:"none",impact:"pierce"},role:"controller",sight:350,counter:"고정 준비 후 직선 관통 · 좁은 진형 파괴",rootSetupMs:700,lineWidth:35,priority:{ranged:130,skirmisher:135,artillery:130},damageClass:"area"},
  chainflower:{requiresContactTerrain:true,name:"연쇄꽃",production:{totalUnits:6,batchSize:2,productionSeconds:10,mineral:50,gas:100},abilityResearchGrade:"standard",tier:2,mineralCost:0,supply:3,buildTimeMs:5250,hp:100,atk:25,range:175,speed:25,cooldownMs:1000,size:15,sizeClass:"light",attackVisual:{sourceMotion:null,travel:"none",impact:"arcane"},role:"caster",sight:350,counter:"밀집 진형 연쇄 공격",chainRange:125,chainBounces:2,priority:{ranged:120,support:120,caster:120},canAttackAir:true,damageClass:"area"},
  guardshroom:{name:"수호버섯",production:{totalUnits:4,batchSize:1,productionSeconds:10,mineral:50,gas:100},abilityResearchGrade:"advanced",tier:2,mineralCost:0,supply:3,buildTimeMs:5750,hp:175,atk:10,range:125,speed:25,cooldownMs:1250,size:15,sizeClass:"medium",attackVisual:{sourceMotion:null,travel:"projectile",impact:"light"},role:"support",sight:325,projectile:175,counter:"주변 아군에게 타격 보호막을 공급하는 지원병",usesMana:true,manaMax:250,manaRegenPerSecond:10,guardChargeRadius:150,guardManaCost:10,guardPulseIntervalMs:1000,abilityGuardPulseIntervalPct:70,guardTargetsPerPulse:3,guardRetaliationManaCost:10,guardRetaliationDamage:25,guardRetaliationSplash:50,guardRetaliationRange:250,guardRetaliationArcHeight:35,canAttackAir:true},
  sporeherd:{name:"포자목자",production:{totalUnits:6,batchSize:3,productionSeconds:10,mineral:150,gas:75},abilityResearchGrade:"standard",tier:2,mineralCost:0,supply:3,buildTimeMs:5750,hp:100,atk:10,range:125,speed:25,cooldownMs:1250,size:15,sizeClass:"light",attackVisual:{sourceMotion:null,travel:"projectile",impact:"light"},role:"support",sight:350,projectile:175,counter:"마나 기반 포자병 생산 · 연구 시 포자병 도약",usesMana:true,manaMax:250,manaRegenPerSecond:10,summonIntervalMs:500,summonMax:5,summonManaCost:35,summonLifetimeMs:12000,canAttackAir:true},
  clawhunter:{requiresContactTerrain:true,name:"집게사냥꾼",production:{totalUnits:5,batchSize:1,productionSeconds:5,mineral:50,gas:50},abilityResearchGrade:"advanced",tier:2,mineralCost:0,supply:3,buildTimeMs:5250,hp:175,atk:25,range:25,speed:50,cooldownMs:750,size:15,sizeClass:"medium",role:"controller",attackVisual:{sourceMotion:"claw",travel:"none",impact:"light"},sight:300,counter:"시야 공유형 초장거리 곡사 집게",hookRange:450,hookTravelMs:300,hookArcHeight:90,hookRetractMs:220,hookImpulseDistance:100,hookImpulseMs:250,hookImpulseDecay:780,hookCooldownMs:8000,hookAirborneMs:1000,hookAirborneHeight:28,priority:{ranged:175,skirmisher:180,support:200,caster:190,artillery:180}},
  sporeling:{requiresContactTerrain:true,name:"포자병",tier:0,mineralCost:0,supply:0,buildTimeMs:0,hp:25,atk:10,range:25,speed:75,cooldownMs:750,size:5,sizeClass:"light",role:"summon",attackVisual:{sourceMotion:"bite",travel:"none",impact:"light"},sight:225,leapAutoPolicy:"parentAbility:sporeherd",leapTargetRoles:"sporeling",leapRange:ROGUE_BLINK_RANGE,leapCooldownMs:ROGUE_BLINK_COOLDOWN_MS},

  // T3 - 적은 수로도 전투 규칙을 바꾸는 최종 테크
  siege:{chargedSkill:{kind:"lob",minReach:160,maxReach:760,speed:260,damage:140,radius:95,arcHeight:150,recoveryMs:2200},name:"철갑씨앗포",production:{totalUnits:4,batchSize:1,productionSeconds:10,mineral:75,gas:100},vfxHeavy:true,abilityResearchGrade:"standard",tier:3,mineralCost:0,supply:7,buildTimeMs:8250,hp:250,atk:100,range:600,minRange:150,speed:25,cooldownMs:2500,attackWindupMs:350,size:20,sizeClass:"heavy",attackVisual:{sourceMotion:null,travel:"projectile",impact:"explosive"},role:"artillery",sight:650,projectile:250,splash:50,counter:"전개 후 초장거리 집중포격 · 좁고 강한 착탄",abilityImpactAreaKnockback:true,impactKnockbackRadius:50,impactKnockbackDistance:25,projectileArc:24,projectileRadius:5,projectileVisualTag:"armorSeed",deployment:{deployMs:900,undeployMs:450,stance:"siege"},damageClass:"area"},
  rocket:{name:"다연발 봉선화",production:{totalUnits:3,batchSize:1,productionSeconds:10,mineral:100,gas:175},vfxHeavy:true,abilityResearchGrade:"advanced",tier:3,mineralCost:0,supply:7,buildTimeMs:8250,hp:200,atk:60,range:425,minRange:125,speed:25,cooldownMs:2500,attackWindupMs:250,size:20,sizeClass:"medium",attackVisual:{sourceMotion:null,travel:"projectile",impact:"explosive"},role:"artillery",sight:475,projectile:200,splash:0,counter:"적 밀집 지점에 연속 곡사탄을 퍼붓는 장거리 포대",aoeScoreRadius:200,projectileVisualTag:"balsamRocket",projectilePattern:{count:4,intervalMs:150,damagePerShot:15,impactRadius:105,spreadRadius:78,arcHeights:[88,96,100,92],splashScale:1,impactAtAimPoint:true},projectileRadius:5,damageClass:"area"},
  shelltitan:{requiresContactTerrain:true,name:"고대껍질 거신",production:{totalUnits:3,batchSize:1,productionSeconds:10,mineral:250,gas:50},vfxHeavy:true,abilityResearchGrade:"advanced",tier:3,mineralCost:0,supply:9,buildTimeMs:9250,hp:900,atk:70,range:25,speed:25,cooldownMs:1250,size:35,sizeClass:"heavy",role:"guardian",attackVisual:{sourceMotion:"smash",travel:"none",impact:"heavy"},sight:300,counter:"초대형 광역 전열 붕괴 · 연구 시 충격파 넉백+에어본",slamRadius:100,slamScale:.60,slamKnockbackDistance:25,slamAirborneMs:200,slamAirborneHeight:24,damageClass:"area"},
  swarmbug:{requiresContactTerrain:true,name:"군락벌레",production:{totalUnits:30,batchSize:6,productionSeconds:15,mineral:300,gas:0},abilityResearchGrade:"advanced",tier:3,mineralCost:0,supply:1,buildTimeMs:3250,hp:150,atk:15,range:25,speed:75,cooldownMs:500,size:10,sizeClass:"light",role:"swarm",attackVisual:{sourceMotion:"bite",travel:"none",impact:"light"},sight:275,counter:"이동 중 지하 접근 · 연구 시 밀집 광분/포위 + 사체 섭취",burrowWhileMoving:true,burrowUntargetable:true,burrowTrail:true,formationProfile:"surround",formationRequiresAbility:true,carcassConsumeRadius:150,carcassPieces:5},
  aegisbeetle:{requiresContactTerrain:true,name:"방패딱정벌레",production:{totalUnits:4,batchSize:1,productionSeconds:10,mineral:75,gas:150},abilityResearchGrade:"core",tier:3,mineralCost:0,supply:7,buildTimeMs:8750,hp:400,atk:5,range:200,speed:25,cooldownMs:250,attackWindupMs:50,size:25,sizeClass:"heavy",attackVisual:{sourceMotion:null,travel:"none",impact:"arcane"},continuous:{dps:20,damageIntervalMs:250},role:"support",sight:375,counter:"빠른 전기 아크 지속딜 · 마나 충전식 투사체 요격",usesMana:true,manaMax:250,manaRegenPerSecond:10,interceptRadius:175,interceptManaCost:20,abilityInterceptRadius:225,abilityInterceptManaCost:10,canAttackAir:true},
  burrowbeast:{requiresContactTerrain:true,name:"굴착괴수",production:{totalUnits:3,batchSize:1,productionSeconds:10,mineral:150,gas:150},abilityResearchGrade:"advanced",abilityResearchCost:200,abilityResearchGasCost:200,tier:3,mineralCost:0,supply:7,buildTimeMs:8750,hp:300,atk:60,range:25,speed:25,cooldownMs:750,size:25,sizeClass:"heavy",role:"assassin",attackVisual:{sourceMotion:"smash",travel:"none",impact:"heavy"},sight:400,builderTargetPriorityScale:2.35,counter:"잠복 고속 돌입",burrowCapable:true,burrowTrail:true,burrowTrailRequiresDetection:true,burrowRange:500,burrowCooldownMs:10000,burrowDiveMs:300,burrowMoveSpeed:500,burrowEmergeRadius:100,burrowEmergeDamageScale:1,burrowAirborneMs:1000,abilityBurrowAirborneMs:2000,burrowAirborneHeight:55,meleeSplashRadius:75,meleeSplashScale:.5,abilityFlatArmor:15,priority:{artillery:300,ranged:235,caster:260,support:280,skirmisher:220},damageClass:"area"},
  deepthorn:{requiresContactTerrain:true,name:"심근가시거수",production:{totalUnits:3,batchSize:1,productionSeconds:10,mineral:100,gas:200},abilityResearchGrade:"core",tier:3,mineralCost:0,supply:8,buildTimeMs:9250,hp:600,atk:60,range:300,speed:25,cooldownMs:1500,attackWindupMs:400,size:30,sizeClass:"heavy",attackVisual:{sourceMotion:"thrust",travel:"none",impact:"pierce"},role:"controller",sight:400,counter:"초장거리 지중 송곳",canAttackGround:true,canAttackAir:false,spikeRadius:50,spikeSplashScale:.6,airborneMs:1000,airborneHeight:50,abilityRangeMultiplier:1.5,secondaryDelayMs:300,secondaryRadius:50,secondaryOffsetRadius:100,secondaryCount:3,secondaryAngleStepDeg:120,secondaryDamageScale:.5,secondaryAirborneScale:.5,secondaryAirborneHeight:25,damageClass:"area"},

  // AIR T1 - 이동 자유도 자체가 능력치이므로 지상 동티어보다 개체 스펙/총량을 낮춘다.
  flowerbee:{name:"꽃벌",production:{totalUnits:8,batchSize:2,productionSeconds:10,mineral:50,gas:50},abilityResearchGrade:"standard",airVisualMotion:"flutter",airAttackFx:"sting",tier:1,mineralCost:0,supply:2,buildTimeMs:3750,hp:75,atk:15,range:25,speed:75,cooldownMs:750,size:10,sizeClass:"light",attackVisual:{sourceMotion:null,travel:"projectile",impact:"pierce"},role:"airfighter",sight:325,counter:"기본형 공중 근접 · 연구 시 공중 편대 합류 가속",layer:"AIR",canAttackGround:true,canAttackAir:true,airHeight:35,formationJoinRadius:250,formationJoinPct:120,formationJoinRequiresAbility:true,formationJoinMinCluster:2},
  sporefly:{name:"포자파리",production:{totalUnits:12,batchSize:3,productionSeconds:10,mineral:50,gas:75},abilityResearchGrade:"standard",airVisualMotion:"swarm",airAttackFx:"spore-bite",tier:1,mineralCost:0,supply:1,buildTimeMs:3250,hp:25,atk:5,range:25,speed:75,cooldownMs:500,size:5,sizeClass:"light",attackVisual:{sourceMotion:null,travel:"projectile",impact:"light"},role:"airswarm",sight:275,counter:"물량 공중 근접",layer:"AIR",canAttackGround:true,canAttackAir:true,airHeight:30,abilityTurnLimitedFlight:{engageRadius:150,speedPct:200,turnDegPerSecond:450,attackHalfAngleDeg:120,orbitRadius:35,orbitDirection:"idSplit"}},
  gustmayfly:{name:"돌풍하루살이",production:{totalUnits:6,batchSize:2,productionSeconds:10,mineral:25,gas:50},abilityResearchGrade:"standard",airVisualMotion:"glide",airAttackFx:"gust-slash",tier:1,mineralCost:0,supply:2,buildTimeMs:4000,hp:50,atk:10,range:25,speed:125,cooldownMs:750,size:10,sizeClass:"light",attackVisual:{sourceMotion:null,travel:"projectile",impact:"light"},role:"airscout",sight:350,counter:"초고속 합류 · 연구 시 비전투 가속",layer:"AIR",canAttackGround:true,canAttackAir:true,airHeight:40,outOfCombatRampMs:3000,outOfCombatMaxSpeedPct:180,outOfCombatRampRequiresAbility:true,outOfCombatResetOnCombat:true},
  lanternmoth:{name:"등불나방",production:{totalUnits:4,batchSize:1,productionSeconds:10,mineral:25,gas:100},abilityResearchGrade:"light",airVisualMotion:"moth",airAttackFx:"lantern",airSupportFx:"detection",tier:1,mineralCost:0,supply:2,buildTimeMs:4250,hp:50,atk:10,range:150,speed:75,cooldownMs:1000,size:10,sizeClass:"light",attackVisual:{sourceMotion:null,travel:"projectile",impact:"arcane"},role:"airsupport",sight:450,projectile:225,counter:"공중 관측 · 연구 시 비중첩 시야 오라",layer:"AIR",canAttackGround:true,canAttackAir:true,detectRadius:200,airHeight:35,sightAuraRadius:225,sightAuraPct:125},

  // AIR T2
  sporemoth:{name:"포자나방",production:{totalUnits:4,batchSize:1,productionSeconds:10,mineral:50,gas:125},abilityResearchGrade:"standard",airVisualMotion:"heavy-moth",airAttackFx:"spore-bomb",tier:2,mineralCost:0,supply:4,buildTimeMs:6250,hp:100,atk:30,range:150,speed:50,cooldownMs:1250,attackWindupMs:350,size:15,sizeClass:"light",attackVisual:{sourceMotion:null,travel:"projectile",impact:"explosive"},role:"airbomber",sight:350,projectile:175,splash:75,counter:"지상 광역 폭격",layer:"AIR",canAttackGround:true,canAttackAir:false,projectileArc:25,projectileRadius:5,airHeight:50,burstIntervalMs:250,burstSecondScale:.6,damageClass:"area"},
  hunterwasp:{name:"사냥말벌",production:{totalUnits:6,batchSize:2,productionSeconds:10,mineral:125,gas:50},abilityResearchGrade:"standard",airVisualMotion:"wasp",airAttackFx:"wasp-sting",airSupportFx:"rapid-sting",tier:2,mineralCost:0,supply:4,buildTimeMs:6250,hp:200,atk:15,range:25,speed:75,cooldownMs:500,attackWindupMs:150,size:15,sizeClass:"medium",attackVisual:{sourceMotion:null,travel:"projectile",impact:"pierce"},role:"airfighter",sight:400,counter:"정예 근접 비행",layer:"AIR",canAttackGround:true,canAttackAir:true,airHeight:45,abilityAttackCooldownResetChance:.5},
  sailwing:{name:"돛날개벌레",production:{totalUnits:4,batchSize:1,productionSeconds:10,mineral:25,gas:100},abilityResearchGrade:"light",airVisualMotion:"sail",airAttackFx:"wind-seed",airSupportFx:"mobility",tier:2,mineralCost:0,supply:4,buildTimeMs:6750,hp:100,atk:10,range:100,speed:50,cooldownMs:1000,size:15,sizeClass:"medium",attackVisual:{sourceMotion:null,travel:"projectile",impact:"light"},role:"airsupport",sight:400,projectile:200,counter:"주변 아군의 이동을 가속하는 공중 지원병",layer:"AIR",canAttackGround:true,canAttackAir:true,mobilityAuraRadius:150,mobilityAuraPct:150,abilityMobilityAuraRadius:275,abilityMobilityAuraPct:200,airHeight:50},

  // AIR T3 - 단순 수치가 아니라 전투 규칙을 바꾸는 게임체인저.
  ancientmistray:{name:"고대안개가오리",production:{totalUnits:2,batchSize:1,productionSeconds:15,mineral:75,gas:225},abilityResearchGrade:"core",airVisualMotion:"ray",airAttackFx:"mist",airSupportFx:"cloak",tier:3,mineralCost:0,supply:9,buildTimeMs:10000,hp:325,atk:20,range:200,speed:25,cooldownMs:1250,attackWindupMs:250,size:30,sizeClass:"medium",attackVisual:{sourceMotion:null,travel:"projectile",impact:"arcane"},role:"airsupport",sight:450,projectile:200,counter:"주변 아군을 은폐하고 연구 후 주력 진형을 따라가는 공중 지원병",layer:"AIR",canAttackGround:true,canAttackAir:true,cloakAuraRadius:200,cloakAuraExcludeSameType:true,adaptiveFormationCacheMs:500,airHeight:70},
  hivecarrier:{requiresContactTerrain:true,name:"군락모함",production:{totalUnits:1,batchSize:1,productionSeconds:15,mineral:300,gas:150},abilityResearchGrade:"light",abilityResearchCost:250,abilityResearchGasCost:250,airVisualMotion:"carrier",airSupportFx:"carrier",tier:3,mineralCost:0,supply:10,buildTimeMs:10750,hp:425,atk:0,range:0,speed:25,cooldownMs:1000,size:35,sizeClass:"heavy",attackVisual:{sourceMotion:"smash",travel:"none",impact:"light"},role:"carrier",sight:450,ownsSummonedUnits:true,counter:"공생 비행충을 출격시키고 부상 개체를 회수·회복하는 공중 모함",layer:"AIR",canAttackGround:false,canAttackAir:false,carrierMax:8,summonType:"carriermite",carrierRespawnMs:4000,abilityCarrierRespawnMs:500,carrierRespawnManaCost:40,abilityCarrierRespawnManaCostPct:75,carrierRadius:650,airHeight:75,usesMana:true,manaMax:250,manaRegenPerSecond:10},
  carriermite:{name:"공생 비행충",airVisualMotion:"drone",airAttackFx:"drone-sting",tier:0,mineralCost:0,supply:0,buildTimeMs:0,hp:80,atk:10,range:75,speed:300,cooldownMs:1000,attackWindupMs:0,attackMoveRecoveryMs:0,size:5,sizeClass:"light",attackVisual:{sourceMotion:null,travel:"projectile",impact:"pierce"},role:"carrierdrone",sight:250,projectile:300,aggroRange:650,targetLeashToSummoner:true,carrierSummon:true,captureExcluded:true,recallExcluded:true,layer:"AIR",canAttackGround:true,canAttackAir:true,airHeight:40,carrierRetreatHpPct:50,carrierRecoverHpPctPerSecond:100,carrierDockRadius:75,turnLimitedFlight:{turnDegPerSecond:360,attackHalfAngleDeg:90}}
};
  static get(type){return this.all[type]||null}
  static has(type){return !!this.all[type]}
  static manaMax(type){const d=this.get(type);return Math.max(0,Number(d?.manaMax)||0)}
  static manaRegen(type){
    const d=this.get(type)||{};
    if(this.manaMax(type)<=0)return 0;
    return Math.max(0,Math.round(Number(d.manaRegenPerSecond??DEFAULT_UNIT_MANA_REGEN_PER_SECOND)||0));
  }
  static initialMana(type){
    const d=this.get(type)||{},max=this.manaMax(type);
    if(max<=0)return 0;
    const ratio=RangeUtil.clamp(Number(d.manaInitialRatio??DEFAULT_UNIT_MANA_INITIAL_RATIO)||0,0,1);
    return Math.max(0,Math.min(max,Math.round(max*ratio)));
  }
  static manaRegenSchedule(type,tps=SIM_TPS){
    const perSecond=this.manaRegen(type);
    if(perSecond<=0)return null;
    const g=IntegerMathUtil.integerGcd(tps,perSecond);
    return {intervalTicks:Math.max(1,Math.round(tps/g)),amount:Math.max(1,Math.round(perSecond/g))};
  }
  static productionProfile(type){
    const p=this.get(type)?.production;
    return p?{totalUnits:p.totalUnits,batchSize:p.batchSize,productionMs:p.productionSeconds*1000,productionTicks:SimulationTiming.msToTicks(p.productionSeconds*1000,SIM_TPS)}:null;
  }
  static productionCost(type){
    const c=this.get(type)?.production;
    if(c)return{mineral:Math.max(0,Number(c.mineral)||0),gas:Math.max(0,Number(c.gas)||0)};
    const tier=this.get(type)?.tier||0;
    const building=Object.keys(BuildingDefinition.all).find(id=>BuildingDefinition.get(id)?.productionFacility&&((BuildingDefinition.get(id)?.requiresTech||0)>=3)===(tier>=3));
    return{mineral:Math.max(0,Number(BuildingDefinition.get(building)?.cost)||0),gas:0};
  }
  static productionMineralCost(type){return this.productionCost(type).mineral}
  static productionGasCost(type){return this.productionCost(type).gas}
  static damageClass(type){
    const d=this.get(type);if(!d)return"normal";
    if(d.damageClass)return d.damageClass;
    if((d.range||0)>=250)return"ranged";
    return"melee";
  }
}
for(const def of Object.values(UnitDefinition.all)){
  if(!def)continue;
  if(Number.isFinite(Number(def.cooldownMs)))def.cooldown=Number(def.cooldownMs)/1000;
  if(Number.isFinite(Number(def.healCooldownMs)))def.healCooldown=Number(def.healCooldownMs)/1000;
  if(Number.isFinite(Number(def.airCooldownMs)))def.airCooldown=Number(def.airCooldownMs)/1000;
}

const ECONOMY_WORKER_TYPE=Object.keys(UnitDefinition.all).find(type=>UnitDefinition.get(type)?.economyWorker);
if(!ECONOMY_WORKER_TYPE)throw new Error("[RALLY] economy worker unit definition is required");
const ECONOMY_WORKER_DEF=UnitDefinition.get(ECONOMY_WORKER_TYPE);
if(typeof document!=="undefined")queueMicrotask(()=>{
  document.querySelectorAll("[data-wiki-worker-cost]").forEach(el=>el.textContent=String(WORKER_COST));
  document.querySelectorAll("[data-wiki-worker-supply]").forEach(el=>el.textContent=String(ECONOMY_WORKER_DEF.supply||0));
  document.querySelectorAll("[data-wiki-start-workers]").forEach(el=>el.textContent=String(STARTING_WORKER_COUNT));
});
const UNIT_RUNTIME_GEOMETRY=Object.freeze(Object.fromEntries(
  Object.entries(UnitDefinition.all).map(([type,d])=>[type,Object.freeze({
    radius:Math.max(1,(d?.size||10)*COLLISION_RADIUS_SCALE),
    radiusFP:Math.max(FP,Math.round((d?.size||10)*COLLISION_RADIUS_SCALE*FP)),
    mass:Math.max(1,(d?.size||10)*(d?.size||10)),
    layer:d?.layer||"GROUND"
  })])
));

// 모든 유닛은 하나의 물리 레이어(GROUND/AIR)와 독립적인 대지/대공 공격 체크를 가진다.
// 기존 지상 유닛은 기본 GROUND이며, 직사 원거리만 명시적으로 대공을 허용한다.
for(const [type,d] of Object.entries(UnitDefinition.all)){
  if(Number(d?.carrierMax)>0&&(!Number.isFinite(d.carrierRadius)||d.carrierRadius<=0)){
    throw new Error(`[RALLY] ${type}.carrierRadius must be a positive finite number`);
  }
}

for(const d of Object.values(UnitDefinition.all)){
  if(!d.layer)d.layer="GROUND";
  if(d.canAttackGround==null)d.canAttackGround=(d.atk||0)>0;
  if(d.canAttackAir==null)d.canAttackAir=false;
}

// Burrow behavior is owned by BurrowableMixin. No global unit capability helpers.

// Reusable authoritative unit mana contract. Units opt in with usesMana/manaMax.
// Data stays human-readable as mana/second; runtime derives an exact integer tick cadence.
const DEFAULT_UNIT_MANA_REGEN_PER_SECOND=10;
const DEFAULT_UNIT_MANA_INITIAL_RATIO=.20;

class IntegerMathUtil{
  static integerGcd(a,b){
    a=Math.abs(Math.round(Number(a)||0));b=Math.abs(Math.round(Number(b)||0));
    while(b){const t=a%b;a=b;b=t}
    return a||1;
  }
}

const COMBAT_UNITS=Object.keys(UnitDefinition.all).filter(id=>Number(UnitDefinition.get(id)?.tier)>0&&!UnitDefinition.get(id)?.economyWorker);

class UnitVisualDefinition{
  

  static all={
  worker:{
    family:"worker",shape:"round",crest:"helmet",weapon:"pickaxe",
    accent:[.96,.70,.20,1],fx:"gather"
  },
  rice:{family:"grain",billboard:true,visualScale:.85,accent:[.96,.94,.86,1],fx:"melee"},
  soybean:{family:"grain",billboard:true,visualScale:1,accent:[.50,.69,.27,1],fx:"melee"},
  redbean:{family:"grain",billboard:true,visualScale:.9,accent:[.66,.20,.23,1],fx:"melee"},
  swordsman:{
    family:"leafblade",shape:"seed",crest:"leaf",weapon:"leafblade",
    accent:[.52,.82,.31,1],fx:"melee"
  },
  pikeman:{
    family:"thorn-reed",facing:"full",shape:"sprout",crest:"spear",weapon:"thorn-stem",
    accent:[.72,.88,.42,1],fx:"pierce"
  },
  archer:{
    family:"seedbow",facing:"full",shape:"bud",crest:"leaf",weapon:"seedbow",
    accent:[.42,.76,.34,1],fx:"pierce"
  },
  fireant:{commonGroundBody:false,
    family:"fire-ant",facing:"full",shape:"bug",crest:"antenna",weapon:"acid-gland",
    accent:[.88,.30,.12,1],fx:"pierce"
  },
  skirmisher:{
    family:"spore-gunner",facing:"full",shape:"pod",crest:"coil",weapon:"spore-pod",
    accent:[.32,.86,.72,1],fx:"bullet"
  },
  shellbug:{family:"t1-shell",shape:"vehicle",crest:"shell",weapon:"body",accent:[.62,.76,.37,1],fx:"guard"},
  stingbug:{family:"t1-sting",shape:"vehicle",crest:"stinger",weapon:"stinger",accent:[.88,.72,.28,1],fx:"pierce"},
  dandelion:{family:"t1-runner",shape:"vehicle",crest:"tuft",weapon:"body",accent:[.92,.94,.72,1],fx:"melee"},
  thornfruit:{family:"t1-thorn",shape:"vehicle",crest:"thorns",weapon:"body",accent:[.64,.82,.31,1],fx:"guard"},
  kickhopper:{family:"t1-kickhopper",shape:"bug",crest:"hopper",weapon:"hindlegs",accent:[.76,.88,.30,1],fx:"melee"},
  tank:{
    family:"shell-guardian",shape:"shell",crest:"shield",weapon:"shell",
    accent:[.58,.76,.34,1],fx:"guard"
  },
  rogue:{
    family:"shadow-flea",facing:"full",shape:"bug",crest:"leaf",weapon:"forelegs",
    accent:[.72,.64,.28,1],fx:"slash"
  },
mage:{
    family:"burst-flower",shape:"petal",crest:"orb",weapon:"pollen",
    accent:[.82,.46,.88,1],fx:"magic"
  },
  lancer:{
    family:"stag-rider",facing:"full",shape:"beetle",crest:"horn",weapon:"mandible",
    accent:[.94,.64,.24,1],fx:"pierce"
  },
  medic:{
    family:"dew-healer",shape:"petal",crest:"leaf",weapon:"dew",
    accent:[.42,.90,.65,1],fx:"heal"
  },
  mantis:{
    family:"veil-mantis",shape:"leaf",crest:"mantis",weapon:"scythes",
    accent:[.47,.94,.43,1],fx:"ambush"
  },
  pillbug:{
    family:"controller",shape:"round",crest:"coil",weapon:"bomb",
    accent:[.90,.66,.24,1],fx:"heavy"
  },
  rootstalker:{family:"controller",shape:"bulb",crest:"root",weapon:"spikes",accent:[.66,.43,.20,1],fx:"pierce"},
  chainflower:{family:"caster",shape:"petal",crest:"arc",weapon:"chain",accent:[.62,.86,1,1],fx:"magic"},
  guardshroom:{family:"support",shape:"mushroom",crest:"cap",weapon:"aura",accent:[.72,.48,.92,1],fx:"guard"},
  sporeherd:{family:"support",shape:"seed",crest:"pod",weapon:"spores",accent:[.74,.82,.35,1],fx:"spawn"},
  clawhunter:{family:"controller",shape:"round",crest:"claw",weapon:"claw",accent:[.94,.58,.28,1],fx:"pull"},
  siege:{
    family:"seed-artillery",facing:"full",shape:"rooted-pod",crest:"seed",weapon:"seed-cannon",
    accent:[.88,.70,.28,1],fx:"heavy"
  },
  rocket:{
    family:"firework-flower",facing:"full",shape:"flower-pod",crest:"bloom",weapon:"firework-seeds",
    accent:[1,.50,.30,1],fx:"heavy"
  },
  shelltitan:{family:"ancient-shell-colossus",facing:"full",shape:"massive-carapace",crest:"small-head",weapon:"body-slam",accent:[.78,.64,.34,1],fx:"heavy"},
  swarmbug:{family:"t3-swarm",shape:"bug",crest:"swarm",weapon:"mandible",accent:[.72,.82,.30,1],fx:"melee"},
  aegisbeetle:{family:"shield-beetle",shape:"broad-scutellum",crest:"shield-dome",weapon:"intercept-nodes",accent:[.40,.82,1,1],fx:"guard",interceptorVisual:{nodeCount:4,nodeRadiusScale:.075,shellPulse:true,arcOrigin:"shell-node"}},
  burrowbeast:{family:"t3-burrow",facing:"full",shape:"beast",crest:"mandible",weapon:"burrow",accent:[.76,.48,.24,1],fx:"heavy"},
  deepthorn:{family:"deep-root-colossus",facing:"full",shape:"rooted-spike-crown",crest:"giant-thorn",weapon:"subterranean-spike",accent:[.54,.78,.28,1],fx:"heavy"},
  flowerbee:{family:"air-bee",shape:"bug",crest:"petal",weapon:"sting",accent:[.96,.72,.24,1],fx:"air"},
  sporefly:{family:"air-fly",shape:"bug",crest:"spore",weapon:"bite",accent:[.62,.78,.28,1],fx:"air"},
  gustmayfly:{family:"air-mayfly",shape:"bug",crest:"wing",weapon:"bite",accent:[.42,.86,.92,1],fx:"air"},
  lanternmoth:{family:"air-moth",shape:"petal",crest:"orb",weapon:"light",accent:[1,.86,.38,1],fx:"air"},
  sporemoth:{family:"air-bomber",shape:"petal",crest:"spore",weapon:"bomb",accent:[.72,.52,.84,1],fx:"air"},
  hunterwasp:{family:"air-wasp",facing:"full",shape:"bug",crest:"blade",weapon:"sting",accent:[1,.50,.24,1],fx:"air"},
  sailwing:{family:"air-sail",shape:"leaf",crest:"wing",weapon:"wind",accent:[.42,.82,.72,1],fx:"air"},
  ancientmistray:{family:"air-ray",facing:"full",shape:"leaf",crest:"veil",weapon:"mist",accent:[.58,.80,.92,1],fx:"cloak"},
  hivecarrier:{family:"air-carrier",shape:"seed",crest:"pod",weapon:"drones",accent:[.74,.64,.34,1],fx:"spawn"},
  carriermite:{family:"air-drone",facing:"full",shape:"bug",crest:"none",weapon:"sting",accent:[.84,.72,.30,1],fx:"air"},
  ancientbear:{visualScale:1.28},
  deathworm:{visualScale:1.28,objectiveFxStyle:"worm"},
  wildhound:{commonGroundBody:false,visualScale:1.28,dark:[.19,.27,.14,1],accent:[.83,.94,.43,1]},
  boar:{commonGroundBody:false,visualScale:1.28,dark:[.25,.18,.11,1],accent:[.88,.68,.36,1]},
  sporetoad:{commonGroundBody:false,visualScale:1.28,dark:[.20,.30,.16,1],accent:[.78,.92,.48,1],breathVfxPreset:"poisonBreath",breathTellColor:"#e9ff82"},
  shellcrab:{commonGroundBody:false,visualScale:1.28,dark:[.27,.17,.11,1],accent:[.92,.68,.34,1]},
  queenwasp:{visualScale:1.28},
  seedwasp:{commonGroundBody:false,visualScale:1.28,dark:[.24,.18,.10,1],accent:[.95,.86,.48,1]},
  dragon:{visualScale:1.28,facing:"full",specialMouthPose:true,objectiveFxStyle:"dragon",breathVfxPreset:"fireBreath",breathTellColor:"#ffe075"},
  greatbear:{commonGroundBody:false,visualScale:1.28,dark:[.21,.15,.10,1],accent:[.82,.63,.34,1],minimapNeutralRadius:2.8},
};
  static get(id){return this.all[id]||null}
}

// Faction supplies colors only; species owns body geometry, scale and materials.
class UnitFactionPalette{
  static all={
    friendly:{body:[.18,.43,.93,1],dark:[.07,.19,.46,1],light:[.48,.68,1,1],ring:[.32,.58,1,.58]},
    enemy:{body:[.89,.28,.28,1],dark:[.48,.08,.10,1],light:[1,.55,.55,1],ring:[1,.35,.35,.58]},
    neutral:{body:[.48,.35,.22,1],dark:[.25,.18,.12,1],light:[.72,.57,.34,1],ring:[.76,.61,.28,.46]}
  };
  static get(relation){return this.all[relation]}
}

export { COMBAT_UNITS, ECONOMY_WORKER_DEF, ECONOMY_WORKER_TYPE, UNIT_RUNTIME_GEOMETRY, UnitDefinition, UnitFactionPalette, UnitVisualDefinition };
