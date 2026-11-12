import {
    halfTurn,
    neutralCapturePoint,
    noWater,
    pairedCapturePoints,
    turnedLane,
} from './pvp-map-layout.js';

// A short open field with two rocks: each side has a safe oil behind its base, and one contested oil in the middle.
export function smallFieldMapLayout() {
    const width = 3000;
    const height = 3600;
    const turn = halfTurn(width, height);
    const host = { x: 500, y: 3150 };
    const guest = turn(host);
    const center = { x: width / 2, y: height / 2 };
    const natural = { x: 900, y: 2650 };
    const west = { x: 350, y: 2000 };
    const east = { x: 1800, y: 2700 };
    const rock = [
        { x: 700, y: 1500 },
        { x: 1040, y: 1400 },
        { x: 1095, y: 1550 },
        { x: 760, y: 1650 },
    ];

    const capturePoints = [
        ...pairedCapturePoints(turn, [
            ['natural', 'mid', '앞마당 식량 거점', natural, 'basic'],
            ['west', 'top', '서쪽 식량 거점', west, 'basic'],
            ['east', 'bot', '동쪽 식량 거점', east, 'basic'],
            ['oil', 'mid', '본진 기름 거점', { x: 1150, y: 3350 }, 'premium'],
        ]),
        neutralCapturePoint('center-oil', 'mid', '중앙 기름 거점', 'premium', center),
    ];
    const top = [host, west, { x: 450, y: 1150 }, turn(east), guest];
    return {
        width,
        height,
        spawns: { host, guest },
        biome: 'frontier',
        topology: 'small-field',
        flags: [guest, host].map((p) => ({ ...p, forced: false })),
        laneControlPoints: {
            top,
            mid: [host, natural, center, turn(natural), guest],
            bot: turnedLane(turn, top),
        },
        capturePoints,
        terrain: {
            layers: [],
            ramps: [],
            blockers: [
                { id: 'west-rock', kind: 'cliff', points: rock },
                { id: 'east-rock', kind: 'cliff', points: rock.map(turn) },
            ],
            ...noWater(),
        },
    };
}
