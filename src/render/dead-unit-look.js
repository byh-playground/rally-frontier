// How a dead unit that is still flying is drawn. A unit that dies while knocked back stays in the simulation
// while it has impact motion (StrategySim.cleanupDeadEntities keeps it); until it lands the renderer draws it
// as a corpse: grey and see-through, its species' hurt face, no team ring. On landing it bursts (deathBurst)
// and is gone. Presentation only: positions, motion and removal belong to the simulation.
import { FP } from '../core/config.js';

const DEAD_UNIT_LOOK = Object.freeze({
    // The species' own face (sprite contract drawFace): every species has an approved hurt face.
    face: 'hurt',
    // Every sprite quad of the body and face is drawn twice: as authored at `alpha`, then as a flat `wash`
    // silhouette (forceColor) at `washAlpha` on top. The wash greys any species colour, dark or saturated,
    // while the faint first pass keeps its outline and face readable.
    paint: Object.freeze({ alpha: 0.4, wash: Object.freeze([0.66, 0.67, 0.7, 1]), washAlpha: 0.7 }),
    // A corpse on the ground slower than this (world units per second) has landed.
    landSpeed: 25,
});

class DeadUnitLook {
    // A dead unit the simulation still moves.
    static flying(unit) {
        return unit?.alive === false && !!unit.impactMotion;
    }
    // Its motion has come down to the ground and (nearly) stopped.
    static landed(motion) {
        const limit = DEAD_UNIT_LOOK.landSpeed * FP;
        return (
            !(motion.heightFP > 0) &&
            !(motion.vzFP > 0) &&
            (motion.vxFP || 0) ** 2 + (motion.vyFP || 0) ** 2 < limit * limit
        );
    }
}

// Draws one sprite renderer's quads with a unit paint (null: as authored). The renderer's `paint` is set by
// main.js only around a corpse's draw. The options record is the caller's own and is reused for the wash pass.
function drawUnitQuads(context, paint, options) {
    if (paint) {
        const alpha = options.alpha ?? 1;
        options.alpha = alpha * paint.alpha;
        context.drawQuads(options);
        options.color = paint.wash;
        options.alpha = alpha * paint.washAlpha;
        options.forceColor = true;
    }
    context.drawQuads(options);
}

export { DEAD_UNIT_LOOK, DeadUnitLook, drawUnitQuads };
