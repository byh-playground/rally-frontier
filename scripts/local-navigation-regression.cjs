const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function run() {
  const root = path.resolve(__dirname, '..');
  let source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  if(process.env.NAV_TILE_SIZE)source=source.replace(/static SIZE=\d+;/, 'static SIZE='+Number(process.env.NAV_TILE_SIZE)+';');
  const end = source.lastIndexOf('})();');
  const html = source.slice(0, end) + 'window.__navQA={WorldContext,TerrainNavigation,NavigationMeshBuilder,NavigationMeshTiles,NavigationGoal,BuildingDefinition,MapGeneration,GameRuleDefinition};' + source.slice(end);
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('http://local-nav.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://local-nav.test/');
    await page.waitForFunction(() => window.__navQA);
    const results = await page.evaluate(() => {
      const { WorldContext, TerrainNavigation, NavigationMeshBuilder, NavigationMeshTiles, NavigationGoal, BuildingDefinition, MapGeneration } = window.__navQA;
      const tileSize=NavigationMeshTiles.SIZE;
      const check = (v, message) => { if (!v) throw Error(message); };
      const state = descriptor => ({ world: WorldContext.fromMap(descriptor), buildings: [], tick: 0, navigationRevision: 0 });
      const descriptor = { width: 3072, height: 4096, terrain: {} };
      const type = Object.keys(BuildingDefinition.all).find(k => !BuildingDefinition.get(k).isTerrainBarrier && BuildingDefinition.get(k).size >= 30);
      const building = (id, x, y) => ({ id: 'building-' + id, type, x, y, hp: 100, alive: true });
      const signature = l => JSON.stringify({ cells: l.cells.map(c => [c.id, c.points, c.component, c.links]), portals: l.portals, nodes: l.fieldNodes });
      const goal = (x, y) => NavigationGoal.point(x, y);
      const results = [];
      for (const radius of [4, 12, 32]) {
        const sim = state(descriptor), nav = new TerrainNavigation(sim);
        let layer = nav.layer(radius), ignored = nav.layer(radius, true);
        const total = layer.tiles.tiles.length;
        const edits = [[building(1, tileSize, tileSize)], [building(1, tileSize*2, tileSize-2), building(2, 800, 900)], [], [building(2, 800, 900), building(1, tileSize, tileSize)]];
        for (const buildings of edits) {
          const retained = layer.tiles.tiles.map(t => t.mesh);
          sim.buildings = buildings; sim.tick++; sim.navigationRevision++; nav.sync();
          check(nav.layers.get(layer.r + ':false') === layer, 'sync is lazy and preserves the layer');
          layer = nav.layer(radius);
          const fresh = new TerrainNavigation({ ...sim, buildings: [...buildings].reverse() });
          const clean = fresh.layer(radius);
          check(signature(layer) === signature(clean), 'Incremental geometry/graph must equal clean rebuild independent of building order');
          const project = p => p && {path:p.path,length:p.length,start:p.start.point,goal:p.goal.point};
          const route=nav.plan(200, 300, goal(1700, 1300), radius);
          check(JSON.stringify(project(route)) === JSON.stringify(project(fresh.plan(200, 300, goal(1700, 1300), radius))), 'Warm and cold paths must match');
          check(route.path.every((p,i)=>!i||nav.segmentClear(route.path[i-1].x,route.path[i-1].y,p.x,p.y,radius)), 'Every funnel segment respects physical obstacles');
          check(layer.rebuiltTiles < total, 'A local edit cannot rebuild every tile');
          check(layer.tiles.tiles.some((t, i) => t.mesh === retained[i]), 'Unaffected geometry must retain identity');
          check(nav.layer(radius, true) === ignored, 'Ordinary buildings must not invalidate burrow layer');
        }
        results.push({ radius, tiles: total, rebuiltTiles: layer.rebuiltTiles, cells: layer.cells.length });
      }
      const sim = state(descriptor), nav = new TerrainNavigation(sim);
      // A complete vertical wall with one opening. Closing/opening it must update distant reachability.
      sim.buildings = Array.from({ length: 55 }, (_, i) => building(i + 10, 1536, i * 80));
      const middle = sim.buildings.find(b => b.y === 2000);
      check(middle, 'wall gap fixture');
      sim.buildings = sim.buildings.filter(b => b !== middle);
      let layer = nav.layer(12), start = nav.locate(300, 2000, layer), target = nav.locate(2800, 2000, layer);
      check(start.cell.component === target.cell.component, 'Gap connects both distant halves');
      sim.buildings.push(middle); sim.navigationRevision++;
      layer = nav.layer(12); start = nav.locate(300, 2000, layer); target = nav.locate(2800, 2000, layer);
      check(start.cell.component !== target.cell.component, 'Closing local gap disconnects distant halves');
      sim.buildings = sim.buildings.filter(b => b !== middle); sim.navigationRevision++;
      layer = nav.layer(12); start = nav.locate(300, 2000, layer); target = nav.locate(2800, 2000, layer);
      check(start.cell.component === target.cell.component, 'Reopening reconnects distant halves');
      results.push({ distantChokepoint: 'closed and reopened', rebuiltTiles: layer.rebuiltTiles });
      const narrow = state(descriptor), narrowNav = new TerrainNavigation(narrow);
      const spacing=nav.circles[0].r+20;
      narrow.buildings=Array.from({length:Math.ceil(4096/spacing)+1},(_,i)=>building(i,tileSize,i*spacing)).filter((b,i)=>i!==25);
      const connectedAt=r=>{const l=narrowNav.layer(r);return narrowNav.locate(tileSize-300,1500,l).cell.component===narrowNav.locate(tileSize+500,1500,l).cell.component};
      check(connectedAt(4)&&!connectedAt(32),'A narrow passage at a tile seam admits only the smaller collision radius');
      results.push({narrowPassage:'radius 4 passes; radius 32 blocked'});
      const barrierType = Object.keys(BuildingDefinition.all).find(k => BuildingDefinition.get(k).isTerrainBarrier);
      check(barrierType, 'terrain barrier definition exists');
      const burrow = nav.layer(12, true);
      sim.buildings.push({ ...building('barrier', 512, 512), type: barrierType }); sim.navigationRevision++;
      check(nav.layer(12, true) !== burrow, 'Burrow layer must update terrain barriers');
      // Same IDs, changed obstacle sizes, and rewound tick/revision emulate snapshot restore.
      const restore = state(descriptor), restoreNav = new TerrainNavigation(restore);
      restore.buildings = [building(1, 512, 512)]; restoreNav.layer(12);
      restore.tick = 15; restore.navigationRevision = 20;
      restore.buildings = [{ ...building(1, 1024, 1024), type: barrierType }]; restoreNav.layer(12);
      restore.tick = 0; restore.navigationRevision = 0;
      restore.buildings = [building(1, 512, 512)];
      check(signature(restoreNav.layer(12)) === signature(new TerrainNavigation(restore).layer(12)), 'Rewound restored topology equals a cold snapshot load');
      results.push({ ignoredTerrainBarrier: 'updated', rewindRestore: 'canonical' });
      for (const seed of [17, 718]) {
        const generated = state(MapGeneration.generateMapDescriptor({ seed })), gn = new TerrainNavigation(generated);
        const at = performance.now(); let mesh = gn.layer(12); const initialMs = performance.now() - at;
        const samples = [];
        for (let i = 0; i < 5; i++) {
          generated.buildings.push(building(i + 1, 700 + i * 180, 650)); generated.navigationRevision++;
          const changeAt = performance.now(); mesh = gn.layer(12); const localMs = performance.now() - changeAt;
          const cold = new TerrainNavigation(generated);
          check(signature(mesh) === signature(cold.layer(12)), 'Generated terrain incremental geometry matches cold rebuild');
          samples.push({ localMs, geometryMs: mesh.geometryMs, connectMs: mesh.connectMs, rebuiltTiles: mesh.rebuiltTiles });
        }
        results.push({ seed, initialMs, cells: mesh.cells.length, samples });
        if(seed===17){
          const connect = NavigationMeshBuilder.connect, timings = { cached: [], uncached: [] };
          const expectedGraph=signature(mesh);
          for(let i=0;i<20;i++)for(const mode of i%2?['cached','uncached']:['uncached','cached']){
            NavigationMeshBuilder.connect = mode==='cached'?connect:function(cells,portals,slabs){for(const c of cells)c.graphCache=null;return connect.call(this,cells,portals,slabs)};
            mesh.tiles.dirty.add(0);mesh=gn.layer(12);timings[mode].push(mesh.connectMs);
            if(i===0)check(signature(mesh)===expectedGraph,'Cached and uncached graph assembly must be exactly equal');
          }
          NavigationMeshBuilder.connect=connect;
          results.push({cacheComparison:Object.fromEntries(Object.entries(timings).map(([k,v])=>[k,v.sort((a,b)=>a-b)[10]]))});
        }
      }
      // Comparison uses exactly the same inflated polygons and obstacle geometry.
      const bench = state({ width: 3072, height: 4096, terrain: { blockers: Array.from({ length: 70 }, (_, i) => ({ id: 'wall' + i, points: [{ x: 150 + i % 7 * 400, y: 150 + Math.floor(i / 7) * 370 }, { x: 280 + i % 7 * 400, y: 150 + Math.floor(i / 7) * 370 }, { x: 280 + i % 7 * 400, y: 200 + Math.floor(i / 7) * 370 }, { x: 150 + i % 7 * 400, y: 200 + Math.floor(i / 7) * 370 }] })) } });
      const bn = new TerrainNavigation(bench), samples = [];
      const initialAt = performance.now(); let bl = bn.layer(12); const initialMs = performance.now() - initialAt;
      for (let i = 0; i < 5; i++) {
        bench.buildings.push(building(i + 1, 700 + i * 180, 650)); bench.navigationRevision++;
        const at = performance.now(); bl = bn.layer(12); const localMs = performance.now() - at;
        const polygons = bn.staticOffsets.get(bl.r).concat(bn.circles.map(b => NavigationMeshBuilder.circle(b.r + bl.r + .25).map(p => ({ x: p.x + b.x, y: p.y + b.y }))));
        const fullAt = performance.now(); const full = NavigationMeshBuilder.build(bench.world.width, bench.world.height, bl.r, polygons, bench.world.terrain.surfaces); const fullMs = performance.now() - fullAt;
        samples.push({ localMs, fullMs, geometryMs: bl.geometryMs, connectMs: bl.connectMs, rebuiltTiles: bl.rebuiltTiles, localCells: bl.cells.length, fullCells: full.cells.length });
      }
      results.push({ initialMs, performance: samples });
      return results;
    });
    console.log(JSON.stringify(results, null, 2));
    assert.ok(results.length >= 5);
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
