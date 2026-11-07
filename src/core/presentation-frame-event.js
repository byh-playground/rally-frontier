import { RallyGamekit } from './gamekit.js';

// Preserve only the source pose needed by presentation at the tick that produced
// an event. The authoritative event and simulation state remain untouched.
export function captureFramePresentationEvents(events, sim) {
    return events.map((event) => {
        const id =
            event.type === 'hit'
                ? event.sourceId
                : event.type === 'launchOverheat'
                  ? event.cannonId
                  : null;
        if (!id) return event;
        const source = sim.unitById?.get(id) || sim.buildingById?.get(id);
        const target =
            source?.targetId &&
            (sim.unitById?.get(source.targetId) || sim.buildingById?.get(source.targetId));
        return {
            ...event,
            presentationSource: source
                ? {
                      id: source.id,
                      x: source.x,
                      y: source.y,
                      side: source.side,
                      alive: source.alive !== false,
                      targetId: source.targetId,
                      presentationTarget:
                          target && target.alive !== false ? { x: target.x, y: target.y } : null,
                  }
                : null,
        };
    });
}

// Stamp visibility only after the published snapshot has refreshed the renderer's
// fields. The GameKit journal remains the sole owner of confirmed identities.
export function attachPublishedVisibility(events, view) {
    return events.map((event) => ({ ...event, presentationVisible: view.visibility(event) }));
}

// Preserve the source frame order and identity; GameKit owns event deduplication.
export function presentationFrameEvent(tick, sequence, payload) {
    return {
        tick,
        sequence,
        entityId: payload.entityId ?? payload.id ?? payload.sourceId ?? 'world',
        generation: 0,
        kind: 'frame',
        payload,
        policy: 'confirmed',
        durationMs: 0,
    };
}

// A single journal owns both confirmation identity and presentation delivery.
export function createFramePresentationJournal({ getView, onImmediate, retentionTicks = 120 }) {
    const adapter = {
        start(record, at, age) {
            const view = getView();
            if (view?.classify(record).delivery === 'presentation')
                return view.start(record, at, age);
            onImmediate(record);
        },
        update(handle, age, record) {
            getView()?.update(handle, age, record);
        },
        stop(handle, reason, record) {
            getView()?.stop(handle, reason, record);
        },
    };
    return new RallyGamekit.PresentationEventQueue({
        adapters: { frame: adapter, audio: adapter },
        retentionTicks,
    });
}

export function configureFramePresentationJournal(journal, view, tps, active = true) {
    if (!view) return false;
    journal.configureDisplay({
        stepMs: 1000 / tps,
        maxLatenessMs: view.maxLatenessMs,
        classify: view.classify,
    });
    if (!active) journal.setPresentationActive(false);
    return true;
}

export function emitFramePresentationEvents(journal, view, tick, events) {
    for (const [sequence, event] of events.entries()) {
        const record = presentationFrameEvent(tick, sequence, event);
        journal.emit(record);
        if (view?.hasAudio(event)) journal.emit({ ...record, kind: 'audio' });
    }
    journal.confirmThrough(tick);
}
