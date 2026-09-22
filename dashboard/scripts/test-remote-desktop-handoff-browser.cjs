'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { WebSocketServer } = require('ws');
const { handoffHtml, createRemoteDesktopBroker } = require('../provisioner/remote-desktop/broker.cjs');
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function main() {
  let controlOrigin = '';
  let brokerOrigin = '';
  const control = http.createServer((request, response) => {
    if (request.url !== '/') { response.writeHead(404).end(); return; }
    const body = `<!doctype html><iframe id="outer" src="${brokerOrigin}/desktop/handoff"></iframe><script>
      window.messages=[];
      window.addEventListener('message',event=>{
        if(event.origin!=='${brokerOrigin}'||event.source!==outer.contentWindow)return;
        messages.push(event.data);
        if(event.data?.type==='hivra.remote-desktop.ready.v1')outer.contentWindow.postMessage({type:'hivra.remote-desktop.handoff.v2',sessionId:'${SESSION_ID}',exchangeCode:'${'e'.repeat(43)}',verifier:'${'v'.repeat(64)}',streamingMode:'hq'},'${brokerOrigin}');
      });
    </script>`;
    response.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  });
  controlOrigin = await listen(control);
  const broker = http.createServer((request, response) => {
    if (request.url === '/desktop/handoff') {
      const body = handoffHtml(controlOrigin);
      response.writeHead(200, {
        'content-type': 'text/html',
        'content-length': Buffer.byteLength(body),
        'content-security-policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; frame-ancestors ${controlOrigin}`,
      });
      response.end(body);
      return;
    }
    if (request.url === '/desktop/api/exchange' && request.method === 'POST') {
      request.resume();
      request.on('end', () => { response.writeHead(204); response.end(); });
      return;
    }
    if (request.url === `/desktop/sessions/${SESSION_ID}/`) {
      const body = `<!doctype html><video id="surface"></video><script>
        window.pixelValue=0;window.callbacks=[];window.emitFrame=true;
        window.selkiesTransport=new EventTarget();window.selkiesTransport.readyState=1;
        const video=document.getElementById('surface');
        Object.defineProperties(video,{videoWidth:{get:()=>1920},videoHeight:{get:()=>1080},readyState:{get:()=>4}});
        video.requestVideoFrameCallback=callback=>(callbacks.push(callback),callbacks.length);
        document.addEventListener('pointerdown',()=>{if(!emitFrame)return;pixelValue+=1;setTimeout(()=>{for(const callback of callbacks.splice(0))callback(performance.now())},20)});
      </script>`;
      response.writeHead(200, {
        'content-type': 'text/html',
        'content-length': Buffer.byteLength(body),
        'content-security-policy': `frame-ancestors 'self' ${controlOrigin}`,
      });
      response.end(body);
      return;
    }
    response.writeHead(404).end();
  });
  brokerOrigin = await listen(broker);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      HTMLCanvasElement.prototype.getContext = function getContext() {
        let source = null;
        return {
          drawImage(value) { source = value; },
          getImageData() {
            const pixel = source?.ownerDocument?.defaultView?.pixelValue ?? 0;
            const data = new Uint8ClampedArray(16 * 9 * 4);
            for (let index = 0; index < data.length; index += 4) {
              data[index] = pixel; data[index + 1] = pixel; data[index + 2] = pixel; data[index + 3] = 255;
            }
            return { data };
          },
        };
      };
    });
    await page.goto(controlOrigin);
    await page.waitForFunction(() => window.messages?.some(message => message.type === 'hivra.remote-desktop.connected.v1'));
    const handoff = page.frames().find(frame => frame.url() === `${brokerOrigin}/desktop/handoff`);
    const child = page.frames().find(frame => frame.url() === `${brokerOrigin}/desktop/sessions/${SESSION_ID}/`);
    assert.ok(handoff);
    assert.ok(child);
    assert.equal(await handoff.locator('#status').evaluate(element => getComputedStyle(element).display), 'none');

    await child.locator('video').click({ position: { x: 5, y: 5 } });
    await page.waitForFunction(() => window.messages?.some(message => message.outcome === 'changed'));
    const changed = await page.evaluate(() => window.messages.find(message => message.outcome === 'changed'));
    assert.equal(changed.metric, 'browser-input-to-changed-frame');
    assert.equal(changed.sequence, 1);
    assert.equal(changed.decodedFrames, 1);
    assert.equal(changed.durationMs >= 0 && changed.durationMs < 2000, true);

    await child.evaluate(() => { window.emitFrame = false; });
    await child.locator('video').click({ position: { x: 5, y: 5 } });
    await page.waitForFunction(() => window.messages?.some(message => message.outcome === 'timeout'), null, { timeout: 3000 });
    const timedOut = await page.evaluate(() => window.messages.find(message => message.outcome === 'timeout'));
    assert.deepEqual({ metric: timedOut.metric, sequence: timedOut.sequence, durationMs: timedOut.durationMs }, {
      metric: 'browser-input-to-changed-frame', sequence: 2, durationMs: 2000,
    });
    const countBeforeLateFrame = await page.evaluate(() => window.messages.filter(message => message.type === 'hivra.remote-desktop.telemetry.v1').length);
    await child.evaluate(() => { for (const callback of window.callbacks.splice(0)) callback(performance.now()); });
    await page.waitForTimeout(50);
    const countAfterLateFrame = await page.evaluate(() => window.messages.filter(message => message.type === 'hivra.remote-desktop.telemetry.v1').length);
    assert.equal(countAfterLateFrame, countBeforeLateFrame);
    await testSessionIsolation(browser);
    process.stdout.write('PASS remote desktop browser handoff: nested click, changed frame, timeout and no late duplicate\n');
  } finally {
    await browser.close();
    await Promise.all([
      new Promise(resolve => control.close(resolve)),
      new Promise(resolve => broker.close(resolve)),
    ]);
  }
}

