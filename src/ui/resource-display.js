import { LaunchRules } from '../sim/launch-rules.js';

// Shared display rules for both currencies. Amounts are owned by the simulation.
export const RESOURCES = Object.freeze([
    { key: 'basic', name: '식량', symbol: '◆', color: '#9bd7ff', costKey: 'cost' },
    { key: 'premium', name: '기름', symbol: '✦', color: '#f6ca76', costKey: 'premiumCost' },
]);

export class ResourceDisplay {
    static depositName(point, kind) {
        // Map descriptors are part of match identity, so translate their stored names at display time.
        const label = point.label || point.lane;
        const name = kind.key === 'basic' ? label.replace(/보급(?= 거점$)/, kind.name) : label;
        return name.includes(kind.name) ? name : `${name} ${kind.name} 거점`;
    }

    static rateText(rate) {
        return String(Number(rate.toFixed(4)));
    }

    static renderWallet(host, s, side, balance) {
        if (!host.childElementCount) {
            host.innerHTML = RESOURCES.map(
                ({ key, symbol, name }) =>
                    `<div class="launch-resource" data-resource="${key}"><span class="launch-resource-name">${symbol} ${name}</span><b class="launch-resource-balance"></b><span class="launch-resource-meter" aria-hidden="true"><span></span></span><span class="launch-resource-state"></span>${key === 'basic' ? '<span class="launch-resource-state launch-base-income"></span>' : ''}</div>`,
            ).join('');
        }
        const producers = [...s.baseProducers, ...s.capturePoints];
        const base = s.baseProducers[side];
        host.querySelector('.launch-base-income').textContent =
            `본진 효율 ${LaunchRules.productionEfficiency(base)}% · +${this.rateText(LaunchRules.productionRate(base, 'basic'))}/초`;
        for (const [index, { key }] of RESOURCES.entries()) {
            const panel = host.children[index];
            const cap = key === 'premium' ? LaunchRules.premiumWalletCap : LaunchRules.walletCap;
            const amount = balance[key];
            const rate = LaunchRules.incomePerSecondFor(producers, side, key);
            panel.querySelector('.launch-resource-balance').textContent = `${amount}/${cap}`;
            panel.style.setProperty(
                '--balance',
                `${Math.min(100, Math.round((100 * amount) / cap))}%`,
            );
            panel.querySelector('.launch-resource-state').textContent =
                rate > 0
                    ? `+${this.rateText(rate)}/초${amount >= cap ? ' · 한도 대기' : ''}`
                    : key === 'premium'
                      ? '기름 거점 필요'
                      : '수입 없음';
        }
    }

    static drawDepositMarker(ctx, x, y, radius, type, ownerColor, locked = false) {
        const oil = type === 'premium';
        const kind = oil ? RESOURCES[1] : RESOURCES[0];
        ctx.save();
        if (locked) ctx.globalAlpha *= 0.6;
        ctx.beginPath();
        ctx.arc(x, y, radius + 1.5, 0, Math.PI * 2);
        ctx.fillStyle = '#14261d';
        ctx.fill();
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = ownerColor;
        ctx.stroke();

        const arm = radius * 0.28;
        ctx.beginPath();
        ctx.moveTo(x, y - radius);
        if (oil) ctx.lineTo(x + arm, y - arm);
        ctx.lineTo(x + radius, y);
        if (oil) ctx.lineTo(x + arm, y + arm);
        ctx.lineTo(x, y + radius);
        if (oil) ctx.lineTo(x - arm, y + arm);
        ctx.lineTo(x - radius, y);
        if (oil) ctx.lineTo(x - arm, y - arm);
        ctx.closePath();
        ctx.fillStyle = kind.color;
        ctx.fill();
        ctx.restore();
    }

    static costs(price) {
        return RESOURCES.flatMap((kind) =>
            price[kind.costKey] > 0 ? [{ ...kind, amount: price[kind.costKey] }] : [],
        );
    }

    static costText(price, named = false) {
        return (
            this.costs(price)
                .map(({ name, symbol, amount }) => `${named ? name : symbol} ${amount}`)
                .join(' · ') || '무료'
        );
    }

    static shortfalls(price, balance) {
        return this.costs(price).filter(({ key, amount }) => balance[key] < amount);
    }

    static shortageText(price, balance) {
        return this.shortfalls(price, balance)
            .map(({ key, name, amount }) => `${name} ${amount - balance[key]} 부족`)
            .join(' · ');
    }

    static costMarkup(price) {
        return (
            this.costs(price)
                .map(
                    ({ key, symbol, amount }) =>
                        `<span data-cost-resource="${key}">${symbol} ${amount}</span>`,
                )
                .join('') || '무료'
        );
    }
}
