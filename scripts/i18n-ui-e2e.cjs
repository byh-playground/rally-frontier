const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const { serveSource, routePinnedSDK } = require('./netcode-qa-module.cjs');

async function run() {
    const app = await serveSource(path.resolve(process.argv[2] || 'index.html'));
    const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge' });
    try {
        const context = await browser.newContext({
            locale: 'ko-KR',
            viewport: { width: 568, height: 320 },
            hasTouch: true,
            isMobile: true,
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await routePinnedSDK(page);
        const ready = async (language) => {
            await page.waitForFunction(
                (lang) =>
                    document.documentElement.lang === lang &&
                    document.documentElement.dataset.bootState === 'ready' &&
                    !document.body.classList.contains('boot-loading'),
                language,
                { timeout: 60_000 },
            );
        };
        await page.goto(app.url, { waitUntil: 'domcontentloaded' });
        await ready('ko');
        assert.equal(await page.locator('#campaignBtn').innerText(), '캠페인');
        await page.locator('#titleSettingsBtn').tap();
        const selection = page.locator('#languageSelect');
        assert.equal(await selection.count(), 1);
        await selection.selectOption('en');
        await ready('en');
        assert.equal(await selection.inputValue(), 'en');
        assert.equal(await page.locator('#campaignBtn').textContent(), 'Campaign');
        const catalogErrors = await page.evaluate(async () => {
            const { t, shellText } = await import('./src/i18n/locale.js');
            const { UNITS } = await import('./src/units/index.js');
            const { CAMPAIGN_ACT_STAGES } = await import('./src/definitions/campaign.js');
            const errors = [];
            const seen = new Set();
            const slots = (value) => [...new Set(value.match(/\{\d+\}/g) || [])].sort().join(',');
            for (const name of ['shell', 'units', 'campaign', 'main', 'ui']) {
                const table = (await import('./src/i18n/' + name + '-en.js')).default;
                for (const [key, value] of Object.entries(table)) {
                    if (
                        seen.has(key) ||
                        !value ||
                        /[가-힣]/.test(value) ||
                        slots(key) !== slots(value)
                    )
                        errors.push(key);
                    seen.add(key);
                }
            }
            function checkCopy(data) {
                if (typeof data === 'string' && /[가-힣]/.test(t(data))) errors.push(data);
                else if (data && typeof data === 'object') Object.values(data).forEach(checkCopy);
            }
            for (const unit of UNITS) {
                checkCopy([unit.unit.name, unit.card, unit.help, unit.unit.campaignUpgrade]);
            }
            for (const stage of CAMPAIGN_ACT_STAGES)
                checkCopy([stage.title, stage.story, stage.practice?.cue]);
            const html = new DOMParser().parseFromString(
                await (await fetch('./index.html')).text(),
                'text/html',
            );
            const walker = html.createTreeWalker(html.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const node = walker.currentNode;
                if (node.parentElement.closest('script,style,option[lang]')) continue;
                const key = node.nodeValue.trim().replace(/\s+/g, ' ');
                if (/[가-힣]/.test(shellText(key))) errors.push(key);
            }
            return errors;
        });
        assert.deepEqual(catalogErrors, []);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await ready('en');
        await page.locator('#settingsHelpBtn').tap();
        const limits = await page
            .locator('#launchHelpSheet details')
            .filter({
                has: page.locator('[data-help-max-zoom]'),
            })
            .locator('summary');
        await limits.tap();
        assert.deepEqual(
            await page.locator('[data-help-start-zoom], [data-help-max-zoom]').allTextContents(),
            ['150%', '350%'],
        );
        const help = await page.locator('#launchHelpSheet').innerText();
        assert.doesNotMatch(help, /[가-힣]/u);
        await page.locator('#launchHelpSheet [data-sheet-close]').tap();
        await page.locator('#campaignBtn').tap();
        await page.locator('.cs-prologue').waitFor();
        assert.doesNotMatch(await page.locator('.cs-prologue').innerText(), /[가-힣]/u);
        await page.goto(app.url + '#/settings');
        await selection.selectOption('ko');
        await ready('ko');
        assert.equal(await page.locator('#settingsHelpBtn').innerText(), '하는 법');
        assert.deepEqual(errors, []);
        console.log('PASS · Korean → English → reload → help and campaign → Korean');
    } finally {
        await browser.close();
        await app.close();
    }
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
