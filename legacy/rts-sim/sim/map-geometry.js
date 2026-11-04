// Lane, capture point and river geometry.
import { RangeUtil } from '../core/game-rules.js';
import { CampDefinition, NeutralCampPolicy } from '../definitions/cards.js';
import { LANE_CONTROL_POINTS } from '../definitions/combat-rules.js';

class MapGeometry{
  static lanePoint(lane,t){
  const pts=LANE_CONTROL_POINTS[lane];
  const segs=[]; let total=0;
  for(let i=0;i<pts.length-1;i++){
    const dx=pts[i+1].x-pts[i].x, dy=pts[i+1].y-pts[i].y;
    const len=Math.hypot(dx,dy);
    segs.push(len); total+=len;
  }
  const target=RangeUtil.clamp(t,0,1)*total;
  let acc=0;
  for(let i=0;i<segs.length;i++){
    const len=segs[i];
    if(target<=acc+len||i===segs.length-1){
      const p=(target-acc)/(len||1);
      return {
        x:Math.round(pts[i].x+(pts[i+1].x-pts[i].x)*p),
        y:Math.round(pts[i].y+(pts[i+1].y-pts[i].y)*p)
      };
    }
    acc+=len;
  }
  return {...pts[pts.length-1]};
}
  static pointSegDist(px,py,ax,ay,bx,by){
  const abx=bx-ax,aby=by-ay;
  const denom=abx*abx+aby*aby||1;
  let t=((px-ax)*abx+(py-ay)*aby)/denom;
  t=Math.max(0,Math.min(1,t));
  const cx=ax+abx*t,cy=ay+aby*t;
  return Math.hypot(px-cx,py-cy);
}
  static pointPolylineDist(px,py,pts){
  let best=1e9;
  for(let i=0;i<pts.length-1;i++){
    best=Math.min(best,MapGeometry.pointSegDist(px,py,pts[i].x,pts[i].y,pts[i+1].x,pts[i+1].y));
  }
  return best;
}
  static pointInBridgeZone(x,y,b,margin=0){
  if(!b)return false;
  const angle=Number(b.angle)||0,ca=Math.cos(-angle),sa=Math.sin(-angle);
  const ox=x-(b.x||0),oy=y-(b.y||0);
  const lx=ox*ca-oy*sa,ly=ox*sa+oy*ca;
  return Math.abs(lx)<=Math.max(1,Number(b.halfLength)||120)+margin&&Math.abs(ly)<=Math.max(1,Number(b.halfWidth)||48)+margin;
}
  static laneTangentAt(pts,t){
  const a=MapGeometry.pointOnPolyline(pts,RangeUtil.clamp(t-.015,0,1)),b=MapGeometry.pointOnPolyline(pts,RangeUtil.clamp(t+.015,0,1));
  const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1;
  return{x:dx/len,y:dy/len};
}
  static riverDistanceAt(x,y,terrain){
  let best=Infinity;
  if((terrain?.riverPath||[]).length>1)best=Math.min(best,MapGeometry.pointPolylineDist(x,y,terrain.riverPath));
  for(const branch of terrain?.riverBranches||[])if(branch.length>1)best=Math.min(best,MapGeometry.pointPolylineDist(x,y,branch));
  return best;
}
  static laneRiverCrossings(laneControlPoints,terrain){
  const result=[],samples=240;
  const wetAt=(pts,t)=>{
    const p=MapGeometry.pointOnPolyline(pts,t);
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
        const q=MapGeometry.pointOnPolyline(pts,midT),start=MapGeometry.pointOnPolyline(pts,startT),end=MapGeometry.pointOnPolyline(pts,endT);
        result.push({laneKey,t:midT,startT,endT,x:q.x,y:q.y,start,end});
        inside=false;
      }
      prevT=t;prevWet=wet;
    }
  }
  return result;
}
  static pointOnPolyline(pts,t){
  if(!Array.isArray(pts)||pts.length<2)return pts?.[0]?{...pts[0]}:{x:0,y:0};
  const segs=[];let total=0;
  for(let i=0;i<pts.length-1;i++){const len=Math.hypot(pts[i+1].x-pts[i].x,pts[i+1].y-pts[i].y);segs.push(len);total+=len}
  let target=RangeUtil.clamp(t,0,1)*total,acc=0;
  for(let i=0;i<segs.length;i++){
    if(target<=acc+segs[i]||i===segs.length-1){const q=(target-acc)/(segs[i]||1);return{x:Math.round(pts[i].x+(pts[i+1].x-pts[i].x)*q),y:Math.round(pts[i].y+(pts[i+1].y-pts[i].y)*q)}}
    acc+=segs[i];
  }
  return{...pts[pts.length-1]};
}
  static closestPolylineProgress(pts,x,y){
  if(!Array.isArray(pts)||pts.length<2)return 0;
  let total=0;const lengths=[];
  for(let i=0;i<pts.length-1;i++){const len=Math.hypot(pts[i+1].x-pts[i].x,pts[i+1].y-pts[i].y);lengths.push(len);total+=len}
  if(total<=0)return 0;
  let acc=0,bestD=Infinity,bestAlong=0;
  for(let i=0;i<pts.length-1;i++){
    const a=pts[i],b=pts[i+1],dx=b.x-a.x,dy=b.y-a.y,len2=dx*dx+dy*dy||1;
    const q=RangeUtil.clamp(((x-a.x)*dx+(y-a.y)*dy)/len2,0,1);
    const px=a.x+dx*q,py=a.y+dy*q,d=(x-px)*(x-px)+(y-py)*(y-py);
    if(d<bestD){bestD=d;bestAlong=acc+lengths[i]*q}
    acc+=lengths[i];
  }
  return RangeUtil.clamp(bestAlong/total,0,1);
}
  static catmullRomPoint(p0,p1,p2,p3,t){
  const t2=t*t,t3=t2*t;
  return{
    x:.5*((2*p1.x)+(-p0.x+p2.x)*t+(2*p0.x-5*p1.x+4*p2.x-p3.x)*t2+(-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
    y:.5*((2*p1.y)+(-p0.y+p2.y)*t+(2*p0.y-5*p1.y+4*p2.y-p3.y)*t2+(-p0.y+3*p1.y-3*p2.y+p3.y)*t3)
  };
}
  static smoothPolylineCatmull(points,steps=5){
  if(!Array.isArray(points)||points.length<2)return points||[];
  const out=[];
  for(let i=0;i<points.length-1;i++){
    const p0=points[Math.max(0,i-1)],p1=points[i],p2=points[i+1],p3=points[Math.min(points.length-1,i+2)];
    for(let s=0;s<steps;s++)out.push(MapGeometry.catmullRomPoint(p0,p1,p2,p3,s/steps));
  }
  out.push({...points[points.length-1]});
  return out;
}
  static insetPolygonTowardCenter(points,factor){
  if(!Array.isArray(points)||points.length<3)return points||[];
  const cx=points.reduce((s,p)=>s+p.x,0)/points.length;
  const cy=points.reduce((s,p)=>s+p.y,0)/points.length;
  return points.map(p=>({x:p.x+(cx-p.x)*factor,y:p.y+(cy-p.y)*factor}));
}
  
  
  static polylineToRibbonPolygon(points,halfWidth,clampFn=null){
  if(!Array.isArray(points)||points.length<2)return[];
  const left=[],right=[];
  for(let i=0;i<points.length;i++){
    const prev=points[Math.max(0,i-1)],next=points[Math.min(points.length-1,i+1)];
    const dx=next.x-prev.x,dy=next.y-prev.y,len=Math.hypot(dx,dy)||1;
    const tx=dx/len,ty=dy/len,nx=-ty,ny=tx;
    let bx=points[i].x,by=points[i].y;
    if(i===0){bx-=tx*halfWidth*.72;by-=ty*halfWidth*.72}
    else if(i===points.length-1){bx+=tx*halfWidth*.72;by+=ty*halfWidth*.72}
    const l={x:bx+nx*halfWidth,y:by+ny*halfWidth};
    const r={x:bx-nx*halfWidth,y:by-ny*halfWidth};
    left.push(clampFn?clampFn(l):l);
    right.push(clampFn?clampFn(r):r);
  }
  // 중심 spline이 이미 매끄럽기 때문에 닫힌 polygon 전체를 다시 평균화하지 않는다.
  // 전체 smoothing은 긴 곡선에서 양 bank가 서로 말려들며 self-intersection을 만들 수 있다.
  return [...left,...right.reverse()];
}
  static pointInSimplePolygon(x,y,points){
  if(!Array.isArray(points)||points.length<3)return false;
  let inside=false;
  for(let i=0,j=points.length-1;i<points.length;j=i++){
    const a=points[i],b=points[j];
    const hit=((a.y>y)!==(b.y>y))&&(x<(b.x-a.x)*(y-a.y)/((b.y-a.y)||1e-9)+a.x);
    if(hit)inside=!inside;
  }
  return inside;
}
  static mapPointDistance(a,b){return Math.hypot((a?.x||0)-(b?.x||0),(a?.y||0)-(b?.y||0))}
  static nearestMapDistance(point,items){
  let best=Infinity;
  for(const item of items||[])best=Math.min(best,MapGeometry.mapPointDistance(point,item));
  return best;
}
  static minMapPairDistance(items){
  let best=Infinity;
  for(let i=0;i<(items||[]).length;i++)for(let j=i+1;j<items.length;j++)best=Math.min(best,MapGeometry.mapPointDistance(items[i],items[j]));
  return Number.isFinite(best)?best:99999;
}
  static minNeutralCampAreaGap(camps){
  let best=Infinity;
  const list=camps||[];
  for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){
    const a=list[i],b=list[j],ar=Math.max(0,Number(CampDefinition.get(a.kind)?.aggroRadius)||180),br=Math.max(0,Number(CampDefinition.get(b.kind)?.aggroRadius)||180);
    best=Math.min(best,MapGeometry.mapPointDistance(a,b)-ar-br);
  }
  return Number.isFinite(best)?best:99999;
}
  static minNeutralCampAreaMargin(camps,baseGap=40){
  let best=Infinity;
  const list=camps||[];
  for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){
    const a=list[i],b=list[j],ar=Math.max(0,Number(CampDefinition.get(a.kind)?.aggroRadius)||180),br=Math.max(0,Number(CampDefinition.get(b.kind)?.aggroRadius)||180);
    const actual=MapGeometry.mapPointDistance(a,b)-ar-br;
    best=Math.min(best,actual-NeutralCampPolicy.neutralCampRequiredAreaGap(a,b,baseGap));
  }
  return Number.isFinite(best)?best:99999;
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
