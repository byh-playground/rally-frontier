// Rally's session-facing peer transport, on GameKit's reconnecting room.
// GameKit owns Nostr discovery, SDP/ICE, the three data channels, reconnect and version checks.
// This class only maps the room onto what GameSession expects: lobby messages, Netcode packets and callbacks.
import { RecoveryTelemetry } from '../diagnostics/recovery-telemetry.js';
import { LobbyControlCodec } from './lobby-codec.js';
import { P2P_CONNECT_ATTEMPT_TIMEOUT_MS } from '../core/session-timing.js';
import { PRODUCT_VERSION } from '../core/product-version.js';

const RALLY_NOSTR_NAMESPACE="ssalkongpang";
const RALLY_NOSTR_RELAYS=[
  "wss://nos.lol",
  "wss://relay.damus.io",
  "wss://relay.snort.social"
];
const RALLY_ICE_SERVERS=[
  {urls:"stun:stun.l.google.com:19302"},
  {urls:"stun:stun1.l.google.com:3478"}
];
// A host waits as long as the room allows for a guest; a guest gives up on an unknown code sooner.
const HOST_WAIT_MS=3600000;
const GUEST_FIND_MS=20000;
// The session's own 60 s disconnect grace ends a match first; this only bounds a lost link's retries.
const RECONNECT_BUDGET_MS=120000;
const DISCONNECT_GRACE_MS=2500;
const SIGNAL_RETRY_MS=800;

// A local (same page) match is addressed by a four-digit code derived from its token.
function localRoomCode(token){
  let h=2166136261>>>0;const text=String(token);
  for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619)>>>0}
  return String(h%10000).padStart(4,"0");
}

class RoomTransport{
  constructor(role,roomCode,{signalMode="nostr"}={}){
    this.role=role;this.roomCode=roomCode;this.signalMode=signalMode;
    this.room=null;this.unsubscribers=[];this.openController=null;this.intentionalClose=false;this.lastVersionMismatchKey="";
    // Subscribers outlive the room: a Worker-hosted session subscribes before the link exists.
    this.netcodeListeners=new Set();this.netcodeStatusListeners=new Set();
    this.onMessage=()=>{};this.onPeerReady=()=>{};this.onOpen=()=>{};this.onClose=()=>{};this.onError=()=>{};
  }
  get everOpened(){return (this.room?.generation||0)>0}
  trace(type,extra={}){RecoveryTelemetry.recordRecovery(type,null,this,extra)}

