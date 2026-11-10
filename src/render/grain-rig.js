// The shared grain skeleton and clips (rice, beans, corn, popcorn): pivots and keyframes only;
// each unit's sprite supplies its own artwork.
const parts = [
    { id: 'body', parent: null, pivot: [0, 0] },
    { id: 'legL', parent: 'body', pivot: [-43, 119] },
    { id: 'legR', parent: 'body', pivot: [43, 119] },
    { id: 'armL', parent: 'body', pivot: [-98, 42] },
    { id: 'hand', parent: 'body', pivot: [91, 35] },
    { id: 'armR', parent: 'hand', pivot: [99, 48] },
    { id: 'sickle', parent: 'hand', pivot: [124, 13] },
    { id: 'face', parent: 'body', pivot: [0, 0] },
];
const key = (timeMs, body, hand = 0, legL = 0, legR = 0, armL = 0, easing = 'inOutSine') => ({
    timeMs,
    easing,
    parts: {
        body,
        hand: { rotation: hand },
        legL: { rotation: legL },
        legR: { rotation: legR },
        armL: { rotation: armL },
    },
});
const body = (x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1) => ({
    x: x * 0.6,
    y: y * 0.6,
    rotation,
    scaleX,
    scaleY,
});
export const GRAIN_RIG = Object.freeze({
    parts,
    clips: {
        idle: {
            durationMs: 1200,
            loop: 'repeat',
            keyframes: [
                key(0, body(0, 2.94, 0, 1.012, 0.97), 0.02),
                key(600, body(1.18, -2.94, 0.012, 0.985, 1.03), -0.025),
                key(1200, body(0, 2.94, 0, 1.012, 0.97), 0.02),
            ],
        },
        walk: {
            durationMs: 480,
            loop: 'repeat',
            keyframes: [
                key(0, body(-4.9, 5.88, -0.05, 1.06, 0.94), -0.11),
                key(120, body(-1.96, -15.86, -0.02, 0.95, 1.07), 0, 0.2, -0.2, -0.12),
                key(240, body(4.9, 5.88, 0.05, 1.06, 0.94), 0.11),
                key(360, body(1.96, -15.86, 0.02, 0.95, 1.07), 0, -0.2, 0.2, 0.12),
                key(480, body(-4.9, 5.88, -0.05, 1.06, 0.94), -0.11),
            ],
        },
        fire: {
            durationMs: 1030,
            loop: 'once',
            keyframes: [
                key(0, body()),
                key(280, body(-4, 3, -0.07), -0.65),
                key(605, body(8, 3, 0.09), 0.85),
                key(780, body(8, 3, 0.09), 0.85),
                key(1030, body()),
            ],
        },
        hit: {
            durationMs: 295,
            loop: 'once',
            keyframes: [
                key(0, body(), 0, 0, 0, 0, 'outQuad'),
                key(35, body(15.61, -17.72, 0.16, 0.88, 1.14), -0.18, 0, 0, 0, 'outQuad'),
                key(113, body(-8.81, 9.8, -0.09, 1.1, 0.9), 0.018, 0, 0, 0, 'outQuad'),
                key(204, body(2.94, -1.96, 0.03, 0.98, 1.02), 0.105, 0, 0, 0, 'outQuad'),
                key(295, body(), 0, 0, 0, 0, 'outQuad'),
            ],
        },
    },
});
