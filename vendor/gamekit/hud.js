// packages/hud/src/index.js
var finite = (value, name) => {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
};
function resolveAnchorInto(camera, anchor, out) {
  const space = anchor.space ?? "world";
  if (space === "world") camera.worldToScreenInto(anchor.x, anchor.y, anchor.z ?? 0, out);
  else if (space === "screen") {
    out.x = finite(anchor.x, "x");
    out.y = finite(anchor.y, "y");
  } else throw new RangeError("anchor.space must be world or screen");
  out.x += finite(anchor.offsetX ?? 0, "offsetX");
  out.y += finite(anchor.offsetY ?? 0, "offsetY");
  const margin = finite(anchor.margin ?? 0, "margin");
  if (margin < 0 || margin * 2 > Math.min(camera.width, camera.height)) throw new RangeError("margin outside viewport");
  out.onScreen = out.x >= margin && out.x <= camera.width - margin && out.y >= margin && out.y <= camera.height - margin;
  out.visible = anchor.visible !== false && (anchor.clamp === true || out.onScreen);
  if (anchor.clamp === true) {
    out.x = Math.max(margin, Math.min(camera.width - margin, out.x));
    out.y = Math.max(margin, Math.min(camera.height - margin, out.y));
  }
  return out;
}
var DOMHud = class {
  constructor({ camera, root } = {}) {
    if (typeof camera?.worldToScreenInto !== "function" || !root?.appendChild) throw new TypeError("camera and DOM root required");
    this.camera = camera;
    this.root = root;
    this.entries = /* @__PURE__ */ new Map();
    this.disposed = false;
    this.stats = { writes: 0, nodes: 0 };
  }
  _ready() {
    if (this.disposed) throw new Error("HUD disposed");
  }
  add(id, { element, anchor, text } = {}) {
    this._ready();
    if (this.entries.has(id)) throw new Error("duplicate HUD id");
    if (!anchor || typeof anchor !== "object") throw new TypeError("anchor required");
    if (text !== void 0 && typeof text !== "string" && typeof text !== "number") throw new TypeError("HUD text must be string or number");
    const owned = !element;
    element ??= this.root.ownerDocument.createElement("span");
    if (!element.style || !element.setAttribute) throw new TypeError("DOM element required");
    const point = {};
    resolveAnchorInto(this.camera, anchor, point);
    const previous = { css: element.getAttribute("style"), hidden: element.hidden, children: [...element.childNodes], parent: element.parentNode, next: element.nextSibling };
    if (!owned && previous.parent) {
      previous.marker = element.ownerDocument.createComment("hud position");
      previous.parent.insertBefore(previous.marker, element);
    }
    element.style.position = "absolute";
    element.style.left = "0";
    element.style.top = "0";
    element.style.pointerEvents = "none";
    this.root.appendChild(element);
    this.entries.set(id, { element, anchor: { ...anchor }, point, owned, previous, x: NaN, y: NaN, visible: null, text: void 0 });
    this.stats.nodes++;
    if (text !== void 0) this.setText(id, text);
    return element;
  }
  setText(id, text) {
    this._ready();
    const entry = this.entries.get(id);
    if (!entry) throw new RangeError("unknown HUD id");
    if (typeof text !== "string" && typeof text !== "number") throw new TypeError("HUD text must be string or number");
    text = String(text);
    if (entry.text !== text) {
      entry.element.textContent = text;
      entry.text = text;
      this.stats.writes++;
    }
    return this;
  }
  setAnchor(id, anchor) {
    this._ready();
    const entry = this.entries.get(id);
    if (!entry) throw new RangeError("unknown HUD id");
    const next = { ...entry.anchor, ...anchor };
    resolveAnchorInto(this.camera, next, entry.point);
    entry.anchor = next;
    return this;
  }
  update() {
    this._ready();
    for (const entry of this.entries.values()) {
      const point = resolveAnchorInto(this.camera, entry.anchor, entry.point);
      if (point.visible !== entry.visible) {
        entry.element.hidden = !point.visible;
        entry.visible = point.visible;
        this.stats.writes++;
      }
      if (point.visible && (point.x !== entry.x || point.y !== entry.y)) {
        entry.element.style.transform = `translate(${point.x}px,${point.y}px) translate(-50%,-100%)`;
        entry.x = point.x;
        entry.y = point.y;
        this.stats.writes++;
      }
    }
    return this.stats;
  }
  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const { element, previous } = entry;
    if (entry.owned) element.remove();
    else {
      if (previous.css === null) element.removeAttribute("style");
      else element.setAttribute("style", previous.css);
      element.hidden = previous.hidden;
      element.replaceChildren(...previous.children);
      if (previous.parent) previous.parent.insertBefore(element, previous.marker?.parentNode === previous.parent ? previous.marker : previous.next?.parentNode === previous.parent ? previous.next : null);
      else element.remove();
      previous.marker?.remove();
    }
    this.entries.delete(id);
    this.stats.nodes--;
    return true;
  }
  dispose() {
    if (this.disposed) return;
    for (const id of this.entries.keys()) this.remove(id);
    this.disposed = true;
  }
};
function paintAnchored(camera, anchor, out, paint) {
  if (typeof paint !== "function") throw new TypeError("paint required");
  resolveAnchorInto(camera, anchor, out);
  if (out.visible) paint(out);
  return out.visible;
}
export {
  DOMHud,
  paintAnchored,
  resolveAnchorInto
};
