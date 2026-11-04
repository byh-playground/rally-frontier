// Balance grid validation and ability info.
import { ABILITY_RESEARCH_COSTS, MOVE_SPEED_STEP, ResearchDefinition, UnitSpecialResearchDefinition } from './research.js';
import { BuildingDefinition } from './buildings.js';
import { COMBAT_UNITS, UnitDefinition } from './units.js';
import { WORKER_COST } from './world-rules.js';

class BalanceValidation{
  static normalizedMoveSpeedTier(value){
  const v=Math.max(MOVE_SPEED_STEP,Number(value)||MOVE_SPEED_STEP);
  return Math.max(MOVE_SPEED_STEP,Math.round(v/MOVE_SPEED_STEP)*MOVE_SPEED_STEP);
}
  static economyCostGridEntries(){
  const rows=[["worker",WORKER_COST]];
  for(const [id,d] of Object.entries(BuildingDefinition.all))rows.push([`building:${id}:mineral`,Number(d.cost)||0]);
  for(const [id,d] of Object.entries(BuildingDefinition.all))if(Number(d.gasCost)>0)rows.push([`building:${id}:gas`,Number(d.gasCost)||0]);
  for(const [id,d] of Object.entries(UnitDefinition.all)){const c=d.production;if(!c)continue;
    rows.push([`production:${id}:mineral`,Number(c.mineral)||0]);
    rows.push([`production:${id}:gas`,Number(c.gas)||0]);
  }
  for(const kind of ["attack","armor"])for(const [i,d] of ResearchDefinition.get(kind).entries()){
    rows.push([`research:${kind}:${i+1}:mineral`,Number(d.cost)||0]);
    rows.push([`research:${kind}:${i+1}:gas`,Number(d.gasCost)||0]);
  }
  rows.push(["research:ability:base:mineral",Number(ResearchDefinition.all.ability.cost)||0]);
  rows.push(["research:ability:base:gas",Number(ResearchDefinition.all.ability.gasCost)||0]);
  for(const [grade,d] of Object.entries(ABILITY_RESEARCH_COSTS)){
    rows.push([`ability:${grade}:mineral`,Number(d.cost)||0]);
    rows.push([`ability:${grade}:gas`,Number(d.gasCost)||0]);
  }
  for(const [id,d] of Object.entries(UnitSpecialResearchDefinition.all)){
    rows.push([`special:${id}:mineral`,Number(d.cost)||0]);
    rows.push([`special:${id}:gas`,Number(d.gasCost)||0]);
  }
  return rows;
}
  static validateEconomicCostGrid(){
  const invalid=BalanceValidation.economyCostGridEntries().filter(([,cost])=>!Number.isFinite(cost)||cost<0||cost%25!==0);
  const missingProduction=COMBAT_UNITS.filter(id=>!UnitDefinition.get(id)?.production);
  const missingProfiles=COMBAT_UNITS.filter(id=>!UnitDefinition.get(id)?.production);
  console.assert(!invalid.length,`[RALLY] 25단위 비용 위반: ${invalid.map(x=>x.join("=")).join(", ")}`);
  console.assert(!missingProduction.length,`[RALLY] 생산축 가격 누락: ${missingProduction.join(", ")}`);
  console.assert(!missingProfiles.length,`[RALLY] 생산 프로필 누락: ${missingProfiles.join(", ")}`);
  return{ok:!invalid.length&&!missingProduction.length&&!missingProfiles.length,invalid,missingProduction,missingProfiles};
}
  static validateUnitMoveSpeedGrid(){
  const invalid=Object.entries(UnitDefinition.all).filter(([,d])=>Number.isFinite(Number(d?.speed))&&Number(d.speed)%MOVE_SPEED_STEP!==0).map(([id,d])=>[id,d.speed]);
  console.assert(!invalid.length,`[RALLY] ${MOVE_SPEED_STEP}단위 기본 이속 위반: ${invalid.map(x=>x.join("=")).join(", ")}`);
  return{ok:!invalid.length,invalid};
}
  static balanceGridMultiple(value,step){return Number.isFinite(Number(value))&&Math.abs(Number(value)/step-Math.round(Number(value)/step))<1e-9}
  static validateNormalizedBalanceGrid(){
  const invalid=[];
  const check=(scope,id,key,value,step)=>{
    if(typeof value!=="number"||!Number.isFinite(value))return;
    if(!BalanceValidation.balanceGridMultiple(value,step))invalid.push(`${scope}.${id}.${key}=${value}`);
  };
  for(const [id,d] of Object.entries(UnitDefinition.all)){
    check("unit",id,"hp",d.hp,25); check("unit",id,"atk",d.atk,5);
    check("unit",id,"speed",d.speed,25); check("unit",id,"range",d.range,25);
    check("unit",id,"sight",d.sight,25); if(d.projectile)check("unit",id,"projectile",d.projectile,25);
    if(d.cooldown!=null)check("unit",id,"cooldown",Number(d.cooldown)*4,1);
    check("unit",id,"size",d.size,5);
    for(const [key,value] of Object.entries(d)){
      if(key==="projectileRadius"){check("unit",id,key,value,5);continue}
      if(key==="splash"||key==="attackSplash"||key==="deathSplash"||key==="airSplash"){check("unit",id,key,value,25);continue}
      if(key==="chargeSpeed"||key==="burrowMoveSpeed"){check("unit",id,key,value,25);continue}
      if(key.endsWith("Range")||key.endsWith("Radius")||key.endsWith("Distance"))check("unit",id,key,value,25);
    }
  }
  for(const [id,d] of Object.entries(BuildingDefinition.all)){
    check("building",id,"hp",d.hp,25); if(d.atk!=null)check("building",id,"atk",d.atk,5);
    if(d.range!=null)check("building",id,"range",d.range,25);
    if(d.sight!=null)check("building",id,"sight",d.sight,25);
    if(d.projectile)check("building",id,"projectile",d.projectile,25);
    if(d.cooldown!=null)check("building",id,"cooldown",Number(d.cooldown)*4,1);
    check("building",id,"size",d.size,5);
  }
  for(const [id,d] of Object.entries(UnitDefinition.all)){const p=d.production;if(p)check("production",id,"productionSeconds",p.productionSeconds,5);}
  console.assert(!invalid.length,`[RALLY] balance-grid 위반: ${invalid.join(", ")}`);
  return{ok:!invalid.length,invalid};
}
}

