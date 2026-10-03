const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium: nativeChromium } = require('playwright');
const chromium = require('./netcode-qa-module.cjs').wrapChromium(nativeChromium);

// Accelerated legal-command benchmark, not a renderer/frame-time test. No state,
// resource, unit, mission-trigger, seed or simulation-timing overrides are used.
// Contracts are finite paid production buildings, NOT a requested free unit count.
// QA_BALANCE_PLAN=swordsman or a comma-separated cyclic mixed composition.
// QA_BALANCE_CASES=1:3,7:6:east-center-west selects mission:budget[:route].
// QA_BALANCE_GATHER=1 groups finite production before the final base rally.
// QA_BALANCE_ACTIVE=3 / QA_BALANCE_WORKERS=8 maintains paid production/workers.
// QA_BALANCE_EXPECT=win|loss makes selected outcomes assertions; timeout fails.
// QA_BALANCE_ACTIVE=1/2/3 renews that many simultaneous paid production contracts
// up to QA_BALANCE_CONTRACTS (e.g.100); continuous mode disables finite gathering.
// QA_BALANCE_WORKERS=8/10 optionally trains/replaces workers legally; unset keeps
// the authored starting workers without training, including after casualties.
// Every player command has an application receipt and can be replayed in GameSession.
const root = process.argv[2] ? path.dirname(path.resolve(process.argv[2])) : path.resolve(__dirname, '..');
const output = path.join(root, '.qa/campaign-balance');
const numbers = (s, fallback) => (s || fallback).split(',').map(Number);

