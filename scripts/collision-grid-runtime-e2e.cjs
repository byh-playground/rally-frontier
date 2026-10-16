const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { bundleGame } = require('./bundle-gamekit.cjs');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const bundled = bundleGame(root, source);
const iifeEnd = bundled.lastIndexOf('})();');
assert(iifeEnd > 0, 'Application IIFE must exist');
const html = bundled.slice(0, iifeEnd) + `
  window.__collisionGridQA = { StrategySim, GameRuleDefinition, DebugScenarioHarness, RallyStateCodec };
` + bundled.slice(iifeEnd);

async function run() {
  fs.mkdirSync(path.join(root, '.qa'), { recursive: true });
  const browserData = fs.mkdtempSync(path.join(root, '.qa', 'collision-grid-browser-'));
  const browserDataRoot = path.resolve(root, '.qa');
  const resolvedBrowserData = path.resolve(browserData);
  assert.equal(path.dirname(resolvedBrowserData), browserDataRoot, 'Browser profile must stay in this task QA folder');
  assert(path.basename(resolvedBrowserData).startsWith('collision-grid-browser-'));
  let context = null;
  try {
    context = await chromium.launchPersistentContext(browserData, {
      channel: process.env.QA_BROWSER_CHANNEL || 'msedge',
      headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('http://collision-grid-qa.local/**', route => route.fulfill({
      status: 200, contentType: 'text/html', body: html,
    }));
    await page.goto('http://collision-grid-qa.local/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__collisionGridQA);
    const result = await page.evaluate(() => {
      const { StrategySim, GameRuleDefinition, DebugScenarioHarness, RallyStateCodec } = window.__collisionGridQA;
      const fail = message => { throw new Error(message); };
      const scenario = DebugScenarioHarness.normalize({
        kind: 'unit-combat', allyType: 'swordsman', enemyType: 'ancientbear',
        allyCount: 12, enemyCount: 12, research: true, humanRole: 'host',
      });
      const draft = { decks: { host: ['swordsman'], guest: ['ancientbear'] }, defenseCards: { host: [], guest: [] } };
      const rules = GameRuleDefinition.resolve({ overrides: { simulation: { tps: 10 } } });
      const create = () => StrategySim.createForMatch({ draft, seed: 9137, rules, debugScenario: scenario });
      const a = create(), b = create();
      const encode = sim => RallyStateCodec.encode(sim.exportState());
      const sameBytes = (left, right, label) => {
        if (left.length !== right.length || !left.every((value, index) => value === right[index])) fail(`Deterministic state mismatch: ${label}`);
      };
      try {
        sameBytes(encode(a), encode(b), 'initial');
        for (let tick = 1; tick <= 12; tick++) {
          a.step();
          b.step();
          sameBytes(encode(a), encode(b), `tick ${tick}`);
        }

        const grid = a.collisionGrid, radii = a.collisionRadii, out = [];
        let maxRadius = 0;
        for (let i = 0; i < a.units.length; i++) maxRadius = Math.max(maxRadius, radii[i] || 0);
        grid.reset(a.units, maxRadius);
        let testedOverlaps = 0;
        for (let i = 0; i < a.units.length; i++) {
          const first = a.units[i], radius = radii[i];
          if (!first?.alive || radius <= 0) continue;
          grid.queryCandidatesFP(first.fx, first.fy, radius, out);
          if (new Set(out).size !== out.length) fail(`Duplicate grid candidates for ${first.id}`);
          const candidateSet = new Set(out);
          for (let j = 0; j < a.units.length; j++) {
            if (j === i) continue;
            const second = a.units[j], otherRadius = radii[j];
            if (!second?.alive || otherRadius <= 0) continue;
            const dx = second.fx - first.fx, dy = second.fy - first.fy, sum = radius + otherRadius;
            if (dx * dx + dy * dy < sum * sum) {
              testedOverlaps++;
              if (!candidateSet.has(j)) fail(`Possible circle overlap omitted: ${first.id}/${second.id}`);
            }
          }
        }
        return {
          browserLoaded: true,
          simulatedTicks: 12,
          unitCount: a.units.length,
          cellSizeWorldUnits: grid.cellSize,
          maxIndexedRadiusFP: grid.maxIndexedRadiusFP,
          possibleOverlapChecks: testedOverlaps,
          peerStateBytesEqual: true,
          candidateListsUnique: true,
        };
      } finally {
        a.dispose('collision-grid-e2e');
        b.dispose('collision-grid-e2e');
      }
    });
    assert.deepEqual(pageErrors, [], 'Application must load and run without page errors');
    assert.equal(result.cellSizeWorldUnits, 64);
    console.log(JSON.stringify({ result, pageErrors }, null, 2));
  } finally {
    if (context) await context.close();
    if (fs.existsSync(resolvedBrowserData)) fs.rmSync(resolvedBrowserData, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
