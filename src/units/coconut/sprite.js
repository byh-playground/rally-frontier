// The coconut: a ball that rolls. Only the shell turns; the shade and the face stay upright on it.
// The coconut has its own sheet (assets/sprites/coconut) and shares the walnut's ball renderer and cells
// (src/units/walnut/sprite.js); this file keeps only the rolling body's per-frame art.
import { GRAIN_SPRITE_BASE_SCALE, UNIT_RENDER_RADIUS_SCALE } from '../baseline.js';
import { Coconut } from './index.js';
import { FP } from '../../core/config.js';
import {
    BALL_RADIUS,
    ballArtScale,
    ballSpriteLoader,
    WalnutSpriteRenderer,
    walnutSpritePortrait,
} from '../walnut/sprite.js';

const loadCoconutSpriteCanvas = ballSpriteLoader(
    new URL('../../../assets/sprites/coconut/', import.meta.url),
    '코코넛',
);

const COCONUT_ART_SCALE = ballArtScale(Coconut.unit.size);
// The shell's rolling radius in world units: θ grows by the distance travelled over this.
const ROLL_RADIUS =
    Coconut.unit.size *
    UNIT_RENDER_RADIUS_SCALE *
    GRAIN_SPRITE_BASE_SCALE *
    Coconut.visual.visualScale ** 2 *
    COCONUT_ART_SCALE *
    BALL_RADIUS;

// Speed stage from s = speed / top speed, with lower thresholds on the way down.
function coconutSpeedStage(previous, s) {
    if (previous === 2) return s >= 0.7 ? 2 : s >= 0.35 ? 1 : 0;
    if (previous === 1) return s >= 0.75 ? 2 : s >= 0.35 ? 1 : 0;
    return s >= 0.75 ? 2 : s >= 0.4 ? 1 : 0;
}

// The rolling body's art for this frame (sprite contract `rolling`, RollingBody). The shell turns with
// the distance the drawn body travels (θ += heading·Δd/R), so pause and replay show the frame they were
// left on. Speed stage, face, stretch, wall squash and the impact star follow the simulation's
// velocity and its last bump and wall ticks. `orientation` is -1 when the view is mirrored (guest).
function prepareRolling(grain, entity, world, renderTick, now, tps, orientation) {
    const spec = Coconut.unit.rolling,
        roll = grain.actor.roll,
        m = entity.impactMotion,
        vx = (m?.vxFP || 0) / FP,
        vy = (m?.vyFP || 0) / FP,
        s = Math.min(1, Math.hypot(vx, vy) / spec.topSpeed);
    const state = (grain.actor.track ||= {
        x: world.x,
        z: world.z,
        heading: 1,
        stage: 0,
        impactTick: null,
        impactHeading: 1,
        impactWall: false,
    });
    if (Math.abs(vx) > 1) state.heading = Math.sign(vx) * orientation;
    const travelled = Math.hypot(world.x - state.x, world.z - state.z);
    // A jump (seek, snap) is not rolling.
    if (travelled < 60) roll.theta += (state.heading * travelled) / ROLL_RADIUS;
    state.x = world.x;
    state.z = world.z;
    state.stage = coconutSpeedStage(state.stage, s);
    const bump = entity.rolling?.bumpTick ?? null,
        wall = entity.rolling?.wallTick ?? null,
        latest = Math.max(bump ?? -1, wall ?? -1);
    if (latest >= 0 && latest !== state.impactTick && renderTick >= latest) {
        // The star sits on the side the coconut was moving toward when it struck.
        state.impactTick = latest;
        state.impactWall = latest === wall && latest !== bump;
        state.impactHeading = roll.heading;
    }
    const sinceImpact = state.impactTick === null ? Infinity : renderTick - state.impactTick;
    roll.heading = state.heading;
    roll.stage = state.stage;
    roll.scaleX = 1 + 0.1 * s * s;
    roll.scaleY = 1 - 0.085 * s * s;
    roll.squash = state.impactWall ? Math.min(1, Math.max(0, 1 - sinceImpact / 2.5)) : 0;
    roll.impact =
        sinceImpact >= 0 && sinceImpact < 0.25 * tps
            ? {
                  age: sinceImpact / (0.25 * tps),
                  side: state.impactHeading * state.heading,
                  wall: state.impactWall,
              }
            : null;
    roll.face =
        sinceImpact >= 0 && sinceImpact < 0.3 * tps
            ? 'bump'
            : grain.hitUntil > now
              ? 'hurt'
              : ['neutral', 'happy', 'rush'][state.stage];
    // Mirrored toward the travel direction; the ground contact stays on the unit's ground point.
    if (state.heading < 0) {
        grain.matrix[0] = -grain.matrix[0];
        grain.matrix[1] = -grain.matrix[1];
    }
}

// This unit's sprite contract (src/units/define-unit.js), loaded only by the page, never the Worker.
// `rolling` is the self-propelled rolling body's per-frame art (RollingBody); drawBehind draws the dust
// and wind behind the ball. The shared loader gives both cards one canvas.
export const SPRITE = Object.freeze({
    load: loadCoconutSpriteCanvas,
    renderer: WalnutSpriteRenderer,
    portrait: walnutSpritePortrait,
    shell: { draw: 'drawAmmo', depthTest: true },
    groundY: 0,
    artScale: COCONUT_ART_SCALE,
    rolling: Object.freeze({ prepare: prepareRolling }),
});
