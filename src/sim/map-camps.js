// Neutral camp layout data. Camps only shape map placement and validation;
// the launch sim spawns no neutral units.
const NEUTRAL_SIDE=2;

class CampDefinition{
  static all={
  hounds:{minorNeutral:true,aggroRadius:200},
  boars:{minorNeutral:true,aggroRadius:200},
  toads:{minorNeutral:true,aggroRadius:200},
  crabs:{minorNeutral:true,aggroRadius:200},
  wasps:{minorNeutral:true,aggroRadius:200},
  objectiveBear:{mainObjective:true,aggroRadius:225},
  objectiveDeathWorm:{mainObjective:true,aggroRadius:225},
  objectiveDragon:{mainObjective:true,aggroRadius:225},
  relic:{aggroRadius:200},
};
  static get(id){return this.all[id]||null}
}

class NeutralCampPolicy{
  static neutralCampRequiredAreaGap(a,b,baseGap=40){
  // Ordinary hunting grounds stay clearly isolated from everything else. Strategic
  // objective territories may sit closer to one another by map design, but their
  // aggro circles still keep a positive physical gap instead of overlapping.
  return CampDefinition.get(a?.kind)?.minorNeutral||CampDefinition.get(b?.kind)?.minorNeutral
    ?Math.max(40,Number(baseGap)||40)
    :Math.max(20,Math.round((Number(baseGap)||40)/2));
}
}

export { CampDefinition, NEUTRAL_SIDE, NeutralCampPolicy };
