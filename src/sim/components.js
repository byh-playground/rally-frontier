// Entity state contracts and components.
import { RallyStateCodec } from '../session/game-session.js';
import { NavigationGoal, TerrainNavigation } from './navigation.js';

/* =========================
   3. Deterministic strategy simulation
   ========================= */

// State owners declare defaults and classify non-authoritative fields once.
// Extra fields in trusted campaign state remain serializable AND hash-visible;
// only explicitly declared presentation/derived fields are excluded.
class StateValue{
  static freeze(value){
    if(!value||typeof value!=="object"||Object.isFrozen(value))return value;
    for(const v of Object.values(value))this.freeze(v);return Object.freeze(value);
  }
  static numberBits=new DataView(new ArrayBuffer(8));
  static copy(value){
    if(value===null||typeof value!=="object")return value;
    if(Array.isArray(value))return value.map(v=>this.copy(v));
    if(ArrayBuffer.isView(value))return new value.constructor(value);
    if(value instanceof ArrayBuffer)return value.slice(0);
    if(value instanceof Date)return new Date(value);
    const out={};for(const key of Object.keys(value))if(typeof value[key]!=="function")out[key]=this.copy(value[key]);return out;
  }
  static hash(h,value){
    if(value===null){h.m(0);return}
    switch(typeof value){
      case "undefined":h.m(1);return;
      case "boolean":h.m(2);h.m(value?1:0);return;
      case "number":h.m(3);if(Number.isNaN(value)){h.m(0x7ff80000);return}this.numberBits.setFloat64(0,value===0?0:value,true);h.m(this.numberBits.getUint32(0,true));h.m(this.numberBits.getUint32(4,true));return;
      case "string":h.m(4);h.m(value.length);h.ms(value);return;
      case "bigint":h.m(5);h.ms(value.toString());return;
      case "function":throw new Error("A function is not simulation state");
    }
    if(Array.isArray(value)||ArrayBuffer.isView(value)){h.m(6);h.m(value.length);for(const v of value)this.hash(h,v);return}
    h.m(7);const keys=Object.keys(value).filter(k=>typeof value[k]!=="function").sort();h.m(keys.length);
    for(const key of keys){h.ms(key);this.hash(h,value[key])}
  }
}
class StateContract{
  // mode "save" is the canonical sorted state; "snapshot" adds presentation fields;
  // "view" is what UI/renderer/bot read. A contract with a view list copies only
  // those keys there, so view snapshots skip simulation-only internals.
  constructor(defaults={}, {presentation=[],derived=[],children={},view=null}={}){
    this.defaults=Object.freeze(defaults);this.presentation=new Set(presentation);this.derived=new Set(derived);this.children=children;this.view=view&&Object.freeze([...view]);
  }
  create(state={}){
    const out=StateValue.copy(this.defaults);
    for(const key of Object.keys(state||{}))if(!this.derived.has(key))out[key]=StateValue.copy(state[key]);
    return out;
  }
  keys(value,mode){
    if(mode==="view"&&this.view)return this.view.filter(k=>k in value);
    const keys=Object.keys(value).filter(k=>!this.derived.has(k)&&(mode!=="save"||!this.presentation.has(k))&&typeof value[k]!=="function");
    return mode==="save"?keys.sort():keys;
  }
  capture(value,mode="snapshot"){
    const out={};for(const key of this.keys(value,mode)){const child=this.children[key];out[key]=child?child.capture(value[key],mode):StateValue.copy(value[key])}return out;
  }
  hash(h,value){
    const keys=this.keys(value,"save");h.m(keys.length);
    for(const key of keys){h.ms(key);const child=this.children[key];if(child)child.hash(h,value[key]);else StateValue.hash(h,value[key])}
  }
}

