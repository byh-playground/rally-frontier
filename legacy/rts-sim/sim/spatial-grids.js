// Deterministic collision and target spatial grids.
import { RangeUtil } from '../core/game-rules.js';
import { COLLISION_SPATIAL_CELL, SIM_SPATIAL_CELL } from '../definitions/world-rules.js';
import { FP } from '../core/config.js';

/* Runtime-only deterministic fixed-cell collision broadphase.
 * Dense numeric bucket arrays avoid Map lookup, candidate sorting and quadtree
 * traversal in the one-pass allied soft-separation hot path. Buckets store unit-array
 * indexes; exact overlap and correction math stays in fixed-point coordinates. */
class DeterministicCollisionGrid{
  constructor(cellSize=COLLISION_SPATIAL_CELL,world){
    this.cellSize=cellSize;
    this.cellSizeFP=cellSize*FP;
    this.cols=Math.ceil(world.width/cellSize);
    this.rows=Math.ceil(world.height/cellSize);
    this.buckets=Array.from({length:this.cols*this.rows},()=>[]);
    this.used=[];
    this.maxIndexedRadiusFP=0;
  }
  // World coordinates are zero-origin; positions outside the world clamp to its edge cells.
  cellXFP(fx){return RangeUtil.clamp(Math.floor(fx/this.cellSizeFP),0,this.cols-1)}
  cellYFP(fy){return RangeUtil.clamp(Math.floor(fy/this.cellSizeFP),0,this.rows-1)}
  // Rebuild after indexed centers move; `maxIndexedRadiusFP` bounds every target.
  reset(units,maxIndexedRadiusFP=0){
    // Clear only cells touched by the previous build, retaining each array bucket.
    for(const key of this.used)this.buckets[key].length=0;
    this.used.length=0;
    this.maxIndexedRadiusFP=Math.max(0,Math.trunc(Number(maxIndexedRadiusFP)||0));
    for(let i=0;i<units.length;i++){
      const u=units[i];if(!u.alive)continue;
      const key=this.cellYFP(u.fy)*this.cols+this.cellXFP(u.fx);
      const bucket=this.buckets[key];
      if(!bucket.length)this.used.push(key);
      bucket.push(i);
    }
  }
  // Radius arguments use fixed-point world units, not diameters. Each live unit
  // has one center cell; this query expands by the largest indexed radius so a
  // small query circle still discovers a large possible contact partner. It scans
  // y/x cells in order and reads buckets at y*columns+x. The caller owns `out` and
  // may reuse it; each reuse clears/overwrites the old result, while a different
  // array is safe for nested calls. Copy the result before reusing its buffer.
  queryCandidatesFP(fx,fy,radiusFP,out){
    out.length=0;
    const reach=Math.max(0,Math.trunc(Number(radiusFP)||0))+this.maxIndexedRadiusFP;
    const minCx=this.cellXFP(fx-reach),maxCx=this.cellXFP(fx+reach);
    const minCy=this.cellYFP(fy-reach),maxCy=this.cellYFP(fy+reach);
    for(let cy=minCy;cy<=maxCy;cy++)for(let cx=minCx;cx<=maxCx;cx++){
      const bucket=this.buckets[cy*this.cols+cx];
      for(let k=0;k<bucket.length;k++)out.push(bucket[k]);
    }
    return out;
  }
}

