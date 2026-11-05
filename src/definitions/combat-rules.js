// Combat, spawn and capture tuning constants.
const DEAD_ENTITY_CLEANUP_MS=1000;
// Combat targeting stability: keep a valid current target unless a new candidate
// is meaningfully better. Artillery minimum range is evaluated during acquisition,
// not only after a target has already been chosen.
const COMBAT_TARGET_STICKINESS_PCT=120;
// Full acquisition is staggered by stable unit ID. Movement, legal-fire gates,
// wind-up and cooldown still run every tick; invalid targets wait for their slot.
const COMBAT_TARGET_REFRESH_MS=300;
// Common attack grammar: acquire -> wind-up -> fire/hit -> cooldown.
// Any range break during wind-up cancels the attack for both melee and ranged.
// Airborne also clears wind-up immediately at the moment the status is applied.
// Post-attack recovery locks MOVEMENT only; stationary firing cadence/DPS is unchanged.
const DEFAULT_ATTACK_WINDUP_MS=200;
const DEFAULT_MELEE_MOVE_RECOVERY_MS=150;
const DEFAULT_RANGED_MOVE_RECOVERY_MS=200;
const NAV_BUILDING_MARGIN=6;
const SPAWN_UNIT_GAP=5;

// 전략 맵: 메인 대각선과 평행한 TOP / MID / BOT 세 전선.
// 각 전선의 중앙에 점령지가 있고, 점령하면 그 자리에 전진 거점이 생긴다.
const CAPTURE_RADIUS=175;

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

// Damage multiplier by attacker damageClass and target sizeClass (percent).
const DAMAGE_CLASS_MATRIX={
  smallSpecialist:{light:100,medium:50,heavy:25},
  normal:{light:100,medium:100,heavy:100},
  area:{light:50,medium:75,heavy:100}
};

export { CAPTURE_RADIUS, COMBAT_TARGET_REFRESH_MS, COMBAT_TARGET_STICKINESS_PCT, DAMAGE_CLASS_MATRIX, DEAD_ENTITY_CLEANUP_MS, DEFAULT_ATTACK_WINDUP_MS, DEFAULT_MELEE_MOVE_RECOVERY_MS, DEFAULT_RANGED_MOVE_RECOVERY_MS, LANE_CONTROL_POINTS, NAV_BUILDING_MARGIN, SPAWN_UNIT_GAP };
