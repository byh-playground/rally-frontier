// The blight field (감염 밭): ground the blight has spread over. A blighted stage declares where its fields start
// (campaign.js `blightFields: [{ x, y }]`) and, for a stage without fire of its own, braziers
// (`braziers: [{ x, y, radius }]`). Numbers: definitions/blight-field.js.
// - The ground is a grid of `cellSize` cells laid on the world's own grid (a cell's middle decides everything about
//   it). `sim.blightField` is the only state and exists only in a stage that declares fields:
//       { col0, row0, cols, rows,     the box of cells around every field at its widest (clamped to the map)
//         cells,                      cols × rows numbers, row by row: CLEAN 0, BLIGHTED 1, PURIFIED 2
//         radius,                     every field's radius now
//         growClock, damageClock,     tickTime `every` accumulators (growEveryMs, damageEveryMs)
//         lit }                       one boolean per declared brazier
//   It is plain data (the state codec takes no typed array), made once at the match start and changed in place: no
//   tick allocates. A match without fields has no such cell, so its state and checksum are what they were.
// - Growth runs on the mission's clock (CampaignMission): while a stage's practice runs the radius stays as it
//   started, and it widens `growEveryMs` after the practice ends as it would after a match start. Harm keeps its own
//   clock: it is not a mission timing.
// - Spread: at the start and each time the radius grows, every CLEAN cell whose middle is within the radius of a
//   field's middle becomes BLIGHTED. A PURIFIED cell is skipped for the rest of the match.
// - Harm: every `damageEveryMs`, each living ground soldier or hero of the player's side whose position is on a
//   BLIGHTED cell takes `damage` through StrategySim.applyDamage (source side the blight's, source 'blight-field').
//   A flying unit, a building and the blight's own side take none. One `blightFieldPulse` event (the middle of the
//   hurt units, how many) comes before that tick's hits, so the presentation shows one number for them.
// - Fire purifies. Each burn (damage tick) of a player's flame that burns the blight (Unit Definition
//   `breathAttack.blightBurn { cellsPerPulse }`, chili; UnitBreathAttack.pulse → `burn`) purifies `cellsPerPulse`
//   BLIGHTED cells of those whose middle is within half a cell of the flame's sector and in clear terrain line from
//   the unit: the nearest first, the lower index in a tie. A longer flame reaches farther and burns no more cells a
//   tick. With no enemy in its attack reach such a unit stands and aims its flame at the nearest blighted cell in
//   reach (`nearestBlighted`), on the flame's own sustain timing. A brazier lights the first tick the player's side alone holds its place, by the capture
//   point's presence rule (StrategySim.capturePresence), and stays lit: every cell within its radius becomes
//   PURIFIED, clean ones too, so the field never grows into a lit brazier's ground.
// - This is a mission area, not an attack: it uses no `sustain`, has no unit and nobody can target it.
import { BlightFieldDefinition as RULE } from '../definitions/blight-field.js';
import { Blight } from './blight.js';
import { CampaignMission } from './campaign-mission.js';
import { UnitFlight } from './capabilities/unit-flight.js';
import { IndexList } from './index-list.js';

const CLEAN = 0,
    BLIGHTED = 1,
    PURIFIED = 2;
const SOURCE = 'blight-field';
// The field's hit: no size matrix, no source entity to reveal or to miss uphill, no impact sparks and no screen
// shake (`ambient`).
const HIT = Object.freeze({
    damageClass: 'normal',
    sourceDamageResolved: true,
    suppressImpactFx: true,
    ambient: true,
});
const HURT = new IndexList();

export class BlightField {
    static CLEAN = CLEAN;
    static BLIGHTED = BLIGHTED;
    static PURIFIED = PURIFIED;
    static SOURCE = SOURCE;