// Each circle's own swept bounds prune false candidates. Ordered bucket streams
// preserve the old coarse-grid traversal, including epsilon contact ties.
class DeterministicSweptCollisionGrid{
  static MAX_CELLS=16;
  constructor(world){
    this.cellFP=64*FP;this.cols=Math.ceil(world.width/64);this.rows=Math.ceil(world.height/64);
    this.buckets=new Array(this.cols*this.rows);this.used=[];
    this.ordered=[];this.overflow=[];this.lists=[];this.cursors=new Int32Array(DeterministicSweptCollisionGrid.MAX_CELLS+1);this.out=[];
    // Query views keep only non-allies for player 0/1, in the same coarse-cell /
    // unit-index order. Neutral/other owners still query the full original view.
    this.hostileBuckets=[new Array(this.cols*this.rows),new Array(this.cols*this.rows)];
    this.hostileUsed=[[],[]];this.hostileOrdered=[[],[]];this.hostileOverflow=[[],[]];
    this.capacity=0;this.bounds=null;
  }
  cellX(x){return RangeUtil.clamp(Math.floor(x/this.cellFP),0,this.cols-1)}
  cellY(y){return RangeUtil.clamp(Math.floor(y/this.cellFP),0,this.rows-1)}
  reset(units,motion,radii,segX,segY,coarse){
    for(const key of this.used)this.buckets[key].length=0;
    this.used.length=0;this.ordered.length=0;this.overflow.length=0;
    for(let side=0;side<2;side++){
      for(const key of this.hostileUsed[side])this.hostileBuckets[side][key].length=0;
      this.hostileUsed[side].length=0;this.hostileOrdered[side].length=0;this.hostileOverflow[side].length=0;
    }
    if(units.length>this.capacity){
      this.capacity=Math.max(units.length,this.capacity*2,64);
      this.bounds=Object.fromEntries(['minX','minY','maxX','maxY'].map(key=>[key,new Float64Array(this.capacity)]));
      this.rank=new Int32Array(this.capacity);this.endCell=new Int32Array(this.capacity);
    }
    const b=this.bounds;
    for(let key=0;key<coarse.buckets.length;key++)for(const i of coarse.buckets[key]){
      const u=units[i];if(!u?.alive||radii[i]<=0||motion.flags[i])continue;
      this.rank[i]=this.ordered.length;this.endCell[i]=key;this.ordered.push(i);
      const hostile0=u.side!==0,hostile1=u.side!==1;
      if(hostile0)this.hostileOrdered[0].push(i);if(hostile1)this.hostileOrdered[1].push(i);
      b.minX[i]=Math.min(segX[i],u.fx)-radii[i]-1;b.maxX[i]=Math.max(segX[i],u.fx)+radii[i]+1;
      b.minY[i]=Math.min(segY[i],u.fy)-radii[i]-1;b.maxY[i]=Math.max(segY[i],u.fy)+radii[i]+1;
      const x0=this.cellX(b.minX[i]),x1=this.cellX(b.maxX[i]),y0=this.cellY(b.minY[i]),y1=this.cellY(b.maxY[i]);
      if((x1-x0+1)*(y1-y0+1)>DeterministicSweptCollisionGrid.MAX_CELLS){
        this.overflow.push(i);if(hostile0)this.hostileOverflow[0].push(i);if(hostile1)this.hostileOverflow[1].push(i);continue;
      }
      for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
        const cell=y*this.cols+x,bucket=this.buckets[cell]||(this.buckets[cell]=[]);
        if(!bucket.length)this.used.push(cell);bucket.push(i);
        if(hostile0){const b0=this.hostileBuckets[0][cell]||(this.hostileBuckets[0][cell]=[]);if(!b0.length)this.hostileUsed[0].push(cell);b0.push(i)}
        if(hostile1){const b1=this.hostileBuckets[1][cell]||(this.hostileBuckets[1][cell]=[]);if(!b1.length)this.hostileUsed[1].push(cell);b1.push(i)}
      }
    }
  }
  query(i,coarse,minCx,maxCx,minCy,maxCy,attackerSide=null){
    const b=this.bounds,out=this.out;out.length=0;
    const player=attackerSide===0||attackerSide===1;
    const buckets=player?this.hostileBuckets[attackerSide]:this.buckets;
    const ordered=player?this.hostileOrdered[attackerSide]:this.ordered;
    const overflow=player?this.hostileOverflow[attackerSide]:this.overflow;
    const accept=j=>{
      if(j<=i)return;
      const key=this.endCell[j],x=key%coarse.cols,y=Math.floor(key/coarse.cols);
      if(x<minCx||x>maxCx||y<minCy||y>maxCy)return;
      if(b.maxX[i]<b.minX[j]||b.maxX[j]<b.minX[i]||b.maxY[i]<b.minY[j]||b.maxY[j]<b.minY[i])return;
      out.push(j);
    };
    const x0=this.cellX(b.minX[i]),x1=this.cellX(b.maxX[i]),y0=this.cellY(b.minY[i]),y1=this.cellY(b.maxY[i]);
    // Large sweeps inspect every eligible unit once, including ordinary bins.
    if((x1-x0+1)*(y1-y0+1)>DeterministicSweptCollisionGrid.MAX_CELLS){for(const j of ordered)accept(j);return out}
    const lists=this.lists;lists.length=0;
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const bucket=buckets[y*this.cols+x];if(bucket?.length)lists.push(bucket)}
    if(overflow.length)lists.push(overflow);
    this.cursors.fill(0,0,lists.length);
    // At most 17 streams, already sorted by old (end-cell, unit-index) order.
    // Consume equal heads together: no duplicate pair and no per-query sort.
    for(;;){
      let next=-1,rank=Infinity;
      for(let k=0;k<lists.length;k++){const cursor=this.cursors[k];if(cursor>=lists[k].length)continue;const j=lists[k][cursor];if(this.rank[j]<rank){rank=this.rank[j];next=j}}
      if(next<0)break;
      for(let k=0;k<lists.length;k++)if(lists[k][this.cursors[k]]===next)this.cursors[k]++;
      accept(next);
    }
    return out;
  }
}

