// Cannon launch rules: income, wallet and grain data.
import { RangeUtil } from '../core/game-rules.js';

// Existing corn shell behaviour shared with the draft single-stalk deployment.
// Millet overrides the approved deployment and impact values below.
const SINGLE_BUNDLE_SHELL = Object.freeze({
    reach: 0.85,
    speed: 750,
    impact: 25,
    splash: 100,
    land: 'bundle',
    fire: Object.freeze({ mode: 'single' }),
});

// 발사전: 대포가 유닛 뭉치를 쏜다. 거리는 누른 시간만으로 정해지고, 조준 중에는 착지 원으로 미리 보인다(D-196).
// 한 발이 무겁다: 자원 단위는 기존 경제의 5배 환산 기준(D-233·D-235), 폭발 중심일수록 피해가 크다(D-230), 곡물마다 발사 방식이 다르다(D-234).
class LaunchRules {
    static resourceScale = 5;
    static incomePerSecond = 3 * this.resourceScale;
    static walletCap = 100 * this.resourceScale;
    static populationLimit = 300;
    static startingWallet = 50 * this.resourceScale;
    static minReach = 250;
    static maxReach = 500;
    static chargeMs = 1500;
    static overheatGraceMs = 180;
    static overheatMs = 2000;
    static reloadMs = 400;
    static speed = 750;
    static landingMarkMs = 1500;
    static captureHoldRadius = 400;
    static rangeMultipliers = Object.freeze([1, 2, 3]);
    static rangeUpgradeCosts = Object.freeze([50, 75].map((cost) => cost * this.resourceScale));
    static captureIncomePerSecond = 1 * this.resourceScale;
    static rangeMultiplier(level = 0) {
        return this.rangeMultipliers[level] ?? this.rangeMultipliers[0];
    }
    static upgradeCost(level) {
        return this.rangeUpgradeCosts[level] ?? null;
    }
    static incomePerSecondFor(capturePoints, side) {
        return (
            this.incomePerSecond +
            capturePoints.reduce(
                (n, p) => n + (p.owner === side ? this.captureIncomePerSecond : 0),
                0,
            )
        );
    }
    // 폭발 중심의 피해 배수. 가장자리는 1배, 중심은 centerPeak배이고 거리에 따라 제곱으로 줄어든다.
    static centerPeak = 3;
    static grains = Object.freeze({
        // 산탄: 한 번에 여러 갈래, 갈래마다 폭발은 작다.
        rice: Object.freeze({
            cost: 25 * this.resourceScale,
            count: 20,
            reach: 1,
            speed: 600,
            impact: 10,
            splash: 180,
            land: 'scatter',
            spread: 260,
            fire: Object.freeze({
                mode: 'shotgun',
                pellets: 5,
                spread: 400,
                impactScale: 0.6,
                splashScale: 0.7,
            }),
        }),
        // 단발: 폭발이 크고 중심 강타가 가장 세다.
        pea: Object.freeze({
            cost: 50 * this.resourceScale,
            count: 12,
            reach: 0.85,
            speed: 750,
            impact: 40,
            splash: 100,
            land: 'line',
            spacing: 22,
            fire: Object.freeze({ mode: 'single' }),
        }),
        // Provisional corn deployment: a single shell releases one grouped squad.
        corn: Object.freeze({
            ...SINGLE_BUNDLE_SHELL,
            cost: 50 * this.resourceScale,
            count: 6,
        }),
        popcorn: Object.freeze({
            ...SINGLE_BUNDLE_SHELL,
            cost: 35 * this.resourceScale,
            count: 10,
        }),
        millet: Object.freeze({
            ...SINGLE_BUNDLE_SHELL,
            cost: 35 * this.resourceScale,
            count: 20,
            impact: 10,
            splash: 50,
            deployTogether: true,
        }),
        chestnut: Object.freeze({
            cost: 50 * this.resourceScale,
            count: 6,
            reach: 0.85,
            speed: 750,
            impact: 10,
            splash: 100,
            land: 'bundle',
            fire: Object.freeze({ mode: 'single' }),
        }),

        // 연사: 같은 곳에 시간차로 세 번 떨어진다.
        redbean: Object.freeze({
            cost: 50 * this.resourceScale,
            count: 10,
            reach: 0.75,
            speed: 750,
            impact: 25,
            splash: 120,
            land: 'rush',
            rushMs: 2000,
            rushPct: 150,
            fire: Object.freeze({ mode: 'burst', shots: 3, gapMs: 300 }),
        }),
        // 도토리는 한 발당 한 병사씩 세 발을 쏜다.
        acorn: Object.freeze({
            cost: 75 * this.resourceScale,
            count: 3,
            reach: 0.85,
            speed: 750,
            impact: 25,
            splash: 100,
            land: 'bundle',
            fire: Object.freeze({ mode: 'burst', shots: 3, gapMs: 300 }),
        }),
    });
    static deck = Object.freeze(Object.keys(LaunchRules.grains));
    static normalizeDeck(deck) {
        if (
            !Array.isArray(deck) ||
            deck.length < 1 ||
            deck.length > this.deck.length ||
            new Set(deck).size !== deck.length ||
            deck.some((type) => typeof type !== 'string' || !this.grain(type))
        )
            throw new Error('덱은 중복 없는 유효한 병종을 하나 이상 포함해야 합니다.');
        return deck.slice();
    }
    static normalizeDeckPair(decks) {
        if (!Array.isArray(decks) || decks.length !== 2)
            throw new Error('양쪽 플레이어의 덱이 필요합니다.');
        return decks.map((deck) => this.normalizeDeck(deck));
    }
    static strike(distance, radius) {
        const k = RangeUtil.clamp(1 - distance / Math.max(1, radius), 0, 1);
        return 1 + (this.centerPeak - 1) * k * k;
    }
    static grain(type) {
        return Object.hasOwn(this.grains, type) ? this.grains[type] : null;
    }
    static payload(type) {
        const g = this.grain(type);
        return g ? { count: g.count, cost: g.cost } : null;
    }
    // Live units plus every already-authorized soldier who has not spawned yet.
    static population(state, side) {
        let alive = 0,
            reserved = 0;
        for (const unit of state?.units || [])
            if (unit.side === side && unit.alive !== false) alive++;
        for (const projectile of state?.projectiles || [])
            if (projectile.side === side && projectile.alive !== false && projectile.payload)
                reserved += projectile.payload.count;
        for (const group of state?.launchDeployments || [])
            if (group.side === side) reserved += Math.max(0, group.count - group.index);
        for (const cannon of state?.buildings || [])
            if (cannon.side === side && cannon.alive !== false)
                for (const shot of cannon.salvo || []) reserved += shot.count;
        return { alive, reserved, total: alive + reserved };
    }
    static overheated(holdMs) {
        return holdMs > this.chargeMs + this.overheatGraceMs;
    }
    static power(holdMs) {
        return RangeUtil.clamp(holdMs / this.chargeMs, 0, 1);
    }
    static maxReachOf(type, level = 0) {
        return Math.round(
            this.maxReach * this.rangeMultiplier(level) * (this.grain(type)?.reach ?? 1),
        );
    }
    static reach(holdMs, type, level = 0) {
        return Math.round(
            this.minReach + (this.maxReachOf(type, level) - this.minReach) * this.power(holdMs),
        );
    }
    // Inverse of reach(): the hold that lands a grain at this distance.
    static holdFor(distance, type, level = 0) {
        return (
            RangeUtil.clamp(
                (distance - this.minReach) /
                    Math.max(1, this.maxReachOf(type, level) - this.minReach),
                0,
                1,
            ) * this.chargeMs
        );
    }
    static arcHeight(distance) {
        return RangeUtil.clamp(Math.round(distance * 0.3), 80, 600);
    }
    // 한 번의 발사가 만드는 포탄 목록. 곡물 수는 포탄마다 나눠 담고(앞쪽이 나머지를 받는다),
    // 산탄은 부채꼴로 흩어지고, 연사는 같은 곳에 gapMs 간격으로 떨어진다.
    static volley(type, aim, cannon) {
        const g = this.grain(type),
            fire = g.fire,
            shots = [];
        const n = fire.mode === 'shotgun' ? fire.pellets : fire.mode === 'burst' ? fire.shots : 1;
        const base = Math.floor(g.count / n),
            extra = g.count % n;
        const dx = aim.x - cannon.x,
            dy = aim.y - cannon.y,
            len = Math.hypot(dx, dy) || 1;
        for (let i = 0; i < n; i++) {
            let x = aim.x,
                y = aim.y,
                delayMs = 0,
                impactScale = 1,
                splashScale = 1;
            if (fire.mode === 'shotgun') {
                // 폭(spread)은 거리와 무관하게 조준점 좌우로 일정하다.
                const off = n > 1 ? (i / (n - 1) - 0.5) * fire.spread : 0;
                x = Math.round(aim.x - (dy / len) * off);
                y = Math.round(aim.y + (dx / len) * off);
                impactScale = fire.impactScale;
                splashScale = fire.splashScale;
            } else if (fire.mode === 'burst') delayMs = i * fire.gapMs;
            shots.push({
                x,
                y,
                delayMs,
                count: base + (i < extra ? 1 : 0),
                impact: Math.max(1, Math.round(g.impact * impactScale)),
                splash: Math.max(1, Math.round(g.splash * splashScale)),
            });
        }
        return shots;
    }
    static volleyMs(type) {
        const fire = this.grain(type).fire;
        return fire.mode === 'burst' ? (fire.shots - 1) * fire.gapMs : 0;
    }
    // Direction comes from the press point; distance comes only from hold time.
    static target(cannon, x, y, holdMs, world, fallback, type, level = 0) {
        let dx = x - cannon.x,
            dy = y - cannon.y,
            len = Math.hypot(dx, dy);
        if (len < 1) {
            dx = fallback.x - cannon.x;
            dy = fallback.y - cannon.y;
            len = Math.hypot(dx, dy) || 1;
        }
        const reach = this.reach(holdMs, type, level);
        return {
            x: Math.round(RangeUtil.clamp(cannon.x + (dx / len) * reach, 40, world.width - 40)),
            y: Math.round(RangeUtil.clamp(cannon.y + (dy / len) * reach, 40, world.height - 40)),
            reach,
        };
    }
}

export { LaunchRules };
