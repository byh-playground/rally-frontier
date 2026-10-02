const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium: nativeChromium } = require('playwright');
const chromium = require('./netcode-qa-module.cjs').wrapChromium(nativeChromium);

// Focused adapter integration tests use the application's actual StrategySim,
// state owners and campaign lifecycle. Full Single-Player UI E2E is separate.
async function run() {
  const htmlPath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  for (const [, attributes, source] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!attributes.includes('application/json')) new vm.Script(source);
  }
  const end = html.lastIndexOf('})();');
  assert.ok(end >= 0, 'Application IIFE exists');
  html = html.slice(0, end) + `
    window.__netcodeStateQA = {
      RallyStateCodec, RallyCommandCodec, RallySimulationAdapter, StrategySim,
      GameRuleDefinition, TerrainNavigation, StateValue, CampaignModuleLoader,
      CampaignMissionDefinition, SimulationRuntimeState, CloneUtil, SIM_VERSION, ReplayPolicy, ReplayPlayer
    };
  ` + html.slice(end);
  const browser = await chromium.launch({
    channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('http://netcode-state-qa.local/**', route => route.fulfill({
      status: 200, contentType: 'text/html', body: html
    }));
    await page.goto('http://netcode-state-qa.local/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__netcodeStateQA);
    const cases = await page.evaluate(() => {
      const {
        RallyStateCodec: StateCodec, RallyCommandCodec: CommandCodec,
        RallySimulationAdapter: Adapter, StrategySim, GameRuleDefinition,
        TerrainNavigation, StateValue, CampaignModuleLoader,
        CampaignMissionDefinition, SimulationRuntimeState, CloneUtil, SIM_VERSION, ReplayPolicy, ReplayPlayer
      } = window.__netcodeStateQA;
      const results = [];
      const check = (condition, message) => { if (!condition) throw Error(message); };
      const sameBytes = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);
      const test = (name, body) => {
        try { results.push({ name, status: 'PASS', evidence: body() }); }
        catch (error) { results.push({ name, status: 'FAIL', error: error.stack || error.message }); }
      };
      const draft = { decks: { host: ['swarmbug'], guest: ['swarmbug'] }, defenseCards: { host: [], guest: [] } };
      const rules = () => GameRuleDefinition.resolve({ overrides: {
        map: { generator: 'fixed-standard' }, economy: { startingResources: { minerals: 1000, gas: 1000 } }
      } });
      const create = (seed = 831047) => {
        const sim = new StrategySim(draft, seed, rules());
        const frames = [], session = { sim, onNetcodeFrameApplied: frame => frames.push(frame) };
        return { sim, frames, adapter: new Adapter(session) };
      };
      const inputs = tick => [
        { playerId: 'guest', commands: tick % 7 === 0 ? [{ sequence: tick + 1, executeTick: tick, payload: CommandCodec.encode({ type: 'SET_FLAG', x: 3100 - tick, y: 500 + tick, forced: true }) }] : [] },
        { playerId: 'host', commands: tick % 5 === 0 ? [{ sequence: tick + 1, executeTick: tick, payload: CommandCodec.encode({ type: 'SET_FLAG', x: 700 + tick, y: 3300 - tick, forced: true }) }] : [] }
      ];
      const step = (game, tick, extra = {}) => game.adapter.step({ tick, tickRate: game.sim.tps, inputs: inputs(tick), ...extra });

      test('Canonical bytes preserve action precision and authoritative array order', () => {
        const action = { type: 'SET_FLAG', x: 107.12345678901235, y: 201.00000000000003, forced: false };
        const bytes = CommandCodec.encode(action);
        check(CommandCodec.decode(bytes).x === action.x && CommandCodec.decode(bytes).y === action.y, 'No float quantization');
        check(sameBytes(bytes, CommandCodec.encode({ y: action.y, forced: false, x: action.x, type: action.type })), 'Object insertion order is canonical');
        check(StateCodec.decode(StateCodec.encode({ order: [3, 1, 2] })).order.join(',') === '3,1,2', 'Arrays preserve owner order');
        const tunnel = { type: 'CAST_SPELL', spellId: 'tunnel', entryX: 300, entryY: 500, exitX: 700, exitY: 1000 };
        check(CommandCodec.decode(CommandCodec.encode(tunnel)).exitX === 700, 'Tunnel retains its existing entry/exit coordinate shape');
        return { commandBytes: bytes.length, x: action.x, y: action.y };
      });

      test('Every command rejects fields outside its authoritative contract', () => {
        const actions=[{type:'MATCH_SURRENDER'},{type:'SET_FLAG',x:10,y:20},{type:'TOGGLE_PRODUCTION'},{type:'TRAIN_WORKER',buildingId:'b1'},{type:'SET_GAS_WORKERS',buildingId:'b1',target:3},{type:'OPEN_TACTICAL_CHEST'},{type:'CHOOSE_TACTICAL_REWARD',offerId:'a',rewardId:'b'},{type:'REPLACE_SPELL',offerId:'a',oldSpellId:'meteor'},{type:'CANCEL_SPELL_REPLACEMENT',offerId:'a'},{type:'CAST_SPELL',spellId:'meteor',x:10,y:20},{type:'CAST_SPELL',spellId:'tunnel',entryX:10,entryY:20,exitX:30,exitY:40},{type:'START_RESEARCH',research:'ability',unit:'medic',researchId:'medic'},{type:'CANCEL_BUILDING',buildingId:'b1'},{type:'BUILD',building:'barracks',produceType:'swarmbug',x:10,y:20}];
        let rejected=0;
        for(const action of actions){CommandCodec.decode(CommandCodec.encode(action));try{CommandCodec.encode({...action,renderRadius:999})}catch{rejected++}}
        check(rejected===actions.length,'All command contracts reject unknown fields');
        return {commandContracts:actions.length,rejected};
      });
      test('Projectile presentation never changes saved state, checksums or recovered impact events', () => {
        const game=create(),sim=game.sim;
        const source=sim.spawnUnit(0,'rocket',600,600),target=sim.spawnUnit(1,'swarmbug',650,600);
        sim.scheduleProjectilePattern(source,target,false,60,{count:4,intervalMs:150,damagePerShot:15,impactRadius:105,spreadRadius:0,arcHeights:[88,96,100,92],impactAtAimPoint:true});
        check(sim.projectiles.length===1&&sim.delayedEffects.length===3,'Actual pattern creates live and reserved projectiles');
        const before=game.adapter.save(),hash=sim.checksum(),parts=JSON.stringify(sim.checksumBundle());
        for(const p of sim.projectiles){p.arcHeight=9999;p.drawRadius=777;p.visualTag='arbitraryRenderer'}
        for(const fx of sim.delayedEffects){fx.arcHeight=123;fx.drawRadius=444;fx.visualTag='ignoredPreset'}
        check(sameBytes(before,game.adapter.save())&&hash===sim.checksum()&&parts===JSON.stringify(sim.checksumBundle()),'Presentation excluded from complete and diagnostic checksums');
        const state=StateCodec.decode(before).state;
        check([...state.projectiles,...state.delayedEffects].every(p=>!('arcHeight' in p)&&!('drawRadius' in p)&&!('visualTag' in p)),'Recovery has no renderer fields');
        for(const p of state.projectiles)p.arcHeight=1;
        check(!game.adapter.validateSnapshot(StateCodec.encode({...StateCodec.decode(before),state})),'Render fields rejected in incoming authoritative state');
        game.adapter.load(before);
        check(sim.projectiles[0].visualTag==='balsamRocket'&&sim.projectiles[0].arcHeight===88,'Restored presentation derives from definitions and shot index');
        for(let tick=0;tick<30;tick++)sim.updateProjectiles();
        check(sim.events.some(e=>e.type==='balsamRocketImpact'),'Recovered semantic impact event preserved');
        return {projectiles:1,reserved:3,rendererMutationExcluded:true,impactEventPreserved:true};
      });
      test('Both role-local sequence 1 commands execute once in resolved SDK order', () => {
        const game = create(), commands = ['guest', 'host'].map(playerId => ({ playerId, commands: [
          { sequence: 1, executeTick: 0, payload: CommandCodec.encode({ type: 'TOGGLE_PRODUCTION' }) }
        ] }));
        game.adapter.step({ tick: 0, tickRate: game.sim.tps, inputs: commands });
        check(game.sim.tick === 1 && game.sim.productionPaused.every(Boolean), 'Both actor actions applied exactly once');
        const receipts = game.sim.commandReceipts;
        check(receipts.length === 2 && receipts[0].actor === 'guest' && receipts[1].actor === 'host', 'Canonical resolved order retained');
        check(receipts[0].seq === 1 && receipts[1].seq === 2 && receipts.every(r => r.netcodeSequence === 1), 'Global replay ordinals differ from local SDK sequences');
        const checkpoint = game.adapter.save();
        check(game.adapter.validateSnapshot(checkpoint, { tick: 1 }), 'Snapshot tick validates');
        check(!game.adapter.validateSnapshot(checkpoint, { tick: 0 }), 'Different frame rejects');
        return { gameTick: game.sim.tick, receipts: StateValue.copy(receipts) };
      });

      test('Save/load exact bytes and next-step equivalence with real StrategySim', () => {
        const uninterrupted = create(), rewound = create();
        for (let tick = 0; tick < 20; tick++) { step(uninterrupted, tick); step(rewound, tick); }
        const checkpoint = rewound.adapter.save(), map = rewound.sim.mapDescriptor, world = rewound.sim.world;
        const entityOrder = rewound.sim.units.map(u => u.id).join('|');
        for (let tick = 20; tick < 50; tick++) step(uninterrupted, tick);
        for (let tick = 20; tick < 32; tick++) step(rewound, tick);
        rewound.adapter.load(checkpoint);
        check(sameBytes(checkpoint, rewound.adapter.save()), 'Load/save bytes match exactly');
        check(rewound.sim.mapDescriptor === map && rewound.sim.world === world, 'Immutable map and geometry caches retain verified identity');
        check(rewound.sim.units.map(u => u.id).join('|') === entityOrder, 'Entity authoritative order retained');
        for (let tick = 20; tick < 50; tick++) step(rewound, tick, { resimulating: true });
        check(sameBytes(uninterrupted.adapter.save(), rewound.adapter.save()), 'Restored/resimulated bytes match uninterrupted state');
        check(rewound.frames.at(-1).resimulating === true && rewound.frames.at(-1).gameTick === 50, 'Observer receives explicit timeline context');
        return { checkpointBytes: checkpoint.length, finalBytes: rewound.adapter.save().length, gameTick: 50 };
      });

      test('Candidate validation rejects malformed bytes before any live mutation', () => {
        const game = create(), saved = game.adapter.save(), baseline = StateCodec.decode(saved);
        const mutate = edit => { const candidate = structuredClone(baseline); edit(candidate); return StateCodec.encode(candidate); };
        const candidates = [
          new Uint8Array([255]), new TextEncoder().encode('{'),
          mutate(s => s.simVersion = SIM_VERSION - 1), mutate(s => s.matchId = 'different'),
          mutate(s => s.mapFingerprint++), mutate(s => s.state.seed++),
          mutate(s => s.state.tick = -1), mutate(s => s.state.wallet = [1]),
          mutate(s => s.state.wallet = ['bad', 1]), mutate(s => s.state.units[0].timers = []),
          mutate(s => s.state.units[0].side = 99), mutate(s => s.state.units[0].type = 'unknown-unit'),
          mutate(s => s.state.units.push(structuredClone(s.state.units[0]))),
          mutate(s => delete s.state.units), mutate(s => s.state.runtimeEpoch = 17),
          mutate(s => s.state.scheduled = [[0, []]]),
          new TextEncoder().encode(new TextDecoder().decode(saved).replace('"tick":0', '"tick":1e999'))
        ];
        const epoch = game.sim.runtimeEpoch;
        for (const candidate of candidates) {
          check(game.adapter.validateSnapshot(candidate) === false, 'Malformed candidate must fail data validation');
          let failed = false; try { game.adapter.load(candidate); } catch { failed = true; }
          check(failed, 'Load rejects malformed candidate');
          check(game.sim.runtimeEpoch === epoch && sameBytes(saved, game.adapter.save()), 'Rejected load leaves live bytes and caches unchanged');
        }
        const malformedFrame = [
          { playerId: 'host', commands: [{ sequence: 1, executeTick: 0, payload: CommandCodec.encode({ type: 'TOGGLE_PRODUCTION' }) }] },
          { playerId: 'guest', commands: [{ sequence: 1, executeTick: 0, payload: new Uint8Array([255]) }] }
        ];
        let rejected = false; try { game.adapter.step({ tick: 0, tickRate: game.sim.tps, inputs: malformedFrame }); } catch { rejected = true; }
        check(rejected && sameBytes(saved, game.adapter.save()), 'Whole resolved frame validates before the first queue mutation');
        return { invalidSnapshots: candidates.length, epoch };
      });

      test('Surrender is an authoritative action shared by adapter and direct replay', () => {
        const game = create(), initial = game.adapter.save();
        game.adapter.step({ tick: 0, tickRate: game.sim.tps, inputs: [
          { playerId: 'guest', commands: [{ sequence: 1, executeTick: 0, payload: CommandCodec.encode({ type: 'MATCH_SURRENDER' }) }] }
        ] });
        check(game.frames[0].winner === 'host' && game.sim.netcodeMatchResult.reason === 'surrender', 'SDK frame owns surrender result');
        const result = game.adapter.save(); game.adapter.load(result);
        check(sameBytes(result, game.adapter.save()), 'Terminal result round-trips');
        game.adapter.load(initial);
        check(!Object.hasOwn(game.sim, 'netcodeMatchResult'), 'Rollback before command removes terminal result');
        game.sim.queueCommand({ tick: 1, seq: 1, actor: 'guest', action: { type: 'MATCH_SURRENDER' } });
        check(game.sim.step() === 'host', 'Replay/direct simulation uses same authoritative command consumer');
        return { result: StateValue.copy(game.sim.netcodeMatchResult), gameTick: game.sim.tick };
      });

      test('Snapshot isolation and same-tick rollback navigation epoch boundary', () => {
        const game = create(), snapshot = game.sim.snapshot(), nav = TerrainNavigation.forState(snapshot);
        const bytes = game.adapter.save(), savedHp = game.sim.units[0].hp;
        game.sim.units[0].hp--;
        check(snapshot.units[0].hp === savedHp, 'Retained snapshot is isolated from live entity mutation');
        const candidate = StateCodec.decode(bytes), originalX = snapshot.buildings[0].x;
        candidate.state.buildings[0].x += 500;
        const epoch = game.sim.runtimeEpoch;
        game.adapter.load(StateCodec.encode(candidate));
        check(game.sim.runtimeEpoch > epoch, 'Load starts a fresh runtime timeline');
        check(game.sim.tick === snapshot.tick && snapshot.buildings[0].x === originalX, 'Same-tick old snapshot remains isolated');
        const retainedNav = TerrainNavigation.forState(snapshot);
        check(retainedNav !== game.sim.navigation && retainedNav !== nav, 'Old snapshot cannot bind to rolled-back live navigation');
        snapshot.units[0].hp = 7;
        check(game.sim.units[0].hp === savedHp, 'Snapshot mutation cannot affect restored sim');
        return { epochBefore: epoch, epochAfter: game.sim.runtimeEpoch, sameTick: game.sim.tick };
      });

      test('Procedural layered-map rollback reuses only verified topology and preserves exact bytes', () => {
        const sim = new StrategySim(draft, 831047, GameRuleDefinition.resolve({ overrides: { simulation: { tps: 20 } } }));
        sim.applyDebugScenario({ allyType: 'swarmbug', allyCount: 70, enemyType: 'swarmbug', enemyCount: 70, research: false });
        const game = { sim, adapter: new Adapter({ sim }) }, checkpoint = game.adapter.save();
        check(sim.mapDescriptor.terrain.layers.length > 0, 'Actual procedural terrain is layered');
        const envelope = StateCodec.decode(checkpoint), originalData = sim.exportState();
        delete originalData.rules; delete originalData.mapDescriptor; delete originalData.campaignScenario;
        check(sameBytes(StateCodec.encode(originalData), StateCodec.encode(sim.exportState({ includeIdentity: false }))), 'Omitting immutable copies preserves previous canonical dynamic bytes');
        const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
        const measure = (body, samples = 7) => {
          const values = []; for (let i = 0; i < samples + 2; i++) {
            const began = performance.now(); body(); if (i >= 2) values.push(performance.now() - began);
          }
          return Number(median(values).toFixed(2));
        };
        const oldSaveMs = measure(() => {
          const state = sim.exportState(); delete state.rules; delete state.mapDescriptor; delete state.campaignScenario;
          StateCodec.encode({ ...envelope, state });
        });
        const saveMs = measure(() => game.adapter.save()), loadMs = measure(() => game.adapter.load(checkpoint));
        const coldStepMs = [], retainedStepMs = [], meshBuildMs = [];
        for (let i = 0; i < 4; i++) {
          game.adapter.load(checkpoint); SimulationRuntimeState.initialize(sim);
          let began = performance.now(); game.adapter.step({ tick: 0, tickRate: sim.tps, inputs: [] });
          coldStepMs.push(Number((performance.now() - began).toFixed(2)));
          meshBuildMs.push(Number(sim.navigation.metrics.meshBuildMs.toFixed(2)));
          const coldBytes = game.adapter.save(), navigation = sim.navigation;
          check(navigation.layers.size > 0, 'Real gameplay builds a terrain navigation layer');
          const version = navigation.topology.version, layer = navigation.layers.values().next().value;
          game.adapter.load(checkpoint);
          check(sim.navigation === navigation && navigation.topology.version === version && navigation.layers.values().next().value === layer, 'Same obstacle values retain verified navigation topology/layers');
          check(sameBytes(checkpoint, game.adapter.save()), 'Retaining derived caches leaves saved bytes exact');
          began = performance.now(); game.adapter.step({ tick: 0, tickRate: sim.tps, inputs: [] });
          retainedStepMs.push(Number((performance.now() - began).toFixed(2)));
          check(sameBytes(coldBytes, game.adapter.save()), 'Warm and regenerated navigation produce identical full gameplay bytes');
        }
        const navigation = sim.navigation, topologyVersion = navigation.topology.version;
        const changed = StateCodec.decode(checkpoint); changed.state.buildings[0].x += 90;
        const changedBytes = StateCodec.encode(changed);
        game.adapter.load(changedBytes);
        check(sim.navigation === navigation && navigation.topology.version > topologyVersion && navigation.layers.size === 0, 'Changed authoritative building layout immediately invalidates mesh/goal caches');
        game.adapter.step({ tick: 0, tickRate: sim.tps, inputs: [] });
        const changedResult = game.adapter.save();
        game.adapter.load(changedBytes); game.adapter.step({ tick: 0, tickRate: sim.tps, inputs: [] });
        check(sameBytes(changedResult, game.adapter.save()), 'Changed-layout warmed replay is deterministic');
        const fullState = sim.exportState(), beforeDefault = sim.navigation;
        sim.importState(fullState);
        check(sim.navigation !== beforeDefault && sim.navigation.layers.size === 0, 'Default replay import still initializes fresh derived runtime');
        return { units: sim.units.length, checkpointBytes: checkpoint.length, oldSaveMedianMs: oldSaveMs, saveMedianMs: saveMs, loadMedianMs: loadMs,
          regeneratedStepMs: coldStepMs, retainedStepMs, regeneratedMeshBuildMs: meshBuildMs };
      });

      test('Campaign rollback keeps compiled module and resets complete script/root state', () => {
        window.__netcodeCompiles = 0; window.__netcodeDisposals = 0;
        const source = `(() => {
          window.__netcodeCompiles++;
          return {
            schemaVersion: 7, missionId: 'adapter-regression', seed: 9327,
            map: { type: 'manual', width: 2400, height: 2400, spawns: {host:[.15,.85],guest:[.85,.15]}, content: {resourcePlacement:'manual'} },
            player: {availableUnits:['swarmbug'],startingUnits:[],startingWorkers:0,techCap:3},
            enemy: {availableUnits:['swarmbug'],startingUnits:[],startingWorkers:0,techCap:3,aiProfile:'scripted'},
            victory: {type:'scripted'}, events: [],
            script: {
              onInit(ctx) { ctx.state.calls=0; ctx.state.events=[]; ctx.sim.authoredRoot={ordinal:0,values:[3,1,2]}; },
              onTick(ctx) {
                ctx.state.calls++; ctx.state.random=ctx.random.next(); ctx.sim.authoredRoot.ordinal++;
                if(ctx.time.tick===4)ctx.sim.afterCheckpoint={spawnedAt:ctx.time.tick};
                if(ctx.time.tick===5)ctx.ui.toast('deterministic event');
              },
              onEvent(ctx,event) { ctx.state.events.push(event.type); },
              onDispose() { window.__netcodeDisposals++; }
            }
          };
        })()`;
        const raw = CampaignModuleLoader.evaluate(source), mission = CampaignMissionDefinition.normalize(raw);
        const makeCampaign = () => {
          const sim = new StrategySim(draft, mission.seed, rules(), mission); sim.applyCampaignScenario(mission);
          const frames = [], session = { sim, onNetcodeFrameApplied: frame => frames.push(frame) };
          return { sim, frames, adapter: new Adapter(session) };
        };
        const straight = makeCampaign(), rolled = makeCampaign();
        for (let tick = 0; tick < 3; tick++) { step(straight, tick); step(rolled, tick); }
        const bytes = rolled.adapter.save(), runtime = rolled.sim.campaignScriptRuntime, module = runtime.module;
        const compiles = window.__netcodeCompiles;
        for (let tick = 3; tick < 12; tick++) { step(straight, tick); step(rolled, tick); }
        rolled.adapter.load(bytes);
        check(rolled.sim.campaignScriptRuntime === runtime && runtime.module === module, 'Compiled mission runtime retained');
        check(window.__netcodeDisposals === 0 && window.__netcodeCompiles === compiles, 'Rollback never invokes dispose or compiles again');
        check(!Object.hasOwn(rolled.sim, 'afterCheckpoint'), 'Root state introduced after checkpoint is removed');
        check(sameBytes(bytes, rolled.adapter.save()), 'Campaign bytes round-trip exactly');
        for (let tick = 3; tick < 12; tick++) step(rolled, tick, { resimulating: true, recovering: true });
        check(sameBytes(straight.adapter.save(), rolled.adapter.save()), 'Campaign random, postStep events and unknown root fields replay deterministically');
        const frame = rolled.frames.find(f => f.resimulating && f.gameTick === 5);
        check(frame.events.some(e => e.type === 'campaignPresentation'), 'Observer receives campaign postStep authoritative events');
        const state = rolled.sim.exportState();
        check(state.authoredRoot.ordinal === 12 && state.campaignScriptState.calls === 12 && !Object.hasOwn(state, 'navigation'), 'State owners capture root extensions and script state without caches');
        rolled.sim.importState(state);
        check(window.__netcodeDisposals === 1 && window.__netcodeCompiles === compiles + 1, 'Default import retains ordinary disposal/recompile lifecycle');
        return { checkpointBytes: bytes.length, compilesBeforeRewind: compiles, disposalsAfterDefaultImport: window.__netcodeDisposals, calls: state.campaignScriptState.calls };
      });
      test('Replay checksum covers added root state and terminal outcome without compiling a shadow', () => {
        const game=create();
        game.sim.authoredRoot={phase:1};
        game.sim.netcodeMatchResult={winner:'host',reason:'surrender',tick:0};
        const checkpoint=ReplayPolicy.replayCheckpointSnapshot(game.sim),before=game.sim.checksum();
        ReplayPlayer.prototype.validateImportedCheckpoint.call({},game.sim,checkpoint,0);
        let rejected=0;
        for(const mutate of [()=>game.sim.authoredRoot.phase++,()=>game.sim.netcodeMatchResult.winner='guest']){
          mutate();
          check(game.sim.checksum()!==before,'Complete checksum detects authoritative extension/outcome mutation');
          try{ReplayPlayer.prototype.validateImportedCheckpoint.call({},game.sim,checkpoint,0)}catch{rejected++}
        }
        check(rejected===2,'Real replay validator rejects both altered checkpoints');
        return {checksumScope:checkpoint.checksumScope,rejected};
      });
      return results;
    });
    console.log(JSON.stringify({ cases, pageErrors }, null, 2));
    assert.equal(pageErrors.length, 0, 'No startup/runtime browser errors');
    assert.equal(cases.filter(result => result.status === 'FAIL').length, 0, 'Every adapter regression passes');
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
