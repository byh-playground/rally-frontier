// Rebuild the version-bound title scenario from its deterministic in-game commands.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const qa = require('./netcode-qa-module.cjs');

(async () => {
    const root = path.resolve(__dirname, '..');
    const server = await qa.serveSource(path.join(root, 'index.html'));
    const browser = await chromium.launch({ channel: 'msedge' });
    try {
        const page = await browser.newPage();
        await qa.routePinnedSDK(page);
        await page.goto(server.url);
        await page.waitForSelector('#bootGate', { state: 'hidden', timeout: 60000 });
        const data = await page.evaluate(async () => {
            const module = await import('./src/ui/title-showcase-sim.js');
            return module.generateTitleCheckpoints();
        });
        fs.writeFileSync(path.join(root, 'assets/title-showcase.json'), JSON.stringify(data));
        console.log(
            `title showcase ${data.productVersion}, ticks ${data.checkpoints.map((c) => c.state.tick).join(', ')}`,
        );
    } finally {
        await browser.close();
        await server.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
