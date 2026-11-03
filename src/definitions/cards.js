// Spell, passive, composition and neutral camp definitions.
import { RangeUtil } from '../core/game-rules.js';
import { UnitDefinition } from './units.js';
import { SPELL_CAST_MARGIN, SPELL_MASTERY_MAX } from './combat-rules.js';
import { SimulationTiming } from '../main.js';

class SpellDefinition{
  static spellLevelRuntime(level,tps){
  const out={...level};
  for(const [msKey,tickKey] of [["cooldownMs","cooldown"],["delayMs","delay"],["buildTimeMs","buildTime"],["durationMs","duration"],["slowDurationMs","slowDuration"]]){
    if(Number.isFinite(Number(out[msKey])))out[tickKey]=SimulationTiming.msToTicks(out[msKey],tps);
  }
  if(out.continuous){
    out.continuous={...out.continuous};
    out.duration=SimulationTiming.msToTicks(out.continuous.durationMs,tps);
    out.damageIntervalTicks=SimulationTiming.msToTicks(out.continuous.damageIntervalMs,tps);
  }
  return out;
}

  static all={
  meteor:{
    id:"meteor",name:"메테오",icon:"☄",category:"화력",
    desc:"3초 예고 후 범위 폭격 · 생산시설과 밀집 병력 압박",
    castMargin:SPELL_CAST_MARGIN,
    levels:[
      {cooldownMs:90000,radius:200,delayMs:3000,unitDamage:165,buildingPct:100},
      {cooldownMs:80000,radius:225,delayMs:3000,unitDamage:180,buildingPct:110},
      {cooldownMs:70000,radius:250,delayMs:3000,unitDamage:200,buildingPct:120}
    ]
  },
  tunnel:{
    id:"tunnel",name:"땅굴",icon:"⛏",category:"기동",
    desc:"두 지점을 연결해 일정 시간 병력을 단방향 수송",
    castMargin:SPELL_CAST_MARGIN,
    levels:[
      {cooldownMs:110000,buildTimeMs:10000,durationMs:35000,entryRadius:50,throughputSupplyPerSec:4},
      {cooldownMs:100000,buildTimeMs:9000,durationMs:40000,entryRadius:75,throughputSupplyPerSec:5},
      {cooldownMs:90000,buildTimeMs:8000,durationMs:45000,entryRadius:75,throughputSupplyPerSec:6}
    ]
  },
  flare:{
    id:"flare",name:"정찰 신호탄",icon:"◉",category:"정보",
    desc:"일정 시간 광역 시야와 Detection 확보",
    castMargin:320,
    levels:[
      {cooldownMs:65000,durationMs:18000,vision:450},
      {cooldownMs:60000,durationMs:22000,vision:500},
      {cooldownMs:50000,durationMs:26000,vision:550}
    ]
  },
  march:{
    id:"march",name:"진군 가속",icon:"➤",category:"기동",
    desc:"지정 지역 아군의 이동속도를 크게 증가",
    castMargin:SPELL_CAST_MARGIN,
    levels:[
      {cooldownMs:80000,durationMs:15000,radius:250,speedPct:135},
      {cooldownMs:70000,durationMs:17000,radius:275,speedPct:140},
      {cooldownMs:65000,durationMs:19000,radius:300,speedPct:150}
    ]
  },
  healspore:{
    id:"healspore",name:"회복 포자",icon:"✚",category:"생존",
    desc:"지정 지역 아군 전투 유닛을 지속 회복",
    castMargin:SPELL_CAST_MARGIN,
    levels:[
      {cooldownMs:90000,durationMs:14000,radius:225,healPerSecond:20},
      {cooldownMs:80000,durationMs:16000,radius:250,healPerSecond:25},
      {cooldownMs:70000,durationMs:18000,radius:275,healPerSecond:30}
    ]
  },
  rootbind:{
    id:"rootbind",name:"속박 뿌리",icon:"╫",category:"제어",
    desc:"범위 적의 이동속도를 장시간 크게 감소",
    castMargin:SPELL_CAST_MARGIN,
    levels:[
      {cooldownMs:85000,radius:200,slowDurationMs:4000,slowPct:45},
      {cooldownMs:75000,radius:225,slowDurationMs:5000,slowPct:45},
      {cooldownMs:70000,radius:250,slowDurationMs:6000,slowPct:45}
    ]
  },
  sporestorm:{
    id:"sporestorm",name:"포자 폭풍",icon:"☁",category:"화력",
    desc:"일정 시간 지역에 포자 피해를 반복해 밀집 병력을 압박",
    castMargin:SPELL_CAST_MARGIN,
    levels:[
      {cooldownMs:95000,radius:200,continuous:{dps:30,damageIntervalMs:500,durationMs:12000}},
      {cooldownMs:85000,radius:225,continuous:{dps:40,damageIntervalMs:500,durationMs:14000}},
      {cooldownMs:75000,radius:250,continuous:{dps:50,damageIntervalMs:500,durationMs:16000}}
    ]
  },
  thornwall:{
    id:"thornwall",name:"가시 장벽",icon:"✣",category:"방어/제어",
    desc:"가시 지대를 만들어 안의 적을 감속하고 지속 피해",
    castMargin:SPELL_CAST_MARGIN,
    levels:[
      {cooldownMs:90000,radius:175,continuous:{dps:10,damageIntervalMs:500,durationMs:12000},slowPct:45},
      {cooldownMs:80000,radius:175,continuous:{dps:20,damageIntervalMs:500,durationMs:14000},slowPct:45},
      {cooldownMs:70000,radius:200,continuous:{dps:20,damageIntervalMs:500,durationMs:16000},slowPct:45}
    ]
  },
  recall:{
    id:"recall",name:"회수 포자",icon:"↶",category:"재배치",
    desc:"범위 아군을 현재 집결 깃발 주변으로 즉시 회수",
    castMargin:SPELL_CAST_MARGIN,
    levels:[
      {cooldownMs:100000,radius:200,supplyCap:20},
      {cooldownMs:90000,radius:225,supplyCap:25},
      {cooldownMs:85000,radius:250,supplyCap:30}
    ]
  }
};
  static get(id){return this.all[id]||null}
  static masteryLevel(mastery=0){return RangeUtil.clamp((Number(mastery)||0)+1,1,SPELL_MASTERY_MAX+1)}
  static statsAt(id,mastery=0){
    const d=this.get(id);if(!d)return null;
    const i=RangeUtil.clamp(Number(mastery)||0,0,SPELL_MASTERY_MAX);
    return {...d,...(d.levels?.[i]||{})};
  }
  static statRows(id,mastery=0){
    const d=this.get(id),v=this.statsAt(id,mastery);if(!d||!v)return[];
    const sec=ms=>`${(Math.max(0,Number(ms)||0)/1000).toFixed((Number(ms)||0)%1000?1:0)}`;
    const rows=[["기본 쿨다운",`${sec(v.cooldownMs)}초`]];
    if(v.radius!=null)rows.push(["반경",`${v.radius}`]);
    if(id==="meteor")rows.push(["유닛 피해",`${v.unitDamage}`],["건물 피해",`${v.buildingPct}%`]);
    if(id==="tunnel")rows.push(["굴착",`${sec(v.buildTimeMs)}초`],["유지",`${sec(v.durationMs)}초`],["수송량",`${v.throughputSupplyPerSec}/초`]);
    if(id==="flare")rows.push(["시야",`${v.vision}`],["지속",`${sec(v.durationMs)}초`]);
    if(id==="march")rows.push(["이동속도",`+${v.speedPct-100}%`],["지속",`${sec(v.durationMs)}초`]);
    if(id==="healspore")rows.push(["초당 회복",`${v.healPerSecond}`],["지속",`${sec(v.durationMs)}초`]);
    if(id==="rootbind")rows.push(["이동 감소",`-${v.slowPct}%`],["지속",`${sec(v.slowDurationMs)}초`]);
    if(id==="sporestorm")rows.push(["초당 피해",`${v.continuous?.dps||0}`],["피해 주기",`${sec(v.continuous?.damageIntervalMs||0)}초`],["지속",`${sec(v.continuous?.durationMs||0)}초`]);
    if(id==="thornwall")rows.push(["초당 피해",`${v.continuous?.dps||0}`],["피해 주기",`${sec(v.continuous?.damageIntervalMs||0)}초`],["이동 감소",`-${v.slowPct}%`],["지속",`${sec(v.continuous?.durationMs||0)}초`]);
    if(id==="recall")rows.push(["회수 보급",`${v.supplyCap}`]);
    return rows;
  }
  static upgradeRows(id,mastery=0){
    const a=this.statRows(id,mastery),b=this.statRows(id,Math.min(SPELL_MASTERY_MAX,mastery+1)),bm=new Map(b);
    return a.map(([label,value])=>[label,value,bm.get(label)??value]).filter(([,v,n])=>v!==n);
  }

