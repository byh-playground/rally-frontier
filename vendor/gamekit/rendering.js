// packages/rendering/src/device.js
var FUNCTIONS = Object.freeze({ never: "NEVER", less: "LESS", equal: "EQUAL", lequal: "LEQUAL", greater: "GREATER", notequal: "NOTEQUAL", gequal: "GEQUAL", always: "ALWAYS" });
var OPERATIONS = Object.freeze({ keep: "KEEP", zero: "ZERO", replace: "REPLACE", increment: "INCR", decrement: "DECR", invert: "INVERT", "increment-wrap": "INCR_WRAP", "decrement-wrap": "DECR_WRAP" });
var UNIFORMS = /* @__PURE__ */ new Set(["1f", "2f", "3f", "4f", "1i", "2i", "3i", "4i", "1iv", "1fv", "2fv", "3fv", "4fv", "matrix3fv", "matrix4fv"]);
var BLENDS = /* @__PURE__ */ new Set(["source-over", "straight-alpha", "copy", "lighter", "source-in", "destination-in"]);
var ALL_COLOR = Object.freeze([true, true, true, true]);
function integer(n, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new RangeError(`${name}: ${min}..${max}`);
}
function finiteArray(value, count, name) {
  if (!value || value.length !== count || !Array.from(value).every(Number.isFinite)) throw new TypeError(`${name} needs ${count} finite numbers`);
}
function compile(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compilation failed: ${message}`);
  }
  return shader;
}
var WebGLDevice = class {
  constructor(canvas, {
    alpha = false,
    antialias = true,
    depth = true,
    stencil = true,
    preserveDrawingBuffer = false,
    powerPreference = "default",
    failIfMajorPerformanceCaveat = false,
    checkGLErrors = false,
    maxTextures = 8,
    maxBufferBytes = 128 * 1024 * 1024
  } = {}) {
    if (!canvas?.getContext || !canvas?.addEventListener) throw new TypeError("canvas required");
    if (!["default", "low-power", "high-performance"].includes(powerPreference)) throw new TypeError("Invalid WebGL powerPreference");
    if (typeof failIfMajorPerformanceCaveat !== "boolean") throw new TypeError("failIfMajorPerformanceCaveat must be boolean");
    if (typeof checkGLErrors !== "boolean") throw new TypeError("checkGLErrors must be boolean");
    this.checkGLErrors = checkGLErrors;
    integer(maxTextures, "maxTextures", 1, 32);
    integer(maxBufferBytes, "maxBufferBytes", 4);
    this.canvas = canvas;
    this.maxBufferBytes = maxBufferBytes;
    this.gl = canvas.getContext("webgl", { alpha, antialias, depth, stencil, premultipliedAlpha: true, preserveDrawingBuffer, powerPreference, failIfMajorPerformanceCaveat });
    if (!this.gl) throw new Error("WebGL 1 required");
    this.maxTextures = Math.min(maxTextures, this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS));
    this.maxTextureSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    this.depthAvailable = !!this.gl.getContextAttributes().depth;
    this.stencilAvailable = !!this.gl.getContextAttributes().stencil;
    this.state = "ready";
    this.failure = null;
    this.active = false;
    this.boundTextureCount = 0;
    this.pipelines = /* @__PURE__ */ new Map();
    this.buffers = /* @__PURE__ */ new Map();
    this.textures = /* @__PURE__ */ new Map();
    this.enabledAttributes = /* @__PURE__ */ new Set();
    this.stats = {
      frame: 0,
      drawCalls: 0,
      vertices: 0,
      bufferUploads: 0,
      bufferBytes: 0,
      textureUploads: 0,
      textureBytes: 0,
      frameCopies: 0,
      bufferAllocations: 0,
      gpuBufferBytes: 0,
      pipelineCount: 0,
      bufferCount: 0,
      textureCount: 0,
      restores: 0
    };
    this.onLost = (event) => {
      event.preventDefault();
      this.active = false;
      this.state = "lost";
    };
    this.onRestored = () => {
      if (this.state === "disposed") return;
      try {
        this.enabledAttributes.clear();
        this.boundTextureCount = 0;
        for (const record of this.pipelines.values()) this._pipeline(record);
        for (const record of this.buffers.values()) {
          record.gpu = this.gl.createBuffer();
          if (!record.gpu) throw new Error("Buffer allocation failed");
          this.gl.bindBuffer(this.gl.ARRAY_BUFFER, record.gpu);
          this.gl.bufferData(this.gl.ARRAY_BUFFER, record.capacity, this.gl.DYNAMIC_DRAW);
          record.used = 0;
          this.stats.bufferAllocations++;
        }
        for (const record of this.textures.values()) {
          record.gpu = null;
          this._texture(record);
        }
        this.state = "ready";
        this.failure = null;
        this.stats.restores++;
      } catch (error) {
        this.state = "failed";
        this.failure = error.message;
        this._deleteGPU();
      }
    };
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
  }
  _ready() {
    if (this.state !== "ready") throw new Error(`WebGLDevice is ${this.state}${this.failure ? `: ${this.failure}` : ""}`);
  }
  _handle(map, handle, name) {
    const record = map.get(handle);
    if (!record) throw new Error(`Unknown/deleted ${name}`);
    return record;
  }
  _pipeline(record) {
    const gl = this.gl;
    let vertex, fragment, program;
    try {
      vertex = compile(gl, gl.VERTEX_SHADER, record.vertex);
      fragment = compile(gl, gl.FRAGMENT_SHADER, record.fragment);
      program = gl.createProgram();
      if (!program) throw new Error("Program allocation failed");
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
      record.locations = record.attributes.map((attribute) => ({ ...attribute, location: gl.getAttribLocation(program, attribute.name) }));
      record.uniformLocations = /* @__PURE__ */ new Map();
      for (const name of Object.keys(record.uniforms)) record.uniformLocations.set(name, gl.getUniformLocation(program, name));
      record.gpu = program;
    } catch (error) {
      if (program) gl.deleteProgram(program);
      throw error;
    } finally {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
    }
  }
  /** Attributes use interleaved FLOAT components, byte offsets and byte stride. */
  createPipeline({ vertex, fragment, stride, attributes, uniforms = {} }) {
    this._ready();
    if (typeof vertex !== "string" || typeof fragment !== "string") throw new TypeError("Shader sources required");
    integer(stride, "stride", 4, 255);
    if (stride % 4) throw new RangeError("stride must align to FLOAT");
    if (!Array.isArray(attributes) || !attributes.length) throw new TypeError("attributes required");
    const names = /* @__PURE__ */ new Set();
    for (const a of attributes) {
      if (typeof a.name !== "string" || !a.name || names.has(a.name)) throw new TypeError("Unique attribute names required");
      names.add(a.name);
      integer(a.size, "attribute size", 1, 4);
      integer(a.offset, "attribute offset", 0, stride - 4);
      if (a.offset % 4 || a.offset + a.size * 4 > stride) throw new RangeError("attribute outside stride");
    }
    if (!uniforms || typeof uniforms !== "object") throw new TypeError("uniform descriptors required");
    for (const type of Object.values(uniforms)) if (!UNIFORMS.has(type)) throw new TypeError(`Unsupported uniform ${type}`);
    const record = { vertex, fragment, stride, attributes: attributes.map((a) => ({ ...a })), uniforms: { ...uniforms }, gpu: null };
    this._pipeline(record);
    const handle = Object.freeze({ stride });
    this.pipelines.set(handle, record);
    this.stats.pipelineCount = this.pipelines.size;
    return handle;
  }
  deletePipeline(handle) {
    const r = this.pipelines.get(handle);
    if (!r) return false;
    this.gl.useProgram(null);
    this.gl.deleteProgram(r.gpu);
    this.pipelines.delete(handle);
    this.stats.pipelineCount = this.pipelines.size;
    return true;
  }
  createVertexBuffer({ capacityBytes = 0 } = {}) {
    this._ready();
    integer(capacityBytes, "capacityBytes", 0, this.maxBufferBytes);
    if (capacityBytes % 4) throw new RangeError("capacityBytes must align to FLOAT");
    const gl = this.gl, gpu = gl.createBuffer();
    if (!gpu) throw new Error("Buffer allocation failed");
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu);
    gl.bufferData(gl.ARRAY_BUFFER, capacityBytes, gl.DYNAMIC_DRAW);
    const handle = Object.freeze({});
    this.buffers.set(handle, { gpu, capacity: capacityBytes, used: 0 });
    this.stats.bufferAllocations++;
    this.stats.gpuBufferBytes += capacityBytes;
    this.stats.bufferCount = this.buffers.size;
    return handle;
  }
  /** View is uploaded synchronously, never copied into another CPU arena or retained. */
  uploadVertices(handle, data) {
    this._ready();
    const r = this._handle(this.buffers, handle, "buffer");
    if (!(data instanceof Float32Array)) throw new TypeError("Float32Array required");
    if (data.byteLength > this.maxBufferBytes) throw new RangeError("Stream exceeds maxBufferBytes");
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, r.gpu);
    if (data.byteLength > r.capacity) {
      let capacity = Math.max(4, r.capacity);
      while (capacity < data.byteLength) capacity = Math.min(this.maxBufferBytes, capacity * 2);
      gl.bufferData(gl.ARRAY_BUFFER, capacity, gl.DYNAMIC_DRAW);
      this.stats.gpuBufferBytes += capacity - r.capacity;
      r.capacity = capacity;
      this.stats.bufferAllocations++;
    }
    if (data.byteLength) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      this.stats.bufferUploads++;
      this.stats.bufferBytes += data.byteLength;
    }
    r.used = data.byteLength;
  }
  deleteVertexBuffer(handle) {
    const r = this.buffers.get(handle);
    if (!r) return false;
    this.gl.deleteBuffer(r.gpu);
    this.buffers.delete(handle);
    this.stats.gpuBufferBytes -= r.capacity;
    this.stats.bufferCount = this.buffers.size;
    return true;
  }
  _source(source, format, premultiplied) {
    if (source === this.canvas) throw new TypeError("Use copyFrameToTexture for GPU frame composition, not canvas upload");
    if (typeof premultiplied !== "boolean") throw new TypeError("premultiplied must be boolean");
    if (Object.prototype.toString.call(source) === "[object ImageBitmap]") throw new TypeError("ImageBitmap alpha mode is not inspectable");
    const width = source?.naturalWidth ?? source?.width, height = source?.naturalHeight ?? source?.height;
    integer(width, "texture width", 1, this.maxTextureSize);
    integer(height, "texture height", 1, this.maxTextureSize);
    if (format !== "rgba" && format !== "luminance") throw new TypeError("texture format must be rgba or luminance");
    let retained = source;
    if (source.data !== void 0) {
      const data = source.data, components = format === "rgba" ? 4 : 1;
      if (data !== null && (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height * components)) throw new TypeError("Texture byte count does not match dimensions/format");
      retained = data === null ? null : new Uint8Array(data);
      if (retained && format === "rgba" && !premultiplied) for (let i = 0; i < retained.length; i += 4) {
        const alpha = retained[i + 3] / 255;
        retained[i] = Math.round(retained[i] * alpha);
        retained[i + 1] = Math.round(retained[i + 1] * alpha);
        retained[i + 2] = Math.round(retained[i + 2] * alpha);
      }
    } else if (format !== "rgba" || premultiplied) throw new TypeError("DOM sources require rgba and premultiplied:false");
    return { source: retained, width, height, format, premultiplied };
  }
  _texture(record) {
    const gl = this.gl;
    record.gpu = gl.createTexture();
    if (!record.gpu) throw new Error("Texture allocation failed");
    try {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, record.gpu);
      this.boundTextureCount = Math.max(1, this.boundTextureCount);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      const pixels = record.source === null || record.source instanceof Uint8Array, format = record.copyFormat === "rgb" ? gl.RGB : record.format === "rgba" ? gl.RGBA : gl.LUMINANCE;
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !pixels);
      if (pixels) gl.texImage2D(gl.TEXTURE_2D, 0, format, record.width, record.height, 0, format, gl.UNSIGNED_BYTE, record.source);
      else gl.texImage2D(gl.TEXTURE_2D, 0, format, format, gl.UNSIGNED_BYTE, record.source);
      this._filter(record.filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`Texture upload error ${error}`);
      this.stats.textureUploads++;
      this.stats.textureBytes += record.width * record.height * (record.format === "rgba" ? 4 : 1);
    } catch (error) {
      gl.deleteTexture(record.gpu);
      record.gpu = null;
      throw error;
    }
  }
  _filter(filter) {
    if (filter !== "nearest" && filter !== "linear") throw new TypeError("filter must be nearest or linear");
    const gl = this.gl, value = filter === "nearest" ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, value);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, value);
  }
  createTexture(source, { format = "rgba", premultiplied = false, filter = "linear" } = {}) {
    this._ready();
    if (filter !== "nearest" && filter !== "linear") throw new TypeError("Invalid filter");
    const record = { ...this._source(source, format, premultiplied), filter, gpu: null };
    this._texture(record);
    const handle = Object.freeze({ width: record.width, height: record.height });
    this.textures.set(handle, record);
    this.stats.textureCount = this.textures.size;
    return handle;
  }
  /** Full source remains restoration authority; region describes only bytes changed since prior upload. */
  updateTexture(handle, source, { x = 0, y = 0, width = handle.width, height = handle.height } = {}) {
    this._ready();
    const r = this._handle(this.textures, handle, "texture");
    integer(x, "x");
    integer(y, "y");
    integer(width, "width", 1);
    integer(height, "height", 1);
    if (x + width > r.width || y + height > r.height) throw new RangeError("Texture region outside bounds");
    const next = this._source(source, r.format, r.premultiplied);
    if (next.width !== r.width || next.height !== r.height || next.source === null) throw new RangeError("Update requires matching full source");
    if (r.copyFormat) {
      const replacement = { ...next, filter: r.filter, gpu: null };
      this._texture(replacement);
      this.gl.deleteTexture(r.gpu);
      Object.assign(r, replacement);
      delete r.copyFormat;
      return;
    }
    const gl = this.gl, format = r.format === "rgba" ? gl.RGBA : gl.LUMINANCE;
    let pixels = next.source;
    if (pixels instanceof Uint8Array) {
      const components = r.format === "rgba" ? 4 : 1;
      if (x || y || width !== r.width || height !== r.height) {
        const needed = width * height * components;
        if (!this.regionBytes || this.regionBytes.length !== needed) this.regionBytes = new Uint8Array(needed);
        for (let row = 0; row < height; row++) {
          const start = ((y + row) * r.width + x) * components;
          this.regionBytes.set(pixels.subarray(start, start + width * components), row * width * components);
        }
        pixels = this.regionBytes;
      }
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    } else {
      if (x || y || width !== r.width || height !== r.height) {
        if (!this.regionCanvas) {
          const doc = this.canvas.ownerDocument;
          if (!doc?.createElement) throw new Error("DOM region uploads require canvas.ownerDocument");
          this.regionCanvas = doc.createElement("canvas");
          this.regionContext = this.regionCanvas.getContext("2d");
          if (!this.regionContext) throw new Error("Asset-region Canvas2D unavailable");
        }
        const c = this.regionCanvas, q = this.regionContext;
        if (c.width !== width || c.height !== height) {
          c.width = width;
          c.height = height;
        } else q.clearRect(0, 0, width, height);
        q.drawImage(next.source, x, y, width, height, 0, 0, width, height);
        pixels = c;
      }
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, r.gpu);
    this.boundTextureCount = Math.max(1, this.boundTextureCount);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (pixels instanceof Uint8Array) gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, format, gl.UNSIGNED_BYTE, pixels);
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, format, gl.UNSIGNED_BYTE, pixels);
    if (this.checkGLErrors) {
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`Texture update error ${error}`);
    }
    r.source = next.source;
    this.stats.textureUploads++;
    this.stats.textureBytes += width * height * (r.format === "rgba" ? 4 : 1);
  }
  /** Copies the resolved framebuffer on-GPU. Recopy after restore; pixels are not CPU-retained. */
  copyFrameToTexture(handle, { x = 0, y = 0 } = {}) {
    this._ready();
    const r = this._handle(this.textures, handle, "texture");
    integer(x, "x");
    integer(y, "y");
    if (r.format !== "rgba" || x + r.width > this.canvas.width || y + r.height > this.canvas.height) throw new RangeError("Framebuffer copy outside bounds");
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, r.gpu);
    this.boundTextureCount = Math.max(1, this.boundTextureCount);
    let allocated = false;
    if (!gl.getContextAttributes().alpha && r.copyFormat !== "rgb") {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, r.width, r.height, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
      r.copyFormat = "rgb";
      allocated = true;
      this.stats.textureUploads++;
      this.stats.textureBytes += r.width * r.height * 3;
    }
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, x, y, r.width, r.height);
    if (allocated || this.checkGLErrors) {
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`Framebuffer copy error ${error}`);
    }
    r.source = null;
    this.stats.frameCopies++;
  }
  deleteTexture(handle) {
    const r = this.textures.get(handle);
    if (!r) return false;
    this.gl.deleteTexture(r.gpu);
    this.textures.delete(handle);
    this.stats.textureCount = this.textures.size;
    return true;
  }
  beginFrame({ width = this.canvas.width, height = this.canvas.height, clearColor = [0, 0, 0, 0], clearDepth = 1, clearStencil = 0 } = {}) {
    if (this.state === "lost") return false;
    this._ready();
    if (this.active) throw new Error("endFrame required");
    integer(width, "width", 1);
    integer(height, "height", 1);
    const gl = this.gl, limit = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    if (width > limit[0] || height > limit[1]) throw new RangeError("Viewport exceeds WebGL limit");
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    gl.viewport(0, 0, width, height);
    this.stats.frame++;
    for (const name of ["drawCalls", "vertices", "bufferUploads", "bufferBytes", "textureUploads", "textureBytes", "frameCopies"]) this.stats[name] = 0;
    this.active = true;
    this.clear({ color: clearColor, depth: clearDepth, stencil: clearStencil });
    return true;
  }
  clear({ color: color2, depth, stencil } = {}) {
    this._ready();
    const gl = this.gl;
    let flags = 0;
    if (color2 !== void 0) {
      finiteArray(color2, 4, "clear color");
      gl.colorMask(true, true, true, true);
      gl.clearColor(...color2);
      flags |= gl.COLOR_BUFFER_BIT;
    }
    if (depth !== void 0) {
      if (!Number.isFinite(depth) || depth < 0 || depth > 1) throw new RangeError("clear depth 0..1");
      gl.depthMask(true);
      gl.clearDepth(depth);
      flags |= gl.DEPTH_BUFFER_BIT;
    }
    if (stencil !== void 0) {
      integer(stencil, "clear stencil", 0, 255);
      gl.stencilMask(255);
      gl.clearStencil(stencil);
      flags |= gl.STENCIL_BUFFER_BIT;
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.clear(flags);
  }
  /** Full pass state is explicit per draw; no state leakage between game materials. */
  draw({ pipeline, buffer, first = 0, count, uniforms = {}, textures = [], blend = "source-over", depth = false, stencil = false, colorMask = ALL_COLOR, filter } = {}) {
    this._ready();
    if (!this.active) throw new Error("beginFrame required");
    const p = this._handle(this.pipelines, pipeline, "pipeline"), b = this._handle(this.buffers, buffer, "buffer");
    integer(first, "first");
    integer(count, "count");
    if (first + count > b.used / p.stride) throw new RangeError("draw exceeds uploaded vertices");
    if (depth && !this.depthAvailable) throw new Error("Context has no depth buffer");
    if (stencil && !this.stencilAvailable) throw new Error("Context has no stencil buffer");
    if (blend !== false && !BLENDS.has(blend)) throw new TypeError("Unsupported blend");
    if (depth && !FUNCTIONS[depth.func ?? "lequal"]) throw new TypeError("Unsupported depth function");
    if (stencil) {
      if (!FUNCTIONS[stencil.func ?? "always"]) throw new TypeError("Unsupported stencil function");
      for (const key of ["fail", "zfail", "pass"]) if (!OPERATIONS[stencil[key] ?? "keep"]) throw new TypeError("Unsupported stencil operation");
      for (const key of ["ref", "mask", "writeMask"]) integer(stencil[key] ?? (key === "ref" ? 0 : 255), key, 0, 255);
    }
    if (!colorMask || colorMask.length !== 4 || !Array.from(colorMask).every((v) => typeof v === "boolean")) throw new TypeError("colorMask must contain booleans");
    if (!Array.isArray(textures) || textures.length > this.maxTextures) throw new RangeError("Too many textures");
    for (const handle of textures) this._handle(this.textures, handle, "texture");
    if (filter !== void 0 && filter !== "nearest" && filter !== "linear") throw new TypeError("Unsupported filter");
    const gl = this.gl;
    gl.useProgram(p.gpu);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.gpu);
    for (const index of this.enabledAttributes) gl.disableVertexAttribArray(index);
    this.enabledAttributes.clear();
    for (const a of p.locations) if (a.location >= 0) {
      gl.enableVertexAttribArray(a.location);
      gl.vertexAttribPointer(a.location, a.size, gl.FLOAT, false, p.stride, a.offset);
      this.enabledAttributes.add(a.location);
    }
    for (const [name, value] of Object.entries(uniforms)) {
      const type = p.uniforms[name];
      if (!type) throw new TypeError(`Undeclared uniform ${name}`);
      const location = p.uniformLocations.get(name);
      if (location === null) continue;
      if (type.startsWith("matrix")) gl[`uniformMatrix${type[6]}fv`](location, false, value);
      else if (type.endsWith("v")) gl[`uniform${type}`](location, value);
      else if (type[0] === "1") gl[`uniform${type}`](location, value);
      else gl[`uniform${type}`](location, ...value);
    }
    const textureUnits = Math.max(this.boundTextureCount, textures.length);
    for (let i = 0; i < textureUnits; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      const r = i < textures.length ? this.textures.get(textures[i]) : null;
      gl.bindTexture(gl.TEXTURE_2D, r?.gpu ?? null);
      if (r) this._filter(filter ?? r.filter);
    }
    if (textureUnits) gl.activeTexture(gl.TEXTURE0);
    this.boundTextureCount = textures.length;
    if (blend === false) gl.disable(gl.BLEND);
    else {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      const factors = blend === "source-over" ? [gl.ONE, gl.ONE_MINUS_SRC_ALPHA] : blend === "straight-alpha" ? [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA] : blend === "copy" ? [gl.ONE, gl.ZERO] : blend === "lighter" ? [gl.ONE, gl.ONE] : blend === "source-in" ? [gl.DST_ALPHA, gl.ZERO] : [gl.ZERO, gl.SRC_ALPHA];
      gl.blendFunc(...factors);
    }
    if (depth) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl[FUNCTIONS[depth.func ?? "lequal"]]);
      gl.depthMask(depth.write ?? true);
    } else {
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
    }
    if (stencil) {
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl[FUNCTIONS[stencil.func ?? "always"]], stencil.ref ?? 0, stencil.mask ?? 255);
      gl.stencilMask(stencil.writeMask ?? 255);
      gl.stencilOp(gl[OPERATIONS[stencil.fail ?? "keep"]], gl[OPERATIONS[stencil.zfail ?? "keep"]], gl[OPERATIONS[stencil.pass ?? "keep"]]);
    } else gl.disable(gl.STENCIL_TEST);
    gl.colorMask(...colorMask);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
    gl.disable(gl.SCISSOR_TEST);
    gl.drawArrays(gl.TRIANGLES, first, count);
    this.stats.drawCalls++;
    this.stats.vertices += count;
  }
  endFrame() {
    this._ready();
    if (!this.active) throw new Error("beginFrame required");
    this.active = false;
    return this.stats;
  }
  _deleteGPU() {
    const gl = this.gl;
    gl.useProgram(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    for (let i = 0; i < this.maxTextures; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);
    for (const r of this.pipelines.values()) gl.deleteProgram(r.gpu);
    for (const r of this.buffers.values()) gl.deleteBuffer(r.gpu);
    for (const r of this.textures.values()) gl.deleteTexture(r.gpu);
  }
  dispose() {
    if (this.state === "disposed") return;
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    this._deleteGPU();
    this.pipelines.clear();
    this.buffers.clear();
    this.textures.clear();
    this.enabledAttributes.clear();
    this.regionCanvas = this.regionContext = this.regionBytes = null;
    this.stats.pipelineCount = this.stats.bufferCount = this.stats.textureCount = this.stats.gpuBufferBytes = 0;
    this.active = false;
    this.state = "disposed";
  }
};

// packages/rendering/src/index.js
var WHITE = Object.freeze([1, 1, 1, 1]);
var CLEAR = Object.freeze([0, 0, 0, 0]);
var VERTEX = `
attribute vec2 a_position;
attribute vec2 a_uv;
attribute vec4 a_color;
uniform mat3 u_projection;
varying vec2 v_uv;
varying vec4 v_color;
void main() {
  vec3 p = u_projection * vec3(a_position, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  v_uv = a_uv; v_color = a_color;
}`;
var FRAGMENT = `
precision mediump float;
uniform sampler2D u_texture;
varying vec2 v_uv;
varying vec4 v_color;
void main() {
  vec4 t = texture2D(u_texture, v_uv);
  float alpha = t.a * v_color.a;
  gl_FragColor = vec4(t.rgb * v_color.rgb * v_color.a, alpha);
}`;
function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
}
function positive(value, name) {
  finite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}
function color(value) {
  if (!value || value.length !== 4) throw new TypeError("color must be [r,g,b,a]");
  for (let i = 0; i < 4; i++) if (!Number.isFinite(value[i]) || value[i] < 0 || value[i] > 1) throw new RangeError("color channels must be in [0,1]");
}
function compile2(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL shader: ${message}`);
  }
  return shader;
}
var Renderer2D = class {
  constructor(canvas, { batchVertices = 6144, antialias = true, preserveDrawingBuffer = false } = {}) {
    if (!canvas?.getContext || !canvas?.addEventListener) throw new TypeError("canvas is required");
    if (!Number.isSafeInteger(batchVertices) || batchVertices < 6 || batchVertices > 1048576) throw new RangeError("batchVertices must be 6..1048576");
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias, depth: false, stencil: false, preserveDrawingBuffer });
    if (!this.gl) throw new Error("WebGL 1 is required; no Canvas2D fallback");
    this.state = "ready";
    this.failure = null;
    this.active = false;
    this.vertices = new Float32Array(batchVertices * 8);
    this.vertexCount = 0;
    this.projection = new Float32Array(9);
    this.textures = /* @__PURE__ */ new Map();
    this.width = canvas.width || 1;
    this.height = canvas.height || 1;
    this.dpr = 1;
    this.camera = { x: this.width / 2, y: this.height / 2, zoom: 1, rotation: 0 };
    this.stats = {
      backend: "webgl1",
      frame: 0,
      drawCalls: 0,
      vertices: 0,
      uploadedBytes: 0,
      bufferViews: 0,
      textureUploads: 0,
      totalTextureUploads: 0,
      textureCount: 0,
      stagingBytes: this.vertices.byteLength,
      bufferAllocations: 0
    };
    this.onLost = (event) => {
      event.preventDefault();
      this.state = "lost";
      this.active = false;
      this.vertexCount = 0;
      this.batchTexture = null;
    };
    this.onRestored = () => {
      if (this.state === "disposed") return;
      try {
        this._initialize();
        this.state = "ready";
        this.failure = null;
      } catch (error) {
        this.state = "failed";
        this.failure = error.message;
        this._deleteGPU();
      }
    };
    try {
      this._initialize();
    } catch (error) {
      this._deleteGPU();
      this.state = "failed";
      throw error;
    }
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
  }
  _ready() {
    if (this.state !== "ready") throw new Error(`Renderer is ${this.state}${this.failure ? `: ${this.failure}` : ""}`);
  }
  _frame() {
    this._ready();
    if (!this.active) throw new Error("beginFrame is required");
  }
  _initialize() {
    const gl = this.gl;
    let vertex, fragment;
    try {
      vertex = compile2(gl, gl.VERTEX_SHADER, VERTEX);
      fragment = compile2(gl, gl.FRAGMENT_SHADER, FRAGMENT);
      this.program = gl.createProgram();
      if (!this.program) throw new Error("WebGL program allocation failed");
      gl.attachShader(this.program, vertex);
      gl.attachShader(this.program, fragment);
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(`WebGL link: ${gl.getProgramInfoLog(this.program)}`);
    } finally {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
    }
    this.buffer = gl.createBuffer();
    if (!this.buffer) throw new Error("WebGL buffer allocation failed");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);
    this.stats.bufferAllocations++;
    gl.useProgram(this.program);
    for (const [name, size, offset] of [["a_position", 2, 0], ["a_uv", 2, 8], ["a_color", 4, 16]]) {
      const location = gl.getAttribLocation(this.program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 32, offset);
    }
    this.uProjection = gl.getUniformLocation(this.program, "u_projection");
    gl.uniform1i(gl.getUniformLocation(this.program, "u_texture"), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    this.white = { width: 1, height: 1, source: new Uint8Array([255, 255, 255, 255]), filter: "nearest", texture: null };
    this._upload(this.white);
    for (const record of this.textures.values()) {
      record.texture = null;
      this._upload(record);
    }
    this.batchTexture = null;
    this.vertexCount = 0;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this._projection();
  }
  _projection() {
    const { x, y, zoom, rotation } = this.camera;
    const c = Math.cos(rotation) * zoom, s = Math.sin(rotation) * zoom;
    const m = this.projection, w = this.width, h = this.height;
    m[0] = 2 * c / w;
    m[1] = 2 * s / h;
    m[2] = 0;
    m[3] = 2 * s / w;
    m[4] = -2 * c / h;
    m[5] = 0;
    m[6] = -2 * (c * x + s * y) / w;
    m[7] = 2 * (c * y - s * x) / h;
    m[8] = 1;
    this.gl.uniformMatrix3fv(this.uProjection, false, m);
  }
  /** CSS viewport dimensions; does not change CSS style. Game controls camera separately. */
  resize(width, height, dpr = 1) {
    this._ready();
    positive(width, "width");
    positive(height, "height");
    positive(dpr, "dpr");
    const pixelWidth = Math.max(1, Math.round(width * dpr)), pixelHeight = Math.max(1, Math.round(height * dpr));
    const limit = this.gl.getParameter(this.gl.MAX_VIEWPORT_DIMS);
    if (pixelWidth > limit[0] || pixelHeight > limit[1]) throw new RangeError("viewport exceeds WebGL limits");
    if (this.active) throw new Error("resize must be outside beginFrame/endFrame");
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    this.gl.viewport(0, 0, pixelWidth, pixelHeight);
    this._projection();
  }
  /** Camera center in world units; zoom is CSS pixels per world unit. */
  setCamera({ x = this.camera.x, y = this.camera.y, zoom = this.camera.zoom, rotation = this.camera.rotation } = {}) {
    this._ready();
    finite(x, "x");
    finite(y, "y");
    positive(zoom, "zoom");
    finite(rotation, "rotation");
    if (this.active) this.flush();
    this.camera.x = x;
    this.camera.y = y;
    this.camera.zoom = zoom;
    this.camera.rotation = rotation;
    this._projection();
  }
  /** Caller-owned output; no world/simulation state is read or changed. */
  worldToScreenInto(x, y, out) {
    finite(x, "x");
    finite(y, "y");
    const camera = this.camera;
    const c = Math.cos(camera.rotation), s = Math.sin(camera.rotation), dx = x - camera.x, dy = y - camera.y;
    out.x = (c * dx + s * dy) * camera.zoom + this.width / 2;
    out.y = (-s * dx + c * dy) * camera.zoom + this.height / 2;
    return out;
  }
  screenToWorldInto(x, y, out) {
    finite(x, "x");
    finite(y, "y");
    const camera = this.camera;
    const c = Math.cos(camera.rotation), s = Math.sin(camera.rotation), dx = (x - this.width / 2) / camera.zoom, dy = (y - this.height / 2) / camera.zoom;
    out.x = c * dx - s * dy + camera.x;
    out.y = s * dx + c * dy + camera.y;
    return out;
  }
  _source(source, filter) {
    if (filter !== "nearest" && filter !== "linear") throw new RangeError("filter must be nearest or linear");
    if (Object.prototype.toString.call(source) === "[object ImageBitmap]") throw new TypeError("ImageBitmap alpha mode cannot be inspected; use an image/canvas or RGBA bytes");
    const width = source?.naturalWidth ?? source?.videoWidth ?? source?.width;
    const height = source?.naturalHeight ?? source?.videoHeight ?? source?.height;
    const max = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > max || height > max) throw new RangeError("texture dimensions are invalid");
    let retained = source;
    if (source.data !== void 0) {
      if (!(source.data instanceof Uint8Array || source.data instanceof Uint8ClampedArray) || source.data.length !== width * height * 4) throw new TypeError("texture data must be width*height*4 RGBA bytes");
      retained = new Uint8Array(source.data);
      for (let i = 0; i < retained.length; i += 4) {
        const a = retained[i + 3] / 255;
        retained[i] = Math.round(retained[i] * a);
        retained[i + 1] = Math.round(retained[i + 1] * a);
        retained[i + 2] = Math.round(retained[i + 2] * a);
      }
    }
    return { width, height, source: retained, filter, texture: null };
  }
  _upload(record) {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error("WebGL texture allocation failed");
    record.texture = texture;
    try {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, !(record.source instanceof Uint8Array));
      if (record.source instanceof Uint8Array) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, record.width, record.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, record.source);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, record.source);
      const filter = record.filter === "linear" ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`WebGL texture upload error ${error}`);
      this.stats.textureUploads++;
      this.stats.totalTextureUploads++;
    } catch (error) {
      gl.deleteTexture(texture);
      record.texture = null;
      throw error;
    }
  }
  /** Loaded origin-clean image/canvas, or {width,height,data: RGBA bytes}. */
  createTexture(source, { filter = "linear" } = {}) {
    this._ready();
    const record = this._source(source, filter);
    if (this.active) this.flush();
    this._upload(record);
    const handle = Object.freeze({ width: record.width, height: record.height });
    this.textures.set(handle, record);
    this.stats.textureCount = this.textures.size;
    return handle;
  }
  /** Replacement dimensions must match the handle. Upload is explicit, never per sprite. */
  updateTexture(handle, source) {
    this._ready();
    const previous = this.textures.get(handle);
    if (!previous) throw new Error("unknown/deleted texture");
    const record = this._source(source, previous.filter);
    if (record.width !== handle.width || record.height !== handle.height) throw new RangeError("texture update dimensions must match");
    if (this.active) this.flush();
    this._upload(record);
    this.gl.deleteTexture(previous.texture);
    this.textures.set(handle, record);
  }
  deleteTexture(handle) {
    if (this.state === "disposed") return false;
    const record = this.textures.get(handle);
    if (!record) return false;
    if (this.active) this.flush();
    this.gl.deleteTexture(record.texture);
    this.textures.delete(handle);
    this.stats.textureCount = this.textures.size;
    return true;
  }
  /** Returns false while context is lost. Caller skips that frame; restore is automatic. */
  beginFrame(clear = CLEAR) {
    if (this.state === "lost") return false;
    this._ready();
    if (this.active) throw new Error("endFrame is required");
    color(clear);
    this.active = true;
    this.vertexCount = 0;
    this.batchTexture = null;
    const stats = this.stats;
    stats.frame++;
    stats.drawCalls = stats.vertices = stats.uploadedBytes = stats.bufferViews = stats.textureUploads = 0;
    const gl = this.gl;
    gl.clearColor(clear[0] * clear[3], clear[1] * clear[3], clear[2] * clear[3], clear[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return true;
  }
  _reserve(count, texture) {
    this._frame();
    if (this.batchTexture !== texture || this.vertexCount + count > this.vertices.length / 8) this.flush();
    this.batchTexture = texture;
  }
  _vertex(x, y, u, v, tint) {
    const data = this.vertices;
    let i = this.vertexCount++ * 8;
    data[i++] = x;
    data[i++] = y;
    data[i++] = u;
    data[i++] = v;
    data[i++] = tint[0];
    data[i++] = tint[1];
    data[i++] = tint[2];
    data[i] = tint[3];
  }
  triangle(x0, y0, x1, y1, x2, y2, tint = WHITE) {
    finite(x0, "x0");
    finite(y0, "y0");
    finite(x1, "x1");
    finite(y1, "y1");
    finite(x2, "x2");
    finite(y2, "y2");
    color(tint);
    this._reserve(3, this.white.texture);
    this._vertex(x0, y0, 0, 0, tint);
    this._vertex(x1, y1, 0, 0, tint);
    this._vertex(x2, y2, 0, 0, tint);
  }
  _quad(texture, x, y, width, height, angle, tint, u0, v0, u1, v1) {
    finite(x, "x");
    finite(y, "y");
    positive(width, "width");
    positive(height, "height");
    finite(angle, "angle");
    color(tint);
    this._reserve(6, texture);
    const c = Math.cos(angle), s = Math.sin(angle), hx = width / 2, hy = height / 2;
    const ax = x - c * hx + s * hy, ay = y - s * hx - c * hy;
    const bx = x + c * hx + s * hy, by = y + s * hx - c * hy;
    const cx = x + c * hx - s * hy, cy = y + s * hx + c * hy;
    const dx = x - c * hx - s * hy, dy = y - s * hx + c * hy;
    this._vertex(ax, ay, u0, v0, tint);
    this._vertex(bx, by, u1, v0, tint);
    this._vertex(cx, cy, u1, v1, tint);
    this._vertex(ax, ay, u0, v0, tint);
    this._vertex(cx, cy, u1, v1, tint);
    this._vertex(dx, dy, u0, v1, tint);
  }
  /** Center-anchored rectangle, positive size, clockwise rotation in y-down world. */
  rect(x, y, width, height, tint = WHITE, angle = 0) {
    this._quad(this.white.texture, x, y, width, height, angle, tint, 0, 0, 1, 1);
  }
  /** Atlas UV edges are top-left based; reversing endpoints flips the image. */
  sprite(texture, x, y, width = texture.width, height = texture.height, { angle = 0, tint = WHITE, u0 = 0, v0 = 0, u1 = 1, v1 = 1 } = {}) {
    const record = this.textures.get(texture);
    if (!record) throw new Error("unknown/deleted texture");
    if (!Number.isFinite(u0) || !Number.isFinite(v0) || !Number.isFinite(u1) || !Number.isFinite(v1) || Math.min(u0, v0, u1, v1) < 0 || Math.max(u0, v0, u1, v1) > 1) throw new RangeError("UV must be in [0,1]");
    this._quad(record.texture, x, y, width, height, angle, tint, u0, v0, u1, v1);
  }
  /** Bounded fan tessellation; game chooses quality. No path/tessellation engine. */
  ellipse(x, y, radiusX, radiusY, tint = WHITE, segments = 24) {
    finite(x, "x");
    finite(y, "y");
    positive(radiusX, "radiusX");
    positive(radiusY, "radiusY");
    color(tint);
    if (!Number.isSafeInteger(segments) || segments < 3 || segments > 256) throw new RangeError("segments must be 3..256");
    for (let i = 0; i < segments; i++) {
      const a = i / segments * Math.PI * 2, b = (i + 1) / segments * Math.PI * 2;
      this._reserve(3, this.white.texture);
      this._vertex(x, y, 0, 0, tint);
      this._vertex(x + Math.cos(a) * radiusX, y + Math.sin(a) * radiusY, 0, 0, tint);
      this._vertex(x + Math.cos(b) * radiusX, y + Math.sin(b) * radiusY, 0, 0, tint);
    }
  }
  line(x0, y0, x1, y1, width, tint = WHITE) {
    finite(x0, "x0");
    finite(y0, "y0");
    finite(x1, "x1");
    finite(y1, "y1");
    positive(width, "width");
    color(tint);
    this._frame();
    const length = Math.hypot(x1 - x0, y1 - y0);
    if (!length) return;
    this.rect((x0 + x1) / 2, (y0 + y1) / 2, length, width, tint, Math.atan2(y1 - y0, x1 - x0));
  }
  flush() {
    this._frame();
    if (!this.vertexCount) return;
    const gl = this.gl, view = this.vertices.subarray(0, this.vertexCount * 8);
    gl.bindTexture(gl.TEXTURE_2D, this.batchTexture);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, view);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
    this.stats.drawCalls++;
    this.stats.vertices += this.vertexCount;
    this.stats.uploadedBytes += view.byteLength;
    this.stats.bufferViews++;
    this.vertexCount = 0;
  }
  /** Stats is a reused object, valid until next frame; CPU submission, not GPU timing. */
  endFrame() {
    this.flush();
    this.active = false;
    this.batchTexture = null;
    return this.stats;
  }
  _deleteGPU() {
    const gl = this.gl;
    gl.useProgram(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    for (const record of this.textures.values()) if (record.texture) gl.deleteTexture(record.texture);
    if (this.white?.texture) gl.deleteTexture(this.white.texture);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.program) gl.deleteProgram(this.program);
  }
  /** Idempotent. Removes context listeners and releases retained sources/GPU resources. */
  dispose() {
    if (this.state === "disposed") return;
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    this._deleteGPU();
    this.textures.clear();
    this.white = null;
    this.buffer = this.program = null;
    this.stats.textureCount = 0;
    this.active = false;
    this.vertexCount = 0;
    this.state = "disposed";
  }
};
export {
  Renderer2D,
  WebGLDevice
};
