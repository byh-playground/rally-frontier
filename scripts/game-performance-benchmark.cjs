/*
 * Real Edge/WebGL + UI-started unit-test battle benchmark, not a match-completion E2E.
 * Exports git revisions without changing any checkout. One browser/page runs at a time.
 * Keep other game/browser benchmarks closed while running. Historical native maps
 * may differ; --canonical-map <saved map.json> makes map equality enforceable.
 * Example: node scripts/game-performance-benchmark.cjs --revisions 37f2566,42c4d8b,5e09908,a46dce5,918b86f --runs 3
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
function option(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
}
const config = {
  revisions: option('revisions', '37f2566,42c4d8b,5e09908,a46dce5,918b86f').split(','),
  runs: Number(option('runs', 3)),
  durationMs: Number(option('duration', 10000)),
  warmupMs: Number(option('warmup', 4000)),
  conditions: option('conditions', 'quiet,commands').split(','),
  output: path.resolve(option('output', path.join(root, '.qa', 'game-performance-benchmark'))),
  canonicalMap: option('canonical-map', null),
  profile: option('profile', '0') !== '0',
  count: Number(option('count', 30)),
  unit: option('unit', 'shelltitan'),
  role: option('role', 'host'),
  viewport: { width: 1280, height: 800 },
  commandIntervalMs: Number(option('command-interval', 80)),
  roomToken: 'AIPERFBENCH20261003',
};
if (argv.includes('--help')) {
  console.log(JSON.stringify(config, null, 2));
  process.exit(0);
}
assert.ok(Number.isInteger(config.runs) && config.runs > 0);
assert.ok(config.durationMs >= 500 && config.warmupMs >= 0);
assert.ok(config.conditions.every(c => ['quiet', 'commands'].includes(c)));
assert.ok(['host', 'guest'].includes(config.role));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const systemSnapshot = () => ({ at: new Date().toISOString(), freeMemoryBytes: os.freemem(),
  cpuTimes: os.cpus().map(c => c.times) });
function stats(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return { n: a.length, mean: a.reduce((sum, x) => sum + x, 0) / a.length,
    p50: a[Math.floor((a.length - 1) * .5)], p95: a[Math.floor((a.length - 1) * .95)], max: a[a.length - 1] };
}
function profileSummary(profile, inclusive = false) {
  const nodes = new Map(profile.nodes.map(n => [n.id, n]));
  const parents = new Map();
  for (const n of profile.nodes) for (const child of n.children || []) parents.set(child, n.id);
  const self = new Map();
  for (let i = 0; i < (profile.samples || []).length; i++) {
    let n = nodes.get(profile.samples[i]);
    if (!n) continue;
    const seen = new Set();
    do {
      const f = n.callFrame;
      const key = `${f.functionName || '(anonymous)'} @ ${f.url}:${f.lineNumber + 1}`;
      if (!seen.has(key)) self.set(key, (self.get(key) || 0) + (profile.timeDeltas?.[i] || 1000) / 1000);
      seen.add(key); n = inclusive ? nodes.get(parents.get(n.id)) : null;
    } while (n);
  }
  return [...self].map(([name, ms]) => ({ name, [inclusive ? 'inclusiveMs' : 'selfMs']: ms }))
    .sort((a, b) => (b.inclusiveMs ?? b.selfMs) - (a.inclusiveMs ?? a.selfMs)).slice(0, inclusive ? 70 : 35);
}

function instrumentation({ roomToken, canonicalMap }) {
  window.__perfBench = { ActiveViewState, MatchLifecycle, BUILD_META, StrategySim, TerrainNavigation,
    frames: [], steps: [], longTasks: [], packets: [], commands: [], measuring: false };
  const b = window.__perfBench;
  MatchLifecycle.singleRoomToken = () => roomToken;
  if (canonicalMap) MapGeneration.generateMapDescriptor = () => JSON.parse(JSON.stringify(canonicalMap));
  try { new PerformanceObserver(list => {
    if (b.measuring) for (const e of list.getEntries()) b.longTasks.push({ at: e.startTime - b.startedAt, duration: e.duration });
  }).observe({ type: 'longtask', buffered: false }); } catch (_) { /* Browser support is recorded separately. */ }
  const step = StrategySim.prototype.step;
  StrategySim.prototype.step = function (...args) {
    if (!b.measuring) return step.apply(this, args);
    const t = performance.now();
    const before = { ...this.navigation?.metrics };
    const result = step.apply(this, args);
    const after = this.navigation?.metrics || {};
    const role = Object.entries(MatchLifecycle.singleMatch?.sessions || {}).find(([, s]) => s.sim === this)?.[0] || 'unknown';
    b.steps.push({ at: t - b.startedAt, role, tick: this.tick, ms: performance.now() - t,
      aliveUnits: this.units.filter(u => u.alive).length,
      nav: Object.fromEntries(['fieldsBuilt', 'layersBuilt', 'fieldHits', 'invalidations', 'meshBuildMs', 'fieldBuildMs', 'regionsBuilt', 'routeQueries']
        .map(key => [key, (after[key] || 0) - (before[key] || 0)])),
      telemetry: this.perfStats.sampleTick === this.tick ? { ...this.perfStats } : null });
    return result;
  };
  const packet = GameSession.prototype.sendGameplayPacket;
  if (packet) GameSession.prototype.sendGameplayPacket = function (payload, ...rest) {
    if (b.measuring) b.packets.push({ at: performance.now() - b.startedAt, role: this.role, type: payload?.type, tick: this.sim?.tick });
    return packet.call(this, payload, ...rest);
  };
  b.begin = (condition, commandIntervalMs) => {
    b.startedAt = performance.now(); b.measuring = true;
    b.startTicks = Object.fromEntries(Object.entries(MatchLifecycle.singleMatch.sessions).map(([role, s]) => [role, s.sim.tick]));
    let last = performance.now();
    const frame = () => {
      if (!b.measuring) return;
      const r = ActiveViewState.renderer, p = r.perfStats, now = performance.now();
      const sessions = Object.fromEntries(Object.entries(MatchLifecycle.singleMatch.sessions).map(([role, s]) => [role, {
        tick: s.sim?.tick, syncHold: s.syncHold, recoveryPhase: s.recoveryPhase,
        fatal: !!s.simulationFatal, peerTick: s.role === 'host' ? s.lastRemoteTick : s.hostClockTick,
        peerTickAgeMs: now - ((s.role === 'host' ? s.remoteTickReceivedAt : s.hostClockReceivedAt) || now),
      }]));
      b.frames.push({ at: now - b.startedAt, intervalMs: now - last, workMs: p.frameWorkMs,
        drawCalls: p.drawCalls, uploadBytes: p.bufferUploadBytes, depthSortMs: p.cpuDepthSortMs,
        terrainTriangles: p.terrainVisibleTriangles, riverTriangles: p.riverVisibleTriangles,
        meshHits: p.unitBodyMeshCacheHits, meshMisses: p.unitBodyMeshCacheMisses,
        passes: p.passes, sessions });
      last = now; requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    if (condition === 'commands') {
      let i = 0;
      b.commandTimer = setInterval(() => {
        const s = ActiveViewState.session, map = s.sim.world;
        const action = { type: 'SET_FLAG', x: Math.round(map.width * (.45 + (i % 2) * .1)), y: Math.round(map.height * (.45 + (i % 3) * .05)), forced: true };
        b.commands.push({ at: performance.now() - b.startedAt, tick: s.sim.tick, action, accepted: s.command(action) }); i++;
      }, commandIntervalMs);
    }
  };
  b.end = () => {
    b.measuring = false; clearInterval(b.commandTimer);
    return { durationMs: performance.now() - b.startedAt, frames: b.frames, steps: b.steps,
      longTasks: b.longTasks, packets: b.packets, commands: b.commands, startTicks: b.startTicks,
      endTicks: Object.fromEntries(Object.entries(MatchLifecycle.singleMatch.sessions).map(([role, s]) => [role, s.sim.tick])),
      rendererFatalReported: !!ActiveViewState.renderer?.renderFatalReported,
      navigation: Object.fromEntries(Object.entries(MatchLifecycle.singleMatch.sessions).map(([role, s]) => [role, s.sim.navigation?.metrics])) };
  };
}

