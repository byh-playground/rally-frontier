const RECOVERY_EVENT_LIMIT = 300;
const events = [];
let sequence = 0;

function recoveryTransportState(transport) {
    const room = transport?.room;
    const peerConnection = room?.peerConnection;
    return {
        role: transport?.role || null,
        roomCode: transport?.roomCode || null,
        peerId: room?.peerId || null,
        roomState: room?.state || 'idle',
        generation: Number(room?.generation) || 0,
        connOpen: !!transport?.isOpen?.(),
        netcodeState: transport?.netcodeState || 'closed',
        rtcConnectionState: peerConnection?.connectionState || null,
        iceConnectionState: peerConnection?.iceConnectionState || null,
        iceGatheringState: peerConnection?.iceGatheringState || null,
        signalingState: peerConnection?.signalingState || null,
    };
}

function recoverySessionState(session) {
    return {
        role: session?.role || null,
        roomCode: session?.roomCode || null,
        tick: session?.sim?.tick ?? null,
        runtimeSeq: Number(session?.runtimeSeq) || 0,
        transportConnected: !!session?.transportConnected,
        syncHold: !!session?.syncHold,
        recoveryPhase: session?.recoveryPhase || 'idle',
        simulationFatal: !!session?.simulationFatal,
        fatalMessage: session?.simulationFatalInfo?.message || '',
        simpleToken: session?.simpleRecoveryToken || '',
        manualNeeded: !!session?.simpleRecoveryNeedsManual,
    };
}

export function recordRecovery(type, session = null, transport = null, extra = {}) {
    const sessionState = recoverySessionState(session);
    const transportState = recoveryTransportState(transport || session?.transport);
    const event = {
        seq: ++sequence,
        wallTime: new Date().toISOString(),
        wallMs: Date.now(),
        perfMs: Math.round(performance.now()),
        visibility: globalThis.document?.visibilityState ?? null,
        type,
        session: sessionState,
        transport: transportState,
        ...extra,
    };
    events.push(event);
    if (events.length > RECOVERY_EVENT_LIMIT) events.shift();
    return event;
}
