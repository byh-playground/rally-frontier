// Goals, interaction geometry, surface contacts and the navigation front door.
import { RangeUtil } from '../core/game-rules.js';
import { NavigationTopology } from './entities.js';
import { HashUtil } from './map-generation.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { UNIT_RUNTIME_GEOMETRY, UnitDefinition } from '../definitions/units.js';
import { MapGeometry } from './map-geometry.js';
import { NAV_BUILDING_MARGIN } from '../definitions/combat-rules.js';
import { COLLISION_RADIUS_SCALE } from '../definitions/world-rules.js';
import { NavigationGrid } from './navigation-field.js';
import { NavigationObstacleIndex } from './terrain.js';
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
class SweptCircleContact{
  static policies=Object.freeze({
    surface:Object.freeze({minSpeed2:1e-16,contactDistanceEpsilon:1e-8,normalEpsilon:1e-10,inwardEpsilon:1e-8,discriminantEpsilon:1e-12,includeTangent:false,retreat:0}),
    relative:Object.freeze({minSpeed2:1e-9,contactSquaredEpsilon:1e-7,normalEpsilon:1e-6,inwardEpsilon:0,discriminantEpsilon:0,includeTangent:true,retreat:.0005})
  });
  static cast(rx,ry,vx,vy,r,policy,fallback=null){
    const aa=vx*vx+vy*vy,radial=rx*vx+ry*vy,c=rx*rx+ry*ry-r*r;
    const distancePolicy=policy.contactDistanceEpsilon!=null,length=distancePolicy?Math.hypot(rx,ry):0;
    if(distancePolicy&&aa<policy.minSpeed2)return null;
    const contact=distancePolicy?length<=r+policy.contactDistanceEpsilon:c<=policy.contactSquaredEpsilon;
    let t=0;
    if(contact){
      const inward=distancePolicy?(vx*(length>policy.normalEpsilon?rx/length:1)+vy*(length>policy.normalEpsilon?ry/length:0)):radial;
      if(inward>=-policy.inwardEpsilon)return null;
    }else{
      if(distancePolicy?aa<policy.minSpeed2:aa<=policy.minSpeed2)return null;
      const disc=radial*radial-aa*c;
      if(policy.includeTangent?disc<policy.discriminantEpsilon:disc<=policy.discriminantEpsilon)return null;
      if(distancePolicy&&radial>=0)return null;
      const enter=(-radial-Math.sqrt(disc))/aa;if(enter<0||enter>1)return null;
      t=Math.max(0,enter-policy.retreat);
    }
    const qx=rx+vx*t,qy=ry+vy*t,l=Math.hypot(qx,qy);
    const normal=l>policy.normalEpsilon?{x:qx/l,y:qy/l}:fallback?fallback():{x:1,y:0};
    return{t,nx:normal.x,ny:normal.y};
  }
}

