const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Requires Playwright in Node's module path and an installed Edge browser.
// Run: node scripts/fog-regression.cjs (QA_BROWSER_CHANNEL overrides Edge).
// Supply an HTML path when running outside the repository's scripts directory.
const htmlPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'index.html');
const browserChannel = process.env.QA_BROWSER_CHANNEL || 'msedge';

function exposeTestDefinitions(html) {
  const closingIndex = html.lastIndexOf('})();');
  assert.ok(closingIndex >= 0, 'Application IIFE closing marker exists');
  const exposure = `
    window.__fogQA = {
      GLRenderer, WorldContext, TerrainSurfaceAtlas, VisibilityPolicy, TerrainPresentation
    };
  `;
  return html.slice(0, closingIndex) + exposure + html.slice(closingIndex);
}

function verifyResults(result, pageErrors) {
  assert.equal(result.shaderLinked, true, 'Production Fog shader links');
  assert.deepEqual(result.sparseLevels, ['level:0', 'level:5']);
  assert.deepEqual(result.maskSize, { w: 41, h: 61 });
  assert.equal(result.initialUploads, 2);
  assert.deepEqual(result.lowSourcePolicy, {
    low: true, high: false, lowMask: 255, highMask: 0
  });

  for (const midpoint of result.ramp.midpoints) {
    assert.equal(midpoint.progress, 0.5);
    assert.equal(midpoint.level, 5);
    assert.equal(midpoint.elevation, result.ramp.midpointElevation);
  }
  assert.deepEqual(result.ramp.samples.map(sample => sample.level), [0, 5, 5]);
  assert.equal(result.unchangedCacheUploadDelta, 0);
  assert.deepEqual(result.sameTickGrid, {
    uploadDelta: 2, previousPoint: 0, highPoint: 255, policy: true
  });
  assert.deepEqual(result.sameTickWorld, {
    atlasChanged: true, uploadDelta: 2, rampPatches: 0
  });
  assert.deepEqual(result.staleTextureCleanup, {
    keys: ['level:0', 'level:1'], deleted: 1
  });

  assert.deepEqual(result.nonSquareUV.maskSizeUniform, [41, 61]);
  assert.deepEqual(result.nonSquareUV.center, [0, 0, 0, 255]);
  assert.deepEqual(result.nonSquareUV.leftNeighbor, [255, 0, 0, 255]);
  assert.deepEqual(result.nonSquareUV.lowerNeighbor, [255, 0, 0, 255]);

  const seam = result.shortGuestRamp;
  assert.equal(seam.orientation, 'guest');
  assert.equal(seam.rampRun, 24);
  assert.equal(seam.targetLevel, 1);
  assert.equal(seam.exactVisible, false);
  assert.equal(seam.lowTexelVisible, true);
  assert.equal(seam.highTexelVisible, false);
  for (const component of seam.ground.slice(0, 3)) {
    assert.ok(component > 40, 'The selected GPU pixel lies on rendered terrain');
  }
  for (const component of seam.fixedLevelFog.slice(0, 3)) {
    assert.ok(component <= 40, 'High ramp remains dark for a low-ground source');
  }
  assert.ok(
    seam.continuousFog[0] >= seam.fixedLevelFog[0] + 20,
    'Control continuous mask reproduces the ramp visibility leak'
  );
  assert.equal(result.glError, 0);
  assert.deepEqual(pageErrors, []);
}

