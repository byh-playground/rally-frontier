// Defense cards, draft weights, deck records and draft policy.
import { CloneUtil, HashUtil } from '../sim/map-generation.js';
import { UnitDefinition } from './units.js';
import { SIM_VERSION } from '../core/config.js';

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

/*
 * Dynamic weighted draft
 * - 8 unit rounds keep the fixed tier contract: T1×3 / T2×3 / T3×2.
 * - Each tier starts from its whole unique unit pool; there is no AIR-count roll.
 * - Every ordinary card has the same base weight inside its tier.
 * - Mobile AA / Detector cards are slightly less likely before they are needed, so an
 *   early blind counter offer is less likely to consume the only useful response.
 * - Once the opponent actually owns AIR / persistent cloak and the chooser still lacks
 *   the matching response, counter weight rises as chooser picks run out.
 * - When waiting any longer would remove every valid counter path, the current pair is
 *   filtered to a 100% response opportunity. The player may still reject it deliberately.
 * - Pair safety is joint across Host+Guest. Scarce counters cannot be promised to both sides
 *   at once; the solver reserves enough future chooser slots/cards before allowing new threats.
 * - A player may deliberately reject the last safe counter choice; only that player then waives
 *   the corresponding guarantee. The opponent is never stranded by somebody else's choice.
 */
const DRAFT_UNIT_ROUNDS=8;
const DRAFT_TOTAL_ROUNDS=9;
const DRAFT_COUNTER_AA=1;
const DRAFT_COUNTER_DETECT=2;
const DRAFT_BASE_WEIGHT=100;
const DRAFT_EARLY_AA_WEIGHT=55;
const DRAFT_EARLY_DETECT_WEIGHT=18;
const DRAFT_COUNTER_PRESSURE=400;

const DECK_STORAGE_KEY="rally-frontier-decks";
const DECK_FORMAT_VERSION=2;
const DECK_RULESET_VERSION=2;
const DECK_STORAGE_VERSION=2;
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