class SurfaceContactGeometry{
  static closest(ax,ay,bx,by,x,y){
    const dx=bx-ax,dy=by-ay,l2=dx*dx+dy*dy,t=l2?RangeUtil.clamp(((x-ax)*dx+(y-ay)*dy)/l2,0,1):0;
    return{x:ax+dx*t,y:ay+dy*t};
  }
  static circleCast(x,y,vx,vy,cx,cy,r,key,obstacle=null){
    const hit=SweptCircleContact.cast(x-cx,y-cy,vx,vy,r,SweptCircleContact.policies.surface);
    return hit?{...hit,key,obstacle}:null;
  }
  static edgeCast(x,y,vx,vy,a,b,r,key){
    const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);
    if(len<1e-9)return this.circleCast(x,y,vx,vy,a.x,a.y,r,key);
    const ex=dx/len,ey=dy/len,nx=-ey,ny=ex;
    let best=null;
    const add=h=>{if(h&&(!best||h.t<best.t-1e-10||Math.abs(h.t-best.t)<=1e-10&&h.key<best.key))best=h};
    const signed=(x-a.x)*nx+(y-a.y)*ny,vn=vx*nx+vy*ny;
    for(const side of [-1,1]){
      if(side*vn>=-1e-8)continue;
      let t=(r-side*signed)/(side*vn);
      if(t<0&&side*signed>=r-1/FP)t=0;
      if(t<0||t>1)continue;
      const along=(x+vx*t-a.x)*ex+(y+vy*t-a.y)*ey;
      if(along>=-1e-8&&along<=len+1e-8)add({t,nx:nx*side,ny:ny*side,key:key+':edge'});
    }
    add(this.circleCast(x,y,vx,vy,a.x,a.y,r,key+':a'));
    add(this.circleCast(x,y,vx,vy,b.x,b.y,r,key+':b'));
    return best;
  }
  static polygonContacts(x,y,r,block,epsilon){
    const points=block.points,inside=MapGeometry.pointInSimplePolygon(x,y,points),out=[];
    let nearest=null;
    for(let i=0;i<points.length;i++){
      const a=points[i],b=points[(i+1)%points.length],p=this.closest(a.x,a.y,b.x,b.y,x,y);
      const dx=x-p.x,dy=y-p.y,d=Math.hypot(dx,dy);
      let nx,ny;
      if(d>1e-9){const sign=inside?-1:1;nx=sign*dx/d;ny=sign*dy/d}
      else{
        const area=points.reduce((sum,v,j)=>{const w=points[(j+1)%points.length];return sum+v.x*w.y-w.x*v.y},0),len=Math.hypot(b.x-a.x,b.y-a.y)||1,sign=area>=0?1:-1;
        nx=(b.y-a.y)/len*sign;ny=-(b.x-a.x)/len*sign;
      }
      const c={nx,ny,depth:inside?r+d:r-d,key:String(block.id)+':'+i,distance:d};
      if(inside){if(!nearest||d<nearest.distance)nearest=c}
      else if(d<=r+epsilon)out.push(c);
    }
    if(inside&&nearest)out.push(nearest);
    return out;
  }
  static feasible(v,contacts){return contacts.every(n=>v.x*n.nx+v.y*n.ny>=-1e-7)}
  static project(vx,vy,contacts){
    const wanted={x:vx,y:vy};if(this.feasible(wanted,contacts))return wanted;
    let best={x:0,y:0},cost=vx*vx+vy*vy;
    for(const n of contacts){const dot=vx*n.nx+vy*n.ny,p={x:vx-n.nx*dot,y:vy-n.ny*dot};
      if(!this.feasible(p,contacts))continue;
      const d=(p.x-vx)**2+(p.y-vy)**2;if(d<cost-1e-12){best=p;cost=d}
    }
    return best;
  }
  static slide(vx,vy,contacts,budget,{steer=false,goalX=vx,goalY=vy,tieKey=''}={}){
    if(budget<1e-8)return{x:0,y:0};
    let p=this.project(vx,vy,contacts),len=Math.hypot(p.x,p.y);
    if(!steer)return p; // An external force never gains a new sideways impulse.
    if(len<budget*.035){
      let best=null,score=-Infinity,tie=Infinity;
      for(const c of contacts)for(const sign of [-1,1]){
        const q={x:-c.ny*sign,y:c.nx*sign};if(!this.feasible(q,contacts))continue;
        const value=q.x*goalX+q.y*goalY;if(value<-1e-7)continue;
        const rank=HashUtil.hash(tieKey+'|'+c.key+'|'+sign)>>>0;
        if(value>score+1e-7||Math.abs(value-score)<=1e-7&&rank<tie){best=q;score=value;tie=rank}
      }
      if(!best)return{x:0,y:0};p=best;len=1;
    }
    return len>1e-8?{x:p.x/len*budget,y:p.y/len*budget}:{x:0,y:0};
  }
}
class SurfaceMotion{
  constructor(navigation){this.navigation=navigation;this.checkpoints=new WeakMap()}
  beginStep(){this.checkpoints=new WeakMap();for(const u of this.navigation.sim.units||[])this.remember(u,false)}
  remember(u,verified=true){this.checkpoints.set(u,{x:u.fx/FP,y:u.fy/FP,verified,ignoreId:this.policy(u),signature:this.navigation.topology.version})}
  policy(){return null}
  clear(x,y,tx,ty,r,ignoreId=null){return this.navigation.segmentClear(x,y,tx,ty,r,ignoreId,x!==tx||y!==ty,0)}
  contacts(x,y,r,ignoreId=null,epsilon=2/FP){
    const nav=this.navigation,g=nav.geometry,out=[];
    for(const b of g.index.query(x,y,x,y,r+epsilon))out.push(...SurfaceContactGeometry.polygonContacts(x,y,r,b,epsilon));
    for(const b of nav.obstacles(x,y,x,y,r+epsilon,ignoreId)){
      if(b.id===ignoreId)continue;
      const dx=x-b.x,dy=y-b.y,d=Math.hypot(dx,dy),needed=r+b.r;
      if(d<=needed+epsilon)out.push({nx:d>1e-9?dx/d:1,ny:d>1e-9?dy/d:0,depth:needed-d,key:'building:'+b.id,obstacle:b});
    }
    for(const [distance,nx,ny,key]of [[x-r,1,0,'left'],[g.width-r-x,-1,0,'right'],[y-r,0,1,'top'],[g.height-r-y,0,-1,'bottom']])if(distance<=epsilon)out.push({nx,ny,depth:-distance,key:'world:'+key});
    out.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
    // Adjacent cliff strips often describe the same exterior support plane.
    return out.filter((c,i)=>!out.slice(0,i).some(n=>Math.abs(c.nx-n.nx)+Math.abs(c.ny-n.ny)<1e-7&&n.depth>=c.depth));
  }
  buildingCast(x,y,vx,vy,r,ignoreId=null){
    let best=null;
    for(const b of this.navigation.obstacles(x,y,x+vx,y+vy,r,ignoreId)){
      if(b.id===ignoreId)continue;
      const h=SurfaceContactGeometry.circleCast(x,y,vx,vy,b.x,b.y,r+b.r,'building:'+b.id,b);
      if(h&&(!best||h.t<best.t-1e-10||Math.abs(h.t-best.t)<=1e-10&&h.key<best.key))best=h;
    }return best;
  }
  cast(x,y,vx,vy,r,ignoreId=null){
    const nav=this.navigation,g=nav.geometry;let best=null;
    const add=h=>{if(h&&(!best||h.t<best.t-1e-10||Math.abs(h.t-best.t)<=1e-10&&h.key<best.key))best=h};
    for(const b of g.index.query(x,y,x+vx,y+vy,r))for(let i=0;i<b.points.length;i++)add(SurfaceContactGeometry.edgeCast(x,y,vx,vy,b.points[i],b.points[(i+1)%b.points.length],r,String(b.id)+':'+i));
    add(this.buildingCast(x,y,vx,vy,r,ignoreId));
    for(const [distance,velocity,nx,ny,key]of [[x-r,vx,1,0,'left'],[g.width-r-x,-vx,-1,0,'right'],[y-r,vy,0,1,'top'],[g.height-r-y,-vy,0,-1,'bottom']]){
      if(velocity>=-1e-8)continue;const t=Math.max(0,-distance/velocity);if(t<=1)add({t,nx,ny,key:'world:'+key});
    }
    return best;
  }
  recover(x,y,r,ignoreId){
    const nav=this.navigation,start={x,y};
    if(this.clear(x,y,x,y,r,ignoreId))return start;
    if(nav.geometry.circleClear(x,y,r)){
      // A newly placed solid may cover a stationary unit. Step to the nearest open
      // point, with a monotone departure sweep: never cross terrain or another
      // building while resolving that pre-existing overlap.
      const p=nav.nearestExterior(x,y,r,ignoreId==='*');
      if(p){const end={x:Math.round(p.point.x*FP)/FP,y:Math.round(p.point.y*FP)/FP};
        if(this.clear(end.x,end.y,end.x,end.y,r,ignoreId)&&nav.departureClear(x,y,end.x,end.y,r,ignoreId))return end;
      }
      return start;
    }
    let remaining=r;
    for(let pass=0;pass<4;pass++){
      const contacts=this.contacts(x,y,r,ignoreId,0).filter(c=>c.depth>1/FP);
      if(!contacts.length)break;
      let delta=null,best=Infinity;
      const consider=p=>{if(contacts.some(c=>p.x*c.nx+p.y*c.ny<c.depth+1/FP-1e-7))return;const d=p.x*p.x+p.y*p.y;if(d<best){best=d;delta=p}};
      for(const c of contacts)consider({x:c.nx*(c.depth+1/FP),y:c.ny*(c.depth+1/FP)});
      for(let i=0;i<contacts.length;i++)for(let j=i+1;j<contacts.length;j++){
        const a=contacts[i],b=contacts[j],den=a.nx*b.ny-a.ny*b.nx;if(Math.abs(den)<1e-8)continue;
        const ad=a.depth+1/FP,bd=b.depth+1/FP;consider({x:(ad*b.ny-a.ny*bd)/den,y:(a.nx*bd-ad*b.nx)/den});
      }
      if(!delta||Math.sqrt(best)>remaining+1e-7)return start;
      const d=Math.sqrt(best);x+=delta.x;y+=delta.y;remaining-=d;
      if(remaining<=0)break;
    }
    return this.clear(x,y,x,y,r,ignoreId)?{x,y}:start;
  }
  advance(x,y,tx,ty,r,ignoreId,whole=false){
    const rounded=(px,py)=>({x:Math.round(px*FP)/FP,y:Math.round(py*FP)/FP});
    const end=rounded(tx,ty);
    if(this.navigation.segmentClear(x,y,end.x,end.y,r,ignoreId,!whole&&(x!==end.x||y!==end.y),0))return end;
    if(whole)return null;
    // Only retreat along this accepted subsegment after fixed-point rounding.
    let lo=0,hi=1,safe=rounded(x,y);
    for(let i=0;i<18;i++){const t=(lo+hi)/2,p=rounded(x+(tx-x)*t,y+(ty-y)*t);if(this.clear(x,y,p.x,p.y,r,ignoreId)){lo=t;safe=p}else hi=t}
    return safe;
  }
  solve(x,y,tx,ty,r,ignoreId=null,mode='steer',tieKey=''){
    const nav=this.navigation;nav.sync();
    const straight=this.advance(x,y,tx,ty,r,ignoreId,true);
    if(straight)return{...straight,hit:null};
    let px=x,py=y,hit=null;
    const start=this.recover(px,py,r,ignoreId);px=start.x;py=start.y;
    if(!this.clear(px,py,px,py,r,ignoreId))return{x:px,y:py,hit,valid:false};
    let rx=tx-x,ry=ty-y,remaining=Math.hypot(rx,ry);
    for(let pass=0;pass<8&&remaining>1e-7;pass++){
      const contact=this.cast(px,py,rx,ry,r,ignoreId);
      if(!contact){const p=this.advance(px,py,px+rx,py+ry,r,ignoreId);px=p.x;py=p.y;break}
      hit=hit||contact;
      const t=RangeUtil.clamp(contact.t,0,1),q=this.advance(px,py,px+rx*t,py+ry*t,r,ignoreId),spent=Math.hypot(q.x-px,q.y-py);
      px=q.x;py=q.y;remaining=Math.max(0,remaining-spent);
      if(mode==='stop'||remaining<1e-7)break;
      const contacts=this.contacts(px,py,r,ignoreId);if(!contacts.some(n=>Math.abs(n.nx-contact.nx)+Math.abs(n.ny-contact.ny)<1e-7))contacts.push(contact);
      const p=SurfaceContactGeometry.slide(rx*(1-t),ry*(1-t),contacts,remaining,{steer:mode==='steer',goalX:tx-px,goalY:ty-py,tieKey});
      const len=Math.hypot(p.x,p.y);if(len<1e-7)break;
      if(spent<1e-7&&Math.abs(p.x-rx)+Math.abs(p.y-ry)<1e-8)break;
      rx=p.x;ry=p.y;remaining=Math.min(remaining,len);
    }
    return{x:px,y:py,hit};
  }
  commit(u,p){
    u.fx=Math.round(p.x*FP);u.fy=Math.round(p.y*FP);u.x=u.fx/FP;u.y=u.fy/FP;
    this.remember(u,p.valid!==false);this.navigation.sim.syncUnitSpatial(u);return p;
  }
  move(u,tx,ty,mode='steer'){
    const sim=this.navigation.sim;
    return this.commit(u,this.solve(u.x,u.y,tx,ty,sim.unitRadius(u.type),this.policy(u),mode,String(u.id)));
  }
  constrain(u){
    const sim=this.navigation.sim,oldX=u.fx,oldY=u.fy;
    this.navigation.sync();const s=this.checkpoints.get(u)||{x:u.x,y:u.y,verified:false};
    if(s.verified&&s.ignoreId===this.policy(u)&&s.signature===this.navigation.topology.version&&s.x===u.x&&s.y===u.y)return false;
    this.commit(u,this.solve(s.x,s.y,u.x,u.y,sim.unitRadius(u.type),this.policy(u),'project',String(u.id)));
    return u.fx!==oldX||u.fy!==oldY;
  }
}

