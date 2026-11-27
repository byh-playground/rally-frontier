// Theme cards lead the deck. Support cards keep ordinary defense and capture available.
export const soloBotThemes = {
    'bean-field': {
        name: '콩밭 단골',
        preferredResource: 'basic',
        signature: { pea: 10, redbean: 8, 'black-bean': 7, peanut: 5 },
        support: ['rice', 'millet', 'chestnut', 'sesame'],
    },
    'nut-grove': {
        name: '밤숲 수집가',
        introVolleys: 0,
        preferredResource: 'premium',
        signature: { walnut: 11, chestnut: 9, acorn: 8 },
        support: ['rice', 'pea', 'buckwheat', 'chili', 'sesame'],
    },
    'corn-pair': {
        name: '옥수수 두 가지',
        preferredResource: 'premium',
        signature: { popcorn: 12, corn: 11 },
        support: ['millet', 'rice', 'pea', 'walnut', 'buckwheat', 'sesame'],
    },
    'wind-seeds': {
        name: '바람에 날리는 씨앗',
        preferredResource: 'premium',
        signature: { dandelion: 12, cotton: 8, 'sunflower-seed': 7 },
        support: ['rice', 'walnut', 'pea', 'sesame', 'chestnut'],
    },
    'single-grain': {
        name: '한 알씩 보내는 상대',
        preferredResource: 'premium',
        signature: { walnut: 12, coconut: 10, potato: 9 },
        support: ['rice', 'pea', 'buckwheat', 'sesame', 'sunflower-seed'],
    },
    'leap-and-flight': {
        name: '땅에 발 붙이기 싫어함',
        preferredResource: 'basic',
        signature: { redbean: 12, popcorn: 10, dandelion: 8 },
        support: ['millet', 'pea', 'sesame', 'walnut', 'chestnut'],
    },
};
