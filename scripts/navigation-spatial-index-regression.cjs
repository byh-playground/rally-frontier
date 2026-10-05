const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const classSource = source.slice(source.indexOf('class NavigationObstacleIndex{'), source.indexOf('class TerrainGeometry{'));
const Index = new Function(`${classSource}; return NavigationObstacleIndex;`)();

// The previous string-key index is the ordering oracle, not a sorted set oracle.
class ReferenceIndex {
  constructor(items, cell = 256) {
    this.items = items; this.cell = cell; this.bins = new Map();
    this.marks = new Uint32Array(items.length); this.epoch = 0; this.out = [];
    for (let i = 0; i < items.length; i++) {
      const b = items[i];
      for (let y = Math.floor(b.minY / cell); y <= Math.floor(b.maxY / cell); y++)
        for (let x = Math.floor(b.minX / cell); x <= Math.floor(b.maxX / cell); x++) {
          const key = x + ',' + y;
          let bin = this.bins.get(key);
          if (!bin) this.bins.set(key, bin = []);
          bin.push(i);
        }
    }
  }
  query(x0, y0, x1 = x0, y1 = y0, pad = 0) {
    this.out.length = 0;
    if (++this.epoch === 0xffffffff) { this.marks.fill(0); this.epoch = 1; }
    const minX = Math.min(x0, x1) - pad, maxX = Math.max(x0, x1) + pad;
    const minY = Math.min(y0, y1) - pad, maxY = Math.max(y0, y1) + pad;
    for (let y = Math.floor(minY / this.cell); y <= Math.floor(maxY / this.cell); y++)
      for (let x = Math.floor(minX / this.cell); x <= Math.floor(maxX / this.cell); x++) {
        const bin = this.bins.get(x + ',' + y);
        if (!bin) continue;
        for (const i of bin) {
          if (this.marks[i] === this.epoch) continue;
          this.marks[i] = this.epoch;
          const b = this.items[i];
          if (b.maxX >= minX && b.minX <= maxX && b.maxY >= minY && b.minY <= maxY) this.out.push(b);
        }
      }
    return this.out;
  }
}

let seed = 0x31415926;
const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
const items = Array.from({ length: 500 }, (_, id) => {
  const minX = Math.floor(random() * 4096) - 2048, minY = Math.floor(random() * 4096) - 2048;
  return { id, minX, minY, maxX: minX + Math.floor(random() * 600), maxY: minY + Math.floor(random() * 600) };
});
items.push({ id: 500, minX: -256, minY: -256, maxX: 0, maxY: 0 },
  { id: 501, minX: 0, minY: 0, maxX: 256, maxY: 256 },
  { id: 502, minX: 256, minY: 256, maxX: 256, maxY: 256 });
const queries = [];
for (let i = 0; i < 4000; i++) {
  const x = random() * 6000 - 3000, y = random() * 6000 - 3000;
  queries.push(i % 3 ? [x, y, x, y, random() * 24] : [x, y, x + random() * 1200 - 600, y + random() * 1200 - 600, random() * 100]);
}
for (const x of [-512, -256, 0, 256, 512]) for (const y of [-512, -256, 0, 256, 512]) {
  queries.push([x, y], [x, y, x + 256, y + 256], [x, y, x, y, 0.001], [x, y, x - 256, y - 256]);
}
let compared = 0;
for (const cell of [16, 127, 256, 512]) {
  const actual = new Index(items, cell), expected = new ReferenceIndex(items, cell), retained = actual.out;
  assert.ok([...actual.bins.entries()].every(([y, row]) => typeof y === 'number' && row instanceof Map && [...row.keys()].every(x => typeof x === 'number')));
  for (const query of queries) {
    assert.deepEqual(actual.query(...query), expected.query(...query));
    assert.equal(actual.out, retained, 'output array must be reused');
    compared++;
  }
  // Single-bin queries must not consume a mark epoch; the following multi-bin
  // query wraps, clears stale marks, deduplicates and preserves scan order.
  actual.epoch = expected.epoch = 0xfffffffe;
  actual.marks.fill(1); expected.marks.fill(1);
  assert.deepEqual(actual.query(1, 1), expected.query(1, 1));
  assert.deepEqual(actual.query(-600, -600, 600, 600), expected.query(-600, -600, 600, 600));
  assert.equal(actual.epoch, 1);
  assert.deepEqual(actual.query(-600, -600, 600, 600), expected.query(-600, -600, 600, 600));
}
const empty = new Index([]), retainedEmpty = empty.query(0, 0);
assert.equal(empty.query(-1e9, -1e9, 1e9, 1e9), retainedEmpty);
assert.deepEqual(retainedEmpty, []);

// Verify the actual renderer method resolves missing height once, and preserves
// already resolved input identity without performing any atlas query.
const projectionSource = source.slice(source.indexOf('  projectRenderWorldPositionStable(p){'), source.indexOf('  projectRenderWorldPosition(p){'));
const renderer = new Function('BattlefieldProjection', `return {${projectionSource}};`)({ planarY: (z, y) => z - y });
let heightCalls = 0;
Object.assign(renderer, { sc: () => 2, canvas: { width: 100 }, viewWorldW: () => 40, viewX: x => x, viewY: y => y,
  cameraLeft: 0, cameraTop: 0, renderDepthForWorld: p => p.groundY,
  world: { terrain: { surfaces: { heightAt: () => { heightCalls++; return 12; } } } } });
const unresolved = { x: 4, z: 8, y: 3 };
assert.deepEqual(renderer.projectRenderWorldPositionStable(unresolved), { x: 18, y: -14, depth: 12, world: { ...unresolved, y: 15, groundY: 12 } });
assert.equal(heightCalls, 1);
const resolved = { ...unresolved, groundY: 5 };
assert.equal(renderer.projectRenderWorldPositionStable(resolved).world, resolved);
assert.equal(heightCalls, 1);

const result = { passed: true, comparedQueries: compared, rendererHeightCalls: heightCalls };
if (process.argv.includes('--benchmark')) {
  const median = xs => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const measure = (index, batch, loops) => {
    let checksum = 0;
    const start = performance.now();
    for (let i = 0; i < loops; i++) for (const q of batch) checksum += index.query(...q).length;
    return { ms: performance.now() - start, checksum };
  };
  result.microbenchmark = [];
  for (const [name, batch] of [['mixed', queries], ['point', queries.filter(q => q.length === 2 || (q[0] === q[2] && q[1] === q[3]))]]) {
    const old = new ReferenceIndex(items), current = new Index(items), before = [], after = [];
    measure(old, batch, 5); measure(current, batch, 5);
    for (let r = 0; r < 7; r++) {
      const a = r % 2 ? measure(current, batch, 30) : measure(old, batch, 30);
      const b = r % 2 ? measure(old, batch, 30) : measure(current, batch, 30);
      assert.equal(a.checksum, b.checksum);
      before.push(r % 2 ? b.ms : a.ms); after.push(r % 2 ? a.ms : b.ms);
    }
    result.microbenchmark.push({ name, queriesPerSample: batch.length * 30, beforeMedianMs: median(before), afterMedianMs: median(after) });
  }
}
console.log(JSON.stringify(result, null, 2));
