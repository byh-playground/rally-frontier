import { isDifficulty } from '../definitions/campaign-pace.js';
import { newRosterRecord } from '../definitions/roster.js';

// Player records on this device, kept through the GameKit save module. Only this file picks the storage:
// a debug address (`?debug=1&scene=…`) and automated tests (navigator.webdriver) keep every record in memory,
// so they neither read nor write the real saves.
//   roster: the owned cards plus the new campaign's progress and sunshine (the single source of what is owned).
//   decks: the three loadouts and the selected one. hints: one-time notices seen.
// Each record lives at `ssalkongpang/<key>` with the module's schema and revision. When it does not exist yet,
// `create()` copies the record the game kept before the save module (the old keys stay untouched).
const PREFIX = 'ssalkongpang/';
const LEGACY_KEYS = Object.freeze({
    decks: 'ssalkongpang.decks.v1',
    volleyAimHint: 'ssalkongpang.volley-aim-hint.v1',
});
// The loadout shape the deck editor saved before the save module (`version` there is not the record schema).
const LEGACY_LOADOUT_VERSION = 3;

function readLegacy(key) {
    try {
        return JSON.parse(localStorage.getItem(key) ?? 'null');
    } catch {
        return null;
    }
}

const isStringList = (value) =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');

function validateDecks(data) {
    if (
        !Number.isInteger(data.selected) ||
        !Array.isArray(data.decks) ||
        !data.decks.every(
            (deck) =>
                Array.isArray(deck) &&
                deck.every((type) => type === null || typeof type === 'string'),
        )
    )
        throw new TypeError('deck record');
}

function validateRoster(data) {
    const progress = data.campaign;
    if (
        !isStringList(data.owned) ||
        !progress ||
        !isStringList(progress.firstCleared) ||
        !isStringList(progress.sideGoalCleared) ||
        !isStringList(progress.hardCleared) ||
        !Number.isInteger(progress.sunshine) ||
        progress.sunshine < 0 ||
        !isStringList(progress.upgrades) ||
        !isStringList(progress.regionOrder) ||
        !isDifficulty(progress.difficulty)
    )
        throw new TypeError('roster record');
}

function validateHints(data) {
    if (typeof data.volleyAim !== 'boolean') throw new TypeError('hint record: volleyAim');
}

function openAdapter(gamekit, isolated) {
    if (isolated) return { adapter: gamekit.memoryAdapter(), legacy: () => null };
    try {
        return {
            adapter: gamekit.localStorageAdapter({ prefix: PREFIX, storage: window.localStorage }),
            legacy: readLegacy,
        };
    } catch (error) {
        console.warn('이 기기 저장소를 열 수 없어 이번 접속에서만 유지합니다.', error);
        return { adapter: gamekit.memoryAdapter(), legacy: () => null };
    }
}

export function openPlayerSaves(gamekit, { isolated }) {
    const { adapter, legacy } = openAdapter(gamekit, isolated);
    const decks = gamekit.createSave({
        adapter,
        key: 'decks',
        version: 1,
        create: () => {
            const old = legacy(LEGACY_KEYS.decks);
            if (old?.version === LEGACY_LOADOUT_VERSION) {
                const copy = { selected: old.selected, decks: old.decks };
                try {
                    validateDecks(copy);
                    return structuredClone(copy);
                } catch {
                    // An unusable old loadout starts from the starter decks, as it did before.
                }
            }
            return { selected: 0, decks: [] };
        },
        validate: validateDecks,
    });
    const hints = gamekit.createSave({
        adapter,
        key: 'hints',
        version: 1,
        create: () => ({ volleyAim: legacy(LEGACY_KEYS.volleyAimHint) === 1 }),
        validate: validateHints,
    });
    const roster = gamekit.createSave({
        adapter,
        key: 'roster',
        version: 1,
        create: newRosterRecord,
        validate: validateRoster,
    });
    return { decks, hints, roster };
}

// Loads a record; an unreadable one stays locked (the module never overwrites it) and the game runs on defaults.
export async function loadPlayerSave(save, label) {
    try {
        return await save.load();
    } catch (error) {
        console.warn(`${label} 저장을 읽지 못해 이번 접속에서만 유지합니다.`, error);
        return null;
    }
}

// Saves through `mutate`; when another tab saved first, reads the newer record once and applies `mutate` to it.
export async function updatePlayerSave(save, mutate) {
    try {
        return await save.update(mutate);
    } catch (error) {
        if (error?.kind !== 'conflict') throw error;
        await save.load();
        return save.update(mutate);
    }
}
