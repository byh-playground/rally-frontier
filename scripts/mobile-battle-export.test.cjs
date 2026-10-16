"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const html = readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const classStart = html.indexOf("class MobileBattleTestMode{");
const classEnd = html.indexOf("\nconst CAMPAIGN_MISSION_SCHEMA_VERSION=", classStart);
assert.ok(classStart >= 0 && classEnd > classStart, "MobileBattleTestMode class boundary should be present");
const classSource = html.slice(classStart, classEnd);

function stats(p50 = 0, p95 = 0, max = 0, mean = p50) {
  return { count: 12, p50, p95, max, mean };
}

function peer(offset = 0) {
  const stageKeys = ["totalMs", "indexMs", "worldMs", "economyMs", "workerMs", "visionMs", "combatMs", "projectileMs", "collisionMs", "collisionSoftApplyMs", "postMs"];
  const sampledStages = Array.from({ length: 15 }, (_, index) => ({
    sampleTick: index * 10 + offset,
    stageMs: Object.fromEntries(stageKeys.map((key, stageIndex) => [key, index + stageIndex + offset])),
    workCounters: {
      spatialQueries: index + offset, spatialCandidates: index * 4 + offset, collisionPairs: index * 2 + offset,
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
    step: { ticksDuringSample: 97, lastStepMs: 11.25, ewmaStepMs: 16.4, maxObservedStepMs: 54.4, lifetimeMaxStepMs: 75.2 },
    snapshot: { samplesDuringSample: 77, totalMsDuringSample: 543, averageMsDuringSample: 7.05, latestSnapshotMs: 5.5, lifetimeMaxSnapshotMs: 22.9 },
  };
}

function reportFixture() {
  return {
    schemaVersion: 2,
    testMode: "mobile-battle",
    capturedAt: "2026-10-16T03:35:57.594Z",
    build: { id: "20261016T033522+0000-rf-0c5866d65800", commit: "0123456789abcdef" }, collisionModel: "ally-soft-one-pass",
    device: { userAgent: "Headless browser details are omitted from summary", platform: "Win32", hardwareConcurrency: 12, viewport: { width: 844, height: 390, devicePixelRatio: 2, orientation: "landscape-primary" } },
    condition: { seed: 20261015, totalCombatUnits: 400, unitsPerSide: 200, composition: "mixed", rosters: { host: ["swordsman", "archer"], guest: ["swordsman", "archer"] }, tps: 10, warmupSeconds: 5, requestedSampleSeconds: 15 },
    measurement: { collector: "completed renderer frame hook", perFrameCounters: ["frameIntervalMs", "rendererCpuWorkMs", "alphaRunCacheHits"] },
    sample: {
      status: "complete", durationMs: 15000, frameCount: 180, fps: 7.31,
      frameIntervalMs: stats(135.7, 179.1, 220, 145), rendererCpuWorkMs: stats(12, 30.4, 48, 15),
      drawCalls: stats(620, 705, 730, 640), vectorAssetDrawCalls: stats(480, 572, 600, 510),
      bufferUploadBytes: stats(80000, 120000, 140000, 85000), vectorAssetGeometryBytes: stats(256, 512, 768, 300),
      vectorAssetInstanceBytes: stats(1024, 2048, 3072, 1200), vectorStagingBytes: stats(12000, 16000, 20000, 14000),
      partUniformBytesSubmitted: stats(500, 700, 900, 600), vectorGeometryUploads: stats(0, 1, 2, 0.2), vectorInstances: stats(300, 400, 450, 340),
      alphaRunCacheHits: stats(4, 8, 10, 5), alphaRunCacheMisses: stats(1, 2, 4, 1.2),
      metricAvailability: { vectorAssetDraws: { available: true, vectorPathUsed: true } },
      pairedSlowFrames: { frameCount: 9, selection: { metric: "frameIntervalMs", operator: ">=", thresholdMs: 139 }, metrics: {
        rendererCpuWorkMs: stats(20, 37, 48, 25), drawCalls: stats(690, 710, 730, 700), bufferUploadBytes: stats(110000, 135000, 140000, 120000),
        alphaRunCacheHits: stats(3, 7, 9, 5), alphaRunCacheMisses: stats(1, 3, 4, 2),
      } },
      gpuTime: { measured: false, timeMs: null }, simulationCpuTimeMs: null, gcTimeMs: null, transportSerializationMs: null,
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
  assert.match(summary, /renderer CPU ms p50\/p95\/max=12\/30\.4\/48/);
  assert.match(summary, /paired slow frames=9/);
  assert.match(summary, /Ticks 31→138 \(\+107\)/);
  assert.match(summary, /snapshot n\/avg\/max=77\/7\.05\/22\.9ms/);
  assert.match(summary, /Alpha cache avg hits\/misses per frame=5\/1\.2/);
  assert.match(summary, /stage p95ms/);
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
  assert.equal(downloaded.simulation.peers.host.sampledStages.length, 15);
  assert.match(status.textContent, /다운로드를 요청했습니다/);
  assert.doesNotMatch(status.textContent, /저장 완료|다운로드 완료/);
  assert.equal(revokedUrls.length, 0);
  assert.equal(timers[0].delay, 60000);
  assert.ok(eventListeners.has("pagehide"));
});
