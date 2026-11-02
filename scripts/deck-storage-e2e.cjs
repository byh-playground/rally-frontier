const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { serveSource, routePinnedSDK } = require('./netcode-qa-module.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.qa', 'deck-storage');
const key = 'rally-frontier-decks';
const broken = '{"decks": [한글 기록 오류';

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const server = await serveSource(path.join(root, 'index.html'));
  let browser;
  const deadline = setTimeout(() => { console.error('Deck storage E2E exceeded 180 seconds'); browser?.close(); }, 180000);
  try {
    browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: true });
    const results = [];
    async function scenario(name, seed, run, readDenied = false) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(({ key, seed, readDenied }) => {
        if (seed !== null) localStorage.setItem(key, seed);
        const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
        window.__deckStorageFault = { read: readDenied, write: false, writes: 0 };
        window.__deckOriginal = () => get.call(localStorage, key);
        Storage.prototype.getItem = function (name) {
          if (name === key && window.__deckStorageFault.read) throw new DOMException('Storage disabled', 'SecurityError');
          return get.call(this, name);
        };
        Storage.prototype.setItem = function (name, value) {
          if (name === key) {
            window.__deckStorageFault.writes++;
            if (window.__deckStorageFault.write) throw new DOMException('Storage full', 'QuotaExceededError');
          }
          return set.call(this, name, value);
        };
      }, { key, seed, readDenied });
      try {
        await routePinnedSDK(page);
        await page.goto(server.url, { waitUntil: 'domcontentloaded' });
        await page.locator('#gameStartBtn').click();
        await page.locator('#selectionDeckBtn').click();
        await page.locator('#singleBtn').click();
        await page.locator('#singleHostBtn').click();
        await page.locator('#deckSelectScreen').waitFor({ state: 'visible', timeout: 35000 });
        await run(page, context);
        assert.deepEqual(errors, [], name + ': no page errors');
        results.push({ name, status: 'passed', pageErrors: errors });
      } catch (error) {
        await page.screenshot({ path: path.join(output, name + '-failure.png') }).catch(() => {});
        throw error;
      } finally { await context.close(); }
    }
    const raw = page => page.evaluate(() => window.__deckOriginal());
    const notice = page => page.locator('#deckSelectStorageNotice');
    const action = (page, name, builder = false) => page.locator((builder ? '#deckBuilderStorageNotice' : '#deckSelectStorageNotice') + ` [data-deck-storage-action="${name}"]`);
    let valid;
    await scenario('new-user', null, async page => {
      assert.equal(await raw(page), null, 'Showing the starter deck does not create a record');
      assert.equal(await page.locator('#deckConfirmBtn').isEnabled(), true);
    });
    await scenario('backup-cancel-reset', broken, async page => {
      await notice(page).waitFor({ state: 'visible' });
      assert.equal(await raw(page), broken);
      assert.equal(await page.locator('#deckEditBtn').isDisabled(), true);
      assert.equal(await page.locator('#deckConfirmBtn').isDisabled(), true);
      assert.equal(await page.evaluate(() => window.__deckStorageFault.writes), 0);
      await page.screenshot({ path: path.join(output, 'protected-original.png') });
      const downloadPromise = page.waitForEvent('download');
      await action(page, 'backup').click();
      const download = await downloadPromise, chunks = [];
      for await (const chunk of await download.createReadStream()) chunks.push(chunk);
      assert.equal(Buffer.concat(chunks).toString('utf8'), broken, 'Download preserves original text');
      page.once('dialog', dialog => dialog.dismiss());
      await action(page, 'reset').click();
      assert.equal(await raw(page), broken, 'Cancel preserves original');
      page.once('dialog', dialog => dialog.accept());
      await action(page, 'reset').click();
      await notice(page).waitFor({ state: 'hidden' });
      valid = await raw(page);
      assert.equal(JSON.parse(valid).decks.length, 5);
      assert.equal(await page.locator('#deckConfirmBtn').isEnabled(), true);
    });
    await scenario('unsupported-format', '{"storageVersion":999,"decks":[],"future":"preserve"}', async page => {
      await notice(page).waitFor({ state: 'visible' });
      const original = await raw(page);
      await action(page, 'retry').click();
      assert.equal(await raw(page), original);
      assert.equal(await page.evaluate(() => window.__deckStorageFault.writes), 0);
    });
    for (const [name, original] of [['existing-empty-record', ''], ['existing-json-null', 'null']]) await scenario(name, original, async page => {
      await notice(page).waitFor({ state: 'visible' });
      assert.equal(await raw(page), original, 'An existing unreadable value is not a missing key');
      assert.equal(await page.evaluate(() => window.__deckStorageFault.writes), 0);
    });
    const mixed = JSON.parse(valid);
    mixed.decks[1] = { ...mixed.decks[0], id: 'future-deck', formatVersion: 999 };
    const mixedRaw = JSON.stringify(mixed);
    await scenario('mixed-compatible-incompatible-slots', mixedRaw, async page => {
      await notice(page).waitFor({ state: 'visible' });
      assert.equal(await raw(page), mixedRaw, 'Valid neighbouring slots remain intact');
      assert.equal(await page.locator('#deckEditBtn').isDisabled(), true);
    });
    await scenario('read-access-retry', valid, async page => {
      await notice(page).waitFor({ state: 'visible' });
      assert.equal(await action(page, 'backup').isDisabled(), true);
      assert.equal(await action(page, 'reset').isDisabled(), true);
      assert.equal(await raw(page), valid);
      await page.evaluate(() => { window.__deckStorageFault.read = false; });
      await action(page, 'retry').click();
      await notice(page).waitFor({ state: 'hidden' });
      assert.equal(await raw(page), valid);
      assert.equal(await page.locator('#deckConfirmBtn').isEnabled(), true);
    }, true);
    await scenario('write-failure-retry', valid, async page => {
      await page.locator('#deckEditBtn').click();
      await page.evaluate(() => { window.__deckStorageFault.write = true; });
      await page.locator('#deckBuilderClearBtn').click();
      assert.equal(await raw(page), valid);
      assert.match(await page.locator('#deckBuilderMessage').innerText(), /저장하지 못했습니다/);
      await page.evaluate(() => { window.__deckStorageFault.write = false; });
      await page.locator('#deckBuilderSaveBtn').click();
      assert.deepEqual(JSON.parse(await raw(page)).decks[0].cards, []);
    });
    await scenario('changed-during-edit', valid, async page => {
      await page.locator('#deckEditBtn').click();
      await page.evaluate(({ key, broken }) => localStorage.setItem(key, broken), { key, broken });
      await page.locator('#deckBuilderClearBtn').click();
      await page.locator('#deckBuilderStorageNotice').waitFor({ state: 'visible' });
      assert.equal(await raw(page), broken);
      assert.equal(await page.locator('#deckBuilderSaveBtn').isDisabled(), true);
      await page.evaluate(({ key, valid }) => localStorage.setItem(key, valid), { key, valid });
      await action(page, 'retry', true).click();
      assert.equal(await raw(page), valid);
      assert.equal(await page.locator('#deckBuilderSaveBtn').isEnabled(), true);
    });
    await scenario('changed-during-confirmation', broken, async (page, context) => {
      await notice(page).waitFor({ state: 'visible' });
      const writer = await context.newPage();
      await writer.goto(server.url + 'storage-writer');
      page.once('dialog', async dialog => {
        await writer.evaluate(({ key, valid }) => localStorage.setItem(key, valid), { key, valid });
        await dialog.accept();
      });
      await action(page, 'reset').click();
      await notice(page).waitFor({ state: 'hidden' });
      assert.equal(await raw(page), valid, 'Reset must not overwrite a record changed in another tab');
    });
    await scenario('automatic-match-transition', valid, async page => {
      await page.locator('#deckEditBtn').click();
      await page.evaluate(({ key, broken }) => localStorage.setItem(key, broken), { key, broken });
      await page.locator('#deckBuilderClearBtn').click();
      await page.locator('#deckBuilderStorageNotice').waitFor({ state: 'visible' });
      const writes = await page.evaluate(() => window.__deckStorageFault.writes);
      await page.locator('#gameScreen').waitFor({ state: 'visible', timeout: 75000 });
      assert.equal(await page.locator('#deckBuilderDialog').isVisible(), false);
      assert.equal(await raw(page), broken, 'Automatic timeout cannot persist over a protected record');
      assert.equal(await page.evaluate(() => window.__deckStorageFault.writes), writes);
    });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ results, environment: { browser: 'Chromium', readWriteFailures: 'injected Storage API failures' } }, null, 2));
    console.log(JSON.stringify({ results }, null, 2));
  } finally { clearTimeout(deadline); try { await browser?.close(); } finally { await server.close(); } }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
