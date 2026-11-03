// Upgrade and research definitions.
import { ABILITY_INFO } from './balance.js';
import { BuildingDefinition } from './buildings.js';
import { UnitDefinition } from './units.js';

const MAX_ATTACK_UPGRADE=3;
const MAX_ARMOR_UPGRADE=3;
const ATTACK_UPGRADE_PCT_PER_LEVEL=10;
const ARMOR_REDUCTION_PCT_PER_LEVEL=10;

class ResearchDefinition{
  static stateHasCompletedBuilding(state,side,type){
  return !!type&&(state?.buildings||[]).some(b=>b?.alive!==false&&b.complete&&b.side===side&&b.type===type);
}

  static specialResearchPrereqMet(state,side,def){
  if(!def)return false;
  // A concrete research building is the authoritative prerequisite when declared.
  // Do not infer availability from the cached tech level: the actual completed, living
  // building must exist when the research is started.
  if(def.requiredBuildingRole){const type=BuildingDefinition.forRole(def.requiredBuildingRole);return !!type&&ResearchDefinition.stateHasCompletedBuilding(state,side,type);}
  return (state?.tech?.[side]||1)>=(def.requiredTech||2);
}

  static all={
  // 공격/방어/특수는 각자의 연구 채널을 사용한다. 비용과 시간은 이 Definition이 소유한다.
  attack:[
    {cost:100,gasCost:100,timeMs:25000},
    {cost:175,gasCost:175,timeMs:35000},
    {cost:250,gasCost:250,timeMs:45000}
  ],
  armor:[
    {cost:100,gasCost:100,timeMs:25000},
    {cost:175,gasCost:175,timeMs:35000},
    {cost:250,gasCost:250,timeMs:45000}
  ],
  ability:{cost:50,gasCost:100,timeMs:40000}
};
  static get(id){return this.all[id]||null}
  static resolveAction(state,side,action){
    const channel=action.research;let def=null,level=null,unit=action.unit||null,researchId=action.researchId||null;
    if(channel==="attack"&&state.attackUpgrade[side]<MAX_ATTACK_UPGRADE){level=state.attackUpgrade[side]+1;def=this.all.attack[state.attackUpgrade[side]]}
    else if(channel==="armor"&&state.armorUpgrade[side]<MAX_ARMOR_UPGRADE){level=state.armorUpgrade[side]+1;def=this.all.armor[state.armorUpgrade[side]]}
    else if(channel==="ability"&&researchId){const special=UnitSpecialResearchDefinition.get(researchId);unit=special?.unit||unit;
      if(special&&unit&&(state.decks[side]||[]).includes(unit)&&!state.specialResearch?.[side]?.[researchId]&&this.specialResearchPrereqMet(state,side,special))def=special;
    }else if(channel==="ability"&&unit&&ABILITY_INFO[unit]&&(state.decks[side]||[]).includes(unit)&&!state.abilities?.[side]?.[unit])def=this.abilityForUnit(unit);
    return{def,level,unit,researchId};
  }
  static abilityGrade(unitType){return UnitDefinition.get(unitType)?.abilityResearchGrade||"standard"}
  static abilityForUnit(unitType){
    const grade=this.abilityGrade(unitType),c=ABILITY_RESEARCH_COSTS[grade]||ABILITY_RESEARCH_COSTS.standard,d=UnitDefinition.get(unitType)||{};
    return{...c,cost:Number.isFinite(Number(d.abilityResearchCost))?Number(d.abilityResearchCost):c.cost,gasCost:Number.isFinite(Number(d.abilityResearchGasCost))?Number(d.abilityResearchGasCost):c.gasCost,grade,timeMs:this.all.ability.timeMs};
  }
}
const ABILITY_RESEARCH_COSTS={
  light:{label:"경량",cost:50,gasCost:50},
  standard:{label:"표준",cost:50,gasCost:100},
  advanced:{label:"고급",cost:75,gasCost:150},
  core:{label:"핵심",cost:100,gasCost:200}
};