// Terrain and building obstacles, plus the distance fields units steer by.
class TerrainNavigation{
  constructor(sim){
    this.sim=sim;this.geometry=sim.world.terrain;this.topology=new NavigationTopology();this.sceneTick=-1;this.circles=[];this.circleIndex=new NavigationObstacleIndex([]);
    this.motion=new SurfaceMotion(this);this.grids=new Map();
    this.metrics={fieldsBuilt:0,fieldBuildMs:0,localFields:0,nextCalls:0,rayHits:0,unreachable:0};
  }
  sync(){
    if(this.sceneTick===this.sim.tick)return;
    this.sceneTick=this.sim.tick;
    if(!this.topology.refresh(this.sim.buildings))return;
    // A changed obstacle layout makes every grid stale; grid() notices by version.
    this.circles=this.topology.records;this.circleIndex=new NavigationObstacleIndex(this.circles);
  }
  grid(radius){
    this.sync();
    const key=Math.ceil((radius+.12)*100)/100;let grid=this.grids.get(key);
    if(!grid)this.grids.set(key,grid=new NavigationGrid(this,key));
    else if(grid.version!==this.topology.version)grid.reset();
    return grid;
  }
  obstacles(x,y,tx,ty,r,ignoreId){const found=this.circleIndex.query(x,y,tx,ty,r);return ignoreId==='*'?found.filter(b=>b.terrainBarrier):found}
  projectileSegmentClear(x,y,tx,ty){
    this.sync();
    if(!this.geometry.projectileSegmentClear(x,y,tx,ty))return false;
    for(const b of this.circleIndex.query(x,y,tx,ty,0)){
      if(!b.blocksProjectile)continue;
      if(Math.hypot(x-b.x,y-b.y)<b.r+.001||Math.hypot(tx-b.x,ty-b.y)<b.r+.001)continue;
      if(MapGeometry.pointSegDist(b.x,b.y,x,y,tx,ty)<b.r-.001)return false;
    }
    return true;
  }
  pointClear(x,y,r,ignoreId=null){return this.segmentClear(x,y,x,y,r,ignoreId)}
  segmentClear(x,y,tx,ty,r,ignoreId=null,departure=false,margin=.25){
    if(Math.min(x,tx)<r||Math.min(y,ty)<r||Math.max(x,tx)>this.geometry.width-r||Math.max(y,ty)>this.geometry.height-r||!this.geometry.segmentClear(x,y,tx,ty,r))return false;
    for(const b of this.obstacles(x,y,tx,ty,r+margin,ignoreId)){
      if(b.id===ignoreId)continue;
      const needed=r+b.r+margin,start=Math.hypot(x-b.x,y-b.y);
      if(departure&&start<needed&&(x-b.x)*(tx-x)+(y-b.y)*(ty-y)>=0&&Math.hypot(tx-b.x,ty-b.y)>=start)continue;
      if(MapGeometry.pointSegDist(b.x,b.y,x,y,tx,ty)<needed-.001)return false;
    }
    return true;
  }
  departureClear(x,y,tx,ty,r,ignoreId=null){return this.segmentClear(x,y,tx,ty,r,ignoreId,true)}
  nearestExterior(x,y,radius,ignoreBuildings=false){
    this.sync();
    const ignoreId=ignoreBuildings?'*':null,p=this.geometry.nearestOpen(x,y,radius,256,(px,py)=>this.pointClear(px,py,radius,ignoreId));
    return p?{point:p}:null;
  }
  acceptsGoalPoint(goal,x,y){return goal.contains(x,y)&&(!goal.terrainLine||this.geometry.segmentClear(x,y,goal.x,goal.y,0))}
  directGoal(x,y,goal,radius){
    const p=goal.closest(x,y);if(!p||!this.acceptsGoalPoint(goal,p.x,p.y))return null;
    return this.segmentClear(x,y,p.x,p.y,radius,null,true,0)?p:null;
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

export { InteractionGeometry, NavigationGoal, SurfaceContactGeometry, SurfaceMotion, SweptCircleContact, TerrainNavigation };
