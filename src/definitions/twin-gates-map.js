export function twinGatesMapLayout() {
    const width = 3800;
    const height = 4200;
    const mirror = ({ x, y }) => ({ x: width - x, y: height - y });
    const host = { x: 560, y: 3550 };
    const guest = mirror(host);
    const natural = { x: 900, y: 3230 };
    const oil = { x: 1300, y: 3830 };
    const westStaging = { x: 520, y: 2450 };
    const southStaging = { x: 2250, y: 3320 };
    const northGate = { x: 520, y: 1500 };

    const top = [
        host,
        natural,
        westStaging,
        northGate,
        { x: 435, y: 855 },
        { x: 739, y: 647 },
        { x: 1122, y: 610 },
        mirror(southStaging),
        mirror(natural),
        guest,
    ];
    const bot = top.slice().reverse().map(mirror);
    const capturePoints = [
        ['natural', 'mid', '앞마당 식량 거점', '앞마당 식량 거점', natural, 'basic'],
        ['oil', 'mid', '본진 기름 거점', '본진 기름 거점', oil, 'premium'],
        ['outer-staging', 'top', '서쪽 전진 거점', '동쪽 전진 거점', westStaging, 'basic'],
        ['inner-staging', 'bot', '남쪽 전진 거점', '북쪽 전진 거점', southStaging, 'basic'],
        ['gate', 'top', '북서 관문', '남동 관문', northGate, 'basic'],
    ].flatMap(([id, homeLane, homeLabel, awayLabel, position, resourceType]) => {
        const awayLane = { top: 'bot', mid: 'mid', bot: 'top' }[homeLane];
        return [
            { stage: 1, laneKey: homeLane, label: homeLabel, position },
            { stage: 2, laneKey: awayLane, label: awayLabel, position: mirror(position) },
        ].map(({ stage, laneKey, label, position }) => ({
            id: `${id}-${stage}`,
            lane: laneKey.toUpperCase(),
            laneKey,
            label,
            stage,
            resourceType,
            ...position,
        }));
    });

    const rockWall = [
        { x: 660, y: 952 },
        { x: 1003, y: 830 },
        { x: 1689, y: 1392 },
        { x: 2349, y: 1770 },
    ];
    return {
        width,
        height,
        spawns: { host, guest },
        biome: 'frontier',
        topology: 'twin-gates',
        flags: [guest, host].map((p) => ({ ...p, forced: false })),
        laneControlPoints: { top, mid: [], bot },
        capturePoints,
        terrain: {
            layers: [],
            ramps: [],
            blockers: [
                {
                    id: 'central-rock-wall',
                    kind: 'cliff',
                    points: [...rockWall, ...rockWall.map(mirror)],
                },
            ],
            riverPath: [],
            riverBranches: [],
            riverPolygon: [],
            riverBranchPolygons: [],
            riverHalfWidth: 0,
            bridges: [],
        },
    };
}
