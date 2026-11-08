const SIM_TPS = 20;
class RangeUtil {
    static clamp(v, a, b) {
        return Math.max(a, Math.min(b, v));
    }
}
class GameRuleDefinition {
    static presets = {
        standard: {},
    };
    static defaults = {
        schemaVersion: 2,
        modeId: 'standard',
        simulation: { tps: 10 },
        map: {
            generator: 'procedural-frontier',
            generatorVersion: 11,
            width: 4200,
            height: 4800,
            biome: 'frontier',
            topology: 'mixed',
            symmetry: 'rotational-180',
            openness: 0.5,
            chokeDensity: 0.5,
            obstacleDensity: 0.5,
            spawns: { host: { x: 525, y: 4285 }, guest: { x: 3675, y: 515 } },
            generation: {
                seedSalt: 'map',
                attempts: 40,
                minSpawnClearance: 560,
                minObjectiveClearance: 260,
                minLaneSeparationRatio: 0.07,
                fairnessTolerance: 0.08,
            },
        },
    };
    static resolve({ presetId = 'standard', overrides = null } = {}) {
        if (!Object.prototype.hasOwnProperty.call(this.presets, presetId))
            throw new Error(`지원하지 않는 경기 preset: ${presetId}`);
        const preset = this.presets[presetId];
        if (overrides) GameRuleRuntime.validatePatch(this.defaults, overrides);
        const presetResolved = GameRuleRuntime.mergeGameRules(this.defaults, preset);
        const resolved = overrides
            ? GameRuleRuntime.mergeGameRules(presetResolved, overrides)
            : presetResolved;
        resolved.modeId = presetId;
        return resolved;
    }
    static current = null;
}

class GameRuleRuntime {
    static normalizeMatchConfig(config = null) {
        const src = config && typeof config === 'object' ? config : {};
        const presetId = src.presetId ?? 'standard';
        if (!Object.prototype.hasOwnProperty.call(GameRuleDefinition.presets, presetId))
            throw new Error(`지원하지 않는 경기 preset: ${presetId}`);
        const overrides =
            src.overrides && typeof src.overrides === 'object' && !Array.isArray(src.overrides)
                ? structuredClone(src.overrides)
                : null;
        const simulationTps = RangeUtil.clamp(
            Math.round(Number(src.simulationTps) || SIM_TPS),
            10,
            30,
        );
        return {
            schemaVersion: 5,
            presetId,
            overrides,
            simulationTps,
            campaignStage: typeof src.campaignStage === 'string' ? src.campaignStage : null,
        };
    }
    static mergeGameRules(base, override) {
        if (!override || typeof override !== 'object') return structuredClone(base);
        const out = structuredClone(base);
        const merge = (dst, src) => {
            for (const [k, v] of Object.entries(src || {})) {
                if (['__proto__', 'constructor', 'prototype'].includes(k))
                    throw new Error(`허용되지 않는 설정 키: ${k}`);
                if (v && typeof v === 'object' && !Array.isArray(v)) {
                    if (
                        !Object.prototype.hasOwnProperty.call(dst, k) ||
                        !dst[k] ||
                        typeof dst[k] !== 'object' ||
                        Array.isArray(dst[k])
                    )
                        dst[k] = {};
                    merge(dst[k], v);
                } else dst[k] = structuredClone(v);
            }
            return dst;
        };
        return merge(out, override);
    }
    static validatePatch(schema, patch, path = 'rules') {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch))
            throw new Error(`${path}: 설정 객체가 필요합니다.`);
        for (const [key, value] of Object.entries(patch)) {
            const current = `${path}.${key}`;
            if (!Object.prototype.hasOwnProperty.call(schema, key))
                throw new Error(`${current}: 실행 경로가 없는 설정입니다.`);
            const expected = schema[key];
            if (Array.isArray(expected)) {
                if (!Array.isArray(value)) throw new Error(`${current}: 배열이 필요합니다.`);
            } else if (expected && typeof expected === 'object')
                this.validatePatch(expected, value, current);
            else if (
                typeof value !== typeof expected ||
                (typeof value === 'number' && !Number.isFinite(value))
            )
                throw new Error(`${current}: 올바른 ${typeof expected} 값이 필요합니다.`);
        }
    }
    static resolveMatchRules({ presetId = 'standard', matchOverrides = null } = {}) {
        return {
            ...GameRuleDefinition.resolve({ presetId, overrides: matchOverrides }),
            roundNumber: 1,
        };
    }
}
GameRuleDefinition.current = GameRuleDefinition.resolve();
export { RangeUtil, GameRuleDefinition, GameRuleRuntime, SIM_TPS };
