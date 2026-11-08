import { FP } from '../core/config.js';
import { RangeUtil } from '../core/game-rules.js';
import { RallyGamekit } from '../core/gamekit.js';
import { RENDER_TRACKS } from './render-tracks.js';

/* Render-position contract:
   Every continuous moving visual, including bodies, strategic markers, facing origins,
   construction poses, hidden/burrow ground markers, trails and moving VFX endpoints,
   reads registered x/y through RenderStateStore. Snapshot x/y remains authoritative for gameplay,
   visibility/detection and checksum; presentation must not bypass interpolation merely
   because the unit body itself is hidden. */
// Game-owned identity/discontinuity policy; the gamekit timeline owns interpolation.
export class RenderStateStore {
    constructor(playbackRate) {
        this.playbackRate = playbackRate;
        this.records = new Map();
        this.zeroDelta = Object.freeze({ x: 0, y: 0 });
        this.lists = { unit: [], projectile: [], unitLob: [], thorn: [], flag: [], bundle: [] };
        this.reset();
    }
    time(now) {
        return (this.clock = Math.max(this.clock, Number(now) || 0));
    }
    syncRate(now) {
        const rate = this.playbackRate();
        if (this.runtime && this.rate !== rate) {
            this.runtime.setRate(rate, now);
            this.rate = rate;
            this.frameAt = NaN;
        }
    }
    finish(tailMs, now = performance.now()) {
        const at = this.time(now);
        if (!this.runtime) return false;
        this.syncRate(at);
        const result = this.runtime.finish({ tailMs }, at);
        this.frameAt = NaN;
        return result;
    }
    capture(source, now, snap, stepMs) {
        const at = this.time(now),
            tick = Number(source.tick) || 0;
        if (!this.runtime || this.stepMs !== stepMs) {
            this.stepMs = stepMs;
            // Keep two fixed samples buffered, matching GameKit's 10 TPS / 200 ms frame example.
            this.runtime = new RallyGamekit.PresentationRuntime({
                stepMs,
                delayMs: stepMs * 2,
                clock: 'bounded',
            });
            this.rate = null;
            snap = true;
        }
        this.syncRate(at);
        // A reset rebases the timeline only. Live identities and their metadata copies
        // stay; re-cloning every entity here made an overloaded frame heavier still.
        if (snap) this.revision++;
        const entities = [],
            seen = new Set();
        let lobLaunches = null;
        for (const event of source.renderEvents || source.events || [])
            if (event.type === 'unitLobLaunch')
                (lobLaunches ||= new Map()).set(event.projectileId, event);
        const add = (kind, id, value) => {
            const key = kind + ':' + id,
                def = RENDER_TRACKS[kind];
            let record = this.records.get(key);
            const revived =
                kind === 'projectile' &&
                record?.entity.retiredTick != null &&
                value.retiredTick == null;
            const previous = record?.live && !revived ? record : null;
            if (!previous) {
                // One detached visual identity at birth. Ordinary metadata is refreshed by
                // the existing UI snapshot cadence, never by cloning the sim each frame.
                record = {
                    kind,
                    id,
                    generation: ++this.generation,
                    entity: value.toState ? value.toState('view') : structuredClone(value),
                    delta: { x: 0, y: 0 },
                };
                this.records.set(key, record);
            } else if (!value.toState) record.entity = value;
            const teleport =
                !!previous &&
                Math.hypot(value.x - record.x, value.y - record.y) >
                    def.snapDistance * Math.max(1, tick - record.tick);
            record.delta.x = snap || teleport || !previous ? 0 : value.x - record.x;
            record.delta.y = snap || teleport || !previous ? 0 : value.y - record.y;
            record.x = value.x;
            record.y = value.y;
            record.tick = tick;
            record.live = true;
            seen.add(key);
            const packet = {
                id: key,
                generation: record.generation,
                type: def.type,
                source: { entity: value, tick, delta: record.delta },
                teleport,
            };
            if (value.heroRoll) {
                // A queued roll can start on the same tick the previous roll ends.
                if (value.heroRoll.distance < record.rollDistance)
                    packet.resetFields = ['entity.heroRoll.distance'];
                record.rollDistance = value.heroRoll.distance;
            }
            if (value.terminalPath) packet.pathPoints = value.terminalPath;
            if (
                kind === 'projectile' &&
                !previous &&
                !revived &&
                !snap &&
                Number.isFinite(value.launchX) &&
                Number.isFinite(value.launchY)
            ) {
                packet.initialSource = {
                    entity: { ...value, x: value.launchX, y: value.launchY },
                    tick: tick - 1,
                };
                packet.initialTimeMs = (tick - 1) * stepMs;
            }
            if (kind === 'unitLob' && !previous && !snap) {
                const launch = lobLaunches?.get(id);
                if (
                    launch &&
                    Number.isFinite(launch.x) &&
                    Number.isFinite(launch.y) &&
                    Number.isFinite(launch.zFP)
                ) {
                    const launchTick = Number.isFinite(Number(launch.presentationTick))
                        ? Number(launch.presentationTick)
                        : tick;
                    packet.initialSource = {
                        entity: { ...value, x: launch.x, y: launch.y, zFP: launch.zFP },
                        tick: launchTick - 1,
                    };
                    packet.initialTimeMs = (launchTick - 1) * stepMs;
                }
            }
            if (
                kind === 'thorn' &&
                !previous &&
                !snap &&
                Number.isFinite(value.fromFx) &&
                Number.isFinite(value.fromFy) &&
                Number.isFinite(value.fromZFP)
            ) {
                const initialTick = Math.min(tick - 1, (Number(value.startTick) || tick) - 1);
                packet.initialSource = {
                    entity: {
                        ...value,
                        x: value.fromFx / FP,
                        y: value.fromFy / FP,
                        zFP: value.fromZFP,
                    },
                    tick: initialTick,
                };
                packet.initialTimeMs = initialTick * stepMs;
            }
            entities.push(packet);
        };
        for (const unit of source.units || [])
            if (unit.alive !== false || unit.impactMotion) add('unit', unit.id, unit);
        for (const projectile of source.projectiles || [])
            if (projectile.alive !== false) add('projectile', projectile.id, projectile);
        for (const projectile of source.unitLobProjectiles || [])
            if (projectile.startTick == null || projectile.startTick <= tick)
                add('unitLob', projectile.id, projectile);
        // Keep the last physical sample until the exact explosion subtick, so
        // the interpolated kernel and event-driven particles meet without a gap.
        for (const event of source.renderEvents || source.events || []) {
            if (event.type !== 'unitLobExplosion') continue;
            const key = 'unitLob:' + event.projectileId,
                record = this.records.get(key);
            if (!record?.live || seen.has(key)) continue;
            const eventTick = Number.isFinite(Number(event.presentationTick))
                ? Number(event.presentationTick)
                : tick;
            add('unitLob', event.projectileId, {
                ...record.entity,
                x: event.x,
                y: event.y,
                zFP: event.zFP,
                retiredAtTick:
                    event.subtick == null
                        ? eventTick
                        : eventTick - 1 + RangeUtil.clamp(Number(event.subtick) / 1000000, 0, 1),
            });
        }
        for (const thorn of source.unitThornProjectiles || [])
            if (thorn.startTick <= tick) add('thorn', thorn.id, thorn);
        // Publish the actual final contact sample before retiring the visual track. Interpolation must reach the impact.
        for (const event of source.renderEvents || source.events || [])
            if (event.type === 'projectileRetire') {
                const record = this.records.get('projectile:' + event.projectileId);
                if (record?.live && record.entity.retiredTick == null) {
                    const retiredTick = Number.isFinite(Number(event.presentationTick))
                        ? Number(event.presentationTick)
                        : tick;
                    const terminalPath =
                        retiredTick >= record.tick
                            ? [{ timeMs: retiredTick * stepMs, x: event.x, y: event.y }]
                            : [];
                    add('projectile', event.projectileId, {
                        ...record.entity,
                        x: event.x,
                        y: event.y,
                        retiredTick,
                        terminalPath,
                    });
                }
            }
        for (const event of source.renderEvents || source.events || [])
            if (event.type === 'unitThornHit' || event.type === 'unitThornMiss') {
                const record = this.records.get('thorn:' + event.projectileId);
                if (record?.live && record.entity.retiredTick == null) {
                    const retiredTick = Number.isFinite(Number(event.presentationTick))
                        ? Number(event.presentationTick)
                        : tick;
                    add('thorn', event.projectileId, {
                        ...record.entity,
                        x: event.x,
                        y: event.y,
                        zFP: event.zFP,
                        retiredTick,
                    });
                }
            }
        for (const group of source.launchDeployments || [])
            if (group.index < group.count) add('bundle', group.projectileId, group);
        for (let side = 0; side < (source.flags || []).length; side++)
            if (source.flags[side]) add('flag', side, source.flags[side]);
        for (const [key, record] of this.records) if (!seen.has(key)) record.live = false;
        this.runtime.capture(
            {
                revision: this.revision,
                sequence: ++this.sequence,
                timeMs: tick * stepMs,
                mode: snap ? 'reset' : 'continuous',
                entities,
            },
            at,
        );
        this.frameAt = NaN;
    }
    updateMetadata(snapshot) {
        for (const kind of ['unit', 'projectile']) {
            for (const entity of snapshot[kind === 'unit' ? 'units' : 'projectiles'] || []) {
                const record = this.records.get(kind + ':' + entity.id);
                if (
                    record &&
                    (entity.alive !== false || entity.impactMotion) &&
                    record.entity.retiredTick == null
                )
                    record.entity = entity;
            }
        }
    }
    frame(now) {
        const at = this.time(now);
        this.syncRate(at);
        if (this.frameAt === at) return this.currentFrame;
        this.frameAt = at;
        for (const list of Object.values(this.lists)) list.length = 0;
        this.currentFrame = this.runtime?.frame(at);
        const displayed = new Set();
        this.currentFrame?.forEach((model, key) => {
            const record = this.records.get(key);
            if (record) {
                displayed.add(key);
                record.model = model;
                this.lists[record.kind].push(record.entity);
            }
        });
        for (const [key, record] of this.records) {
            if (!displayed.has(key)) {
                record.model = null;
                if (!record.live) this.records.delete(key);
            }
        }
        return this.currentFrame;
    }
    model(kind, id, now = performance.now()) {
        this.frame(now);
        return this.records.get(kind + ':' + id)?.model || null;
    }
    has(kind, id, now = performance.now()) {
        return !!this.model(kind, id, now);
    }
    position(kind, id, source, now = performance.now()) {
        return (
            this.model(kind, id, now)?.entity || {
                x: Number(source?.x) || 0,
                y: Number(source?.y) || 0,
            }
        );
    }
    displayed(kind, now) {
        this.frame(now);
        return this.lists[kind];
    }
    entity(kind, id) {
        return this.records.get(kind + ':' + id)?.entity || null;
    }
    delta(kind, id) {
        return this.records.get(kind + ':' + id)?.model?.delta || this.zeroDelta;
    }
    reset() {
        this.records.clear();
        this.generation = 0;
        this.revision = 0;
        this.sequence = 0;
        this.clock = 0;
        this.runtime = null;
        this.stepMs = null;
        this.rate = null;
        this.currentFrame = null;
        this.frameAt = NaN;
        for (const list of Object.values(this.lists)) list.length = 0;
    }
}
