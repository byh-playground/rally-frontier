// The warning, collision and sprite all sample the same world-space path.
export function fruitProjectilePosition(shot, tick) {
    const returning = shot.turnTick !== null && tick > shot.turnTick;
    const start = returning ? shot.to : shot.from;
    const end = returning ? (shot.returnTo ?? shot.from) : shot.to;
    const firstTick = returning ? shot.turnTick : shot.startTick;
    const lastTick = returning ? shot.endTick : (shot.turnTick ?? shot.endTick);
    const t = Math.max(0, Math.min(1, (tick - firstTick) / (lastTick - firstTick)));
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const distance = Math.hypot(dx, dy) || 1;
    const arc = 4 * t * (1 - t);
    const lateral = (arc * shot.curve) / distance;
    return {
        x: start.x + dx * t - dy * lateral,
        y: start.y + dy * t + dx * lateral,
        z: start.z + (end.z - start.z) * t + arc * shot.height,
    };
}
