import { drawUnitQuads } from '../../render/dead-unit-look.js';
const ROOT = new URL('../../../assets/sprites/black-bean/', import.meta.url);
const SHEET_SIZE = [740, 540];
// The enemy helmet is the same cell repainted in enemy colors and baked below the sheet.
const ENEMY_HELMET_Y = SHEET_SIZE[1] + 10;
const CANVAS_SIZE = [SHEET_SIZE[0], ENEMY_HELMET_Y + 170];
// Helmet stripe paint regions, as the cannon art paints them (building-art.js TEAM / ENEMY).
const ENEMY_PAINT = Object.freeze({
    team: '#f04545',
    'team-light': '#ff9e99',
    'team-shadow': '#b32f2f',
});
// One sheet unit is one rice sheet unit: the standing bean (helmet top to feet, 252) is about 73% of rice's 343.5.
export const BLACK_BEAN_ART_SCALE = 1;
// One sheet unit is 0.4219 cannon SVG units on the muzzle.
const RIDE_SCALE = 0.4219;
// The flight pose stretches the body along the head-first axis; the whoosh stays unstretched.
const FLIGHT_STRETCH = [0.9, 1.14];
const IMPACT_CELL_SCALE = 1.3;
// A landed bean leans at the approved impact angle; its body centre sits this far from the helmet tip.
const IMPACT_ANGLE = 161;
const IMPACT_REACH = 142 * 0.8;
const DEGREE = Math.PI / 180;

const cells = {
    body: { slot: [10, 10, 200, 230], pivot: [100, 222] },
    helmet: { slot: [220, 10, 200, 170], pivot: [100, 112] },
    enemyHelmet: { slot: [220, ENEMY_HELMET_Y, 200, 170], pivot: [100, 112] },
    ride: { slot: [430, 10, 170, 190], pivot: [85, 170] },
    arm: { slot: [610, 10, 50, 64], pivot: [25, 10] },
    foot: { slot: [670, 10, 60, 40], pivot: [30, 12] },
    grip: { slot: [610, 84, 56, 56], pivot: [28, 28] },
    trail: { slot: [10, 250, 200, 280], pivot: [100, 10] },
    whoosh: { slot: [220, 190, 200, 100], pivot: [100, 80] },
    impact: { slot: [430, 210, 240, 150], pivot: [120, 100] },
    neutral: { slot: [434, 372, 148, 72], pivot: [74, 36] },
    happy: { slot: [586, 372, 148, 72], pivot: [74, 36] },
    angry: { slot: [434, 452, 148, 72], pivot: [74, 36] },
    hurt: { slot: [586, 452, 148, 72], pivot: [74, 36] },
};
// Match faces: the shared ids map onto the bean's own white faces.
const FACES = Object.freeze({ neutral: 'neutral', attack: 'angry', hurt: 'hurt', happy: 'happy' });

