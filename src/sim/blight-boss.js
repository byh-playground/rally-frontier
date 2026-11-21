// The blight's boss (깜부기에 지배당한 영웅): a hero the blight rules, the last fight of a chapter. A blighted stage
// declares it (campaign.js):
//     boss: { type: 'watermelon', level: 5, x: 1400, y: 2500,
//             escorts: [{ type: 'rice', x: 1400, y: 2400, count: 12, columns: 4 }] }
// At the match start the enemy's main base fires the hero at (x, y) on the ordinary hero sortie: its deployment
// slot waits with the kills of `level` (HERO_LEVEL_KILLS) and StrategySim.fireLaunchShell -> LaunchImpact ->
// HeroDeployment.land bring it out with that level's health, attack and growth (landing strike, kill effect,
// passive, ally aura, automatic strike), blighted as every unit of the blight's side is (Blight.mark). It levels on
// the player's soldiers it strikes down as any hero does, so a level-5 boss awakens (level 6) at the 100th kill,
// 30 after its 70. The escorts are ordinary enemy formations (CampaignMission.spawnFormations). Both come at the
// mission's start (`start`): the first tick, or in a stage with a practice the tick it ends. The boss must be a hero card of the stage's enemy deck; the enemy AI never launches or recalls a hero,
// so the boss is never recovered and never comes out again.
// The boss's shell is the ordinary hero shell (LaunchRules.volley: no shock of its own). Its landing strike shows its
// shock but hurts and shoves nobody (`landsHarmless`, HeroLandingStrike.land): the fight starts with the player's
// soldiers standing. A boss with no open ground where its shell came down keeps waiting there for it
// (`waitsToLand`, HeroDeployment.landingFailed) instead of going back to the cannons, so it always comes out once.
// The boss does not die: the hit that would take its health to 0 subdues it instead (StrategySim.applyDamage). Its
// health stays 0, the blight leaves it (Blight.free: the freeing presentation) and it stands where it is: it takes no
// turn, uses no hero ability and counts no kill (HeroGrowth.recordKill), nobody targets it and nothing hurts it.
// Only a subdued boss wins the stage (`resolve`): the enemy main base falling does not end it, the player's own main
// base falling loses it (that same tick too). A boss stage has no survival defence.
// `sim.blightBoss { subduedTick }` is the only state (null until subdued) and `unit.subdued` marks the body. Both
// exist only in a stage that declares a boss, so every other match's state and checksum are what they were.
import { UnitDefinition } from '../definitions/units.js';
import { HERO_LEVEL_KILLS } from '../units/baseline.js';
import { Blight } from './blight.js';
import { CampaignMission } from './campaign-mission.js';
import { CampaignPractice } from './campaign-practice.js';
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
        const { mission } = sim.rules.campaign;
        if (mission?.surviveMs)
            throw new Error(
                '보스 판은 보스를 쓰러뜨려야 이기므로 버티기·영웅 수업·발사 목표 임무와 함께 둘 수 없습니다.',
            );
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

    // Match start (StrategySim constructor, after the main bases): the boss's slot holds the kills of its level, and
    // the mission starts now unless a practice runs first (CampaignPractice: then `start` comes the tick it ends).
    static initialize(sim) {
        const boss = this.declared(sim);
        if (!boss) return;
        sim.blightBoss = { subduedTick: null };
        sim.heroGrowth[SIDE][boss.type] = {
            kills: HERO_LEVEL_KILLS[boss.level - 1],
            level: boss.level,
        };
        if (!CampaignPractice.declared(sim)) this.start(sim);
    }

    // The mission starts (the match start, or the tick the practice ends): the escorts stand and the enemy main base
    // fires the boss. Nothing without a boss.
    static start(sim) {
        if (!sim.blightBoss) return;
        const boss = sim.rules.campaign.boss;
        CampaignMission.spawnFormations(sim, boss.escorts);
        this.fire(sim, boss);
    }

    // The enemy main base fires the boss at its place with the ordinary hero shell (LaunchRules.volley).
    static fire(sim, boss) {
        const cannon =
                sim.buildingById.get(BASE_ID) || sim.buildings.find(({ id }) => id === BASE_ID),
            [shot] = LaunchRules.volley(boss.type, boss, cannon, sim.world);
        sim.fireLaunchShell({
            side: SIDE,
            cannonId: BASE_ID,
            type: boss.type,
            mode: LaunchRules.grain(boss.type).fire.mode,
            shot: 0,
            shots: 1,
            power: LaunchRules.power(0),
            holdMs: 0,
            arcDistance: null,
            ...shot,
        });
    }

    // Is this landing deployment the boss's sortie? (HeroDeployment.landingFailed: it keeps waiting for open ground.)
    static waitsToLand(sim, group) {
        return (
            !!sim.blightBoss && group.side === SIDE && group.type === sim.rules.campaign.boss.type
        );
    }

    // Does this hero's landing strike hurt and shove nobody? The boss's does not (HeroLandingStrike.land).
    static landsHarmless(sim, unit) {
        return !!sim.blightBoss && unit === this.unit(sim);
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

    // The match's winner with the boss counted (StrategySim.step, from the main bases, before the mission): the
    // player's main base falling (a draw too) loses, a subdued boss wins, nothing else ends it. A read.
    static resolve(sim, winner) {
        if (!sim.blightBoss) return winner;
        if (winner === 'guest' || winner === 'draw') return 'guest';
        return sim.blightBoss.subduedTick !== null ? 'host' : null;
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
