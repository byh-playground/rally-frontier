import { halfTurn, pairedCapturePoints, turnedLane } from './pvp-map-layout.js';

// A wide river crosses the whole map at right angles to the base axis; two straight causeways along that axis
// cross it without the water's penalty. No safe oil: each side's oil stands on its own bank.
export function causewayFlatsMapLayout() {
    const width = 4000;
    const height = 4400;
    const turn = halfTurn(width, height);
    const host = { x: 600, y: 3800 };
    const guest = turn(host);
    const center = { x: width / 2, y: height / 2 };
    const axis = Math.atan2(guest.y - host.y, guest.x - host.x);
    // The river's centre line meets the west and east edges. Its water, 220 to either side of that line, runs 500
    // past both edges: the drawn surface's lighter inner band is inset toward the ribbon's middle and would
    // otherwise stop short of the edges.
    const riverPath = [
        { x: 0, y: 450 },
        { x: width, y: 3950 },
    ];
    const riverPolygon = [
        { x: -231, y: -45 },
        { x: 4521, y: 4114 },
        { x: 4231, y: 4445 },
        { x: -521, y: 286 },
    ];
    // Causeways stand on the centre line 1000 to either side of the middle and run along the base axis.
    const causeway = { x: 1247, y: 1542 };
    const bridges = [causeway, turn(causeway)].map((p, i) => ({
        id: `causeway-${i}`,
        level: 0,
        ...p,
        angle: axis,
        halfLength: 360,
        halfWidth: 60,
    }));
    const natural = { x: 1050, y: 3250 };
    const oil = { x: 1600, y: 2650 };
    // Each causeway's host end has a supply point a little off the road, the guest end its half turn.
    const westHead = { x: 900, y: 2050 };
    const eastHead = { x: 2400, y: 3350 };

    const capturePoints = pairedCapturePoints(turn, [
        ['natural', 'mid', '앞마당 식량 거점', natural, 'basic'],
        ['rear', 'bot', '후방 식량 거점', { x: 1650, y: 4050 }, 'basic'],
        ['oil', 'mid', '강변 기름 거점', oil, 'premium'],
        ['west-head', 'top', '서쪽 둑길 거점', westHead, 'basic'],
        ['east-head', 'bot', '동쪽 둑길 거점', eastHead, 'basic'],
    ]);
    const top = [host, natural, westHead, causeway, turn(eastHead), turn(natural), guest];
    return {
        width,
        height,
        spawns: { host, guest },
        biome: 'frontier',
        topology: 'causeway-flats',
        flags: [guest, host].map((p) => ({ ...p, forced: false })),
        laneControlPoints: {
            top,
            mid: [host, oil, center, turn(oil), guest],
            bot: turnedLane(turn, top),
        },
        capturePoints,
        terrain: {
            layers: [],
            ramps: [],
            blockers: [],
            riverPath,
            riverBranches: [],
            riverPolygon,
            riverBranchPolygons: [],
            riverHalfWidth: 220,
            bridges,
        },
    };
}
