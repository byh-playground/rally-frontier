// Terrain geometry, battlefield projection and the terrain surface atlas.
import { RangeUtil } from '../core/game-rules.js';
import { MapGeometry } from './map-geometry.js';
import { NavigationGoal } from './navigation.js';
import { RallyGamekit } from '../core/gamekit.js';
import { FP } from '../core/config.js';
import { VISION_CELL } from '../definitions/world-rules.js';
const { BoundsIndex, ObstacleField, VisionMap, assignBounds, boundariesCross, pointInSimplePolygon, pointSegmentDistance, polygonTouchesRect, polygonsOverlap, segmentDistance, segmentsIntersect, triangulatePolygon } = RallyGamekit;

// Derived, immutable world geometry. Each simulation and renderer owns a context;
// no active-view switch can change another match's coordinates or spatial grids.
// Static map geometry is shared by simulation, placement and presentation.
// Route fields are derived caches, never authoritative unit state or replay data.
class TerrainGeometry{
  static cache=new WeakMap();
  static fromMap(map){
    let g=this.cache.get(map);if(!g){g=new TerrainGeometry(map);this.cache.set(map,g)}return g;
  }
  static blocker(raw){
    const points=(raw.points||[]).map(p=>({x:p.x,y:p.y}));
    return {...raw,points,
      blocksMovement:raw.blocksMovement!==false,
      blocksVision:raw.blocksVision!==false,
      minX:Math.min(...points.map(p=>p.x)),maxX:Math.max(...points.map(p=>p.x)),minY:Math.min(...points.map(p=>p.y)),maxY:Math.max(...points.map(p=>p.y))};
  }
  constructor(map){
    this.width=Number(map.width)||3600;this.height=Number(map.height)||4200;
    this.surfaces=TerrainSurfaceAtlas.fromMap(map);
    const authored=(map.terrain?.blockers||[]).map(TerrainGeometry.blocker);
    const cliffs=this.surfaces.cliffs.map(TerrainGeometry.blocker);
    this.blocks=[...authored.filter(b=>b.blocksMovement),...cliffs];
    this.visionBlocks=authored.filter(b=>b.blocksVision);
    this.active=this.blocks.length>0;
    this.index=new BoundsIndex(this.blocks);
    // Polygon-only clearance for placement, map checks and spawning; buildings live in each navigation's own field.
    this.field=new ObstacleField({width:this.width,height:this.height,fixedPoint:FP,polygons:this.index,circles:[]});
  }
  // Vision raster of this terrain: surface level and vision-blocker membership at every VISION_CELL cell centre.
  // Built on first use: map generation checks many candidate maps and never looks.
  ensureVisionMap(){
    if(!this.visionMapCache){
      const index=new BoundsIndex(this.visionBlocks);
      this.visionMapCache=VisionMap.sample({width:this.width,height:this.height,cellSize:VISION_CELL,
        levelAt:(x,y)=>this.surfaces.levelAt(x,y),
        blockedAt:(x,y)=>{for(const b of index.query(x,y,x,y,0))if(pointInSimplePolygon(x,y,b.points))return true;return false}});
    }
    return this.visionMapCache;
  }
}
// A 2.5D surface atlas: horizontal cells plus authored ramp transitions.
// Cliffs, navigation seams, placement and drawing are derived from this one descriptor.
class BattlefieldProjection{
  // Top-quarter presentation. World heights, navigation and collision do not change.
  static heightScale=.60;
  static planarY(viewY,elevation){return viewY-elevation*this.heightScale}
}
class TerrainSurfaceProjection{
  static owners=new WeakMap();
  static forAtlas(atlas){let owner=this.owners.get(atlas);if(!owner){owner=new TerrainSurfaceProjection(atlas);this.owners.set(atlas,owner)}return owner}
  constructor(atlas){this.atlas=atlas;this.projectedMeshCache=new Map();this.renderProjectedMeshCache=new Map();this.projectedTriangleCaches=new WeakMap()}
  projectedTriangleMesh(mesh,flipped=false){
    let cache=this.projectedTriangleCaches.get(mesh);if(!cache)this.projectedTriangleCaches.set(mesh,cache=new Map());
    const key=(flipped?1:0)+":"+BattlefieldProjection.heightScale;let value=cache.get(key);if(value)return value;
    const triangles=mesh.map((tri,order)=>assignBounds({tri,order,points:tri.vertices.map(v=>({x:flipped?this.atlas.width-v.x:v.x,y:BattlefieldProjection.planarY(flipped?this.atlas.height-v.z:v.z,v.y)}))}));
    value={triangles,index:new BoundsIndex(triangles)};cache.set(key,value);return value;
  }
  renderProjectedSurfaceMesh(flipped=false){
    const mesh=this.atlas.presentationSurfaceMesh(),key=(flipped?1:0)+":"+BattlefieldProjection.heightScale;
    let cached=this.renderProjectedMeshCache.get(key);if(cached?.mesh===mesh)return cached;
    const triangles=[],sign=flipped?-1:1;
    for(const patch of mesh){
      if(patch.kind==='cliff'&&patch.outwardY*sign<=1e-8)continue;
      const points=patch.vertices.map(v=>({x:flipped?this.atlas.width-v.x:v.x,y:BattlefieldProjection.planarY(flipped?this.atlas.height-v.z:v.z,v.y)}));
      for(const indices of patch.triangles)triangles.push(assignBounds({points:indices.map(i=>points[i]),vertices:indices.map(i=>patch.vertices[i]),indices,patch,order:triangles.length}));
    }
    cached={mesh,triangles,index:new BoundsIndex(triangles)};this.renderProjectedMeshCache.set(key,cached);return cached;
  }
  projectedSurfaceMesh(flipped=false){
    const key=(flipped?1:0)+":"+BattlefieldProjection.heightScale;let cached=this.projectedMeshCache.get(key);if(cached)return cached;
    const triangles=[],sign=flipped?-1:1;
    for(const patch of this.atlas.surfaceMesh){
      if(patch.kind==='cliff'&&patch.outwardY*sign<=1e-8)continue;
      const points=patch.vertices.map(p=>({x:flipped?this.atlas.width-p.x:p.x,y:BattlefieldProjection.planarY(flipped?this.atlas.height-p.z:p.z,p.y)}));
      for(const tri of patch.triangles){const p=tri.map(i=>points[i]),[a,b,c]=p;
        const den=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y);if(Math.abs(den)<1e-8)continue;
        const vertices=tri.map(i=>patch.vertices[i]),[u,v,w]=vertices,worldDen=(v.x-u.x)*(w.z-u.z)-(v.z-u.z)*(w.x-u.x);
        const gradient=Math.abs(worldDen)>1e-8?{x:((v.y-u.y)*(w.z-u.z)-(w.y-u.y)*(v.z-u.z))/worldDen,z:((v.x-u.x)*(w.y-u.y)-(w.x-u.x)*(v.y-u.y))/worldDen}:null;
        triangles.push(assignBounds({points:p,vertices,kind:patch.kind,id:patch.id,den,gradient}));
      }
    }
    const transitions=this.atlas.surfaceMesh.filter(p=>p.kind==='cliff'||p.kind==='ramp').map(p=>assignBounds({points:p.vertices.map(v=>({x:flipped?this.atlas.width-v.x:v.x,y:BattlefieldProjection.planarY(flipped?this.atlas.height-v.z:v.z,v.y)}))}));
    cached={triangles,index:new BoundsIndex(triangles),transitionIndex:new BoundsIndex(transitions)};this.projectedMeshCache.set(key,cached);return cached;
  }
  pickSurface(viewX,projectedY,flipped=false){
    const ax=flipped?this.atlas.width-viewX:viewX,az=flipped?this.atlas.height-projectedY:projectedY;
    let best=null;
    for(const tri of this.projectedSurfaceMesh(flipped).index.query(viewX,projectedY)){
      const [a,b,c]=tri.points,wa=((b.y-c.y)*(viewX-c.x)+(c.x-b.x)*(projectedY-c.y))/tri.den;
      const wb=((c.y-a.y)*(viewX-c.x)+(a.x-c.x)*(projectedY-c.y))/tri.den,wc=1-wa-wb;
      if(Math.min(wa,wb,wc)<-1e-7)continue;
      const [p,q,r]=tri.vertices,height=wa*p.y+wb*q.y+wc*r.y;
      if(best&&(height<best.y-1e-6||Math.abs(height-best.y)<=1e-6&&tri.kind==='cliff'))continue;
      best={x:wa*p.x+wb*q.x+wc*r.x,y:height,z:wa*p.z+wb*q.z+wc*r.z,groundY:0,kind:tri.kind,id:tri.id,gradient:tri.gradient};
    }
    return best||{x:ax,y:this.atlas.heightAt(ax,az),z:az,groundY:0,kind:'outside-map'};
  }
}

