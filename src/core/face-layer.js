// The face is not authored art: every species gets the same faces from three anchor points in its body.
// Geometry is built once per (anchor, face) in the SVG canvas of the body, so a renderer can draw it with
// the live body transform and the codex can place it into an SVG without a second description.

export const STATE_FACES = Object.freeze([
    'neutral',
    'happy',
    'focused',
    'attack',
    'surprised',
    'hurt',
    'hungry',
    'dead',
]);
export const TEMPERAMENT_FACES = Object.freeze([
    'temperament-0',
    'temperament-1',
    'temperament-2',
    'temperament-3',
    'temperament-4',
]);
export const FACE_IDS = Object.freeze([...STATE_FACES, ...TEMPERAMENT_FACES]);

export const DEFAULT_CHEEK_COLOR = '#ec8070';
const EYE_COLOR = '#4a2420',
    INK_COLOR = '#2c1c18',
    GLINT_COLOR = '#fff5d8',
    TONGUE_COLOR = '#e9776b',
    EYE_SIZE = 0.165,
    MOUTH_HALF_WIDTH = 0.19,
    ELLIPSE_KAPPA = 0.5522847498;

export function ellipsePath(cx, cy, rx, ry) {
    const KX = rx * ELLIPSE_KAPPA,
        KY = ry * ELLIPSE_KAPPA;
    return [
        ['M', cx + rx, cy],
        ['C', cx + rx, cy + KY, cx + KX, cy + ry, cx, cy + ry],
        ['C', cx - KX, cy + ry, cx - rx, cy + KY, cx - rx, cy],
        ['C', cx - rx, cy - KY, cx - KX, cy - ry, cx, cy - ry],
        ['C', cx + KX, cy - ry, cx + rx, cy - KY, cx + rx, cy],
        ['Z'],
    ];
}

function boxOf(operation) {
    const PAD = operation.width ? operation.width / 2 : 0,
        BOX = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [, ...NUMBERS] of operation.path) {
        for (let index = 0; index < NUMBERS.length; index += 2) {
            BOX[0] = Math.min(BOX[0], NUMBERS[index] - PAD);
            BOX[1] = Math.min(BOX[1], NUMBERS[index + 1] - PAD);
            BOX[2] = Math.max(BOX[2], NUMBERS[index] + PAD);
            BOX[3] = Math.max(BOX[3], NUMBERS[index + 1] + PAD);
        }
    }
    return BOX;
}
const STYLE_OF = (operation) =>
    operation.fill ? 'f' + operation.fill + '/' + operation.opacity : 's' + operation.stroke + '/' + operation.width;
const OVERLAPS = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

// One draw per colour: an operation joins the nearest earlier one of its style unless an operation drawn
// between them overlaps it, so the layering (glints over eyes, teeth over mouth) is unchanged.
function mergeByStyle(operations) {
    const MERGED = [];
    for (const OPERATION of operations) {
        const ENTRY = { operation: { ...OPERATION, path: [...OPERATION.path] }, box: boxOf(OPERATION) },
            STYLE = STYLE_OF(OPERATION);
        let target = null;
        for (let index = MERGED.length - 1; index >= 0; index--) {
            if (STYLE_OF(MERGED[index].operation) === STYLE) {
                target = MERGED[index];
                break;
            }
            if (OVERLAPS(MERGED[index].box, ENTRY.box)) {
                break;
            }
        }
        if (target) {
            target.operation.path.push(...OPERATION.path);
            target.box = [
                Math.min(target.box[0], ENTRY.box[0]),
                Math.min(target.box[1], ENTRY.box[1]),
                Math.max(target.box[2], ENTRY.box[2]),
                Math.max(target.box[3], ENTRY.box[3]),
            ];
        } else {
            MERGED.push(ENTRY);
        }
    }
    return MERGED.map((entry) => entry.operation);
}

// A face is three parts placed on the body's anchors: the left eye and the right eye around their eye points and the
// mouth around the mouth point, plus a pair of cheeks. Part geometry is in eye-gap units (the distance between the
// eyes is 1) with the part's own point at the origin, so every species shares the same parts; a species only moves
// and scales them. Returns { eyes: [ops, ops], mouth: ops, cheeks: { scale, opacity } }, ops as in buildFace.
const PARTS_CACHE = new Map();
export function faceParts(faceId) {
    let parts = PARTS_CACHE.get(faceId);
    if (!parts) {
        parts = Object.freeze(buildFaceParts(faceId));
        PARTS_CACHE.set(faceId, parts);
    }
    return parts;
}
// Where a part's origin sits and how big one eye-gap unit is, for one species' anchors.
export function facePartPlacement(anchor) {
    const GAP = anchor.eyeRight[0] - anchor.eyeLeft[0];
    return { gap: GAP, origins: [anchor.eyeLeft, anchor.eyeRight, anchor.mouth] };
}
// The two cheek ellipses in the body's canvas: [cx, cy, rx, ry] each.
export function cheekEllipses(anchor, cheeks) {
    const GAP = anchor.eyeRight[0] - anchor.eyeLeft[0],
        RX = GAP * 0.2 * cheeks.scale,
        Y = anchor.mouth[1] + GAP * 0.05;
    return [
        [anchor.eyeLeft[0] - GAP * 0.2, Y, RX, RX * CHEEK_ASPECT],
        [anchor.eyeRight[0] + GAP * 0.2, Y, RX, RX * CHEEK_ASPECT],
    ];
}
const CHEEK_ASPECT = 0.62;

