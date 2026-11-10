import { RallyNetcode } from './gamekit.js';

class RallyStateCodec {
    static MAX_ARRAY = 20000;
    static maxBytes = 8 * 1024 * 1024;
    static codec = RallyNetcode.createValueCodec({
        format: 'binary',
        maxBytes: 8 * 1024 * 1024,
        maxDepth: 64,
        maxEntries: 500000,
    });
    static assertData(
        value,
        {
            maxNodes = 500000,
            maxArray = RallyStateCodec.MAX_ARRAY,
            maxString = 1024 * 1024,
            budget = null,
        } = {},
    ) {
        let count = 0;
        const seen = new Set();
        const visit = (v, depth) => {
            if (++count > maxNodes || depth > 64)
                throw new Error('게임 데이터의 크기 제한을 넘었습니다.');
            if (v === null || typeof v === 'boolean') return;
            if (typeof v === 'number') {
                if (!Number.isFinite(v))
                    throw new Error('게임 데이터에 유한하지 않은 숫자가 있습니다.');
                return;
            }
            if (typeof v === 'string') {
                if (v.length > maxString) throw new Error('게임 문자열이 너무 깁니다.');
                return;
            }
            if (typeof v !== 'object' || seen.has(v))
                throw new Error('게임 데이터는 순환 없는 JSON 값이어야 합니다.');
            seen.add(v);
            if (Array.isArray(v)) {
                if (v.length > maxArray) throw new Error('게임 배열이 너무 큽니다.');
                for (const x of v) visit(x, depth + 1);
            } else {
                const proto = Object.getPrototypeOf(v);
                if (proto !== Object.prototype && proto !== null)
                    throw new Error('게임 객체는 일반 데이터여야 합니다.');
                const keys = Object.keys(v);
                if (keys.length > 4096) throw new Error('게임 객체 필드가 너무 많습니다.');
                for (const key of keys) {
                    if (['__proto__', 'prototype', 'constructor'].includes(key))
                        throw new Error('게임 객체에 예약된 필드가 있습니다.');
                    visit(v[key], depth + 1);
                }
            }
            seen.delete(v);
        };
        visit(value, 0);
        if (budget) {
            budget.nodes = count;
            budget.maxNodes = maxNodes;
        }
        return value;
    }
    static encode(value) {
        return this.codec.encode(value);
    }
    static encodeInto(value, out) {
        return this.codec.encodeInto(value, out);
    }
    static decode(bytes, options) {
        return this.assertData(this.codec.decode(bytes), options);
    }
    static assertContract(value, contract) {
        if (!value || Array.isArray(value) || typeof value !== 'object')
            throw new Error('상태 소유자의 객체가 필요합니다.');
        for (const [key, initial] of Object.entries(contract.capture(contract.defaults, 'save'))) {
            if (
                !Object.prototype.hasOwnProperty.call(value, key) ||
                (initial !== null &&
                    (Array.isArray(initial)
                        ? !Array.isArray(value[key])
                        : typeof value[key] !== typeof initial))
            )
                throw new Error(`상태 소유자의 ${key} 필드가 잘못되었습니다.`);
        }
        for (const [key, child] of Object.entries(contract.children))
            this.assertContract(value[key], child);
    }
}
export { RallyStateCodec };
