const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const start = html.indexOf('class DeterministicCollisionGrid{');
const end = html.indexOf('// Each circle\'s own swept bounds', start);
assert(start >= 0 && end > start, 'Collision grid class markers must exist');
const FP = 100;
const RangeUtil = { clamp: (value, min, max) => Math.max(min, Math.min(max, value)) };
const CollisionGrid = new Function('FP', 'RangeUtil', 'COLLISION_SPATIAL_CELL', `${html.slice(start, end)}; return DeterministicCollisionGrid;`)(FP, RangeUtil, 64);
const unitGridStart = html.indexOf('class DeterministicUnitSpatialGrid{');
const buildingGridStart = html.indexOf('class DeterministicBuildingSpatialGrid{', unitGridStart);
const simulationStart = html.indexOf('class StateValue{', buildingGridStart);
assert(unitGridStart >= 0 && buildingGridStart > unitGridStart && simulationStart > buildingGridStart,
  'Unit and building target grid markers must exist');
const UnitGrid = new Function('SIM_SPATIAL_CELL', 'RangeUtil',
  `${html.slice(unitGridStart, buildingGridStart)}; return DeterministicUnitSpatialGrid;`)(64, RangeUtil);
const BuildingGrid = new Function('SIM_SPATIAL_CELL', 'RangeUtil',
  `${html.slice(buildingGridStart, simulationStart)}; return DeterministicBuildingSpatialGrid;`)(64, RangeUtil);
const queryMethodsStart = html.indexOf('  nearbyUnits(x,y,r,side=null,out=null){');
const queryMethodsEnd = html.indexOf('\n  ensureCollisionBuffers(', queryMethodsStart);
assert(queryMethodsStart >= 0 && queryMethodsEnd > queryMethodsStart,
  'StrategySim caller-owned and scoped query methods must exist');
const QueryApi = new Function(`return class {${html.slice(queryMethodsStart, queryMethodsEnd)}};`)();
const aoeStart = html.indexOf('  pickAoeTargetInRange(');
const aoeEnd = html.indexOf('\n  formationJoinMovePct(', aoeStart);
assert(aoeStart >= 0 && aoeEnd > aoeStart, 'AOE target query must exist');
const AoeApi = new Function('UnitDefinition', 'NEUTRAL_SIDE',
  `return class {${html.slice(aoeStart, aoeEnd)}};`)({ get: () => ({}) }, 2);
const mobilityStart = html.indexOf('  findOffensiveMobilityTarget(');
const mobilityEnd = html.indexOf('\n  findBacklineAbilityTarget(', mobilityStart);
assert(mobilityStart >= 0 && mobilityEnd > mobilityStart, 'offensive mobility target scan must exist');
const MobilityApi = new Function(`return class {${html.slice(mobilityStart, mobilityEnd)}};`)();
const world = { width: 512, height: 512 };

function queryFixture(units) {
  const unitIndexById = new Map(units.map((unit, index) => [unit.id, index]));
  const unitSpatial = new UnitGrid(64, world);
  unitSpatial.reset(units, unitIndexById);
  return Object.assign(Object.create(QueryApi.prototype), {
    units, unitSpatial, tick: 0, runtimeIndexTick: 0, maxUnitRadius: 24,
    spatialQueryBuffers: Array.from({ length: 64 }, () => []), spatialQueryCursor: 0,
    spatialQueryScopeBuffers: [], spatialQueryScopeDepth: 0,
    aoeCandidateSpatialScratch: [], aoeCandidateSpatialDepth: 0,
    rebuildRuntimeIndexes() { this.runtimeIndexTick = this.tick; },
  });
}

