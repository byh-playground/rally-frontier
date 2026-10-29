"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const html = readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
const classStart = html.indexOf("class MobileBattleTestMode{");
const classEnd = html.indexOf("\nconst CAMPAIGN_MISSION_SCHEMA_VERSION=", classStart);
assert.ok(classStart >= 0 && classEnd > classStart, "MobileBattleTestMode class boundary should be present");
const classSource = html.slice(classStart, classEnd);

function stats(p50 = 0, p95 = 0, max = 0, mean = p50) {
  return { count: 12, p50, p95, max, mean };
}

function peer(offset = 0) {
  const stageKeys = ["totalMs", "indexMs", "worldMs", "economyMs", "workerMs", "visionMs", "combatMs", "combatTargetPickMs", "combatOtherMs", "projectileMs", "collisionMs", "collisionSoftApplyMs", "postMs"];
  const sampledStages = Array.from({ length: 15 }, (_, index) => ({
    sampleTick: index * 10 + offset,
    stageMs: Object.fromEntries(stageKeys.map((key, stageIndex) => [key, index + stageIndex + offset])),
    workCounters: {
      spatialQueries: index + offset, spatialCandidates: index * 4 + offset, targetQueries: index * 3 + offset, combatTargetPickCalls: index + 2, collisionPairs: index * 2 + offset,
      collisionSoftPasses: 1, collisionSoftContacts: index + offset, collisionSoftMovedUnits: index,
      collisionSoftCappedUnits: index % 2, collisionSweptCalls: 2, collisionSweptActivePasses: 1,
      collisionHardFixCalls: 1, collisionHardFixPasses: 1, collisionHardFixCorrections: 0,
    },
    step: { lastMs: index, ewmaMs: index + 0.5, samples: index + 1 },
    snapshot: { latestMs: index / 2, samplesAtCapture: index + 1, totalMsAtCapture: index * 2 },
  }));
  return {
    available: true,
    sampleCadenceMs: 1000,
    sampledStages,
    step: { ticksDuringSample: 97, totalCpuMsDuringSample: 945.7, lastStepMs: 11.25, ewmaStepMs: 16.4, maxObservedStepMs: 54.4, lifetimeMaxStepMs: 75.2 },
    snapshot: { samplesDuringSample: 77, totalMsDuringSample: 543, averageMsDuringSample: 7.05, latestSnapshotMs: 5.5, lifetimeMaxSnapshotMs: 22.9 },
    snapshotUi: { samplesDuringSample: 14, totalMsDuringSample: 23.5 },
    sessionPulse: { samplesDuringSample: 101, totalMsDuringSample: 1120.25, averageMsDuringSample: 11.09 },
  };
}

