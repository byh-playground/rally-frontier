export function artilleryBasinMapLayout() {
    const width = 4000;
    const height = 4300;
    const point = ([x, y]) => ({ x, y });
    const opposite = ({ x, y }) => ({ x: width - x, y: height - y });
    const host = { x: 640, y: 3690 };
    const guest = opposite(host);
    const center = { x: width / 2, y: height / 2 };
    const natural = { x: 950, y: 3350 };
    const oil = { x: 1410, y: 3850 };
    const shoulder = { x: 1870, y: 3150 };
    const edge = { x: 570, y: 2520 };
    const rim = { x: 1060, y: 1880 };

    const capturePoints = [
        ['natural', '본진 앞 식량 거점', 'mid', natural, 'basic'],
        ['oil', '본진 측면 기름 거점', 'bot', oil, 'premium'],
        ['shoulder', '분지 입구 식량 거점', 'bot', shoulder, 'basic'],
        ['edge', '외곽 식량 거점', 'top', edge, 'basic'],
        ['rim', '포격 고지 식량 거점', 'top', rim, 'basic'],
    ].flatMap(([id, label, laneKey, position, resourceType]) => {
        const mirroredLane = laneKey === 'mid' ? laneKey : laneKey === 'top' ? 'bot' : 'top';
        return [
            { id: `basin-${id}-1`, label, laneKey, resourceType, stage: 1, ...position },
            {
                id: `basin-${id}-2`,
                label,
                laneKey: mirroredLane,
                resourceType,
                stage: 2,
                ...opposite(position),
            },
        ];
    });
    capturePoints.push({
        id: 'basin-center',
        label: '분지 중앙 식량 거점',
        laneKey: 'mid',
        resourceType: 'basic',
        stage: 0,
        ...center,
    });
    for (const cp of capturePoints) cp.lane = cp.laneKey.toUpperCase();

    // The low floor opens at both ends of the main diagonal. Each raised rim
    // has two inset ramps along the outer route.
    const basinHalf = [
        [1390, 2850],
        [1210, 2410],
        [1580, 1950],
        [2130, 1425],
    ].map(point);
    const westRim = [
        [265, 1310],
        [1150, 1250],
        [1440, 1550],
        [1380, 1940],
        [1200, 2240],
        [515, 2110],
        [305, 1790],
    ].map(point);
    const layers = [
        { id: 'basin-floor', level: -1, points: [...basinHalf, ...basinHalf.map(opposite)] },
        { id: 'basin-west-rim', level: 1, points: westRim },
        { id: 'basin-east-rim', level: 1, points: westRim.map(opposite) },
    ];
    const ramps = [
        {
            id: 'basin-floor-south',
            layerId: 'basin-floor',
            edge: 7,
            t0: 0.125,
            t1: 0.875,
            run: 150,
        },
        {
            id: 'basin-floor-north',
            layerId: 'basin-floor',
            edge: 3,
            t0: 0.125,
            t1: 0.875,
            run: 150,
        },
        ...['west', 'east'].flatMap((side) => {
            const layerId = `basin-${side}-rim`;
            return [
                { id: `${layerId}-entry`, layerId, edge: 4, t0: 0.55, t1: 0.92, run: 140 },
                { id: `${layerId}-exit`, layerId, edge: 0, t0: 0.4, t1: 0.78, run: 140 },
            ];
        }),
    ];

    const southApproach = [host, natural, point([1620, 2980]), point([1620, 2640])];
    const westRoute = [
        host,
        edge,
        point([680, 2250]),
        point([730, 1950]),
        rim,
        point([800, 1490]),
        point([780, 1170]),
        point([1300, 820]),
        opposite(shoulder),
        opposite(oil),
        guest,
    ];
    const mirroredRoute = (route) => route.map(opposite).reverse();
    return {
        width,
        height,
        spawns: { host, guest },
        biome: 'frontier',
        topology: 'artillery-basin',
        flags: [guest, host].map((p) => ({ ...p, forced: false })),
        laneControlPoints: {
            top: westRoute,
            mid: [...southApproach, center, ...mirroredRoute(southApproach)],
            bot: mirroredRoute(westRoute),
        },
        capturePoints,
        terrain: {
            layers,
            ramps,
            blockers: [],
            riverPath: [],
            riverBranches: [],
            riverPolygon: [],
            riverBranchPolygons: [],
            riverHalfWidth: 0,
            bridges: [],
        },
    };
}