test('collision grid defaults to 64-world-unit cells and accepts variable query ranges', () => {
  assert.match(html, /const COLLISION_SPATIAL_CELL=64;/);
  const gridSource = html.slice(start, end);
  assert.match(gridSource, /this\.cellYFP\(u\.fy\)\*this\.cols\+this\.cellXFP\(u\.fx\)/,
    'center insertion uses the integer y*columns+x bucket index');
  assert.match(gridSource, /this\.buckets\[cy\*this\.cols\+cx\]/,
    'range queries directly read numeric array buckets');
  assert.doesNotMatch(gridSource, /\bnew Map\b/, 'fixed collision buckets do not use Map');
  const grid = new CollisionGrid(undefined, world);
  assert.equal(grid.cellSize, 64);

  // The query radius is a radius in fixed-point world units. The grid adds the
  // indexed maximum target radius, so a small source still finds a large target.
  const units = [
    { id: 'small', fx: 0, fy: 0, alive: true, side: 0 },
    { id: 'large', fx: 100 * FP, fy: 0, alive: true, side: 1 },
    { id: 'neutral-edge', fx: 512 * FP, fy: 512 * FP, alive: true, side: 2 },
    { id: 'dead', fx: 2 * FP, fy: 0, alive: false, side: 0 },
  ];
  grid.reset(units, 81 * FP);
  const out = [];
  const found = grid.queryCandidatesFP(0, 0, 20 * FP, out);
  assert.strictEqual(found, out, 'query returns the caller-owned reusable buffer');
  assert(found.includes(1), 'small query includes a large possible contact at radius-sum distance');
  assert(!found.includes(3), 'dead centers are not indexed');
  assert.equal(new Set(found).size, found.length, 'center registration and cell traversal do not duplicate candidates');
  assert.deepEqual(found, grid.queryCandidatesFP(0, 0, 20 * FP, out), 'cell and bucket order is stable');
  const expectedOrder = found.slice();
  grid.reset(units, 81 * FP);
  assert.deepEqual(grid.queryCandidatesFP(0, 0, 20 * FP, out), expectedOrder,
    'rebuilding the same indexed state preserves deterministic candidate order');
  assert.equal(grid.cellXFP(-FP), 0, 'negative world coordinates clamp to the zero-origin edge cell');
  assert.equal(grid.cellYFP(-FP), 0, 'negative world coordinates clamp to the zero-origin edge cell');
  assert.equal(grid.cellXFP(512 * FP), grid.cols - 1, 'coordinates beyond the world clamp to the last cell');
  assert(grid.queryCandidatesFP(-FP, -FP, 0, []).includes(0), 'negative query bounds clamp and still inspect the edge bucket');

  const edge = grid.queryCandidatesFP(512 * FP, 512 * FP, 20 * FP, []);
  assert(edge.includes(2), 'world-edge cell clamping still returns the boundary unit');
  assert(edge.every(index => units[index].alive), 'candidate list contains only indexed live units');
  const oldResult = out.slice();
  assert.strictEqual(grid.queryCandidatesFP(512 * FP, 512 * FP, 20 * FP, out), out);
  assert.deepEqual(out, edge, 'reusing the same output buffer clears and replaces its previous result');
  assert.notDeepEqual(out, oldResult);

  const moved = { fx: 20 * FP, fy: 20 * FP, alive: true };
  grid.reset([moved], 20 * FP);
  const oldKey = grid.cellYFP(moved.fy) * grid.cols + grid.cellXFP(moved.fx);
  moved.fx = 220 * FP;
  moved.fy = 220 * FP;
  grid.reset([moved], 20 * FP);
  assert.equal(grid.buckets[oldKey].length, 0, 'used-cell reset clears stale centers after movement');
  assert.deepEqual(grid.used, [grid.cellYFP(moved.fy) * grid.cols + grid.cellXFP(moved.fx)],
    'used-cell list contains only the current nonempty cell');
  assert(grid.queryCandidatesFP(20 * FP, 20 * FP, 0, []).length === 0,
    'old cell no longer returns the moved unit');
});

test('candidate queries are complete for mixed radii and reset the maximum-radius bound', () => {
  let seed = 0x51a7c0de;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const radii = [2025, 3375, 4725, 6750, 8100];
  const units = Array.from({ length: 96 }, (_, index) => ({
    id: `u${index}`,
    fx: Math.round(random() * world.width * FP),
    fy: Math.round(random() * world.height * FP),
    alive: index % 13 !== 0,
    side: index % 4,
  }));
  const radius = index => radii[index % radii.length];
  const maxRadius = Math.max(...units.map((_, index) => radius(index)));
  const grid = new CollisionGrid(64, world);
  grid.reset(units, maxRadius);

  const reusable = [];
  const checkAllOverlapsAreCandidates = () => {
    for (let i = 0; i < units.length; i++) {
      const a = units[i];
      if (!a.alive) continue;
      const candidates = grid.queryCandidatesFP(a.fx, a.fy, radius(i), reusable);
      assert.strictEqual(candidates, reusable);
      assert.equal(new Set(candidates).size, candidates.length, `duplicate candidates for ${a.id}`);
      const candidateSet = new Set(candidates);
      for (let j = 0; j < units.length; j++) {
        const b = units[j];
        if (!b.alive) continue;
        const dx = b.fx - a.fx, dy = b.fy - a.fy, sum = radius(i) + radius(j);
        if (dx * dx + dy * dy <= sum * sum) {
          assert(candidateSet.has(j), `overlapping pair ${a.id}/${b.id} was omitted`);
        }
      }
    }
  };
  checkAllOverlapsAreCandidates();

  // Rebuilding with a smaller live-radius ceiling must replace, not retain, the
  // prior maximum. The next reset can then grow it again without a stale bound.
  const smallUnits = [
    { fx: 20 * FP, fy: 20 * FP, alive: true },
    { fx: 50 * FP, fy: 20 * FP, alive: true },
  ];
  grid.reset(smallUnits, 2025);
  assert.equal(grid.maxIndexedRadiusFP, 2025);
  assert(grid.queryCandidatesFP(smallUnits[0].fx, smallUnits[0].fy, 2025, []).includes(1));
  grid.reset(units, maxRadius);
  assert.equal(grid.maxIndexedRadiusFP, maxRadius);
  checkAllOverlapsAreCandidates();
  grid.reset(smallUnits, 2025);
  assert.equal(grid.maxIndexedRadiusFP, 2025, 'resetting after a large roster removes the old maximum');
});