async function runOne(browser, revision, condition, repetition, canonicalMap) {
  const systemBefore = systemSnapshot();
  const dir = path.join(config.output, `${revision.label}-${condition}-${repetition}`);
  fs.mkdirSync(dir, { recursive: true });
  const page = await browser.newPage({ viewport: config.viewport, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let source = git('show', `${revision.sha}:index.html`);
  const tail = source.lastIndexOf('})();');
  assert.ok(tail >= 0, 'App IIFE injection boundary is present');
  source = source.slice(0, tail) + `\n(${instrumentation.toString()})(${JSON.stringify({ roomToken: config.roomToken, canonicalMap })});\n` + source.slice(tail);
  await page.route('http://127.0.0.1:32119/**', route => {
    const requested = new URL(route.request().url()).pathname;
    if (requested === '/') return route.fulfill({ contentType: 'text/html', body: source });
    try {
      const content = git('show', `${revision.sha}:${decodeURIComponent(requested).slice(1)}`);
      return route.fulfill({ contentType: requested.endsWith('.js') ? 'application/javascript' : 'text/plain', body: content });
    } catch (_) { return route.fulfill({ status: 404, body: '' }); }
  });
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.goto('http://127.0.0.1:32119/', { waitUntil: 'domcontentloaded' });
    await page.locator('#gameStartBtn').click();
    await page.locator('#advancedTestSettings summary').click();
    await page.locator('#unitTestAllyType').selectOption(config.unit);
    await page.locator('#unitTestEnemyType').selectOption(config.unit);
    await page.locator('#unitTestAllyCount').fill(String(config.count));
    await page.locator('#unitTestEnemyCount').fill(String(config.count));
    await page.locator('#unitTestBtn').click();
    await page.locator(config.role === 'host' ? '#singleHostBtn' : '#singleGuestBtn').click();
    await page.locator('#gameScreen').waitFor({ state: 'visible', timeout: 60000 });
    await page.waitForFunction(() => Object.values(window.__perfBench.MatchLifecycle.singleMatch?.sessions || {}).every(s => s.sim?.tick > 3), null, { timeout: 60000 });
    const setup = await page.evaluate(() => {
      const { ActiveViewState, MatchLifecycle, BUILD_META } = window.__perfBench;
      const r = ActiveViewState.renderer, gl = r.gl, ext = gl.getExtension('WEBGL_debug_renderer_info');
      const s = MatchLifecycle.singleMatch.sessions.host.sim;
      return { build: BUILD_META.id, role: r.role, backend: r.backend,
        webglVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        webglRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        userAgent: navigator.userAgent, devicePixelRatio, tps: s.tps, seed: s.seed,
        map: s.mapDescriptor, roster: s.units.map(u => ({ type: u.type, side: u.side })).sort((a, b) => a.side - b.side || a.type.localeCompare(b.type)),
        transport: ActiveViewState.transport.constructor.name,
        longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask') };
    });
    assert.equal(setup.backend, 'WebGL');
    setup.softwareRenderer = /swiftshader|llvmpipe|software|basic render/i.test(setup.webglRenderer);
    setup.mapHash = hash(setup.map); setup.rosterHash = hash(setup.roster);
    if (canonicalMap) assert.equal(setup.mapHash, hash(canonicalMap), 'Every revision uses the exact canonical map descriptor');
    json(path.join(dir, 'map.json'), setup.map);
    const minimapPoint = await page.evaluate(() => {
      const m = window.__perfBench.ActiveViewState.minimap, rect = m.contentRect();
      return { x: rect.left + rect.width * .5, y: rect.top + rect.height * .5 };
    });
    await page.mouse.click(minimapPoint.x, minimapPoint.y);
    await page.waitForFunction(warmup => {
      const s = window.__perfBench.MatchLifecycle.singleMatch.sessions.host.sim;
      return s.tick >= 5 + Math.ceil(warmup * s.tps / 1000);
    }, config.warmupMs, { timeout: 60000 });
    if (config.profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 1000 }); await cdp.send('Profiler.start'); }
    await page.evaluate(({ condition, interval }) => window.__perfBench.begin(condition, interval), { condition, interval: config.commandIntervalMs });
    await page.waitForTimeout(config.durationMs);
    const measurements = await page.evaluate(() => window.__perfBench.end());
    let cpu = null, cpuInclusive = null;
    if (config.profile) { const { profile } = await cdp.send('Profiler.stop'); json(path.join(dir, 'cpu.cpuprofile'), profile); cpu = profileSummary(profile); cpuInclusive = profileSummary(profile, true); }
    await page.screenshot({ path: path.join(dir, 'battle.png') });
    const systemAfter = systemSnapshot();
    const cpuDelta = key => systemAfter.cpuTimes.reduce((sum, c, i) => sum + c[key] - systemBefore.cpuTimes[i][key], 0);
    const systemBusyRatio = 1 - cpuDelta('idle') / ['user', 'nice', 'sys', 'idle', 'irq'].reduce((sum, key) => sum + cpuDelta(key), 0);
    const system = { before: systemBefore, after: systemAfter, busyRatio: systemBusyRatio };
    const result = { revision, condition, repetition, setup, errors, measurements, cpu, cpuInclusive, system };
    delete setup.map;
    const passes = [...new Set(measurements.frames.flatMap(f => Object.keys(f.passes || {})))];
    result.summary = {
      frames: measurements.frames.length, frameIntervalMs: stats(measurements.frames.slice(1).map(f => f.intervalMs)),
      frameWorkMs: stats(measurements.frames.map(f => f.workMs)),
      longTasks: { count: measurements.longTasks.length, totalMs: measurements.longTasks.reduce((sum, x) => sum + x.duration, 0), durationMs: stats(measurements.longTasks.map(x => x.duration)) },
      passes: Object.fromEntries(passes.map(key => [key, stats(measurements.frames.map(f => f.passes?.[key]?.ms))])),
      drawCalls: stats(measurements.frames.map(f => f.drawCalls)), uploadBytes: stats(measurements.frames.map(f => f.uploadBytes)),
      depthSortMs: stats(measurements.frames.map(f => f.depthSortMs)),
      meshCacheHits: stats(measurements.frames.map(f => f.meshHits)), meshCacheMisses: stats(measurements.frames.map(f => f.meshMisses)),
      visibleTerrainTriangles: stats(measurements.frames.map(f => f.terrainTriangles)),
      commands: measurements.commands.length,
      sessions: Object.fromEntries(['host', 'guest'].map(role => {
        const steps = measurements.steps.filter(s => s.role === role);
        let maxGap = 0, lastAt = 0;
        for (const s of steps) { maxGap = Math.max(maxGap, s.at - lastAt); lastAt = s.at; }
        maxGap = Math.max(maxGap, measurements.durationMs - lastAt);
        return [role, { steps: steps.length, actualTps: steps.length * 1000 / measurements.durationMs,
          stepMs: stats(steps.map(s => s.ms)), maxStepGapMs: maxGap,
          nav: Object.fromEntries(['fieldsBuilt', 'layersBuilt', 'invalidations', 'meshBuildMs', 'fieldBuildMs', 'routeQueries'].map(k => [k, steps.reduce((sum, s) => sum + s.nav[k], 0)])),
          telemetry: Object.fromEntries(['combatMs', 'collisionMs', 'visionMs', 'worldMs', 'workerMs'].map(k => [k, stats(steps.filter(s => s.telemetry).map(s => s.telemetry[k]))])) }];
      })),
    };
    json(path.join(dir, 'result.json'), result);
    console.log(JSON.stringify({ revision: revision.label, condition, repetition, mapHash: setup.mapHash,
      softwareRenderer: setup.softwareRenderer, frameWorkMs: result.summary.frameWorkMs.mean,
      frameIntervalMs: result.summary.frameIntervalMs.mean, hostStepMs: result.summary.sessions.host.stepMs?.mean,
      hostTps: result.summary.sessions.host.actualTps, directory: dir }));
    assert.deepEqual(errors, [], 'No browser JavaScript errors');
    return { revision, condition, repetition, setup, summary: result.summary, cpu, cpuInclusive, system, directory: dir };
  } catch (error) {
    json(path.join(dir, 'failure.json'), { message: error.stack, errors, body: await page.locator('body').innerText().catch(() => '') });
    throw error;
  } finally { await cdp.detach(); await page.close(); }
}