function reportFixture() {
  const slowFrame = {
    frameIndex: 8, rendererFrameSequence: 108, frameIntervalMs: 180, elapsedWindowMs: 180, rendererCpuMs: 37,
    host: { step: { count: 2, cpuMs: 2 }, snapshot: { count: 1, cpuMs: 0.5 }, sessionPulse: { cpuMs: 4 } },
    guest: { step: { count: 1, cpuMs: 1.3 }, snapshot: { count: 1, cpuMs: 0.4 }, sessionPulse: { cpuMs: 3 } },
    unattributedElapsedMs: 120, vector: { drawMeshSubmissions: 285, meshInstances: 300, webglDrawDispatches: 572, alphaRunDispatches: 80, alphaRunSafeBatches: 1, alphaRunBatchedInstances: 2, alphaRunDrawsSaved: 4, alphaRunOverlapBoundaries: 1 },
    vectorFlushes: { events: 6, reasons: { alphaOverlap: 4, "world-pass-end": 1, explicit: 1 } },
    vectorDrawDispatchReasons: { "world-pass-end": 492, alphaImmediateRun: 80 },
  };
  return {
    schemaVersion: 3,
    testMode: "mobile-battle",
    capturedAt: "2026-10-16T03:35:57.594Z",
    build: { id: "20261016T033522+0000-rf-0c5866d65800", commit: "0123456789abcdef" }, collisionModel: "ally-soft-one-pass",
    device: { userAgent: "Headless browser details are omitted from summary", platform: "Win32", hardwareConcurrency: 12, viewport: { width: 844, height: 390, devicePixelRatio: 2, orientation: "landscape-primary" } },
    condition: { seed: 20261015, totalCombatUnits: 400, unitsPerSide: 200, composition: "mixed", rosters: { host: ["swordsman", "archer"], guest: ["swordsman", "archer"] }, tps: 10, warmupSeconds: 5, requestedSampleSeconds: 15 },
    measurement: { collector: "completed renderer frame hook", perFrameCounters: ["frameIntervalMs", "frameWindowMs", "rendererCpuWorkMs", "hostStepCpuMs", "guestSessionPulseCpuMs", "unattributedElapsedMs"], vectorAssetDrawCallMeaning: "VectorContext mesh stats draws: WebGL device.draw() dispatches; not measured GPU execution time.", nestedCpuAccounting: "sessionPulse includes StrategySim step and snapshot work", vectorFlushDiagnostics: { available: true, safeAlphaRunBatching: true, scope: "native stats" } },
    sample: {
      status: "complete", durationMs: 15000, frameCount: 180, fps: 7.31,
      frameIntervalMs: stats(135.7, 179.1, 220, 145), rendererCpuWorkMs: stats(12, 30.4, 48, 15),
      drawCalls: stats(620, 705, 730, 640), vectorAssetDrawCalls: stats(480, 572, 600, 510), vectorAssetDraws: stats(200, 285, 300, 240),
      bufferUploadBytes: stats(80000, 120000, 140000, 85000), vectorAssetGeometryBytes: stats(256, 512, 768, 300),
      vectorAssetInstanceBytes: stats(1024, 2048, 3072, 1200), vectorStagingBytes: stats(12000, 16000, 20000, 14000),
      partUniformBytesSubmitted: stats(500, 700, 900, 600), vectorGeometryUploads: stats(0, 1, 2, 0.2), vectorInstances: stats(300, 400, 450, 340),
      alphaRunCacheHits: stats(4, 8, 10, 5), alphaRunCacheMisses: stats(1, 2, 4, 1.2),
      metricAvailability: { vectorAssetDraws: { available: true, vectorPathUsed: true } },
      pairedSlowFrames: { frameCount: 9, selection: { metric: "frameIntervalMs", operator: ">=", thresholdMs: 139 }, flushReasons: { alphaOverlap: 4, "world-pass-end": 1 }, drawDispatchReasons: { "world-pass-end": 492, alphaImmediateRun: 80 }, frames: [slowFrame], metrics: {
        frameWindowMs: stats(140, 180, 220, 150), rendererCpuWorkMs: stats(20, 37, 48, 25), hostSessionPulseCpuMs: stats(3, 4, 5, 3.5), guestSessionPulseCpuMs: stats(2, 3, 4, 2.5), unattributedElapsedMs: stats(90, 120, 160, 100),
        hostStepCpuMs: stats(1, 2, 3, 1.5), hostStepCount: stats(1, 2, 3, 1.5), guestStepCpuMs: stats(1, 2, 3, 1.5), guestStepCount: stats(1, 2, 3, 1.5),
        hostSnapshotCpuMs: stats(0.2, 0.5, 1, 0.4), hostSnapshotCount: stats(0, 1, 2, 0.5), guestSnapshotCpuMs: stats(0.2, 0.5, 1, 0.4), guestSnapshotCount: stats(0, 1, 2, 0.5),
        hostSnapshotUiCpuMs: stats(0.1, 0.2, 0.5, 0.2), hostSnapshotUiCount: stats(0, 1, 2, 0.5), guestSnapshotUiCpuMs: stats(0.1, 0.2, 0.5, 0.2), guestSnapshotUiCount: stats(0, 1, 2, 0.5),
        drawCalls: stats(690, 710, 730, 700), bufferUploadBytes: stats(110000, 135000, 140000, 120000),
        alphaRunCacheHits: stats(3, 7, 9, 5), alphaRunCacheMisses: stats(1, 3, 4, 2),
      } },
      frameAlignedSimulation: { accounting: "pulse includes nested step and snapshot work; residual is not GPU time or idle time" },
      vectorFlushReasons: { alphaOverlap: 4, "world-pass-end": 1 }, vectorDrawDispatchReasons: { "world-pass-end": 492, alphaImmediateRun: 80 }, vectorDrawDispatchReasonTotal: 572, vectorDrawDispatchReasonsMatchDrawCalls: true,
      vectorAlphaRunBatching: { enabled: true, safeBatches: stats(1, 2, 3, 1.2), batchedInstances: stats(2, 4, 6, 3), drawsSaved: stats(4, 8, 12, 6), safeRunDraws: stats(8, 16, 24, 12), immediateRunDraws: stats(2, 4, 8, 3), overlapBoundaries: stats(1, 2, 4, 1.5), signatureBoundaries: stats(0, 1, 2, 0.5), unbatchableBounds: stats(0, 0, 1, 0.1), immediateInstances: stats(1, 2, 4, 2) },
      gpuTime: { measured: false, timeMs: null }, simulationCpuTimeMs: 1900, simulationCpuTimeSource: "sum of Host and Guest StrategySim step cumulative CPU", gcTimeMs: null, transportSerializationMs: null,
      rawFrameSamples: Array.from({ length: 180 }, (_, index) => ({ index, frameMs: index })),
    },
    visibility: { visibilityStateAtStart: "visible", visibilityStateAtSampleStart: "visible", visibilityStateAtFinish: "visible", sampleValid: true, hiddenEvents: 0, unpausedHiddenEvents: 0, hiddenWhilePausedEvents: 0, pagehideEvents: 0, invalidated: false },
    simulation: {
      startTick: 31, endTick: 138, ticksAdvanced: 107,
      aliveUnitsStart: { total: 400, host: 200, guest: 200, workers: 0 },
      aliveUnitsEnd: { total: 269, host: 135, guest: 134, workers: 0 },
      peers: { host: peer(0), guest: peer(1) },
    },
    renderer: { backend: "WebGL", canvas: { width: 1296, height: 404 }, vectorAssets: true, vectorMeshes: 12, alphaRunCache: { hits: stats(4, 8, 10, 5), misses: stats(1, 2, 4, 1.2) }, instancing: { enabled: true } },
  };
}

