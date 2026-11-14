// The walnut's ball sheet: a shell, an upright shade and faces, plus the rolling art (dust, wind, spin arcs,
// impact star) the coconut borrows until its own art is approved (src/units/coconut/sprite.js).
// Every piece is an unposed atlas quad placed by its own matrix, built from the battlefield matrix
// (ground contact at the origin, sheet units, mirrored toward the travel direction).
import { GRAIN_SIZE } from '../baseline.js';
import { Walnut } from './index.js';
import { drawUnitQuads } from '../../render/dead-unit-look.js';

const ROOT = new URL('../../../assets/sprites/walnut/', import.meta.url);
const SHEET_SIZE = [900, 800];
// Shell radius, ball centre to ground contact, in sheet units.
export const BALL_RADIUS = 101;
// Ball diameter (205.5 with the outline) is 1.7 times a plain grain's standing height 343.5 (rice,
// size GRAIN_SIZE), at their sizes.
export const ballArtScale = (size) => ((1.7 * 343.5) / 205.5) * (GRAIN_SIZE / size);

// [x, y, w, h] / pivot inside the cell.
const CELLS = {
    shell: [
        [10, 10, 250, 250],
        [125, 125],
    ],
    shade: [
        [270, 10, 220, 220],
        [110, 110],
    ],
    arcs: [
        [500, 10, 280, 280],
        [140, 140],
    ],
    neutral: [
        [10, 300, 160, 80],
        [80, 40],
    ],
    happy: [
        [180, 300, 160, 80],
        [80, 40],
    ],
    rush: [
        [350, 300, 160, 80],
        [80, 40],
    ],
    bump: [
        [520, 300, 160, 80],
        [80, 40],
    ],
    hurt: [
        [690, 300, 160, 80],
        [80, 40],
    ],
    streaksMid: [
        [10, 400, 340, 220],
        [330, 110],
    ],
    streaksMax: [
        [360, 400, 530, 220],
        [520, 110],
    ],
    dustSlow: [
        [10, 630, 200, 70],
        [190, 60],
    ],
    dustMax: [
        [220, 630, 330, 160],
        [320, 140],
    ],
    impact: [
        [560, 630, 230, 160],
        [110, 90],
    ],
};
// The game's 'attack' face is the ball's rush.
const FACE_ALIAS = { attack: 'rush' };

async function readAsset(name) {
    const response = await fetch(new URL(name, ROOT), { cache: 'no-cache' });
    if (!response.ok) throw new Error('호두 스프라이트를 불러오지 못했습니다: ' + name);
    return response;
}

export async function loadWalnutSpriteCanvas() {
    const [manifest, bytes] = await Promise.all([
        readAsset('manifest.json').then((response) => response.json()),
        readAsset('parts.svg').then((response) => response.arrayBuffer()),
    ]);
    const spec = manifest?.assets?.['parts.svg'];
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
        value.toString(16).padStart(2, '0'),
    ).join('');
    if (manifest?.schemaVersion !== 1 || spec?.bytes !== bytes.byteLength || spec.sha256 !== hash)
        throw new Error('호두 SVG 무결성 오류');
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const [width, height] = SHEET_SIZE;
        if (image.naturalWidth !== width || image.naturalHeight !== height)
            throw new Error('호두 스프라이트 시트 크기가 다릅니다.');
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(image, 0, 0);
        return canvas;
    } finally {
        URL.revokeObjectURL(url);
    }
}

// The deck card: the resting ball turned a little, with its everyday dot-eye face, without speed effects.
export function walnutSpritePortrait(source, width) {
    const canvas = document.createElement('canvas'),
        scale = width / 330;
    canvas.width = width;
    canvas.height = Math.round(280 * scale);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 165 * scale, 250 * scale);
    const piece = (name) => {
        const [[x, y, w, h], [px, py]] = CELLS[name];
        ctx.drawImage(source, x, y, w, h, -px, -py, w, h);
    };
    ctx.translate(0, -BALL_RADIUS);
    ctx.save();
    ctx.rotate((-15 * Math.PI) / 180);
    piece('shell');
    ctx.restore();
    piece('shade');
    ctx.translate(14, 6);
    piece('neutral');
    return canvas.toDataURL('image/png');
}

