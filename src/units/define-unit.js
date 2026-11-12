// One unit card: everything the game knows about it, read by the shared systems through UNITS (./index.js).
//
//   id       stable identifier (decks, snapshots, replays, assets)
//   hero     hero card: one per deck, launched alone and free, recalled to a cannon
//   unit     simulation Definition. A capability is a named field whose value is its parameters
//            (stickyCling, leapAttack, spinAttack, ...); the simulation reads it directly. A sustained attack
//            (breathAttack, a pulsing spinAttack, burstAttack) also has `sustain { durationMs, tickMs, cooldownMs,
//            windupMs?, recoverMs? }`, the shared timing of every damage-over-time attack (SustainedAttack) in
//            place of the unit's cooldownMs.
//   payload  the cannon shell that carries the unit (LaunchRules)
//   visual   body scale, team accent, hit effect family, optional landing husk colors
//   card     deck card and card detail copy
//   help     optional in-game help entries { section, summary, paragraphs }; section names a
//            [data-unit-help] slot in index.html (hero, hero-skill, construction)
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
//            Optional renderer methods the shared drawing calls when present: prepareExtraArt,
//            drawHeldKernel, drawWrapOverlay (StickyCling), drawRide (CannonRider), drawFlight and
//            drawImpact (a 'soldier' shell), drawBehind (trailing effects just behind the body),
//            drawUnderlay (see-through art under every body and face, before any of them),
//            actor.setTeam, actor.setRootStage and actor.setFlight({ phase, alive, altitude, clockMs,
//            heightPx, landStartMs, landEndMs, dropFromPx }) (Unit.flight on the render tick's clock and the
//            landing fall, main.js). The renderer draws its body and face quads
//            through drawUnitQuads(context, this.paint, …) (render/dead-unit-look.js): main.js sets
//            `paint` around a flying corpse's drawBody/drawFace, and its `hurt` face is the corpse's.
import { COLLISION_RADIUS_SCALE } from '../definitions/world-rules.js';
import { GRAIN_SIZE } from './baseline.js';
import { SustainedAttack } from '../sim/capabilities/sustained-attack.js';

const REQUIRED = ['unit', 'payload', 'visual', 'card'];
// The attacks timed by the shared sustained-attack grammar (Definition `sustain`, SustainedAttack).
const SUSTAINED = ['breathAttack', 'spinAttack', 'burstAttack'];
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