async function main() {
  fs.mkdirSync(config.output, { recursive: true });
  const canonicalMap = config.canonicalMap ? JSON.parse(fs.readFileSync(config.canonicalMap, 'utf8')) : null;
  const revisions = config.revisions.map(label => ({ label, sha: git('rev-parse', `${label}^{commit}`).trim() }));
  const machine = { platform: process.platform, cpus: os.cpus().map(c => c.model), memoryBytes: os.totalmem(), node: process.version };
  const results = [];
  const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL || 'msedge', headless: process.env.QA_HEADED !== '1' });
  try {
    for (let rep = 1; rep <= config.runs; rep++) {
      // Rotate revision order to avoid always penalizing the latest revision with heat/background drift.
      const ordered = [...revisions.slice((rep - 1) % revisions.length), ...revisions.slice(0, (rep - 1) % revisions.length)];
      for (const revision of ordered) for (const condition of config.conditions) {
        const result = await runOne(browser, revision, condition, rep, canonicalMap);
        if (results.length) {
          assert.equal(result.setup.seed, results[0].setup.seed, 'Simulation seed is identical across conditions');
          assert.equal(result.setup.rosterHash, results[0].setup.rosterHash, 'Initial unit roster is identical across conditions');
        }
        results.push(result);
        json(path.join(config.output, 'summary.json'), { kind: 'RALLY_REAL_WEBGL_BENCHMARK', config, machine, browserVersion: browser.version(), results });
      }
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
