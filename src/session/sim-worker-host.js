import { BotController } from '../ai/bot-controller.js';
import { setNetcodeMode } from '../core/config.js';
import { BACKGROUND_TICK_PULSE_MS } from '../core/session-timing.js';
import { measureSessionPulse } from '../diagnostics/simulation-stats.js';
import { GameSession } from './game-session.js';

// Worker side of a single-player AI peer: the same GameSession + BotController
// as the in-page path. Its transport is a mirror of the AI's real WebRTC
// transport, which stays on the main thread (Workers have no RTCPeerConnection).
export class SimWorkerHost {
    static STATUS_MS = 250;
    // Session calls the main thread may forward.
    static SESSION_CALLS = new Set([
        'setTestModePaused',
        'setLocalVisibility',
        'markManualRecoveryNeeded',
        'prepareSimpleRecovery',
        'startSimpleRecovery',
        'balanceTelemetry',
    ]);
    static session = null;
    static bot = null;
    static transport = null;
    static statusTimer = 0;
    static pulseTimer = 0;
    static install(reportFatal) {
        self.onmessage = (e) => {
            const m = e.data;
            if (m?.type === 'start') this.start(m, reportFatal);
            else if (m?.type === 'transport') this.transport?.receive(m);
            else if (m?.type === 'call') this.call(m);
            else if (m?.type === 'dispose') this.dispose(m.reason);
        };
        self.postMessage({ type: 'ready' });
    }
    static start({ role, token, config, netcodeState, netcodeMode, deck }, reportFatal) {
        if (netcodeMode) setNetcodeMode(netcodeMode);
        const transport = new WorkerRelayTransport(role, token, netcodeState),
            session = new GameSession(role, transport, token, config ?? undefined, deck);
        this.transport = transport;
        this.session = session;
        session.onSimulationStarted = () => this.startPulsing(session);
        session.onSimulationStopped = () => this.stopPulsing();
        session.onSimulationFatal = reportFatal;
        this.bot = BotController.attach(session, role);
        transport.onOpen = (visible) => {
            session.localVisible = visible;
            session.onTransportOpen();
        };
        transport.onClose = () => session.onTransportClosed();
        this.statusTimer = setInterval(() => this.publishStatus(), this.STATUS_MS);
    }
    static startPulsing(session) {
        if (this.pulseTimer) return;
        const pulse = () => {
            const started = performance.now();
            try {
                measureSessionPulse(session, started);
            } catch (error) {
                session.enterSimulationFatal(error, { source: 'background-pulse' });
            } finally {
                if (this.pulseTimer) {
                    this.pulseTimer = setTimeout(
                        pulse,
                        Math.max(1, BACKGROUND_TICK_PULSE_MS - (performance.now() - started)),
                    );
                }
            }
        };
        this.pulseTimer = setTimeout(pulse, BACKGROUND_TICK_PULSE_MS);
    }
    static stopPulsing() {
        clearTimeout(this.pulseTimer);
        this.pulseTimer = 0;
    }
    static call({ id, method, args }) {
        let result = null;
        if (this.session && this.SESSION_CALLS.has(method))
            try {
                result = this.session[method](...(args || []));
            } catch (error) {
                self.postMessage({
                    type: 'error',
                    message: String(error?.message || error),
                    error: error instanceof Error ? error : String(error),
                });
            }
        if (id) self.postMessage({ type: 'result', id, result: result ?? null });
        this.publishStatus();
    }
    static publishStatus() {
        const s = this.session;
        if (!s) return;
        const core = s.netcodeSession;
        self.postMessage({
            type: 'status',
            tick: s.sim?.tick ?? 0,
            simEnded: !!s.simEnded,
            transportConnected: !!s.transportConnected,
            perfStats: s.sim?.perfStats || null,
            timings: s.performanceStats?.timings || {},
            netcode: core
                ? { ready: !!core.ready, status: core.status, metrics: core.metrics }
                : null,
            recovery: {
                phase: s.recoveryPhase || 'idle',
                needsManual: !!s.simpleRecoveryNeedsManual,
                token: s.simpleRecoveryToken || '',
                syncHold: !!s.syncHold,
            },
        });
    }
    static dispose(reason) {
        clearInterval(this.statusTimer);
        this.stopPulsing();
        this.bot?.stop();
        try {
            this.session?.dispose(reason);
        } finally {
            this.session = null;
            this.bot = null;
            this.transport = null;
            self.close();
        }
    }
}
// The Worker session's view of the AI's main-thread WebRTC transport: state is
// mirrored from WorkerSessionProxy, sends and recovery calls are relayed to it.
class WorkerRelayTransport {
    constructor(role, roomCode, netcodeState) {
        this.role = role;
        this.roomCode = roomCode;
        this.connected = false;
        this.netcodeState = netcodeState || 'closed';
        this.netcodeListeners = new Set();
        this.netcodeStatusListeners = new Set();
        this.onMessage = () => {};
        this.onPeerReady = () => {};
        this.onOpen = () => {};
        this.onClose = () => {};
        this.onError = () => {};
    }
    receive({ event, data, state, visible }) {
        if (event === 'open') {
            this.connected = true;
            this.onOpen(visible);
        } else if (event === 'close') {
            this.connected = false;
            this.onClose();
        } else if (event === 'message') this.onMessage(data);
        else if (event === 'packet')
            for (const listener of this.netcodeListeners) {
                try {
                    listener(data);
                } catch (error) {
                    this.onError(error);
                }
            }
        else if (event === 'netcode-state') {
            this.netcodeState = state;
            for (const listener of this.netcodeStatusListeners) listener(state);
        }
    }
    relay(op, payload, transfer) {
        self.postMessage({ type: 'transport', op, ...payload }, transfer || []);
    }
    isOpen() {
        return this.connected;
    }
    isNetcodeOpen() {
        return this.netcodeState === 'open';
    }
    get netcodeBufferedAmount() {
        return 0;
    }
    send(message) {
        if (!this.connected) return false;
        this.relay('send', { data: message });
        return true;
    }
    sendNetcode(packet) {
        if (!(packet instanceof Uint8Array) || !this.isNetcodeOpen()) return false;
        const copy = packet.slice();
        this.relay('send-netcode', { data: copy }, [copy.buffer]);
        return true;
    }
    subscribeNetcode(listener) {
        this.netcodeListeners.add(listener);
        return () => this.netcodeListeners.delete(listener);
    }
    subscribeNetcodeStatus(listener) {
        this.netcodeStatusListeners.add(listener);
        return () => this.netcodeStatusListeners.delete(listener);
    }
    prepareRecoveryHost(reason) {
        this.relay('call', { method: 'prepareRecoveryHost', args: [reason] });
        return this.role === 'host';
    }
    rebuildRecoveryGuest(reason) {
        this.relay('call', { method: 'rebuildRecoveryGuest', args: [reason] });
        return this.role === 'guest';
    }
    forceReconnect(reason) {
        this.relay('call', { method: 'forceReconnect', args: [reason] });
        return true;
    }
    // The main thread owns the WebRTC transport and closes it with the proxy.
    close() {
        this.netcodeListeners.clear();
        this.netcodeStatusListeners.clear();
    }
}
