// Seeded frontier map generation.
import { GameRuleDefinition, GameRuleRuntime, RangeUtil } from '../core/game-rules.js';
import { TerrainQuery } from './entities.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { UnitDefinition } from '../definitions/units.js';
import { CampDefinition, NEUTRAL_SIDE, NeutralCampPolicy, UnitCompositionDefinition } from '../definitions/cards.js';
import { CapturePointDefinition, LANE_NORMALS, MapGeometry, RIVER_HALF_WIDTH, RIVER_PATH } from './map-geometry.js';
import { LANE_CONTROL_POINTS } from '../definitions/combat-rules.js';
import { COLLISION_RADIUS_SCALE } from '../definitions/world-rules.js';
import { WorldContext } from './world-context.js';
import { InteractionGeometry, TerrainNavigation } from './navigation.js';
import { TerrainGeometry, TerrainSurfaceAtlas } from './terrain.js';

class CloneUtil{static clone(v){return JSON.parse(JSON.stringify(v))}}
class HashUtil{static hash(s){let h=2166136261>>>0;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}}

const MAP_DESCRIPTOR_SCHEMA_VERSION=1;

// Rooms and terrain boundaries are laid out together. Variation changes the same
// structural template; no post-hoc random walls are placed across a valid route.
class FrontierTerrainLayout{
  static create(ctx){
    const {width:w,height:h,seed}=ctx;
    const point=([x,y])=>({x:Math.round(x*w),y:Math.round(y*h)}),mirror=p=>({x:w-p.x,y:h-p.y});
    const density=RangeUtil.clamp(Number(ctx.m.obstacleDensity??.5),0,1),openness=RangeUtil.clamp(Number(ctx.m.openness??.5),0,1),choke=RangeUtil.clamp(Number(ctx.m.chokeDensity??.5),0,1);
    const variation=(HashUtil.hash(seed+'|plateau-shape')%21-10)/2000*(.5+density),widthScale=1+(openness-.5)*.3;
    const layers=[],ramps=[],blockers=[],structures=[];
    const pairLayer=(id,coords,entries)=>{
      const points=coords.map(point);
      for(let side=0;side<2;side++){
        const layerId=id+'-'+side;layers.push({id:layerId,level:1,points:side?points.map(mirror):points.map(p=>({...p}))});
        for(const e of entries){const half=(e.t1-e.t0)/2*(e.destructible?1:widthScale),center=(e.t0+e.t1)/2;ramps.push({...e,t0:center-half,t1:center+half,run:e.run*(.85+choke*.3),id:layerId+'-'+e.name,layerId})}
      }
    };
    pairLayer('base-high',[[0,.735],[.205,.735],[.275,.805],[.275,1],[0,1]],[
      {name:'main-ramp',edge:0,t0:.38,t1:.88,run:240},
      {name:'flank-ramp',edge:2,t0:.22,t1:.64,run:220}
    ]);
    pairLayer('flank-high',[[.22,.32],[.28,.285],[.355+variation,.30],[.405+variation,.37],[.40,.45],[.34,.50],[.265,.465],[.235,.40]],[
      {name:'outer-ramp',edge:6,t0:.15,t1:.85,run:155},
      {name:'centre-ramp',edge:3,t0:.08,t1:.92,run:160},
      {name:'shortcut',edge:0,t0:.135,t1:.865,run:150,destructible:true}
    ]);
    const border=[[0,0],[.35,0],[.33,.065],[.255,.09],[.195,.16],[.115,.20],[.075,.285],[0,.32]].map(point);
    blockers.push({id:'outer-ridge-nw',kind:'cliff',points:border},{id:'outer-ridge-se',kind:'cliff',points:border.map(mirror)});
    const atlas=new TerrainSurfaceAtlas({width:w,height:h,terrain:{layers,ramps}});
    for(const r of atlas.ramps)if(r.destructible){const p=TerrainSurfaceAtlas.lerp(r.lowA,r.lowB,.5);structures.push({id:'gate-'+r.id,type:'rootBarrier',side:NEUTRAL_SIDE,x:Math.round(p.x),y:Math.round(p.y),terrainGate:r.id})}
    return {layers,ramps,blockers,structures};
  }
  static lanes(ctx){
    const w=ctx.width,h=ctx.height,p=(x,y)=>({x:Math.round(x*w),y:Math.round(y*h)}),mirror=q=>({x:w-q.x,y:h-q.y});
    // Corner rooms are connected by two outer routes and the central battlefield.
    const top=[ctx.host,p(.135,.76),p(.135,.69),p(.13,.57),p(.12,.42),p(.17,.275),p(.27,.16),p(.43,.13),p(.61,.135),p(.735,.14),ctx.guest];
    const bot=top.slice().reverse().map(mirror),mid=[ctx.host,p(.20,.80),p(.30,.72),p(.35,.65),p(.50,.50),p(.65,.35),p(.72,.30),p(.80,.20),ctx.guest];
    const capturePoints=[['top',1,.13,.57],['top',2,.43,.13],['mid',1,.35,.65],['mid',2,.65,.35],['bot',1,.57,.87],['bot',2,.87,.43]].map(([id,stage,x,y])=>({id:id+'-'+stage,lane:id.toUpperCase(),laneKey:id,label:id.toUpperCase()+' '+stage,stage,...p(x,y)}));
    return{laneControlPoints:{top,mid,bot},laneNormals:{top:{x:ctx.nx,y:ctx.ny},mid:{x:ctx.nx,y:ctx.ny},bot:{x:ctx.nx,y:ctx.ny}},capturePoints};
  }
  static safety(map){
    const geometry=TerrainGeometry.fromMap(map),atlas=geometry.surfaces,terrain=map.terrain;
    const dryGeometry=TerrainGeometry.fromMap({...map,terrain:{...terrain,layers:(terrain.layers||[]).filter(l=>!l.innerPoints?.length),bridges:[]}});
    const waterPaths=[terrain.riverPath,...(terrain.riverBranches||[])],banks=atlas.layers.filter(l=>l.innerPoints?.length),elevated=atlas.layers.filter(l=>l.level>0);
    const clearance=(terrain.riverHalfWidth||0)+(terrain.riverBankWidth||0)+20;
    const waterClear=waterPaths.every(path=>path.every((p,i)=>dryGeometry.circleClear(p.x,p.y,clearance)&&(!i||dryGeometry.segmentClear(path[i-1].x,path[i-1].y,p.x,p.y,clearance))))&&banks.every((b,i)=>b.points.every(p=>p.x>=0&&p.x<=map.width&&p.y>=0&&p.y<=map.height)&&!elevated.some(l=>TerrainSurfaceAtlas.polygonsOverlap(b.points,l.points))&&!banks.slice(i+1).some(l=>TerrainSurfaceAtlas.polygonsOverlap(b.points,l.points)));
    const bridgeClear=(terrain.bridges||[]).every(b=>{
      const ca=Math.cos(b.angle),sa=Math.sin(b.angle),p=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>({x:b.x+x*b.halfLength*ca-y*b.halfWidth*sa,y:b.y+x*b.halfLength*sa+y*b.halfWidth*ca}));
      const groundedEndcaps=[1,3].every(i=>banks.every(bank=>bank.points.every((a,j)=>{const z=bank.points[(j+1)%bank.points.length],v=p[i],q=p[(i+1)%4];return TerrainGeometry.segmentEdgeDistance(v.x,v.y,q.x,q.y,a.x,a.y,z.x,z.y)>=2})));
      return groundedEndcaps&&p.every((v,i)=>atlas.heightAt(v.x,v.y)===0&&dryGeometry.segmentClear(v.x,v.y,p[(i+1)%4].x,p[(i+1)%4].y,2))&&!elevated.some(l=>TerrainSurfaceAtlas.polygonsOverlap(p,l.points));
    });
    const pads=[map.spawns.host,map.spawns.guest,...map.capturePoints,...map.gasNodes,...map.resources,...map.camps];
    const buildablePads=pads.every(p=>geometry.circleClear(p.x,p.y,42)&&atlas.buildable(p.x,p.y,42)&&!banks.some(b=>MapGeometry.pointInSimplePolygon(p.x,p.y,b.points)));
    return {waterLayerSeparation:waterClear,bridgeRampSeparation:bridgeClear,buildablePads};
  }
  static connectedLayout(map){
    // Validate the actual radius-inflated navigation mesh, including closed gates.
    // Generation-time caches are discarded; no validation state enters gameplay.
    const adapter={world:WorldContext.fromMap(map),tick:0,navigationRevision:0,
      buildings:(map.authoredStructures||[]).map(b=>({...b,alive:true,hp:BuildingDefinition.get(b.type)?.hp||1})),
      unitRadius:InteractionGeometry.unitRadius};
    const nav=new TerrainNavigation(adapter);
    const largest=Math.max(...Object.values(UnitDefinition.all).filter(d=>d.layer!=='AIR').map(d=>(d.size||10)*COLLISION_RADIUS_SCALE));
    const strategic=[map.spawns.host,map.spawns.guest,...map.capturePoints,...map.camps,
      ...adapter.world.terrain.surfaces.layers.map(l=>l.points.reduce((p,q)=>({x:p.x+q.x/l.points.length,y:p.y+q.y/l.points.length}),{x:0,y:0}))];
    for(const [radius,points] of [[InteractionGeometry.unitRadius('worker')+.12,[...strategic,...map.resources,...map.gasNodes]],[largest+.12,strategic]]){
      const mesh=nav.layer(radius),start=nav.locate(map.spawns.host.x,map.spawns.host.y,mesh);
      if(!start||start.d2>1)return false;
      for(const p of points){const goal=nav.locate(p.x,p.y,mesh);if(!goal||goal.d2>1||goal.cell.component!==start.cell.component)return false}
    }
    return true;
  }
  static water(ctx){
    const {width:w,height:h,seed}=ctx;
    const shift=(HashUtil.hash(seed+'|lowland-stream')%21-10)/2000;
    const riverHalfWidth=65+5*(HashUtil.hash(seed+'|stream-width')%4);
    const riverBankWidth=96,outerWidth=riverHalfWidth+riverBankWidth;
    // Caps extend along the tangent as well as across it. Reserve the maximum
    // possible cap extent before smoothing; paired contours are never clamped.
    const startX=Math.max(.075,(outerWidth*Math.hypot(1,.72)+20)/w);
    const templates=[[[startX,.66],[.13,.645],[.215,.615],[.29,.57+shift],[.36,.555+shift],[.445,.56+shift]]];
    // Short maps cannot fit the full stream between the fixed physical ramps.
    // Search a shorter lowland ribbon while keeping the same gentle bank width.
    const offsets=[0,.015,-.015,.03,-.03],reverse=(HashUtil.hash(seed+'|compact-stream')&1)?1:-1;
    for(const dy of offsets)for(const dx of offsets)templates.push([[.34,.76],[.38,.75],[.425,.72],[.47,.675]].map(([x,y])=>[x+dx*reverse,y+dy]));
    const layout=ctx.terrainLayout||FrontierTerrainLayout.create(ctx),geometry=new TerrainGeometry({width:w,height:h,terrain:layout}),atlas=geometry.surfaces;
    const pads=[ctx.host,ctx.guest,...FrontierTerrainLayout.lanes(ctx).capturePoints],clearance=outerWidth+20;
    for(const coords of templates){
      const controls=coords.map(([x,y])=>({x:x*w,y:y*h}));
      const riverPath=MapGeometry.smoothPolylineCatmull(controls,5).map(p=>({x:Math.round(p.x),y:Math.round(p.y)}));
      const riverBranches=[riverPath.map(p=>({x:w-p.x,y:h-p.y}))],paths=[riverPath,...riverBranches];
      const riverBankLayers=paths.map((path,i)=>({id:'river-bank-'+i,level:-1,points:MapGeometry.polylineToRibbonPolygon(path,outerWidth),innerPoints:MapGeometry.polylineToRibbonPolygon(path,riverHalfWidth)}));
      const clear=riverBankLayers.every((b,i)=>b.points.every(p=>p.x>=0&&p.x<=w&&p.y>=0&&p.y<=h)&&![...atlas.layers,...atlas.ramps].some(l=>TerrainSurfaceAtlas.polygonsOverlap(b.points,l.points))&&!riverBankLayers.slice(i+1).some(l=>TerrainSurfaceAtlas.polygonsOverlap(b.points,l.points))&&pads.every(p=>!MapGeometry.pointInSimplePolygon(p.x,p.y,b.points)&&b.points.every((a,j)=>{const z=b.points[(j+1)%b.points.length];return MapGeometry.pointSegDist(p.x,p.y,a.x,a.y,z.x,z.y)>=42})));
      if(!clear||!paths.every(path=>path.every((p,i)=>geometry.circleClear(p.x,p.y,clearance)&&(!i||geometry.segmentClear(path[i-1].x,path[i-1].y,p.x,p.y,clearance)))))continue;
      return {riverPath,riverHalfWidth,riverBranches,riverBankWidth,riverBankLayers,
        riverPolygon:MapGeometry.polylineToRibbonPolygon(riverPath,riverHalfWidth),
        riverBranchPolygons:riverBranches.map(p=>MapGeometry.polylineToRibbonPolygon(p,riverHalfWidth))};
    }
    throw new Error('No lowland corridor can fit the physical river banks');
  }
}

