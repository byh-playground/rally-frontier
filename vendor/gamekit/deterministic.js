// packages/deterministic/src/utilities.js
var compareIds = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function integer(value, name, min = 0, max = 4294967295) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(name);
  return value;
}
function bytes(value, name = "bytes") {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`${name} must be Uint8Array or ArrayBuffer`);
}
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function hashBytes(value, seed = 2166136261) {
  let h = seed >>> 0;
  for (const b of bytes(value)) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h;
}
function statelessRandom(seed, eventId) {
  let x = (seed ^ Math.imul(integer(eventId, "eventId"), 2654435769)) >>> 0;
  x = Math.imul(x ^ x >>> 16, 2246822507);
  x = Math.imul(x ^ x >>> 13, 3266489909);
  return (x ^ x >>> 16) >>> 0;
}
var SeededPRNG = class {
  constructor(seed = 1) {
    this.state = integer(seed, "seed") >>> 0;
  }
  nextUint32() {
    this.state = this.state + 1831565813 >>> 0;
    let t = this.state;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return (t ^ t >>> 14) >>> 0;
  }
  nextInt(bound) {
    integer(bound, "bound", 1, 4294967296);
    const limit = Math.floor(4294967296 / bound) * bound;
    let x;
    do {
      x = this.nextUint32();
    } while (x >= limit);
    return x % bound;
  }
};
var signed = (x) => integer(x, "fixed-point result", -2147483648, 2147483647);
var fixedPoint = Object.freeze({
  scale: 1024,
  fromNumber: (x) => signed(Math.round(x * 1024)),
  toNumber: (x) => signed(x) / 1024,
  add: (a, b) => signed(signed(a) + signed(b)),
  sub: (a, b) => signed(signed(a) - signed(b)),
  mul: (a, b) => {
    signed(a);
    signed(b);
    const product = a * b;
    if (Number.isSafeInteger(product)) return signed(Math.trunc(product / 1024) || 0);
    return signed(Number(BigInt(a) * BigInt(b) / 1024n));
  },
  div: (a, b) => {
    if (signed(b) === 0) throw new RangeError("fixed-point division by zero");
    return signed(Number(BigInt(signed(a)) * 1024n / BigInt(b)));
  }
});

