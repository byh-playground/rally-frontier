// Shared baselines that more than one unit folder derives from. A value used by one unit lives in its folder.

// Food and oil are counted in units of this scale (LaunchRules.resourceScale reads it).
export const RESOURCE_SCALE = 5;

// Body radius per unit of Definition size, and the grain sprite's art-unit scale.
export const UNIT_RENDER_RADIUS_SCALE = 1.56;
export const GRAIN_SPRITE_BASE_SCALE = 2.7 / 260;

// The size unit grain bodies are measured in (a plain grain is one unit).
export const GRAIN_SIZE = 10;

// The plain melee soldier several grains start from (rice uses it as is).
export const BASIC_MELEE = Object.freeze({
    requiresContactTerrain: true,
    construction: { range: 5, workPerHit: 1 },
    hp: 25,
    atk: 5,
    range: 25,
    speed: 75,
    cooldownMs: 1000,
    size: GRAIN_SIZE,
    sizeClass: 'light',
    role: 'bruiser',
    attackVisual: { sourceMotion: 'slash', travel: 'none', impact: 'light' },
    sight: 275,
});

// The heavier front-line bundle price (pea, and peanut at the same price).
export const FRONT_LINE_BUNDLE_COST = 45;

// Every hero walks at the same speed.
export const HERO_MOVE_SPEED = 75;

// The leap shared by red beans and popcorn (popcorn lowers the apex).
export const GRAIN_LEAP = Object.freeze({ range: 150, lift: 500, cooldownMs: 3000 });

// A single shell that drops one squad: corn's original deployment, reused by most single-shot cards.
export const SINGLE_BUNDLE_SHELL = Object.freeze({
    reach: 0.85,
    speed: 750,
    impact: 25,
    splash: 100,
    land: 'bundle',
    fire: Object.freeze({ mode: 'single' }),
});
// A hero flies alone and free.
export const HERO_SHELL = Object.freeze({ ...SINGLE_BUNDLE_SHELL, cost: 0, count: 1 });