    // The stage's declaration, checked: its campaign rules when it declares fields, else null.
    static declared(sim) {
        const campaign = sim.rules.campaign,
            fields = campaign?.blightFields,
            braziers = campaign?.braziers;
        if (fields === undefined) {
            if (braziers !== undefined)
                throw new Error('화로는 감염 밭(blightFields)을 선언한 판에만 둘 수 있습니다.');
            return null;
        }
        if (!Blight.declared(sim))
            throw new Error('감염 밭은 감염(blight: true)을 선언한 판에만 둘 수 있습니다.');
        if (!Array.isArray(fields) || !fields.length)
            throw new Error('감염 밭 선언은 비어 있지 않은 목록이어야 합니다.');
        const inside = (place) =>
            Number.isFinite(place?.x) &&
            Number.isFinite(place?.y) &&
            place.x >= 0 &&
            place.y >= 0 &&
            place.x <= sim.world.width &&
            place.y <= sim.world.height;
        for (const field of fields)
            if (!inside(field)) throw new Error('감염 밭 선언에는 맵 안의 x, y가 필요합니다.');
        if (braziers !== undefined) {
            if (!Array.isArray(braziers) || !braziers.length)
                throw new Error('화로 선언은 비어 있지 않은 목록이어야 합니다.');
            for (const brazier of braziers)
                if (!inside(brazier) || !Number.isFinite(brazier.radius) || brazier.radius <= 0)
                    throw new Error('화로 선언에는 맵 안의 x, y와 양수 radius가 필요합니다.');
        }
        return campaign;
    }

    // Match start (StrategySim constructor): the grid around the declared fields, blighted out to the start radius.
    static initialize(sim) {
        const campaign = this.declared(sim);
        if (!campaign) return;
        const { cellSize, maxRadius } = RULE;
        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;
        for (const { x, y } of campaign.blightFields) {
            minX = Math.min(minX, x - maxRadius);
            minY = Math.min(minY, y - maxRadius);
            maxX = Math.max(maxX, x + maxRadius);
            maxY = Math.max(maxY, y + maxRadius);
        }
        const col0 = Math.max(0, Math.floor(minX / cellSize)),
            row0 = Math.max(0, Math.floor(minY / cellSize)),
            cols =
                Math.min(Math.ceil(sim.world.width / cellSize), Math.ceil(maxX / cellSize)) - col0,
            rows =
                Math.min(Math.ceil(sim.world.height / cellSize), Math.ceil(maxY / cellSize)) - row0;
        if (cols * rows > RULE.maxCells)
            throw new Error(
                `감염 밭이 차지하는 칸이 너무 많습니다: ${cols} × ${rows} (최대 ${RULE.maxCells})`,
            );
        sim.blightField = {
            col0,
            row0,
            cols,
            rows,
            cells: new Array(cols * rows).fill(CLEAN),
            radius: RULE.startRadius,
            growClock: 0,
            damageClock: 0,
            lit: (campaign.braziers ?? []).map(() => false),
        };
        this.spread(sim);
    }

    // Visits every cell of the grid whose middle is within `radius` of (x, y): `visit(state, index)`.
    static eachCellWithin(state, x, y, radius, visit) {
        const size = RULE.cellSize,
            { col0, row0, cols, rows } = state,
            fromCol = Math.max(0, Math.floor((x - radius) / size) - col0),
            toCol = Math.min(cols - 1, Math.floor((x + radius) / size) - col0),
            fromRow = Math.max(0, Math.floor((y - radius) / size) - row0),
            toRow = Math.min(rows - 1, Math.floor((y + radius) / size) - row0),
            radius2 = radius * radius;
        for (let row = fromRow; row <= toRow; row++) {
            const dy = (row0 + row + 0.5) * size - y;
            for (let col = fromCol; col <= toCol; col++) {
                const dx = (col0 + col + 0.5) * size - x;
                if (dx * dx + dy * dy <= radius2) visit(state, row * cols + col);
            }
        }
    }
    static blightCell(state, index) {
        if (state.cells[index] === CLEAN) state.cells[index] = BLIGHTED;
    }
    static purifyCell(state, index) {
        state.cells[index] = PURIFIED;
    }

    // Every clean cell inside a field's radius becomes blighted; a purified one stays as it is.
    static spread(sim) {
        const state = sim.blightField;
        for (const { x, y } of sim.rules.campaign.blightFields)
            this.eachCellWithin(state, x, y, state.radius, BlightField.blightCell);
    }

