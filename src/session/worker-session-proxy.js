import { CONFIG } from '../core/config.js';

// Main-thread stand-in for the AI GameSession in SimWorkerHost. It keeps the AI's
// real WebRTC transport here, relays its traffic to the Worker, mirrors the state
// the UI and recovery read (every STATUS_MS and after each call) and forwards
// session calls. Forwarded calls answer true once sent; the outcome arrives as status.
export class WorkerSessionProxy {
    static TRANSPORT_CALLS = new Set([
        'prepareRecoveryHost',
        'rebuildRecoveryGuest',
        'forceReconnect',
    ]);
    constructor(role, transport, token, config, deck) {
        this.role = role;
        this.roomCode = token;
        this.transport = transport;
        this.sim = null;
        this.netcodeSession = null;
        this.performanceStats = { timings: {} };
        this.statusMessages = 0;
        this.simEnded = false;
        this.disposed = false;
        this.transportConnected = false;
        this.syncHold = true;
        this.simpleRecoverySeq = 0;
        this.localVisible = true;
        this.recoveryPhase = 'idle';
        this.simpleRecoveryNeedsManual = false;
        this.simpleRecoveryToken = '';
        this.onFatal = () => {};
        this.pending = new Map();
        this.nextCallId = 0;
        this.started = false;
        this.outbox = [];
        this.ready = new Promise((resolve) => (this.resolveReady = resolve));
        // Relay traffic for diagnostics: control messages are structured-cloned, netcode packets are moved.
        this.traffic = {
            sentMessages: 0,
            sentPackets: 0,
            sentPacketBytes: 0,
            receivedMessages: 0,
            receivedPackets: 0,
            receivedPacketBytes: 0,
        };
        transport.onMessage = (data) => {
            this.traffic.receivedMessages++;
            this.toTransport('message', { data });
        };
        this.detachTransport = [
            transport.subscribeNetcode((packet) => {
                const copy = packet.slice();
                this.traffic.receivedPackets++;
                this.traffic.receivedPacketBytes += copy.byteLength;
                this.toTransport('packet', { data: copy }, [copy.buffer]);
            }),
            transport.subscribeNetcodeStatus((state) =>
                this.toTransport('netcode-state', { state }),
            ),
        ];
        this.worker = new Worker(new URL('../sim-worker.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e) => {
            const m = e.data;
            if (m?.type === 'ready') {
                // The WebRTC link may open before the Worker is ready; hold what it sent until then.
                // The Worker realm has its own CONFIG: hand it the page's sync mode, or both peers fail the handshake.
                this.worker.postMessage({
                    type: 'start',
                    role,
                    token,
                    config,
                    netcodeState: transport.netcodeState,
                    netcodeMode: CONFIG.netcode.mode,
                    deck,
                });
                this.started = true;
                for (const [message, transfer] of this.outbox)
                    this.worker.postMessage(message, transfer);
                this.outbox.length = 0;
                this.resolveReady();
            } else if (m?.type === 'transport') this.fromTransport(m);
            else if (m?.type === 'status') this.applyStatus(m);
            else if (m?.type === 'result') {
                this.pending.get(m.id)?.(m.result);
                this.pending.delete(m.id);
            } else if (m?.type === 'fatal' || m?.type === 'error') this.onFatal(m);
        };
        this.worker.onerror = (e) => this.onFatal({ message: e.message || 'worker error' });
    }
    post(message, transfer = []) {
        if (this.started) this.worker.postMessage(message, transfer);
        else this.outbox.push([message, transfer]);
    }
    toTransport(event, payload, transfer) {
        if (!this.disposed) this.post({ type: 'transport', event, ...payload }, transfer);
    }
    fromTransport({ op, data, method, args }) {
        if (this.disposed) return;
        if (op === 'send') {
            if (this.transport.send(data)) this.traffic.sentMessages++;
        } else if (op === 'send-netcode') {
            if (this.transport.sendNetcode(data)) {
                this.traffic.sentPackets++;
                this.traffic.sentPacketBytes += data.byteLength;
            }
        } else if (op === 'call' && WorkerSessionProxy.TRANSPORT_CALLS.has(method))
            this.transport[method]?.(...(args || []));
    }
    // The single-player wiring calls these from the AI transport's onOpen/onClose, as for a GameSession.
    onTransportOpen() {
        this.toTransport('open', { visible: this.localVisible });
    }
    onTransportClosed() {
        this.toTransport('close');
    }
    applyStatus(m) {
        this.statusMessages++;
        this.simEnded = m.simEnded;
        this.transportConnected = m.transportConnected;
        this.performanceStats.timings = m.timings;
        this.recoveryPhase = m.recovery.phase;
        this.simpleRecoveryNeedsManual = m.recovery.needsManual;
        this.simpleRecoveryToken = m.recovery.token;
        this.syncHold = m.recovery.syncHold;
        // Readers test sim/netcodeSession presence and identity the way they do for an in-page session.
        if (m.tick > 0 || m.perfStats) {
            this.sim ||= { tick: 0, perfStats: null };
            this.sim.tick = m.tick;
            this.sim.perfStats = m.perfStats;
        }
        this.netcodeSession = m.netcode;
    }
    forward(method, args = []) {
        if (this.disposed) return false;
        this.post({ type: 'call', method, args });
        return true;
    }
    request(method, args = []) {
        if (this.disposed) return Promise.resolve(null);
        const id = ++this.nextCallId;
        return new Promise((resolve) => {
            this.pending.set(id, resolve);
            this.post({ type: 'call', id, method, args });
        });
    }
    setTestModePaused(paused) {
        return this.forward('setTestModePaused', [!!paused]);
    }
    setLocalVisibility(visible) {
        this.localVisible = !!visible;
        this.forward('setLocalVisibility', [!!visible]);
    }
    markManualRecoveryNeeded(reason) {
        return !!this.sim && !this.simEnded && this.forward('markManualRecoveryNeeded', [reason]);
    }
    prepareSimpleRecovery(token, reason) {
        return (
            !!this.sim && !this.simEnded && this.forward('prepareSimpleRecovery', [token, reason])
        );
    }
    startSimpleRecovery(reason) {
        return !!this.sim && !this.simEnded && this.forward('startSimpleRecovery', [reason]);
    }
    balanceTelemetry() {
        return this.request('balanceTelemetry');
    }
    dispose(reason) {
        if (this.disposed) return false;
        this.disposed = true;
        this.worker.postMessage({ type: 'dispose', reason });
        for (const resolve of this.pending.values()) resolve(null);
        this.pending.clear();
        for (const detach of this.detachTransport) detach();
        const t = this.transport;
        t.onMessage = () => {};
        t.onOpen = () => {};
        t.onClose = () => {};
        t.onPeerReady = () => {};
        t.onError = () => {};
        t.close();
        // The Worker closes itself after disposing; terminate covers a stuck one.
        setTimeout(() => this.worker.terminate(), 1000);
        return true;
    }
}
