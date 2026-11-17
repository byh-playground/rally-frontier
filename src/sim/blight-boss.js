// The blight's boss (깜부기에 지배당한 영웅): a hero the blight rules, the last fight of a chapter. A blighted stage
// declares it (campaign.js):
//     boss: { type: 'watermelon', level: 5, x: 1400, y: 2500,
//             escorts: [{ type: 'rice', x: 1400, y: 2400, count: 12, columns: 4 }] }
// At the match start the enemy's main base fires the hero at (x, y) on the ordinary hero sortie: its deployment
// slot waits with the kills of `level` (HERO_LEVEL_KILLS) and StrategySim.fireLaunchShell -> LaunchImpact ->
// HeroDeployment.land bring it out with that level's health, attack and growth (landing strike, kill effect,
// passive, ally aura, automatic strike), blighted as every unit of the blight's side is (Blight.mark). It levels on
// the player's soldiers it strikes down as any hero does, so a level-5 boss awakens (level 6) at the 100th kill,
// 30 after its 70. The escorts are ordinary enemy formations (CampaignMission.spawnFormations) standing from the
// first tick. The boss must be a hero card of the stage's enemy deck; the enemy AI never launches or recalls a hero,
// so the boss is never recovered and never comes out again.
// The boss does not die: the hit that would take its health to 0 subdues it instead (StrategySim.applyDamage). Its
// health stays 0, the blight leaves it (Blight.free: the freeing presentation) and it stands where it is: it takes no
// turn and uses no hero ability, nobody targets it and nothing hurts it. A subdued boss wins the match for the player
// (`resolve`), apart from the enemy main base falling; the player's own main base falling on the same tick loses it.
// `sim.blightBoss { subduedTick }` is the only state (null until subdued) and `unit.subdued` marks the body. Both
// exist only in a stage that declares a boss, so every other match's state and checksum are what they were.
import { UnitDefinition } from '../definitions/units.js';
import { HERO_LEVEL_KILLS } from '../units/baseline.js';
import { Blight } from './blight.js';
import { CampaignMission } from './campaign-mission.js';
import { HeroDeployment } from './hero-deployment.js';
import { HeroGrowth } from './hero-growth.js';
import { LaunchRules } from './launch-rules.js';
import { UnitSpinAttack } from './capabilities/unit-spin-attack.js';

const SIDE = Blight.ENEMY_SIDE,
    // The enemy main base, which fires the boss.
    BASE_ID = 'base' + SIDE;

export class BlightBoss {
    // The stage's declared boss, checked, or null: only a blighted stage has one, a hero card of the enemy deck.
    static declared(sim) {
        const boss = sim.rules.campaign?.boss;
        if (boss === undefined) return null;
        if (!Blight.declared(sim))
            throw new Error('보스는 감염(blight: true)을 선언한 판에만 둘 수 있습니다.');
        const { type, level, x, y, escorts } = boss ?? {};
        if (!LaunchRules.isHeroType(type))
            throw new Error(`보스는 영웅 병종이어야 합니다: ${type}`);
        if (!sim.decks[SIDE].includes(type))
            throw new Error(`보스 영웅은 적 덱(enemyDeck)에 있어야 합니다: ${type}`);
        if (!Number.isSafeInteger(level) || level < 1 || level > HeroGrowth.maxLevel)
            throw new Error(`보스 레벨은 1~${HeroGrowth.maxLevel}의 정수여야 합니다: ${level}`);
        if (!this.onMap(sim, x, y)) throw new Error('보스 선언에는 맵 안의 x, y가 필요합니다.');
        if (escorts !== undefined) {
            if (!Array.isArray(escorts) || !escorts.length)
                throw new Error('보스 호위(escorts)는 비어 있지 않은 목록이어야 합니다.');
            for (const formation of escorts) {
                const { type: escort, count, side } = formation ?? {};
                if (
                    !UnitDefinition.get(escort) ||
                    LaunchRules.isHeroType(escort) ||
                    !Number.isSafeInteger(count) ||
                    count < 1 ||
                    side !== undefined
                )
                    throw new Error(`보스 호위로 둘 수 없는 병사 선언입니다: ${escort} × ${count}`);
                if (!this.onMap(sim, formation.x, formation.y))
                    throw new Error('보스 호위의 formations에는 맵 안의 x, y가 필요합니다.');
            }
        }
        return boss;
    }

