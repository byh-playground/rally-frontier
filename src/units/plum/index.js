import { GRAIN_SIZE, RESOURCE_SCALE, SINGLE_BUNDLE_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

const acid = Object.freeze({
    radius: 50,
    durationMs: 2500,
    maxStacks: 5,
    bonusPerStack: 2,
});

export const Plum = defineUnit({
    id: 'plum',
    unit: {
        name: '매실',
        hp: 25,
        atk: 5,
        range: 200,
        sight: 275,
        speed: 50,
        size: GRAIN_SIZE,
        sizeClass: 'light',
        role: 'ranged',
        requiresContactTerrain: false,
        construction: { range: 5, workPerHit: 1 },
        damageClass: 'normal',
        attackIntervalMs: 1000,
        attackWindupMs: 200,
        attackVisual: { sourceMotion: null, travel: 'lob', impact: 'light' },
        lobAttack: Object.freeze({
            shots: 1,
            shotGapMs: 100,
            projectileSpeed: 400,
            launchOffsetX: 25,
            launchHeight: 25,
            gravity: 650,
            radius: 5,
            mass: 5,
            restitution: 0,
            settleSpeed: 15,
            groundFriction: 8,
            fuseMs: 0,
            explosionRadius: acid.radius,
            explosionDamageScale: 1,
        }),
        plumAcid: acid,
    },
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        cost: 30 * RESOURCE_SCALE,
        premiumCost: 5 * RESOURCE_SCALE,
        count: 6,
        shellHp: 25,
        impact: 10,
        splash: 50,
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.9,
        accent: [0.63, 0.72, 0.25, 1],
        fx: 'ranged',
    },
    card: {
        role: '산성 지원',
        feature: '매실즙 범위 타격 · 명중당 추가 피해',
        land: '착지점에서 사방으로 튀어나옴',
        fire: '단발',
        notes: [
            '산성 매실즙을 뿌려 적에게 표식을 남겨요. 표식이 묻은 적은 아군의 직접 공격에 맞을 때마다 더 크게 다쳐요.',
            '즙탄이 맞을 때 표식이 하나씩 붙어요. 표식마다 따로 사라지고, 최대 중첩에서는 가장 먼저 끝날 표식의 시간만 갱신돼요.',
            '한 발씩 자주 쏘는 병사와 함께 쓰면 강해요. 사거리 안에서 단단한 껍질을 가진 적을 먼저 노려요.',
        ],
    },
    help: [
        {
            section: 'construction',
            summary: '매실의 산성 표식',
            paragraphs: [
                '매실즙이 튄 범위 안의 적 지상 병력에게 표식이 하나씩 붙어요. 지글거리는 산성 기포와 숫자로 표식 수를 확인할 수 있어요.',
                '메밀이나 해바라기씨가 표식이 붙은 적을 직접 맞히면 타격마다 추가 피해를 줘요.',
            ],
        },
    ],
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
