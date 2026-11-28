import { FP } from '../core/config.js';
import { HashUtil } from '../sim/map-generation.js';
import { EffectObjectFactory } from './presentation-effects.js';

const IMPACT_MS = 540;
const IMPACT_RING_MS = 190;
const CIRCLE_SEGMENTS = 32;
const FADE_IN_MS = 110;
const FADE_OUT_MS = 280;
const SURFACE_BIAS = 0.0009;

const HUSK = [0.95, 0.62, 0.18];
const PIT = [1, 0.91, 0.62];
const STAIN = [0.43, 0.46, 0.13];
const HAZE = [0.8, 0.78, 0.29];
const WISP = [0.69, 0.76, 0.28];
const FRIENDLY_EDGE = [0.58, 0.48, 0.13];
const HOSTILE_EDGE = [0.58, 0.25, 0.13];
const GROUND_ARC = Array.from({ length: CIRCLE_SEGMENTS + 1 }, (_, step) => {
    const angle = (step * Math.PI * 2) / CIRCLE_SEGMENTS;
    return [Math.cos(angle), Math.sin(angle)];
});

function groundPoint(renderer, x, z, y) {
    const world = { x, y, z, groundY: y },
        point = renderer.projectRenderWorldPosition(world);
    // Bridge decks sit on their own occluding layer, including the row depth of objects on them.
    point.depth = renderer.spriteDepthForWorld(world, SURFACE_BIAS);
    return point;
}

// The footprint comes from authoritative clouds, while the pulp and pit are a short cosmetic impact.
// Keep expired samples until the delayed render clock reaches their expiry, including in replays.
export class GinkgoLook {
    #clouds = new Map();
    #visible = [];
    #impacts = [];
    #matrix = new Float32Array(6);

    reset() {
        this.#clouds.clear();
        this.#visible.length = 0;
        this.#impacts.length = 0;
    }