// A unit may own multiple special researches. Effects are declarative so the
// same movement/stat contracts can be reused by future units without bespoke branches.
const MOVE_SPEED_STEP=25;
class UnitSpecialResearchDefinition{
  static all=Object.freeze({
  fireantBreath:Object.freeze({
    id:"fireantBreath",unit:"fireant",name:"산성 분사낭",
    desc:"기본 공격 시 일정 확률로 평타 대신 전방의 좁은 범위에 지속형 소형 특화 산성 브레스를 분사",
    requiredTech:2,requiredBuildingRole:"academy",cost:100,gasCost:200,timeMs:40000,
    effects:Object.freeze({attackVariant:"acidBreath"})
  }),
  stingbugMove:Object.freeze({
    id:"stingbugMove",unit:"stingbug",name:"고속 다리",
    desc:"기본 이동속도를 상위 이동속도 티어로 강화",
    requiredTech:2,requiredBuildingRole:"academy",cost:50,gasCost:50,timeMs:30000,
    effects:Object.freeze({moveSpeedPct:150})
  }),
  stingbugFrenzy:Object.freeze({
    id:"stingbugFrenzy",unit:"stingbug",name:"연속 찌르기",
    desc:"이동 없이 공격을 이어갈수록 공격속도가 누적 증가 · 실제 이동 시 즉시 초기화",
    requiredBuildingRole:"lab",cost:75,gasCost:150,timeMs:40000,
    effects:Object.freeze({stationaryAttackSpeedPerStack:10,stationaryAttackSpeedMaxStacks:10,resetOnMove:true})
  }),
  kickhopperLeap:Object.freeze({
    id:"kickhopperLeap",unit:"kickhopper",name:"도약 강습",
    desc:"콩벌레와 같은 공통 도약 이동으로 빠르게 접근 · 기존 탄성 뒷다리 연구의 범위 피해/에어본과 연계",
    requiredBuildingRole:"lab",cost:75,gasCost:125,timeMs:40000
  }),
  thornfruitSpines:Object.freeze({
    id:"thornfruitSpines",unit:"thornfruit",name:"원거리 가시반격",
    desc:"가시 폭발 반경 증가 · 근접에만 적용되던 고정 방어력 반사를 원거리 투사체에도 적용",
    requiredBuildingRole:"lab",cost:75,gasCost:125,timeMs:40000
  }),
  medicCombatDew:Object.freeze({
    id:"medicCombatDew",unit:"medic",name:"전투 이슬낭",
    desc:"이슬치유사를 전투 의무병으로 강화 · 기본 공격력과 공격 사거리를 강화",
    requiredBuildingRole:"lab",cost:250,gasCost:250,timeMs:40000,
    effects:Object.freeze({attackMultiplier:3,attackRangeMultiplier:2})
  }),
  guardshroomRetaliation:Object.freeze({
    id:"guardshroomRetaliation",unit:"guardshroom",name:"포자 반격",
    desc:"자신이 부여한 보호막이 적 공격을 막고 깨질 때 마나를 추가 소모해 공격자에게 낮은 곡사의 포자탄으로 반격",
    requiredBuildingRole:"lab",cost:200,gasCost:200,timeMs:40000,
    effects:Object.freeze({guardRetaliation:true})
  })
});
  static get(id){return this.all[id]||null}
  static forUnit(type){return Object.values(this.all).filter(d=>d.unit===type)}
  static hasOptions(type){return !!ABILITY_INFO?.[type]||this.forUnit(type).length>0}
  static namesForUnit(type){
    const names=[];if(ABILITY_INFO?.[type]?.name)names.push(ABILITY_INFO[type].name);
    for(const d of this.forUnit(type))names.push(d.name);
    return names.join(" / ")||"없음";
  }

  static ids=Object.freeze(Object.keys(UnitSpecialResearchDefinition.all));
}

