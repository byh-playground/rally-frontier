// Building definitions: each side's main base and the outposts spawned on captured points.
class BuildingDefinition{
  static all={
  base:{name:"메인 거점",showsFactionPennant:true,visualCategory:"base",isMainBase:true,hp:2400,size:55,sight:475},
  outpost:{name:"전진 거점",showsFactionPennant:true,visualCategory:"outpost",isOutpost:true,construction:{cost:75,workRequired:375,initialHpRatio:.1},hp:1400,size:45,sight:425,canAttackGround:true,range:250,atk:10,cooldownMs:1000,damageClass:"normal",attackVisual:{travel:"hitscan",impact:"light"}},
};
  static get(type){return this.all[type]||null}
  static isMainBase(type){return !!this.get(type)?.isMainBase}
  static byRole=Object.freeze({mainBase:"base",outpost:"outpost"});
  static forRole(role){return this.byRole[role]||null}
}

export { BuildingDefinition };