    observe(clouds) {
        for (const cloud of clouds || []) {
            if (!this.#clouds.has(cloud.id))
                this.#clouds.set(cloud.id, {
                    ...cloud,
                    phase: (HashUtil.hash(String(cloud.id)) % 256) / 256,
                });
        }
    }

    impact(event, clock) {
        if (clock.ageMs >= IMPACT_MS) return;
        const hit = { ...event, phase: (HashUtil.hash(String(event.projectileId)) % 256) / 256 };
        EffectObjectFactory.attachClock(hit, clock, IMPACT_MS);
        this.#impacts.push(hit);
    }

    drawGround(renderer, timeMs, stepMs) {
        if (!Number.isFinite(timeMs)) return;
        const visible = this.#visible;
        visible.length = 0;
        for (const [id, cloud] of this.#clouds) {
            const end = cloud.endTick * stepMs;
            if (timeMs >= end) {
                this.#clouds.delete(id);
                continue;
            }
            const age = timeMs - cloud.startTick * stepMs;
            if (age < 0 || !renderer.onScreenAuth(cloud.x, cloud.y, cloud.radius)) continue;
            if (!renderer.visibleRaw(cloud.x, cloud.y)) continue;
            cloud.age = age;
            cloud.fade = Math.min(1, 0.38 + age / FADE_IN_MS, (end - timeMs) / FADE_OUT_MS);
            visible.push(cloud);
        }
        if (!visible.length && !this.#impacts.length) return;
        const depth = renderer._renderDepth;
        for (const cloud of visible) this.#drawCloud(renderer, cloud, visible);
        this.#drawImpactRings(renderer);
        renderer.setRenderDepth(depth);
    }

    #drawImpactRings(renderer) {
        const surfaces = renderer.world.terrain.surfaces;
        for (const hit of this.#impacts) {
            const age = hit.clock.ageMs;
            if (hit.clock.expired || age < 0 || age >= IMPACT_RING_MS) continue;
            if (
                !renderer.onScreenAuth(hit.x, hit.y, hit.radius) ||
                !renderer.visibleRaw(hit.x, hit.y)
            )
                continue;
            const t = age / IMPACT_RING_MS,
                height = surfaces.heightAt(hit.x, hit.y),
                point = groundPoint(renderer, hit.x, hit.y, height);
            renderer.setRenderDepth(point.depth);
            renderer.drawGroundCircle(hit.x, hit.y, hit.radius * (0.45 + 0.55 * Math.sqrt(t)), {
                elevation: height,
                stroke: [...PIT, 0.78 * (1 - t)],
                width: Math.max(1.2, 2.1 * renderer.sc()),
                segments: 20,
            });
        }
    }

    #drawCloud(renderer, cloud, others) {
        const { x, y, radius, level, zFP, side, phase, fade, age } = cloud,
            elevation = zFP / FP,
            overlaps = (other) =>
                level === other.level &&
                (other.x - x) ** 2 + (other.y - y) ** 2 < (other.radius + radius) ** 2,
            neighbors = others.filter(overlaps);
        // All discs covering a shared point intersect one another. Weighting by that count
        // keeps the tint translucent even when a whole volley hits the same area at once.
        const share = fade / neighbors.length,
            fill = [...STAIN, 0.24 * share],
            haze = [...HAZE, 0.36 * fade],
            wisp = [...WISP, 0.66 * fade],
            edge = [...(renderer.isFriendlySide(side) ? FRIENDLY_EDGE : HOSTILE_EDGE), 0.78 * fade],
            surfaces = renderer.world.terrain.surfaces,
            occupies = (atX, atY) =>
                atX >= 0 &&
                atY >= 0 &&
                atX <= renderer.world.width &&
                atY <= renderer.world.height &&
                (level == null || surfaces.levelAt(atX, atY) === level),
            place = (atX, atY, height) => groundPoint(renderer, atX, atY, height),
            center = place(x, y, elevation),
            width = Math.max(1, 1.8 * renderer.sc());
        let previous = null;
        for (const [dx, dy] of GROUND_ARC) {
            let limit = radius;
            if (!occupies(x + dx * limit, y + dy * limit)) {
                // Stop the footprint at an adjacent terrace or board edge.
                let inner = 0;
                for (let i = 0; i < 5; i++) {
                    const next = (inner + limit) / 2;
                    if (occupies(x + dx * next, y + dy * next)) inner = next;
                    else limit = next;
                }
                limit = inner;
            }
            const wx = x + dx * limit,
                wy = y + dy * limit,
                at = place(wx, wy, surfaces.heightAt(wx, wy));
            if (previous) {
                // Ground marks use per-row depth, so they sit on the valley floor as well as high ground.
                for (const point of [center, previous.at, at]) {
                    renderer.setRenderDepth(point.depth);
                    renderer.v(point.x, point.y, fill);
                }
                const midX = (wx + previous.wx) / 2,
                    midY = (wy + previous.wy) / 2;
                if (
                    !neighbors.some(
                        (other) =>
                            other !== cloud &&
                            (other.x - midX) ** 2 + (other.y - midY) ** 2 < (other.radius - 1) ** 2,
                    )
                ) {
                    renderer.setRenderDepth(Math.min(previous.at.depth, at.depth));
                    renderer.line(previous.at.x, previous.at.y, at.x, at.y, width, edge);
                }
            }
            previous = { at, wx, wy };
        }
        // One plume represents a locally stacked cloud. More overlapping shots widen the reach
        // of the perimeter, but cannot flood a single target with repeated foreground haze.
        if (
            neighbors.some(
                (other) =>
                    other !== cloud &&
                    other.fade >= 0.45 &&
                    (other.x - x) ** 2 + (other.y - y) ** 2 < (radius * 0.66) ** 2 &&
                    (other.startTick < cloud.startTick ||
                        (other.startTick === cloud.startTick && other.id < cloud.id)),
            )
        )
            return;
        // Low wavy bands and uneven patches read as drifting odour, with the area boundary still fixed.
        for (let i = 0; i < 2; i++) {
            const angle = (phase + i / 2) * Math.PI * 2 + age * 0.00065,
                atX = x + Math.cos(angle) * radius * 0.29,
                atY = y + Math.sin(angle) * radius * 0.29;
            if (!occupies(atX, atY)) continue;
            const cloudSize = radius * (0.43 + 0.05 * Math.sin(age * 0.004 + i * 2));
            const height = surfaces.heightAt(atX, atY),
                point = place(atX, atY, height);
            renderer.setRenderDepth(point.depth);
            renderer.drawGroundCircle(atX, atY, cloudSize, {
                fill: haze,
                elevation: height,
                segments: 12,
            });
            let last = null;
            for (let j = 0; j <= 6; j++) {
                const drift = j / 6 - 0.5,
                    wx = atX + drift * cloudSize,
                    wy = atY + Math.sin(j * 0.85 + age * 0.008 + i * 0.8) * cloudSize * 0.22;
                if (!occupies(wx, wy)) {
                    last = null;
                    continue;
                }
                const p = place(wx, wy, surfaces.heightAt(wx, wy) + 8 + j * 2.4);
                if (last) {
                    renderer.setRenderDepth(Math.min(last.depth, p.depth));
                    renderer.line(
                        last.x,
                        last.y,
                        p.x,
                        p.y,
                        Math.max(1, width * (1.1 - j * 0.05)),
                        wisp,
                    );
                }
                last = p;
            }
        }
    }

    drawImpacts(renderer) {
        if (!this.#impacts.length) return;
        const context = renderer.vectorContext,
            scale = renderer.sc();
        context.depthTest = !!renderer.passState.depthEnabled;
        context.depthWrite = false;
        context.depthFunc = renderer.passState.depthFunc || 'lequal';
        let write = 0;
        for (const hit of this.#impacts) {
            const age = hit.clock.ageMs;
            if (hit.clock.expired || age >= IMPACT_MS) continue;
            this.#impacts[write++] = hit;
            if (
                age < 0 ||
                !renderer.onScreenAuth(hit.x, hit.y, hit.radius) ||
                !renderer.visibleRaw(hit.x, hit.y)
            )
                continue;
            const t = age / IMPACT_MS,
                art = renderer.spriteRenderers[hit.sourceType],
                direction = hit.phase * Math.PI * 2,
                opacity = Math.min(1, (1 - t) * 2.2);
            for (let i = 0; i < 5; i++) {
                const angle = direction + (i * Math.PI * 2) / 5,
                    distance = Math.min(hit.radius || 50, 38) * Math.sqrt(t),
                    height = Math.sin(Math.PI * t) * (8 + (i % 3) * 4);
                this.#piece(
                    renderer,
                    art,
                    hit,
                    'husk',
                    angle,
                    distance,
                    height,
                    Math.max(2.5, 6.5 * scale),
                    angle + t * 3,
                    opacity,
                );
            }
            // One hard pale pit rolls out of the yellow pulp. No second hit is implied by its tiny skip.
            this.#piece(
                renderer,
                art,
                hit,
                'pit',
                direction + 0.3,
                3 + 19 * t,
                1 + Math.sin(Math.PI * t) * 10,
                Math.max(3, 11 * scale),
                direction + t * 2.4,
                opacity,
            );
        }
        this.#impacts.length = write;
        context.flush('ginkgo-impact');
        if (renderer.frame.length) {
            renderer.flush(renderer.frame, true);
            renderer.begin();
        }
        context.depthTest = false;
        context.depthFunc = 'lequal';
    }

    #piece(renderer, art, hit, kind, direction, distance, lift, size, angle, alpha) {
        const x = hit.x + Math.cos(direction) * distance,
            z = hit.y + Math.sin(direction) * distance,
            groundY = renderer.world.terrain.surfaces.heightAt(x, z),
            world = { x, z, y: Math.max(groundY, (hit.zFP || 0) / FP) + lift, groundY },
            p = renderer.projectRenderWorldPosition(world),
            depth = renderer.spriteDepthForWorld(world),
            cos = Math.cos(angle) * size,
            sin = Math.sin(angle) * size;
        const matrix = this.#matrix;
        matrix[0] = cos;
        matrix[1] = sin;
        matrix[2] = -sin;
        matrix[3] = cos;
        matrix[4] = p.x;
        matrix[5] = p.y;
        const draw = kind === 'pit' ? art?.drawPit : art?.drawHusk;
        if (draw) draw.call(art, this.#matrix, depth, alpha);
        else
            renderer.withWorldSpriteDepth(world, () =>
                renderer.circle(p.x, p.y, size / 2, [...(kind === 'pit' ? PIT : HUSK), alpha], 7),
            );
    }
}