  static ids=Object.keys(SpellDefinition.all);
}

const TACTICAL_ECON_REWARDS=[
  {id:"mineral-260",kind:"mineral",name:"미네랄 보급",icon:"◆",mineral:260,desc:"즉시 미네랄 260 획득"},
  {id:"mineral-440",kind:"mineral",name:"대량 미네랄 보급",icon:"◆",mineral:440,desc:"즉시 미네랄 440 획득"},
  {id:"gas-120",kind:"gas",name:"가스 보급",icon:"⬡",gas:120,desc:"즉시 가스 120 획득"},
  {id:"mixed-220-70",kind:"mixed",name:"혼합 보급",icon:"▣",mineral:220,gas:70,desc:"미네랄 220 + 가스 70 획득"}
];

class PassiveCardDefinition{
  static all={
  t1March:{id:"t1March",effect:"movePct",tier:1,name:"새싹 행군",icon:"➤",maxLevel:3,values:[10,15,20],desc:"T1 전투 유닛 이동속도 증가",statLabel:"T1 이동속도",suffix:"%"},
  t2March:{id:"t2March",effect:"movePct",tier:2,name:"숙련 군락",icon:"❯",maxLevel:3,values:[10,15,20],desc:"T2 전투 유닛 이동속도 증가",statLabel:"T2 이동속도",suffix:"%"},
  t3Vitality:{id:"t3Vitality",effect:"hpPct",tier:3,onApplyKind:"refreshCombatHp",name:"거목의 힘",icon:"♜",maxLevel:3,values:[10,15,20],desc:"T3 전투 유닛 최대 HP 증가",statLabel:"T3 최대 HP",suffix:"%"},
  armyAttack:{id:"armyAttack",effect:"attackPct",name:"날카로운 수액",icon:"⚔",maxLevel:3,values:[5,10,15],desc:"모든 아군 전투 유닛 공격력 증가",statLabel:"전군 공격력",suffix:"%"},
  armyHp:{id:"armyHp",effect:"hpPct",onApplyKind:"refreshCombatHp",name:"질긴 외피",icon:"⬢",maxLevel:3,values:[5,10,15],desc:"모든 아군 전투 유닛 최대 HP 증가",statLabel:"전군 최대 HP",suffix:"%"},
  mineralYield:{id:"mineralYield",effect:"miningPct",resource:"mineral",name:"풍요의 뿌리",icon:"◆",maxLevel:3,values:[10,15,20],desc:"미네랄 채취 효율 증가",statLabel:"미네랄 채취",suffix:"%"},
  gasYield:{id:"gasYield",effect:"miningPct",resource:"gas",name:"농축 포자",icon:"⬡",maxLevel:3,values:[10,15,20],desc:"가스 채취 효율 증가",statLabel:"가스 채취",suffix:"%"},
  vision:{id:"vision",effect:"visionPct",name:"확장 시야",icon:"◉",maxLevel:3,values:[10,15,20],desc:"모든 아군 전투 유닛 시야 증가",statLabel:"전군 시야",suffix:"%"},
  towerRange:{id:"towerRange",effect:"towerRangePct",name:"포탑 사거리 강화",icon:"⌖",maxLevel:3,values:[5,10,15],desc:"모든 방어 포탑 공격 사거리 증가",statLabel:"포탑 사거리",suffix:"%"},
  bark:{id:"bark",effect:"hitGuard",onApplyKind:"grantHitGuardOnFirstUnlock",formatKind:"blockedHits",name:"나무 껍질",icon:"◍",maxLevel:1,values:[5],desc:"모든 아군 전투 유닛이 피해 1회를 완전히 막는 타격 보호막 1회를 얻습니다.",statLabel:"타격 보호막",suffix:"회"}
};
  static get(id){return this.all[id]||null}