function buildFaceParts(faceId) {
    const U = EYE_SIZE,
        W = MOUTH_HALF_WIDTH,
        STROKE_WIDTH = 0.055,
        EYES = [[], []],
        MOUTH = [],
        PARTS = { eyes: EYES, mouth: MOUTH, cheeks: { scale: 1, opacity: 1 } };
    const FILL = (part, path, color, opacity = 1) => part.push({ fill: color, path, opacity });
    const STROKE = (part, path, scale = 1, color = INK_COLOR) =>
        part.push({ stroke: color, path, width: STROKE_WIDTH * scale });
    const LINE = (part, x1, y1, x2, y2, scale) =>
        STROKE(
            part,
            [
                ['M', x1, y1],
                ['L', x2, y2],
            ],
            scale,
        );
    const CURVE = (part, x1, y1, cx, cy, x2, y2, scale) =>
        STROKE(
            part,
            [
                ['M', x1, y1],
                ['Q', cx, cy, x2, y2],
            ],
            scale,
        );
    const CHEEKS = (scale = 1, opacity = 1) => {
        PARTS.cheeks = { scale, opacity };
    };
    const ROUND_EYES = (rx = 1, ry = 1, dy = 0) => {
        for (const EYE of EYES) {
            FILL(EYE, ellipsePath(0, dy * U, U * rx, U * ry * 1.05), EYE_COLOR);
        }
    };
    const GLINTS = (rx = 1, big = 0.3, small = 0.14, dy = 0) => {
        for (const EYE of EYES) {
            FILL(EYE, ellipsePath(-0.3 * U * rx, dy * U - 0.35 * U, U * big, U * big), GLINT_COLOR);
            if (small) {
                FILL(EYE, ellipsePath(0.35 * U * rx, dy * U + 0.3 * U, U * small, U * small), GLINT_COLOR, 0.8);
            }
        }
    };
    const SMILE = (half, depth, scale) => CURVE(MOUTH, -half, 0, 0, depth, half, 0, scale);
    // A closed mouth outline that holds the open-mouth fill; optional tongue.
    const OPEN_MOUTH = (half, depth, tongue) => {
        FILL(
            MOUTH,
            [
                ['M', -half, -U * 0.1],
                ['Q', 0, -U * 0.1, half, -U * 0.1],
                ['Q', half * 0.8, depth, 0, depth + U * 0.05],
                ['Q', -half * 0.8, depth, -half, -U * 0.1],
                ['Z'],
            ],
            INK_COLOR,
        );
        if (tongue) {
            FILL(MOUTH, ellipsePath(0, depth * 0.78, half * 0.5, U * 0.38), TONGUE_COLOR);
        }
    };
    const BROW = (side, x1, y1, x2, y2, scale = 1) =>
        LINE(EYES[side < 0 ? 0 : 1], x1 * U, y1 * U, x2 * U, y2 * U, scale);
    const ARC_UP = (i, scale = 1.25) => CURVE(EYES[i], -U, U * 0.35, 0, -U, U, U * 0.35, scale);
    switch (faceId) {
        case 'neutral':
            CHEEKS();
            ROUND_EYES();
            GLINTS(1, 0.3, 0);
            SMILE(W, W * 0.525, 1.15);
            break;
        case 'happy':
            CHEEKS(1.2);
            ARC_UP(0);
            ARC_UP(1);
            OPEN_MOUTH(W, U * 1.5, true);
            break;
        case 'focused':
            CHEEKS(1, 0.55);
            for (const EYE of EYES) {
                FILL(
                    EYE,
                    [
                        ['M', -U * 1.05, -U * 0.1],
                        ['Q', -U * 1.05, U * 0.85, 0, U * 0.85],
                        ['Q', U * 1.05, U * 0.85, U * 1.05, -U * 0.1],
                        ['Z'],
                    ],
                    EYE_COLOR,
                );
            }
            BROW(-1, -1.15, -1.15, 0.95, -0.8, 1.2);
            BROW(1, 1.15, -1.15, -0.95, -0.8, 1.2);
            LINE(MOUTH, -W * 0.45, U * 0.1, W * 0.45, U * 0.1, 1.2);
            break;
        case 'attack':
            CHEEKS(1, 0.8);
            for (const EYE of EYES) {
                FILL(EYE, ellipsePath(0, U * 0.1, U * 0.95, U * 0.84), EYE_COLOR);
            }
            BROW(-1, -1.3, -1.55, 1.1, -0.7, 1.5);
            BROW(1, 1.3, -1.55, -1.1, -0.7, 1.5);
            OPEN_MOUTH(W * 0.85, U * 1.5, false);
            FILL(
                MOUTH,
                [
                    ['M', -W * 0.62, -U * 0.05],
                    ['L', W * 0.62, -U * 0.05],
                    ['L', W * 0.62, U * 0.4],
                    ['L', -W * 0.62, U * 0.4],
                    ['Z'],
                ],
                '#ffffff',
            );
            break;
        case 'surprised':
            CHEEKS(1, 0.9);
            for (const EYE of EYES) {
                FILL(EYE, ellipsePath(0, 0, U * 1.12, U * 1.28), EYE_COLOR);
                FILL(EYE, ellipsePath(-0.35 * U, -0.5 * U, U * 0.38, U * 0.38), GLINT_COLOR);
                FILL(EYE, ellipsePath(0.4 * U, 0.4 * U, U * 0.17, U * 0.17), GLINT_COLOR, 0.85);
                CURVE(EYE, -U, -U * 1.85, 0, -U * 2.4, U, -U * 1.85, 0.8);
            }
            FILL(MOUTH, ellipsePath(0, U * 0.55, U * 0.5, U * 0.72), INK_COLOR);
            break;
        case 'hurt':
            CHEEKS(1, 0.8);
            STROKE(
                EYES[0],
                [
                    ['M', -U * 0.9, -U * 0.8],
                    ['L', U * 0.8, 0],
                    ['L', -U * 0.9, U * 0.8],
                ],
                1.3,
            );
            STROKE(
                EYES[1],
                [
                    ['M', U * 0.9, -U * 0.8],
                    ['L', -U * 0.8, 0],
                    ['L', U * 0.9, U * 0.8],
                ],
                1.3,
            );
            STROKE(
                MOUTH,
                [
                    ['M', -W * 0.8, U * 0.3],
                    ['Q', -W * 0.4, -U * 0.35, 0, U * 0.3],
                    ['Q', W * 0.4, U * 0.95, W * 0.8, U * 0.3],
                ],
                1.1,
            );
            break;
        case 'hungry':
            CHEEKS(1, 0.6);
            for (const EYE of EYES) {
                FILL(EYE, ellipsePath(0, U * 0.15, U * 0.95, U * 0.84), EYE_COLOR);
                FILL(EYE, ellipsePath(-0.25 * U, -0.05 * U, U * 0.3, U * 0.3), GLINT_COLOR);
            }
            BROW(-1, -1.1, -1.0, 1.0, -1.5, 0.9);
            BROW(1, 1.1, -1.0, -1.0, -1.5, 0.9);
            CURVE(MOUTH, -W * 0.5, U * 0.5, 0, -U * 0.2, W * 0.5, U * 0.5, 1.1);
            break;
        case 'dead':
            CHEEKS(1, 0.5);
            for (const EYE of EYES) {
                LINE(EYE, -U * 0.8, -U * 0.8, U * 0.8, U * 0.8, 1.2);
                LINE(EYE, U * 0.8, -U * 0.8, -U * 0.8, U * 0.8, 1.2);
            }
            LINE(MOUTH, -W * 0.45, U * 0.2, W * 0.45, U * 0.2, 1.1);
            break;
        case 'temperament-0': // 느긋: small round eyes gazing up, relaxed shallow smile
            CHEEKS(1.1, 0.9);
            for (const EYE of EYES) {
                FILL(EYE, ellipsePath(0, 0, U * 0.72, U * 0.84), EYE_COLOR);
                FILL(EYE, ellipsePath(U * 0.1, -U * 0.3, U * 0.3, U * 0.3), GLINT_COLOR);
            }
            CURVE(MOUTH, -W * 0.55, U * 0.1, 0, W * 0.55 + U * 0.1, W * 0.55, U * 0.1, 1.1);
            break;
        case 'temperament-1': // 소심: wet eyes, worried brows, trembling mouth
            CHEEKS(1, 0.9);
            for (const EYE of EYES) {
                FILL(EYE, ellipsePath(0, U * 0.05, U, U * 1.15), EYE_COLOR);
                FILL(EYE, ellipsePath(-U * 0.3, -U * 0.35, U * 0.4, U * 0.4), GLINT_COLOR);
                FILL(EYE, ellipsePath(U * 0.35, U * 0.4, U * 0.2, U * 0.2), GLINT_COLOR, 0.9);
            }
            BROW(-1, -1.1, -1.0, 0.9, -1.7, 0.95);
            BROW(1, 1.1, -1.0, -0.9, -1.7, 0.95);
            STROKE(
                MOUTH,
                [
                    ['M', -W * 0.55, U * 0.3],
                    ['Q', -W * 0.28, -U * 0.15, 0, U * 0.3],
                    ['Q', W * 0.28, U * 0.75, W * 0.55, U * 0.3],
                ],
                1.0,
            );
            break;
        case 'temperament-2': // 발끈: slanted brows, round dark eyes, pout
            CHEEKS(1.15);
            for (const EYE of EYES) {
                FILL(EYE, ellipsePath(0, U * 0.1, U * 0.9, U * 0.9), EYE_COLOR);
            }
            BROW(-1, -1.3, -1.5, 1.0, -0.8, 1.2);
            BROW(1, 1.3, -1.5, -1.0, -0.8, 1.2);
            CURVE(MOUTH, -W * 0.5, U * 0.45, 0, -U * 0.25, W * 0.5, U * 0.45, 1.1);
            break;
        case 'temperament-3': // 까불: one big eye, one wink, open grin with tongue
            CHEEKS(1.15);
            FILL(EYES[0], ellipsePath(0, 0, U * 1.1, U * 1.26), EYE_COLOR);
            FILL(EYES[0], ellipsePath(-U * 0.3, -U * 0.4, U * 0.4, U * 0.4), GLINT_COLOR);
            FILL(EYES[0], ellipsePath(U * 0.35, U * 0.4, U * 0.17, U * 0.17), GLINT_COLOR, 0.85);
            ARC_UP(1, 1.2);
            OPEN_MOUTH(W * 0.75, U * 1.4, true);
            break;
        case 'temperament-4': // 다정: closed upward-arched eyes, big blush, small smile
            CHEEKS(1.4);
            ARC_UP(0);
            ARC_UP(1);
            SMILE(W * 0.6, W * 0.95, 1.15);
            break;
        default:
            throw new RangeError('Unknown face: ' + faceId);
    }
    return {
        eyes: EYES.map((ops) => Object.freeze(mergeByStyle(ops))),
        mouth: Object.freeze(mergeByStyle(MOUTH)),
        cheeks: Object.freeze(PARTS.cheeks),
    };
}

