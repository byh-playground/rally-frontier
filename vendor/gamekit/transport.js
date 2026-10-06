// packages/deterministic/src/utilities.js
var nowMs = () => globalThis.performance?.now() ?? Date.now();
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
function hashBytes(value, seed = 2166136261) {
  let h = seed >>> 0;
  for (const b of bytes(value)) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h;
}
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

// packages/_rollback-shared/src/protocol.js
var PROTOCOL_VERSION = 1;
var CHUNK_SIZE = 16384;
var defaults = {
  mode: "rollback",
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
    mode: "lockstep",
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

// packages/transport/src/webrtc.js
var WebRTCTransport = class {
  constructor({ inputChannel, controlChannel, highWaterMark = 262144, lowWaterMark = 65536 } = {}) {
    if (!controlChannel || typeof controlChannel.send !== "function") throw new TypeError("controlChannel");
    integer(highWaterMark, "highWaterMark", CHUNK_SIZE, 16 * 1024 * 1024);
    integer(lowWaterMark, "lowWaterMark", 0, highWaterMark);
    this.inputChannel = inputChannel ?? controlChannel;
    this.controlChannel = controlChannel;
    this.highWaterMark = highWaterMark;
    this.listeners = /* @__PURE__ */ new Set();
    this.statusListeners = /* @__PURE__ */ new Set();
    this.closed = false;
    this.connectionState = "connected";
    this._lastStatus = null;
    this.channels = [.../* @__PURE__ */ new Set([this.inputChannel, this.controlChannel])];
    this._onMessage = async (event) => {
      if (this.closed) return;
      let data = event.data;
      if (typeof Blob !== "undefined" && data instanceof Blob) {
        if (data.size > CHUNK_SIZE) return;
        data = await data.arrayBuffer();
      }
      if (this.closed) return;
      try {
        const b = bytes(data);
        if (b.length > CHUNK_SIZE) return;
        for (const listener of this.listeners) listener(b.slice());
      } catch {
      }
    };
    for (const channel of this.channels) {
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = lowWaterMark;
      channel.addEventListener("message", this._onMessage);
      channel.addEventListener("open", this._onStatus = this._onStatus ?? (() => this._notifyStatus()));
      channel.addEventListener("close", this._onStatus);
      channel.addEventListener("error", this._onChannelError = this._onChannelError ?? (() => {
        this.connectionState = "failed";
        this._notifyStatus();
      }));
    }
  }
  get state() {
    if (this.closed || this.connectionState === "closed" || this.channels.some((c) => c.readyState === "closed" || c.readyState === "closing")) return "closed";
    if (this.connectionState === "failed") return "failed";
    if (this.connectionState === "disconnected") return "interrupted";
    return this.channels.every((c) => c.readyState === "open") ? "open" : "connecting";
  }
  _notifyStatus() {
    const state = this.state;
    if (state === this._lastStatus) return;
    this._lastStatus = state;
    for (const listener of this.statusListeners) {
      try {
        listener(state);
      } catch {
      }
    }
  }
  setConnectionState(state) {
    this.connectionState = state;
    this._notifyStatus();
  }
  subscribeStatus(listener) {
    if (typeof listener !== "function") throw new TypeError("status subscriber");
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  get bufferedAmount() {
    return this.channels.reduce((n, c) => n + c.bufferedAmount, 0);
  }
  send(data) {
    const b = bytes(data);
    if (b.length > CHUNK_SIZE) throw new RangeError("DataChannel chunk size");
    const type = b.length >= HEADER ? b[5] : 0;
    const channel = type === TYPE.INPUT || type === TYPE.CLOCK ? this.inputChannel : this.controlChannel;
    if (this.closed || channel.readyState !== "open" || this.bufferedAmount + b.length > this.highWaterMark) return false;
    try {
      channel.send(b);
      return true;
    } catch (error) {
      if (error.name === "OperationError" || error.name === "InvalidStateError") return false;
      throw error;
    }
  }
  subscribe(handler) {
    if (this.closed || typeof handler !== "function") throw new TypeError("transport subscriber");
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this._notifyStatus();
    for (const channel of this.channels) {
      channel.removeEventListener("message", this._onMessage);
      channel.removeEventListener("open", this._onStatus);
      channel.removeEventListener("close", this._onStatus);
      channel.removeEventListener("error", this._onChannelError);
      channel.close();
    }
    this.listeners.clear();
    this.statusListeners.clear();
  }
};
var DEFAULT_ICE = Object.freeze([{ urls: "stun:stun.l.google.com:19302" }]);
function createWebRTCPeer({
  initiator = false,
  signaler,
  remoteId,
  rtcConfig = { iceServers: DEFAULT_ICE },
  timeoutMs = 2e4,
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  onStatus = () => {
  },
  signal
} = {}) {
  if (signal?.aborted) return Promise.reject(new Error("connection aborted"));
  if (typeof RTCPeerConnectionImpl !== "function" || typeof signaler?.send !== "function" || typeof signaler.subscribe !== "function" || !remoteId) return Promise.reject(new TypeError("WebRTC and Signaler capabilities required"));
  let pc;
  try {
    integer(timeoutMs, "timeoutMs", 1, 12e4);
    pc = new RTCPeerConnectionImpl(rtcConfig);
  } catch (error) {
    return Promise.reject(error);
  }
  let inputChannel, controlChannel, transport, unsubscribe, timer, disposed = false, settled = false;
  let chain = Promise.resolve();
  const earlyIce = [], iceBatch = [];
  let iceTimer;
  const status = (value) => {
    try {
      onStatus(value);
    } catch {
    }
  };
  let resolve, reject;
  const result = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const close = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    clearTimeout(iceTimer);
    unsubscribe?.();
    signal?.removeEventListener("abort", close);
    transport?.close();
    pc.close();
    if (!settled) {
      settled = true;
      reject(new Error("WebRTC connection closed"));
    }
  };
  const fail = (error) => {
    status({ type: "connection-error", error });
    if (!settled) {
      settled = true;
      reject(error);
    }
    close();
  };
  signal?.addEventListener("abort", close, { once: true });
  const send = (message) => Promise.resolve(signaler.send(remoteId, message));
  const maybeReady = () => {
    if (disposed || settled || inputChannel?.readyState !== "open" || controlChannel?.readyState !== "open") return;
    clearTimeout(timer);
    settled = true;
    transport = new WebRTCTransport({ inputChannel, controlChannel });
    status({ type: "connected" });
    resolve({ transport, peerConnection: pc, close });
  };
  const channel = (value) => {
    if (value.label === "inputs" && !inputChannel) inputChannel = value;
    else if (value.label === "control" && !controlChannel) controlChannel = value;
    else {
      value.close();
      return;
    }
    value.addEventListener("open", maybeReady);
    maybeReady();
  };
  pc.addEventListener("datachannel", (event) => channel(event.channel));
  const flushCandidates = () => {
    clearTimeout(iceTimer);
    if (disposed || !iceBatch.length) return;
    send({ type: "ice", candidates: iceBatch.splice(0) }).catch(fail);
  };
  pc.addEventListener("icecandidate", (event) => {
    if (disposed) return;
    if (event.candidate) {
      if (iceBatch.length >= 128) {
        fail(new RangeError("ICE candidate batch capacity"));
        return;
      }
      iceBatch.push(event.candidate.toJSON());
      clearTimeout(iceTimer);
      iceTimer = setTimeout(flushCandidates, 100);
    } else flushCandidates();
  });
  pc.addEventListener("connectionstatechange", () => {
    transport?.setConnectionState(pc.connectionState);
    status({ type: "connection-state", state: pc.connectionState });
    if (pc.connectionState === "failed") fail(new Error("P2P connection failed; no automatic TURN fallback"));
  });
  const flushIce = async () => {
    while (earlyIce.length) await pc.addIceCandidate(earlyIce.shift());
  };
  unsubscribe = signaler.subscribe((event) => {
    if (disposed || event.from !== remoteId || event.to !== signaler.id && event.to !== "*") return;
    const message = event.message;
    chain = chain.then(async () => {
      if (disposed) return;
      if (message?.type === "offer" && !initiator && !pc.remoteDescription) {
        await pc.setRemoteDescription(message.description);
        await flushIce();
        await pc.setLocalDescription(await pc.createAnswer());
        await send({ type: "answer", description: pc.localDescription.toJSON() });
      } else if (message?.type === "answer" && initiator && !pc.remoteDescription) {
        await pc.setRemoteDescription(message.description);
        await flushIce();
      } else if (message?.type === "ice") {
        const candidates = message.candidates ?? (message.candidate ? [message.candidate] : []);
        if (!Array.isArray(candidates) || candidates.length > 128) throw new RangeError("ICE candidate batch");
        for (const candidate of candidates) {
          if (pc.remoteDescription) await pc.addIceCandidate(candidate);
          else if (earlyIce.length < 128) earlyIce.push(candidate);
          else throw new RangeError("ICE queue capacity");
        }
      } else if (message?.type === "bye") close();
    }).catch(fail);
  });
  timer = setTimeout(() => fail(new Error("P2P connection timeout")), integer(timeoutMs, "timeoutMs", 1, 12e4));
  if (initiator) {
    channel(pc.createDataChannel("inputs", { ordered: false, maxRetransmits: 0 }));
    channel(pc.createDataChannel("control", { ordered: true }));
    chain = chain.then(async () => {
      await pc.setLocalDescription(await pc.createOffer());
      await send({ type: "offer", description: pc.localDescription.toJSON() });
    }).catch(fail);
  }
  return result;
}

// packages/transport/src/nostr-crypto.js
var nostrField = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
var nostrOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
var nostrGenerator = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
  1n
];
var nostrInfinity = [0n, 1n, 0n];
var nostrEncoder = new TextEncoder();
function nostrMod(nostrValue, nostrModulus = nostrField) {
  const nostrRemainder = nostrValue % nostrModulus;
  return nostrRemainder < 0n ? nostrRemainder + nostrModulus : nostrRemainder;
}
function nostrPow(nostrBase, nostrExponent) {
  let nostrResult = 1n;
  nostrBase = nostrMod(nostrBase);
  while (nostrExponent > 0n) {
    if (nostrExponent & 1n) nostrResult = nostrMod(nostrResult * nostrBase);
    nostrBase = nostrMod(nostrBase * nostrBase);
    nostrExponent >>= 1n;
  }
  return nostrResult;
}
function nostrDouble(nostrPoint) {
  const [nostrX, nostrY, nostrZ] = nostrPoint;
  if (nostrZ === 0n || nostrY === 0n) return nostrInfinity;
  const nostrA = nostrMod(nostrX * nostrX);
  const nostrB = nostrMod(nostrY * nostrY);
  const nostrC = nostrMod(nostrB * nostrB);
  const nostrD = nostrMod(2n * (nostrMod((nostrX + nostrB) ** 2n) - nostrA - nostrC));
  const nostrE = nostrMod(3n * nostrA);
  const nostrNextX = nostrMod(nostrE * nostrE - 2n * nostrD);
  return [nostrNextX, nostrMod(nostrE * (nostrD - nostrNextX) - 8n * nostrC), nostrMod(2n * nostrY * nostrZ)];
}
function nostrAdd(nostrLeft, nostrRight) {
  if (nostrLeft[2] === 0n) return nostrRight;
  if (nostrRight[2] === 0n) return nostrLeft;
  const [nostrX1, nostrY1, nostrZ1] = nostrLeft;
  const [nostrX2, nostrY2, nostrZ2] = nostrRight;
  const nostrZ1Squared = nostrMod(nostrZ1 * nostrZ1);
  const nostrZ2Squared = nostrMod(nostrZ2 * nostrZ2);
  const nostrU1 = nostrMod(nostrX1 * nostrZ2Squared);
  const nostrU2 = nostrMod(nostrX2 * nostrZ1Squared);
  const nostrS1 = nostrMod(nostrY1 * nostrZ2Squared * nostrZ2);
  const nostrS2 = nostrMod(nostrY2 * nostrZ1Squared * nostrZ1);
  if (nostrU1 === nostrU2) return nostrS1 === nostrS2 ? nostrDouble(nostrLeft) : nostrInfinity;
  const nostrH = nostrMod(nostrU2 - nostrU1);
  const nostrI = nostrMod(4n * nostrH * nostrH);
  const nostrJ = nostrMod(nostrH * nostrI);
  const nostrR = nostrMod(2n * (nostrS2 - nostrS1));
  const nostrV = nostrMod(nostrU1 * nostrI);
  const nostrNextX = nostrMod(nostrR * nostrR - nostrJ - 2n * nostrV);
  return [
    nostrNextX,
    nostrMod(nostrR * (nostrV - nostrNextX) - 2n * nostrS1 * nostrJ),
    nostrMod(((nostrZ1 + nostrZ2) ** 2n - nostrZ1Squared - nostrZ2Squared) * nostrH)
  ];
}
function nostrMultiply(nostrScalar, nostrPoint = nostrGenerator) {
  let nostrResult = nostrInfinity;
  while (nostrScalar > 0n) {
    if (nostrScalar & 1n) nostrResult = nostrAdd(nostrResult, nostrPoint);
    nostrPoint = nostrDouble(nostrPoint);
    nostrScalar >>= 1n;
  }
  return nostrResult;
}
function nostrAffine(nostrPoint) {
  if (nostrPoint[2] === 0n) return null;
  const nostrInverse = nostrPow(nostrPoint[2], nostrField - 2n);
  const nostrInverseSquared = nostrMod(nostrInverse * nostrInverse);
  return [nostrMod(nostrPoint[0] * nostrInverseSquared), nostrMod(nostrPoint[1] * nostrInverseSquared * nostrInverse)];
}
function nostrLiftX(nostrX) {
  if (nostrX >= nostrField) return null;
  const nostrC = nostrMod(nostrX ** 3n + 7n);
  const nostrY = nostrPow(nostrC, (nostrField + 1n) / 4n);
  if (nostrMod(nostrY * nostrY) !== nostrC) return null;
  return [nostrX, nostrY & 1n ? nostrField - nostrY : nostrY, 1n];
}
function nostrRequireBytes(nostrValue, nostrLength, nostrName) {
  if (!(nostrValue instanceof Uint8Array) || nostrValue.length !== nostrLength) {
    throw new TypeError(`${nostrName} must be a ${nostrLength}-byte Uint8Array`);
  }
  return new Uint8Array(nostrValue);
}
function nostrBytesToNumber(nostrBytes) {
  let nostrValue = 0n;
  for (const nostrByte of nostrBytes) nostrValue = nostrValue << 8n | BigInt(nostrByte);
  return nostrValue;
}
function nostrNumberToBytes(nostrValue) {
  const nostrBytes = new Uint8Array(32);
  for (let nostrIndex = 31; nostrIndex >= 0; nostrIndex--) {
    nostrBytes[nostrIndex] = Number(nostrValue & 255n);
    nostrValue >>= 8n;
  }
  return nostrBytes;
}
function nostrToHex(nostrBytes) {
  return Array.from(nostrBytes, (nostrByte) => nostrByte.toString(16).padStart(2, "0")).join("");
}
function nostrFromHex(nostrHex) {
  return Uint8Array.from(nostrHex.match(/../g), (nostrByte) => parseInt(nostrByte, 16));
}
function nostrConcat(...nostrParts) {
  const nostrBytes = new Uint8Array(nostrParts.reduce((nostrSize, nostrPart) => nostrSize + nostrPart.length, 0));
  let nostrOffset = 0;
  for (const nostrPart of nostrParts) {
    nostrBytes.set(nostrPart, nostrOffset);
    nostrOffset += nostrPart.length;
  }
  return nostrBytes;
}
function nostrRequireCrypto(nostrCryptoImpl, nostrRandom = false) {
  if (!nostrCryptoImpl?.subtle || typeof nostrCryptoImpl.subtle.digest !== "function" || nostrRandom && typeof nostrCryptoImpl.getRandomValues !== "function") {
    throw new Error("Nostr signaling requires WebCrypto SHA-256 and secure randomness (use HTTPS)");
  }
}
async function nostrHash(nostrBytes, nostrCryptoImpl) {
  nostrRequireCrypto(nostrCryptoImpl);
  return new Uint8Array(await nostrCryptoImpl.subtle.digest("SHA-256", nostrBytes));
}
async function nostrTaggedHash(nostrTag, nostrBytes, nostrCryptoImpl) {
  const nostrTagHash = await nostrHash(nostrEncoder.encode(nostrTag), nostrCryptoImpl);
  return nostrHash(nostrConcat(nostrTagHash, nostrTagHash, nostrBytes), nostrCryptoImpl);
}
function nostrPublicKey(nostrSecret) {
  const nostrSecretCopy = nostrRequireBytes(nostrSecret, 32, "secret");
  try {
    const nostrScalar = nostrBytesToNumber(nostrSecretCopy);
    if (nostrScalar === 0n || nostrScalar >= nostrOrder) throw new RangeError("Invalid secp256k1 secret");
    return nostrNumberToBytes(nostrAffine(nostrMultiply(nostrScalar))[0]);
  } finally {
    nostrSecretCopy.fill(0);
  }
}
async function nostrVerify(nostrSignature, nostrMessage, nostrPublic, nostrCryptoImpl) {
  if (!(nostrSignature instanceof Uint8Array) || nostrSignature.length !== 64 || !(nostrMessage instanceof Uint8Array) || nostrMessage.length !== 32 || !(nostrPublic instanceof Uint8Array) || nostrPublic.length !== 32) return false;
  const nostrSignatureCopy = new Uint8Array(nostrSignature);
  const nostrMessageCopy = new Uint8Array(nostrMessage);
  const nostrPublicCopy = new Uint8Array(nostrPublic);
  const nostrPoint = nostrLiftX(nostrBytesToNumber(nostrPublicCopy));
  const nostrR = nostrBytesToNumber(nostrSignatureCopy.subarray(0, 32));
  const nostrS = nostrBytesToNumber(nostrSignatureCopy.subarray(32));
  if (!nostrPoint || nostrR >= nostrField || nostrS >= nostrOrder) return false;
  const nostrChallenge = nostrBytesToNumber(await nostrTaggedHash(
    "BIP0340/challenge",
    nostrConcat(nostrSignatureCopy.subarray(0, 32), nostrPublicCopy, nostrMessageCopy),
    nostrCryptoImpl
  )) % nostrOrder;
  const nostrResult = nostrAffine(nostrAdd(nostrMultiply(nostrS), nostrMultiply(
    nostrChallenge,
    [nostrPoint[0], nostrMod(-nostrPoint[1]), 1n]
  )));
  return nostrResult !== null && (nostrResult[1] & 1n) === 0n && nostrResult[0] === nostrR;
}
async function nostrSign(nostrMessage, nostrSecret, nostrAuxiliary, nostrCryptoImpl) {
  const nostrMessageCopy = nostrRequireBytes(nostrMessage, 32, "message");
  const nostrAuxiliaryCopy = nostrRequireBytes(nostrAuxiliary, 32, "auxiliary randomness");
  const nostrSecretCopy = nostrRequireBytes(nostrSecret, 32, "secret");
  let nostrMaskedSecret;
  try {
    const nostrScalar = nostrBytesToNumber(nostrSecretCopy);
    if (nostrScalar === 0n || nostrScalar >= nostrOrder) throw new RangeError("Invalid secp256k1 secret");
    const nostrPoint = nostrAffine(nostrMultiply(nostrScalar));
    const nostrNormalizedSecret = nostrPoint[1] & 1n ? nostrOrder - nostrScalar : nostrScalar;
    const nostrPublic = nostrNumberToBytes(nostrPoint[0]);
    const nostrAuxiliaryHash = await nostrTaggedHash("BIP0340/aux", nostrAuxiliaryCopy, nostrCryptoImpl);
    nostrMaskedSecret = nostrNumberToBytes(nostrNormalizedSecret);
    for (let nostrIndex = 0; nostrIndex < 32; nostrIndex++) nostrMaskedSecret[nostrIndex] ^= nostrAuxiliaryHash[nostrIndex];
    const nostrNonce = nostrBytesToNumber(await nostrTaggedHash(
      "BIP0340/nonce",
      nostrConcat(nostrMaskedSecret, nostrPublic, nostrMessageCopy),
      nostrCryptoImpl
    )) % nostrOrder;
    if (nostrNonce === 0n) throw new Error("BIP340 nonce generation failed");
    const nostrNoncePoint = nostrAffine(nostrMultiply(nostrNonce));
    const nostrNormalizedNonce = nostrNoncePoint[1] & 1n ? nostrOrder - nostrNonce : nostrNonce;
    const nostrR = nostrNumberToBytes(nostrNoncePoint[0]);
    const nostrChallenge = nostrBytesToNumber(await nostrTaggedHash(
      "BIP0340/challenge",
      nostrConcat(nostrR, nostrPublic, nostrMessageCopy),
      nostrCryptoImpl
    )) % nostrOrder;
    const nostrSignature = nostrConcat(nostrR, nostrNumberToBytes(nostrMod(nostrNormalizedNonce + nostrChallenge * nostrNormalizedSecret, nostrOrder)));
    if (!await nostrVerify(nostrSignature, nostrMessageCopy, nostrPublic, nostrCryptoImpl)) throw new Error("BIP340 signature self-check failed");
    return nostrSignature;
  } finally {
    nostrSecretCopy.fill(0);
    nostrAuxiliaryCopy.fill(0);
    nostrMaskedSecret?.fill(0);
  }
}
var nostrCrypto = Object.freeze({
  publicKey: nostrPublicKey,
  sign: (nostrMessage, nostrSecret, nostrAuxiliary) => nostrSign(nostrMessage, nostrSecret, nostrAuxiliary, globalThis.crypto),
  verify: (nostrSignature, nostrMessage, nostrPublic) => nostrVerify(nostrSignature, nostrMessage, nostrPublic, globalThis.crypto)
});

