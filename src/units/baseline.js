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

// A hero grows within one match (HeroGrowth): the enemy soldiers it struck the killing blow on, one each
// whatever their kind. Reaching HERO_LEVEL_KILLS[n] kills makes it level n + 1 (1 to 6). Recovering keeps the
// level, dying ends it with the hero.
export const HERO_LEVEL_KILLS = Object.freeze([0, 10, 25, 45, 70, 100]);
// Each level above 1 adds this share (percent) of the level-1 Definition health and attack, added up, not
// compounded: level L has hp * (100 + 20 * (L - 1)) / 100 and atk * (100 + 10 * (L - 1)) / 100, floored (HeroGrowth).
export const HERO_LEVEL_HP_PCT = 20;
export const HERO_LEVEL_ATK_PCT = 10;

// The leap shared by red beans and popcorn (popcorn lowers the apex).
export const GRAIN_LEAP = Object.freeze({ range: 150, lift: 500, cooldownMs: 3000 });

// The coconut's mass; the walnut weighs the same and the watermelon is twice as heavy.
export const COCONUT_MASS = 1600;

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
export const FOOD_CARD_AMMO = Object.freeze({ max: 3, rechargeMs: 5000 });
export const OIL_CARD_AMMO = Object.freeze({ max: 2, rechargeMs: 5000 });

// A hero flies alone and free, and comes out of the shell on its own (land 'bundle': one soldier at a time). Its
// shell has no landing shock (no impact or splash): each hero's payload adds its own landing strike in its place
// (landingStrike, HeroLandingStrike). The hero looks for its landing spot as far out as the plain shell's splash.
export const HERO_SHELL = Object.freeze({
    reach: SINGLE_BUNDLE_SHELL.reach,
    speed: SINGLE_BUNDLE_SHELL.speed,
    fire: SINGLE_BUNDLE_SHELL.fire,
    deployRadius: SINGLE_BUNDLE_SHELL.splash,
    cost: 0,
    count: 1,
    land: 'bundle',
});
