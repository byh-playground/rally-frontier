import { DEFAULT_CHEEK_COLOR, ellipsePath, faceParts, facePartPlacement, cheekEllipses, buildFace } from './face-layer.js';

// Ported from budmori render/unit-overlay-images.js and unit-face-draw.js (face parts only, no element marks).
export const GRAIN_FACE_IDS = Object.freeze(['neutral', 'attack', 'hurt']);
const FACE_SOCKETS = ['face-eye-left', 'face-eye-right', 'face-mouth'];
// Pixels per eye gap for face parts and across the unit cheek circle. A part is drawn at most half that size;
// larger draws use paths so nothing is magnified.
const FACE_PART_PIXELS = 128;
const CHEEK_PIXELS = 64;
const MAX_DISPLAY_TO_IMAGE_SCALE = 0.5;

// Eye and mouth parts per face plus one white cheek, on the device atlas. Every grain body shares them and only
// moves and scales them to its own face sockets, so the atlas holds 3 faces however many bodies there are.
// prepare() uploads once outside game frames; the device replays uploaded regions after a lost context is restored.
export class GrainFaceOverlay {
    constructor(ctx) {
        this.ctx = ctx;
        this.images = new Map();
        this.anchors = new WeakMap();
        this.ops = new Map();
        this.posed = [0, 0, 0, 0, 0, 0];
        this.disposed = false;
    }
    prepare() {
        const DEVICE = this.ctx.device;
        if (this.disposed || DEVICE?.state !== 'ready' || this.images.size) {
            return;
        }
        const ATLAS = DEVICE.textureAtlas;
        for (const [KEY, PICTURE] of facePictures()) {
            const REGION = ATLAS.allocate(PICTURE.canvas.width, PICTURE.canvas.height);
            ATLAS.upload(REGION, PICTURE.canvas);
            this.images.set(KEY, { ...PICTURE, region: REGION });
        }
    }
    // The three face sockets of a compiled body at its rest pose, in the body's SVG canvas.
    anchor(compiled) {
        let anchor = this.anchors.get(compiled);
        if (!anchor) {
            const SOCKETS = compiled.metadata.sockets,
                POINT = (id) => {
                    if (!SOCKETS[id]) {
                        throw new Error('Grain body is missing face socket ' + id + ' (' + compiled.sourcePath + ')');
                    }
                    return SOCKETS[id].point;
                };
            anchor = Object.freeze({ eyeLeft: POINT(FACE_SOCKETS[0]), eyeRight: POINT(FACE_SOCKETS[1]), mouth: POINT(FACE_SOCKETS[2]) });
            this.anchors.set(compiled, anchor);
        }
        return anchor;
    }
    // matrix: the screen transform the body was drawn with. Call after the body's own submission.
    draw(compiled, actor, faceId, matrix, alpha = 1) {
        const C = this.ctx,
            ANCHOR = this.anchor(compiled),
            P = posedFace(actor, ANCHOR, this.posed);
        C.save();
        C.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
        C.transform(P[0], P[1], P[2], P[3], P[4], P[5]);
        const PIXELS_PER_UNIT = Math.hypot(matrix[0], matrix[1]) * Math.hypot(P[0], P[1]);
        if (!this.drawImages(ANCHOR, faceId, alpha, PIXELS_PER_UNIT)) {
            drawOperations(C, this.faceOps(compiled, ANCHOR, faceId), alpha);
        }
        C.restore();
    }
    drawImages(anchor, faceId, alpha, pixelsPerUnit) {
        const { gap: GAP, origins: ORIGINS } = facePartPlacement(anchor);
        if (GAP * pixelsPerUnit > FACE_PART_PIXELS * MAX_DISPLAY_TO_IMAGE_SCALE || this.disposed || !this.images.size || this.ctx.device?.state !== 'ready') {
            return false;
        }
        const C = this.ctx,
            PARTS = faceParts(faceId),
            CHEEK = this.images.get('cheek');
        C.globalAlpha = alpha * PARTS.cheeks.opacity;
        C.withColor(DEFAULT_CHEEK_COLOR, () => {
            for (const [CX, CY, RX, RY] of cheekEllipses(anchor, PARTS.cheeks)) {
                drawImage(C, CHEEK, CX, CY, RX, RY);
            }
        });
        C.globalAlpha = alpha;
        for (const [INDEX, [OX, OY]] of ORIGINS.entries()) {
            drawImage(C, this.images.get(`${faceId}:${INDEX}`), OX, OY, GAP, GAP);
        }
        return true;
    }
    faceOps(compiled, anchor, faceId) {
        const KEY = compiled.sourceSha256 + ':' + faceId;
        let ops = this.ops.get(KEY);
        if (!ops) {
            ops = Object.freeze(buildFace(faceId, anchor));
            this.ops.set(KEY, ops);
        }
        return ops;
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.ctx.device?.state === 'ready') {
            for (const IMAGE of this.images.values()) {
                IMAGE.region.atlas.release(IMAGE.region);
            }
        }
        this.images.clear();
    }
}