  static ids=Object.keys(PassiveCardDefinition.all);
}

const NEUTRAL_SIDE=2;
const CAPTURED_OBJECTIVE_SCALE=.75;
const MAIN_OBJECTIVE_RESPAWN_MS=90000;
const OBJECTIVE_DRAGON_BREATH_PHASE=Object.freeze({IDLE:"idle",TELL:"tell",ACTIVE:"active"});
const OBJECTIVE_DRAGON_BREATH_PHASES=new Set(Object.values(OBJECTIVE_DRAGON_BREATH_PHASE));

class UnitCompositionDefinition{
  static normalize(raw){
    if(raw==null)return [];
    if(!Array.isArray(raw))throw new TypeError("병력 composition은 배열이어야 합니다.");
    const out=[],byUnit=new Map();
    for(const entry of raw){
      if(!entry||typeof entry!=="object"||Array.isArray(entry))throw new TypeError("composition 항목은 {unit,count} 객체여야 합니다.");
      const unit=entry.unit,count=entry.count;
      if(typeof unit!=="string"||!Object.prototype.hasOwnProperty.call(UnitDefinition.all,unit))throw new Error(`알 수 없는 composition 병종: ${unit}`);
      if(!Number.isSafeInteger(count)||count<1)throw new Error(`composition ${unit}: 수량은 1 이상의 안전한 정수여야 합니다.`);
      const found=byUnit.get(unit);
      if(found){if(!Number.isSafeInteger(found.count+count))throw new Error(`composition ${unit}: 합산 수량 범위 초과`);found.count+=count}
      else{const row={unit,count};out.push(row);byUnit.set(unit,row)}
    }
    return out;
  }
  static expand(raw){const out=[];for(const e of this.normalize(raw))for(let i=0;i<e.count;i++)out.push(e.unit);return out}
  static first(raw){return this.normalize(raw)?.[0]?.unit||""}
  static total(raw){return this.normalize(raw).reduce((n,e)=>n+e.count,0)}
}

