import { halfTurn, noWater, pairedCapturePoints, turnedLane } from './pvp-map-layout.js';

// Three staggered cliff walls fold the ground road into an S: far on foot, near through the air. Each side has a
// safe oil behind its base and an oil in one pass at the ends of the middle wall.
export function windRavinesMapLayout() {
    const width = 3600;
    const height = 4400;
    const turn = halfTurn(width, height);
    const host = { x: 520, y: 3880 };
    const guest = turn(host);
    const natural = { x: 1000, y: 3450 };
    const eastStaging = { x: 3000, y: 3150 };
    const ravine = { x: 1400, y: 2520 };
    const passOil = { x: 2850, y: 1950 };
    // The north wall runs from x 1250 to the east edge; the south wall is its half turn.
    const northWall = [
        { x: 1250, y: 1630 },
        { x: 3600, y: 1300 },
        { x: 3600, y: 1440 },
        { x: 1250, y: 1770 },
    ];
    const middleWall = [
        { x: 950, y: 2260 },
        { x: 2650, y: 2000 },
        { x: 2650, y: 2140 },
        { x: 950, y: 2400 },
    ];

    const capturePoints = pairedCapturePoints(turn, [
        ['oil', 'mid', '본진 기름 거점', { x: 1150, y: 4150 }, 'premium'],
        ['natural', 'top', '앞마당 식량 거점', natural, 'basic'],
        ['east-staging', 'bot', '동쪽 전진 거점', eastStaging, 'basic'],
        ['ravine', 'top', '골짜기 식량 거점', ravine, 'basic'],
        ['pass-oil', 'bot', '고개 기름 거점', passOil, 'premium'],
    ]);
    // Past the south wall's east end, through the west pass of the middle wall and round the north wall's west end.
    const top = [
        host,
        natural,
        eastStaging,
        { x: 2950, y: 2750 },
        { x: 2450, y: 2500 },
        ravine,
        turn(passOil),
        { x: 650, y: 1650 },
        turn(eastStaging),
        turn(natural),
        guest,
    ];
    return {
        width,
        height,
        spawns: { host, guest },
        biome: 'frontier',
        topology: 'wind-ravines',
        flags: [guest, host].map((p) => ({ ...p, forced: false })),
        laneControlPoints: { top, mid: [], bot: turnedLane(turn, top) },
        capturePoints,
        terrain: {
            layers: [],
            ramps: [],
            blockers: [
                { id: 'north-wall', kind: 'cliff', points: northWall },
                { id: 'middle-wall', kind: 'cliff', points: middleWall },
                { id: 'south-wall', kind: 'cliff', points: northWall.map(turn) },
            ],
            ...noWater(),
        },
    };
}
