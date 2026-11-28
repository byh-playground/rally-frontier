import { FP } from '../core/config.js';
import { HashUtil } from '../sim/map-generation.js';
import { EffectObjectFactory } from './presentation-effects.js';

const IMPACT_MS = 340;
const TRAIL = Object.freeze([0.72, 0.84, 0.31]);
const ACID = '#b9d64f';
const GLOW = '#f4f3a0';
const EDGE = '#425832';
const BADGE_W = 20;
const BADGE_H = 13;

// The impact bursts over the contact point. Bubbles and the badge follow the sampled
// unit and only last as long as at least one authoritative mark remains there.
export class PlumLook {
    static trail = TRAIL;

    #impacts = [];

    reset() {
        this.#impacts.length = 0;
    }

    impact(event, clock) {
        if (clock.ageMs >= IMPACT_MS) return;
        const impact = {
            ...event,
            angle: ((HashUtil.hash(String(event.projectileId)) % 256) * Math.PI) / 128,
        };
        EffectObjectFactory.attachClock(impact, clock, IMPACT_MS);
        this.#impacts.push(impact);
    }

    drawImpacts(renderer, ctx) {
        if (!this.#impacts.length) return;
        const surfaces = renderer.world.terrain.surfaces,
            scale = renderer.sc();
        let write = 0;
        ctx.save();
        for (const impact of this.#impacts) {
            const age = impact.clock.ageMs;
            if (impact.clock.expired || age >= IMPACT_MS) continue;
            this.#impacts[write++] = impact;
            const { x, y, radius, angle } = impact;
            if (age < 0 || !renderer.onScreenAuth(x, y, radius) || !renderer.visibleRaw(x, y))
                continue;
            const t = age / IMPACT_MS,
                groundY = surfaces.heightAt(x, y),
                height = Math.max(groundY, (impact.zFP || 0) / FP),
                level = surfaces.levelAt(x, y);

            // A short bright wet splat, followed by small separated drops.
            const p = renderer.projectRenderWorldPosition({ x, z: y, y: height, groundY });
            ctx.globalAlpha = 0.8 * (1 - t);
            ctx.fillStyle = ACID;
            ctx.beginPath();
            ctx.ellipse(
                p.x,
                p.y,
                Math.max(2, (3 + 13 * t) * scale),
                Math.max(1, (2 + 5 * t) * scale),
                0,
                0,
                Math.PI * 2,
            );
            ctx.fill();
            for (let i = 0; i < 6; i++) {
                const direction = angle + (i * Math.PI) / 3,
                    distance = Math.min(radius, 35) * Math.sqrt(t) * (i % 2 ? 1 : 0.68),
                    wx = x + Math.cos(direction) * distance,
                    wy = y + Math.sin(direction) * distance;
                if (surfaces.levelAt(wx, wy) !== level || !renderer.visibleRaw(wx, wy)) continue;
                const elevation = surfaces.heightAt(wx, wy),
                    lift = (12 + (i % 3) * 4) * Math.sin(Math.PI * t),
                    drop = renderer.projectRenderWorldPosition({
                        x: wx,
                        z: wy,
                        y: Math.max(elevation, height - 20 * t) + lift,
                        groundY: elevation,
                    }),
                    size = Math.max(1.25, (3.6 - t * 1.8) * scale);
                this.#bubble(ctx, drop.x, drop.y, size);
            }
        }
        this.#impacts.length = write;
        ctx.restore();
    }

    drawMarks(renderer, ctx, pixelRatio) {
        const now = renderer.presentationNow(),
            timeMs = renderer.renderState.frame(now)?.timeMs,
            tick = timeMs / renderer.presentationTargetIntervalMs(),
            tracked = renderer.renderState.displayed('plumUnits', now);
        if (!tracked.length || !Number.isFinite(tick)) return;
        const width = BADGE_W * pixelRatio,
            height = BADGE_H * pixelRatio;
        ctx.save();
        ctx.font = `800 ${10 * pixelRatio}px system-ui, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        for (const unit of tracked) {
            if (
                !unit.alive ||
                (unit.side !== renderer.mySide() && !renderer.visibleRaw(unit.x, unit.y))
            )
                continue;
            const model = renderer.renderState.model('unit', unit.id, now),
                expires = model?.plumExpires;
            let count = 0;
            for (const expiry of expires || []) if (expiry > tick) count++;
            if (!count) continue;
            const mounted = renderer.mountedUnitIds.has(unit.id),
                anchor = mounted
                    ? renderer.mountedUnitAnchors.get(unit.id)
                    : renderer.projectEntityScreen(unit),
                radius = renderer.unitRenderRadius(unit);
            if (
                !anchor ||
                anchor.x < -radius ||
                anchor.x > renderer.fxCanvas.width + radius ||
                anchor.y < -radius ||
                anchor.y > renderer.fxCanvas.height + radius
            )
                continue;

            // The bubbles sit against the sides of the shell, below its health bar.
            for (let i = 0; i < 3; i++) {
                const age = (timeMs * 0.0015 + i * 0.39) % 1,
                    side = i === 1 ? -1 : 1,
                    size = Math.max(1.25 * pixelRatio, radius * 0.13);
                ctx.globalAlpha = Math.min(1, age * 6, 3 * (1 - age));
                this.#bubble(
                    ctx,
                    anchor.x + side * radius * (0.65 + i * 0.17),
                    anchor.y - radius * (0.35 + age * 1.05),
                    size * (0.65 + age * 0.45),
                );
            }
            ctx.globalAlpha = 1;
            const badge = this.#placeBadge(renderer, anchor, radius, width, height, pixelRatio);
            if (badge) this.#badge(ctx, badge, anchor, radius, width, height, pixelRatio, count);
        }
        ctx.restore();
    }

    #placeBadge(renderer, anchor, radius, width, height, pixelRatio) {
        const offset = Math.max(15 * pixelRatio, radius) + 2 * pixelRatio,
            top = anchor.y - radius * 2.15 - 5 * pixelRatio;
        // Bars have already reserved their cells. Side placement keeps the damage fly-up centred.
        for (const col of [0, 1])
            for (const row of [0, 1, -1, 2, -2])
                for (const side of [1, -1]) {
                    const reach = offset + col * (width + 3 * pixelRatio),
                        x = anchor.x + side * reach - (side < 0 ? width : 0),
                        y = top + row * (height + 3 * pixelRatio);
                    if (
                        x < 0 ||
                        y < 0 ||
                        x + width > renderer.fxCanvas.width ||
                        y + height > renderer.fxCanvas.height
                    )
                        continue;
                    if (renderer.worldHudSpace.place(x, y, width, height))
                        return { x, y, tether: col > 0 || Math.abs(row) > 1 };
                }
        return null;
    }

    #badge(ctx, { x, y, tether }, anchor, radius, width, height, pixelRatio, count) {
        if (tether) {
            const outward = x >= anchor.x ? 1 : -1;
            ctx.beginPath();
            ctx.moveTo(anchor.x + outward * radius * 0.85, anchor.y - radius * 1.45);
            ctx.lineTo(x + (outward < 0 ? width : 0), y + height / 2);
            ctx.strokeStyle = 'rgba(208,228,131,.54)';
            ctx.lineWidth = pixelRatio;
            ctx.stroke();
        }
        ctx.beginPath();
        ctx.roundRect(x, y, width, height, 4 * pixelRatio);
        ctx.fillStyle = '#283a23';
        ctx.fill();
        ctx.strokeStyle = count === 5 ? '#e9e785' : '#b8ce70';
        ctx.lineWidth = pixelRatio;
        ctx.stroke();

        const dx = x + 5.5 * pixelRatio,
            dy = y + 7 * pixelRatio;
        ctx.beginPath();
        ctx.moveTo(dx, dy - 3.65 * pixelRatio);
        ctx.quadraticCurveTo(
            dx + 5 * pixelRatio,
            dy + 2.75 * pixelRatio,
            dx,
            dy + 2.75 * pixelRatio,
        );
        ctx.quadraticCurveTo(
            dx - 5 * pixelRatio,
            dy + 2.75 * pixelRatio,
            dx,
            dy - 3.65 * pixelRatio,
        );
        ctx.closePath();
        ctx.fillStyle = ACID;
        ctx.fill();
        ctx.fillStyle = '#fff8db';
        ctx.fillText(String(count), x + 13.5 * pixelRatio, y + height / 2 + 0.5 * pixelRatio);
    }

    #bubble(ctx, x, y, size) {
        ctx.fillStyle = ACID;
        ctx.strokeStyle = EDGE;
        ctx.lineWidth = Math.max(0.7, size * 0.28);
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = GLOW;
        ctx.beginPath();
        ctx.arc(x - size * 0.22, y - size * 0.29, size * 0.36, 0, Math.PI * 2);
        ctx.fill();
    }
}
