// WebRTC peer transport over Nostr signaling, plus the loopback transport.
import { RecoveryTelemetry } from '../diagnostics/recovery-telemetry.js';
import { LobbyControlCodec } from './lobby-codec.js';
import { P2P_CONNECT_ATTEMPT_TIMEOUT_MS, P2P_RECONNECT_MIN_MS } from '../core/session-timing.js';
import { SIM_VERSION } from '../core/config.js';
import { BUILD_ID } from '../core/build-info.js';

/* =========================
   2. Peer transport
   ========================= */
const RALLY_RTC_SIGNAL_PROTOCOL="rally-frontier-rtc/1";
const RALLY_RTC_SIGNAL_TYPES=new Set(["hello","version-mismatch","offer","answer","ice","bye"]);
const RALLY_NOSTR_RELAYS=[
  "wss://nos.lol",
  "wss://relay.damus.io",
  "wss://relay.snort.social"
];
const RALLY_ICE_SERVERS=[
  {urls:"stun:stun.l.google.com:19302"},
  {urls:"stun:stun1.l.google.com:3478"}
];
const RTC_SEND_HIGH_WATER_BYTES=512*1024;
const RTC_SEND_LOW_WATER_BYTES=128*1024;
const RTC_SEND_MAX_QUEUE_BYTES=8*1024*1024;
const rtcTextEncoder=new TextEncoder();
const rtcTextDecoder=new TextDecoder();

const localRtcSignalBuses=new Map();
class LocalRtcSignalBus{
  constructor(owner,onSignal){this.owner=owner;this.onSignal=onSignal;this.opened=false}
  open(){
    let set=localRtcSignalBuses.get(this.owner.roomCode);
    if(!set)localRtcSignalBuses.set(this.owner.roomCode,set=new Set());
    set.add(this);this.opened=true;queueMicrotask(()=>this.owner.onSignalingReady());
  }
  publish(payload){
    if(!this.opened)return false;
    const set=localRtcSignalBuses.get(this.owner.roomCode);
    if(!set)return false;
    const envelope={...payload,from:this.owner.signalId,roomCode:this.owner.roomCode,protocol:RALLY_RTC_SIGNAL_PROTOCOL};
    for(const bus of set){
      if(bus===this)continue;
      queueMicrotask(()=>bus.onSignal(envelope));
    }
    return true;
  }
  suspend(){this.close()}
  resume(){if(!this.opened)this.open()}
  close(){
    if(!this.opened)return;
    this.opened=false;
    const set=localRtcSignalBuses.get(this.owner.roomCode);
    set?.delete(this);if(set&&!set.size)localRtcSignalBuses.delete(this.owner.roomCode);
  }
}

