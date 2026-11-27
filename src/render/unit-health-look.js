const SHOW_MS = 1200;
const FADE_MS = 400;
const CRITICAL_RATIO = 0.4;

// Damage is tracked from simulation snapshots, including units outside the camera.
export class UnitHealthLook {
    previous = new Map();
    next = new Map();

    reset() {
        this.previous.clear();
        this.next.clear();
    }

    observe(units, tick) {
        for (const unit of units) {
            if (!unit.alive || unit.hp <= 0) continue;
            const state = this.previous.get(unit.id) ?? { hp: unit.hp, hurtTick: null };
            if (unit.hp >= unit.maxHp) state.hurtTick = null;
            else if (unit.hp < state.hp) state.hurtTick = tick;
            state.hp = unit.hp;
            this.next.set(unit.id, state);
        }
        this.previous.clear();
        [this.previous, this.next] = [this.next, this.previous];
    }

    bar(unit, tick, tickMs, persistent) {
        if (!unit.alive || unit.hp <= 0 || unit.hp >= unit.maxHp) return null;
        const ratio = unit.hp / unit.maxHp;
        const hurtTick = this.previous.get(unit.id)?.hurtTick;
        const age = hurtTick == null ? Infinity : (tick - hurtTick) * tickMs;
        const critical = ratio <= CRITICAL_RATIO;
        if (persistent) return { mode: 'persistent', ratio, opacity: 1 };
        if (age >= 0 && age < SHOW_MS)
            return { mode: 'recent', ratio, opacity: Math.min(1, (SHOW_MS - age) / FADE_MS) };
        return critical ? { mode: 'critical', ratio, opacity: 1 } : null;
    }
}

export function drawUnitHealthBar(
    ctx,
    { x, y, width, height, pixelRatio, ratio, opacity, faction },
) {
    const left = Math.round(x - width / 2),
        top = Math.round(y),
        border = Math.max(1, pixelRatio);
    ctx.globalAlpha = opacity;
    ctx.fillStyle = '#12171b';
    ctx.fillRect(left - border, top - border, width + 2 * border, height + 2 * border);
    if (faction === 'friendly' || faction === 'enemy') {
        ctx.fillStyle = faction === 'friendly' ? '#76a9ff' : '#ff9088';
        ctx.fillRect(left - 3 * border, top - border, 2 * border, height + 2 * border);
    }
    ctx.fillStyle = '#475159';
    ctx.fillRect(left, top, width, height);
    ctx.fillStyle = ratio <= CRITICAL_RATIO ? '#ef7464' : '#8fe27e';
    ctx.fillRect(left, top, Math.max(pixelRatio, width * ratio), height);
    ctx.globalAlpha = 1;
}