    // The cell state under a world position (CLEAN outside the grid).
    static at(sim, x, y) {
        const state = sim.blightField;
        if (!state) return CLEAN;
        const col = Math.floor(x / RULE.cellSize) - state.col0,
            row = Math.floor(y / RULE.cellSize) - state.row0;
        if (col < 0 || row < 0 || col >= state.cols || row >= state.rows) return CLEAN;
        return state.cells[row * state.cols + col];
    }

    // One tick (StrategySim.stepSimulation, after the capture points): braziers, then growth, then harm.
    static update(sim) {
        const state = sim.blightField;
        if (!state) return;
        const braziers = sim.rules.campaign.braziers,
            player = 1 - Blight.ENEMY_SIDE;
        for (let i = 0; i < state.lit.length; i++) {
            const brazier = braziers[i];
            if (state.lit[i] || sim.capturePresence(brazier.x, brazier.y) !== player) continue;
            state.lit[i] = true;
            this.eachCellWithin(
                state,
                brazier.x,
                brazier.y,
                brazier.radius,
                BlightField.purifyCell,
            );
        }
        // The fields widen on the mission's clock: not while a practice holds it (CampaignMission.startTick).
        if (CampaignMission.startTick(sim) !== null)
            state.growClock = sim.time.every(
                state.growClock,
                RULE.growEveryMs,
                BlightField.grow,
                sim,
            );
        state.damageClock = sim.time.every(
            state.damageClock,
            RULE.damageEveryMs,
            BlightField.harm,
            sim,
        );
    }

    // The fields widen one step (until they are at their widest).
    static grow(sim) {
        const state = sim.blightField;
        if (state.radius >= RULE.maxRadius) return;
        state.radius = Math.min(RULE.maxRadius, state.radius + RULE.growStep);
        BlightField.spread(sim);
    }

    // Does the field hurt this unit where it stands? The player's living ground soldiers and heroes.
    static harms(sim, unit) {
        return (
            unit.alive &&
            unit.side !== Blight.ENEMY_SIDE &&
            !UnitFlight.airborne(unit) &&
            this.at(sim, unit.x, unit.y) === BLIGHTED
        );
    }

    // One harm: everything the field hurts takes `damage`, after one event that says where and how many.
    static harm(sim) {
        let x = 0,
            y = 0;
        HURT.reserve(sim.units.length);
        HURT.count = 0;
        for (let i = 0; i < sim.units.length; i++) {
            const unit = sim.units[i];
            if (!BlightField.harms(sim, unit)) continue;
            HURT.items[HURT.count++] = i;
            x += unit.x;
            y += unit.y;
        }
        const count = HURT.count;
        if (!count) return;
        sim.events.push({
            type: 'blightFieldPulse',
            side: 1 - Blight.ENEMY_SIDE,
            sourceId: SOURCE,
            x: x / count,
            y: y / count,
            hits: count,
        });
        for (let k = 0; k < count; k++)
            sim.applyDamage(
                Blight.ENEMY_SIDE,
                SOURCE,
                sim.units[HURT.items[k]],
                false,
                RULE.damage,
                SOURCE,
                HIT,
            );
    }

    // Can this unit's flame purify the field? A flame that burns the blight (`breathAttack.blightBurn`) on the
    // player's side, in a match with fields.
    static burner(sim, unit, spec) {
        return !!spec.blightBurn && !!sim.blightField && unit.side !== Blight.ENEMY_SIDE;
    }

