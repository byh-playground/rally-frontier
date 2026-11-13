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

// The walnut's mass; the watermelon is twice as heavy.
export const WALNUT_MASS = 1600;

// A single shell that drops one squad: corn's original deployment, reused by most single-shot cards.
// Its squad bursts out of the impact all at once (land 'burst', millet's landing); `spreadAcross` > 1
// throws it wider across the shot than along it.
export const SINGLE_BUNDLE_SHELL = Object.freeze({
    reach: 0.85,
    speed: 750,
    impact: 25,
    splash: 100,
    land: 'burst',
    fire: Object.freeze({ mode: 'single' }),
});
// Card ammo (CardAmmo): a launch spends one round, and a card below its max refills one round per rechargeMs.
// A card without payload.ammo takes the food default, or the oil default when it costs oil (premiumCost). Heroes
// have no ammo.
export const FOOD_CARD_AMMO = Object.freeze({ max: 3, rechargeMs: 10000 });
export const OIL_CARD_AMMO = Object.freeze({ max: 2, rechargeMs: 20000 });

// A hero flies alone and free, and comes out of the shell on its own (land 'bundle': one soldier at a time).
export const HERO_SHELL = Object.freeze({
    ...SINGLE_BUNDLE_SHELL,
    cost: 0,
    count: 1,
    land: 'bundle',
});