// Draws a grain's face with paths on a plain 2D canvas whose transform is the body's SVG canvas (card portraits).
export function drawGrainFace(ctx, compiled, faceId = 'neutral') {
    const SOCKETS = compiled.metadata.sockets,
        ANCHOR = { eyeLeft: SOCKETS[FACE_SOCKETS[0]].point, eyeRight: SOCKETS[FACE_SOCKETS[1]].point, mouth: SOCKETS[FACE_SOCKETS[2]].point };
    drawOperations(ctx, buildFace(faceId, ANCHOR), 1);
}

// Maps the rest anchor triangle onto the posed one, so squash, lean and bounce carry the face like the body.
function posedFace(actor, rest, out) {
    const EL = actor.getSocket(FACE_SOCKETS[0]),
        ER = actor.getSocket(FACE_SOCKETS[1]),
        MO = actor.getSocket(FACE_SOCKETS[2]);
    const U1X = rest.eyeRight[0] - rest.eyeLeft[0],
        U1Y = rest.eyeRight[1] - rest.eyeLeft[1],
        U2X = rest.mouth[0] - rest.eyeLeft[0],
        U2Y = rest.mouth[1] - rest.eyeLeft[1],
        V1X = ER.x - EL.x,
        V1Y = ER.y - EL.y,
        V2X = MO.x - EL.x,
        V2Y = MO.y - EL.y,
        DET = U1X * U2Y - U1Y * U2X;
    // [a c; b d] = V * U^-1
    out[0] = (V1X * U2Y - V2X * U1Y) / DET;
    out[1] = (V1Y * U2Y - V2Y * U1Y) / DET;
    out[2] = (V2X * U1X - V1X * U2X) / DET;
    out[3] = (V2Y * U1X - V1Y * U2X) / DET;
    out[4] = EL.x - (out[0] * rest.eyeLeft[0] + out[2] * rest.eyeLeft[1]);
    out[5] = EL.y - (out[1] * rest.eyeLeft[0] + out[3] * rest.eyeLeft[1]);
    return out;
}