class DeckRecord{
  static storageFailure=null;
  static makeStarterDeck(slot=0){
    return {
      id:`deck-${slot+1}`,name:`덱 ${slot+1}`,formatVersion:DECK_FORMAT_VERSION,rulesetVersion:DECK_RULESET_VERSION,createdWithSimVersion:SIM_VERSION,
      cards:[
        ...["swordsman","archer","kickhopper","tank","medic","clawhunter","siege","aegisbeetle"].map(id=>DeckCardRuleDefinition.card("unit",id)),
        DeckCardRuleDefinition.card("defense","thornTowerCard"),
        DeckCardRuleDefinition.card("defense","acornTowerCard")
      ],updatedAt:new Date().toISOString()
    };
  }
  static normalizeDeckStore(raw=null){
    if(raw!==null){
      if(typeof raw!=="object"||Array.isArray(raw)||Number(raw.storageVersion)!==DECK_STORAGE_VERSION||!Array.isArray(raw.decks)||raw.decks.length>DECK_SLOT_COUNT)throw new Error("지원하지 않는 덱 저장 형식입니다.");
      if(raw.decks.some(deck=>deck!==null&&(!deck||typeof deck!=="object"||Array.isArray(deck)||!DeckRecord.validateDeckRecord(deck).compatible)))throw new Error("호환되지 않는 덱 기록입니다.");
    }
    const decks=Array.isArray(raw?.decks)?raw.decks.slice(0,DECK_SLOT_COUNT):[];
    while(decks.length<DECK_SLOT_COUNT)decks.push(null);if(!decks.some(Boolean))decks[0]=DeckRecord.makeStarterDeck(0);return {storageVersion:DECK_STORAGE_VERSION,decks};
  }
  static loadDeckStore(){
    let raw;
    try{
      raw=localStorage.getItem(DECK_STORAGE_KEY);
      const parsed=raw===null?null:JSON.parse(raw);
      if(raw!==null&&parsed===null)throw new Error("덱 기록이 비어 있습니다.");
      const store=DeckRecord.normalizeDeckStore(parsed);DeckRecord.storageFailure=null;return store;
    }catch(_){
      DeckRecord.storageFailure={raw,message:raw===undefined?"이 브라우저에서 덱 기록을 읽을 수 없습니다. 저장소 접근을 허용한 뒤 다시 읽어 주세요.":"덱 기록이 손상되었거나 현재 버전과 호환되지 않습니다. 원본은 보존했으며 덱 저장을 중단했습니다."};
      return{storageVersion:DECK_STORAGE_VERSION,decks:Array(DECK_SLOT_COUNT).fill(null)};
    }
  }
  static saveDeckStore(store){
    DeckRecord.loadDeckStore();if(DeckRecord.storageFailure)return false;
    try{localStorage.setItem(DECK_STORAGE_KEY,JSON.stringify(DeckRecord.normalizeDeckStore(store)));return true}catch(_){return false}
  }
  static resetDeckStore(expectedRaw){
    if(typeof expectedRaw!=="string")return false;
    try{
      if(localStorage.getItem(DECK_STORAGE_KEY)!==expectedRaw){DeckRecord.loadDeckStore();return false}
      localStorage.setItem(DECK_STORAGE_KEY,JSON.stringify(DeckRecord.normalizeDeckStore(null)));
      DeckRecord.storageFailure=null;return true;
    }catch(_){return false}
  }
  static validateDeckRecord(deck){
    if(!deck)return {compatible:true,complete:false,reason:"비어 있는 덱입니다."};
    if(Number(deck.formatVersion)!==DECK_FORMAT_VERSION||Number(deck.rulesetVersion)!==DECK_RULESET_VERSION)return {compatible:false,complete:false,reason:"호환되지 않는 덱입니다"};
    return DeckCardRuleDefinition.validateCards(deck.cards);
  }
  static deckPayloadFromRecord(deck){const v=DeckRecord.validateDeckRecord(deck);if(!v.compatible||!v.complete)return null;return {formatVersion:DECK_FORMAT_VERSION,rulesetVersion:DECK_RULESET_VERSION,cards:deck.cards.map(c=>({...c}))}}
  static validateDeckPayload(payload){return !!payload&&Number(payload.formatVersion)===DECK_FORMAT_VERSION&&Number(payload.rulesetVersion)===DECK_RULESET_VERSION&&DeckCardRuleDefinition.validateCards(payload.cards).complete}
  static deckRuntimeSelection(payload){
    if(!DeckRecord.validateDeckPayload(payload))return null;const units=DeckCardRuleDefinition.cardsByType(payload.cards,"unit").map(c=>c.id),defs=DeckCardRuleDefinition.cardsByType(payload.cards,"defense").map(c=>c.id);
    return {unitIds:units,defenseCardIds:defs};
  }
  static defaultBotDeckPayload(seed="bot"){
    const t1=DeterministicSortUtil.seededSort(UnitDefinition.tierPool(1),seed,"deck-bot-t1").slice(0,3),t2=DeterministicSortUtil.seededSort(UnitDefinition.tierPool(2),seed,"deck-bot-t2").slice(0,3),t3=DeterministicSortUtil.seededSort(UnitDefinition.tierPool(3),seed,"deck-bot-t3").slice(0,2);
    const defenses=DeterministicSortUtil.seededSort(Object.keys(DefenseCardDefinition.all),seed,"deck-bot-defense").slice(0,2);
    return {formatVersion:DECK_FORMAT_VERSION,rulesetVersion:DECK_RULESET_VERSION,cards:[...[...t1,...t2,...t3].map(id=>DeckCardRuleDefinition.card("unit",id)),...defenses.map(id=>DeckCardRuleDefinition.card("defense",id))]};
  }
}

class DeterministicSortUtil{
  static seededSort(items,seed,key){
    return items.slice().sort((a,b)=>{
      const ha=HashUtil.hash(seed+"|"+key+"|"+JSON.stringify(a));
      const hb=HashUtil.hash(seed+"|"+key+"|"+JSON.stringify(b));
      if(ha!==hb)return ha-hb;
      const sa=JSON.stringify(a),sb=JSON.stringify(b);
      return sa<sb?-1:sa>sb?1:0;
    });
  }
}

