// Per-match derived world geometry shared by simulation and presentation.
import { GameRuleDefinition } from '../core/game-rules.js';
import { TerrainGeometry } from './terrain.js';

class WorldContext{
  constructor(map){
    this.width=Math.max(2400,Math.round(Number(map?.width)||GameRuleDefinition.defaults.map.width));
    this.height=Math.max(2400,Math.round(Number(map?.height)||GameRuleDefinition.defaults.map.height));
    const defaults=GameRuleDefinition.defaults.map.spawns;
    this.bases=Object.freeze(["host","guest"].map(role=>Object.freeze({
      x:Number(map?.spawns?.[role]?.x??defaults[role].x),
      y:Number(map?.spawns?.[role]?.y??defaults[role].y)
    })));
    this.center=Object.freeze({x:this.width/2,y:this.height/2});
    this.terrain=TerrainGeometry.fromMap(map);
    Object.freeze(this);
  }
  static cache=new WeakMap();
  static fromMap(map){
    if(!map||typeof map!=="object")return this.standard;
    let world=this.cache.get(map);
    if(!world){world=new WorldContext(map);this.cache.set(map,world)}
    return world;
  }
  static forState(state){return state?.world||this.fromMap(state?.mapDescriptor||state?.rules?.map)}
  static standard=new WorldContext(GameRuleDefinition.defaults.map);
}

export { WorldContext };