async function run() {
  const html = exposeTestDefinitions(fs.readFileSync(htmlPath, 'utf8'));
  const browser = await chromium.launch({
    channel: browserChannel,
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });

  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('http://fog-qa.local/**', route => route.fulfill({
      status: 200, contentType: 'text/html', body: html
    }));
    await page.goto('http://fog-qa.local/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__fogQA);

    const result = await page.evaluate(() => {
      const {
        GLRenderer, WorldContext, TerrainSurfaceAtlas, VisibilityPolicy, TerrainPresentation
      } = window.__fogQA;
      const canvas = document.createElement('canvas');
      canvas.width = 410;
      canvas.height = 610;
      const renderer = new GLRenderer(canvas);
      const gl = renderer.gl;
      const out = {
        webglVersion: gl.getParameter(gl.VERSION),
        shaderLinked: false
      };

      // Observe the real device boundary; native uploads/draws still execute unchanged.
      const uploads = [], deletedTextures = [];
      const device = renderer.device;
      const nativeCreate = device.createTexture.bind(device), nativeUpdate = device.updateTexture.bind(device), nativeDelete = device.deleteTexture.bind(device);
      device.createTexture = (source, options) => {
        const texture = nativeCreate(source, options);
        uploads.push({texture,w:source.width,h:source.height,data:new Uint8Array(source.data)});
        return texture;
      };
      device.updateTexture = (texture, source, region) => {
        const result = nativeUpdate(texture, source, region);
        uploads.push({texture,w:source.width,h:source.height,data:new Uint8Array(source.data)});
        return result;
      };
      device.deleteTexture = texture => { const result=nativeDelete(texture); if(result)deletedTextures.push(texture); return result; };
      let lastMaskSize;
      const nativeDraw=device.draw.bind(device);
      device.draw=command=>{const result=nativeDraw(command);if(command.pipeline===renderer.fogProgram){lastMaskSize=[...command.uniforms.maskSize];out.shaderLinked=gl.getProgramParameter(gl.getParameter(gl.CURRENT_PROGRAM),gl.LINK_STATUS);}return result;};

      function mapFor(level, withRamp = true, edgeY = 1024, run = 256) {
        return {
          width: 2560,
          height: 3840,
          terrain: {
            layers: [{
              id: 'high', level,
              points: [
                { x: 1024, y: edgeY }, { x: 2048, y: edgeY },
                { x: 2048, y: edgeY + 1024 }, { x: 1024, y: edgeY + 1024 }
              ]
            }],
            ramps: withRamp ? [{
              id: 'ramp', layerId: 'high', edge: 0,
              t0: 0.125, t1: 0.375, run
            }] : []
          }
        };
      }

      function sourceAt(x, y, level) {
        return {
          x, y, level, r: 400, detect: 0,
          air: false, ignoresTerrainVision: false
        };
      }

      function gridFor(source, side = 0) {
        const grid = [new Map(), new Map()];
        // Explicitly populate test bins; production VisibilityPolicy does all LOS checks.
        for (let y = 0; y <= 3840 / 320; y++) {
          for (let x = 0; x <= 2560 / 320; x++) {
            grid[side].set(`${x},${y}`, [source]);
          }
        }
        return grid;
      }

      function useWorld(world) {
        renderer.world = world;
        renderer.snapshot = { tick: 12, world, units: [], buildings: [] };
      }

      function lastMask(id) {
        const texture = renderer.fogTextures.get(id);
        return uploads.filter(upload => upload.texture === texture).at(-1);
      }

      function maskAt(mask, x, y) {
        const i = Math.round(x / renderer.world.width * (mask.w - 1));
        const j = Math.round(y / renderer.world.height * (mask.h - 1));
        return mask.data[j * mask.w + i];
      }

      const worldA = WorldContext.fromMap(mapFor(5));
      useWorld(worldA);
      const lowSource = sourceAt(1280, 960, 0);
      renderer.visionGridBySide = gridFor(lowSource);
      renderer.visionSourcesBySide = [[lowSource], []];
      renderer.ensureFogTextures();
      out.sparseLevels = [...renderer.fogTextures.keys()];
      out.maskSize = renderer.fogMaskSize;
      out.initialUploads = uploads.length;
      out.lowSourcePolicy = {
        low: VisibilityPolicy.sourceCanSeePoint(
          renderer.snapshot, lowSource, 1280, 960, { targetLevel: 0 }
        ),
        high: VisibilityPolicy.sourceCanSeePoint(
          renderer.snapshot, lowSource, 1280, 960, { targetLevel: 5 }
        ),
        lowMask: maskAt(lastMask('level:0'), 1280, 960),
        highMask: maskAt(lastMask('level:5'), 1280, 960)
      };

      const ramp = worldA.terrain.surfaces.ramps[0];
      const highHalf = renderer.fogSurfaces.get(5)
        .find(patch => patch.kind === 'ramp');
      out.ramp = {
        midpointElevation: (ramp.lowElevation + ramp.highElevation) / 2,
        midpoints: highHalf.vertices.filter(vertex =>
          Math.abs(vertex.y - (ramp.lowElevation + ramp.highElevation) / 2) < 1e-7
        ).map(vertex => ({
          progress: worldA.terrain.surfaces.rampProgress(ramp, vertex.x, vertex.z),
          level: worldA.terrain.surfaces.sample(vertex.x, vertex.z).level,
          elevation: vertex.y
        })),
        samples: [0.4999, 0.5, 0.5001].map(t => {
          const a = TerrainSurfaceAtlas.lerp(ramp.lowA, ramp.lowB, 0.5);
          const b = TerrainSurfaceAtlas.lerp(ramp.highA, ramp.highB, 0.5);
          const point = TerrainSurfaceAtlas.lerp(a, b, t);
          return { t, level: worldA.terrain.surfaces.sample(point.x, point.y).level };
        })
      };

      const beforeGridChange = uploads.length;
      renderer.ensureFogTextures();
      out.unchangedCacheUploadDelta = uploads.length - beforeGridChange;
      const highSource = sourceAt(1280, 1536, 5);
      renderer.visionGridBySide = gridFor(highSource);
      renderer.visionSourcesBySide = [[highSource], []];
      renderer.ensureFogTextures();
      out.sameTickGrid = {
        uploadDelta: uploads.length - beforeGridChange,
        previousPoint: maskAt(lastMask('level:0'), 1280, 960),
        highPoint: maskAt(lastMask('level:5'), 1280, 1536),
        policy: VisibilityPolicy.sourceCanSeePoint(
          renderer.snapshot, highSource, 1280, 1536, { targetLevel: 5 }
        )
      };

      const worldB = WorldContext.fromMap(mapFor(5, false));
      const beforeWorldChange = uploads.length;
      useWorld(worldB);
      renderer.ensureFogTextures();
      out.sameTickWorld = {
        atlasChanged: worldB.terrain.surfaces !== worldA.terrain.surfaces,
        uploadDelta: uploads.length - beforeWorldChange,
        rampPatches: [...renderer.fogSurfaces.values()].flat()
          .filter(patch => patch.kind === 'ramp').length
      };
      useWorld(WorldContext.fromMap(mapFor(1, false)));
      renderer.ensureFogTextures();
      out.staleTextureCleanup = {
        keys: [...renderer.fogTextures.keys()], deleted: deletedTextures.length
      };

      function uploadMask(texture, width, height, data) {
        return texture ? device.updateTexture(texture,{width,height,data}) : device.createTexture({width,height,data},{format:'luminance',filter:'linear'});
      }

      function readPixel(x, y) {
        const pixel = new Uint8Array(4);
        gl.readPixels(
          Math.floor(x), canvas.height - 1 - Math.floor(y), 1, 1,
          gl.RGBA, gl.UNSIGNED_BYTE, pixel
        );
        return [...pixel];
      }

      // Use the production linked shader and production flushFog uniform setup.
      const width = 41;
      const height = 61;
      const isolatedMask = new Uint8Array(width * height);
      isolatedMask[15 * width + 20] = 255;
      const isolatedTexture = uploadMask(null, width, height, isolatedMask);
      if(renderer.device.active)renderer.device.endFrame(); renderer.device.beginFrame({clearColor:[0, 0, 0, 1]}); Object.assign(renderer.passState,{depthEnabled:false,depthWrite:true,depthFunc:'lequal',stencil:false,colorMask:[true,true,true,true]});
      renderer.fogMaskSize = { w: width, h: height };
      renderer.fogFrame.reset();
      const quad = [
        [0, 0, 0, 0, 0], [410, 0, 0, 1, 0], [410, 610, 0, 1, 1],
        [0, 0, 0, 0, 0], [410, 610, 0, 1, 1], [0, 610, 0, 0, 1]
      ];
      for (const vertex of quad) renderer.fogFrame.push5(...vertex);
      renderer.flushFog(isolatedTexture, [1, 0, 0, 1]);
      out.nonSquareUV = {
        maskSizeUniform: lastMaskSize,
        center: readPixel(205, 152),
        leftNeighbor: readPixel(194, 152),
        lowerNeighbor: readPixel(205, 163)
      };

      // A 24-unit ramp beginning one unit after a mask row recreates the old leak.
      // Render authoritative atlas geometry using the real guest projection and depth.
      canvas.width = 900;
      canvas.height = 1500;
      renderer.role = 'guest';
      useWorld(WorldContext.fromMap(mapFor(1, true, 1281, 24)));
      const shortRamp = renderer.world.terrain.surfaces.ramps[0];
      const guestSource = sourceAt(1280, 1248, 0);
      renderer.visionGridBySide = gridFor(guestSource, 1);
      renderer.visionSourcesBySide = [[], [guestSource]];
      const sampleProgress = 0.9;
      const lowCenter = TerrainSurfaceAtlas.lerp(shortRamp.lowA, shortRamp.lowB, 0.5);
      const highCenter = TerrainSurfaceAtlas.lerp(shortRamp.highA, shortRamp.highB, 0.5);
      const target = TerrainSurfaceAtlas.lerp(lowCenter, highCenter, sampleProgress);
      const targetWorld = {
        x: target.x,
        y: shortRamp.lowElevation + sampleProgress * (
          shortRamp.highElevation - shortRamp.lowElevation
        ),
        z: target.y,
        groundY: 0
      };
      renderer.cameraLeft = renderer.viewX(targetWorld.x) - 450;
      renderer.cameraTop = renderer.viewY(targetWorld.z) - targetWorld.y * 0.6 - 750;
      const projected = renderer.projectRenderWorldPosition(targetWorld);

      function drawTerrain() {
        if(renderer.device.active)renderer.device.endFrame(); renderer.device.beginFrame({clearColor:[0, 0, 0, 1]}); Object.assign(renderer.passState,{depthEnabled:true,depthWrite:true,depthFunc:'lequal',stencil:false,colorMask:[true,true,true,true]});
        renderer.begin();
        // Production atlas vertices carry groundY:0 and their explicit elevation.
        TerrainPresentation.drawSurfaces(renderer);
        renderer.flush();
      }

      drawTerrain();
      const ground = readPixel(projected.x, projected.y);
      renderer.drawFog();
      const fixedLevelFog = readPixel(projected.x, projected.y);
      const maskSize = renderer.fogMaskSize;
      const continuousMask = new Uint8Array(maskSize.w * maskSize.h);
      for (let j = 0; j < maskSize.h; j++) {
        const y = j / (maskSize.h - 1) * renderer.world.height;
        for (let i = 0; i < maskSize.w; i++) {
          const x = i / (maskSize.w - 1) * renderer.world.width;
          continuousMask[j * maskSize.w + i] = renderer.visibleRaw(x, y) ? 255 : 0;
        }
      }
      // Control: substitute the old continuous-level visibility for the high mask.
      uploadMask(
        renderer.fogTextures.get('level:1'), maskSize.w, maskSize.h, continuousMask
      );
      drawTerrain();
      renderer.drawFog();
      const continuousFog = readPixel(projected.x, projected.y);
      out.shortGuestRamp = {
        orientation: renderer.orientationRole(),
        rampRun: shortRamp.run,
        targetLevel: renderer.world.terrain.surfaces.sample(target.x, target.y).level,
        exactVisible: VisibilityPolicy.sourceCanSeePoint(
          renderer.snapshot, guestSource, target.x, target.y
        ),
        lowTexelVisible: renderer.visibleRaw(1280, 1280),
        highTexelVisible: renderer.visibleRaw(1280, 1344),
        ground, fixedLevelFog, continuousFog,
        worldTarget: targetWorld,
        pixel: { x: projected.x, y: projected.y }
      };
      out.glError = gl.getError();
      return out;
    });

    verifyResults(result, pageErrors);
    console.log(JSON.stringify({ ...result, pageErrors, assertions: 'PASS' }, null, 2));
  } finally {
    await browser.close();
  }
}

run().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