// Approved standing assembly: the ground point is the origin.
const bodyParts = [
    { cell: 'foot', id: 'leftFoot', position: [-34, -14], scaleX: -1 },
    { cell: 'foot', id: 'rightFoot', position: [34, -14] },
    { cell: 'body', id: 'body', position: [0, 0] },
];
const frontParts = [
    { id: 'face', position: [0, -100], scaleX: 0.9, scaleY: 0.9 },
    { id: 'helmet', position: [0, -160] },
    {
        cell: 'arm',
        id: 'leftArm',
        position: [-82, -92],
        rotation: 24 * DEGREE,
        scaleX: -0.85,
        scaleY: 0.85,
    },
    {
        cell: 'arm',
        id: 'rightArm',
        position: [82, -92],
        rotation: -24 * DEGREE,
        scaleX: 0.85,
        scaleY: 0.85,
    },
];
const parts = [...bodyParts, ...frontParts];
const key = (timeMs, parts = {}) => ({ timeMs, parts, easing: 'inOutSine' });
const clip = (durationMs, loop, keyframes) => ({ durationMs, loop, keyframes });
// Offsets from the standing assembly. The walk alternates the approved stride with its mirror.
const STRIDE = (sign) => ({
    body: { y: -6, rotation: 5 * DEGREE * sign },
    leftFoot:
        sign > 0
            ? { x: 6, y: -12, rotation: -22 * DEGREE }
            : { x: -2, y: 2, rotation: -8 * DEGREE },
    rightFoot:
        sign > 0 ? { x: 2, y: 2, rotation: 8 * DEGREE } : { x: -6, y: -12, rotation: 22 * DEGREE },
    leftArm: { rotation: (sign > 0 ? -30 : 22) * DEGREE },
    rightArm: { rotation: (sign > 0 ? -22 : 30) * DEGREE },
    helmet: { rotation: 2 * DEGREE * sign },
});
const PLANTED = {
    body: { y: 0 },
};
const CHARGE = {
    body: { rotation: 9 * DEGREE, scaleX: 1.05, scaleY: 0.95 },
    leftArm: { rotation: 38 * DEGREE },
    rightArm: { rotation: -38 * DEGREE },
    leftFoot: { x: -6, rotation: -6 * DEGREE },
    rightFoot: { x: 4, rotation: 4 * DEGREE },
};
const rig = {
    parts: parts.map(({ id, position }) => ({
        id,
        parent: id === 'body' || id.endsWith('Foot') ? null : 'body',
        pivot: position,
    })),
    clips: {
        idle: clip(1200, 'repeat', [
            key(0),
            key(600, { body: { y: -2, scaleY: 1.02 }, helmet: { y: -1 } }),
            key(1200),
        ]),
        walk: clip(600, 'repeat', [
            key(0, STRIDE(1)),
            key(150, PLANTED),
            key(300, STRIDE(-1)),
            key(450, PLANTED),
            key(600, STRIDE(1)),
        ]),
        fire: clip(320, 'once', [key(0), key(90, CHARGE), key(200, CHARGE), key(320)]),
        hit: clip(260, 'once', [
            key(0, {
                body: { rotation: -11 * DEGREE, scaleY: 0.96 },
                leftArm: { rotation: 22 * DEGREE },
                rightArm: { rotation: -22 * DEGREE },
                helmet: { x: -6, rotation: -14 * DEGREE },
            }),
            key(260),
        ]),
    },
};

async function readAsset(name) {
    const response = await fetch(new URL(name, ROOT), { cache: 'no-cache' });
    if (!response.ok) throw new Error('검은콩 스프라이트를 불러오지 못했습니다: ' + name);
    return response;
}

async function rasterize(bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const [width, height] = SHEET_SIZE;
        if (image.naturalWidth !== width || image.naturalHeight !== height)
            throw new Error('검은콩 스프라이트 시트 크기가 다릅니다.');
        return image;
    } finally {
        URL.revokeObjectURL(url);
    }
}

export async function loadBlackBeanSpriteCanvas() {
    const [manifest, bytes] = await Promise.all([
        readAsset('manifest.json').then((response) => response.json()),
        readAsset('parts.svg').then((response) => response.arrayBuffer()),
    ]);
    const spec = manifest?.assets?.['parts.svg'];
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
        value.toString(16).padStart(2, '0'),
    ).join('');
    if (manifest?.schemaVersion !== 1 || spec?.bytes !== bytes.byteLength || spec.sha256 !== hash)
        throw new Error('검은콩 SVG 무결성 오류');
    // The helmet stripe is the only painted region; the enemy copy differs in those three fills.
    let painted = 0;
    const enemySvg = new TextDecoder()
        .decode(bytes)
        .replace(
            /fill="#[0-9a-fA-F]{6}"(\s+data-paint-region="(team|team-light|team-shadow)")/g,
            (_, attribute, region) => {
                painted++;
                return `fill="${ENEMY_PAINT[region]}"${attribute}`;
            },
        );
    if (painted !== 3) throw new Error('검은콩 헬멧의 팀색 영역을 찾지 못했습니다.');
    const [own, enemy] = await Promise.all([
        rasterize(bytes),
        rasterize(new TextEncoder().encode(enemySvg)),
    ]);
    const canvas = document.createElement('canvas');
    [canvas.width, canvas.height] = CANVAS_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(own, 0, 0);
    const [hx, hy, hw, hh] = cells.helmet.slot;
    ctx.drawImage(enemy, hx, hy, hw, hh, hx, ENEMY_HELMET_Y, hw, hh);
    return canvas;
}

