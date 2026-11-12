import {
    halfTurn,
    neutralCapturePoint,
    noWater,
    pairedCapturePoints,
    turnedLane,
} from './pvp-map-layout.js';

// One octagonal hill in the middle carries the only contested oil; each side reaches its top by two ramps.
export function kingsHillMapLayout() {
    const width = 3800;
    const height = 4200;
    const turn = halfTurn(width, height);
    const host = { x: 560, y: 3650 };
    const guest = turn(host);
    const center = { x: width / 2, y: height / 2 };
    const natural = { x: 1000, y: 3200 };
    const west = { x: 450, y: 2200 };
    const south = { x: 2350, y: 3450 };
    const hill = Array.from({ length: 8 }, (_, k) => {
        const angle = ((22.5 + 45 * k) * Math.PI) / 180;
        return {
            x: Math.round(center.x + 560 * Math.cos(angle)),
            y: Math.round(center.y + 560 * Math.sin(angle)),
        };
    });
    // Edge k faces 45·(k+1)°: 1 south and 3 west face the host, 5 north and 7 east the guest.
    const ramps = [1, 3, 5, 7].map((edge) => ({
        id: `kings-hill-ramp-${edge}`,
        layerId: 'kings-hill',
        edge,
        t0: 0.2,
        t1: 0.8,
        run: 160,
    }));
    const rock = [
        { x: 900, y: 1250 },
        { x: 1250, y: 1150 },
        { x: 1350, y: 1450 },
        { x: 1000, y: 1550 },
    ];

    const capturePoints = [
        ...pairedCapturePoints(turn, [
            ['oil', 'mid', '본진 기름 거점', { x: 1250, y: 3950 }, 'premium'],
            ['natural', 'mid', '앞마당 식량 거점', natural, 'basic'],
            ['west', 'top', '서쪽 식량 거점', west, 'basic'],
            ['south', 'bot', '남쪽 식량 거점', south, 'basic'],
        ]),
        neutralCapturePoint('hill-oil', 'mid', '언덕 꼭대기 기름 거점', 'premium', center),
    ];
    const top = [host, west, { x: 650, y: 1050 }, turn(south), guest];
    return {
        width,
        height,
        spawns: { host, guest },
        biome: 'frontier',
        topology: 'kings-hill',
        flags: [guest, host].map((p) => ({ ...p, forced: false })),
        laneControlPoints: {
            top,
            mid: [host, natural, center, turn(natural), guest],
            bot: turnedLane(turn, top),
        },
        capturePoints,
        terrain: {
            layers: [{ id: 'kings-hill', level: 1, points: hill }],
            ramps,
            blockers: [
                { id: 'west-rock', kind: 'cliff', points: rock },
                { id: 'east-rock', kind: 'cliff', points: rock.map(turn) },
            ],
            ...noWater(),
        },
    };
}
