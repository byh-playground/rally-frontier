import { RallyGamekit } from '../core/gamekit.js';
import { ConstructionRules } from '../sim/construction-rules.js';

const PARTS = ['base', 'cradle', 'cradle-back', 'barrel', 'barrel-front', 'barrel-back'];
const EXCLUDE = Object.fromEntries(
    PARTS.map((part) => [part, new Set(PARTS.filter((other) => other !== part))]),
);
const TEAM = Object.freeze({
    team: [48 / 255, 122 / 255, 240 / 255],
    'team-light': [145 / 255, 199 / 255, 1],
    'team-shadow': [31 / 255, 85 / 255, 181 / 255],
});
const ENEMY = Object.freeze({
    team: [240 / 255, 69 / 255, 69 / 255],
    'team-light': [1, 158 / 255, 153 / 255],
    'team-shadow': [179 / 255, 47 / 255, 47 / 255],
});
const ART_SCALE = 90 / 360;
const matrixAt = (a, b, c, d, sx, sy, x, y) => [
    a,
    b,
    c,
    d,
    x - a * sx - c * sy,
    y - b * sx - d * sy,
];

// The same authored channel drives the actor and the projected muzzle. No independent VFX kick curve.
function recoilAt(age, asset) {
    const clip = asset.metadata.clips.fire;
    if (!(age >= 0 && age < clip.durationMs)) return 0;
    const keys = clip.keyframes;
    for (let i = 1; i < keys.length; i++) {
        if (age > keys[i].timeMs) continue;
        const a = keys[i - 1],
            b = keys[i],
            t = (age - a.timeMs) / (b.timeMs - a.timeMs);
        return a.parts.barrel.x + (b.parts.barrel.x - a.parts.barrel.x) * t;
    }
    return 0;
}

