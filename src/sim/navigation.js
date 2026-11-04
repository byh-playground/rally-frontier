// Goals, interaction geometry, surface contacts and the navigation front door.
import { RangeUtil } from '../core/game-rules.js';
import { NavigationTopology } from './entities.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { UNIT_RUNTIME_GEOMETRY, UnitDefinition } from '../definitions/units.js';
import { NAV_BUILDING_MARGIN } from '../definitions/combat-rules.js';
import { COLLISION_RADIUS_SCALE } from '../definitions/world-rules.js';
import { NavigationGrid } from './navigation-field.js';
import { RallyGamekit } from '../core/gamekit.js';
const { ObstacleField, SurfaceMotion } = RallyGamekit;
import { FP } from '../core/config.js';

// Interaction geometry owns the legal arrival set; the distance field only leads units to it.
// Goal regions are continuous (discs/annuli), not a fixed number of radial probes.
class NavigationGoal{
  static EPS=1e-7;
  static cross(a,b,c){return (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)}
  static ARRIVAL_INSET=5/FP;
  constructor(x,y,radius=0,innerRadius=0,terrainLine=false,project=false){
    if(![x,y,radius,innerRadius].every(Number.isFinite)||radius<0||innerRadius<0||innerRadius>radius)throw new Error('Invalid navigation goal');
    this.x=x;this.y=y;this.radius=radius;this.innerRadius=innerRadius;this.terrainLine=terrainLine;this.project=project;
    this.key=[x,y,radius,innerRadius,terrainLine?1:0,project?1:0].join(':');
  }
  static point(x,y,project=true){return new NavigationGoal(x,y,0,0,false,project)}
  static range(x,y,radius,innerRadius=0,terrainLine=false){
    // Five fixed-point quanta prevent rounding a stopped unit outside gameplay
    // range. The gameplay reach itself is not changed.
    const inset=Math.min(this.ARRIVAL_INSET,Math.max(0,(radius-innerRadius)/4));
    return new NavigationGoal(x,y,Math.max(0,radius-inset),innerRadius>0?innerRadius+inset:0,terrainLine,false);
  }
  contains(x,y){const d=Math.hypot(x-this.x,y-this.y);return d<=this.radius+NavigationGoal.EPS&&d>=this.innerRadius-NavigationGoal.EPS}
  interior(x,y){
    const dx=x-this.x,dy=y-this.y,d=Math.hypot(dx,dy)||1,r=this.innerRadius>0?(this.innerRadius+this.radius)/2:0;
    return{x:this.x+(dx||(!dy?1:0))/d*r,y:this.y+dy/d*r};
  }
  static polygonContains(points,x,y){
    if(points.length<3)return false;
    for(let i=0;i<points.length;i++)if(NavigationGoal.cross(points[i],points[(i+1)%points.length],{x,y})<-this.EPS)return false;
    return true;
  }
  static clipPolygon(points,clip){
    let out=points;
    for(let i=0;i<clip.length&&out.length;i++){
      const a=clip[i],b=clip[(i+1)%clip.length],input=out;out=[];
      let p=input[input.length-1],pd=NavigationGoal.cross(a,b,p);
      for(const q of input){const qd=NavigationGoal.cross(a,b,q);
        if((pd>=0)!==(qd>=0)){const t=pd/(pd-qd);out.push({x:p.x+(q.x-p.x)*t,y:p.y+(q.y-p.y)*t})}
        if(qd>=0)out.push(q);p=q;pd=qd;
      }
    }
    return out;
  }
  segmentIntervals(a,b){
    const dx=b.x-a.x,dy=b.y-a.y,fx=a.x-this.x,fy=a.y-this.y,A=dx*dx+dy*dy;
    if(A<1e-16)return this.contains(a.x,a.y)?[[0,1]]:[];
    const B=fx*dx+fy*dy,C=fx*fx+fy*fy,disc=B*B-A*(C-this.radius*this.radius);
    if(disc<-NavigationGoal.EPS)return [];
    const root=Math.sqrt(Math.max(0,disc)),lo=Math.max(0,(-B-root)/A),hi=Math.min(1,(-B+root)/A);
    if(lo>hi+NavigationGoal.EPS)return [];
    if(this.innerRadius<=0)return [[lo,hi]];
    const innerDisc=B*B-A*(C-this.innerRadius*this.innerRadius);
    if(innerDisc<=0)return [[lo,hi]];
    const ir=Math.sqrt(innerDisc),il=(-B-ir)/A,ih=(-B+ir)/A,out=[];
    if(lo<=Math.min(hi,il))out.push([lo,Math.min(hi,il)]);
    if(Math.max(lo,ih)<=hi)out.push([Math.max(lo,ih),hi]);return out;
  }
  closest(x,y,polygon=null){
    let best=null;const eps=NavigationGoal.EPS;
    const add=(px,py)=>{
      if(!this.contains(px,py)||(polygon&&!NavigationGoal.polygonContains(polygon,px,py)))return;
      const d2=(px-x)**2+(py-y)**2;
      if(!best||d2<best.d2-eps||(Math.abs(d2-best.d2)<=eps&&(px<best.x-eps||Math.abs(px-best.x)<=eps&&py<best.y)))best={x:px,y:py,d2};
    };
    if(this.radius===0){add(this.x,this.y);return best}
    const dx=x-this.x,dy=y-this.y,len=Math.hypot(dx,dy),ux=len>eps?dx/len:1,uy=len>eps?dy/len:0;
    const radial=RangeUtil.clamp(len,this.innerRadius,this.radius);add(this.x+ux*radial,this.y+uy*radial);
    if(polygon)for(let i=0;i<polygon.length;i++){
      const a=polygon[i],b=polygon[(i+1)%polygon.length],ex=b.x-a.x,ey=b.y-a.y,den=ex*ex+ey*ey;
      for(const [lo,hi]of this.segmentIntervals(a,b)){
        const t=RangeUtil.clamp(den?((x-a.x)*ex+(y-a.y)*ey)/den:0,lo,hi);add(a.x+ex*t,a.y+ey*t);
      }
    }
    return best;
  }
}
class InteractionGeometry{
  static unitRadius(type){return UNIT_RUNTIME_GEOMETRY[type]?.radius||Math.max(1,10*COLLISION_RADIUS_SCALE)}
  static buildingClearance(source,target){
    const st=typeof source==='string'?source:source?.type,tt=typeof target==='string'?target:target?.type;
    return this.unitRadius(st)+(BuildingDefinition.get(tt)?.size||35)+NAV_BUILDING_MARGIN;
  }
  static contact(source,target){
    const st=typeof source==='string'?source:source?.type,tt=typeof target==='string'?target:target?.type,building=BuildingDefinition.get(tt);
    if(building)return (((UnitDefinition.get(st)||{}).size||10)+(building.size||30))*COLLISION_RADIUS_SCALE;
    return this.unitRadius(st)+this.unitRadius(tt);
  }
  static requiresTerrainLine(source,kind,extra=0){
    const st=typeof source==='string'?source:source?.type,d=UnitDefinition.get(st)||{};
    return kind==='attack'&&!d.projectile&&Number(extra)<=100&&d.requiresContactTerrain===true;
  }
  static reach(source,target,kind,extra=0){
    if(kind==='building-clearance')return this.buildingClearance(source,target);
    if(kind==='combat-contact')return this.contact(source,target);
    if(kind==='attack'){
      const nominal=this.contact(source,target)+Math.max(0,Number(extra)||0);
      return BuildingDefinition.get(target?.type)?Math.max(nominal,this.buildingClearance(source,target)):nominal;
    }
    return Math.max(0,Number(extra)||0);
  }
  static region(source,target,kind,extra=0,minRange=null,inset=false){
    let inner=0;
    if(kind==='attack'){
      const minimum=minRange??UnitDefinition.get(source.type)?.minRange??0;
      if(minimum>0)inner=this.contact(source,target)+minimum;
    }
    const outer=this.reach(source,target,kind,extra),terrainLine=this.requiresTerrainLine(source,kind,extra);
    return inset?NavigationGoal.range(target.x,target.y,outer,inner,terrainLine):new NavigationGoal(target.x,target.y,outer,inner,terrainLine);
  }
  static goal(source,target,kind,extra=0,minRange=null){
    return this.region(source,target,kind,extra,minRange,true);
  }
}