// Affine [a, b, c, d, e, f] products in screen space.
const multiply = (m, n) => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
];
// translate(x y) rotate(degrees) scale(sx sy), as in the approved SVG assembly.
const placed = (x, y, degrees = 0, sx = 1, sy = sx) => {
    const c = Math.cos(degrees * DEGREE),
        s = Math.sin(degrees * DEGREE);
    return [c * sx, s * sx, -s * sy, c * sy, x, y];
};
const helmetCell = (own) => (own ? 'helmet' : 'enemyHelmet');

// Standing bean in sheet units around its ground point (portrait only).
const standing = (face, arms = 24) => [
    ['foot', placed(-34, -14, 0, -1, 1)],
    ['foot', placed(34, -14)],
    ['body', placed(0, 0)],
    [face, placed(0, -100, 0, 0.9)],
    ['helmet', placed(0, -160)],
    ['arm', placed(-82, -92, arms, -0.85, 0.85)],
    ['arm', placed(82, -92, -arms, 0.85, 0.85)],
];

// Three beans overlap: the card is a squad card.
export function blackBeanSpritePortrait(source, width) {
    const canvas = document.createElement('canvas');
    const scale = width / 430;
    canvas.width = width;
    canvas.height = width;
    const ctx = canvas.getContext('2d');
    const root = [scale, 0, 0, scale, width / 2, width / 2 + 125 * scale];
    for (const [group, face, arms] of [
        [placed(-92, -26), 'happy', 24],
        [placed(92, -26, 0, -1, 1), 'neutral', 24],
        [placed(0, 0, 0, 1.08), 'angry', 60],
    ])
        for (const [cell, matrix] of standing(face, arms)) {
            const {
                slot,
                pivot: [px, py],
            } = cells[cell];
            ctx.setTransform(...multiply(root, multiply(group, matrix)));
            ctx.drawImage(source, ...slot, -px, -py, slot[2], slot[3]);
        }
    return canvas.toDataURL('image/png');
}

export class BlackBeanSpriteRenderer {
    constructor(context, canvas, gamekit) {
        this.context = context;
        this.mesh = context.acquireMeshRenderer();
        this.actors = new Set();
        const region = context.device.textureAtlas.allocate(canvas.width, canvas.height, {
            filter: 'linear',
        });
        try {
            context.device.textureAtlas.upload(region, canvas);
            this.source = this.mesh.createPoseSource(gamekit.compilePoseChannels(rig));
        } catch (error) {
            context.device.textureAtlas.release(region);
            throw error;
        }
        this.region = region;

        // Posed quads are in standing-art units; unposed quads are in sheet units around their pivot.
        const build = (pieces, posed = true) => {
            const uvRects = [],
                localRects = [],
                channels = [];
            for (const {
                cell,
                id,
                position: [x, y],
            } of pieces) {
                const {
                    slot: [sx, sy, w, h],
                    pivot: [px, py],
                } = cells[cell];
                uvRects.push(
                    (region.x + sx) / region.atlas.width,
                    (region.y + sy) / region.atlas.height,
                    w / region.atlas.width,
                    h / region.atlas.height,
                );
                localRects.push(x - px, y - py, w, h);
                if (posed) channels.push(parts.findIndex((part) => part.id === id));
            }
            return {
                uvRects: Float32Array.from(uvRects),
                localRects: Float32Array.from(localRects),
                ...(posed ? { parts: Float32Array.from(channels) } : {}),
            };
        };
        this.body = build(bodyParts);
        this.front = Object.fromEntries(
            [true, false].map((own) => [
                own,
                Object.fromEntries(
                    Object.entries(FACES).map(([face, cell]) => [
                        face,
                        build(
                            frontParts.map((part) => ({
                                ...part,
                                cell: part.cell || (part.id === 'helmet' ? helmetCell(own) : cell),
                            })),
                        ),
                    ]),
                ),
            ]),
        );
        this.cells = Object.fromEntries(
            Object.keys(cells).map((cell) => [cell, build([{ cell, position: [0, 0] }], false)]),
        );
        context.onDispose(() => this.dispose());
    }

