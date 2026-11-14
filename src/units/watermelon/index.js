import {
    COCONUT_MASS,
    GRAIN_SIZE,
    GRAIN_SPRITE_BASE_SCALE,
    HERO_MOVE_SPEED,
    HERO_SHELL,
    UNIT_RENDER_RADIUS_SCALE,
} from '../baseline.js';
import { defineUnit } from '../define-unit.js';
import { VIEW_W } from '../../definitions/world-rules.js';

// Approved rind half-width in sheet units; the roll's hit radius and the roll art both read it.
export const WATERMELON_RIND_RADIUS_X = 118;
const WATERMELON_SIZE = GRAIN_SIZE * 3.5;
const WATERMELON_VISUAL_SCALE = 1;
// The roll hits what the drawn rind touches.
const WATERMELON_RIND_WORLD_RADIUS =
    WATERMELON_SIZE *
    UNIT_RENDER_RADIUS_SCALE *
    GRAIN_SPRITE_BASE_SCALE *
    WATERMELON_VISUAL_SCALE ** 2 *
    WATERMELON_RIND_RADIUS_X;

export const Watermelon = defineUnit({
    id: 'watermelon',
    hero: true,
    unit: {
        requiresContactTerrain: true,
        name: '수박',
        hp: 550,
        atk: 20,
        range: 25,
        speed: HERO_MOVE_SPEED,
        attackIntervalMs: 500,
        size: WATERMELON_SIZE,
        // The big rind weighs twice a coconut, so its roll throws harder than a coconut at the same speed.
        mass: COCONUT_MASS * 2,
        sizeClass: 'heavy',
        role: 'bruiser',
        attackVisual: { sourceMotion: 'smash', travel: 'none', impact: 'light' },
        sight: 275,
        // The basic attack also hits the soldiers around the struck one (BasicSplash).
        basicSplash: Object.freeze({ radius: 25, damageRatio: 0.5 }),
        // The hop-and-roll ability (HeroRollAttack). No player command starts it any more; it stays for the
        // automatic skill planned for a later hero level.
        heroActive: Object.freeze({
            cost: 100,
            range: 250,
            hopMs: 500,
            hopHeight: WATERMELON_SIZE * 3,
            landing: Object.freeze({ radius: VIEW_W / 6, damageRatio: 1 }),
            rollSpeed: 250,
            rollHitRadius: WATERMELON_RIND_WORLD_RADIUS,
            rollDistance: WATERMELON_RIND_WORLD_RADIUS * 2 * 3,
            unfoldMs: 100,
            damageRatio: 1,
        }),
        spinAttack: Object.freeze({
            radius: 150,
            windupMs: 500,
            activeMs: 500,
            recoverMs: 250,
            arcSweep: true,
            rhythm: Object.freeze({ basicsPerSweep: 4 }),
            tangentRatio: 0,
        }),
        // Level unlocks (HeroGrowth.unlocked). Level 2: juice splashes from each soldier it finishes and heals it.
        growth: Object.freeze({
            2: Object.freeze({ killEffect: Object.freeze({ heal: 15 }) }),
        }),
    },
    payload: {
        ...HERO_SHELL,
        shellHp: 65,
        // Landing (HeroLandingStrike): the ground shakes, then the rind rolls two of its widths back home.
        landingStrike: Object.freeze({
            radius: 150,
            damage: 40,
            knockback: 'area',
            retreat: Object.freeze({
                motion: 'roll',
                distance: WATERMELON_RIND_WORLD_RADIUS * 2 * 2,
            }),
        }),
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: WATERMELON_VISUAL_SCALE,
        accent: [0.26, 0.69, 0.38, 1],
        fx: 'melee',
    },
    card: {
        role: '범위 근접 영웅',
        feature: '범위 평타 4회 → 양팔 360도 휩쓸기',
        land: '영웅 한 명 출격',
        fire: '영웅 단발',
        notes: [
            '착지하면 땅을 울려 주변 적을 밀치고 본진 쪽으로 굴러 빠져요.',
            '평타 네 번 뒤 양팔로 적을 휩쓸어요.',
            '2레벨: 막타를 치면 과즙이 튀어 체력 15 회복',
        ],
    },
    help: [
        {
            section: 'hero',
            summary: '수박의 범위 평타와 휩쓸기',
            paragraphs: [
                '수박의 평타는 맞은 적 주변의 병력에도 피해를 주고 살짝 밀어내요. 병력에게 평타가 네 번 맞으면 다음 공격에 양팔로 몸 주변을 휩쓸어 평타와 같은 피해를 주고 적을 밀어내요.',
                '수박 카드의 점이 모두 차면 다음 공격에 휩쓸기를 써요.',
                '착지하는 순간 땅을 울려 반경 150 안의 적에게 피해 40을 주고 밀쳐낸 뒤, 껍질 지름 두 배만큼 본진 쪽으로 굴러 빠져요.',
                '2레벨: 수박이 막타로 적 병력을 쓰러뜨리면 과즙이 튀어 체력이 15 차요.',
            ],
        },
    ],
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
