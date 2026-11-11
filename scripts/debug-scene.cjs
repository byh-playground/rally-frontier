// Opens one debug scene address (src/debug-scenes.js) in headless Chromium and prints its state as JSON.
// A tool, not a test: it never passes or fails a result. See AGENTS.md "디버그 장면".
//
//   node scripts/debug-scene.cjs "<query>" [--ticks N] [--capture out.png] [--compare <checkout>] [--repeat N] [--gpu]
//
//   <query>      the address after `?debug=1&`, e.g. "scene=walnut-melee&map=artillery-basin&seed=1&units=150&mix=rice,pea&walnuts=5&tick=100"
//   --ticks N    after the scene is ready, step N more ticks (__bloomDebug.step) before reading the state
//   --capture    save a screenshot; with --compare the other checkout's goes to <name>-compare.png
//   --compare    run the same address on another checkout (a worktree path) and print both side by side
//   --repeat N   with --compare, alternate the two checkouts N times each (timing under load)
//   --gpu        draw on the real GPU (ANGLE D3D11) instead of SwiftShader; SwiftShader gives identical pixels
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ANGLE = {
    swiftshader: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    gpu: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'],
};

function readArguments(argv) {
    const [query, ...rest] = argv;
    if (!query || query.startsWith('--'))
        throw new Error('usage: debug-scene.cjs "<query>" [options]');
    const options = { query, ticks: 0, capture: null, compare: null, repeat: 1, gpu: false };
    for (let i = 0; i < rest.length; i++) {
        const name = rest[i];
        if (name === '--gpu') options.gpu = true;
        else if (name === '--ticks' || name === '--repeat') {
            const value = Number(rest[++i]);
            if (!Number.isSafeInteger(value) || value < 0)
                throw new Error(`${name} needs an integer`);
            options[name.slice(2)] = value;
        } else if (name === '--capture') options.capture = path.resolve(rest[++i]);
        else if (name === '--compare') options.compare = path.resolve(rest[++i]);
        else throw new Error(`unknown option ${name}`);
    }
    return options;
}

// One checkout: its own source server and its own pinned GameKit bytes.
async function openCheckout(root) {
    await require(path.join(root, 'scripts', 'setup-gamekit.cjs')).setupGamekit(root);
    const qa = require(path.join(root, 'scripts', 'netcode-qa-module.cjs'));
    const commit = require('node:child_process')
        .execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' })
        .trim();
    return { root, commit, qa, server: await qa.serveSource(path.join(root, 'index.html')) };
}

async function runScene(browser, checkout, { query, ticks }, capture) {
    const context = await browser.newContext({
        viewport: { width: 540, height: 900 },
        deviceScaleFactor: 1,
    });
    const page = await context.newPage(),
        pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    try {
        await checkout.qa.routePinnedSDK(page);
        await page.goto(`${checkout.server.url}?debug=1&${query}`, {
            waitUntil: 'domcontentloaded',
        });
        await page.waitForFunction(
            () =>
                globalThis.__bloomDebug?.error ||
                (globalThis.__bloomDebug?.ready &&
                    !document.body.classList.contains('boot-loading')),
            null,
            { timeout: 600_000, polling: 100 },
        );
        const error = await page.evaluate(() => globalThis.__bloomDebug.error);
        if (error) throw new Error(error);
        if (ticks)
            await page.evaluate((count) => globalThis.__bloomDebug.step(count), ticks, {
                timeout: 600_000,
            });
        const state = await page.evaluate(() => globalThis.__bloomDebug.state());
        if (capture) {
            fs.mkdirSync(path.dirname(capture), { recursive: true });
            await page.screenshot({ path: capture, animations: 'disabled' });
        }
        if (pageErrors.length) state.pageErrors = pageErrors;
        return state;
    } finally {
        await context.close();
    }
}

// The fields worth reading across two checkouts at a glance.
function brief(label, state) {
    return {
        run: label,
        simTick: state.simTick,
        checksum: state.checksum,
        units: `${state.units.host}/${state.units.guest}`,
        'tick mean': state.tickMs?.mean,
        'tick p95': state.tickMs?.p95,
        'tick max': state.tickMs?.max,
        'collision mean': state.stageMs?.mean.collision,
        'collision max': state.stageMs?.max.collision,
        skipped: state.contacts?.skippedPairs,
        overlap: state.overlap?.pairs,
    };
}

(async () => {
    const options = readArguments(process.argv.slice(2));
    const checkouts = [await openCheckout(path.resolve(__dirname, '..'))];
    if (options.compare) checkouts.push(await openCheckout(options.compare));
    const browser = await chromium.launch({
        args: options.gpu ? ANGLE.gpu : ANGLE.swiftshader,
    });
    try {
        const runs = [];
        for (let round = 0; round < (options.compare ? options.repeat || 1 : 1); round++)
            for (const [index, checkout] of checkouts.entries()) {
                const capture =
                    options.capture && round === 0
                        ? index === 0
                            ? options.capture
                            : options.capture.replace(/(\.[^.]+)?$/, '-compare$1')
                        : null;
                const state = await runScene(browser, checkout, options, capture);
                runs.push({ checkout: checkout.root, commit: checkout.commit, round, state });
            }
        if (!options.compare) {
            console.log(JSON.stringify(runs[0].state, null, 2));
            return;
        }
        console.log(JSON.stringify(runs, null, 2));
        console.table(runs.map((run) => brief(`${run.commit} #${run.round + 1}`, run.state)));
    } finally {
        await browser.close();
        for (const checkout of checkouts) await checkout.server.close();
    }
})().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