// packages/transport/src/nostr.js
var nostrHex32 = /^[0-9a-f]{64}$/;
var nostrHex64 = /^[0-9a-f]{128}$/;
var nostrSignalTypes = /* @__PURE__ */ new Set(["discover", "presence", "offer", "answer", "ice", "bye", "group"]);
var nostrContentLimit = 128 * 1024;
var nostrFreshSeconds = 120;
var nostrFutureSeconds = 30;
function nostrIsSignalMessage(nostrMessage) {
  return nostrMessage !== null && typeof nostrMessage === "object" && !Array.isArray(nostrMessage) && Object.prototype.hasOwnProperty.call(nostrMessage, "type") && nostrSignalTypes.has(nostrMessage.type);
}
function nostrListen(nostrSocket, nostrType, nostrHandler) {
  if (typeof nostrSocket.addEventListener === "function") {
    nostrSocket.addEventListener(nostrType, nostrHandler);
    return () => nostrSocket.removeEventListener(nostrType, nostrHandler);
  }
  const nostrProperty = `on${nostrType}`;
  nostrSocket[nostrProperty] = nostrHandler;
  return () => {
    if (nostrSocket[nostrProperty] === nostrHandler) nostrSocket[nostrProperty] = null;
  };
}
async function createNostrSignaler({
  room,
  namespace = "rollback-netcode",
  relays = ["wss://relay.primal.net", "wss://relay.damus.io"],
  timeoutMs = 1e4,
  onStatus = () => {
  },
  WebSocketImpl = globalThis.WebSocket,
  cryptoImpl = globalThis.crypto,
  signal,
  publishIntervalMs = 500,
  maxVerificationsPerSecond = 16,
  verificationBurst = 8
} = {}) {
  if (signal?.aborted) throw new Error("Nostr signaler aborted");
  if (typeof room !== "string" || !/^\d{4}$/.test(room)) throw new TypeError("room must contain exactly four ASCII digits");
  if (typeof namespace !== "string" || namespace.trim().length === 0 || nostrEncoder.encode(namespace).length > 128) throw new TypeError("namespace must be a nonempty string of at most 128 UTF-8 bytes");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 12e4) throw new RangeError("timeoutMs must be greater than zero and at most 120000");
  integer(publishIntervalMs, "publishIntervalMs", 0, 1e4);
  integer(maxVerificationsPerSecond, "maxVerificationsPerSecond", 1, 1024);
  integer(verificationBurst, "verificationBurst", 1, 32);
  if (typeof WebSocketImpl !== "function") throw new Error("Nostr signaling requires WebSocket support");
  if (typeof onStatus !== "function") throw new TypeError("onStatus must be a function");
  nostrRequireCrypto(cryptoImpl, true);
  if (!Array.isArray(relays) || relays.length === 0 || relays.length > 16) throw new TypeError("relays must contain between 1 and 16 WebSocket URLs");
  const nostrUrls = [...new Set(relays.map((nostrRelay) => {
    if (typeof nostrRelay !== "string") throw new TypeError("Relay URLs must be strings");
    const nostrUrl = new URL(nostrRelay);
    if (!["ws:", "wss:"].includes(nostrUrl.protocol) || nostrUrl.username || nostrUrl.password || nostrUrl.hash) throw new TypeError("Relays must be ws:// or wss:// URLs without credentials or fragments");
    return nostrUrl.href;
  }))];
  const nostrRandom = (nostrLength) => cryptoImpl.getRandomValues(new Uint8Array(nostrLength));
  const nostrSecret = new Uint8Array(32);
  let nostrSecretReady = false;
  for (let nostrAttempt = 0; nostrAttempt < 16; nostrAttempt++) {
    nostrSecret.set(nostrRandom(32));
    const nostrValue = nostrBytesToNumber(nostrSecret);
    if (nostrValue > 0n && nostrValue < nostrOrder) {
      nostrSecretReady = true;
      break;
    }
  }
  if (!nostrSecretReady) {
    nostrSecret.fill(0);
    throw new Error("Secure random secret generation failed");
  }
  const nostrId = nostrToHex(nostrPublicKey(nostrSecret));
  const nostrRoomTag = `${namespace}:${room}`;
  const nostrSubscription = `rn-${nostrToHex(nostrRandom(16))}`;
  const nostrListeners = /* @__PURE__ */ new Set();
  const nostrBacklog = [];
  const nostrSeen = /* @__PURE__ */ new Map();
  const nostrVerifying = /* @__PURE__ */ new Set();
  const nostrPending = /* @__PURE__ */ new Map();
  const nostrStates = [];
  let verificationTokens = verificationBurst, verificationAt = nowMs();
  const verificationMetrics = { attempted: 0, verified: 0, throttled: 0, totalVerificationMs: 0, maxVerificationMs: 0 };
  let nostrClosed = false;
  let nostrSending = 0;
  let nostrSendTail = Promise.resolve(), nostrLastPublication = -Infinity;
  const nostrWaiters = /* @__PURE__ */ new Map();
  let nostrHasSubscriber = false;
  let nostrReadyResolve;
  let nostrReadyReject;
  let nostrInitializationSettled = false;
  const nostrReady = new Promise((nostrResolve, nostrReject) => {
    nostrReadyResolve = nostrResolve;
    nostrReadyReject = nostrReject;
  });
  const nostrStatus = (nostrStatusName, nostrRelay, nostrMessage) => {
    if (nostrClosed && nostrStatusName !== "closed") return;
    try {
      onStatus({ type: "signaler", transport: "nostr", status: nostrStatusName, ...nostrRelay ? { relay: nostrRelay } : {}, ...nostrMessage ? { message: String(nostrMessage) } : {} });
    } catch {
    }
  };
  function nostrFinishPublication(nostrEventId, nostrError) {
    const nostrPublication = nostrPending.get(nostrEventId);
    if (!nostrPublication) return;
    clearTimeout(nostrPublication.timer);
    nostrPending.delete(nostrEventId);
    if (nostrError) nostrPublication.reject(nostrError);
    else nostrPublication.resolve();
  }
  function nostrPublicationFailure(nostrState, nostrEventId, nostrReason) {
    const nostrPublication = nostrPending.get(nostrEventId);
    if (!nostrPublication || !nostrPublication.remaining.delete(nostrState)) return;
    nostrPublication.failures.push(`${nostrState.url}: ${nostrReason}`);
    if (nostrPublication.remaining.size === 0 && !nostrStates.some((nostrRelay) => !nostrRelay.failed && !nostrRelay.ready)) nostrFinishPublication(
      nostrEventId,
      new Error(`No Nostr relay accepted the event: ${nostrPublication.failures.join("; ")}`)
    );
  }
  function nostrFailRelay(nostrState, nostrReason) {
    if (nostrState.failed || nostrClosed) return;
    nostrState.failed = true;
    nostrState.ready = false;
    clearTimeout(nostrState.timer);
    for (const nostrRemove of nostrState.remove) nostrRemove();
    try {
      nostrState.socket?.close();
    } catch {
    }
    for (const nostrEventId of nostrPending.keys()) nostrPublicationFailure(nostrState, nostrEventId, nostrReason);
    nostrStatus("error", nostrState.url, nostrReason);
    if (!nostrInitializationSettled && nostrStates.length === nostrUrls.length && nostrStates.every((nostrRelay) => nostrRelay.failed)) {
      nostrInitializationSettled = true;
      nostrReadyReject(new Error(`No Nostr relay became ready: ${nostrReason}`));
    }
  }
  function nostrDeliver(nostrEnvelope) {
    if (nostrClosed) return;
    if (!nostrHasSubscriber) {
      if (nostrBacklog.length === 32) nostrBacklog.shift();
      nostrBacklog.push(nostrEnvelope);
      return;
    }
    for (const nostrHandler of [...nostrListeners]) {
      if (nostrClosed) break;
      try {
        const nostrResult = nostrHandler(nostrEnvelope);
        if (nostrResult && typeof nostrResult.then === "function") Promise.resolve(nostrResult).catch((nostrError) => nostrStatus("error", null, nostrError?.message || "Signaling subscriber failed"));
      } catch (nostrError) {
        nostrStatus("error", null, nostrError?.message || "Signaling subscriber failed");
      }
    }
  }
  async function nostrReceive(nostrEvent) {
    if (nostrClosed || !nostrEvent || typeof nostrEvent !== "object" || Array.isArray(nostrEvent) || typeof nostrEvent.id !== "string" || typeof nostrEvent.pubkey !== "string" || typeof nostrEvent.sig !== "string" || !nostrHex32.test(nostrEvent.id) || !nostrHex32.test(nostrEvent.pubkey) || !nostrHex64.test(nostrEvent.sig) || nostrEvent.pubkey === nostrId || nostrEvent.kind !== 20078 || !Number.isSafeInteger(nostrEvent.created_at) || typeof nostrEvent.content !== "string" || nostrEvent.content.length > nostrContentLimit || !Array.isArray(nostrEvent.tags) || nostrEvent.tags.length > 16 || nostrVerifying.size >= 32) return;
    const nostrNow = Date.now();
    const nostrNowSeconds = Math.floor(nostrNow / 1e3);
    if (nostrEvent.created_at < nostrNowSeconds - nostrFreshSeconds || nostrEvent.created_at > nostrNowSeconds + nostrFutureSeconds || nostrEncoder.encode(nostrEvent.content).length > nostrContentLimit) return;
    for (const [nostrSeenId, nostrExpiry] of nostrSeen) {
      if (nostrExpiry > nostrNow) break;
      nostrSeen.delete(nostrSeenId);
    }
    if (nostrSeen.has(nostrEvent.id) || nostrVerifying.has(nostrEvent.id)) return;
    if (!nostrEvent.tags.every((nostrTag) => Array.isArray(nostrTag) && nostrTag.length > 0 && nostrTag.length <= 4 && nostrTag.every((nostrValue) => typeof nostrValue === "string" && nostrEncoder.encode(nostrValue).length <= 256))) return;
    const nostrRoomTags = nostrEvent.tags.filter((nostrTag) => nostrTag[0] === "d");
    const nostrRecipientTags = nostrEvent.tags.filter((nostrTag) => nostrTag[0] === "p");
    if (nostrRoomTags.length !== 1 || nostrRoomTags[0][1] !== nostrRoomTag) return;
    let nostrContent;
    try {
      nostrContent = JSON.parse(nostrEvent.content);
    } catch {
      return;
    }
    if (!nostrContent || nostrContent.v !== 1 || nostrContent.namespace !== namespace || nostrContent.room !== room || nostrContent.from !== nostrEvent.pubkey || typeof nostrContent.nonce !== "string" || !/^[0-9a-f]{32}$/.test(nostrContent.nonce) || nostrContent.to !== "*" && nostrContent.to !== nostrId || !nostrIsSignalMessage(nostrContent.message)) return;
    if (nostrContent.to === "*" ? nostrRecipientTags.length !== 0 : nostrRecipientTags.length !== 1 || nostrRecipientTags[0][1] !== nostrContent.to) return;
    const measuredNow = nowMs();
    verificationTokens = Math.min(verificationBurst, verificationTokens + Math.max(0, measuredNow - verificationAt) * maxVerificationsPerSecond / 1e3);
    verificationAt = measuredNow;
    if (verificationTokens < 1) {
      verificationMetrics.throttled++;
      return;
    }
    verificationTokens--;
    verificationMetrics.attempted++;
    nostrVerifying.add(nostrEvent.id);
    try {
      const nostrHashBytes = await nostrHash(nostrEncoder.encode(JSON.stringify([0, nostrEvent.pubkey, nostrEvent.created_at, nostrEvent.kind, nostrEvent.tags, nostrEvent.content])), cryptoImpl);
      if (nostrToHex(nostrHashBytes) !== nostrEvent.id || !await nostrVerify(nostrFromHex(nostrEvent.sig), nostrHashBytes, nostrFromHex(nostrEvent.pubkey), cryptoImpl) || nostrClosed) return;
      if (nostrSeen.size >= 2048) nostrSeen.delete(nostrSeen.keys().next().value);
      nostrSeen.set(nostrEvent.id, nostrNow + 3e5);
      verificationMetrics.verified++;
      nostrDeliver({ from: nostrContent.from, to: nostrContent.to, message: nostrContent.message });
    } catch (nostrError) {
      nostrStatus("error", null, nostrError?.message || "Nostr verification failed");
    } finally {
      nostrVerifying.delete(nostrEvent.id);
      const elapsed = nowMs() - measuredNow;
      verificationMetrics.totalVerificationMs += elapsed;
      verificationMetrics.maxVerificationMs = Math.max(verificationMetrics.maxVerificationMs, elapsed);
    }
  }
  function nostrHandleMessage(nostrState, nostrData) {
    if (nostrClosed || nostrState.failed || typeof nostrData !== "string" || nostrData.length > 1024 * 1024) return;
    let nostrFrame;
    try {
      nostrFrame = JSON.parse(nostrData);
    } catch {
      return;
    }
    if (!Array.isArray(nostrFrame)) return;
    if (nostrFrame[0] === "EOSE" && nostrFrame.length === 2 && nostrFrame[1] === nostrSubscription && nostrState.requested) {
      if (nostrState.ready) return;
      nostrState.ready = true;
      clearTimeout(nostrState.timer);
      nostrStatus("connected", nostrState.url);
      if (!nostrInitializationSettled) {
        nostrInitializationSettled = true;
        nostrReadyResolve();
      }
      for (const nostrPublication of nostrPending.values()) if (!nostrPublication.attempted.has(nostrState)) {
        nostrPublication.attempted.add(nostrState);
        nostrPublication.remaining.add(nostrState);
        try {
          nostrState.socket.send(nostrPublication.frame);
        } catch (nostrError) {
          nostrFailRelay(nostrState, nostrError?.message || "Fallback publication failed");
        }
      }
    } else if (nostrFrame[0] === "EVENT" && nostrFrame.length === 3 && nostrFrame[1] === nostrSubscription && nostrState.requested) {
      void nostrReceive(nostrFrame[2]);
    } else if (nostrFrame[0] === "OK" && nostrFrame.length === 4 && typeof nostrFrame[1] === "string" && typeof nostrFrame[2] === "boolean" && typeof nostrFrame[3] === "string") {
      const nostrPublication = nostrPending.get(nostrFrame[1]);
      if (!nostrPublication?.remaining.has(nostrState)) return;
      if (nostrFrame[2]) {
        nostrFinishPublication(nostrFrame[1]);
        nostrStatus("published", nostrState.url);
      } else nostrFailRelay(nostrState, nostrFrame[3].slice(0, 256) || "Relay rejected the event");
    } else if (nostrFrame[0] === "CLOSED" && nostrFrame.length === 3 && nostrFrame[1] === nostrSubscription && typeof nostrFrame[2] === "string") {
      nostrFailRelay(nostrState, `Relay ended the signaling subscription: ${nostrFrame[2].slice(0, 256)}`);
    } else if (nostrFrame[0] === "NOTICE" && typeof nostrFrame[1] === "string") {
      nostrStatus("notice", nostrState.url, nostrFrame[1].slice(0, 256));
    }
  }
  function nostrClose() {
    if (nostrClosed) return;
    nostrClosed = true;
    signal?.removeEventListener("abort", nostrClose);
    for (const [nostrTimer, nostrReject] of nostrWaiters) {
      clearTimeout(nostrTimer);
      nostrReject(new Error("Nostr signaler closed"));
    }
    nostrWaiters.clear();
    for (const nostrState of nostrStates) {
      clearTimeout(nostrState.timer);
      if (nostrState.socket?.readyState === 1 && nostrState.requested) {
        try {
          nostrState.socket.send(JSON.stringify(["CLOSE", nostrSubscription]));
        } catch {
        }
      }
      for (const nostrRemove of nostrState.remove) nostrRemove();
      try {
        nostrState.socket?.close();
      } catch {
      }
      nostrState.ready = false;
    }
    for (const nostrEventId of nostrPending.keys()) nostrFinishPublication(nostrEventId, new Error("Nostr signaler closed"));
    if (!nostrInitializationSettled) {
      nostrInitializationSettled = true;
      nostrReadyReject(new Error("Nostr signaler closed"));
    }
    nostrSecret.fill(0);
    nostrListeners.clear();
    nostrBacklog.length = 0;
    nostrSeen.clear();
    nostrVerifying.clear();
    nostrStatus("closed");
  }
  signal?.addEventListener("abort", nostrClose, { once: true });
  for (const nostrUrl of nostrUrls) {
    if (nostrClosed) break;
    const nostrState = { url: nostrUrl, socket: null, ready: false, requested: false, failed: false, remove: [], timer: null };
    nostrStates.push(nostrState);
    nostrStatus("connecting", nostrUrl);
    if (nostrClosed) break;
    try {
      const nostrSocket = nostrState.socket = new WebSocketImpl(nostrUrl);
      if (nostrClosed) {
        try {
          nostrSocket.close();
        } catch {
        }
        break;
      }
      nostrState.timer = setTimeout(() => nostrFailRelay(nostrState, "Nostr connection/subscription timed out"), timeoutMs);
      const nostrOpen = () => {
        if (nostrClosed || nostrState.failed || nostrState.requested) return;
        nostrState.requested = true;
        try {
          nostrSocket.send(JSON.stringify(["REQ", nostrSubscription, { kinds: [20078], "#d": [nostrRoomTag], since: Math.floor(Date.now() / 1e3) - nostrFreshSeconds, limit: 0 }]));
        } catch (nostrError) {
          nostrFailRelay(nostrState, nostrError?.message || "Nostr subscription failed");
        }
      };
      nostrState.remove.push(
        nostrListen(nostrSocket, "open", nostrOpen),
        nostrListen(nostrSocket, "message", (nostrEvent) => nostrHandleMessage(nostrState, nostrEvent.data)),
        nostrListen(nostrSocket, "error", () => nostrFailRelay(nostrState, "Nostr WebSocket error")),
        nostrListen(nostrSocket, "close", () => nostrFailRelay(nostrState, "Nostr relay disconnected"))
      );
      if (nostrSocket.readyState === 1) nostrOpen();
    } catch (nostrError) {
      nostrFailRelay(nostrState, nostrError?.message || "Nostr connection failed");
    }
  }
  try {
    await nostrReady;
  } catch (nostrError) {
    nostrClose();
    throw nostrError;
  }
  return {
    id: nostrId,
    room,
    get metrics() {
      return { ...verificationMetrics };
    },
    async send(nostrTo, nostrMessage) {
      if (nostrClosed) throw new Error("Nostr signaler closed");
      if (nostrTo !== "*" && (typeof nostrTo !== "string" || !nostrHex32.test(nostrTo))) throw new TypeError("Nostr recipient must be a lowercase public key or *");
      if (!nostrIsSignalMessage(nostrMessage)) throw new TypeError("Nostr carries discovery, presence, offer, answer, ice, bye and group signaling only");
      if (nostrSending >= 64) throw new Error("Too many pending Nostr publications");
      if (!nostrStates.some((nostrState) => nostrState.ready && !nostrState.failed && nostrState.socket.readyState === 1)) throw new Error("No live Nostr relays");
      nostrSending++;
      const nostrPrevious = nostrSendTail;
      let nostrUnlock;
      nostrSendTail = new Promise((nostrResolve) => {
        nostrUnlock = nostrResolve;
      });
      try {
        let nostrContent;
        try {
          nostrContent = JSON.stringify({ v: 1, namespace, room, from: nostrId, to: nostrTo, nonce: nostrToHex(nostrRandom(16)), message: nostrMessage });
        } catch {
          throw new TypeError("Nostr signaling message must be JSON serializable");
        }
        if (nostrEncoder.encode(nostrContent).length > nostrContentLimit) throw new RangeError("Nostr signaling content exceeds 128 KiB");
        if (!nostrIsSignalMessage(JSON.parse(nostrContent).message)) throw new TypeError("Nostr signaling message serialization changed its type");
        await nostrPrevious;
        if (nostrClosed) throw new Error("Nostr signaler closed");
        const nostrWait = publishIntervalMs - (Date.now() - nostrLastPublication);
        if (nostrWait > 0) await new Promise((nostrResolve, nostrReject) => {
          const nostrTimer = setTimeout(() => {
            nostrWaiters.delete(nostrTimer);
            nostrResolve();
          }, nostrWait);
          nostrWaiters.set(nostrTimer, nostrReject);
        });
        if (nostrClosed) throw new Error("Nostr signaler closed");
        const nostrEvent = {
          pubkey: nostrId,
          created_at: Math.floor(Date.now() / 1e3),
          kind: 20078,
          tags: [["d", nostrRoomTag], ...nostrTo === "*" ? [] : [["p", nostrTo]]],
          content: nostrContent
        };
        const nostrHashBytes = await nostrHash(nostrEncoder.encode(JSON.stringify([0, nostrId, nostrEvent.created_at, nostrEvent.kind, nostrEvent.tags, nostrContent])), cryptoImpl);
        if (nostrClosed) throw new Error("Nostr signaler closed");
        const nostrAuxiliary = nostrRandom(32);
        try {
          nostrEvent.sig = nostrToHex(await nostrSign(nostrHashBytes, nostrSecret, nostrAuxiliary, cryptoImpl));
        } finally {
          nostrAuxiliary.fill(0);
        }
        nostrEvent.id = nostrToHex(nostrHashBytes);
        if (nostrClosed) throw new Error("Nostr signaler closed");
        const nostrAvailable = nostrStates.filter((nostrState) => nostrState.ready && !nostrState.failed && nostrState.socket.readyState === 1);
        if (nostrAvailable.length === 0) throw new Error("No live Nostr relays");
        const nostrFrame = JSON.stringify(["EVENT", nostrEvent]);
        nostrLastPublication = Date.now();
        await new Promise((nostrResolve, nostrReject) => {
          const nostrPublication = {
            resolve: nostrResolve,
            reject: nostrReject,
            remaining: new Set(nostrAvailable),
            attempted: new Set(nostrAvailable),
            frame: nostrFrame,
            failures: [],
            timer: null
          };
          nostrPending.set(nostrEvent.id, nostrPublication);
          nostrPublication.timer = setTimeout(() => nostrFinishPublication(nostrEvent.id, new Error("Nostr publication timed out without a positive relay OK")), timeoutMs);
          for (const nostrState of nostrAvailable) {
            if (nostrClosed) break;
            try {
              nostrState.socket.send(nostrFrame);
            } catch (nostrError) {
              nostrFailRelay(nostrState, nostrError?.message || "Nostr publication failed");
            }
          }
        });
      } finally {
        await nostrPrevious;
        nostrSending--;
        nostrUnlock();
      }
    },
    subscribe(nostrHandler) {
      if (nostrClosed) throw new Error("Nostr signaler closed");
      if (typeof nostrHandler !== "function") throw new TypeError("Signaling subscriber must be a function");
      nostrListeners.add(nostrHandler);
      if (!nostrHasSubscriber) {
        nostrHasSubscriber = true;
        const nostrQueued = nostrBacklog.splice(0);
        for (const nostrEnvelope of nostrQueued) nostrDeliver(nostrEnvelope);
      }
      return () => nostrListeners.delete(nostrHandler);
    },
    close: nostrClose
  };
}