// packages/deterministic/src/value-codec.js
function createValueCodec({ format = "binary", maxBytes = 16 * 1024 * 1024, maxDepth = 128, maxEntries = 1e6 } = {}) {
  if (!["binary", "json"].includes(format)) throw new TypeError("Unknown codec format");
  for (const limit of [maxBytes, maxDepth, maxEntries]) if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Invalid codec limit");
  const encoder2 = new TextEncoder(), decoder2 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  function normalize(value, depth = 0, seen = /* @__PURE__ */ new Set(), budget = { count: 0 }) {
    if (depth > maxDepth || ++budget.count > maxEntries) throw new RangeError("Value codec budget exceeded");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("Finite numbers required");
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === "string") {
      if (decoder2.decode(encoder2.encode(value)) !== value) throw new TypeError("Invalid Unicode string");
      return value;
    }
    if (!value || typeof value !== "object" || seen.has(value)) throw new TypeError("Unsupported or cyclic value");
    seen.add(value);
    let result;
    if (value instanceof Uint8Array) {
      if (format === "json") throw new TypeError("JSON codec does not support byte values");
      result = value;
    } else if (Array.isArray(value)) {
      result = Array.from(value, (item) => normalize(item, depth + 1, seen, budget));
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Plain records required");
      result = {};
      for (const key of Object.keys(value).sort()) {
        normalize(key, depth + 1, seen, budget);
        Object.defineProperty(result, key, { value: normalize(value[key], depth + 1, seen, budget), enumerable: true, writable: true, configurable: true });
      }
    }
    seen.delete(value);
    return result;
  }
  const stringCache = /* @__PURE__ */ new Map();
  let cachedStringBytes = 0;
  function stringBytes(value) {
    let data = stringCache.get(value);
    if (data) return data;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 55296 && c <= 56319) {
        const next = value.charCodeAt(++i);
        if (!(next >= 56320 && next <= 57343)) throw new TypeError("Invalid Unicode string");
      } else if (c >= 56320 && c <= 57343) throw new TypeError("Invalid Unicode string");
    }
    data = encoder2.encode(value);
    if (data.length <= 256 && stringCache.size < 1024 && cachedStringBytes + data.length <= 131072) {
      stringCache.set(value, data);
      cachedStringBytes += data.length;
    }
    return data;
  }
  function encode(value) {
    if (format === "json") {
      const bytes3 = encoder2.encode(JSON.stringify(normalize(value)));
      if (bytes3.length > maxBytes) throw new RangeError("Codec byte budget exceeded");
      return bytes3;
    }
    let bytes2 = new Uint8Array(Math.min(1024, maxBytes)), offset = 0, view = new DataView(bytes2.buffer), entries = 0;
    const seen = /* @__PURE__ */ new Set(), strings = /* @__PURE__ */ new Map();
    function reserve(size) {
      if (offset + size > maxBytes) throw new RangeError("Codec byte budget exceeded");
      if (offset + size > bytes2.length) {
        const next = new Uint8Array(Math.min(maxBytes, Math.max(offset + size, bytes2.length * 2)));
        next.set(bytes2);
        bytes2 = next;
        view = new DataView(bytes2.buffer);
      }
    }
    function byte(n) {
      reserve(1);
      bytes2[offset++] = n;
    }
    function length(n) {
      reserve(4);
      view.setUint32(offset, n, true);
      offset += 4;
    }
    function raw(data) {
      length(data.length);
      reserve(data.length);
      bytes2.set(data, offset);
      offset += data.length;
    }
    function variable(n) {
      while (n >= 128) {
        byte(n % 128 + 128);
        n = Math.floor(n / 128);
      }
      byte(n);
    }
    function write(v, depth = 0) {
      if (depth > maxDepth || ++entries > maxEntries) throw new RangeError("Value codec budget exceeded");
      if (v === null) byte(0);
      else if (v === false) byte(1);
      else if (v === true) byte(2);
      else if (typeof v === "number") {
        if (!Number.isFinite(v)) throw new TypeError("Finite numbers required");
        if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
          byte(8);
          variable(v < 0 ? -v * 2 - 1 : v * 2);
        } else {
          byte(3);
          reserve(8);
          view.setFloat64(offset, v, true);
          offset += 8;
        }
      } else if (typeof v === "string") {
        const ref = strings.get(v);
        if (ref !== void 0) {
          byte(9);
          variable(ref);
        } else {
          strings.set(v, strings.size);
          byte(4);
          raw(stringBytes(v));
        }
      } else {
        if (!v || typeof v !== "object" || seen.has(v)) throw new TypeError("Unsupported or cyclic value");
        if (v instanceof Uint8Array) {
          byte(7);
          raw(v);
          return;
        }
        seen.add(v);
        if (Array.isArray(v)) {
          byte(5);
          length(v.length);
          for (const item of v) write(item, depth + 1);
        } else {
          const prototype = Object.getPrototypeOf(v);
          if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Plain records required");
          byte(6);
          const keys = Object.keys(v).sort();
          length(keys.length);
          for (const key of keys) {
            write(key, depth + 1);
            write(v[key], depth + 1);
          }
        }
        seen.delete(v);
      }
    }
    byte(82);
    byte(86);
    byte(1);
    write(value);
    return bytes2.slice(0, offset);
  }
  function decode(input) {
    const bytes2 = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : null;
    if (!bytes2 || bytes2.length > maxBytes) throw new RangeError("Invalid codec bytes");
    let result;
    if (format === "json") result = normalize(JSON.parse(decoder2.decode(bytes2)));
    else {
      let need = function(n) {
        if (n > bytes2.length - offset) throw new RangeError("Truncated codec bytes");
      }, byte = function() {
        need(1);
        return bytes2[offset++];
      }, length = function() {
        need(4);
        const n = view.getUint32(offset, true);
        offset += 4;
        return n;
      }, raw = function() {
        const n = length();
        need(n);
        const data = bytes2.subarray(offset, offset + n);
        offset += n;
        return data;
      }, read = function(depth = 0) {
        if (depth > maxDepth || ++entries > maxEntries) throw new RangeError("Value codec budget exceeded");
        const tag = byte();
        if (tag === 0) return null;
        if (tag === 1) return false;
        if (tag === 2) return true;
        if (tag === 3) {
          need(8);
          const n2 = view.getFloat64(offset, true);
          offset += 8;
          if (!Number.isFinite(n2) || Object.is(n2, -0) || Number.isInteger(n2) && n2 >= -2147483648 && n2 <= 2147483647) throw new TypeError("Noncanonical number");
          return n2;
        }
        if (tag === 8 || tag === 9) {
          let n2 = 0, scale = 1, part;
          for (let i = 0; i < 5; i++) {
            part = byte();
            n2 += (part & 127) * scale;
            if (n2 > 4294967295) throw new TypeError("Integer overflow");
            if (part < 128) {
              if (i && part === 0) throw new TypeError("Noncanonical integer");
              if (tag === 9) {
                if (n2 >= strings.length) throw new TypeError("Invalid string reference");
                return strings[n2];
              }
              return n2 % 2 ? -(n2 + 1) / 2 : n2 / 2;
            }
            scale *= 128;
          }
          throw new TypeError("Invalid integer");
        }
        if (tag === 4) {
          const value = decoder2.decode(raw());
          if (stringSet.has(value)) throw new TypeError("Noncanonical repeated string");
          stringSet.add(value);
          strings.push(value);
          return value;
        }
        if (tag === 7) return raw().slice();
        if (tag !== 5 && tag !== 6) throw new TypeError("Invalid codec tag");
        const n = length();
        if (n > maxEntries - entries) throw new RangeError("Value codec budget exceeded");
        if (tag === 5) {
          const arr = [];
          for (let i = 0; i < n; i++) arr.push(read(depth + 1));
          return arr;
        }
        const obj = {};
        let previous;
        for (let i = 0; i < n; i++) {
          const key = read(depth + 1);
          if (typeof key !== "string" || i && key <= previous) throw new TypeError("Noncanonical record key");
          if (key === "__proto__") Object.defineProperty(obj, key, { value: read(depth + 1), enumerable: true, writable: true, configurable: true });
          else obj[key] = read(depth + 1);
          previous = key;
        }
        return obj;
      };
      let offset = 0, entries = 0;
      const strings = [], stringSet = /* @__PURE__ */ new Set();
      const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
      if (byte() !== 82 || byte() !== 86 || byte() !== 1) throw new TypeError("Invalid codec header");
      result = read();
      if (offset !== bytes2.length) throw new TypeError("Trailing codec bytes");
    }
    if (format === "json") {
      const canonical = encode(result);
      if (canonical.length !== bytes2.length || canonical.some((v, i) => v !== bytes2[i])) throw new TypeError("Noncanonical codec bytes");
    }
    return result;
  }
  return Object.freeze({ format, encode, decode });
}
var binaryCodec = createValueCodec();
var jsonCodec = createValueCodec({ format: "json" });