class DraftPolicy{
  static draftChooserForRound(round){return round%2===0?"host":"guest"}
  static draftTierSchedule(seed){
  const slots=[1,1,1,2,2,2,3,3].map((tier,index)=>({tier,index}));
  return DeterministicSortUtil.seededSort(slots,seed,"draft-tier-order").map(x=>x.tier);
}
  static draftCounterMask(id){
  const d=UnitDefinition.get(id);
  if(!d)return 0;
  let mask=0;
  if(d.canAttackAir)mask|=DRAFT_COUNTER_AA;
  if(d.detectRadius)mask|=DRAFT_COUNTER_DETECT;
  return mask;
}
  static draftThreatMask(id){
  const d=UnitDefinition.get(id);
  if(!d)return 0;
  let mask=0;
  if(d.layer==="AIR")mask|=DRAFT_COUNTER_AA;
  if(d.stealth||Number(d.cloakAuraRadius)>0)mask|=DRAFT_COUNTER_DETECT;
  return mask;
}
  static draftDeckCounterMask(deck){let mask=0;for(const id of deck||[])mask|=DraftPolicy.draftCounterMask(id);return mask}
  static draftDeckThreatMask(deck){let mask=0;for(const id of deck||[])mask|=DraftPolicy.draftThreatMask(id);return mask}
  static draftNeedsMaskFromDecks(decks,who){
  const enemy=who==="host"?"guest":"host";
  return DraftPolicy.draftDeckThreatMask(decks?.[enemy]||[])&~DraftPolicy.draftDeckCounterMask(decks?.[who]||[]);
}
  static draftUsedUnitCards(state){return new Set([...(state?.decks?.host||[]),...(state?.decks?.guest||[])])}
  static draftAvailableTierCards(state,tier,extraUsed=[]){
  const used=DraftPolicy.draftUsedUnitCards(state);for(const id of extraUsed||[])used.add(id);
  return UnitDefinition.tierPool(tier).filter(id=>!used.has(id));
}
  static draftRemainingChooserPicks(state,who,startRound=state?.draft?.round||0){
  let count=0;
  for(let r=startRound;r<DRAFT_UNIT_ROUNDS;r++)if(DraftPolicy.draftChooserForRound(r)===who)count++;
  return count;
}
  static draftPopcount(mask){return (mask&1)+((mask>>1)&1)}
  static draftCardWeight(state,id,chooser){
  const needs=DraftPolicy.draftNeedsMaskFromDecks(state.decks,chooser);
  const counter=DraftPolicy.draftCounterMask(id),cover=counter&needs,d=UnitDefinition.get(id)||{};
  let weight=DRAFT_BASE_WEIGHT;
  if(cover){
    const remaining=Math.max(1,DraftPolicy.draftRemainingChooserPicks(state,chooser,state.draft.round));
    weight+=Math.round(DRAFT_COUNTER_PRESSURE*DraftPolicy.draftPopcount(cover)/remaining);
  }else{
    // Keep AIR itself on the normal random table. Only dedicated ground counter value
    // is de-emphasized before a threat exists; Detector keeps the stronger early penalty.
    if(counter&DRAFT_COUNTER_DETECT)weight=DRAFT_EARLY_DETECT_WEIGHT;
    else if((counter&DRAFT_COUNTER_AA)&&d.layer!=="AIR")weight=DRAFT_EARLY_AA_WEIGHT;
  }
  return Math.max(1,weight|0);
}
  static draftGuaranteeNeedsMask(state,who){
  const waived=Number(state?.draft?.waivedCounterMask?.[who])||0;
  return DraftPolicy.draftNeedsMaskFromDecks(state.decks,who)&~waived;
}
  
