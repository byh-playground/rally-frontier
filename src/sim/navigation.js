// Navigation mesh, tiles, goals, funnel and surface motion.
import { RangeUtil } from '../core/game-rules.js';
import { StrategySim } from './strategy-sim.js';
import { NavigationTopology } from './entities.js';
import { BurrowableMixin, LeapableMixin, MovementComponent, StateValue } from './components.js';
import { RallyStateCodec } from '../session/game-session.js';
import { HashUtil } from './map-generation.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { UNIT_RUNTIME_GEOMETRY, UnitDefinition } from '../definitions/units.js';
import { NEUTRAL_SIDE } from '../definitions/cards.js';
import { MapGeometry } from './map-geometry.js';
import { BUILDER_INTERACTION_PADDING, NAV_BUILDING_MARGIN } from '../definitions/combat-rules.js';
import { COLLISION_RADIUS_SCALE, GAS_WORKER_INTERACTION_PADDING, WORKER_DROPOFF_INTERACTION_RADIUS, WORKER_MINERAL_INTERACTION_PADDING } from '../definitions/world-rules.js';
import { WorldContext } from './world-context.js';
import { NavigationAStarScratch, NavigationMinHeap, NavigationObstacleIndex, PolygonTriangulation } from './terrain.js';
import { FP } from '../core/config.js';

