import {
    halfTurn,
    neutralCapturePoint,
    noWater,
    pairedCapturePoints,
    turnedLane,
} from './pvp-map-layout.js';

const point = ([x, y]) => ({ x, y });

// A short field: each base sits on a hill with a narrow side ramp and a wide front ramp, the west food point on a
// low hill of its own, two rocks pinching the road out of the front yard, and one contested oil in the middle.
// Everything is laid out for the host and turned half a turn for the guest.
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
    // Where the roads leave the base hill by its front ramp, and where the east road leaves that ramp.
    const baseExit = { x: 925, y: 3195 };
    const rampExit = { x: 1175, y: 2812 };

    // Raised ground (level 1), clockwise on screen. A ramp is [name, edge, t0, t1, run]: cut `run` deep into the
    // hill from the stretch t0..t1 of that edge.
    const hills = [
        {
            id: 'hill',
            points: [
                [0, 2700],
                [240, 2632],
                [630, 2648],
                [700, 2946],
                [1270, 2854],
                [1400, 3000],
                [1540, 3220],
                [1570, 3440],
                [1500, 3600],
                [0, 3600],
            ],
            ramps: [
                ['west', 1, 0.2051, 0.8205, 220],
                // The front ramp stays wide: its west wall stands clear of the road from the base.
                ['main', 3, 0.12, 1, 210],
            ],
        },
        {
            id: 'west-hill',
            points: [
                [0, 1650],
                [200, 1590],
                [480, 1590],
                [620, 1760],
                [770, 1810],
                [770, 2030],
                [620, 2130],
                [520, 2410],
                [260, 2410],
                [0, 2330],
            ],
            ramps: [
                ['north', 1, 0.1429, 0.8571, 150],
                ['east', 4, 0.0455, 0.9545, 160],
                ['south', 7, 0.1154, 0.8846, 150],
            ],
        },
    ];
    // Rocks as [[host id, guest id], points]: the old one out in the field, and two beside the road out of the front yard. The west one of the pair
    // runs into the west hill's cliff, so no gap is left there for troops to squeeze through.
    const rocks = [
        [
            ['west-rock', 'east-rock'],
            [
                [700, 1500],
                [1040, 1400],
                [1095, 1550],
                [760, 1650],
            ],
        ],
        [
            ['host-choke-west', 'guest-choke-west'],
            [
                [622, 2146],
                [680, 2065],
                [945, 2256],
                [887, 2337],
            ],
        ],
        [
            ['host-choke-east', 'guest-choke-east'],
            [
                [1163, 2536],
                [1221, 2455],
                [1367, 2560],
                [1309, 2641],
            ],
        ],
    ];
    const sides = [
        ['host', (p) => p],
        ['guest', turn],
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
    const top = [
        host,
        west,
        { x: 450, y: 1150 },
        turn(east),
        turn(rampExit),
        turn(baseExit),
        guest,
    ];
    return {
        width,
        height,
        spawns: { host, guest },
        theme: 'paddy',
        topology: 'small-field',
        flags: [guest, host].map((p) => ({ ...p, forced: false })),
        laneControlPoints: {
            top,
            mid: [host, baseExit, natural, center, turn(natural), turn(baseExit), guest],
            bot: turnedLane(turn, top),
        },
        capturePoints,
        terrain: {
            layers: sides.flatMap(([side, place]) =>
                hills.map((hill) => ({
                    id: `${side}-${hill.id}`,
                    level: 1,
                    points: hill.points.map((p) => place(point(p))),
                })),
            ),
            ramps: sides.flatMap(([side]) =>
                hills.flatMap((hill) =>
                    hill.ramps.map(([name, edge, t0, t1, run]) => ({
                        id: `${side}-${hill.id}-ramp-${name}`,
                        layerId: `${side}-${hill.id}`,
                        edge,
                        t0,
                        t1,
                        run,
                    })),
                ),
            ),
            blockers: sides.flatMap(([, place], side) =>
                rocks.map(([ids, points]) => ({
                    id: ids[side],
                    kind: 'cliff',
                    points: points.map((p) => place(point(p))),
                })),
            ),
            ...noWater(),
        },
    };
}