/* Runtime-only deterministic unit spatial grid.
 * Dense fixed arrays replace Map lookup + per-query sorting in the combat hot path.
 * Each cell also keeps side-specific buckets, so enemy/ally queries do not scan
 * unrelated units. Bucket order is runtime-only; every gameplay tie is resolved by
 * explicit distance/ID rules and the structure never enters checksum/exportState. */
class DeterministicUnitSpatialGrid{
  constructor(cellSize=SIM_SPATIAL_CELL,world){
    this.cellSize=cellSize;
    this.cols=Math.ceil(world.width/cellSize);
    this.rows=Math.ceil(world.height/cellSize);
    this.cellCount=this.cols*this.rows;
    this.units=null;
    this.unitIndexById=null;
    this.buckets=Array.from({length:this.cellCount},()=>[]);
    this.sideBuckets=Array.from({length:3},()=>Array.from({length:this.cellCount},()=>[]));
    this.indexCellKeys=[];
    this.indexAllSlots=[];
    this.indexSideSlots=[];
    this.queryBuffer=[];
  }
  cellX(x){return RangeUtil.clamp(Math.floor(x/this.cellSize),0,this.cols-1)}
  cellY(y){return RangeUtil.clamp(Math.floor(y/this.cellSize),0,this.rows-1)}
  keyXY(cx,cy){return cy*this.cols+cx}
  keyFor(x,y){return this.keyXY(this.cellX(x),this.cellY(y))}
  sideIndex(side){return side===0?0:side===1?1:2}
  reset(units,unitIndexById){
    this.units=units;
    this.unitIndexById=unitIndexById;
    for(let key=0;key<this.cellCount;key++){
      this.buckets[key].length=0;
      this.sideBuckets[0][key].length=0;
      this.sideBuckets[1][key].length=0;
      this.sideBuckets[2][key].length=0;
    }
    this.indexCellKeys.length=units.length;
    this.indexAllSlots.length=units.length;
    this.indexSideSlots.length=units.length;
    for(let i=0;i<units.length;i++){
      const u=units[i];
      if(!u.alive){this.indexCellKeys[i]=null;continue}
      this.add(u,i);
    }
  }
  add(u,index){
    if(!u?.alive||index==null)return;
    const key=this.keyFor(u.x,u.y),side=this.sideIndex(u.side);
const all=this.buckets[key],sb=this.sideBuckets[side][key];
    this.indexCellKeys[index]=key;
    this.indexAllSlots[index]=all.length;all.push(index);
    this.indexSideSlots[index]=sb.length;sb.push(index);
  }
  removeFromBucket(bucket,slot,slotTable){
    if(slot==null||slot<0||slot>=bucket.length)return;
    const lastIndex=bucket[bucket.length-1];
    bucket[slot]=lastIndex;bucket.pop();
    if(slot<bucket.length)slotTable[lastIndex]=slot;
  }
  sync(u){
    if(!u||!this.units||!this.unitIndexById)return;
    const index=this.unitIndexById.get(u.id);
    if(index==null)return;
    const oldKey=this.indexCellKeys[index],next=this.keyFor(u.x,u.y);
    if(oldKey===next)return;
    if(oldKey!=null){
      const side=this.sideIndex(u.side);
      this.removeFromBucket(this.buckets[oldKey],this.indexAllSlots[index],this.indexAllSlots);
      this.removeFromBucket(this.sideBuckets[side][oldKey],this.indexSideSlots[index],this.indexSideSlots);
    }
    this.add(u,index);
  }
  query(x,y,r,out=this.queryBuffer,side=null){
    out.length=0;
    const minX=this.cellX(x-r),maxX=this.cellX(x+r);
    const minY=this.cellY(y-r),maxY=this.cellY(y+r);
    const grid=side==null?this.buckets:this.sideBuckets[this.sideIndex(side)];
    for(let cy=minY;cy<=maxY;cy++)for(let cx=minX;cx<=maxX;cx++){
      const bucket=grid[this.keyXY(cx,cy)];
      for(let i=0;i<bucket.length;i++)out.push(bucket[i]);
    }
    return out;
  }
}

