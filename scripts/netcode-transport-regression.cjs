const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium: nativeChromium } = require('playwright');
const chromium = require('./netcode-qa-module.cjs').wrapChromium(nativeChromium);

// QA_SDK_PATH explicitly intercepts the production URL for candidate verification.
const htmlPath = process.argv[2] || process.env.QA_HTML_PATH || path.resolve(__dirname, '..', 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
for (const [index, match] of [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].entries()) {
  if (!/\btype=["'](?:module|application\/json)["']/i.test(match[1])) {
    new vm.Script(match[2], {filename:`index.html:inline-${index}`});
  }
}
const end = html.lastIndexOf('})();');
assert.ok(end >= 0, 'Application IIFE exists');
html = html.slice(0, end) + `
  window.__netcodeTransportQA = { NostrRtcTransport, LoopbackTransport, MinimalNostrSignalBus,
    NetworkModuleLoader, GameSession, SIM_VERSION, RALLY_RTC_SIGNAL_PROTOCOL };
` + html.slice(end);

async function runTransportRegression() {
  const {NostrRtcTransport, LoopbackTransport, GameSession} = window.__netcodeTransportQA;
  const sdk = window.RallyNetcode;
  const check = (value, message) => {if (!value) throw Error(message);};
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (test, label) => {
    const deadline = Date.now() + 16000;
    while (!test()) {
      if (Date.now() > deadline) throw Error('Timed out: ' + label);
      await pause(10);
    }
  };
  check(sdk && typeof sdk.WebRTCTransport === 'function', 'Pinned public SDK is present');
  const failures = [];
  const host = new NostrRtcTransport('host', 'transport-qa', {signalMode:'local'});
  const guest = new NostrRtcTransport('guest', 'transport-qa', {signalMode:'local'});
  const hostGame = new GameSession('host', host, 'transport-qa', {selectionMode:'deck'});
  const guestGame = new GameSession('guest', guest, 'transport-qa', {selectionMode:'deck'});
  host.onError = guest.onError = error => failures.push(String(error?.message || error));
  const lobby = [];
  for (const [transport, game] of [[host,hostGame],[guest,guestGame]]) {
    transport.onMessage = message => {lobby.push(message.type);game.handle(message);};
  }
  const packets = [];
  const unsubscribe = guest.subscribeNetcode(packet => packets.push([...packet]));
  const coreSessions = [];
  try {
    host.open(); guest.open();
    await wait(() => host.isOpen() && guest.isOpen() && host.isNetcodeOpen() && guest.isNetcodeOpen(), 'three actual RTC channels');
    const labels = [host.dc, host.netcodeInputChannel, host.netcodeControlChannel].map(channel => channel.label);
    check(new Set(labels).size === 3, 'Lobby and SDK labels differ');
    check(host.dc.ordered && host.dc.maxRetransmits === null, 'Lobby is reliable and ordered');
    check(!host.netcodeInputChannel.ordered && host.netcodeInputChannel.maxRetransmits === 0, 'SDK input is unordered and loss tolerant');
    check(host.netcodeControlChannel.ordered && host.netcodeControlChannel.maxRetransmits === null, 'SDK control is reliable and ordered');
    check(guest.conn.dataChannel === guest.dc && guest.conn.label === guest.channelLabel(), 'Core channels do not replace the lobby connection');
    guestGame.start();
    await wait(() => guestGame.draft?.phase === 'deck-select' && lobby.includes('HELLO') && lobby.includes('DRAFT_SYNC'), 'real GameSession lobby HELLO and DRAFT_SYNC');
    const marker = new Uint8Array([31,42,53]);
    check(host.sendNetcode(marker), 'Raw SDK carrier accepts Uint8Array');
    marker.fill(0);
    await wait(() => packets.length === 1, 'raw binary delivery');
    check(packets[0].join(',') === '31,42,53', 'RTC binary delivery retains sent bytes');
    check(!lobby.includes(undefined), 'Raw SDK packets never enter JSON lobby dispatch');

    const counts = {input:0,control:0};
    guest.netcodeInputChannel.addEventListener('message', () => counts.input++);
    guest.netcodeControlChannel.addEventListener('message', () => counts.control++);
    const makeAdapter = () => {
      let value = 0;
      return {
        save: () => new Uint8Array(new Uint32Array([value]).buffer),
        load: bytes => {value = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,true);},
        validateSnapshot: bytes => bytes.length === 4,
        step: frame => {for (const input of frame.inputs) value += input.input[0];}
      };
    };
    const carrier = transport => ({
      send: packet => transport.sendNetcode(packet),
      subscribe: listener => transport.subscribeNetcode(listener),
      get bufferedAmount(){return transport.netcodeBufferedAmount;},
      close() {}
    });
    const makeSession = (id, transport) => sdk.createSession({players:['host','guest'],localPlayerId:id,
      sessionId:'carrier-public-api',simulationVersion:'carrier-qa-v1',seed:7,inputSize:1,
      profile:{...sdk.profiles.lockstep,tickRate:20},adapter:makeAdapter(),
      onEvent: event => {if (['transport-error','incompatible'].includes(event.type)) failures.push(event.type);}});
    const a = makeSession('host',host), b = makeSession('guest',guest);
    coreSessions.push(a,b);
    a.attachTransport('guest',carrier(host)); b.attachTransport('host',carrier(guest));
    await wait(() => {a.poll();b.poll();return a.ready && b.ready;}, 'SDK public Session handshake');
    for (let attempts=0; attempts<200 && (a.tick<12 || b.tick<12); attempts++) {
      if (a.tick<12) a.advance(new Uint8Array([1])); else a.poll();
      if (b.tick<12) b.advance(new Uint8Array([2])); else b.poll();
      await pause(5);
    }
    await wait(() => {a.poll();b.poll();return a.confirmedTick>=11 && b.confirmedTick>=11;}, 'confirmed SDK input');
    check(a.tick===12 && b.tick===12 && a.getStateHash()===b.getStateHash(), 'Public SDK sessions converge over production raw carriers');
    check(counts.input>0 && counts.control>0, 'SDK chooses both packet channels through its public transport');
    const metrics = {host:a.metrics,guest:b.metrics};
    check(metrics.host.rejectedPackets===0 && metrics.guest.rejectedPackets===0, 'SDK receives intact packets');
    a.close();b.close();
    check(host.isOpen() && guest.isOpen() && host.isNetcodeOpen(), 'Session detach keeps game lobby and RTC open');

    const old = {pc:host.pc,lobby:host.dc,input:host.netcodeInputChannel,control:host.netcodeControlChannel,carrier:host.netcodeTransport};
    const before = packets.length;
    host.forceReconnect('transport-qa-reconnect');guest.forceReconnect('transport-qa-reconnect');
    await wait(() => host.isOpen() && guest.isOpen() && host.isNetcodeOpen() && guest.isNetcodeOpen(), 'three channels after RTC reconnect');
    check(old.pc.connectionState==='closed' && old.lobby.readyState==='closed' && old.input.readyState==='closed' && old.control.readyState==='closed', 'Discard closes all old RTC resources');
    check(host.netcodeTransport!==old.carrier && host.netcodeInputChannel!==old.input, 'Reconnect builds a fresh SDK carrier');
    check(host.sendNetcode(new Uint8Array([64])), 'Reconnect accepts raw packet');
    await wait(() => packets.length===before+1, 'subscriber survives RTC replacement');
    unsubscribe();
    const detached = packets.length;
    check(host.sendNetcode(new Uint8Array([65])), 'Carrier continues after subscriber detaches');
    await pause(40);
    check(packets.length===detached, 'Unsubscribe removes the persistent listener');
    const final = [host.pc,host.dc,host.netcodeInputChannel,host.netcodeControlChannel];
    host.close();guest.close();
    await wait(() => final[0].connectionState==='closed' && final.slice(1).every(channel => channel.readyState==='closed'), 'final close releases every channel and PC');
    check(!host.sendNetcode(new Uint8Array([1])), 'Closed carrier rejects sends');

    const loopA = new LoopbackTransport('host','loop-qa'), loopB = new LoopbackTransport('guest','loop-qa');
    loopA.pair(loopB);loopB.pair(loopA);loopA.open();loopB.open();
    await wait(() => loopA.isOpen() && loopB.isOpen(), 'loopback open');
    let jsonCount=0;
    loopB.onMessage=()=>jsonCount++;
    const copies=[];
    const offA=loopB.subscribeNetcode(packet=>{copies.push([...packet]);packet.fill(0);});
    const offB=loopB.subscribeNetcode(packet=>copies.push([...packet]));
    const bytes=new Uint8Array([7,8,9]);
    check(loopA.sendNetcode(bytes), 'Loopback accepts raw packet');bytes.fill(0);
    await pause(0);
    check(copies.length===2 && copies.every(copy=>copy.join(',')==='7,8,9') && jsonCount===0, 'Loopback copies sender and individual subscriber bytes apart from JSON');
    check(!loopA.sendNetcode(new Uint8Array(sdk.CHUNK_SIZE+1)), 'Loopback enforces the SDK packet bound');
    offA();offB();loopA.close();loopB.close();
    check(failures.length===0, 'No RTC/SDK errors: '+failures.join(';'));
    return {labels,channelMessages:counts,lobby,metrics,reconnect:{serial:host.connectionSerial,persistentSubscription:true,closedAllChannels:true},loopback:{isolatedCopies:true,separateBinaryDispatch:true}};
  } finally {
    for (const session of coreSessions) session.close();
    hostGame.dispose('transport-qa');guestGame.dispose('transport-qa');
  }
}

async function runSignalerRegression() {
  const {NostrRtcTransport,MinimalNostrSignalBus,NetworkModuleLoader,SIM_VERSION,RALLY_RTC_SIGNAL_PROTOCOL} = window.__netcodeTransportQA;
  const sdk = window.RallyNetcode;
  const sockets=[],publications=[],errors=[],options=[];
  const check=(value,message)=>{if(!value)throw Error(message);};
  const wait=async(test,label)=>{const end=Date.now()+5000;while(!test()){if(Date.now()>end)throw Error('Timed out: '+label);await new Promise(resolve=>setTimeout(resolve,10));}};
  class Relay extends EventTarget {
    constructor(url){super();this.url=url;this.readyState=0;sockets.push(this);queueMicrotask(()=>{if(this.readyState!==0)return;this.readyState=1;this.dispatchEvent(new Event('open'));});}
    message(frame){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(frame)}));}
    send(raw){
      const frame=JSON.parse(raw);
      if(frame[0]==='REQ'){this.sub=frame[1];queueMicrotask(()=>this.message(['EOSE',this.sub]));}
      if(frame[0]==='EVENT'){
        const event=frame[1];publications.push({url:this.url,event});
        queueMicrotask(()=>{
          const accepted=!this.url.includes('nos.lol');
          this.message(['OK',event.id,accepted,accepted?'':'mock relay rejected']);
          if(accepted)for(const socket of sockets){if(socket.url===this.url&&socket.readyState===1)socket.message(['EVENT',socket.sub,event]);}
        });
      }
    }
    close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}
  }
  const runtime={...sdk,createNostrSignaler: opts=>{
    options.push(opts);
    return sdk.createNostrSignaler({...opts,WebSocketImpl:Relay,timeoutMs:350,publishIntervalMs:15});
  }};
  window.RallyNetcode=runtime;
  const owner=role=>({role,roomCode:'1234',signalId:'pending-'+role,ready:0,trace(){},onError:error=>errors.push(String(error?.message||error)),onSignalingReady(){this.ready++;}});
  const a=owner('host'),b=owner('guest'),received=[];
  const host=new MinimalNostrSignalBus(a,packet=>received.push({side:'host',packet}));
  const guest=new MinimalNostrSignalBus(b,packet=>received.push({side:'guest',packet}));
  try {
    await Promise.all([host.open(),guest.open()]);
    check(a.ready===1&&b.ready===1&&a.signalId===host.signaler.id&&/^[a-f0-9]{64}$/.test(a.signalId), 'SDK owns public signaling identity: '+errors.join(';'));
    check(options.every(opts=>opts.room==='1234'&&opts.namespace.includes('rally-frontier')&&opts.namespace.includes('sim-'+SIM_VERSION)&&opts.signal instanceof AbortSignal), 'Application supplies room/version namespace and cancellation through public SDK options');
    check(guest.publish({type:'hello',to:null,role:'guest',simVersion:SIM_VERSION,serial:1}), 'Discovery queued');
    await wait(()=>received.some(item=>item.side==='host'&&item.packet.type==='hello'),'SDK signed discovery');
    const discover=publications.map(item=>JSON.parse(item.event.content)).find(content=>content.message.signalType==='hello');
    check(discover.to==='*'&&discover.message.type==='discover'&&discover.message.protocol===RALLY_RTC_SIGNAL_PROTOCOL,'Broadcast and game signaling translate to SDK public shape');
    check(host.publish({type:'version-mismatch',to:b.signalId,role:'host',simVersion:SIM_VERSION}), 'Presence queued');
    await wait(()=>received.some(item=>item.side==='guest'&&item.packet.type==='version-mismatch'),'SDK directed presence');
    const presence=publications.map(item=>JSON.parse(item.event.content)).find(content=>content.message.signalType==='version-mismatch');
    check(presence.to===b.signalId&&presence.message.type==='presence','Directed game mismatch uses presence');
    check(received.every(item=>item.packet.roomCode==='1234'&&item.packet.from===(item.side==='host'?b.signalId:a.signalId)), 'SDK envelope supplies recipient and signed sender');
    check(!host.publish({type:'RUNTIME_COMMIT',payload:{}}),'Nostr refuses gameplay messages');
    const id=a.signalId,connectionCount=sockets.length;
    host.suspend();await host.resume();
    check(a.signalId===id&&sockets.length===connectionCount&&a.ready===2,'Suspend/resume preserves SDK identity without creating duplicate sockets');
    let action=0;
    NetworkModuleLoader.pendingPeerAction=()=>action++;
    check(await NetworkModuleLoader.ensureReady(),'URL imported SDK marks loader ready');
    check(NetworkModuleLoader.networkLoadState==='ready'&&action===1&&!NetworkModuleLoader.pendingPeerAction,'Pending lobby action runs once');
    host.close();guest.close();
    check(sockets.every(socket=>socket.readyState===3),'Signaler close shuts down all relay sockets');
    check(errors.some(error=>error.includes('mock relay rejected')),'SDK fallback rejection reaches error callback');
    check(publications.some(item=>item.url.includes('damus')),'SDK obtains an accepting relay fallback');
    const rtcHost=new NostrRtcTransport('host','5678'),rtcGuest=new NostrRtcTransport('guest','5678');
    const rtcErrors=[];let binary=0;
    rtcHost.onError=rtcGuest.onError=error=>rtcErrors.push(String(error?.message||error));
    rtcGuest.subscribeNetcode(packet=>{if(packet[0]===91)binary++;});
    try {
      rtcHost.open();rtcGuest.open();
      await wait(()=>rtcHost.isOpen()&&rtcGuest.isOpen()&&rtcHost.isNetcodeOpen()&&rtcGuest.isNetcodeOpen(),'actual RTC over SDK Nostr signaling');
      check(rtcHost.remoteSignalId===rtcGuest.signalId&&rtcGuest.remoteSignalId===rtcHost.signalId,'Actual RTC selects SDK public sender IDs');
      check(rtcHost.sendNetcode(new Uint8Array([91])),'Nostr negotiated RTC accepts binary');
      await wait(()=>binary===1,'binary after signed SDP and ICE');
      check(rtcErrors.every(error=>error.includes('mock relay rejected')),'Actual Nostr RTC has no negotiation errors: '+rtcErrors.join(';'));
    } finally {rtcHost.close();rtcGuest.close();}
    const abortOwner=owner('host'),pendingBus=new MinimalNostrSignalBus(abortOwner,()=>{});
    const pendingOpen=pendingBus.open();pendingBus.close();
    check(await pendingOpen===false&&abortOwner.ready===0,'Closing pending SDK initialization never reports ready');
    check(sockets.every(socket=>socket.readyState===3),'Pending cancellation and actual Nostr RTC close all sockets');
    return {publicIdentity:true,discoveryType:discover.message.type,presenceType:presence.message.type,broadcastRecipient:discover.to,
      relays:sockets.length,publications:publications.length,negativeRelayErrors:errors.length,pendingAction:action,
      actualNostrRtc:{binaryDelivered:binary,selectedPublicIDs:true},cancelPending:true,closedRelays:true};
  } finally {host.close();guest.close();window.RallyNetcode=sdk;}
}

(async()=>{
  const browser = await chromium.launch({headless:true,channel:process.env.QA_BROWSER_CHANNEL||'msedge',
    args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try {
    const page=await browser.newPage();
    const pageErrors=[];
    page.on('pageerror',error=>pageErrors.push(error.message));
    await page.route('https://netcode-transport-qa.local/**',route=>route.fulfill({status:200,contentType:'text/html',body:html}));
    await page.goto('https://netcode-transport-qa.local/',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__netcodeTransportQA);

    const transport=await page.evaluate(runTransportRegression);
    const signaler=await page.evaluate(runSignalerRegression);
    assert.deepEqual(pageErrors,[]);
    console.log(JSON.stringify({transport,signaler,pageErrors},null,2));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