class MapGeneration{
  static descriptorCache=null;
  static mapRuleSeed(baseSeed,rules=GameRuleDefinition.current,roundNumber=1){
  const m=rules?.map||{};
  const salt=m.generation?.seedSalt||"map";
  return HashUtil.hash(`${baseSeed>>>0}|${rules?.modeId||"standard"}|${roundNumber||1}|${m.generator||"fixed-standard"}|${m.generatorVersion||1}|${salt}`)>>>0;
}
  static fixedStandardMapDescriptor(rules=GameRuleDefinition.current,baseSeed=0,roundNumber=1){
  const m=rules?.map||GameRuleDefinition.defaults.map;
  const width=Number(m.width)||3600,height=Number(m.height)||4200;
  const sx=width/3600,sy=height/4200;
  const scalePoint=p=>({x:Math.round(p.x*sx),y:Math.round(p.y*sy)});
  const cps=CapturePointDefinition.all.map(cp=>({...cp,...scalePoint(cp)}));
  const laneNormals=CloneUtil.clone(LANE_NORMALS);
  const resources=[];let mid=0;
  const addM=(x,y,amount)=>resources.push({id:"m"+(++mid),x:Math.round(RangeUtil.clamp(x,80,width-80)),y:Math.round(RangeUtil.clamp(y,80,height-80)),amount,max:amount,r:28});
  const mirror=(x,y)=>[width-x,height-y];
  for(const [x0,y0,a] of [[820,3520,650],[690,3260,600],[1040,3370,650]]){
    const x=x0*sx,y=y0*sy;addM(x,y,a);const [mx,my]=mirror(x,y);addM(mx,my,a);
  }
  for(const cp of cps){
    const n=laneNormals[cp.laneKey],forward=cp.stage===1?1:-1;
    addM(cp.x+n.x*170*sx+forward*85*sx,cp.y+n.y*170*sy-forward*85*sy,cp.stage===1?900:1150);
    addM(cp.x-n.x*120*sx-forward*120*sx,cp.y-n.y*120*sy+forward*120*sy,cp.stage===1?820:1050);
  }
  addM(1700*sx,2140*sy,1700);addM(1900*sx,2060*sy,1700);
  const gasNodes=[];let gid=0;
  const addG=(x,y,amount=1600)=>gasNodes.push({id:"g"+(++gid),x:Math.round(RangeUtil.clamp(x,80,width-80)),y:Math.round(RangeUtil.clamp(y,80,height-80)),amount,max:amount,r:32});
  for(const [x0,y0,a] of [[900,3820,1500],[1280,3020,1600],[1180,2470,1800],[1560,2260,2000]]){
    const x=x0*sx,y=y0*sy;addG(x,y,a);const [mx,my]=mirror(x,y);addG(mx,my,a);
  }
  const camps=[];
  const addPair=(id,kind,x0,y0)=>{const x=x0*sx,y=y0*sy;camps.push({id:id+"h",kind,x,y,state:"ready",respawnAt:0,lastHitSide:null,spawnNo:0});const [mx,my]=mirror(x,y);camps.push({id:id+"g",kind,x:mx,y:my,state:"ready",respawnAt:0,lastHitSide:null,spawnNo:0})};
  addPair("houndA","hounds",1450,2830);addPair("houndB","hounds",1050,2390);addPair("boarA","boars",1580,2450);addPair("boarB","boars",800,1960);
  for(const [id,kind,laneKey] of [["main-top","objectiveBear","top"],["main-mid","objectiveDeathWorm","mid"],["main-bot","objectiveDragon","bot"]]){
    const pts=(LANE_CONTROL_POINTS[laneKey]||[]).map(scalePoint),mid=MapGeometry.pointOnPolyline(pts,.5);
    let p=mid;
    if(laneKey!=="mid"){const tangent=MapGeometry.laneTangentAt(pts,.5),n1={x:-tangent.y,y:tangent.x},n2={x:tangent.y,y:-tangent.x},center={x:width/2,y:height/2};const a={x:mid.x+n1.x*205,y:mid.y+n1.y*205},b={x:mid.x+n2.x*205,y:mid.y+n2.y*205};p=Math.hypot(a.x-center.x,a.y-center.y)>=Math.hypot(b.x-center.x,b.y-center.y)?a:b}
    camps.push({id,kind,laneKey,x:Math.round(RangeUtil.clamp(p.x,90,width-90)),y:Math.round(RangeUtil.clamp(p.y,90,height-90)),state:"ready",respawnAt:0,lastHitSide:null,spawnNo:0,capturedUnitId:null,capturedOwner:null,lastDeathX:null,lastDeathY:null});
  }
  for(const cp of cps){
    const n=laneNormals[cp.laneKey],forward=cp.stage===1?1:-1;
    const x=Math.round(cp.x+n.x*235*sx+forward*135*sx),y=Math.round(cp.y+n.y*235*sy-forward*135*sy);
    camps.push({id:"objective-"+cp.id,kind:"relic",x:RangeUtil.clamp(x,90,width-90),y:RangeUtil.clamp(y,90,height-90),state:"ready",respawnAt:0,lastHitSide:null,spawnNo:0,spellReward:true,captureId:cp.id,lane:cp.lane,label:cp.label});
  }
  return {
    schemaVersion:MAP_DESCRIPTOR_SCHEMA_VERSION,generator:m.generator||"fixed-standard",generatorVersion:m.generatorVersion||1,
    seed:MapGeneration.mapRuleSeed(baseSeed,rules,roundNumber),width,height,biome:m.biome||"frontier",topology:m.topology||"standard",symmetry:m.symmetry||"diagonal",
    spawns:{host:{x:Number(m.spawns?.host?.x)||450,y:Number(m.spawns?.host?.y)||3750},guest:{x:Number(m.spawns?.guest?.x)||3150,y:Number(m.spawns?.guest?.y)||450}},
    flags:[{x:1050*sx,y:3150*sy,forced:false},{x:width-1050*sx,y:height-3150*sy,forced:false}],
    laneControlPoints:Object.fromEntries(Object.entries(LANE_CONTROL_POINTS).map(([k,pts])=>[k,pts.map(scalePoint)])),
    laneNormals,capturePoints:cps,
    terrain:{layers:[],ramps:[],blockers:[],riverPath:RIVER_PATH.map(scalePoint),riverHalfWidth:Math.round(RIVER_HALF_WIDTH*((sx+sy)/2)),riverBranches:[],riverPolygon:[],riverBranchPolygons:[],bridges:[]},
    resources,gasNodes,camps
  };
}
  static seededMapRandom(seed){
  let x=(seed>>>0)||0x9e3779b9;
  return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;x>>>=0;return x/4294967296};
}
  static createProceduralMapContext(rules=GameRuleDefinition.current,baseSeed=0,roundNumber=1,candidateSeed=null){
  const m=rules?.map||GameRuleDefinition.defaults.map,width=Number(m.width)||3600,height=Number(m.height)||4200;
  const seed=(candidateSeed==null?MapGeneration.mapRuleSeed(baseSeed,rules,roundNumber):candidateSeed)>>>0,rnd=MapGeneration.seededMapRandom(seed);
  const host={x:Number(m.spawns?.host?.x)||Math.round(width*.125),y:Number(m.spawns?.host?.y)||Math.round(height*.893)};
  const guest={x:Number(m.spawns?.guest?.x)||width-host.x,y:Number(m.spawns?.guest?.y)||height-host.y};
  const axisX=guest.x-host.x,axisY=guest.y-host.y,axisLen=Math.hypot(axisX,axisY)||1;
  const ux=axisX/axisLen,uy=axisY/axisLen,nx=-uy,ny=ux;
  const margin=150,mirror=p=>({x:width-p.x,y:height-p.y});
  const clampPt=p=>({x:Math.round(RangeUtil.clamp(p.x,margin,width-margin)),y:Math.round(RangeUtil.clamp(p.y,margin,height-margin))});
  const requestedTopology=String(m.topology||"mixed");
  const topologyPool=["open","braided","hourglass","split","wild"];
  const topology=requestedTopology==="mixed"?topologyPool[Math.floor(rnd()*topologyPool.length)]:requestedTopology;
  const terrainArchetypes=["plains","ridge","riverland","basin","highlands","broken"];
  const terrainArchetype=terrainArchetypes[Math.floor(rnd()*terrainArchetypes.length)];
  const scale=Math.min(width/3600,height/4200);
  return {rules,m,width,height,seed,rnd,host,guest,axisX,axisY,ux,uy,nx,ny,mirror,clampPt,topology,terrainArchetype,scale};
}
  static generateProceduralLanes(ctx){return FrontierTerrainLayout.lanes(ctx)}
  static generateProceduralResources(ctx,capturePoints){
  const {width,height,host,guest,ux,uy,nx,ny,clampPt}=ctx;
const resources=[];let mid=0;
  const gasNodes=[];let gid=0;
  const addM=(p,amount,cluster)=>resources.push({
    id:"m"+(++mid),x:Math.round(RangeUtil.clamp(p.x,80,width-80)),y:Math.round(RangeUtil.clamp(p.y,80,height-80)),
    amount,max:amount,r:28,cluster
  });
  const addG=(p,amount,cluster)=>gasNodes.push({
    id:"g"+(++gid),x:Math.round(RangeUtil.clamp(p.x,80,width-80)),y:Math.round(RangeUtil.clamp(p.y,80,height-80)),
    amount,max:amount,r:32,cluster
  });

  const clusterPoints=(center,normal,forward,{mineralRadius=220,gasRadius=310,mineralCount=3,seedKey=""}={})=>{
    const minerals=[];
    const localRnd=MapGeneration.seededMapRandom(HashUtil.hash(`${ctx.seed}|resource-cluster|${seedKey}|${Math.round(center.x)}|${Math.round(center.y)}`));
    const minCenterRadius=mineralRadius*.88;
    const maxCenterRadius=mineralRadius*1.12;
    const minMineralGap=118;
    const maxAttempts=80;

    // 스타크래프트식 자원권: 거점 주변을 둘러싸되 각도/반경은 seed 기반 랜덤.
    // 단, 자원끼리 겹치지 않고 거점에 너무 붙지 않는 것만 강제한다.
    for(let slot=0;slot<mineralCount;slot++){
      let chosen=null;
      for(let attempt=0;attempt<maxAttempts;attempt++){
        const a=localRnd()*Math.PI*2;
        const rr=minCenterRadius+(maxCenterRadius-minCenterRadius)*localRnd();
        const q={
          x:center.x+Math.cos(a)*rr,
          y:center.y+Math.sin(a)*rr
        };
        const inBounds=q.x>=95&&q.x<=width-95&&q.y>=95&&q.y<=height-95;
        const separated=
          minerals.every(m=>Math.hypot(m.x-q.x,m.y-q.y)>=minMineralGap)&&
          gasNodes.every(g=>Math.hypot(g.x-q.x,g.y-q.y)>=120);
        if(inBounds&&separated&&(!ctx.isNavigable||ctx.isNavigable(q.x,q.y,42))){chosen=q;break}
      }

      // 극단적인 가장자리에서도 반드시 결정적으로 배치되도록 fallback.
      if(!chosen){
        // fallback도 충돌 검사를 유지하며 24방향을 결정적으로 순회한다.
        const start=localRnd()*Math.PI*2;
        for(let k=0;k<24&&!chosen;k++){
          const a=start+k*Math.PI*2/24;
          const rr=mineralRadius;
          const q=clampPt({x:center.x+Math.cos(a)*rr,y:center.y+Math.sin(a)*rr});
          const separated=
            minerals.every(m=>Math.hypot(m.x-q.x,m.y-q.y)>=minMineralGap)&&
            gasNodes.every(g=>Math.hypot(g.x-q.x,g.y-q.y)>=120);
          if(separated&&(!ctx.isNavigable||ctx.isNavigable(q.x,q.y,42)))chosen=q;
        }
      }
      if(!chosen)chosen=clampPt({x:center.x+Math.cos(slot*Math.PI*2/mineralCount)*mineralRadius,y:center.y+Math.sin(slot*Math.PI*2/mineralCount)*mineralRadius});
      minerals.push(chosen);
    }

    // 가스도 남는 방향 중 미네랄과 충분히 떨어진 위치를 seed 기반으로 선택.
    let gas=null;
    for(let attempt=0;attempt<maxAttempts;attempt++){
      const a=localRnd()*Math.PI*2;
      const rr=gasRadius*(.92+.16*localRnd());
      const q={x:center.x+Math.cos(a)*rr,y:center.y+Math.sin(a)*rr};
      const inBounds=q.x>=100&&q.x<=width-100&&q.y>=100&&q.y<=height-100;
      const separated=
        minerals.every(m=>Math.hypot(m.x-q.x,m.y-q.y)>=135)&&
        resources.every(m=>Math.hypot(m.x-q.x,m.y-q.y)>=120)&&
        gasNodes.every(g=>Math.hypot(g.x-q.x,g.y-q.y)>=110);
      if(inBounds&&separated&&(!ctx.isNavigable||ctx.isNavigable(q.x,q.y,42))){gas=q;break}
    }
    if(!gas){
      const start=Math.atan2(-normal.y,-normal.x);
      for(let k=0;k<24&&!gas;k++){
        const a=start+k*Math.PI*2/24;
        const q=clampPt({x:center.x+Math.cos(a)*gasRadius,y:center.y+Math.sin(a)*gasRadius});
        const separated=
          minerals.every(m=>Math.hypot(m.x-q.x,m.y-q.y)>=135)&&
          resources.every(m=>Math.hypot(m.x-q.x,m.y-q.y)>=120)&&
          gasNodes.every(g=>Math.hypot(g.x-q.x,g.y-q.y)>=110);
        if(separated&&(!ctx.isNavigable||ctx.isNavigable(q.x,q.y,42)))gas=q;
      }
    }
    if(!gas)gas=clampPt({x:center.x-normal.x*gasRadius,y:center.y-normal.y*gasRadius});
    return {minerals,gas,center};
  };

  const commitCluster=(id,points,{mineralAmount=900,gasAmount=1800}={})=>{
    for(const q of points.minerals)addM(q,mineralAmount,id);
    addG(points.gas,gasAmount,id);
  };

  // 메인 Base: 각자 자신의 실제 Base 좌표가 자원 원의 중심이며 미네랄 5개를 배치한다.
  const amountCfg=ctx.resourceAmounts||{};
  const baseMineral=Math.max(1,Math.round(Number(amountCfg.baseMineral)||700));
  const baseGas=Math.max(1,Math.round(Number(amountCfg.baseGas)||1600));
  const objectiveMineral=Math.max(1,Math.round(Number(amountCfg.objectiveMineral)||900));
  const objectiveGas=Math.max(1,Math.round(Number(amountCfg.objectiveGas)||1800));
  commitCluster(
    "base-h",
    clusterPoints(host,{x:nx,y:ny},{x:ux,y:uy},{mineralRadius:220,gasRadius:305,mineralCount:5,seedKey:"base-h"}),
    {mineralAmount:baseMineral,gasAmount:baseGas}
  );
  commitCluster(
    "base-g",
    clusterPoints(guest,{x:-nx,y:-ny},{x:-ux,y:-uy},{mineralRadius:220,gasRadius:305,mineralCount:5,seedKey:"base-g"}),
    {mineralAmount:baseMineral,gasAmount:baseGas}
  );

  // 모든 점령지: 점령지 자체가 향후 전진 거점 중심이다.
  // 미네랄 3개는 그 실제 중심에서 같은 거리, 가스만 더 바깥에 둔다.
  for(const cp of capturePoints||[]){
    const towardEnemy=cp.stage===1?{x:ux,y:uy}:{x:-ux,y:-uy};
    const sideNormal=cp.stage===1?{x:nx,y:ny}:{x:-nx,y:-ny};
    const tier=cp.laneKey==="mid"?1.08:1;
    commitCluster(
      `objective-${cp.id}`,
      clusterPoints(cp,sideNormal,towardEnemy,{mineralRadius:225,gasRadius:315,seedKey:`objective-${cp.id}`}),
      {
        mineralAmount:amountCfg.objectiveMineral==null?Math.round(980*tier):objectiveMineral,
        gasAmount:amountCfg.objectiveGas==null?Math.round(1850*tier):objectiveGas
      }
    );
  }
  return {resources,gasNodes};
}
  static mainObjectiveCampPoint(ctx,laneControlPoints,laneKey){
  const pts=laneControlPoints?.[laneKey]||[];
  const mid=MapGeometry.pointOnPolyline(pts,.5);
  if(laneKey==="mid")return ctx.clampPt(mid);
  const tangent=MapGeometry.laneTangentAt(pts,.5),a={x:-tangent.y,y:tangent.x},b={x:tangent.y,y:-tangent.x};
  const center={x:ctx.width/2,y:ctx.height/2};
  const qa={x:mid.x+a.x*205*ctx.scale,y:mid.y+a.y*205*ctx.scale};
  const qb={x:mid.x+b.x*205*ctx.scale,y:mid.y+b.y*205*ctx.scale};
  const da=Math.hypot(qa.x-center.x,qa.y-center.y),db=Math.hypot(qb.x-center.x,qb.y-center.y);
  return ctx.clampPt(da>=db?qa:qb);
}
  static generateProceduralCamps(ctx,capturePoints,laneControlPoints){
  const {host,axisX,axisY,nx,ny,mirror,clampPt,topology,rnd}=ctx;
  const camps=[];
  const areaGap=Math.max(40,Number(ctx.rules?.map?.generation?.minNeutralAreaGap)||40);
  const combatRadius=kind=>Math.max(0,Number(CampDefinition.get(kind)?.aggroRadius)||180);
  const pairGap=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y)-combatRadius(a.kind)-combatRadius(b.kind);
  const pairMargin=(a,b)=>pairGap(a,b)-NeutralCampPolicy.neutralCampRequiredAreaGap(a,b,areaGap);
  const placementMargin=(candidate,extra=[])=>{
    if(ctx.isNavigable&&!ctx.isNavigable(candidate.x,candidate.y,140))return -100000;
    let best=Infinity;
    for(const other of [...camps,...extra])best=Math.min(best,pairMargin(candidate,other));
    return Number.isFinite(best)?best:99999;
  };
  const addPlaced=(camp)=>{camps.push(camp);return camp};
  const placeRelic=(cp,index)=>{
    const sign=cp.stage===1?1:-1,baseAngle=Math.atan2(ny*sign,nx*sign);
    const offsets=[0,.34,-.34,.68,-.68,1.02,-1.02,1.36,-1.36,Math.PI];
    let best=null,bestGap=-Infinity;
    for(let attempt=0;attempt<40;attempt++){
      const ring=215+Math.floor(attempt/10)*55+(attempt%2)*18;
      const angle=baseAngle+offsets[attempt%offsets.length]+Math.floor(attempt/offsets.length)*.11;
      const p=clampPt({x:cp.x+Math.cos(angle)*ring,y:cp.y+Math.sin(angle)*ring});
      const candidate={id:"objective-"+cp.id,kind:"relic",x:p.x,y:p.y,state:"ready",respawnAt:0,lastHitSide:null,spawnNo:0,spellReward:true,captureId:cp.id,lane:cp.lane,label:cp.label};
      const gap=placementMargin(candidate);
      if(gap>bestGap){best=candidate;bestGap=gap}
      if(gap>=0){best=candidate;break}
    }
    const relicGroundCompositions=[
      [{unit:"boar",count:1},{unit:"wildhound",count:2}],
      [{unit:"sporetoad",count:2},{unit:"shellcrab",count:1}],
      [{unit:"shellcrab",count:2},{unit:"wildhound",count:1}],
      [{unit:"sporetoad",count:1},{unit:"wildhound",count:3}]
    ];
    best.composition=UnitCompositionDefinition.normalize(relicGroundCompositions[HashUtil.hash(`${ctx.seed}|relic|${cp.id}|${index}`)%relicGroundCompositions.length]);
    addPlaced(best);
  };
  const placePair=(id,kind,preferred)=>{
    let best=null,bestGap=-Infinity;
    const candidateAngles=[0,.45,-.45,.90,-.90,1.35,-1.35,Math.PI];
    for(let attempt=0;attempt<56;attempt++){
      const ring=attempt===0?0:45+Math.floor((attempt-1)/8)*45;
      const angle=candidateAngles[attempt%candidateAngles.length]+Math.floor(attempt/candidateAngles.length)*.17;
      const p=clampPt({x:preferred.x+Math.cos(angle)*ring,y:preferred.y+Math.sin(angle)*ring});
      const q=mirror(p);
      const a={id:id+"h",kind,x:p.x,y:p.y,state:"ready",respawnAt:0,lastHitSide:null,spawnNo:0};
      const b={id:id+"g",kind,x:q.x,y:q.y,state:"ready",respawnAt:0,lastHitSide:null,spawnNo:0};
      const gap=Math.min(placementMargin(a,[b]),placementMargin(b,[a]),pairMargin(a,b));
      if(gap>bestGap){best=[a,b];bestGap=gap}
      if(gap>=0){best=[a,b];break}
    }
    addPlaced(best[0]);addPlaced(best[1]);
  };

  // Main objectives keep their lane-authored positions. Every other neutral camp is
  // placed around these first so a minor camp can never be the reason two combat
  // territories overlap.
  const main=[
    ["main-top","objectiveBear","top"],
    ["main-mid","objectiveDeathWorm","mid"],
    ["main-bot","objectiveDragon","bot"]
  ];
  for(const [id,kind,laneKey] of main){
    const p=MapGeneration.mainObjectiveCampPoint(ctx,laneControlPoints,laneKey);
    addPlaced({id,kind,laneKey,x:Math.round(p.x),y:Math.round(p.y),state:"ready",respawnAt:0,lastHitSide:null,spawnNo:0,capturedUnitId:null,capturedOwner:null,lastDeathX:null,lastDeathY:null});
  }

  // Relics stay near their capture point, but their actual aggro circles must remain
  // independent from every already placed objective/camp. Relic composition varies
  // deterministically while staying ground-clearable for every roster.
  capturePoints.forEach(placeRelic);

  const campSpread=topology==="open"?1.35:topology==="hourglass"?.90:1;
  const lightKinds=["hounds","toads","wasps"],heavyKinds=["boars","crabs"];
  for(let i=lightKinds.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[lightKinds[i],lightKinds[j]]=[lightKinds[j],lightKinds[i]]}
  if(rnd()<.5)heavyKinds.reverse();
  // Six ordinary camps keep neutral density below the main-objective layer:
  // leave readable empty territory between fights, while three distinct families per
  // map plus varied Relic compositions increase biodiversity instead of visual clutter.
  const slots=[
    {id:"wildA",kind:lightKinds[0],t:.27,side:1,offset:330+rnd()*240},
    {id:"wildB",kind:lightKinds[1],t:.35,side:-1,offset:390+rnd()*230},
    {id:"wildC",kind:heavyKinds[0],t:.43,side:1,offset:350+rnd()*240}
  ];
  for(const slot of slots){
    const preferred=clampPt({
      x:host.x+axisX*slot.t+nx*slot.side*slot.offset*campSpread,
      y:host.y+axisY*slot.t+ny*slot.side*slot.offset*campSpread
    });
    placePair(slot.id,slot.kind,preferred);
  }
  return camps;
}
  static proceduralFrontierMapCandidate(rules=GameRuleDefinition.current,baseSeed=0,roundNumber=1,candidateSeed=null){
    const ctx=MapGeneration.createProceduralMapContext(rules,baseSeed,roundNumber,candidateSeed);
    const layout=FrontierTerrainLayout.create(ctx),{layers,ramps,blockers,structures}=layout;
    ctx.terrainLayout=layout;
    const {laneControlPoints,laneNormals,capturePoints}=MapGeneration.generateProceduralLanes(ctx);
    const terrain={layers,ramps,blockers,riverPath:[],riverBranches:[],riverPolygon:[],riverBranchPolygons:[],riverHalfWidth:80,bridges:[]};
    // Add the full walkable bank before placing strategic objects, so placement
    // sees the same signed heights and slopes as movement and visibility.
    Object.assign(terrain,FrontierTerrainLayout.water(ctx));
    terrain.bridges=MapGeneration.generateProceduralBridges(ctx,laneControlPoints,terrain);
    terrain.layers.push(...terrain.riverBankLayers);delete terrain.riverBankLayers;
    const geometry=new TerrainGeometry({width:ctx.width,height:ctx.height,terrain});
    ctx.isNavigable=(x,y,r=140)=>geometry.circleClear(x,y,r)&&geometry.surfaces.buildable(x,y,r)&&!geometry.surfaces.layers.some(l=>l.innerPoints?.length&&MapGeometry.pointInSimplePolygon(x,y,l.points));
    const {resources,gasNodes}=MapGeneration.generateProceduralResources(ctx,capturePoints);
    const camps=MapGeneration.generateProceduralCamps(ctx,capturePoints,laneControlPoints);
    const {m,width,height,seed,host,guest,topology,terrainArchetype}=ctx;
    return {schemaVersion:MAP_DESCRIPTOR_SCHEMA_VERSION,generator:'procedural-frontier',generatorVersion:10,seed,width,height,biome:m.biome||'frontier',topology,terrainArchetype,symmetry:'rotational-terrain',spawns:{host,guest},flags:[MapGeometry.pointOnPolyline(laneControlPoints.mid,.18),MapGeometry.pointOnPolyline(laneControlPoints.mid,.82)].map(p=>({...p,forced:false})),laneControlPoints,laneNormals,capturePoints,terrain,resources,gasNodes,camps,authoredStructures:structures};
  }
  static mapTerrainDescriptor(mapDescriptor){
  return mapDescriptor?.terrain||{layers:[],ramps:[],blockers:[],riverPath:RIVER_PATH,riverHalfWidth:RIVER_HALF_WIDTH,riverBranches:[],bridges:[]};
}
  static mapTerrainFlagsAt(desc,x,y){return TerrainQuery.at(desc,x,y)}
  static mainObjectiveMapDiagnostics(desc){
  const terrain=MapGeneration.mapTerrainDescriptor(desc),main=(desc.camps||[]).filter(c=>!!CampDefinition.get(c.kind)?.mainObjective),atlas=TerrainSurfaceAtlas.fromMap(desc);
  const elevatedCoverageByLane={top:0,mid:0,bot:0};
  // Sample the playable corridor against the same level atlas used by combat/vision.
  for(const laneKey of ["top","mid","bot"]){
    const pts=desc.laneControlPoints?.[laneKey]||[];let hit=0,total=0;
    for(let i=0;i<=48;i++){
      const t=i/48,q=MapGeometry.pointOnPolyline(pts,t),tan=MapGeometry.laneTangentAt(pts,t),nx=-tan.y,ny=tan.x;
      for(const offset of [-180,-90,0,90,180]){
        total++;if(atlas.levelAt(q.x+nx*offset,q.y+ny*offset)>0)hit++;
      }
    }
    elevatedCoverageByLane[laneKey]=total?Math.round(hit/total*1000)/1000:0;
  }
  const crossings=MapGeometry.laneRiverCrossings(desc.laneControlPoints,terrain);
  let objectiveFlankWidth=Infinity,accessible=true;
  for(const c of main){
    if(c.x<270||c.x>desc.width-270||c.y<270||c.y>desc.height-270)accessible=false;
    const centerFlags=MapGeneration.mapTerrainFlagsAt(desc,c.x,c.y);
    if(centerFlags.river||centerFlags.level>0)accessible=false;
    let clear=0;const radius=165,samples=16;
    for(let i=0;i<samples;i++){
      const a=i/samples*Math.PI*2,q={x:c.x+Math.cos(a)*radius,y:c.y+Math.sin(a)*radius},f=MapGeneration.mapTerrainFlagsAt(desc,q.x,q.y);
      if(!f.river&&f.level===0)clear++;
    }
    const width=clear/samples*(Math.PI*2*radius);objectiveFlankWidth=Math.min(objectiveFlankWidth,width);if(clear<5)accessible=false;
  }
  if(!Number.isFinite(objectiveFlankWidth))objectiveFlankWidth=0;
  let bridgeLevelOverlap=false;
  for(const b of terrain.bridges||[]){
    const ca=Math.cos(b.angle||0),sa=Math.sin(b.angle||0),probes=[[0,0],[b.halfLength,0],[-b.halfLength,0],[0,b.halfWidth],[0,-b.halfWidth]];
    for(const [lx,ly] of probes){if(atlas.levelAt(b.x+lx*ca-ly*sa,b.y+lx*sa+ly*ca)>0){bridgeLevelOverlap=true;break}}
    if(bridgeLevelOverlap)break;
  }
  return{
    elevatedLayerCount:atlas.layers.filter(l=>l.level>0).length,elevatedCoverageByLane,riverCrossingCount:crossings.length,bridgeCount:(terrain.bridges||[]).length,
    objectiveFlankWidth:Math.round(objectiveFlankWidth),mainObjectiveAccessibility:accessible,bridgeLevelOverlap
  };
}
  static evaluateProceduralMapCandidate(desc,rules=GameRuleDefinition.current){
  const g=rules?.map?.generation||GameRuleDefinition.defaults.map.generation;
  const host=desc.spawns.host,guest=desc.spawns.guest;
  const hostileCamps=desc.camps.filter(c=>c.kind!=="relic");
  const allNeutralCamps=desc.camps||[];
  // A base's own plateau is its buildable starting room, not a spawn hazard.
  const elevatedCenters=TerrainSurfaceAtlas.fromMap(desc).layers.filter(l=>l.level>0&&!MapGeometry.pointInSimplePolygon(host.x,host.y,l.points)&&!MapGeometry.pointInSimplePolygon(guest.x,guest.y,l.points)).map(l=>({x:l.points.reduce((n,p)=>n+p.x,0)/l.points.length,y:l.points.reduce((n,p)=>n+p.y,0)/l.points.length}));
  const spawnHazardDistance=Math.min(MapGeometry.nearestMapDistance(host,hostileCamps),MapGeometry.nearestMapDistance(guest,hostileCamps),MapGeometry.nearestMapDistance(host,elevatedCenters),MapGeometry.nearestMapDistance(guest,elevatedCenters));
  const resourceClearance=Math.min(MapGeometry.minMapPairDistance(desc.resources),MapGeometry.minMapPairDistance(desc.gasNodes));
  const neutralClearance=MapGeometry.minMapPairDistance(allNeutralCamps);
  const neutralAreaGap=MapGeometry.minNeutralCampAreaGap(allNeutralCamps);
  const neutralAreaMargin=MapGeometry.minNeutralCampAreaMargin(allNeutralCamps,Math.max(40,Number(g.minNeutralAreaGap)||40));
  const objectives=desc.capturePoints||[];
  const objectiveClearance=MapGeometry.minMapPairDistance(objectives);
  const laneCenters=Object.values(desc.laneControlPoints||{}).map(pts=>MapGeometry.pointOnPolyline(pts,.5));
  const laneSeparation=MapGeometry.minMapPairDistance(laneCenters);
  let maxObjectiveLaneOffset=0,maxLaneEndpointError=0;
  for(const cp of objectives){
    const pts=desc.laneControlPoints?.[cp.laneKey]||[];
    if(pts.length>1)maxObjectiveLaneOffset=Math.max(maxObjectiveLaneOffset,MapGeometry.pointPolylineDist(cp.x,cp.y,pts));
  }
  for(const pts of Object.values(desc.laneControlPoints||{})){
    if(!pts.length)continue;
    maxLaneEndpointError=Math.max(
      maxLaneEndpointError,
      MapGeometry.mapPointDistance(pts[0],host),
      MapGeometry.mapPointDistance(pts[pts.length-1],guest)
    );
  }
  const hostObjectives=objectives.filter(o=>o.stage===1),guestObjectives=objectives.filter(o=>o.stage===2);
  const hostObjCost=hostObjectives.reduce((s,o)=>s+MapGeometry.mapPointDistance(host,o),0)/Math.max(1,hostObjectives.length);
  const guestObjCost=guestObjectives.reduce((s,o)=>s+MapGeometry.mapPointDistance(guest,o),0)/Math.max(1,guestObjectives.length);
  const hostRes=(desc.resources||[]).filter(r=>String(r.cluster||"").includes("-1"));
  const guestRes=(desc.resources||[]).filter(r=>String(r.cluster||"").includes("-2"));
  const hostResCost=hostRes.reduce((s,o)=>s+MapGeometry.mapPointDistance(host,o),0)/Math.max(1,hostRes.length);
  const guestResCost=guestRes.reduce((s,o)=>s+MapGeometry.mapPointDistance(guest,o),0)/Math.max(1,guestRes.length);
  const fairnessError=Math.max(
    Math.abs(hostObjCost-guestObjCost)/Math.max(1,(hostObjCost+guestObjCost)/2),
    Math.abs(hostResCost-guestResCost)/Math.max(1,(hostResCost+guestResCost)/2)
  );
  const spawnClearanceTarget=Math.max(220,Number(g.minSpawnClearance)||560)*.7;
  const topology=String(desc.topology||"mixed");
  const objectiveFactor=topology==="braided"?.78:topology==="wild"?.86:1;
  const laneFactor=topology==="hourglass"?.42:topology==="braided"?.72:topology==="wild"?.78:1;
  const objectiveTarget=Math.max(120,Number(g.minObjectiveClearance)||260)*objectiveFactor;
  const resourceTarget=Math.max(55,Number(g.minResourceClearance)||90);
  const neutralTarget=Math.max(90,Number(g.minNeutralClearance)||140);
  const neutralAreaGapTarget=Math.max(40,Number(g.minNeutralAreaGap)||40);
  const laneTarget=Math.min(desc.width,desc.height)*Math.max(.04,Math.min(.14,Number(g.minLaneSeparationRatio)||.07))*laneFactor;
  const validResourceCluster=(center,id,expectedMinerals=3)=>{
    const ms=(desc.resources||[]).filter(r=>String(r.cluster||"")===id);
    const gs=(desc.gasNodes||[]).filter(g=>String(g.cluster||"")===id);
    if(ms.length!==expectedMinerals||gs.length!==1)return false;
    const rs=ms.map(m=>MapGeometry.mapPointDistance(center,m));
    if(Math.min(...rs)<175||Math.max(...rs)>285)return false;
    for(let i=0;i<ms.length;i++)for(let j=i+1;j<ms.length;j++){
      if(MapGeometry.mapPointDistance(ms[i],ms[j])<105)return false;
    }
    // gasExtractor(size 30) + mineral radius 28 + build margin 16 = 74.
    // 여유를 포함해 120 이상을 생성 단계에서 보장한다.
    if(ms.some(m=>MapGeometry.mapPointDistance(m,gs[0])<120))return false;
    if(gs[0].x<100||gs[0].x>desc.width-100||gs[0].y<100||gs[0].y>desc.height-100)return false;
    return true;
  };
  const objectiveResourceComposition=(desc.capturePoints||[]).every(
    cp=>validResourceCluster(cp,`objective-${cp.id}`)
  );
  const baseResourceRadii=
    validResourceCluster(desc.spawns.host,"base-h",5)&&
    validResourceCluster(desc.spawns.guest,"base-g",5);
  const gasBuildable=(desc.gasNodes||[]).every(g=>{
    if(g.x<100||g.x>desc.width-100||g.y<100||g.y>desc.height-100)return false;
    return (desc.resources||[]).every(m=>MapGeometry.mapPointDistance(g,m)>=90);
  });
  const terrainVariety=(desc.terrain?.layers||[]).length>=2;
  const objectiveTerrain=MapGeneration.mainObjectiveMapDiagnostics(desc);
  const blockerGeometry=TerrainGeometry.fromMap(desc),blockerCount=(desc.terrain?.blockers||[]).length;
  const blockerSubjects=[...objectives,...(desc.resources||[]),...(desc.gasNodes||[]),...(desc.camps||[]),desc.spawns.host,desc.spawns.guest];
  const blockerPlacement=blockerCount>=2&&blockerSubjects.every(p=>blockerGeometry.circleClear(p.x,p.y,Math.max(42,Number(p.r)||0)));
  const checks={
    ...FrontierTerrainLayout.safety(desc),
    spawnClearance:spawnHazardDistance>=spawnClearanceTarget,
    objectiveResources:objectiveResourceComposition,
    baseResourceRadii,
    gasBuildable,
    terrainVariety,
    blockerPlacement,
    objectiveClearance:objectiveClearance>=objectiveTarget,
    resourceClearance:resourceClearance>=resourceTarget,
    neutralClearance:neutralClearance>=neutralTarget,
    neutralAreaSeparation:neutralAreaMargin>=0,
    laneDiversity:laneSeparation>=laneTarget,
    objectiveOnLane:maxObjectiveLaneOffset<=36,
    laneConnectsBases:maxLaneEndpointError<=36,
    bridgeLevelSeparation:!objectiveTerrain.bridgeLevelOverlap,
    mainObjectiveAccessibility:objectiveTerrain.mainObjectiveAccessibility&&objectiveTerrain.objectiveFlankWidth>=220,
    fairness:fairnessError<=Math.max(.10,Number(g.fairnessTolerance)||.12)
  };
  checks.groundConnectivity=Object.values(checks).every(Boolean)?FrontierTerrainLayout.connectedLayout(desc):false;
  const ratios=[spawnHazardDistance/spawnClearanceTarget,objectiveClearance/objectiveTarget,resourceClearance/resourceTarget,neutralClearance/neutralTarget,Math.max(0,neutralAreaGap)/neutralAreaGapTarget,laneSeparation/laneTarget];
  const midCoverage=Number(objectiveTerrain.elevatedCoverageByLane?.mid)||0,sideCoverage=((Number(objectiveTerrain.elevatedCoverageByLane?.top)||0)+(Number(objectiveTerrain.elevatedCoverageByLane?.bot)||0))/2;
  let terrainSoftBonus=0;
  if(midCoverage>sideCoverage)terrainSoftBonus+=Math.min(4,(midCoverage-sideCoverage)*10);
  if(objectiveTerrain.elevatedLayerCount>=2&&objectiveTerrain.elevatedLayerCount<=8)terrainSoftBonus+=2.5;
  if(objectiveTerrain.bridgeCount>=1&&objectiveTerrain.bridgeCount<=2)terrainSoftBonus+=2;
  const score=Math.round((ratios.reduce((sum,v)=>sum+Math.min(1.5,v),0)*16+(checks.fairness?20:0)+terrainSoftBonus)*1000)/1000;
  return {accepted:Object.values(checks).every(Boolean),score,checks,metrics:{spawnHazardDistance:Math.round(spawnHazardDistance),objectiveClearance:Math.round(objectiveClearance),resourceClearance:Math.round(resourceClearance),neutralClearance:Math.round(neutralClearance),neutralAreaGap:Math.round(neutralAreaGap),neutralAreaMargin:Math.round(neutralAreaMargin),laneSeparation:Math.round(laneSeparation),maxObjectiveLaneOffset:Math.round(maxObjectiveLaneOffset),maxLaneEndpointError:Math.round(maxLaneEndpointError),fairnessError:Math.round(fairnessError*1000)/1000,terrainSoftBonus:Math.round(terrainSoftBonus*1000)/1000,...objectiveTerrain}};
}
  static proceduralFrontierMapDescriptor(rules=GameRuleDefinition.current,baseSeed=0,roundNumber=1){
  const rootSeed=MapGeneration.mapRuleSeed(baseSeed,rules,roundNumber);
  const requestedTopology=String(rules?.map?.topology||"mixed");
  const topologyPool=["open","braided","hourglass","split","wild"];
  const topology=requestedTopology==="mixed"?topologyPool[HashUtil.hash(`${rootSeed}|topology`)%topologyPool.length]:requestedTopology;
  const candidateRules=requestedTopology==="mixed"?GameRuleRuntime.mergeGameRules(rules,{map:{topology}}):rules;
  const attempts=Math.max(1,Math.min(64,Math.floor(Number(rules?.map?.generation?.attempts)||24)));
  let best=null,bestEval=null,bestAttempt=0;
  for(let attempt=0;attempt<attempts;attempt++){
    const candidateSeed=HashUtil.hash(`${rootSeed}|${topology}|candidate|${attempt}`)>>>0;
    const candidate=MapGeneration.proceduralFrontierMapCandidate(candidateRules,baseSeed,roundNumber,candidateSeed);
    const quality=MapGeneration.evaluateProceduralMapCandidate(candidate,candidateRules);
    if(!best||quality.score>bestEval.score){best=candidate;bestEval=quality;bestAttempt=attempt}
    if(quality.accepted){best=candidate;bestEval=quality;bestAttempt=attempt;break}
  }
  best.seed=rootSeed;
  best.topology=topology;
  best.generation={attempt:bestAttempt,attemptsTried:bestAttempt+1,accepted:bestEval.accepted,score:bestEval.score,checks:bestEval.checks,metrics:bestEval.metrics};
  return best;
}
  static generateMapDescriptor({rules=GameRuleDefinition.current,seed=0,roundNumber=1}={}){
  const id=rules?.map?.generator||"fixed-standard";
  const key=JSON.stringify([id,seed>>>0,roundNumber||1,rules]);
  if(this.descriptorCache?.key===key)return this.descriptorCache.descriptor;
  const generator=MAP_GENERATORS[id]||MAP_GENERATORS["fixed-standard"];
  const out=generator(rules,seed,roundNumber);
  out.generator=id in MAP_GENERATORS?id:"fixed-standard";
  this.descriptorCache={key,descriptor:out};
  return out;
}
  static generateProceduralBridges(ctx,laneControlPoints,terrain){
  // Span the depressed floor and both banks; bridge endpoints return to level 0.
  const crossings=MapGeometry.laneRiverCrossings(laneControlPoints,{...terrain,riverHalfWidth:(terrain.riverHalfWidth||80)+(terrain.riverBankWidth||0)}),eligible=[];
  for(const c of crossings){
    const chance=c.laneKey==="mid"?.55:.32;
    const roll=(HashUtil.hash(`${ctx.seed}|bridge|${c.laneKey}|${Math.round(c.t*1000)}`)%10000)/10000;
    if(roll>=chance)continue;
    const tangent=MapGeometry.laneTangentAt(laneControlPoints[c.laneKey],c.t);
    eligible.push({...c,priority:c.laneKey==="mid"?0:1,roll,tangent});
  }
  eligible.sort((a,b)=>a.priority-b.priority||a.roll-b.roll||a.laneKey.localeCompare(b.laneKey)||a.t-b.t);
  return eligible.slice(0,2).map((c,i)=>{
    const angle=Math.atan2(c.tangent.y,c.tangent.x),ca=Math.cos(-angle),sa=Math.sin(-angle);
    const project=(p)=>{const ox=p.x-c.x,oy=p.y-c.y;return ox*ca-oy*sa};
    const bankSpan=Math.max(Math.abs(project(c.start)),Math.abs(project(c.end)));
    const bankOverhang=Math.max(28*ctx.scale,(terrain.riverHalfWidth||80)*.18);
    const x=Math.round(c.x),y=Math.round(c.y),halfWidth=Math.round(46*ctx.scale),banks=terrain.riverBankLayers||(terrain.layers||[]).filter(l=>l.innerPoints?.length);
    // The lane crossing is curved but the deck is straight. Projected lane
    // endpoints can miss a thin bank sliver between sampled endcap points.
    // Require both complete endcap segments, plus their land margin, to clear
    // every bank polygon before fixing the actual level-0 bridge footprint.
    const endcapsClear=halfLength=>[-1,1].every(sign=>{
      const ex=x+sign*halfLength*Math.cos(angle),ey=y+sign*halfLength*Math.sin(angle);
      const a={x:ex-halfWidth*Math.sin(angle),y:ey+halfWidth*Math.cos(angle)},b={x:ex+halfWidth*Math.sin(angle),y:ey-halfWidth*Math.cos(angle)};
      return banks.every(bank=>!MapGeometry.pointInSimplePolygon(a.x,a.y,bank.points)&&!MapGeometry.pointInSimplePolygon(b.x,b.y,bank.points)&&bank.points.every((p,j)=>{const q=bank.points[(j+1)%bank.points.length];return TerrainGeometry.segmentEdgeDistance(a.x,a.y,b.x,b.y,p.x,p.y,q.x,q.y)>=bankOverhang}));
    });
    let halfLength=Math.max(120,Math.ceil(bankSpan+bankOverhang));
    const extent=Math.ceil(Math.hypot(ctx.width,ctx.height));
    while(halfLength<extent&&!endcapsClear(halfLength))halfLength++;
    return {
      id:`bridge-${c.laneKey}-${i}`,laneKey:c.laneKey,level:0,x,y,
      angle,
      halfLength,
      halfWidth,
      crossingT:Math.round(c.t*10000)/10000,
      crossingStartT:Math.round(c.startT*10000)/10000,
      crossingEndT:Math.round(c.endT*10000)/10000
    };
  }).filter(b=>{
    const ca=Math.cos(b.angle),sa=Math.sin(b.angle),points=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>({x:b.x+x*b.halfLength*ca-y*b.halfWidth*sa,y:b.y+x*b.halfLength*sa+y*b.halfWidth*ca}));
    const atlas=TerrainSurfaceAtlas.fromMap({width:ctx.width,height:ctx.height,terrain:ctx.terrainLayout||FrontierTerrainLayout.create(ctx)});
    return points.every(p=>p.x>=0&&p.x<=ctx.width&&p.y>=0&&p.y<=ctx.height)&&![...atlas.layers,...atlas.ramps].some(l=>TerrainSurfaceAtlas.polygonsOverlap(points,l.points));
  });
}
}

const MAP_GENERATORS={"fixed-standard":MapGeneration.fixedStandardMapDescriptor,"procedural-frontier":MapGeneration.proceduralFrontierMapDescriptor};

export { CloneUtil, HashUtil, MapGeneration };