// a·b for 2D affine matrices [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f.
function multiply(out, a, b) {
    const [a0, a1, a2, a3, a4, a5] = a;
    out[0] = a0 * b[0] + a2 * b[1];
    out[1] = a1 * b[0] + a3 * b[1];
    out[2] = a0 * b[2] + a2 * b[3];
    out[3] = a1 * b[2] + a3 * b[3];
    out[4] = a0 * b[4] + a2 * b[5] + a4;
    out[5] = a1 * b[4] + a3 * b[5] + a5;
    return out;
}
const local = (x, y, scaleX = 1, scaleY = 1, angle = 0) => {
    const cos = Math.cos(angle),
        sin = Math.sin(angle);
    return [cos * scaleX, sin * scaleX, -sin * scaleY, cos * scaleY, x, y];
};

export class WalnutSpriteRenderer {
    constructor(context, canvas) {
        this.context = context;
        this.actors = new Set();
        this.disposed = false;
        const region = context.device.textureAtlas.allocate(canvas.width, canvas.height, {
            filter: 'linear',
        });
        context.device.textureAtlas.upload(region, canvas);
        this.region = region;
        const build = (names, unit = 1) => {
            const uvRects = [],
                localRects = [];
            for (const name of names) {
                const [[x, y, w, h], [px, py]] = CELLS[name];
                uvRects.push(
                    (region.x + x) / region.atlas.width,
                    (region.y + y) / region.atlas.height,
                    w / region.atlas.width,
                    h / region.atlas.height,
                );
                localRects.push(-px / unit, -py / unit, w / unit, h / unit);
            }
            return {
                uvRects: Float32Array.from(uvRects),
                localRects: Float32Array.from(localRects),
            };
        };
        this.cells = Object.fromEntries(Object.keys(CELLS).map((name) => [name, build([name])]));
        // Cannon ammo: the resting ball, one shell width per matrix unit.
        this.ammo = build(['shell', 'shade', 'neutral'], 250);
        this.ammo.localRects[8] += 14 / 250;
        this.ammo.localRects[9] += 6 / 250;
        this.scratch = [1, 0, 0, 1, 0, 0];
        this.body = [1, 0, 0, 1, 0, 0];
        context.onDispose(() => this.dispose());
    }

    // A rolling body's art (the coconut's `rolling.prepare`) sets the roll state on the actor every frame: shell
    // angle θ, heading (+1 right, -1 left, already in the matrix), stretch, wall squash 0..1, speed stage, face
    // and the latest impact. A walking walnut leaves it at rest: no turn, no dust, the game's face.
    createActor() {
        const owner = this;
        const actor = {
            currentClip: 'idle',
            startedAt: 0,
            elapsed: 0,
            pose: null,
            disposed: false,
            roll: {
                theta: 0,
                heading: 1,
                scaleX: 1,
                scaleY: 1,
                squash: 0,
                stage: null,
                face: null,
                impact: null,
            },
            play(name) {
                this.currentClip = name;
                this.startedAt = 0;
                return this;
            },
            seek(time) {
                return this.seekElapsed(time - (this.startedAt || 0));
            },
            seekElapsed(elapsed) {
                this.elapsed = Math.max(0, elapsed);
                return this;
            },
            preparePose() {
                this.pose = true;
                return this.pose;
            },
            dispose() {
                if (this.disposed) return false;
                this.disposed = true;
                owner.actors.delete(this);
                return true;
            },
        };
        owner.actors.add(actor);
        return actor;
    }

    draw(name, matrix, depth, alpha = 1, depthWriteAlphaThreshold = 0) {
        this.context.depth = depth;
        drawUnitQuads(this.context, this.paint, {
            layer: this.region.layer,
            filter: this.region.filter,
            ...this.cells[name],
            matrix,
            alpha,
            depthWriteAlphaThreshold,
        });
    }