// packages/_rollback-shared/src/protocol.js
var CHUNK_SIZE = 16384;
var MAX_TICK = 2147483646;
var defaults = {
  tickRate: 60,
  baseInputDelayTicks: 2,
  minInputDelayTicks: 0,
  maxInputDelayTicks: 8,
  rollbackWindowTicks: 12,
  stateHistorySize: 64,
  predictionPolicy: "hold",
  stallPolicy: "wait",
  tickDriftThreshold: 2,
  pacingPolicy: "hold",
  checksumInterval: 30,
  maxCatchupSteps: 4,
  adaptiveInputDelay: true,
  heartbeatMs: 100,
  adaptationIntervalMs: 1e3,
  maxSnapshotBytes: 4 * 1024 * 1024,
  maxHistoryBytes: 64 * 1024 * 1024,
  maxReplayBytes: 64 * 1024 * 1024,
  maxCommandBytes: 2048,
  maxPendingCommands: 256,
  maxQueuedBytes: 5 * 1024 * 1024,
  recoveryTimeoutMs: 1e4,
  maxRecoveryAttempts: 3,
  peerInterruptMs: 1e3,
  peerTimeoutMs: 1e4
};
var profiles = Object.freeze({
  action: Object.freeze({ ...defaults }),
  rts: Object.freeze({
    ...defaults,
    tickRate: 20,
    baseInputDelayTicks: 4,
    maxInputDelayTicks: 12,
    rollbackWindowTicks: 6,
    stateHistorySize: 32,
    predictionPolicy: "neutral",
    checksumInterval: 20
  }),
  lockstep: Object.freeze({
    ...defaults,
    tickRate: 20,
    baseInputDelayTicks: 4,
    maxInputDelayTicks: 20,
    rollbackWindowTicks: 0,
    checksumInterval: 20,
    stateHistorySize: 32,
    predictionPolicy: "neutral"
  })
});
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: true });
var TYPE = Object.freeze({
  HELLO: 1,
  INPUT: 2,
  CLOCK: 3,
  HASH: 4,
  REQUEST: 5,
  BEGIN: 6,
  CHUNK: 7
});
var HEADER = 12;
var SNAP_CHUNK_BYTES = CHUNK_SIZE - HEADER - 8;
function copyFrame(frame) {
  return { input: frame.input.slice(), commands: frame.commands.map((c) => ({ ...c, payload: c.payload.slice() })) };
}
function runSimulationFrame(adapter, context) {
  return adapter.step({ ...context, inputs: context.inputs.map((frame) => ({
    ...copyFrame(frame),
    playerId: frame.playerId,
    predicted: !!frame.predicted
  })) });
}

