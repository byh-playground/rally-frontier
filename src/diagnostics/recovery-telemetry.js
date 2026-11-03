// Memory-only recovery and correction flight recorders.
import { ActiveViewState } from '../session/runtime-state.js';
import { BUILD_META } from '../core/build-info.js';
import { ConnectionPresentation, LocalEnvironmentUtil, LogUtil, MatchLifecycle, SinglePlayerModeUtil } from '../main.js';

/* =========================
   Recovery flight recorder — memory only
   ========================= */
const RECOVERY_EVENT_LIMIT=300;

class RecoveryTelemetry{
  static recoveryTransportState(trans){
  const pc=trans?.conn?.peerConnection||null;
  const dc=trans?.conn?.dataChannel||null;
  return {
    role:trans?.role||null,
    roomCode:trans?.roomCode||null,
    peerId:trans?.peer?.id||null,
    peerOpen:!!trans?.peer?.open,
    peerDisconnected:!!trans?.peer?.disconnected,
    peerDestroyed:!!trans?.peer?.destroyed,
    connOpen:!!trans?.isOpen?.(),
    connState:trans?.connState||"idle",
    connLabel:trans?.conn?.label||dc?.label||null,
    connectionSerial:Number(trans?.connectionSerial)||0,
    acceptedSerial:Number(trans?.lastAcceptedConnectionSerial)||0,
    rtcConnectionState:pc?.connectionState||null,
    iceConnectionState:pc?.iceConnectionState||null,
    iceGatheringState:pc?.iceGatheringState||null,
    signalingState:pc?.signalingState||null,
    dataChannelReadyState:dc?.readyState||null
  };
}
  static recoverySessionState(sess){
  return {
    role:sess?.role||null,
    roomCode:sess?.roomCode||null,
    tick:sess?.sim?.tick??null,
    runtimeSeq:Number(sess?.runtimeSeq)||0,
    transportConnected:!!sess?.transportConnected,
    syncHold:!!sess?.syncHold,
    recoveryPhase:sess?.recoveryPhase||"idle",
    simulationFatal:!!sess?.simulationFatal,
    fatalMessage:sess?.simulationFatalInfo?.message||"",
    simpleToken:sess?.simpleRecoveryToken||"",
    manualNeeded:!!sess?.simpleRecoveryNeedsManual
  };
}
  static recordRecovery(type,sess=null,trans=null,extra={}){
  return recoveryFlightRecorder.record(type,{
    session:RecoveryTelemetry.recoverySessionState(sess),
    transport:RecoveryTelemetry.recoveryTransportState(trans||sess?.transport),
    ...extra
  });
}
  static startSingleManualSnapshotRecovery(reason="manual-single-reconnect"){
  const match=MatchLifecycle.singleMatch,host=match?.sessions?.host,guest=match?.sessions?.guest;
  if(!host?.sim||!guest?.sim||host.simEnded||guest.simEnded)return false;
  if(host.transportConnected&&guest.transportConnected&&host.transport.isNetcodeOpen()&&guest.transport.isNetcodeOpen())return guest.startSimpleRecovery(reason);
  const token=String(++host.simpleRecoverySeq);guest.simpleRecoverySeq=host.simpleRecoverySeq;
  host.prepareSimpleRecovery(token,reason);guest.prepareSimpleRecovery(token,reason);
  const ok=!!host.transport.prepareRecoveryHost?.(reason)&&!!guest.transport.rebuildRecoveryGuest?.(reason);
  if(!ok){host.simpleRecoveryNeedsManual=true;guest.simpleRecoveryNeedsManual=true;host.recoveryPhase=guest.recoveryPhase="needs-manual"}
  return ok;
}
  static exportCorrectionFlightLog(){
  const events=correctionFlightRecorder.all(),active=MatchLifecycle.activeSession?.();
  const payload={exportedAt:new Date().toISOString(),build:BUILD_META.id,buildMetadata:BUILD_META.snapshot(),role:active?.role||null,tps:active?.sim?.tps??null,currentTick:active?.sim?.tick??null,runtimeSeq:active?.runtimeSeq??null,events};
  const blob=new Blob([JSON.stringify(payload)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=`rally-frontier-corrections-${Date.now()}.json`;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);LogUtil.log(`보정 로그 ${events.length}개 JSON 저장`);
}
  static requestManualRecovery(){
  const active=MatchLifecycle.activeSession?.();

  if(!active?.sim||active.simEnded){
    LogUtil.log("복구할 진행 중 게임이 없습니다.");
    return false;
  }

  const started=SinglePlayerModeUtil.isSinglePlayer()
    ?RecoveryTelemetry.startSingleManualSnapshotRecovery()
    :active.startSimpleRecovery("manual-host-snapshot");

  if(started){
    LogUtil.log("공통 코어 복구 시작 · 입력 이력 보존 · 검증한 과거 snapshot 재실행");
    ConnectionPresentation.renderLockstepDebugPanel();
  }else{
    LogUtil.log("복구를 시작하지 못했습니다.");
  }
  return started;
}
  
  static localRecoverySession(){
  if(SinglePlayerModeUtil.isSinglePlayer()){
    return MatchLifecycle.singleMatch?.sessions?.[MatchLifecycle.singleMatch.humanRole||"guest"]||ActiveViewState.session||null;
  }
  if(LocalEnvironmentUtil.isLocalTest()){
    return MatchLifecycle.localTest?.sessions?.[ActiveViewState.role]||ActiveViewState.session||null;
  }
  return ActiveViewState.session||null;
}
}

const recoveryFlightRecorder={
  memory:[],
  seq:0,
  record(type,data={}){
    const event={
      seq:++this.seq,
      wallTime:new Date().toISOString(),
      wallMs:Date.now(),
      perfMs:Math.round(performance.now()),
      visibility:typeof document!=="undefined"?document.visibilityState:null,
      type,
      ...data
    };

    this.memory.push(event);
    if(this.memory.length>RECOVERY_EVENT_LIMIT){
      this.memory.splice(0,this.memory.length-RECOVERY_EVENT_LIMIT);
    }
    return event;
  },
  all(){
    return this.memory.slice();
  },
  clear(){
    this.memory.length=0;
  }
};

const CORRECTION_LOG_LIMIT=32;
const correctionFlightRecorder={
  memory:[],seq:0,
  record(kind,sess,data={}){
    const event={seq:++this.seq,at:new Date().toISOString(),kind,role:sess?.role||null,
      tick:sess?.sim?.tick??data.tick??null,peerTick:sess?.lastRemoteTick??null,
      runtimeSeq:sess?.runtimeSeq??null,...data};
    this.memory.push(event);
    if(this.memory.length>CORRECTION_LOG_LIMIT)this.memory.splice(0,this.memory.length-CORRECTION_LOG_LIMIT);
    return event;
  },
  all(){return this.memory.slice()},
  clear(){this.memory.length=0}
};

export { RecoveryTelemetry };
