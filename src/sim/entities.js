// Units, buildings, projectiles, the vision policy and terrain queries.
import { RangeUtil } from '../core/game-rules.js';
import { CombatComponent, MovementComponent, StateContract, StatusComponent } from './components.js';
import { LaunchRules } from './launch-rules.js';
import { MapGeneration } from './map-generation.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { UnitDefinition } from '../definitions/units.js';
import { MapGeometry } from './map-geometry.js';
import { NAV_BUILDING_MARGIN } from '../definitions/combat-rules.js';
import { TERRAIN_ATTACK_REVEAL_RADIUS, VISION_SPATIAL_CELL } from '../definitions/world-rules.js';
import { WorldContext } from './world-context.js';
import { TerrainSurfaceAtlas } from './terrain.js';

class Unit{
  static stateContract=new StateContract({hitFlash:0,attackFlash:0,target:null},{
    presentation:["hitFlash","attackFlash"],
    derived:["collisionIntentTick","collisionIntentTx","collisionIntentTy","collisionMoveTick","collisionMoveStartFx","collisionMoveStartFy"],
    children:{status:StatusComponent.stateContract,movement:MovementComponent.stateContract,combat:CombatComponent.stateContract}
  });
  constructor(spec={}){
    const data=Unit.stateContract.create(spec);
    this.status=new StatusComponent(data.status||{});delete data.status;
    this.movement=new MovementComponent(data.movement||{});delete data.movement;
    this.combat=new CombatComponent(data.combat||{});delete data.combat;
    Object.assign(this,data);
  }
  toState(mode="snapshot"){return Unit.stateContract.capture(this,mode)}
  writeChecksum(h){Unit.stateContract.hash(h,this)}
  toJSON(){return this.toState("save")}
  static fromState(state){return new Unit(state||{})}
}

class Building{
  static stateContract=new StateContract({cooldownUntil:0,attackCooldownPhase:0,salvo:[],terrainRevealUntil0:0,terrainRevealUntil1:0},{presentation:["hitFlash","attackFlash"]});
  constructor(state={}){Object.assign(this,Building.stateContract.create(state));if(!Array.isArray(this.salvo))this.salvo=[]}
  cooldownActive(sim){return sim.tick<(Number(this.cooldownUntil)||0)}
  clearCooldown(){this.cooldownUntil=0}
  startCooldownUntil(tick){this.cooldownUntil=Math.max(0,Math.round(Number(tick)||0));return this.cooldownUntil}
  toState(mode="snapshot"){return Building.stateContract.capture(this,mode)}
  writeChecksum(h){Building.stateContract.hash(h,this)}toJSON(){return this.toState("save")}static fromState(state){return new Building(state||{})}
}
class Projectile{
  static stateContract=new StateContract({}, {presentation:["arcHeight","drawRadius","visualTag"]});
  constructor(state={}){
    Object.assign(this,Projectile.stateContract.create(state));
    this.visualTag="launchAmmo";
    this.arcHeight=LaunchRules.arcHeight(Math.hypot((Number(this.lockedAimX)||0)-(Number(this.launchX)||0),(Number(this.lockedAimY)||0)-(Number(this.launchY)||0)));
    this.drawRadius=8+Math.min(10,(this.payload?.count||0)/3);
  }toState(mode="snapshot"){return Projectile.stateContract.capture(this,mode)}
  writeChecksum(h){Projectile.stateContract.hash(h,this)}toJSON(){return this.toState("save")}static fromState(state){return new Projectile(state||{})}
}

