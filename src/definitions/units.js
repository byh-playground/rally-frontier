// Launch grain definitions, runtime geometry and visual definitions.
import { COLLISION_RADIUS_SCALE } from './world-rules.js';
import { FP } from '../core/config.js';

class UnitDefinition{
  static all={
  rice:{requiresContactTerrain:true,name:"쌀",hp:25,atk:5,range:25,speed:75,cooldownMs:1000,size:10,sizeClass:"light",role:"bruiser",attackVisual:{sourceMotion:"slash",travel:"none",impact:"light"},sight:275},
  soybean:{requiresContactTerrain:true,name:"콩",mass:225,hp:75,atk:10,range:25,speed:50,cooldownMs:1000,size:10,sizeClass:"medium",role:"bruiser",attackVisual:{sourceMotion:"smash",travel:"none",impact:"light"},sight:275},
  redbean:{requiresContactTerrain:true,name:"팥",hp:50,atk:15,range:25,speed:50,cooldownMs:1000,size:10,sizeClass:"light",role:"bruiser",attackVisual:{sourceMotion:"smash",travel:"none",impact:"light"},sight:275},
};
  static get(type){return this.all[type]||null}
  static damageClass(type){
    const d=this.get(type);if(!d)return"normal";
    if(d.damageClass)return d.damageClass;
    if((d.range||0)>=250)return"ranged";
    return"melee";
  }
}
for(const d of Object.values(UnitDefinition.all)){
  if(Number.isFinite(Number(d.cooldownMs)))d.cooldown=Number(d.cooldownMs)/1000;
  if(d.canAttackGround==null)d.canAttackGround=(d.atk||0)>0;
}

const UNIT_RUNTIME_GEOMETRY=Object.freeze(Object.fromEntries(
  Object.entries(UnitDefinition.all).map(([type,d])=>[type,Object.freeze({
    radius:Math.max(1,(d?.size||10)*COLLISION_RADIUS_SCALE),
    radiusFP:Math.max(FP,Math.round((d?.size||10)*COLLISION_RADIUS_SCALE*FP)),
    mass:Math.max(1,Number(d?.mass)||(d?.size||10)*(d?.size||10))
  })])
));

class UnitVisualDefinition{
  static all={
  rice:{family:"grain",billboard:true,visualScale:.85,accent:[.96,.94,.86,1],fx:"melee"},
  soybean:{family:"grain",billboard:true,visualScale:.8,accent:[.50,.69,.27,1],fx:"melee"},
  redbean:{family:"grain",billboard:true,visualScale:.9,accent:[.66,.20,.23,1],fx:"melee"}
};
  static get(id){return this.all[id]||null}
}

// Faction supplies colors only; species owns body geometry, scale and materials.
class UnitFactionPalette{
  static all={
    friendly:{body:[.18,.43,.93,1],dark:[.07,.19,.46,1],light:[.48,.68,1,1],ring:[.32,.58,1,.58]},
    enemy:{body:[.89,.28,.28,1],dark:[.48,.08,.10,1],light:[1,.55,.55,1],ring:[1,.35,.35,.58]},
    neutral:{body:[.48,.35,.22,1],dark:[.25,.18,.12,1],light:[.72,.57,.34,1],ring:[.76,.61,.28,.46]}
  };
  static get(relation){return this.all[relation]}
}

// Faces baked into the shared face atlas: the grains only ever show these three.
const GRAIN_FACE_IDS=Object.freeze(['neutral','attack','hurt']);

export { GRAIN_FACE_IDS, UNIT_RUNTIME_GEOMETRY, UnitDefinition, UnitFactionPalette, UnitVisualDefinition };
