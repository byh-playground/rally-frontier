const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { readGamekit } = require('./setup-gamekit.cjs');

const root = path.resolve(__dirname, '..');
const htmlPath = path.resolve(process.argv[2] || path.join(root, '_site', 'index.html'));
const output = path.join(root, '.qa', 'replay-import-feedback');
const legacySdkUrl = 'https://byh-playground.github.io/rollback-netcode/rollback-netcode.js';
fs.mkdirSync(output, { recursive: true });

function cachedGamekit(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    try { return readGamekit(dir); }
    catch (error) {
      if (!/ENOENT|cache is missing|Cannot find/i.test(String(error?.message))) throw error;
      const parent = path.dirname(dir);
      if (parent === dir) throw Error('Gamekit cache is missing in this checkout and its parents.');
    }
  }
}

async function run() {
  let html = fs.readFileSync(htmlPath, 'utf8');
  const end = html.lastIndexOf('})();');
  assert.ok(end >= 0, 'Application IIFE exists');
  html = html.slice(0, end) + `
window.__replayFeedbackE2E={
  protocol:REPLAY_PROTOCOL,simVersion:SIM_VERSION,
  screen:()=>UiRuntimeState.value.screen,
  makeReplay(corrupt=false){
    const seed=20261015,finalDraft={decks:{host:[],guest:[]},defenseCards:{host:[],guest:[]}};
    const sim=new StrategySim(finalDraft,seed,GameRuleDefinition.current);
    const checkpoint=ReplayPolicy.replayCheckpointSnapshot(sim);
    sim.dispose("replay-import-feedback-fixture");
    return {protocol:REPLAY_PROTOCOL,simVersion:SIM_VERSION,seed,finalDraft,rules:GameRuleDefinition.current,
      commands:[],checkpoints:[{tick:0,...checkpoint,checksum:corrupt?"bad-checksum":checkpoint.checksum}],result:{winner:null,reason:"in-progress",endTick:0}};
  }
};
` + html.slice(end);

  const { modules } = cachedGamekit(root);
  const sdk = ['rollback', 'deterministic', 'simloop', 'transport'].map(name =>
    `export * from ${JSON.stringify('data:text/javascript;base64,' + modules[name].toString('base64'))};`
  ).join('\n');
  const browser = await chromium.launch({
    channel: process.env.QA_BROWSER_CHANNEL || 'msedge',
    headless: process.env.QA_HEADED !== '1',
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });
  try {
    const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(legacySdkUrl, route => route.fulfill({
      contentType: 'text/javascript',
      headers: { 'access-control-allow-origin': '*' },
      body: sdk
    }));
    await page.route('http://replay-import-feedback-qa.local/**', route => route.fulfill({
      contentType: 'text/html', body: html
    }));
    await page.goto('http://replay-import-feedback-qa.local/', { waitUntil: 'domcontentloaded' });
    await page.locator('#replayOpenBtn').waitFor({ state: 'visible', timeout: 45000 });
    await page.waitForFunction(() => window.__replayFeedbackE2E && window.RallyNetcode);

    async function selectFile(name, contents, expected) {
      const chooserReady = page.waitForEvent('filechooser');
      await page.locator('#replayOpenBtn').click();
      const chooser = await chooserReady;
      await chooser.setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(contents) });
      await page.locator('#singleStatus').waitFor({ state: 'visible' });
      const result = await page.evaluate(() => ({
        message: document.querySelector('#singleStatus').textContent,
        role: document.querySelector('#singleStatus').getAttribute('role'),
        live: document.querySelector('#singleStatus').getAttribute('aria-live'),
        tone: document.querySelector('#singleStatus').dataset.tone,
        screen: window.__replayFeedbackE2E.screen()
      }));
      assert.match(result.message, expected, name);
      assert.equal(result.role, 'alert', name + ' is announced as an error');
      assert.equal(result.live, 'assertive', name + ' is announced promptly');
      assert.equal(result.tone, 'error', name + ' has error styling');
      assert.equal(result.screen, 'lobby', name + ' leaves the user in the lobby');
      assert.equal(await page.locator('#gameStartBtn').isVisible(), true, name + ' keeps the normal lobby action');
      assert.equal(await page.locator('#replayFileInput').inputValue(), '', name + ' resets the file picker for retry');
      return result;
    }

    const invalidJson = await selectFile('truncated.json', '{"commands":', /JSON/);
    await page.screenshot({ path: path.join(output, 'mobile-invalid-json.png') });

    const protocol = await page.evaluate(() => window.__replayFeedbackE2E.protocol);
    const simVersion = await page.evaluate(() => window.__replayFeedbackE2E.simVersion);
    const wrongFormat = await selectFile('wrong-format.json', JSON.stringify({ protocol: 'other-game' }), /RALLY FRONTIER/);
    const wrongVersion = await selectFile('wrong-version.json', JSON.stringify({
      protocol, simVersion: simVersion - 1, seed: 1, finalDraft: {}, commands: []
    }), /게임 버전/);
    const missingCommands = await selectFile('missing-commands.json', JSON.stringify({
      protocol, simVersion, seed: 1, finalDraft: {}
    }), /명령 기록이나 초기 상태/);

    const corruptCheckpoint = await page.evaluate(() => JSON.stringify(window.__replayFeedbackE2E.makeReplay(true)));
    const badCheckpoint = await selectFile('bad-checkpoint.json', corruptCheckpoint, /체크포인트 검증/);
    await page.screenshot({ path: path.join(output, 'mobile-invalid-checkpoint.png') });

    const validReplay = await page.evaluate(() => JSON.stringify(window.__replayFeedbackE2E.makeReplay(false)));
    const chooserReady = page.waitForEvent('filechooser');
    await page.locator('#replayOpenBtn').click();
    await (await chooserReady).setFiles({
      name: 'valid-retry.json', mimeType: 'application/json', buffer: Buffer.from(validReplay)
    });
    await page.waitForFunction(() => document.querySelector('#singleStatus').classList.contains('hidden'));
    await page.locator('#replayDock').waitFor({ state: 'visible', timeout: 15000 });
    const success = await page.evaluate(() => ({
      screen: window.__replayFeedbackE2E.screen(),
      statusHidden: document.querySelector('#singleStatus').classList.contains('hidden'),
      replayLoaded: !!document.querySelector('#replayDock')
    }));
    assert.equal(success.screen, 'replay');
    assert.equal(success.statusHidden, true);
    await page.screenshot({ path: path.join(output, 'mobile-valid-retry.png') });
    assert.deepEqual(errors, []);

    const result = {
      viewport: { width: 412, height: 915 },
      cases: [
        { file: 'truncated.json', outcome: 'visible JSON error; lobby preserved', message: invalidJson.message },
        { file: 'wrong-format.json', outcome: 'visible unsupported-format explanation', message: wrongFormat.message },
        { file: 'wrong-version.json', outcome: 'visible version explanation', message: wrongVersion.message },
        { file: 'missing-commands.json', outcome: 'visible missing-data explanation', message: missingCommands.message },
        { file: 'bad-checkpoint.json', outcome: 'visible checkpoint explanation; retry remains available', message: badCheckpoint.message },
        { file: 'valid-retry.json', outcome: 'replay opened and prior error cleared' }
      ],
      success, pageErrors: errors,
      screenshots: ['mobile-invalid-json.png', 'mobile-invalid-checkpoint.png', 'mobile-valid-retry.png']
    };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
