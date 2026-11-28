import { RangeUtil } from '../core/game-rules.js';
import { AttackPresentationDefinition } from '../definitions/attack-presentation.js';
import { LaunchRules } from '../sim/launch-rules.js';

class FloatingTextPresentationDefinition {
    // How long each kind shows and how large it is (canvas px at sc() 1, and at least in CSS px); NumberLook owns its motion.
    static presets = Object.freeze({
        damageTaken: Object.freeze({ lifeMs: 620, baseSize: 12, minSize: 8 }),
        damageDealt: Object.freeze({ lifeMs: 620, baseSize: 16, minSize: 10 }),
        heroHeal: Object.freeze({ lifeMs: 900, baseSize: 18, minSize: 11 }),
        heroLevelUp: Object.freeze({ lifeMs: 1300, baseSize: 15, minSize: 11 }),
        dodge: Object.freeze({ lifeMs: 600, baseSize: 11, minSize: 8.5 }),
    });
    static get(kind) {
        return this.presets[kind] || this.presets.damageDealt;
    }
}

class EffectObjectFactory {
    static cornBurstLifeMs = 650;
    // Popcorn's self-destruct burst, presentation only. The ground ring and the kernels reach the blast radius
    // × `radiusScale` and last `lifeMs` (1.5 × a corn burst; the puff keeps the corn burst's 650 ms). A burst on
    // screen shakes the camera lightly (a building death is 3.5 for 180 ms); bursts in a row keep one shake at
    // the strongest value instead of adding up.
    static selfDestructBurst = Object.freeze({
        radiusScale: 1,
        // The puff art's width against the blast radius (1.2 × 80 keeps its original 95-ish size).
        puffScale: 1.2,
        lifeMs: 975,
        kernels: 10,
        shakeIntensity: 1.2,
        shakeMs: 110,
        // A burst with the campaign upgrade bigPop (event `big`): a larger puff and a brighter, longer flash. The
        // ground ring stays at the real radius, which the upgrade does not change.
        big: Object.freeze({ puffScale: 1.3, flashAlpha: 0.6, flashShare: 0.45 }),
    });
    static milletBurstLifeMs = 600;
    // Kill effects (HeroKillEffect), presentation only: juice drops (world units) and the filled-counter ring.
    static heroKillJuice = Object.freeze({ drops: 6, spread: 25, arc: 50, size: 5 });
    static heroKillCharge = Object.freeze({ radius: 25, growth: 1 });
    // Level passives and auras (HeroPassive, HeroAllyAura), presentation only (world units): the boomerang echo's
    // gold flash, the grape aura's rising drops, the puddle's purple pool and the ring under an aura's ally.
    static heroEchoFlash = Object.freeze({ radius: 12, growth: 1.5 });
    static heroAuraRegen = Object.freeze({ drops: 3, spread: 7, rise: 28, size: 3.5 });
    static heroPuddle = Object.freeze({
        fill: [0.5, 0.16, 0.7, 0.42],
        stroke: [0.78, 0.5, 1, 0.75],
    });
    static heroAuraRing = Object.freeze({ scale: 1.25, alpha: 0.85 });
    // A campaign upgrade's block (UpgradeHitBlock), presentation only: the husk-coloured ring under a soldier that
    // still holds one (radius in body radii).
    static upgradeArmorRing = Object.freeze({
        scale: 1.5,
        stroke: [0.98, 0.86, 0.42, 0.95],
        fill: [0.98, 0.86, 0.42, 0.22],
    });
    // A soldier running a campaign upgrade's chain (UpgradeChainCharge), presentation only: the ring under it.
    static upgradeChainRing = Object.freeze({
        scale: 1.6,
        stroke: [1, 0.6, 0.24, 0.95],
        fill: [1, 0.6, 0.24, 0.28],
    });
    // The ground ring of a campaign upgrade's reach: a widened leap landing, a walnut's shell shards.
    static upgradeReachTint = Object.freeze({ leap: [1, 0.5, 0.42], shards: [0.62, 0.4, 0.2] });
    static defaultCombatLifeMs = 360;
    static sourceMotionFallbackMs = 220;
    static shellFlinch = Object.freeze({ lifeMs: 160, tilt: 0.6, squash: 0.28 });
    static combatLifetimes = Object.freeze({
        thornImpact: 250,
        basicSplashImpact: 180,
        heroKillJuice: 500,
        heroKillCharge: 400,
        heroEchoFlash: 320,
        heroAuraRegen: 700,
        upgradeHitBlock: 320,
        upgradeLeapRing: 400,
        upgradeChainCharge: 360,
        upgradeShellShards: 420,
        upgradeShardRing: 420,
        upgradeWallRebound: 320,
        constructionHit: 220,
        hitscanTravel: 180,
        rapidHitscanTravel: 125,
        antiAirHit: 320,
        unitBurstShot: 160,
        shellIntercepted: 420,
        emergencyLanding: 320,
        buildingBurst: 620,
        sporeSacBurst: 760,
        sporeCloudLift: 900,
        launchMuzzle: 900,
        launchBlast: 820,
        launchBundleBreak: 680,
        deathBurst: 480,
        // Shards and the stain of a declared unit's death (CombatFxLook).
        unitBurst: 4670,
        // A fallen cannon's pieces and its ground mark (SiegeLook, CombatFxLook).
        buildingWreck: 3740,
        selfDestructBurst: EffectObjectFactory.selfDestructBurst.lifeMs,
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
            this.selfDestructBurst.lifeMs,
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
            dir: 1,
            spread: 0,
            lift: 0,
            targetId: null,
            kill: false,
            group: null,
            numberLayout: null,
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
        v.dir = 1;
        v.spread = 0;
        v.lift = 0;
        v.targetId = null;
        v.kill = false;
        v.group = null;
        v.numberLayout = null;
    }
    static makeShakeFx() {
        return {
            start: 0,
            duration: 0,
            intensity: 0,
            seed: 0,
            presentationTick: null,
            single: null,
        };
    }
    static resetShakeFx(v) {
        v.single = null;
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
                [
                    'captureComplete',
                    'buildingDeath',
                    'death',
                    'hit',
                    'unitSelfDestruct',
                    'sporeCloudWarn',
                    'launchFire',
                    'mortarFire',
                    'launchImpact',
                    'mortarImpact',
                ].includes(event.type)
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
