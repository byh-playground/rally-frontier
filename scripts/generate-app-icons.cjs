// Build app icons from the game's actual cannon and shared GameKit rice portrait.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { serveSource, routePinnedSDK } = require('./netcode-qa-module.cjs');

(async () => {
  const root = path.resolve(__dirname, '..');
  const server = await serveSource(path.join(root, 'index.html'));
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge' });
  try {
    const page = await browser.newPage();
    await routePinnedSDK(page);
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.locator('#bootGate').waitFor({ state: 'hidden', timeout: 90000 });
    const images = await page.evaluate(async () => {
      const { grainPortrait } = await import('./src/ui/grain-portrait.js');
      const portrait = new Image();
      portrait.src = await grainPortrait('rice', window.RallyVectorAssets.rice, 320);
      const cannon = new Image(); cannon.src = './assets/units/cannon.svg';
      await Promise.all([portrait.decode(), cannon.decode()]);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
      const c = canvas.getContext('2d');
      c.fillStyle = '#407b49'; c.fillRect(0, 0, 512, 512);
      c.fillStyle = '#e7f3c7'; c.beginPath(); c.arc(256, 245, 192, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#f5c74d'; c.beginPath(); c.arc(337, 170, 61, 0, Math.PI * 2); c.fill();
      c.drawImage(portrait, 69, 35, 260, 284);
      c.save(); c.translate(265, 331); c.rotate(-0.34);
      c.drawImage(cannon, -177, -177, 354, 354); c.restore();
      return [180, 192, 512].map(size => {
        const out = document.createElement('canvas'); out.width = out.height = size;
        out.getContext('2d').drawImage(canvas, 0, 0, size, size);
        return { size, data: out.toDataURL('image/png').split(',')[1] };
      });
    });
    for (const image of images) fs.writeFileSync(path.join(root, 'icons', `ssalkongpang-${image.size}.png`), Buffer.from(image.data, 'base64'));
    console.log('Generated 180, 192 and 512px icons from the current game assets.');
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
