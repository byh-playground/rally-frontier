// Lane, capture point and river geometry.
import { RangeUtil } from '../core/game-rules.js';
import { LANE_CONTROL_POINTS } from '../definitions/combat-rules.js';
import { RallyGamekit } from '../core/gamekit.js';
const { pointPolylineDistance, roundedPointOnPolyline } = RallyGamekit;

class MapGeometry{
  static lanePoint(lane,t){return roundedPointOnPolyline(LANE_CONTROL_POINTS[lane],t)}
  static pointInBridgeZone(x,y,b,margin=0){
  if(!b)return false;
  const angle=Number(b.angle)||0,ca=Math.cos(-angle),sa=Math.sin(-angle);
  const ox=x-(b.x||0),oy=y-(b.y||0);
  const lx=ox*ca-oy*sa,ly=ox*sa+oy*ca;
  return Math.abs(lx)<=Math.max(1,Number(b.halfLength)||120)+margin&&Math.abs(ly)<=Math.max(1,Number(b.halfWidth)||48)+margin;
}
  static riverDistanceAt(x,y,terrain){
  let best=Infinity;
  if((terrain?.riverPath||[]).length>1)best=Math.min(best,pointPolylineDistance(x,y,terrain.riverPath));
  for(const branch of terrain?.riverBranches||[])if(branch.length>1)best=Math.min(best,pointPolylineDistance(x,y,branch));
  return best;
}
  static laneRiverCrossings(laneControlPoints,terrain){
  const result=[],samples=240;
  const wetAt=(pts,t)=>{
    const p=roundedPointOnPolyline(pts,t);
    return MapGeometry.riverDistanceAt(p.x,p.y,terrain)<=Math.max(1,Number(terrain.riverHalfWidth)||0)*1.03;
  };
  const refineBoundary=(pts,lo,hi,targetWet)=>{
    let a=RangeUtil.clamp(lo,0,1),b=RangeUtil.clamp(hi,0,1);
    for(let n=0;n<8;n++){
      const m=(a+b)/2;
      if(wetAt(pts,m)===targetWet)b=m;else a=m;
    }
    return (a+b)/2;
  };
  for(const laneKey of ["top","mid","bot"]){
    const pts=laneControlPoints?.[laneKey]||[];if(pts.length<2)continue;
    let inside=false,startT=0,prevT=0,prevWet=wetAt(pts,0);
    if(prevWet){inside=true;startT=0}
    for(let i=1;i<=samples;i++){
      const t=i/samples,wet=wetAt(pts,t);
      if(wet&&!inside){
        inside=true;
        startT=refineBoundary(pts,prevT,t,true);
      }
      if((!wet||i===samples)&&inside){
        const endT=wet?1:refineBoundary(pts,prevT,t,false);
        const midT=(startT+endT)/2;
        const q=roundedPointOnPolyline(pts,midT),start=roundedPointOnPolyline(pts,startT),end=roundedPointOnPolyline(pts,endT);
        result.push({laneKey,t:midT,startT,endT,x:q.x,y:q.y,start,end});
        inside=false;
      }
      prevT=t;prevWet=wet;
    }
  }
  return result;
}
  
  
  
}

const LANE_NORMALS={
  top:{x:-0.88,y:-0.47},
  mid:{x:-0.71,y:0.71},
  bot:{x:0.88,y:0.47}
};

class CapturePointDefinition{
  static all=[
  {id:"top-1",lane:"TOP",laneKey:"top",label:"TOP 1",stage:1,...MapGeometry.lanePoint("top",.30)},
  {id:"top-2",lane:"TOP",laneKey:"top",label:"TOP 2",stage:2,...MapGeometry.lanePoint("top",.73)},
  {id:"mid-1",lane:"MID",laneKey:"mid",label:"MID 1",stage:1,...MapGeometry.lanePoint("mid",.32)},
  {id:"mid-2",lane:"MID",laneKey:"mid",label:"MID 2",stage:2,...MapGeometry.lanePoint("mid",.68)},
  {id:"bot-1",lane:"BOT",laneKey:"bot",label:"BOT 1",stage:1,...MapGeometry.lanePoint("bot",.28)},
  {id:"bot-2",lane:"BOT",laneKey:"bot",label:"BOT 2",stage:2,...MapGeometry.lanePoint("bot",.72)}
];
}

// 실제 전투 판정에 사용되는 강. 고지는 terrain.layers[].level에서만 파생한다.
// 강: 이동속도 50%, 적에게 받는 피해 1.5배.
const RIVER_PATH=[
  {x:430,y:1120},
  {x:920,y:1400},
  {x:1420,y:1700},
  {x:1800,y:2100},
  {x:2220,y:2480},
  {x:2720,y:2860},
  {x:3230,y:3160}
];
const RIVER_HALF_WIDTH=150;

export { CapturePointDefinition, LANE_NORMALS, MapGeometry, RIVER_HALF_WIDTH, RIVER_PATH };
