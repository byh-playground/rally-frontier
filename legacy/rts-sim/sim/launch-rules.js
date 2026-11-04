// Cannon launch rules: income, wallet and grain data.
import { RangeUtil } from '../core/game-rules.js';

// 발사전: 대포가 유닛 뭉치를 쏜다. 거리는 누른 시간만으로 정해지고, 조준 중에는 착지 원으로 미리 보인다(D-196).
class LaunchRules{
  static incomePerSecond=40;static walletCap=600;static startingWallet=200;
  static minReach=250;static maxReach=2200;static chargeMs=1500;static overheatGraceMs=180;
  static overheatMs=2000;static reloadMs=400;static speed=750;
  static landingMarkMs=1500;static captureHoldRadius=400;
  static grains=Object.freeze({
    rice:Object.freeze({cost:100,count:20,reach:1,speed:600,impact:10,splash:180,land:"scatter",spread:260}),
    soybean:Object.freeze({cost:100,count:12,reach:.85,speed:750,impact:40,splash:100,land:"line",spacing:22}),
    redbean:Object.freeze({cost:150,count:10,reach:.75,speed:750,impact:25,splash:120,land:"rush",rushMs:2000,rushPct:150}),
  });
  static deck=Object.freeze(Object.keys(LaunchRules.grains));
  static grain(type){return Object.hasOwn(this.grains,type)?this.grains[type]:null}
  static payload(type){const g=this.grain(type);return g?{count:g.count,cost:g.cost}:null}
  static overheated(holdMs){return holdMs>this.chargeMs+this.overheatGraceMs}
  static power(holdMs){return RangeUtil.clamp(holdMs/this.chargeMs,0,1)}
  static maxReachOf(type){return Math.round(this.maxReach*(this.grain(type)?.reach??1))}
  static reach(holdMs,type){return Math.round(this.minReach+(this.maxReachOf(type)-this.minReach)*this.power(holdMs))}
  // Inverse of reach(): the hold that lands a grain at this distance.
  static holdFor(distance,type){return RangeUtil.clamp((distance-this.minReach)/Math.max(1,this.maxReachOf(type)-this.minReach),0,1)*this.chargeMs}
  static arcHeight(distance){return RangeUtil.clamp(Math.round(distance*.3),80,600)}
  // Direction comes from the press point; distance comes only from hold time.
  static target(cannon,x,y,holdMs,world,fallback,type){
    let dx=x-cannon.x,dy=y-cannon.y,len=Math.hypot(dx,dy);
    if(len<1){dx=fallback.x-cannon.x;dy=fallback.y-cannon.y;len=Math.hypot(dx,dy)||1}
    const reach=this.reach(holdMs,type);
    return {x:Math.round(RangeUtil.clamp(cannon.x+dx/len*reach,40,world.width-40)),y:Math.round(RangeUtil.clamp(cannon.y+dy/len*reach,40,world.height-40)),reach};
  }
}

export { LaunchRules };
