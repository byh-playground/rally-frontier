// Frozen production contact implementation from cddabc0de28ff7fa0f0671c3acf36e82eb20d3b2.
// QA byte-equality oracle only; this file is never imported or deployed by the game.
// The retired helper is invoked through this object to preserve the original calculations.
const contactReference={
cast(rx,ry,vx,vy,r,policy,fallback=null){
    const aa=vx*vx+vy*vy,radial=rx*vx+ry*vy,c=rx*rx+ry*ry-r*r;
    const length=Math.hypot(rx,ry),distancePolicy=policy.contactDistanceEpsilon!=null;
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
  },
sweep(startFx,startFy,radii,maxRadius,maxPasses=4){
    const units=this.units,n=units.length;
    if(!n)return 0;
    const segX=this.collisionSegmentFx,segY=this.collisionSegmentFy;
    const nextX=this.collisionNextFx,nextY=this.collisionNextFy;
    const bestT=this.collisionBestT,bestNx=this.collisionBestNx,bestNy=this.collisionBestNy,bestOther=this.collisionBestOther;
    const grid=this.collisionGrid,buckets=grid.buckets,cols=grid.cols;

    for(let i=0;i<n;i++){
      const u=units[i];
      segX[i]=i<startFx.length?startFx[i]:(u?.fx??0);
      segY[i]=i<startFy.length?startFy[i]:(u?.fy??0);
    }

    let totalCorrections=0;
    for(let pass=0;pass<maxPasses;pass++){
      bestT.fill(Infinity,0,n);bestOther.fill(-1,0,n);
      let maxTravel=0;
      for(let i=0;i<n;i++){
        const u=units[i];if(!u?.alive)continue;
        maxTravel=Math.max(maxTravel,Math.ceil(Math.hypot(u.fx-segX[i],u.fy-segY[i])));
      }

      grid.reset(units);
      let pairContacts=0;
      for(let i=0;i<n;i++){
        const a=units[i];
        if(!a?.alive||radii[i]<=0||!!a?.capability(BurrowableMixin.KEY)?.isActive()||!!a?.capability(LeapableMixin.KEY)?.isActive(this)||a.objectiveChargeActive)continue;
        const sx=segX[i],sy=segY[i],ex=a.fx,ey=a.fy;
        const reach=radii[i]+maxRadius+maxTravel;
        const minCx=grid.cellXFP(Math.min(sx,ex)-reach),maxCx=grid.cellXFP(Math.max(sx,ex)+reach);
        const minCy=grid.cellYFP(Math.min(sy,ey)-reach),maxCy=grid.cellYFP(Math.max(sy,ey)+reach);
        for(let cy=minCy;cy<=maxCy;cy++)for(let cx=minCx;cx<=maxCx;cx++){
          const bucket=buckets[cy*cols+cx];
          for(let k=0;k<bucket.length;k++){
            const j=bucket[k];if(j<=i)continue;
            const b=units[j];
            if(!b?.alive||radii[j]<=0||this.isAlliedCollisionUnit(a,b))continue;
            if(!!b?.capability(BurrowableMixin.KEY)?.isActive()||!!b?.capability(LeapableMixin.KEY)?.isActive(this)||b.objectiveChargeActive)continue;
            if(this.unitLayer(a.type)!==this.unitLayer(b.type))continue;

            const hit=contactReference.contact.call(this,
              i,j,radii,
              segX[i]/FP,segY[i]/FP,segX[j]/FP,segY[j]/FP,
              a.fx/FP,a.fy/FP,b.fx/FP,b.fy/FP
            );
            if(!hit)continue;
            pairContacts++;

            if(hit.t<bestT[i]-1e-9||(Math.abs(hit.t-bestT[i])<=1e-9&&(bestOther[i]<0||j<bestOther[i]))){
              bestT[i]=hit.t;bestNx[i]=hit.nx;bestNy[i]=hit.ny;bestOther[i]=j;
            }
            if(hit.t<bestT[j]-1e-9||(Math.abs(hit.t-bestT[j])<=1e-9&&(bestOther[j]<0||i<bestOther[j]))){
              bestT[j]=hit.t;bestNx[j]=-hit.nx;bestNy[j]=-hit.ny;bestOther[j]=i;
            }
          }
        }
      }
      if(!pairContacts)break;

      let corrected=0;
      for(let i=0;i<n;i++){
        const u=units[i];nextX[i]=u?.fx??0;nextY[i]=u?.fy??0;
        const other=bestOther[i];if(!u?.alive||other<0)continue;
        const sx=segX[i]/FP,sy=segY[i]/FP,ex=u.fx/FP,ey=u.fy/FP;
        const dx=ex-sx,dy=ey-sy,len=Math.hypot(dx,dy);
        if(len<.000001){segX[i]=u.fx;segY[i]=u.fy;continue}

        const q=RangeUtil.clamp(bestT[i],0,1),cx=sx+dx*q,cy=sy+dy*q,leftLen=len*(1-q);
        let goalX=dx,goalY=dy;
        if(u.collisionIntentTick===this.tick){
          goalX=(Number(u.collisionIntentTx)||0)-cx;goalY=(Number(u.collisionIntentTy)||0)-cy;
        }
        const slide=SurfaceContactGeometry.slide(dx*(1-q),dy*(1-q),[{nx:bestNx[i],ny:bestNy[i],key:'solid:'+other}],leftLen,{steer:true,
          goalX,goalY,tieKey:`solid|${u.id}|${units[other]?.id||other}`
        });
        const ur=radii[i]||this.radiusFP(u);
        nextX[i]=RangeUtil.clamp(Math.round((cx+slide.x)*FP),ur,this.world.width*FP-ur);
        nextY[i]=RangeUtil.clamp(Math.round((cy+slide.y)*FP),ur,this.world.height*FP-ur);

        // Next pass starts at this contact point, not at tick start. This preserves
        // the actual piecewise path and catches second/third obstacles on the tangent.
        segX[i]=Math.round(cx*FP);segY[i]=Math.round(cy*FP);
        if(nextX[i]!==u.fx||nextY[i]!==u.fy)corrected++;
      }

      // Units without a contact have consumed their entire segment and are stationary
      // for later sub-passes; units with a contact continue from their contact point.
      for(let i=0;i<n;i++){
        const u=units[i];if(!u?.alive)continue;
        if(bestOther[i]<0){segX[i]=u.fx;segY[i]=u.fy;continue}
        u.fx=nextX[i];u.fy=nextY[i];u.x=u.fx/FP;u.y=u.fy/FP;
        this.navigation.motion.constrain(u);
      }
      totalCorrections+=corrected;
      if(!corrected)break;
    }
    return totalCorrections;
  },
solve(){
    // Fixed-cell grid broadphase + unchanged Jacobi/PBD narrowphase.
    // Rebuild is O(N) per iteration; each unit only scans cells intersecting its
    // maximum possible contact radius. No candidate sort/Map/quadtree traversal.
    const units=this.units,n=units.length;
    if(!n)return;
    const perf=this._perfCollect;
    this.constrainSurfaceContacts();

    this.ensureCollisionBuffers(n);
    const radii=this.collisionRadii,masses=this.collisionMasses;
    let maxRadius=FP;
    for(let i=0;i<n;i++){
      const u=units[i];
      const ud=UnitDefinition.get(u.type);
      if(!u.alive||ud?.crowdCollision===false||!!u?.capability(LeapableMixin.KEY)?.isActive(this)||u.objectiveChargeActive){radii[i]=0;masses[i]=0;continue}
      radii[i]=this.radiusFP(u);masses[i]=this.mass(u);
      if(radii[i]>maxRadius)maxRadius=radii[i];
    }

    const grid=this.collisionGrid,buckets=grid.buckets,cols=grid.cols;
    const dxA=this.collisionDx,dyA=this.collisionDy,cnt=this.collisionCnt;

    // First resolve the actual movement/impulse path for this tick against dynamic
    // non-allied solids. This is where normal movement becomes surface sliding.
    this.resolveNonAlliedSurfaceMotion(this.collisionStartFx,this.collisionStartFy,radii,maxRadius,4);

    for(let iter=0;iter<COLLISION_ITERS;iter++){
      if(perf)perf.collisionIterations++;
      grid.reset(units);
      dxA.fill(0,0,n);dyA.fill(0,0,n);cnt.fill(0,0,n);
      for(let i=0;i<n;i++){
        const u=units[i];this.collisionSegmentFx[i]=u?.fx??0;this.collisionSegmentFy[i]=u?.fy??0;
      }
      let overlaps=0;

      for(let i=0;i<n;i++){
        const a=units[i];if(!a.alive||radii[i]<=0)continue;
        const reach=radii[i]+maxRadius;
        const minCx=grid.cellXFP(a.fx-reach),maxCx=grid.cellXFP(a.fx+reach);
        const minCy=grid.cellYFP(a.fy-reach),maxCy=grid.cellYFP(a.fy+reach);

        for(let cy=minCy;cy<=maxCy;cy++)for(let cx=minCx;cx<=maxCx;cx++){
          const bucket=buckets[cy*cols+cx];
          for(let k=0;k<bucket.length;k++){
            const j=bucket[k];if(j<=i)continue;
            const b=units[j];
            if(radii[j]<=0)continue;
            const aBurrow=!!a?.capability(BurrowableMixin.KEY)?.isActive(),bBurrow=!!b?.capability(BurrowableMixin.KEY)?.isActive();
            if(!b.alive||aBurrow!==bBurrow||!!a?.capability(LeapableMixin.KEY)?.isActive(this)||!!b?.capability(LeapableMixin.KEY)?.isActive(this)||a.objectiveChargeActive||b.objectiveChargeActive||this.unitLayer(a.type)!==this.unitLayer(b.type))continue;
            if(perf)perf.collisionPairs++;
            const min=radii[i]+radii[j];
            let dx=b.fx-a.fx,dy=b.fy-a.fy;const d2=dx*dx+dy*dy;
            if(d2>=min*min)continue;
            let nx,ny,dist;
            if(d2===0){[nx,ny]=this.fallbackNormal(a,b);dist=0}
            else{dist=Math.max(1,Math.floor(Math.sqrt(d2)));nx=Math.trunc(dx*COLLISION_NORMAL/dist);ny=Math.trunc(dy*COLLISION_NORMAL/dist)}
            const pen=min-dist;if(pen<=0)continue;
            if(!this.isAlliedCollisionUnit(a,b))continue;
            overlaps++;if(perf)perf.collisionOverlaps++;
            const ma=masses[i],mb=masses[j],tot=ma+mb;
            const pa=Math.max(1,Math.floor(pen*mb/tot)),pb=Math.max(1,pen-pa);
            dxA[i]-=Math.trunc(nx*pa/COLLISION_NORMAL);dyA[i]-=Math.trunc(ny*pa/COLLISION_NORMAL);
            dxA[j]+=Math.trunc(nx*pb/COLLISION_NORMAL);dyA[j]+=Math.trunc(ny*pb/COLLISION_NORMAL);
            cnt[i]++;cnt[j]++;
          }
        }
      }

      // First apply Jacobi unit-unit corrections. Static buildings are infinite-mass
      // constraints, so their correction must NOT be diluted by cnt[i] when a unit
      // is simultaneously pressed by several neighbors.
      for(let i=0;i<n;i++){
        const u=units[i];if(!u.alive||!cnt[i])continue;
        const r=radii[i];
        let cx=Math.trunc(dxA[i]/cnt[i]),cy=Math.trunc(dyA[i]/cnt[i]);
        // PBD safety bound: a dense/singular overlap may generate many simultaneous
        // constraints, but one solver iteration must never teleport a unit farther
        // than its own collision radius. Remaining penetration converges over later
        // iterations/ticks instead of overshooting.
        const len2=cx*cx+cy*cy,maxCorrection=Math.max(FP,Math.round(r));
        if(len2>maxCorrection*maxCorrection){const len=Math.max(1,Math.sqrt(len2)),scale=maxCorrection/len;cx=Math.trunc(cx*scale);cy=Math.trunc(cy*scale)}
        u.fx=RangeUtil.clamp(u.fx+cx,r,this.world.width*FP-r);
        u.fy=RangeUtil.clamp(u.fy+cy,r,this.world.height*FP-r);
        u.x=u.fx/FP;u.y=u.fy/FP;
      }

      // Allied crowd correction is also not allowed to push through a non-ally.
      // Treat this iteration's PBD correction as its own short motion segment and
      // surface-slide that correction without modifying the obstacle.
      const solidCorrections=this.resolveNonAlliedSurfaceMotion(
        this.collisionSegmentFx,this.collisionSegmentFy,radii,maxRadius,3
      );
      if(solidCorrections){overlaps+=solidCorrections;if(perf)perf.collisionOverlaps+=solidCorrections}

      // Buildings and cliffs constrain this correction, not the whole tick chord.
      const surfaceCorrections=this.constrainSurfaceContacts();
      if(surfaceCorrections){overlaps+=surfaceCorrections;if(perf)perf.collisionOverlaps+=surfaceCorrections}

      // Final invariant: no ordinary ground non-allied pair may remain overlapped.
      // Cross-team pressure is never transferred: recovery moves the semantic intruder
      // selected from this tick's motion. Emerge/knockback/pull remain explicit forces.
      const hardFixes=this.enforceNonAlliedNoOverlap(radii,maxRadius,4);
      if(hardFixes){
        overlaps+=hardFixes;if(perf)perf.collisionOverlaps+=hardFixes;
        for(let i=0;i<n;i++)if(units[i]?.alive)this.syncUnitSpatial(units[i]);
        this.constrainSurfaceContacts();
      }
      if(!overlaps)break;
    }
  },
contact(i,j,radii,asx,asy,bsx,bsy,aex,aey,bex,bey){
    const a=this.units[i],b=this.units[j];if(!a?.alive||!b?.alive)return null;
    return SweptCircleContact.cast(asx-bsx,asy-bsy,(aex-asx)-(bex-bsx),(aey-asy)-(bey-bsy),(radii[i]+radii[j])/FP,SweptCircleContact.policies.relative,()=>{const n=this.fallbackNormal(a,b);return{x:n[0]/COLLISION_NORMAL,y:n[1]/COLLISION_NORMAL}});
  }
};