  static draftCanCoverGuaranteesInFuture(state,startRound,extraUsed=[]){
  let hostNeeds=DraftPolicy.draftGuaranteeNeedsMask(state,"host")&3;
  let guestNeeds=DraftPolicy.draftGuaranteeNeedsMask(state,"guest")&3;
  if(!hostNeeds&&!guestNeeds)return true;
  const schedule=state.draft.tierSchedule||DraftPolicy.draftTierSchedule(state.roomCode);
  const rounds=[];
  for(let r=startRound;r<DRAFT_UNIT_ROUNDS;r++)rounds.push({round:r,tier:schedule[r],chooser:DraftPolicy.draftChooserForRound(r)});
  if(!rounds.length)return false;
  const used=DraftPolicy.draftUsedUnitCards(state);for(const id of extraUsed||[])used.add(id);
  const memo=new Map();
  const dfs=(index,hNeed,gNeed,usedSet)=>{
    if(!hNeed&&!gNeed)return true;
    if(index>=rounds.length)return false;
    const key=index+"|"+hNeed+"|"+gNeed+"|"+[...usedSet].sort().join(",");
    if(memo.has(key))return memo.get(key);
    const info=rounds[index],need=info.chooser==="host"?hNeed:gNeed;
    // This chooser may spend the round on a non-counter; later rounds can still save it.
    if(dfs(index+1,hNeed,gNeed,usedSet)){memo.set(key,true);return true}
    if(need){
      for(const id of UnitDefinition.tierPool(info.tier)){
        if(usedSet.has(id))continue;
        const cover=DraftPolicy.draftCounterMask(id)&need;if(!cover)continue;
        const nextUsed=new Set(usedSet);nextUsed.add(id);
        const nh=info.chooser==="host"?(hNeed&~cover):hNeed;
        const ng=info.chooser==="guest"?(gNeed&~cover):gNeed;
        if(dfs(index+1,nh,ng,nextUsed)){memo.set(key,true);return true}
      }
    }
    memo.set(key,false);return false;
  };
  return dfs(0,hostNeeds,guestNeeds,used);
}
  static draftOutcomeState(state,pair,chosenId){
  const chooser=state.draft.chooser,otherRole=chooser==="host"?"guest":"host";
  const other=pair[0]===chosenId?pair[1]:pair[0];
  const decks={host:(state.decks.host||[]).slice(),guest:(state.decks.guest||[]).slice()};
  decks[chooser].push(chosenId);decks[otherRole].push(other);
  const draft={...state.draft,waivedCounterMask:{host:Number(state.draft.waivedCounterMask?.host)||0,guest:Number(state.draft.waivedCounterMask?.guest)||0}};
  return {...state,draft,decks};
}
  static draftOutcomeWithChooserWaiver(outcome,chooser){
  const waived=CloneUtil.clone(outcome);
  waived.draft.waivedCounterMask=waived.draft.waivedCounterMask||{host:0,guest:0};
  waived.draft.waivedCounterMask[chooser]|=DraftPolicy.draftGuaranteeNeedsMask(outcome,chooser);
  return waived;
}
  static draftPairOpportunitySafe(state,pair){
  const chooser=state.draft.chooser;
  const nextRound=state.draft.round+1,extraUsed=pair;
  const outcomes=pair.map(chosen=>DraftPolicy.draftOutcomeState(state,pair,chosen));
  for(let i=0;i<2;i++){
    const outcome=outcomes[i];
    if(DraftPolicy.draftCanCoverGuaranteesInFuture(outcome,nextRound,extraUsed))continue;

    // Unsafe is allowed only as the chooser's deliberate gamble: the other visible card
    // must actually counter at least one of the chooser's unmet required tags, choosing it
    // must preserve the joint Host+Guest path, and waiving ONLY the chooser's own missed
    // response must leave the non-chooser guarantees feasible.
    const chooserNeeds=DraftPolicy.draftGuaranteeNeedsMask(outcome,chooser);
    const alternative=pair[1-i],cover=DraftPolicy.draftCounterMask(alternative)&chooserNeeds;
    if(!cover)return false;
    const altOutcome=outcomes[1-i];
    if(!DraftPolicy.draftCanCoverGuaranteesInFuture(altOutcome,nextRound,extraUsed))return false;
    const waivedOutcome=DraftPolicy.draftOutcomeWithChooserWaiver(outcome,chooser);
    if(!DraftPolicy.draftCanCoverGuaranteesInFuture(waivedOutcome,nextRound,extraUsed))return false;
  }
  return true;
}
  static draftPairIsCriticalOpportunity(state,pair){
  const nextRound=state.draft.round+1;
  // If all unwaived Host+Guest counter requirements can still be satisfied without using
  // this chooser round, keep the pair weighted/random.
  if(DraftPolicy.draftCanCoverGuaranteesInFuture(state,nextRound,pair))return true;
  // Otherwise at least one visible choice must preserve the global response path now.
  for(const chosen of pair){
    const outcome=DraftPolicy.draftOutcomeState(state,pair,chosen);
    if(DraftPolicy.draftCanCoverGuaranteesInFuture(outcome,nextRound,pair))return true;
  }
  return false;
}
  static draftWeightedPair(state,tier){
  const chooser=state.draft.chooser;
  const cards=DraftPolicy.draftAvailableTierCards(state,tier);
  const candidates=[];
  for(let i=0;i<cards.length;i++)for(let j=i+1;j<cards.length;j++){
    const pair=[cards[i],cards[j]];
    if(!DraftPolicy.draftPairOpportunitySafe(state,pair))continue;
    if(!DraftPolicy.draftPairIsCriticalOpportunity(state,pair))continue;
    const wa=DraftPolicy.draftCardWeight(state,pair[0],chooser),wb=DraftPolicy.draftCardWeight(state,pair[1],chooser);
    candidates.push({pair,weight:Math.max(1,wa*wb)});
  }
  // This should not normally happen. Keep the game deterministic and playable rather
  // than inventing a forced deck: fall back to all available pairs with equal weight.
  const list=candidates.length?candidates:(()=>{
    const fallback=[];
    for(let i=0;i<cards.length;i++)for(let j=i+1;j<cards.length;j++)fallback.push({pair:[cards[i],cards[j]],weight:1});
    return fallback;
  })();
  const salt=`${state.roomCode}|draft-pair|${state.draft.round}|${chooser}|${tier}|${(state.decks.host||[]).join(",")}|${(state.decks.guest||[]).join(",")}`;
  let total=0;for(const c of list)total+=c.weight;
  let roll=HashUtil.hash(salt)%Math.max(1,total),picked=list[0];
  for(const c of list){if(roll<c.weight){picked=c;break}roll-=c.weight}
  const pair=picked.pair.slice();
  if(HashUtil.hash(salt+"|flip")&1)pair.reverse();
  return pair;
}
  static draftDefensePair(seed){
  const pair=DeterministicSortUtil.seededSort(Object.keys(DefenseCardDefinition.all),seed,"defense-pool").slice(0,2);
  if(HashUtil.hash(seed+"|defense-card-flip")&1)pair.reverse();
  return pair;
}
  static draftGeneratePair(state){
  const round=state.draft.round;
  if(round>=DRAFT_UNIT_ROUNDS)return DraftPolicy.draftDefensePair(state.roomCode);
  const tier=(state.draft.tierSchedule||DraftPolicy.draftTierSchedule(state.roomCode))[round];
  return DraftPolicy.draftWeightedPair(state,tier);
}
}

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

export { DAMAGE_CLASS_LABEL, DAMAGE_CLASS_MATRIX, DECK_FORMAT_VERSION, DECK_RULESET_VERSION, DECK_SLOT_COUNT, DECK_TOTAL_CARD_COUNT, DRAFT_COUNTER_AA, DRAFT_COUNTER_DETECT, DRAFT_TOTAL_ROUNDS, DeckCardRuleDefinition, DeckRecord, DefenseCardDefinition, DraftPolicy, SIZE_CLASS_LABEL, VALID_DAMAGE_CLASSES };