/* Runtime-only fixed-cell building grid. Buildings are static, so buckets rebuild
 * only when topology changes (create/destroy/recovery import). Building indices are
 * appended in this.buildings stable index order; queries never sort. */
class DeterministicBuildingSpatialGrid{
  constructor(cellSize=SIM_SPATIAL_CELL,world){
    this.cellSize=cellSize;this.cols=Math.ceil(world.width/cellSize);this.rows=Math.ceil(world.height/cellSize);
    this.cellCount=this.cols*this.rows;this.buckets=Array.from({length:this.cellCount},()=>[]);this.queryBuffer=[];
  }
  cellX(x){return RangeUtil.clamp(Math.floor(x/this.cellSize),0,this.cols-1)}
  cellY(y){return RangeUtil.clamp(Math.floor(y/this.cellSize),0,this.rows-1)}
  key(cx,cy){return cy*this.cols+cx}
  reset(buildings){
    for(let k=0;k<this.cellCount;k++)this.buckets[k].length=0;
    for(let i=0;i<buildings.length;i++){
      const b=buildings[i];if(!b||b.alive===false)continue;
      this.buckets[this.key(this.cellX(b.x),this.cellY(b.y))].push(i);
    }
  }
  query(x,y,r,out=this.queryBuffer){
    out.length=0;const minX=this.cellX(x-r),maxX=this.cellX(x+r),minY=this.cellY(y-r),maxY=this.cellY(y+r);
    for(let cy=minY;cy<=maxY;cy++)for(let cx=minX;cx<=maxX;cx++){
      const bucket=this.buckets[this.key(cx,cy)];for(let i=0;i<bucket.length;i++)out.push(bucket[i]);
    }
    return out;
  }
}

export { DeterministicBuildingSpatialGrid, DeterministicCollisionGrid, DeterministicSweptCollisionGrid, DeterministicUnitSpatialGrid };