const ABILITY_INFO={
  
  pikeman:{name:"창벽 강화",desc:"넉백 거리 증가 · 돌격형 적을 더 강하게 밀어내 접근을 차단"},
  
  skirmisher:{name:"포자 충격탄",desc:"기본 공격 적중마다 아주 약한 반복 넉백을 추가"},
  shellbug:{name:"웅크리기",desc:"교전 중 움직이지 않고 준비를 마치면 고정 방어력을 얻고, 이동하면 즉시 해제"},
  dandelion:{name:"바람타기",desc:"비전투 이동 가속과 얕은 다중 전선 포위 · 소규모 교전과 카이팅에는 기존 포위 접근을 사용"},
  thornfruit:{name:"가시 폭발",desc:"근접 피격 반사 · 짧은 시간에 연속 피격되면 주변 가시 폭발 · 내부 쿨다운 적용"},
  kickhopper:{name:"탄성 뒷다리",desc:"주 대상 에어본을 강화하고 착지 충격으로 주변에 광역 피해"},
  tank:{name:"겹껍질 성채",desc:"원거리 투사체 피해 감소를 추가 강화 · 근접 피해 추가 감소 없음"},
  rogue:{name:"도약 충격",desc:"도약 착지 시 지정한 주 대상에게 강화 피해 · 주변 지상 적 에어본 · 도약 후 암살 피해 버프 없음"},
  mage:{name:"중심부 과숙",desc:"폭발 중심에서 가장 강하고 바깥으로 갈수록 피해가 감소"},
  lancer:{name:"왕사슴 돌격",desc:"비전투 가속을 크게 축적 · 고속 첫 충돌에 가속 비례 넉백 추가"},
  medic:{name:"충격 이슬탄",desc:"일정 확률로 동일 피해의 곡사 충격탄을 발사해 단일 적을 밀어냄"},

  pillbug:{name:"도약 폭낭",desc:"그림자벼룩의 공통 도약 이동을 재사용해 사거리 내 적에게 뛰어든 뒤 기존 자폭 공격"},
  rootstalker:{name:"가시 융기",desc:"직선 관통 가시에 맞은 적들을 아주 짧게 에어본시켜 이동/공격을 끊음"},
  chainflower:{name:"과부하",desc:"기본 연쇄가 마지막 대상까지 이어지면 마지막 위치에 작은 범위 폭발"},
  guardshroom:{name:"고속 포자막",desc:"보호막 공급 주기를 단축 · 보호 반경과 보호막 성능은 유지"},
  sporeherd:{name:"도약 포자병",desc:"소환된 포자병이 그림자벼룩의 공통 도약 이동을 재사용해 사거리 내 적에게 도약"},
  clawhunter:{name:"공중 포획",desc:"집게 적중 순간 주 대상을 에어본시키고 공중에 뜬 상태로 끌어옴"},
  siege:{name:"충격 포탄",desc:"포탄 착탄 시 좁은 범위 적을 폭심 바깥 방향으로 넉백"},
  rocket:{name:"대군 조준",desc:"현재 공격 가능 범위 안에서 광역 적중 수가 가장 높은 표적을 우선"},
  shelltitan:{name:"대지충격",desc:"기본 충격파 적중 적에게 주변 넉백 + 짧은 에어본 추가"},
  swarmbug:{name:"군락 본능",desc:"주변 군락벌레에 따른 광분 · 포위 접근 · 가까운 아군 사체 조각을 섭취"},
  aegisbeetle:{name:"고효율 요격 코어",desc:"요격 반경 증가 · 투사체당 마나 소모 감소"},
  burrowbeast:{name:"강화 굴착갑",desc:"고정 방어력과 잠복 출현 시 에어본을 강화"},
  deepthorn:{name:"연속 융기",desc:"사거리를 늘리고 중앙 송곳 뒤에 주변으로 약화된 추가 융기를 발생"},
  flowerbee:{name:"군집 합류",desc:"진행 방향의 아군 공중 편대에 합류할 때 이동속도 증가"},
  sporefly:{name:"파리떼 비행",desc:"적 근처에서 이동속도를 높이고 좌우로 분산 선회 비행"},
  gustmayfly:{name:"돌풍 가속",desc:"비전투 이동을 지속할수록 가속 · 전투 진입 시 초기화"},
  lanternmoth:{name:"시야 오라",desc:"주변 아군의 시야를 증가 · 비중첩 · Detection은 증가하지 않음"},
  sporemoth:{name:"연속 폭격",desc:"한 공격 사이클에 연속 투하 · 후속 포탄은 감소된 피해"},
  hunterwasp:{name:"연속 침",desc:"기본 공격마다 일정 확률로 재사용 대기를 즉시 초기화 · 후속 정상 공격에서도 다시 발동 가능"},
  sailwing:{name:"확장 기동 오라",desc:"이동 오라의 반경과 이동 보너스를 강화 · 비중첩"},
  ancientmistray:{name:"적응형 은폐 진형",desc:"주변 아군의 교전 사거리와 이동속도에 맞춰 비행하여 은폐장을 주력 진형에 유지 · 실제 무기 사거리는 유지"},
  hivecarrier:{name:"긴급 군락 재생",desc:"격추된 공생충 재생 간격과 마나 비용을 줄임 · 최대 운용 수는 유지"},
};

BalanceValidation.validateEconomicCostGrid();

BalanceValidation.validateUnitMoveSpeedGrid();

BalanceValidation.validateNormalizedBalanceGrid();

export { ABILITY_INFO, BalanceValidation };