// packages/transport/src/room.js
async function createNostrRoom({
  role,
  room,
  namespace = "rollback-netcode",
  relays,
  rtcConfig,
  timeoutMs = 3e4,
  onStatus = () => {
  },
  signal,
  signalerFactory = createNostrSignaler,
  peerFactory = createWebRTCPeer
} = {}) {
  if (!["host", "join"].includes(role)) throw new TypeError("room role");
  integer(timeoutMs, "timeoutMs", 1, 12e4);
  if (typeof signalerFactory !== "function" || typeof peerFactory !== "function") throw new TypeError("room adapter factories");
  if (signal?.aborted) throw new Error("room aborted");
  if (!room && role === "host") {
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    room = String(value[0] % 1e4).padStart(4, "0");
  }
  if (!/^\d{4}$/.test(room ?? "")) throw new TypeError("four-digit room");
  const controller = new AbortController();
  const externalAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", externalAbort, { once: true });
  const roomSignal = controller.signal;
  let signaler;
  try {
    signaler = await signalerFactory({
      room,
      namespace,
      relays,
      timeoutMs: Math.min(timeoutMs, 1e4),
      onStatus,
      signal: roomSignal
    });
  } catch (error) {
    signal?.removeEventListener("abort", externalAbort);
    throw error;
  }
  if (roomSignal.aborted) {
    signaler.close();
    signal?.removeEventListener("abort", externalAbort);
    throw new Error("room aborted");
  }
  return new Promise((resolve, reject) => {
    let connection, unsubscribe, pulse, deadline, collisionTimer;
    let disposed = false, connecting = false, completed = false, selectedPeer, checking = role === "host";
    const nonce = new Uint8Array(16);
    globalThis.crypto.getRandomValues(nonce);
    let sessionId = [...nonce].map((n) => n.toString(16).padStart(2, "0")).join("");
    const status = (value) => {
      try {
        onStatus(value);
      } catch {
      }
    };
    const close = () => {
      if (disposed) return;
      disposed = true;
      clearInterval(pulse);
      clearTimeout(deadline);
      clearTimeout(collisionTimer);
      unsubscribe?.();
      roomSignal.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", externalAbort);
      controller.abort();
      connection?.close();
      signaler.close();
    };
    const fail = (error) => {
      if (!completed) {
        completed = true;
        reject(error);
      }
      close();
    };
    const abort = () => fail(new Error("room aborted"));
    roomSignal.addEventListener("abort", abort, { once: true });
    const send = (to, message) => signaler.send(to, message).catch(fail);
    const presence = (to) => send(to, { type: "presence", room, namespace, host: signaler.id, sessionId, protocol: PROTOCOL_VERSION });
    const connect = (remoteId) => {
      if (connecting || disposed) return;
      connecting = true;
      selectedPeer = remoteId;
      Promise.resolve().then(() => peerFactory({
        initiator: role === "join",
        signaler,
        remoteId,
        rtcConfig,
        timeoutMs: Math.min(timeoutMs, 2e4),
        onStatus,
        signal: roomSignal
      })).then((value) => {
        if (disposed) {
          value.close();
          return;
        }
        connection = value;
        completed = true;
        clearInterval(pulse);
        clearTimeout(deadline);
        clearTimeout(collisionTimer);
        unsubscribe?.();
        resolve({
          room,
          sessionId,
          localPlayerId: role === "host" ? "a" : "b",
          remotePlayerId: role === "host" ? "b" : "a",
          transport: value.transport,
          peerConnection: value.peerConnection,
          close
        });
      }).catch(fail);
    };
    unsubscribe = signaler.subscribe(({ from, to, message }) => {
      if (disposed || from === signaler.id) return;
      if (role === "host") {
        if (message.type === "presence" && message.host === from && message.protocol === PROTOCOL_VERSION) {
          fail(new Error("room code is already in use; choose another four-digit code"));
          return;
        }
        if (message.type === "discover" && !checking && (!selectedPeer || selectedPeer === from)) {
          connect(from);
          presence(from);
        }
      } else if (message.type === "presence" && message.host === from && message.protocol === PROTOCOL_VERSION && typeof message.sessionId === "string") {
        if (selectedPeer && selectedPeer !== from) return;
        selectedPeer = from;
        if (to === signaler.id) {
          sessionId = message.sessionId;
          connect(from);
        } else send(from, { type: "discover" });
      }
    });
    if (disposed) {
      unsubscribe?.();
      return;
    }
    deadline = setTimeout(() => fail(new Error("room discovery timeout")), timeoutMs);
    const advertise = () => {
      if (disposed || connecting || checking) return;
      if (role === "host") presence("*");
      else send(selectedPeer ?? "*", { type: "discover" });
    };
    pulse = setInterval(advertise, 1e3);
    status({ type: "room", room, role });
    if (disposed) return;
    if (checking) collisionTimer = setTimeout(() => {
      checking = false;
      advertise();
    }, 1200);
    else advertise();
  });
}

