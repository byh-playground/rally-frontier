// The blight field (감염 밭, sim/blight-field.js): ground the blight has spread over. Distances are world units,
// times are ms.
export const BlightFieldDefinition = Object.freeze({
    // The ground is judged in square cells of this size; a cell is in a field when its middle is.
    cellSize: 25,
    // Every field starts this wide and widens by `growStep` every `growEveryMs`, up to `maxRadius`.
    startRadius: 100,
    growEveryMs: 10_000,
    growStep: 25,
    maxRadius: 200,
    // Each of the player's ground soldiers and heroes standing on a blighted cell loses this every `damageEveryMs`.
    damage: 5,
    damageEveryMs: 1000,
    // The most cells one stage's fields may span together (the box around every field at its widest).
    maxCells: 16_384,
});