class VisibilityPolicy{
  static snapshotQueries=new WeakMap();
  static unitQuery(state){
    if(typeof state.nearbyUnits==="function")return(x,y,r,visit)=>{for(const i of state.nearbyUnits(x,y,r))visit(state.units[i])};
    let cached=this.snapshotQueries.get(state);
    if(cached&&cached.tick===state.tick&&cached.units===state.units)return cached.query;
    const cell=VISION_SPATIAL_CELL,bins=new Map();
    for(const u of state.units||[])if(u?.alive){const key=Math.floor(u.x/cell)+","+Math.floor(u.y/cell);let bin=bins.get(key);if(!bin)bins.set(key,bin=[]);bin.push(u)}
    const query=(x,y,r,visit)=>{for(let cy=Math.floor((y-r)/cell);cy<=Math.floor((y+r)/cell);cy++)for(let cx=Math.floor((x-r)/cell);cx<=Math.floor((x+r)/cell);cx++){const bin=bins.get(cx+","+cy);if(bin)for(const u of bin)visit(u)}};
    this.snapshotQueries.set(state,{tick:state.tick,units:state.units,query});return query;
  }
  static revealUntil(unit,side){return Number(side===0?unit?.status?.terrainRevealUntil0:unit?.status?.terrainRevealUntil1)||0}
  static sources(state,side){
    const out=[],world=WorldContext.forState(state);
    for(const u of state.units||[])if(u.alive&&u.side===side){const d=UnitDefinition.get(u.type)||{};
      out.push({x:u.x,y:u.y,r:Number(d.sight)||0,level:world.terrain.surfaces.levelAt(u.x,u.y),ignoresTerrainVision:false,sourceId:u.id});
    }
    for(const b of state.buildings||[])if(b.alive!==false&&b.side===side){const d=BuildingDefinition.get(b.type)||{};out.push({x:b.x,y:b.y,r:Number(d.sight)||0,level:world.terrain.surfaces.levelAt(b.x,b.y),ignoresTerrainVision:false,sourceId:b.id})}
    // High-ground attackers briefly reveal their own tile to the side they attacked.
    for(const u of state.units||[])if(u?.alive&&u.side!==side&&this.revealUntil(u,side)>Number(state.tick||0))out.push({x:u.x,y:u.y,r:TERRAIN_ATTACK_REVEAL_RADIUS,level:world.terrain.surfaces.levelAt(u.x,u.y),ignoresTerrainVision:true,reveal:true,sourceId:`reveal:${u.id}`});
    for(const b of state.buildings||[])if(b?.alive!==false&&b.side!==side&&Number(side===0?b.terrainRevealUntil0:b.terrainRevealUntil1)>Number(state.tick||0))out.push({x:b.x,y:b.y,r:TERRAIN_ATTACK_REVEAL_RADIUS,level:world.terrain.surfaces.levelAt(b.x,b.y),ignoresTerrainVision:true,reveal:true,sourceId:`reveal:${b.id}`});
    return out;
  }
}
// Per-side visibility on a fixed cell grid: the one answer for combat targeting,
// AI, entity rendering and fog. A source lights the cells it can see by walking
// outward from its own cell; each cell inherits sight from the neighbour one step
// closer (0 A.D./OpenRA-style cells instead of a ray per target). Cells count the
// sources per sight ceiling, so "visible to a target on level L" is a lookup, and
// only sources whose cell, radius, level or terrain policy changed are repainted.
class VisionField{
  static CELL=32;
  static OPEN_CEILING=127; // terrain-ignoring reveals see every level
  static rasters=new WeakMap();
  static offsetTable=null;
  static of(owner,side,state){
    const terrain=WorldContext.forState(state).terrain,fields=owner.visionFields||=[null,null];
    let field=fields[side];if(field?.terrain!==terrain)field=fields[side]=new VisionField(terrain);
    return field.update(VisibilityPolicy.sources(state,side),state);
  }
  // Static terrain at cell centres: surface level and vision obstacle membership.
  static raster(terrain){
    let raster=this.rasters.get(terrain);if(raster)return raster;
    const cell=this.CELL,cols=Math.ceil(terrain.width/cell),rows=Math.ceil(terrain.height/cell),n=cols*rows;
    const level=new Int8Array(n),ground=new Uint8Array(n);
    const inside=(index,x,y)=>{for(const b of index.query(x,y,x,y,0))if(MapGeometry.pointInSimplePolygon(x,y,b.points))return true;return false};
    for(let cy=0;cy<rows;cy++)for(let cx=0;cx<cols;cx++){
      const x=Math.min(terrain.width,(cx+.5)*cell),y=Math.min(terrain.height,(cy+.5)*cell),c=cy*cols+cx;
      level[c]=terrain.surfaces.levelAt(x,y);ground[c]=inside(terrain.visionIndex,x,y)?1:0;
    }
    raster={cols,rows,level,ground};this.rasters.set(terrain,raster);return raster;
  }
  // Cell offsets sorted by distance; parent is the neighbour one step toward the origin.
  static offsets(radius){
    if(this.offsetTable?.radius>=radius)return this.offsetTable;
    const R=Math.max(radius,2*(this.offsetTable?.radius||8)),span=2*R+1,list=[];
    for(let dy=-R;dy<=R;dy++)for(let dx=-R;dx<=R;dx++)if(dx*dx+dy*dy<=R*R)list.push([dx,dy,dx*dx+dy*dy]);
    list.sort((a,b)=>a[2]-b[2]||a[1]-b[1]||a[0]-b[0]);
    const n=list.length,dx=new Int16Array(n),dy=new Int16Array(n),d2=new Int32Array(n),parent=new Int32Array(n),at=new Int32Array(span*span);
    list.forEach(([x,y,d],i)=>{dx[i]=x;dy[i]=y;d2[i]=d;at[(y+R)*span+x+R]=i});
    for(let i=0;i<n;i++){
      const x=dx[i],y=dy[i],ax=Math.abs(x),ay=Math.abs(y);let px,py;
      if(!ax&&!ay){parent[i]=-1;continue}
      if(ax>=ay){px=x-Math.sign(x);py=Math.sign(y)*Math.round(ay*(ax-1)/ax)}
      else{py=y-Math.sign(y);px=Math.sign(x)*Math.round(ax*(ay-1)/ay)}
      parent[i]=at[(py+R)*span+px+R];
    }
    return this.offsetTable={radius:R,dx,dy,d2,parent};
  }
  constructor(terrain){
    this.terrain=terrain;this.raster=VisionField.raster(terrain);this.size=this.raster.cols*this.raster.rows;
    this.visionAny=new Uint16Array(this.size);
    this.vision=new Map();this.records=new Map();this.duplicates=new Map();
    this.buildingGround=new Int32Array(this.size);this.blockers=[];this.blockerKey="";
    this.pass=new Uint8Array(0);this.scratch=new Int32Array(0);this.epoch=0;this.revision=0;this.sources=[];
  }
  cellAt(x,y){
    const {cols,rows}=this.raster,cell=VisionField.CELL;
    return RangeUtil.clamp(Math.floor(y/cell),0,rows-1)*cols+RangeUtil.clamp(Math.floor(x/cell),0,cols-1);
  }
  update(sources,state){
    this.sources=sources;this.syncBlockers(state);
    const epoch=++this.epoch;let changed=false;this.duplicates.clear();
    for(const s of sources){
      let id=String(s.sourceId);const seen=this.duplicates.get(id)||0;this.duplicates.set(id,seen+1);if(seen)id+="#"+seen;
      const ignore=!!s.ignoresTerrainVision,cell=this.cellAt(s.x,s.y);
      const key=`${cell}|${Number(s.r)||0}|${ignore?1:0}|${Number(s.level)||0}`,record=this.records.get(id);
      if(record?.key===key){record.epoch=epoch;continue}
      if(record)this.apply(record,-1);
      const next=this.paint(s,key,ignore,cell);next.epoch=epoch;this.records.set(id,next);this.apply(next,1);changed=true;
    }
    for(const [id,record] of this.records)if(record.epoch!==epoch){this.apply(record,-1);this.records.delete(id);changed=true}
    if(changed)this.revision++;
    return this;
  }
  // Vision-blocking buildings occlude cells behind them, never themselves or
  // the source inside them. A change repaints every source.
  syncBlockers(state){
    const blockers=[];
    for(const b of state.buildings||[]){
      if(b.alive===false||!(b.hp>0))continue;
      const d=BuildingDefinition.get(b.type);if(!d?.blocksVision)continue;
      blockers.push({x:b.x,y:b.y,r:(d.size||35)+NAV_BUILDING_MARGIN});
    }
    const key=blockers.map(b=>`${b.x},${b.y},${b.r}`).join(";");
    if(key===this.blockerKey)return;
    this.blockerKey=key;this.blockers=blockers;this.buildingGround.fill(0);
    const {cols,rows}=this.raster,cell=VisionField.CELL;
    blockers.forEach((b,i)=>{
      for(let cy=Math.max(0,Math.floor((b.y-b.r)/cell));cy<=Math.min(rows-1,Math.floor((b.y+b.r)/cell));cy++)
        for(let cx=Math.max(0,Math.floor((b.x-b.r)/cell));cx<=Math.min(cols-1,Math.floor((b.x+b.r)/cell));cx++){
          if(Math.hypot((cx+.5)*cell-b.x,(cy+.5)*cell-b.y)>=b.r)continue;
          this.buildingGround[cy*cols+cx]=i+1;
        }
    });
    for(const record of this.records.values())this.apply(record,-1);
    this.records.clear();this.revision++;
  }
  paint(s,key,ignore,origin){
    const cell=VisionField.CELL,{cols,rows,level,ground}=this.raster,sight=Math.max(0,Number(s.r)||0);
    const reach=sight/cell,reach2=reach*reach,table=VisionField.offsets(Math.ceil(reach));
    if(this.pass.length<table.d2.length)this.pass=new Uint8Array(table.d2.length);
    if(this.scratch.length<table.d2.length)this.scratch=new Int32Array(table.d2.length);
    const pass=this.pass,cells=this.scratch,ox=origin%cols,oy=(origin-ox)/cols,sourceLevel=Number(s.level)||0;
    const own=this.blockers.findIndex(b=>Math.hypot(s.x-b.x,s.y-b.y)<b.r)+1,occluder=this.buildingGround;
    // A zero radius sees nothing, not its own cell.
    let count=0;
    for(let i=0;i<table.d2.length;i++){
      const d2=table.d2[i];if(d2>reach2)break;
      const x=ox+table.dx[i],y=oy+table.dy[i],parent=table.parent[i];
      if(x<0||y<0||x>=cols||y>=rows||(parent>=0&&!pass[parent])){pass[i]=0;continue}
      const c=y*cols+x,seen=ignore||!ground[c]&&(parent<0||level[c]<=sourceLevel);
      pass[i]=seen&&(ignore||!occluder[c]||occluder[c]===own)?1:0;
      if(!seen)continue;
      cells[count++]=c;
    }
    const ceiling=ignore?VisionField.OPEN_CEILING:sourceLevel,visionCount=sight>0?count:0;
    return{key,ceiling,cells:cells.slice(0,visionCount),visionCount,epoch:0};
  }
  counts(map,ceiling){let counts=map.get(ceiling);if(!counts)map.set(ceiling,counts=new Uint16Array(this.size));return counts}
  apply(record,delta){
    const {cells,visionCount,ceiling}=record;
    if(visionCount){const counts=this.counts(this.vision,ceiling);for(let i=0;i<visionCount;i++){counts[cells[i]]+=delta;this.visionAny[cells[i]]+=delta}}
  }
  visibleAt(x,y,targetLevel=this.terrain.surfaces.levelAt(x,y)){
    const c=this.cellAt(x,y);if(!this.visionAny[c])return false;
    for(const [ceiling,counts] of this.vision)if(ceiling>=targetLevel&&counts[c])return true;
    return false;
  }
  // Highest ground level seen at a point: Infinity for a terrain-ignoring reveal, -Infinity for none.
  ceilingAt(x,y){
    const c=this.cellAt(x,y);if(!this.visionAny[c])return -Infinity;
    let best=-Infinity;for(const [ceiling,counts] of this.vision)if(counts[c]&&ceiling>best)best=ceiling;
    return best>=VisionField.OPEN_CEILING?Infinity:best;
  }
}
class TerrainQuery{
  static boxes=new WeakMap();
  // Bounding boxes reject most river polygon tests without changing any answer.
  static inPolygon(x,y,points){
    let box=this.boxes.get(points);
    if(!box){box={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};for(const p of points){box.minX=Math.min(box.minX,p.x);box.maxX=Math.max(box.maxX,p.x);box.minY=Math.min(box.minY,p.y);box.maxY=Math.max(box.maxY,p.y)}this.boxes.set(points,box)}
    return x>=box.minX&&x<=box.maxX&&y>=box.minY&&y<=box.maxY&&MapGeometry.pointInSimplePolygon(x,y,points);
  }
  static at(map,x,y,atlas=null){
    const terrain=MapGeneration.mapTerrainDescriptor(map);
    const bridge=(terrain.bridges||[]).find(b=>MapGeometry.pointInBridgeZone(x,y,b,0))||null;
    let river=false;
    if(!bridge){
      river=!!terrain.riverPolygon&&this.inPolygon(x,y,terrain.riverPolygon);
      if(!river)for(const poly of terrain.riverBranchPolygons||[])if(this.inPolygon(x,y,poly)){river=true;break}
      if(!river&&(!terrain.riverPolygon||terrain.riverPolygon.length<3)){
        river=(terrain.riverPath||[]).length>1&&MapGeometry.pointPolylineDist(x,y,terrain.riverPath)<=terrain.riverHalfWidth;
        if(!river)for(const branch of terrain.riverBranches||[])if(branch.length>1&&MapGeometry.pointPolylineDist(x,y,branch)<=terrain.riverHalfWidth*.72){river=true;break}
      }
    }
    const surface=(atlas||(map?TerrainSurfaceAtlas.fromMap(map):null))?.sample(x,y)||{elevation:0,level:0,ramp:null};
    const raised=surface.layer&&surface.level>(surface.layer.parent?.level??0);
    return{river:surface.elevation>0||raised||surface.ramp?false:river,bridge,level:surface.level,height:TerrainSurfaceAtlas.levelForElevation(surface.elevation),surfaceElevation:surface.elevation,terrainLayer:surface.level,ramp:surface.ramp?.id||null,rampProgress:surface.ramp?RangeUtil.clamp(Number(surface.progress)||0,0,1):null};
  }
}
// Tracks authoritative obstacle values without per-tick filter/map/string allocation.
// Direct writes by trusted campaign scripts are still noticed on the next sync.
class NavigationTopology{
  constructor(){this.records=[];this.byId=new Map();this.changes=[];this.version=0;this.scans=0}
  refresh(buildings){
    this.scans++;let count=0,changed=this.version===0;
    for(const b of buildings)if(b.alive!==false&&b.hp>0){count++;const old=this.byId.get(b.id),d=BuildingDefinition.get(b.type),r=(d?.size||35)+NAV_BUILDING_MARGIN;
      if(!old||old.type!==b.type||old.x!==b.x||old.y!==b.y||old.r!==r||old.terrainBarrier!==!!d?.isTerrainBarrier||old.blocksVision!==!!d?.blocksVision||old.blocksProjectile!==!!d?.blocksProjectile)changed=true;
    }
    if(!changed&&count===this.records.length)return false;
    const old=new Map(this.byId),records=[],changes=[];
    for(const b of buildings)if(b.alive!==false&&b.hp>0){const d=BuildingDefinition.get(b.type),r=(d?.size||35)+NAV_BUILDING_MARGIN;
      const next={id:b.id,type:b.type,x:b.x,y:b.y,r,terrainBarrier:!!d?.isTerrainBarrier,blocksVision:!!d?.blocksVision,blocksProjectile:!!d?.blocksProjectile,minX:b.x-r,maxX:b.x+r,minY:b.y-r,maxY:b.y+r},previous=old.get(b.id);
      if(!previous||Object.keys(next).some(key=>next[key]!==previous[key])){if(previous)changes.push(previous);changes.push(next)}
      records.push(next);old.delete(b.id);
    }
    changes.push(...old.values());this.changes=changes;
    if(!changes.length&&this.version>0)return false;
    this.records=records.sort((a,b)=>String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0);this.byId=new Map(this.records.map(b=>[b.id,b]));
    this.version++;return true;
  }
}

export { Building, NavigationTopology, Projectile, TerrainQuery, Unit, VisibilityPolicy, VisionField };