// Convex free-space cells are bounded by actual obstacle edges, not raster samples.
// Vertical decomposition gives a polygon navigation mesh with explicit portals.
class NavigationMeshBuilder{
  static EPS=1e-6;
  static cross(a,b,c){return (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)}
  static hull(points){
    const p=points.slice().sort((a,b)=>a.x-b.x||a.y-b.y),q=[];
    for(const v of p)if(!q.length||v.x!==q[q.length-1].x||v.y!==q[q.length-1].y)q.push(v);
    if(q.length<3)return q;
    const lo=[],hi=[];
    for(const v of q){while(lo.length>1&&this.cross(lo[lo.length-2],lo[lo.length-1],v)<=1e-9)lo.pop();lo.push(v)}
    for(let i=q.length-1;i>=0;i--){const v=q[i];while(hi.length>1&&this.cross(hi[hi.length-2],hi[hi.length-1],v)<=1e-9)hi.pop();hi.push(v)}
    lo.pop();hi.pop();return lo.concat(hi);
  }
  static circle(radius){
    // Circumscribed polygon: never opens a gap smaller than the physical disc.
    // .25-unit approximation target, plus a .015 margin and 1/1024 quantization.
    const n=Math.max(16,Math.ceil(Math.PI/Math.acos(radius/(radius+.25))/4)*4),r=(radius+.015)/Math.cos(Math.PI/n);
    return Array.from({length:n},(_,i)=>({x:Math.round(Math.cos((i+.5)*2*Math.PI/n)*r*1024)/1024,y:Math.round(Math.sin((i+.5)*2*Math.PI/n)*r*1024)/1024}));
  }
  static inflate(points,radius){
    const ball=this.circle(radius),mesh=PolygonTriangulation.mesh(points);
    const parts=mesh.convex?[points]:mesh.triangles.map(t=>t.map(i=>points[i]));
    return parts.map(part=>this.hull(part.flatMap(p=>ball.map(v=>({x:p.x+v.x,y:p.y+v.y})))));
  }
  static edge(a,b,id){
    return {a,b,id,minX:Math.min(a.x,b.x),maxX:Math.max(a.x,b.x),minY:Math.min(a.y,b.y),maxY:Math.max(a.y,b.y),slope:Math.abs(b.x-a.x)>1e-12?(b.y-a.y)/(b.x-a.x):0};
  }
  static at(e,x){return e.a.y+(x-e.a.x)*e.slope}
  static build(width,height,radius,polygons,surfaces=null,bounds=null){
    const eps=this.EPS,xmin=bounds?.minX??radius+.02,xmax=bounds?.maxX??width-radius-.02,ymin=bounds?.minY??radius+.02,ymax=bounds?.maxY??height-radius-.02;
    const edges=[],polys=[],xs=[xmin,xmax];let seq=0;
    for(const points of polygons){
      const p={edges:[],minX:Infinity,maxX:-Infinity};
      for(let i=0;i<points.length;i++){
        const e=this.edge(points[i],points[(i+1)%points.length],seq++);edges.push(e);p.edges.push(e);
        p.minX=Math.min(p.minX,e.minX);p.maxX=Math.max(p.maxX,e.maxX);
        if(e.a.x>xmin+eps&&e.a.x<xmax-eps)xs.push(e.a.x);
        if(e.maxX-e.minX>eps&&Math.abs(e.slope)>eps)for(const y of [ymin,ymax]){
          const x=e.a.x+(y-e.a.y)/e.slope;if(x>Math.max(xmin,e.minX)+eps&&x<Math.min(xmax,e.maxX)-eps)xs.push(x);
        }
      }
      polys.push(p);
    }
    const seams=(surfaces?.seams||[]).map(s=>this.edge(s.a,s.b,seq++));
    for(const e of seams){edges.push(e);for(const p of [e.a,e.b])if(p.x>xmin+eps&&p.x<xmax-eps)xs.push(p.x);
      if(Math.abs(e.slope)>eps)for(const y of [ymin,ymax]){const x=e.a.x+(y-e.a.y)/e.slope;if(x>Math.max(xmin,e.minX)+eps&&x<Math.min(xmax,e.maxX)-eps)xs.push(x)}
    }
    const edgeIndex=new NavigationObstacleIndex(edges);
    for(const a of edges){
      if(a.maxX-a.minX<eps)continue;
      for(const b of edgeIndex.query(a.minX,a.minY,a.maxX,a.maxY)){
        if(b.id<=a.id||b.maxX-b.minX<eps)continue;
        const denominator=a.slope-b.slope;if(Math.abs(denominator)<1e-10)continue;
        const x=(b.a.y-b.slope*b.a.x-a.a.y+a.slope*a.a.x)/denominator;
        if(x>Math.max(xmin,a.minX,b.minX)+eps&&x<Math.min(xmax,a.maxX,b.maxX)-eps){
          const y=this.at(a,x);if(y>ymin-eps&&y<ymax+eps)xs.push(x);
        }
      }
    }
    xs.sort((a,b)=>a-b);const events=[];
    for(const x of xs)if(!events.length||x-events[events.length-1]>eps)events.push(x);
    const lower=this.edge({x:xmin,y:ymin},{x:xmax,y:ymin},-1),upper=this.edge({x:xmin,y:ymax},{x:xmax,y:ymax},-2);
    const cells=[],portals=[],seamPortals=new Map();let previous=[];
    const starts=polys.slice().sort((a,b)=>a.minX-b.minX);let cursor=0,active=[];
    for(let slab=0;slab<events.length-1;slab++){
      const xl=events[slab],xr=events[slab+1],xm=(xl+xr)/2;if(xr-xl<=eps)continue;
      while(cursor<starts.length&&starts[cursor].minX<xm)active.push(starts[cursor++]);
      active=active.filter(p=>p.maxX>xm);
      const intervals=[];
      for(const p of active){
        let low=null,high=null,ly=Infinity,hy=-Infinity;
        for(const e of p.edges)if(e.minX<xm&&e.maxX>xm){const y=this.at(e,xm);
          if(y<ly){ly=y;low=e}if(y>hy){hy=y;high=e}
        }
        if(!low||hy<=ymin+eps||ly>=ymax-eps)continue;
        if(ly<ymin){ly=ymin;low=lower}if(hy>ymax){hy=ymax;high=upper}
        intervals.push({low,high,ly,hy});
      }
      intervals.sort((a,b)=>a.ly-b.ly||b.hy-a.hy||a.low.id-b.low.id);
      const merged=[];
      for(const q of intervals){const last=merged[merged.length-1];
        if(!last||q.ly>last.hy+eps)merged.push({...q});else if(q.hy>last.hy){last.hy=q.hy;last.high=q.high}
      }
      let bottom=lower,by=ymin;const gaps=[];
      const prevByKey=new Map(previous.map(g=>[g.key,g]));
      const part=(lo,hi)=>{
        const surface=surfaces?.sample(xm,(this.at(lo,xm)+this.at(hi,xm))/2)||{id:'low-ground',level:0,elevation:0,ramp:null};
        const key=lo.id+':'+hi.id+':'+surface.id;let c=prevByKey.get(key)?.cell;
        if(!c||Math.abs(c.xr-xl)>eps){c={id:cells.length,xl,xr,lo,hi,links:[],component:-1,surface,terrainLayer:surface.level};cells.push(c)}else c.xr=xr;
        gaps.push({key,cell:c,lo,hi});
      };
      const gap=(lo,hi)=>{
        const cuts=seams.filter(e=>e.minX<xm&&e.maxX>xm&&this.at(e,xm)>this.at(lo,xm)+eps&&this.at(e,xm)<this.at(hi,xm)-eps).sort((a,b)=>this.at(a,xm)-this.at(b,xm)||a.id-b.id);
        let bottom=lo;for(const cut of cuts){if(this.at(cut,xm)-this.at(bottom,xm)>eps){part(bottom,cut);bottom=cut}}part(bottom,hi);
      };
      for(const q of merged){if(q.ly>by+eps)gap(bottom,q.low);if(q.hy>by){bottom=q.high;by=q.hy}}
      if(ymax>by+eps)gap(bottom,upper);
      let i=0,j=0;
      while(i<previous.length&&j<gaps.length){
        const a=previous[i],b=gaps[j];
        const al=this.at(a.lo,xl),ah=this.at(a.hi,xl),bl=this.at(b.lo,xl),bh=this.at(b.hi,xl);
        const low=Math.max(al,bl),high=Math.min(ah,bh);
        if(high-low>eps&&a.cell.id!==b.cell.id){
          const p={id:portals.length,a:a.cell.id,b:b.cell.id,p:{x:xl,y:low},q:{x:xl,y:high}};
          if(!surfaces||surfaces.transition(a.cell.surface,b.cell.surface,p.p,p.q)){
            portals.push(p);a.cell.links.push({to:b.cell.id,portal:p.id});b.cell.links.push({to:a.cell.id,portal:p.id});
          }
        }
        if(ah<bh-eps)i++;else if(bh<ah-eps)j++;else{i++;j++}
      }
      for(let k=1;k<gaps.length;k++){
        const a=gaps[k-1],b=gaps[k],e=a.hi;
        if(e!==b.lo||!seams.includes(e)||a.cell===b.cell)continue;
        const p={x:xl,y:this.at(e,xl)},q={x:xr,y:this.at(e,xr)};
        if(surfaces&&!surfaces.transition(a.cell.surface,b.cell.surface,p,q))continue;
        const key=a.cell.id+':'+b.cell.id+':'+e.id;
        let portal=seamPortals.get(key);
        if(portal&&Math.abs(portal.q.x-xl)<eps)portal.q=q;
        else {portal={id:portals.length,a:a.cell.id,b:b.cell.id,p,q};portals.push(portal);seamPortals.set(key,portal);a.cell.links.push({to:b.cell.id,portal:portal.id});b.cell.links.push({to:a.cell.id,portal:portal.id})}
      }
      previous=gaps;
    }
    for(const c of cells){
      c.points=[{x:c.xl,y:this.at(c.lo,c.xl)},{x:c.xr,y:this.at(c.lo,c.xr)},{x:c.xr,y:this.at(c.hi,c.xr)},{x:c.xl,y:this.at(c.hi,c.xl)}];
      c.x=(c.xl+c.xr)/2;c.y=(this.at(c.lo,c.x)+this.at(c.hi,c.x))/2;
      c.minX=c.xl;c.maxX=c.xr;c.minY=Math.min(...c.points.map(p=>p.y));c.maxY=Math.max(...c.points.map(p=>p.y));
      c.links.sort((a,b)=>a.to-b.to||a.portal-b.portal);
    }
    if(bounds)return {cells,portals,slabs:events.length-1};
    return this.connect(cells,portals,events.length-1);
  }
  static connect(cells,portals,slabs){
    for(const c of cells){c.component=-1;c.links.sort((a,b)=>a.to-b.to||a.portal-b.portal)}
    let components=0;
    for(const c of cells)if(c.component<0){const queue=[c.id];c.component=components;
      for(let i=0;i<queue.length;i++)for(const link of cells[queue[i]].links){const next=cells[link.to];if(next.component<0){next.component=components;queue.push(next.id)}}components++;
    }
    const fieldNodes=[];
    for(const p of portals){
      p.x=(p.p.x+p.q.x)/2;p.y=(p.p.y+p.q.y)/2;p.nodes=[];
      for(const v of [p.p,{x:p.x,y:p.y},p.q]){
        p.nodes.push(fieldNodes.length);fieldNodes.push({id:fieldNodes.length,portal:p.id,x:v.x,y:v.y,links:[]});
      }
    }
    for(const c of cells)for(let i=0;i<c.links.length;i++)for(let j=i+1;j<c.links.length;j++){
      const pa=portals[c.links[i].portal],pb=portals[c.links[j].portal];
      for(const ai of pa.nodes)for(const bi of pb.nodes){
        const a=fieldNodes[ai],b=fieldNodes[bi],cost=Math.max(1,Math.round(Math.hypot(a.x-b.x,a.y-b.y)*1024));
        a.links.push({to:b.id,via:c.id,cost});b.links.push({to:a.id,via:c.id,cost});
      }
    }
    for(const p of fieldNodes)p.links.sort((a,b)=>a.to-b.to||a.via-b.via);
    return {cells,portals,fieldNodes,components,index:new NavigationObstacleIndex(cells),fields:new Map(),goals:new Map(),slabs};
  }
  static contains(c,x,y){const e=1e-5;return x>=c.xl-e&&x<=c.xr+e&&y>=this.at(c.lo,x)-e&&y<=this.at(c.hi,x)+e}
  static closest(c,x,y){
    if(this.contains(c,x,y))return {x,y,d2:0};
    let best=null;
    for(let i=0;i<c.points.length;i++){
      const a=c.points[i],b=c.points[(i+1)%c.points.length],dx=b.x-a.x,dy=b.y-a.y;
      const t=RangeUtil.clamp(((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy||1),0,1),px=a.x+t*dx,py=a.y+t*dy,d2=(px-x)**2+(py-y)**2;
      if(!best||d2<best.d2)best={x:px,y:py,d2};
    }return best;
  }
}
class NavigationGraphOrder{
  static cell(a,b){return a.tile-b.tile||a.local-b.local}
  static portal(a,b){return a.kind-b.kind||a.owner-b.owner||a.direction-b.direction||a.local-b.local}
  static node(a,b){return this.portal(a.order,b.order)||a.sample-b.sample}
}
class NavigationGraphSlots{
  constructor(){this.items=[];this.free=[];this.count=0}
  add(value){const id=this.free.length?this.free.pop():this.items.length;value.id=id;this.items[id]=value;this.count++;return value}
  remove(id){if(!this.items[id])return;this.items[id]=null;this.free.push(id);this.count--}
}
class NavigationTileIndex{
  constructor(owner){this.owner=owner;this.out=[]}
  query(x0,y0,x1=x0,y1=y0,pad=0){
    const owner=this.owner,size=NavigationMeshTiles.SIZE;this.out.length=0;
    const minX=Math.max(0,Math.floor((Math.min(x0,x1)-pad)/size)),maxX=Math.min(owner.columns-1,Math.floor((Math.max(x0,x1)+pad)/size));
    const minY=Math.max(0,Math.floor((Math.min(y0,y1)-pad)/size)),maxY=Math.min(owner.rows-1,Math.floor((Math.max(y0,y1)+pad)/size));
    // Include the cell on both sides of an exact tile boundary.
    const left=(Math.min(x0,x1)-pad)/size,bottom=(Math.min(y0,y1)-pad)/size;
    for(let y=Math.max(0,minY-(Number.isInteger(bottom)?1:0));y<=maxY;y++)for(let x=Math.max(0,minX-(Number.isInteger(left)?1:0));x<=maxX;x++){
      const id=y*owner.columns+x,index=owner.tileIndex?owner.tileIndex(id):owner.tiles[id].index;if(index)this.out.push(...index.query(x0,y0,x1,y1,pad));
    }
    return this.out;
  }
}
class NavigationTileGeometry{
  constructor(geometry,r,fixed,ignoreBuildings){
    this.geometry=geometry;this.r=r;this.ignoreBuildings=ignoreBuildings;this.tiles=[];this.dirty=new Set();
    this.staticParts=new Map();this.dynamicSource=null;this.dynamic=[];
    const size=NavigationMeshTiles.SIZE,margin=r+.02;
    this.columns=Math.ceil(geometry.width/size);this.rows=Math.ceil(geometry.height/size);
    const boxes=fixed?.map(NavigationTileGeometry.polygonBounds);
    const overlaps=(a,b)=>a.minX<=b.maxX&&a.maxX>=b.minX&&a.minY<=b.maxY&&a.maxY>=b.minY;
    for(let y=0;y<this.rows;y++)for(let x=0;x<this.columns;x++){
      const bounds={minX:Math.max(margin,x*size),maxX:Math.min(geometry.width-margin,(x+1)*size),minY:Math.max(margin,y*size),maxY:Math.min(geometry.height-margin,(y+1)*size)};
      const surfaces=Object.create(geometry.surfaces);
      surfaces.seams=geometry.surfaces.seams.filter(s=>overlaps(bounds,{minX:Math.min(s.a.x,s.b.x),maxX:Math.max(s.a.x,s.b.x),minY:Math.min(s.a.y,s.b.y),maxY:Math.max(s.a.y,s.b.y)}));
      this.tiles.push({bounds,surfaces,fixed:boxes?boxes.filter(b=>overlaps(bounds,b)).map(b=>b.points):null,mesh:null,cells:[],portals:[],index:null});this.dirty.add(this.tiles.length-1);
    }
  }
  invalidate(records){
    const padding=this.r+.55,size=NavigationMeshTiles.SIZE;
    for(const b of records){if(this.ignoreBuildings&&!b.terrainBarrier)continue;
      for(let y=Math.max(0,Math.floor((b.minY-padding)/size));y<=Math.min(this.rows-1,Math.floor((b.maxY+padding)/size));y++)
        for(let x=Math.max(0,Math.floor((b.minX-padding)/size));x<=Math.min(this.columns-1,Math.floor((b.maxX+padding)/size));x++)this.dirty.add(y*this.columns+x);
    }
  }
  static polygonBounds(points){return {points,minX:Math.min(...points.map(p=>p.x)),maxX:Math.max(...points.map(p=>p.x)),minY:Math.min(...points.map(p=>p.y)),maxY:Math.max(...points.map(p=>p.y))}}
  buildTile(id,circles){
    const tile=this.tiles[id],b=tile.bounds,r=this.r,g=this.geometry;
    const overlaps=p=>p.minX<=b.maxX&&p.maxX>=b.minX&&p.minY<=b.maxY&&p.maxY>=b.minY;
    if(!tile.fixed){
      // Projection has no need to inflate terrain on the other side of the map.
      // Keep the authored block order used by the full layer builder.
      const blocks=g.index.query(b.minX,b.minY,b.maxX,b.maxY,r+.3).slice().sort((a,b)=>g.blocks.indexOf(a)-g.blocks.indexOf(b));
      tile.fixed=blocks.flatMap(block=>{let parts=this.staticParts.get(block);
        if(!parts){parts=NavigationMeshBuilder.inflate(block.points,r).map(NavigationTileGeometry.polygonBounds);this.staticParts.set(block,parts)}
        return parts.filter(overlaps).map(p=>p.points);
      });
    }
    if(this.dynamicSource!==circles){this.dynamicSource=circles;
      this.dynamic=circles.filter(b=>!this.ignoreBuildings||b.terrainBarrier).map(b=>NavigationTileGeometry.polygonBounds(NavigationMeshBuilder.circle(b.r+r+.25).map(p=>({x:b.x+p.x,y:b.y+p.y}))));
    }
    const polygons=tile.fixed.concat(this.dynamic.filter(overlaps).map(p=>p.points));
    tile.mesh=b.maxX>b.minX&&b.maxY>b.minY?NavigationMeshBuilder.build(g.width,g.height,r,polygons,tile.surfaces,b):{cells:[],portals:[],slabs:0};
    return tile.mesh;
  }
}
class NavigationMeshTiles extends NavigationTileGeometry{
  static SIZE=1024;
  constructor(geometry,r,fixed,ignoreBuildings){
    super(geometry,r,fixed,ignoreBuildings);
    this.cellSlots=new NavigationGraphSlots();this.portalSlots=new NavigationGraphSlots();this.nodeSlots=new NavigationGraphSlots();this.boundaries=new Map();
    this.layer={cells:this.cellSlots.items,portals:this.portalSlots.items,fieldNodes:this.nodeSlots.items,fields:new Map(),goals:new Map(),index:new NavigationTileIndex(this),tiles:this,slabs:0};
  }
  rebuild(circles){
    const begun=performance.now(),dirty=[...this.dirty].sort((a,b)=>a-b),g=this.geometry,r=this.r,layer=this.layer;
    const oldCells=this.cellSlots.count,oldPortals=this.portalSlots.count,oldNodes=this.nodeSlots.count;
    const touched=new Set(),touchedNodes=new Set(),seams=new Map(),stats={cellsRemoved:0,cellsAdded:0,portalsRemoved:0,portalsAdded:0,nodesRemoved:0,nodesAdded:0,cellsRelinked:0,nodesRelinked:0,edgesAdded:0};
    const boundary=(a,direction)=>{const b=a+(direction===0?1:this.columns);seams.set(a+':'+direction,{a,b,direction})};
    for(const id of dirty){const x=id%this.columns,y=Math.floor(id/this.columns);
      if(x>0)boundary(id-1,0);if(x+1<this.columns)boundary(id,0);if(y>0)boundary(id-this.columns,1);if(y+1<this.rows)boundary(id,1);
      for(const c of this.tiles[id].cells)touched.add(c);
    }
    for(const key of seams.keys())for(const p of this.boundaries.get(key)||[]){touched.add(layer.cells[p.a]);touched.add(layer.cells[p.b])}
    // Remove only edges contributed by changed cells or their seam neighbors.
    const cleared=new Set(),clearEdges=c=>{if(cleared.has(c))return;cleared.add(c);
      for(const link of c.links){const p=layer.portals[link.portal];for(const id of p.nodes){const node=layer.fieldNodes[id];
        for(let i=node.links.length-1;i>=0;i--)if(node.links[i].via===c.id)node.links.splice(i,1);touchedNodes.add(node);
      }}
    };
    for(const c of touched)clearEdges(c);
    const removePortal=p=>{
      for(const id of [p.a,p.b]){const links=layer.cells[id].links,index=links.findIndex(link=>link.portal===p.id);if(index>=0)links.splice(index,1)}
      for(const id of p.nodes){this.nodeSlots.remove(id);stats.nodesRemoved++}this.portalSlots.remove(p.id);stats.portalsRemoved++;
    };
    for(const key of seams.keys()){for(const p of this.boundaries.get(key)||[])removePortal(p);this.boundaries.delete(key)}
    for(const id of dirty){const tile=this.tiles[id];
      for(const p of tile.portals)removePortal(p);
      for(const c of tile.cells){this.cellSlots.remove(c.id);stats.cellsRemoved++}
      layer.slabs-=tile.mesh?.slabs||0;tile.cells=[];tile.portals=[];
    }
    const detachMs=performance.now()-begun,geometryAt=performance.now();
    for(const id of dirty)layer.slabs+=this.buildTile(id,circles).slabs;
    this.dirty.clear();
    const geometryMs=performance.now()-geometryAt,connectAt=performance.now();
    const add=(a,b,p,q,order)=>{
      clearEdges(a);clearEdges(b);
      const portal=this.portalSlots.add({...order,a:a.id,b:b.id,p,q,x:(p.x+q.x)/2,y:(p.y+q.y)/2,nodes:[]});stats.portalsAdded++;
      for(const [sample,v]of [p,{x:portal.x,y:portal.y},q].entries()){
        const node=this.nodeSlots.add({portal:portal.id,order:portal,sample,x:v.x,y:v.y,links:[]});portal.nodes.push(node.id);touchedNodes.add(node);stats.nodesAdded++;
      }
      a.links.push({to:b.id,portal:portal.id});b.links.push({to:a.id,portal:portal.id});touched.add(a);touched.add(b);return portal;
    };
    for(const id of dirty){const tile=this.tiles[id];
      tile.cells=tile.mesh.cells.map(c=>{const cell=this.cellSlots.add({...c,tile:id,local:c.id,links:[],component:-1});stats.cellsAdded++;touched.add(cell);return cell});
      for(const p of tile.mesh.portals)tile.portals.push(add(tile.cells[p.a],tile.cells[p.b],p.p,p.q,{kind:0,owner:id,direction:0,local:p.id}));
      tile.index=new NavigationObstacleIndex(tile.cells);
    }
    const join=(left,right,vertical,edge,owner,direction)=>{
      const result=[];
      const eps=NavigationMeshBuilder.EPS,at=NavigationMeshBuilder.at;
      const side=(list,first)=>list.flatMap(c=>{
        if(vertical){if(Math.abs((first?c.xr:c.xl)-edge)>eps)return [];return [{c,lo:at(c.lo,edge),hi:at(c.hi,edge)}]}
        const e=first?c.hi:c.lo;if(Math.abs(at(e,c.xl)-edge)>eps||Math.abs(at(e,c.xr)-edge)>eps)return [];
        return [{c,lo:c.xl,hi:c.xr}];
      }).sort((a,b)=>a.lo-b.lo||a.hi-b.hi||NavigationGraphOrder.cell(a.c,b.c));
      const a=side(left,true),b=side(right,false);let i=0,j=0;
      while(i<a.length&&j<b.length){const low=Math.max(a[i].lo,b[j].lo),high=Math.min(a[i].hi,b[j].hi);
        if(high-low>eps){const p=vertical?{x:edge,y:low}:{x:low,y:edge},q=vertical?{x:edge,y:high}:{x:high,y:edge};
          if(g.surfaces.transition(a[i].c.surface,b[j].c.surface,p,q))result.push(add(a[i].c,b[j].c,p,q,{kind:1,owner,direction,local:result.length}));
        }
        if(a[i].hi<b[j].hi-eps)i++;else if(b[j].hi<a[i].hi-eps)j++;else{i++;j++}
      }
      return result;
    };
    for(const [key,{a,b,direction}]of [...seams].sort((x,y)=>x[1].a-y[1].a||x[1].direction-y[1].direction)){
      const edge=(direction===0?a%this.columns+1:Math.floor(a/this.columns)+1)*NavigationMeshTiles.SIZE;
      this.boundaries.set(key,join(this.tiles[a].cells,this.tiles[b].cells,direction===0,edge,a,direction));
    }
    for(const c of touched){if(layer.cells[c.id]!==c)continue;stats.cellsRelinked++;
      c.links.sort((a,b)=>NavigationGraphOrder.cell(layer.cells[a.to],layer.cells[b.to])||NavigationGraphOrder.portal(layer.portals[a.portal],layer.portals[b.portal]));
      for(let i=0;i<c.links.length;i++)for(let j=i+1;j<c.links.length;j++){
        const pa=layer.portals[c.links[i].portal],pb=layer.portals[c.links[j].portal];
        for(const ai of pa.nodes)for(const bi of pb.nodes){const a=layer.fieldNodes[ai],b=layer.fieldNodes[bi],cost=Math.max(1,Math.round(Math.hypot(a.x-b.x,a.y-b.y)*1024));
          a.links.push({to:b.id,via:c.id,cost});b.links.push({to:a.id,via:c.id,cost});touchedNodes.add(a);touchedNodes.add(b);stats.edgesAdded+=2;
        }
      }
    }
    for(const node of touchedNodes)if(layer.fieldNodes[node.id]===node){stats.nodesRelinked++;
      node.links.sort((a,b)=>NavigationGraphOrder.node(layer.fieldNodes[a.to],layer.fieldNodes[b.to])||NavigationGraphOrder.cell(layer.cells[a.via],layer.cells[b.via]));
    }
    const relinkMs=performance.now()-connectAt,componentsAt=performance.now();
    // A local deletion can split distant reachability; labels and goal fields
    // are global derived values, while all unaffected graph objects stay intact.
    for(const tile of this.tiles)for(const c of tile.cells)c.component=-1;
    let components=0;
    for(const tile of this.tiles)for(const c of tile.cells)if(c.component<0){const queue=[c];c.component=components;
      for(let i=0;i<queue.length;i++)for(const link of queue[i].links){const next=layer.cells[link.to];if(next.component<0){next.component=components;queue.push(next)}}components++;
    }
    layer.fields.clear();layer.goals.clear();layer.sharedPaths?.clear();
    Object.assign(stats,{cellsPreserved:oldCells-stats.cellsRemoved,portalsPreserved:oldPortals-stats.portalsRemoved,nodesPreserved:oldNodes-stats.nodesRemoved});
    Object.assign(layer,{components,rebuiltTiles:dirty.length,geometryMs,connectMs:detachMs+performance.now()-connectAt,detachMs,relinkMs,componentMs:performance.now()-componentsAt,graphChanges:stats,cellCount:this.cellSlots.count,portalCount:this.portalSlots.count,nodeCount:this.nodeSlots.count});
    return layer;
  }
}
class NavigationProjectionTiles extends NavigationTileGeometry{
  constructor(navigation,r,ignoreBuildings){
    super(navigation.geometry,r,null,ignoreBuildings);this.navigation=navigation;
    this.layer={index:new NavigationTileIndex(this),ignoreId:ignoreBuildings?'*':null};
  }
  tileIndex(id){const tile=this.tiles[id];
    if(this.dirty.has(id)){
      const begun=performance.now(),b=tile.bounds,circles=this.navigation.circleIndex.query(b.minX,b.minY,b.maxX,b.maxY,this.r+.55).slice().sort((a,b)=>String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0);
      const mesh=this.buildTile(id,circles);
      for(const c of mesh.cells){c.tile=id;c.local=c.id}
      tile.index=new NavigationObstacleIndex(mesh.cells);this.dirty.delete(id);
      this.navigation.metrics.projectionTilesBuilt++;this.navigation.metrics.projectionBuildMs+=performance.now()-begun;
    }
    return tile.index;
  }
}
class NavigationFunnel{
  static area(a,b,c){return (c.x-a.x)*(b.y-a.y)-(b.x-a.x)*(c.y-a.y)}
  static equal(a,b){return Math.abs(a.x-b.x)+Math.abs(a.y-b.y)<1e-7}
  static path(start,goal,portals){
    let apex=start,left=start,right=start,apexAt=0,leftAt=0,rightAt=0;
    const chain=[{left:start,right:start},...portals,{left:goal,right:goal}],result=[start];
    let operations=0;
    for(let i=1;i<chain.length;i++){
      if(++operations>chain.length*chain.length*4+10)throw new Error('NavMesh funnel did not converge');
      const l=chain[i].left,r=chain[i].right;
      if(this.area(apex,right,r)<=0){
        if(this.equal(apex,right)||this.area(apex,left,r)>0){right=r;rightAt=i}
        else{result.push(left);apex=left;apexAt=leftAt;left=apex;right=apex;leftAt=rightAt=apexAt;i=apexAt;continue}
      }
      if(this.area(apex,left,l)>=0){
        if(this.equal(apex,left)||this.area(apex,right,l)<0){left=l;leftAt=i}
        else{result.push(right);apex=right;apexAt=rightAt;left=apex;right=apex;leftAt=rightAt=apexAt;i=apexAt;continue}
      }
    }
    if(!this.equal(result[result.length-1],goal))result.push(goal);
    return result;
  }
}
// Navigation owns reachability; interaction geometry owns the legal arrival set.
// Goal regions are continuous (discs/annuli), not a fixed number of radial probes.
class NavigationGoal{
  static EPS=1e-7;
  static ARRIVAL_INSET=5/FP;
  constructor(x,y,radius=0,innerRadius=0,terrainLine=false,project=false){
    if(![x,y,radius,innerRadius].every(Number.isFinite)||radius<0||innerRadius<0||innerRadius>radius)throw new Error('Invalid navigation goal');
    this.x=x;this.y=y;this.radius=radius;this.innerRadius=innerRadius;this.terrainLine=terrainLine;this.project=project;
    this.key=[x,y,radius,innerRadius,terrainLine?1:0,project?1:0].join(':');
  }
  static fromKey(key){
    if(typeof key!=='string'||key.length>1024)throw new Error('Invalid navigation goal key');
    const values=key.split(':');if(values.length!==6)throw new Error('Invalid navigation goal key');
    const numbers=values.slice(0,4).map(Number);if(!numbers.every(Number.isFinite)||!['0','1'].includes(values[4])||!['0','1'].includes(values[5]))throw new Error('Invalid navigation goal key');
    const goal=new NavigationGoal(...numbers,values[4]==='1',values[5]==='1');if(goal.key!==key)throw new Error('Noncanonical navigation goal key');return goal;
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
    for(let i=0;i<points.length;i++)if(NavigationMeshBuilder.cross(points[i],points[(i+1)%points.length],{x,y})<-this.EPS)return false;
    return true;
  }
  static clipPolygon(points,clip){
    let out=points;
    for(let i=0;i<clip.length&&out.length;i++){
      const a=clip[i],b=clip[(i+1)%clip.length],input=out;out=[];
      let p=input[input.length-1],pd=NavigationMeshBuilder.cross(a,b,p);
      for(const q of input){const qd=NavigationMeshBuilder.cross(a,b,q);
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
// Terrain-only interaction visibility. Ranged attacks do not request this.
// Sectors use actual edge/vertex events, not a fixed angular sample count.
class NavigationGoalVisibility{
  static geometryCache=new WeakMap();
  static obstacleIndex(geometry){
    let index=this.geometryCache.get(geometry);if(index)return index;
    const polygons=geometry.blocks.flatMap(b=>NavigationMeshBuilder.inflate(b.points,2/FP)).map(points=>({points,minX:Math.min(...points.map(p=>p.x)),maxX:Math.max(...points.map(p=>p.x)),minY:Math.min(...points.map(p=>p.y)),maxY:Math.max(...points.map(p=>p.y))}));
    index=new NavigationObstacleIndex(polygons);this.geometryCache.set(geometry,index);return index;
  }
  static build(goal,geometry){
    if(!goal.terrainLine||!geometry.blocks.length)return null;
    const radius=goal.radius,blocks=this.obstacleIndex(geometry).query(goal.x,goal.y,goal.x,goal.y,radius);
    if(!blocks.length)return null;
    if(blocks.some(b=>MapGeometry.pointInSimplePolygon(goal.x,goal.y,b.points)))return new NavigationObstacleIndex([]);
    const edges=[],angles=[0,Math.PI*2],tau=Math.PI*2;
    const angle=p=>{let a=Math.atan2(p.y-goal.y,p.x-goal.x);if(a<0)a+=tau;angles.push(a)};
    const edge=(a,b)=>{const e=NavigationMeshBuilder.edge(a,b,edges.length);edges.push(e);angle(a);angle(b)};
    const r=radius+1,box=[{x:goal.x-r,y:goal.y-r},{x:goal.x+r,y:goal.y-r},{x:goal.x+r,y:goal.y+r},{x:goal.x-r,y:goal.y+r}];
    for(let i=0;i<4;i++)edge(box[i],box[(i+1)%4]);
    for(const b of blocks)for(let i=0;i<b.points.length;i++)edge(b.points[i],b.points[(i+1)%b.points.length]);
    const index=new NavigationObstacleIndex(edges);
    for(const a of edges)for(const b of index.query(a.minX,a.minY,a.maxX,a.maxY)){
      if(b.id<=a.id)continue;
      const ux=a.b.x-a.a.x,uy=a.b.y-a.a.y,vx=b.b.x-b.a.x,vy=b.b.y-b.a.y,den=ux*vy-uy*vx;
      if(Math.abs(den)<1e-12)continue;
      const qx=b.a.x-a.a.x,qy=b.a.y-a.a.y,t=(qx*vy-qy*vx)/den,s=(qx*uy-qy*ux)/den;
      if(t>0&&t<1&&s>0&&s<1)angle({x:a.a.x+ux*t,y:a.a.y+uy*t});
    }
    angles.sort((a,b)=>a-b);const events=angles.filter((a,i)=>!i||a-angles[i-1]>1e-10),pieces=[];
    const ray=(a,e,bounded=true)=>{
      const dx=Math.cos(a),dy=Math.sin(a),ex=e.b.x-e.a.x,ey=e.b.y-e.a.y,den=dx*ey-dy*ex;
      if(Math.abs(den)<1e-12)return null;
      const qx=e.a.x-goal.x,qy=e.a.y-goal.y,t=(qx*ey-qy*ex)/den,s=(qx*dy-qy*dx)/den;
      return t>=0&&(!bounded||s>=-1e-8&&s<=1+1e-8)?{x:goal.x+dx*t,y:goal.y+dy*t,t}:null;
    };
    for(let i=1;i<events.length;i++){
      const a=events[i-1],b=events[i],mid=(a+b)/2;let selected=null,dist=Infinity;
      for(const e of edges){const hit=ray(mid,e);if(hit&&(hit.t<dist||(hit.t===dist&&e.id<selected.id))){selected=e;dist=hit.t}}
      if(!selected)throw new Error('Navigation visibility sector has no boundary');
      const p=ray(a,selected,false),q=ray(b,selected,false);if(!p||!q)continue;
      const points=[{x:goal.x,y:goal.y},{x:p.x,y:p.y},{x:q.x,y:q.y}];
      if(NavigationMeshBuilder.cross(...points)<=1e-10)continue;
      pieces.push({points,minX:Math.min(...points.map(v=>v.x)),maxX:Math.max(...points.map(v=>v.x)),minY:Math.min(...points.map(v=>v.y)),maxY:Math.max(...points.map(v=>v.y))});
    }
    return new NavigationObstacleIndex(pieces);
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
    if(building)return source?.side===NEUTRAL_SIDE?this.unitRadius(st)+(building.size||35):(((UnitDefinition.get(st)||{}).size||10)+(building.size||30))*COLLISION_RADIUS_SCALE;
    return this.unitRadius(st)+this.unitRadius(tt);
  }
  static requiresTerrainLine(source,kind,extra=0){
    const st=typeof source==='string'?source:source?.type,d=UnitDefinition.get(st)||{};
    return kind.startsWith('worker-')||kind==='attack'&&d.layer!=='AIR'&&!d.projectile&&Number(extra)<=100&&d.requiresContactTerrain===true;
  }
  static reach(source,target,kind,extra=0){
    if(kind==='building-clearance')return this.buildingClearance(source,target);
    if(kind==='worker-build')return this.buildingClearance(source,target)+BUILDER_INTERACTION_PADDING+.5;
    if(kind==='worker-gas')return this.buildingClearance(source,target)+GAS_WORKER_INTERACTION_PADDING;
    if(kind==='worker-dropoff')return Math.max(WORKER_DROPOFF_INTERACTION_RADIUS,this.buildingClearance(source,target)+GAS_WORKER_INTERACTION_PADDING);
    if(kind==='worker-mineral')return Math.max(0,Number(target?.r)||0)+WORKER_MINERAL_INTERACTION_PADDING;
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
    }else if(kind.startsWith('worker-')&&BuildingDefinition.get(target?.type))inner=this.buildingClearance(source,target);
    const outer=this.reach(source,target,kind,extra),terrainLine=this.requiresTerrainLine(source,kind,extra);
    return inset?NavigationGoal.range(target.x,target.y,outer,inner,terrainLine):new NavigationGoal(target.x,target.y,outer,inner,terrainLine);
  }
  static goal(source,target,kind,extra=0,minRange=null){
    const goal=this.region(source,target,kind,extra,minRange,true);
    // A unit's old position stops being a reusable destination when it moves.
    // Keep the active handle, but do not retain its obsolete pursuit positions.
    goal.retainHistory=!UnitDefinition.get(target?.type);return goal;
  }
}

// Local contacts share one solver; NavMesh still owns the choice of route.
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
  policy(u){return TerrainNavigation.ignoresBuildings(u)?'*':null}
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
      // A newly placed solid may cover a stationary unit. Reuse the mesh's exact
      // nearest exterior projection, with a monotone departure sweep: never cross
      // terrain or another building while resolving that pre-existing overlap.
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
    if(sim.unitLayer(u.type)==='AIR'||u.capability(LeapableMixin.KEY)?.isActive(sim))return this.commit(u,{x:tx,y:ty,hit:null});
    return this.commit(u,this.solve(u.x,u.y,tx,ty,sim.unitRadius(u.type),this.policy(u),mode,String(u.id)));
  }
  constrain(u){
    const sim=this.navigation.sim,oldX=u.fx,oldY=u.fy;
    if(sim.unitLayer(u.type)==='AIR'||u.capability(LeapableMixin.KEY)?.isActive(sim)){this.remember(u);return false}
    this.navigation.sync();const s=this.checkpoints.get(u)||{x:u.x,y:u.y,verified:false};
    if(s.verified&&s.ignoreId===this.policy(u)&&s.signature===this.navigation.topology.version&&s.x===u.x&&s.y===u.y)return false;
    this.commit(u,this.solve(s.x,s.y,u.x,u.y,sim.unitRadius(u.type),this.policy(u),'project',String(u.id)));
    return u.fx!==oldX||u.fy!==oldY;
  }
}

// Coarse prior-tick Flow admission is authoritative; local cache warmth is not.
class AdaptiveNavigationDemand{
  // Conservative empirical query crossovers. Distance is a tunable calibration,
  // not an inferred map-complexity or CPU-budget model.
  static FAR_DISTANCE=1000;
  static FAR_REQUESTS=20;
  static TOTAL_REQUESTS=80;
  static MAX_ADMISSIONS=4096;
  static begin(sim){sim.navigationDemandScope={previous:new Set(sim.navigationAdmissions),groups:new Map()}}
  static end(sim){
    const scope=sim.navigationDemandScope;sim.navigationDemandScope=null;
    if(!scope)return;
    sim.navigationAdmissions=[...scope.groups].filter(([,g])=>this.eligible(g)).map(([key])=>key).sort().slice(0,this.MAX_ADMISSIONS);
  }
  static invalidate(sim){
    sim.navigationAdmissions=[];
    if(sim.navigationDemandScope){sim.navigationDemandScope.previous.clear();sim.navigationDemandScope.groups.clear()}
  }
  static eligible(group){return group.far.size>=this.FAR_REQUESTS||group.units.size>=this.TOTAL_REQUESTS}
  static validate(keys){
    if(!Array.isArray(keys)||keys.length>this.MAX_ADMISSIONS)throw new Error('Invalid navigation admissions');
    let previous=null;
    for(const key of keys){
      if(typeof key!=='string'||key.length>512||previous!==null&&key<=previous)throw new Error('Invalid navigation admission key');
      let parts;try{parts=JSON.parse(key)}catch{throw new Error('Invalid navigation admission key')}
      if(!Array.isArray(parts)||parts.length!==3||typeof parts[0]!=='string'||!/^\d+(?:\.\d+)?:[01]$/.test(parts[0])||!Number.isSafeInteger(parts[1])||parts[1]<0||typeof parts[2]!=='string')throw new Error('Invalid navigation admission profile');
      const goal=parts[2].split(':').map(Number);
      if(goal.length!==6||!goal.every(Number.isFinite)||goal[2]<0||goal[3]<0||goal[3]>goal[2]||![0,1].includes(goal[4])||![0,1].includes(goal[5])||goal.join(':')!==parts[2]||JSON.stringify(parts)!==key)throw new Error('Invalid navigation admission goal');
      previous=key;
    }
  }
  static select(nav,u,goal,radius,ignore){
    const scope=nav.sim.navigationDemandScope;
    // Preview/speculative calls never acquire admission or alter future movement.
    if(!scope)return 'astar';
    const layer=nav.layer(radius,ignore),start=nav.locate(u.x,u.y,layer,null,{radius:Math.max(0,radius-.12)});
    if(!start||start.d2>256*256)return 'astar';
    // Components follow canonical tile/local traversal, not reusable graph slots.
    const profile=TerrainNavigation.layerProfile(radius,ignore);
    const key=JSON.stringify([profile.r+':'+(ignore?1:0),start.cell.component,goal.key]);
    let group=scope.groups.get(key);
    if(!group){group={units:new Set(),far:new Set()};scope.groups.set(key,group)}
    group.units.add(u.id);
    if(Math.hypot(u.x-goal.x,u.y-goal.y)>=this.FAR_DISTANCE)group.far.add(u.id);
    const mode=scope.previous.has(key)||this.eligible(group)?'flow-field':group.units.size>1?'shared-astar':'astar';
    const metric=mode==='flow-field'?'adaptiveFlowQueries':mode==='shared-astar'?'adaptiveSharedQueries':'adaptiveAstarQueries';
    nav.metrics[metric]=(nav.metrics[metric]||0)+1;
    return mode;
  }
}

class TerrainNavigation{
  static MAX_LAYERS=12;
  static SHARED_ASTAR_GOALS=16;
  static SHARED_ASTAR_NODES=2048;
  static preparationQueue=[];
  static preparationScheduled=false;
  static stateCache=new WeakMap();
  static snapshotOwners=new WeakMap();
  static schedulePreparationStep(callback){
    this.preparationQueue.push(callback);
    this.dispatchPreparationStep();
  }
  static dispatchPreparationStep(){
    if(this.preparationScheduled||!this.preparationQueue.length)return;
    this.preparationScheduled=true;
    const run=()=>{
      this.preparationScheduled=false;
      const next=this.preparationQueue.shift();
      try{next?.()}finally{this.dispatchPreparationStep()}
    };
    if(document.visibilityState==='visible'&&typeof requestAnimationFrame==='function')requestAnimationFrame(run);else setTimeout(run,0);
  }
  static bindSnapshot(snapshot,sim){
    // A same-tick, same-topology read may share the live derived navigation cache.
    // A retained snapshot never reads a later simulation's obstacle layout.
    this.snapshotOwners.set(snapshot,{sim,tick:sim.tick,revision:sim.navigationRevision,epoch:sim.runtimeEpoch});
    return snapshot;
  }
  static forState(state){
    if(state.navigation instanceof TerrainNavigation)return state.navigation;
    const owner=this.snapshotOwners.get(state);
    if(owner&&owner.sim.tick===owner.tick&&owner.sim.navigationRevision===owner.revision&&owner.sim.runtimeEpoch===owner.epoch)return owner.sim.navigation;
    let nav=this.stateCache.get(state);
    if(!nav){const adapter={world:WorldContext.forState(state),buildings:state.buildings||[],tick:state.tick||0,navigationRevision:0,unitRadius:StrategySim.prototype.unitRadius};nav=new TerrainNavigation(adapter);this.stateCache.set(state,nav)}
    return nav;
  }
  constructor(sim){
    this.sim=sim;this.geometry=sim.world.terrain;this.layers=new Map();this.projections=new Map();this.staticOffsets=new Map();this.topology=new NavigationTopology();this.sceneTick=-1;this.circles=[];this.circleIndex=new NavigationObstacleIndex([]);this.motion=new SurfaceMotion(this);
    this.metrics={backend:'navmesh',fieldsBuilt:0,fieldHits:0,layersBuilt:0,routeQueries:0,directQueries:0,unreachable:0,funnelQueries:0,meshCells:0,meshPortals:0,meshBuildMs:0,meshBuildMaxMs:0,meshGeometryMs:0,meshConnectMs:0,meshTilesBuilt:0,projectionQueries:0,projectionTilesBuilt:0,projectionBuildMs:0,fieldBuildMs:0,astarQueries:0,astarExpanded:0,astarCostMs:0,astarMoveQueries:0,astarDistanceQueries:0,sharedAstarQueries:0,sharedAstarHits:0,sharedAstarCachedNodes:0,invalidations:0,endpointProjections:0,regionsBuilt:0,regionHits:0};
  }
  sync({preserveRevision=false}={}){
    if(this.sceneTick===this.sim.tick&&this.sceneRevision===this.sim.navigationRevision)return;
    const previousRevision=this.sceneRevision,requestedRevision=this.sim.navigationRevision,initial=!this.topology.version,changed=this.topology.refresh(this.sim.buildings);
    if(!changed){
      const revisionChanged=previousRevision!==undefined&&previousRevision!==this.sim.navigationRevision;
      this.sceneTick=this.sim.tick;this.sceneRevision=this.sim.navigationRevision;
      if(revisionChanged)this.sim.clearRuntimeRouteCache?.({clearHandles:!preserveRevision});
      return;
    }
    for(const layer of this.layers.values())layer.tiles.invalidate(this.topology.changes);
    for(const projection of this.projections.values())projection.invalidate(this.topology.changes);
    this.metrics.invalidations++;
    this.circles=this.topology.records;this.circleIndex=new NavigationObstacleIndex(this.circles);
    let affected=false;
    if(!initial)for(const path of this.sim.routePathStore?.values()||[])if(path.topology!==this.routeTopology(path)){affected=true;break}
    if(affected&&!preserveRevision&&this.sim.navigationRevision===requestedRevision)this.sim.navigationRevision=requestedRevision+1;
    const revisionChanged=previousRevision!==undefined&&previousRevision!==this.sim.navigationRevision;
    this.sceneTick=this.sim.tick;this.sceneRevision=this.sim.navigationRevision;
    if(affected||revisionChanged)this.sim.clearRuntimeRouteCache?.({clearHandles:!preserveRevision});
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
  static layerProfile(radius,ignoreBuildings){const r=Math.ceil((radius+.10)*100)/100;return {r,key:r+':'+ignoreBuildings}}
  layerPreparationPlan(units=[],types=[]){
    const present=new Map(),available=new Map();
    const add=(type,ignoreBuildings,destination)=>{
      const definition=UnitDefinition.get(type);if(!definition||definition.layer==='AIR')return;
      const radius=this.sim.unitRadius(type)+.12,profile=TerrainNavigation.layerProfile(radius,ignoreBuildings);
      destination.set(profile.key,{...profile,radius,ignoreBuildings});
    };
    for(const u of units)if(u&&u.alive!==false&&u.hp>0)add(u.type,TerrainNavigation.ignoresBuildings(u),present);
    for(const type of types)add(type,TerrainNavigation.ignoresBuildings({type}),available);
    const order=(a,b)=>a.r-b.r||Number(a.ignoreBuildings)-Number(b.ignoreBuildings);
    const profiles=[...present.values()].sort(order).concat([...available.values()].filter(p=>!present.has(p.key)).sort(order));
    const selected=profiles.slice(0,TerrainNavigation.MAX_LAYERS);
    return {profiles:selected,keys:new Set(selected.map(p=>p.key)),skipped:profiles.length-selected.length};
  }
  reservePreparedLayers(plan){
    const missing=plan.profiles.filter(p=>!this.layers.has(p.key)).length;
    // Reserve only the missing slots, preserving both selected cached layers
    // and unrelated layers whenever the capacity can hold them together.
    for(const key of this.layers.keys())if(this.layers.size+missing>TerrainNavigation.MAX_LAYERS&&!plan.keys.has(key))this.layers.delete(key);
  }
  recordLayerPreparation(plan,before,workMs){
    const built=this.metrics.layersBuilt-before;
    this.metrics.preparationMs=(this.metrics.preparationMs||0)+workMs;
    this.metrics.preparationWorkMs=(this.metrics.preparationWorkMs||0)+workMs;
    this.metrics.preparationLayersBuilt=(this.metrics.preparationLayersBuilt||0)+built;
    this.metrics.preparationProfiles=plan.profiles.length;this.metrics.preparationSkippedProfiles=plan.skipped;
    return {profiles:plan.profiles.map(p=>p.key),skipped:plan.skipped,elapsedMs:workMs,layersBuilt:built};
  }
  prepareLayersInSlices(units=[],types=[],{schedule,shouldContinue=()=>true,onError=()=>{}}={}){
    if(typeof schedule!=='function')throw new TypeError('A navigation preparation scheduler is required');
    const plan=this.layerPreparationPlan(units,types),before=this.metrics.layersBuilt;
    this.reservePreparedLayers(plan);
    let index=0,workMs=0,active=true;
    const cancel=()=>{active=false};
    const step=()=>{
      if(!active||!shouldContinue()){active=false;return}
      if(index>=plan.profiles.length){active=false;this.recordLayerPreparation(plan,before,workMs);return}
      const profile=plan.profiles[index++],begun=performance.now();
      try{this.layer(profile.radius,profile.ignoreBuildings);workMs+=performance.now()-begun}
      catch(error){active=false;onError(error);return}
      if(active&&index<plan.profiles.length)schedule(step);
      else if(active){active=false;this.recordLayerPreparation(plan,before,workMs)}
    };
    schedule(step);
    return cancel;
  }
  nearestExterior(x,y,radius,ignoreBuildings=false){
    this.sync();this.metrics.projectionQueries++;
    const {r,key}=TerrainNavigation.layerProfile(radius,ignoreBuildings),ready=this.layers.get(key);
    if(ready&&!ready.tiles.dirty.size)return this.locate(x,y,ready,null,{radius});
    let projection=this.projections.get(key);
    if(!projection){
      projection=new NavigationProjectionTiles(this,r,ignoreBuildings);
      if(this.projections.size>=12)this.projections.delete(this.projections.keys().next().value);
      this.projections.set(key,projection);
    }
    return this.locate(x,y,projection.layer,null,{radius});
  }
  layer(radius,ignoreBuildings=false){
    this.sync();const {r,key}=TerrainNavigation.layerProfile(radius,ignoreBuildings);
    let layer=this.layers.get(key);if(layer&&!layer.tiles.dirty.size)return layer;
    const begun=performance.now();let fixed=this.staticOffsets.get(r);
    if(!fixed){fixed=this.geometry.blocks.flatMap(b=>NavigationMeshBuilder.inflate(b.points,r));this.staticOffsets.set(r,fixed)}
    const tiles=layer?.tiles||new NavigationMeshTiles(this.geometry,r,fixed,ignoreBuildings);
    layer=tiles.rebuild(this.circles);layer.r=r;layer.ignoreId=ignoreBuildings?'*':null;
    if(!this.layers.has(key)&&this.layers.size>=TerrainNavigation.MAX_LAYERS)this.layers.delete(this.layers.keys().next().value);
    this.layers.set(key,layer);const elapsed=performance.now()-begun;
    this.metrics.meshGeometryMs+=layer.geometryMs;this.metrics.meshConnectMs+=layer.connectMs;this.metrics.meshTilesBuilt+=layer.rebuiltTiles;
    this.metrics.layersBuilt++;this.metrics.meshBuildMs+=elapsed;this.metrics.meshBuildMaxMs=Math.max(this.metrics.meshBuildMaxMs,elapsed);this.metrics.meshCells=layer.cellCount;this.metrics.meshPortals=layer.portalCount;
    return layer;
  }
  locate(x,y,layer,component=null,departure=null){
    let result=null;
    for(const c of layer.index.query(x,y))if((component==null||c.component===component)&&NavigationMeshBuilder.contains(c,x,y)){
      if(!result||NavigationGraphOrder.cell(c,result.cell)<0)result={cell:c,point:{x,y},d2:0};
    }
    if(result)return result;
    // Spatial bins only accelerate point location; they are not navigation cells.
    // Expand until the best Euclidean projection is inside the searched square.
    const limit=departure?256:Math.max(this.geometry.width,this.geometry.height)*2;
    for(let range=16;range<=limit*2;range*=2){
      const candidates=[];
      for(const c of layer.index.query(x-range,y-range,x+range,y+range)){
        if(component!=null&&c.component!==component)continue;
        const p=NavigationMeshBuilder.closest(c,x,y);
        if(p.d2<=range*range)candidates.push({cell:c,point:{x:p.x,y:p.y},d2:p.d2});
      }
      candidates.sort((a,b)=>a.d2-b.d2||NavigationGraphOrder.cell(a.cell,b.cell));
      for(const candidate of candidates){
        if(departure&&!this.departureClear(x,y,candidate.point.x,candidate.point.y,departure.radius,layer.ignoreId))continue;
        this.metrics.endpointProjections++;return candidate;
      }
    }
    return null;
  }
  static ignoresBuildings(u){return !!UnitDefinition.get(u.type)?.burrowWhileMoving||!!u.capability?.(BurrowableMixin.KEY)?.isActive()}
  acceptsGoalPoint(goal,x,y){return goal.contains(x,y)&&(!goal.terrainLine||this.geometry.segmentClear(x,y,goal.x,goal.y,0))}
  regionPoint(area,goal,x,y){
    if(area.point)return {...area.point,d2:(area.point.x-x)**2+(area.point.y-y)**2};
    return goal.closest(x,y,area.polygon);
  }
  regions(goal,layer,component=null){
    const key=goal.key+':'+component;let cached=layer.goals.get(key);
    if(cached){this.metrics.regionHits++;return cached}
    const areas=[],byCell=new Map();
    const add=(cell,polygon,point=null)=>{
      if(!point&&!goal.closest(goal.x,goal.y,polygon))return;
      const area={id:areas.length,cell,polygon,point};areas.push(area);
      let list=byCell.get(cell.id);if(!list)byCell.set(cell.id,list=[]);list.push(area);
    };
    if(goal.radius===0){
      const g=this.locate(goal.x,goal.y,layer,component);
      if(g&&(goal.project||g.d2<=NavigationGoal.EPS)){
        // Cell order must not select a side of an equally close blocked point.
        const range=Math.sqrt(g.d2)+.01,candidates=layer.index.query(goal.x,goal.y,goal.x,goal.y,range).slice().sort(NavigationGraphOrder.cell);
        for(const c of candidates){if(component!=null&&c.component!==component)continue;const p=NavigationMeshBuilder.closest(c,goal.x,goal.y);
          if(p.d2<=g.d2+NavigationGoal.EPS)add(c,c.points,{x:p.x,y:p.y});
        }
      }
    }else{
      const visibility=NavigationGoalVisibility.build(goal,this.geometry);
      const cells=layer.index.query(goal.x,goal.y,goal.x,goal.y,goal.radius).slice().sort(NavigationGraphOrder.cell);
      for(const cell of cells){
        if(component!=null&&cell.component!==component)continue;
        if(!goal.closest(goal.x,goal.y,cell.points))continue;
        if(!visibility){add(cell,cell.points);continue}
        for(const sector of visibility.query(cell.minX,cell.minY,cell.maxX,cell.maxY)){
          const polygon=NavigationGoal.clipPolygon(cell.points,sector.points);
          if(polygon.length>=3)add(cell,polygon);
        }
      }
    }
    cached={key,goal,areas,byCell};
    if(layer.goals.size>=48)layer.goals.delete(layer.goals.keys().next().value);layer.goals.set(key,cached);
    this.metrics.regionsBuilt++;return cached;
  }
  field(regions,layer){
    const key=regions.key;let f=layer.fields.get(key);if(f){this.metrics.fieldHits++;return f}
    const begun=performance.now(),n=layer.fieldNodes.length,cost=new Float64Array(n),next=new Int32Array(n),via=new Int32Array(n),terminal=new Int32Array(n),heap=new NavigationMinHeap((a,b)=>NavigationGraphOrder.node(layer.fieldNodes[a],layer.fieldNodes[b]));
    const endX=new Float64Array(n),endY=new Float64Array(n);
    cost.fill(Infinity);next.fill(-1);via.fill(-1);terminal.fill(-1);
    for(const area of regions.areas)for(const l of area.cell.links)for(const id of layer.portals[l.portal].nodes){
      const node=layer.fieldNodes[id],p=this.regionPoint(area,regions.goal,node.x,node.y);if(!p)continue;
      const d=Math.round(Math.sqrt(p.d2)*1024);
      if(d>cost[id]||d===cost[id]&&terminal[id]>=0&&area.id>=terminal[id])continue;
      cost[id]=d;via[id]=area.cell.id;terminal[id]=area.id;endX[id]=p.x;endY[id]=p.y;heap.push(id,d);
    }
    while(heap.length){const a=heap.pop(),node=layer.fieldNodes[a.id];if(a.cost!==cost[a.id])continue;
      for(const link of node.links){const alt=a.cost+link.cost;
        if(alt<cost[link.to]||alt===cost[link.to]&&next[link.to]>=0&&NavigationGraphOrder.node(node,layer.fieldNodes[next[link.to]])<0){
          cost[link.to]=alt;next[link.to]=a.id;via[link.to]=link.via;terminal[link.to]=terminal[a.id];heap.push(link.to,alt);
        }
      }
    }
    f={cost,next,via,terminal,endX,endY};
    if(layer.fields.size>=48)layer.fields.delete(layer.fields.keys().next().value);layer.fields.set(key,f);
    this.metrics.fieldsBuilt++;this.metrics.fieldBuildMs+=performance.now()-begun;return f;
  }
  static planner(type){
    const planner=UnitDefinition.get(type)?.navigationPlanner??'adaptive';
    if(planner!=='adaptive'&&planner!=='astar'&&planner!=='shared-astar'&&planner!=='flow-field')throw new Error('Unknown navigation planner: '+planner);
    return planner;
  }
  plan(x,y,goal,radius,ignoreBuildings=false,planner='flow-field'){
    if(planner==='astar')return this.astarPlan(x,y,goal,radius,ignoreBuildings);
    if(planner==='shared-astar')return this.astarPlan(x,y,goal,radius,ignoreBuildings,true);
    if(planner==='flow-field')return this.fieldPlan(x,y,goal,radius,ignoreBuildings);
    throw new Error('Unknown navigation planner: '+planner);
  }
  goalPotential(layer,regions,shared=false){
    const ready=layer.fields.get(regions.key);
    if(ready)this.metrics.fieldHits++;
    // Goal lifetime survives local graph replacement, but graph costs never do.
    // Radius/interaction layer belong to the containing navigation layer.
    const lifetimes=layer.goalLifetimes??=new Map();
    let lifetime=lifetimes.get(regions.goal.key);
    if(!lifetime&&(shared||ready)){
      if(lifetimes.size>=48)lifetimes.delete(lifetimes.keys().next().value);
      lifetime={firstTick:this.sim.tick};lifetimes.set(regions.goal.key,lifetime);
    }
    return ready||(lifetime&&this.sim.tick>lifetime.firstTick?this.field(regions,layer):null);
  }
  astarPlan(x,y,goal,radius,ignoreBuildings=false,shared=false){
    const begun=performance.now();this.metrics.astarQueries++;
    if(shared)this.metrics.sharedAstarQueries=(this.metrics.sharedAstarQueries||0)+1;
    try{
      const layer=this.layer(radius,ignoreBuildings),s=this.locate(x,y,layer,null,{radius:Math.max(0,radius-.12)});
      if(!s||s.d2>256*256)return null;
      const regions=this.regions(goal,layer,s.cell.component);if(!regions.areas.length)return null;
      let best=Infinity,endpoint=null,area=null;
      for(const a of regions.byCell.get(s.cell.id)||[]){const p=this.regionPoint(a,goal,s.point.x,s.point.y),cost=p?Math.sqrt(p.d2)*1024:Infinity;
        if(cost<best){best=cost;endpoint=p;area=a}
      }
      if(best===0||!layer.nodeCount)return Number.isFinite(best)?this.finishPlan(layer,s,goal,x,y,endpoint,area,[],best):null;
      let bestWhole=Math.floor(best),bestFraction=Number.isFinite(best)?best-bestWhole:0;
      const directWhole=bestWhole,directFraction=bestFraction,candidates=new Map();let cache=null;
      const competitive=(whole,fraction)=>whole<bestWhole||whole===bestWhole&&fraction<=bestFraction;
      const setBest=(whole,fraction)=>{bestWhole=whole;bestFraction=fraction;best=whole+fraction};
      if(shared){
        layer.sharedPaths??=new Map();cache=layer.sharedPaths.get(regions.key);
        if(!cache){cache=new Map();if(layer.sharedPaths.size>=TerrainNavigation.SHARED_ASTAR_GOALS)layer.sharedPaths.delete(layer.sharedPaths.keys().next().value);layer.sharedPaths.set(regions.key,cache)}
      }
      // Repeated goals reuse the same integer suffix metric as terminal/edge costs.
      // Keep A*'s complete-path tie selection; the field supplies only its lower bound.
      const distanceField=this.goalPotential(layer,regions,shared);
      let reach=goal.radius;
      if(goal.radius===0)for(const a of regions.areas)reach=Math.max(reach,Math.hypot(a.point.x-goal.x,a.point.y-goal.y));
      const scratch=(layer.astarScratch||(layer.astarScratch=new NavigationAStarScratch(layer))).begin(layer.fieldNodes.length),epoch=scratch.epoch,heap=scratch.heap;
      const offer=(id,whole,fraction,previous,via)=>{
        const fresh=scratch.stamp[id]!==epoch,oldWhole=fresh?Infinity:scratch.whole[id],oldFraction=fresh?0:scratch.fraction[id];
        if(whole>oldWhole||whole===oldWhole&&fraction>oldFraction)return;
        if(whole===oldWhole&&fraction===oldFraction){const prev=scratch.previous[id];
          if(previous<0||prev<0||NavigationGraphOrder.node(layer.fieldNodes[previous],layer.fieldNodes[prev])>=0)return;
          scratch.previous[id]=previous;scratch.via[id]=via;return;
        }
        if(fresh){scratch.stamp[id]=epoch;scratch.estimate[id]=distanceField?distanceField.cost[id]:NavigationAStarScratch.heuristic(layer.fieldNodes[id],goal,reach)}
        const cost=whole+fraction;scratch.whole[id]=whole;scratch.fraction[id]=fraction;
        scratch.cost[id]=cost;scratch.previous[id]=previous;scratch.via[id]=via;scratch.closed[id]=0;
        const priority=cost+scratch.estimate[id];if(priority<=best)heap.push(id,priority);
      };
      // Keep the initial Euclidean fraction separate from integral graph costs.
      // Adding a cached suffix once must equal adding its edges individually.
      for(const link of s.cell.links)for(const id of layer.portals[link.portal].nodes){const node=layer.fieldNodes[id],cost=Math.hypot(node.x-s.point.x,node.y-s.point.y)*1024,whole=Math.floor(cost);offer(id,whole,cost-whole,-1,s.cell.id)}
      while(heap.length){const current=heap.pop(),id=current.id,node=layer.fieldNodes[id];
        if(current.cost>best)break;
        if(scratch.closed[id]===epoch||current.cost!==scratch.cost[id]+scratch.estimate[id])continue;
        scratch.closed[id]=epoch;this.metrics.astarExpanded++;
        const memo=cache?.get(id);
        if(memo){
          this.metrics.sharedAstarHits=(this.metrics.sharedAstarHits||0)+1;
          const whole=scratch.whole[id]+memo.remaining,fraction=scratch.fraction[id];
          if(competitive(whole,fraction)){setBest(whole,fraction);candidates.set(id,{head:id,remaining:memo.remaining,area:memo.area,point:memo.point,cached:true})}
          continue;
        }
        const portal=layer.portals[node.portal];
        for(const cellId of [portal.a,portal.b])for(const candidate of regions.byCell.get(cellId)||[]){
          const p=this.regionPoint(candidate,goal,node.x,node.y);if(!p)continue;
          const remaining=Math.round(Math.sqrt(p.d2)*1024),whole=scratch.whole[id]+remaining,fraction=scratch.fraction[id],previous=candidates.get(id);
          if(competitive(whole,fraction)){
            if(!previous||remaining<previous.remaining||remaining===previous.remaining&&candidate.id<previous.area.id)candidates.set(id,{head:id,remaining,area:candidate,point:p,cached:false});
            const chosen=candidates.get(id);setBest(scratch.whole[id]+chosen.remaining,fraction);
          }
        }
        for(const edge of node.links)offer(edge.to,scratch.whole[id]+edge.cost,scratch.fraction[id],id,edge.via);
      }
      if(!Number.isFinite(best))return null;
      const portals=[];let selected=null;
      if(bestWhole<directWhole||bestWhole===directWhole&&bestFraction<directFraction){
        // Compare complete paths only after all competitive frontiers finish:
        // equal-cost predecessor improvements may occur after a cache hit.
        for(const candidate of candidates.values())if(scratch.whole[candidate.head]+candidate.remaining===bestWhole&&scratch.fraction[candidate.head]===bestFraction){
          const trace=this.astarTrace(layer,scratch,candidate,cache);
          if(!selected||this.compareAstarTraces(layer,trace,selected)<0)selected=trace;
        }
        if(!selected)throw new Error('Missing optimal A* terminal');
        endpoint=selected.point;area=selected.area;let current=s.cell.id;
        for(let i=0;i<selected.nodes.length;i++){
          const p=layer.portals[layer.fieldNodes[selected.nodes[i]].portal],to=selected.via[i];
          if(to!==current){portals.push(this.orientPortal(layer,p,current,to));current=to}
        }
        if(cache){let remaining=0;
          // Cache from the terminal backwards, so every stored next pointer is
          // a complete valid suffix, even when the per-goal bound is reached.
          for(let i=selected.nodes.length-1;i>=0;i--){remaining+=selected.costs[i];const id=selected.nodes[i];
            if(cache.has(id))continue;if(cache.size>=TerrainNavigation.SHARED_ASTAR_NODES)break;
            cache.set(id,{remaining,next:i+1<selected.nodes.length?selected.nodes[i+1]:-1,via:selected.via[i],area,point:{x:endpoint.x,y:endpoint.y}});
          }
        }
      }
      if(shared)this.metrics.sharedAstarCachedNodes=[...this.layers.values()].reduce((sum,l)=>sum+[...(l.sharedPaths?.values()||[])].reduce((n,c)=>n+c.size,0),0);
      return this.finishPlan(layer,s,goal,x,y,endpoint,area,portals,best);
    }finally{this.metrics.astarCostMs+=performance.now()-begun}
  }
  astarTrace(layer,scratch,candidate,cache){
    const nodes=[],via=[],costs=[];let id=candidate.head;
    while(id>=0){if(nodes.length>layer.nodeCount)throw new Error('NavMesh A* predecessor cycle');nodes.push(id);id=scratch.previous[id]}
    nodes.reverse();
    for(let i=0;i+1<nodes.length;i++){
      const cell=scratch.via[nodes[i+1]],edge=layer.fieldNodes[nodes[i]].links.find(e=>e.to===nodes[i+1]&&e.via===cell);
      if(!edge)throw new Error('Missing A* corridor edge');via.push(cell);costs.push(edge.cost);
    }
    if(candidate.cached){id=candidate.head;
      while(true){const entry=cache.get(id);if(!entry)throw new Error('Incomplete shared A* suffix');via.push(entry.via);
        if(entry.next<0){costs.push(entry.remaining);break}
        const next=cache.get(entry.next);if(!next||nodes.length>layer.nodeCount)throw new Error('Invalid shared A* suffix');
        costs.push(entry.remaining-next.remaining);nodes.push(entry.next);id=entry.next;
      }
    }else{via.push(candidate.area.cell.id);costs.push(candidate.remaining)}
    return {nodes,via,costs,area:candidate.area,point:candidate.point};
  }
  compareAstarTraces(layer,a,b){
    let order=NavigationGraphOrder.node(layer.fieldNodes[a.nodes.at(-1)],layer.fieldNodes[b.nodes.at(-1)])||a.area.id-b.area.id;
    for(let ai=a.nodes.length-2,bi=b.nodes.length-2;!order&&ai>=0&&bi>=0;ai--,bi--)order=NavigationGraphOrder.node(layer.fieldNodes[a.nodes[ai]],layer.fieldNodes[b.nodes[bi]]);
    return order||a.nodes.length-b.nodes.length;
  }
  orientPortal(layer,p,current,to){
    if((p.a!==current&&p.b!==current)||(p.a!==to&&p.b!==to))throw new Error('Invalid NavMesh goal portal');
    const dx=layer.cells[to].x-layer.cells[current].x,dy=layer.cells[to].y-layer.cells[current].y;
    const left=dx*(p.p.y-p.q.y)-dy*(p.p.x-p.q.x)>0?p.p:p.q;
    return {left,right:left===p.p?p.q:p.p};
  }
  fieldPlan(x,y,goal,radius,ignoreBuildings=false){
    const layer=this.layer(radius,ignoreBuildings),s=this.locate(x,y,layer,null,{radius:Math.max(0,radius-.12)});
    if(!s||s.d2>256*256)return null;
    const regions=this.regions(goal,layer,s.cell.component);if(!regions.areas.length)return null;
    let endpoint=null,area=null,best=Infinity,first=-1;
    for(const a of regions.byCell.get(s.cell.id)||[]){const p=this.regionPoint(a,goal,s.point.x,s.point.y);if(p&&p.d2<best){best=p.d2;endpoint=p;area=a}}
    best=Math.sqrt(best)*1024;
    const f=this.field(regions,layer);
    for(const link of s.cell.links)for(const id of layer.portals[link.portal].nodes){const p=layer.fieldNodes[id];
      if(f.via[id]===s.cell.id||!Number.isFinite(f.cost[id]))continue;
      const total=Math.hypot(s.point.x-p.x,s.point.y-p.y)*1024+f.cost[id];
      if(total<best){best=total;first=id;endpoint=null}
    }
    if(!Number.isFinite(best))return null;
    const portals=[];
    if(first>=0){let current=s.cell.id,id=first;
      for(let count=0;;count++){
        if(count>layer.fieldNodes.length||id<0)throw new Error('NavMesh goal field did not converge');
        const p=layer.portals[layer.fieldNodes[id].portal],to=f.via[id];
        if(to!==current){
          portals.push(this.orientPortal(layer,p,current,to));current=to;
        }
        if(f.next[id]<0){endpoint={x:f.endX[id],y:f.endY[id]};area=regions.areas[f.terminal[id]];break}
        id=f.next[id];
      }
    }
    return this.finishPlan(layer,s,goal,x,y,endpoint,area,portals,best);
  }
  finishPlan(layer,s,goal,x,y,endpoint,area,portals,graphCost){
    endpoint={x:endpoint.x,y:endpoint.y};
    this.metrics.funnelQueries++;
    let path=NavigationFunnel.path(s.point,endpoint,portals);
    // Refine the continuous terminal set from the actual final funnel corner.
    if(!area.point&&path.length>1){const p=path[path.length-2],end=this.regionPoint(area,goal,p.x,p.y);
      if(end){endpoint=end;path=NavigationFunnel.path(s.point,endpoint,portals)}
    }
    // Stop at the first legal entry, not deeper inside the goal region.
    if(goal.radius>0)outer:for(let i=1;i<path.length;i++){
      const a=path[i-1],b=path[i];
      for(const [t]of goal.segmentIntervals(a,b)){
        const px=a.x+(b.x-a.x)*t,py=a.y+(b.y-a.y)*t;
        if(this.acceptsGoalPoint(goal,px,py)){endpoint={x:px,y:py};path=path.slice(0,i);path.push(endpoint);break outer}
      }
    }
    if(s.d2>1e-8)path.unshift({x,y});
    let length=0;for(let i=1;i<path.length;i++)length+=Math.hypot(path[i].x-path[i-1].x,path[i].y-path[i-1].y);
    return{layer,path,start:s,goal:{cell:area.cell,point:endpoint},length,graphCost};
  }
  directGoal(x,y,goal,radius,ignoreBuildings=false){
    const p=goal.closest(x,y);if(!p||!this.acceptsGoalPoint(goal,p.x,p.y))return null;
    return this.segmentClear(x,y,p.x,p.y,radius,ignoreBuildings?'*':null,true,0)?p:null;
  }
  movementPlan(u,goal){
    let planner=TerrainNavigation.planner(u.type);
    if(UnitDefinition.get(u.type)?.layer==='AIR')return {point:goal.closest(u.x,u.y),goal,fromX:u.x,fromY:u.y,type:u.type,revision:this.sim.navigationRevision};
    this.sync();const ignore=TerrainNavigation.ignoresBuildings(u),r=this.sim.unitRadius(u.type);this.metrics.routeQueries++;
    const direct=this.directGoal(u.x,u.y,goal,r,ignore);
    if(direct){this.metrics.directQueries++;return {point:direct,goal,fromX:u.x,fromY:u.y,type:u.type,revision:this.sim.navigationRevision,planner:'direct'}}
    if(planner==='adaptive')planner=AdaptiveNavigationDemand.select(this,u,goal,r+.12,ignore);
    if(planner!=='flow-field')this.metrics.astarMoveQueries++;
    const plan=this.plan(u.x,u.y,goal,r+.12,ignore,planner);
    if(!plan){this.metrics.unreachable++;return null}
    return {route:plan,radius:r,ignoreBuildings:ignore,goal,fromX:u.x,fromY:u.y,type:u.type,revision:this.sim.navigationRevision,planner};
  }
  nextPlanPoint(u,record){
    if(!record)return null;
    if(u.x!==record.fromX||u.y!==record.fromY||u.type!==record.type||this.sim.navigationRevision!==record.revision)return this.nextPoint(u,record.goal);
    if(record.point!==undefined)return record.point;
    const plan=record.route,r=record.radius,ignore=record.ignoreBuildings;
    // Recheck the farthest physically visible corner, without changing the goal.
    for(let i=plan.path.length-1;i>1;i--)if(this.segmentClear(u.x,u.y,plan.path[i].x,plan.path[i].y,r,ignore?'*':null,true,0))return plan.path[i];
    for(let i=1;i<plan.path.length;i++)if(Math.hypot(plan.path[i].x-u.x,plan.path[i].y-u.y)>.001)return plan.path[i];
    return {x:u.x,y:u.y};
  }
  nextPoint(u,goal){
    if(!u.movement||UnitDefinition.get(u.type)?.layer==='AIR')return this.nextPlanPoint(u,this.movementPlan(u,goal));
    this.sync();
    const state=u.movement,radius=this.sim.unitRadius(u.type),ignore=TerrainNavigation.ignoresBuildings(u);
    const key=goal.key,active=state.routes[state.routeIndex],activePath=active&&this.sim.routePathStore.get(active.pathId);
    let reason=!active||!activePath?'first':activePath.key!==key||activePath.radius!==radius||activePath.ignore!==ignore?'target':activePath.topology!==this.routeTopology(activePath)?'topology':null;
    if(!reason){
      const point=this.followRoute(u,active,goal);
      if(point||!activePath.length&&Math.hypot(u.x-active.legX,u.y-active.legY)<=Math.max(2*radius,.5)){active.retained=goal.retainHistory!==false;return point}
      reason='deviation';
    }
    this.metrics['routeInvalid_'+reason]=(this.metrics['routeInvalid_'+reason]||0)+1;
    const route=this.acquireRoute(u,goal,key,radius,ignore);
    return route?.transient?this.nextPlanPoint(u,route.transient):route?this.followRoute(u,route,goal):null;
  }
  routeTopology(route,{force=false}={}){
    const checks=this.routeChecks??=new WeakMap(),checked=checks.get(route);
    if(!force&&checked?.records===this.circles)return checked.key;
    // Include the accepted 2r deviation corridor plus the physical disc.
    const found=new Map(),padding=3*route.radius+.55,length=route.length??(Number.isFinite(route.points?.[0])?route.points.length/2:route.points.length);
    if(!length)for(const c of this.circles)if(!route.ignore||c.terrainBarrier)found.set(c.id,c);
    for(let i=1;i<length;i++){
      const a=this.routePoint(route,i-1),b=this.routePoint(route,i);
      for(const c of this.circleIndex.query(a.x,a.y,b.x,b.y,padding+100)){
        if(route.ignore&&!c.terrainBarrier)continue;
        if(MapGeometry.pointSegDist(c.x,c.y,a.x,a.y,b.x,b.y)<=c.r+padding)found.set(c.id,c);
      }
    }
    const key=JSON.stringify([...found.values()].sort((a,b)=>String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0).map(c=>[c.id,c.type,c.x,c.y,c.r,c.terrainBarrier]));
    checks.set(route,{records:this.circles,key});return key;
  }
  followRoute(u,route,goal){
    const path=this.sim.routePathStore.get(route.pathId);if(!path)return null;
    const length=path.length,r=path.radius;
    if(!length)return null;
    let end=this.routePoint(path,route.cursor);if(!end)return null;
    // Only the active leg is checked. SurfaceMotion still owns physical sweeps.
    if(MapGeometry.pointSegDist(u.x,u.y,route.legX,route.legY,end.x,end.y)>Math.max(2*r,.5))return null;
    if(route.cursor<length-1){
      const distance=Math.hypot(end.x-u.x,end.y-u.y),next=this.routePoint(path,route.cursor+1);
      // A displaced unit can advance locally without occupying the exact
      // corner. Only one adjacent connection is considered, never the suffix.
      if(distance<=.02||distance<=2*r&&this.segmentClear(u.x,u.y,next.x,next.y,r,route.ignore?'*':null,true,0)){
        route.legX=u.x;route.legY=u.y;end=this.routePoint(path,++route.cursor);
      }
    }
    this.metrics.routeFollowSteps=(this.metrics.routeFollowSteps||0)+1;
    if(goal?.contains(u.x,u.y)&&this.acceptsGoalPoint(goal,u.x,u.y))return{x:u.x,y:u.y};
    // An interaction is a continuous terminal region. Nearby units must not
    // queue for one shared boundary point after physical separation displaces
    // them. This is a local terminal sweep, never a route/cache query or scan.
    if(goal?.radius>0&&route.cursor===length-1&&Math.hypot(end.x-u.x,end.y-u.y)<=2*r){
      const inside=goal.interior(u.x,u.y);
      if(this.acceptsGoalPoint(goal,inside.x,inside.y)&&this.segmentClear(u.x,u.y,inside.x,inside.y,r,route.ignore?'*':null,true,0))return inside;
      const terminal=this.directGoal(u.x,u.y,goal,r,route.ignore);if(terminal)return terminal;
    }
    return end;
  }
  materializePlanRoute(recipe){
    if(!recipe)return null;
    const signature=this.sim.routePathSignature(recipe),existing=this.sim.routePathIndex.get(signature);if(existing!==undefined&&this.sim.routePathStore.has(existing))return existing;
    const goal=NavigationGoal.fromKey(recipe.key);let points=[];
    if(recipe.kind==='plan'){
      if(recipe.planner==='direct'){
        const direct=this.directGoal(recipe.fromX,recipe.fromY,goal,recipe.radius,recipe.ignore);
        if(!direct)throw new Error('Cached direct route recipe is no longer reachable');
        points=[{x:recipe.fromX,y:recipe.fromY},direct];
      }else{
        const plan=this.plan(recipe.fromX,recipe.fromY,goal,recipe.radius+.12,recipe.ignore,recipe.planner);
        if(!plan)throw new Error('Cached route recipe is no longer reachable');
        points=plan.path;
      }
    }else if(recipe.kind!=='unreachable')throw new Error('Invalid cached route recipe kind');
    const draft={key:recipe.key,radius:recipe.radius,ignore:recipe.ignore,points,tailId:null,tailStart:0,length:points.length};
    const topology=this.routeTopology(draft),pathId=this.sim.internRoutePath({...draft,topology,recipe,rootPathId:null});
    this.routeChecks.set(this.sim.routePathStore.get(pathId),{records:this.circles,key:topology});return pathId;
  }
  materializeRouteRecipe(recipe){
    if(!recipe)return null;
    if(recipe.kind==='plan'||recipe.kind==='unreachable')return this.materializePlanRoute(recipe);
    if(recipe.kind!=='join')throw new Error('Invalid movement route recipe');
    const rootRecipe={kind:recipe.root.kind,key:recipe.key,radius:recipe.radius,ignore:recipe.ignore,fromX:recipe.root.fromX,fromY:recipe.root.fromY,planner:recipe.root.planner};
    const rootId=this.materializePlanRoute(rootRecipe),root=this.sim.routePathStore.get(rootId),joined=this.joinRoute({x:recipe.fromX,y:recipe.fromY},{pathId:rootId},NavigationGoal.fromKey(recipe.key));
    if(!root||!joined||joined.routeRecipe?.kind!=='join'||this.sim.routePathSignature(joined.routeRecipe)!==this.sim.routePathSignature(recipe))throw new Error('Cached joined route recipe no longer matches');
    return joined.pathId;
  }
  joinRoute(u,route,goal){
    const source=this.sim.routePathStore.get(route.pathId);if(!source||source.recipe?.kind!=='plan'||source.tailId!==null||source.topology!==this.routeTopology(source)||source.length<2)return null;
    const direct=goal&&this.directGoal(u.x,u.y,goal,source.radius,source.ignore);
    if(direct){const recipe={kind:'plan',key:source.key,radius:source.radius,ignore:source.ignore,fromX:u.x,fromY:u.y,planner:'direct'};return this.makeRouteHandle(source.key,source.radius,source.ignore,[{x:u.x,y:u.y},{x:direct.x,y:direct.y}],null,0,u.x,u.y,recipe)}
    const candidates=[];
    for(let i=1;i<source.length;i++){
      const a=this.routePoint(source,i-1),b=this.routePoint(source,i),dx=b.x-a.x,dy=b.y-a.y,length=dx*dx+dy*dy;
      const t=length?RangeUtil.clamp(((u.x-a.x)*dx+(u.y-a.y)*dy)/length,0,1):1;
      const p={x:a.x+dx*t,y:a.y+dy*t};
      candidates.push({i,p,d:Math.hypot(p.x-u.x,p.y-u.y)});
    }
    candidates.sort((a,b)=>a.d-b.d||b.i-a.i);
    for(const {i,p}of candidates){
      if(!this.segmentClear(u.x,u.y,p.x,p.y,source.radius,source.ignore?'*':null,true,0))continue;
      const prefix=[{x:u.x,y:u.y}];
      let first=i;
      // Joining is a connection, not another mandatory crowd rendezvous.
      // Remove visible prefix poses once, during acquisition only.
      for(let j=source.length-1;j>=i;j--){const point=this.routePoint(source,j);if(this.segmentClear(u.x,u.y,point.x,point.y,source.radius,source.ignore?'*':null,true,0)){first=j;break}}
      const firstPoint=this.routePoint(source,first);
      if(first===i&&!this.segmentClear(u.x,u.y,firstPoint.x,firstPoint.y,source.radius,source.ignore?'*':null,true,0)&&Math.hypot(p.x-u.x,p.y-u.y)>.02)prefix.push(p);
      let tailId,tailStart;
      if(source.tailId===null){tailId=source.id;tailStart=first}
      else if(first<source.points.length/2){
        for(let j=first;j<source.points.length/2;j++){const point=this.routePoint(source,j);if(Math.hypot(prefix.at(-1).x-point.x,prefix.at(-1).y-point.y)>.02)prefix.push(point)}
        tailId=source.tailId;tailStart=source.tailStart;
      }else{tailId=source.tailId;tailStart=source.tailStart+first-source.points.length/2}
      const root=this.sim.routePathStore.get(tailId);
      while(tailStart<root.length&&Math.hypot(prefix.at(-1).x-this.routePoint(root,tailStart).x,prefix.at(-1).y-this.routePoint(root,tailStart).y)<=.02)tailStart++;
      if(tailStart>=root.length){
        if(prefix.length===1)prefix.push({...prefix[0]});
        if(prefix.length>RallyStateCodec.MAX_ARRAY)continue;
        const recipe={kind:'join',key:source.key,radius:source.radius,ignore:source.ignore,fromX:u.x,fromY:u.y,root:{kind:source.recipe.kind,fromX:source.recipe.fromX,fromY:source.recipe.fromY,planner:source.recipe.planner}};
        return this.makeRouteHandle(source.key,source.radius,source.ignore,prefix,null,0,u.x,u.y,recipe,source.id);
      }
      if(prefix.length+root.length-tailStart>RallyStateCodec.MAX_ARRAY)continue;
      const recipe={kind:'join',key:source.key,radius:source.radius,ignore:source.ignore,fromX:u.x,fromY:u.y,root:{kind:source.recipe.kind,fromX:source.recipe.fromX,fromY:source.recipe.fromY,planner:source.recipe.planner}};
      return this.makeRouteHandle(source.key,source.radius,source.ignore,prefix,root.id,tailStart,u.x,u.y,recipe,source.id);
    }
    return null;
  }
  routePoint(path,index){
    if(!path||!Number.isSafeInteger(index)||index<0||index>=(path.length??(Number.isFinite(path.points?.[0])?path.points.length/2:path.points.length)))return null;
    const flat=Number.isFinite(path.points?.[0])||Number.isSafeInteger(path.topologyId),localLength=flat?path.points.length/2:path.points.length;
    if(index<localLength)return flat?{x:path.points[index*2],y:path.points[index*2+1]}:path.points[index];
    const root=this.sim.routePathStore.get(path.tailId);return root?this.routePoint(root,path.tailStart+index-localLength):null;
  }
  makeRouteHandle(key,radius,ignore,points,tailId,tailStart,x,y,recipe,rootPathId=null){
    const root=tailId===null?null:this.sim.routePathStore.get(tailId);
    const draft={key,radius,ignore,points,tailId,tailStart,length:points.length+(root?root.length-tailStart:0)};
    if(!recipe)throw new Error('Movement route recipe is required');
    const topology=this.routeTopology(draft),pathId=this.sim.internRoutePath({key,radius,ignore,points,tailId,tailStart,topology,recipe,rootPathId});
    this.routeChecks.set(this.sim.routePathStore.get(pathId),{records:this.circles,key:topology});
    const handle={recipe:MovementComponent.encodeRouteRecipe(recipe),cursor:1,legX:x,legY:y,retained:false};
    Object.defineProperty(handle,'routeRecipe',{value:StateValue.copy(recipe),writable:true,enumerable:false,configurable:true});
    Object.defineProperty(handle,'pathId',{value:pathId,writable:true,enumerable:false,configurable:true});return handle;
  }
  static routeKey(key,radius,ignore){return radius+(ignore?':1|':':0|')+key}
  acquireRoute(u,goal,key,radius,ignore){
    this.metrics.routeCacheLookups=(this.metrics.routeCacheLookups||0)+1;
    const state=u.movement,profile=TerrainNavigation.routeKey(key,radius,ignore),matches=saved=>{const path=this.sim.routePathStore.get(saved.pathId),recipe=saved?.recipe;return !!path&&recipe?.key===key&&recipe.radius===radius&&recipe.ignore===ignore};let route=null;
    // The index only accelerates acquisition. Its order is reconstructed from
    // authoritative IDs, independent of cache warmth or insertion history.
    if(this.routeTemplates?.tick!==this.sim.tick||this.routeTemplates.epoch!==this.sim.runtimeEpoch||this.routeTemplates.units!==this.sim.units||this.routeTemplates.revision!==this.sim.navigationRevision){
      const byKey=new Map();
      for(const v of this.sim.units)for(const saved of v.movement?.routes||[]){
        const path=this.sim.routePathStore.get(saved.pathId);if(!path)continue;
        const root=this.sim.routePathStore.get(path.rootPathId??path.id);if(!root||root.recipe?.kind!=='plan')continue;
        const profile=TerrainNavigation.routeKey(path.key,path.radius,path.ignore);let list=byKey.get(profile);if(!list)byKey.set(profile,list=[]);list.push({unit:v,route:saved,rootRoute:{pathId:root.id}});
      }
      this.routeTemplates={tick:this.sim.tick,epoch:this.sim.runtimeEpoch,units:this.sim.units,revision:this.sim.navigationRevision,byKey};
    }
    const own=state.routes.find(matches);
    if(own){const ownPath=this.sim.routePathStore.get(own.pathId),root=this.sim.routePathStore.get(ownPath.rootPathId??ownPath.id);if(root)route=this.joinRoute(u,{pathId:root.id},goal)}
    const candidates=this.routeTemplates.byKey.get(profile)||[];
    candidates.sort((a,b)=>String(a.unit.id)<String(b.unit.id)?-1:String(a.unit.id)>String(b.unit.id)?1:0);
    if(!route)for(const candidate of candidates){
      const v=candidate.unit,saved=candidate.route;
      if(v===u||!v.alive||v.side!==u.side||!v.movement.routes.includes(saved))continue;
      route=this.joinRoute(u,candidate.rootRoute,goal);if(route)break;
    }
    if(route)this.metrics.routeJoins=(this.metrics.routeJoins||0)+1;
    if(!route){
      const record=this.movementPlan(u,goal);
      const points=!record?[]:record.route?record.route.path:[{x:u.x,y:u.y},{x:record.point.x,y:record.point.y}];
      // Only paths outside the shared checkpoint data budget are transient.
      if(points.length>RallyStateCodec.MAX_ARRAY){state.routeIndex=-1;return {transient:record}}
      const recipe={kind:record?'plan':'unreachable',key,radius,ignore,fromX:u.x,fromY:u.y,...(record?{planner:record.planner}:{})};
      route=this.makeRouteHandle(key,radius,ignore,points,null,0,u.x,u.y,recipe);if(points.length<2)route.cursor=0;
      this.metrics.routeBuilds=(this.metrics.routeBuilds||0)+1;
    }
    // Uncontinued goals and obsolete positions of moving unit targets do not
    // enter history. Their current active routes remain available to join.
    state.routes=state.routes.filter(saved=>{
      const recipe=saved.routeRecipe??MovementComponent.decodeRouteRecipe(saved.recipe),sameProfile=recipe.key===key&&recipe.radius===radius&&recipe.ignore===ignore;
      return !sameProfile&&saved.retained;
    });
    const index=state.routes.findIndex(matches);
    if(index>=0){state.routes[index]=route;state.routeIndex=index}
    else{if(state.routes.length>=3)state.routes.shift();state.routes.push(route);state.routeIndex=state.routes.length-1}
    let list=this.routeTemplates.byKey.get(profile);if(!list)this.routeTemplates.byKey.set(profile,list=[]);
    const indexedPath=this.sim.routePathStore.get(route.pathId),indexedRoot=indexedPath&&this.sim.routePathStore.get(indexedPath.rootPathId??indexedPath.id);
    if(indexedRoot?.recipe?.kind==='plan'){
      const previous=list.find(entry=>entry.unit===u),entry={unit:u,route,rootRoute:{pathId:indexedRoot.id}};
      if(previous)Object.assign(previous,entry);else list.push(entry);
    }
    return route;
  }
  connected(x,y,tx,ty,type='worker',ignoreBuildings=false){
    return Number.isFinite(this.distance(x,y,NavigationGoal.point(tx,ty,false),type,ignoreBuildings));
  }
  resolveGroundGoal(u,tx,ty,ignoreBuildings=false){
    this.sync();const r=this.sim.unitRadius(u.type)+1,ignoreId=ignoreBuildings?'*':null;
    const p=this.geometry.nearestOpen(tx,ty,r,256,(x,y)=>this.pointClear(x,y,r,ignoreId));return p&&this.connected(u.x,u.y,p.x,p.y,u.type,ignoreBuildings)?p:null;
  }
  distance(x,y,goal,type='worker',ignoreBuildings=false){
    const configured=TerrainNavigation.planner(type),planner=configured==='adaptive'?'astar':configured;
    this.sync();const r=this.sim.unitRadius(type),direct=this.directGoal(x,y,goal,r,ignoreBuildings);
    if(direct)return Math.sqrt(direct.d2);
    if(planner!=='flow-field')this.metrics.astarDistanceQueries++;
    const plan=this.plan(x,y,goal,r+.12,ignoreBuildings,planner);return plan?plan.length:Infinity;
  }

}

export { AdaptiveNavigationDemand, InteractionGeometry, NavigationGoal, NavigationGraphOrder, NavigationMeshBuilder, SurfaceContactGeometry, SurfaceMotion, SweptCircleContact, TerrainNavigation };
