// packages/presentation-events/src/index.js
var integer = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer`);
  return value;
};
var time = (value, name) => {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be nonnegative milliseconds`);
  return value;
};
function presentationEventKey(event) {
  integer(event.tick, "tick");
  integer(event.sequence, "sequence");
  integer(event.generation, "generation");
  if (typeof event.entityId !== "string" && typeof event.entityId !== "number" || typeof event.entityId === "number" && !Number.isSafeInteger(event.entityId)) throw new TypeError("entityId must be string or safe integer");
  if (typeof event.kind !== "string" || !event.kind) throw new TypeError("kind required");
  return JSON.stringify([event.tick, event.sequence, event.entityId, event.generation, event.kind]);
}
var PresentationEventQueue = class {
  constructor({ adapters, retentionTicks = 120, maxPending = 1e5, nowMs = 0 } = {}) {
    if (!adapters || typeof adapters !== "object") throw new TypeError("adapters required");
    integer(retentionTicks, "retentionTicks");
    if (!retentionTicks) throw new RangeError("retentionTicks must be positive");
    integer(maxPending, "maxPending");
    if (!maxPending) throw new RangeError("maxPending must be positive");
    this.adapters = new Map(Object.entries(adapters));
    for (const [kind, adapter] of this.adapters) {
      if (!kind || typeof adapter?.start !== "function") throw new TypeError("adapter.start required");
      if (adapter.reversible === true && typeof adapter.stop !== "function") throw new TypeError("reversible adapter.stop required");
      for (const key of ["stop", "update", "reconcile", "confirm"]) if (adapter[key] !== void 0 && typeof adapter[key] !== "function") throw new TypeError(`adapter.${key} must be function`);
    }
    this.retentionTicks = retentionTicks;
    this.maxPending = maxPending;
    this.nowMs = time(nowMs, "nowMs");
    this.confirmedTick = -1;
    this.records = /* @__PURE__ */ new Map();
    this.active = /* @__PURE__ */ new Set();
    this.rollbackFrom = null;
    this.disposed = false;
    this.confirmationDirty = false;
    this.stats = { started: 0, duplicates: 0, cancelled: 0, expired: 0, collected: 0, rejectedOld: 0 };
  }
  _ready() {
    if (this.disposed) throw new Error("event queue disposed");
  }
  _start(record) {
    try {
      record.handle = record.adapter.start(record.event, this.nowMs);
    } catch (error) {
      if (record.confirmed) this.confirmationDirty = true;
      throw error;
    }
    record.startedMs = this.nowMs;
    record.state = "active";
    this.active.add(record);
    this.stats.started++;
    if (record.durationMs === 0) {
      this._stop(record, "expired");
      this.stats.expired++;
    }
  }
  _release(record) {
    if (!record.confirmed || record.state === "active" || record.state === "pending") return;
    const { tick } = record.event;
    if (!record.compacted) {
      const { sequence, entityId, generation, kind, policy } = record.event;
      record.event = { tick, sequence, entityId, generation, kind, policy };
      record.handle = void 0;
      record.compacted = true;
    }
    if (tick <= this.confirmedTick - this.retentionTicks && this.records.delete(record.key)) this.stats.collected++;
  }
  _stop(record, reason) {
    if (record.state === "active") {
      record.state = reason;
      this.active.delete(record);
      try {
        record.adapter.stop?.(record.handle, reason, record.event);
      } finally {
        record.handle = void 0;
        this._release(record);
      }
    } else {
      record.state = reason;
      this._release(record);
    }
  }
  emit(event) {
    this._ready();
    const key = presentationEventKey(event), adapter = this.adapters.get(event.kind);
    if (!adapter) throw new RangeError(`unknown presentation kind: ${event.kind}`);
    const policy = event.policy ?? "confirmed";
    if (policy !== "confirmed" && policy !== "speculative") throw new RangeError("policy must be confirmed or speculative");
    if (policy === "speculative" && adapter.reversible !== true) throw new Error("speculation requires reversible resources; played one-shot sounds cannot be unplayed");
    const durationMs = event.durationMs === void 0 ? Infinity : time(event.durationMs, "durationMs");
    if (this.rollbackFrom !== null && event.tick < this.rollbackFrom) throw new RangeError("resimulation event precedes rollback range");
    if (event.tick <= this.confirmedTick - this.retentionTicks) {
      this.stats.rejectedOld++;
      return false;
    }
    let record = this.records.get(key);
    if (record) {
      if (record.policy !== policy) throw new Error("event policy cannot change for a stable identity");
      record.seen = true;
      this.stats.duplicates++;
      if (!record.confirmed) {
        const previous = record.event;
        record.event = { ...event, policy };
        record.durationMs = durationMs;
        if (record.state === "cancelled") {
          record.state = "pending";
          if (policy === "speculative") this._start(record);
        } else if (record.state === "active") adapter.reconcile?.(record.handle, record.event, previous, this.nowMs);
        else if (record.state === "pending" && policy === "speculative") this._start(record);
      }
      if (record.confirmed && record.state === "pending") this._start(record);
      return false;
    }
    if (this.records.size >= this.maxPending) throw new RangeError("presentation journal capacity exceeded; confirm/collect or increase capacity explicitly");
    record = {
      key,
      event: { ...event, policy },
      adapter,
      policy,
      durationMs,
      confirmed: event.tick <= this.confirmedTick,
      state: "pending",
      handle: void 0,
      startedMs: 0,
      seen: true,
      compacted: false
    };
    this.records.set(key, record);
    if (policy === "speculative" || record.confirmed) this._start(record);
    return true;
  }
  beginRollback(fromTick) {
    this._ready();
    integer(fromTick, "fromTick");
    if (this.rollbackFrom !== null) throw new Error("rollback already active");
    if (fromTick <= this.confirmedTick) throw new RangeError("cannot rollback confirmed presentation");
    this.rollbackFrom = fromTick;
    for (const record of this.records.values()) if (record.event.tick >= fromTick && !record.confirmed) record.seen = false;
  }
  endRollback() {
    this._ready();
    if (this.rollbackFrom === null) throw new Error("no rollback active");
    this.rollbackFrom = null;
    const errors = [];
    for (const record of this.records.values()) if (!record.seen && !record.confirmed && record.state !== "cancelled") {
      try {
        this._stop(record, "cancelled");
      } catch (error) {
        errors.push(error);
      }
      this.stats.cancelled++;
    }
    if (errors.length) throw new AggregateError(errors, "rollback resource cleanup failed");
  }
  confirmThrough(tick) {
    this._ready();
    integer(tick, "tick");
    if (this.rollbackFrom !== null) throw new Error("finish rollback before confirmation");
    if (tick < this.confirmedTick) throw new RangeError("confirmed tick cannot regress");
    if (tick === this.confirmedTick && !this.confirmationDirty) return;
    this.confirmedTick = tick;
    this.confirmationDirty = true;
    for (const record of this.records.values()) if (record.event.tick <= tick) {
      const wasConfirmed = record.confirmed;
      record.confirmed = true;
      if (record.state === "pending") this._start(record);
      if (!wasConfirmed && record.state === "active") record.adapter.confirm?.(record.handle, record.event);
      this._release(record);
    }
    this.collect();
    this.confirmationDirty = false;
  }
  update(nowMs) {
    this._ready();
    time(nowMs, "nowMs");
    if (nowMs < this.nowMs) throw new RangeError("presentation clock must be monotonic");
    this.nowMs = nowMs;
    for (const record of this.active) {
      const ageMs = nowMs - record.startedMs;
      if (ageMs >= record.durationMs) {
        this._stop(record, "expired");
        this.stats.expired++;
      } else record.adapter.update?.(record.handle, ageMs, record.event);
    }
  }
  /** Adapter reports a naturally completed audio/particle resource without discarding its dedup identity. */
  finish(event) {
    this._ready();
    const record = this.records.get(presentationEventKey(event));
    if (!record || record.state !== "active") return false;
    this._stop(record, "expired");
    this.stats.expired++;
    return true;
  }
  collect() {
    this._ready();
    const cutoff = this.confirmedTick - this.retentionTicks;
    for (const [key, record] of this.records) if (record.confirmed && record.event.tick <= cutoff && record.state !== "active" && record.state !== "pending") {
      this.records.delete(key);
      this.stats.collected++;
    }
  }
  get size() {
    return this.records.size;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const errors = [];
    for (const record of this.records.values()) try {
      this._stop(record, "disposed");
    } catch (error) {
      errors.push(error);
    }
    this.records.clear();
    this.active.clear();
    this.rollbackFrom = null;
    if (errors.length) throw new AggregateError(errors, "presentation cleanup failed");
  }
};
export {
  PresentationEventQueue,
  presentationEventKey
};
