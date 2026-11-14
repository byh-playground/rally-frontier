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
    },
    payload: { ...HERO_SHELL, shellHp: 65 },
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
            '평타 네 번 뒤 양팔로 적을 휩쓸어요.',
            '스킬로 뛰어올라 착지한 뒤 적을 향해 굴러요.',
        ],
    },
    help: [
        {
            section: 'hero',
            summary: '수박의 범위 평타와 휩쓸기',
            paragraphs: [
                '수박의 평타는 맞은 적 주변의 병력에도 피해를 주고 살짝 밀어내요. 병력에게 평타가 네 번 맞으면 다음 공격에 양팔로 몸 주변을 휩쓸어 평타와 같은 피해를 주고 적을 밀어내요.',
                '수박 카드의 점이 모두 차면 다음 공격에 휩쓸기를 써요.',
            ],
        },
        {
            section: 'hero-skill',
            summary: '수박의 액티브 스킬',
            paragraphs: [
                '수박은 제자리에서 높이 뛰었다가 착지하면서 충격파로 주변 적 병력에 피해를 주고 살짝 밀어내요. 점프 중에는 바닥의 원이 충격파 범위를, 화살표가 구르기 방향과 경로를 알려 줘요. 처음 겨눈 적 방향으로 몸통 지름의 세 배만큼 굴러가며 몸통 폭에 닿은 적을 코코넛처럼 멀리 쳐 내고(맞고 쓰러진 적도 날아가요), 지형이나 건물에 닿으면 멈춰요.',
            ],
        },
    ],
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
