// Campaign maps share one short front. Stages select which enemy positions are built.
export function campaignMapLayout(stage) {
    const width = 2400;
    const height = 3000;
    const centerX = width / 2;
    const spawns = {
        host: { x: centerX, y: 2600 },
        guest: { x: centerX, y: 400 },
    };
    // Stagger the pads so automatic fire, including mortar splash, cannot reach another tower.
    const advance = { id: 'advance', label: '전진 보급 거점', x: 970, y: 1925 };
    const center = { id: 'center', label: '중앙 보급 거점', x: 1475, y: 1500 };
    const front = { id: 'enemy-front', label: '전방 보급 거점', x: 950, y: 1050 };
    const ridge = { id: 'enemy-ridge', label: '언덕 보급 거점', x: 2075, y: 1775 };
    const oil = { id: 'oil', label: '측면 기름 거점', x: 2135, y: 2440 };
    const hasRidge = stage.enemyOutposts.includes(ridge.id);
    const rear = {
        id: 'enemy-rear',
        label: '후방 보급 거점',
        x: 1685,
        y: 875,
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
        ...(stage.volleyGoals ? [] : [capturePoint(front)]),
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
                { x: ridge.x - 160, y: ridge.y - 200 },
                { x: ridge.x + 260, y: ridge.y - 200 },
                { x: ridge.x + 260, y: ridge.y + 200 },
                { x: ridge.x - 160, y: ridge.y + 200 },
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
            bot: hasRidge ? route(center, { x: ridge.x - 270, y: ridge.y }, ridge, rear) : [],
        },
        capturePoints,
        terrain,
    };
}