// One compiled SVG, independent ground/mount/shaft projections. The ground never turns or recoils.
// Shaft direction and reach match the simulation's physical muzzle origin.
// A near-facing shaft shows its bore, a far-facing shaft shows its closed rear cap instead.
class BuildingArt {
    constructor(renderer) {
        this.renderer = renderer;
        this.actors = new Map();
        this.liveIds = new Set();
    }
    static pose({ x, y, sc, aim, fireAgeMs = Infinity }, matrices = false) {
        const asset = globalThis.RallyVectorAssets?.cannon;
        if (!asset) throw new Error('Cannon vector asset is missing');
        const sockets = asset.metadata.sockets,
            GROUND = sockets.ground.point,
            TRUNNION = sockets.trunnion.point,
            MUZZLE = sockets.muzzle.point,
            BACK = sockets.breech.point;
        const length = Math.hypot(aim.dx, aim.dy),
            dx = length > 0 ? aim.dx / length : 1,
            dy = length > 0 ? aim.dy / length : 0;
        const scale = ART_SCALE * sc,
            ax = dx * scale,
            ay = dy * scale;
        // The cross section stays round while its end face narrows to an edge at a side-on yaw.
        const nx = -dy * scale,
            ny = dx * scale,
            faceWidth = Math.abs(dy) * 0.84;
        const pivot = {
            x: x + (TRUNNION[0] - GROUND[0]) * scale,
            y: y + (TRUNNION[1] - GROUND[1]) * scale,
        };
        const recoil = recoilAt(fireAgeMs, asset),
            along = (point) => ({
                x: pivot.x + ax * (point[0] - TRUNNION[0] + recoil) + nx * (point[1] - TRUNNION[1]),
                y: pivot.y + ay * (point[0] - TRUNNION[0] + recoil) + ny * (point[1] - TRUNNION[1]),
            });
        const muzzle = along(MUZZLE),
            back = along(BACK),
            muzzleEnd = along(sockets['muzzle-dir'].point),
            muzzleLength = Math.hypot(muzzleEnd.x - muzzle.x, muzzleEnd.y - muzzle.y) || 1;
        // Mount width varies with yaw; it remains upright and keeps its pin at the same trunnion.
        const mountScale = (dx < 0 ? -1 : 1) * (0.65 + 0.35 * Math.abs(dx)) * scale;
        return {
            muzzle,
            muzzleDir: {
                x: (muzzleEnd.x - muzzle.x) / muzzleLength,
                y: (muzzleEnd.y - muzzle.y) / muzzleLength,
            },
            trunnion: pivot,
            ground: { x, y },
            recoil,
            face: dy >= 0 ? 'barrel-front' : 'barrel-back',
            ...(matrices
                ? {
                      base: matrixAt(scale, 0, 0, scale, GROUND[0], GROUND[1], x, y),
                      cradle: matrixAt(
                          mountScale,
                          0,
                          0,
                          scale,
                          TRUNNION[0],
                          TRUNNION[1],
                          pivot.x,
                          pivot.y,
                      ),
                      barrel: matrixAt(ax, ay, nx, ny, TRUNNION[0], TRUNNION[1], pivot.x, pivot.y),
                      // The cap has a different affine map. Anchor its posed source centre so inherited recoil agrees with the shaft.
                      cap: matrixAt(
                          dx * faceWidth * scale,
                          dy * faceWidth * scale,
                          nx,
                          ny,
                          (dy >= 0 ? MUZZLE[0] : BACK[0]) + recoil,
                          (dy >= 0 ? MUZZLE : BACK)[1],
                          (dy >= 0 ? muzzle : back).x,
                          (dy >= 0 ? muzzle : back).y,
                      ),
                  }
                : {}),
            capVisible: faceWidth > 0.001,
        };
    }
    draw(building, options) {
        const r = this.renderer,
            source = globalThis.RallyVectorAssets?.cannon;
        if (!source) throw new Error('Cannon vector asset is missing');
        let actors = this.actors.get(building.id);
        if (!actors) {
            actors = Object.fromEntries(
                PARTS.map((part) => [
                    part,
                    RallyGamekit.createVectorActor(r.vectorContext, source, {
                        clip: 'idle',
                        startedAtMs: 0,
                    }),
                ]),
            );
            this.actors.set(building.id, actors);
        }
        const firing =
                options.fireAgeMs >= 0 && options.fireAgeMs < source.metadata.clips.fire.durationMs,
            clip = firing ? 'fire' : 'idle';
        const pose = BuildingArt.pose(options, true),
            context = r.vectorContext,
            paintRegions = options.own ? TEAM : ENEMY;
        const progress = building.construction
            ? ConstructionRules.progress(building.construction)
            : 1;
        const reveal = (start, end) => Math.max(0, Math.min(1, (progress - start) / (end - start)));
        const opacity = {
            base: reveal(0.15, 0.25),
            cradle: reveal(0.4, 0.5),
            barrel: reveal(0.7, 0.8),
        };
        const partOpacity = (part) =>
            part === 'base'
                ? opacity.base
                : part.startsWith('cradle')
                  ? opacity.cradle
                  : opacity.barrel;
        // Each fixed exclusion owns a pose row. Reusing one row for all parts forces a GPU pose pass on every draw.
        for (const part of PARTS) {
            if (partOpacity(part) <= 0) continue;
            if (
                (part === 'barrel-front' || part === 'barrel-back') &&
                (!pose.capVisible || part !== pose.face)
            )
                continue;
            const actor = actors[part];
            if (actor.currentClip !== clip) actor.play(clip, 0);
            actor.seek(firing ? options.fireAgeMs : 0);
            actor.preparePose({ excludeParts: EXCLUDE[part] });
        }
        context.preparePoses();
        if (r.frame.length) {
            r.flushVectorMesh('frame-to-cannon');
            r.flush(r.frame, true);
            r.begin();
        }
        const draw = (part, matrix) => {
            const alpha = partOpacity(part);
            if (alpha > 0)
                context.drawVectorActor(actors[part], {
                    matrix,
                    excludeParts: EXCLUDE[part],
                    paintRegions,
                    alpha,
                    depth: r._renderDepth ?? 0,
                    depthTest: !!r.passState.depthEnabled,
                    depthWrite: false,
                    depthFunc: r.passState.depthFunc || 'lequal',
                });
        };
        draw('base', pose.base);
        draw('cradle-back', pose.cradle);
        // The pin and wooden support move behind the shaft when its muzzle faces the viewer.
        if (options.aim.dy > 0) draw('cradle', pose.cradle);
        draw('barrel', pose.barrel);
        if (pose.capVisible) draw(pose.face, pose.cap);
        if (options.aim.dy <= 0) draw('cradle', pose.cradle);
        r.flushVectorMesh('cannon-art');
        return pose;
    }
    prune(buildings) {
        const ids = this.liveIds;
        ids.clear();
        for (const building of buildings) ids.add(building.id);
        for (const [id, actors] of this.actors)
            if (!ids.has(id)) {
                for (const actor of Object.values(actors)) actor.dispose();
                this.actors.delete(id);
            }
    }
    dispose() {
        for (const actors of this.actors.values())
            for (const actor of Object.values(actors)) actor.dispose();
        this.actors.clear();
        this.liveIds.clear();
    }
}

export { BuildingArt };
