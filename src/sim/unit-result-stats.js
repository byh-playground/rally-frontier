import { LaunchRules } from './launch-rules.js';

// Authoritative, bounded match totals. A launch payload is counted only when
// its unit actually spawns; damage is limited to the target's remaining HP.
export class UnitResultStats {
    static fields = Object.freeze(['deployed', 'unitDamage', 'buildingDamage', 'kills']);

    static create() {
        return [0, 1].map(() =>
            Object.fromEntries(
                Object.keys(LaunchRules.grains).map((type) => [
                    type,
                    { deployed: 0, unitDamage: 0, buildingDamage: 0, kills: 0 },
                ]),
            ),
        );
    }

    static add(stats, side, type, field, amount = 1) {
        if ((side !== 0 && side !== 1) || !LaunchRules.grain(type)) return;
        const entry = stats?.[side]?.[type];
        if (!entry || !this.fields.includes(field) || !Number.isFinite(amount) || amount < 0)
            throw new Error('병종별 경기 통계가 올바르지 않습니다.');
        const next = entry[field] + amount;
        if (
            !Number.isFinite(next) ||
            next < 0 ||
            next > Number.MAX_SAFE_INTEGER ||
            ((field === 'deployed' || field === 'kills') && !Number.isSafeInteger(next))
        )
            throw new Error('병종별 경기 통계가 허용 범위를 넘었습니다.');
        entry[field] = next;
    }

    static validate(stats) {
        const types = Object.keys(LaunchRules.grains).sort();
        if (!Array.isArray(stats) || stats.length !== 2)
            throw new Error('병종별 경기 통계가 올바르지 않습니다.');
        for (const side of stats) {
            if (!side || Array.isArray(side) || typeof side !== 'object')
                throw new Error('병종별 경기 통계가 올바르지 않습니다.');
            if (JSON.stringify(Object.keys(side).sort()) !== JSON.stringify(types))
                throw new Error('병종별 경기 통계의 병종이 올바르지 않습니다.');
            for (const type of types) {
                const entry = side[type];
                if (
                    !entry ||
                    Array.isArray(entry) ||
                    typeof entry !== 'object' ||
                    JSON.stringify(Object.keys(entry).sort()) !==
                        JSON.stringify([...this.fields].sort()) ||
                    this.fields.some(
                        (field) =>
                            !Number.isFinite(entry[field]) ||
                            entry[field] < 0 ||
                            entry[field] > Number.MAX_SAFE_INTEGER ||
                            ((field === 'deployed' || field === 'kills') &&
                                !Number.isSafeInteger(entry[field])),
                    )
                )
                    throw new Error('병종별 경기 통계 값이 올바르지 않습니다.');
            }
        }
        return stats;
    }
}