test('caller-owned buffers keep a nested query from overwriting its parent result', () => {
  const grid = new CollisionGrid(64, world);
  const units = [
    { fx: 40 * FP, fy: 40 * FP, alive: true },
    { fx: 70 * FP, fy: 40 * FP, alive: true },
    { fx: 400 * FP, fy: 400 * FP, alive: true },
  ];
  grid.reset(units, 25 * FP);

  const inner = [];
  let nested = false;
  const outer = new Proxy([], {
    set(target, key, value) {
      if (key === 'length' && !nested) {
        nested = true;
        grid.queryCandidatesFP(400 * FP, 400 * FP, 25 * FP, inner);
      }
      return Reflect.set(target, key, value);
    },
  });
  const result = grid.queryCandidatesFP(40 * FP, 40 * FP, 25 * FP, outer);
  assert.strictEqual(result, outer);
  assert(outer.includes(0) && outer.includes(1));
  assert.deepEqual(inner, [2]);
  assert.equal(new Set(outer).size, outer.length);
});

test('StrategySim scoped unit queries survive 64 intervening borrowed queries and nested scopes', () => {
  const units = [
    { id: 'outer-a', x: 40, y: 40, alive: true, side: 0 },
    { id: 'outer-b', x: 72, y: 40, alive: true, side: 1 },
    { id: 'far', x: 400, y: 400, alive: true, side: 2 },
  ];
  const sim = queryFixture(units);
  const callerOwned = [];
  assert.strictEqual(sim.nearbyUnits(40, 40, 40, null, callerOwned), callerOwned);
  const callerOwnedSnapshot = callerOwned.slice();
  sim.nearbyUnits(400, 400, 12);
  assert.deepEqual(callerOwned, callerOwnedSnapshot, 'a later ring-buffer query does not mutate a caller-owned result');

  sim.withNearbyUnits(40, 40, 40, outer => {
    const expected = outer.slice();
    for (let i = 0; i < 64; i++) sim.nearbyUnits(400, 400, 12);
    assert.deepEqual(outer, expected, 'ring wraparound cannot overwrite a live scoped result');
    sim.withNearbyUnits(400, 400, 12, nested => {
      assert.deepEqual(nested, [2]);
      assert.deepEqual(outer, expected, 'a nested scoped result has independent ownership');
    });
    assert.deepEqual(outer, expected, 'scope depth is restored after nested traversal');
  });
  assert.equal(sim.spatialQueryScopeDepth, 0);
});

test('single-broadphase AOE target selection matches exhaustive attack and splash scoring', () => {
  let seed = 0x7c3a41;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const units = Array.from({ length: 180 }, (_, index) => ({
    id: `unit-${index}`, x: Math.round(random() * world.width), y: Math.round(random() * world.height),
    alive: index % 19 !== 0, side: index % 5 === 0 ? 2 : index % 2,
  }));
  const sim = Object.assign(queryFixture(units), {
    canAttackEntity: () => true, canSeeCombatTarget: () => true, isVisible: () => true,
    unitLayer: () => 'GROUND', interactionDistance: (_unit, _target, _kind, range) => range,
    isHostileCombatUnit(side, target) { return !!target?.alive && target.side !== side; },
  });
  const source = { id: 'source', type: 'ranged', side: 0, x: 248, y: 251 };
  const attackRange = 190, splashRadius = 82;
  const actual = AoeApi.prototype.pickAoeTargetInRange.call(sim, source, [], attackRange, splashRadius);
  const d = { minRange: 0 };
  const candidateQuery = attackRange + sim.maxUnitRadius + 40;
  const minCellX = sim.unitSpatial.cellX(source.x - candidateQuery), maxCellX = sim.unitSpatial.cellX(source.x + candidateQuery);
  const minCellY = sim.unitSpatial.cellY(source.y - candidateQuery), maxCellY = sim.unitSpatial.cellY(source.y + candidateQuery);
  let expected = null, bestHits = -1, bestD2 = Infinity;
  for (const e of units) {
    if (!sim.isHostileCombatUnit(source.side, e)) continue;
    const cx = sim.unitSpatial.cellX(e.x), cy = sim.unitSpatial.cellY(e.y);
    if (cx < minCellX || cx > maxCellX || cy < minCellY || cy > maxCellY) continue;
    const dx = e.x - source.x, dy = e.y - source.y, d2 = dx * dx + dy * dy, dist = Math.sqrt(d2);
    if (dist > attackRange || (d.minRange && dist < d.minRange)) continue;
    const hits = units.filter(v => sim.isHostileCombatUnit(source.side, v) && Math.hypot(v.x - e.x, v.y - e.y) <= splashRadius).length;
    if (hits > bestHits || (hits === bestHits && d2 < bestD2) ||
        (hits === bestHits && d2 === bestD2 && expected && String(e.id) < String(expected.id))) {
      expected = e; bestHits = hits; bestD2 = d2;
    }
  }
  assert.equal(actual?.entity?.id ?? null, expected?.id ?? null);
  assert.equal(actual?.aoeHits ?? null, expected ? bestHits : null);
});