    createActor() {
        const owner = this;
        const instance = owner.mesh.createPoseInstance(owner.source);
        const basePoses = parts.map(({ rotation = 0, scaleX = 1, scaleY = 1 }) => ({
            x: 0,
            y: 0,
            rotation,
            scaleX,
            scaleY,
            opacity: 1,
        }));
        const visible = parts.map(() => true);
        const actor = {
            currentClip: 'idle',
            startedAt: 0,
            elapsed: 0,
            pose: null,
            disposed: false,
            own: true,
            // The helmet stripe follows the viewer's side, like the cannons.
            setTeam(own) {
                this.own = !!own;
                return this;
            },
            play(name) {
                this.currentClip = Object.hasOwn(rig.clips, name) ? name : 'idle';
                this.startedAt = name === 'idle' || name === 'walk' ? 0 : null;
                return this;
            },
            seek(time) {
                if (this.startedAt === null) this.startedAt = time;
                return this.seekElapsed(time - this.startedAt);
            },
            seekElapsed(elapsed) {
                this.elapsed = Math.max(0, elapsed);
                return this;
            },
            preparePose() {
                this.pose = owner.mesh.preparePose(instance, {
                    clipName: this.currentClip,
                    elapsedMs: this.elapsed,
                    basePoses,
                    visible,
                    morph: [0, 0],
                });
                if (!this.pose) throw new Error('검은콩 GPU 포즈를 준비하지 못했습니다.');
                return this.pose;
            },
            dispose() {
                if (this.disposed) return false;
                this.disposed = true;
                owner.actors.delete(this);
                return owner.mesh.deletePoseInstance(instance);
            },
        };
        owner.actors.add(actor);
        return actor;
    }

    draw(data, matrix, depth, actor = null, depthWriteAlphaThreshold = 0) {
        this.context.depth = depth;
        drawUnitQuads(this.context, this.paint, {
            layer: this.region.layer,
            filter: this.region.filter,
            ...data,
            ...(actor ? { pose: actor.pose } : {}),
            matrix,
            depthWriteAlphaThreshold,
        });
    }

    drawBody(actor, matrix, depth) {
        this.draw(this.body, matrix, depth, actor, 0.05);
    }

    drawFace(actor, matrix, depth, face) {
        const front = this.front[actor.own];
        this.draw(front[face] || front.neutral, matrix, depth, actor);
    }

    drawCells(list, depth) {
        for (const [cell, matrix] of list) this.draw(this.cells[cell], matrix, depth);
    }

    // Head-first flight, from the approved assembly. (x, y) is the body centre on screen,
    // (vx, vy) the on-screen velocity and k screen pixels per sheet unit.
    flightCells(x, y, vx, vy, k, own) {
        const mirror = vx < 0 ? -1 : 1,
            angle = Math.atan2(vy, vx * mirror) / DEGREE + 90,
            outer = multiply([mirror * k, 0, 0, k, x, y], placed(0, 0, angle)),
            inner = multiply(outer, multiply(placed(0, 0, 0, ...FLIGHT_STRETCH), placed(0, 110))),
            at = (matrix) => multiply(inner, matrix);
        return [
            ['trail', outer],
            ['foot', at(placed(-14, -12, 14, -1, 1))],
            ['foot', at(placed(14, -12, -14))],
            ['body', inner],
            ['angry', at(placed(0, -100, 0, 0.9))],
            [helmetCell(own), at(placed(0, -160))],
            ['arm', at(placed(-78, -104, -12, -0.85, 0.85))],
            ['arm', at(placed(78, -104, 12, 0.85, 0.85))],
            ['whoosh', multiply(outer, placed(0, -166))],
        ];
    }

