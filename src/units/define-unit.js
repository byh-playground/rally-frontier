// One unit card: everything the game knows about it, read by the shared systems through UNITS (./index.js).
//
//   id       stable identifier (decks, snapshots, replays, assets)
//   hero     hero card: one per deck, launched alone and free, recalled to a cannon
//   unit     simulation Definition. A capability is a named field whose value is its parameters
//            (stickyCling, leapAttack, spinAttack, ...); the simulation reads it directly.
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
//            Optional renderer methods the shared drawing calls when present: prepareExtraArt,
//            drawHeldKernel, drawWrapOverlay (StickyCling), drawRide (CannonRider), drawFlight and
//            drawImpact (a 'soldier' shell), drawBehind (trailing effects just behind the body),
//            actor.setTeam and actor.setRootStage. The renderer draws its body and face quads
//            through drawUnitQuads(context, this.paint, …) (render/dead-unit-look.js): main.js sets
//            `paint` around a flying corpse's drawBody/drawFace, and its `hurt` face is the corpse's.
const REQUIRED = ['unit', 'payload', 'visual', 'card'];

export function defineUnit({ id, hero = false, help = [], ...parts }) {
    if (typeof id !== 'string' || !id) throw new Error('병종 id가 필요합니다.');
    for (const key of REQUIRED)
        if (!parts[key] || typeof parts[key] !== 'object')
            throw new Error(`병종 ${id}에 ${key}가 없습니다.`);
    if (typeof parts.sprite !== 'function') throw new Error(`병종 ${id}에 sprite 로더가 없습니다.`);
    const unit = { ...parts.unit };
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
