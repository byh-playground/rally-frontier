// packages/input/src/actions.js
function actionName(action) {
  if (typeof action !== "string" || !action.length) throw new TypeError("action must be a nonempty string");
}
function sourceId(source) {
  if ((typeof source !== "string" || !source.length) && typeof source !== "symbol") {
    throw new TypeError("source must be a nonempty string or symbol");
  }
}
var ActionState = class {
  #actions = /* @__PURE__ */ new Map();
  #sources = /* @__PURE__ */ new Map();
  #entry(action) {
    let entry = this.#actions.get(action);
    if (!entry) {
      entry = { sources: /* @__PURE__ */ new Set(), pressed: false, released: false };
      this.#actions.set(action, entry);
    }
    return entry;
  }
  /**
   * 실제 장치/source의 눌림을 갱신합니다. 반복 down/up은 무시합니다.
   * 첫 source가 눌리면 pressed, 마지막 source가 해제되면 released가 생깁니다.
   * @param {string} action @param {string|symbol} source @param {boolean} down
   */
  set(action, source, down) {
    actionName(action);
    sourceId(source);
    if (typeof down !== "boolean") throw new TypeError("down must be boolean");
    const entry = down ? this.#entry(action) : this.#actions.get(action);
    if (!entry || entry.sources.has(source) === down) return;
    if (down) {
      if (!entry.sources.size) entry.pressed = true;
      entry.sources.add(source);
      let actions = this.#sources.get(source);
      if (!actions) this.#sources.set(source, actions = /* @__PURE__ */ new Set());
      actions.add(action);
    } else {
      entry.sources.delete(source);
      if (!entry.sources.size) entry.released = true;
      const actions = this.#sources.get(source);
      actions.delete(action);
      if (!actions.size) this.#sources.delete(source);
    }
  }
  /**
   * tap 같은 이산 행동의 pressed/released를 함께 표시합니다. 기존 hold는 유지합니다.
   * 같은 consume 구간의 반복 pulse는 bool 하나로 합쳐집니다. 횟수/좌표는 호출자가 큐에 보관합니다.
   * @param {string} action
   */
  pulse(action) {
    actionName(action);
    const entry = this.#entry(action);
    entry.pressed = true;
    entry.released = true;
  }
  /** 해당 source의 hold만 해제합니다. 다른 장치/어댑터의 hold는 유지합니다. @param {string|symbol} source */
  releaseSource(source) {
    sourceId(source);
    const actions = this.#sources.get(source);
    if (!actions) return;
    for (const action of actions) {
      const entry = this.#actions.get(action);
      entry.sources.delete(source);
      if (!entry.sources.size) entry.released = true;
    }
    this.#sources.delete(source);
  }
  /** 모든 source를 해제합니다. 남아 있는 edge는 consume() 전까지 유지됩니다. */
  releaseAll() {
    for (const source of this.#sources.keys()) this.releaseSource(source);
  }
  /** 소비 없이 재사용 가능한 out을 갱신합니다. 모르는 액션은 모두 false입니다. @param {string} action @param {ActionSample} out @returns {ActionSample} */
  sampleInto(action, out) {
    actionName(action);
    if (!out || typeof out !== "object") throw new TypeError("out must be a writable object");
    const entry = this.#actions.get(action);
    out.held = !!entry?.sources.size;
    out.pressed = entry?.pressed ?? false;
    out.released = entry?.released ?? false;
    return out;
  }
  /** 새 객체가 필요한 편의 함수. 매 프레임에는 sampleInto를 쓰세요. @param {string} action @returns {ActionSample} */
  sample(action) {
    return this.sampleInto(action, {});
  }
  /** 게임의 입력 제출/simulation tick 경계에서만 명시적으로 호출합니다. hold는 유지합니다. */
  consume() {
    for (const entry of this.#actions.values()) {
      entry.pressed = false;
      entry.released = false;
    }
  }
};