class CampDefinition{
  static all={
  // Passive shared-camp state machine (camp.state separately tracks alive/cooldown):
  // IDLE = !engaged && !resetting; ENGAGED = engaged && !resetting;
  // FORCED_RETURN = resetting. Only FORCED_RETURN restores HP, anywhere on its route.
  // aggroRadius   : 캠프 활동/어그로 반경. proactiveAggro 캠프에서는 IDLE 선공 탐지에도 사용하며,
  //                 교전 중에는 이탈/귀환 판정 기준으로 동일 반경을 재사용한다.
  // homeRadius    : 생존 몹 모두 각자의 원위치에서 이 거리 이내면 귀환 완료. HP 보정 없음.
  // homeSpread    : 원위치 배치 반경. UI 작은 원은 homeSpread + homeRadius로 표시.
  // gaugeGain     : 범위 밖 교전 중 tick당 증가량. 현재 TPS와 무관하게 동일한 초당 증가량을 유지하도록 시간 기준으로 환산.
  // gaugeDecay    : 전원이 범위 안에 2초 머무르면 감소. 현재 TPS와 무관하게 동일한 초당 감소량을 유지하도록 시간 기준으로 환산.
  // proactiveAggro: true면 IDLE에서도 aggroRadius 안의 공격 가능한 플레이어를 찾아 캠프 단위로 선공. 기본값 false.
  // resetHealPerSecond : 기존 정수 tick 회복량을 유지. 귀환 상태인 동안 안/밖 모두 적용.
  hounds:{minorNeutral:true,name:"가시등 스프린터 무리",clearBonus:75,respawnMs:75000,aggroRadius:200,homeRadius:25,homeSpread:75,aggroGaugeMax:1000,gaugeGain:30,gaugeDecay:20,resetHealPerSecond:.1,composition:[{unit:"wildhound",count:4}]},
  boars:{minorNeutral:true,name:"껍질멧돼지 둥지",clearBonus:150,respawnMs:100000,aggroRadius:200,homeRadius:50,homeSpread:75,aggroGaugeMax:1000,gaugeGain:30,gaugeDecay:20,resetHealPerSecond:.1,composition:[{unit:"boar",count:2}]},
  toads:{minorNeutral:true,name:"포자두꺼비 웅덩이",clearBonus:100,respawnMs:100000,aggroRadius:200,homeRadius:25,homeSpread:75,aggroGaugeMax:1000,gaugeGain:30,gaugeDecay:20,resetHealPerSecond:.1,composition:[{unit:"sporetoad",count:3}]},
  crabs:{minorNeutral:true,name:"꽃게딱지 군락",clearBonus:125,respawnMs:100000,aggroRadius:200,homeRadius:25,homeSpread:50,aggroGaugeMax:1000,gaugeGain:30,gaugeDecay:20,resetHealPerSecond:.1,composition:[{unit:"shellcrab",count:2}]},
  wasps:{minorNeutral:true,name:"씨앗날벌 둥지",clearBonus:100,respawnMs:100000,aggroRadius:200,homeRadius:25,homeSpread:75,aggroGaugeMax:1000,gaugeGain:30,gaugeDecay:20,resetHealPerSecond:.1,composition:[{unit:"queenwasp",count:3}]},
  objectiveBear:{name:"TOP · 고대곰 영역",clearBonus:0,respawnMs:MAIN_OBJECTIVE_RESPAWN_MS,aggroRadius:225,homeRadius:50,homeSpread:0,aggroGaugeMax:1000,gaugeGain:25,gaugeDecay:15,resetHealPerSecond:.10,composition:[{unit:"ancientbear",count:1}],proactiveAggro:true,mainObjective:true,laneKey:"top"},
  objectiveDeathWorm:{name:"MID · 데스웜 영역",clearBonus:0,respawnMs:MAIN_OBJECTIVE_RESPAWN_MS,aggroRadius:225,homeRadius:50,homeSpread:0,aggroGaugeMax:1000,gaugeGain:25,gaugeDecay:15,resetHealPerSecond:.10,composition:[{unit:"deathworm",count:1}],proactiveAggro:true,mainObjective:true,laneKey:"mid"},
  objectiveDragon:{name:"BOT · 드래곤 둥지",clearBonus:0,respawnMs:MAIN_OBJECTIVE_RESPAWN_MS,aggroRadius:225,homeRadius:50,homeSpread:0,aggroGaugeMax:1000,gaugeGain:25,gaugeDecay:15,resetHealPerSecond:.10,composition:[{unit:"dragon",count:1}],proactiveAggro:true,mainObjective:true,laneKey:"bot"},
  relic:{name:"전술 오브젝트",clearBonus:175,respawnMs:125000,aggroRadius:200,homeRadius:50,homeSpread:75,aggroGaugeMax:1000,gaugeGain:30,gaugeDecay:20,resetHealPerSecond:.1,composition:[{unit:"boar",count:1},{unit:"wildhound",count:2}]},
  scenarioUnitGroup:{name:"시나리오 공격 부대",scenarioObject:true,clearBonus:0,respawnMs:0,aggroRadius:200,homeRadius:25,homeSpread:45,aggroGaugeMax:1000,gaugeGain:30,gaugeDecay:20,resetHealPerSecond:0,composition:[]},
  unitNeutralObject:{name:"유닛 기반 중립 오브젝트",unitBasedNeutralObject:true,clearBonus:0,respawnMs:0,aggroRadius:200,homeRadius:25,homeSpread:45,aggroGaugeMax:1000,gaugeGain:30,gaugeDecay:20,resetHealPerSecond:.1,composition:[],proactiveAggro:true}
};
  static get(id){return this.all[id]||null}
}