    static onMap(sim, x, y) {
        return (
            Number.isFinite(x) &&
            Number.isFinite(y) &&
            x >= 0 &&
            y >= 0 &&
            x <= sim.world.width &&
            y <= sim.world.height
        );
    }

    // Match start (StrategySim constructor, after the main bases): the escorts stand and the enemy main base fires
    // the boss, its slot holding the kills of its level.
    static initialize(sim) {
        const boss = this.declared(sim);
        if (!boss) return;
        sim.blightBoss = { subduedTick: null };
        CampaignMission.spawnFormations(sim, boss.escorts);
        sim.heroGrowth[SIDE][boss.type] = {
            kills: HERO_LEVEL_KILLS[boss.level - 1],
            level: boss.level,
        };
        this.fire(sim, boss);
    }

    // After the tick's landings (StrategySim.step, after HeroDeployment.settle): a boss that found no open ground
    // where its shell came down went back to the cannons (HeroDeployment.landingFailed), and the enemy main base
    // fires it at its place again, while that base stands.
    static settle(sim) {
        if (!sim.blightBoss) return;
        const boss = sim.rules.campaign.boss;
        if (sim.heroes[SIDE][boss.type] !== null) return;
        const base = sim.buildingById.get(BASE_ID);
        if (base && base.alive !== false && base.hp > 0) this.fire(sim, boss);
    }

    // The enemy main base fires the boss at its place (the slot keeps its growth and health).
    static fire(sim, boss) {
        const grain = LaunchRules.grain(boss.type);
        sim.fireLaunchShell({
            side: SIDE,
            cannonId: BASE_ID,
            type: boss.type,
            mode: 'single',
            shot: 0,
            shots: 1,
            power: 1,
            holdMs: 0,
            arcDistance: null,
            x: boss.x,
            y: boss.y,
            count: grain.count,
            impact: grain.impact,
            splash: grain.splash,
        });
    }

    // Is this unit the subdued boss? (Out of the fight: no turn, no ability, no target, StrategySim.)
    static subdued(unit) {
        return unit.subdued === true;
    }

    // The boss on the field, or null (before it lands).
    static unit(sim) {
        const type = sim.rules.campaign.boss.type,
            unitId = sim.heroes[SIDE][type]?.unitId;
        return unitId == null ? null : sim.unitById.get(unitId);
    }

    // `unit` is at 0 health (StrategySim.applyDamage, before a death). The boss is subdued instead of killed: returns
    // true and the caller does not kill it. Any other unit: false.
    static subdue(sim, unit) {
        const state = sim.blightBoss;
        if (!state || unit.side !== SIDE || unit !== this.unit(sim)) return false;
        unit.hp = 0;
        if (state.subduedTick !== null) return true;
        state.subduedTick = sim.tick;
        unit.target = null;
        unit.combat.cancelWindup();
        if (UnitDefinition.get(unit.type).spinAttack) UnitSpinAttack.cancel(sim, unit);
        HeroDeployment.stopAbilities(unit);
        Blight.free(sim, unit);
        unit.subdued = true;
        sim.events.push({
            type: 'blightBossSubdued',
            id: unit.id,
            unitType: unit.type,
            x: unit.x,
            y: unit.y,
        });
        return true;
    }

    // The match's winner with the boss counted (StrategySim.step, after the mission): a subdued boss wins for the
    // player unless the player's main base has fallen (that same tick too). A read: it changes nothing.
    static resolve(sim, winner) {
        if (sim.blightBoss?.subduedTick == null || winner === 'guest' || winner === 'draw')
            return winner;
        return 'host';
    }

    // What the battle screen reads (StrategySim.snapshot): the boss's level, kills, the kills still between it and
    // its awakening (0 once awakened), its health and the tick it was subdued. Undefined without a boss.
    static view(sim) {
        const state = sim.blightBoss;
        if (!state) return undefined;
        const type = sim.rules.campaign.boss.type,
            unit = this.unit(sim),
            growth = unit ? unit.heroGrowth : sim.heroGrowth[SIDE][type],
            awakenKills = HERO_LEVEL_KILLS[HeroGrowth.maxLevel - 1];
        return {
            type,
            level: growth.level,
            kills: growth.kills,
            untilAwaken: Math.max(0, awakenKills - growth.kills),
            hp: unit ? unit.hp : HeroDeployment.reserveHp(sim, SIDE, type),
            maxHp: unit ? unit.maxHp : HeroGrowth.slotMaxHp(sim, SIDE, type),
            subduedTick: state.subduedTick,
        };
    }
}
