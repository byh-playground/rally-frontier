// Defense cards, deck card rules and the damage taxonomy.
import { UnitDefinition } from './units.js';

// 생산건물은 건설 순간 아래 계약을 복사한다.
// totalUnits: 건물 하나가 평생 생산하는 총 수량
// batchSize: 한 번에 출격하는 수량 (부분 출격 없음)
// productionSeconds: batch 하나의 기본 생산시간. 밀집 생산 페널티는 기존대로 적용.

class DefenseCardDefinition{
  static all={
  thornTowerCard:{
    name:"가시꽃 초소",icon:"✣",building:"thornTower",
    desc:"긴 사거리의 빠른 단일 사격으로 소수 침입자가 경제권에 접근하기 어렵게 만듭니다.",
    role:"장거리 접근 억제"
  },
  acornTowerCard:{
    name:"도토리 감시포",icon:"◉",building:"acornTower",
    desc:"매우 긴 사거리와 묵직한 단발 피해로 대형 중립몹과 소규모 견제를 멀리서 압박합니다.",
    role:"초장거리 감시포"
  },
  sunvineTowerCard:{
    name:"태양덩굴 포탑",icon:"☀",building:"sunvineTower",
    desc:"해바라기처럼 빛을 모아 고열 씨앗을 발사합니다. 충전 리듬은 느리지만 한 발의 존재감이 확실합니다.",
    role:"집중 광선 포격"
  },
  mortarTowerCard:{
    name:"포자 박격 둥지",icon:"☄",building:"mortarTower",
    desc:"가까운 적은 못 치지만 멀리 몰린 적에게 느린 곡사 포탄을 떨어뜨리는 범위 방어 건물입니다.",
    role:"곡사 범위 포격"
  }
};
  static get(id){return this.all[id]||null}
  
  static list(ids=null){
    const all=Object.keys(this.all);
    if(!Array.isArray(ids))return all;
    return [...new Set(ids.map(String).filter(id=>!!this.get(id)))];
  }
  static names(ids=[]){return ids.map(id=>this.get(id)?.name||id)}
}

const DECK_SLOT_COUNT=5;
class DeckCardRuleDefinition{
  static rules={unit:{min:8,max:10},defense:{min:0,max:2}};
  static filters=[
    {id:"all",label:"전체"},{id:"t1",label:"T1"},{id:"t2",label:"T2"},{id:"t3",label:"T3"},
    {id:"air",label:"공중"},{id:"support",label:"지원/제어"},{id:"defense",label:"방어 건물"}
  ];

  static card(type,id){return{type,id}}
  static key(card){return `${card.type}:${card.id}`}
  static def(card){return card?.type==="unit"?UnitDefinition.get(card.id):card?.type==="defense"?DefenseCardDefinition.get(card.id):null}
  static icon(card){return card?.type==="unit"?UnitDefinition.icon(card.id):(this.def(card)?.icon||"◆")}
  static name(card){return this.def(card)?.name||card?.id||""}
  static kindLabel(card){return card?.type==="unit"?`T${this.def(card)?.tier||"?"}`:"방어 건물"}
  static cardsByType(cards,type){return (Array.isArray(cards)?cards:[]).filter(c=>c?.type===type)}
  static countText(cards){
    const units=this.cardsByType(cards,"unit").length,defs=this.cardsByType(cards,"defense").length;
    return `카드 ${(cards||[]).length}/${DECK_TOTAL_CARD_COUNT} · 유닛 ${units} · 방어 건물 ${defs}/${this.rules.defense.max}`;
  }
  static unitIds(){return [...UnitDefinition.tierPool(1),...UnitDefinition.tierPool(2),...UnitDefinition.tierPool(3)]}
  static allCards(){return [...this.unitIds().map(id=>this.card("unit",id)),...Object.keys(DefenseCardDefinition.all).map(id=>this.card("defense",id))]}
  static filterAccepts(card,filter="all"){
    if(!card)return false;if(filter==="all")return true;if(filter==="defense")return card.type==="defense";if(card.type!=="unit")return false;
    const d=UnitDefinition.get(card.id);if(!d)return false;
    if(filter==="t1")return d.tier===1;if(filter==="t2")return d.tier===2;if(filter==="t3")return d.tier===3;if(filter==="air")return d.layer==="AIR";
    if(filter==="support")return ["support","controller","guardian"].includes(d.role);return true;
  }
  static validateCards(cards){
    if(!Array.isArray(cards)||cards.length>DECK_TOTAL_CARD_COUNT)return {compatible:false,complete:false,reason:"호환되지 않는 덱입니다"};
    const validUnits=new Set(this.unitIds()),keys=new Set();
    for(const c of cards){
      if(!c||!this.rules[c.type])return {compatible:false,complete:false,reason:"호환되지 않는 덱입니다"};
      if(c.type==="unit"&&!validUnits.has(c.id))return {compatible:false,complete:false,reason:"호환되지 않는 덱입니다"};
      if(c.type==="defense"&&!DefenseCardDefinition.get(c.id))return {compatible:false,complete:false,reason:"호환되지 않는 덱입니다"};
      const k=this.key(c);if(keys.has(k))return {compatible:false,complete:false,reason:"호환되지 않는 덱입니다"};keys.add(k);
    }
    for(const [type,rule] of Object.entries(this.rules))if(this.cardsByType(cards,type).length>rule.max)return {compatible:false,complete:false,reason:"호환되지 않는 덱입니다"};
    const complete=cards.length===DECK_TOTAL_CARD_COUNT&&Object.entries(this.rules).every(([type,rule])=>{const n=this.cardsByType(cards,type).length;return n>=rule.min&&n<=rule.max});
    return {compatible:true,complete,reason:complete?"사용 가능":`덱을 완성해 주세요 · ${this.countText(cards)}`};
  }
  static canPlace(cards,index,newCard){
    if(index<0||index>=DECK_TOTAL_CARD_COUNT||!newCard)return false;
    const next=(cards||[]).slice();next[index]=newCard;return this.validateCards(next.filter(Boolean)).compatible;
  }
}
const DECK_TOTAL_CARD_COUNT=10;

const DAMAGE_CLASS_MATRIX={
  smallSpecialist:{light:100,medium:50,heavy:25},
  normal:{light:100,medium:100,heavy:100},
  area:{light:50,medium:75,heavy:100}
};
const SIZE_CLASS_LABEL={light:"소형",medium:"중형",heavy:"대형"};
const DAMAGE_CLASS_LABEL={smallSpecialist:"소형 특화형",normal:"일반형",area:"범위형"};
// Gameplay combat taxonomy is intentionally only two axes:
// sizeClass = light/medium/heavy, damageClass = smallSpecialist/normal/area.
// attackVisual is presentation-only and MUST NOT participate in damage math.
const VALID_DAMAGE_CLASSES=new Set(["smallSpecialist","normal","area"]);

export { DAMAGE_CLASS_LABEL, DAMAGE_CLASS_MATRIX, DECK_SLOT_COUNT, DECK_TOTAL_CARD_COUNT, DeckCardRuleDefinition, DefenseCardDefinition, SIZE_CLASS_LABEL, VALID_DAMAGE_CLASSES };
