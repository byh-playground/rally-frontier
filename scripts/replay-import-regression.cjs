const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise production replay methods with isolated simulation and UI dependencies.
// Real StrategySim, renderer and Single-Player UI verification remain separate.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
for (const [, attributes, source] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
  if (!attributes.includes('application/json')) new vm.Script(source);
}
function classSource(name) {
  const start = html.indexOf(`class ${name}{`);
  assert.ok(start >= 0, `${name} exists`);
  let depth = 0;
  let end = html.indexOf('{', start);
  for (; end < html.length; end++) {
    if (html[end] === '{') depth++;
    if (html[end] === '}' && !--depth) break;
  }
  return html.slice(start, end + 1);
}

const events = [];
const sims = [];
let failSnapshot = false;
const context = vm.createContext({
  performance: { now: () => 100 },
  SIM_VERSION: 1,
  REPLAY_PROTOCOL: 'test',
  GameRuleDefinition: { current: {} },
  CloneUtil: { clone: structuredClone },
  RangeUtil: { clamp: (v, a, b) => Math.min(b, Math.max(a, v)) },
  StrategySim: class {
    constructor() {
      this.tick = 0;
      sims.push(this);
      events.push('candidate-created');
    }
    importState(state) { Object.assign(this, state); }
    checksum() { return 'valid'; }
    snapshot() {
      if (failSnapshot) throw Error('snapshot failure');
      events.push('snapshot-ready');
      return { tick: this.tick };
    }
    dispose(reason) { this.disposed = true; events.push(reason); }
    queueCommand() {}
  },
  CampaignPresentation: { clear: () => events.push('campaign-presentation-clear') },
  CampaignRuntime: { clear: () => events.push('campaign-runtime-clear') },
  MatchLifecycle: { disposeMatches: () => events.push('matches-dispose') },
  UiRuntimeState: { value: { target: {}, selection: {}, modal: null } },
  UiController: { setUiCommand() {}, invalidatePanelHtmlCaches() {}, closeUiModal() {} },
  SpellPresentation: { setSpellChoicePhase() {} },
  ActiveViewState: { renderer: null },
  LogUtil: { log: message => events.push(message) }
});
vm.runInContext(
  ['ReplayPolicy', 'ReplayPlayer', 'ReplayPresentation'].map(classSource).join(';') +
  ';globalThis.api={ReplayPlayer,ReplayPresentation}', context
);
const { ReplayPlayer, ReplayPresentation: presentation } = context.api;
presentation.renderReplaySnapshot = () => events.push('render');
presentation.applyReplayPerspective = () => {};
presentation.syncReplayControls = () => {};
presentation.formatReplayTime = () => '';
ReplayPlayer.prototype.start = function() { events.push('start'); };
const payload = {
  protocol: 'test', simVersion: 1, seed: 123, finalDraft: {}, commands: [],
  result: { endTick: 50 },
  checkpoints: [{
    tick: 0, state: { tick: 0 }, checksum: 'valid',
    checksumScope: 'state-without-scheduled-v1'
  }]
};

for (const playing of [true, false]) {
  const old = {
    playing, stopped: false,
    stop() { this.stopped = true; this.playing = false; events.push('old-stop'); }
  };
  presentation.replayPlayer = old;
  presentation.replayLoadedData = payload;
  const corruptions = [
    ['checksum', data => data.checkpoints[0].checksum = 'broken'],
    ['scope', data => data.checkpoints[0].checksumScope = 'broken'],
    ['tick', data => data.checkpoints[0].tick = -1]
  ];
  function assertPreserved() {
    assert.equal(presentation.replayPlayer, old);
    assert.equal(presentation.replayLoadedData, payload);
    assert.equal(old.playing, playing);
    assert.equal(old.stopped, false);
    for (const teardown of ['matches-dispose', 'campaign-runtime-clear', 'campaign-presentation-clear', 'old-stop']) {
      assert.ok(!events.includes(teardown), `${teardown} must wait for preparation`);
    }
  }
  for (const [name, mutate] of corruptions) {
    events.length = 0;
    const before = sims.length;
    const data = structuredClone(payload);
    mutate(data);
    assert.equal(presentation.startReplay(data), false, name);
    assertPreserved();
    assert.equal(sims.length, before + 1);
    assert.equal(sims.at(-1).disposed, true);
  }
  events.length = 0;
  assert.equal(presentation.startReplay({ ...payload, protocol: 'bad' }), false);
  assertPreserved();
  assert.ok(!events.includes('candidate-created'));
  assert.equal(presentation.startReplay({ ...payload, extra: () => {} }), false);
  assertPreserved();
  failSnapshot = true;
  assert.equal(presentation.startReplay(payload), false);
  failSnapshot = false;
  assert.equal(sims.at(-1).disposed, true);
  assertPreserved();

  events.length = 0;
  assert.equal(presentation.startReplay(payload), true);
  assert.notEqual(presentation.replayPlayer, old);
  assert.equal(old.stopped, true);
  for (const teardown of ['campaign-presentation-clear', 'matches-dispose', 'old-stop']) {
    assert.ok(events.indexOf('snapshot-ready') < events.indexOf(teardown));
  }
  assert.ok(events.indexOf('matches-dispose') < events.indexOf('old-stop'));
  assert.ok(events.indexOf('old-stop') < events.indexOf('render'));
  assert.notEqual(presentation.replayLoadedData, payload);
  assert.equal(presentation.replayPlayer.sim.disposed, undefined);
}
console.log('PASS: corrupt checkpoints, header, clone and snapshot failures preserve replay; candidates disposed; preparation precedes teardown.');