function makeHarness({ clipboardWriteText, execCommand = false } = {}) {
  const classTokens = new Set(["hidden"]);
  const fallback = {
    value: "", classList: { add(token) { classTokens.add(token); }, remove(token) { classTokens.delete(token); }, contains(token) { return classTokens.has(token); } },
    focus(options) { this.focusOptions = options; }, select() { this.selected = true; }, setSelectionRange(start, end) { this.selection = [start, end]; },
    scrollIntoView(options) { this.scrollOptions = options; },
  };
  const status = { textContent: "" };
  const body = { children: [], appendChild(element) { this.children.push(element); element.parentElement = this; return element; } };
  const createdElements = [];
  const document = {
    body,
    getElementById(id) { return id === "battleTestCopyFallback" ? fallback : id === "battleTestHudStatus" ? status : null; },
    createElement(tag) {
      const element = { tagName: tag.toUpperCase(), style: {}, setAttribute() {}, remove() { body.children = body.children.filter(item => item !== this); this.removed = true; }, select() { this.selected = true; }, click() { this.clicked = true; } };
      createdElements.push(element); return element;
    },
    execCommand() { return execCommand; },
  };
  const revokedUrls = [];
  const timers = [];
  const eventListeners = new Map();
  const urlApi = { createObjectURL(blob) { this.createdBlob = blob; return "blob:test-mobile-report"; }, revokeObjectURL(url) { revokedUrls.push(url); } };
  const context = vm.createContext({
    document,
    navigator: { clipboard: clipboardWriteText ? { writeText: clipboardWriteText } : undefined },
    window: { addEventListener(name, callback, options) { eventListeners.set(name, { callback, options }); }, removeEventListener(name) { eventListeners.delete(name); } },
    URL: urlApi,
    Blob,
    setTimeout(callback, delay) { const timer = { id: timers.length + 1, callback, delay, cleared: false }; timers.push(timer); return timer.id; },
    clearTimeout(id) { const timer = timers.find(item => item.id === id); if (timer) timer.cleared = true; },
  });
  vm.runInContext(`${classSource}\nglobalThis.MobileBattleTestMode = MobileBattleTestMode;`, context, { filename: "index.html:MobileBattleTestMode" });
  return { MobileBattleTestMode: context.MobileBattleTestMode, document, fallback, status, createdElements, revokedUrls, timers, eventListeners, urlApi };
}

