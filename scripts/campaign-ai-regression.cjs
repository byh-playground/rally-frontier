const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium: nativeChromium } = require('playwright');
const chromium = require('./netcode-qa-module.cjs').wrapChromium(nativeChromium);

// Supply a candidate index.html as argv[2]; its sibling campaign module is used.
// Default: all seven real simulations and UI missions 1, 4, 7. Override with
// QA_CAMPAIGN_UI_MISSIONS=1,2,3,4,5,6,7 or QA_CAMPAIGN_UI_MISSIONS=0.
// QA_CAMPAIGN_RUSH=1 additionally records a six-minute no-build direct rush.
const root = process.argv[2] ? path.dirname(path.resolve(process.argv[2])) : path.resolve(__dirname, '..');
const output = path.join(root, '.qa/campaign-ai');

async function run() {
  fs.mkdirSync(output, { recursive: true });
  let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const end = html.lastIndexOf('})();'); assert.ok(end >= 0);
  html = html.slice(0, end) + 'window.__campaignAiQA={CampaignBuiltinCatalog,CampaignMissionDefinition,StrategySim,BotController,GameRuleDefinition,MatchLifecycle,ActiveViewState,UnitDefinition,StableSerializationUtil};' + html.slice(end);
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: true });
  const result = { integration: [], ui: [], pageErrors: [] };
  async function newPage() {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', e => result.pageErrors.push(e.message)); page.on('dialog', d => d.accept());
    await page.route('http://campaign-ai-qa.local/', r => r.fulfill({ contentType: 'text/html', body: html }));
    await page.route('http://campaign-ai-qa.local/campaign/campaigns.js*', r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(root, 'campaign/campaigns.js'), 'utf8') }));
    await page.goto('http://campaign-ai-qa.local/'); await page.waitForFunction(() => window.__campaignAiQA);
    return page;
  }
  try {
    const page = await newPage();
    const missions = await page.evaluate(async () => (await window.__campaignAiQA.CampaignBuiltinCatalog.manifest()).campaigns.flatMap(c => c.missions));
    assert.equal(missions.length, 7);
    const originalStartingCounts=[[3],[8],[6,5],[5,4,4],[5,4,4],[6,4,5],[6,4,4,2]];
    const originalJoinCounts=[5,6,6,6,10,4,0];
    for(const [i,entry] of missions.entries()){
      assert.deepEqual(entry.mission.player.startingUnits.map(u=>u.count),originalStartingCounts[i], 'Keep the authored player starting army');
      const joinCount=entry.mission.map.garrisons.filter(g=>g.faction==='player').flatMap(g=>g.composition).reduce((sum,u)=>sum+u.count,0);
      assert.equal(joinCount,originalJoinCounts[i], 'Keep the authored player joining army');
      assert.ok(entry.mission.enemy.startingUnits.reduce((sum,u)=>sum+u.count,0)>0, 'Enemy army increases instead of reducing the player army');
    }
    result.unlockContracts=await page.evaluate(entries=>{
      const q=window.__campaignAiQA,out=[],check=(ok,message)=>{if(!ok)throw Error(message)};
      for(const entry of entries)for(const humanRole of ['host','guest']){
        const raw=structuredClone(entry.mission);raw.playerRole=humanRole;
        const mission=q.CampaignMissionDefinition.normalize(raw),enemyRole=humanRole==='host'?'guest':'host',enemySide=enemyRole==='host'?0:1;
        const draft={decks:{[humanRole]:mission.player.availableUnits,[enemyRole]:mission.enemy.availableUnits},defenseCards:{host:[],guest:[]}};
        const sim=q.StrategySim.createForMatch({draft,seed:mission.seed,rules:q.GameRuleDefinition.current,campaignScenario:mission});
        const bot=new q.BotController({role:enemyRole,sim,draft,getPendingCommandTickets:()=>[],get confirmedGameTick(){return sim.tick}},{role:enemyRole});
        try{
          for(const event of mission.events){const actions=event.actions.filter(a=>a.type==='unlockUnit');if(!actions.length)continue;
            for(const action of actions)sim.campaignScriptRuntime.runAction(action);
            check(JSON.stringify(sim.decks[0])===JSON.stringify(sim.decks[1]),`${entry.id}/${humanRole}/${event.id}: join must unlock exactly the same cards for both roles`);
          }
          const state=sim.snapshot();bot.lastSnapshot=state;
          check(JSON.stringify(bot.deck())===JSON.stringify(sim.decks[enemySide]),`${entry.id}/${humanRole}: bot reads authoritative live deck`);
          if(!mission.enemy.availableUnits.length){check(draft.decks[enemyRole].length===0,'Intro draft remains stale');check(bot.deck().includes('swordsman'),'Intro live swordsman unlock reaches bot')}
          // Isolated observation/budget probes use the mission's allowed cards and real prerequisite policy.
          const air=Object.keys(q.UnitDefinition.all).find(id=>q.UnitDefinition.get(id)?.layer==='AIR');
          const p={enemyUnits:[{type:air,alive:true,side:1-enemySide},{type:'swordsman',alive:true,side:1-enemySide}],ownArmy:[]};
          state.wallet[enemySide]=1000;state.gasWallet[enemySide]=1000;
          const units=bot.deck().slice(),ordered=bot.orderedProductionUnits(state,p,units);
          check(ordered.every(id=>units.includes(id)), 'Observation does not invent production cards');
          const affordableAA=units.filter(id=>q.UnitDefinition.get(id)?.canAttackAir&&bot.productionPrerequisitesReady(state,id)&&q.UnitDefinition.productionCost(id).mineral<=1000&&q.UnitDefinition.productionCost(id).gas<=1000);
          if(affordableAA.length)check(q.UnitDefinition.get(ordered[0])?.canAttackAir,`${entry.id}/${humanRole}: observed air prioritizes allowed affordable AA`);
          state.wallet[enemySide]=100;state.gasWallet[enemySide]=0;
          const poor=bot.orderedProductionUnits(state,p,units),affordable=units.filter(id=>bot.productionPrerequisitesReady(state,id)&&q.UnitDefinition.productionCost(id).mineral<=100&&q.UnitDefinition.productionCost(id).gas===0);
          if(affordable.length)check(affordable.includes(poor[0]),`${entry.id}/${humanRole}: unaffordable counter does not block an affordable card`);
          if(units.includes('medic')){
            state.wallet[enemySide]=1000;state.gasWallet[enemySide]=1000;
            const quiet={enemyUnits:[],ownArmy:[]};
            const opening=bot.orderedProductionUnits(state,quiet,['medic','swordsman']);
            check(opening[0]==='swordsman','Support cannot replace the opening combat army');
            state.buildings.push({id:'support-pipeline-probe',side:enemySide,alive:true,produceType:'medic',productionRemaining:10});
            quiet.ownArmy=[{type:'swordsman'},{type:'swordsman'},{type:'swordsman'}];
            const funded=bot.orderedProductionUnits(state,quiet,['medic','swordsman']);
            check(funded[0]==='swordsman','Already-funded support batches prevent excess support contracts');
          }
          out.push({id:entry.id,humanRole,liveDeck:units,airObservationOrder:ordered,lowBudgetOrder:poor});
        }finally{bot.stop();sim.dispose('campaign-unlock-contract')}
      }return out;
    },missions);
    for (const [index, entry] of missions.entries()) {
      const evidence = await page.evaluate(({ entry, rush }) => {
        const q = window.__campaignAiQA, mission = q.CampaignMissionDefinition.normalize(entry.mission);
        const check = (ok, message) => { if (!ok) throw Error(`${entry.id}: ${message}`); };
        check(mission.enemy.aiProfile === 'standard', 'Enemy must use the standard AI');
        check(JSON.stringify(mission.enemy.availableUnits) === JSON.stringify(mission.player.availableUnits), 'Enemy starts with the same allowed production cards');
        check(JSON.stringify(mission.enemy.startingResources) === JSON.stringify(mission.player.startingResources), 'Enemy starts with the same resource budget');
        check(mission.enemy.startingTech===mission.player.startingTech&&mission.enemy.techCap===mission.player.techCap, 'Enemy starts with the same technology and cap');
        const humanRole = mission.playerRole, enemyRole = humanRole === 'host' ? 'guest' : 'host', side = enemyRole === 'host' ? 0 : 1;
        const draft = { decks: { [humanRole]: mission.player.availableUnits, [enemyRole]: mission.enemy.availableUnits }, defenseCards: { host: [], guest: [] } };
        const sim = q.StrategySim.createForMatch({ draft, seed: mission.seed, rules: q.GameRuleDefinition.current, campaignScenario: mission });
        const initialBuildings = new Set(sim.buildings.map(b => b.id));
        const initialArmy = sim.units.filter(u => u.side === 1 - side && !q.UnitDefinition.get(u.type)?.economyWorker).length;
        let sequence = 0; const tickets = new Map(), submitted = [], applied = [];
        const session = { role: enemyRole, sim, draft, matchConfig: { campaignScenario: mission }, netcodeSession: { resimulating: false },
          get confirmedGameTick() { return sim.tick; }, inputAvailable: () => true,
          getPendingCommandTickets: () => [...tickets.values()],
          command(action) {
            if(action.type==='BUILD'&&action.produceType)check(sim.decks[side].includes(action.produceType), 'AI only builds production for a currently allowed card');
            const ticket = { sequence: ++sequence, actor: enemyRole, key: q.StableSerializationUtil.stableStringify(action), action: structuredClone(action), submittedTick: sim.tick };
            tickets.set(sequence, ticket); this.lastCommandTicket = ticket; submitted.push({ tick: sim.tick, ...action });
            const tick = sim.tick + 1, commands = sim.scheduled.get(tick) || [];
            commands.push({ seq: sequence, netcodeSequence: sequence, actor: enemyRole, action: ticket.action }); sim.scheduled.set(tick, commands); return true;
          }
        };
        const bot = new q.BotController(session, { role: enemyRole });
        let winner = null; const completedProducers = new Map(),startedAt=performance.now();let peakUnits=sim.units.length;
        try {
          if (!mission.enemy.availableUnits.length) {
            const rescue = mission.regions.rescue;
            check(rescue, 'Empty intro deck has a rescue region');
            sim.applyCommand(humanRole, { type:'SET_FLAG', x:rescue.center[0]*sim.world.width, y:rescue.center[1]*sim.world.height });
            for(let i=0;i<120*sim.tps&&!sim.decks[side].length;i++){bot.handleSnapshot(sim.snapshot());sim.step();for(const receipt of sim.commandReceipts)if(tickets.has(receipt.netcodeSequence)){applied.push(structuredClone(receipt));tickets.delete(receipt.netcodeSequence)}}
            check(sim.decks[side].length>0, 'Actual rescue unlocks enemy production too');
            check(draft.decks[enemyRole].length===0, 'Intro draft stays empty while the authoritative live deck unlocks');
          }
          if (rush) { const target = sim.base(side); sim.applyCommand(humanRole, { type: 'SET_FLAG', x: target.x, y: target.y }); }
          const duration = rush ? 360 : 180;
          for (let i = 0; i < duration * sim.tps && !winner; i++) {
            if (sim.tick % Math.max(1, Math.round(sim.tps / 2)) === 0) bot.handleSnapshot(sim.snapshot());
            winner = sim.step();
            peakUnits=Math.max(peakUnits,sim.units.length);
            for (const b of sim.buildings) if (b.side === side && !initialBuildings.has(b.id) && b.produceType && b.productionBatchesCompleted > 0) completedProducers.set(b.id, {id:b.id,type:b.type,unit:b.produceType,batches:b.productionBatchesCompleted});
            for (const receipt of sim.commandReceipts) if (tickets.has(receipt.netcodeSequence)) { applied.push(structuredClone(receipt)); tickets.delete(receipt.netcodeSequence); }
          }
          const built = sim.buildings.filter(b => b.side === side && !initialBuildings.has(b.id));
          const producers = [...completedProducers.values()];
          check(applied.some(r => r.type === 'BUILD' && r.applied), `AI BUILD command actually applied (${JSON.stringify({tick:sim.tick,winner,submitted,applied,stats:bot.commandExecutor.stats})})`);
          check(producers.length > 0, `New AI building completed at least one troop batch (${JSON.stringify({built:built.map(b=>({id:b.id,type:b.type,produceType:b.produceType,complete:b.complete,batches:b.productionBatchesCompleted})),submitted,applied})})`);
          check(!sim.buildings.some(b => b.side === 1 - side && b.produceType && !initialBuildings.has(b.id)), 'Probe contains no player production');
          return { id: entry.id, tick: sim.tick, seconds: sim.tick / sim.tps, enemyDeck: mission.enemy.availableUnits, initialPlayerArmy: initialArmy,
            measured:{wallMs:Math.round(performance.now()-startedAt),peakUnits,finalUnits:sim.units.length,scope:'Synchronous browser simulation probe; includes snapshots and AI decisions, excludes rendering. Not a frame-time benchmark.'},
            submittedBuilds: submitted.filter(a => a.type === 'BUILD'), appliedBuilds: applied.filter(r => r.type === 'BUILD'),
            producers,
            rush: rush ? { winner, ended: !!winner, playerArmyRemaining: sim.units.filter(u => u.alive && u.side === 1 - side && !q.UnitDefinition.get(u.type)?.economyWorker).length,
              playerBaseHp: sim.base(1 - side)?.hp ?? 0, enemyBaseHp: sim.base(side)?.hp ?? 0,
              limitation: 'Direct base rally, no player construction or spells; an unfinished probe does not establish mission difficulty.' } : null };
        } finally { bot.stop(); sim.dispose('campaign-ai-regression'); }
      }, { entry, rush: process.env.QA_CAMPAIGN_RUSH === '1' });
      result.integration.push(evidence); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify({ mission: index + 1, id: entry.id, producers: evidence.producers, rush: evidence.rush }));
    }
    await page.close();
    const selected = (process.env.QA_CAMPAIGN_UI_MISSIONS || '1,4,7').split(',').map(Number);
    for (const [index, entry] of missions.entries()) {
      if (!selected.includes(index + 1)) continue;
      const ui = await newPage();
      await ui.locator('#gameStartBtn').click(); await ui.locator('#campaignBtn').click();
      await ui.locator(`[data-mission-id="${entry.id}"]`).click(); await ui.locator('#campaignStartBtn').click();
      await ui.waitForFunction(() => window.__campaignAiQA.MatchLifecycle.singleMatch?.sessions.guest.sim?.tick > 20, null, { timeout: 30000 });
      await ui.evaluate(() => { const q = window.__campaignAiQA, session = q.MatchLifecycle.singleMatch.sessions.guest; window.__aiInitialBuildings = session.sim.buildings.map(b => b.id); });
      if (!entry.mission.enemy.availableUnits.length) {
        const position=entry.mission.regions.rescue.center;
        const mini=await ui.evaluate(p=>{const q=window.__campaignAiQA,r=q.ActiveViewState.renderer,b=q.ActiveViewState.minimap.contentRect();return{x:b.left+r.viewX(p[0]*r.world.width)/r.world.width*b.width,y:b.top+r.viewY(p[1]*r.world.height)/r.world.height*b.height}},position);
        await ui.mouse.click(mini.x,mini.y);await ui.waitForTimeout(250);
        const ground=await ui.evaluate(p=>{const r=window.__campaignAiQA.ActiveViewState.renderer,b=r.canvas.getBoundingClientRect(),x=p[0]*r.world.width,z=p[1]*r.world.height,v=r.projectRenderWorldPosition({x,y:r.world.terrain.surfaces.heightAt(x,z),z});return{x:b.left+v.x*b.width/r.canvas.width,y:b.top+v.y*b.height/r.canvas.height}},position);
        await ui.mouse.click(ground.x,ground.y);
      }
      await ui.waitForFunction(() => {
        const q = window.__campaignAiQA, session = q.MatchLifecycle.singleMatch.sessions.guest;
        return session.sim.buildings.some(b => b.side === 1 && !window.__aiInitialBuildings.includes(b.id) && b.produceType && b.productionBatchesCompleted > 0);
      }, null, { timeout: 180000 });
      const live = await ui.evaluate(() => {
        const q = window.__campaignAiQA, match = q.MatchLifecycle.singleMatch, session = match.sessions.guest, bot = match.bot;
        return { id: session.sim.campaignScenario.missionId, tick: session.sim.tick, backend: q.ActiveViewState.renderer.backend,
          transportOpen: session.transportConnected, confirmedTick: session.confirmedGameTick,
          ledger: bot.commandExecutor.history.filter(h => h.action?.type === 'BUILD'),
          producers: session.sim.buildings.filter(b => b.side === 1 && !window.__aiInitialBuildings.includes(b.id) && b.produceType && b.productionBatchesCompleted > 0).map(b => ({ id: b.id, unit: b.produceType, batches: b.productionBatchesCompleted })) };
      });
      assert.equal(live.id, entry.id); assert.equal(live.backend, 'WebGL'); assert.equal(live.transportOpen, true); assert.ok(live.producers.length);
      // Move the actual camera through the minimap; never alter fog or ownership for screenshots.
      const target = await ui.evaluate(() => {
        const q = window.__campaignAiQA, r = q.ActiveViewState.renderer, b = q.ActiveViewState.minimap.contentRect(), base = q.MatchLifecycle.singleMatch.sessions.host.sim.base(1);
        return { x: b.left + r.viewX(base.x) / r.world.width * b.width, y: b.top + r.viewY(base.y) / r.world.height * b.height };
      });
      await ui.mouse.click(target.x, target.y); await ui.waitForTimeout(500);
      await ui.screenshot({ path: path.join(output, `${entry.id}-enemy-production-ui.png`) });
      await ui.locator('#matchMenuBtnGame').click(); await ui.locator('#matchMenuSurrenderBtn').click(); await ui.locator('#result').waitFor({ state: 'visible' });
      await ui.locator('#rematchBtn').click(); await ui.locator('#gameStartBtn').waitFor({ state: 'visible' });
      result.ui.push({ ...live, returnedToLobby: true }); fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
      await ui.close();
    }
    assert.deepEqual(result.pageErrors, []); console.log(JSON.stringify({ missions: result.integration.length, ui: result.ui.length, pageErrors: result.pageErrors }));
  } finally { await browser.close(); }
}
run().catch(e => { console.error(e.stack); process.exitCode = 1; });