// Every face picture, keyed as drawn: `${face}:${part}` and 'cheek'.
function facePictures() {
    const PICTURES = new Map();
    for (const FACE of GRAIN_FACE_IDS) {
        const PARTS = faceParts(FACE);
        for (const [INDEX, OPS] of [...PARTS.eyes, PARTS.mouth].entries()) {
            PICTURES.set(`${FACE}:${INDEX}`, rasterise(OPS, FACE_PART_PIXELS));
        }
    }
    // A unit circle squashed to each cheek when drawn; white so withColor gives it the cheek colour.
    PICTURES.set('cheek', rasterise([{ fill: '#ffffff', opacity: 1, path: ellipsePath(0, 0, 1, 1) }], CHEEK_PIXELS / 2));
    return PICTURES;
}
// Rasterises draw operations ({ fill | stroke, path, width?, opacity? } in local units) into a canvas.
// Returns it with the local rectangle it covers.
function rasterise(operations, pixelsPerUnit) {
    const BOX = [Infinity, Infinity, -Infinity, -Infinity];
    for (const OPERATION of operations) {
        const PAD = (OPERATION.width || 0) / 2;
        for (const [, ...NUMBERS] of OPERATION.path) {
            for (let index = 0; index < NUMBERS.length; index += 2) {
                BOX[0] = Math.min(BOX[0], NUMBERS[index] - PAD);
                BOX[1] = Math.min(BOX[1], NUMBERS[index + 1] - PAD);
                BOX[2] = Math.max(BOX[2], NUMBERS[index] + PAD);
                BOX[3] = Math.max(BOX[3], NUMBERS[index + 1] + PAD);
            }
        }
    }
    // One clear texel around the art keeps linear sampling from bleeding a neighbour in.
    const MARGIN = 1 / pixelsPerUnit,
        X = BOX[0] - MARGIN,
        Y = BOX[1] - MARGIN,
        WIDTH = Math.ceil((BOX[2] - BOX[0]) * pixelsPerUnit) + 2,
        HEIGHT = Math.ceil((BOX[3] - BOX[1]) * pixelsPerUnit) + 2,
        CANVAS = new OffscreenCanvas(WIDTH, HEIGHT),
        C = CANVAS.getContext('2d');
    C.setTransform(pixelsPerUnit, 0, 0, pixelsPerUnit, -X * pixelsPerUnit, -Y * pixelsPerUnit);
    C.lineCap = 'round';
    C.lineJoin = 'round';
    for (const OPERATION of operations) {
        const PATH = new Path2D();
        tracePath(PATH, OPERATION.path);
        if (OPERATION.fill) {
            C.globalAlpha = OPERATION.opacity ?? 1;
            C.fillStyle = OPERATION.fill;
            C.fill(PATH);
        } else {
            C.globalAlpha = 1;
            C.strokeStyle = OPERATION.stroke;
            C.lineWidth = OPERATION.width;
            C.stroke(PATH);
        }
    }
    return { canvas: CANVAS, x: X, y: Y, width: WIDTH / pixelsPerUnit, height: HEIGHT / pixelsPerUnit };
}
function tracePath(target, path) {
    for (const [COMMAND, ...N] of path) {
        if (COMMAND === 'M') {
            target.moveTo(N[0], N[1]);
        } else if (COMMAND === 'L') {
            target.lineTo(N[0], N[1]);
        } else if (COMMAND === 'Q') {
            target.quadraticCurveTo(N[0], N[1], N[2], N[3]);
        } else if (COMMAND === 'C') {
            target.bezierCurveTo(N[0], N[1], N[2], N[3], N[4], N[5]);
        } else {
            target.closePath();
        }
    }
}
// Draws operations as paths on the current transform, where the images would be magnified.
function drawOperations(ctx, operations, alpha) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const OP of operations) {
        ctx.beginPath();
        tracePath(ctx, OP.path);
        if (OP.fill) {
            ctx.globalAlpha = (OP.opacity ?? 1) * alpha;
            ctx.fillStyle = OP.fill;
            ctx.fill();
        } else {
            ctx.globalAlpha = alpha;
            ctx.strokeStyle = OP.stroke;
            ctx.lineWidth = OP.width;
            ctx.stroke();
        }
    }
}
// Places an image whose local origin goes to (x, y) and whose local unit is (scaleX, scaleY) on the current transform.
function drawImage(ctx, image, x, y, scaleX, scaleY) {
    ctx.drawRegion(image.region, x + image.x * scaleX, y + image.y * scaleY, image.width * scaleX, image.height * scaleY);
}
