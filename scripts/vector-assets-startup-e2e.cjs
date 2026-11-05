const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { readProductVersion } = require('./product-version.cjs');

async function deploymentState(page) {
    await page.waitForFunction(
        () =>
            window.__RALLY_BUILD_METADATA__ && window.__RALLY_BUILD_METADATA__.status !== 'pending',
        undefined,
        { timeout: 10_000 },
    );
    // The title stamp is redrawn after the metadata settles; read it once it leaves the pending text.
    await page.waitForFunction(
        () => document.getElementById('titleUpdateStamp')?.textContent !== '확인 중',
        undefined,
        { timeout: 10_000 },
    );
    return page.evaluate(() => ({
        metadata: window.__RALLY_BUILD_METADATA__,
        build: document.documentElement.dataset.build,
        label: document.getElementById('titleUpdateStamp')?.textContent,
    }));
}

async function verifyOptionalMetadata(browser, server, routePinnedSDK, record) {
    const results = [];
    for (const scenario of [
        'missing',
        'malformed',
        'invalid-record',
        'missing-version',
        'version-mismatch',
        'network-failure',
        'timeout',
    ]) {
        const page = await browser.newPage(),
            errors = [];
        let requests = 0;
        page.on('pageerror', (error) => errors.push(error.message));
        await routePinnedSDK(page);
        await page.route('**/build.json', (route) => {
            requests++;
            if (scenario === 'timeout') return;
            if (scenario === 'network-failure') return route.abort('failed');
            if (scenario === 'version-mismatch')
                return route.fulfill({
                    contentType: 'application/json',
                    body: JSON.stringify({ ...record, productVersion: '9.9.9' }),
                });
            if (scenario === 'missing-version') {
                const { productVersion, ...unversioned } = record;
                return route.fulfill({
                    contentType: 'application/json',
                    body: JSON.stringify(unversioned),
                });
            }
            return route.fulfill({
                status: scenario === 'missing' ? 404 : 200,
                contentType: 'application/json',
                body: scenario === 'malformed' ? '{' : '{}',
            });
        });
        try {
            await page.goto(server.url, { waitUntil: 'domcontentloaded' });
            await page.locator('#titleUpdateStamp').waitFor({ state: 'visible' });
            const state = await deploymentState(page);
            if (state.metadata.status !== 'unavailable' || state.metadata.commit !== null)
                throw new Error(`Invalid ${scenario} deployment status`);
            if (!state.label.includes('배포 정보 확인 불가') || state.label.includes('미배포'))
                throw new Error(`${scenario}: source availability was mislabeled`);
            if (
                state.metadata.productVersion !== record.productVersion ||
                !state.label.includes('v' + record.productVersion)
            )
                throw new Error(`${scenario}: source product version was lost`);
            if (requests !== 1 || errors.length)
                throw new Error(
                    `${scenario}: metadata requests/errors ${requests}/${errors.join('; ')}`,
                );
            results.push({ scenario, status: state.metadata.status, requests, pageErrors: errors });
        } finally {
            await page.close();
        }
    }
    const page = await browser.newPage();
    try {
        await routePinnedSDK(page);
        let metadataRoute;
        await page.route('**/build.json', (route) => {
            metadataRoute = route;
        });
        await page.route('**/rollback.js', (route) =>
            route.fulfill({
                contentType: 'text/javascript',
                headers: { 'access-control-allow-origin': '*' },
                body: 'throw new Error("expected SDK failure fixture")',
            }),
        );
        await page.goto(server.url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
            () =>
                window.__RALLY_FATAL_DIAGNOSTIC__?.kind === 'RALLY_NETCODE_LOAD_FAILED' &&
                window.__RALLY_FATAL_DIAGNOSTIC__?.buildMetadata?.status === 'pending',
        );
        if (!metadataRoute)
            throw new Error('Early SDK failure did not independently request deployment metadata');
        await metadataRoute.fulfill({
            contentType: 'application/json',
            body: JSON.stringify(record),
        });
        await page.waitForFunction(
            (commit) =>
                window.__RALLY_FATAL_DIAGNOSTIC__?.kind === 'RALLY_NETCODE_LOAD_FAILED' &&
                window.__RALLY_FATAL_DIAGNOSTIC__?.buildMetadata?.commit === commit,
            record.commit,
        );
        const diagnostic = await page.evaluate(() => window.__RALLY_FATAL_DIAGNOSTIC__);
        if (diagnostic.buildMetadata.productVersion !== record.productVersion)
            throw new Error('Early SDK failure omitted product version');
        if (diagnostic.build !== record.commit || diagnostic.buildMetadata.source !== 'build.json')
            throw new Error('Early SDK failure omitted deployment identity');
        results.push({ scenario: 'early-sdk-failure', commit: diagnostic.buildMetadata.commit });
    } finally {
        await page.close();
    }
    return results;
}

