// Interpolated render tracks: which sim fields the presentation samples per entity kind.
import { RallyGamekit } from '../core/gamekit.js';

// Full UI snapshots stay at 10 Hz. Presentation targets are fed directly from the
// local authoritative sim at the selected SIM TPS without cloning sim.snapshot().
// Game-owned visual fields; the SDK owns sampling and display lifetime.
const RenderField = RallyGamekit.RenderObject;
class UnitRenderObject extends RenderField {
    static renderSchema = {
        tick: RenderField.LINEAR,
        'entity.impactMotion.heightFP': RenderField.LINEAR,
        'entity.heroRoll.distance': RenderField.LINEAR,
        'entity.fruitAttack': RenderField.STEP,
        ...Object.fromEntries(
            [
                'kind',
                'startTick',
                'endTick',
                'recoverUntilTick',
                'vzFP',
                'vxFP',
                'vyFP',
                'originX',
                'originY',
                'sourceId',
            ].map((k) => ['entity.impactMotion.' + k, RenderField.STEP]),
        ),
        'delta.x': RenderField.STEP,
        'delta.y': RenderField.STEP,
        'entity.x': RenderField.POSITION_X,
        'entity.y': RenderField.POSITION_Y,
        ...Object.fromEntries(
            [
                'target',
                'attackFlash',
                'hitFlash',
                'combat.attackArcTargetId',
                'combat.attackArcUntilTick',
                'combat.attackWindupUntil',
                'combat.attackWindupStartedAt',
                'combat.attackWindupTargetId',
                'combat.attackWindupTargetKind',
                'combat.burstAttack',
                'combat.basicAttackTick',
                'combat.lobLaunchTick',
                'combat.thornLaunchTick',
                'combat.thornAimX',
                'combat.cooldownUntil',
                'constructionWork.targetId',
                'constructionWork.phase',
                'constructionWork.phaseStartedAtTick',
                'constructionWork.phaseEndsAtTick',
                'constructionWork.cycleStartedAtTick',
                'constructionWork.nextHitTick',
                'constructionWork.lastHitTick',
                'spinAttack.startTick',
                'spinAttack.activeStartTick',
                'spinAttack.activeEndTick',
                'spinAttack.endTick',
                'heroRoll.phase',
                'heroRoll.phaseStartTick',
                'heroRoll.phaseEndTick',
                'heroRoll.dx',
                'heroRoll.dy',
                'selfDestruct.phase',
                'selfDestruct.startTick',
                'selfDestruct.endTick',
                'cannonTick',
            ].map((k) => ['entity.' + k, RenderField.STEP]),
        ),
    };
}
class ThornRenderObject extends RenderField {
    static renderSchema = {
        tick: RenderField.LINEAR,
        'entity.x': RenderField.POSITION_X,
        'entity.y': RenderField.POSITION_Y,
        'entity.zFP': RenderField.LINEAR,
        ...Object.fromEntries(
            ['side', 'fromFx', 'fromFy', 'fromZFP', 'toFx', 'toFy', 'toZFP', 'retiredTick'].map(
                (k) => ['entity.' + k, RenderField.STEP],
            ),
        ),
    };
}
class ProjectileRenderObject extends RenderField {
    static renderPath = { x: 'entity.x', y: 'entity.y', durationMs: 250, maxPoints: 32 };
    static renderSchema = {
        tick: RenderField.LINEAR,
        'entity.x': RenderField.POSITION_X,
        'entity.y': RenderField.POSITION_Y,
        ...Object.fromEntries(
            [
                'launchX',
                'launchY',
                'lockedAimX',
                'lockedAimY',
                'trajectoryPolicy',
                'impactAtAimPoint',
                'target',
                'targetLost',
                'aimOffsetX',
                'aimOffsetY',
                'arcHeight',
            ].map((k) => ['entity.' + k, RenderField.STEP]),
        ),
    };
}
// Soldier lob projectiles carry their simulated absolute altitude. They must not
// reuse the deployment shell's reconstructed, fixed launch-to-target parabola.
class UnitLobRenderObject extends RenderField {
    static renderSchema = {
        tick: RenderField.LINEAR,
        'entity.x': RenderField.POSITION_X,
        'entity.y': RenderField.POSITION_Y,
        'entity.zFP': RenderField.LINEAR,
        ...Object.fromEntries(
            [
                'side',
                'sourceId',
                'sourceType',
                'grounded',
                'landedAtTick',
                'explodeTick',
                'retiredAtTick',
            ].map((k) => ['entity.' + k, RenderField.STEP]),
        ),
    };
}
class FlagRenderObject extends RenderField {
    static renderSchema = {
        tick: RenderField.LINEAR,
        'entity.x': RenderField.POSITION_X,
        'entity.y': RenderField.POSITION_Y,
        'entity.forced': RenderField.STEP,
    };
}
class BundleRenderObject extends RenderField {
    static renderSchema = {
        tick: RenderField.LINEAR,
        'entity.x': RenderField.POSITION_X,
        'entity.y': RenderField.POSITION_Y,
        'entity.heightFP': RenderField.LINEAR,
        ...Object.fromEntries(
            ['index', 'count', 'side', 'type', 'vzFP'].map((k) => [
                'entity.' + k,
                RenderField.STEP,
            ]),
        ),
    };
}
const RENDER_TRACKS = Object.freeze({
    bundle: { type: BundleRenderObject, snapDistance: 180 },
    unit: { type: UnitRenderObject, snapDistance: 120 },
    projectile: { type: ProjectileRenderObject, snapDistance: 180 },
    unitLob: { type: UnitLobRenderObject, snapDistance: 180 },
    thorn: { type: ThornRenderObject, snapDistance: 180 },
    flag: { type: FlagRenderObject, snapDistance: 80 },
});

export { RENDER_TRACKS };