const TERRAIN_LEVEL_HEIGHT=48;
const TERRAIN_NEGATIVE_LEVEL_DEPTH=TERRAIN_LEVEL_HEIGHT*.5;
class TerrainSurfaceAtlas{
  static SAMPLE_CELL=32;
  static elevationForLevel(level){return level*(level<0?TERRAIN_NEGATIVE_LEVEL_DEPTH:TERRAIN_LEVEL_HEIGHT)}
  static levelForElevation(elevation){return elevation/(elevation<0?TERRAIN_NEGATIVE_LEVEL_DEPTH:TERRAIN_LEVEL_HEIGHT)}
  static cache=new WeakMap();
  static rampPlaneCache=new WeakMap();
  static fromMap(map){let value=this.cache.get(map);if(!value){value=new TerrainSurfaceAtlas(map);this.cache.set(map,value)}return value}
  static lerp(a,b,t){return{x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t}}
  static pointKey(p){return `${Math.round(Number(p.x)*1000)/1000},${Math.round(Number(p.y)*1000)/1000}`}
  static directedEdgeKey(a,b){return this.pointKey(a)+">"+this.pointKey(b)}
  static smoothClosedContour(points,protectedKeys=new Set(),_iterations=0,_cut=0){
    // Presentation-only corner rounding. Long authored edges stay perfectly straight;
    // only the immediate corner is replaced by a short quadratic arc. This avoids
    // the inflated/blob-like silhouette produced by repeated Chaikin subdivision.
    const src=(points||[]).map(p=>({x:Number(p.x),y:Number(p.y)})),n=src.length;if(n<3)return src;
    const out=[],radius=28,segments=3;
    const add=q=>{const last=out[out.length-1];if(!last||Math.hypot(last.x-q.x,last.y-q.y)>.01)out.push(q)};
    for(let i=0;i<n;i++){
      const prev=src[(i+n-1)%n],p=src[i],next=src[(i+1)%n];
      if(protectedKeys.has(this.pointKey(p))){add({...p});continue}
      const ax=prev.x-p.x,ay=prev.y-p.y,bx=next.x-p.x,by=next.y-p.y,la=Math.hypot(ax,ay),lb=Math.hypot(bx,by);
      if(la<1||lb<1){add({...p});continue}
      const ua={x:ax/la,y:ay/la},ub={x:bx/lb,y:by/lb},dot=RangeUtil.clamp(ua.x*ub.x+ua.y*ub.y,-1,1);
      // Near-straight vertices are not rounded.
      if(dot<-0.985){add({...p});continue}
      const cut=Math.min(radius,la*.22,lb*.22);
      const a={x:p.x+ua.x*cut,y:p.y+ua.y*cut},b={x:p.x+ub.x*cut,y:p.y+ub.y*cut};
      add(a);
      for(let k=1;k<segments;k++){const t=k/segments,u=1-t;add({x:u*u*a.x+2*u*t*p.x+t*t*b.x,y:u*u*a.y+2*u*t*p.y+t*t*b.y})}
      add(b);
    }
    if(out.length>2&&Math.hypot(out[0].x-out[out.length-1].x,out[0].y-out[out.length-1].y)<.01)out.pop();
    return out;
  }
  // Closed segment/rectangle contact by separating axes; near-touching counts.
  static wall(a,b,id){const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);if(len<.01)return null;const x=-dy/len*2,y=dx/len*2;return{id,kind:'cliff',surfaceBoundary:true,blocksMovement:true,blocksVision:false,blocksProjectile:false,points:[{x:a.x+x,y:a.y+y},{x:b.x+x,y:b.y+y},{x:b.x-x,y:b.y-y},{x:a.x-x,y:a.y-y}]}}
  static flatMesh(contour,holes,elevation){
    // WorldContext's empty rectangular map is constructed before geometry helpers.
    if(!holes.length&&contour.length===4&&contour.every((p,i)=>{const q=contour[(i+1)%4];return p.x===q.x||p.y===q.y}))return{
      vertices:contour.map(p=>({x:p.x,y:typeof elevation==='function'?elevation(p.x,p.y):elevation,z:p.y,groundY:0})),triangles:[[0,1,2],[0,2,3]]};
    // Exact vertical decomposition of one floor minus its child floors and ramps.
    // Every vertex/intersection is a slab boundary, so each open interval has a
    // constant polygon membership and its four corners lie on original edges.
    const polygons=[contour,...holes],edges=[],xs=[];
    for(const points of polygons)for(let i=0;i<points.length;i++){
      const a=points[i],b=points[(i+1)%points.length];xs.push(a.x);
      if(Math.abs(a.x-b.x)>1e-9)edges.push({a,b,minX:Math.min(a.x,b.x),maxX:Math.max(a.x,b.x),slope:(b.y-a.y)/(b.x-a.x)});
    }
    const at=(e,x)=>e.a.y+(x-e.a.x)*e.slope;
    for(let i=0;i<edges.length;i++)for(let j=i+1;j<edges.length;j++){
      const a=edges[i],b=edges[j],d=a.slope-b.slope;if(Math.abs(d)<1e-10)continue;
      const x=(b.a.y-b.slope*b.a.x-a.a.y+a.slope*a.a.x)/d;
      if(x>Math.max(a.minX,b.minX)+1e-8&&x<Math.min(a.maxX,b.maxX)-1e-8)xs.push(x);
    }
    xs.sort((a,b)=>a-b);const cuts=xs.filter((x,i)=>!i||x-xs[i-1]>1e-8),vertices=[],triangles=[];
    for(let i=1;i<cuts.length;i++){
      const left=cuts[i-1],right=cuts[i],mid=(left+right)/2;
      const active=edges.filter(e=>e.minX<mid&&e.maxX>mid).sort((a,b)=>at(a,mid)-at(b,mid));
      for(let j=1;j<active.length;j++){
        const lower=active[j-1],upper=active[j],y=(at(lower,mid)+at(upper,mid))/2;
        if(at(upper,mid)-at(lower,mid)<1e-8||!pointInSimplePolygon(mid,y,contour)||holes.some(p=>pointInSimplePolygon(mid,y,p)))continue;
        const start=vertices.length;vertices.push(...[{x:left,y:at(lower,left)},{x:right,y:at(lower,right)},{x:right,y:at(upper,right)},{x:left,y:at(upper,left)}].map(p=>({x:p.x,y:typeof elevation==='function'?elevation(p.x,p.y):elevation,z:p.y,groundY:0})));
        const p=vertices.slice(start),area=(a,b,c)=>Math.abs((b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x));
        if(area(p[0],p[1],p[2])>1e-8)triangles.push([start,start+1,start+2]);
        if(area(p[0],p[2],p[3])>1e-8)triangles.push([start,start+2,start+3]);
      }
    }
    return{vertices,triangles};
  }
  static rampTriangle(r,index){
    let cached=this.rampPlaneCache.get(r);if(!cached){cached=[];this.rampPlaneCache.set(r,cached)}if(cached[index])return cached[index];
    const vertices=[{...r.lowA,h:r.lowElevation},{...r.lowB,h:r.lowElevation},{...r.highB,h:r.highElevation},{...r.highA,h:r.highElevation}];
    const [a,b,c]=(index===0?[0,1,2]:[0,2,3]).map(i=>vertices[i]),den=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
    const gradient={x:((b.h-a.h)*(c.y-a.y)-(c.h-a.h)*(b.y-a.y))/den,z:((b.x-a.x)*(c.h-a.h)-(c.x-a.x)*(b.h-a.h))/den};
    return cached[index]={points:[a,b,c],gradient,heightAt:(x,y)=>a.h+gradient.x*(x-a.x)+gradient.z*(y-a.y),den};
  }
  static sampleRamp(r,x,y){
    for(let i=0;i<2;i++){
      const triangle=this.rampTriangle(r,i),[a,b,c]=triangle.points;
      const u=((x-a.x)*(c.y-a.y)-(y-a.y)*(c.x-a.x))/triangle.den,v=((b.x-a.x)*(y-a.y)-(b.y-a.y)*(x-a.x))/triangle.den;
      if(u>=-1e-6&&v>=-1e-6&&u+v<=1+1e-6){const elevation=triangle.heightAt(x,y),progress=RangeUtil.clamp((elevation-r.lowElevation)/(r.highElevation-r.lowElevation),0,1);return{elevation,progress,gradient:triangle.gradient,triangleIndex:i}}
    }
    return null;
  }
  static splitRampAtLevelTransition(patch){
    const midpoint=(this.elevationForLevel(patch.lowLevel)+this.elevationForLevel(patch.highLevel))*.5;
    const parts={low:{vertices:[],triangles:[]},high:{vertices:[],triangles:[]}};
    for(const side of ['low','high'])for(const triangle of patch.triangles){
      const src=triangle.map(i=>patch.vertices[i]),out=[],inside=p=>side==='low'?p.y<=midpoint+1e-8:p.y>=midpoint-1e-8;
      for(let i=0;i<src.length;i++){
        const a=src[i],b=src[(i+1)%src.length],aIn=inside(a),bIn=inside(b);if(aIn)out.push({...a});
        if(aIn!==bIn){const t=(midpoint-a.y)/(b.y-a.y);out.push({x:a.x+(b.x-a.x)*t,y:midpoint,z:a.z+(b.z-a.z)*t,groundY:0})}
      }
      const mesh=parts[side],start=mesh.vertices.length;mesh.vertices.push(...out);
      for(let i=1;i+1<out.length;i++){const a=out[0],b=out[i],c=out[i+1];if(Math.abs((b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x))>1e-8)mesh.triangles.push([start,start+i,start+i+1])}
    }
    return parts;
  }
  presentationSurfaceMesh(){
    if(this._presentationSurfaceMesh)return this._presentationSurfaceMesh;
    // Terrain and fixed-level Fog share one tessellation. Simulation/navigation
    // retain surfaceMesh; camera input never changes these derived world vertices.
    const patches=[];
    for(const patch of this.renderSurfaceMesh||this.surfaceMesh){
      if(patch.kind==='ramp'){
        const split=TerrainSurfaceAtlas.splitRampAtLevelTransition(patch);
        for(const side of ['low','high'])patches.push({...patch,...split[side],fogLevel:side==='low'?patch.lowLevel:patch.highLevel});
      }else patches.push({...patch,fogLevel:patch.kind==='cliff'?patch.face.highLevel:patch.level});
    }
    // Slab decomposition creates T-junctions against long ramp/cliff edges.
    // Resolve them once per atlas in 3D, never joining different height planes.
    // Match only arithmetic noise far below a Float32 vertex quantum. Keep
    // original doubles and triangles; no quantization or proximity welding.
    const tolerance=1e-7,cellSize=128,vertices=new Map(),cells=new Map();
    const key=v=>[v.x,v.y,v.z].join(',');
    for(const patch of patches)for(const v of patch.vertices){
      const id=key(v);if(vertices.has(id))continue;
      const q={x:v.x,y:v.y,z:v.z,groundY:v.groundY??0};vertices.set(id,q);
      const cell=Math.floor(q.x/cellSize)+':'+Math.floor(q.z/cellSize);
      if(!cells.has(cell))cells.set(cell,[]);cells.get(cell).push(q);
    }
    const edgeCache=new Map();
    const boundary=(a,b)=>{
      const ka=key(a),kb=key(b),forward=ka<kb,id=forward?ka+'>'+kb:kb+'>'+ka;
      let cached=edgeCache.get(id);
      if(!cached){
        const start=forward?a:b,end=forward?b:a,dx=end.x-start.x,dy=end.y-start.y,dz=end.z-start.z,length=dx*dx+dy*dy+dz*dz;
        const cuts=[{t:0,v:start},{t:1,v:end}];
        if(length>0){
          const minX=Math.floor((Math.min(start.x,end.x)-tolerance)/cellSize),maxX=Math.floor((Math.max(start.x,end.x)+tolerance)/cellSize),minZ=Math.floor((Math.min(start.z,end.z)-tolerance)/cellSize),maxZ=Math.floor((Math.max(start.z,end.z)+tolerance)/cellSize);
          for(let x=minX;x<=maxX;x++)for(let z=minZ;z<=maxZ;z++)for(const v of cells.get(x+':'+z)||[]){
            if(v===start||v===end)continue;
            const t=((v.x-start.x)*dx+(v.y-start.y)*dy+(v.z-start.z)*dz)/length;
            if(t<=0||t>=1)continue;
            if(Math.hypot(v.x-start.x-dx*t,v.y-start.y-dy*t,v.z-start.z-dz*t)<=tolerance)cuts.push({t,v});
          }
        }
        cuts.sort((a,b)=>a.t-b.t);cached=cuts.map(c=>c.v);edgeCache.set(id,cached);
      }
      return forward?cached:cached.slice().reverse();
    };
    this._presentationSurfaceMesh=patches.map(patch=>{
      const out={...patch,vertices:[],triangles:[]};
      for(const triangle of patch.triangles){
        const corners=triangle.map(i=>vertices.get(key(patch.vertices[i]))),ring=[];
        for(let i=0;i<3;i++)ring.push(...boundary(corners[i],corners[(i+1)%3]).slice(0,-1));
        const start=out.vertices.length;
        if(ring.length===3){out.vertices.push(...corners);out.triangles.push([start,start+1,start+2]);continue}
        const center={x:corners.reduce((s,v)=>s+v.x,0)/3,y:corners.reduce((s,v)=>s+v.y,0)/3,z:corners.reduce((s,v)=>s+v.z,0)/3,groundY:0};
        out.vertices.push(center,...ring);
        for(let i=0;i<ring.length;i++)out.triangles.push([start,start+i+1,start+(i+1)%ring.length+1]);
      }
      return out;
    });
    return this._presentationSurfaceMesh;
  }
  static segmentCuts(x0,y0,x1,y1,polygons){
    const dx=x1-x0,dy=y1-y0,cuts=[0,1];
    for(const polygon of polygons)for(let i=0;i<polygon.points.length;i++){
      const a=polygon.points[i],b=polygon.points[(i+1)%polygon.points.length],ex=b.x-a.x,ey=b.y-a.y,den=dx*ey-dy*ex;
      if(Math.abs(den)<1e-10)continue;
      const t=((a.x-x0)*ey-(a.y-y0)*ex)/den,u=((a.x-x0)*dy-(a.y-y0)*dx)/den;
      if(t>0&&t<1&&u>=-1e-8&&u<=1+1e-8)cuts.push(t);
    }
    cuts.sort((a,b)=>a-b);return cuts.filter((t,i)=>!i||t-cuts[i-1]>1e-8);
  }
  constructor(map){
    this.width=Number(map?.width)||3600;this.height=Number(map?.height)||4200;
    this.layers=(map?.terrain?.layers||[]).map(p=>assignBounds({...p,level:Number(p.level),elevation:TerrainSurfaceAtlas.elevationForLevel(Number(p.level)),points:p.points.map(q=>({...q})),...(p.innerPoints?{innerPoints:p.innerPoints.map(q=>({...q}))}:{})}));
    this.ramps=[];this.cliffs=[];this.faces=[];this.seams=[];
    this.bridges=(map?.terrain?.bridges||[]).map((b,i)=>{const ca=Math.cos(b.angle||0),sa=Math.sin(b.angle||0),points=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>({x:b.x+x*b.halfLength*ca-y*b.halfWidth*sa,y:b.y+x*b.halfLength*sa+y*b.halfWidth*ca}));return assignBounds({...b,id:String(b.id||'bridge-'+i),level:Number(b.level??0),elevation:TerrainSurfaceAtlas.elevationForLevel(Number(b.level??0)),points})});
    this.maxLevel=Math.max(0,...this.layers.map(p=>p.level),...this.bridges.map(p=>p.level));this.maxHeight=TerrainSurfaceAtlas.elevationForLevel(this.maxLevel);
    this.minLevel=Math.min(0,...this.layers.map(p=>p.level),...this.bridges.map(p=>p.level));this.minHeight=TerrainSurfaceAtlas.elevationForLevel(this.minLevel);
    const ids=new Set();
    for(const layer of this.layers){
      if(!layer.id||layer.id==='low-ground'||ids.has(layer.id)||!Number.isSafeInteger(layer.level)||!Number.isFinite(layer.elevation))throw new Error('Invalid terrain layer: '+layer.id);
      ids.add(layer.id);
      if(layer.points.length<3||layer.points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0||p.x>this.width||p.y>this.height))throw new Error('Invalid terrain layer polygon: '+layer.id);
      for(let i=0;i<layer.points.length;i++)for(let j=i+2;j<layer.points.length;j++){
        if(i===0&&j===layer.points.length-1)continue;
        const a=layer.points[i],b=layer.points[(i+1)%layer.points.length],c=layer.points[j],d=layer.points[(j+1)%layer.points.length];
        if(segmentsIntersect(a.x,a.y,b.x,b.y,c.x,c.y,d.x,d.y))throw new Error('Self-intersecting terrain layer: '+layer.id);
      }
      triangulatePolygon(layer.points);
      const area=layer.points.reduce((sum,p,i)=>{const q=layer.points[(i+1)%layer.points.length];return sum+p.x*q.y-q.x*p.y},0);
      if(Math.abs(area)<1)throw new Error('Degenerate terrain layer: '+layer.id);
      layer.area=area;layer.topPoints=[];
      if(layer.innerPoints){
        if(layer.innerPoints.length!==layer.points.length||layer.innerPoints.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||!pointInSimplePolygon(p.x,p.y,layer.points))||boundariesCross(layer.points,layer.innerPoints))throw new Error('Invalid terrain bank inner contour: '+layer.id);
        triangulatePolygon(layer.innerPoints);
        for(let i=0;i<layer.innerPoints.length;i++)for(let j=i+2;j<layer.innerPoints.length;j++){
          if(i===0&&j===layer.innerPoints.length-1)continue;
          const a=layer.innerPoints[i],b=layer.innerPoints[(i+1)%layer.innerPoints.length],c=layer.innerPoints[j],d=layer.innerPoints[(j+1)%layer.innerPoints.length];
          if(segmentsIntersect(a.x,a.y,b.x,b.y,c.x,c.y,d.x,d.y))throw new Error('Self-intersecting terrain bank: '+layer.id);
        }
      }
    }
    for(const bridge of this.bridges){
      if(ids.has(bridge.id)||bridge.id==='low-ground'||!Number.isSafeInteger(bridge.level)||!Number.isFinite(bridge.elevation)||!(bridge.halfLength>0&&bridge.halfWidth>0)||bridge.points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0||p.x>this.width||p.y>this.height))throw new Error('Invalid terrain bridge: '+bridge.id);
      ids.add(bridge.id);
    }
    for(let i=0;i<this.bridges.length;i++)for(let j=i+1;j<this.bridges.length;j++)if(polygonsOverlap(this.bridges[i].points,this.bridges[j].points))throw new Error('Overlapping terrain bridges: '+this.bridges[i].id+' / '+this.bridges[j].id);
    // Layers may stack only by strict containment. Crossing/partial overlaps are ambiguous.
    for(let i=0;i<this.layers.length;i++)for(let j=i+1;j<this.layers.length;j++){
      const a=this.layers[i],b=this.layers[j];
      if(boundariesCross(a.points,b.points))throw new Error('Terrain layer boundaries cross: '+a.id+' / '+b.id);
      const aInB=pointInSimplePolygon(a.points[0].x,a.points[0].y,b.points);
      const bInA=pointInSimplePolygon(b.points[0].x,b.points[0].y,a.points);
      if(aInB&&bInA)throw new Error('Duplicate terrain layer footprint: '+a.id+' / '+b.id);
    }
    for(const layer of this.layers){
      const parents=this.layers.filter(p=>p!==layer&&pointInSimplePolygon(layer.points[0].x,layer.points[0].y,p.points));
      layer.parent=parents.sort((a,b)=>Math.abs(a.area)-Math.abs(b.area))[0]||null;
      if(layer.parent?.innerPoints&&(layer.points.some(p=>!pointInSimplePolygon(p.x,p.y,layer.parent.innerPoints))||boundariesCross(layer.points,layer.parent.innerPoints)))throw new Error('Terrain child overlaps its parent bank: '+layer.id);
    }
    const underlyingAt=(x,y,excludeId=null)=>{
      let best={id:'low-ground',level:0,elevation:0};
      for(const layer of this.layers){
        if(layer.id===excludeId||best.area!==undefined&&Math.abs(layer.area)>=Math.abs(best.area))continue;
        if(pointInSimplePolygon(x,y,layer.points)||this.onBoundary(layer.points,x,y))best={id:layer.id,level:layer.level,elevation:layer.elevation,area:layer.area};
      }
      return best;
    };
    for(const layer of this.layers){
      if(layer.innerPoints){
        const outer=layer.parent||{id:'low-ground',level:0,elevation:0},raised=layer.level>outer.level;
        if(layer.level===outer.level)throw new Error('Terrain bank must connect different levels: '+layer.id);
        if((map.terrain?.ramps||[]).some(r=>r.layerId===layer.id))throw new Error('Continuous terrain bank cannot have authored ramp openings: '+layer.id);
        layer.topPoints=layer.innerPoints;
        for(let i=0;i<layer.points.length;i++){
          const j=(i+1)%layer.points.length,a=layer.points[i],b=layer.points[j],ia=layer.innerPoints[i],ib=layer.innerPoints[j],loA=raised?a:ia,loB=raised?b:ib,hiA=raised?ia:a,hiB=raised?ib:b,dx=(hiA.x+hiB.x-loA.x-loB.x)/2,dy=(hiA.y+hiB.y-loA.y-loB.y)/2,run=Math.hypot(dx,dy);
          const ramp=assignBounds({id:layer.id+':bank:'+i,bank:true,edge:i,layer,lowLevel:Math.min(layer.level,outer.level),highLevel:Math.max(layer.level,outer.level),lowElevation:Math.min(layer.elevation,outer.elevation),highElevation:Math.max(layer.elevation,outer.elevation),lowSurfaceId:raised?outer.id:layer.id,highSurfaceId:raised?layer.id:outer.id,lowA:loA,lowB:loB,highA:hiA,highB:hiB,nx:dx/run,ny:dy/run,run,points:[loA,loB,hiB,hiA]});
          const triangles=[TerrainSurfaceAtlas.rampTriangle(ramp,0),TerrainSurfaceAtlas.rampTriangle(ramp,1)];
          if(!run||triangles.some(t=>!Number.isFinite(t.den)||Math.abs(t.den)<1e-6)||triangles[0].den*triangles[1].den<0)throw new Error('Invalid terrain bank strip: '+ramp.id);
          this.ramps.push(ramp);this.seams.push({a,b},{a:ia,b:ib},{a,b:ia});
        }
        continue;
      }
      const area=layer.area,sign=area>0?1:-1;
      for(let edge=0;edge<layer.points.length;edge++){
        const a=layer.points[edge],b=layer.points[(edge+1)%layer.points.length],dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy),nx=-dy/len*sign,ny=dx/len*sign;
        layer.topPoints.push(a);
        const outside=t=>{const q=TerrainSurfaceAtlas.lerp(a,b,t),eps=.25;return underlyingAt(q.x-nx*eps,q.y-ny*eps,layer.id)};
        const lows=[outside(.15),outside(.5),outside(.85)];
        if(lows.some(q=>q.level!==lows[0].level||q.id!==lows[0].id))throw new Error('Terrain edge crosses multiple lower levels; split the layer edge: '+layer.id+' / edge '+edge);
        const low=lows[0];
        const openings=(map.terrain?.ramps||[]).filter(r=>r.layerId===layer.id&&r.edge===edge).slice().sort((u,v)=>u.t0-v.t0||String(u.id).localeCompare(String(v.id)));
        let end=0;
        const raised=layer.level>low.level;
        const cliff=(lo,hi)=>{if(hi-lo<1e-8||layer.level===low.level)return;const p=TerrainSurfaceAtlas.lerp(a,b,lo),q=TerrainSurfaceAtlas.lerp(a,b,hi),id=`${layer.id}:edge:${edge}:${lo}`;this.cliffs.push(TerrainSurfaceAtlas.wall(p,q,id));this.faces.push({a:p,b:q,lowA:Math.min(low.elevation,layer.elevation),lowB:Math.min(low.elevation,layer.elevation),high:Math.max(low.elevation,layer.elevation),lowLevel:Math.min(low.level,layer.level),highLevel:Math.max(low.level,layer.level),outwardY:raised?-ny:ny})};
        for(const spec of openings){
          if(!spec.id||ids.has(spec.id)||!(spec.t0>=end&&spec.t1>spec.t0&&spec.t1<=1&&spec.run>0))throw new Error('Invalid terrain ramp: '+spec.id);
          ids.add(spec.id);cliff(end,spec.t0);end=spec.t1;
          const p=TerrainSurfaceAtlas.lerp(a,b,spec.t0),q=TerrainSurfaceAtlas.lerp(a,b,spec.t1),ph={x:p.x+nx*spec.run,y:p.y+ny*spec.run},qh={x:q.x+nx*spec.run,y:q.y+ny*spec.run};
          for(const v of [ph,qh,TerrainSurfaceAtlas.lerp(ph,qh,.5)])if(!pointInSimplePolygon(v.x-nx*.02,v.y-ny*.02,layer.points))throw new Error('Ramp extends outside its layer: '+spec.id);
          if(layer.level===low.level)throw new Error('Ramp must connect different terrain levels: '+spec.id);
          const ramp=assignBounds({...spec,layer,lowLevel:Math.min(low.level,layer.level),lowSurfaceId:raised?low.id:layer.id,lowElevation:Math.min(low.elevation,layer.elevation),highLevel:Math.max(low.level,layer.level),highSurfaceId:raised?layer.id:low.id,highElevation:Math.max(low.elevation,layer.elevation),lowA:raised?p:ph,lowB:raised?q:qh,highA:raised?ph:p,highB:raised?qh:q,nx:raised?nx:-nx,ny:raised?ny:-ny,points:[p,q,qh,ph]});
          this.ramps.push(ramp);layer.topPoints.push(p,ph,qh,q);
          this.cliffs.push(TerrainSurfaceAtlas.wall(p,ph,spec.id+':left'),TerrainSurfaceAtlas.wall(q,qh,spec.id+':right'));
          this.faces.push({a:p,b:ph,lowA:ramp.lowElevation,lowB:layer.elevation,high:layer.elevation,highA:raised?layer.elevation:low.elevation,highB:layer.elevation,lowLevel:ramp.lowLevel,highLevel:ramp.highLevel,outwardY:dy/len*(raised?1:-1)},{a:qh,b:q,lowA:layer.elevation,lowB:ramp.lowElevation,high:layer.elevation,highA:layer.elevation,highB:raised?layer.elevation:low.elevation,lowLevel:ramp.lowLevel,highLevel:ramp.highLevel,outwardY:-dy/len*(raised?1:-1)});
          this.seams.push({a:p,b:q},{a:ph,b:qh});
        }
        cliff(end,1);
      }
    }
    for(let i=0;i<this.ramps.length;i++)for(let j=i+1;j<this.ramps.length;j++){
      const a=this.ramps[i],b=this.ramps[j];if(a.bank&&b.bank&&a.layer===b.layer&&(Math.abs(a.edge-b.edge)===1||Math.abs(a.edge-b.edge)===a.layer.points.length-1))continue;
      if(polygonsOverlap(a.points,b.points))throw new Error('Overlapping terrain ramps: '+a.id+' / '+b.id);
    }
    for(const ramp of this.ramps)for(const child of this.layers){
      let parent=child.parent;while(parent&&parent!==ramp.layer)parent=parent.parent;
      if(parent===ramp.layer&&polygonsOverlap(ramp.points,child.points))throw new Error('Terrain ramp overlaps a child layer: '+ramp.id+' / '+child.id);
    }
    for(const layer of this.layers)triangulatePolygon(layer.topPoints);
    for(const r of map?.terrain?.ramps||[])if(!this.ramps.some(q=>q.id===r.id))throw new Error('Unknown ramp layer/edge: '+r.id);
    this.cliffs=this.cliffs.filter(Boolean);this.layerIndex=new BoundsIndex(this.layers);this.rampIndex=new BoundsIndex(this.ramps);this.bridgeIndex=new BoundsIndex(this.bridges);
    // Hidden terrain contacts are cut by the same deck footprint as the floors.
    // All collision consumers receive these exposed polygons, including motion casts.
    if(this.bridges.length)this.cliffs=this.cliffs.flatMap(wall=>{
      const bounds=assignBounds(wall),holes=this.bridgeIndex.query(bounds.minX,bounds.minY,bounds.maxX,bounds.maxY).map(b=>b.points);
      if(!holes.length)return[wall];
      const mesh=TerrainSurfaceAtlas.flatMesh(wall.points,holes,0);
      return mesh.triangles.map((t,i)=>({...wall,id:wall.id+':exposed:'+i,points:t.map(j=>({x:mesh.vertices[j].x,y:mesh.vertices[j].z}))}));
    });
    // A bridge joins equal-height ground at its ends; unsupported side edges are
    // physical cliffs, split wherever the terrain plane changes under the deck.
    const terrainPolygons=[...this.layers,...this.ramps,...this.ramps.map(r=>({points:[r.lowA,r.highB]}))];
    for(const bridge of this.bridges)for(let edge=0;edge<4;edge++){
      const a=bridge.points[edge],b=bridge.points[(edge+1)%4],dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy),outX=dy/len,outY=-dx/len,cuts=TerrainSurfaceAtlas.segmentCuts(a.x,a.y,b.x,b.y,terrainPolygons);
      this.seams.push({a,b});
      for(let i=1;i<cuts.length;i++){
        const p=TerrainSurfaceAtlas.lerp(a,b,cuts[i-1]),q=TerrainSurfaceAtlas.lerp(a,b,cuts[i]),m=TerrainSurfaceAtlas.lerp(p,q,.5),under=this.sampleTerrain(m.x+outX*.02,m.y+outY*.02).elevation;
        if(under>bridge.elevation+.01)throw new Error('Terrain bridge is below its supporting surface: '+bridge.id);
        if(bridge.elevation-under<.01)continue;
        const lowA=Math.min(bridge.elevation,this.sampleTerrain(p.x+outX*.02,p.y+outY*.02).elevation),lowB=Math.min(bridge.elevation,this.sampleTerrain(q.x+outX*.02,q.y+outY*.02).elevation),id=bridge.id+':side:'+edge+':'+i;
        const wall=TerrainSurfaceAtlas.wall(p,q,id);if(wall)this.cliffs.push(wall);this.faces.push({a:p,b:q,lowA,lowB,high:bridge.elevation,lowLevel:Math.round(TerrainSurfaceAtlas.levelForElevation(Math.min(lowA,lowB))),highLevel:bridge.level,outwardY:outY,bridge:true});
      }
    }
    // Exact terrain triangles drive gameplay picking/navigation. Elevation is derived solely from level.
    this.surfaceMesh=[];
    const vertex=(p,height)=>({x:p.x,y:height,z:p.y,groundY:0});
    const baseContour=[{x:0,y:0},{x:this.width,y:0},{x:this.width,y:this.height},{x:0,y:this.height}];
    const floorMesh=(layer,render=false,bridges=this.bridges)=>{
      const contour=layer?(layer.innerPoints||(render?layer.renderTopPoints:layer.points)):baseContour;
      const childLayers=this.layers.filter(p=>p.parent===(layer||null)),children=childLayers.map(p=>p.innerPoints?p.points:render?p.renderTopPoints:p.points);
      const ramps=this.ramps.filter(r=>!r.bank&&(r.layer===layer||render&&childLayers.includes(r.layer))).map(r=>r.points);
      return{kind:'plateau',id:layer?.id||'low-ground',level:layer?.level||0,...TerrainSurfaceAtlas.flatMesh(contour,[...children,...ramps,...bridges.map(b=>b.points)],layer?.elevation||0)};
    };
    // Check the full footprint against exposed terrain before subtracting decks.
    // Parent surfaces hidden by nested layers must not count as bridge support.
    if(this.bridges.length){
      const supports=[];
      for(const layer of [null,...this.layers]){
        const mesh=floorMesh(layer,false,[]);
        for(const t of mesh.triangles)supports.push({points:t.map(i=>({x:mesh.vertices[i].x,y:mesh.vertices[i].z})),heightAt:()=>layer?.elevation||0});
      }
      for(const ramp of this.ramps)for(let i=0;i<2;i++)supports.push(TerrainSurfaceAtlas.rampTriangle(ramp,i));
      for(const bridge of this.bridges)for(const support of supports){
        const overlap=NavigationGoal.clipPolygon(support.points,bridge.points);
        const area=Math.abs(overlap.reduce((sum,p,i)=>{const q=overlap[(i+1)%overlap.length];return sum+p.x*q.y-q.x*p.y},0));
        if(area>1e-8&&overlap.some(p=>support.heightAt(p.x,p.y)>bridge.elevation+.01))throw new Error('Terrain bridge is below its supporting surface: '+bridge.id);
      }
    }
    const rampMesh=ramp=>{
      const patch={kind:'ramp',id:ramp.id,bank:!!ramp.bank,lowLevel:ramp.lowLevel,highLevel:ramp.highLevel,vertices:[],triangles:[]};
      if(!this.bridges.length){patch.vertices=[vertex(ramp.lowA,ramp.lowElevation),vertex(ramp.lowB,ramp.lowElevation),vertex(ramp.highB,ramp.highElevation),vertex(ramp.highA,ramp.highElevation)];patch.triangles=[[0,1,2],[0,2,3]];return patch}
      for(let i=0;i<2;i++){const plane=TerrainSurfaceAtlas.rampTriangle(ramp,i),mesh=TerrainSurfaceAtlas.flatMesh(plane.points,this.bridges.map(b=>b.points),plane.heightAt),start=patch.vertices.length;patch.vertices.push(...mesh.vertices);patch.triangles.push(...mesh.triangles.map(t=>t.map(j=>j+start)))}
      return patch;
    };
    const bridgeMesh=bridge=>({kind:'plateau',id:bridge.id,bridge:true,level:bridge.level,vertices:bridge.points.map(p=>vertex(p,bridge.elevation)),triangles:[[0,1,2],[0,2,3]]});
    this.surfaceMesh.push(floorMesh(null));
    for(const layer of this.layers)this.surfaceMesh.push(floorMesh(layer));
    for(const ramp of this.ramps)this.surfaceMesh.push(rampMesh(ramp));
    for(const bridge of this.bridges)this.surfaceMesh.push(bridgeMesh(bridge));
    for(const face of this.faces)this.surfaceMesh.push({kind:'cliff',outwardY:face.outwardY,face,
      vertices:[vertex(face.a,face.lowA),vertex(face.b,face.lowB),vertex(face.b,face.highB??face.high),vertex(face.a,face.highA??face.high)],triangles:[[0,1,2],[0,2,3]]});

    // Presentation contour: round only authored corners. Ramp joins stay locked so
    // plateau/ramp/cliff surfaces continue to meet at exactly the same endpoints.
    const protectedKeys=new Set(),rampEdges=new Map();
    for(const ramp of this.ramps){
      if(ramp.bank)continue;
      for(const q of [ramp.lowA,ramp.lowB,ramp.highA,ramp.highB])protectedKeys.add(TerrainSurfaceAtlas.pointKey(q));
      const [p,q,qh,ph]=ramp.points,raised=ramp.layer.level===ramp.highLevel,outer=raised?ramp.lowElevation:ramp.highElevation,inner=ramp.layer.elevation;
      rampEdges.set(TerrainSurfaceAtlas.directedEdgeKey(p,ph),{kind:'side',raised,lowA:Math.min(outer,inner),lowB:inner,highA:Math.max(outer,inner),highB:inner});
      rampEdges.set(TerrainSurfaceAtlas.directedEdgeKey(qh,q),{kind:'side',raised,lowA:inner,lowB:Math.min(outer,inner),highA:inner,highB:Math.max(outer,inner)});
      rampEdges.set(TerrainSurfaceAtlas.directedEdgeKey(ph,qh),{kind:'seam'});
    }
    // Collision probes sample just outside a deck to choose its supporting plane.
    // Presentation must evaluate that plane on the actual rim, otherwise the
    // .02 probe offset leaves a visible slit between its wall and a sloping bank.
    this.renderFaces=this.faces.filter(face=>face.bridge).map(face=>({...face,
      lowA:Math.min(face.high,this.sampleTerrain(face.a.x,face.a.y).elevation),
      lowB:Math.min(face.high,this.sampleTerrain(face.b.x,face.b.y).elevation)}));
    for(const layer of this.layers){
      if(layer.innerPoints){layer.renderTopPoints=layer.innerPoints;continue}
      layer.renderTopPoints=TerrainSurfaceAtlas.smoothClosedContour(layer.topPoints,protectedKeys,2,.16);
      const pts=layer.renderTopPoints,area=pts.reduce((sum,q,i)=>{const t=pts[(i+1)%pts.length];return sum+q.x*t.y-t.x*q.y},0),sign=area>=0?1:-1;
      for(let i=0;i<pts.length;i++){
        const a=pts[i],b=pts[(i+1)%pts.length],special=rampEdges.get(TerrainSurfaceAtlas.directedEdgeKey(a,b));
        if(special?.kind==='seam')continue;
        const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);if(len<.01)continue;
        let lowA,lowB,highA,highB,outwardY=-dx/len*sign;
        if(special?.kind==='side'){({lowA,lowB,highA,highB}=special);if(!special.raised)outwardY=-outwardY}
        else{const outer=layer.parent?.elevation||0;lowA=lowB=Math.min(outer,layer.elevation);highA=highB=Math.max(outer,layer.elevation);if(outer>layer.elevation)outwardY=-outwardY}
        if(Math.max(highA-lowA,highB-lowB)<.001)continue;
        this.renderFaces.push({a,b,lowA,lowB,high:Math.max(highA,highB),highA,highB,lowLevel:Math.round(TerrainSurfaceAtlas.levelForElevation(Math.min(lowA,lowB))),highLevel:Math.round(TerrainSurfaceAtlas.levelForElevation(Math.max(highA,highB))),outwardY});
      }
    }
    // Rendering uses the rounded presentation contour; simulation/picking keeps surfaceMesh.
    this.renderSurfaceMesh=[];
    this.renderSurfaceMesh.push(floorMesh(null,true));
    for(const layer of this.layers)this.renderSurfaceMesh.push(floorMesh(layer,true));
    for(const ramp of this.ramps)this.renderSurfaceMesh.push(rampMesh(ramp));
    for(const bridge of this.bridges)this.renderSurfaceMesh.push(bridgeMesh(bridge));
    for(const face of this.renderFaces)this.renderSurfaceMesh.push({kind:'cliff',outwardY:face.outwardY,face,
      vertices:[vertex(face.a,face.lowA),vertex(face.b,face.lowB),vertex(face.b,face.highB??face.high),vertex(face.a,face.highA??face.high)],triangles:[[0,1,2],[0,2,3]]});
  }
  onBoundary(points,x,y){for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];if(pointSegmentDistance(x,y,a.x,a.y,b.x,b.y)<1e-6)return true}return false}
  rampProgress(r,x,y){return TerrainSurfaceAtlas.sampleRamp(r,x,y)?.progress??RangeUtil.clamp(((x-r.lowA.x)*r.nx+(y-r.lowA.y)*r.ny)/r.run,0,1)}
  // A cell that no bridge, ramp or layer edge touches has one sample at every
  // point inside it, so it is answered from a table; other cells sample exactly.
  sampleCellTable(){
    if(this.sampleCells)return this.sampleCells;
    const cell=TerrainSurfaceAtlas.SAMPLE_CELL,pad=.01,cols=Math.ceil(this.width/cell),rows=Math.ceil(this.height/cell),cells=new Array(cols*rows).fill(null);
    for(let cy=0;cy<rows;cy++)for(let cx=0;cx<cols;cx++){
      const x0=cx*cell-pad,y0=cy*cell-pad,x1=(cx+1)*cell+pad,y1=(cy+1)*cell+pad;
      if(this.bridgeIndex.query(x0,y0,x1,y1).length||this.rampIndex.query(x0,y0,x1,y1).length)continue;
      if(this.layerIndex.query(x0,y0,x1,y1).some(l=>polygonTouchesRect(l.points,x0,y0,x1,y1)))continue;
      cells[cy*cols+cx]=Object.freeze(this.sampleTerrain((cx+.5)*cell,(cy+.5)*cell));
    }
    return this.sampleCells={cell,cols,rows,cells};
  }
  sample(x,y){
    const table=this.sampleCells||this.sampleCellTable();
    if(x>=0&&y>=0){const cx=Math.floor(x/table.cell),cy=Math.floor(y/table.cell);if(cx<table.cols&&cy<table.rows){const hit=table.cells[cy*table.cols+cx];if(hit)return hit}}
    for(const bridge of this.bridgeIndex.query(x,y))if(pointInSimplePolygon(x,y,bridge.points)||this.onBoundary(bridge.points,x,y))return{id:bridge.id,level:bridge.level,elevation:bridge.elevation,bridge,ramp:null,progress:1,gradient:{x:0,z:0}};
    return this.sampleTerrain(x,y);
  }
  sampleTerrain(x,y){
    let bestRamp=null;
    for(const r of this.rampIndex.query(x,y))if((pointInSimplePolygon(x,y,r.points)||this.onBoundary(r.points,x,y))&&(!bestRamp||r.highLevel>bestRamp.highLevel))bestRamp=r;
    if(bestRamp){
      const plane=TerrainSurfaceAtlas.sampleRamp(bestRamp,x,y),t=plane?.progress??this.rampProgress(bestRamp,x,y),elevation=plane?.elevation??bestRamp.lowElevation+(bestRamp.highElevation-bestRamp.lowElevation)*t;
      return{id:bestRamp.id,level:t<.5?bestRamp.lowLevel:bestRamp.highLevel,elevation,ramp:bestRamp,progress:t,gradient:plane?.gradient,triangleIndex:plane?.triangleIndex};
    }
    let best=null;
    for(const l of this.layerIndex.query(x,y))if((pointInSimplePolygon(x,y,l.points)||this.onBoundary(l.points,x,y))&&(!best||Math.abs(l.area)<Math.abs(best.area)))best=l;
    if(best)return{id:best.id,level:best.level,elevation:best.elevation,layer:best,ramp:null,progress:1};
    return{id:'low-ground',level:0,elevation:0,ramp:null,progress:0};
  }
  levelAt(x,y){return this.sample(x,y).level}
  heightAt(x,y){return this.sample(x,y).elevation}
  buildable(x,y,r){
    // A footprint fully supported by the bridge does not touch the hidden bank below.
    for(const bridge of this.bridgeIndex.query(x,y,x,y,r))if(MapGeometry.pointInBridgeZone(x,y,bridge,-r))return true;
    for(const ramp of this.rampIndex.query(x,y,x,y,r)){
      if(pointInSimplePolygon(x,y,ramp.points))return false;
      for(let i=0;i<4;i++){const a=ramp.points[i],b=ramp.points[(i+1)%4];if(pointSegmentDistance(x,y,a.x,a.y,b.x,b.y)<r+2)return false}
    }return true;
  }
  transition(a,b,p,q){
    if(a.id===b.id)return true;
    const x=(p.x+q.x)/2,y=(p.y+q.y)/2;
    if(a.bridge||b.bridge){
      if(a.bridge&&b.bridge)return false;
      const bridge=a.bridge||b.bridge;
      return this.onBoundary(bridge.points,x,y)&&Math.abs(this.sampleTerrain(x,y).elevation-bridge.elevation)<.01;
    }
    if(!a.ramp&&!b.ramp)return a.level===b.level;
    if(a.ramp&&b.ramp){
      const u=a.ramp,v=b.ramp;if(u.id===v.id)return true;
      if(!u.bank||!v.bank||u.layer!==v.layer||!this.onBoundary(u.points,x,y)||!this.onBoundary(v.points,x,y))return false;
      const left=TerrainSurfaceAtlas.sampleRamp(u,x,y),right=TerrainSurfaceAtlas.sampleRamp(v,x,y);return!!left&&!!right&&Math.abs(left.elevation-right.elevation)<.01;
    }
    const r=a.ramp||b.ramp,flat=a.ramp?b:a,t=this.rampProgress(r,x,y);
    if(Math.abs(t)<1e-4)return flat.level===r.lowLevel&&(r.lowSurfaceId==='low-ground'||flat.id===r.lowSurfaceId);
    if(Math.abs(t-1)<1e-4)return flat.level===r.highLevel&&(r.highSurfaceId==='low-ground'||flat.id===r.highSurfaceId);
    return false;
  }
}

export { BattlefieldProjection, TerrainGeometry, TerrainSurfaceAtlas, TerrainSurfaceProjection };
