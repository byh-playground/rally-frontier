// One unit card: everything the game knows about it, read by the shared systems through UNITS (./index.js).
//
//   id       stable identifier (decks, snapshots, replays, assets)
//   hero     hero card: one per deck, launched alone and free, recalled to a cannon
//   unit     simulation Definition. A capability is a named field whose value is its parameters
//            (stickyCling, leapAttack, spinAttack, ...); the simulation reads it directly. A sustained attack
//            (breathAttack, a pulsing spinAttack, burstAttack, chainAttack) also has `sustain { durationMs, tickMs, cooldownMs,
//            windupMs?, recoverMs? }`, the shared timing of every damage-over-time attack (SustainedAttack) in
//            place of the unit's cooldownMs. `construction { range, workPerHit }`: work added per hit.
//            `damageTaken { scale, whileBuilding? }`: the share of enemy damage it takes (StrategySim.applyDamage,
//            floored, at least 1), always or with `whileBuilding` only while assigned to a project under way.
//            `basicSplash { radius, damageRatio }`: its basic melee hit on a soldier also hits the soldiers
//            around (BasicSplash). `workerCard` marks a card the bot launches only to build (BotController).
//            `growth { <level 2..6>: { <effect>: spec } }` (heroes only): what each hero level unlocks
//            (HeroGrowth.unlocked), checked by GROWTH_EFFECTS below. Levels raise no stats. Effects:
//              killEffect { heal?, fillCombo?, bounce? { radius, damage } } (HeroKillEffect)
//              passive { seedBurst? { takenPerBurst, seeds, radius, damage, flightMs }, echoHit? { ratio },
//                puddle? { durationMs, tickMs, radius, damage } } (HeroPassive)
//              allyAura { radius, refreshMs, takenScale?, movePct?, regen? { intervalMs, percent, min } } (HeroAllyAura)
//   payload  the cannon shell that carries the unit (LaunchRules). A hero's shell has no landing shock (impact,
//            splash) but `landingStrike { radius, damage, knockback?, scatter? { ring, count }, retreat { motion:
//            'roll'|'hop', distance } }`, the hero's own strike when it lands (HeroLandingStrike)
//   visual   body scale, team accent, hit effect family, optional landing husk colors
//   card     deck card and card detail copy
//   help     optional in-game help entries { section, summary, paragraphs }; section names a
//            [data-unit-help] slot in index.html (hero, construction)
//   sprite   () => Promise of the art contract (./<id>/sprite.js SPRITE), a lazy import so the
//            simulation Worker never loads art. Fields:
//              load, renderer, portrait, groundY, art?, artScale?, heroBasic?, fruitAttack?
//              shell?      { draw, turn?, flight?: 'tumble'|'ear'|'cone'|'soldier', sheet?,
//                          particleTrail?, aimFallback?, depthTest? }; without it the cannon
//                          shell is the vector asset 'ammo-<id>'
//              landing?    'ear-burst'
//              pose?       'kernel-thrower'|'thorn-thrower'|'body-charge'
//              roll?       { progress, tuck, setMatrix }  (HeroRollAttack)
//              rolling?    { prepare(grain, entity, world, renderTick, now, tps, orientation) }: the
//                          self-propelled rolling body's per-frame art (RollingBody)
//              effectArt?  ['grain-particles'|'self-destruct-burst'|'thorn']
//              breath?     { drawFlame(ctx, flame) }: paints a breathAttack unit's flame (UnitBreathAttack)
//                          on main.js's 2D effect canvas from the screen geometry main.js measures
//                          (drawBreathFlames); its actors then also have setAim(dx, dy, breathing,
//                          alive, clockMs, cooling), facing and mouthTip(out); flame.cooling marks the
//                          wait between breaths (SustainedAttack cooldown)
//              chain?      { drawBolt(ctx, bolt) }: paints a chainAttack unit's lightning (UnitChainAttack) on
//                          main.js's 2D effect canvas (drawChainBolts) through the screen points main.js
//                          measures for its links; its actors then also have setChannel(state, clockMs, alive)
//                          (state 'channel'|'telegraph'|null) and boltTip(out)
//            Optional renderer methods the shared drawing calls when present: prepareExtraArt,
//            drawThorn(matrix, depth) (this unit's own thornAttack shot; otherwise effectArt 'thorn' draws it),
//            drawHeldKernel, drawWrapOverlay (StickyCling), drawRide (CannonRider), drawFlight and
//            drawImpact (a 'soldier' shell), drawBehind (trailing effects just behind the body),
//            drawUnderlay (see-through art under every body and face, before any of them),
//            actor.setTeam, actor.setRootStage and actor.setFlight({ phase, alive, altitude, clockMs,
//            heightPx, landStartMs, landEndMs, dropFromPx }) (Unit.flight on the render tick's clock and the
//            landing fall, main.js). The renderer draws its body and face quads
//            through drawUnitQuads(context, this.paint, …) (render/dead-unit-look.js): main.js sets
//            `paint` around a stopped, greying corpse's drawBody/drawFace (null otherwise), and its `hurt` face is every corpse's.
import { COLLISION_RADIUS_SCALE } from '../definitions/world-rules.js';
import { GRAIN_SIZE, HERO_LEVEL_KILLS } from './baseline.js';
import { SustainedAttack } from '../sim/capabilities/sustained-attack.js';

