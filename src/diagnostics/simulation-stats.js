function createLocalPerfStats() {
    return {
        sampleTick: 0,
        totalMs: 0,
        indexMs: 0,
        worldMs: 0,
        visionMs: 0,
        combatMs: 0,
        projectileMs: 0,
        collisionMs: 0,
        collisionPrepMs: 0,
        collisionGridBuildMs: 0,
        collisionPairScanMs: 0,
        collisionSoftApplyMs: 0,
        collisionSweptMotionMs: 0,
        collisionTerrainMs: 0,
        collisionHardFixMs: 0,
        collisionOtherMs: 0,
        collisionSoftPasses: 0,
        collisionSoftContacts: 0,
        collisionSoftMovedUnits: 0,
        collisionSoftCappedUnits: 0,
        collisionSoftDetailedSamples: 0,
        collisionSweptCalls: 0,
        collisionSweptActivePasses: 0,
        collisionSweptZeroMotionCalls: 0,
        collisionSweptEmptyPasses: 0,
        collisionSweptPairTests: 0,
        collisionSweptHits: 0,
        collisionSweptCorrectionUnits: 0,
        collisionSweptNoCorrectionPasses: 0,
        collisionHardFixCalls: 0,
        collisionHardFixPasses: 0,
        collisionHardFixActivePairTests: 0,
        collisionHardFixCandidates: 0,
        collisionHardFixCorrections: 0,
        collisionHardFixNoOpCalls: 0,
        combatTargetPickMs: 0,
        combatTargetPickCalls: 0,
        combatOtherMs: 0,
        postMs: 0,
        snapshotMs: 0,
        snapshotCumulativeMs: 0,
        maxSnapshotMs: 0,
        snapshotSamples: 0,
        lastStepMs: 0,
        stepSamples: 0,
        stepCumulativeMs: 0,
        maxStepMs: 0,
        ewmaStepMs: 0,
        aliveUnits: 0,
        combatUnits: 0,
        projectiles: 0,
        peakAliveUnits: 0,
        peakBuildings: 0,
        peakProjectiles: 0,
        spatialQueries: 0,
        spatialCandidates: 0,
        targetQueries: 0,
        targetVisibilityRejects: 0,
        sideSpatialQueries: 0,
        visibilityChecks: 0,
        collisionPairs: 0,
        collisionOverlaps: 0,
        buildingCollisionCandidates: 0,
    };
}
function createLocalBalanceStats() {
    return {
        startedTick: 0,
        lastSampleTick: 0,
        firstCombatTick: null,
        firstCaptureTick: [null, null],
        captures: [0, 0],
        buildingLosses: [0, 0],
        outpostLosses: [0, 0],
        samples: 0,
        armyTotal: [0, 0],
        armyPeak: [0, 0],
        currentArmy: [0, 0],
        gameEndTick: null,
        winner: null,
        history: [],
    };
}

function recordTiming(stats, key, ms) {
    const row =
        stats[key] ||
        (stats[key] = { samples: 0, currentMs: 0, cumulativeMs: 0, ewmaMs: 0, maxMs: 0 });
    row.currentMs = Math.max(0, ms);
    row.cumulativeMs = (row.cumulativeMs || 0) + row.currentMs;
    row.ewmaMs = row.samples ? row.ewmaMs * 0.85 + row.currentMs * 0.15 : row.currentMs;
    row.maxMs = Math.max(row.maxMs, row.currentMs);
    row.samples++;
}

function measureSessionPulse(session, now) {
    const stats = session.performanceStats;
    if (!stats || !session.sim || session.simEnded || session.simulationFatal)
        return session.advanceSimulation(now);
    const started = performance.now();
    if (stats.lastPulseAt !== null)
        recordTiming(stats.timings, 'pulseGap', started - stats.lastPulseAt);
    stats.lastPulseAt = started;
    try {
        return session.advanceSimulation(now);
    } finally {
        recordTiming(stats.timings, 'pulse', performance.now() - started);
    }
}

function balanceTelemetrySnapshot(sim) {
    if (!sim) return null;
    const b = structuredClone(sim.balanceStats || createLocalBalanceStats());
    b.tick = sim.tick;
    b.seconds = sim.tick / sim.tps;
    b.averageArmy = [0, 1].map((side) => (b.samples ? b.armyTotal[side] / b.samples : 0));
    b.currentWallet = sim.wallet.slice();
    b.checksum = sim.checksum();
    return b;
}

export {
    balanceTelemetrySnapshot,
    createLocalBalanceStats,
    createLocalPerfStats,
    measureSessionPulse,
    recordTiming,
};
