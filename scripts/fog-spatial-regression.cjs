const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Production WebGL coverage with static vision, fractional camera pan, and return.
// Color readback allows one 8-bit quantization step on the unchanged-camera frame.
// QA_NEGATIVE_CONTROL=1 restores the original unjoined presentation tessellation.
(async () => {
  let html = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'index.html'), 'utf8');
  const close = html.lastIndexOf('})();');
  html = html.slice(0, close) + 'window.__spatialQA={GLRenderer,WorldContext,TerrainPresentation,TerrainSurfaceAtlas,MapGeneration,GameRuleDefinition};' + html.slice(close);
  const browser = await chromium.launch({ headless: true, channel: process.env.QA_BROWSER_CHANNEL || 'msedge' });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(html);
    const results = await page.evaluate(negative => {
      const { GLRenderer, WorldContext, TerrainPresentation, TerrainSurfaceAtlas, MapGeneration, GameRuleDefinition } = window.__spatialQA;
      if (negative) TerrainSurfaceAtlas.prototype.presentationSurfaceMesh = function () {
        if(this._negativeMesh)return this._negativeMesh; return this._negativeMesh=(this.renderSurfaceMesh || this.surfaceMesh).flatMap(patch => {
          if (patch.kind !== 'ramp') return [{ ...patch, fogLevel: patch.kind === 'cliff' ? patch.face.highLevel : patch.level }];
          const split = TerrainSurfaceAtlas.splitRampAtLevelTransition(patch);
          return ['low', 'high'].map(side => ({ ...patch, ...split[side], fogLevel: side === 'low' ? patch.lowLevel : patch.highLevel }));
        });
      };
      const results = [];
      const canvas = document.createElement('canvas');
      canvas.width = 900; canvas.height = 1500;
      const r = new GLRenderer(canvas), gl = r.gl;
      function frame() {
        gl.useProgram(r.p); gl.uniform2f(r.r, canvas.width, canvas.height);
        gl.viewport(0, 0, canvas.width, canvas.height); gl.disable(gl.DITHER);
        gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.LEQUAL); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.clearDepth(1); gl.clearColor(.69, .81, .63, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        r.begin(); TerrainPresentation.drawSurfaces(r); r.flush();
        const terrain = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, terrain);
        r.drawFog();
        const fog = new Uint8Array(terrain.length);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, fog);
        let bright = 0; const leaks=[];
        for (let i = 0; i < terrain.length; i += 4) if (fog[i] - (terrain[i] * .12 + .025 * 255 * .88) > 3) {bright++; if(leaks.length<5) leaks.push({x:i/4%900,y:Math.floor(i/4/900),before:terrain[i],after:fog[i]});}
        return { terrain, fog, bright, leaks };
      }
      for (const seed of [1, 8]) {
        r.world = WorldContext.fromMap(MapGeneration.generateMapDescriptor({ rules: GameRuleDefinition.defaults, seed }));
        r.snapshot = { tick: 10, world: r.world, units: [], buildings: [] };
        const atlas = r.world.terrain.surfaces;
        const original = JSON.stringify(atlas.surfaceMesh);
        const start = performance.now(), mesh = atlas.presentationSurfaceMesh(), buildMs = performance.now() - start;
        if (original !== JSON.stringify(atlas.surfaceMesh)) throw new Error('Presentation changed simulation mesh');
        if (!negative && mesh !== atlas.presentationSurfaceMesh()) throw new Error('Atlas geometry was rebuilt');
        const bank = atlas.ramps.filter(p => p.bank).sort((a, b) => Math.hypot((a.lowA.x + a.highB.x) / 2 - r.world.width / 2, (a.lowA.y + a.highB.y) / 2 - r.world.height / 2) - Math.hypot((b.lowA.x + b.highB.x) / 2 - r.world.width / 2, (b.lowA.y + b.highB.y) / 2 - r.world.height / 2))[0];
        const x = (bank.lowA.x + bank.highB.x) / 2, y = (bank.lowA.y + bank.highB.y) / 2;
        for (const role of ['host', 'guest']) {
          r.role = role;
          const baseX = (role === 'guest' ? r.world.width - x : x) - 450;
          const baseY = (role === 'guest' ? r.world.height - y : y) - 750;
          const frames = []; let first; r.cameraLeft=baseX; r.cameraTop=baseY; frame();
          for (const offset of [0, .125, .25, .375, .5, .625, .75, .875, 0]) {
            r.cameraLeft = baseX + offset; r.cameraTop = baseY + offset;
            const current = frame();
            if (!first) first = current;
            let changed = 0, maxDelta = 0;
            if (frames.length === 8) for (let i = 0; i < current.fog.length; i++) {const delta=Math.abs(first.fog[i] - current.fog[i]); maxDelta=Math.max(maxDelta,delta); if(delta>1) changed++;}
            frames.push({ offset, bright: current.bright, leaks: current.leaks, changed, maxDelta });
          }
          const visionFrames=[];
          const raised=atlas.layers.find(layer=>layer.level>0);
          const points=[{...bank.lowA,level:bank.lowLevel},{...bank.highA,level:bank.highLevel},
            {x:raised.points.reduce((sum,p)=>sum+p.x,0)/raised.points.length,y:raised.points.reduce((sum,p)=>sum+p.y,0)/raised.points.length,level:raised.level}];
          for(const point of points){
            const source={...point,r:260,detect:0,air:false,ignoresTerrainVision:false},side=role==='guest'?1:0;
            const grid=[new Map(),new Map()];
            for(let y=0;y<=r.world.height/320;y++)for(let x=0;x<=r.world.width/320;x++)grid[side].set(x+','+y,[source]);
            r.visionGridBySide=grid;r.cameraLeft=baseX;r.cameraTop=baseY;frame();const initial=frame();
            r.cameraLeft=baseX+37.125;r.cameraTop=baseY+29.375;frame();
            r.cameraLeft=baseX;r.cameraTop=baseY;const returned=frame();let maxDelta=0;
            for(let i=0;i<initial.fog.length;i++)maxDelta=Math.max(maxDelta,Math.abs(initial.fog[i]-returned.fog[i]));
            visionFrames.push({level:point.level,maxDelta});
          }
          r.visionGridBySide=[new Map(),new Map()];
          const shared = [...r.fogSurfaces.values()].flat().every(p => mesh.includes(p));
          results.push({ seed, role, buildMs, totalTriangles:r.perfStats.terrainTotalTriangles,visibleTriangles:r.perfStats.terrainVisibleTriangles, frames, visionFrames, shared, levels: [...r.fogSurfaces.keys()], glError: gl.getError() });
        }
      }
      return results;
    }, process.env.QA_NEGATIVE_CONTROL === '1');
    assert.deepEqual(errors, []);
    for (const result of results) {
      assert.equal(result.glError, 0);
      assert.equal(result.shared, true, 'Terrain and Fog share exact patch objects');
      assert.ok(result.levels.includes(-1) && result.levels.includes(0) && result.levels.some(level => level > 0));
      for(const frame of result.visionFrames)assert.ok(frame.maxDelta<=1,'Fixed low/high/ramp visibility survives camera roundtrip');
      for (const frame of result.frames) {
        assert.equal(frame.bright, 0, `seed ${result.seed}, ${result.role}, camera ${frame.offset}: no uncovered bright pixels`);
        assert.equal(frame.changed, 0, 'Returning camera reproduces GPU pixels within one color quantum');
      }
    }
    console.log(JSON.stringify({ status: 'PASS', results }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