class AttackPresentationDefinition{
  static sourceMotions=Object.freeze({
    // Source-motion scale is owned by the attacker. Target size/distance never changes it.
    slash:Object.freeze({kind:"slash",lifeMs:210,baseSize:12,sourceRadiusScale:1.15,maxSize:42}),
    thrust:Object.freeze({kind:"thrust",lifeMs:190,baseSize:11,sourceRadiusScale:1.10,maxSize:40}),
    claw:Object.freeze({kind:"claw",lifeMs:230,baseSize:13,sourceRadiusScale:1.15,maxSize:42}),
    bite:Object.freeze({kind:"bite",lifeMs:210,baseSize:16,sourceRadiusScale:1.00,maxSize:38}),
    smash:Object.freeze({kind:"smash",lifeMs:260,baseSize:18,sourceRadiusScale:1.30,maxSize:52})
  });
  static impacts=Object.freeze({
    // Impact owns target/contact feedback. Its scale is semantic, never inherited from Source Motion.
    light:Object.freeze({fx:"meleeImpact",scale:0.82}),
    pierce:Object.freeze({fx:"pierceImpact",scale:0.88}),
    heavy:Object.freeze({fx:"heavyImpact",scale:1.00}),
    explosive:Object.freeze({fx:"heavyImpact",scale:1.08}),
    arcane:Object.freeze({fx:"magicImpact",scale:0.92}),
    bullet:Object.freeze({fx:"bulletImpact",scale:0.78})
  });
  static forSource(type){
    const d=UnitDefinition.get(type)||BuildingDefinition.get(type)||{};
    const a=d.attackVisual;
    if(!a)return {sourceMotion:null,travel:d.projectile?"projectile":"none",impact:"light"};
    return {sourceMotion:a.sourceMotion??null,travel:a.travel??"none",impact:a.impact??"light"};
  }
  
  static impactPreset(type){const id=this.forSource(type).impact;return this.impacts[id]||this.impacts.light}
  static impactFx(type){return this.impactPreset(type)?.fx||"meleeImpact"}
}
class BodyPulsePresentation{
  static presets=Object.freeze({
    guardshroomRetaliation:Object.freeze({durationMs:320,keyframes:Object.freeze([Object.freeze({at:0,scale:1}),Object.freeze({at:70,scale:.78}),Object.freeze({at:180,scale:1.28}),Object.freeze({at:320,scale:1})])}),
    hunterWaspRapidSting:Object.freeze({durationMs:220,keyframes:Object.freeze([Object.freeze({at:0,scale:1}),Object.freeze({at:70,scale:1.30}),Object.freeze({at:145,scale:.82}),Object.freeze({at:220,scale:1})])})
  });
  constructor(){this.active=new Map()}
  trigger(entityId,presetId,now=performance.now()){
    if(!entityId||!BodyPulsePresentation.presets[presetId])return false;
    this.active.set(entityId,{presetId,start:now});return true;
  }
  scale(entityId,now=performance.now()){
    const state=this.active.get(entityId);if(!state)return 1;
    const preset=BodyPulsePresentation.presets[state.presetId];if(!preset){this.active.delete(entityId);return 1}
    const age=Math.max(0,now-state.start);if(age>=preset.durationMs){this.active.delete(entityId);return 1}
    const frames=preset.keyframes;let a=frames[0],b=frames[frames.length-1];
    for(let i=1;i<frames.length;i++)if(age<=frames[i].at){a=frames[i-1];b=frames[i];break}
    const span=Math.max(1,b.at-a.at),t=Math.max(0,Math.min(1,(age-a.at)/span));
    return a.scale+(b.scale-a.scale)*t;
  }
}

export { ABILITY_RESEARCH_COSTS, ARMOR_REDUCTION_PCT_PER_LEVEL, ATTACK_UPGRADE_PCT_PER_LEVEL, AttackPresentationDefinition, BodyPulsePresentation, MAX_ARMOR_UPGRADE, MAX_ATTACK_UPGRADE, MOVE_SPEED_STEP, ResearchDefinition, UnitSpecialResearchDefinition };