test('offensive mobility building grid returns the same in-range enemy and stable tie-break as a full scan', () => {
  let seed = 0x4f10a92;
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x100000000);
  const buildings = Array.from({ length: 220 }, (_, index) => ({
    id: `building-${index}`, x: Math.round(random() * world.width), y: Math.round(random() * world.height),
    alive: index % 23 !== 0, side: index % 3,
  }));
  const grid = new BuildingGrid(64, world);
  grid.reset(buildings);
  const sim = Object.assign(Object.create(MobilityApi.prototype), {
    buildings,
    findBacklineAbilityTarget: () => null,
    nearbyBuildingIndices: (x, y, radius) => grid.query(x, y, radius, []),
    canAttackEntity: () => true, isVisible: () => true,
  });
  const source = { id: 'mobility', type: 'charger', side: 0, x: 251, y: 247 };
  const range = 245, range2 = range * range;
  const actual = MobilityApi.prototype.findOffensiveMobilityTarget.call(sim, source, range, new Set(), []);
  let expected = null, bestD2 = Infinity;
  for (const building of buildings) {
    if (!building || building.alive === false || building.side !== 1) continue;
    const dx = building.x - source.x, dy = building.y - source.y, d2 = dx * dx + dy * dy;
    if (d2 > range2) continue;
    if (d2 < bestD2 || (d2 === bestD2 && expected && String(building.id) < String(expected.id))) {
      expected = building; bestD2 = d2;
    }
  }
  assert.equal(actual?.entity?.id ?? null, expected?.id ?? null);
  assert.equal(actual?.isBuilding ?? null, expected ? true : null);
});

test('unit and building target grids keep direct array buckets and visit each cell once', () => {
  const unitSource = html.slice(unitGridStart, buildingGridStart);
  const buildingSource = html.slice(buildingGridStart, simulationStart);
  const sweptStart = html.indexOf('class DeterministicSweptCollisionGrid{');
  const sweptEnd = html.indexOf('/* Runtime-only deterministic unit spatial grid.', sweptStart);
  const sweptSource = html.slice(sweptStart, sweptEnd);
  for (const [name, source] of [['unit target', unitSource], ['building target', buildingSource], ['swept collision', sweptSource]]) {
    assert.doesNotMatch(source, /\bnew Map\b/, `${name} cell buckets use arrays`);
  }
  assert.match(unitSource, /grid\[this\.keyXY\(cx,cy\)\]/);
  assert.match(buildingSource, /this\.buckets\[this\.key\(cx,cy\)\]/);
  assert.match(sweptSource, /this\.buckets=new Array\(this\.cols\*this\.rows\)/);

  const units = [
    { id: 'a', x: 20, y: 20, alive: true, side: 0 },
    { id: 'b', x: 95, y: 35, alive: true, side: 1 },
    { id: 'c', x: 140, y: 140, alive: true, side: 0 },
    { id: 'd', x: 300, y: 300, alive: true, side: 1 },
  ];
  const indexById = new Map(units.map((unit, index) => [unit.id, index]));
  const unitGrid = new UnitGrid(64, world);
  unitGrid.reset(units, indexById);
  const all = unitGrid.query(80, 80, 130, []);
  assert.equal(new Set(all).size, all.length, 'one center insertion plus one visit per cell returns no duplicates');
  const side0 = unitGrid.query(80, 80, 130, [], 0);
  assert(side0.every(index => units[index].side === 0), 'side buckets preserve target filtering');

  const buildings = [
    { x: 20, y: 20, alive: true },
    { x: 95, y: 35, alive: true },
    { x: 140, y: 140, alive: true },
  ];
  const buildingGrid = new BuildingGrid(64, world);
  buildingGrid.reset(buildings);
  const buildingCandidates = buildingGrid.query(80, 80, 130, []);
  assert.equal(new Set(buildingCandidates).size, buildingCandidates.length, 'building target cell visits are duplicate-free');
});
