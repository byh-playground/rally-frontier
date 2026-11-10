// Cannon launch rules: income, wallet and grain data.
import { RangeUtil } from '../core/game-rules.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { StickyCling } from './sticky-cling.js';

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
const PEA_BUNDLE_COST = 45;

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
    static maxVolleyCannons = 3;
    static volleyReinforcementPctPerExtraCannon = 20;
    static speed = 750;
    static shellFlight = Object.freeze({ speedScale: 0.8, arcScale: 1.25, sightRadius: 200 });
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
        watermelon: Object.freeze({ ...HERO_SHELL, shellHp: 65 }),
        banana: Object.freeze({ ...HERO_SHELL, shellHp: 50 }),
        grape: Object.freeze({ ...HERO_SHELL, shellHp: 55 }),
        // 산탄: 한 번에 여러 갈래, 갈래마다 폭발은 작다.
        rice: Object.freeze({
            cost: 35 * this.resourceScale,
            count: 20,
            shellHp: 10,
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
            cost: PEA_BUNDLE_COST * this.resourceScale,
            count: 12,
            shellHp: 40,
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
            shellHp: 30,
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
            shellHp: 15,
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
            shellHp: 20,
            cost: 40 * this.resourceScale,
            count: 20,
            impact: 10,
            splash: 45,
            deployTogether: true,
            fire: Object.freeze({ mode: 'split', offsets: Object.freeze([-100, 0]) }),
        }),
        chestnut: Object.freeze({
            shellHp: 25,
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
            shellHp: 18,
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
            shellHp: 35,
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
        'sunflower-seed': Object.freeze({
            ...SINGLE_BUNDLE_SHELL,
            shellHp: 25,
            cost: 40 * this.resourceScale,
            premiumCost: 10 * this.resourceScale,
            count: 6,
            impact: 10,
            splash: 50,
            land: 'compact',
            deployTogether: true,
        }),
        peanut: Object.freeze({
            ...SINGLE_BUNDLE_SHELL,
            cost: PEA_BUNDLE_COST * this.resourceScale,
            count: 5,
            shellHp: 25,
            impact: 10,
            splash: 50,
            land: 'transverse',
            spacing: 32,
            deployTogether: true,
        }),
        // 비용·인원은 확정, 포탄 성능은 땅콩의 초안을 따른다.
        'sticky-rice': Object.freeze({
            ...SINGLE_BUNDLE_SHELL,
            cost: 20 * this.resourceScale,
            premiumCost: 5 * this.resourceScale,
            count: 5,
            shellHp: 25,
            impact: 10,
            splash: 50,
            land: 'transverse',
            spacing: 32,
            deployTogether: true,
        }),
        // 비용·사거리(일반의 75%)·대포당 한 명은 확정, 포탄 체력·위력·반경은 찹쌀과 같은 초안이다.
        // Every cannon in a volley carries its own potato, so the volley grows one cannon per participant.
        potato: Object.freeze({
            ...SINGLE_BUNDLE_SHELL,
            cost: 5 * this.resourceScale,
            premiumCost: 15 * this.resourceScale,
            reach: 0.75,
            count: 1,
            perCannonLoad: true,
            shellHp: 25,
            impact: 10,
            splash: 50,
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
    static isLaunchCannon(building, side) {
        const definition = BuildingDefinition.get(building.type);
        return (
            building.side === side &&
            building.alive !== false &&
            !building.construction &&
            !!definition?.launch
        );
    }
    // Where a shell leaves this cannon, measured from its centre toward the aim.
    static muzzleReach(cannon) {
        return BuildingDefinition.get(cannon.type).launch.muzzleReach;
    }
    static launchCannons(state, side) {
        return (state?.buildings || []).filter((building) => this.isLaunchCannon(building, side));
    }
    // A sticky-rice soldier wrapped around the muzzle stops launches and turret fire.
    static jammed(state, cannon) {
        return !!StickyCling.clingerOf(state, cannon);
    }
    static readyToLaunch(state, cannon) {
        return (
            this.isLaunchCannon(cannon, cannon.side) &&
            Number(state.tick) >= (Number(cannon.launchReadyTick) || 0) &&
            !this.jammed(state, cannon)
        );
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
    static shellSpeed(type) {
        return this.grain(type).speed * this.shellFlight.speedScale;
    }
    static arcHeight(distance, type) {
        const height = RangeUtil.clamp(Math.round(distance * 0.3), 80, 600);
        return Math.round(height * (this.grain(type)?.arcScale ?? 1) * this.shellFlight.arcScale);
    }
    static lineDeploymentPosition({ x, y, count, dirX, dirY }, index, spacing) {
        const offset = (index - (count - 1) / 2) * spacing;
        return { x: x - dirY * offset, y: y + dirX * offset };
    }
    // A single cannon's shell stats are independent of aim and map position.
    static volleyStats(type) {
        const g = this.grain(type),
            fire = g.fire,
            count = fire.pellets ?? fire.shots ?? fire.offsets?.length ?? 1,
            base = Math.floor(g.count / count),
            extra = g.count % count,
            impactScale = fire.mode === 'shotgun' ? fire.impactScale : 1,
            splashScale = fire.mode === 'shotgun' ? fire.splashScale : 1;
        return Array.from({ length: count }, (_, i) => ({
            delayMs: fire.mode === 'burst' ? i * fire.gapMs : 0,
            count: base + (i < extra ? 1 : 0),
            impact: fire.impacts?.[i] ?? Math.max(1, Math.round(g.impact * impactScale)),
            splash: fire.splashes?.[i] ?? Math.max(1, Math.round(g.splash * splashScale)),
        }));
    }
    // 산탄은 부채꼴로 흩어지고, 연사는 같은 곳에 gapMs 간격으로 떨어진다.
    static volley(type, aim, cannon, world) {
        const { fire } = this.grain(type),
            shots = this.volleyStats(type),
            n = shots.length;
        const dx = aim.x - cannon.x,
            dy = aim.y - cannon.y,
            len = Math.hypot(dx, dy) || 1;
        return shots.map((shot, i) => {
            let x = aim.x,
                y = aim.y;
            if (fire.mode === 'shotgun') {
                // 폭(spread)은 거리와 무관하게 조준점 좌우로 일정하다.
                const off = n > 1 ? (i / (n - 1) - 0.5) * fire.spread : 0;
                x = Math.round(aim.x - (dy / len) * off);
                y = Math.round(aim.y + (dx / len) * off);
            } else if (fire.mode === 'split') {
                const forward = fire.offsets[i];
                const lateral = (i / (n - 1) - 0.5) * (fire.lateralSpread ?? 0);
                x = Math.round(aim.x + (dx * forward - dy * lateral) / len);
                y = Math.round(aim.y + (dy * forward + dx * lateral) / len);
                x = RangeUtil.clamp(x, 40, world.width - 40);
                y = RangeUtil.clamp(y, 40, world.height - 40);
            }
            return { x, y, ...shot };
        });
    }
    static sharedVolley(type, aim, primary, world, state, level) {
        const original = this.volley(type, aim, primary, world),
            grain = this.grain(type),
            // A per-cannon load fills every joining cannon; otherwise each shell must keep a passenger.
            limit = grain.perCannonLoad
                ? this.maxVolleyCannons
                : Math.min(this.maxVolleyCannons, Math.floor(grain.count / original.length));
        const groups = [{ cannon: primary, shots: original }];
        if (limit <= 1 || this.isHeroType(type)) return groups;

        const maxReach = this.maxReachOf(type, level),
            candidates = [];
        for (const cannon of this.launchCannons(state, primary.side)) {
            if (cannon.id === primary.id || !this.readyToLaunch(state, cannon)) continue;
            const distanceSquared = (aim.x - cannon.x) ** 2 + (aim.y - cannon.y) ** 2;
            if (distanceSquared >= this.minReach ** 2 && distanceSquared <= maxReach ** 2)
                candidates.push({ cannon, distanceSquared });
        }
        candidates.sort(
            (a, b) =>
                a.distanceSquared - b.distanceSquared ||
                (a.cannon.id < b.cannon.id ? -1 : a.cannon.id > b.cannon.id ? 1 : 0),
        );
        const seen = new Set([primary.id]);
        for (const { cannon } of candidates) {
            if (groups.length === limit) break;
            if (seen.has(cannon.id)) continue;
            seen.add(cannon.id);
            groups.push({ cannon, shots: this.volley(type, aim, cannon, world) });
        }
        if (groups.length === 1 || grain.perCannonLoad) return groups;

        const bonus = Math.round(
            (grain.count * (groups.length - 1) * this.volleyReinforcementPctPerExtraCannon) / 100,
        );
        const total = grain.count + bonus,
            slotBase = Math.floor(total / original.length),
            slotExtra = total % original.length;
        // Rotate the extra passengers between cannons while keeping each
        // cannon's usual shell impact and durability.
        let offset = 0;
        for (let slot = 0; slot < original.length; slot++) {
            const slotCount = slotBase + (slot < slotExtra ? 1 : 0),
                perCannon = Math.floor(slotCount / groups.length),
                extra = slotCount % groups.length;
            for (let index = 0; index < groups.length; index++) {
                const extraIndex = (index - offset + groups.length) % groups.length;
                groups[index].shots[slot].count = perCannon + (extraIndex < extra ? 1 : 0);
            }
            offset = (offset + extra) % groups.length;
        }
        return groups;
    }
    static volleyPassengerCount(groups) {
        return groups.reduce(
            (total, { shots }) => total + shots.reduce((count, shot) => count + shot.count, 0),
            0,
        );
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