class StatusComponent{
  static stateContract=new StateContract({timedModifiers:{},terrainRevealUntil0:0,terrainRevealUntil1:0},{view:[]});
  constructor(state={}){Object.assign(this,StatusComponent.stateContract.create(state))}
}
class MovementComponent{
  static stateContract=new StateContract({routes:[],routeIndex:-1,lastMoveTick:-999999},{view:["lastMoveTick"]});
  constructor(state={}){Object.assign(this,MovementComponent.stateContract.create(state))}
  static plannerCodes=Object.freeze({direct:0,astar:1,'shared-astar':2,'flow-field':3});
  static planners=Object.freeze(['direct','astar','shared-astar','flow-field']);
  static encodeRouteRecipe(recipe){
    const code=this.plannerCodes[recipe?.planner];
    if(recipe?.kind==='plan'&&code!==undefined)return[0,recipe.key,recipe.radius,recipe.ignore,recipe.fromX,recipe.fromY,code];
    if(recipe?.kind==='unreachable')return[1,recipe.key,recipe.radius,recipe.ignore,recipe.fromX,recipe.fromY];
    const rootCode=this.plannerCodes[recipe?.root?.planner];
    if(recipe?.kind==='join'&&rootCode!==undefined)return[2,recipe.key,recipe.radius,recipe.ignore,recipe.fromX,recipe.fromY,recipe.root.fromX,recipe.root.fromY,rootCode];
    throw new Error('Invalid movement route recipe');
  }
  static decodeRouteRecipe(data){
    if(!Array.isArray(data))throw new Error('Invalid packed movement route recipe');
    if(data.length===7&&data[0]===0&&Number.isSafeInteger(data[6])&&this.planners[data[6]])return{kind:'plan',key:data[1],radius:data[2],ignore:data[3],fromX:data[4],fromY:data[5],planner:this.planners[data[6]]};
    if(data.length===6&&data[0]===1)return{kind:'unreachable',key:data[1],radius:data[2],ignore:data[3],fromX:data[4],fromY:data[5]};
    if(data.length===9&&data[0]===2&&Number.isSafeInteger(data[8])&&this.planners[data[8]])return{kind:'join',key:data[1],radius:data[2],ignore:data[3],fromX:data[4],fromY:data[5],root:{kind:'plan',fromX:data[6],fromY:data[7],planner:this.planners[data[8]]}};
    throw new Error('Invalid packed movement route recipe');
  }
  static validateRoutes(state,world,type,maxRevision=Number.MAX_SAFE_INTEGER){
    if(!state||!Array.isArray(state.routes)||state.routes.length>3||!Number.isSafeInteger(state.routeIndex)||state.routeIndex< -1||state.routeIndex>=state.routes.length)throw new Error('Invalid movement route state');
    const keys=new Set();
    for(const route of state.routes){
      if(!route||Array.isArray(route)||Object.keys(route).sort().join(',')!=='cursor,legX,legY,recipe,retained'||typeof route.retained!=='boolean'||!Number.isSafeInteger(route.cursor)||route.cursor<0||route.cursor>RallyStateCodec.MAX_ARRAY||!Number.isFinite(route.legX)||!Number.isFinite(route.legY)||route.legX<0||route.legY<0||route.legX>world.width||route.legY>world.height)throw new Error('Invalid movement route handle');
      const recipe=this.decodeRouteRecipe(route.recipe);
      if(typeof recipe.key!=='string'||recipe.key.length>1024||!Number.isFinite(recipe.radius)||recipe.radius<=0||recipe.radius>1024||typeof recipe.ignore!=='boolean'||!Number.isFinite(recipe.fromX)||!Number.isFinite(recipe.fromY)||recipe.fromX<0||recipe.fromY<0||recipe.fromX>world.width||recipe.fromY>world.height)throw new Error('Invalid movement route recipe');
      NavigationGoal.fromKey(recipe.key);
      if(recipe.kind==='join'){
        const root=recipe.root;if(!root||!Number.isFinite(root.fromX)||!Number.isFinite(root.fromY)||root.fromX<0||root.fromY<0||root.fromX>world.width||root.fromY>world.height)throw new Error('Invalid joined route root recipe');
      }
      const key=TerrainNavigation.routeKey(recipe.key,recipe.radius,recipe.ignore);if(keys.has(key))throw new Error('Duplicate movement route');keys.add(key);
    }
  }
}
class CombatComponent{
  static stateContract=new StateContract({cooldownUntil:0,attackCooldownPhase:0,attackArcTargetId:null,attackArcUntilTick:0,attackWindupUntil:0,attackWindupStartedAt:0,attackWindupTargetId:null,attackWindupIsBuilding:false,moveRecoveryUntil:0,hitBurstCooldownUntil:0,recentImpactUntil:0},{presentation:["attackArcTargetId","attackArcUntilTick"],derived:["lastTimerTick"],view:["attackArcTargetId","attackArcUntilTick"]});
  constructor(state={}){Object.assign(this,CombatComponent.stateContract.create(state))}
  cooldownActive(sim){return sim.tick<(Number(this.cooldownUntil)||0)}
  windupPending(){return (Number(this.attackWindupUntil)||0)>0}
  moveRecoveryActive(sim){return sim.tick<(Number(this.moveRecoveryUntil)||0)}
  recordImpact(sim,ticks){this.recentImpactUntil=sim.tick+Math.max(0,ticks)-(this.lastTimerTick===sim.tick?0:1)}
  recentlyImpacted(sim){return sim.tick<(Number(this.recentImpactUntil)||0)}
  windupElapsedTicks(sim){return Math.max(0,sim.tick-(Number(this.attackWindupStartedAt)||sim.tick))}
}
export { CombatComponent, MovementComponent, StateContract, StateValue, StatusComponent };
