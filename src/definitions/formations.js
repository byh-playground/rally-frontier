// Formation profiles.
import { UnitDefinition } from './units.js';

// Data-driven combat formation system. Units only select a profile; all tuning
// values live here so ratios / offsets / thresholds can be changed without
// editing simulation control flow.
class FormationDefinition{
  static profiles={
  surround:{
    strategy:"pairedFlank",
    contactPadding:8,
    cohort:{selfRadius:180,targetRadius:150,min:2},
    flank:{
      hashSalt:"surround",
      minOffset:36,
      maxOffset:72,
      targetRadiusScale:2.2,
      maxCostMultiplier:1.30
    }
  },
  threeBand:{
    strategy:"bands",
    fallbackProfile:"surround",
    kiteFallbackProfile:"surround",
    contactPadding:22,
    cohort:{selfRadius:180,targetRadius:150,min:2},
    activation:{enemyClusterMin:24,enemyClusterRadius:260,excludeTypes:["worker"]},
    bands:{
      slotCount:8,
      hashSalt:"dandelion-three-band",
      ratios:{left:.125,center:.75,right:.125},
      sideOffset:28,
      sideSpread:0,
      sideBackOffset:4,
      sideMaxCostMultiplier:1.12,
      centerSpread:12,
      centerBackOffset:0,
      centerMaxCostMultiplier:1.03
    }
  }
};
  static forUnit(type,ability=false){
    const d=UnitDefinition.get(type);
    if(!d?.formationProfile||d.formationRequiresAbility&&!ability)return "direct";
    return this.profiles[d.formationProfile]?d.formationProfile:"direct";
  }

  static validateFormationProfiles(){
    for(const [id,p] of Object.entries(FormationDefinition.profiles)){
      if(p.strategy!=="bands")continue;
      const r=p.bands?.ratios||{};
      const sum=(Number(r.left)||0)+(Number(r.center)||0)+(Number(r.right)||0);
      console.assert(sum>0&&Math.abs(sum-1)<.0001,`[RALLY] formation ${id} ratios must total 1.0`);
      console.assert((Number(p.bands?.slotCount)||0)>=1,`[RALLY] formation ${id} slotCount must be >= 1`);
    }
  }
}

FormationDefinition.validateFormationProfiles();

export { FormationDefinition };
