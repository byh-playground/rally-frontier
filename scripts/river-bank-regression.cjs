const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Run with Playwright in Node's module path; QA_BROWSER_CHANNEL overrides Edge.
// The optional argument selects another HTML revision for regression comparison.
const htmlPath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'index.html');
const channel = process.env.QA_BROWSER_CHANNEL || 'msedge';

async function run() {
  let html = fs.readFileSync(htmlPath, 'utf8');
  const end = html.lastIndexOf('})();');
  assert.ok(end >= 0, 'Application IIFE exists');
  html = html.slice(0, end) + `
    window.__bankQA = {
      TerrainSurfaceAtlas, WorldContext, TerrainNavigation, TerrainSurfaceProjection,
      TerrainPresentation, VisibilityPolicy, TerrainQuery, GLRenderer, MapGeneration,
      MapGeometry, GameRuleDefinition, GameRuleRuntime, StrategySim
    };
  ` + html.slice(end);
  const browser = await chromium.launch({
    channel, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 650 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('http://bank-qa.local/**', route => route.fulfill({
      status: 200, contentType: 'text/html', body: html
    }));
    await page.goto('http://bank-qa.local/', { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForFunction(() => window.__bankQA);
    } catch (error) {
      console.error(JSON.stringify({ startupPageErrors: pageErrors }));
      throw error;
    }
    const cases = await page.evaluate(() => {
      const {
        TerrainSurfaceAtlas, WorldContext, TerrainNavigation, TerrainSurfaceProjection,
        TerrainPresentation, VisibilityPolicy, TerrainQuery, GLRenderer, MapGeneration,
        MapGeometry, GameRuleDefinition, GameRuleRuntime, StrategySim
      } = window.__bankQA;
      const results = [];
      const generatedMaps = new Map();
      function check(value, message) { if (!value) throw new Error(message); }
      function equal(actual, expected, message) {
        check(actual === expected, `${message}: expected ${expected}, received ${actual}`);
      }
      function close(actual, expected, message, tolerance = 0.001) {
        check(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} != ${expected}`);
      }
      function test(name, body) {
        try { results.push({ name, status: 'PASS', evidence: body() }); }
        catch (error) { results.push({ name, status: 'FAIL', error: error.message }); }
      }
      function rectangle(x0, y0, x1, y1) {
        return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
      }
      function bankMap(width = 1280, withBridge = false) {
        const center = 1600;
        return {
          width: 3200, height: 4096,
          terrain: {
            layers: [{
              id: 'river-bank', level: -1,
              points: rectangle(center - width / 2 - 160, 900, center + width / 2 + 160, 3000),
              innerPoints: rectangle(center - width / 2, 1060, center + width / 2, 2840)
            }],
            ramps: [], blockers: [],
            riverPolygon: rectangle(center - width / 2, 1060, center + width / 2, 2840),
            bridges: withBridge ? [{
              id: 'crossing', x: center, y: 1950, angle: 0,
              halfLength: width / 2 + 240, halfWidth: 60, level: 0
            }] : []
          }
        };
      }
      function stateFor(descriptor) {
        return { tick: 0, world: WorldContext.fromMap(descriptor), units: [], buildings: [] };
      }
      function midpoint(a, b) { return TerrainSurfaceAtlas.lerp(a, b, 0.5); }
      function barycentricPoint(points, weights) {
        return {
          x: points.reduce((sum, point, index) => sum + point.x * weights[index], 0),
          y: points.reduce((sum, point, index) => sum + point.y * weights[index], 0)
        };
      }

      test('All canonical bank sides, corners and caps sample piecewise planar heights', () => {
        let samples = 0;
        let traversals = 0;
        for (const width of [40, 80, 1280]) {
          const descriptor = bankMap(width);
          const state = stateFor(descriptor);
          const atlas = state.world.terrain.surfaces;
          const banks = atlas.ramps.filter(ramp => ramp.bank);
          equal(banks.length, 4, 'Closed rectangle has four continuous bank ramps including caps');
          equal(atlas.levelAt(200, 200), 0, 'Implicit land stays zero');
          equal(atlas.levelAt(1600, 1800), -1, 'Inner water floor stays negative one');
          const navigation = TerrainNavigation.forState(state);
          const mesh = navigation.layer(4);
          const contour = descriptor.terrain.layers[0];
          for (let corner = 0; corner < contour.points.length; corner++) {
            for (const progress of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
              const point = TerrainSurfaceAtlas.lerp(contour.points[corner], contour.innerPoints[corner], progress);
              close(atlas.heightAt(point.x, point.y), -96 * progress, 'Adjacent bank triangles share the continuous corner height');
              samples++;
            }
          }
          for (const ramp of banks) {
            for (let index = 0; index < 2; index++) {
              const triangle = TerrainSurfaceAtlas.rampTriangle(ramp, index);
              for (const weights of [[0.7, 0.2, 0.1], [0.2, 0.3, 0.5], [0.1, 0.2, 0.7]]) {
                const point = barycentricPoint(triangle.points, weights);
                const expectedHeight = triangle.points.reduce((sum, vertex, i) => sum + vertex.h * weights[i], 0);
                const sample = atlas.sample(point.x, point.y);
                check(sample.ramp?.bank, 'Interior bank triangle is a bank surface');
                close(sample.elevation, expectedHeight, 'Sample agrees with actual triangle plane');
                close(sample.progress, (expectedHeight + 96) / 96, 'Progress derives from physical height');
                close(sample.gradient.x, (atlas.heightAt(point.x + 0.01, point.y) - atlas.heightAt(point.x - 0.01, point.y)) / 0.02, 'Bank x gradient matches finite difference');
                close(sample.gradient.z, (atlas.heightAt(point.x, point.y + 0.01) - atlas.heightAt(point.x, point.y - 0.01)) / 0.02, 'Bank z gradient matches finite difference');
                samples++;
              }
            }
            const low = midpoint(ramp.lowA, ramp.lowB);
            const high = midpoint(ramp.highA, ramp.highB);
            const dx = (high.x - low.x) / ramp.run;
            const dy = (high.y - low.y) / ramp.run;
            const floor = { x: low.x - dx * 12, y: low.y - dy * 12 };
            const land = { x: high.x + dx * 12, y: high.y + dy * 12 };
            equal(navigation.segmentClear(floor.x, floor.y, land.x, land.y, 4), true, 'Every bank perimeter side is traversable uphill');
            equal(navigation.segmentClear(land.x, land.y, floor.x, floor.y, 4), true, 'Every bank perimeter side is traversable downhill');
            const floorCell = navigation.locate(floor.x, floor.y, mesh);
            const landCell = navigation.locate(land.x, land.y, mesh);
            check(floorCell && landCell, 'Bank endpoints have actual navigation cells');
            equal(floorCell.cell.component, landCell.cell.component, 'Navigation mesh connects floor to land through each bank');
            traversals += 2;
          }
          // Cross both banks and inner floor with the same movement segment.
          const outer = descriptor.terrain.layers[0].points;
          equal(navigation.segmentClear(outer[0].x - 12, 1800, outer[1].x + 12, 1800, 4), true, 'Full cross-river traversal has no synthetic walls');
          const firstBankCell = navigation.locate(outer[0].x - 12, 1800, mesh);
          const secondBankCell = navigation.locate(outer[1].x + 12, 1800, mesh);
          equal(firstBankCell.cell.component, secondBankCell.cell.component, 'Navigation mesh connects both banks through the water floor');
        }
        return { samples, traversals, widths: [40, 80, 1280] };
      });

      test('Bridge zero floor connects both land ends and blocks side teleportation', () => {
        const descriptor = bankMap(1280, true);
        const state = stateFor(descriptor);
        const atlas = state.world.terrain.surfaces;
        const bridge = atlas.bridges[0];
        check(bridge, 'Atlas derives bridge surface');
        const left = { x: bridge.x - bridge.halfLength - 12, y: bridge.y };
        const right = { x: bridge.x + bridge.halfLength + 12, y: bridge.y };
        equal(atlas.levelAt(left.x, left.y), 0, 'First bridge end connects zero land');
        equal(atlas.levelAt(right.x, right.y), 0, 'Second bridge end connects zero land');
        equal(atlas.sample(1600, 1950).level, 0, 'Bridge floor is zero over water');
        check(atlas.sample(1600, 1950).bridge, 'Bridge floor wins sampled water floor');
        equal(atlas.buildable(1600, 1950, 8), true, 'Bridge supports a contained footprint above hidden banks');
        const navigation = TerrainNavigation.forState(state);
        equal(navigation.segmentClear(left.x, left.y, right.x, right.y, 8), true, 'Bridge traversable toward second land end');
        equal(navigation.segmentClear(right.x, right.y, left.x, left.y, 8), true, 'Bridge traversable toward first land end');
        equal(navigation.segmentClear(1600, 1950, 1600, 1820, 8), false, 'Bridge cannot teleport sideways into lower water floor');
        equal(navigation.segmentClear(1600, 1820, 1600, 1950, 8), false, 'Water floor cannot teleport sideways onto bridge');
        return { left, right, bridgeLevel: atlas.levelAt(1600, 1950), sideTraversal: false };
      });

      test('Bridge-only elevated terrain renders without authored layers', () => {
        const descriptor = { width: 3072, height: 4096, terrain: { layers: [], bridges: [{
          id: 'raised-deck', level: 1, x: 1536, y: 2048,
          halfLength: 200, halfWidth: 100, angle: 0
        }] } };
        const canvas = document.createElement('canvas');
        canvas.width = 390; canvas.height = 650;
        const renderer = new GLRenderer(canvas), gl = renderer.gl;
        renderer.world = WorldContext.fromMap(descriptor); renderer.role = 'host';
        renderer.cameraLeft = 1536 - 450; renderer.cameraTop = 2048 - 96 * 0.6 - 750;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(renderer.p); gl.uniform2f(renderer.r, canvas.width, canvas.height);
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
        gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        renderer.begin(); TerrainPresentation.drawSurfaces(renderer); renderer.flush();
        const point = renderer.projectRenderWorldPosition({ x: 1536, y: 96, z: 2048, groundY: 0 });
        const rgba = new Uint8Array(4);
        gl.readPixels(Math.floor(point.x), canvas.height - 1 - Math.floor(point.y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        check(rgba[0] > 100 && rgba[1] > 100, 'Bridge-only opaque surface renders');
        close(renderer.surfaceAtScreen(point.x, point.y).y, 96, 'Bridge rendering and picking share elevation');
        equal(gl.getError(), 0, 'Bridge-only shader has no GL error');
        return { rgba: [...rgba], pickedHeight: 96 };
      });

      test('Bridge footprint removes hidden cliff contacts for navigation and SurfaceMotion', () => {
        const descriptor = { width: 1200, height: 1200, terrain: {
          layers: [{ id: 'pit', level: -1, points: rectangle(400, 400, 800, 800) }],
          ramps: [], bridges: [{ id: 'deck', level: 0, x: 600, y: 600, angle: 0, halfLength: 300, halfWidth: 50 }]
        } };
        const state = stateFor(descriptor), geometry = state.world.terrain;
        const navigation = TerrainNavigation.forState(state), mesh = navigation.layer(10);
        equal(geometry.surfaces.heightAt(400, 600), 0, 'Deck owns the former cliff crossing');
        equal(geometry.circleClear(400, 600, 10), true, 'Former cliff crossing has no hidden circle contact');
        equal(geometry.segmentClear(350, 600, 850, 600, 10), true, 'Both hidden pit cliffs are removed');
        for (const [from, to] of [[350, 850], [850, 350]]) {
          equal(navigation.segmentClear(from, 600, to, 600, 10), true, 'Shared navigation traverses the deck');
          const motion = navigation.motion.solve(from, 600, to, 600, 10, null, 'project');
          close(motion.x, to, 'SurfaceMotion reaches the opposite bridge end');
          close(motion.y, 600, 'SurfaceMotion stays on the bridge');
          equal(motion.hit, null, 'Shared solver sees no hidden bank contact');
        }
        equal(navigation.locate(350, 600, mesh).cell.component, navigation.locate(850, 600, mesh).cell.component, 'NavMesh connects bridge land ends');
        equal(geometry.segmentClear(600, 600, 600, 700, 10), false, 'Deck lateral cliff remains blocked');
        const lateral = navigation.motion.solve(600, 600, 600, 700, 10, null, 'project');
        check(lateral.hit && lateral.y < 650, 'SurfaceMotion contacts the exposed deck side');
        equal(geometry.circleClear(lateral.x, lateral.y, 10), true, 'Side contact ends at a valid circle');
        equal(geometry.circleClear(400, 500, 10), false, 'Pit cliff outside the bridge remains blocked');
        return { deckTraversal: [350, 850], lateralStop: lateral.y, exposedContacts: geometry.blocks.length };
      });

      test('Bridge support rejects contained islands and preserves exposed nested lower floors', () => {
        const deck = { id: 'deck', level: 0, x: 600, y: 600, angle: 0, halfLength: 300, halfWidth: 80 };
        const map = layers => ({ width: 1200, height: 1200, terrain: { layers, ramps: [], bridges: [{ ...deck }] } });
        const pit = { id: 'pit', level: -1, points: rectangle(400, 400, 800, 800) };
        let rejected = false;
        try { stateFor(map([pit, { id: 'island', level: 1, points: rectangle(550, 580, 650, 620) }])); }
        catch (error) { rejected = error.message.includes('below its supporting surface'); }
        check(rejected, 'Fully contained higher island cannot be hidden by a lower bridge');
        const nested = map([
          { id: 'outer', level: 1, points: rectangle(100, 100, 1100, 1100) },
          { id: 'inner', level: -1, points: rectangle(200, 200, 1000, 1000) }
        ]);
        const nestedAtlas = stateFor(nested).world.terrain.surfaces;
        equal(nestedAtlas.sampleTerrain(600, 600).elevation, -96, 'Inner lower floor overrides higher parent support');
        equal(nestedAtlas.heightAt(600, 600), 0, 'Deck over a nested lower floor remains valid');
        const bank = bankMap(1280, true);
        const bankAtlas = stateFor(bank).world.terrain.surfaces;
        equal(bankAtlas.sample(850, 1950).bridge?.id, 'crossing', 'Deck over a sloped bank remains valid');
        return { containedIslandRejected: rejected, nestedSupport: -96, bankDeck: 0 };
      });

      test('Procedural seeds 1 through 12 have deterministic safe bank surfaces and walkable perimeters', () => {
        const evidence = [];
        const failures = [];
        let totalBankCrossings = 0;
        for (let seed = 1; seed <= 12; seed++) {
          try {
            const descriptor = MapGeneration.generateMapDescriptor({ rules: GameRuleDefinition.defaults, seed });
            generatedMaps.set(seed, descriptor);
            const repeat = MapGeneration.generateMapDescriptor({ rules: GameRuleDefinition.defaults, seed });
            equal(JSON.stringify(descriptor), JSON.stringify(repeat), 'Same seed gives identical descriptor');
            equal(descriptor.schemaVersion, 1, 'Generated descriptor retains canonical schema');
            equal(descriptor.generation.accepted, true, `Default seed ${seed} passes all preset quality checks`);
            const failedChecks = Object.entries(descriptor.generation.checks).filter(([, passed]) => !passed).map(([name]) => name);
            equal(JSON.stringify(failedChecks), '[]', `Default seed ${seed} has no failed quality checks`);
            const state = stateFor(descriptor);
            const atlas = state.world.terrain.surfaces;
            const banks = atlas.ramps.filter(ramp => ramp.bank);
            check(banks.length > 0, `Seed ${seed} has generated continuous river banks`);
            for (const layer of atlas.layers.filter(layer => layer.innerPoints)) {
              equal(layer.level, -1, 'Generated river floor uses negative one');
              equal(layer.innerPoints.length, layer.points.length, 'Bank contours have paired vertices');
              for (const point of [...layer.points, ...layer.innerPoints]) {
                check(point.x >= 0 && point.x <= descriptor.width && point.y >= 0 && point.y <= descriptor.height, 'Generated banks remain in world bounds');
              }
            }
            for (const subject of [...descriptor.resources, ...descriptor.gasNodes, ...descriptor.camps]) {
              check(!atlas.sample(subject.x, subject.y).ramp, `Strategic object ${subject.id} avoids bank slopes`);
            }
            const navigation = TerrainNavigation.forState(state);
            let crossings = 0;
            let bridgeBoundarySegments = 0;
            const bridgeWalls = state.world.terrain.blocks.filter(block =>
              atlas.bridges.some(bridge => String(block.id).startsWith(bridge.id + ':'))
            );
            for (const ramp of banks) {
              const low = midpoint(ramp.lowA, ramp.lowB);
              const high = midpoint(ramp.highA, ramp.highB);
              const dx = (high.x - low.x) / ramp.run;
              const dy = (high.y - low.y) / ramp.run;
              const floor = { x: low.x - dx * 8, y: low.y - dy * 8 };
              const land = { x: high.x + dx * 8, y: high.y + dy * 8 };
              if ([floor, low, high, land].some(point => atlas.sample(point.x, point.y).bridge)) {
                bridgeBoundarySegments++;
                continue;
              }
              // Bridge side walls are intentionally impassable. A bank sample may intersect
              // one between endpoint probes or graze it with the movement disc.
              if (bridgeWalls.some(block => state.world.terrain.segmentBlockedBy(
                { query: () => [block] }, floor.x, floor.y, land.x, land.y, 2
              ))) {
                bridgeBoundarySegments++;
                continue;
              }
              // Extremely short authored edge segments are tested by planar sampling, not an oversized disc.
              if (Math.hypot(ramp.lowB.x - ramp.lowA.x, ramp.lowB.y - ramp.lowA.y) < 12) continue;
              const uphill = navigation.segmentClear(floor.x, floor.y, land.x, land.y, 2);
              const diagnostic = () => {
                const geometry = state.world.terrain;
                return JSON.stringify({
                  floor, land,
                  samples: [floor, low, high, land].map(point => {
                    const surface = atlas.sample(point.x, point.y);
                    return { id: surface.id, level: surface.level, ramp: surface.ramp?.id, bridge: surface.bridge?.id };
                  }),
                  geometryClear: geometry.segmentClear(floor.x, floor.y, land.x, land.y, 2),
                  blockers: geometry.blocks.filter(block => geometry.segmentBlockedBy(
                    { query: () => [block] }, floor.x, floor.y, land.x, land.y, 2
                  )).map(block => block.id)
                });
              };
              if (!uphill) throw new Error(`Seed ${seed} bank ${ramp.id} crosses uphill: ${diagnostic()}`);
              equal(navigation.segmentClear(land.x, land.y, floor.x, floor.y, 2), true, `Seed ${seed} bank ${ramp.id} crosses downhill`);
              crossings += 2;
            }
            check(crossings > 0, `Seed ${seed} has tested river crossings`);
            totalBankCrossings += crossings;
            for (const bridge of atlas.bridges) {
              const dx = Math.cos(bridge.angle || 0);
              const dy = Math.sin(bridge.angle || 0);
              const a = { x: bridge.x - dx * (bridge.halfLength + 8), y: bridge.y - dy * (bridge.halfLength + 8) };
              const b = { x: bridge.x + dx * (bridge.halfLength + 8), y: bridge.y + dy * (bridge.halfLength + 8) };
              for (const direction of [-1, 1]) {
                for (const widthFraction of [-1, -0.5, 0, 0.5, 1]) {
                  const support = {
                    x: bridge.x + dx * bridge.halfLength * direction - dy * bridge.halfWidth * widthFraction,
                    y: bridge.y + dy * bridge.halfLength * direction + dx * bridge.halfWidth * widthFraction
                  };
                  close(atlas.sampleTerrain(support.x, support.y).elevation, 0,
                    `Seed ${seed} bridge ${bridge.id} full-width end joins zero support`);
                }
              }
              equal(atlas.levelAt(a.x, a.y), 0, 'Generated bridge first end reaches zero land');
              equal(atlas.levelAt(b.x, b.y), 0, 'Generated bridge second end reaches zero land');
              if (!navigation.segmentClear(a.x, a.y, b.x, b.y, 2)) {
                const geometry = state.world.terrain;
                throw new Error('Generated bridge is traversable: ' + JSON.stringify({
                  seed, id: bridge.id, a, b,
                  blockers: geometry.blocks.filter(block => geometry.segmentBlockedBy(
                    { query: () => [block] }, a.x, a.y, b.x, b.y, 2
                  )).map(block => block.id)
                }));
              }
              equal(navigation.segmentClear(b.x, b.y, a.x, a.y, 2), true, 'Generated bridge is traversable in reverse');
            }
            evidence.push({ seed, banks: banks.length, bridges: atlas.bridges.length, crossings, bridgeBoundarySegments });
          } catch (error) {
            failures.push({ seed, error: error.message });
          }
        }
        check(failures.length === 0, JSON.stringify({ seeds: evidence, failures, totalBankCrossings }));
        return { seeds: evidence, totalBankCrossings };
      });

      test('Compact and rectangular presets retain valid negative water and separated bridges', () => {
        const evidence = [];
        for (const [width, height] of [[2400, 4800], [4800, 2400], [2400, 2400]]) {
          const rules = GameRuleRuntime.mergeGameRules(GameRuleDefinition.defaults, { map: { width, height } });
          for (const seed of [1, 8]) {
            const descriptor = MapGeneration.generateMapDescriptor({ rules, seed });
            const atlas = WorldContext.fromMap(descriptor).terrain.surfaces;
            equal(descriptor.generation.checks.waterLayerSeparation, true, 'Compact preset keeps bank layers separated');
            equal(descriptor.generation.checks.bridgeRampSeparation, true, 'Compact preset keeps bridge ends and ramps separated');
            check(atlas.ramps.some(ramp => ramp.bank && ramp.lowLevel === -1 && ramp.highLevel === 0), 'Compact preset retains actual negative river banks');
            evidence.push({ width, height, seed, banks: atlas.ramps.filter(ramp => ramp.bank).length });
          }
        }
        return evidence;
      });

      test('Persistent river viewport culling preserves every host and guest water pixel', () => {
        const descriptor = generatedMaps.get(8);
        check(descriptor, 'Default seed eight fixture was generated');
        const atlas = WorldContext.fromMap(descriptor).terrain.surfaces;
        const mesh = TerrainPresentation.riverSurfaceMesh(descriptor, atlas);
        equal(TerrainPresentation.riverSurfaceMesh(descriptor, atlas), mesh, 'River mesh cache preserves its identity');
        check(mesh.length > 0, 'Generated fixture has actual river triangles');
        const center = descriptor.terrain.riverPath[Math.floor(descriptor.terrain.riverPath.length / 2)];
        return ['host', 'guest'].map(role => {
          const canvas = document.createElement('canvas');
          canvas.width = 390;
          canvas.height = 650;
          const renderer = new GLRenderer(canvas);
          renderer.role = role;
          renderer.snapshot = stateFor(descriptor);
          renderer.world = renderer.snapshot.world;
          renderer.cameraLeft = renderer.viewX(center.x) - 450;
          renderer.cameraTop = renderer.viewY(center.y) - atlas.heightAt(center.x, center.y) * 0.6 - 750;
          const gl = renderer.gl;
          const projection = TerrainSurfaceProjection.forAtlas(atlas);
          const flipped = role === 'guest';
          equal(projection.projectedTriangleMesh(mesh, flipped), projection.projectedTriangleMesh(mesh, flipped), 'Projected river index is persistently cached');

          function paint(reference) {
            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.useProgram(renderer.p);
            gl.uniform2f(renderer.r, canvas.width, canvas.height);
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LEQUAL);
            gl.depthMask(true);
            gl.clearColor(...TerrainPresentation.colors.lowGround);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            renderer.begin();
            TerrainPresentation.drawSurfaces(renderer);
            renderer.flush();
            if (!reference) {
              TerrainPresentation.drawRiverSurfaces(renderer, descriptor, true);
            } else {
              // Reference draws the same production mesh in full, with its original order
              // and depth bias. Only the viewport selection is bypassed.
              const previous = renderer._renderDepth;
              gl.depthMask(false);
              renderer.begin();
              for (const triangle of mesh) {
                for (const vertex of triangle.vertices) {
                  const pixel = renderer.projectRenderWorldPosition(vertex);
                  renderer.setRenderDepth(pixel.depth - 0.0001);
                  renderer.v(pixel.x, pixel.y, triangle.color);
                }
              }
              renderer.flush();
              gl.depthMask(true);
              renderer.setRenderDepth(previous);
              renderer.begin();
            }
            const pixels = new Uint8Array(canvas.width * canvas.height * 4);
            gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            equal(gl.getError(), gl.NO_ERROR, 'Full-viewport water rendering has no GPU errors');
            return pixels;
          }
          const culled = paint(false);
          const selected = renderer.perfStats.riverVisibleTriangles;
          const total = renderer.perfStats.riverTotalTriangles;
          check(selected > 0 && selected < total, 'Viewport culling selects a proper nonempty subset of river triangles');
          const reference = paint(true);
          let differences = 0;
          let maxChannelDifference = 0;
          for (let index = 0; index < reference.length; index++) {
            const difference = Math.abs(culled[index] - reference[index]);
            if (difference) differences++;
            maxChannelDifference = Math.max(maxChannelDifference, difference);
          }
          equal(differences, 0, 'Viewport culling preserves every rendered RGBA channel');
          return { role, selected, total, differences, maxChannelDifference };
        });
      });

      test('Mobile bank gradient, picking and Fog align for host and guest', () => {
        const descriptor = bankMap();
        return ['host', 'guest'].flatMap(role => [0.25, 0.75].map(progress => {
          const canvas = document.createElement('canvas');
          canvas.width = 390;
          canvas.height = 650;
          const renderer = new GLRenderer(canvas);
          renderer.role = role;
          renderer.snapshot = stateFor(descriptor);
          renderer.world = renderer.snapshot.world;
          const atlas = renderer.world.terrain.surfaces;
          const ramp = atlas.ramps.find(ramp => ramp.bank && ramp.edge === 0);
          const low = midpoint(ramp.lowA, ramp.lowB);
          const high = midpoint(ramp.highA, ramp.highB);
          const point = TerrainSurfaceAtlas.lerp(low, high, progress);
          const sample = atlas.sample(point.x, point.y);
          const target = { x: point.x, y: sample.elevation, z: point.y, groundY: 0 };
          const side = role === 'guest' ? 1 : 0;
          const visionSource = { x: 1600, y: 1200, level: -1, r: 450, detect: 0, air: false, ignoresTerrainVision: false };
          renderer.visionGridBySide = [new Map(), new Map()];
          for (let y = 0; y <= descriptor.height / 320; y++) {
            for (let x = 0; x <= descriptor.width / 320; x++) {
              renderer.visionGridBySide[side].set(`${x},${y}`, [visionSource]);
            }
          }
          renderer.visionSourcesBySide = side ? [[], [visionSource]] : [[visionSource], []];
          renderer.cameraLeft = renderer.viewX(target.x) - 450;
          renderer.cameraTop = renderer.viewY(target.z) - target.y * 0.6 - 750;
          const projected = renderer.projectRenderWorldPosition(target);
          close(projected.x, 195, 'Bank projects to intended mobile pixel x');
          close(projected.y, 325, 'Bank projects to intended mobile pixel y');
          const picked = renderer.surfaceAtScreen(195, 325);
          close(picked.x, target.x, 'Bank picking world x');
          close(picked.z, target.z, 'Bank picking world z');
          close(picked.y, target.y, 'Bank picking continuous signed height');
          equal(VisibilityPolicy.sourceCanSeePoint(renderer.snapshot, visionSource, point.x, point.y), progress < 0.5, 'Low floor source uses actual bank visibility level');
          const gl = renderer.gl;
          gl.viewport(0, 0, canvas.width, canvas.height);
          gl.useProgram(renderer.p);
          gl.uniform2f(renderer.r, canvas.width, canvas.height);
          gl.enable(gl.DEPTH_TEST);
          gl.depthFunc(gl.LEQUAL);
          gl.depthMask(true);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          renderer.begin();
          TerrainPresentation.drawSurfaces(renderer);
          renderer.flush();
          function read() {
            const rgba = new Uint8Array(4);
            gl.readPixels(195, 324, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
            return [...rgba];
          }
          const bank = read();
          check(bank.slice(0, 3).every(component => component > 40), 'Actual bank surface renders');
          renderer.drawFog();
          const fog = read();
          if (progress > 0.5) check(fog.slice(0, 3).every(component => component < 40), 'Upper bank Fog stays opaque');
          else check(fog.slice(0, 3).every((component, i) => Math.abs(component - bank[i]) < 5), 'Lower bank remains visible');
          equal(gl.getError(), gl.NO_ERROR, 'Actual bank GPU pass has no errors');
          return { role, progress, height: sample.elevation, bank, fog, picked };
        }));
      });

      test('Full generated ground pass handles bridge-clipped bank meshes on mobile WebGL', () => {
        const descriptor = generatedMaps.get(8) || MapGeneration.generateMapDescriptor({
          rules: GameRuleDefinition.defaults, seed: 8
        });
        const atlas = WorldContext.fromMap(descriptor).terrain.surfaces;
        const clippedBankPatches = atlas.renderSurfaceMesh.filter(patch =>
          patch.kind === 'ramp' && patch.vertices.length !== 4
        ).length;
        check(clippedBankPatches > 0, 'Generated bridge clips actual bank patches into variable vertex counts');
        check(atlas.bridges.length > 0, 'Generated fixture includes actual bridges');
        return ['host', 'guest'].map(role => {
          const canvas = document.createElement('canvas');
          canvas.width = 390;
          canvas.height = 650;
          const renderer = new GLRenderer(canvas);
          renderer.role = role;
          renderer.snapshot = {
            ...stateFor(descriptor), mapDescriptor: descriptor,
            resources: [], gasNodes: [], camps: [], capturePoints: [], flags: []
          };
          renderer.world = renderer.snapshot.world;
          const bridge = atlas.bridges[0];
          renderer.cameraLeft = renderer.viewX(bridge.x) - 450;
          renderer.cameraTop = renderer.viewY(bridge.y) - 750;
          const gl = renderer.gl;
          gl.viewport(0, 0, canvas.width, canvas.height);
          gl.useProgram(renderer.p);
          gl.uniform2f(renderer.r, canvas.width, canvas.height);
          gl.enable(gl.DEPTH_TEST);
          gl.depthFunc(gl.LEQUAL);
          gl.depthMask(true);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          renderer.renderGroundPass();
          equal(gl.getError(), gl.NO_ERROR, 'Production generated ground pass completes without GPU errors');
          equal(renderer.renderFatalReported, false, 'Production generated ground pass has no render fatal');
          const picked = renderer.surfaceAtScreen(195, 325);
          close(picked.x, bridge.x, 'Generated bridge pixel picks its world x');
          close(picked.z, bridge.y, 'Generated bridge pixel picks its world z');
          close(picked.y, 0, 'Generated bridge pixel picks zero deck height');
          equal(picked.id, bridge.id, 'Generated bridge owns the center pixel');
          function read() {
            const rgba = new Uint8Array(4);
            gl.readPixels(195, 324, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
            return [...rgba];
          }
          const ground = read();
          check(ground.slice(0, 3).every(component => component > 40), 'Production bridge ground actually renders');
          renderer.drawFog();
          const fog = read();
          check(fog.slice(0, 3).every(component => component < 40), 'Production bridge and clipped banks remain covered by unseen Fog');
          equal(gl.getError(), gl.NO_ERROR, 'Production generated ground plus Fog completes without GPU errors');
          return { role, clippedBankPatches, ground, fog, pickedHeight: picked.y };
        });
      });

      test('Generated bank state export/import preserves deterministic simulation checksum', () => {
        const draft = { decks: { host: [], guest: [] }, defenseCards: { host: [], guest: [] } };
        const a = new StrategySim(draft, 3, GameRuleDefinition.defaults);
        const b = new StrategySim(draft, 3, GameRuleDefinition.defaults);
        for (let tick = 0; tick < 10; tick++) { a.step(); b.step(); }
        equal(a.checksum(), b.checksum(), 'Identical bank simulations produce identical checksums');
        const exported = a.exportState();
        b.importState(exported);
        equal(a.checksum(), b.checksum(), 'Bank state round-trip preserves checksum');
        check(b.world.terrain.surfaces.ramps.some(ramp => ramp.bank), 'State import reconstructs actual bank surfaces');
        for (let tick = 0; tick < 5; tick++) { a.step(); b.step(); }
        equal(a.checksum(), b.checksum(), 'Post-import bank simulation remains deterministic');
        const checksum = a.checksum();
        a.dispose('qa-finished');
        b.dispose('qa-finished');
        return { ticks: a.tick, checksum };
      });
      return results;
    });
    console.log(JSON.stringify({ cases, pageErrors }, null, 2));
    assert.deepEqual(pageErrors, [], 'Application has no boot errors');
    assert.deepEqual(cases.filter(test => test.status !== 'PASS'), [], 'Every river bank regression passes');
  } finally {
    await browser.close();
  }
}

run().catch(error => { console.error(error.stack); process.exitCode = 1; });
