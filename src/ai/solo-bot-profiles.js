import { LaunchRules } from '../sim/launch-rules.js';
import { HashUtil } from '../sim/map-generation.js';
import { soloBotTactics } from './solo-bot-tactics.js';
import { soloBotThemes } from './solo-bot-themes.js';

function makeProfile(id, definition, kind) {
    const {
        name,
        signature,
        support,
        decisionIntervalMs = 1000,
        preferredResource = 'premium',
    } = definition;
    const weights = { ...signature, ...Object.fromEntries(support.map((type) => [type, 1])) };
    return Object.freeze({
        id,
        kind,
        name,
        decisionIntervalMs,
        preferredResource,
        introVolleys: kind === 'theme' ? (definition.introVolleys ?? 2) : 0,
        signature: Object.freeze(Object.keys(signature)),
        weights: Object.freeze(weights),
        deck: Object.freeze(LaunchRules.normalizeDeck(Object.keys(weights))),
        ...(kind === 'tactic' ? { operation: definition } : {}),
    });
}

const profiles = new Map([
    ...Object.entries(soloBotTactics).map(([id, definition]) => [
        id,
        makeProfile(id, definition, 'tactic'),
    ]),
    ...Object.entries(soloBotThemes).map(([id, definition]) => [
        id,
        makeProfile(id, definition, 'theme'),
    ]),
]);
const profileIds = Array.from(profiles.keys());

export function soloBotProfile(id) {
    const profile = profiles.get(id);
    if (!profile) throw new Error('알 수 없는 1대1 AI 프리셋: ' + id);
    return profile;
}

export function soloBotProfileForSeed(seed) {
    return soloBotProfile(profileIds[(HashUtil.hash(seed + '|solo-ai') >>> 0) % profileIds.length]);
}