async function main(htmlPath = path.resolve(process.argv[2] || '_site/index.html')) {
    const { serveSource, routePinnedSDK } = require('./netcode-qa-module.cjs');
    const expected = JSON.parse(
        fs.readFileSync(path.join(path.dirname(htmlPath), 'assets/units/manifest.json'), 'utf8'),
    );
    const metadataFile = path.join(path.dirname(htmlPath), 'build.json');
    const productVersion = readProductVersion(path.dirname(htmlPath));
    const expectedBuild = fs.existsSync(metadataFile)
        ? JSON.parse(fs.readFileSync(metadataFile, 'utf8'))
        : null;
    const server = await serveSource(htmlPath, {
        observer: 'window.__startupRenderer = () => ActiveViewState.renderer;',
    });
    let browser;
    try {
        browser = await chromium.launch({
            headless: true,
            channel: process.env.QA_BROWSER_CHANNEL || 'msedge',
        });
        const page = await browser.newPage();
        await routePinnedSDK(page);
        const pageErrors = [];
        const relativeRequests = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('request', (request) => {
            const pathname = new URL(request.url()).pathname;
            if (
                request.url().startsWith('http://127.0.0.1:') &&
                pathname !== '/' &&
                pathname !== '/index.html' &&
                pathname !== '/favicon.ico'
            )
                relativeRequests.push(request.url());
        });
        await page.goto(server.url, { waitUntil: 'domcontentloaded' });
        await page.locator('#bootGate').waitFor({ state: 'hidden', timeout: 90_000 });
        const prepared = await page.evaluate(() => ({
            holds: window.__startupRenderer()?.gameResourceHolds?.length ?? 0,
            riceAtlas: !!window.__startupRenderer()?.riceSprites?.atlas?.region,
            beanAtlases: ['soybean', 'redbean'].every(
                (type) => !!window.__startupRenderer()?.beanSprites?.[type]?.atlas?.region,
            ),
            device: window.__startupRenderer()?.device?.state,
            loopStarted: window.__startupRenderer()?.loopStarted,
        }));
        if (
            prepared.holds !== expected.assets.length ||
            !prepared.riceAtlas ||
            !prepared.beanAtlases ||
            prepared.device !== 'ready' ||
            prepared.loopStarted
        )
            throw new Error(
                `GPU resources were not prepared before the lobby: ${JSON.stringify(prepared)}`,
            );
        await page.waitForFunction(
            () =>
                Object.keys(window.RallyVectorAssets || {}).length > 0 &&
                typeof window.RallyGamekit?.createVectorAssetLoader === 'function' &&
                window.RallyVectorAssetLoader,
            undefined,
            { timeout: 90_000 },
        );
        const result = await page.evaluate((expected) => {
            const assets = window.RallyVectorAssets || {};
            return {
                ids: Object.keys(assets).sort(),
                expectedIds: expected.assets.map((entry) => entry.id).sort(),
                sourceHashes: Object.fromEntries(
                    Object.entries(assets).map(([id, asset]) => [id, asset.sourceSha256]),
                ),
                expectedHashes: Object.fromEntries(
                    expected.assets.map((entry) => [entry.id, entry.sha256]),
                ),
                geometry: Object.fromEntries(
                    Object.entries(assets).map(([id, asset]) => [
                        id,
                        Boolean(asset.geometry && asset.metadata && asset.viewBox),
                    ]),
                ),
                omittedSourcePaths: Object.values(assets).every(
                    (asset) => !Object.hasOwn(asset, 'sourcePaths'),
                ),
                cacheSize: window.RallyVectorAssetLoader?.size ?? -1,
                pendingLoads: window.RallyVectorAssetLoader?.pendingCount ?? -1,
                moduleAPI: typeof window.RallyGamekit?.createVectorAssetLoader,
            };
        }, expected);
        if (result.ids.length !== expected.assets.length)
            throw new Error(
                `Expected ${expected.assets.length} compiled SVGs, found ${result.ids.length}`,
            );
        if (JSON.stringify(result.ids) !== JSON.stringify(result.expectedIds))
            throw new Error('Compiled unit IDs do not match the SVG manifest');
        if (JSON.stringify(result.sourceHashes) !== JSON.stringify(result.expectedHashes))
            throw new Error('Compiled source hashes do not match the SVG manifest');
        if (Object.values(result.geometry).some((value) => !value))
            throw new Error('A compiled unit SVG has no geometry, metadata, or viewBox');
        if (!result.omittedSourcePaths)
            throw new Error('Compiled unit SVGs unexpectedly include sourcePaths');
        if (result.cacheSize !== result.ids.length || result.pendingLoads !== 0)
            throw new Error(
                'SDK startup loader cache does not contain every completed unit compilation',
            );
        if (result.moduleAPI !== 'function')
            throw new Error('Pinned GameKit loader API is missing from the runtime');
        if (!relativeRequests.some((url) => new URL(url).pathname === '/src/main.js'))
            throw new Error('Original source entrypoint was not requested');
        if (
            !relativeRequests.some((url) => new URL(url).pathname === '/assets/units/manifest.json')
        )
            throw new Error('Original SVG manifest was not requested');
        const deployment = await deploymentState(page);
        if (
            deployment.metadata.productVersion !== productVersion ||
            !deployment.label.includes('v' + productVersion)
        )
            throw new Error('Source product version is missing from metadata or title');
        if (
            expectedBuild &&
            (deployment.metadata.status !== 'available' ||
                deployment.metadata.commit !== expectedBuild.commit ||
                deployment.build !== expectedBuild.commit ||
                !deployment.label.includes(expectedBuild.commit.slice(0, 12)))
        )
            throw new Error('Deployment identity does not match the copied source revision');
        if (
            !expectedBuild &&
            (deployment.metadata.status !== 'unavailable' ||
                deployment.metadata.commit !== null ||
                deployment.label.includes('미배포'))
        )
            throw new Error('Source checkout metadata status was fabricated');
        if (relativeRequests.filter((url) => new URL(url).pathname === '/build.json').length !== 1)
            throw new Error('Deployment metadata must be requested exactly once per page');
        if (pageErrors.length)
            throw new Error(`Browser page errors during startup: ${pageErrors.join('; ')}`);
        await page.close();
        const metadataScenarios = await verifyOptionalMetadata(
            browser,
            server,
            routePinnedSDK,
            expectedBuild || {
                format: 'source-esm',
                productVersion,
                commit: 'a'.repeat(40),
                builtAt: '2026-11-02T00:00:00.000Z',
            },
        );
        console.log(
            JSON.stringify(
                {
                    status: 'passed',
                    assetCount: result.ids.length,
                    deployment,
                    metadataScenarios,
                    relativeRequests,
                    pageErrors,
                },
                null,
                2,
            ),
        );
    } finally {
        try {
            await browser?.close();
        } finally {
            await server.close();
        }
    }
}

if (require.main === module)
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