// Serialized into either the probe page or a real GameSession UI page. Only the
// supplied session.command path changes. Command receipts are authoritative.
function createPlayerDriver(q, session, mission, policy) {
  const sim = session.sim, role = session.role, side = role === 'host' ? 0 : 1;
  const bot = new q.BotController(session, { role });
  const budget = policy.budget || 0, plan = policy.plan || ['swordsman'];
  const activeLimit = Math.max(0, Math.floor(Number(policy.activeLimit) || 0));
  const workerTarget = Math.max(0, Math.floor(Number(policy.workerTarget) || 0));
  const attainable = new Set([...mission.player.availableUnits, ...mission.events.flatMap(e => e.actions.filter(a => a.type === 'unlockUnit' && a.side !== 'enemy').map(a => a.unit))]);
  const composition = plan.filter(id => attainable.has(id));
  const stages = [], receiptsSeen = new Set(), issued = new Map();
  let contracts = 0, targetKey = '', finalRallyTick = null, pendingFront = null, lastTarget = null;
  const spent = { mineral: 0, gas: 0, productionMineral: 0, productionGas: 0, workerMineral: 0 };
  const hasLesson = mission.events.some(e => e.actions.some(a => a.type === 'setFlag' && a.id === 'lessonComplete'));
  const hasFronts = mission.events.some(e => e.actions.some(a => a.type === 'setFlag' && a.id === 'frontsComplete'));
  const rescueEvent = mission.events.find(e => e.when?.type === 'enterRegion');
  const rescue = mission.regions[rescueEvent?.when?.region];
  const routeOrder = policy.route && policy.route !== 'nearest' ? policy.route.split(',') : null;
  function rememberTicket() {
    const ticket = session.lastCommandTicket;
    if (ticket) issued.set(ticket.sequence, structuredClone(ticket.action));
  }
  function observeReceipts(receipts) {
    for (const receipt of receipts || []) {
      const seq = receipt.netcodeSequence, action = issued.get(seq);
      if (receipt.actor !== role || receipt.tick > (session.confirmedGameTick ?? sim.tick) || !action || receiptsSeen.has(seq)) continue;
      receiptsSeen.add(seq);
      if (!receipt.applied) continue;
      if (action.type === 'TRAIN_WORKER') { const cost = q.UnitDefinition.get('worker').mineralCost; spent.mineral += cost; spent.workerMineral += cost; }
      if (action.type !== 'BUILD') continue;
      const cost = q.BuildingDefinition.resourceCost(action.building, action.produceType);
      spent.mineral += cost.mineral; spent.gas += cost.gas;
      if (action.produceType) { contracts++; spent.productionMineral += cost.mineral; spent.productionGas += cost.gas; }
    }
  }
  function route(snapshot) {
    const flags = sim.campaignScriptRuntime.scenario.flags;
    for (const key of ['lessonComplete', 'frontsComplete']) if (flags[key] && !stages.some(s => s.stage === key)) stages.push({ stage: key, tick: sim.tick, seconds: sim.tick / sim.tps });
    let key, x, y;
    if (hasLesson && !flags.lessonComplete) { key = 'rescue'; x = rescue.center[0] * sim.world.width; y = rescue.center[1] * sim.world.height; }
    else if (hasFronts && !flags.frontsComplete) {
      if (!pendingFront || sim.capturePoints.find(p => p.id === pendingFront)?.owner === side) {
        const remaining = sim.capturePoints.filter(p => p.owner !== side);
        if (routeOrder) remaining.sort((a, b) => routeOrder.indexOf(a.id) - routeOrder.indexOf(b.id));
        else {
          const army = snapshot.units.filter(u => u.alive !== false && u.side === side && !q.UnitDefinition.get(u.type)?.economyWorker);
          const base = sim.base(side), center = army.length ? { x: army.reduce((n,u) => n+u.x,0)/army.length, y: army.reduce((n,u) => n+u.y,0)/army.length } : base;
          remaining.sort((a,b) => Math.hypot(a.x-center.x,a.y-center.y)-Math.hypot(b.x-center.x,b.y-center.y));
        }
        pendingFront = remaining[0]?.id;
      }
      const cp = sim.capturePoints.find(p => p.id === pendingFront); if (!cp) return;
      key = cp.id; x = cp.x; y = cp.y;
    } else {
      if (!stages.some(s => s.stage === 'prerequisitesComplete')) stages.push({ stage: 'prerequisitesComplete', tick: sim.tick, seconds: sim.tick / sim.tps });
      const army=snapshot.units.filter(u=>u.alive!==false&&u.side===side&&!q.UnitDefinition.get(u.type)?.economyWorker);
      const assembled=!lastTarget||army.filter(u=>Math.hypot(u.x-lastTarget.x,u.y-lastTarget.y)<600).length>=Math.ceil(army.length*.8);
      if (policy.gather && finalRallyTick==null && !activeLimit && budget > 0 && (contracts < budget || snapshot.buildings.some(b => b.side === side && b.alive !== false && b.produceType && b.productionRemaining > 0) || !assembled)) {
        if (!stages.some(s => s.stage === 'muster')) stages.push({ stage: 'muster', tick: sim.tick, seconds: sim.tick / sim.tps });
        // Keep the last genuine objective flag while finite contracts finish.
        return;
      }
      key = 'enemy-base'; const base = mission.map.spawns[side ? 'host' : 'guest']; x = base[0] * sim.world.width; y = base[1] * sim.world.height;
    }
    if (key !== targetKey && session.command({ type: 'SET_FLAG', x, y })) {
      rememberTicket(); targetKey = key; lastTarget={x,y}; stages.push({ stage: `rally:${key}`, tick: sim.tick, seconds: sim.tick / sim.tps });
      if (key === 'enemy-base') finalRallyTick = sim.tick;
    }
  }
  function economy(snapshot) {
    const state = bot.commandExecutor.begin(snapshot); bot.lastSnapshot = state;
    try {
      const p = bot.perceive(state);
      const pending = session.getPendingCommandTickets?.() || [];
      if (pending.some(t => ['BUILD', 'TRAIN_WORKER'].includes(t.action.type))) return;
      const desired = composition[contracts % composition.length];
      const unit = bot.deck().includes(desired) && bot.productionPrerequisitesReady(state, desired) ? desired : null;
      const active = state.buildings.filter(b => b.side === side && b.alive !== false && b.produceType && b.productionRemaining > 0).length;
      const workerDef = q.UnitDefinition.get('worker');
      const workersNeeded = workerTarget > p.ownWorkers.length + bot.queuedWorkerCount(state);
      const supply = q.BuildingDefinition.forRole('supply');
      const pendingSupply = state.buildings.some(b => b.side === side && b.alive !== false && b.type === supply && !b.complete);
      if ((contracts < budget || active || workersNeeded) && !pendingSupply && bot.supplyCap(state) - bot.supplyUsed(state) < 6 && bot.tryBuild(state, p, supply)) return;
      if (workersNeeded && state.wallet[side] >= workerDef.mineralCost && bot.supplyCap(state) - bot.supplyUsed(state) >= workerDef.supply) {
        const base = bot.workerBases(state).find(b => !(b.queue || []).some(item => item.kind === 'workerProduction'));
        if (base && bot.issueCommand({ type: 'TRAIN_WORKER', buildingId: base.id })) return;
      }
      if (contracts >= budget || !unit || activeLimit && active >= activeLimit) return;
      const cost = q.UnitDefinition.productionCost(unit);
      if (cost.gas > (state.gasWallet?.[side] || 0)) {
        const extractorType = q.BuildingDefinition.forRole('gasExtractor');
        const extractor = state.buildings.find(b => b.side === side && b.alive !== false && b.type === extractorType);
        if (!extractor) { bot.tryBuild(state, p, extractorType); return; }
        const base = bot.workerBases(state)[0];
        if (extractor.complete && base && base.gasWorkerTarget !== 2) bot.issueCommand({ type: 'SET_GAS_WORKERS', buildingId: base.id, target: 2 });
        return;
      }
      bot.tryBuild(state, p, bot.productionBuildingType(unit), unit, null, { allowProductionDensity: true });
    } finally { bot.commandExecutor.flush(); rememberTicket(); }
  }
  return { stages, spent, hasLesson, hasFronts, observeReceipts,
    get contracts() { return contracts; }, get finalRallyTick() { return finalRallyTick; },
    handleSnapshot(snapshot) { observeReceipts(snapshot.commandReceipts || sim.commandReceipts); route(snapshot); if (budget > 0 || workerTarget > 0) economy(snapshot); },
    stop() { bot.stop(); }
  };
}
async function run() {
  fs.mkdirSync(output, { recursive: true });
  const missions = numbers(process.env.QA_BALANCE_MISSIONS, '1');
  const budgets = numbers(process.env.QA_BALANCE_CONTRACTS, '0');
  const cases=process.env.QA_BALANCE_CASES?process.env.QA_BALANCE_CASES.split(',').map(s=>{const [mission,budget,route]=s.split(':');return{number:Number(mission),budget:Number(budget),route:route?.replaceAll('-',',')}}):missions.flatMap(number=>budgets.map(budget=>({number,budget})));
  const maxSeconds = Number(process.env.QA_BALANCE_MAX_SECONDS || 600);
  const plan = (process.env.QA_BALANCE_PLAN || 'swordsman,pikeman,archer,skirmisher,dandelion,medic').split(',');
  const route = process.env.QA_BALANCE_ROUTE || 'nearest';
  const expectation=process.env.QA_BALANCE_EXPECT||null;
  if(expectation&&!['win','loss'].includes(expectation))throw Error('QA_BALANCE_EXPECT must be win or loss');
  const activeLimit = Number(process.env.QA_BALANCE_ACTIVE || 0), workerTarget = Number(process.env.QA_BALANCE_WORKERS || 0);
  let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const end = html.lastIndexOf('})();');
  if (end < 0) throw Error('Game module export boundary missing');
  html = html.slice(0, end) + 'window.__balanceQA={CampaignBuiltinCatalog,CampaignMissionDefinition,StrategySim,BotController,GameRuleDefinition,UnitDefinition,BuildingDefinition,StableSerializationUtil};window.__balanceQA.createPlayer=' + createPlayerDriver.toString() + ';' + html.slice(end);
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: true });
  const gather = !activeLimit && process.env.QA_BALANCE_GATHER === '1';
  const candidateHash=createHash('sha256').update(fs.readFileSync(path.join(root,'index.html'))).update(fs.readFileSync(path.join(root,'campaign/campaigns.js'))).digest('hex');
  const result = { candidate: root, candidateHash, cases, plan, route, gather, activeLimit, workerTarget, maxSeconds, expectation, runs: [], pageErrors: [] };
  const caseLabel=cases.map(c=>`${c.number}x${c.budget}${c.route?'-'+c.route.replaceAll(',','-'):''}`).join('_');
  const suffix = `${caseLabel}-${plan.join('-')}-${route.replaceAll(',', '-')}-${gather ? 'gather' : 'immediate'}-active${activeLimit}-workers${workerTarget}-${candidateHash.slice(0,8)}`;
  const save = () => fs.writeFileSync(path.join(output, `result-${suffix}.json`), JSON.stringify(result, null, 2));
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => result.pageErrors.push(e.message));
    await page.route('http://campaign-balance.local/', r => r.fulfill({ contentType: 'text/html', body: html }));
    await page.route('http://campaign-balance.local/campaign/campaigns.js*', r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(root, 'campaign/campaigns.js'), 'utf8') }));
    await page.goto('http://campaign-balance.local/');
    await page.waitForFunction(() => window.__balanceQA);
    const entries = await page.evaluate(async () => (await window.__balanceQA.CampaignBuiltinCatalog.manifest()).campaigns.flatMap(c => c.missions));
    for (const {number,budget,route:caseRoute} of cases) {
      const evidence = await page.evaluate(async ({ entry, number, budget, maxSeconds, plan, route, gather, activeLimit, workerTarget }) => {
        const q = window.__balanceQA, mission = q.CampaignMissionDefinition.normalize(entry.mission);
        const role = mission.playerRole, side = role === 'host' ? 0 : 1, enemyRole = side ? 'host' : 'guest';
        const draft = { decks: { [role]: mission.player.availableUnits, [enemyRole]: mission.enemy.availableUnits }, defenseCards: { host: [], guest: [] } };
        const sim = q.StrategySim.createForMatch({ draft, seed: mission.seed, rules: q.GameRuleDefinition.current, campaignScenario: mission });
        let sequence = 0, winner = null, maxArmy = 0, maxWorkers = 0, maxActiveContracts = 0;
        const actions = [], receipts = [], tickets = new Map(), production = new Map(), producedByType = {}, productionEvents = [];
        function session(actor) { return { role: actor, sim, draft, matchConfig: { campaignScenario: mission }, netcodeSession: { resimulating: false },
          get confirmedGameTick() { return sim.tick; }, inputAvailable: () => true,
          getPendingCommandTickets: () => [...tickets.values()].filter(t => t.actor === actor),
          command(action) {
            const ticket = { sequence: ++sequence, actor, key: q.StableSerializationUtil.stableStringify(action), action: structuredClone(action), submittedTick: sim.tick };
            tickets.set(sequence, ticket); this.lastCommandTicket = ticket;
            actions.push({ tick: sim.tick, sequence, actor, action: ticket.action });
            const tick = sim.tick + 1, scheduled = sim.scheduled.get(tick) || [];
            scheduled.push({ seq: sequence, netcodeSequence: sequence, actor, action: ticket.action }); sim.scheduled.set(tick, scheduled); return true;
          }
        }; }
        const playerSession = session(role), enemy = new q.BotController(session(enemyRole), { role: enemyRole });
        const player = q.createPlayer(q, playerSession, mission, { budget, plan, route, gather, activeLimit, workerTarget });
        const started = performance.now();
        const initialArmy = sim.units.filter(u => u.alive && u.side === side && !q.UnitDefinition.get(u.type)?.economyWorker).length;
        try {
          for (let n = 0; n < maxSeconds * sim.tps && !winner; n++) {
            if (sim.tick % Math.max(1, Math.round(sim.tps / 2)) === 0) {
              const state = sim.snapshot(); enemy.handleSnapshot(state); player.handleSnapshot(state);
            }
            winner = sim.step();
            for (const receipt of sim.commandReceipts) {
              const ticket = tickets.get(receipt.netcodeSequence); if (!ticket) continue;
              receipts.push({ ...structuredClone(receipt), actor: ticket.actor, tick: sim.tick }); tickets.delete(ticket.sequence);
            }
            player.observeReceipts(sim.commandReceipts);
            for (const e of sim.events) if (e.type === 'productionBatchComplete' && e.side === side) {
              producedByType[e.unit] = (producedByType[e.unit] || 0) + e.count; productionEvents.push({ tick: sim.tick, ...structuredClone(e) });
            }
            for (const b of sim.buildings) if (b.side === side && b.produceType) production.set(b.id, { id: b.id, type: b.produceType, count: b.productionTotal - b.productionRemaining, complete: b.complete, alive: b.alive });
            maxArmy = Math.max(maxArmy, sim.units.filter(u => u.alive && u.side === side && !q.UnitDefinition.get(u.type)?.economyWorker).length);
            maxWorkers = Math.max(maxWorkers, sim.units.filter(u => u.alive && u.side === side && q.UnitDefinition.get(u.type)?.economyWorker).length);
            maxActiveContracts = Math.max(maxActiveContracts, sim.buildings.filter(b => b.alive !== false && b.side === side && b.produceType && b.productionRemaining > 0).length);
            if (n % 100 === 99) await new Promise(resolve => setTimeout(resolve, 0));
          }
          const scenario = sim.campaignScriptRuntime.scenario, prerequisitesComplete = (!player.hasLesson || !!scenario.flags.lessonComplete) && (!player.hasFronts || !!scenario.flags.frontsComplete);
          return { mission: number, id: entry.id, playerRole:role, budget, plan, route, activeLimit, workerTarget, initialArmy, startingWorkers: mission.player.startingWorkers,
            contracts: player.contracts, spent: player.spent, producedByType, productionEvents, production: [...production.values()], maxArmy, maxWorkers, maxActiveContracts, winner, missionResult: scenario.result,
            prerequisitesComplete, stageOutcome: prerequisitesComplete ? 'after-prerequisites' : 'prerequisites-incomplete', stages: player.stages, finalRallyTick: player.finalRallyTick,
            seconds: sim.tick / sim.tps, wallMs: Math.round(performance.now() - started),
            playerBaseHp: sim.base(side)?.hp ?? 0, enemyBaseHp: sim.base(1 - side)?.hp ?? 0,
            playerArmyRemaining: sim.units.filter(u => u.alive && u.side === side && !q.UnitDefinition.get(u.type)?.economyWorker).length,
            flags: structuredClone(scenario.flags), objectives: structuredClone(scenario.objectives), actions, receipts,
            limitations: 'Accelerated StrategySim with actual BotController and legal scheduled commands. Optional worker target uses paid training; otherwise no worker training. No player spells, upgrades or combat micro. Continuous production disables finite gathering. UI playback is a separate required check. Timeout is inconclusive, not defeat.' };
        } finally { player.stop(); enemy.stop(); sim.dispose('campaign-balance'); }
      }, { entry: entries[number - 1], number, budget, maxSeconds, plan, route:caseRoute||route, gather, activeLimit, workerTarget });
      result.runs.push(evidence); save();
      console.log(JSON.stringify({ ...evidence, actions: evidence.actions.length, receipts: evidence.receipts.length, objectives: undefined, production: undefined, productionEvents:evidence.productionEvents.length }));
      if(expectation==='win'&&(!evidence.prerequisitesComplete||evidence.winner!==evidence.playerRole))throw Error(`Mission ${number}: expected a genuine mission victory`);
      if(expectation==='loss'&&(!evidence.winner||evidence.winner===evidence.playerRole||evidence.winner==='draw'))throw Error(`Mission ${number}: expected defeat; timeout is inconclusive`);
    }
    if(result.pageErrors.length)throw Error(result.pageErrors.join('\n'));
  } finally { save(); await browser.close(); }
}
module.exports = { createPlayerDriver };
if (require.main === module) run().catch(error => { console.error(error.stack); process.exitCode = 1; });
