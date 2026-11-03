// Building definitions and placement rules.
import { ECONOMY_WORKER_DEF, ECONOMY_WORKER_TYPE, UnitDefinition } from './units.js';
import { NAV_BUILDING_MARGIN } from './combat-rules.js';
import { BASE_SUPPLY, COLLISION_RADIUS_SCALE, DETECT_BASE_RADIUS, DETECT_OUTPOST_RADIUS } from './world-rules.js';
import { InteractionGeometry, TerrainNavigation } from '../sim/navigation.js';

class BuildingDefinition{
  static all={
  base:{name:"메인 거점",showsFactionPennant:true,visualCategory:"base",isMainBase:true,isDropoff:true,workerQueue:true,cancelProtected:true,detectRadius:DETECT_BASE_RADIUS,meteorBaseDamage:150,cost:0,hp:2400,size:55,sight:475,buildTimeMs:0,supplyPlus:BASE_SUPPLY,aiDefenseAnchorBaseScore:30,aiBuildAnchorPriorityTech:0,aiBuildAnchorPriorityForward:1,aiObjectiveValue:75,aiMeteorValue:18},
  outpost:{name:"전진 거점",showsFactionPennant:true,visualCategory:"outpost",isOutpost:true,isDropoff:true,workerQueue:true,cancelProtected:true,detectRadius:DETECT_OUTPOST_RADIUS,meteorBaseDamage:280,cost:0,hp:1400,size:45,sight:425,buildTimeMs:0,supplyPlus:0,aiDefenseAnchorBaseScore:26,aiDefenseAnchorBonus:6,aiBuildAnchorPriorityTech:1,aiBuildAnchorPriorityForward:0,aiObjectiveValue:105,aiMeteorValue:50},
  supply:{name:"보급소",detailIcon:"▣",visualCategory:"supply",meteorBaseDamage:250,cost:100,hp:500,size:30,sight:250,buildTimeMs:4250,supplyPlus:15,alwaysBuildable:true,commandGroup:"economy"},
  gasExtractor:{name:"가스 추출장",detailIcon:"⬡",showsFactionPennant:true,visualCategory:"gasExtractor",isGasExtractor:true,cost:75,hp:550,size:30,sight:225,buildTimeMs:4500,alwaysBuildable:true,commandGroup:"economy"},
  // 배럭/공장은 일반 건물 템플릿 가격이다. 병종 생산축 BUILD는
  // UnitDefinition.all.production의 병종별 가격만 지불하며 이 값을 중복 과금하지 않는다.
  barracks:{name:"배럭",showsFactionPennant:true,visualCategory:"barracks",isProductionBuilding:true,meteorBaseDamage:350,cost:100,hp:650,size:35,sight:275,buildTimeMs:5000,productionFacility:true,aiObjectiveValue:92,aiMeteorValue:58,commandGroup:"military",productionLabel:"전용 배럭"},
  factory:{name:"중화기 공장",showsFactionPennant:true,visualCategory:"factory",isProductionBuilding:true,meteorBaseDamage:350,cost:125,hp:750,size:40,sight:300,buildTimeMs:6250,productionFacility:true,requiresTech:3,aiObjectiveValue:92,aiMeteorValue:65,commandGroup:"military",productionLabel:"중화기 공장"},
  airIncubator:{name:"공중 배양소",showsFactionPennant:true,visualCategory:"airIncubator",meteorBaseDamage:300,cost:150,hp:800,size:40,sight:300,buildTimeMs:55000,longTech:true,gasCost:125,singleton:true,unlocksAir:true,commandGroup:"research"},

  thornTower:{name:"가시꽃 초소",showsFactionPennant:true,visualCategory:"thornTower",cost:150,hp:700,size:30,sight:500,buildTimeMs:5250,attackVisual:{sourceMotion:null,travel:"projectile",impact:"pierce"},atk:45,range:450,cooldownMs:500,projectile:675,sizeClass:"medium",role:"defense",canAttackGround:true,canAttackAir:true,isDefenseTower:true,commandGroup:"tactics"},
  acornTower:{name:"도토리 감시포",showsFactionPennant:true,visualCategory:"acornTower",cost:175,hp:750,size:35,sight:600,buildTimeMs:5750,attackVisual:{sourceMotion:null,travel:"projectile",impact:"light"},atk:90,range:550,cooldownMs:1500,projectile:550,sizeClass:"heavy",role:"defense",isDefenseTower:true,canAttackGround:true,canAttackAir:true,commandGroup:"tactics"},
  sunvineTower:{name:"태양덩굴 포탑",suppressHitShake:true,showsFactionPennant:true,visualCategory:"sunvineTower",beamTower:true,cost:150,hp:700,size:35,sight:525,buildTimeMs:5500,attackVisual:{sourceMotion:null,travel:"beam",impact:"arcane"},continuous:{dps:85,damageIntervalMs:250},atk:85,range:475,cooldownMs:1000,projectile:625,sizeClass:"medium",role:"defense",gasCost:50,isDefenseTower:true,projectileArc:10,projectileRadius:5,canAttackGround:true,canAttackAir:true,commandGroup:"tactics"},
  mortarTower:{name:"포자 박격 둥지",showsFactionPennant:true,visualCategory:"mortarTower",cost:200,hp:750,size:35,sight:625,buildTimeMs:6250,attackVisual:{sourceMotion:null,travel:"projectile",impact:"explosive"},atk:75,range:625,minRange:175,cooldownMs:2000,projectile:350,sizeClass:"heavy",role:"defense",splash:75,targetMode:"farthest",projectileArc:45,projectileRadius:5,canAttackGround:true,canAttackAir:false,damageClass:"area",isDefenseTower:true,gasCost:50,commandGroup:"tactics"},

  rootBarrier:{name:"굳은 뿌리 장벽",cost:0,hp:600,size:110,sight:0,buildTimeMs:1,scenarioOnly:true,isTerrainBarrier:true,blocksVision:true,blocksProjectile:false,visualCategory:"rootBarrier",constructionCoreColor:[.44,.37,.24,1]},
  academy:{name:"아카데미",constructionCoreColor:[.85,.75,1,1],visualCategory:"academy",meteorBaseDamage:300,cost:175,hp:900,size:40,sight:325,buildTimeMs:60000,tech:2,longTech:true,singleton:true,commandGroup:"research"},
  lab:{name:"첨단 전술 연구소",constructionCoreColor:[1,.65,.25,1],visualCategory:"lab",meteorBaseDamage:300,cost:275,hp:1000,size:45,sight:350,buildTimeMs:70000,tech:3,longTech:true,singleton:true,requiresTech:2,requiresBuildings:["academy"],commandGroup:"research"},
};
  static get(type){return this.all[type]||null}
  static has(type){return !!this.all[type]}
  static isDefenseTower(type){return !!this.get(type)?.isDefenseTower}
  static isProduction(type){return !!this.get(type)?.isProductionBuilding}
  static isGasExtractor(type){return !!this.get(type)?.isGasExtractor}
  static isMainBase(type){return !!this.get(type)?.isMainBase}
  static visualCategory(type){return this.get(type)?.visualCategory||null}
  static mineralCost(type,produceType=null){
    if(this.get(type)?.productionFacility&&produceType)return UnitDefinition.productionMineralCost(produceType);
    return Math.max(0,Number(this.get(type)?.cost)||0);
  }
  static gasCost(type,produceType=null){
    if(this.get(type)?.productionFacility&&produceType)return UnitDefinition.productionGasCost(produceType);
    return Math.max(0,Number(this.get(type)?.gasCost)||0);
  }
  static resourceCost(type,produceType=null){return{mineral:this.mineralCost(type,produceType),gas:this.gasCost(type,produceType)}}