// Local contacts share one solver; the distance field only chooses where to head.
// A grain's own motion record: checkpoints, fixed-point commit and the unit's radius sit around the shared contact solver.
class UnitMotion{
  constructor(navigation){this.navigation=navigation;this.surface=new SurfaceMotion(navigation.field,{sync:()=>navigation.sync()})}
  beginStep(){this.surface.forgetAll();for(const u of this.navigation.sim.units||[])this.remember(u,false)}
  remember(u,verified=true){this.surface.remember(u,u.fx/FP,u.fy/FP,verified,null)}
  commit(u,p){
    u.fx=Math.round(p.x*FP);u.fy=Math.round(p.y*FP);u.x=u.fx/FP;u.y=u.fy/FP;
    this.remember(u,p.valid!==false);this.navigation.sim.syncUnitSpatial(u);return p;
  }
  move(u,tx,ty,mode='steer'){
    return this.commit(u,this.surface.solve(u.x,u.y,tx,ty,this.navigation.sim.unitRadius(u.type),null,mode,String(u.id)));
  }
  constrain(u){
    const oldX=u.fx,oldY=u.fy,result=this.surface.constrain(u,u.x,u.y,this.navigation.sim.unitRadius(u.type),null,String(u.id));
    if(result)this.commit(u,result);
    return u.fx!==oldX||u.fy!==oldY;
  }
}