  // Resolves once discovery is ready (a host also after its room-code check). The link itself opens later.
  async open(){
    if(this.openController&&!this.openController.signal.aborted)return false;
    const controller=new AbortController();this.openController=controller;
    this.intentionalClose=false;this.trace("transport.open");
    const netcode=globalThis.RallyNetcode,local=this.signalMode==="local";
    if(typeof netcode?.createNostrRoom!=="function"||(local&&typeof netcode.createLocalSignaler!=="function")){
      this.onError({type:"nostr-module-unavailable",message:"Nostr 모듈이 준비되지 않았습니다."});return false;
    }
    let room;
    try{
      room=await netcode.createNostrRoom({
        signal:controller.signal,
        role:this.role==="guest"?"join":"host",room:local?localRoomCode(this.roomCode):String(this.roomCode),
        namespace:RALLY_NOSTR_NAMESPACE,version:PRODUCT_VERSION,relays:RALLY_NOSTR_RELAYS,
        rtcConfig:{iceServers:local?[]:RALLY_ICE_SERVERS},signalerFactory:local?netcode.createLocalSignaler:undefined,
        timeoutMs:this.role==="host"?HOST_WAIT_MS:GUEST_FIND_MS,reconnectTimeoutMs:RECONNECT_BUDGET_MS,
        peerTimeoutMs:P2P_CONNECT_ATTEMPT_TIMEOUT_MS,disconnectGraceMs:DISCONNECT_GRACE_MS,retryMs:SIGNAL_RETRY_MS,
        // Two rooms in one page cannot collide on a code, so a local host need not listen for one.
        collisionCheckMs:local?0:undefined,
      });
    }catch(error){
      if(!controller.signal.aborted&&!this.intentionalClose)this.onError({type:error?.code||"room-create-failed",message:error?.code==="room-in-use"?"이미 사용 중인 방 코드입니다. 다른 코드로 다시 만들어 주세요.":String(error?.message||error)});
      return false;
    }
    if(controller.signal.aborted||this.intentionalClose){room.close();return false}
    this.room=room;
    this.unsubscribers.push(
      room.subscribe(event=>this.handleRoomEvent(event)),
      room.transport.subscribe(packet=>{for(const listener of this.netcodeListeners){try{listener(packet.slice())}catch(error){this.onError(error)}}}),
      room.transport.subscribeStatus(()=>this.emitNetcodeStatus()),
      room.app.subscribe(bytes=>{
        if(this.intentionalClose)return;
        try{this.onMessage(LobbyControlCodec.decodeRtcMessage(bytes))}catch(error){this.onError(error)}
      }),
    );
    this.trace("signal.ready",{mode:this.signalMode});
    if(this.role==="host")this.onPeerReady();
    return true;
  }
  handleRoomEvent(event){
    if(this.intentionalClose)return;
    if(event.type==="state"){
      this.trace("room."+event.state,{reason:event.reason,generation:event.generation});this.emitNetcodeStatus();
      if(event.state==="open")this.onOpen({reconnect:event.reconnect??event.generation>1});
      else if(event.state==="interrupted")this.onClose({recovering:true,reason:event.reason,forced:!!event.forced});
      else if(event.state==="failed")this.handleFailure();
    }else if(event.type==="version-mismatch")this.reportVersionMismatch(event);
    else if(event.type==="error")this.onError({type:event.code||"room-error",nonFatal:true,message:String(event.error?.message||event.message||event.code||"연결 오류"),error:event.error});
  }
  handleFailure(){
    const reason=this.room?.failure?.reason;
    if(reason==="version-mismatch")return; // already reported with both versions
    if(reason==="timeout"){
      // A host keeps waiting for its guest; a guest that never found the room reports it.
      if(this.role==="host"){this.room.reconnect({reason:"wait-for-guest"});return}
      this.onError({type:"signal-timeout",message:"signal-timeout"});return;
    }
    this.onClose({recovering:false,reason:reason||"failed"});
  }
  reportVersionMismatch(event){
    const remote=typeof event.remote==="string"?event.remote:null,key=`${event.peerId}:${remote}`;
    if(this.lastVersionMismatchKey===key)return;
    this.lastVersionMismatchKey=key;
    this.trace("signal.version-mismatch",{expectedVersion:PRODUCT_VERSION,remoteVersion:remote,peer:event.peerId});
    this.onError({type:"version-mismatch",nonFatal:true,expectedVersion:PRODUCT_VERSION,remoteVersion:remote,
      message:`게임 버전이 다릅니다. 내 v${PRODUCT_VERSION} / 상대 ${remote??"확인 불가"}. 양쪽 모두 같은 최신 게임으로 새로고침하세요.`});
  }

  isOpen(){return this.room?.state==="open"}
  send(message){
    if(!this.isOpen())return false;
    let frame;try{frame=new Uint8Array(LobbyControlCodec.encodeRtcMessage(message))}catch(error){this.onError(error);return false}
    return this.room.app.send(frame);
  }

  // Netcode packets ride the room's input/control channels; the same transport object survives reconnects.
  get netcodeState(){return this.room?.transport.state||"closed"}
  get netcodeBufferedAmount(){return this.room?.transport.bufferedAmount||0}
  isNetcodeOpen(){return this.netcodeState==="open"}
  sendNetcode(packet){
    if(!(packet instanceof Uint8Array)||!this.room)return false;
    try{return this.room.transport.send(packet)}catch(error){this.onError(error);return false}
  }
  subscribeNetcode(listener){
    if(typeof listener!=="function")throw new TypeError("넷코드 수신 함수가 필요합니다.");
    this.netcodeListeners.add(listener);return ()=>this.netcodeListeners.delete(listener);
  }
  subscribeNetcodeStatus(listener){
    if(typeof listener!=="function")throw new TypeError("netcode status subscriber");
    this.netcodeStatusListeners.add(listener);return ()=>this.netcodeStatusListeners.delete(listener);
  }
  emitNetcodeStatus(){for(const listener of this.netcodeStatusListeners){try{listener(this.netcodeState)}catch(error){this.onError(error)}}}

  forceReconnect(reason="transport-stall"){return !!this.room?.reconnect({reason})}
  // Manual recovery rebuilds the pairing: a fresh peer on both sides, then the host snapshot resyncs the match.
  prepareRecoveryHost(reason="manual-host-snapshot"){return this.role==="host"&&!!this.room?.reconnect({reason,newPeer:true})}
  rebuildRecoveryGuest(reason="manual-host-snapshot"){return this.role==="guest"&&!!this.room?.reconnect({reason,newPeer:true})}

  close(){
    this.intentionalClose=true;this.openController?.abort();
    for(const unsubscribe of this.unsubscribers.splice(0))try{unsubscribe()}catch{}
    this.room?.close();this.netcodeListeners.clear();this.netcodeStatusListeners.clear();
  }
}

export { RoomTransport };
