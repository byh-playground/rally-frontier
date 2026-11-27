// The numbers and words that pop out of a fight: damage thrown the way of the blow and falling in an arc (the
// killing blow larger, in gold), a heal rising with green pluses, a short hop for a miss and a level badge with
// turning rays. Presentation only: main.js owns the records (what, where, which way) and calls draw() each frame
// with the screen point of the record's ground position.

const FONT = 'system-ui,-apple-system,"Segoe UI",sans-serif';
// How far above its ground position each kind starts, in sc() units.
const ANCHOR = Object.freeze({ damage: 22, heal: 34, dodge: 30, level: 46 });
const outBack = (t) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2;
const eased = (t) => 1 - (1 - t) ** 2;

export class NumberLook {
    // The lifetime of a damage number that killed (the others are FloatingTextPresentationDefinition's).
    static killLifeMs = 850;
    // The most large (killing) numbers on screen at once.
    static maxKillNumbers = 4;
    // Past this number of active labels, individual damage becomes quieter. Screen-space overlap is resolved separately.
    // In a crowded fight, unit damage may also
    // keep one per body, so bodies and blows stay visible.
    static crowdAt = 14;

    static ordinary(f) {
        return (f.kind === 'damageDealt' || f.kind === 'damageTaken') && !f.kill;
    }

    static isOrdinaryUnitDamage(f) {
        return this.ordinary(f) && !f.group?.targets;
    }

    static damagePose(f, preset, x, y, sc, age, pixel, quiet) {
        const s = age / 1000;
        const t = age / (f.kill ? this.killLifeMs : preset.lifeMs);
        const gold = f.kill && f.kind === 'damageDealt';
        const burst = !!f.group?.targets;
        const bigger = gold ? (burst ? 1.1 : 1.5) : 1;
        const grow = quiet
            ? 0.75
            : t < 0.18
              ? 0.5 + outBack(t / 0.18) * 0.9
              : Math.max(1, 1.4 - (t - 0.18) * 1.6);
        return {
            x: x + (f.dir * 70 * s + f.spread * (40 * s + (burst ? 70 : 0))) * sc,
            y: y + (-ANCHOR.damage - (burst ? f.lift * 34 : 0) - 190 * s + 330 * s * s) * sc,
            size: Math.max(preset.minSize * pixel, preset.baseSize * sc) * grow * bigger,
            stroke: (gold ? 5 : quiet ? 2.5 : 3.5) * Math.max(0.7, sc) * Math.min(1, grow),
        };
    }

    static text(ctx, text, x, y, size, fill, stroke, alpha, width) {
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        ctx.font = `900 ${size}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        ctx.lineWidth = Math.max(2, width);
        ctx.strokeStyle = stroke;
        ctx.strokeText(text, x, y);
        ctx.fillStyle = fill;
        ctx.fillText(text, x, y);
    }

    // `f`: { kind, text, dir (-1|1), spread (-0.5..0.5), kill }, `preset`: its size and lifetime, `x`,`y`: its
    // ground position on screen, `sc`: the world's screen scale, `age`: ms since it appeared, `pixel`: canvas
    // pixels per CSS pixel (the least sizes are CSS pixels), `crowded`: see crowdAt.
    static draw(ctx, f, preset, x, y, sc, age, pixel, crowded, placement = null) {
        const life = f.kill ? this.killLifeMs : preset.lifeMs,
            t = age / life,
            quiet = crowded && this.isOrdinaryUnitDamage(f),
            size = (pop) => Math.max(preset.minSize * pixel, preset.baseSize * sc) * pop;
        ctx.save();
        if (f.kind === 'damageDealt' || f.kind === 'damageTaken') {
            const taken = f.kind === 'damageTaken';
            const gold = f.kill && !taken;
            const pose = placement ?? this.damagePose(f, preset, x, y, sc, age, pixel, quiet);
            this.text(
                ctx,
                f.text,
                pose.x,
                pose.y,
                pose.size,
                age < 60 ? '#ffffff' : taken ? '#ff8a8a' : gold ? '#ffcc1f' : '#fffdf0',
                taken ? '#4b0909' : gold ? '#5e2a00' : '#3f2a14',
                (t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3) * (quiet ? 0.6 : 1),
                pose.stroke,
            );
        } else if (f.kind === 'heroHeal') {
            const base = y - ANCHOR.heal * sc;
            ctx.globalAlpha = Math.max(0, 1 - t);
            ctx.fillStyle = '#b7ffb0';
            for (let i = 0; i < 5; i++) {
                const px = x + Math.sin(i * 2.4 + f.spread * 9) * 17 * sc,
                    py = y - (((age / 12 + i * 17) % 46) - 8) * sc;
                ctx.fillRect(px - sc, py - 4 * sc, 2 * sc, 8 * sc);
                ctx.fillRect(px - 4 * sc, py - sc, 8 * sc, 2 * sc);
            }
            this.text(
                ctx,
                f.text,
                x,
                base - 34 * eased(t) * sc,
                size(t < 0.18 ? outBack(t / 0.18) : 1),
                '#a6ff9c',
                '#0f4515',
                t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3,
                4 * Math.max(0.7, sc),
            );
        } else if (f.kind === 'heroLevelUp') {
            const pop = t < 0.16 ? outBack(t / 0.16) : 1,
                alpha = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25,
                unit = size(1) / preset.baseSize;
            ctx.translate(x, y - (ANCHOR.level + 14 * t) * sc);
            ctx.scale(pop * unit, pop * unit);
            ctx.globalAlpha = Math.max(0, alpha);
            ctx.strokeStyle = '#ffe066';
            ctx.lineWidth = 3;
            ctx.beginPath();
            const reach = 30 + 14 * Math.min(1, t * 3);
            for (let i = 0; i < 8; i++) {
                const a = (i * Math.PI) / 4 + t * 1.5;
                ctx.moveTo(Math.cos(a) * 28, Math.sin(a) * 14);
                ctx.lineTo(Math.cos(a) * reach, Math.sin(a) * reach * 0.5);
            }
            ctx.stroke();
            ctx.fillStyle = '#7a4a06';
            ctx.beginPath();
            ctx.roundRect(-29, -11, 58, 22, 11);
            ctx.fill();
            this.text(ctx, f.text, 0, 1, preset.baseSize, '#fff2a8', '#4a2a00', alpha, 3);
        } else {
            this.text(
                ctx,
                f.text,
                x + f.dir * 16 * t * sc,
                y - (ANCHOR.dodge + 10 * Math.sin(t * Math.PI)) * sc,
                size(1),
                '#e4efff',
                '#1a3d64',
                t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4,
                3 * Math.max(0.7, sc),
            );
        }
        ctx.restore();
    }
}
