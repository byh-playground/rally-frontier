// Artillery contact and deployment policy. Distances/seconds are world units; authority stores FP integers.
class LaunchImpactRules{
  static launchHeight=60;
  static muzzleReach=38;
  static gravity=1000;
  static recoveryMs=250;
  static deploymentGapMs=50;
  static deploymentRetryMs=100;
  static deploymentSpeed=250;
  static deploymentLift=250;
  static knockbackSpeed=400;
  static knockbackLift=250;
  static projectileRadius=10;
  // Integer-quantized parabola shared by collision and presentation, including the physical muzzle height.
  static flightHeight(progress,arcHeight){
    const t=Math.max(0,Math.min(10000,Math.round(progress*10000))),remaining=10000-t;
    return Math.round((4*Math.round(arcHeight*100)*t*remaining+this.launchHeight*100*remaining*remaining)/100000000)/100;
  }
}
export { LaunchImpactRules };
