const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium: nativeChromium } = require('playwright');
const chromium = require('./netcode-qa-module.cjs').wrapChromium(nativeChromium);

// Candidate index.html is argv[2]. Controlled casualty/ownership fixtures test
// the order lifecycle; they are not a fair-play difficulty or victory benchmark.
// UI defaults to real campaign menu missions 5 and 7; set QA_OFFENSE_UI=0 to skip.
const root = process.argv[2] ? path.dirname(path.resolve(process.argv[2])) : path.resolve(__dirname, '..');
const output = path.join(root, '.qa/campaign-offense');
async function run() {
  fs.mkdirSync(output, { recursive: true });
  let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const end = html.lastIndexOf('})();'); assert.ok(end >= 0);
  html = html.slice(0, end) + 'window.__offenseQA={CampaignBuiltinCatalog,CampaignMissionDefinition,CampaignContentValidator,StrategySim,BotController,GameRuleDefinition,MatchLifecycle,ActiveViewState,UnitDefinition,BuildingDefinition,StableSerializationUtil,AiMacroExecutor,AiActionGenerator};' + html.slice(end);
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: true });
  const result = { contracts: [], integration: [], ui: [], pageErrors: [] };
  const save = () => fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  async function newPage() {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', e => result.pageErrors.push(e.message)); page.on('dialog', d => d.accept());
    await page.route('http://campaign-offense-qa.local/', r => r.fulfill({ contentType: 'text/html', body: html }));
    await page.route('http://campaign-offense-qa.local/campaign/campaigns.js*', r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(root, 'campaign/campaigns.js'), 'utf8') }));
    await page.goto('http://campaign-offense-qa.local/'); await page.waitForFunction(() => window.__offenseQA);
    return page;
  }
  try {
    const page = await newPage();
    const entries = await page.evaluate(async () => (await window.__offenseQA.CampaignBuiltinCatalog.manifest()).campaigns.flatMap(c => c.missions));
    assert.equal(entries.length, 7);
    result.contracts = await page.evaluate(entries => {
      const q = window.__offenseQA, out = [], check = (ok, message) => { if (!ok) throw Error(message); };
      const starting = [[3], [8], [6, 5], [5, 4, 4], [5, 4, 4], [6, 4, 5], [6, 4, 4, 2]], joins = [5, 6, 6, 6, 10, 4, 0];
      for (const [i, entry] of entries.entries()) {
        const raw = entry.mission;
        check(JSON.stringify(raw.player.startingUnits.map(u => u.count)) === JSON.stringify(starting[i]), 'Authored starting army preserved');
        check(raw.map.garrisons.filter(g => g.faction === 'player').flatMap(g => g.composition).reduce((n, u) => n + u.count, 0) === joins[i], 'Authored joining army preserved');
        check(raw.enemy.offense && JSON.stringify(raw.player.availableUnits) === JSON.stringify(raw.enemy.availableUnits), 'Same production cards with offense profile');
        const bad = structuredClone(raw); bad.enemy.offense.counterattackPoints = ['missing-capture-point'];
        let validation = null;
        try { q.CampaignContentValidator.validate(bad); } catch (error) { validation = error.message; }
        check(validation?.includes('counterattackPoints'), 'Malformed capture references rejected');
        for (const value of [0, -1, 1.5]) {
          const invalid = structuredClone(raw); invalid.enemy.offense.productionLimit = value;
          let error = null; try { q.CampaignContentValidator.validate(invalid); } catch (e) { error = e.message; }
          check(error?.includes('productionLimit'), `Invalid production cap ${value} rejected`);
        }
        for (const value of [null, undefined]) {
          const uncapped = structuredClone(raw); uncapped.enemy.offense.productionLimit = value;
          check(q.CampaignMissionDefinition.normalize(uncapped).enemy.offense.productionLimit == null, 'Optional production cap stays absent');
        }
        for (const humanRole of ['host', 'guest']) {
          const candidate = structuredClone(raw); candidate.playerRole = humanRole;
          const mission = q.CampaignMissionDefinition.normalize(candidate), role = humanRole === 'host' ? 'guest' : 'host';
          const draft = { decks: { [humanRole]: mission.player.availableUnits, [role]: mission.enemy.availableUnits }, defenseCards: { host: [], guest: [] } };
          const sim = q.StrategySim.createForMatch({ draft, seed: mission.seed, rules: q.GameRuleDefinition.current, campaignScenario: mission });
          const playerSide = humanRole === 'host' ? 0 : 1;
          const joiningSupply = raw.map.garrisons.filter(g => g.faction === 'player').flatMap(g => g.composition).reduce((total, u) => total + q.UnitDefinition.get(u.unit).supply * u.count, 0);
          check(sim.supplyCap(playerSide) - sim.supplyUsed(playerSide) - joiningSupply >= 15, 'Opening supply covers every joining troop and at least 15 reinforcement supply');
          check(sim.buildings.filter(b => b.side === playerSide && b.type === 'supply').every(b => b.complete && b.alive), 'Opening depots are completed, living buildings');
          const session = { role, sim, draft, matchConfig: { campaignScenario: mission }, getPendingCommandTickets: () => [], get confirmedGameTick() { return sim.tick; } };
          const bot = new q.BotController(session, { role });
          try {
            check(bot.campaignOffense.config() === mission.enemy.offense, 'Enemy role gets mission offense');
            const humanBot = new q.BotController({ ...session, role: humanRole }, { role: humanRole });
            check(!humanBot.campaignOffense.config(), 'Human role never gets enemy campaign offense'); humanBot.stop();
            const normalBot = new q.BotController({ ...session, matchConfig: {} }, { role });
            check(!normalBot.campaignOffense.config(), 'Regular AI unaffected'); normalBot.stop();
            if (i === 1) {
              // A filled production state must block only the mission enemy.
              // Actual tryBuild/placement/reservation runs against a fresh view.
              const canReserveAtCapacity = probe => {
                const state = sim.snapshot(), type = probe.productionBuildingType('swordsman');
                state.wallet[probe.side] = 10000; state.gasWallet[probe.side] = 10000;
                for (let n = 0; n < mission.enemy.offense.productionLimit; n++) state.buildings.push({ id: `capacity-fixture-${n}`, side: probe.side, type, produceType: 'swordsman', alive: true, complete: n % 2 === 0, x: 50 + n * 100, y: 50 });
                const view = probe.commandExecutor.begin(state);
                return probe.tryBuild(view, probe.perceive(view), type, 'swordsman');
              };
              check(!canReserveAtCapacity(bot), 'Enemy cannot reserve beyond completed/under-construction cap');
              const human = new q.BotController({ ...session, role: humanRole }, { role: humanRole });
              try { check(canReserveAtCapacity(human), 'Human-role AI can build beyond enemy-only cap'); } finally { human.stop(); }
              const uncappedMission = q.CampaignMissionDefinition.normalize({ ...candidate, enemy: { ...candidate.enemy, offense: { ...candidate.enemy.offense, productionLimit: null } } });
              const uncapped = new q.BotController({ ...session, matchConfig: { campaignScenario: uncappedMission } }, { role });
              try { check(canReserveAtCapacity(uncapped), 'Absent cap permits another real production reservation'); } finally { uncapped.stop(); }
            }
            const state = sim.snapshot(), p = bot.perceive(state), offense = bot.campaignOffense;
            const combat = p.ownArmy.find(u => q.UnitDefinition.get(u.type)?.role !== 'support');
            if (combat) {
              const candidates = [combat, { ...combat, id: 'script', scenarioGroupId: 'authored-wave' }, { ...combat, id: 'camp', campId: 'garrison' }, { ...combat, id: 'support', type: 'medic' }];
              check(offense.combat({ ownArmy: candidates }).length === 1, 'Script forces, garrisons and support excluded from muster');
            }
            if (mission.enemy.offense.counterattackPoints.length && offense.combat(p).length) {
              const cp = p.capturePoints.find(point => mission.enemy.offense.counterattackPoints.includes(point.id));
              cp.owner = 1 - bot.side; cp.enabled = false;
              offense.lastTick = state.tick; offense.phase = 'assault'; offense.target = { id: 'main', x: sim.base(1 - bot.side).x, y: sim.base(1 - bot.side).y }; offense.members = offense.combat(p).map(u => u.id);
              const redirected = offense.action(state, p, { situation: { underThreat: false } });
              check(redirected?.target.capturePointId === cp.id, 'New player ownership redirects main assault to occupied outpost');
            }
            offense.lastTick = state.tick; offense.phase = 'assault'; offense.target = { id: 'main', x: sim.base(1 - bot.side).x, y: sim.base(1 - bot.side).y }; offense.members = offense.combat(p).map(u => u.id);
            offense.action(state, p, { situation: { underThreat: true } });
            check(offense.phase === 'gather' && !offense.pending && offense.readyAt > state.tick, 'Defense interrupts assault and requires regroup');
            out.push({ mission: i + 1, humanRole, counterattackPoints: mission.enemy.offense.counterattackPoints });
          } finally { bot.stop(); sim.dispose('offense-contract'); }
        }
      }
      return out;
    }, entries); save();
    // The same scheduled command/receipt path used by a local match. No direct
    // calls to offense.accept or synthetic wave increments in integration probes.
    const fixtures = [{ index: 1, kind: 'rebuild' }, { index: 4, kind: 'capture' }, { index: 6, kind: 'capture' }, { index: 1, kind: 'delayed' }, { index: 1, kind: 'production' }];
    for (const fixture of fixtures.filter(f => !process.env.QA_OFFENSE_FIXTURES || process.env.QA_OFFENSE_FIXTURES.split(',').includes(f.kind))) {
      const evidence = await page.evaluate(({ entry, fixture }) => {
        const q = window.__offenseQA, check = (ok, message) => { if (!ok) throw Error(`${entry.id}/${fixture.kind}: ${message}`); };
        const mission = q.CampaignMissionDefinition.normalize(entry.mission), role = mission.playerRole === 'host' ? 'guest' : 'host', side = role === 'host' ? 0 : 1;
        const draft = { decks: { [mission.playerRole]: mission.player.availableUnits, [role]: mission.enemy.availableUnits }, defenseCards: { host: [], guest: [] } };
        const sim = q.StrategySim.createForMatch({ draft, seed: mission.seed, rules: q.GameRuleDefinition.current, campaignScenario: mission });
        let sequence = 0, firstFlag = null, rejected = false; const tickets = new Map(), commands = [], receipts = [];
        const session = { role, sim, draft, matchConfig: { campaignScenario: mission }, netcodeSession: { resimulating: false }, get confirmedGameTick() { return sim.tick; }, inputAvailable: () => true,
          getPendingCommandTickets: () => [...tickets.values()], command(action) {
            const attack = action.type === 'SET_FLAG' && Math.hypot(action.x - sim.base(1 - side).x, action.y - sim.base(1 - side).y) < 90;
            if (fixture.kind === 'delayed' && attack && !rejected) { rejected = true; commands.push({ tick: sim.tick, rejected: true, action }); return false; }
            const ticket = { sequence: ++sequence, actor: role, key: q.StableSerializationUtil.stableStringify(action), action: structuredClone(action), submittedTick: sim.tick };
            tickets.set(sequence, ticket); this.lastCommandTicket = ticket; commands.push({ tick: sim.tick, action: ticket.action });
            const delay = fixture.kind === 'delayed' && attack && !firstFlag || fixture.kind === 'production' && action.type === 'BUILD' && action.produceType ? sim.tps * 3 : 1;
            if (attack && !firstFlag) firstFlag = { tick: sim.tick, due: sim.tick + delay };
            const tick = sim.tick + delay, scheduled = sim.scheduled.get(tick) || [];
            scheduled.push({ seq: sequence, netcodeSequence: sequence, actor: role, action: ticket.action }); sim.scheduled.set(tick, scheduled); return true;
          } };
        const bot = new q.BotController(session, { role }), initialIds = new Set(sim.units.map(u => u.id));
        let routed = false, firstWave = null, target = null, initialDistance = null, closestDistance = Infinity, recaptured = false, neutralSeen = false, winner = null;
        let peakProductionSlots = 0, sawConstruction = false, sawReservation = false, destroyedProducer = null, exhaustedProducer = null, paidReplacement = false;
        const limit = mission.enemy.offense.productionLimit;
        const isProducer = b => b.side === side && q.BuildingDefinition.get(b.type)?.isProductionBuilding;
        const waves = [], completed = new Map();
        try {
          if (fixture.kind === 'capture') {
            target = sim.capturePoints.find(cp => mission.enemy.offense.counterattackPoints.includes(cp.id));
            check(target, 'Configured counterattack objective exists'); sim.spawnOutpost(target, 1 - side);
            check(!target.enabled && target.owner === 1 - side, 'Real owned outpost disables capture until destroyed');
            // Controlled ownership/path fixture removes hostile mobile blockers,
            // so movement and actual capture completion can be checked deterministically.
            for (const unit of sim.units) if (unit.side !== side && !q.UnitDefinition.get(unit.type)?.economyWorker) { unit.alive = false; unit.hp = 0; }
          }
          for (let n = 0; n < 300 * sim.tps; n++) {
            if (sim.tick % Math.max(1, Math.round(sim.tps / 2)) === 0) bot.handleSnapshot(sim.snapshot());
            // Observe after normal receipt reconciliation: a BUILD transitioning
            // from reservation to actual construction occupies one slot.
            bot.commandExecutor.reconcile({ tick: sim.tick });
            const activeProducers = sim.buildings.filter(b => b.alive !== false && isProducer(b));
            const reservedProducers = bot.commandExecutor.outstanding().filter(e => e.action.type === 'BUILD' && q.BuildingDefinition.get(e.action.building)?.isProductionBuilding);
            peakProductionSlots = Math.max(peakProductionSlots, activeProducers.length + reservedProducers.length);
            sawConstruction ||= activeProducers.some(b => !b.complete); sawReservation ||= reservedProducers.length > 0;
            if (limit != null) check(activeProducers.length + reservedProducers.length <= limit, 'Active construction plus outstanding production never exceeds profile limit');
            if (fixture.kind === 'production') {
              // Keep the economic fixture alive and unblocked by supply. Losses
              // are explicit fixture actions, not a claim about battle balance.
              for (const u of sim.units) if (u.side === side && !q.UnitDefinition.get(u.type)?.economyWorker && !u.scenarioGroupId && !u.campId) { u.alive = false; u.hp = 0; }
              const producing = activeProducers.find(b => b.complete && b.productionBatchesCompleted > 0);
              if (!destroyedProducer && producing) { destroyedProducer = { id: producing.id, tick: sim.tick }; producing.alive = false; producing.hp = 0; sim.markBuildingSpatialDirty(); }
              const exhausted = sim.buildings.find(b => isProducer(b) && b.id !== destroyedProducer?.id && b.alive === false && b.productionRemaining === 0);
              if (!exhaustedProducer && exhausted) exhaustedProducer = { id: exhausted.id, tick: sim.tick };
              paidReplacement = !!exhaustedProducer && receipts.some(r => r.type === 'BUILD' && r.applied && r.tick > exhaustedProducer.tick) && activeProducers.some(b => b.id !== exhaustedProducer.id && b.id !== destroyedProducer.id && b.productionBatchesCompleted > 0);
            }
            const offense = bot.campaignOffense;
            if (fixture.kind === 'delayed' && firstFlag && sim.tick <= firstFlag.due) check(offense.wave === 0, 'Queued or rejected flag cannot create phantom assault');
            if (offense.wave > waves.length) {
              const record = { tick: sim.tick, wave: offense.wave, target: offense.target, members: offense.members.slice() }; waves.push(record);
              if (!firstWave) firstWave = record;
              if (fixture.kind === 'rebuild' && !routed) {
                for (const unit of sim.units) if (unit.side === side && !q.UnitDefinition.get(unit.type)?.economyWorker && !unit.scenarioGroupId && !unit.campId) { unit.alive = false; unit.hp = 0; }
                routed = true;
              }
            }
            winner = sim.step();
            for (const r of sim.commandReceipts) if (tickets.has(r.netcodeSequence)) { receipts.push(structuredClone(r)); tickets.delete(r.netcodeSequence); }
            for (const b of sim.buildings) if (b.side === side && b.produceType && b.productionBatchesCompleted > 0) completed.set(b.id, { id: b.id, unit: b.produceType, batches: b.productionBatchesCompleted });
            if (target && firstWave) {
              if (target.owner === null) { neutralSeen = true; check(offense.target?.capturePointId === target.id, 'Outpost destruction keeps assault aimed at neutral capture center'); }
              const army = sim.units.filter(u => u.alive && firstWave.members.includes(u.id));
              const distance = army.length ? Math.min(...army.map(u => Math.hypot(u.x - target.x, u.y - target.y))) : Infinity;
              if (initialDistance == null) initialDistance = distance; closestDistance = Math.min(closestDistance, distance);
              if (target.owner === side) { recaptured = true; if (offense.phase === 'gather') break; }
            }
            if (fixture.kind === 'rebuild' && waves.length >= 2 || fixture.kind === 'delayed' && waves.length >= 1) break;
            if (fixture.kind === 'production' && paidReplacement) break;
            if (winner) break;
          }
          if (fixture.kind !== 'production') check(waves.length >= 1, `At least one confirmed assault (${JSON.stringify({ tick: sim.tick, winner, phase: bot.campaignOffense.phase, commands, completed: [...completed.values()] })})`);
          if (fixture.kind === 'production') {
            check(limit != null && sawReservation && sawConstruction, 'Cap tested with real pending commands and under-construction producers');
            check(destroyedProducer && exhaustedProducer && paidReplacement, `Destroyed and naturally exhausted producers free slots for paid replacements (${JSON.stringify({ destroyedProducer, exhaustedProducer, paidReplacement, tick: sim.tick })})`);
          }
          check(JSON.stringify(sim.decks[0]) === JSON.stringify(sim.decks[1]), 'Offense leaves both production card rosters equal');
          if (fixture.kind === 'rebuild') {
            check(waves.length >= 2, 'Routed army is rebuilt for second assault');
            check(waves[1].members.every(id => !initialIds.has(id)), 'Second assault contains newly produced army');
            check(completed.size > 0 && receipts.some(r => r.type === 'BUILD' && r.applied), 'Real paid production buildings completed troop batches');
          }
          if (fixture.kind === 'capture') {
            check(firstWave.target.capturePointId === target.id, 'Attack targets the newly owned capture point');
            check(closestDistance < initialDistance - 50, 'Real dispatched units move toward capture center');
            check(recaptured, 'Real capture simulation reclaims point');
            check(neutralSeen, 'Actual outpost destruction exposes neutral recapture phase');
            check(bot.campaignOffense.phase === 'gather', 'Recovered objective ends assault and regroups');
          }
          if (fixture.kind === 'delayed') check(rejected && firstFlag && receipts.some(r => r.type === 'SET_FLAG' && r.applied), 'Rejected submission retries and delayed flag confirms');
          return { mission: fixture.index + 1, fixture: fixture.kind, limitation: 'Controlled casualty/ownership/transport fixtures; not a full-play difficulty benchmark.', tick: sim.tick, waves, producers: [...completed.values()], initialDistance, closestDistance, recaptured, neutralSeen, rejected, firstFlag, production: { limit, peakProductionSlots, sawConstruction, sawReservation, destroyedProducer, exhaustedProducer, paidReplacement } };
        } finally { bot.stop(); sim.dispose('offense-integration'); }
      }, { entry: entries[fixture.index], fixture });
      result.integration.push(evidence); save(); console.log(JSON.stringify(evidence));
    }
    await page.close();
    const selected = (process.env.QA_OFFENSE_UI || '5,7').split(',').map(Number);
    for (const [index, entry] of entries.entries()) {
      if (!selected.includes(index + 1)) continue;
      const ui = await newPage();
      await ui.locator('#gameStartBtn').click(); await ui.locator('#campaignBtn').click();
      await ui.locator(`[data-mission-id="${entry.id}"]`).click(); await ui.locator('#campaignStartBtn').click();
      await ui.waitForFunction(() => window.__offenseQA.MatchLifecycle.singleMatch?.bot?.campaignOffense?.wave > 0, null, { timeout: 180000 });
      const live = await ui.evaluate(() => {
        const q = window.__offenseQA, match = q.MatchLifecycle.singleMatch, bot = match.bot, session = match.sessions[bot.role], o = bot.campaignOffense;
        return { id: session.sim.campaignScenario.missionId, tick: session.sim.tick, backend: q.ActiveViewState.renderer.backend, transportOpen: session.transportConnected, phase: o.phase, wave: o.wave, target: o.target, flag: session.sim.flags[bot.side], ledger: bot.commandExecutor.history.filter(h => h.action?.type === 'SET_FLAG') };
      });
      assert.equal(live.id, entry.id); assert.equal(live.backend, 'WebGL'); assert.equal(live.transportOpen, true); assert.ok(live.wave > 0);
      assert.ok(Math.hypot(live.flag.x - live.target.x, live.flag.y - live.target.y) < 90);
      await ui.screenshot({ path: path.join(output, `${entry.id}-offense-ui.png`) });
      await ui.locator('#matchMenuBtnGame').click(); await ui.locator('#matchMenuSurrenderBtn').click(); await ui.locator('#result').waitFor({ state: 'visible' });
      await ui.locator('#rematchBtn').click(); await ui.locator('#gameStartBtn').waitFor({ state: 'visible' });
      result.ui.push({ ...live, returnedToLobby: true }); save(); await ui.close();
    }
    assert.deepEqual(result.pageErrors, []); console.log(JSON.stringify({ contracts: result.contracts.length, integration: result.integration.length, ui: result.ui.length, pageErrors: result.pageErrors }));
  } finally { save(); await browser.close(); }
}
run().catch(e => { console.error(e.stack); process.exitCode = 1; });
