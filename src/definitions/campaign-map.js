// Campaign maps share one short front. Stages select which enemy positions are built.
export function campaignMapLayout(stage) {
    const width = 2400;
    const height = 3000;
    const centerX = width / 2;
    const layout = stage.layout ?? {};
    const spawns = {
        host: { x: centerX, y: 2600 },
        guest: { x: centerX, y: layout.guestY ?? 400 },
    };
    const advance = { id: 'advance', label: '전진 식량 거점', x: 970, y: 1925, ...layout.advance };
    const center = { id: 'center', label: '중앙 식량 거점', x: 1475, y: 1500, ...layout.center };
    const front = { id: 'enemy-front', label: '전방 식량 거점', x: 950, y: 1050, ...layout.front };
    const ridge = { id: 'enemy-ridge', label: '언덕 보급 거점', x: 2075, y: 1775 };
    const oil = { id: 'oil', label: '측면 기름 거점', x: 2135, y: 2440 };
    // Mirror of the player's oil outpost around the map centre, measured from the enemy base.
    const enemyOil = {
        id: 'enemy-oil',
        label: '적 기름 거점',
        x: width - oil.x,
        y: spawns.guest.y + (spawns.host.y - oil.y),
    };
    const hasRidge = stage.enemyOutposts.includes(ridge.id);
    const hasOil = stage.friendlyOutposts?.includes(oil.id);
    const rear = { id: 'enemy-rear', label: '후방 보급 거점', x: 1685, y: 875 };
    const hasRear = stage.enemyOutposts.includes(rear.id);
    const hasEnemyOil = stage.enemyOutposts.includes(enemyOil.id);
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
        ...(hasOil ? [capturePoint(oil, 'top', 'premium')] : []),
        ...(hasEnemyOil ? [capturePoint(enemyOil, 'bot', 'premium')] : []),
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
            top: hasOil ? route(spawns.host, oil, center) : [],
            bot: hasRidge ? route(center, { x: ridge.x - 270, y: ridge.y }, ridge, rear) : [],
        },
        capturePoints: stage.mission?.heroLesson ? [] : capturePoints,
        terrain,
    };
}
