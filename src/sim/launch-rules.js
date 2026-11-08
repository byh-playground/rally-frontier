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
const HERO_SHELL = Object.freeze({ ...SINGLE_BUNDLE_SHELL, cost: 0, count: 1 });

// 발사전: 대포가 유닛 뭉치를 쏜다. 거리는 누른 시간만으로 정해지고, 조준 중에는 착지 원으로 미리 보인다(D-196).
// 한 발이 무겁다: 자원 단위는 기존 경제의 5배 환산 기준(D-233·D-235), 폭발 중심일수록 피해가 크다(D-230), 곡물마다 발사 방식이 다르다(D-234).
class LaunchRules {
    static resourceScale = 5;
    static walletCap = 100 * this.resourceScale;
    static populationLimit = 300;
    static startingWallet = this.walletCap;
    static premiumWalletCap = this.walletCap;
    static baseIncomePerSecond = 15;
    static outpostIncomePerSecond = 5;
    static productionDecline = Object.freeze({
        fullYieldSeconds: 120,
        floorYieldSeconds: 300,
        minimumPercent: 50,
    });
    static minReach = 250;
    static maxReach = 500;
    static chargeMs = 1500;
    static overheatGraceMs = 180;
    static overheatMs = 2000;
    static reloadMs = 400;
    static speed = 750;
    static landingMarkMs = 1500;
    static captureHoldRadius = 400;
    static rangeMultipliers = Object.freeze([1, 2, 3, 4, 5]);
    static rangeUpgradeCosts = Object.freeze(
        [50, 75, 75, 100].map((cost) => cost * this.resourceScale),
    );
    static rangeUpgradePremiumCosts = Object.freeze(
        [0, 0, 25, 50].map((cost) => cost * this.resourceScale),
    );
    static rangeMultiplier(level = 0) {
        return this.rangeMultipliers[level] ?? this.rangeMultipliers[0];
    }
    static upgradeCost(level) {
        return this.rangeUpgradeCosts[level] ?? null;
    }
    static upgradePremiumCost(level) {
        return this.rangeUpgradePremiumCosts[level] ?? null;
    }
    static productionChannels(incomePerSecond, mixed = false) {
        const oilRate = mixed ? incomePerSecond / 2 : 0;
        const production = {
            basic: { incomePerSecond: incomePerSecond - oilRate, miningCarry: 0 },
        };
        if (mixed) {
            production.premium = { incomePerSecond: oilRate, miningCarry: 0 };
        }
        return production;
    }
    static productionEfficiency(point) {
        const { basic, premium } = point.production;
        const total = basic.incomePerSecond + (premium?.incomePerSecond ?? 0);
        const { fullYieldSeconds, floorYieldSeconds, minimumPercent } = this.productionDecline;
        const start = fullYieldSeconds * total;
        const end = floorYieldSeconds * total;
        if (point.extractedResources <= start) return 100;
        const decline = Math.floor(
            ((point.extractedResources - start) * (100 - minimumPercent)) / (end - start),
        );
        return Math.max(minimumPercent, 100 - decline);
    }
    static productionRateHundredths(channel, efficiency) {
        return (channel?.incomePerSecond ?? 0) * efficiency;
    }
    static productionRate(point, resource) {
        return (
            this.productionRateHundredths(
                point.production[resource],
                this.productionEfficiency(point),
            ) / 100
        );
    }
    static incomePerSecondFor(producers, side, resource = 'basic') {
        return producers.reduce(
            (sum, point) => sum + (point.owner === side ? this.productionRate(point, resource) : 0),
            0,
        );
    }
    // Artillery damage falls off from the center to 1× at the edge.
    static unitImpactScale = 0.75;
    static unitImpactPeak = 4;
    static buildingImpactPeak = 3;
    static heroCard = 'watermelon';
    static heroTypes = Object.freeze([LaunchRules.heroCard, 'banana', 'grape']);
    static grains = Object.freeze({
        ...Object.fromEntries(LaunchRules.heroTypes.map((type) => [type, HERO_SHELL])),
        // 산탄: 한 번에 여러 갈래, 갈래마다 폭발은 작다.
        rice: Object.freeze({
            cost: 35 * this.resourceScale,
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
            cost: 45 * this.resourceScale,
            count: 12,
            reach: 0.85,
            speed: 750,
            impact: 40,
            splash: 80,
            land: 'line',
            spacing: 22,
            fire: Object.freeze({ mode: 'single' }),
        }),
        // Provisional corn deployment: a single shell releases one grouped squad.
        corn: Object.freeze({
            ...SINGLE_BUNDLE_SHELL,
            speed: 550,
            arcScale: 1.5,
            splash: 65,
            land: 'compact',
            deployTogether: true,
            cost: 20 * this.resourceScale,
            premiumCost: 15 * this.resourceScale,
            count: 6,
        }),
        popcorn: Object.freeze({
            ...SINGLE_BUNDLE_SHELL,
            impact: 15,
            splash: 60,
            fire: Object.freeze({
                mode: 'split',
                offsets: Object.freeze([0, 0]),
                lateralSpread: 160,
            }),
            cost: 35 * this.resourceScale,
            count: 10,
        }),
        millet: Object.freeze({
            ...SINGLE_BUNDLE_SHELL,
            cost: 40 * this.resourceScale,
            count: 20,
            impact: 10,
            splash: 45,
            deployTogether: true,
            fire: Object.freeze({ mode: 'split', offsets: Object.freeze([-100, 0]) }),
        }),
        chestnut: Object.freeze({
            cost: 25 * this.resourceScale,
            premiumCost: 5 * this.resourceScale,
            count: 6,
            reach: 0.85,
            speed: 1000,
            arcScale: 0.65,
            impact: 10,
            splash: 50,
            land: 'transverse',
            spacing: 35,
            deployTogether: true,
            fire: Object.freeze({ mode: 'single' }),
        }),

        // 연사: 같은 곳에 시간차로 세 번 떨어진다.
        redbean: Object.freeze({
            cost: 60 * this.resourceScale,
            count: 10,
            reach: 0.75,
            speed: 750,
            impact: 20,
            splash: 95,
            land: 'rush',
            rushMs: 2000,
            rushPct: 150,
            fire: Object.freeze({ mode: 'burst', shots: 3, gapMs: 300 }),
        }),
        // 도토리는 한 발당 두 병사씩 세 발을 쏜다.
        acorn: Object.freeze({
            cost: 35 * this.resourceScale,
            premiumCost: 10 * this.resourceScale,
            count: 6,
            reach: 0.85,
            speed: 750,
            impact: 25,
            splash: 100,
            land: 'bundle',
            fire: Object.freeze({
                mode: 'burst',
                shots: 3,
                gapMs: 450,
                impacts: Object.freeze([15, 25, 40]),
                splashes: Object.freeze([90, 60, 40]),
            }),
        }),
    });
    static deck = Object.freeze(
        Object.keys(LaunchRules.grains).filter((type) => !LaunchRules.isHeroType(type)),
    );
    static deckLimit = 8;
    static deckHeroLimit = 1;
    static starterDeck = Object.freeze([
        LaunchRules.heroCard,
        ...LaunchRules.deck.slice(0, LaunchRules.deckLimit - 1),
    ]);
    static isHeroType(type) {
        return this.heroTypes.includes(type);
    }
    static normalizeDeck(deck) {
        if (
            !Array.isArray(deck) ||
            deck.length < 1 ||
            deck.length > this.deckLimit ||
            deck.includes(undefined) ||
            new Set(deck).size !== deck.length ||
            deck.some((type) => typeof type !== 'string' || !this.grain(type))
        )
            throw new Error(`덱은 중복 없이 유효한 카드를 1~${this.deckLimit}장 포함해야 합니다.`);
        if (deck.filter((type) => this.isHeroType(type)).length > this.deckHeroLimit)
            throw new Error(`덱에 장착할 수 있는 영웅은 최대 ${this.deckHeroLimit}명이에요.`);
        return deck.slice();
    }
    static normalizeDeckPair(decks) {
        if (!Array.isArray(decks) || decks.length !== 2)
            throw new Error('양쪽 플레이어의 덱이 필요합니다.');
        return decks.map((deck) => this.normalizeDeck(deck));
    }
    static strike(distance, radius, peak) {
        const k = RangeUtil.clamp(1 - distance / Math.max(1, radius), 0, 1);
        return 1 + (peak - 1) * k * k;
    }
    static grain(type) {
        return Object.hasOwn(this.grains, type) ? this.grains[type] : null;
    }
    static payload(type) {
        const g = this.grain(type);
        return g ? { count: g.count, cost: g.cost, premiumCost: g.premiumCost || 0 } : null;
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
    static arcHeight(distance, type) {
        const height = RangeUtil.clamp(Math.round(distance * 0.3), 80, 600);
        return Math.round(height * (this.grain(type)?.arcScale ?? 1));
    }
    static lineDeploymentPosition({ x, y, count, dirX, dirY }, index, spacing) {
        const offset = (index - (count - 1) / 2) * spacing;
        return { x: x - dirY * offset, y: y + dirX * offset };
    }
    // 한 번의 발사가 만드는 포탄 목록. 곡물 수는 포탄마다 나눠 담고(앞쪽이 나머지를 받는다),
    // 산탄은 부채꼴로 흩어지고, 연사는 같은 곳에 gapMs 간격으로 떨어진다.
    static volley(type, aim, cannon, world) {
        const g = this.grain(type),
            fire = g.fire,
            shots = [];
        const n = fire.pellets ?? fire.shots ?? fire.offsets?.length ?? 1;
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
            else if (fire.mode === 'split') {
                const forward = fire.offsets[i];
                const lateral = (i / (n - 1) - 0.5) * (fire.lateralSpread ?? 0);
                x = Math.round(aim.x + (dx * forward - dy * lateral) / len);
                y = Math.round(aim.y + (dy * forward + dx * lateral) / len);
                x = RangeUtil.clamp(x, 40, world.width - 40);
                y = RangeUtil.clamp(y, 40, world.height - 40);
            }
            shots.push({
                x,
                y,
                delayMs,
                count: base + (i < extra ? 1 : 0),
                impact: fire.impacts?.[i] ?? Math.max(1, Math.round(g.impact * impactScale)),
                splash: fire.splashes?.[i] ?? Math.max(1, Math.round(g.splash * splashScale)),
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