  static byRole=Object.freeze({
  mainBase:Object.keys(BuildingDefinition.all).find(type=>BuildingDefinition.get(type)?.isMainBase),
  outpost:Object.keys(BuildingDefinition.all).find(type=>BuildingDefinition.get(type)?.isOutpost),
  supply:Object.keys(BuildingDefinition.all).find(type=>Number(BuildingDefinition.get(type)?.supplyPlus)>0&&!BuildingDefinition.get(type)?.isMainBase),
  gasExtractor:Object.keys(BuildingDefinition.all).find(type=>BuildingDefinition.get(type)?.isGasExtractor),
  airTech:Object.keys(BuildingDefinition.all).find(type=>BuildingDefinition.get(type)?.unlocksAir),
  academy:Object.keys(BuildingDefinition.all).find(type=>BuildingDefinition.get(type)?.commandGroup==="research"&&Number(BuildingDefinition.get(type)?.requiresTech||0)===0&&!BuildingDefinition.get(type)?.unlocksAir),
  lab:Object.keys(BuildingDefinition.all).find(type=>BuildingDefinition.get(type)?.commandGroup==="research"&&Number(BuildingDefinition.get(type)?.requiresTech||0)>=2),
  beamTower:Object.keys(BuildingDefinition.all).find(type=>BuildingDefinition.get(type)?.beamTower)
});