// anchor: { eyeLeft: [x, y], eyeRight: [x, y], mouth: [x, y] } in the body's SVG canvas.
// cheekColor: the element colour of the unit, or null for the shared cheek colour.
// Returns draw operations in the body's canvas: { fill | stroke: colour, path: [[command, ...NUMBERS]], width?, opacity? }.
export function buildFace(faceId, anchor, cheekColor = null) {
    const PARTS = faceParts(faceId),
        { gap: GAP, origins: ORIGINS } = facePartPlacement(anchor),
        OPS = cheekEllipses(anchor, PARTS.cheeks).map(([cx, cy, rx, ry]) => ({
            fill: cheekColor ?? DEFAULT_CHEEK_COLOR,
            path: ellipsePath(cx, cy, rx, ry),
            opacity: PARTS.cheeks.opacity,
        }));
    for (const [INDEX, PART] of [...PARTS.eyes, PARTS.mouth].entries()) {
        const [OX, OY] = ORIGINS[INDEX];
        for (const OP of PART) {
            OPS.push({
                ...OP,
                path: OP.path.map(([command, ...numbers]) => [
                    command,
                    ...numbers.map((value, index) => (index % 2 ? OY : OX) + value * GAP),
                ]),
                ...(OP.width ? { width: OP.width * GAP } : {}),
            });
        }
    }
    return mergeByStyle(OPS);
}

// SVG markup of the same face, for portraits that are plain SVG images.
export function faceSvg(faceId, anchor, cheekColor = null) {
    const D = (path) =>
        path.map(([command, ...numbers]) => command + numbers.map((n) => +n.toFixed(2)).join(' ')).join('');
    return buildFace(faceId, anchor, cheekColor)
        .map((op) =>
            op.fill
                ? `<path d="${D(op.path)}" fill="${op.fill}"${op.opacity < 1 ? ` opacity="${op.opacity}"` : ''}/>`
                : `<path d="${D(op.path)}" fill="none" stroke="${op.stroke}" stroke-width="${+op.width.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`,
        )
        .join('');
}
