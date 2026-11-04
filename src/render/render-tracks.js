// Interpolated render tracks: which sim fields the presentation samples per entity kind.
import { RallyGamekit } from '../core/gamekit.js';

// Full UI snapshots stay at 10 Hz. Presentation targets are fed directly from the
// local authoritative sim at the selected SIM TPS without cloning sim.snapshot().
// Game-owned visual fields; the SDK owns sampling and display lifetime.
const RenderField=RallyGamekit.RenderObject;
class UnitRenderObject extends RenderField{
  static renderSchema={tick:RenderField.LINEAR,"delta.x":RenderField.STEP,"delta.y":RenderField.STEP,
    "entity.x":RenderField.POSITION_X,"entity.y":RenderField.POSITION_Y,
    ...Object.fromEntries(["target","attackFlash","combat.attackArcTargetId","combat.attackArcUntilTick","combat.attackWindupUntil","combat.cooldownUntil"].map(k=>["entity."+k,RenderField.STEP]))};
}
class ProjectileRenderObject extends RenderField{
  static renderSchema={tick:RenderField.LINEAR,
    "entity.x":RenderField.POSITION_X,"entity.y":RenderField.POSITION_Y,
    ...Object.fromEntries(["launchX","launchY","lockedAimX","lockedAimY","trajectoryPolicy","impactAtAimPoint",
      "target","targetLost","aimOffsetX","aimOffsetY","arcHeight"].map(k=>["entity."+k,RenderField.STEP]))};
}
class FlagRenderObject extends RenderField{
  static renderSchema={tick:RenderField.LINEAR,"entity.x":RenderField.POSITION_X,"entity.y":RenderField.POSITION_Y,"entity.forced":RenderField.STEP};
}
const RENDER_TRACKS=Object.freeze({
  unit:{type:UnitRenderObject,snapDistance:120},projectile:{type:ProjectileRenderObject,snapDistance:180},flag:{type:FlagRenderObject,snapDistance:80}
});

export { RENDER_TRACKS };