class NeutralCampPolicy{
 static friendlySide(camp){return camp?.friendlySide===0||camp?.friendlySide===1?camp.friendlySide:null}
  static aggroRadius(camp){
    const radius=Number(camp?.guardRadius);
    return Number.isFinite(radius)&&radius>0?radius:(CampDefinition.get(camp?.kind)?.aggroRadius||200);
  }
  static homeSpread(camp){
    return Number.isFinite(camp?.homeSpread)?camp.homeSpread:(CampDefinition.get(camp?.kind)?.homeSpread||0);
  }
  static neutralCampRequiredAreaGap(a,b,baseGap=40){
  // Ordinary hunting grounds stay clearly isolated from everything else. Strategic
  // objective territories may sit closer to one another by map design, but their
  // aggro circles still keep a positive physical gap instead of overlapping.
  return CampDefinition.get(a?.kind)?.minorNeutral||CampDefinition.get(b?.kind)?.minorNeutral
    ?Math.max(40,Number(baseGap)||40)
    :Math.max(20,Math.round((Number(baseGap)||40)/2));
}
}

export { CAPTURED_OBJECTIVE_SCALE, CampDefinition, MAIN_OBJECTIVE_RESPAWN_MS, NEUTRAL_SIDE, NeutralCampPolicy, OBJECTIVE_DRAGON_BREATH_PHASE, OBJECTIVE_DRAGON_BREATH_PHASES, PassiveCardDefinition, SpellDefinition, TACTICAL_ECON_REWARDS, UnitCompositionDefinition };