// packages/input/src/dom.js
var UI_TARGETS = 'input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"]), [data-gamekit-ui]';
var BUTTON_BITS = [1, 4, 2, 8, 16];
function bindings(value, name, pointer = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const map = /* @__PURE__ */ new Map();
  for (const [key, action] of Object.entries(value)) {
    if (!key.length || typeof action !== "string" || !action.length) throw new TypeError(`${name} requires nonempty action names`);
    if (pointer && !/^[0-4]$/.test(key)) throw new RangeError("pointerButtons keys must be 0..4");
    map.set(pointer ? Number(key) : key, action);
  }
  return map;
}
function positive(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite nonnegative number`);
  return value;
}
function gestureOptions(value) {
  if (value === void 0 || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("gestures must be an object");
  const result = {
    tap: value.tap,
    doubleTap: value.doubleTap,
    button: value.button ?? 0,
    tapMs: value.tapMs ?? 400,
    doubleTapMs: value.doubleTapMs ?? 300,
    dragSlop: value.dragSlop ?? 12,
    doubleTapSlop: value.doubleTapSlop ?? 32
  };
  for (const name of ["tap", "doubleTap"]) {
    if (result[name] !== void 0 && (typeof result[name] !== "string" || !result[name].length)) throw new TypeError(`gestures.${name} must be a nonempty action name`);
  }
  if (!result.tap && !result.doubleTap) throw new TypeError("gestures needs tap or doubleTap");
  if (!Number.isInteger(result.button) || result.button < 0 || result.button > 4) throw new RangeError("gestures.button must be 0..4");
  for (const name of ["tapMs", "doubleTapMs", "dragSlop", "doubleTapSlop"]) positive(result[name], `gestures.${name}`);
  return result;
}
function pointerPositionInto(event, target, out) {
  if (!out || typeof out !== "object") throw new TypeError("out must be a writable object");
  const rect = target.getBoundingClientRect();
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY) || !Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) return false;
  out.x = event.clientX - rect.left;
  out.y = event.clientY - rect.top;
  out.u = out.x / rect.width;
  out.v = out.y / rect.height;
  return true;
}
function createDOMInput({ target, state = new ActionState(), keys = {}, pointerButtons = {}, keyboardTarget = target?.ownerDocument, excludeTarget = UI_TARGETS, preventDefault = true, touchAction, gestures, onGesture, onPointer, onRelease } = {}) {
  const doc = target?.ownerDocument;
  if (!target?.addEventListener || !target?.getBoundingClientRect || !doc?.addEventListener || !keyboardTarget?.addEventListener) throw new TypeError("target needs a DOM ownerDocument; keyboardTarget must be an EventTarget");
  if (!(state instanceof ActionState)) throw new TypeError("state must be an ActionState");
  if (typeof excludeTarget !== "string" && typeof excludeTarget !== "function" && excludeTarget !== false) throw new TypeError("excludeTarget must be a selector, predicate or false");
  if (typeof preventDefault !== "boolean") throw new TypeError("preventDefault must be boolean");
  if (touchAction !== void 0 && typeof touchAction !== "string") throw new TypeError("touchAction must be a string");
  if (onGesture !== void 0 && typeof onGesture !== "function") throw new TypeError("onGesture must be a function");
  for (const [name, callback] of Object.entries({ onPointer, onRelease })) if (callback !== void 0 && typeof callback !== "function") throw new TypeError(`${name} must be a function`);
  const keyMap = bindings(keys, "keys");
  const buttonMap = bindings(pointerButtons, "pointerButtons", true);
  const gesture = gestureOptions(gestures);
  if (typeof excludeTarget === "string" && excludeTarget) target.matches?.(excludeTarget);
  const activeKeys = /* @__PURE__ */ new Map();
  const pointers = /* @__PURE__ */ new Map();
  const removers = [];
  let latest = null, lastTap = null, disposed = false;
  const oldTouchAction = target.style?.touchAction;
  const listen = (owner, type, callback, options) => {
    owner.addEventListener(type, callback, options);
    removers.push(() => owner.removeEventListener(type, callback, options));
  };
  const prevent = (event) => {
    if (preventDefault && event.cancelable) event.preventDefault();
  };
  const inside = (event) => event.composedPath?.().includes(target) || event.target === target || target.contains?.(event.target);
  const excluded = (event) => {
    if (excludeTarget === false || excludeTarget === "") return false;
    if (typeof excludeTarget === "function") return !!excludeTarget(event.target, event);
    const path = event.composedPath?.() ?? [event.target];
    return path.some((node) => node?.closest?.(excludeTarget));
  };
  const sample = (record, out) => {
    if (!record) return false;
    if (!out || typeof out !== "object") throw new TypeError("out must be a writable object");
    out.pointerId = record.pointerId;
    out.pointerType = record.pointerType;
    out.x = record.x;
    out.y = record.y;
    out.u = record.u;
    out.v = record.v;
    out.buttons = record.buttons;
    out.timeMs = record.timeMs;
    out.active = record.active;
    return true;
  };
  const notifyPointer = (type, record, originalEvent, reason) => {
    if (!onPointer) return;
    const value = { type, originalEvent, reason };
    sample(record, value);
    onPointer(value);
  };
  const updatePosition = (record, event) => {
    if (!pointerPositionInto(event, target, record)) return false;
    record.buttons = event.buttons;
    record.timeMs = event.timeStamp;
    latest = record;
    return true;
  };
  const syncButtons = (record, event) => {
    for (const [button, action] of buttonMap) {
      const down = (event.buttons & BUTTON_BITS[button]) !== 0;
      let source = record.sources.get(button);
      if (down && !source) {
        source = /* @__PURE__ */ Symbol(`pointer:${event.pointerId}:${button}`);
        record.sources.set(button, source);
        state.set(action, source, true);
      } else if (!down && source) {
        state.releaseSource(source);
        record.sources.delete(button);
      }
    }
  };
  const releaseCapture = (id) => {
    try {
      if (target.hasPointerCapture?.(id)) target.releasePointerCapture(id);
    } catch {
    }
  };
  const dropPointer = (record) => {
    pointers.delete(record.pointerId);
    record.active = false;
    for (const source of record.sources.values()) state.releaseSource(source);
    record.sources.clear();
    releaseCapture(record.pointerId);
  };
  const releaseAll = (event) => {
    const released = onPointer ? [...pointers.values()] : [];
    for (const source of activeKeys.values()) state.releaseSource(source);
    activeKeys.clear();
    for (const record of pointers.values()) dropPointer(record);
    lastTap = null;
    latest = null;
    const reason = typeof event === "string" ? event : event?.type ?? "releaseAll";
    const errors = [];
    for (const record of released) try {
      notifyPointer("cancel", record, event?.type ? event : null, reason);
    } catch (error) {
      errors.push(error);
    }
    try {
      onRelease?.({ reason, originalEvent: event?.type ? event : null });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "input release callbacks failed");
  };
  const cancelGesture = (record) => {
    record.gestureCanceled = true;
    lastTap = null;
  };
  const moved = (record, event) => Math.hypot(event.clientX - record.startX, event.clientY - record.startY) > gesture.dragSlop;
  const checkGesture = (record, event) => {
    if (!gesture || record.gestureCanceled) return;
    if (moved(record, event) || (event.buttons & ~BUTTON_BITS[gesture.button]) !== 0) cancelGesture(record);
  };
  const keydown = (event) => {
    const action = keyMap.get(event.code);
    if (!action || doc.hidden || excluded(event)) return;
    if (!activeKeys.has(event.code)) {
      if (event.repeat) return;
      const source = /* @__PURE__ */ Symbol(`key:${event.code}`);
      activeKeys.set(event.code, source);
      state.set(action, source, true);
    }
    prevent(event);
  };
  const keyup = (event) => {
    const source = activeKeys.get(event.code);
    if (!source) return;
    state.releaseSource(source);
    activeKeys.delete(event.code);
    if (!excluded(event)) prevent(event);
  };
  const pointerdown = (event) => {
    if (doc.hidden || excluded(event) || pointers.has(event.pointerId)) return;
    if (!buttonMap.has(event.button) && (!gesture || event.button !== gesture.button)) return;
    const record = { pointerId: event.pointerId, pointerType: event.pointerType, active: true, sources: /* @__PURE__ */ new Map(), startX: event.clientX, startY: event.clientY, startMs: event.timeStamp, gestureCanceled: !gesture || event.button !== gesture.button || pointers.size > 0 };
    if (!updatePosition(record, event)) return;
    if (pointers.size) for (const other of pointers.values()) cancelGesture(other);
    pointers.set(event.pointerId, record);
    syncButtons(record, event);
    checkGesture(record, event);
    try {
      target.setPointerCapture?.(event.pointerId);
    } catch {
    }
    prevent(event);
    notifyPointer("down", record, event);
  };
  const pointermove = (event) => {
    const record = pointers.get(event.pointerId);
    if (!record) {
      if (inside(event) && !excluded(event)) {
        const hover = latest && !latest.active && latest.pointerId === event.pointerId ? latest : { pointerId: event.pointerId, pointerType: event.pointerType, active: false };
        if (updatePosition(hover, event)) notifyPointer("move", hover, event);
      }
      return;
    }
    if (!updatePosition(record, event)) cancelGesture(record);
    checkGesture(record, event);
    syncButtons(record, event);
    prevent(event);
    notifyPointer("move", record, event);
  };
  const pointerend = (event, canceled) => {
    const record = pointers.get(event.pointerId);
    if (!record) return;
    const validPosition = updatePosition(record, event);
    checkGesture(record, event);
    dropPointer(record);
    if (!canceled) prevent(event);
    notifyPointer(canceled ? "cancel" : "up", record, event, canceled ? "pointercancel" : void 0);
    if (!gesture) return;
    const duration = event.timeStamp - record.startMs;
    if (canceled || !validPosition || record.gestureCanceled || !Number.isFinite(duration) || duration < 0 || duration > gesture.tapMs || record.u < 0 || record.u > 1 || record.v < 0 || record.v > 1) {
      lastTap = null;
      return;
    }
    const gap = lastTap ? event.timeStamp - lastTap.timeMs : Infinity;
    const double = !!gesture.doubleTap && !!lastTap && lastTap.pointerType === record.pointerType && gap >= 0 && gap <= gesture.doubleTapMs && Math.hypot(event.clientX - lastTap.clientX, event.clientY - lastTap.clientY) <= gesture.doubleTapSlop;
    const type = double ? "doubleTap" : "tap";
    const action = gesture[type];
    lastTap = double ? null : { timeMs: event.timeStamp, clientX: event.clientX, clientY: event.clientY, pointerType: record.pointerType };
    if (action) state.pulse(action);
    if (onGesture) onGesture({ type, action: action ?? null, pointerId: record.pointerId, pointerType: record.pointerType, x: record.x, y: record.y, u: record.u, v: record.v, timeMs: record.timeMs });
  };
  const unrelatedDown = (event) => {
    if (!inside(event) || excluded(event) || !buttonMap.has(event.button) && gesture && event.button !== gesture.button) {
      lastTap = null;
      for (const record of pointers.values()) cancelGesture(record);
    }
  };
  const lostcapture = (event) => {
    const record = pointers.get(event.pointerId);
    if (!record) return;
    dropPointer(record);
    lastTap = null;
    notifyPointer("cancel", record, event, "lostpointercapture");
  };
  listen(keyboardTarget, "keydown", keydown);
  listen(doc, "keyup", keyup, true);
  listen(target, "pointerdown", pointerdown, { passive: false });
  listen(doc, "pointerdown", unrelatedDown, true);
  listen(doc, "pointermove", pointermove, { capture: true, passive: false });
  listen(doc, "pointerup", (event) => pointerend(event, false), { capture: true, passive: false });
  listen(doc, "pointercancel", (event) => pointerend(event, true), true);
  listen(target, "lostpointercapture", lostcapture);
  listen(doc, "visibilitychange", (event) => {
    if (doc.hidden) releaseAll(event);
  });
  if (doc.defaultView) {
    listen(doc.defaultView, "blur", releaseAll);
    listen(doc.defaultView, "pagehide", releaseAll);
  }
  if (preventDefault && (buttonMap.has(2) || gesture?.button === 2)) {
    listen(target, "contextmenu", (event) => {
      if (!excluded(event)) prevent(event);
    });
  }
  if (touchAction !== void 0 && target.style) target.style.touchAction = touchAction;
  return {
    state,
    get disposed() {
      return disposed;
    },
    samplePointerInto(pointerId, out) {
      return sample(pointers.get(pointerId), out);
    },
    sampleLatestPointerInto(out) {
      return sample(latest, out);
    },
    releaseAll,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const remove of removers) remove();
      try {
        releaseAll("dispose");
      } finally {
        if (touchAction !== void 0 && target.style?.touchAction === touchAction) target.style.touchAction = oldTouchAction;
      }
    }
  };
}
export {
  ActionState,
  createDOMInput,
  pointerPositionInto
};
