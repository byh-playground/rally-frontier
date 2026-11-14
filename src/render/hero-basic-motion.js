const HERO_BASIC_STRIKE_MS = 240;
const HERO_BASIC_END_MS = 480;

// The first part of the clip is normalized to each unit's windup. The
// release pose sits on the simulation tick that committed the basic attack.
export function heroBasicAttackElapsedMs(combat, renderTick, tps) {
    if (!combat || !Number.isFinite(renderTick) || !(tps > 0)) return null;
    const { attackWindupStartedAt: start, attackWindupUntil: end, basicAttackTick } = combat;
    if (end > start && renderTick >= start && renderTick < end)
        return ((renderTick - start) / (end - start)) * HERO_BASIC_STRIKE_MS;

    if (!Number.isFinite(basicAttackTick)) return null;
    const elapsed = HERO_BASIC_STRIKE_MS + ((renderTick - basicAttackTick) * 1000) / tps;
    return elapsed >= HERO_BASIC_STRIKE_MS && elapsed < HERO_BASIC_END_MS ? elapsed : null;
}

export function createHeroBasicAttackClip({ windup, strike, followThrough }) {
    // GameKit carries channels across omitted keys. Every authored channel
    // needs an explicit rest value so the final key returns to the idle pose.
    const rest = {};
    for (const parts of [windup, strike, followThrough])
        for (const [part, pose] of Object.entries(parts)) {
            const channels = (rest[part] ??= {});
            for (const field of Object.keys(pose))
                channels[field] = field.startsWith('scale') || field === 'opacity' ? 1 : 0;
        }
    const key = (timeMs, easing, parts = {}) => ({
        timeMs,
        easing,
        parts: Object.fromEntries(
            Object.entries(rest).map(([part, pose]) => [part, { ...pose, ...parts[part] }]),
        ),
    });
    return {
        durationMs: HERO_BASIC_END_MS,
        loop: 'once',
        keyframes: [
            key(0, 'linear'),
            key(170, 'outQuad', windup),
            key(HERO_BASIC_STRIKE_MS, 'linear', strike),
            key(315, 'outQuad', followThrough),
            key(HERO_BASIC_END_MS, 'inOutSine'),
        ],
    };
}
