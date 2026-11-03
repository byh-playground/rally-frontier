// Combat, spawn, capture and spell tuning constants.
const DEAD_ENTITY_CLEANUP_MS=1000;
// Combat targeting stability: keep a valid current target unless a new candidate
// is meaningfully better. Artillery minimum range is evaluated during acquisition,
// not only after a target has already been chosen.
const COMBAT_TARGET_STICKINESS_PCT=120;
// Full acquisition is staggered by stable unit ID. Movement, legal-fire gates,
// wind-up and cooldown still run every tick; invalid targets wait for their slot.
const COMBAT_TARGET_REFRESH_MS=300;
const COMBAT_IDEAL_RANGE_REPOSITION_MARGIN=8;
// Common attack grammar: acquire -> wind-up -> fire/hit -> cooldown.
// Any range break during wind-up cancels the attack for both melee and ranged.
// Airborne also clears wind-up immediately at the moment the status is applied.
// Post-attack recovery locks MOVEMENT only; stationary firing cadence/DPS is unchanged.
const DEFAULT_ATTACK_WINDUP_MS=200;
const DEFAULT_MELEE_MOVE_RECOVERY_MS=150;
const DEFAULT_RANGED_MOVE_RECOVERY_MS=200;
const DEFAULT_ARTILLERY_MOVE_RECOVERY_MS=350;
const NAV_BUILDING_MARGIN=6;
const SPAWN_CLEARANCE=22;
const SPAWN_UNIT_GAP=5;
const SUMMON_SPAWN_ACTION_GRACE_MS=200;
const PRODUCTION_CLUSTER_RADIUS=250;
const DEFENSE_CLUSTER_RADIUS=250;
const BUILD_START_HP_PCT=10;
const BUILDER_INTERACTION_PADDING=3;
const MINERAL_BUILD_MARGIN=16;
// 같은 편 생산건물이 이 반경 안에 몇 개 있느냐에 따른 생산속도(%)
const PRODUCTION_CLUSTER_SPEED_PCT=Object.freeze([100,85,70,55]);

// 전략 맵: 메인 대각선과 평행한 TOP / MID / BOT 세 전선.
// 각 전선의 중앙 점령지 주변에는 별도의 오브젝트 캠프가 존재한다.
const CAPTURE_RADIUS=175;
const CAPTURE_DURATION_MS=10000;
const CAPTURE_DECAY_PER_TICK=1;
const SPELL_CAST_MARGIN=250;
const SPELL_MASTERY_MAX=2;
const SPELL_SLOT_MAX=3;
const TACTICAL_CHEST_OPTION_COUNT=3;

// 롤식 3축: TOP=좌측 상단, MID=중앙, BOT=우측 하단.
const LANE_CONTROL_POINTS={
  top:[
    {x:380,y:2940},
    {x:560,y:2240},
    {x:760,y:1460},
    {x:1140,y:760},
    {x:1880,y:470},
    {x:2660,y:560},
    {x:3200,y:1020}
  ],
  mid:[
    {x:520,y:3550},
    {x:940,y:3020},
    {x:1360,y:2540},
    {x:1800,y:2100},
    {x:2240,y:1660},
    {x:2660,y:1180},
    {x:3080,y:650}
  ],
  bot:[
    {x:980,y:3740},
    {x:1430,y:3640},
    {x:2070,y:3390},
    {x:2660,y:2960},
    {x:3070,y:2330},
    {x:3270,y:1590},
    {x:3220,y:960}
  ]
};

export { BUILDER_INTERACTION_PADDING, BUILD_START_HP_PCT, CAPTURE_DECAY_PER_TICK, CAPTURE_DURATION_MS, CAPTURE_RADIUS, COMBAT_IDEAL_RANGE_REPOSITION_MARGIN, COMBAT_TARGET_REFRESH_MS, COMBAT_TARGET_STICKINESS_PCT, DEAD_ENTITY_CLEANUP_MS, DEFAULT_ARTILLERY_MOVE_RECOVERY_MS, DEFAULT_ATTACK_WINDUP_MS, DEFAULT_MELEE_MOVE_RECOVERY_MS, DEFAULT_RANGED_MOVE_RECOVERY_MS, DEFENSE_CLUSTER_RADIUS, LANE_CONTROL_POINTS, MINERAL_BUILD_MARGIN, NAV_BUILDING_MARGIN, PRODUCTION_CLUSTER_RADIUS, PRODUCTION_CLUSTER_SPEED_PCT, SPAWN_CLEARANCE, SPAWN_UNIT_GAP, SPELL_CAST_MARGIN, SPELL_MASTERY_MAX, SPELL_SLOT_MAX, SUMMON_SPAWN_ACTION_GRACE_MS, TACTICAL_CHEST_OPTION_COUNT };