class MinimalNostrSignalBus{
  constructor(owner,onSignal){
    this.owner=owner;this.onSignal=onSignal;this.signaler=null;this.unsubscribe=null;
    this.abortController=null;this.openPromise=null;this.closed=false;this.suspended=false;this.ready=false;
  }
  namespace(){return `rally-frontier:rtc:${RALLY_RTC_SIGNAL_PROTOCOL}:sim-${SIM_VERSION}`}
  open(){
    if(this.closed)return Promise.resolve(false);
    this.suspended=false;
    if(this.ready){this.owner.onSignalingReady();return Promise.resolve(true)}
    if(this.openPromise)return this.openPromise;
    const create=globalThis.RallyNetcode?.createNostrSignaler;
    if(typeof create!=="function"){
      this.owner.onError({type:"nostr-module-unavailable",message:"URL 네트워크 모듈이 준비되지 않았습니다."});
      return Promise.resolve(false);
    }
    const abortController=this.abortController=new AbortController();
    this.openPromise=(async()=>{
      try{
        const signaler=await create({room:String(this.owner.roomCode),namespace:this.namespace(),
          relays:RALLY_NOSTR_RELAYS,signal:abortController.signal,
          onStatus:status=>{
            if(this.closed)return;
            this.owner.trace("signal.nostr-status",status);
            if(status.status==="error")this.owner.onError({type:"nostr-signaling-error",nonFatal:true,
              message:"연결 정보 중계 오류: "+String(status.message||status.status)});
          }});
        if(this.closed||abortController.signal.aborted){signaler.close();return false}
        this.signaler=signaler;this.owner.signalId=signaler.id;this.ready=true;
        this.unsubscribe=signaler.subscribe(envelope=>{
          if(this.closed||this.suspended)return;
          const message=envelope?.message;
          if(!message||message.protocol!==RALLY_RTC_SIGNAL_PROTOCOL||String(message.roomCode)!==String(this.owner.roomCode))return;
          const signalType=message.signalType;
          if(!RALLY_RTC_SIGNAL_TYPES.has(signalType)||message.type!==(signalType==="hello"?"discover":signalType==="version-mismatch"?"presence":signalType))return;
          this.onSignal({...message,type:signalType,from:envelope.from,
            to:envelope.to==="*"?null:envelope.to});
        });
        if(!this.suspended)this.owner.onSignalingReady();
        return true;
      }catch(error){
        if(!this.closed&&!abortController.signal.aborted)this.owner.onError(error);
        return false;
      }finally{this.openPromise=null}
    })();
    return this.openPromise;
  }
  resume(){return this.open()}
  // SDK identity belongs to the signaler's lifetime. Keep it for RTC reconnects.
  suspend(){this.suspended=true}
  publish(payload){
    if(this.closed||this.suspended||!this.ready||!this.signaler||!RALLY_RTC_SIGNAL_TYPES.has(payload?.type))return false;
    const type=payload.type==="hello"?"discover":payload.type==="version-mismatch"?"presence":payload.type;
    const message={...payload,type,signalType:payload.type,protocol:RALLY_RTC_SIGNAL_PROTOCOL,roomCode:String(this.owner.roomCode)};
    delete message.to;
    const signaler=this.signaler;
    Promise.resolve().then(()=>signaler.send(payload.to??"*",message)).catch(error=>{
      if(!this.closed)this.owner.onError(error);
    });
    return true;
  }
  close(){
    if(this.closed)return;
    this.closed=true;this.ready=false;this.suspended=true;this.abortController?.abort();
    this.unsubscribe?.();this.unsubscribe=null;this.signaler?.close();this.signaler=null;
  }
}

class NostrRtcTransport{
  constructor(role,roomCode,{signalMode="nostr"}={}){
    this.role=role;this.roomCode=roomCode;this.signalMode=signalMode;
    this.pc=null;this.dc=null;this.conn=null;this.signaler=null;
    this.netcodeInputChannel=null;this.netcodeControlChannel=null;this.netcodeTransport=null;this.netcodeUnsubscribe=null;this.netcodeStatusUnsubscribe=null;this.netcodeListeners=new Set();this.netcodeStatusListeners=new Set();
    this.onMessage=()=>{};this.onPeerReady=()=>{};this.onOpen=()=>{};this.onClose=()=>{};this.onError=()=>{};
    this.intentionalClose=false;this.everOpened=false;this.connState="idle";
    this.connectionSerial=0;this.lastAcceptedConnectionSerial=0;this.lastAcceptedOffer=null;this.connAttemptStartedAt=0;
    this.reconnectTimer=0;this.connAttemptTimer=0;this.rtcDisconnectTimer=0;this.helloTimer=0;
    this.remoteSignalId="";this.pendingIce=[];this.prePcIce=[];this.sendQueue=[];this.sendQueueBytes=0;
    this.signalId="local-"+Math.random().toString(36).slice(2,12);
    this.signalingOpen=false;this.lastDataAt=0;
  }
  channelLabel(){return "rally-frontier-"+this.roomCode}
  trace(type,extra={}){RecoveryTelemetry.recordRecovery(type,null,this,extra)}
  netcodeInputLabel(){return "rally-netcode-inputs-"+this.roomCode}
  netcodeControlLabel(){return "rally-netcode-control-"+this.roomCode}
  initSignalIdentity(){return this.signalMode==="local"||typeof globalThis.RallyNetcode?.createNostrSignaler==="function"}

