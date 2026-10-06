// packages/camera/src/index.js
var finite = (n, name) => {
  if (!Number.isFinite(n)) throw new TypeError(`${name} must be finite`);
  return n;
};
var positive = (n, name) => {
  finite(n, name);
  if (n <= 0) throw new RangeError(`${name} must be positive`);
  return n;
};
var OrthographicProjection = class {
  constructor(options = {}) {
    this.configure({ degrees: 40, pixel2to1: false, ...options });
  }
  configure({ degrees = this._degrees, pixel2to1 = this.pixel2to1 } = {}) {
    finite(degrees, "degrees");
    if (degrees <= 0 || degrees > 90) throw new RangeError("degrees must be (0,90]");
    if (typeof pixel2to1 !== "boolean") throw new TypeError("pixel2to1 must be boolean");
    this._degrees = degrees;
    this.pixel2to1 = pixel2to1;
    this.K = pixel2to1 ? 0.5 : Math.sin(degrees * Math.PI / 180);
    this.H = Math.sqrt(Math.max(0, 1 - this.K * this.K));
    this.degrees = Math.asin(this.K) * 180 / Math.PI;
    return this;
  }
  projectInto(x, y, z, out) {
    finite(x, "x");
    finite(y, "y");
    finite(z, "z");
    out.x = x;
    out.y = y * this.K - z * this.H;
    out.depth = y * this.H + z * this.K;
    return out;
  }
  groundInto(x, y, out, z = 0) {
    finite(x, "x");
    finite(y, "y");
    finite(z, "z");
    out.x = x;
    out.y = (y + z * this.H) / this.K;
    out.z = z;
    return out;
  }
  depth(y, z = 0) {
    return finite(y, "y") * this.H + finite(z, "z") * this.K;
  }
  angle(angle) {
    finite(angle, "angle");
    return Math.atan2(Math.sin(angle) * this.K, Math.cos(angle));
  }
  intentInto(x, y, out) {
    finite(x, "x");
    finite(y, "y");
    const magnitude = Math.min(1, Math.hypot(x, y)), wy = y / this.K, length = Math.hypot(x, wy);
    out.x = length ? x / length * magnitude : 0;
    out.y = length ? wy / length * magnitude : 0;
    return out;
  }
};
var CameraViewport = class {
  constructor({ projection = new OrthographicProjection(), width = 1, height = 1, dpr = 1, left = 0, top = 0, x = 0, y = 0, zoom = 1, rotation = 0 } = {}) {
    if (typeof projection?.projectInto !== "function" || typeof projection?.groundInto !== "function") throw new TypeError("projection contract required");
    this.projection = projection;
    this.camera = { x: 0, y: 0, zoom: 1, rotation: 0 };
    this._point = {};
    this._render = {};
    this.shakeX = 0;
    this.shakeY = 0;
    this.setViewport({ width, height, dpr, left, top });
    this.setCamera({ x, y, zoom, rotation });
  }
  setViewport({ width = this.width, height = this.height, dpr = this.dpr, left = this.left, top = this.top } = {}) {
    positive(width, "width");
    positive(height, "height");
    positive(dpr, "dpr");
    positive(width * dpr, "backing width");
    positive(height * dpr, "backing height");
    finite(left, "left");
    finite(top, "top");
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.left = left;
    this.top = top;
    return this;
  }
  setCamera({ x = this.camera.x, y = this.camera.y, zoom = this.camera.zoom, rotation = this.camera.rotation } = {}) {
    finite(x, "x");
    finite(y, "y");
    positive(zoom, "zoom");
    finite(rotation, "rotation");
    Object.assign(this.camera, { x, y, zoom, rotation });
    this._cos = Math.cos(rotation);
    this._sin = Math.sin(rotation);
    return this;
  }
  setShake(x = 0, y = 0) {
    this.shakeX = finite(x, "x");
    this.shakeY = finite(y, "y");
    return this;
  }
  /** Caller chooses target and duration. This modifies presentation only; no random source or authority. */
  follow(x, y, elapsedMs, halfLifeMs = 0) {
    finite(x, "x");
    finite(y, "y");
    finite(elapsedMs, "elapsedMs");
    finite(halfLifeMs, "halfLifeMs");
    if (elapsedMs < 0 || halfLifeMs < 0) throw new RangeError("follow times must be nonnegative");
    const a = halfLifeMs === 0 ? 1 : -Math.expm1(-Math.LN2 * elapsedMs / halfLifeMs);
    return this.setCamera({ x: this.camera.x + (x - this.camera.x) * a, y: this.camera.y + (y - this.camera.y) * a });
  }
  rendererCameraInto(out) {
    const c = this.camera, dx = this.shakeX / c.zoom, dy = this.shakeY / c.zoom;
    out.x = c.x - this._cos * dx + this._sin * dy;
    out.y = c.y - this._sin * dx - this._cos * dy;
    out.zoom = c.zoom;
    out.rotation = c.rotation;
    return out;
  }
  applyToRenderer(renderer, resize = false) {
    if (resize) renderer.resize(this.width, this.height, this.dpr);
    renderer.setCamera(this.rendererCameraInto(this._render));
    return this;
  }
  planeToScreenInto(x, y, out) {
    finite(x, "x");
    finite(y, "y");
    const dx = x - this.camera.x, dy = y - this.camera.y;
    out.x = (this._cos * dx + this._sin * dy) * this.camera.zoom + this.width / 2 + this.shakeX;
    out.y = (-this._sin * dx + this._cos * dy) * this.camera.zoom + this.height / 2 + this.shakeY;
    return out;
  }
  screenToPlaneInto(x, y, out) {
    finite(x, "x");
    finite(y, "y");
    const dx = (x - this.width / 2 - this.shakeX) / this.camera.zoom, dy = (y - this.height / 2 - this.shakeY) / this.camera.zoom;
    out.x = this._cos * dx - this._sin * dy + this.camera.x;
    out.y = this._sin * dx + this._cos * dy + this.camera.y;
    return out;
  }
  worldToScreenInto(x, y, z, out) {
    this.projection.projectInto(x, y, z, this._point);
    return this.planeToScreenInto(this._point.x, this._point.y, out);
  }
  clientToScreenInto(x, y, out) {
    out.x = finite(x, "x") - this.left;
    out.y = finite(y, "y") - this.top;
    return out;
  }
  screenToClientInto(x, y, out) {
    out.x = finite(x, "x") + this.left;
    out.y = finite(y, "y") + this.top;
    return out;
  }
  screenToBackingInto(x, y, out) {
    out.x = finite(x, "x") * Math.max(1, Math.round(this.width * this.dpr)) / this.width;
    out.y = finite(y, "y") * Math.max(1, Math.round(this.height * this.dpr)) / this.height;
    return out;
  }
  /** Exact flat inverse, or caller terrain intersection hook (returns boolean). No hidden iterative solver. */
  screenToGroundInto(x, y, out, { z = 0, intersect = null } = {}) {
    this.screenToPlaneInto(x, y, this._point);
    if (intersect !== null) {
      if (typeof intersect !== "function") throw new TypeError("intersect must be a function");
      return intersect(this._point.x, this._point.y, this.projection, out);
    }
    this.projection.groundInto(this._point.x, this._point.y, out, z);
    return true;
  }
};
export {
  CameraViewport,
  OrthographicProjection
};
