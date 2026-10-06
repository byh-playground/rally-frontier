// packages/debug-tools/src/index.js
var bound = (value, name, min = 1, max = 1e5) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${name} outside supported range`);
  return value;
};
var field = (object, key) => {
  try {
    return object?.[key];
  } catch {
    return void 0;
  }
};
function redactDiagnostic(value, limit = 1600) {
  bound(limit, "limit");
  const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  return text.replace(/\{[\s\S]*\}/g, "[structured data omitted]").replace(/(?:["']?(?:password|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret|cookie)["']?\s*[=:]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;]+)/gi, "[redacted]").replace(/\b(?:https?|blob|file):[^\r\n)\]<>"']+/gi, "[source]").replace(/(?:[A-Za-z]:[\\/]|\/(?!\/)[A-Za-z0-9_.~-]+\/)[^\r\n)\]<>"']*/g, "[local source]").replace(/\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]+)/gi, "[redacted]").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, limit);
}
var DiagnosticRing = class {
  constructor({ capacity = 20, now = () => performance.now(), release = "" } = {}) {
    bound(capacity, "capacity", 1, 1e3);
    if (typeof now !== "function") throw new TypeError("now must be function");
    this.capacity = capacity;
    this.now = now;
    this.release = redactDiagnostic(release, 160);
    this.records = new Array(capacity);
    this.start = 0;
    this.size = 0;
    this.total = 0;
    this.dropped = 0;
    this._lastMs = 0;
    this._busy = false;
    this._listeners = /* @__PURE__ */ new Set();
  }
  report(error, { kind = "exception", fatal = false, origin = "main", source = "", line = 0, column = 0, workerTimeMs = null, cause = "" } = {}) {
    if (this._busy) {
      this.dropped++;
      return null;
    }
    this._busy = true;
    try {
      const at = this.now();
      if (!Number.isFinite(at)) throw new TypeError("diagnostic clock must be finite");
      this._lastMs = Math.max(this._lastMs, at);
      const record = {
        kind: redactDiagnostic(kind, 64),
        fatal: Boolean(fatal),
        origin: redactDiagnostic(origin, 64),
        message: redactDiagnostic(typeof error === "string" ? error : field(error, "message") ?? "Non-text error omitted", 500),
        stack: redactDiagnostic(field(error, "stack"), 1800),
        source: redactDiagnostic(source, 160),
        line: Number.isSafeInteger(line) && line >= 0 ? line : 0,
        column: Number.isSafeInteger(column) && column >= 0 ? column : 0,
        workerTimeMs: Number.isFinite(workerTimeMs) && workerTimeMs >= 0 ? workerTimeMs : null,
        cause: redactDiagnostic(typeof cause === "string" && cause ? cause : field(field(error, "cause"), "message") ?? field(error, "cause"), 300),
        firstMs: this._lastMs,
        lastMs: this._lastMs,
        count: 1
      };
      this.total++;
      for (let i = 0; i < this.size; i++) {
        const old = this.records[(this.start + i) % this.capacity];
        if (old.kind === record.kind && old.message === record.message && old.stack === record.stack && old.fatal === record.fatal && old.origin === record.origin && old.source === record.source && old.line === record.line && old.column === record.column) {
          old.count++;
          old.lastMs = record.lastMs;
          return { ...old };
        }
      }
      if (this.size === this.capacity) {
        this.records[this.start] = record;
        this.start = (this.start + 1) % this.capacity;
        this.dropped++;
      } else {
        this.records[(this.start + this.size) % this.capacity] = record;
        this.size++;
      }
      return { ...record };
    } finally {
      this._busy = false;
    }
  }
  snapshot() {
    const errors = [];
    for (let i = 0; i < this.size; i++) errors.push({ ...this.records[(this.start + i) % this.capacity] });
    return { format: "bloom-gamekit diagnostics v1", release: this.release, total: this.total, dropped: this.dropped, errors };
  }
  format() {
    return JSON.stringify(this.snapshot(), null, 2);
  }
  /** Does not swallow errors or replace onerror. Caller decides whether a fatal error should halt gameplay. */
  installGlobal(target, { onReport } = {}) {
    if (!target?.addEventListener || !target?.removeEventListener) throw new TypeError("EventTarget required");
    if (onReport !== void 0 && typeof onReport !== "function") throw new TypeError("onReport must be function");
    const report = (error2, kind) => {
      try {
        const record = this.report(error2, { kind });
        onReport?.(record);
      } catch {
        this.dropped++;
      }
    };
    const error = (event) => report(event.error ?? event.message, "global-error");
    const rejection = (event) => report(event.reason, "unhandled-rejection");
    target.addEventListener("error", error);
    target.addEventListener("unhandledrejection", rejection);
    let active = true;
    const dispose = () => {
      if (!active) return;
      active = false;
      target.removeEventListener("error", error);
      target.removeEventListener("unhandledrejection", rejection);
      this._listeners.delete(dispose);
    };
    this._listeners.add(dispose);
    return dispose;
  }
  clear() {
    this.records.fill(void 0);
    this.size = this.start = this.total = this.dropped = 0;
  }
  dispose() {
    for (const dispose of this._listeners) dispose();
    this.clear();
  }
};
async function copyDiagnostic(text, { clipboard, textarea } = {}) {
  if (typeof text !== "string") throw new TypeError("text must be string");
  if (clipboard?.writeText) try {
    await clipboard.writeText(text);
    return { copied: true, method: "clipboard" };
  } catch {
  }
  if (textarea?.select) {
    textarea.value = text;
    textarea.focus();
    textarea.select();
    return { copied: false, method: "selection", text };
  }
  return { copied: false, method: "text", text };
}
var ReplayTimeline = class {
  constructor(adapter) {
    for (const name of ["read", "seek", "setPlaying"]) if (typeof adapter?.[name] !== "function") throw new TypeError(`replay adapter.${name} required`);
    this.adapter = adapter;
  }
  readInto(out) {
    const state = this.adapter.read();
    for (const name of ["tick", "firstTick", "lastTick"]) if (!Number.isSafeInteger(state[name]) || state[name] < 0) throw new RangeError(`invalid replay ${name}`);
    if (state.firstTick > state.lastTick || state.tick < state.firstTick || state.tick > state.lastTick) throw new RangeError("invalid replay bounds");
    out.tick = state.tick;
    out.firstTick = state.firstTick;
    out.lastTick = state.lastTick;
    out.playing = Boolean(state.playing);
    return out;
  }
  seek(tick) {
    const state = this.readInto({});
    if (!Number.isSafeInteger(tick)) throw new RangeError("tick must be safe integer");
    return this.adapter.seek(Math.max(state.firstTick, Math.min(state.lastTick, tick)));
  }
  step(delta = 1) {
    if (!Number.isSafeInteger(delta)) throw new RangeError("delta must be safe integer");
    const state = this.readInto({});
    this.adapter.setPlaying(false);
    return this.seek(state.tick + delta);
  }
  setPlaying(playing) {
    if (typeof playing !== "boolean") throw new TypeError("playing must be boolean");
    return this.adapter.setPlaying(playing);
  }
};
function compareStateFields(left, right, fields, { maxDifferences = 100 } = {}) {
  bound(maxDifferences, "maxDifferences");
  if (!Array.isArray(fields)) throw new TypeError("fields must be array");
  const differences = [];
  let mismatches = 0;
  for (const field2 of fields) {
    if (typeof field2?.name !== "string" || typeof field2?.read !== "function" || field2.equal !== void 0 && typeof field2.equal !== "function") throw new TypeError("field name/read required");
    const a = field2.read(left), b = field2.read(right), equal = field2.equal ? field2.equal(a, b) : Object.is(a, b);
    if (!equal) {
      mismatches++;
      if (differences.length < maxDifferences) differences.push({ field: redactDiagnostic(field2.name, 160), left: redactDiagnostic(a, 300), right: redactDiagnostic(b, 300) });
    }
  }
  return { equal: mismatches === 0, mismatches, truncated: mismatches > differences.length, differences };
}
export {
  DiagnosticRing,
  ReplayTimeline,
  compareStateFields,
  copyDiagnostic,
  redactDiagnostic
};
