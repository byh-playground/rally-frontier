// Contract (HeroKillEffect):
// - 영웅 정의의 `growth[레벨].killEffect`는 그 레벨부터 켜지는 막타 효과다(HeroGrowth.unlocked). 영웅이 막타로
//   적 병력을 쓰러뜨린 순간(StrategySim.emitUnitDeath → HeroGrowth.recordKill 뒤, 처치 수를 센 뒤의 레벨) 한 번
//   실행한다.
// - 필드마다 따로 켜진다(정의 검사는 defineUnit). `heal`: 영웅 체력을 그만큼(최대 체력까지) 채운다. `fillCombo`: n타 카운터
//   (fruitAttack.every)를 가득 채워 다음 평타가 곧바로 n번째 평타가 된다. `bounce { radius, damage }`: 쓰러진 적
//   자리에서 열매 하나가 곡사(fruitAttack.lob의 경로·시간)로 튀어 반경 안의 가장 가까운 지상 적 한 명에게 피해를 준다.
// - 튄 열매의 막타도 처치 수에 들어가지만 막타 효과는 다시 실행하지 않는다(연쇄 없음, `heroKillEffect: false`).
// - 실행한 막타 효과마다 `heroKillEffect` 사건 하나를 낸다. 연출(과즙 방울·금빛 고리)은 이 사건을 읽는다.
import { UnitDefinition } from '../../definitions/units.js';
import { HeroGrowth } from '../hero-growth.js';
import { FruitHeroAttack } from './fruit-hero-attack.js';

export class HeroKillEffect {
    // `hero` just struck the killing blow on `target` and counted it (HeroGrowth.recordKill).
    static onKill(sim, hero, target) {
        const spec = HeroGrowth.unlocked(hero, 'killEffect');
        if (!spec) return;
        const heal = spec.heal ? this.heal(hero, spec.heal) : null;
        const charged = !!spec.fillCombo && FruitHeroAttack.fillCombo(hero);
        const bounceTargetId = spec.bounce
            ? FruitHeroAttack.bounce(sim, hero, target, spec.bounce)
            : null;
        sim.events.push({
            type: 'heroKillEffect',
            side: hero.side,
            sourceId: hero.id,
            unit: hero.type,
            level: hero.heroGrowth.level,
            kills: hero.heroGrowth.kills,
            x: target.x,
            y: target.y,
            heroX: hero.x,
            heroY: hero.y,
            heal,
            charged,
            bounceTargetId,
        });
    }

    // Health restored, up to the hero's maximum. Returns how much it rose (the event's `heal`, null without one).
    static heal(hero, amount) {
        const before = hero.hp;
        hero.hp = Math.min(UnitDefinition.get(hero.type).hp, hero.hp + amount);
        return Math.max(0, hero.hp - before);
    }
}