    // The stretched (or wall-squashed) ball about its ground contact.
    bodyMatrix(actor, matrix) {
        const { scaleX, scaleY, squash } = actor.roll;
        const sx = scaleX + (0.8 - scaleX) * squash,
            sy = scaleY + (1.1 - scaleY) * squash;
        return multiply(this.body, matrix, local(0, 0, sx, sy));
    }

    // Shell, then the upright shade. The shell turns by θ and is never mirrored, so the formula's
    // heading sign alone sets the visible spin direction.
    drawBody(actor, matrix, depth) {
        const roll = actor.roll,
            body = this.bodyMatrix(actor, matrix),
            m = this.scratch;
        multiply(m, body, local(0, -BALL_RADIUS, roll.heading, 1, roll.heading * roll.theta));
        this.draw('shell', m, depth, 1, 0.05);
        multiply(m, body, local(0, -BALL_RADIUS));
        this.draw('shade', m, depth, 1, 0.05);
    }

    // Dust and wind behind a rolling ball: main.js draws them just behind its body, without depth writes.
    drawBehind(actor, matrix, depth) {
        const { stage, scaleY, squash } = actor.roll,
            m = this.scratch;
        if (stage === null || squash > 0) return;
        if (stage === 0) this.draw('dustSlow', matrix, depth);
        else if (stage === 1) {
            this.draw('dustSlow', multiply(m, matrix, local(-14, 0, 1.2, 1.2)), depth);
            this.draw('streaksMid', multiply(m, matrix, local(0, -BALL_RADIUS * scaleY)), depth);
        } else {
            this.draw('dustMax', matrix, depth);
            this.draw('streaksMax', multiply(m, matrix, local(0, -BALL_RADIUS * scaleY)), depth);
        }
    }

    // The upright face 14 ahead and 6 below the centre, the spin arcs at top speed, then the impact.
    // A rolling ball picks its own face; a walking one shows the game's.
    drawFace(actor, matrix, depth, face) {
        const roll = actor.roll,
            body = this.bodyMatrix(actor, matrix),
            m = this.scratch;
        const name = roll.face ?? FACE_ALIAS[face] ?? face;
        this.draw(
            CELLS[name] ? name : 'neutral',
            multiply(m, body, local(14, 6 - BALL_RADIUS)),
            depth,
        );
        if (roll.stage === 2 && !roll.squash)
            this.draw('arcs', multiply(m, body, local(0, -BALL_RADIUS)), depth);
        const impact = roll.impact;
        if (impact && impact.age >= 0 && impact.age < 1) {
            // Pops in, then fades. A wall hit sits flatter against the wall.
            const grow = 0.8 + 0.3 * Math.min(1, impact.age * 4),
                alpha = impact.age < 0.5 ? 1 : 2 - impact.age * 2,
                size = (impact.wall ? 0.32 : 0.39) * grow;
            this.draw(
                'impact',
                multiply(
                    m,
                    matrix,
                    local(
                        impact.side * (impact.wall ? 82 : 96),
                        impact.wall ? -111 : -BALL_RADIUS,
                        size * (impact.wall ? 0.7 : 1),
                        size,
                    ),
                ),
                depth,
                alpha,
            );
        }
    }

    drawAmmo(matrix, depth) {
        this.context.depth = depth;
        this.context.drawQuads({
            layer: this.region.layer,
            filter: this.region.filter,
            ...this.ammo,
            matrix,
        });
    }

    dispose() {
        if (this.disposed) return false;
        this.disposed = true;
        for (const actor of this.actors) actor.dispose();
        this.context.device.textureAtlas.release(this.region);
        return true;
    }
}

// This unit's sprite contract (src/units/define-unit.js), loaded only by the page, never the Worker.
// The walnut walks: no `rolling`, so the ball stays upright and drawBehind draws nothing.
export const SPRITE = Object.freeze({
    load: loadWalnutSpriteCanvas,
    renderer: WalnutSpriteRenderer,
    portrait: walnutSpritePortrait,
    shell: { draw: 'drawAmmo', depthTest: true },
    groundY: 0,
    artScale: ballArtScale(Walnut.unit.size),
});
