const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const runRegression = async () => {
      const {NostrRtcTransport,SIM_VERSION,RALLY_RTC_SIGNAL_PROTOCOL} = window.__rtcQA;
      const wait = async (test, label) => {
        const deadline = Date.now()+12000;
        while (!test()) {
          if (Date.now()>deadline) throw Error('Timed out: '+label);
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      };
      const host = new NostrRtcTransport('host','rtc-qa',{signalMode:'local'});
      const guest = new NostrRtcTransport('guest','rtc-qa',{signalMode:'local'});
      const failures = [];
      host.onError = guest.onError = e => failures.push(String(e?.message||e));
      const envelope = (sender, m) => ({...m,from:sender.signalId,roomCode:sender.roomCode,
        protocol:RALLY_RTC_SIGNAL_PROTOCOL});
      // Deliberately make local serial unrelated to the host's offer serial.
      guest.connectionSerial = 40;
      host.open();
      let delayed;
      const publish = host.signaler.publish.bind(host.signaler);
      host.signaler.publish = m => {
        if (m.type==='offer'&&m.serial===1) {delayed=envelope(host,m);return true;}
        return publish(m);
      };
      guest.open();
      await wait(() => host.isOpen()&&guest.isOpen(), 'timeout/retry connection');
      const initial = {host:host.connectionSerial,guest:guest.connectionSerial};
      const checkUnchanged = async m => {
        const pc=guest.pc, dc=guest.dc, attempt=guest.connAttemptTimer, hello=guest.helloTimer;
        const serial=guest.connectionSerial;
        await guest.handleSignal(m);
        if (guest.pc!==pc||guest.dc!==dc||guest.connAttemptTimer!==attempt||
            guest.helloTimer!==hello||guest.connectionSerial!==serial||!guest.isOpen()) {
          throw Error('Rejected offer changed live connection/timers');
        }
      };
      await checkUnchanged(delayed);
      await checkUnchanged({...delayed,serial:2});
      for (const serial of [0,-1,1.5,'bad',null]) await checkUnchanged({...delayed,serial});
      await checkUnchanged({...delayed,from:'unselected-host',serial:999});
      let delivered=0;
      guest.onMessage=m=>{if(m.type==='qa')delivered++;};
      host.send({type:'qa'});
      await wait(()=>delivered===1,'data after delayed offer');
      host.forceReconnect('qa-reconnect');guest.forceReconnect('qa-reconnect');
      await wait(()=>host.isOpen()&&guest.isOpen(),'same-host reconnect');
      const reconnect={host:host.connectionSerial,guest:guest.connectionSerial};
      await checkUnchanged(delayed);
      guest.rebuildRecoveryGuest('qa-same-host-reset');
      const resetHello=guest.helloTimer;
      await guest.handleSignal(delayed);
      if(guest.pc||guest.helloTimer!==resetHello)throw Error('Reset forgot accepted host serial');
      host.prepareRecoveryHost('qa-same-host-reset');
      await wait(()=>host.isOpen()&&guest.isOpen(),'same host after recovery reset');
      const recovery={host:host.connectionSerial,guest:guest.connectionSerial};
      // A recovery reset allows selecting a refreshed host identity with serial 1.
      host.close();guest.rebuildRecoveryGuest('qa-new-host');
      const next = new NostrRtcTransport('host','rtc-qa',{signalMode:'local'});
      next.onError=e=>failures.push(String(e?.message||e));next.open();
      await wait(()=>next.isOpen()&&guest.isOpen(),'new host identity serial 1');
      const replacement={host:next.connectionSerial,guest:guest.connectionSerial,
        selected:guest.remoteSignalId===next.signalId};
      next.close();guest.close();
      if(initial.host!==2||initial.guest!==41||reconnect.host!==3||reconnect.guest!==42||
          recovery.host!==4||recovery.guest!==43||replacement.host!==1||
          replacement.guest!==44||!replacement.selected||failures.length)throw Error('Unexpected RTC result');
      return {initial,reconnect,recovery,replacement,failures};
};

// NODE_PATH must include Playwright. QA_BROWSER_CHANNEL optionally selects Edge/Chrome.
// Uses production transport with real browser RTCPeerConnection/DataChannel.
// If browser launch is restricted, --serve exposes /test for an existing browser.
const file = process.env.QA_HTML_PATH || path.resolve(__dirname, '..', 'index.html');
const source = fs.readFileSync(file, 'utf8');
const end = source.lastIndexOf('})();');
assert.ok(end >= 0);
const html = source.slice(0, end) +
  'window.__rtcQA={NostrRtcTransport,SIM_VERSION,RALLY_RTC_SIGNAL_PROTOCOL};' + source.slice(end);
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const harness = `<button id="rtcRegressionRun">RTC regression run</button><pre id="rtcRegressionResult"></pre><script>document.getElementById('rtcRegressionRun').onclick=async()=>{const out=document.getElementById('rtcRegressionResult');out.textContent='RUNNING';try{out.textContent=JSON.stringify(await (${runRegression.toString()})(),null,2)}catch(e){out.textContent='FAIL '+e.stack}};</script>`;
  res.end(req.url === '/test' ? html+harness : source);
});

if (process.argv.includes('--serve')) {
  server.listen(Number(process.env.QA_PORT)||8771,'127.0.0.1',()=>console.log('Open /test and click RTC regression run'));
} else (async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true,
    ...(process.env.QA_BROWSER_CHANNEL ? {channel:process.env.QA_BROWSER_CHANNEL} : {})});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/test`);
    await page.waitForFunction(() => window.__rtcQA);
    const result = await page.evaluate(runRegression);
    assert.deepEqual(result.initial,{host:2,guest:41});
    assert.deepEqual(result.reconnect,{host:3,guest:42});
    assert.deepEqual(result.recovery,{host:4,guest:43});
    assert.deepEqual(result.replacement,{host:1,guest:44,selected:true});
    assert.deepEqual(result.failures,[]);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify(result,null,2));
  } finally {await browser.close();server.close();}
})().catch(error => {console.error(error);server.close();process.exitCode=1;});
