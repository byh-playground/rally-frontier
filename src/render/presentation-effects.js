import { RangeUtil } from '../core/game-rules.js';
import { AttackPresentationDefinition } from '../definitions/attack-presentation.js';
import { LaunchRules } from '../sim/launch-rules.js';

class FloatingTextPresentationDefinition {
    static presets = Object.freeze({
        damageTaken: Object.freeze({
            lifeMs: 600,
            baseSize: 15,
            minSize: 10,
            rise: 30,
            alpha: 0.8,
            strokeAlpha: 0.8,
            pop: 1,
        }),
        damageDealt: Object.freeze({
            lifeMs: 600,
            baseSize: 15,
            minSize: 10,
            rise: 30,
            alpha: 0.8,
            strokeAlpha: 0.8,
            pop: 1,
        }),
        dodge: Object.freeze({
            lifeMs: 750,
            baseSize: 15,
            minSize: 10,
            rise: 30,
            alpha: 0.8,
            strokeAlpha: 0.8,
            pop: 1,
        }),
    });
    static get(kind) {
        return this.presets[kind] || this.presets.damageDealt;
    }
}

class EffectObjectFactory {
    static cornBurstLifeMs = 650;
    static milletBurstLifeMs = 600;
    static defaultCombatLifeMs = 360;
    static sourceMotionFallbackMs = 220;
    static shellFlinch = Object.freeze({ lifeMs: 160, tilt: 0.6, squash: 0.28 });
    static combatLifetimes = Object.freeze({
        thornImpact: 250,
        spinBasicImpact: 180,
        constructionHit: 220,
        hitscanTravel: 180,
        antiAirHit: 320,
        shellIntercepted: 420,
        emergencyLanding: 320,
        buildingBurst: 620,
        launchMuzzle: 900,
        launchBlast: 820,
        launchBundleBreak: 680,
        deathBurst: 480,
    });
    static fireShakeDuration(power) {
        return 110 + 150 * power;
    }
    static impactShakeDuration(peak, hits) {
        return hits > 0 ? 130 + 70 * (peak - 1) : 80;
    }
    static get maxTailMs() {
        return Math.max(
            LaunchRules.landingMarkMs,
            this.cornBurstLifeMs,
            this.milletBurstLifeMs,
            this.defaultCombatLifeMs,
            this.sourceMotionFallbackMs,
            ...Object.values(this.combatLifetimes),
            ...Object.values(FloatingTextPresentationDefinition.presets).map(
                (preset) => preset.lifeMs,
            ),
            ...Object.values(AttackPresentationDefinition.sourceMotions).map(
                (motion) => motion.lifeMs,
            ),
            this.fireShakeDuration(1),
            this.impactShakeDuration(
                Math.max(LaunchRules.unitImpactPeak, LaunchRules.buildingImpactPeak),
                1,
            ),
        );
    }
    static combatLife(fx) {
        if (fx.kind === 'meleeSourceMotion')
            return (
                AttackPresentationDefinition.sourceMotions[fx.motion]?.lifeMs ||
                this.sourceMotionFallbackMs
            );
        return this.combatLifetimes[fx.kind] ?? this.defaultCombatLifeMs;
    }
    static attachClock(effect, clock, lifeMs) {
        effect.clock = clock;
        clock.lifeMs = Math.max(clock.lifeMs, lifeMs);
    }
    static makeFloatFx() {
        return {
            x: 0,
            y: 0,
            kind: '',
            text: '',
            amount: 0,
            start: 0,
            presentationTick: null,
            jitter: 0,
            lane: 0,
        };
    }
    static resetFloatFx(v) {
        v.x = 0;
        v.y = 0;
        v.kind = '';
        v.text = '';
        v.amount = 0;
        v.start = 0;
        v.presentationTick = null;
        v.clock = null;
        v.jitter = 0;
        v.lane = 0;
    }
    static makeShakeFx() {
        return { start: 0, duration: 0, intensity: 0, seed: 0, presentationTick: null };
    }
    static resetShakeFx(v) {
        v.start = 0;
        v.duration = 0;
        v.intensity = 0;
        v.seed = 0;
        v.presentationTick = null;
        v.clock = null;
    }
    static makeCombatFx() {
        return {
            kind: '',
            x: 0,
            y: 0,
            x2: 0,
            y2: 0,
            sourceType: '',
            targetType: '',
            entity: '',
            amount: 0,
            radius: 0,
            width: 0,
            durationTicks: 0,
            remaining: 0,
            sourceId: null,
            targetId: null,
            fromX: null,
            fromY: null,
            isBuilding: false,
            points: null,
            side: null,
            start: 0,
            presentationTick: null,
            seed: 0,
            _extraKeys: null,
        };
    }
    static resetCombatFx(v) {
        if (v._extraKeys) {
            for (const k of v._extraKeys) delete v[k];
            v._extraKeys = null;
        }
        v.kind = '';
        v.x = v.y = v.x2 = v.y2 = 0;
        v.sourceType = v.targetType = v.entity = '';
        v.amount = v.radius = v.width = v.durationTicks = v.remaining = 0;
        v.sourceId = v.targetId = null;
        v.fromX = v.fromY = null;
        v.isBuilding = false;
        v.points = null;
        v.side = null;
        v.start = v.seed = 0;
        v.presentationTick = null;
        v.clock = null;
    }
}

function createPresentationView(owner, getRenderer, { hud = true, audio = true } = {}) {
    return {
        maxLatenessMs: LaunchRules.landingMarkMs,
        tailMs: EffectObjectFactory.maxTailMs,
        classify(record) {
            if (record.kind === 'audio' || record.payload.type === 'launchRejected')
                return { delivery: 'confirmation', durationMs: 0 };
            const result = { delivery: 'presentation', durationMs: Infinity };
            if (record.payload.type === 'unitLobExplosion' && record.payload.subtick != null)
                result.phase = RangeUtil.clamp(record.payload.subtick / 1000000, 0, 1);
            return result;
        },
        hasAudio(event) {
            return (
                audio &&
                ['captureComplete', 'buildingDeath', 'death', 'hit', 'unitSelfDestruct'].includes(
                    event.type,
                )
            );
        },
        visibility(event) {
            const renderer = getRenderer();
            if (!renderer || !Number.isFinite(event.x) || !Number.isFinite(event.y)) return null;
            const level = renderer.world.terrain.surfaces.levelAt(event.x, event.y);
            return [0, 1].map(
                (side) => !!renderer.visionFields[side]?.visibleAt(event.x, event.y, level),
            );
        },
        start(record, at, age) {
            const clock = getRenderer()?.presentEvent(record, age, { hud });
            if (!clock?.lifeMs) owner.finishPresentationEvent(record);
            return clock;
        },
        update(clock, age, record) {
            if (!clock) return;
            clock.ageMs = age;
            if (age >= clock.lifeMs) owner.finishPresentationEvent(record);
        },
        stop(clock) {
            if (clock) clock.expired = true;
        },
    };
}

export { createPresentationView, EffectObjectFactory, FloatingTextPresentationDefinition };