// packages/transport/src/star-transport.js
var starHeader = 24;
var starPayload = CHUNK_SIZE - starHeader;
var starMagic = 827544658;
function createStarTransports({
  players,
  localPlayerId,
  hostPlayerId,
  sessionId,
  physicalTransports,
  onError = () => {
  },
  maxQueuedBytes = 5 * 1024 * 1024
} = {}) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 8 || new Set(players).size !== players.length || !players.includes(localPlayerId) || !players.includes(hostPlayerId) || typeof sessionId !== "string" || !(physicalTransports instanceof Map) || typeof onError !== "function") throw new TypeError("star transport configuration");
  integer(maxQueuedBytes, "star queue budget", CHUNK_SIZE * 2, 64 * 1024 * 1024);
  const local = players.indexOf(localPlayerId), host = players.indexOf(hostPlayerId), isHost = local === host;
  const required = isHost ? players.filter((id) => id !== localPlayerId) : [hostPlayerId];
  if (required.some((id) => !physicalTransports.get(id)?.subscribe || !physicalTransports.get(id)?.send)) throw new TypeError("missing star physical transport");
  const tag = hashBytes(new TextEncoder().encode(sessionId)), listeners = /* @__PURE__ */ new Map(), statusListeners = /* @__PURE__ */ new Map();
  const queues = new Map(required.map((id) => [id, []])), assemblies = /* @__PURE__ */ new Map(), completed = /* @__PURE__ */ new Map();
  const unsubs = [], stats = { sentFrames: 0, forwardedFrames: 0, rejectedFrames: 0, queuedBytes: 0, queuedFrames: 0, assemblyBytes: 0 };
  let closed = false, sequence = 0, pumping = false;
  function reject() {
    stats.rejectedFrames++;
  }
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    for (const remove of unsubs.splice(0)) remove();
    queues.forEach((q) => q.length = 0);
    assemblies.clear();
    completed.clear();
    stats.queuedBytes = 0;
    stats.queuedFrames = 0;
    stats.assemblyBytes = 0;
    for (const set of statusListeners.values()) for (const fn of set) {
      try {
        fn("closed");
      } catch {
      }
    }
    listeners.clear();
    statusListeners.clear();
  }
  function fail(message) {
    if (closed) return;
    close();
    try {
      onError(new Error(message));
    } catch {
    }
  }
  function pump() {
    if (closed || pumping) return;
    pumping = true;
    try {
      const now = nowMs();
      for (const [id, q] of queues) {
        let work = 0;
        while (q.length && work++ < 128 && !closed) {
          if (now - q[0].at > 1e4) {
            fail("star forwarding backpressure timeout");
            break;
          }
          if (physicalTransports.get(id).send(q[0].bytes) === false) break;
          stats.queuedBytes -= q.shift().bytes.length;
          stats.queuedFrames--;
          stats.sentFrames++;
        }
      }
      for (const [key, a] of assemblies) if (now - a.at > 2e3) {
        assemblies.delete(key);
        stats.assemblyBytes -= a.total;
      }
    } catch (error) {
      fail("star forwarding failed: " + error.message);
    } finally {
      pumping = false;
    }
  }
  function enqueue(id, frames, forwarded) {
    const size = frames.reduce((n, b) => n + b.length, 0), q = queues.get(id);
    if (closed || !q || physicalTransports.get(id).state && physicalTransports.get(id).state !== "open") return false;
    if (stats.queuedBytes + size > maxQueuedBytes || stats.queuedFrames + frames.length > 4096) {
      if (forwarded) fail("star forwarding queue capacity");
      return false;
    }
    const at = nowMs();
    for (const b of frames) q.push({ bytes: b.slice(), at });
    stats.queuedBytes += size;
    stats.queuedFrames += frames.length;
    if (forwarded) stats.forwardedFrames += frames.length;
    pump();
    return !closed;
  }
  function deliver(from, id, payload, lane) {
    const actualLane = payload.length > 5 && [TYPE.INPUT, TYPE.CLOCK].includes(payload[5]) ? payload[5] : 1;
    if (actualLane !== lane) {
      reject();
      return;
    }
    let seen = completed.get(from);
    if (!seen) completed.set(from, seen = /* @__PURE__ */ new Set());
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > 256) seen.delete(seen.values().next().value);
    const target = listeners.get(players[from]);
    if (target?.size) for (const fn of target) fn(payload.slice());
  }
  function receive(physicalId, data) {
    if (closed) return;
    let b;
    try {
      b = bytes(data);
    } catch {
      reject();
      return;
    }
    if (b.length < starHeader || b.length > CHUNK_SIZE) {
      reject();
      return;
    }
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength), from = b[6], to = b[7], lane = b[5];
    const id = v.getUint32(12, true), total = v.getUint16(16, true), offset = v.getUint16(18, true), length = v.getUint16(20, true);
    if (v.getUint32(0, true) !== starMagic || b[4] !== 1 || v.getUint32(8, true) !== tag || v.getUint16(22, true) !== 0 || ![1, TYPE.INPUT, TYPE.CLOCK].includes(lane) || from >= players.length || to >= players.length || from === to || from === local || !id || !total || total > CHUNK_SIZE || ![0, starPayload].includes(offset) || offset >= total || length !== Math.min(starPayload, total - offset) || b.length !== starHeader + length || (isHost ? players[from] !== physicalId : physicalId !== hostPlayerId || to !== local)) {
      reject();
      return;
    }
    if (to !== local) {
      if (!isHost || !enqueue(players[to], [b], true)) {
        if (!closed) fail("star destination is not available");
      }
      return;
    }
    if (completed.get(from)?.has(id)) return;
    if (total <= starPayload) {
      deliver(from, id, b.slice(starHeader), lane);
      return;
    }
    const key = from + ":" + id;
    let a = assemblies.get(key);
    if (!a) {
      if (assemblies.size >= 32 || stats.assemblyBytes + total > 512 * 1024) {
        reject();
        return;
      }
      a = { total, lane, bytes: new Uint8Array(total), seen: /* @__PURE__ */ new Set(), at: nowMs() };
      assemblies.set(key, a);
      stats.assemblyBytes += total;
    }
    if (a.total !== total || a.lane !== lane) {
      reject();
      return;
    }
    if (a.seen.has(offset)) {
      for (let i = 0; i < length; i++) if (a.bytes[offset + i] !== b[starHeader + i]) {
        reject();
        return;
      }
      return;
    }
    a.bytes.set(b.subarray(starHeader), offset);
    a.seen.add(offset);
    if (a.seen.size === 2) {
      assemblies.delete(key);
      stats.assemblyBytes -= total;
      deliver(from, id, a.bytes, lane);
    }
  }
  const timer = setInterval(pump, 16);
  timer.unref?.();
  const transports = /* @__PURE__ */ new Map();
  for (const remote of players.filter((id) => id !== localPlayerId)) {
    listeners.set(remote, /* @__PURE__ */ new Set());
    statusListeners.set(remote, /* @__PURE__ */ new Set());
    const physical = isHost ? remote : hostPlayerId;
    transports.set(remote, {
      get state() {
        return closed ? "closed" : physicalTransports.get(physical).state ?? "open";
      },
      send(data) {
        if (closed) return false;
        const payload = bytes(data);
        if (!payload.length || payload.length > CHUNK_SIZE) throw new RangeError("star packet size");
        sequence = sequence + 1 >>> 0 || 1;
        const id = sequence, frames = [];
        const lane = payload.length > 5 && [TYPE.INPUT, TYPE.CLOCK].includes(payload[5]) ? payload[5] : 1;
        for (let offset = 0; offset < payload.length; offset += starPayload) {
          const length = Math.min(starPayload, payload.length - offset), b = new Uint8Array(starHeader + length), v = new DataView(b.buffer);
          v.setUint32(0, starMagic, true);
          b[4] = 1;
          b[5] = lane;
          b[6] = local;
          b[7] = players.indexOf(remote);
          v.setUint32(8, tag, true);
          v.setUint32(12, id, true);
          v.setUint16(16, payload.length, true);
          v.setUint16(18, offset, true);
          v.setUint16(20, length, true);
          b.set(payload.subarray(offset, offset + length), starHeader);
          frames.push(b);
        }
        return enqueue(physical, frames, false);
      },
      subscribe(fn) {
        if (closed || typeof fn !== "function") throw new TypeError("star subscriber");
        const set = listeners.get(remote);
        set.add(fn);
        return () => set.delete(fn);
      },
      subscribeStatus(fn) {
        if (closed || typeof fn !== "function") throw new TypeError("star status subscriber");
        const set = statusListeners.get(remote);
        set.add(fn);
        return () => set.delete(fn);
      },
      close() {
        listeners.get(remote)?.clear();
        statusListeners.get(remote)?.clear();
      }
    });
  }
  try {
    for (const id of required) {
      const raw = physicalTransports.get(id);
      unsubs.push(raw.subscribe((data) => receive(id, data)));
      if (raw.subscribeStatus) unsubs.push(raw.subscribeStatus((state) => {
        for (const [remote, set] of statusListeners) if (!isHost || remote === id) for (const fn of set) {
          try {
            fn(state);
          } catch {
          }
        }
      }));
    }
  } catch (error) {
    close();
    throw error;
  }
  return { transports, close, get metrics() {
    return { ...stats };
  } };
}

