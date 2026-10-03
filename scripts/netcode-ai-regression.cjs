const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium: nativeChromium } = require('playwright');
const chromium = require('./netcode-qa-module.cjs').wrapChromium(nativeChromium);

// Exercise the production AI ledger against the public GameSession ticket facade.
// Receipt fixtures model the SDK actor-local sequence independently of replay seq.
// Actual StrategySim applies the worker/research commands in the last case.
const htmlPath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'index.html');

async function run() {
  let html = fs.readFileSync(htmlPath, 'utf8');
  for (const [, attributes, source] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!attributes.includes('application/json') && !attributes.includes('src=')) new vm.Script(source);
  }
  const end = html.lastIndexOf('})();');
  assert.ok(end >= 0, 'Application IIFE exists');
  html = html.slice(0, end) + `
    window.__netcodeAiQA = { AiCommandExecutor, BotController, StrategySim,
      StableSerializationUtil, StateValue, BuildingDefinition, UnitDefinition, AiMacroExecutor, WORKER_COST, WORKER_QUEUE_LIMIT };
  ` + html.slice(end);
  const browser = await chromium.launch({
    channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('http://netcode-ai-qa.local/**', route => route.fulfill({
      status: 200, contentType: 'text/html', body: html
    }));
    await page.goto('http://netcode-ai-qa.local/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__netcodeAiQA);
    const results = await page.evaluate(() => {
      const { AiCommandExecutor, BotController, StrategySim, StableSerializationUtil,
        StateValue, BuildingDefinition, UnitDefinition, AiMacroExecutor, WORKER_COST, WORKER_QUEUE_LIMIT } = window.__netcodeAiQA;
      const check = (condition, message) => { if (!condition) throw Error(message); };
      const equal = (actual, expected, message) => check(actual === expected, `${message}: ${actual} != ${expected}`);
      const clone = value => StateValue.copy(value);
      const draft = { decks: { host: ['swordsman'], guest: ['swordsman'] }, defenseCards: { host: [], guest: [] } };
      const live = new StrategySim(draft, 8);
      live.wallet = [1000, 1000]; live.gasWallet = [1000, 1000];
      const baseline = live.snapshot(); baseline.tick = 12;
      const results = [];
      const test = (name, body) => { body(); results.push({ name, status: 'PASS' }); };
      function fixture(role = 'guest', sim = null) {
        const state = clone(baseline), side = role === 'host' ? 0 : 1;
        sim ||= { tick: state.tick, runtimeEpoch: 1, scheduled: new Map(), commandReceipts: [] };
        const tickets = new Map(); let sequence = 0;
        const session = { role, sim, confirmedGameTick: state.tick, netcodeSession: { resimulating: false },
          inputAvailable: () => true, getPendingCommandTickets: () => Array.from(tickets.values(), clone),
          command(action) {
            if (session.rejectSubmission) return false;
            const ticket = { sequence: ++sequence, actor: role,
              key: StableSerializationUtil.stableStringify(action), action: clone(action), submittedTick: sim.tick };
            tickets.set(ticket.sequence, ticket); session.lastCommandTicket = clone(ticket); return true;
          }
        };
        for (const obsolete of ['runtimeSeq', 'proposalSeq', 'pendingRuntimeProposals', 'deferredActions']) {
          Object.defineProperty(session, obsolete, { get() { throw Error(`AI read obsolete ${obsolete}`); } });
        }
        const bot = { role, side, session, supplyUsed: () => 0, supplyCap: () => 100 };
        return { state, bot, sim, session, tickets, executor: new AiCommandExecutor(bot) };
      }
      function submit(f, action) {
        f.executor.begin(f.state);
        check(f.executor.offer(action), `${action.type} admitted`);
        f.executor.flush();
        return f.executor.pending.at(-1);
      }
      function receipt(entry, tick, applied, seq = tick * 4096 + 1) {
        return { actor: entry.actor, netcodeSequence: entry.netcodeSequence,
          seq, tick, applied, type: entry.action.type, key: entry.key };
      }
      const flag = { type: 'SET_FLAG', x: 1200, y: 1600 };
      const build = { type: 'BUILD', building: 'barracks', x: 1300, y: 1700, produceType: 'swordsman' };
      try {
        test('Host and Guest local sequence 1 resolve distinct replay receipts', () => {
          const host = fixture('host'), guest = fixture('guest');
          const h = submit(host, flag), g = submit(guest, flag);
          equal(h.netcodeSequence, 1, 'Host SDK sequence'); equal(g.netcodeSequence, 1, 'Guest SDK sequence');
          const receipts = [receipt(h, 14, true, 14 * 4096 + 2), receipt(g, 14, false, 14 * 4096 + 1)];
          for (const f of [host, guest]) {
            f.tickets.clear(); f.sim.commandReceipts = receipts; f.session.confirmedGameTick = 14;
            f.executor.reconcile({ tick: 14 }); equal(f.executor.pending.length, 0, 'Matching receipt retires ticket');
          }
          equal(host.executor.stats.applied, 1, 'Host applied'); equal(guest.executor.stats.rejected, 1, 'Guest rejected');
          equal(host.executor.history[0].seq, 14 * 4096 + 2, 'Host canonical replay seq is recorded');
          equal(guest.executor.history[0].seq, 14 * 4096 + 1, 'Guest canonical replay seq is recorded');
        });
        test('Rewind retains an SDK pending command and its reservation exactly once', () => {
          const f = fixture(), entry = submit(f, build), cost = entry.cost.mineral;
          for (const tick of [10, 8, 4]) {
            f.sim.runtimeEpoch++; f.sim.tick = tick; f.state.tick = tick;
            const view = f.executor.begin(f.state);
            equal(f.executor.pending.length, 1, 'SDK ticket survives epoch');
            equal(view.wallet[1], f.state.wallet[1] - cost, 'Reservation debited once');
            check(!f.executor.offer(build), 'Rewind does not admit a duplicate build'); f.executor.flush();
          }
          f.tickets.clear(); f.sim.commandReceipts = [receipt(entry, 5, true)];
          f.session.confirmedGameTick = 5; f.executor.reconcile({ tick: 5 });
          equal(f.executor.stats.applied, 1, 'Actor-local receipt resolves after rewind');
          equal(f.executor.pending.length, 0, 'Executed ticket has no orphan');
        });
        test('Scheduled game command keeps its ticket across a runtime epoch', () => {
          const f = fixture(), entry = submit(f, flag);
          f.tickets.clear(); f.sim.scheduled.set(14, [{ actor: entry.actor, netcodeSequence: entry.netcodeSequence, action: flag }]);
          f.sim.runtimeEpoch++; f.executor.reconcile(f.state);
          equal(f.executor.pending.length, 1, 'Scheduled command is retained');
        });
        test('Speculative receipts retain command identities until confirmation', () => {
          const f = fixture(), entry = submit(f, build);
          f.tickets.clear(); f.sim.runtimeEpoch++; f.sim.commandReceipts = [receipt(entry, 14, false)];
          f.executor.reconcile({ tick: 20 });
          equal(f.executor.pending.length, 1, 'Unconfirmed receipt retains command');
          equal(f.executor.stats.rejected, 0, 'Unconfirmed rejection is not counted');
          f.session.confirmedGameTick = 14; f.executor.reconcile({ tick: 13 });
          equal(f.executor.pending.length, 1, 'Older decision state also limits receipt consumption');
          f.executor.reconcile({ tick: 14 }); f.executor.reconcile({ tick: 20 });
          equal(f.executor.pending.length, 0, 'Confirmed receipt retires command');
          equal(f.executor.stats.rejected, 1, 'Confirmed rejection is counted once');
        });
        test('An unrelated command with the same action does not retain an orphan', () => {
          const f = fixture(); submit(f, flag);
          f.tickets.clear(); f.session.command(flag); f.sim.runtimeEpoch++;
          f.executor.reconcile(f.state);
          equal(f.executor.pending.length, 0, 'Sequence 2 cannot retain sequence 1');
          equal(f.executor.history[0].status, 'reconciled-from-state', 'Missing command is reconciled explicitly');
        });
        test('Build, worker and research reservations preserve shared budget and capacity', () => {
          const f = fixture(), base = f.state.buildings.find(b => b.side === 1 && BuildingDefinition.get(b.type)?.isDropoff);
          const worker = { type: 'TRAIN_WORKER', buildingId: base.id }, research = { type: 'START_RESEARCH', research: 'attack' };
          f.executor.begin(f.state);
          for (const action of [build, worker, research]) check(f.executor.offer(action), `${action.type} admitted`);
          f.executor.flush();
          const mineral = f.executor.pending.reduce((sum, entry) => sum + entry.cost.mineral, 0);
          const gas = f.executor.pending.reduce((sum, entry) => sum + entry.cost.gas, 0);
          f.sim.runtimeEpoch++; const view = f.executor.begin(f.state);
          equal(f.executor.pending.length, 3, 'Three reservations survive once');
          equal(view.wallet[1], f.state.wallet[1] - mineral, 'Shared mineral budget');
          equal(view.gasWallet[1], f.state.gasWallet[1] - gas, 'Shared gas budget');
          check(!f.executor.offer(build), 'Duplicate build rejected');
          check(!f.executor.offer({ type: 'START_RESEARCH', research: 'armor' }), 'Shared combat research slot rejected');
          for (let i = 1; i < WORKER_QUEUE_LIMIT; i++) check(f.executor.offer(worker), 'Available worker queue slot admitted');
          check(!f.executor.offer(worker), 'Worker queue reserves its exact capacity');
          f.executor.flush();
          equal(f.executor.pending.filter(entry => entry.action.type === 'TRAIN_WORKER').length, WORKER_QUEUE_LIMIT, 'Worker reservations are unique submissions');
          const poor = fixture(); poor.state.wallet[1] = WORKER_COST - 1; poor.executor.begin(poor.state);
          check(!poor.executor.offer(worker), 'Resource shortage rejects worker');
          equal(poor.executor.stats.budgetRejected, 1, 'Budget rejection is recorded');
        });
        test('Accepted construction orders replace pending costs and survive worker travel', () => {
          const f = fixture(), entry = submit(f, build);
          const bot = Object.assign(Object.create(BotController.prototype), f.bot, { commandExecutor: f.executor });
          f.executor.bot = bot;
          equal(bot.productionContractCount(f.state, 'swordsman'), 1, 'Submitted build already occupies one planning contract');
          f.state.tick = 14; f.state.wallet[1] -= entry.cost.mineral; f.state.gasWallet[1] -= entry.cost.gas;
          f.state.constructionOrders = [{ id: 'order-test', type: build.building, side: 1, x: build.x, y: build.y, produceType: build.produceType, paidMineral: entry.cost.mineral, paidGas: entry.cost.gas }];
          f.sim.commandReceipts = [receipt(entry, 14, true)]; f.tickets.clear();
          const view = f.executor.begin(f.state);
          equal(view.wallet[1], f.state.wallet[1], 'Already-paid order never subtracts the accepted command price twice');
          equal(f.executor.pending.length, 1, 'Unconfirmed identity remains tracked for rollback');
          equal(bot.productionContractCount(view, 'swordsman'), 1, 'Receipt and order are counted once');
          equal(bot.productionPipelineRemaining(view, 'swordsman'), UnitDefinition.productionProfile('swordsman').totalUnits, 'Paid future production remains a planning commitment');
          check(f.executor.conflictsBuilding(build.building, build.x, build.y), 'Order reserves footprint before a building exists');
          f.session.confirmedGameTick = 14; f.executor.begin(f.state);
          equal(f.executor.pending.length, 0, 'Confirmed BUILD retires immediately without waiting for arrival');
          equal(bot.productionContractCount(f.state, 'swordsman'), 1, 'Order alone prevents missing-production duplicate');
          // Restoring before application must reserve the still-submitted command again.
          f.executor.pending = [entry]; f.sim.commandReceipts = []; f.sim.runtimeEpoch++; f.tickets.set(entry.netcodeSequence, { actor: entry.actor, sequence: entry.netcodeSequence });
          const prior = clone(baseline); prior.constructionOrders = [];
          equal(f.executor.begin(prior).wallet[1], prior.wallet[1] - entry.cost.mineral, 'Rollback before application restores unspent reservation');
        });
        test('Construction plans suppress duplicates without granting completed capabilities', () => {
          const f = fixture();
          const bot = Object.assign(Object.create(BotController.prototype), f.bot, { commandExecutor: f.executor });
          f.executor.bot = bot; bot.supplyCap = BotController.prototype.supplyCap;
          const type = BuildingDefinition.forRole('academy'), gasType = BuildingDefinition.forRole('gasExtractor'), supplyType = BuildingDefinition.forRole('supply');
          const worker = f.state.units.find(u => u.side === 1 && UnitDefinition.get(u.type)?.economyWorker);
          check(worker, 'Fixture owns a real worker'); worker.buildTargetId = 'academy-order';
          const order = (id, type, extra = {}) => ({ id, type, side: 1, x: 1200, y: 1400, ...extra });
          const priorCap = bot.supplyCap(f.state), priorFacilities = bot.productionFacilityCount(f.state, 1), priorBases = bot.workerBases(f.state).length;
          f.state.constructionOrders = [order('academy-order', type), order('gas-order', gasType, {gasNodeId: f.state.gasNodes[0].id}), order('supply-order', supplyType), order('production-order', 'barracks', {produceType:'swordsman'})];
          const view = f.executor.begin(f.state);
          equal(bot.countBuilding(view, type), 1, 'Traveling academy counts as ordered');
          equal(bot.activeConstructionDemand(view), 1, 'Traveling builder remains detached from economy');
          equal(bot.supplyCap(view), priorCap, 'Ghost grants no actual supply');
          equal(bot.productionFacilityCount(view, 1), priorFacilities, 'Ghost grants no operational production');
          equal(bot.workerBases(view).length, priorBases, 'Ghost grants no dropoff');
          equal(bot.rawGasWorkerDemand(view), 0, 'Ghost extractor grants no usable gas slots');
          check(!bot.tryBuild(view, {}, type), 'Singleton order blocks duplicate before placement search');
          check(!bot.tryBuild(view, {}, supplyType), 'One unfinished supply plan prevents repeated supply orders');
          bot.campaignOffense = {config: () => ({productionLimit: 1})};
          check(!bot.tryBuild(view, {}, 'barracks', 'swordsman'), 'Campaign production limit includes traveling construction');
          bot.runResearch = () => false; bot.deck = () => ['swordsman'];
          check(!AiMacroExecutor.execute(bot, view, {}, {kind:'tech'}), 'Tech macro does not order a second academy');
          let assigned = 0; bot.updateGasAssignments = () => {assigned++; return false};
          check(!AiMacroExecutor.execute(bot, view, {}, {kind:'gas-readiness'}), 'Gas macro recognizes paid extractor order');
          equal(assigned, 1, 'Gas macro moves to existing-resource assignment rather than new placement');
          check(!bot.productionPrerequisitesReady(view, 'guardshroom'), 'Pending academy does not unlock tier-two production');
          const empty = {...view, constructionOrders:[]};
          equal(bot.countBuilding(empty, type), 0, 'Cancellation immediately allows replacement planning');
        });
        test('Disposal cancels unresolved and admitted commands exactly once', () => {
          const f = fixture(); submit(f, flag); f.executor.begin(f.state);
          check(f.executor.offer({ ...flag, x: 1400 }), 'Second command admitted');
          f.executor.dispose('test-end'); f.executor.dispose('test-end');
          equal(f.executor.stats.cancelled, 2, 'Both reservations cancelled once');
          equal(f.executor.history.length, 2, 'No duplicate cancellation history');
          equal(f.executor.outstanding().length, 0, 'Disposal releases all reservations');
          const rejected = fixture(); rejected.session.rejectSubmission = true;
          rejected.executor.begin(rejected.state); check(rejected.executor.offer(flag), 'Rejected submission initially admitted');
          rejected.executor.flush(); equal(rejected.executor.stats.rejected, 1, 'Facade rejection is recorded');
          equal(rejected.executor.pending.length, 0, 'Facade rejection creates no pending command');
        });
        test('Bot suppresses decisions while resimulating or viewing speculative state', () => {
          const f = fixture(), bot = new BotController(f.session); let decisions = 0;
          bot.perceive = () => { decisions++; return {}; }; bot.rememberEnemies = () => {};
          bot.handleTacticalChest = () => true;
          f.session.netcodeSession.resimulating = true; bot.handleSnapshot(f.state);
          equal(decisions, 0, 'Resimulation emits no decision');
          bot.commandExecutor.begin(f.state); check(!bot.issueCommand(flag), 'Direct offer during resimulation is also blocked');
          bot.commandExecutor.flush(); f.session.netcodeSession.resimulating = false;
          bot.handleSnapshot({ ...f.state, tick: 13 }); equal(decisions, 0, 'Speculative view emits no decision');
          bot.handleSnapshot(f.state); equal(decisions, 1, 'Confirmed view can emit a decision'); bot.stop();
        });
        test('Actual StrategySim worker debit and rejected research release ledger reservations', () => {
          const f = fixture('guest', live); f.state = live.snapshot(); f.session.confirmedGameTick = live.tick;
          const base = live.buildings.find(b => b.side === 1 && BuildingDefinition.get(b.type)?.isDropoff);
          const entry = submit(f, { type: 'TRAIN_WORKER', buildingId: base.id }), before = live.wallet[1];
          const applied = live.applyCommand('guest', entry.action);
          check(applied, 'Actual worker command applies'); equal(live.wallet[1], before - WORKER_COST, 'Actual simulation debits worker cost');
          live.commandReceipts.push(receipt(entry, live.tick, applied)); f.tickets.clear();
          f.executor.reconcile(live.snapshot()); equal(f.executor.pending.length, 0, 'Applied worker reservation released');
          f.state = live.snapshot(); const research = submit(f, { type: 'START_RESEARCH', research: 'attack' });
          const rejected = live.applyCommand('guest', research.action); equal(rejected, false, 'Tier-one simulation rejects research');
          live.commandReceipts.push(receipt(research, live.tick, rejected)); f.tickets.clear();
          f.executor.reconcile(live.snapshot()); equal(f.executor.pending.length, 0, 'Rejected research reservation released');
          equal(f.executor.stats.applied, 1, 'Worker application recorded'); equal(f.executor.stats.rejected, 1, 'Research rejection recorded');
        });
      } finally { live.dispose('regression-test-complete'); }
      return results;
    });
    assert.deepEqual(pageErrors, [], 'Application boots without page errors');
    console.log(JSON.stringify({ results, pageErrors, scope: 'Public AI ticket facade and actual StrategySim command application; full Single-Player UI E2E is separate.' }, null, 2));
  } finally { await browser.close(); }
}

run().catch(error => { console.error(error.stack); process.exitCode = 1; });