    // The blighted cell nearest to `unit` whose middle is within `reach` of it and in clear terrain line, or -1:
    // what a burner's flame aims at when no enemy is in its reach (StrategySim.updateCombat). The lower cell index
    // wins a tie. `cellX`·`cellY` give the cell's middle.
    static nearestBlighted(sim, unit, reach) {
        const state = sim.blightField,
            size = RULE.cellSize,
            { col0, row0, cols, rows, cells } = state,
            fromCol = Math.max(0, Math.floor((unit.x - reach) / size) - col0),
            toCol = Math.min(cols - 1, Math.floor((unit.x + reach) / size) - col0),
            fromRow = Math.max(0, Math.floor((unit.y - reach) / size) - row0),
            toRow = Math.min(rows - 1, Math.floor((unit.y + reach) / size) - row0),
            terrain = sim.world.terrain.field;
        let best = -1,
            bestDistance2 = reach * reach;
        for (let row = fromRow; row <= toRow; row++) {
            const cy = (row0 + row + 0.5) * size,
                dy = cy - unit.y;
            for (let col = fromCol; col <= toCol; col++) {
                const index = row * cols + col;
                if (cells[index] !== BLIGHTED) continue;
                const cx = (col0 + col + 0.5) * size,
                    dx = cx - unit.x,
                    distance2 = dx * dx + dy * dy;
                // Rows and columns run in index order, so a strict comparison keeps the lower index of a tie.
                if (
                    (best < 0 ? distance2 > bestDistance2 : distance2 >= bestDistance2) ||
                    !terrain.polygonSegmentClear(unit.x, unit.y, cx, cy, 0)
                )
                    continue;
                best = index;
                bestDistance2 = distance2;
            }
        }
        return best;
    }
    static cellX(sim, index) {
        const state = sim.blightField;
        return (state.col0 + (index % state.cols) + 0.5) * RULE.cellSize;
    }
    static cellY(sim, index) {
        const state = sim.blightField;
        return (state.row0 + Math.floor(index / state.cols) + 0.5) * RULE.cellSize;
    }

    // A burn of a burner's flame (UnitBreathAttack.pulse): the sector from `unit` along the unit vector (ux, uy),
    // half-angle cosine `c` and sine `s`, `length` long; `flame.sectorTouches` is the flame's own sector test. It
    // purifies `count` blighted cells (`blightBurn.cellsPerPulse`) of those whose middle is within half a cell of
    // the sector and in clear terrain line: the nearest first, the lower cell index first in a tie.
    static burn(sim, unit, flame, ux, uy, c, s, length, count) {
        const state = sim.blightField,
            size = RULE.cellSize,
            reach = length + size / 2,
            { col0, row0, cols, rows, cells } = state,
            fromCol = Math.max(0, Math.floor((unit.x - reach) / size) - col0),
            toCol = Math.min(cols - 1, Math.floor((unit.x + reach) / size) - col0),
            fromRow = Math.max(0, Math.floor((unit.y - reach) / size) - row0),
            toRow = Math.min(rows - 1, Math.floor((unit.y + reach) / size) - row0),
            terrain = sim.world.terrain.field;
        for (let burned = 0; burned < count; burned++) {
            let best = -1,
                bestDistance2 = Infinity;
            for (let row = fromRow; row <= toRow; row++) {
                const cy = (row0 + row + 0.5) * size,
                    dy = cy - unit.y;
                for (let col = fromCol; col <= toCol; col++) {
                    const index = row * cols + col;
                    if (cells[index] !== BLIGHTED) continue;
                    const dx = (col0 + col + 0.5) * size - unit.x,
                        distance2 = dx * dx + dy * dy;
                    if (
                        distance2 >= bestDistance2 ||
                        !flame.sectorTouches(ux, uy, c, s, length, dx, dy, size / 2) ||
                        !terrain.polygonSegmentClear(unit.x, unit.y, unit.x + dx, cy, 0)
                    )
                        continue;
                    best = index;
                    bestDistance2 = distance2;
                }
            }
            if (best < 0) return;
            cells[best] = PURIFIED;
        }
    }

    // What the renderer reads (StrategySim.snapshot): the grid and each brazier with whether it is lit.
    static view(sim) {
        const state = sim.blightField;
        if (!state) return undefined;
        const braziers = sim.rules.campaign.braziers ?? [];
        return {
            cellSize: RULE.cellSize,
            col0: state.col0,
            row0: state.row0,
            cols: state.cols,
            rows: state.rows,
            cells: state.cells.slice(),
            radius: state.radius,
            braziers: braziers.map(({ x, y, radius }, i) => ({ x, y, radius, lit: state.lit[i] })),
        };
    }
}
