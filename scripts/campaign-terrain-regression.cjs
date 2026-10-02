const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.qa/campaign-terrain');
// Gameplay projection of the catalog before the authored terrain upgrade (PR21).
// Spatial placement and prose may change; troop counts, trigger radii, waves and victory do not.
const gameplayDigest = '826c64b12996b93e4af431d2bad7bd2f8ec10436ff0ec0e98752882c1f515720';
function gameplayFingerprint(manifest) {
  const omitted = new Set(['terrain', 'lanes', 'spawns', 'position', 'offset', 'center',
    'title', 'briefing', 'presentation', 'label', 'text']);
  const project = value => Array.isArray(value) ? value.map(project)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().filter(key => !omitted.has(key)).map(key => [key, project(value[key])]))
      : value;
  return createHash('sha256').update(JSON.stringify(project(manifest))).digest('hex');
}

async function run() {
  fs.mkdirSync(output, { recursive: true });
  const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const end = source.lastIndexOf('})();');
  assert.ok(end >= 0);
  const html = source.slice(0, end) + `window.__terrainQA={CampaignBuiltinCatalog,CampaignMissionDefinition,
    CampaignMapDefinition,WorldContext,StrategySim,GameRuleDefinition,InteractionGeometry,NavigationGoal,
    TerrainNavigation,UnitDefinition,BuildingDefinition,TerrainPresentation,DraftPresentation,UiController,
    UiRegistry,ActiveViewState,MatchLifecycle,CAPTURE_RADIUS,ECONOMY_WORKER_TYPE};` + source.slice(end);
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (name === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return; }
    const file = path.resolve(root, `.${name}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const result = { integration: [], ui: [], pageErrors: [] };
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1400 } });
    page.on('pageerror', error => result.pageErrors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(url); await page.waitForFunction(() => window.__terrainQA);
    const manifest = await page.evaluate(() => window.__terrainQA.CampaignBuiltinCatalog.manifest());
    assert.equal(gameplayFingerprint(manifest), gameplayDigest, 'Terrain edits preserve non-spatial mission rules and every trigger radius');
    result.integration = await page.evaluate(manifest => {
      const q = window.__terrainQA;
      const check = (condition, message) => { if (!condition) throw Error(message); };
      const missions = manifest.campaigns.flatMap(c => c.missions);
      q.maps = [];
      return missions.map((entry, index) => {
        let sim;
        try {
          const mission = q.CampaignMissionDefinition.normalize(entry.mission);
          const descriptor = q.CampaignMapDefinition.build(mission.map, q.GameRuleDefinition.current, mission.seed, 0);
          check(q.WorldContext.fromMap(descriptor).width === descriptor.width, 'Authored WorldContext uses campaign dimensions');
          sim = new q.StrategySim({ decks: { host: mission.player.availableUnits, guest: mission.enemy.availableUnits }, defenseCards: { host: [], guest: [] } }, mission.seed, q.GameRuleDefinition.current, mission);
          sim.applyCampaignScenario(mission);
          const nav = q.TerrainNavigation.forState(sim), terrain = sim.world.terrain, atlas = terrain.surfaces;
          const evidence = { id: entry.id, layers: descriptor.terrain.layers.length, ramps: atlas.ramps.length,
            bridges: [], groundSpawns: 0, structures: 0, resources: [], buildPads: [], routes: [], flatRegions: [] };
          const route = (from, goal, type, label) => {
            const distance = nav.distance(from.x, from.y, goal, type);
            check(Number.isFinite(distance), `${label}: ${type} cannot reach (${goal.x},${goal.y})`);
            check(distance < Math.hypot(descriptor.width, descriptor.height) * 4, `${label}: excessive detour ${distance}`);
            evidence.routes.push({ label, type, distance: Math.round(distance), direct: Math.round(Math.hypot(from.x - goal.x, from.y - goal.y)) });
            return distance;
          };
          // Spawn the real authored delayed formations without running their timers or changing counts.
          for (const camp of sim.camps) if (!sim.units.some(u => (u.campId || u.scenarioGroupId) === camp.id)) sim.spawnCamp(camp);
          for (const event of mission.events) for (const action of event.actions)
            if (action.type === 'spawnGroup') sim.campaignScriptRuntime.runAction(action);
          for (const unit of sim.units) if (q.UnitDefinition.get(unit.type)?.layer !== 'AIR') {
            check(terrain.circleClear(unit.x, unit.y, sim.unitRadius(unit.type)), `${unit.type}/${unit.campId || unit.scenarioGroupId || unit.side}: actual formation spawn intersects cliff`);
            evidence.groundSpawns++;
          }
          for (const building of sim.buildings) {
            const radius = q.BuildingDefinition.get(building.type).size + 2;
            check(terrain.circleClear(building.x, building.y, radius) && atlas.buildable(building.x, building.y, radius), `${building.id}: actual building footprint is not buildable`);
            evidence.structures++;
          }
          const workers = sim.units.filter(u => q.UnitDefinition.get(u.type)?.economyWorker);
          const nearestWorker = node => workers.slice().sort((a, b) => Math.hypot(a.x-node.x,a.y-node.y)-Math.hypot(b.x-node.x,b.y-node.y))[0];
          const returnFromInteraction = (worker,goal,label) => {
            const direct=nav.directGoal(worker.x,worker.y,goal,sim.unitRadius(worker.type));
            const terminal=direct||nav.plan(worker.x,worker.y,goal,sim.unitRadius(worker.type)+.12)?.goal.point;
            check(terminal,`${label}: no legal interaction terminal`);
            check(nav.acceptsGoalPoint(goal,terminal.x,terminal.y),`${label}: terminal does not satisfy the actual interaction goal`);
            route(terminal,q.InteractionGeometry.goal(worker,sim.base(worker.side),'worker-dropoff'),worker.type,`${label} return/dropoff`);
          };
          for (const node of sim.resources) {
            const worker = nearestWorker(node);
            check(worker, 'Campaign has workers for mining');
            const goal = q.InteractionGeometry.goal(worker, node, 'worker-mineral');
            const distance = route(worker, goal, worker.type, `mineral ${node.id}`);
            returnFromInteraction(worker,goal,`mineral ${node.id}`);
            evidence.resources.push({ kind: 'mineral', id: node.id, x: node.x, y: node.y, distance: Math.round(distance) });
          }
          for (const node of sim.gasNodes) {
            const worker = nearestWorker(node), target = { ...node, type: q.BuildingDefinition.forRole('gasExtractor') };
            check(atlas.buildable(node.x, node.y, q.BuildingDefinition.get(target.type).size + 2), `${node.id}: gas extractor footprint on a slope at (${node.x},${node.y}), surface ${atlas.sample(node.x,node.y).id}`);
            const gasGoal=q.InteractionGeometry.goal(worker,target,'worker-gas');
            const distance = route(worker, gasGoal, worker.type, `gas ${node.id}`);
            returnFromInteraction(worker,gasGoal,`gas ${node.id}`);
            route(worker, q.InteractionGeometry.goal(worker, target, 'worker-build'), worker.type, `gas construction ${node.id}`);
            evidence.resources.push({ kind: 'gas', id: node.id, x: node.x, y: node.y, distance: Math.round(distance) });
          }
          for (const side of [0, 1]) {
            const base = sim.base(side), worker = workers.find(u => u.side === side);
            route(worker, q.InteractionGeometry.goal(worker, base, 'worker-dropoff'), worker.type, `side ${side} dropoff`);
            for (const type of ['supply', 'barracks', 'academy']) {
              let pad;
              for (const radius of [230, 330, 440, 560]) {
                for (let i = 0; i < 24 && !pad; i++) {
                  const angle = i * Math.PI / 12, x = base.x + Math.cos(angle)*radius, y = base.y + Math.sin(angle)*radius;
                  if (!sim.pointClearForBuildingSetup(type, x, y)) continue;
                  const target = { x, y, type, side }, goal = q.InteractionGeometry.goal(worker, target, 'worker-build');
                  const distance = nav.distance(worker.x, worker.y, goal, worker.type);
                  if (Number.isFinite(distance)) pad = { type, side, x: Math.round(x), y: Math.round(y), distance: Math.round(distance) };
                }
                if (pad) break;
              }
              check(pad, `${entry.id} side ${side}: no reachable buildable ${type} pad within 560 of base`);
              evidence.buildPads.push(pad);
            }
          }
          const troop = sim.units.find(u => u.side === 0 && !q.UnitDefinition.get(u.type)?.economyWorker && q.UnitDefinition.get(u.type)?.layer !== 'AIR');
          check(troop, 'Real starting army exists');
          const types = [...new Set([troop.type, 'swordsman', 'pikeman', 'skirmisher', 'medic',
            ...mission.player.availableUnits, ...mission.enemy.availableUnits,
            ...sim.camps.flatMap(c=>c.composition.map(item=>item.unit))])].filter(type=>q.UnitDefinition.get(type)?.layer!=='AIR');
          evidence.radii=types.map(type=>({type,radius:sim.unitRadius(type)}));
          const widest=types.slice().sort((a,b)=>sim.unitRadius(b)-sim.unitRadius(a))[0];
          for(const [lane,points] of Object.entries(descriptor.laneControlPoints)) {
            let from=troop;
            for(let i=1;i<points.length-1;i++) {
              const point=points[i];
              check(terrain.circleClear(point.x,point.y,sim.unitRadius(widest)),`${lane} waypoint ${i} lies in an exposed cliff/blocker`);
              const distance=route(from,q.NavigationGoal.point(point.x,point.y,false),widest,`${lane} waypoint ${i}`);
              const direct=Math.hypot(from.x-point.x,from.y-point.y);
              check(distance<=direct*3+200,`${lane} waypoint ${i}: authored lane conceals a large navigation detour`);
              from=point;
            }
          }
          const requiredRegions = new Set();
          const collect = condition => { if (!condition) return; if (['enterRegion','unitsInRegion'].includes(condition.type) && typeof condition.region === 'string') requiredRegions.add(condition.region); for (const item of condition.all || condition.any || []) collect(item); if (condition.not) collect(condition.not); };
          for (const event of mission.events) collect(event.when);
          const flatDisk = (id, x, y, radius) => {
            const height = atlas.heightAt(x, y);
            check(atlas.buildable(x,y,radius),`${id}: XY trigger disk overlaps a sloped surface`);
            for (const fraction of [.25, .5, .75, 1]) for (let i=0;i<48;i++) {
              const a=i*Math.PI/24, px=x+Math.cos(a)*radius*fraction, py=y+Math.sin(a)*radius*fraction;
              check(Math.abs(atlas.heightAt(px,py)-height) < .01, `${id}: XY trigger reaches an adjacent layer/slope at (${Math.round(px)},${Math.round(py)})`);
            }
            evidence.flatRegions.push({ id, radius: Math.round(radius), height });
          };
          for (const [id, region] of Object.entries(mission.regions)) {
            const x=region.center[0]*descriptor.width,y=region.center[1]*descriptor.height,radius=region.radius*Math.min(descriptor.width,descriptor.height);
            for (const type of types) route(troop, q.NavigationGoal.range(x,y,radius), type, `region ${id}`);
            if (requiredRegions.has(id)) flatDisk(id,x,y,radius);
          }
          for (const point of sim.capturePoints) {
            const radius=q.BuildingDefinition.get(q.BuildingDefinition.forRole('outpost')).size+2;
            check(terrain.circleClear(point.x,point.y,radius)&&atlas.buildable(point.x,point.y,radius), `${point.id}: capture outpost pad is not buildable`);
            flatDisk(`capture ${point.id}`,point.x,point.y,q.CAPTURE_RADIUS);
            for (const type of types) route(troop,q.NavigationGoal.point(point.x,point.y,false),type,`capture ${point.id}`);
          }
          for (const type of types) route(troop,q.InteractionGeometry.goal({type,side:0},sim.base(1),'attack',q.UnitDefinition.get(type).range),type,'enemy base attack');
          for (const camp of sim.camps.filter(c=>c.side===1)) for (const type of [...new Set(camp.composition.map(c=>c.unit))]) {
            if(q.UnitDefinition.get(type)?.layer==='AIR')continue;
            const from=sim.units.find(u=>(u.campId||u.scenarioGroupId)===camp.id&&u.type===type)||camp;
            route(from,q.InteractionGeometry.goal({type,side:1},sim.base(0),'attack',q.UnitDefinition.get(type).range),type,`wave ${camp.id} to player base`);
          }
          if(index===0)check(descriptor.terrain.layers.length===0&&!descriptor.terrain.riverPath.length,'Mission 1 keeps an open road without forced heights/river');
          if(index===3||index===6) {
            check(descriptor.terrain.layers.some(l=>l.level===-1&&l.innerPoints?.length>=3),'River has an actual negative floor and continuous banks');
            check(atlas.ramps.some(r=>r.bank),'Signed river derives continuous bank planes');
            check(atlas.bridges.length>0,'River has a level-zero bridge');
          }
          for (const bridge of atlas.bridges) {
            const dx=Math.cos(bridge.angle),dy=Math.sin(bridge.angle);
            for(const sign of [-1,1])for(const fraction of [-1,-.5,0,.5,1]) {
              const x=bridge.x+dx*bridge.halfLength*sign-dy*bridge.halfWidth*fraction;
              const y=bridge.y+dy*bridge.halfLength*sign+dx*bridge.halfWidth*fraction;
              check(Math.abs(atlas.sampleTerrain(x,y).elevation)<.01,`${bridge.id}: full-width endcap lacks level-zero land support`);
            }
            const a={x:bridge.x-dx*(bridge.halfLength+20),y:bridge.y-dy*(bridge.halfLength+20)};
            const b={x:bridge.x+dx*(bridge.halfLength+20),y:bridge.y+dy*(bridge.halfLength+20)};
            for(const type of types) {
              const radius=sim.unitRadius(type);
              check(nav.segmentClear(a.x,a.y,b.x,b.y,radius)&&nav.segmentClear(b.x,b.y,a.x,a.y,radius),`${bridge.id}: bridge too narrow or obstructed for ${type}`);
            }
            const lateral={x:bridge.x-dy*(bridge.halfWidth+40),y:bridge.y+dx*(bridge.halfWidth+40)};
            check(!nav.segmentClear(bridge.x,bridge.y,lateral.x,lateral.y,sim.unitRadius(troop.type)),`${bridge.id}: bridge permits crossing the exposed lateral cliff`);
            const contact=nav.motion.solve(bridge.x,bridge.y,lateral.x,lateral.y,sim.unitRadius(troop.type),null,'project',bridge.id);
            check(contact.hit,`${bridge.id}: SurfaceMotion misses the exposed lateral contact`);
            evidence.bridges.push({id:bridge.id,halfWidth:bridge.halfWidth,endcaps:a.x+','+a.y+' → '+b.x+','+b.y,lateralContact:true});
          }
          q.maps.push(descriptor);
          return { status:'PASS', ...evidence };
        } catch(error) { q.maps.push(sim?.mapDescriptor||null); return { id:entry.id,status:'FAIL',error:error.message }; }
        finally { sim?.dispose('terrain-regression'); }
      });
    },manifest);
    fs.writeFileSync(path.join(output,'integration.json'),JSON.stringify(result.integration,null,2));
    console.log(JSON.stringify(result.integration.map(m=>({id:m.id,status:m.status,error:m.error,routes:m.routes?.length,spawns:m.groundSpawns})),null,2));
    assert.ok(result.integration.every(m=>m.status==='PASS'),'Campaign terrain integration failed; see integration.json');
    // Actual production draft renderer, with a larger QA layout for readable whole-map artifacts.
    for(let index=0;index<7;index++) {
      const image=await page.evaluate(index=>{
        const q=window.__terrainQA;q.UiController.setUiScreen('finale');q.DraftPresentation.setDraftCountdownValue(3,'캠페인 지형 검증');
        const card=document.querySelector('.draft-countdown-card');card.style.height='1250px';card.style.maxHeight='none';card.style.width='1100px';
        const canvas=q.UiRegistry.refs.draftMapPreviewCanvas;
        q.DraftPresentation.drawDraftMapPreview(q.maps[index]);
        return {url:canvas.toDataURL('image/png'),width:canvas.width,height:canvas.height};
      },index);
      assert.ok(image.width>=500&&image.height>=600,'Whole campaign map is readable');
      fs.writeFileSync(path.join(output,`mission-${index+1}-map.png`),Buffer.from(image.url.split(',')[1],'base64'));
    }
    await page.close();
    if(process.env.QA_TERRAIN_UI!=='0') {
      const selected=process.env.QA_TERRAIN_MISSIONS?.split(',').map(Number);
      for(const [index,entry] of manifest.campaigns.flatMap(c=>c.missions).entries()) {
        if(selected&&!selected.includes(index+1))continue;
        const ui=await browser.newPage({viewport:{width:1280,height:900}});
        ui.on('pageerror',error=>result.pageErrors.push(error.message));ui.on('dialog',dialog=>dialog.accept());
        await ui.goto(url);await ui.locator('#gameStartBtn').click();await ui.locator('#campaignBtn').click();
        await ui.locator(`[data-mission-id="${entry.id}"]`).click();await ui.locator('#campaignStartBtn').click();
        await ui.waitForFunction(()=>window.__terrainQA.ActiveViewState.snap?.tick>20,null,{timeout:30000});
        const live=await ui.evaluate(()=>{const q=window.__terrainQA;return{id:q.MatchLifecycle.activeSession().sim.campaignScenario.missionId,tick:q.ActiveViewState.snap.tick,backend:q.ActiveViewState.renderer.backend}});
        assert.equal(live.id,entry.id);assert.equal(live.backend,'WebGL');
        await ui.screenshot({path:path.join(output,`${entry.id}-ui-entry.png`)});
        // Additional real movement commands are opt-in while all mission starts remain mandatory.
        if(process.env.QA_TERRAIN_MOVEMENT==='1'&&entry.id==='frontier-02-rear-fire') {
          await rally(ui,entry.mission.regions.archers.center);
          await ui.waitForFunction(()=>window.__terrainQA.ActiveViewState.snap.decks[0].includes('archer'),null,{timeout:90000});
          live.archerRescue=true;await ui.screenshot({path:path.join(output,'mission-2-plateau-rescue.png')});
        }
        if(process.env.QA_TERRAIN_MOVEMENT==='1'&&entry.id==='frontier-04-moving-front') {
          const bridge=await ui.evaluate(()=>window.__terrainQA.ActiveViewState.renderer.world.terrain.surfaces.bridges[0]);
          const south=[(bridge.x-Math.cos(bridge.angle)*(bridge.halfLength+80))/entry.mission.map.width,(bridge.y-Math.sin(bridge.angle)*(bridge.halfLength+80))/entry.mission.map.height];
          const north=[(bridge.x+Math.cos(bridge.angle)*(bridge.halfLength+80))/entry.mission.map.width,(bridge.y+Math.sin(bridge.angle)*(bridge.halfLength+80))/entry.mission.map.height];
          const ordered=south[1]>north[1]?[south,north]:[north,south];
          await rally(ui,ordered[0]);
          await ui.waitForFunction(p=>window.__terrainQA.ActiveViewState.snap.units.some(u=>u.side===0&&u.alive&&u.type!=='worker'&&Math.hypot(u.x-p[0]*3600,u.y-p[1]*4200)<140),ordered[0],{timeout:90000});
          await rally(ui,[bridge.x/entry.mission.map.width,bridge.y/entry.mission.map.height]);
          await ui.waitForFunction(b=>window.__terrainQA.ActiveViewState.snap.units.some(u=>u.side===0&&u.alive&&Math.hypot(u.x-b.x,u.y-b.y)<70),bridge,{timeout:60000});
          await ui.screenshot({path:path.join(output,'mission-4-bridge-crossing.png')});
          await rally(ui,ordered[1]);
          await ui.waitForFunction(p=>window.__terrainQA.ActiveViewState.snap.units.some(u=>u.side===0&&u.alive&&Math.hypot(u.x-p[0]*3600,u.y-p[1]*4200)<140),ordered[1],{timeout:60000});
          live.bridgeCrossing=true;
        }
        if(process.env.QA_TERRAIN_MOVEMENT==='1'&&entry.id==='frontier-07-frontier-line') {
          const capture=entry.mission.map.capturePoints.find(c=>c.id==='east');
          await rally(ui,capture.position);
          await ui.waitForFunction(()=>window.__terrainQA.ActiveViewState.snap.capturePoints.some(c=>c.id==='east'&&c.owner===0),null,{timeout:120000});
          live.eastCapture=true;await ui.screenshot({path:path.join(output,'mission-7-east-capture.png')});
        }
        await ui.locator('#matchMenuBtnGame').click();await ui.locator('#matchMenuSurrenderBtn').click();await ui.locator('#result').waitFor({state:'visible'});
        await ui.locator('#rematchBtn').click();await ui.locator('#gameStartBtn').waitFor({state:'visible'});
        result.ui.push({...live,returnedToLobby:true,result:'UI surrender'});console.log(JSON.stringify(result.ui.at(-1)));
        fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
        await ui.close();
      }
    }
    assert.deepEqual(result.pageErrors,[]);
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
  } finally {
    await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}
async function rally(page,position) {
  const minimap=await page.evaluate(position=>{const q=window.__terrainQA,r=q.ActiveViewState.renderer,m=q.ActiveViewState.minimap,b=m.contentRect();return{x:b.left+r.viewX(position[0]*r.world.width)/r.world.width*b.width,y:b.top+r.viewY(position[1]*r.world.height)/r.world.height*b.height};},position);
  await page.mouse.click(minimap.x,minimap.y);await page.waitForTimeout(250);
  const target=await page.evaluate(position=>{const r=window.__terrainQA.ActiveViewState.renderer,b=r.canvas.getBoundingClientRect(),x=position[0]*r.world.width,z=position[1]*r.world.height,p=r.projectRenderWorldPosition({x,y:r.world.terrain.surfaces.heightAt(x,z),z});return{x:b.left+p.x*b.width/r.canvas.width,y:b.top+p.y*b.height/r.canvas.height};},position);
  await page.mouse.click(target.x,target.y);
}
run().catch(error=>{console.error(error.stack);process.exitCode=1});
