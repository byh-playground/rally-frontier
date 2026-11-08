// Browser runtime sampling and downloads.
import { recordTiming } from './simulation-stats.js';
import { ActiveViewState } from '../session/runtime-state.js';
import { PRODUCT_VERSION } from '../core/product-version.js';
import { BUILD_META } from '../core/build-info.js';
import { LogUtil, MatchLifecycle, SinglePlayerModeUtil } from '../main.js';

class PerformanceTelemetry {
    static runtimeMonitor = null;
    static startRuntimeMonitor() {
        if (this.runtimeMonitor) return;
        const m = (this.runtimeMonitor = {
            timings: {},
            longTasks: 0,
            longTaskMs: 0,
            maxLongTaskMs: 0,
            lastLongTaskAt: null,
            observer: null,
            timer: 0,
        });
        let expectedAt = performance.now() + 250;
        m.timer = setInterval(() => {
            const now = performance.now();
            recordTiming(m.timings, 'eventLoop', now - expectedAt);
            expectedAt = now + 250;
        }, 250);
        if (globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
            m.observer = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                    m.longTasks++;
                    m.longTaskMs = e.duration;
                    m.maxLongTaskMs = Math.max(m.maxLongTaskMs, e.duration);
                    m.lastLongTaskAt = e.startTime + e.duration;
                }
            });
            m.observer.observe({ type: 'longtask', buffered: false });
        }
    }
    static stopRuntimeMonitor() {
        const m = this.runtimeMonitor;
        if (!m) return;
        clearInterval(m.timer);
        m.observer?.disconnect();
        this.runtimeMonitor = null;
    }
    static async sampleConnection(session) {
        const stats = session.performanceStats,
            pc = session.transport?.room?.peerConnection,
            now = performance.now();
        if (session.performanceIceConnection !== pc) {
            session.performanceIceConnection = pc;
            stats.iceRttMs = null;
            stats.iceFetchedAt = null;
            stats.iceError = null;
            stats.iceRequestedAt = -1000;
        }
        if (
            !pc?.getStats ||
            stats.icePending ||
            now - stats.iceRequestedAt < 1000 ||
            session.disposed
        )
            return;
        stats.iceRequestedAt = now;
        stats.icePending = true;
        try {
            const report = await pc.getStats();
            if (session.disposed || session.transport?.room?.peerConnection !== pc) return;
            let pair = null;
            for (const row of report.values())
                if (row.type === 'transport' && row.selectedCandidatePairId)
                    pair = report.get(row.selectedCandidatePairId) || pair;
            if (!pair)
                for (const row of report.values())
                    if (
                        row.type === 'candidate-pair' &&
                        row.state === 'succeeded' &&
                        row.nominated
                    ) {
                        pair = row;
                        break;
                    }
            stats.iceRttMs = Number.isFinite(pair?.currentRoundTripTime)
                ? pair.currentRoundTripTime * 1000
                : null;
            stats.iceFetchedAt = performance.now();
            stats.iceError = null;
        } catch (error) {
            if (!session.disposed && session.transport?.room?.peerConnection === pc) {
                stats.iceRttMs = null;
                stats.iceFetchedAt = performance.now();
                stats.iceError = String(error.message || error);
            }
        } finally {
            stats.icePending = false;
        }
    }
    static exportTimingTelemetry() {
        const active = MatchLifecycle.activeSession?.();
        if (!active?.sim) return;
        const sessions = SinglePlayerModeUtil.isSinglePlayer()
            ? MatchLifecycle.singleMatch.sessions
            : { [active.role]: active };
        const m = this.runtimeMonitor;
        const payload = {
            exportedAt: new Date().toISOString(),
            build: BUILD_META.id,
            buildMetadata: BUILD_META.snapshot(),
            gameVersion: PRODUCT_VERSION,
            visibility: document.visibilityState,
            note: 'Local timings only. Nested timings overlap. App RTT includes browser message handling; ICE RTT is a separate sample. GPU begin time is CPU API cost. Collision details are sampled once per second; allied soft-contact counters describe that sampled tick.',
            mainThread: m
                ? {
                      timings: m.timings,
                      longTasks: m.longTasks,
                      lastLongTaskMs: m.longTaskMs,
                      maxLongTaskMs: m.maxLongTaskMs,
                  }
                : null,
            renderer: ActiveViewState.renderer?.perfStats || null,
            sessions: Object.fromEntries(
                Object.entries(sessions).map(([role, s]) => [
                    role,
                    {
                        tick: s.sim?.tick,
                        mode: s.netcodeMode,
                        status: s.netcodeSession?.status,
                        timings: s.performanceStats,
                        simulation: s.sim?.perfStats,
                        core: s.netcodeSession?.metrics,
                        bufferedBytes: s.transport?.netcodeBufferedAmount || 0,
                    },
                ]),
            ),
        };
        const url = URL.createObjectURL(
            new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
        );
        const a = document.createElement('a');
        a.href = url;
        a.download = `ssalkongpang-performance-${Date.now()}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    static async exportBalanceTelemetry() {
        const active = MatchLifecycle.activeSession?.();
        if (!active?.sim) return;
        const sessions = {};
        if (SinglePlayerModeUtil.isSinglePlayer() && MatchLifecycle.singleMatch?.sessions) {
            // A Worker-hosted AI session answers asynchronously.
            for (const r of ['host', 'guest']) {
                const sess = MatchLifecycle.singleMatch.sessions[r];
                if (sess?.sim) sessions[r] = await sess.balanceTelemetry();
            }
        } else {
            sessions[active.role || ActiveViewState.role || 'local'] = active.balanceTelemetry();
        }
        const payload = {
            exportedAt: new Date().toISOString(),
            build: BUILD_META.id,
            buildMetadata: BUILD_META.snapshot(),
            gameVersion: PRODUCT_VERSION,
            roomCode: active.roomCode || null,
            localOnly: true,
            note: 'Balance telemetry is diagnostics-only and excluded from checksum/exportState/recovery authority.',
            sessions,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ssalkongpang-balance-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        LogUtil.log('밸런스 계측 JSON 저장 · authoritative state에는 포함되지 않음');
    }
}

export { PerformanceTelemetry };
