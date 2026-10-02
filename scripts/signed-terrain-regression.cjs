const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const htmlPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'index.html');
const channel = process.env.QA_BROWSER_CHANNEL || 'msedge';

async function run() {
  let html = fs.readFileSync(htmlPath, 'utf8');
  const end = html.lastIndexOf('})();');
  assert.ok(end >= 0, 'Application IIFE exists');
  html = html.slice(0, end) + `
    window.__signedQA = {
      GLRenderer, WorldContext, TerrainSurfaceAtlas, TerrainSurfaceProjection,
      TerrainNavigation, VisibilityPolicy, TerrainPresentation, TerrainQuery,
      CampaignContentValidator, CampaignMapDefinition, CAMPAIGN_MISSION_SCHEMA_VERSION
    };
  ` + html.slice(end);
  const browser = await chromium.launch({
    channel, headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 650 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('http://signed-qa.local/**', route => route.fulfill({
      status: 200, contentType: 'text/html', body: html
    }));
    await page.goto('http://signed-qa.local/', { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForFunction(() => window.__signedQA);
    } catch (error) {
      console.error(JSON.stringify({ startupPageErrors: pageErrors }, null, 2));
      throw error;
    }
    const cases = await page.evaluate(() => {
      const {
        GLRenderer, WorldContext, TerrainSurfaceAtlas, TerrainSurfaceProjection,
        TerrainNavigation, VisibilityPolicy, TerrainPresentation, TerrainQuery,
        CampaignContentValidator, CampaignMapDefinition, CAMPAIGN_MISSION_SCHEMA_VERSION
      } = window.__signedQA;
      const results = [];
      function check(condition, message) {
        if (!condition) throw new Error(message);
      }
      function equal(actual, expected, message) {
        check(actual === expected, `${message}: expected ${expected}, received ${actual}`);
      }
      function close(actual, expected, message) {
        check(Math.abs(actual - expected) < 0.001, `${message}: ${actual} != ${expected}`);
      }
      function test(name, body) {
        try {
          results.push({ name, status: 'PASS', evidence: body() });
        } catch (error) {
          results.push({ name, status: 'FAIL', error: error.message });
        }
      }
      function rectangle(id, level, x0, y0, x1, y1) {
        return { id, level, points: [
          { x: x0, y: y0 }, { x: x1, y: y0 },
          { x: x1, y: y1 }, { x: x0, y: y1 }
        ] };
      }
      function map(layers, ramps = []) {
        return { width: 3072, height: 4096, terrain: { layers, ramps } };
      }
      function stateFor(descriptor) {
        return { tick: 0, world: WorldContext.fromMap(descriptor), units: [], buildings: [] };
      }
      function source(x, y, level, air = false) {
        return { x, y, level, r: 3000, detect: 0, air, ignoresTerrainVision: false };
      }
      const nestedMap = map([
        rectangle('outer-pit', -1, 400, 400, 2400, 3000),
        rectangle('deep-pit', -2, 1000, 1000, 2000, 2200),
        rectangle('island', 0, 1300, 1300, 1700, 1700)
      ]);
      const rampMap = map([rectangle('pit', -1, 1024, 1024, 2048, 2048)], [{
        id: 'pit-ramp', layerId: 'pit', edge: 0, t0: 0.125, t1: 0.375, run: 128
      }]);

      test('Signed levels and smallest-contained surface selection', () => {
        const atlas = TerrainSurfaceAtlas.fromMap(nestedMap);
        const levels = [
          atlas.levelAt(200, 200), atlas.levelAt(800, 1500),
          atlas.levelAt(1100, 1500), atlas.levelAt(1500, 1500)
        ];
        equal(JSON.stringify(levels), '[0,-1,-2,0]', 'Base, pit, nested pit, island levels');
        close(atlas.heightAt(1100, 1500), -192, 'Negative elevation derives from level');
        // Alternating upward/downward nesting must choose containment, not numeric maximum.
        const alternating = TerrainSurfaceAtlas.fromMap(map([
          rectangle('positive', 2, 300, 300, 2700, 3500),
          rectangle('negative', -2, 600, 600, 2400, 3200),
          rectangle('restored', 1, 900, 900, 2100, 2900),
          rectangle('depressed', -1, 1200, 1200, 1800, 2500)
        ]));
        const alternateLevels = [450, 750, 1050, 1500]
          .map(x => alternating.levelAt(x, 1800));
        equal(JSON.stringify(alternateLevels), '[2,-2,1,-1]', 'Alternating nested levels');
        return { levels, alternateLevels, deepElevation: atlas.heightAt(1100, 1500) };
      });

      test('Signed levels have no arbitrary gameplay floor or ceiling', () => {
        return [-10000, 10000].map(level => {
          const atlas = TerrainSurfaceAtlas.fromMap(map([
            rectangle('distant-level', level, 600, 600, 1800, 2200)
          ]));
          equal(atlas.levelAt(1200, 1600), level, 'Large signed level remains authored');
          close(atlas.heightAt(1200, 1600), level * 96, 'Large signed elevation');
          equal(atlas.minLevel, Math.min(0, level), 'Derived minimum');
          equal(atlas.maxLevel, Math.max(0, level), 'Derived maximum');
          return level;
        });
      });

      test('Depression ramps order low/high independently of exterior', () => {
        const atlas = TerrainSurfaceAtlas.fromMap(rampMap);
        const ramp = atlas.ramps[0];
        equal(ramp.lowLevel, -1, 'Actual lower endpoint');
        equal(ramp.highLevel, 0, 'Actual higher endpoint');
        const low = TerrainSurfaceAtlas.lerp(ramp.lowA, ramp.lowB, 0.5);
        const high = TerrainSurfaceAtlas.lerp(ramp.highA, ramp.highB, 0.5);
        const samples = [0, 0.4999, 0.5, 1].map(t => {
          const point = TerrainSurfaceAtlas.lerp(low, high, t);
          const sampled = atlas.sample(point.x, point.y);
          close(sampled.progress, t, 'Ramp progress follows actual ascent');
          close(sampled.elevation, -96 + 96 * t, 'Ramp elevation interpolates signed endpoints');
          return sampled.level;
        });
        equal(JSON.stringify(samples), '[-1,-1,0,0]', 'Ramp midpoint changes to higher level');
        return { low, high, samples };
      });

      test('Ramp navigation transitions and both cliff directions', () => {
        const state = stateFor(rampMap);
        const atlas = state.world.terrain.surfaces;
        const ramp = atlas.ramps[0];
        const low = TerrainSurfaceAtlas.lerp(ramp.lowA, ramp.lowB, 0.5);
        const high = TerrainSurfaceAtlas.lerp(ramp.highA, ramp.highB, 0.5);
        const dx = (high.x - low.x) / ramp.run;
        const dy = (high.y - low.y) / ramp.run;
        const pit = { x: low.x - dx * 32, y: low.y - dy * 32 };
        const base = { x: high.x + dx * 32, y: high.y + dy * 32 };
        const navigation = TerrainNavigation.forState(state);
        equal(navigation.segmentClear(pit.x, pit.y, base.x, base.y, 8), true, 'Ascent through authored ramp');
        equal(navigation.segmentClear(base.x, base.y, pit.x, pit.y, 8), true, 'Descent through authored ramp');
        equal(navigation.segmentClear(1800, 960, 1800, 1100, 8), false, 'Base cannot cross cliff into pit');
        equal(navigation.segmentClear(1800, 1100, 1800, 960, 8), false, 'Pit cannot cross cliff onto base');
        for (const [endpoint, outward] of [[low, -1], [high, 1]]) {
          const a = { x: endpoint.x + dx * outward, y: endpoint.y + dy * outward };
          const b = { x: endpoint.x - dx * outward, y: endpoint.y - dy * outward };
          equal(atlas.transition(atlas.sample(a.x, a.y), atlas.sample(b.x, b.y), a, b), true, 'Ramp seam transition');
        }
        return { pit, base, ascent: true, descent: true, cliffBothDirections: false };
      });

      test('East-edge depression ramp side normals and host/guest cliff culling', () => {
        const descriptor = map([rectangle('east-pit', -1, 1024, 1024, 2048, 2048)], [{
          id: 'east-ramp', layerId: 'east-pit', edge: 1,
          t0: 0.125, t1: 0.375, run: 128
        }]);
        const atlas = TerrainSurfaceAtlas.fromMap(descriptor);
        const ramp = atlas.ramps[0];
        const sides = [
          { a: ramp.highA, b: ramp.lowA, expectedNormal: -1 },
          { a: ramp.lowB, b: ramp.highB, expectedNormal: 1 }
        ];
        function samePoint(a, b) {
          return Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001;
        }
        function findFace(faces, side) {
          const face = faces.find(candidate =>
            samePoint(candidate.a, side.a) && samePoint(candidate.b, side.b)
          );
          check(face, 'Ramp side retains both protected authored endpoints');
          close(face.outwardY, side.expectedNormal, 'Ramp wall normal points toward lower surrounding floor');
          return face;
        }
        const exactFaces = sides.map(side => findFace(atlas.faces, side));
        const renderFaces = sides.map(side => findFace(atlas.renderFaces, side));
        const culling = ['host', 'guest'].map(role => {
          const flipped = role === 'guest';
          const projected = TerrainSurfaceProjection.forAtlas(atlas).projectedSurfaceMesh(flipped);
          const counts = sides.map(side => projected.triangles.filter(triangle =>
            triangle.kind === 'cliff' && triangle.vertices.every(vertex =>
              Math.abs(vertex.z - side.a.y) < 0.001 &&
              vertex.x >= Math.min(side.a.x, side.b.x) - 0.001 &&
              vertex.x <= Math.max(side.a.x, side.b.x) + 0.001
            )
          ).length);
          const expected = flipped ? [1, 0] : [0, 1];
          equal(JSON.stringify(counts), JSON.stringify(expected), 'Picking mesh includes only the facing ramp side');

          const frontFace = renderFaces[flipped ? 0 : 1];
          const patch = atlas.renderSurfaceMesh.find(candidate => candidate.face === frontFace);
          check(patch, 'Renderer has an actual mesh for the facing side');
          const canvas = document.createElement('canvas');
          canvas.width = 390;
          canvas.height = 650;
          const renderer = new GLRenderer(canvas);
          renderer.role = role;
          renderer.snapshot = stateFor(descriptor);
          renderer.world = renderer.snapshot.world;
          const gl = renderer.gl;
          const triangle = patch.triangles.find(indices => {
            const [a, b, c] = indices.map(index => renderer.projectRenderWorldPosition(patch.vertices[index]));
            return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) > 0.001;
          });
          check(triangle, 'Facing side has nondegenerate projected area');
          const vertices = triangle.map(index => patch.vertices[index]);
          const target = {
            x: vertices.reduce((sum, vertex) => sum + vertex.x, 0) / 3,
            y: vertices.reduce((sum, vertex) => sum + vertex.y, 0) / 3,
            z: vertices.reduce((sum, vertex) => sum + vertex.z, 0) / 3,
            groundY: 0
          };
          renderer.cameraLeft = renderer.viewX(target.x) - 450;
          renderer.cameraTop = renderer.viewY(target.z) - target.y * 0.6 - 750;
          const picked = renderer.surfaceAtScreen(195, 325);
          equal(picked.kind, 'cliff', 'Mobile pixel picks the exposed ramp wall');
          close(picked.y, target.y, 'Picking follows the wall elevation');
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
          const rgba = new Uint8Array(4);
          gl.readPixels(195, 324, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
          const dx = frontFace.b.x - frontFace.a.x;
          const dy = frontFace.b.y - frontFace.a.y;
          const light = (dx - dy) / Math.hypot(dx, dy);
          const expectedColor = [
            (0.31 + light * 0.035) * 255,
            (0.37 + light * 0.035) * 255,
            (0.25 + light * 0.025) * 255
          ];
          expectedColor.forEach((value, index) =>
            check(Math.abs(rgba[index] - value) < 2,
              `Production renderer ${role} cliff color: actual ${[...rgba]} expected ${expectedColor} picked ${JSON.stringify(picked)}`)
          );
          equal(gl.getError(), gl.NO_ERROR, 'Directional side rendering has no GPU errors');
          return { role, projectedSideTriangles: counts, rgba: [...rgba], pickedHeight: picked.y };
        });
        return {
          exactNormals: exactFaces.map(face => face.outwardY),
          renderNormals: renderFaces.map(face => face.outwardY), culling
        };
      });

      test('Signed vision targets and intervening base terrain', () => {
        const state = stateFor(nestedMap);
        const ground = source(800, 1500, -1);
        equal(VisibilityPolicy.sourceCanSeePoint(state, ground, 200, 1500), false, 'Pit cannot see higher base');
        equal(VisibilityPolicy.sourceCanSeePoint(state, { ...ground, air: true }, 200, 1500), true, 'Air ignores height restriction');
        equal(VisibilityPolicy.sourceCanSeePoint(state, ground, 1100, 1500), true, 'Pit sees lower nested pit');
        equal(VisibilityPolicy.sourceCanSeePoint(state, ground, 1500, 1500), false, 'Pit cannot see level-zero island');
        const separated = stateFor(map([
          rectangle('left-pit', -1, 400, 1000, 1000, 1800),
          rectangle('right-pit', -1, 1400, 1000, 2000, 1800)
        ]));
        const left = source(700, 1400, -1);
        equal(VisibilityPolicy.sourceCanSeePoint(separated, left, 1700, 1400), false, 'Intervening level zero blocks two negative pits');
        equal(VisibilityPolicy.sourceCanSeePoint(separated, { ...left, air: true }, 1700, 1400), true, 'Air sees across intervening base');
        return { higherBase: false, lowerPit: true, zeroIsland: false, separatedPit: false, air: true };
      });

      test('Host and guest ray picking enters depressed floor through base hole', () => {
        const atlas = TerrainSurfaceAtlas.fromMap(map([
          rectangle('floor', -2, 1024, 1024, 2048, 2048)
        ]));
        const projection = TerrainSurfaceProjection.forAtlas(atlas);
        const picks = [false, true].map(flipped => {
          const x = flipped ? atlas.width - 1536 : 1536;
          const y = (flipped ? atlas.height - 1536 : 1536) - (-192) * 0.6;
          const picked = projection.pickSurface(x, y, flipped);
          close(picked.x, 1536, 'Picked floor world x');
          close(picked.z, 1536, 'Picked floor world z');
          close(picked.y, -192, 'Picked depressed floor height');
          return { flipped, x: picked.x, y: picked.y, z: picked.z };
        });
        return picks;
      });

      function triangleCovers(vertices, triangle, x, z) {
        const [a, b, c] = triangle.map(index => vertices[index]);
        const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
        if (Math.abs(denominator) < 1e-9) return false;
        const wa = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / denominator;
        const wb = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / denominator;
        return Math.min(wa, wb, 1 - wa - wb) >= -1e-8;
      }

      test('Fog uses actual signed surfaces and cut base patches', () => {
        const canvas = document.createElement('canvas');
        canvas.width = 390;
        canvas.height = 650;
        const renderer = new GLRenderer(canvas);
        renderer.snapshot = stateFor(nestedMap);
        renderer.world = renderer.snapshot.world;
        renderer.ensureFogTextures();
        const keys = [...renderer.fogTextures.keys()].sort();
        equal(JSON.stringify(keys), '["level:-1","level:-2","level:0"]', 'Only actual signed levels allocate masks');
        const basePatches = renderer.fogSurfaces.get(0).filter(patch => patch.kind === 'plateau');
        const covering = basePatches.reduce((count, patch) => count + patch.triangles
          .filter(triangle => triangleCovers(patch.vertices, triangle, 1100, 1500)).length, 0);
        equal(covering, 0, 'Base Fog triangles leave the negative floor open');
        equal(renderer.gl.getError(), renderer.gl.NO_ERROR, 'Signed Fog upload has no GPU errors');
        return { keys, baseTrianglesCoveringDeepFloor: covering };
      });

      test('Mobile WebGL floor pixel and picking align for both orientations', () => {
        const descriptor = map([rectangle('floor', -2, 1024, 1024, 2048, 2048)]);
        return ['host', 'guest'].map(role => {
          const canvas = document.createElement('canvas');
          canvas.width = 390;
          canvas.height = 650;
          const renderer = new GLRenderer(canvas);
          const gl = renderer.gl;
          renderer.role = role;
          renderer.snapshot = stateFor(descriptor);
          renderer.world = renderer.snapshot.world;
          // Signed terrain extends the bottom camera bound by the projected pit depth.
          const bottomCameraTop = renderer.clampCameraTop(100000);
          close(bottomCameraTop, 4096 + 192 * 0.6 - 1500, 'Negative floor bottom camera bound');
          close(renderer.clampCameraTop(-100000), 0, 'All-negative map top camera bound');
          const target = { x: 1536, y: -192, z: 1536, groundY: 0 };
          renderer.cameraLeft = renderer.viewX(target.x) - 450;
          renderer.cameraTop = renderer.viewY(target.z) - target.y * 0.6 - 750;
          const projected = renderer.projectRenderWorldPosition(target);
          close(projected.x, 195, 'Mobile floor pixel x');
          close(projected.y, 325, 'Mobile floor pixel y');
          const picked = renderer.surfaceAtScreen(projected.x, projected.y);
          close(picked.x, target.x, 'Mobile picking x');
          close(picked.z, target.z, 'Mobile picking planar y');
          close(picked.y, target.y, 'Mobile picking negative height');
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
          function pixel() {
            const rgba = new Uint8Array(4);
            gl.readPixels(195, 324, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
            return [...rgba];
          }
          const floor = pixel();
          check(floor.slice(0, 3).every(value => value > 40), 'Depressed floor actually renders in base hole');
          renderer.drawFog();
          const fog = pixel();
          check(fog.slice(0, 3).every(value => value < 40), 'Unseen depressed floor Fog actually renders');
          equal(gl.getError(), gl.NO_ERROR, 'Mobile render has no GPU errors');
          return { role, floor, fog, picked, bottomCameraTop };
        });
      });

      test('Depressed river water follows signed floors and excludes level-zero bridge island', () => {
        const descriptor = {
          ...nestedMap,
          terrain: {
            ...nestedMap.terrain,
            riverPolygon: rectangle('river-area', 0, 500, 600, 2300, 2800).points,
            riverBranchPolygons: [], riverPath: [], riverBranches: []
          }
        };
        const atlas = TerrainSurfaceAtlas.fromMap(descriptor);
        const mesh = TerrainPresentation.riverSurfaceMesh(descriptor, atlas);
        check(mesh.length > 0, 'River mesh intersects authored negative floors');
        const elevations = [...new Set(mesh.flatMap(triangle => triangle.vertices.map(vertex => vertex.y)))].sort((a, b) => a - b);
        equal(JSON.stringify(elevations), '[-192,-96]', 'Water vertices use actual signed floor heights');
        for (const triangle of mesh) {
          for (const vertex of triangle.vertices) {
            equal(vertex.groundY, 0, 'Water vertices already contain their elevation');
          }
        }
        const islandCoverage = mesh.filter(triangle =>
          triangleCovers(triangle.vertices, [0, 1, 2], 1500, 1500)
        ).length;
        equal(islandCoverage, 0, 'Level-zero bridge island clips water triangles');
        equal(TerrainQuery.at(descriptor, 1500, 1500).river, false, 'Raised zero island is dry for gameplay');
        equal(TerrainQuery.at(descriptor, 800, 1800).river, true, 'Negative floor is river for gameplay');
        const negativeIsland = {
          ...descriptor,
          terrain: {
            ...descriptor.terrain,
            layers: [
              ...descriptor.terrain.layers.slice(0, 2),
              rectangle('raised-negative-island', -1, 1300, 1300, 1700, 1700)
            ]
          }
        };
        const negativeIslandMesh = TerrainPresentation.riverSurfaceMesh(
          negativeIsland, TerrainSurfaceAtlas.fromMap(negativeIsland)
        );
        equal(TerrainQuery.at(negativeIsland, 1500, 1500).river, false, 'Raised negative island is also dry for gameplay');
        equal(negativeIslandMesh.filter(triangle =>
          triangleCovers(triangle.vertices, [0, 1, 2], 1500, 1500)
        ).length, 0, 'Raised negative island also clips river triangles');

        const pixels = [];
        for (const role of ['host', 'guest']) {
          for (const target of [
            { x: 800, y: -96, z: 1800, groundY: 0 },
            { x: 1100, y: -192, z: 1800, groundY: 0 }
          ]) {
            const canvas = document.createElement('canvas');
            canvas.width = 390;
            canvas.height = 650;
            const renderer = new GLRenderer(canvas);
            const gl = renderer.gl;
            renderer.role = role;
            renderer.snapshot = stateFor(descriptor);
            renderer.world = renderer.snapshot.world;
            renderer.cameraLeft = renderer.viewX(target.x) - 450;
            renderer.cameraTop = renderer.viewY(target.z) - target.y * 0.6 - 750;
            const projected = renderer.projectRenderWorldPosition(target);
            close(projected.x, 195, 'Mobile water pixel x');
            close(projected.y, 325, 'Mobile water pixel y');
            const picked = renderer.surfaceAtScreen(projected.x, projected.y);
            close(picked.x, target.x, 'Water surface picking world x');
            close(picked.z, target.z, 'Water surface picking world z');
            close(picked.y, target.y, 'Water surface picking signed elevation');

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
            const read = () => {
              const rgba = new Uint8Array(4);
              gl.readPixels(195, 324, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
              return [...rgba];
            };
            const floor = read();
            TerrainPresentation.drawRiverSurfaces(renderer, descriptor);
            equal(gl.getParameter(gl.DEPTH_WRITEMASK), true, 'Water restores caller depth-write state');
            const water = read();
            check(water[2] > water[0] + 30, 'Water visibly replaces floor with blue');
            check(water[2] >= water[1], 'Depressed water blue component exceeds green');
            check(water[2] !== floor[2] || water[0] !== floor[0], 'Actual water pass changes floor pixels');
            renderer.drawFog();
            const fog = read();
            check(fog.slice(0, 3).every(value => value < 40), 'Fog covers depressed water without depth interference');
            equal(gl.getError(), gl.NO_ERROR, 'Depressed water render has no GPU errors');
            pixels.push({ role, elevation: target.y, floor, water, fog, picked });
          }
        }
        return { triangles: mesh.length, elevations, islandCoverage, pixels };
      });

      test('Implicit level-zero base preserves underlay while explicit zero island paints dry grass', () => {
        const underlayMap = {
          ...nestedMap,
          terrain: {
            ...nestedMap.terrain,
            riverPolygon: rectangle('water-source', 0, 100, 100, 2500, 3100).points
          }
        };
        return [
          { id: 'low-ground', x: 200, z: 200, preserve: true },
          { id: 'island', x: 1500, z: 1500, preserve: false }
        ].map(target => {
          const canvas = document.createElement('canvas');
          canvas.width = 390;
          canvas.height = 650;
          const renderer = new GLRenderer(canvas);
          const gl = renderer.gl;
          renderer.snapshot = stateFor(underlayMap);
          renderer.world = renderer.snapshot.world;
          renderer.cameraLeft = target.x - 450;
          renderer.cameraTop = target.z - 750;
          gl.viewport(0, 0, canvas.width, canvas.height);
          gl.useProgram(renderer.p);
          gl.uniform2f(renderer.r, canvas.width, canvas.height);
          gl.enable(gl.DEPTH_TEST);
          gl.depthFunc(gl.LEQUAL);
          gl.depthMask(true);
          gl.clearColor(0.1, 0.3, 0.6, 1);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          const read = () => {
            const rgba = new Uint8Array(4);
            gl.readPixels(195, 324, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
            return [...rgba];
          };
          const before = read();
          renderer.begin();
          TerrainPresentation.drawSurfaces(renderer);
          renderer.flush();
          const after = read();
          if (target.preserve) {
            equal(JSON.stringify(after), JSON.stringify(before), 'Implicit base preserves blue underlay pixel exactly');
          } else {
            const grass = TerrainPresentation.colors.lowGround.slice(0, 3);
            grass.forEach((component, index) =>
              check(Math.abs(after[index] - component * 255) < 2, 'Explicit zero island paints opaque dry grass')
            );
            check(after[1] > after[2], 'Raised zero island is green, not blue');
          }
          let afterRiver = null;
          if (!target.preserve) {
            TerrainPresentation.drawRiverSurfaces(renderer, underlayMap);
            afterRiver = read();
            equal(JSON.stringify(afterRiver), JSON.stringify(after), 'River drawing leaves the dry island grass unchanged');
          }
          const picked = renderer.surfaceAtScreen(195, 325);
          close(picked.y, 0, 'Pixel is on the actual zero-level floor');
          equal(picked.id, target.id, 'Correct implicit or explicit floor owns the picked surface');
          equal(gl.getError(), gl.NO_ERROR, 'Level-zero render has no GPU errors');
          return { id: target.id, before, after, afterRiver, picked };
        });
      });

      test('Campaign validator and build accept negative and zero authored levels', () => {
        const raw = {
          schemaVersion: CAMPAIGN_MISSION_SCHEMA_VERSION,
          id: 'signed-terrain-regression', title: 'Signed terrain regression',
          map: {
            type: 'manual', width: 3072, height: 4096,
            content: { resourcePlacement: 'manual' },
            terrain: {
              layers: nestedMap.terrain.layers.map(layer => ({
                id: layer.id, level: layer.level,
                points: layer.points.map(point => [point.x / 3072, point.y / 4096])
              }))
            }
          },
          player: {}, enemy: {}, objectives: [], events: []
        };
        CampaignContentValidator.validate(raw);
        const built = CampaignMapDefinition.build(raw.map);
        const levels = built.terrain.layers.map(layer => layer.level);
        equal(JSON.stringify(levels), '[-1,-2,0]', 'Campaign build retains authored signed levels');
        const atlas = TerrainSurfaceAtlas.fromMap(built);
        equal(atlas.levelAt(1500, 1500), 0, 'Campaign zero island remains above pit');
        return { schemaVersion: CAMPAIGN_MISSION_SCHEMA_VERSION, levels };
      });
      return results;
    });
    console.log(JSON.stringify({ cases, pageErrors }, null, 2));
    assert.deepEqual(pageErrors, [], 'Application starts without page errors');
    const failures = cases.filter(result => result.status !== 'PASS');
    assert.deepEqual(failures, [], 'Every signed terrain regression passes');
  } finally {
    await browser.close();
  }
}

run().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
