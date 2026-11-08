// Dedicated AI peer entry. Install error forwarding before loading pinned GameKit.
function reportFatal(error) {
    self.postMessage({
        type: 'fatal',
        message: String(error?.message || error),
        stack: String(error?.stack || ''),
    });
}

self.__RALLY_PRESENT_FATAL__ = reportFatal;
self.addEventListener('unhandledrejection', (event) => reportFatal(event.reason));
self.addEventListener('error', (event) => reportFatal(event.error || event.message));

try {
    const { SimWorkerHost } = await import('./session/sim-worker-host.js');
    SimWorkerHost.install(reportFatal);
} catch (error) {
    reportFatal(error);
}