// packages/_rollback-shared/src/history.js
var StateHistory = class {
  constructor(size, maxBytes = 64 * 1024 * 1024) {
    this.slots = new Array(size);
    this.size = size;
    this.maxBytes = maxBytes;
    this.byteLength = 0;
  }
  get(tick) {
    const s = this.slots[tick % this.size];
    return s?.tick === tick ? s : void 0;
  }
  put(state) {
    const i = state.tick % this.size, next = this.byteLength - (this.slots[i]?.bytes.length ?? 0) + state.bytes.length;
    if (next > this.maxBytes) throw Object.assign(new RangeError("state history byte budget"), { code: "history-capacity", requiredBytes: next, maxHistoryBytes: this.maxBytes, snapshotBytes: state.bytes.length });
    this.slots[i] = state;
    this.byteLength = next;
  }
  invalidateAfter(tick) {
    for (let i = 0; i < this.size; i++) if (this.slots[i]?.tick > tick) {
      this.byteLength -= this.slots[i].bytes.length;
      this.slots[i] = void 0;
    }
  }
};

// packages/deterministic/src/synctest.js
var DeterminismError = class extends Error {
  constructor({ tick, checkpointTick, expected, actual, inputs }) {
    let offset = 0;
    while (offset < Math.min(expected.length, actual.length) && expected[offset] === actual[offset]) offset++;
    super(`Determinism mismatch at state S[${tick}], first byte ${offset}, checkpoint S[${checkpointTick}]`);
    this.name = "DeterminismError";
    this.code = "determinism-mismatch";
    this.tick = tick;
    this.checkpointTick = checkpointTick;
    this.firstDifference = offset;
    this.expectedHash = hashBytes(expected);
    this.actualHash = hashBytes(actual);
    this.expectedState = expected.slice();
    this.actualState = actual.slice();
    this.inputs = inputs.map((frame) => ({ ...copyFrame(frame), playerId: frame.playerId, predicted: false }));
  }
};
function createSyncTestSession(options) {
  return new SyncTestSession(options);
}
var SyncTestSession = class {
  constructor({
    adapter,
    players,
    inputSize,
    tickRate = 60,
    initialTick = 0,
    checkDistance = 1,
    maxSnapshotBytes = 4 * 1024 * 1024,
    maxHistoryBytes = 64 * 1024 * 1024,
    now = () => globalThis.performance?.now() ?? Date.now()
  } = {}) {
    if (!adapter || ["save", "load", "step", "validateSnapshot"].some((key) => typeof adapter[key] !== "function")) throw new TypeError("Simulation Adapter capabilities");
    if (!Array.isArray(players) || !players.length || players.length > 8 || players.some((id) => typeof id !== "string" || !id.length) || new Set(players).size !== players.length) throw new TypeError("fixed player roster");
    if (typeof now !== "function") throw new TypeError("diagnostic clock");
    this._now = now;
    this._cost = { forwardCostMs: 0, resimulationCostMs: 0, totalCostMs: 0 };
    this.adapter = adapter;
    this.players = Object.freeze([...players].sort(compareIds));
    this.inputSize = integer(inputSize, "inputSize", 1, 1024);
    this.tickRate = integer(tickRate, "tickRate", 1, 240);
    this.checkDistance = integer(checkDistance, "checkDistance", 1, 256);
    this._tick = integer(initialTick, "initialTick", 0, MAX_TICK);
    this.initialTick = this.tick;
    this.maxSnapshotBytes = integer(maxSnapshotBytes, "maxSnapshotBytes", 1, 64 * 1024 * 1024);
    integer(maxHistoryBytes, "maxHistoryBytes", 1, 2147483647);
    this._history = new StateHistory(checkDistance + 1, maxHistoryBytes);
    this._frames = /* @__PURE__ */ new Map();
    this.failure = null;
    this.closed = false;
    this.resimulatedTicks = 0;
    this.checkedTicks = 0;
    const initial = this._save();
    if (initial.length * (checkDistance + 1) > maxHistoryBytes) throw new RangeError("synctest history byte budget");
    if (adapter.validateSnapshot(initial.slice(), { tick: this.tick }) !== true) throw new TypeError("initial snapshot validation");
    this._history.put({ tick: this.tick, bytes: initial });
  }
  get tick() {
    return this._tick;
  }
  get status() {
    return this.closed ? "closed" : this.failure ? "failed" : "running";
  }
  get metrics() {
    const error = this.failure;
    const failure = error ? Object.freeze({
      name: error.name ?? "Error",
      message: String(error.message ?? error),
      code: error.code ?? null,
      tick: error.tick ?? null,
      checkpointTick: error.checkpointTick ?? null,
      firstDifference: error.firstDifference ?? null,
      expectedHash: error.expectedHash ?? null,
      actualHash: error.actualHash ?? null
    }) : null;
    return Object.freeze({
      status: this.status,
      tick: this.tick,
      checkDistance: this.checkDistance,
      checkedTicks: this.checkedTicks,
      resimulatedTicks: this.resimulatedTicks,
      stateHash: this.closed ? null : this.getStateHash() ?? null,
      historyBytes: this._history.byteLength,
      failure,
      ...this._cost
    });
  }
  _save() {
    const value = bytes(this.adapter.save()).slice();
    if (!value.length || value.length > this.maxSnapshotBytes) throw new RangeError("snapshot size");
    return value;
  }
  _inputs(inputs) {
    if (!Array.isArray(inputs) || inputs.length !== this.players.length) throw new TypeError("all local player inputs required");
    const ordered = [...inputs].sort((a, b) => compareIds(a.playerId, b.playerId));
    return ordered.map((frame, index) => {
      if (frame.playerId !== this.players[index] || bytes(frame.input).length !== this.inputSize) throw new TypeError("player/inputSize");
      const commands = frame.commands ?? [];
      if (!Array.isArray(commands) || commands.length > 256) throw new TypeError("commands");
      const sorted = [...commands].sort((a, b) => a.sequence - b.sequence);
      let previous = 0;
      for (const command of sorted) {
        integer(command.sequence, "command sequence", 1);
        if (command.sequence <= previous || command.executeTick !== this.tick) throw new TypeError("command ordering/executeTick");
        const payload = bytes(command.payload);
        if (!payload.length || payload.length > 15360) throw new RangeError("command payload");
        previous = command.sequence;
      }
      return { ...copyFrame({ input: bytes(frame.input), commands: sorted }), playerId: frame.playerId, predicted: false };
    });
  }
  advance(inputs) {
    if (this.closed) throw new Error("sync test closed");
    if (this.failure) throw this.failure;
    integer(this.tick + 1, "tick limit", 0, MAX_TICK);
    const frames = this._inputs(inputs), before = this._history.get(this.tick), frameTick = this.tick;
    let forward = before.bytes;
    const started = this._now();
    let replayStarted;
    try {
      runSimulationFrame(this.adapter, { tick: frameTick, tickRate: this.tickRate, inputs: frames, resimulating: false, synctesting: true });
      const next = this._save();
      this._history.put({ tick: frameTick + 1, bytes: next });
      forward = next;
      this._frames.set(frameTick, frames);
      this._tick++;
      replayStarted = this._now();
      this._cost.forwardCostMs += Math.max(0, replayStarted - started);
      const from = Math.max(this.initialTick, this.tick - this.checkDistance);
      this.adapter.load(this._history.get(from).bytes.slice());
      for (let tick = from; tick < this.tick; tick++) {
        const input = this._frames.get(tick);
        runSimulationFrame(this.adapter, { tick, tickRate: this.tickRate, inputs: input, resimulating: true, synctesting: true });
        const actual = this._save(), expected = this._history.get(tick + 1).bytes;
        this.resimulatedTicks++;
        if (!equalBytes(actual, expected)) throw new DeterminismError({ tick: tick + 1, checkpointTick: from, expected, actual, inputs: input });
      }
      this.checkedTicks++;
      for (const tick of this._frames.keys()) if (tick < from) this._frames.delete(tick);
    } catch (error) {
      this.failure = error;
      throw error;
    } finally {
      try {
        this.adapter.load(forward.slice());
      } catch (error) {
        if (this.failure) this.failure.restoreError = error;
        else {
          this.failure = error;
          throw error;
        }
      } finally {
        const finished = this._now();
        if (replayStarted !== void 0) this._cost.resimulationCostMs += Math.max(0, finished - replayStarted);
        else this._cost.forwardCostMs += Math.max(0, finished - started);
        this._cost.totalCostMs += Math.max(0, finished - started);
      }
    }
    return { tick: this.tick, checkedTicks: this.checkedTicks, resimulatedTicks: this.resimulatedTicks };
  }
  getStateHash() {
    const state = this._history.get(this.tick);
    if (!state) return void 0;
    if (state.hash === void 0) state.hash = hashBytes(state.bytes);
    return state.hash;
  }
  close() {
    this.closed = true;
    this._frames.clear();
    this._history.slots.fill(void 0);
    this._history.byteLength = 0;
  }
};
function beginSyncTestBatch(frames, options) {
  if (!Array.isArray(frames)) throw new TypeError("frames");
  return { initial: bytes(options.adapter.save()).slice(), session: createSyncTestSession(options) };
}
function advanceSyncTestBatch(session, frame) {
  if (frame.tick !== session.tick) throw new TypeError("non-contiguous test frames");
  session.advance(frame.inputs);
}
function syncTestBatchResult(session) {
  return { tick: session.tick, checkedTicks: session.checkedTicks, resimulatedTicks: session.resimulatedTicks, hash: session.getStateHash(), metrics: session.metrics };
}
function syncTestBatchFailure(session, error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  session.failure ??= failure;
  failure.syncTestMetrics = session.metrics;
  return failure;
}
function checkSyncTestAbort(signal) {
  if (signal?.aborted) {
    if (signal.reason instanceof Error) throw signal.reason;
    const error = new Error(signal.reason === void 0 ? "Synctest aborted" : String(signal.reason));
    error.name = "AbortError";
    throw error;
  }
}
function runSyncTest({ frames, ...options } = {}) {
  const { initial, session } = beginSyncTestBatch(frames, options);
  try {
    for (const frame of frames) advanceSyncTestBatch(session, frame);
    return syncTestBatchResult(session);
  } catch (error) {
    throw syncTestBatchFailure(session, error);
  } finally {
    session.close();
    options.adapter.load(initial);
  }
}
async function runSyncTestAsync({ frames, yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)), signal, ...options } = {}) {
  if (typeof yieldControl !== "function") throw new TypeError("yieldControl");
  const { initial, session } = beginSyncTestBatch(frames, options);
  try {
    checkSyncTestAbort(signal);
    for (const frame of frames) {
      await yieldControl();
      checkSyncTestAbort(signal);
      advanceSyncTestBatch(session, frame);
      await yieldControl();
      checkSyncTestAbort(signal);
    }
    return syncTestBatchResult(session);
  } catch (error) {
    throw syncTestBatchFailure(session, error);
  } finally {
    session.close();
    options.adapter.load(initial);
  }
}
export {
  DeterminismError,
  SeededPRNG,
  SyncTestSession,
  binaryCodec,
  createSyncTestSession,
  createValueCodec,
  fixedPoint,
  hashBytes,
  jsonCodec,
  runSyncTest,
  runSyncTestAsync,
  statelessRandom
};
