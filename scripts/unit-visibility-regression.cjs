const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const htmlArg = process.argv.indexOf('--html');
const source = fs.readFileSync(htmlArg >= 0 ? process.argv[htmlArg + 1] : path.join(root, 'index.html'), 'utf8');
const baseline = process.argv.includes('--baseline');
const output = path.join(root, '.qa/unit-visibility', baseline ? 'before' : 'after');
fs.mkdirSync(output, { recursive: true });
for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
  const opening = match[0].slice(0, match[0].indexOf('>'));
  if (match[1].trim() && !/type=["']application\/(?:ld\+)?json["']/.test(opening)) new vm.Script(match[1]);
}
if (process.argv.includes('--static')) {
  console.log('Inline JavaScript syntax passed');
  process.exit(0);
}

async function run() {
  const { chromium } = require('playwright');
  const end = source.lastIndexOf('})();');
  assert.ok(end >= 0);
  const html = source.slice(0, end) + `window.__unitQA={GLRenderer,Unit,UnitDefinition,UnitVisualDefinition,
    UnitVisualLookup,NEUTRAL_SIDE,ActiveViewState,MatchLifecycle,CampaignRuntime,CampaignModuleLoader};` + source.slice(end);
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: true });
  const errors = [], consoleErrors = [];
  const result = { baseline, geometry: null, local2p: null, singlePlayer: null, errors, consoleErrors };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', e => { if (e.type() === 'error') consoleErrors.push(e.text()); });
    page.on('dialog', d => d.accept());
    await page.route('http://127.0.0.1:32127/', r => r.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://127.0.0.1:32127/');
    await page.waitForFunction(() => window.__unitQA);

    result.geometry = await page.evaluate(() => {
      const { GLRenderer, Unit, UnitDefinition, UnitVisualLookup, NEUTRAL_SIDE } = window.__unitQA;
      const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 900;
      canvas.style.cssText = 'position:fixed;inset:0;z-index:99999;width:960px;height:900px';
      document.body.appendChild(canvas);
      // The gallery is drawn synchronously; do not leave an extra renderer loop
      // resizing the live game's shared HUD canvas after the probe is removed.
      const scheduleFrame = window.requestAnimationFrame;
      let r;
      try { window.requestAnimationFrame = () => 0; r = new GLRenderer(canvas); }
      finally { window.requestAnimationFrame = scheduleFrame; }
      const gl = r.gl, originalNow = performance.now;
      const fixedTime = 1000;
      // Normalize pose, animation phase and visibility, then exercise the production
      // drawUnit -> cache/species -> WebGL path for every declared species.
      performance.now = () => fixedTime;
      r.sc = () => 1; r.cameraLeft = (canvas.width - r.viewWorldW()) / 2; r.cameraTop = 0;
      r.snapshot = { tick: 10, tps: 20, units: [], buildings: [] };
      r.snapshotStealthed = () => false;
      r.resolveAirFacingScreen = () => ({ fx: 0, fy: -1, sx: 1, sy: 0, angle: -Math.PI / 2, attack: false });
      r.detectedRaw = () => true;
      const out = [], exceptions = [];
      const position = { x: 200, y: 0, z: 200, groundY: 0, motion: 'ground' };
      const colorsDiffer = (a, b) => a.some((v, i) => i % 7 >= 3 && v !== b[i]);
      const geometry = data => data.filter((_, i) => i % 7 < 3);
      const draw = (type, side, attack, x = 200, y = 200) => {
        const u = new Unit({ id: 'same-animation-seed', type, side, x, y, alive: true,
          hp: 100, maxHp: 100, attackFlash: attack ? 1 : 0, hitFlash: 0 });
        r.unitFacingStates.set(u.id, { angle: -Math.PI / 2, lastAt: fixedTime });
        r.artilleryFacingStates.set(u.id, { hull: -Math.PI / 2, turret: -Math.PI / 2, lastAt: fixedTime });
        r.drawUnit(u, { visibilityChecked: true, worldPosition: { ...position, x, z: y } });
        return { radius: r.unitRenderRadius(u), data: Array.from(r.frame.data.subarray(0, r.frame.length)) };
      };
      try {
        for (const type of Object.keys(UnitDefinition.all)) for (const attack of [false, true]) {
          try {
            const samples = [0, 1, NEUTRAL_SIDE].map(side => { r.begin(); return draw(type, side, attack); });
            const cold = samples.map(s => geometry(s.data));
            const sameGeometry = cold.every(g => g.length === cold[0].length && g.every((v, i) => Math.abs(v - cold[0][i]) < 1e-4));
            const repeats = [0, 1, NEUTRAL_SIDE].map((side, i) => {
              r.begin(); const repeated = draw(type, side, attack);
              return repeated.data.every((v, j) => Math.abs(v - samples[i].data[j]) < 1e-4) && repeated.data.length === samples[i].data.length;
            });
            out.push({ type, attack, sameGeometry, radius: samples.map(s => s.radius),
              vertices: samples.map(s => s.data.length / 7), repeatStable: repeats.every(Boolean),
              colored: colorsDiffer(samples[0].data, samples[1].data) && colorsDiffer(samples[1].data, samples[2].data) });
          } catch (e) { exceptions.push({ type, attack, message: e.message }); }
        }
        // Production currently uses DYNAMIC meshes. Explicitly exercise the dormant
        // shared STATIC path with two immutable species; never change its live policy.
        const cacheCases = [], policy = UnitVisualLookup.cachePolicy;
        try {
          for (const type of ['swordsman', 'pikeman']) for (const attack of [false, true]) for (const side of [0, 1, NEUTRAL_SIDE]) {
            UnitVisualLookup.cachePolicy = policy;
            r.begin(); const procedural = draw(type, side, attack).data;
            UnitVisualLookup.cachePolicy = () => 'STATIC';
            r.begin(); const cold = draw(type, side, attack).data;
            r.begin(); const warm = draw(type, side, attack).data;
            const equal = data => data.length === procedural.length && data.every((v, i) => Math.abs(v - procedural[i]) < 1e-4);
            cacheCases.push({ type, side, attack, coldMatches: equal(cold), warmMatches: equal(warm) });
          }
        } finally { UnitVisualLookup.cachePolicy = policy; }
        gl.viewport(0, 0, canvas.width, canvas.height); gl.useProgram(r.p); gl.uniform2f(r.r, canvas.width, canvas.height);
        gl.clearColor(.125, .21, .15, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.disable(gl.DEPTH_TEST);
        r.begin();
        const gallery = ['swordsman', 'pikeman', 'archer', 'skirmisher', 'wildhound', 'sporetoad'];
        const pixels = [];
        for (let row = 0; row < gallery.length; row++) for (let col = 0; col < 3; col++) {
          const type = gallery[row], side = [0, 1, NEUTRAL_SIDE][col], x = 170 + col * 300, y = 85 + row * 145;
          // draw() returns all current vertices; appending here renders a real GPU gallery.
          draw(type, side, false, x, y); pixels.push({ type, side, x, y });
        }
        r.flush(); gl.finish();
        for (const p of pixels) { const color = new Uint8Array(4); gl.readPixels(p.x, canvas.height - p.y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, color); p.center = [...color]; }
        return { species: Object.keys(UnitDefinition.all).length, cases: out, exceptions, pixels,
          neutralRelation: r.factionRelation(NEUTRAL_SIDE), glError: gl.getError(), backend: r.backend,
          raster: canvas.toDataURL(), cacheCases, cacheHits: r.unitBodyMeshCacheHits, cacheMisses: r.unitBodyMeshCacheMisses };
      } finally { performance.now = originalNow; canvas.remove(); r.snapshot = null; }
    });
    fs.writeFileSync(path.join(output, 'factions.png'), Buffer.from(result.geometry.raster.split(',')[1], 'base64'));
    delete result.geometry.raster;
    if (!baseline) {
      assert.deepEqual(result.geometry.exceptions, [], 'Every declared species renders through the production renderer');
      assert.equal(result.geometry.neutralRelation, 'neutral');
      for (const c of result.geometry.cases) {
        assert.ok(c.sameGeometry, `${c.type} attack=${c.attack}: faction must not change body geometry`);
        assert.ok(c.repeatStable, `${c.type}: identical animation and state repeat the same geometry`);
        assert.ok(c.colored, `${c.type}: every faction has visible identifying color`);
        assert.equal(new Set(c.radius).size, 1, `${c.type}: faction cannot resize the species`);
      }
      assert.ok(result.geometry.cacheHits > 0 && result.geometry.cacheMisses > 0, 'Explicit STATIC probe executes both cache paths');
      assert.ok(result.geometry.cacheCases.every(c => c.coldMatches && c.warmMatches), 'STATIC cold/warm geometry matches procedural output');
      for (const p of result.geometry.pixels.filter(p => ['swordsman', 'pikeman', 'archer', 'skirmisher'].includes(p.type))) {
        assert.notDeepEqual(p.center.slice(0, 3), [32, 54, 38], `${p.type} side=${p.side}: torso covers its center`);
      }
      assert.equal(result.geometry.glError, 0);
    }

    if (!baseline && !process.argv.includes('--geometry-only')) {
      await page.evaluate(() => {
        const q = window.__unitQA;
        // Authored initial conditions only. All movement, neutral aggro, attacks,
        // death, snapshots and both peers are owned by actual game sessions.
        const mission = { schemaVersion: 7, missionId: 'unit-faction-qa', title: '중립 진영 외형 검증', playerRole: 'host', seed: 17,
          victory: { type: 'scripted' },
          player: { availableUnits: ['swordsman'], startingWorkers: 0, startingUnits: [] },
          enemy: { availableUnits: ['swordsman'], startingWorkers: 0, startingUnits: [], aiProfile: 'scripted' },
          map: { type: 'manual', width: 3072, height: 4096, content: { resourcePlacement: 'none' },
            spawns: { host: [.15, .85], guest: [.85, .15] }, capturePoints: [],
            garrisons: [{ id: 'neutral-line', faction: 'neutral', position: [.5, .5], control: 'guard', guardRadius: .1, spread: .012,
              composition: [{ unit: 'swordsman', count: 6 }, { unit: 'pikeman', count: 2 }, { unit: 'archer', count: 2 }, { unit: 'skirmisher', count: 2 }] }],
            attackForces: [{ id: 'player-line', faction: 'player', position: [.5, .55], spread: .014,
              composition: [{ unit: 'swordsman', count: 6 }, { unit: 'archer', count: 4 }] }] },
          events: [{ id: 'engage', once: true, when: { type: 'time', seconds: .2 }, actions: [
            { type: 'order', group: 'player-line', order: 'attack', position: [.5, .5] },
            { type: 'cameraFocus', position: [.5, .515] }] }] };
        q.CampaignRuntime.setMission(mission);
        const captures = [], original = q.GLRenderer.prototype.drawUnitCommonBody;
        q.GLRenderer.prototype.drawUnitCommonBody = function(ctx) {
          const before = this.frame.length; original.call(this, ctx);
          if (ctx.u.side === q.NEUTRAL_SIDE && captures.length < 3000) captures.push({ tick: this.snapshot?.tick,
            type: ctx.u.type, vertices: (this.frame.length - before) / 7, hp: ctx.u.hp, maxHp: ctx.u.maxHp,
            attack: ctx.u.attackFlash > 0, backend: this.backend });
        };
        window.__unitCombatCaptures = captures;
        q.MatchLifecycle.startLocalTest();
      });
      await page.waitForFunction(() => window.__unitQA.ActiveViewState.snap?.tick > 5, null, { timeout: 45000 });
      const cameraTarget = await page.evaluate(() => {
        const q = window.__unitQA, r = q.ActiveViewState.renderer, rect = q.ActiveViewState.minimap.contentRect();
        return { x: rect.left + r.viewX(r.world.width * .5) / r.world.width * rect.width,
          y: rect.top + r.viewY(r.world.height * .515) / r.world.height * rect.height };
      });
      await page.mouse.click(cameraTarget.x, cameraTarget.y);
      await page.waitForFunction(() => window.__unitCombatCaptures.length > 0, null, { timeout: 10000 });
      await page.screenshot({ path: path.join(output, 'local2p-combat.png') });
      await page.waitForFunction(() => window.__unitCombatCaptures.some(c => c.attack || c.hp < c.maxHp), null, { timeout: 45000 });
      await page.screenshot({ path: path.join(output, 'local2p-neutral-hit.png') });
      result.local2p = await page.evaluate(() => {
        const q = window.__unitQA, local = q.MatchLifecycle.localTest, sim = local.sessions.host.sim;
        return { backend: q.ActiveViewState.renderer.backend, tick: sim.tick, peers: Object.keys(local.sessions),
          captures: window.__unitCombatCaptures, entityErrors: [...(q.ActiveViewState.renderer.entityRenderErrors || [])],
          fatal: document.body.innerText.includes('RALLY_FRONTIER_PRESENTATION_CONTRACT_FATAL'),
          neutral: sim.units.filter(u => u.side === q.NEUTRAL_SIDE).map(u => ({ type: u.type, hp: u.hp, alive: u.alive })) };
      });
      assert.equal(result.local2p.backend, 'WebGL');
      assert.deepEqual(result.local2p.peers.sort(), ['guest', 'host']);
      assert.equal(result.local2p.fatal, false);
      assert.deepEqual(result.local2p.entityErrors, []);
      for (const type of ['swordsman', 'pikeman', 'archer', 'skirmisher']) {
        assert.ok(result.local2p.captures.some(c => c.type === type && c.vertices > 0), `${type}: actual neutral combat draws a torso`);
      }
      await page.evaluate(() => window.__unitQA.MatchLifecycle.disposeMatches('qa-complete'));
      await page.close();

      const single = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      single.on('pageerror', e => errors.push(e.message));
      single.on('console', e => { if (e.type() === 'error') consoleErrors.push(e.text()); });
      single.on('dialog', d => d.accept());
      await single.route('http://127.0.0.1:32127/', r => r.fulfill({ contentType: 'text/html', body: html }));
      await single.route('http://127.0.0.1:32127/campaign/campaigns.js*', r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(root, 'campaign/campaigns.js'), 'utf8') }));
      await single.goto('http://127.0.0.1:32127/');
      await single.waitForFunction(() => window.__unitQA);
      await single.evaluate(() => {
        const q = window.__unitQA, original = q.GLRenderer.prototype.drawUnit;
        window.__singleCombatFrames = [];
        q.GLRenderer.prototype.drawUnit = function(u, ...args) {
          const before = this.frame.length, value = original.call(this, u, ...args);
          if (this.frame.length > before && (u.attackFlash > 0 || u.hitFlash > 0) && window.__singleCombatFrames.length < 1000) {
            window.__singleCombatFrames.push({ tick: this.snapshot?.tick, side: u.side, type: u.type, attack: u.attackFlash > 0, hit: u.hitFlash > 0 });
          }
          return value;
        };
      });
      await single.locator('#gameStartBtn').click(); await single.locator('#campaignBtn').click();
      await single.locator('[data-mission-id="frontier-01-first-flag"]').click(); await single.locator('#campaignStartBtn').click();
      await single.waitForFunction(() => window.__unitQA.ActiveViewState.snap?.tick > 20, null, { timeout: 30000 });
      const camera = async (x, y) => {
        const p = await single.evaluate(({ x, y }) => {
          const r = window.__unitQA.ActiveViewState.renderer, rect = window.__unitQA.ActiveViewState.minimap.contentRect();
          return { x: rect.left + r.viewX(r.world.width * x) / r.world.width * rect.width,
            y: rect.top + r.viewY(r.world.height * y) / r.world.height * rect.height };
        }, { x, y });
        await single.mouse.click(p.x, p.y);
      };
      const ground = async (x, y) => {
        const p = await single.evaluate(({ x, y }) => {
          const r = window.__unitQA.ActiveViewState.renderer, rect = r.canvas.getBoundingClientRect();
          const pos = r.projectRenderWorldPosition({ x: r.world.width * x, y: 0, z: r.world.height * y });
          return { x: rect.left + pos.x * rect.width / r.canvas.width, y: rect.top + pos.y * rect.height / r.canvas.height };
        }, { x, y });
        await single.mouse.click(p.x, p.y);
      };
      await camera(.30, .72); await ground(.30, .72);
      await single.waitForFunction(() => window.__unitQA.ActiveViewState.snap.decks[0].includes('swordsman'), null, { timeout: 60000 });
      const rallyTick = await single.evaluate(() => window.__unitQA.ActiveViewState.snap.tick);
      await camera(.34, .65); await ground(.34, .65);
      await single.waitForFunction(tick => window.__singleCombatFrames.some(c => c.side === window.__unitQA.NEUTRAL_SIDE && c.tick >= tick), rallyTick, { timeout: 60000 });
      await single.screenshot({ path: path.join(output, 'single-player-combat.png') });
      await camera(.30, .72);
      await single.locator('#economyTreeBtn').click(); await single.locator('#supplyBtn').click();
      await ground(.26, .73); await single.locator('#buildFinishBtn').click();
      await single.waitForFunction(() => window.__unitQA.ActiveViewState.snap.buildings.some(b => b.side === 0 && b.type === 'supply' && b.complete), null, { timeout: 45000 });
      await single.locator('#militaryTreeBtn').click(); await single.locator('#militaryT1Btn').click();
      await single.locator('[data-produce-unit="swordsman"]').click(); await ground(.31, .76); await single.locator('#buildFinishBtn').click();
      await single.waitForFunction(() => window.__unitQA.ActiveViewState.snap.buildings.some(b => b.side === 0 && b.produceType === 'swordsman' && b.productionBatchesCompleted > 0), null, { timeout: 60000 });
      await single.screenshot({ path: path.join(output, 'single-player-production.png') });
      result.singlePlayer = await single.evaluate(() => {
        const q = window.__unitQA, snap = q.ActiveViewState.snap;
        return { backend: q.ActiveViewState.renderer.backend, tick: snap.tick,
          transport: q.ActiveViewState.transport.constructor.name, peers: Object.keys(q.MatchLifecycle.singleMatch.sessions),
          production: snap.buildings.filter(b => b.produceType === 'swordsman').map(b => b.productionBatchesCompleted),
          combatFrames: window.__singleCombatFrames, entityErrors: [...(q.ActiveViewState.renderer.entityRenderErrors || [])] };
      });
      assert.equal(result.singlePlayer.backend, 'WebGL'); assert.deepEqual(result.singlePlayer.entityErrors, []);
      await single.locator('#matchMenuBtnGame').click(); await single.locator('#matchMenuSurrenderBtn').click();
      await single.locator('#result').waitFor({ state: 'visible' });
      await single.screenshot({ path: path.join(output, 'single-player-result.png') });
      await single.locator('#rematchBtn').click(); await single.locator('#gameStartBtn').waitFor({ state: 'visible' });
      result.singlePlayer.returnedToLobby = true;
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ species: result.geometry.species, cases: result.geometry.cases.length,
      geometryFailures: result.geometry.cases.filter(c => !c.sameGeometry).map(c => c.type),
      exceptions: result.geometry.exceptions, local2pTick: result.local2p?.tick,
      singlePlayerTick: result.singlePlayer?.tick, returnedToLobby: result.singlePlayer?.returnedToLobby, errors }, null, 2));
  } finally {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    await browser.close();
  }
}
run().catch(e => { console.error(e.stack); process.exitCode = 1; });