// Terrain and building obstacles, plus the distance fields units steer by.
class TerrainNavigation{
  constructor(sim){
    this.sim=sim;this.geometry=sim.world.terrain;this.topology=new NavigationTopology();this.sceneTick=-1;
    this.field=new ObstacleField({width:this.geometry.width,height:this.geometry.height,fixedPoint:FP,polygons:this.geometry.index,circles:[],ignoreAll:{id:'*',keep:b=>b.terrainBarrier}});
    this.motion=new UnitMotion(this);this.grids=new Map();
    this.metrics={fieldsBuilt:0,fieldBuildMs:0,localFields:0,nextCalls:0,rayHits:0,unreachable:0};
  }
  sync(){
    if(this.sceneTick===this.sim.tick)return;
    this.sceneTick=this.sim.tick;
    if(!this.topology.refresh(this.sim.buildings))return;
    // A changed obstacle layout makes every grid stale; grid() notices by version.
    this.field.setCircles(this.topology.records);
  }
  grid(radius){
    this.sync();
    const key=Math.ceil((radius+.12)*100)/100;let grid=this.grids.get(key);
    if(!grid)this.grids.set(key,grid=new NavigationGrid(this,key));
    else if(grid.version!==this.topology.version)grid.reset();
    return grid;
  }
  acceptsGoalPoint(goal,x,y){return goal.contains(x,y)&&(!goal.terrainLine||this.geometry.field.polygonSegmentClear(x,y,goal.x,goal.y,0))}
  directGoal(x,y,goal,radius){
    const p=goal.closest(x,y);if(!p||!this.acceptsGoalPoint(goal,p.x,p.y))return null;
    return this.field.segmentClear(x,y,p.x,p.y,radius,null,true,0)?p:null;
  }
  // Where a unit heads next to reach `goal`. A clear straight ray inside the scan
  // radius wins; otherwise the unit reads the goal's distance field. Point goals are
  // fixed places (bases, flags, capture points) and keep their field.
  nextPoint(u,goal){
    this.metrics.nextCalls++;
    const radius=this.sim.unitRadius(u.type);
    const near=goal.closest(u.x,u.y);
    if(near&&Math.hypot(near.x-u.x,near.y-u.y)<=NavigationGrid.RAY_RANGE){
      const direct=this.directGoal(u.x,u.y,goal,radius);
      if(direct){this.metrics.rayHits++;return direct}
    }
    const grid=this.grid(radius),fixed=goal.radius===0,begun=performance.now(),known=fixed?grid.fields.size:grid.local.fields.size;
    const point=grid.next(u.x,u.y,goal,fixed);
    const built=(fixed?grid.fields.size:grid.local.fields.size)>known;
    if(built){this.metrics[fixed?'fieldsBuilt':'localFields']++;if(fixed)this.metrics.fieldBuildMs+=performance.now()-begun}
    if(!point)this.metrics.unreachable++;
    return point;
  }
  // Whether every strategic point can be reached from `from` by a unit this wide.
  connected(from,points,radius){
    const grid=this.grid(radius),reached=grid.reachableFrom(from.x,from.y);
    return points.every(p=>{const cell=grid.nearestOpen(grid.cellAt(p.x,p.y),4);return cell>=0&&reached[cell]===1});
  }
}

export { InteractionGeometry, NavigationGoal, TerrainNavigation, UnitMotion };
