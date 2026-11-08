// Campaign maps share one short front. Stages select which enemy positions are built.
export function campaignMapLayout(stage) {
    const width = 2400;
    const height = 3000;
    const centerX = width / 2;
    const spawns = {
        host: { x: centerX, y: 2600 },
        guest: { x: centerX, y: 400 },
    };
    const advance = { id: 'advance', label: '전진 보급 거점', x: centerX, y: 2200 };
    const center = { id: 'center', label: '중앙 보급 거점', x: centerX, y: 1720 };
    const front = { id: 'enemy-front', label: '전방 보급 거점', x: centerX, y: 1280 };
    const ridge = { id: 'enemy-ridge', label: '언덕 보급 거점', x: 1500, y: 1380 };
    const oil = { id: 'oil', label: '측면 기름 거점', x: 2145, y: 2300 };
    const hasRidge = stage.enemyOutposts.includes(ridge.id);
    const rear = {
        id: 'enemy-rear',
        label: '후방 보급 거점',
        x: centerX,
        // Keep the forward-to-rear third-tier link in the flat oil lessons.
        y: stage.resourceLesson && !hasRidge ? 940 : 850,
    };
    const hasRear = stage.enemyOutposts.includes(rear.id);
    const capturePoint = (point, laneKey = 'mid', resourceType = 'basic') => ({
        ...point,
        laneKey,
        resourceType,
    });
    const capturePoints = [
        capturePoint(advance),
        capturePoint(center),
        capturePoint(front),
        ...(hasRear ? [capturePoint(rear)] : []),
        ...(hasRidge ? [capturePoint(ridge, 'bot')] : []),
        ...(stage.resourceLesson ? [capturePoint(oil, 'top', 'premium')] : []),
    ];

    const layerId = 'campaign-ridge';
    const terrain = {
        layers: [],
        ramps: [],
        blockers: [],
        riverPath: [],
        riverBranches: [],
        riverPolygon: [],
        riverBranchPolygons: [],
        riverHalfWidth: 0,
        bridges: [],
    };
    if (hasRidge) {
        terrain.layers.push({
            id: layerId,
            level: 1,
            points: [
                { x: 1340, y: 1180 },
                { x: 1760, y: 1180 },
                { x: 1760, y: 1580 },
                { x: 1340, y: 1580 },
            ],
        });
        terrain.ramps.push(
            { id: 'ridge-west', layerId, edge: 3, t0: 0.25, t1: 0.75, run: 100 },
            { id: 'ridge-east', layerId, edge: 1, t0: 0.25, t1: 0.75, run: 100 },
        );
    }
    const route = (...points) => points.map(({ x, y }) => ({ x, y }));
    return {
        width,
        height,
        spawns,
        biome: 'frontier',
        topology: 'campaign-front',
        flags: [spawns.guest, spawns.host].map((p) => ({ ...p, forced: false })),
        laneControlPoints: {
            mid: route(
                spawns.host,
                advance,
                center,
                front,
                ...(hasRear ? [rear] : []),
                spawns.guest,
            ),
            top: stage.resourceLesson ? route(spawns.host, oil, center) : [],
            bot: hasRidge
                ? route(center, { x: centerX, y: ridge.y }, ridge, { x: 1840, y: ridge.y }, rear)
                : [],
        },
        capturePoints,
        terrain,
    };
}