const REQUIRED = ['unit', 'payload', 'visual', 'card'];
// The attacks timed by the shared sustained-attack grammar (Definition `sustain`, SustainedAttack).
const SUSTAINED = ['breathAttack', 'spinAttack', 'burstAttack', 'chainAttack'];
// Attacks and movements a breathing unit cannot also have: its combat action is the breath alone.
const BREATH_EXCLUSIVE = [
    'flight',
    'rolling',
    'growsCannon',
    'cannonRider',
    'spinAttack',
    'burstAttack',
    'lobAttack',
    'thornAttack',
    'leapAttack',
    'contactMelee',
    'selfDestruct',
    'canAttackAir',
];

// The effects a hero level can unlock (Definition `unit.growth[level]`) and each one's check.
const GROWTH_EFFECTS = Object.freeze({
    // HeroKillEffect: the hero's killing blow on an enemy soldier.
    killEffect(id, spec, unit) {
        const keys = Object.keys(spec || {});
        if (!keys.length || keys.some((key) => !['heal', 'fillCombo', 'bounce'].includes(key)))
            throw new Error(
                `병종 ${id}의 killEffect는 heal·fillCombo·bounce 중 하나 이상이어야 합니다.`,
            );
        if (spec.heal !== undefined && !(Number.isInteger(spec.heal) && spec.heal > 0))
            throw new Error(`병종 ${id}의 killEffect.heal은 양의 정수여야 합니다.`);
        if (spec.fillCombo !== undefined && (spec.fillCombo !== true || !unit.fruitAttack))
            throw new Error(
                `병종 ${id}의 killEffect.fillCombo는 true이고 fruitAttack이 있어야 합니다.`,
            );
        const bounce = spec.bounce;
        if (
            bounce !== undefined &&
            (!(bounce.radius > 0 && bounce.damage > 0) || !unit.fruitAttack?.lob)
        )
            throw new Error(
                `병종 ${id}의 killEffect.bounce는 양수 radius·damage와 fruitAttack.lob이 필요합니다.`,
            );
    },
    // HeroPassive: always on once unlocked.
    passive(id, spec, unit) {
        const keys = Object.keys(spec || {});
        if (keys.length !== 1 || !['seedBurst', 'echoHit', 'puddle'].includes(keys[0]))
            throw new Error(`병종 ${id}의 passive는 seedBurst·echoHit·puddle 중 하나여야 합니다.`);
        const positive = (block, fields) =>
            fields.every((field) => Number.isFinite(block[field]) && block[field] > 0);
        if (
            spec.seedBurst &&
            !(
                positive(spec.seedBurst, [
                    'takenPerBurst',
                    'seeds',
                    'radius',
                    'damage',
                    'flightMs',
                ]) &&
                Number.isInteger(spec.seedBurst.takenPerBurst) &&
                Number.isInteger(spec.seedBurst.seeds)
            )
        )
            throw new Error(
                `병종 ${id}의 passive.seedBurst는 양수(정수 takenPerBurst·seeds)여야 합니다.`,
            );
        if (
            spec.echoHit &&
            !(positive(spec.echoHit, ['ratio']) && unit.fruitAttack?.kind === 'boomerang')
        )
            throw new Error(
                `병종 ${id}의 passive.echoHit은 양수 ratio와 부메랑 fruitAttack이 필요합니다.`,
            );
        if (
            spec.puddle &&
            (!positive(spec.puddle, ['durationMs', 'tickMs', 'radius', 'damage']) ||
                spec.puddle.tickMs > spec.puddle.durationMs ||
                !unit.fruitAttack?.lob)
        )
            throw new Error(
                `병종 ${id}의 passive.puddle은 양수 값(tickMs ≤ durationMs)과 fruitAttack.lob이 필요합니다.`,
            );
    },
    // HeroAllyAura: the allies around the hero.
    allyAura(id, spec) {
        const effects = ['takenScale', 'movePct', 'regen'].filter(
            (key) => spec?.[key] !== undefined,
        );
        if (
            !(spec?.radius > 0 && spec.refreshMs > 0) ||
            !effects.length ||
            Object.keys(spec).some(
                (key) => !['radius', 'refreshMs', 'takenScale', 'movePct', 'regen'].includes(key),
            )
        )
            throw new Error(
                `병종 ${id}의 allyAura는 양수 radius·refreshMs와 takenScale·movePct·regen 중 하나 이상이 필요합니다.`,
            );
        if (spec.takenScale !== undefined && !(spec.takenScale > 0 && spec.takenScale < 1))
            throw new Error(`병종 ${id}의 allyAura.takenScale은 0과 1 사이여야 합니다.`);
        if (spec.movePct !== undefined && !(Number.isInteger(spec.movePct) && spec.movePct > 100))
            throw new Error(`병종 ${id}의 allyAura.movePct는 100보다 큰 정수여야 합니다.`);
        const regen = spec.regen;
        if (
            regen !== undefined &&
            !(
                regen.intervalMs > 0 &&
                regen.percent > 0 &&
                Number.isInteger(regen.min) &&
                regen.min > 0
            )
        )
            throw new Error(
                `병종 ${id}의 allyAura.regen은 양수 intervalMs·percent와 양의 정수 min이 필요합니다.`,
            );
    },
});

