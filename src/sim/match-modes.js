// Draft and deck match setup state.
import { CloneUtil } from './map-generation.js';
import { DRAFT_TOTAL_ROUNDS, DeckCardRuleDefinition, DeckRecord, DefenseCardDefinition, DraftPolicy } from '../definitions/decks.js';

class DraftGame{
  static initial(roomCode){
    const state={phase:"draft",roomCode,draft:{round:0,pairs:[],tierSchedule:DraftPolicy.draftTierSchedule(roomCode),chooser:"host",waivedCounterMask:{host:0,guest:0}},decks:{host:[],guest:[]},defenseCards:{host:[],guest:[]},winner:null};
    state.draft.pairs.push(DraftPolicy.draftGeneratePair(state));
    return state;
  }
  static apply(state,role,action){
    const s=CloneUtil.clone(state);if(action.type!=="DRAFT_PICK"||s.phase!=="draft"||s.draft.chooser!==role)return state;
    const pair=s.draft.pairs[s.draft.round];if(!pair||!pair.includes(action.card))return state;
    const other=pair[0]===action.card?pair[1]:pair[0];
    if(!DefenseCardDefinition.get(action.card)){
      const nextRound=s.draft.round+1;
      const chosenOutcome=DraftPolicy.draftOutcomeState(state,pair,action.card);
      if(!DraftPolicy.draftCanCoverGuaranteesInFuture(chosenOutcome,nextRound,pair)){
        const altOutcome=DraftPolicy.draftOutcomeState(state,pair,other);
        const chooserNeeds=DraftPolicy.draftGuaranteeNeedsMask(chosenOutcome,role);
        const cover=DraftPolicy.draftCounterMask(other)&chooserNeeds;
        if(cover&&DraftPolicy.draftCanCoverGuaranteesInFuture(altOutcome,nextRound,pair)){
          s.draft.waivedCounterMask=s.draft.waivedCounterMask||{host:0,guest:0};
          s.draft.waivedCounterMask[role]=(Number(s.draft.waivedCounterMask[role])||0)|chooserNeeds;
        }
      }
    }
    if(DefenseCardDefinition.get(action.card)){
      s.defenseCards=s.defenseCards||{host:[],guest:[]};
      s.defenseCards[role]=[action.card];
      s.defenseCards[role==="host"?"guest":"host"]=[other];
    }else{
      s.decks[role].push(action.card);
      s.decks[role==="host"?"guest":"host"].push(other);
    }
    s.draft.round++;
    if(s.draft.round>=DRAFT_TOTAL_ROUNDS){
      s.phase="live";
    }else{
      s.draft.chooser=s.draft.chooser==="host"?"guest":"host";
      s.draft.pairs[s.draft.round]=DraftPolicy.draftGeneratePair(s);
    }
    return s;
  }
}

class DeckGame{
  static initial(roomCode){
    return {
      phase:"deck-select",
      roomCode,
      selectionMode:"deck",
      decks:{host:[],guest:[]},
      defenseCards:{host:[],guest:[]},
      deckReady:{host:false,guest:false},
      deckSelectDeadlineAt:0,
      winner:null
    };
  }
  static apply(state,role,payload){
    if(!state||state.phase!=="deck-select"||!["host","guest"].includes(role)||!DeckRecord.validateDeckPayload(payload))return state;
    const s=CloneUtil.clone(state);
    const selection=DeckRecord.deckRuntimeSelection(payload);if(!selection)return state;
    s.decks[role]=selection.unitIds.slice();
    s.defenseCards[role]=selection.defenseCardIds.slice(0,DeckCardRuleDefinition.rules.defense.max);
    s.deckReady=s.deckReady||{host:false,guest:false};
    s.deckReady[role]=true;
    if(s.deckReady.host&&s.deckReady.guest)s.phase="live";
    return s;
  }
}

export { DeckGame, DraftGame };
