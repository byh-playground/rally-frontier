const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const htmlPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'index.html');

async function run() {
  let html = fs.readFileSync(htmlPath, 'utf8');
  const end = html.lastIndexOf('})();');
  assert.ok(end >= 0, 'Application IIFE exists');
  html = html.slice(0, end) + `
    window.__gameStartQA = {
      GameSession, StrategySim, CampaignMissionDefinition, CampaignModuleLoader, SIM_VERSION,
      P2P_STALL_RECYCLE_MS, NETWORK_HEALTH_POLL_MS
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
    await page.route('http://game-start-qa.local/**', route => route.fulfill({
      status: 200, contentType: 'text/html', body: html
    }));
    await page.goto('http://game-start-qa.local/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__gameStartQA);
    const result = await page.evaluate(() => {
      const {
        GameSession, StrategySim, CampaignMissionDefinition, CampaignModuleLoader, SIM_VERSION,
        P2P_STALL_RECYCLE_MS, NETWORK_HEALTH_POLL_MS
      } = window.__gameStartQA;
      const realNow = Date.now, realSetInterval = window.setInterval;
      let offset = 0, heartbeat = null, session = null, restored = null;
      const packets = [];
      const check = (condition, message) => {
        if (!condition) throw new Error(message);
      };
      Date.now = () => realNow() + offset;
      try {
        const rawMission = {
          schemaVersion: 7, missionId: 'game-start-heartbeat-regression',
          title: 'Game start heartbeat regression', playerRole: 'host', seed: 8,
          victory: { type: 'scripted' },
          player: { availableUnits: ['swordsman'], startingUnits: [], startingWorkers: 0 },
          enemy: { availableUnits: ['swordsman'], startingUnits: [], startingWorkers: 0, aiProfile: 'scripted' },
          map: { type: 'manual', width: 3072, height: 4096, content: { resourcePlacement: 'none' } }
        };
        const source = `(()=>{
          const mission=${JSON.stringify(rawMission)};
          mission.script={onInit(ctx){
            ctx.action({type:'spawnGroup',id:'position-order',faction:'player',
              position:[.4,.6],composition:[{unit:'swordsman',count:1}],spread:.005});
            ctx.action({type:'order',group:'position-order',order:'attack',position:[.6,.4]});
          }};
          return mission;
        })()`;
        const mission = CampaignMissionDefinition.normalize(
          CampaignModuleLoader.evaluate(source, 'game-start-regression.js')
        );
        const transport = {
          send: packet => packets.push(packet.type),
          sendNetcode: packet => { packets.push(`SDK:${packet.byteLength}`); return true; },
          subscribeNetcode: () => () => {},
          isNetcodeOpen: () => true,
          close() {}, onError() {}
        };
        session = new GameSession('guest', transport, 'GAME-START-QA', {
          selectionMode: 'deck', campaignScenario: mission
        });
        // Capture the real production heartbeat callback; retain its real timer.
        window.setInterval = (callback, delay, ...args) => {
          if (delay === NETWORK_HEALTH_POLL_MS) heartbeat = callback;
          return realSetInterval(callback, delay, ...args);
        };
        session.onTransportOpen();
        window.setInterval = realSetInterval;
        check(typeof heartbeat === 'function', 'Production heartbeat is registered');
        const staleAge = P2P_STALL_RECYCLE_MS + 1000;
        session.lastPongAt = Date.now() - staleAge;
        let snapshotCompletedAt = 0;
        session.onSnapshot = () => {
          // Model slow local initialization without changing simulation dt/TPS,
          // geometry, combat, transport parsing, or the heartbeat implementation.
          offset += staleAge;
          snapshotCompletedAt = performance.now();
        };
        session.handle({
          type: 'GAME_START', simVersion: SIM_VERSION, seed: 8,
          draft: { phase: 'live', decks: { host: ['swordsman'], guest: ['swordsman'] },
            defenseCards: { host: [], guest: [] } }
        });
        check(session.sim && session.sim.tick === 0, 'Real StrategySim starts at tick zero');
        check(session.lastPongAt >= Date.now() - 10, 'Startup completion refreshes peer liveness');
        check(session.simClockLast >= snapshotCompletedAt, 'Simulation clock starts after snapshot initialization');
        check(session.netcodeSession?.tick === 0, 'Actual SDK session starts at the same pre-step tick zero');
        check(session.netcodeNow >= snapshotCompletedAt, 'SDK runtime clock starts after snapshot initialization');
        heartbeat();
        check(!session.syncHold && session.recoveryPhase === 'idle', 'Slow local startup does not require manual recovery');
        const startup = {
          tick: session.sim.tick, syncHold: session.syncHold,
          recoveryPhase: session.recoveryPhase, simulatedLocalInitMs: staleAge
        };
        const unit = session.sim.units.find(u =>
          (u.campId || u.scenarioGroupId) === 'position-order');
        check(unit, 'Campaign script spawns the ordered unit through its actual action API');
        check(unit.target === null && unit.forcedTargetId === null,
          'A position order without an entity ID retains canonical nullable target fields');
        const before = session.sim.checksumBundle();
        const serialized = JSON.parse(JSON.stringify(session.sim.exportState()));
        restored = new StrategySim(session.draft, 8, session.roundRules, session.matchConfig.campaignScenario);
        restored.importState(serialized);
        const after = restored.checksumBundle();
        check(before.root === after.root,
          `Position order preserves checksum through JSON state import: ${before.root} != ${after.root}`);
        const positionOrder = {
          target: unit.target, forcedTargetId: unit.forcedTargetId,
          liveChecksum: before.root, restoredChecksum: after.root
        };
        offset += P2P_STALL_RECYCLE_MS + 1;
        heartbeat();
        check(session.syncHold && session.simpleRecoveryNeedsManual, 'Real subsequent peer silence still freezes gameplay');
        check(session.simpleRecoveryReason === 'network-silence', 'Subsequent silence retains the current connection recovery reason');
        return { startup, positionOrder, subsequentSilence: {
          syncHold: session.syncHold, recoveryPhase: session.recoveryPhase,
          reason: session.simpleRecoveryReason
        }, packets };
      } finally {
        window.setInterval = realSetInterval;
        restored?.dispose('regression-test-complete');
        session?.dispose('regression-test-complete');
        Date.now = realNow;
      }
    });
    console.log(JSON.stringify({ result, pageErrors }, null, 2));
    assert.deepEqual(pageErrors, [], 'Application starts without page errors');
  } finally {
    await browser.close();
  }
}

run().catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