  static forRole(role){return this.byRole[role]||null}
}

const BUILDER_NAV_PLACEMENT_RADIUS=Math.max(1,(ECONOMY_WORKER_DEF.size||10)*COLLISION_RADIUS_SCALE);
function buildingPlacementEdgeMargin(type){
  // Buildings may sit against the battlefield edge. The builder only needs one
  // reachable interaction face inside the world; reserving a full worker corridor
  // on every edge made legitimate perimeter construction impossible.
  const bd=BuildingDefinition.get(type);
  return Math.ceil((bd?.size||35)+2);
}
function buildingPlacementSeparation(typeA,typeB){
  const a=BuildingDefinition.get(typeA),b=BuildingDefinition.get(typeB);
  return (a?.size||35)+(b?.size||35)+Math.ceil((BUILDER_NAV_PLACEMENT_RADIUS+NAV_BUILDING_MARGIN)*2+2);
}
function buildingPlacementInsideWorld(type,x,y,world){
  const m=buildingPlacementEdgeMargin(type);
  if(!world.terrain.circleClear(x,y,(BuildingDefinition.get(type)?.size||35)+2)||!world.terrain.surfaces.buildable(x,y,(BuildingDefinition.get(type)?.size||35)+2))return false;
  return x>=m&&x<=world.width-m&&y>=m&&y<=world.height-m;
}
function buildingBuilderGoal(type,x,y){return InteractionGeometry.goal({type:ECONOMY_WORKER_TYPE},{type,x,y},"worker-build")}
function buildingHasReachableBuilder(state,side,type,x,y){
  const nav=TerrainNavigation.forState(state),goal=buildingBuilderGoal(type,x,y);
  return (state.units||[]).some(u=>u.alive!==false&&u.side===side&&UnitDefinition.get(u.type)?.economyWorker&&Number.isFinite(nav.distance(u.x,u.y,goal,u.type)));
}
function buildingHasBuilderApproach(state,type,x,y){
  const nav=TerrainNavigation.forState(state),goal=buildingBuilderGoal(type,x,y),layer=nav.layer(InteractionGeometry.unitRadius(ECONOMY_WORKER_TYPE)+.12);
  return nav.regions(goal,layer).areas.length>0;
}

for(const def of Object.values(BuildingDefinition.all)){
  if(!def)continue;
  if(Number.isFinite(Number(def.cooldownMs)))def.cooldown=Number(def.cooldownMs)/1000;
}

export { BuildingDefinition, buildingHasBuilderApproach, buildingHasReachableBuilder, buildingPlacementEdgeMargin, buildingPlacementInsideWorld, buildingPlacementSeparation };
