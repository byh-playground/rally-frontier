// How a dead unit is drawn. A unit that dies while knocked back stays in the simulation while it has impact
// motion (StrategySim.cleanupDeadEntities keeps it). While it flies and slides it looks like a living unit (its
// own colours, its species' hurt face, no team ring, only the ground shadow). Once it has (nearly) stopped it turns
// grey for `turnMs`, then stays grey while it fades out over `fadeMs`, and is no longer drawn. Presentation only:
// positions, motion and removal belong to the simulation, which keeps the body well past this (it drops it once
// its motion has fully settled).
import { FP } from '../core/config.js';

const DEAD_UNIT_LOOK = Object.freeze({
    // The species' own face (sprite contract drawFace): every species has an approved hurt face.
    face: 'hurt',
    // A corpse on the ground slower than this (world units per second) has stopped.
    landSpeed: 25,
    // Grey: every sprite quad of the body and face is drawn twice, as authored at `alpha`, then as a flat `wash`
    // silhouette (forceColor) at `washAlpha` on top. The wash greys any species colour, dark or saturated,
    // while the faint first pass keeps its outline and face readable.
    grey: Object.freeze({ alpha: 0.4, wash: Object.freeze([0.66, 0.67, 0.7, 1]), washAlpha: 0.7 }),
    // After stopping: the colour-to-grey turn, then the grey fade-out.
    turnMs: 100,
    fadeMs: 400,
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
    // The whole stopped-corpse look (turn, then fade).
    static get totalMs() {
        return DEAD_UNIT_LOOK.turnMs + DEAD_UNIT_LOOK.fadeMs;
    }
    // The paint of a corpse `ageMs` after it stopped, written into the caller's own record (no allocation).
    static paint(ageMs, out) {
        const { grey, turnMs, fadeMs } = DEAD_UNIT_LOOK,
            turn = Math.min(1, Math.max(0, ageMs / turnMs)),
            left = Math.min(1, Math.max(0, (ageMs - turnMs) / fadeMs)),
            // Eased so the grey stays readable for most of the fade and drops away at its end.
            fade = 1 - left * left;
        out.alpha = (1 + (grey.alpha - 1) * turn) * fade;
        out.wash = grey.wash;
        out.washAlpha = grey.washAlpha * turn * fade;
        return out;
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