// packages/transport/src/group-room.js
function groupRoomId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
async function createNostrGroupRoom({
  role,
  room,
  playerCount = 2,
  topology = "mesh",
  namespace = "rollback-netcode",
  relays,
  rtcConfig,
  timeoutMs = 6e4,
  onStatus = () => {
  },
  signal,
  signalerFactory = createNostrSignaler,
  peerFactory = createWebRTCPeer
} = {}) {
  if (!["host", "join"].includes(role) || !["mesh", "star"].includes(topology)) throw new TypeError("group room role/topology");
  integer(playerCount, "playerCount", 2, 8);
  integer(timeoutMs, "timeoutMs", 1, 12e4);
  if (typeof namespace !== "string" || !namespace.trim() || new TextEncoder().encode(namespace + ":group-v1").length > 128) throw new TypeError("group namespace");
  if ([onStatus, signalerFactory, peerFactory].some((fn) => typeof fn !== "function")) throw new TypeError("group room capability");
  if (signal?.aborted) throw new Error("group room aborted");
  const random = () => [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((v) => v.toString(16).padStart(2, "0")).join("");
  if (!room && role === "host") room = String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1e4).padStart(4, "0");
  if (!/^\d{4}$/.test(room ?? "")) throw new TypeError("four-digit room");
  const peerController = new AbortController(), signalController = new AbortController(), startedAt = nowMs();
  const earlyAbort = () => {
    peerController.abort();
    signalController.abort();
  };
  signal?.addEventListener("abort", earlyAbort, { once: true });
  let signaler;
  try {
    signaler = await signalerFactory({
      room,
      namespace: namespace + ":group-v1",
      relays,
      signal: signalController.signal,
      timeoutMs: Math.min(timeoutMs, 1e4),
      onStatus,
      maxVerificationsPerSecond: Math.max(16, playerCount * 4),
      verificationBurst: playerCount * 4
    });
    if (!groupRoomId(signaler?.id) || typeof signaler.send !== "function" || typeof signaler.subscribe !== "function" || typeof signaler.close !== "function") throw new TypeError("group signaler capability");
    if (signal?.aborted || signalController.signal.aborted) throw new Error("group room aborted");
  } catch (error) {
    earlyAbort();
    signaler?.close?.();
    signal?.removeEventListener("abort", earlyAbort);
    throw error;
  }
  signal?.removeEventListener("abort", earlyAbort);
  return new Promise((resolve, reject) => {
    const self = signaler.id, members = /* @__PURE__ */ new Set([self]), departed = /* @__PURE__ */ new Set(), acks = /* @__PURE__ */ new Set([self]), ready = /* @__PURE__ */ new Set(), starts = /* @__PURE__ */ new Set([self]);
    const peers = /* @__PURE__ */ new Map(), subscribers = /* @__PURE__ */ new Map(), backlog = /* @__PURE__ */ new Map(), controlPending = /* @__PURE__ */ new Map(), removers = [];
    let host = role === "host" ? self : null, sessionId = role === "host" ? random() : null, roster = null, rosterKey = "";
    let phase = role === "host" ? "checking" : "discovering", disposed = false, settled = false, connecting = false, localReady = false;
    let unsubscribe, interval, collisionTimer, deadline, router, backlogBytes = 0, startPublished = false;
    const status = (type, detail = {}) => {
      try {
        onStatus({ type, room, role, playerCount, topology, phase, ...detail });
      } catch {
      }
    };
    function message(op, extra = {}) {
      return { type: "group", version: 1, protocol: PROTOCOL_VERSION, op, host, sessionId, playerCount, topology, ...extra };
    }
    function dispose(reason, notify = true) {
      if (disposed) return;
      disposed = true;
      clearInterval(interval);
      clearTimeout(collisionTimer);
      clearTimeout(deadline);
      unsubscribe?.();
      signal?.removeEventListener("abort", abort);
      peerController.abort();
      removers.splice(0).forEach((fn) => fn());
      router?.close();
      peers.forEach((p) => p.close());
      peers.clear();
      subscribers.clear();
      backlog.clear();
      backlogBytes = 0;
      const finish2 = () => {
        signalController.abort();
        signaler.close();
      };
      if (notify && host && sessionId) {
        const grace = setTimeout(finish2, 1500);
        grace.unref?.();
        Promise.resolve().then(() => signaler.send(role === "host" ? "*" : host, message("leave", { reason }))).catch(() => {
        }).finally(() => {
          clearTimeout(grace);
          finish2();
        });
      } else finish2();
    }
    function fail(error, notify = true) {
      if (disposed) return;
      const value = error instanceof Error ? error : new Error(String(error));
      const former = phase;
      phase = "failed";
      dispose(value.message, notify);
      status("group-failed", { reason: value.message, previousPhase: former });
      if (!settled) {
        settled = true;
        reject(value);
      }
    }
    function abort() {
      fail(new Error("group room aborted"));
    }
    function send(to, op, extra = {}) {
      if (disposed) return Promise.resolve();
      const key = to + ":" + op;
      if (controlPending.has(key)) return controlPending.get(key);
      if (controlPending.size >= 32) return Promise.resolve();
      const pending = Promise.resolve().then(() => {
        if (!disposed) return signaler.send(to, message(op, extra));
      }).catch((error) => {
        fail(error);
      }).finally(() => controlPending.delete(key));
      controlPending.set(key, pending);
      return pending;
    }
    function close() {
      if (disposed) return;
      const pending = !settled;
      phase = "closed";
      dispose("room closed");
      status("group-closed");
      if (pending) {
        settled = true;
        reject(new Error("group room closed"));
      }
    }
    function finish() {
      if (disposed || settled || !localReady) return;
      settled = true;
      phase = "running";
      clearTimeout(deadline);
      clearInterval(interval);
      const physical = new Map([...peers].map(([id, peer]) => [id, peer.transport]));
      status("group-started", { players: [...roster], localPlayerId: self });
      if (disposed) {
        reject(new Error("group room closed by observer"));
        return;
      }
      resolve({
        room,
        sessionId,
        playerCount,
        topology,
        players: Object.freeze([...roster]),
        localPlayerId: self,
        authorityPlayerId: host,
        hostPlayerId: host,
        transports: new Map(router?.transports ?? physical),
        peerConnections: new Map([...peers].map(([id, peer]) => [id, peer.peerConnection])),
        get closed() {
          return disposed;
        },
        get metrics() {
          return router?.metrics ?? null;
        },
        close
      });
    }
    function hostProgress() {
      if (disposed || role !== "host" || !roster) return;
      if (phase === "roster" && acks.size === playerCount) {
        phase = "connecting";
        connect();
        send("*", "connect", { rosterKey });
      }
      if (phase === "connecting" && ready.size === playerCount) {
        phase = "starting";
        send("*", "start", { rosterKey }).then(() => {
          startPublished = true;
          hostProgress();
        });
      }
      if (phase === "starting" && startPublished && starts.size === playerCount) finish();
    }
    function wantedPeers() {
      return roster.filter((id) => id !== self && (topology === "mesh" || self === host || id === host));
    }
    function scopedSignaler(remote) {
      return {
        id: self,
        send(to, payload) {
          if (disposed || to !== remote) return Promise.reject(new Error("group peer scope"));
          return signaler.send(to, { ...payload, groupSession: sessionId });
        },
        subscribe(fn) {
          const set = subscribers.get(remote) ?? /* @__PURE__ */ new Set();
          subscribers.set(remote, set);
          set.add(fn);
          const queued = backlog.get(remote) ?? [];
          backlog.delete(remote);
          for (const item of queued) {
            backlogBytes -= item.size;
            if (!disposed) fn(item.envelope);
          }
          return () => set.delete(fn);
        },
        close() {
        }
      };
    }
    function connect() {
      if (disposed || connecting || !roster) return;
      connecting = true;
      phase = "connecting";
      status("group-connecting", { players: [...roster] });
      if (disposed) return;
      Promise.all(wantedPeers().map((remote) => Promise.resolve().then(() => {
        if (disposed) throw new Error("group room closed");
        return peerFactory({
          initiator: compareIds(self, remote) > 0,
          signaler: scopedSignaler(remote),
          remoteId: remote,
          rtcConfig,
          timeoutMs: Math.min(timeoutMs, 3e4),
          onStatus: (event) => status("group-peer", { peerId: remote, event }),
          signal: peerController.signal
        });
      }).then((peer) => {
        if (disposed) {
          peer.close();
          return;
        }
        if (!peer?.transport?.send || !peer.transport.subscribe || typeof peer.close !== "function") throw new TypeError("group peer capability");
        peers.set(remote, peer);
        if (peer.transport.subscribeStatus) removers.push(peer.transport.subscribeStatus((state) => {
          if (!disposed && (state === "closed" || state === "failed" || !settled && state === "interrupted")) fail(new Error("group peer unavailable: " + remote));
        }));
      }))).then(() => {
        if (disposed) return;
        if ([...peers.values()].some((p) => p.transport.state && p.transport.state !== "open")) throw new Error("group transport not open");
        if (topology === "star") router = createStarTransports({
          players: roster,
          localPlayerId: self,
          hostPlayerId: host,
          sessionId,
          physicalTransports: new Map([...peers].map(([id, p]) => [id, p.transport])),
          onError: fail
        });
        localReady = true;
        status("group-ready", { players: [...roster] });
        if (disposed) return;
        if (role === "host") {
          ready.add(self);
          hostProgress();
        } else send(host, "ready", { rosterKey });
      }).catch(fail);
    }
    function publishRoster() {
      send("*", "roster", { players: roster, rosterKey });
    }
    function advertise(to = "*") {
      send(to, "hello", { accepting: phase === "collecting", memberCount: members.size });
    }
    function acceptRoster(from, m) {
      if (from !== host || !Array.isArray(m.players) || m.players.length !== playerCount || m.players.some((id) => !groupRoomId(id)) || new Set(m.players).size !== playerCount || !m.players.includes(self) || !m.players.includes(host) || m.players.join("\n") !== [...m.players].sort(compareIds).join("\n") || m.rosterKey !== m.players.join("\n")) {
        fail(new Error("invalid group roster"));
        return;
      }
      if (roster && rosterKey !== m.rosterKey) {
        fail(new Error("group roster changed"));
        return;
      }
      if (!roster) {
        roster = Object.freeze([...m.players]);
        rosterKey = m.rosterKey;
        phase = "roster";
        status("group-roster", { players: [...roster] });
      }
      send(host, "ack", { rosterKey });
    }
    function receive(envelope) {
      if (disposed || !envelope || envelope.from === self || !groupRoomId(envelope.from) || !["*", self].includes(envelope.to) || !envelope.message || typeof envelope.message !== "object") return;
      const { from, to, message: m } = envelope;
      if (["offer", "answer", "ice", "bye"].includes(m.type)) {
        if (!roster || to !== self || m.groupSession !== sessionId || !wantedPeers().includes(from)) return;
        const set = subscribers.get(from);
        if (set?.size) {
          for (const fn of set) fn(envelope);
          return;
        }
        const size = encoder.encode(JSON.stringify(m)).length, queued = backlog.get(from) ?? [];
        if (queued.length >= 32 || backlogBytes + size > 2 * 1024 * 1024) {
          fail(new Error("group signaling backlog capacity"));
          return;
        }
        queued.push({ envelope, size });
        backlog.set(from, queued);
        backlogBytes += size;
        return;
      }
      if (m.type !== "group" || m.version !== 1 || m.protocol !== PROTOCOL_VERSION) return;
      if (role === "host" && m.op === "hello" && m.host === from) {
        if (["checking", "collecting"].includes(phase)) fail(new Error("room code is already in use"));
        else if (m.accepting !== false) advertise(from);
        return;
      }
      if (role === "join" && m.op === "hello" && m.host === from && groupRoomId(m.sessionId)) {
        if (host && (host !== from || sessionId !== m.sessionId)) return;
        if (m.playerCount !== playerCount || m.topology !== topology) {
          fail(new Error("group playerCount/topology mismatch"), false);
          return;
        }
        const selected = !!host;
        if (!host) {
          host = from;
          sessionId = m.sessionId;
        }
        if (!roster) {
          if (m.accepting === false && !selected) {
            fail(new Error("group room is full or already started"), false);
            return;
          }
          send(host, "join");
        }
        return;
      }
      if (role === "host" && m.op === "discover") {
        if (phase !== "checking") advertise(from);
        return;
      }
      if (m.host !== host || m.sessionId !== sessionId || m.playerCount !== playerCount || m.topology !== topology) return;
      if (role === "host") {
        if (m.op === "join") {
          if (members.has(from)) {
            if (roster) publishRoster();
            return;
          }
          if (phase !== "collecting" || departed.has(from)) {
            send(from, "reject", { reason: "group room is full or already started" });
            return;
          }
          members.add(from);
          status("group-members", { players: [...members].sort(compareIds) });
          if (disposed) return;
          if (members.size === playerCount) {
            roster = Object.freeze([...members].sort(compareIds));
            rosterKey = roster.join("\n");
            phase = "roster";
            status("group-roster", { players: [...roster] });
            publishRoster();
          }
        } else if (m.op === "leave" && members.has(from)) {
          if (phase === "collecting") {
            members.delete(from);
            departed.add(from);
            if (departed.size > 64) fail(new Error("group membership churn limit"));
            else status("group-members", { players: [...members].sort(compareIds) });
          } else fail(new Error("group participant left"));
        } else if (roster?.includes(from) && m.rosterKey === rosterKey) {
          if (m.op === "ack") acks.add(from);
          if (m.op === "ready" && ["connecting", "starting"].includes(phase)) ready.add(from);
          if (m.op === "start-ack" && phase === "starting") starts.add(from);
          hostProgress();
        }
      } else if (from === host) {
        if (m.op === "reject") fail(new Error(String(m.reason || "group rejected")), false);
        else if (m.op === "leave") fail(new Error("group host left"), false);
        else if (m.op === "roster") acceptRoster(from, m);
        else if (roster && m.rosterKey === rosterKey) {
          if (m.op === "connect") {
            connect();
            if (localReady) send(host, "ready", { rosterKey });
          }
          if (m.op === "start" && localReady) send(host, "start-ack", { rosterKey }).then(finish);
        }
      }
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    unsubscribe = signaler.subscribe(receive);
    if (disposed) {
      unsubscribe?.();
      return;
    }
    const remaining = timeoutMs - (nowMs() - startedAt);
    if (remaining <= 0) {
      fail(new Error("group room timeout"));
      return;
    }
    deadline = setTimeout(() => fail(new Error("group room timeout: " + phase)), remaining);
    interval = setInterval(() => {
      if (disposed) return;
      if (role === "host") {
        if (phase === "collecting") advertise();
        else if (phase === "roster") publishRoster();
        else if (phase === "connecting") send("*", "connect", { rosterKey });
        else if (phase === "starting") send("*", "start", { rosterKey }).then(() => {
          startPublished = true;
          hostProgress();
        });
      } else if (!host) send("*", "discover");
      else if (!roster) send(host, "join");
      else if (!connecting) send(host, "ack", { rosterKey });
      else if (localReady) send(host, "ready", { rosterKey });
    }, 1e3);
    status("room");
    if (disposed) return;
    if (role === "host") collisionTimer = setTimeout(() => {
      if (!disposed) {
        phase = "collecting";
        advertise();
      }
    }, 1200);
    else send("*", "discover");
  });
}
export {
  WebRTCTransport,
  createNostrGroupRoom,
  createNostrRoom,
  createNostrSignaler,
  createWebRTCPeer,
  nostrCrypto
};