async function testSessionIsolation(browser) {
  // Ephemeral local TLS material lives only in a private temporary directory
  // removed immediately: no user profile, persisted fixture keys, remote login,
  // or external network request is involved. openssl cannot write to
  // /dev/stdout when Node's stdio is a Unix socket (Linux), so use files.
  const tlsDirectory = mkdtempSync(path.join(tmpdir(), 'hivra-handoff-tls-'));
  let tls;
  try {
    const keyPath = path.join(tlsDirectory, 'key.pem'), certPath = path.join(tlsDirectory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
    tls = { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
  } finally {
    rmSync(tlsDirectory, { recursive: true, force: true });
  }
  const ids = [SESSION_ID, '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];
  const grants = ids.map((id, index) => ({ id, code: String.fromCharCode(101 + index).repeat(43),
    token: `hrs1_${String.fromCharCode(116 + index).repeat(43)}`, active: false, revoked: false }));
  let controlOrigin = '', publicOrigin = '';
  let broker;
  const socketServer = new WebSocketServer({ noServer: true });
  const upstream = http.createServer((req, res) => {
    const body = `<!doctype html><video id="surface"></video><button id="input">Input</button><button id="kill">Kill fixture</button><output id="count">0</output><script>
      const workerMode=location.pathname.includes('${ids[1]}');
      // Mirrors the verified pinned worker facade's independent event-listener
      // dispatch. The underlying browser sockets/workers and cookies are real.
      class WorkerSocket extends EventTarget {
        constructor(url){super();this.readyState=0;
          const source="let ws;onmessage=e=>{if(e.data.url){ws=new WebSocket(e.data.url);for(const type of ['open','close','error','message'])ws.addEventListener(type,event=>postMessage({type,data:event.data}));}else if(e.data.close)ws.close();else ws.send(e.data.data)}";
          const blob=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));this.worker=new Worker(blob);URL.revokeObjectURL(blob);
          this.worker.onmessage=e=>{const d=e.data;if(d.type==='open')this.readyState=1;if(d.type==='close')this.readyState=3;
            const event=new MessageEvent(d.type,{data:d.data});if(this['on'+d.type])this['on'+d.type](event);this.dispatchEvent(event);};
          this.worker.postMessage({url});}
        send(data){this.worker.postMessage({data});}close(){this.worker.postMessage({close:true});}
      }
      const url=new URL('api/websockets',location.href);url.protocol='wss:';
      const transport=window.selkiesTransport=workerMode?new WorkerSocket(url.href):new WebSocket(url.href);
      transport.onclose=()=>setTimeout(()=>location.reload(),50);
      transport.onmessage=e=>{if(e.data.startsWith('KILL ')){transport.onclose=()=>{};transport.close();return;}document.getElementById('count').textContent=String(Number(document.getElementById('count').textContent)+1);};
      input.onclick=()=>transport.send('input');kill.onclick=()=>transport.send('kill');
      const video=document.getElementById('surface');Object.defineProperties(video,{videoWidth:{get:()=>1920},videoHeight:{get:()=>1080},readyState:{get:()=>transport.readyState===1?4:0}});
    </script>`;
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) });res.end(body);
  });
  upstream.on('upgrade', (req, socket, head) => socketServer.handleUpgrade(req, socket, head, peer => {
    peer.on('message', bytes => peer.send(String(bytes) === 'kill' ? 'KILL a new primary client connected connection killed' : 'input-ok'));
  }));
  const control = https.createServer(tls, (req, res) => {
    const grant = grants[Number(req.url.slice(1))];
    if (!grant) { res.writeHead(404).end(); return; }
    const body = `<!doctype html><iframe id="outer" src="${publicOrigin}/desktop/handoff"></iframe><script>
      window.messages=[];window.addEventListener('message',e=>{if(e.origin!=='${publicOrigin}'||e.source!==outer.contentWindow)return;messages.push(e.data);if(e.data.type==='hivra.remote-desktop.ready.v1')outer.contentWindow.postMessage({type:'hivra.remote-desktop.handoff.v2',sessionId:'${grant.id}',exchangeCode:'${grant.code}',verifier:'${'v'.repeat(64)}',streamingMode:'hq'},'${publicOrigin}');});
    </script>`;
    res.writeHead(200, { 'content-type': 'text/html' });res.end(body);
  });
  const front = https.createServer(tls, (req, res) => { void broker.handleHttp(req, res); });
  front.on('upgrade', (req, socket, head) => { void broker.handleUpgrade(req, socket, head); });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const requests = [];
  context.on('request', request => requests.push(request.url()));
  try {
    await listen(upstream);controlOrigin=(await listen(control)).replace('http:', 'https:');publicOrigin=(await listen(front)).replace('http:', 'https:');
    broker=createRemoteDesktopBroker({ controlOrigin, publicOrigin, computerKind:'hivra-agent', computerId:'11111111-1111-4111-8111-111111111111',
      transport:'selkies-websocket', upstreamPort:upstream.address().port, basicAuthorization:'Basic '+Buffer.from('fixture:fixture-password').toString('base64'),
      verifyInputIsolation:async()=>true,recheckMs:20,fetchFn:async(url,init)=>{
        const body=JSON.parse(init.body);const grant=url.endsWith('/exchange')?grants.find(g=>g.code===body.exchangeCode):grants.find(g=>init.headers.authorization===`Bearer ${g.token}`);
        if(!grant)return new Response('{}',{status:401});
        const identity={sessionId:grant.id,computerKind:'hivra-agent',computerId:'11111111-1111-4111-8111-111111111111',capabilityGeneration:'33333333-3333-4333-8333-333333333333',transport:'selkies-websocket',inputRole:'controller'};
        if(url.endsWith('/exchange'))return new Response(JSON.stringify({success:true,data:{...identity,sessionToken:grant.token,inputReady:false,audience:'hivra-computer:hivra-agent:11111111-1111-4111-8111-111111111111:desktop',brokerOrigin:publicOrigin,expiresAt:new Date(Date.now()+240000).toISOString()}}));
        if(url.endsWith('/authorize'))return new Response(JSON.stringify({authorized:!grant.revoked,data:{...identity,inputReady:body.wantsInput}}),{status:grant.revoked?401:200});
        if(url.endsWith('/input-transition')){grant.active=body.action==='agent-input-suspended';return new Response('{"confirmed":true}');}
        if(url.endsWith('/terminate')){grant.revoked=true;return new Response(JSON.stringify({revoked:true,inputState:grant.active?'release-pending':'released'}));}
        throw Error('unexpected fixture control request');
      }});
    const pages=[];
    const open=async index=>{
      const page=await context.newPage();pages.push(page);await page.goto(`${controlOrigin}/${index}`);
      await page.waitForFunction(()=>window.messages.some(m=>m.type==='hivra.remote-desktop.connected.v1'));
      const child=page.frames().find(f=>f.url()===`${publicOrigin}/desktop/sessions/${ids[index]}/`);assert.ok(child);return{page,child};
    };
    const a=await open(0);await a.child.locator('#input').click();await a.child.locator('#count').filter({hasText:'1'}).waitFor();
    grants[0].revoked=true;
    await a.page.waitForFunction(()=>window.messages.some(m=>m.type==='hivra.remote-desktop.disconnected.v1'));
    assert.equal(a.page.frames().some(f=>f.url().includes(`/sessions/${ids[0]}/`)),false);
    const b=await open(1);
    const cookiesA=await context.cookies(`${publicOrigin}/desktop/sessions/${ids[0]}/`);
    const cookiesB=await context.cookies(`${publicOrigin}/desktop/sessions/${ids[1]}/`);
    assert.equal(cookiesA.some(c=>c.name.endsWith(ids[1])),false);assert.equal(cookiesB.some(c=>c.name.endsWith(ids[0])),false);
    const oldReload=await a.page.goto(`${publicOrigin}/desktop/sessions/${ids[0]}/`);assert.equal(oldReload.status(),401);
    const oldSocket=await a.page.evaluate(url=>new Promise(resolve=>{const socket=new WebSocket(url);socket.onopen=()=>{socket.close();resolve('opened')};socket.onerror=()=>resolve('rejected')}),`${publicOrigin.replace('https:', 'wss:')}/desktop/sessions/${ids[0]}/api/websockets`);
    assert.equal(oldSocket,'rejected');await b.child.locator('#input').click();await b.child.locator('#count').filter({hasText:'1'}).waitFor();
    await b.child.locator('#kill').click();await b.page.waitForFunction(()=>window.messages.filter(m=>m.type==='hivra.remote-desktop.disconnected.v1').length===1);
    assert.equal(b.page.frames().some(f=>f.url().includes(`/sessions/${ids[1]}/`)),false);
    const c=await open(2);await c.child.locator('#kill').click();await c.page.waitForFunction(()=>window.messages.filter(m=>m.type==='hivra.remote-desktop.disconnected.v1').length===1);
    for(const url of requests){assert.equal(grants.some(g=>url.includes(g.code)||url.includes(g.token)),false);assert.equal(url.includes('v'.repeat(64)),false);}
    process.stdout.write('PASS browser session isolation: shared cookie jar, revoked A/new B, B input, native+worker KILL and terminal teardown\n');
  } finally {
    await context.close();if(broker)await broker.close();for(const peer of socketServer.clients)peer.terminate();socketServer.close();
    await Promise.all([front,control,upstream].map(server=>new Promise(resolve=>server.close(resolve))));
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
