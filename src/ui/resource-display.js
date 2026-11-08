// Shared display rules for both currencies. Amounts are owned by the simulation.
export const RESOURCES = Object.freeze([
    { key: 'basic', name: '기본 자원', symbol: '◆', costKey: 'cost' },
    { key: 'premium', name: '고급 자원', symbol: '✦', costKey: 'premiumCost' },
]);

export class ResourceDisplay {
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
