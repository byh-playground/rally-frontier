// Gameplay tuning constants: view, terrain reveal, collision and sampling cadence.
const VIEW_H = 1500,
    VIEW_W = 900;
const TERRAIN_ATTACK_REVEAL_MS = 1000;
const TERRAIN_ATTACK_REVEAL_RADIUS = 40;
const COLLISION_RADIUS_SCALE = 1.35;
// Ground speed in a river (a bridge is dry ground). Also the source of a river cell's path cost: crossing it takes
// 1 / RIVER_MOVEMENT_MULTIPLIER times as long, so the flow fields weigh water by that time (TerrainNavigation).
const RIVER_MOVEMENT_MULTIPLIER = 0.5;
// Runtime-only fixed-cell spatial indexes. They never enter checksum/exportState.
// Combat and range queries share the same deterministic unit grid (contact candidates live in the contact solver).
// Final distance/contact tests remain exact, so the grid changes candidate discovery only.
const SIM_SPATIAL_CELL = 256;
// Cell size of the per-side vision grid (GameKit vision module); sight radii round to this.
const VISION_CELL = 32;
const PERF_SAMPLE_EVERY_MS = 1000;
const BALANCE_SAMPLE_EVERY_MS = 1000;
const BALANCE_HISTORY_EVERY_MS = 30000;
const BALANCE_HISTORY_MAX = 160;

export {
    BALANCE_HISTORY_EVERY_MS,
    BALANCE_HISTORY_MAX,
    BALANCE_SAMPLE_EVERY_MS,
    COLLISION_RADIUS_SCALE,
    PERF_SAMPLE_EVERY_MS,
    RIVER_MOVEMENT_MULTIPLIER,
    SIM_SPATIAL_CELL,
    TERRAIN_ATTACK_REVEAL_MS,
    TERRAIN_ATTACK_REVEAL_RADIUS,
    VIEW_H,
    VIEW_W,
    VISION_CELL,
};