  open(){
    this.intentionalClose=false;this.trace("transport.open");
    if(!this.initSignalIdentity()){this.onError({type:"nostr-module-unavailable",message:"Nostr 모듈이 준비되지 않았습니다."});return}
    this.openSignaling();
  }
  openSignaling(){
    if(this.intentionalClose)return false;
    if(this.signaler){this.signaler.resume();return true}
    const onSignal=m=>this.handleSignal(m);
    this.signaler=this.signalMode==="local"?new LocalRtcSignalBus(this,onSignal):new MinimalNostrSignalBus(this,onSignal);
    this.signaler.open();return true;
  }
  onSignalingReady(){
    if(this.intentionalClose)return;
    this.signalingOpen=true;this.trace("signal.ready",{mode:this.signalMode});
    if(this.role==="host")this.onPeerReady();else this.startHelloLoop(true);
  }
  suspendSignaling(){this.signalingOpen=false;this.stopHelloLoop();this.signaler?.suspend?.()}
  startHelloLoop(immediate=false){
    this.stopHelloLoop();
    const send=()=>{
      if(this.intentionalClose||this.role!=="guest"||this.conn?.open)return;
      if(this.signalingOpen)this.sendSignal("hello",{serial:this.connectionSerial+1});
      this.helloTimer=setTimeout(send,800);
    };
    if(immediate)send();else this.helloTimer=setTimeout(send,250);
  }
  stopHelloLoop(){if(this.helloTimer){clearTimeout(this.helloTimer);this.helloTimer=0}}
  sendSignal(type,data={},to=this.remoteSignalId||null){
    if(!this.signaler)return false;
    return this.signaler.publish({type,to,role:this.role,simVersion:SIM_VERSION,buildId:BUILD_ID,...data});
  }
  async handleSignal(m){
    if(this.intentionalClose||!m||m.protocol!==RALLY_RTC_SIGNAL_PROTOCOL)return;
    if(String(m.roomCode)!==String(this.roomCode)||m.from===this.signalId)return;
    const peer=String(m.from||"");
    if(!peer||m.role===this.role||!["host","guest"].includes(m.role))return;
    if(m.to!=null&&m.to!==this.signalId)return;
    if(this.remoteSignalId&&peer!==this.remoteSignalId)return;
    // Unselected relay peers cannot disrupt an established connection/recovery.
    if(this.conn?.open&&peer!==this.remoteSignalId)return;
    if(m.type==="version-mismatch"){
      if(m.to!==this.signalId||this.conn?.open)return;
      this.reportVersionMismatch(m.simVersion,peer);return;
    }
    if(!Number.isInteger(Number(m.simVersion))||Number(m.simVersion)!==SIM_VERSION){
      const initial=m.type==="hello"&&this.role==="host"&&!this.pc&&!this.conn||m.type==="offer"&&this.role==="guest";
      if(!initial)return;
      this.sendSignal("version-mismatch",{expectedVersion:SIM_VERSION,receivedVersion:m.simVersion},peer);
      this.reportVersionMismatch(m.simVersion,peer);return;
    }
    try{
      if(m.type==="hello"&&this.role==="host"){
        if(this.conn||this.pc)return;
        this.remoteSignalId=String(m.from||"");
        this.lastAcceptedConnectionSerial=Math.max(this.lastAcceptedConnectionSerial,Number(m.serial)||0);
        await this.beginHostOffer();return;
      }
      if(m.type==="offer"&&this.role==="guest"){
        if(this.remoteSignalId&&this.remoteSignalId!==m.from)return;
        const serial=Number(m.serial);
        if(!Number.isSafeInteger(serial)||serial<1)return;
        if(this.lastAcceptedOffer?.peer===peer&&serial<=this.lastAcceptedOffer.serial)return;
        this.lastAcceptedOffer={peer,serial};
        this.remoteSignalId=String(m.from||"");this.stopHelloLoop();
        this.lastAcceptedConnectionSerial=Math.max(this.lastAcceptedConnectionSerial,Number(m.serial)||0);
        await this.acceptOffer(m.sdp);return;
      }
      if(m.type==="answer"&&this.role==="host"&&this.pc&&m.from===this.remoteSignalId){
        await this.acceptAnswer(m.sdp);return;
      }
      if(m.type==="ice"&&m.candidate){
        if(this.remoteSignalId&&m.from!==this.remoteSignalId)return;
        if(!this.pc){this.prePcIce.push({from:String(m.from||""),candidate:m.candidate});return}
        if(m.from!==this.remoteSignalId)return;
        if(this.pc.remoteDescription){const pc=this.pc;try{await pc.addIceCandidate(m.candidate)}catch(e){if(this.isCurrentPeer(pc))throw e}}else this.pendingIce.push(m.candidate);
      }
    }catch(e){if(!this.intentionalClose)this.onError(e)}
  }
  reportVersionMismatch(remoteVersion,peer){
    const remote=Number.isInteger(Number(remoteVersion))?Number(remoteVersion):null;
    const key=`${peer}:${remote}`;
    if(this.lastVersionMismatchKey===key)return;
    this.lastVersionMismatchKey=key;
    if(this.role==="guest"){this.stopHelloLoop();this.clearReconnectTimer();this.clearConnectionAttemptTimer()}
    this.trace("signal.version-mismatch",{expectedVersion:SIM_VERSION,remoteVersion:remote,peer});
    this.onError({type:"version-mismatch",nonFatal:true,expectedVersion:SIM_VERSION,remoteVersion:remote,
      message:`게임 버전이 다릅니다. 내 SIM ${SIM_VERSION} / 상대 SIM ${remote??"확인 불가"}. 양쪽 모두 같은 최신 HTML로 새로고침하세요.`});
  }
  makePeerConnection(originator){
    this.discardCurrentConnection("replace-before-new-rtc");
    const serial=++this.connectionSerial;
    // Same-machine peers use real RTC host candidates; external STUN discovery is unnecessary.
    const pc=new RTCPeerConnection({iceServers:this.signalMode==="local"?[]:RALLY_ICE_SERVERS,sdpSemantics:"unified-plan"});
    this.pc=pc;
    this.pendingIce=this.prePcIce.filter(x=>!this.remoteSignalId||x.from===this.remoteSignalId).map(x=>x.candidate);
    this.prePcIce=[];
    this.connState="connecting";this.connAttemptStartedAt=Date.now();
    pc.onicecandidate=e=>{if(this.pc===pc&&e.candidate)this.sendSignal("ice",{candidate:e.candidate.toJSON?.()||e.candidate,serial})};
    const check=()=>this.watchRtcState(pc);
    pc.addEventListener("connectionstatechange",check);pc.addEventListener("iceconnectionstatechange",check);
    pc.ondatachannel=e=>this.bindDataChannel(pc,e.channel);
    if(originator){
      this.bindDataChannel(pc,pc.createDataChannel(this.channelLabel(),{ordered:true}));
      this.bindDataChannel(pc,pc.createDataChannel(this.netcodeInputLabel(),{ordered:false,maxRetransmits:0}));
      this.bindDataChannel(pc,pc.createDataChannel(this.netcodeControlLabel(),{ordered:true}));
    }
    this.armConnectionAttemptTimeout(pc,serial);
    return pc;
  }
  isCurrentPeer(pc){return !this.intentionalClose&&this.pc===pc}
  async beginHostOffer(){
    const peer=this.remoteSignalId,pc=this.makePeerConnection(true),serial=this.connectionSerial;
    try{
      const offer=await pc.createOffer();if(!this.isCurrentPeer(pc))return false;
      await pc.setLocalDescription(offer);if(!this.isCurrentPeer(pc))return false;
      return this.sendSignal("offer",{sdp:pc.localDescription,serial},peer);
    }catch(e){if(this.isCurrentPeer(pc))throw e;return false}
  }
  async acceptOffer(sdp){
    const peer=this.remoteSignalId,pc=this.makePeerConnection(false),serial=this.connectionSerial;
    try{
      await pc.setRemoteDescription(sdp);if(!this.isCurrentPeer(pc))return false;
      await this.flushPendingIce(pc);if(!this.isCurrentPeer(pc))return false;
      const answer=await pc.createAnswer();if(!this.isCurrentPeer(pc))return false;
      await pc.setLocalDescription(answer);if(!this.isCurrentPeer(pc))return false;
      return this.sendSignal("answer",{sdp:pc.localDescription,serial},peer);
    }catch(e){if(this.isCurrentPeer(pc))throw e;return false}
  }
  async acceptAnswer(sdp){
    const pc=this.pc;if(!this.isCurrentPeer(pc)||!pc)return false;
    try{
      await pc.setRemoteDescription(sdp);if(!this.isCurrentPeer(pc))return false;
      await this.flushPendingIce(pc);return this.isCurrentPeer(pc);
    }catch(e){if(this.isCurrentPeer(pc))throw e;return false}
  }
  async flushPendingIce(pc=this.pc){
    if(!this.isCurrentPeer(pc)||!pc?.remoteDescription)return false;
    const pending=this.pendingIce.splice(0);
    for(const c of pending){
      if(!this.isCurrentPeer(pc))return false;
      try{await pc.addIceCandidate(c)}catch(e){if(this.isCurrentPeer(pc))this.onError(e)}
    }
    return this.isCurrentPeer(pc);
  }
  bindDataChannel(pc,dc){
    if(this.intentionalClose||this.pc!==pc){try{dc.close()}catch{};return}
    if(dc.label===this.netcodeInputLabel()||dc.label===this.netcodeControlLabel()){
      this.bindNetcodeChannel(pc,dc);return;
    }
    if(dc.label!==this.channelLabel()||this.dc&&this.dc!==dc){try{dc.close()}catch{};return}
    this.bindLobbyDataChannel(pc,dc);
  }
  bindNetcodeChannel(pc,dc){
    const key=dc.label===this.netcodeInputLabel()?"netcodeInputChannel":"netcodeControlChannel";
    if(this[key]&&this[key]!==dc){try{dc.close()}catch{};return}
    this[key]=dc;dc.binaryType="arraybuffer";
    dc.onerror=event=>{if(this.isCurrentPeer(pc))this.onError(event?.error||event)};
    dc.onclose=()=>{
      if(!this.isCurrentPeer(pc)||this[key]!==dc)return;
      this.discardCurrentConnection("netcode-datachannel-close");this.onClose({recovering:true,reason:"netcode-datachannel-close"});
    };
    if(!this.netcodeTransport&&this.netcodeInputChannel&&this.netcodeControlChannel){
      const Carrier=globalThis.RallyNetcode?.WebRTCTransport;
      if(typeof Carrier!=="function")throw new Error("URL 넷코드 전송 모듈이 준비되지 않았습니다.");
      const carrier=this.netcodeTransport=new Carrier({inputChannel:this.netcodeInputChannel,controlChannel:this.netcodeControlChannel});
      this.netcodeStatusUnsubscribe=carrier.subscribeStatus(()=>this.emitNetcodeStatus());
      this.emitNetcodeStatus();
      this.netcodeUnsubscribe=carrier.subscribe(packet=>{
        if(this.netcodeTransport!==carrier||!this.isCurrentPeer(pc))return;
        this.lastDataAt=Date.now();
        for(const listener of this.netcodeListeners){try{listener(packet.slice())}catch(error){this.onError(error)}}
      });
    }
  }
  get netcodeState(){
    if(this.intentionalClose||!this.pc)return 'closed';
    const state=this.pc.connectionState,ice=this.pc.iceConnectionState;
    if(state==='failed'||ice==='failed')return 'failed';
    if(state==='closed')return 'closed';
    if(state==='disconnected'||ice==='disconnected')return 'interrupted';
    return this.netcodeTransport?.state||'connecting';
  }
  subscribeNetcodeStatus(listener){
    if(typeof listener!=='function')throw new TypeError('netcode status subscriber');
    this.netcodeStatusListeners.add(listener);return ()=>this.netcodeStatusListeners.delete(listener);
  }
  emitNetcodeStatus(){for(const listener of this.netcodeStatusListeners){try{listener(this.netcodeState)}catch(error){this.onError(error)}}}
  get netcodeBufferedAmount(){return this.netcodeTransport?.bufferedAmount||0}
  isNetcodeOpen(){return !!(this.netcodeInputChannel?.readyState==="open"&&this.netcodeControlChannel?.readyState==="open")}
  sendNetcode(packet){
    if(!(packet instanceof Uint8Array))return false;
    try{return this.netcodeTransport?.send(packet)||false}catch(error){this.onError(error);return false}
  }
  subscribeNetcode(listener){
    if(typeof listener!=="function")throw new TypeError("넷코드 수신 함수가 필요합니다.");
    this.netcodeListeners.add(listener);return ()=>this.netcodeListeners.delete(listener);
  }
  bindLobbyDataChannel(pc,dc){
    this.dc=dc;dc.binaryType="arraybuffer";dc.bufferedAmountLowThreshold=RTC_SEND_LOW_WATER_BYTES;
    const conn={open:dc.readyState==="open",peerConnection:pc,dataChannel:dc,label:dc.label,metadata:{roomCode:this.roomCode},close:()=>{try{dc.close()}catch{}},send:m=>this.send(m)};
    this.conn=conn;
    dc.onopen=()=>{
      if(this.dc!==dc||this.pc!==pc||this.intentionalClose)return;
      this.clearConnectionAttemptTimer();this.connState="open";this.connAttemptStartedAt=0;this.lastDataAt=Date.now();conn.open=true;
      const reconnect=this.everOpened;this.everOpened=true;this.lastVersionMismatchKey="";this.stopHelloLoop();this.flushSendQueue();
      this.trace("conn.open",{reconnect,label:dc.label,serial:this.connectionSerial});this.onOpen({reconnect});
      setTimeout(()=>{if(this.dc===dc&&dc.readyState==="open")this.suspendSignaling()},250);
    };
    dc.onmessage=e=>{
      if(this.dc!==dc||this.intentionalClose)return;
      this.lastDataAt=Date.now();
      try{this.onMessage(LobbyControlCodec.decodeRtcMessage(e.data))}catch(err){this.onError(err)}
    };
    dc.onbufferedamountlow=()=>{if(this.dc===dc)this.flushSendQueue()};
    dc.onerror=e=>{if(this.dc===dc&&!this.intentionalClose)this.onError(e?.error||e)};
    dc.onclose=()=>{
      if(this.dc!==dc||this.intentionalClose)return;
      this.trace("conn.close",{label:dc.label});this.discardCurrentConnection("datachannel-close");this.onClose({recovering:true});
    };
  }
  watchRtcState(pc){
    if(this.pc!==pc||this.intentionalClose)return;
    const state=String(pc.connectionState||""),ice=String(pc.iceConnectionState||"");
    this.trace("rtc.state",{state,ice});this.emitNetcodeStatus();
    if(state==="failed"||state==="closed"||ice==="failed"){this.failRtcConnection(pc,`rtc-${state||ice||"failed"}`);return}
    if(state==="disconnected"||ice==="disconnected"){
      if(!this.rtcDisconnectTimer)this.rtcDisconnectTimer=setTimeout(()=>{
        this.rtcDisconnectTimer=0;if(this.pc!==pc||this.intentionalClose)return;
        const s=String(pc.connectionState||""),i=String(pc.iceConnectionState||"");
        if(s==="failed"||s==="closed"||s==="disconnected"||i==="failed"||i==="disconnected")this.failRtcConnection(pc,`rtc-${s||i||"disconnected"}`);
      },2500);
    }else this.clearRtcDisconnectTimer();
  }
  failRtcConnection(pc,reason){
    if(this.pc!==pc||this.intentionalClose)return false;
    const had=!!this.conn||!!this.pc;this.discardCurrentConnection(reason);if(had)this.onClose({recovering:true,reason,rtcFailed:true});return had;
  }
  armConnectionAttemptTimeout(pc,serial){
    this.clearConnectionAttemptTimer();
    this.connAttemptTimer=setTimeout(()=>{
      this.connAttemptTimer=0;if(this.pc!==pc||this.conn?.open||this.intentionalClose||serial!==this.connectionSerial)return;
      this.discardCurrentConnection("connect-timeout");
      if(this.everOpened)this.onClose({recovering:true,reason:"connect-timeout"});else this.scheduleReconnect();
    },P2P_CONNECT_ATTEMPT_TIMEOUT_MS);
  }
  clearConnectionAttemptTimer(){if(this.connAttemptTimer){clearTimeout(this.connAttemptTimer);this.connAttemptTimer=0}}
  clearReconnectTimer(){if(this.reconnectTimer){clearTimeout(this.reconnectTimer);this.reconnectTimer=0}}
  clearReconnectControlTimers(){this.clearReconnectTimer();this.clearConnectionAttemptTimer();this.clearRtcDisconnectTimer();this.stopHelloLoop()}
  clearRtcDisconnectTimer(){if(this.rtcDisconnectTimer){clearTimeout(this.rtcDisconnectTimer);this.rtcDisconnectTimer=0}}
  discardCurrentConnection(reason="discard"){
    this.clearConnectionAttemptTimer();this.clearRtcDisconnectTimer();
    const dc=this.dc,pc=this.pc,carrier=this.netcodeTransport;
    const coreChannels=[this.netcodeInputChannel,this.netcodeControlChannel],had=!!dc||!!pc||!!this.conn;
    this.netcodeTransport=null;this.netcodeInputChannel=null;this.netcodeControlChannel=null;
    this.netcodeUnsubscribe?.();this.netcodeUnsubscribe=null;
    this.netcodeStatusUnsubscribe?.();this.netcodeStatusUnsubscribe=null;
    for(const channel of coreChannels)if(channel)channel.onopen=channel.onclose=channel.onerror=null;
    try{carrier?.close()}catch(error){this.onError(error)}
    for(const channel of coreChannels){try{channel?.close()}catch{}}
    this.dc=null;this.pc=null;this.conn=null;this.connState="idle";this.connAttemptStartedAt=0;this.pendingIce=[];this.sendQueue=[];this.sendQueueBytes=0;
    try{if(dc){dc.onopen=dc.onmessage=dc.onclose=dc.onerror=dc.onbufferedamountlow=null;dc.close()}}catch{}
    try{if(pc){pc.onicecandidate=pc.ondatachannel=null;pc.close()}}catch{}
    this.emitNetcodeStatus();this.trace("rtc.discard",{reason});return had;
  }
  scheduleReconnect(){
    if(this.intentionalClose||this.conn?.open||this.reconnectTimer)return;
    const delay=P2P_RECONNECT_MIN_MS;
    this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=0;if(this.intentionalClose||this.conn?.open)return;this.openSignaling();if(this.role==="guest")this.startHelloLoop(true)},delay);
  }
  forceReconnect(reason="transport-stall"){
    if(this.intentionalClose)return false;const had=this.discardCurrentConnection(reason);if(had)this.onClose({recovering:true,reason,forced:true});this.openSignaling();if(this.role==="guest")this.startHelloLoop(true);return true;
  }
  resetRtcNegotiation(reason,{guestHello=false}={}){
    if(this.intentionalClose)return false;
    this.clearReconnectControlTimers();
    // Retain the last offer across recovery; a new host identity has its own serial.
    this.remoteSignalId="";
    this.discardCurrentConnection(reason);
    this.openSignaling();
    if(guestHello&&this.role==="guest")this.startHelloLoop(false);
    return true;
  }
  prepareRecoveryHost(reason="manual-host-snapshot"){
    return this.role==="host"&&this.resetRtcNegotiation(reason);
  }
  rebuildRecoveryGuest(reason="manual-host-snapshot"){
    return this.role==="guest"&&this.resetRtcNegotiation(reason,{guestHello:true});
  }
  
  queueFrame(frame){
    const bytes=frame.byteLength||0;if(this.sendQueueBytes+bytes>RTC_SEND_MAX_QUEUE_BYTES){this.onError({type:"rtc-send-queue-overflow",message:"RTC send queue overflow"});return false}
    this.sendQueue.push(frame);this.sendQueueBytes+=bytes;return true;
  }
  flushSendQueue(){
    const dc=this.dc;if(!dc||dc.readyState!=="open")return;
    while(this.sendQueue.length&&dc.bufferedAmount<RTC_SEND_HIGH_WATER_BYTES){
      const frame=this.sendQueue.shift();this.sendQueueBytes-=frame.byteLength||0;try{dc.send(frame)}catch(e){this.onError(e);this.forceReconnect("send-failed");return}
    }
  }
  isOpen(){return !!(this.dc?.readyState==="open"&&this.conn?.open)}
  send(m){
    const dc=this.dc;if(!this.isOpen())return false;
    let frame;try{frame=LobbyControlCodec.encodeRtcMessage(m)}catch(e){this.onError(e);return false}
    if(dc.bufferedAmount>=RTC_SEND_HIGH_WATER_BYTES||this.sendQueue.length)return this.queueFrame(frame);
    try{dc.send(frame);return true}catch(e){this.onError(e);this.forceReconnect("send-failed");return false}
  }
  close(){
    this.intentionalClose=true;this.clearReconnectControlTimers();this.discardCurrentConnection("intentional-close");this.signaler?.close?.();this.signaler=null;this.signalingOpen=false;this.netcodeListeners.clear();this.netcodeStatusListeners.clear();
  }
}

export { NostrRtcTransport, rtcTextDecoder, rtcTextEncoder };
