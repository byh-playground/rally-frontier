import { LaunchRules } from '../sim/launch-rules.js';
import { HashUtil } from '../sim/map-generation.js';

// The configured cards are both the deck and their relative share of combat volleys.
const definitions = {
    expansion: {
        name: '거점 선점형',
        decisionIntervalMs: 1000,
        preferredResource: 'basic',
        weights: {
            sesame: 1,
            buckwheat: 8,
            rice: 5,
            pea: 3,
            walnut: 2,
            chestnut: 2,
            'sunflower-seed': 1,
            popcorn: 1,
        },
    },
    pressure: {
        name: '초반 압박형',
        decisionIntervalMs: 800,
        openingAdvanceVolleys: 2,
        weights: {
            millet: 9,
            redbean: 7,
            'black-bean': 5,
            pea: 3,
            popcorn: 3,
            rice: 2,
            chili: 2,
            cotton: 1,
        },
    },
    siege: {
        name: '포격형',
        decisionIntervalMs: 1100,
        attackPriority: 'buildings',
        weights: {
            corn: 9,
            chestnut: 7,
            walnut: 4,
            cotton: 3,
            'sunflower-seed': 2,
            rice: 2,
            buckwheat: 1,
            popcorn: 1,
        },
    },
};

const profiles = Object.fromEntries(
    Object.entries(definitions).map(([id, spec]) => [
        id,
        Object.freeze({
            id,
            ...spec,
            weights: Object.freeze(spec.weights),
            deck: Object.freeze(LaunchRules.normalizeDeck(Object.keys(spec.weights))),
        }),
    ]),
);
const profileIds = Object.keys(profiles);

export function soloBotProfile(id) {
    if (!Object.hasOwn(profiles, id)) throw new Error('알 수 없는 1대1 AI 프리셋: ' + id);
    return profiles[id];
}

export function soloBotProfileForSeed(seed) {
    return soloBotProfile(profileIds[HashUtil.hash(seed + '|solo-ai') % profileIds.length]);
}