    drawFlight(x, y, vx, vy, k, own, depth) {
        this.drawCells(this.flightCells(x, y, vx, vy, k, own), depth);
    }

    // Cannon ammo matrix: unit = shell width, +x along the flight. Used for resource preparation.
    drawAmmo(matrix, depth) {
        const k = Math.hypot(matrix[0], matrix[1]) / 300;
        this.drawFlight(matrix[4], matrix[5], matrix[0], matrix[1], k, true, depth);
    }

    // The landing at the ground point (x, y): optionally a bean stuck head first at the last flight
    // angle (bean = { mirror, own }), then the impact splash over it at 1.3 times the bean.
    impactCells(x, y, k, bean) {
        const list = [];
        if (bean) {
            const mirror = bean.mirror ? -1 : 1,
                radians = IMPACT_ANGLE * DEGREE,
                reach = k * IMPACT_REACH,
                root = multiply(
                    [
                        mirror * k,
                        0,
                        0,
                        k,
                        x - mirror * reach * Math.sin(radians),
                        y + reach * Math.cos(radians),
                    ],
                    multiply(placed(0, 0, IMPACT_ANGLE, 1.12, 0.8), placed(0, 110)),
                ),
                at = (matrix) => multiply(root, matrix);
            list.push(
                ['foot', at(placed(-20, -12, 18, -1, 1))],
                ['foot', at(placed(20, -12, -18))],
                ['body', root],
                ['hurt', at(placed(0, -100, 0, 0.9))],
                [helmetCell(bean.own), at(placed(0, -160))],
                ['arm', at(placed(-82, -96, 70, -0.85, 0.85))],
                ['arm', at(placed(82, -96, -70, 0.85, 0.85))],
            );
        }
        const splash = k * IMPACT_CELL_SCALE;
        list.push(['impact', [splash, 0, 0, splash, x, y]]);
        return list;
    }

    drawImpact(x, y, k, depth, bean = null) {
        this.drawCells(this.impactCells(x, y, k, bean), depth);
    }

    // A rider on BuildingArt.pose's muzzle socket. 'body' sits inside the barrel order, 'hands'
    // grip the rim after the whole cannon (building-art.js draw).
    rideCells(cannon, own, part) {
        const { muzzle, muzzleDir } = cannon,
            angle =
                muzzleDir.y > 0 ? muzzleDir.x * 90 : Math.atan2(muzzleDir.x, -muzzleDir.y) / DEGREE,
            root = multiply(
                [1, 0, 0, 1, muzzle.x, muzzle.y],
                placed(0, 0, angle, cannon.scale * RIDE_SCALE),
            ),
            at = (matrix) => multiply(root, matrix);
        return part === 'hands'
            ? [
                  ['grip', at(placed(-86, 0, 0, -1, 1))],
                  ['grip', at(placed(86, 0))],
              ]
            : [
                  ['ride', root],
                  ['happy', at(placed(0, -58, 0, 0.8))],
                  [helmetCell(own), at(placed(0, -98, 0, 0.82))],
              ];
    }

    drawRide(cannon, own, part, depth) {
        this.drawCells(this.rideCells(cannon, own, part), depth);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        for (const actor of this.actors) actor.dispose();
        this.mesh.deletePoseSource(this.source);
        this.context.device.textureAtlas.release(this.region);
    }
}

// This unit's sprite contract (src/units/define-unit.js), loaded only by the page, never the Worker.
// The shell is the soldier itself: drawFlight in the air, drawImpact head first in the ground and
// drawRide on a muzzle (CannonRider).
export const SPRITE = Object.freeze({
    load: loadBlackBeanSpriteCanvas,
    renderer: BlackBeanSpriteRenderer,
    portrait: blackBeanSpritePortrait,
    shell: { draw: 'drawAmmo', depthTest: true, flight: 'soldier' },
    groundY: 0,
    artScale: BLACK_BEAN_ART_SCALE,
});
