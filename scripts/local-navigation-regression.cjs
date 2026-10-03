const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function run() {
  const root = path.resolve(__dirname, '..');
  let source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  if(process.env.NAV_TILE_SIZE)source=source.replace(/static SIZE=\d+;/, 'static SIZE='+Number(process.env.NAV_TILE_SIZE)+';');
  const end = source.lastIndexOf('})();');
  const html = source.slice(0, end) + 'window.__navQA={WorldContext,TerrainNavigation,NavigationMeshBuilder,NavigationMeshTiles,NavigationGoal,BuildingDefinition,MapGeneration,GameRuleDefinition,StrategySim,RallyStateCodec};' + source.slice(end);
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('http://local-nav.test/**', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://local-nav.test/');
    await page.waitForFunction(() => window.__navQA);
    const results = await page.evaluate(() => {
      const { WorldContext, TerrainNavigation, NavigationMeshBuilder, NavigationMeshTiles, NavigationGoal, BuildingDefinition, MapGeneration, GameRuleDefinition, StrategySim, RallyStateCodec } = window.__navQA;
      const tileSize=NavigationMeshTiles.SIZE;
      const check = (v, message) => { if (!v) throw Error(message); };
      const state = descriptor => ({ world: WorldContext.fromMap(descriptor), buildings: [], tick: 0, navigationRevision: 0 });
      const descriptor = { width: 3072, height: 4096, terrain: {} };
      const type = Object.keys(BuildingDefinition.all).find(k => !BuildingDefinition.get(k).isTerrainBarrier && BuildingDefinition.get(k).size >= 30);
      const building = (id, x, y) => ({ id: 'building-' + id, type, x, y, hp: 100, alive: true });
      const ck=c=>[c.tile,c.local],pk=p=>[p.kind,p.owner,p.direction,p.local],nk=n=>[...pk(n.order),n.sample];
      const cmp=(a,b)=>{for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]-b[i];return 0};
      const signature = l => JSON.stringify({
        cells:l.cells.filter(Boolean).sort((a,b)=>cmp(ck(a),ck(b))).map(c=>[ck(c),c.points,c.component,c.links.map(x=>[ck(l.cells[x.to]),pk(l.portals[x.portal])])]),
        portals:l.portals.filter(Boolean).sort((a,b)=>cmp(pk(a),pk(b))).map(p=>[pk(p),ck(l.cells[p.a]),ck(l.cells[p.b]),p.p,p.q]),
        nodes:l.fieldNodes.filter(Boolean).sort((a,b)=>cmp(nk(a),nk(b))).map(n=>[nk(n),n.x,n.y,n.links.map(x=>[nk(l.fieldNodes[x.to]),ck(l.cells[x.via]),x.cost])])
      });
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
      const burrow = nav.layer(12, true),burrowSignature=signature(burrow);
      sim.buildings.push({ ...building('barrier', 512, 512), type: barrierType }); sim.navigationRevision++;
      check(signature(nav.layer(12, true)) !== burrowSignature, 'Burrow layer must update terrain barriers');
      // Same IDs, changed obstacle sizes, and rewound tick/revision emulate snapshot restore.
      const restore = state(descriptor), restoreNav = new TerrainNavigation(restore);
      restore.buildings = [building(1, 512, 512)]; restoreNav.layer(12);
      restore.tick = 15; restore.navigationRevision = 20;
      restore.buildings = [{ ...building(1, 1024, 1024), type: barrierType }]; restoreNav.layer(12);
      restore.tick = 0; restore.navigationRevision = 0;
      restore.buildings = [building(1, 512, 512)];
      check(signature(restoreNav.layer(12)) === signature(new TerrainNavigation(restore).layer(12)), 'Rewound restored topology equals a cold snapshot load');
      results.push({ ignoredTerrainBarrier: 'updated', rewindRestore: 'canonical' });
      const churn=state(descriptor),churnNav=new TerrainNavigation(churn),churnLayer=churnNav.layer(12),farTile=churnLayer.tiles.tiles.at(-1);
      const distantCells=farTile.cells.slice(),distantIndex=farTile.index,distantPortals=[...new Set(farTile.cells.flatMap(c=>c.links.map(link=>churnLayer.portals[link.portal])))];
      const distantNodes=distantPortals.flatMap(p=>p.nodes.map(id=>churnLayer.fieldNodes[id]));
      const distantLinks=distantNodes.map(n=>({array:n.links,edges:n.links.slice()}));
      let capacity=null;
      const originalConnect=NavigationMeshBuilder.connect;
      NavigationMeshBuilder.connect=()=>{throw Error('Incremental update called the global graph builder')};
      for(let cycle=0;cycle<48;cycle++){
        churn.buildings=cycle%2?[]:[building('churn-'+cycle,500,500)];churn.navigationRevision++;
        check(churnNav.layer(12)===churnLayer,'Layer identity persists during topology changes');
        check(farTile.index===distantIndex&&farTile.cells.every((c,i)=>c===distantCells[i]),'Distant cell/index identities persist');
        for(const p of distantPortals)check(churnLayer.portals[p.id]===p,'Distant portal ID and object persist');
        distantNodes.forEach((n,i)=>check(churnLayer.fieldNodes[n.id]===n&&n.links===distantLinks[i].array&&n.links.length===distantLinks[i].edges.length&&n.links.every((e,j)=>e===distantLinks[i].edges[j]),'Distant node, link array, and edge identities persist'));
        const pools=[churnLayer.tiles.cellSlots,churnLayer.tiles.portalSlots,churnLayer.tiles.nodeSlots];
        if(cycle===1)capacity=pools.map(p=>p.items.length);
        if(cycle>1)check(pools.every((p,i)=>p.items.length===capacity[i]&&p.free.length+p.count===p.items.length),'Repeated add/remove must reuse bounded slots without growing holes/free lists');
        for(const c of churnLayer.cells.filter(Boolean))for(const link of c.links){const p=churnLayer.portals[link.portal],other=churnLayer.cells[link.to];check(p&&other&&other.links.some(back=>back.to===c.id&&back.portal===p.id),'No stale or one-sided cell link after slot reuse')}
        for(const n of churnLayer.fieldNodes.filter(Boolean))for(const edge of n.links){const other=churnLayer.fieldNodes[edge.to];check(other&&churnLayer.cells[edge.via]&&other.links.some(back=>back.to===n.id&&back.via===edge.via&&back.cost===edge.cost),'No stale or one-sided field edge after slot reuse')}
        if(cycle%12===11)check(signature(churnLayer)===signature(new TerrainNavigation(churn).layer(12)),'Churn graph equals cold graph');
      }
      NavigationMeshBuilder.connect=originalConnect;
      results.push({churnCycles:48,slotCapacities:capacity,preservedNodes:distantNodes.length,lastGraphChanges:churnLayer.graphChanges});
      const draft={decks:{host:['swarmbug'],guest:['swarmbug']},defenseCards:{host:[],guest:[]}},rules=GameRuleDefinition.resolve({overrides:{map:{generator:'fixed-standard'}}});
      const gameA=new StrategySim(draft,831047,rules),gameB=new StrategySim(draft,831047,rules);
      gameA.buildings.push(building('temporary',1024,1024));gameA.navigationRevision++;
      for(const radius of [gameA.unitRadius('worker')+.12,12,32])gameA.navigation.layer(radius);
      gameA.buildings.pop();gameA.navigationRevision++;
      for(const radius of [gameA.unitRadius('worker')+.12,12,32])gameA.navigation.layer(radius);
      for(let tick=0;tick<160;tick++){
        if(tick%13===0)for(const game of [gameA,gameB])game.queueCommand({tick:game.tick+1,seq:tick+1,actor:'host',action:{type:'SET_FLAG',x:700+tick*5,y:3300-tick*7,forced:true}});
        if(tick%37===0)gameB.navigation=new TerrainNavigation(gameB);
        gameA.step();gameB.step();
        if(tick%10===0){const a=RallyStateCodec.encode(gameA.exportState()),b=RallyStateCodec.encode(gameB.exportState());check(a.length===b.length&&a.every((v,i)=>v===b[i]),'Warm slot history versus cold cache must preserve actual authoritative game bytes')}
      }
      gameA.dispose('qa-finished');gameB.dispose('qa-finished');results.push({authoritativeWarmColdTicks:160});
      const projectionMaps=[descriptor,{width:3072,height:4096,terrain:{layers:[{id:'pit',level:-1,points:[{x:1024,y:1024},{x:2048,y:1024},{x:2048,y:2048},{x:1024,y:2048}]}],ramps:[{id:'ramp',layerId:'pit',edge:0,t0:.125,t1:.375,run:128}]}}];
      let projectionCases=0;
      const position=p=>p&&{point:p.point,d2:p.d2,cell:ck(p.cell)};
      for(const map of projectionMaps)for(const radius of [4,9.5,12,32])for(const point of [{x:500,y:500},{x:1024,y:1024},{x:1280,y:1010},{x:radius+.1,y:100},{x:3072-radius-.1,y:4096-radius-.1}]){
        const localState=state(map),oracleState=state(map),local=new TerrainNavigation(localState),oracle=new TerrainNavigation(oracleState);
        oracle.nearestExterior=function(x,y,r,ignore){return this.locate(x,y,this.layer(r,ignore),null,{radius:r})};
        const center=building(1,point.x,point.y),overlap=building(2,point.x+20,point.y+10);
        const phases=[[center],[center,overlap],[{...center,x:point.x+35,y:point.y+40,type:barrierType}],[],[center]];
        for(const [phase,buildings]of phases.entries()){
          localState.buildings=buildings;oracleState.buildings=buildings;localState.navigationRevision=oracleState.navigationRevision=phase===4?0:phase+1;localState.tick=oracleState.tick=phase===4?0:phase+1;
          for(const ignore of [false,true]){
            const actual=local.nearestExterior(point.x,point.y,radius,ignore),expected=oracle.nearestExterior(point.x,point.y,radius,ignore);
            check(JSON.stringify(position(actual))===JSON.stringify(position(expected)),'Local nearest-exterior projection equals full tiled graph oracle');
            const actualMotion=local.motion.recover(point.x,point.y,radius,ignore?'*':null),expectedMotion=oracle.motion.recover(point.x,point.y,radius,ignore?'*':null);
            check(JSON.stringify(actualMotion)===JSON.stringify(expectedMotion),'Overlap recovery final fixed-point position equals full graph oracle');projectionCases++;
          }
        }
        check(local.layers.size===0&&local.metrics.layersBuilt===0&&local.metrics.fieldsBuilt===0,'Projection must never allocate a world graph or field');
      }
      const projectionState=state(MapGeneration.generateMapDescriptor({seed:17})),projectionNav=new TerrainNavigation(projectionState);
      let coldPoint=null;for(let y=128;y<900&&!coldPoint;y+=96)for(let x=128;x<900;x+=96)if(projectionNav.geometry.circleClear(x,y,9.5)){coldPoint={x,y};break}
      check(coldPoint,'Generated map has a local clear overlap fixture');
      projectionState.buildings=[building('cold',coldPoint.x,coldPoint.y)];projectionNav.sync();
      const coldAt=performance.now();projectionNav.motion.recover(coldPoint.x,coldPoint.y,9.5,null);const coldMs=performance.now()-coldAt;
      check(projectionNav.metrics.projectionTilesBuilt>0&&projectionNav.metrics.projectionTilesBuilt<projectionNav.projections.values().next().value.tiles.length,'Cold overlap recovery builds only the queried local tiles');
      check(projectionNav.layers.size===0&&projectionNav.staticOffsets.size===0,'Cold projection does not inflate static terrain globally or create graph layers');
      results.push({projectionCases,coldProjectionMs:coldMs,coldProjectionTiles:projectionNav.metrics.projectionTilesBuilt,worldGraphs:projectionNav.layers.size});
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
