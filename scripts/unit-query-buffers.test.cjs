const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

// StrategySim's unit queries are sliced from its source and run on the shared GameKit grid, so the
// buffer-ownership rules are checked against the real grid, not a copy of it.
const source = fs.readFileSync(path.join(__dirname, '../src/sim/strategy-sim.js'), 'utf8');
const queryMethodsStart = source.indexOf('  nearbyUnits(x,y,r,side=null,out=null){');
const queryMethodsEnd = source.indexOf('\n  ensureCollisionBuffers(', queryMethodsStart);
assert(queryMethodsStart >= 0 && queryMethodsEnd > queryMethodsStart, 'StrategySim caller-owned and scoped query methods must exist');
const QueryApi = new Function('StrategySim', `return class {${source.slice(queryMethodsStart, queryMethodsEnd)}};`)({
  spatialGroup: side => (side === 0 ? 0 : side === 1 ? 1 : 2),
});
const world = { width: 512, height: 512 };

async function queryFixture(units) {
  const { UniformGrid } = await import(pathToFileURL(path.join(__dirname, '../.cache/gamekit/spatial.js')).href);
  const unitSpatial = new UniformGrid({ cellSize: 64, width: world.width, height: world.height, outside: 'clamp', groups: 3, track: 'index' });
  units.forEach((unit, index) => unit.alive && unitSpatial.insert(index, unit.x, unit.y, unit.side === 0 ? 0 : unit.side === 1 ? 1 : 2));
  return Object.assign(Object.create(QueryApi.prototype), {
    units, unitSpatial, tick: 0, runtimeIndexTick: 0, maxUnitRadius: 24,
    spatialQueryBuffers: Array.from({ length: 64 }, () => []), spatialQueryCursor: 0,
    spatialQueryScopeBuffers: [], spatialQueryScopeDepth: 0,
    rebuildRuntimeIndexes() { this.runtimeIndexTick = this.tick; },
  });
}

test('StrategySim scoped unit queries survive 64 intervening borrowed queries and nested scopes', async () => {
  const units = [
    { id: 'outer-a', x: 40, y: 40, alive: true, side: 0 },
    { id: 'outer-b', x: 72, y: 40, alive: true, side: 1 },
    { id: 'far', x: 400, y: 400, alive: true, side: 2 },
  ];
  const sim = await queryFixture(units);
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

  // Side groups keep an enemy query from seeing allies.
  const enemies = sim.nearbyUnits(40, 40, 80, 1, []);
  assert(enemies.every(index => units[index].side === 1), 'a side query returns only that side');
});