function validateGrowth(id, growth, unit, hero) {
    if (!hero) throw new Error(`병종 ${id}: growth(레벨 해금 효과)는 영웅만 가집니다.`);
    for (const [level, unlocks] of Object.entries(growth)) {
        const number = Number(level);
        if (!Number.isInteger(number) || number < 2 || number > HERO_LEVEL_KILLS.length)
            throw new Error(
                `병종 ${id}의 growth 레벨은 2~${HERO_LEVEL_KILLS.length}이어야 합니다.`,
            );
        for (const [effect, spec] of Object.entries(unlocks)) {
            if (!Object.hasOwn(GROWTH_EFFECTS, effect))
                throw new Error(`병종 ${id}의 growth[${level}].${effect}는 없는 효과입니다.`);
            GROWTH_EFFECTS[effect](id, spec, unit);
        }
    }
}

export function defineUnit({ id, hero = false, help = [], ...parts }) {
    if (typeof id !== 'string' || !id) throw new Error('병종 id가 필요합니다.');
    for (const key of REQUIRED)
        if (!parts[key] || typeof parts[key] !== 'object')
            throw new Error(`병종 ${id}에 ${key}가 없습니다.`);
    if (typeof parts.sprite !== 'function') throw new Error(`병종 ${id}에 sprite 로더가 없습니다.`);
    const unit = { ...parts.unit };
    // A flight (UnitFlight) is a walking soldier's one way of moving: it takes the ordinary melee path once landed.
    if (unit.flight) {
        if (hero || unit.rolling || unit.growsCannon || unit.cannonRider)
            throw new Error(
                `병종 ${id}의 flight는 영웅·rolling·growsCannon·cannonRider와 함께 쓸 수 없습니다.`,
            );
        for (const key of ['speed', 'altitude', 'climbSpeed'])
            if (!(Number(unit.flight[key]) > 0))
                throw new Error(`병종 ${id}의 flight.${key}는 양수여야 합니다.`);
    }
    // A sustained attack (SustainedAttack): its own duration, damage step and cooldown replace the unit's attack
    // cadence, so the unit has no cooldownMs or attackIntervalMs of its own.
    if (unit.sustain) {
        SustainedAttack.validate(id, unit.sustain);
        if (!SUSTAINED.some((key) => unit[key]))
            throw new Error(
                `병종 ${id}의 sustain은 지속 피해형 공격(${SUSTAINED.join('·')})에만 씁니다.`,
            );
        if (unit.cooldownMs != null || unit.attackIntervalMs != null)
            throw new Error(
                `병종 ${id}는 sustain.cooldownMs를 쓰므로 cooldownMs·attackIntervalMs를 따로 둘 수 없습니다.`,
            );
    }
    // The burst and the pulsing spin are sustained attacks; the arc sweep keeps its own timing.
    if ((unit.burstAttack || (unit.spinAttack && !unit.spinAttack.arcSweep)) && !unit.sustain)
        throw new Error(`병종 ${id}의 burstAttack·회전 타격(spinAttack)은 sustain이 필요합니다.`);
    if (unit.spinAttack?.arcSweep && unit.sustain)
        throw new Error(`병종 ${id}의 spinAttack.arcSweep은 sustain을 쓰지 않습니다.`);
    // A breath (UnitBreathAttack) is a sustained attack: the unit's atk on every damage tick; its flame tip is the
    // attack reach.
    if (unit.breathAttack) {
        const spec = unit.breathAttack;
        for (const key of ['length', 'arcDegrees', 'turnDegreesPerSecond', 'buildingDamageScale'])
            if (!(Number(spec[key]) > 0))
                throw new Error(`병종 ${id}의 breathAttack.${key}는 양수여야 합니다.`);
        if (spec.arcDegrees >= 180)
            throw new Error(`병종 ${id}의 breathAttack.arcDegrees는 180보다 작아야 합니다.`);
        if (!(unit.atk > 0) || !unit.sustain)
            throw new Error(
                `병종 ${id}의 breathAttack은 atk(피해 틱당 피해)와 sustain이 필요합니다.`,
            );
        if (unit.range + (unit.size || GRAIN_SIZE) * COLLISION_RADIUS_SCALE !== spec.length)
            throw new Error(
                `병종 ${id}의 range는 breathAttack.length에서 몸 반경을 뺀 값이어야 합니다.`,
            );
        for (const other of BREATH_EXCLUSIVE)
            if (hero || unit[other])
                throw new Error(`병종 ${id}의 breathAttack은 영웅·${other}와 함께 쓸 수 없습니다.`);
    }
    // A chain (UnitChainAttack) is a sustained attack: the unit's atk on every link at each damage tick, its first
    // link within the attack range. Its combat action is the chain alone (the same exclusions as a breath, plus it).
    if (unit.chainAttack) {
        const spec = unit.chainAttack;
        for (const key of ['links', 'bounceRange', 'buildingDamageScale'])
            if (!(Number(spec[key]) > 0))
                throw new Error(`병종 ${id}의 chainAttack.${key}는 양수여야 합니다.`);
        if (!Number.isInteger(spec.links))
            throw new Error(`병종 ${id}의 chainAttack.links는 정수여야 합니다.`);
        if (!(unit.atk > 0) || !unit.sustain || !(unit.range > 0))
            throw new Error(
                `병종 ${id}의 chainAttack은 atk(피해 틱당 피해)·range·sustain이 필요합니다.`,
            );
        for (const other of [...BREATH_EXCLUSIVE, 'breathAttack'])
            if (hero || unit[other])
                throw new Error(`병종 ${id}의 chainAttack은 영웅·${other}와 함께 쓸 수 없습니다.`);
    }
    // A unit that takes less damage keeps a share in (0, 1]; only a builder can limit it to building.
    const taken = unit.damageTaken;
    if (taken !== undefined) {
        if (!(Number(taken.scale) > 0 && Number(taken.scale) <= 1))
            throw new Error(`병종 ${id}의 damageTaken.scale은 0보다 크고 1 이하여야 합니다.`);
        if (taken.whileBuilding && !unit.construction)
            throw new Error(`병종 ${id}의 damageTaken.whileBuilding은 construction이 필요합니다.`);
    }
    const splash = unit.basicSplash;
    if (
        splash !== undefined &&
        !(Number(splash.radius) > 0 && Number(splash.damageRatio) > 0 && unit.atk > 0)
    )
        throw new Error(`병종 ${id}의 basicSplash는 양수 radius·damageRatio와 atk가 필요합니다.`);
    if (unit.growth !== undefined) validateGrowth(id, unit.growth, unit, hero);
    if (unit.workerCard && !unit.construction)
        throw new Error(`병종 ${id}의 workerCard는 construction이 필요합니다.`);
    // A hero's shell lands with the hero's landing strike in place of the shell's shock (HeroLandingStrike).
    const strike = parts.payload.landingStrike;
    if (hero !== !!strike)
        throw new Error(
            `병종 ${id}: 영웅 포탄만 landingStrike를 가지며 영웅 포탄에는 꼭 있어야 합니다.`,
        );
    if (strike) {
        if (parts.payload.impact !== undefined || parts.payload.splash !== undefined)
            throw new Error(
                `병종 ${id}의 영웅 포탄은 착탄 충격(impact·splash) 대신 landingStrike를 씁니다.`,
            );
        if (
            !(strike.radius > 0 && strike.damage > 0 && strike.retreat?.distance > 0) ||
            !['roll', 'hop'].includes(strike.retreat.motion) ||
            (strike.retreat.motion === 'roll' && !unit.heroActive) ||
            (strike.scatter && !(strike.scatter.ring > 0 && Number.isInteger(strike.scatter.count)))
        )
            throw new Error(`병종 ${id}의 landingStrike가 잘못되었습니다.`);
    }
    if (Number.isFinite(Number(unit.cooldownMs))) unit.cooldown = Number(unit.cooldownMs) / 1000;
    if (unit.canAttackGround == null) unit.canAttackGround = (unit.atk || 0) > 0;
    return Object.freeze({
        id,
        hero,
        unit,
        payload: Object.freeze({ ...parts.payload }),
        visual: Object.freeze({ ...parts.visual }),
        card: Object.freeze({ ...parts.card }),
        help: Object.freeze(help.map((entry) => Object.freeze({ ...entry }))),
        sprite: parts.sprite,
    });
}