test("summary copy keeps key diagnostics concise and excludes raw sample arrays", () => {
  const { MobileBattleTestMode } = makeHarness();
  const report = reportFixture();
  const summary = MobileBattleTestMode.summaryReportText(report);

  assert.match(summary, /Build 20261016T033522\+0000-rf-0c5866d65800/);
  assert.match(summary, /collision=ally-soft-one-pass/);
  assert.match(summary, /seed=20261015 units=400/);
  assert.match(summary, /FPS=7\.31/);
  assert.match(summary, /Frame ms p50\/p95\/max=135\.7\/179\.1\/220/);
  assert.match(summary, /all\/WebGL-vector draws p95=705\/572; vector unit submissions p95=285/);
  assert.match(summary, /renderer CPU ms p50\/p95\/max=12\/30\.4\/48/);
  assert.match(summary, /paired slow frames=9/);
  assert.match(summary, /Ticks 31→138 \(\+107\)/);
  assert.match(summary, /snapshot n\/avg\/max=77\/7\.05\/22\.9ms/);
  assert.match(summary, /step ticks\/cpu\/last\/ewma\/max=97\/945\.7\/11\.25/);
  assert.match(summary, /Alpha cache avg hits\/misses per frame=5\/1\.2/);
  assert.match(summary, /stage p95ms .*target-pick=20\/combat-other=21/);
  assert.match(summary, /nearby-return\/targetQueries\/collisions=56\/42\/28 target-pick calls=135/);
  assert.match(summary, /Paired slow-frame p95 ms window\/render\/Host pulse\/Guest pulse\/unattributed=180\/37\/4\/3\/120/);
  assert.match(summary, /Same frame #108 elapsed\/render=180\/37ms; H step 2\/2ms snap 1\/0\.5ms pulse 4ms; G step 1\/1\.3ms snap 1\/0\.4ms pulse 3ms; vector submit\/WebGL\/alpha-run=285\/572\/80; safe alpha batches\/instances saved=1\/2\/4; flush events=6 \(alphaOverlap:4,world-pass-end:1\); dispatch reasons=world-pass-end:492,alphaImmediateRun:80; unattributed=120ms/);
  assert.match(summary, /Alpha-run batching enabled=yes; safe batches\/batched instances\/draws saved p50\/p95\/max=1\/2\/3\/2\/4\/6\/4\/8\/12/);
  assert.match(summary, /pulse includes nested sim work/);
  assert.match(summary, /collision sum soft pass\/contact\/moved\/capped=15\/105\/105\/7 sweep call\/pass=30\/15 hardfix call\/pass\/correction=15\/15\/0/);
  assert.match(summary, /GPU timer not measured; GC timing not collected/);
  assert.doesNotMatch(summary, /rawFrameSamples|sampleTick|Headless browser details/);
  assert.ok(Buffer.byteLength(summary, "utf8") <= 4096, `summary is ${Buffer.byteLength(summary, "utf8")} UTF-8 bytes`);
});

test("summary labels unavailable peer and vector-path metrics instead of implying zero work", () => {
  const { MobileBattleTestMode } = makeHarness();
  const report = reportFixture();
  report.sample.metricAvailability.vectorAssetDraws = { available: false, value: null };
  report.simulation.peers.guest.available = false;

  const summary = MobileBattleTestMode.summaryReportText(report);
  assert.match(summary, /vector path=metrics unavailable/);
  assert.match(summary, /Guest: unavailable/);
});

test("clipboard failure exposes the same summary in a selected read-only textarea", async () => {
  const { MobileBattleTestMode, fallback, status } = makeHarness({ clipboardWriteText: async () => { throw new Error("denied"); }, execCommand: false });
  const report = reportFixture();
  MobileBattleTestMode.report = report;
  await MobileBattleTestMode.copyReport();

  assert.equal(fallback.value, MobileBattleTestMode.summaryReportText(report));
  assert.equal(fallback.classList.contains("hidden"), false);
  assert.equal(fallback.selected, true);
  assert.deepEqual(fallback.selection, [0, fallback.value.length]);
  assert.match(status.textContent, /자동 복사에 실패/);
});

test("clipboard success copies only the summary", async () => {
  let copiedText = "";
  const { MobileBattleTestMode, fallback, status } = makeHarness({ clipboardWriteText: async text => { copiedText = text; } });
  const report = reportFixture();
  MobileBattleTestMode.report = report;
  await MobileBattleTestMode.copyReport();

  assert.equal(copiedText, MobileBattleTestMode.summaryReportText(report));
  assert.doesNotMatch(copiedText, /rawFrameSamples|"schemaVersion"/);
  assert.equal(fallback.classList.contains("hidden"), true);
  assert.match(status.textContent, /진단 요약을 복사했습니다/);
});

test("download requests the complete JSON with the correct Blob type and filename without claiming completion", async () => {
  const { MobileBattleTestMode, status, createdElements, urlApi, revokedUrls, timers, eventListeners } = makeHarness();
  const report = reportFixture();
  MobileBattleTestMode.report = report;
  MobileBattleTestMode.downloadReport();

  const anchor = createdElements.find(element => element.tagName === "A");
  assert.ok(anchor?.clicked);
  assert.match(anchor.download, /^rally-mobile-battle-20261015-400\.json$/);
  assert.equal(urlApi.createdBlob.type, "application/json");
  const downloaded = JSON.parse(await urlApi.createdBlob.text());
  assert.equal(downloaded.sample.rawFrameSamples.length, 180);
  assert.equal(downloaded.sample.pairedSlowFrames.metrics.rendererCpuWorkMs.p95, 37);
  assert.match(downloaded.measurement.vectorAssetDrawCallMeaning, /device\.draw\(\).*not measured GPU execution time/);
  assert.match(downloaded.sample.frameAlignedSimulation.accounting, /not GPU time or idle time/);
  assert.equal(downloaded.sample.pairedSlowFrames.frames[0].rendererFrameSequence, 108);
  assert.equal(downloaded.sample.pairedSlowFrames.frames[0].vectorFlushes.reasons.alphaOverlap, 4);
  assert.equal(downloaded.sample.pairedSlowFrames.frames[0].vectorDrawDispatchReasons["world-pass-end"], 492);
  assert.equal(downloaded.sample.vectorDrawDispatchReasonsMatchDrawCalls, true);
  assert.equal(downloaded.sample.vectorAlphaRunBatching.drawsSaved.p95, 8);
  assert.equal(downloaded.simulation.peers.host.sampledStages.length, 15);
  assert.match(status.textContent, /다운로드를 요청했습니다/);
  assert.doesNotMatch(status.textContent, /저장 완료|다운로드 완료/);
  assert.equal(revokedUrls.length, 0);
  assert.equal(timers[0].delay, 60000);
  assert.ok(eventListeners.has("pagehide"));
});

test("frame-aligned peer deltas keep pulse as the non-overlapping CPU total", () => {
  const { MobileBattleTestMode } = makeHarness();
  const mode = MobileBattleTestMode;
  mode.sampleBuffers = Object.fromEntries(mode.sampleMetricKeys.map(key => [key, new Float32Array(2)]));
  const makeSession = (stepSamples, stepCumulativeMs, snapshotSamples, snapshotCumulativeMs, pulseSamples, pulseCumulativeMs, snapshotUiSamples, snapshotUiCumulativeMs) => {
    const sim = { perfStats: { stepSamples, stepCumulativeMs, snapshotSamples, snapshotCumulativeMs } };
    return { sim, performanceStats: { timings: { pulse: { samples: pulseSamples, cumulativeMs: pulseCumulativeMs }, snapshotUi: { samples: snapshotUiSamples, cumulativeMs: snapshotUiCumulativeMs } } } };
  };
  const host = makeSession(102, 11.2, 8, 4.4, 22, 35, 9, 3.1);
  const guest = makeSession(202, 21.7, 18, 7.2, 32, 57, 19, 5.4);
  mode.peerFrameBaseline = {
    host: { session: host, sim: host.sim, stepCount: 100, stepCpuMs: 10, snapshotCount: 6, snapshotCpuMs: 3.8, pulseCount: 20, sessionPulseCpuMs: 32, snapshotUiCount: 7, snapshotUiCpuMs: 2.9 },
    guest: { session: guest, sim: guest.sim, stepCount: 200, stepCpuMs: 20, snapshotCount: 16, snapshotCpuMs: 6.8, pulseCount: 30, sessionPulseCpuMs: 52, snapshotUiCount: 17, snapshotUiCpuMs: 5.2 },
  };

  mode.capturePeerFrameMetrics({ sessions: { host, guest } }, 0, true, 20, 4);

  assert.equal(mode.sampleBuffers.hostStepCount[0], 2);
  assert.ok(Math.abs(mode.sampleBuffers.hostStepCpuMs[0] - 1.2) < 1e-5);
  assert.equal(mode.sampleBuffers.hostSnapshotCount[0], 2);
  assert.ok(Math.abs(mode.sampleBuffers.hostSnapshotCpuMs[0] - 0.6) < 1e-5);
  assert.equal(mode.sampleBuffers.hostSnapshotUiCount[0], 2);
  assert.ok(Math.abs(mode.sampleBuffers.hostSessionPulseCpuMs[0] - 3) < 1e-5);
  assert.equal(mode.sampleBuffers.guestStepCount[0], 2);
  assert.ok(Math.abs(mode.sampleBuffers.guestStepCpuMs[0] - 1.7) < 1e-5);
  assert.equal(mode.sampleBuffers.guestSessionPulseCpuMs[0], 5);
  assert.equal(mode.sampleBuffers.unattributedElapsedMs[0], 8);
  assert.equal(mode.sampleBuffers.frameWindowMs[0], 20);
});

test("same-frame slow rows join elapsed, renderer, Host/Guest simulation, vector submits and draw dispatches", () => {
  const { MobileBattleTestMode: mode } = makeHarness();
  mode.sampleBuffers = Object.fromEntries(mode.sampleMetricKeys.map(key => [key, new Float32Array(4).fill(NaN)]));
  mode.sampleVectorDiagnostics = new Array(4);
  mode.sampleCount = 4;
  const set = (key, values) => values.forEach((value, index) => { mode.sampleBuffers[key][index] = value; });
  set("frameIntervalMs", [20, 60, 30, 80]); set("frameWindowMs", [19, 59, 29, 79]); set("rendererCpuWorkMs", [4, 15, 5, 22]); set("rendererFrameSequence", [1, 2, 3, 4]);
  set("hostStepCount", [1, 2, 1, 4]); set("hostStepCpuMs", [0.5, 2, 0.3, 4]); set("hostSnapshotCount", [0, 1, 0, 2]); set("hostSnapshotCpuMs", [0, 0.8, 0, 1.2]); set("hostSessionPulseCpuMs", [1, 4, 1, 8]);
  set("guestStepCount", [1, 1, 2, 3]); set("guestStepCpuMs", [0.6, 1, 1.2, 3]); set("guestSnapshotCount", [0, 1, 1, 1]); set("guestSnapshotCpuMs", [0, 0.4, 0.5, 0.6]); set("guestSessionPulseCpuMs", [1.2, 3, 3.4, 6]);
  set("unattributedElapsedMs", [10, 37, 17, 43]); set("vectorAssetDraws", [10, 15, 20, 25]); set("vectorAssetDrawCalls", [20, 30, 40, 50]); set("vectorInstances", [10, 15, 20, 25]);
  set("vectorFlushEvents", [1, 2, 3, 4]); set("vectorAlphaRunDrawCalls", [5, 8, 9, 12]); set("vectorAlphaRunSafeBatches", [0, 1, 2, 3]); set("vectorAlphaRunBatchedInstances", [0, 2, 3, 4]); set("vectorAlphaRunDrawsSaved", [0, 2, 4, 6]); set("vectorAlphaRunOverlapBoundaries", [0, 1, 2, 3]);
  set("vectorFlushAlphaOverlap", [0, 1, 2, 3]); set("vectorFlushWorldPassEnd", [1, 1, 1, 1]);
  mode.sampleVectorDiagnostics = [
    { flushReasons: { "world-pass-end": 1 }, drawDispatchReasons: { "world-pass-end": 20 } },
    { flushReasons: { alphaOverlap: 1, "world-pass-end": 1 }, drawDispatchReasons: { alphaOverlap: 8, "world-pass-end": 22 } },
    { flushReasons: { alphaOverlap: 2, "world-pass-end": 1 }, drawDispatchReasons: { alphaOverlap: 9, "world-pass-end": 31 } },
    { flushReasons: { alphaOverlap: 3, "world-pass-end": 1 }, drawDispatchReasons: { alphaOverlap: 12, "world-pass-end": 38 } },
  ];

  const result = mode.pairedSlowFrameSummary(mode.stats(mode.sampleBuffers.frameIntervalMs, mode.sampleCount));
  assert.deepEqual(Array.from(result.frames, row => row.frameIndex), [3, 1]);
  assert.equal(result.frames[0].rendererFrameSequence, 4);
  assert.equal(result.frames[0].elapsedWindowMs, 79);
  assert.equal(result.frames[0].host.step.count, 4);
  assert.equal(result.frames[0].host.snapshot.cpuMs, 1.2);
  assert.equal(result.frames[0].guest.sessionPulse.cpuMs, 6);
  assert.equal(result.frames[0].vector.drawMeshSubmissions, 25);
  assert.equal(result.frames[0].vector.webglDrawDispatches, 50);
  assert.equal(result.frames[0].vectorFlushes.events, 4);
  assert.equal(result.frames[0].vectorFlushes.reasons.alphaOverlap, 3);
  assert.equal(result.frames[0].vectorDrawDispatchReasons.alphaOverlap, 12);
  assert.equal(result.frames[0].vector.alphaRunBatchedInstances, 4);
  assert.equal(result.metrics.vectorFlushAlphaOverlap.count, 2);
  assert.equal(result.flushReasons.alphaOverlap, 4);
});

test("sampling reads native VectorContext mesh reason stats without wrapping renderer methods", () => {
  const { MobileBattleTestMode: mode } = makeHarness();
  const originalFlush = function () {}, originalDrawVectorActor = function () {};
  const renderer = { perfStats: { frameSequence: 11 }, vectorContext: { flush: originalFlush, drawVectorActor: originalDrawVectorActor, stats: () => ({ mesh: {
    safeAlphaRunBatching: true, flushReasons: { alphaOverlap: 3 }, drawDispatchReasons: { alphaOverlap: 12 },
  } }) } };
  const makeSession = role => {
    const sim = { tick: 24, units: [], perfStats: { stepSamples: 0, stepCumulativeMs: 0, snapshotSamples: 0, snapshotCumulativeMs: 0, sampleTick: 0 } };
    return { role, sim, performanceStats: { timings: { pulse: { samples: 0, cumulativeMs: 0 }, snapshotUi: { samples: 0, cumulativeMs: 0 } } } };
  };
  const host = makeSession("host"), guest = makeSession("guest"), match = { sessions: { host, guest } };
  mode.beginSampling(100, { renderer, match, sim: host.sim });
  assert.equal(mode.vectorFlushDiagnosticsAvailable, true);
  assert.equal(mode.vectorSafeAlphaRunBatching, true);
  assert.equal(renderer.vectorContext.flush, originalFlush);
  assert.equal(renderer.vectorContext.drawVectorActor, originalDrawVectorActor);
});
