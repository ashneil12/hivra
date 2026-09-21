'use strict';

// Guest-side Selkies session broker. Hivra session bearers remain in this
// dedicated process and are never returned to the browser or forwarded to the
// upstream desktop. The public guest router mounts this service at /desktop.

const http = require('node:http');
const { createHash, randomBytes } = require('node:crypto');
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const COOKIE_NAME = '__Secure-hivra-rd';
const COOKIE_RE = /^v1\.([A-Za-z0-9_-]{43})$/;
const SESSION_TOKEN_RE = /^hrs1_[A-Za-z0-9_-]{43}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXCHANGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CONTROL_BYPASS_SECRET_RE = /^[A-Za-z0-9_-]{16,256}$/;
const SAFE_REQUEST_HEADERS = ['accept', 'accept-language', 'accept-encoding', 'content-type', 'content-length', 'range'];
const SAFE_RESPONSE_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-disposition', 'content-range', 'accept-ranges'];

function canonicalOrigin(value, label) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.origin !== value || parsed.username || parsed.password) {
    throw new Error(`${label}_invalid`);
  }
  return parsed;
}

function fixedTarget(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || /[\\\s\x00-\x1f\x7f]/.test(raw)) return null;
  const target = new URL(raw, 'http://guest.invalid');
  if (target.hash || raw.split('?')[0] !== target.pathname) return null;
  for (const name of target.searchParams.keys()) {
    if (/token|code|verifier|secret|credential|session|auth/i.test(name)) return null;
  }
  return target;
}

function copyHeaders(source, allowlist) {
  const nominated = new Set(String(source.connection || '').toLowerCase().split(',').map(value => value.trim()));
  const result = {};
  for (const name of allowlist) {
    if (!nominated.has(name) && typeof source[name] === 'string') result[name] = source[name];
  }
  return result;
}

function cookieValue(req, sessionId) {
  const expected = `${COOKIE_NAME}-${sessionId}`;
  const values = [];
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === expected) values.push(part.slice(index + 1).trim());
  }
  return values.length === 1 ? values[0] : '';
}

function mediaTarget(target) {
  const match = target.pathname.match(/^\/desktop\/sessions\/([^/]+)(\/.*)$/);
  if (!match || !CANONICAL_UUID_RE.test(match[1])) return null;
  return { sessionId: match[1], upstreamPath: match[2] + target.search };
}

function safeResponseHeaders(source, controlOrigin) {
  return {
    ...copyHeaders(source, SAFE_RESPONSE_HEADERS),
    'cache-control': 'private, no-store',
    // The authenticated handoff document keeps Selkies in a same-origin child
    // frame so it can measure decoded frame changes without exposing the
    // guest-held bearer to Hivra. The exact Hivra origin remains the only
    // cross-origin framing authority.
    'content-security-policy': `frame-ancestors 'self' ${controlOrigin}`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
}

function errorResponse(res, status, message = 'Remote desktop unavailable.') {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'private, no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(message);
}

function jsonResponse(res, status, body) {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(encoded),
    'cache-control': 'private, no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(encoded);
}

function boundedJson(req, maxBytes = 2048) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function validGrant(data, expected) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const keys = new Set([
    'sessionToken', 'sessionId', 'computerKind', 'computerId', 'capabilityGeneration',
    'transport', 'inputRole', 'inputReady', 'audience', 'brokerOrigin', 'expiresAt',
  ]);
  if (Object.keys(data).some(key => !keys.delete(key)) || keys.size !== 0) return false;
  const expiresAt = Date.parse(data.expiresAt);
  return SESSION_TOKEN_RE.test(data.sessionToken)
    && UUID_RE.test(data.sessionId)
    && UUID_RE.test(data.capabilityGeneration)
    && data.computerKind === expected.computerKind
    && data.computerId === expected.computerId
    && data.transport === expected.transport
    && data.inputRole === 'controller'
    && data.inputReady === false
    && data.audience === `hivra-computer:${expected.computerKind}:${expected.computerId}:desktop`
    && data.brokerOrigin === expected.publicOrigin
    && Number.isFinite(expiresAt)
    && expiresAt > Date.now()
    && expiresAt <= Date.now() + 5 * 60_000;
}

function handoffHtml(controlOrigin) {
  const origin = JSON.stringify(controlOrigin);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening desktop</title><style>html,body,#desktop{width:100%;height:100%;margin:0;border:0;background:#090909}body{overflow:hidden;color:#bbb;font:14px system-ui,sans-serif}#status{position:absolute;inset:0;display:grid;place-items:center;margin:0}#status[hidden],#desktop[hidden]{display:none}</style></head><body><p id="status">Connecting securely…</p><iframe id="desktop" title="Remote desktop stream" hidden></iframe><script>
  'use strict';
  const CONTROL_ORIGIN=${origin};
  const desktop=document.getElementById('desktop');
  const status=document.getElementById('status');
  let used=false;
  let sessionId=null;
  let ended=false;
  let loaded=false;
  let transport=null;
  let bindingTimer=null;
  let bindingStartedAt=0;
  let sequence=0;
  let pending=false;
  let boundDocument=null;
  let resizeTimer=null;
  let resizeMonitoring=false;
  let dprQuery=null;
  let streamingMode='hq';
  let appliedProfile=null;
  let appliedDimensions=null;
  const streamProfiles={
    hq:{videoBitRate:25000,videoFramerate:60,width:1920,height:1080},
    qhd:{videoBitRate:40000,videoFramerate:60,width:2560,height:1440},
    uhd:{videoBitRate:65000,videoFramerate:60,width:3840,height:2160},
    performance:{videoBitRate:12000,videoFramerate:60,width:1280,height:720}
  };
  const post=(message)=>window.parent.postMessage({...message,...(sessionId?{sessionId}:{})},CONTROL_ORIGIN);
  const endStream=(reason)=>{
    if(ended||!sessionId)return;
    ended=true;
    if(bindingTimer!==null)clearTimeout(bindingTimer);
    bindingTimer=null;
    stopResizeMonitoring();
    if(transport){transport.removeEventListener('close',onTransportClose);transport.removeEventListener('error',onTransportError);}
    // Removing the browsing context stops both the native and worker reconnect
    // paths, including KILL's replacement of the native .onclose callback.
    desktop.remove();
    status.hidden=false;
    status.textContent='Desktop disconnected. Reconnect from Hivra when ready.';
    post({type:'hivra.remote-desktop.disconnected.v1',reason});
  };
  const onTransportClose=()=>endStream('transport-closed');
  const onTransportError=()=>endStream('transport-error');
  const forwardResize=()=>{
    resizeTimer=null;
    try{
      const child=desktop.contentWindow;
      if(!child||typeof child.dispatchEvent!=='function'||typeof child.Event!=='function')return;
      child.dispatchEvent(new child.Event('resize'));
      if(child.webrtcInput&&typeof child.webrtcInput.resize==='function')child.webrtcInput.resize();
      applyStreamingMode();
    }catch{}
  };
  const scheduleResize=()=>{
    if(resizeTimer!==null)clearTimeout(resizeTimer);
    resizeTimer=setTimeout(forwardResize,100);
  };
  const applyStreamingMode=()=>{
    if(ended||!loaded)return false;
    try{
      const child=desktop.contentWindow;
      const profile=streamProfiles[streamingMode];
      if(!child||!profile)return false;
      // Modern pinned Selkies exposes input and a same-origin message API,
      // not the legacy Vue app. Wait for its listener and open transport.
      if(child.webrtcInput&&child.selkiesTransport&&child.selkiesTransport.readyState===1){
        if(appliedProfile!==streamingMode){
          child.postMessage({type:'settings',settings:{video_bitrate:profile.videoBitRate,framerate:profile.videoFramerate}},window.location.origin);
          appliedProfile=streamingMode;
        }
        const aspect=desktop.clientWidth/desktop.clientHeight;
        if(!Number.isFinite(aspect)||aspect<=0)return false;
        const boundedAspect=Math.max(0.25,Math.min(4,aspect));
        let width=Math.sqrt(profile.width*profile.height*boundedAspect);
        let height=width/boundedAspect;
        const limit=Math.min(1,4080/width,4080/height);
        width=Math.max(320,Math.floor(width*limit/2)*2);
        height=Math.max(240,Math.floor(height*limit/2)*2);
        const dimensions=width+'x'+height;
        if(appliedDimensions!==dimensions){
          // Explicit dimensions bypass retained manual settings and CSS
          // transforms, which otherwise make different presets look identical.
          child.postMessage({type:'setManualResolution',width,height},window.location.origin);
          appliedDimensions=dimensions;
        }
        return true;
      }
      const app=child.app;
      if(!app||typeof app!=='object')return false;
      if(app.videoFramerate!==profile.videoFramerate)app.videoFramerate=profile.videoFramerate;
      if(app.videoBitRate!==profile.videoBitRate)app.videoBitRate=profile.videoBitRate;
      return true;
    }catch{return false;}
  };
  const resizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(scheduleResize):null;
  const visualViewport=window.visualViewport;
  const removeDprListener=()=>{
    if(!dprQuery)return;
    if(typeof dprQuery.removeEventListener==='function')dprQuery.removeEventListener('change',onDprChange);
    else if(typeof dprQuery.removeListener==='function')dprQuery.removeListener(onDprChange);
    dprQuery=null;
  };
  const watchDpr=()=>{
    removeDprListener();
    if(typeof window.matchMedia!=='function')return;
    dprQuery=window.matchMedia('(resolution: '+(window.devicePixelRatio||1)+'dppx)');
    if(typeof dprQuery.addEventListener==='function')dprQuery.addEventListener('change',onDprChange,{once:true});
    else if(typeof dprQuery.addListener==='function')dprQuery.addListener(onDprChange);
  };
  function onDprChange(){scheduleResize();watchDpr();}
  const startResizeMonitoring=()=>{
    if(resizeMonitoring)return;
    resizeMonitoring=true;
    if(resizeObserver)resizeObserver.observe(desktop);
    window.addEventListener('resize',scheduleResize);
    if(visualViewport&&typeof visualViewport.addEventListener==='function')visualViewport.addEventListener('resize',scheduleResize);
    watchDpr();
    scheduleResize();
  };
  const stopResizeMonitoring=()=>{
    if(!resizeMonitoring)return;
    resizeMonitoring=false;
    if(resizeObserver)resizeObserver.disconnect();
    window.removeEventListener('resize',scheduleResize);
    if(visualViewport&&typeof visualViewport.removeEventListener==='function')visualViewport.removeEventListener('resize',scheduleResize);
    removeDprListener();
    if(resizeTimer!==null){clearTimeout(resizeTimer);resizeTimer=null;}
  };
  startResizeMonitoring();
  const signature=(video)=>{
    if(!video.videoWidth||!video.videoHeight)return null;
    try{
      const canvas=document.createElement('canvas');
      canvas.width=16;canvas.height=9;
      const context=canvas.getContext('2d',{willReadFrequently:true});
      if(!context)return null;
      context.drawImage(video,0,0,canvas.width,canvas.height);
      const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
      let hash=2166136261;
      for(let index=0;index<pixels.length;index+=4){
        hash^=pixels[index];hash=Math.imul(hash,16777619);
        hash^=pixels[index+1];hash=Math.imul(hash,16777619);
        hash^=pixels[index+2];hash=Math.imul(hash,16777619);
      }
      return hash>>>0;
    }catch{return null;}
  };
  const measure=(video,inputAt)=>{
    if(pending||typeof video.requestVideoFrameCallback!=='function')return;
    const baseline=signature(video);
    if(baseline===null)return;
    pending=true;
    let frames=0;
    let completed=false;
    const sampleSequence=++sequence;
    const finish=(outcome,durationMs)=>{
      if(completed)return;
      completed=true;
      pending=false;
      clearTimeout(deadline);
      if(ended)return;
      post({type:'hivra.remote-desktop.telemetry.v1',metric:'browser-input-to-changed-frame',outcome,sequence:sampleSequence,durationMs,decodedFrames:frames});
    };
    const deadline=setTimeout(()=>finish('timeout',2000),2000);
    const inspect=()=>{
      if(completed)return;
      frames+=1;
      const changed=signature(video);
      const duration=Math.max(0,performance.now()-inputAt);
      if(duration>=2000){finish('timeout',2000);return;}
      if(changed!==null&&changed!==baseline){
        finish('changed',Math.round(duration*10)/10);
        return;
      }
      if(frames<180)video.requestVideoFrameCallback(inspect);
    };
    video.requestVideoFrameCallback(inspect);
  };
  const bindTelemetry=()=>{
    bindingTimer=null;
    if(ended||!sessionId)return;
    let document;
    try{document=desktop.contentDocument;}catch{return;}
    if(!document||document===boundDocument)return;
    const candidate=desktop.contentWindow&&desktop.contentWindow.selkiesTransport;
    if(!transport&&candidate&&typeof candidate.addEventListener==='function'&&typeof candidate.removeEventListener==='function'){
      transport=candidate;
      transport.addEventListener('close',onTransportClose);
      transport.addEventListener('error',onTransportError);
    }
    if(transport&&transport.readyState>=2){endStream('transport-closed');return;}
    const video=document.querySelector('video');
    // Pinned modern Selkies paints WebCodecs frames into these stream sinks,
    // not the hidden compatibility video. Its fps starts/reset at zero and
    // only becomes positive after decoded/painted frame accounting. A static
    // canvas or an open socket alone is not evidence of an opened desktop.
    const canvas=document.querySelector('#videoCanvas');
    const fps=desktop.contentWindow&&desktop.contentWindow.fps;
    const canvasReady=canvas&&canvas.tagName==='CANVAS'&&canvas.width>0&&canvas.height>0
      &&typeof fps==='number'&&Number.isFinite(fps)&&fps>0;
    const videoReady=video&&video.readyState>=2;
    if(!transport||transport.readyState!==1||(!videoReady&&!canvasReady)){
      if(performance.now()-bindingStartedAt>=30000){endStream('stream-unavailable');return;}
      bindingTimer=setTimeout(bindTelemetry,250);return;
    }
    applyStreamingMode();
    boundDocument=document;
    const onInput=(event)=>{
      if(!event.isTrusted)return;
      // Canvas clients have no requestVideoFrameCallback. Do not invent
      // decoded-frame timing from RAF polling or from a static screenshot.
      if(videoReady)measure(video,performance.now());
    };
    document.addEventListener('pointerdown',onInput,true);
    document.addEventListener('keydown',onInput,true);
    post({type:'hivra.remote-desktop.connected.v1'});
  };
  desktop.addEventListener('load',()=>{
    if(!sessionId||ended)return;
    if(loaded){endStream('document-reloaded');return;}
    loaded=true;bindingStartedAt=performance.now();boundDocument=null;
    // Render the guest cursor shape locally, including hand/text/resize and
    // hidden cursors. Browser-cursor mode disables the separate cursor canvas;
    // the Omarchy capture policy independently prevents a baked video cursor.
    try{desktop.contentWindow.postMessage({type:'setUseBrowserCursors',value:true},'*');}catch{}
    applyStreamingMode();
    scheduleResize();bindingTimer=setTimeout(bindTelemetry,0);
  });
  window.addEventListener('pagehide',()=>{stopResizeMonitoring();endStream('document-closed');});
  window.addEventListener('message',async event=>{
    if(event.origin!==CONTROL_ORIGIN||event.source!==window.parent)return;
    const data=event.data;
    if(data&&typeof data==='object'&&!Array.isArray(data)&&data.type==='hivra.remote-desktop.viewport.v1'&&Object.keys(data).length===1){scheduleResize();return;}
    if(data&&typeof data==='object'&&!Array.isArray(data)&&data.type==='hivra.remote-desktop.streaming-mode.v1'
      &&Object.keys(data).length===2&&Object.prototype.hasOwnProperty.call(streamProfiles,data.mode)){
      streamingMode=data.mode;applyStreamingMode();return;
    }
    if(used)return;
    if(!data||Array.isArray(data)||data.type!=='hivra.remote-desktop.handoff.v2'||Object.keys(data).length!==5
      ||typeof data.sessionId!=='string'||typeof data.exchangeCode!=='string'||typeof data.verifier!=='string'
      ||!Object.prototype.hasOwnProperty.call(streamProfiles,data.streamingMode)
      ||!${CANONICAL_UUID_RE}.test(data.sessionId)||!${EXCHANGE_RE}.test(data.exchangeCode)||!${VERIFIER_RE}.test(data.verifier))return;
    used=true;
    sessionId=data.sessionId;
    streamingMode=data.streamingMode;
    const fail=(reason)=>{
      if(ended)return;
      status.textContent='Desktop connection failed.';
      post({type:'hivra.remote-desktop.failed.v1',reason});
    };
    try{
      let response=null;
      for(let attempt=0;attempt<3;attempt+=1){
        try{
          response=await fetch('./api/exchange',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId,exchangeCode:data.exchangeCode,verifier:data.verifier})});
        }catch(error){
          if(attempt===2)throw error;
        }
        if(ended)return;
        if(response&&response.status===204)break;
        if(response&&response.status<500){fail('handoff-rejected');return;}
        if(attempt<2)await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
      }
      if(ended)return;
      if(!response||response.status!==204){fail('control-unreachable');return;}
      status.hidden=true;
      desktop.hidden=false;
      desktop.src='./sessions/'+sessionId+'/';
    }catch{fail('control-unreachable');}
  });
  post({type:'hivra.remote-desktop.ready.v1'});
  </script></body></html>`;
}

function createRemoteDesktopBroker(options) {
  const control = canonicalOrigin(options.controlOrigin, 'control_origin');
  const publicUrl = canonicalOrigin(options.publicOrigin, 'public_origin');
  const controlBypassSecret = options.controlBypassSecret === undefined ? '' : options.controlBypassSecret;
  if (!['hermes-instance', 'hivra-agent'].includes(options.computerKind)
    || !UUID_RE.test(options.computerId)
    || options.transport !== 'selkies-websocket'
    || !Number.isInteger(options.upstreamPort) || options.upstreamPort < 1 || options.upstreamPort > 65535
    || typeof options.basicAuthorization !== 'string' || !/^Basic [A-Za-z0-9+/=]{16,512}$/.test(options.basicAuthorization)
    || typeof controlBypassSecret !== 'string'
    // Legacy callers may still pass this flag; cursor shapes are now preserved.
    || (options.capturedCursor !== undefined && typeof options.capturedCursor !== 'boolean')
    || (options.nativeBrowserCursor !== undefined && typeof options.nativeBrowserCursor !== 'boolean')
    || (controlBypassSecret !== '' && !CONTROL_BYPASS_SECRET_RE.test(controlBypassSecret))
    || typeof options.verifyInputIsolation !== 'function') {
    throw new Error('remote_desktop_broker_options_invalid');
  }
  const fetchFn = options.fetchFn || fetch;
  const now = options.now || (() => Date.now());
  const recheckMs = options.recheckMs || 1000;
  const disconnectGraceMs = options.disconnectGraceMs || 10000;
  const renewalLeadMs = options.renewalLeadMs || 60000;
  const renewalRetryMs = options.renewalRetryMs || 15000;
  const renewalDiagnostic = options.renewalDiagnostic || (record => console.info(JSON.stringify(record)));
  function diagnostic(event, failureClass, status, transportKind) {
    const record = { event };
    if (failureClass) record.failureClass = failureClass;
    if (Number.isInteger(status) && status >= 100 && status <= 599) record.httpStatus = status;
    if (transportKind) record.transportKind = transportKind;
    try { renewalDiagnostic(record); } catch { /* Diagnostics never change lease authority. */ }
  }
  // A short control-plane hiccup must not look like a revoked lease. The
  // broker rechecks authorization every second; keep the last explicit grant
  // alive for a bounded window while the control request recovers.
  const authorizationGraceMs = options.authorizationGraceMs || 30000;
  const statePath = options.statePath || null;
  const upstreamOrigin = `http://127.0.0.1:${options.upstreamPort}`;
  const sessions = new Map();
  const connections = new Set();
  let closed = false;
  let tickRunning = false;

  function persist() {
    if (!statePath) return;
    const directory = path.dirname(statePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const records = [...sessions.values()].map(session => ({
      cookieId: session.cookieId,
      sessionToken: session.sessionToken,
      sessionId: session.sessionId,
      capabilityGeneration: session.capabilityGeneration,
      expiresAt: session.expiresAt,
      inputRole: session.inputRole,
      lastDisconnectedAt: session.lastDisconnectedAt,
    }));
    const temporary = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, sessions: records }), { mode: 0o600 });
    renameSync(temporary, statePath);
  }

  function restore() {
    if (!statePath) return;
    let parsed;
    try { parsed = JSON.parse(readFileSync(statePath, 'utf8')); } catch { return; }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) return;
    for (const record of parsed.sessions) {
      if (!record || !EXCHANGE_RE.test(record.cookieId) || !SESSION_TOKEN_RE.test(record.sessionToken)
        || !UUID_RE.test(record.sessionId) || !UUID_RE.test(record.capabilityGeneration)
        || record.inputRole !== 'controller' || !Number.isFinite(record.expiresAt)) continue;
      sessions.set(record.cookieId, {
        ...record,
        activeConnections: 0,
        lastDisconnectedAt: Number.isFinite(record.lastDisconnectedAt) ? record.lastDisconnectedAt : now(),
        finalizing: null,
        renewing: null,
        lastAuthorizedAt: 0,
        nextRenewalAttemptAt: 0,
        expiryTimer: null,
      });
    }
  }

  async function controlRequest(pathname, sessionToken, body) {
    const response = await fetchFn(`${control.origin}${pathname}`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${sessionToken}`,
        'content-type': 'application/json',
        ...(controlBypassSecret ? { 'x-vercel-protection-bypass': controlBypassSecret } : {}),
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    if (text.length > 16384) throw new Error('control_response_too_large');
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    return { status: response.status, payload };
  }

  async function authorize(session, wantsInput) {
    try {
      const result = await controlRequest('/api/remote-desktop/sessions/authorize', session.sessionToken, {
        computerKind: options.computerKind,
        computerId: options.computerId,
        transport: options.transport,
        wantsInput,
      });
      const data = result.payload?.data;
      const authorized = result.status === 200 && result.payload?.authorized === true
        && data?.sessionId === session.sessionId
        && data?.computerKind === options.computerKind
        && data?.computerId === options.computerId
        && data?.capabilityGeneration === session.capabilityGeneration
        && data?.transport === options.transport
        && data?.inputRole === 'controller'
        && data?.inputReady === wantsInput;
      if (authorized) {
        session.lastAuthorizedAt = now();
        return true;
      }
      // Explicit denial is authoritative. Server errors and throttling are
      // transient control-plane failures, so preserve a recently authorized
      // stream and let the next watchdog tick retry the proof.
      if (result.status >= 500 || result.status === 429) {
        return now() - session.lastAuthorizedAt <= authorizationGraceMs;
      }
      return false;
    } catch {
      return now() - session.lastAuthorizedAt <= authorizationGraceMs;
    }
  }

  async function renew(session) {
    if (session.renewing) return session.renewing;
    const originalExpiresAt = session.expiresAt;
    diagnostic('renew_attempt');
    session.renewing = (async () => {
      try {
        const result = await controlRequest('/api/remote-desktop/sessions/renew', session.sessionToken, {
          ttlSeconds: 240,
        });
        const data = result.payload?.data;
        const expiresAt = Date.parse(data?.expiresAt);
        const continuousExpiresAt = Date.parse(data?.continuousExpiresAt);
        if (result.status !== 200) {
          diagnostic('renew_failed', 'http', result.status);
          return false;
        }
        if (sessions.get(session.cookieId) !== session || session.finalizing
          || session.expiresAt !== originalExpiresAt || now() >= originalExpiresAt) {
          diagnostic('renew_failed', 'late_result', result.status);
          return false;
        }
        if (result.payload?.renewed !== true
          || data?.sessionId !== session.sessionId
          || !Number.isFinite(expiresAt) || !Number.isFinite(continuousExpiresAt)
          || expiresAt <= originalExpiresAt || expiresAt <= now() + 30000
          || expiresAt > now() + 5 * 60 * 1000 || expiresAt > continuousExpiresAt) {
          diagnostic('renew_failed', 'invalid_receipt', result.status);
          return false;
        }
        session.expiresAt = expiresAt;
        session.nextRenewalAttemptAt = 0;
        scheduleExpiry(session);
        persist();
        diagnostic('renew_succeeded', undefined, result.status);
        return true;
      } catch (error) {
        diagnostic('renew_failed', 'transport', undefined,
          error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'abort' : 'other');
        return false;
      }
      finally { session.renewing = null; }
    })();
    const renewed = await session.renewing;
    if (!renewed) session.nextRenewalAttemptAt = now() + renewalRetryMs;
    return renewed;
  }

  function inputReceipt(session, action) {
    const suspending = action === 'agent-input-suspended';
    return {
      protocol: 'hivra-remote-desktop-input-v1',
      action,
      sessionId: session.sessionId,
      computerKind: options.computerKind,
      computerId: options.computerId,
      capabilityGeneration: session.capabilityGeneration,
      transport: options.transport,
      agentInputSuspended: suspending,
      controllerCount: suspending ? 1 : 0,
      observedAt: new Date(now()).toISOString(),
    };
  }

  async function transition(session, action) {
    const result = await controlRequest(
      '/api/remote-desktop/sessions/input-transition',
      session.sessionToken,
      inputReceipt(session, action),
    );
    return result.status === 200 && result.payload?.confirmed === true;
  }

  async function finalize(session, reason) {
    // HTTP denials also finalize sessions. Close media before removing the
    // session/expiry timer, including sockets arriving during finalization.
    for (const connection of [...connections]) if (connection.session === session) connection.stop();
    if (session.finalizing) return session.finalizing;
    session.finalizing = (async () => {
      try {
        const revoked = await controlRequest('/api/remote-desktop/sessions/terminate', session.sessionToken, { reason });
        if (revoked.status !== 200 || revoked.payload?.revoked !== true) return false;
        if (revoked.payload.inputState === 'release-pending') {
          if (!await transition(session, 'agent-input-resumed')) return false;
        }
        if (session.expiryTimer) clearTimeout(session.expiryTimer);
        session.expiryTimer = null;
        sessions.delete(session.cookieId);
        persist();
        return true;
      } catch { return false; }
      finally { session.finalizing = null; }
    })();
    return session.finalizing;
  }

  function scheduleExpiry(session) {
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    session.expiryTimer = setTimeout(() => {
      for (const connection of [...connections]) if (connection.session === session) connection.stop();
      void finalize(session, 'computer_stopping');
    }, Math.max(0, session.expiresAt - now()));
    session.expiryTimer.unref();
  }

  function sessionFor(req, sessionId) {
    const match = cookieValue(req, sessionId).match(COOKIE_RE);
    const session = match ? sessions.get(match[1]) : null;
    return session?.sessionId === sessionId ? session : null;
  }

  async function exchange(req, res) {
    if (req.method !== 'POST' || req.headers.origin !== publicUrl.origin
      || req.headers['sec-fetch-site'] !== 'same-origin'
      || String(req.headers['content-type'] || '').toLowerCase() !== 'application/json') {
      errorResponse(res, 403); return;
    }
    let body;
    try { body = await boundedJson(req); } catch { errorResponse(res, 400); return; }
    if (!body || Object.keys(body).length !== 3 || typeof body.sessionId !== 'string'
      || typeof body.exchangeCode !== 'string' || typeof body.verifier !== 'string' || !CANONICAL_UUID_RE.test(body.sessionId)
      || !EXCHANGE_RE.test(body.exchangeCode) || !VERIFIER_RE.test(body.verifier)) {
      errorResponse(res, 400); return;
    }
    let response;
    try {
      response = await fetchFn(`${control.origin}/api/remote-desktop/sessions/exchange`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(controlBypassSecret ? { 'x-vercel-protection-bypass': controlBypassSecret } : {}),
        },
        body: JSON.stringify({ exchangeCode: body.exchangeCode, verifier: body.verifier }),
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
    } catch { errorResponse(res, 503); return; }
    if (response.redirected || (response.status >= 300 && response.status < 400)
      || response.status === 401 || response.status >= 500) {
      errorResponse(res, 503); return;
    }
    if (response.status !== 200) { errorResponse(res, 401); return; }
    let envelope;
    try {
      const text = await response.text();
      if (text.length > 16384) throw new Error('response_too_large');
      envelope = JSON.parse(text);
    } catch { errorResponse(res, 401); return; }
    if (envelope?.success !== true || envelope.data?.sessionId !== body.sessionId || !validGrant(envelope.data, {
      computerKind: options.computerKind,
      computerId: options.computerId,
      transport: options.transport,
      publicOrigin: publicUrl.origin,
    })) { errorResponse(res, 401); return; }

    const grant = envelope.data;
    const session = {
      cookieId: randomBytes(32).toString('base64url'),
      sessionToken: grant.sessionToken,
      sessionId: grant.sessionId,
      capabilityGeneration: grant.capabilityGeneration,
      expiresAt: Date.parse(grant.expiresAt),
      inputRole: grant.inputRole,
      activeConnections: 0,
      lastDisconnectedAt: now(),
      finalizing: null,
      renewing: null,
      lastAuthorizedAt: 0,
      nextRenewalAttemptAt: 0,
      expiryTimer: null,
    };
    // The takeover transition independently binds the exchanged bearer to the
    // exact live capability generation and rejects revoked or expired grants.
    // Keep the post-transition authorization: it additionally proves the
    // owner is still running and the selected transport remains admitted.
    if (!await options.verifyInputIsolation()
      || !await transition(session, 'agent-input-suspended') || !await authorize(session, true)) {
      await finalize(session, 'security_event');
      errorResponse(res, 401); return;
    }
    sessions.set(session.cookieId, session);
    scheduleExpiry(session);
    persist();
    res.writeHead(204, {
      // The opaque cookie is browser-session scoped. Server authorization,
      // revocation and the rolling lease remain the actual validity fence.
      'set-cookie': `${COOKIE_NAME}-${session.sessionId}=v1.${session.cookieId}; Path=/desktop/sessions/${session.sessionId}/; HttpOnly; Secure; SameSite=Strict`,
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
    });
    res.end();
  }

  async function proxyHttp(req, res, session, target) {
    if (!await authorize(session, true)) { await finalize(session, 'security_event'); errorResponse(res, 401); return; }
    const headers = {
      ...copyHeaders(req.headers, SAFE_REQUEST_HEADERS),
      host: `127.0.0.1:${options.upstreamPort}`,
      origin: upstreamOrigin,
      authorization: options.basicAuthorization,
    };
    const upstream = http.request({ hostname: '127.0.0.1', port: options.upstreamPort, path: target.upstreamPath,
      method: req.method, headers, agent: false, maxHeaderSize: 16384 }, response => {
      res.writeHead(response.statusCode || 502, safeResponseHeaders(response.headers, control.origin));
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.setTimeout(30000, () => upstream.destroy());
    upstream.on('error', () => errorResponse(res, 502));
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  }

  async function handleHttp(req, res) {
    const target = fixedTarget(req.url);
    if (!target || req.headers.host !== publicUrl.host) { errorResponse(res, 400); return; }
    if (req.method === 'GET' && target.pathname === '/healthz' && !target.search) {
      jsonResponse(res, 200, { status: 'ok', protocol: 'hivra-remote-desktop-guest-v1' }); return;
    }
    if (req.method === 'GET' && target.pathname === '/desktop/handoff' && !target.search) {
      const body = handoffHtml(control.origin);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'private, no-store',
        'content-security-policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; frame-ancestors ${control.origin}`,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      res.end(body); return;
    }
    if (target.pathname === '/desktop/api/exchange' && !target.search) {
      await exchange(req, res); return;
    }
    const media = mediaTarget(target);
    if (!media) { errorResponse(res, 401); return; }
    const session = sessionFor(req, media.sessionId);
    if (!session || session.inputRole !== 'controller') { errorResponse(res, 401); return; }
    if (media.upstreamPath === '/api/session' && req.method === 'GET' && !target.search) {
      if (!await authorize(session, true)) { await finalize(session, 'security_event'); errorResponse(res, 401); return; }
      jsonResponse(res, 200, { connected: true, expiresAt: new Date(session.expiresAt).toISOString() }); return;
    }
    await proxyHttp(req, res, session, media);
  }

  async function handleUpgrade(req, socket, head) {
    const target = fixedTarget(req.url);
    const media = target ? mediaTarget(target) : null;
    const session = media ? sessionFor(req, media.sessionId) : null;
    const key = req.headers['sec-websocket-key'];
    const reject = status => {
      try { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`); } catch {}
      socket.destroy();
    };
    if (closed || !target || !media || media.upstreamPath !== '/api/websockets' || target.search
      || req.method !== 'GET' || req.headers.host !== publicUrl.host
      || req.headers.origin !== publicUrl.origin || !session || session.inputRole !== 'controller'
      || req.headers.upgrade?.toLowerCase() !== 'websocket'
      || req.headers['sec-websocket-version'] !== '13'
      || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)
      || Buffer.from(key, 'base64').toString('base64') !== key) { reject(401); return; }
    if (!await authorize(session, true)) { await finalize(session, 'security_event'); reject(401); return; }
    if (closed || sessions.get(session.cookieId) !== session || session.finalizing || now() >= session.expiresAt) {
      reject(401); return;
    }

    const offeredProtocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim()).filter(Boolean);
    const offeredExtensions = String(req.headers['sec-websocket-extensions'] || '');
    const headers = {
      host: `127.0.0.1:${options.upstreamPort}`,
      origin: upstreamOrigin,
      authorization: options.basicAuthorization,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': key,
      'sec-websocket-version': '13',
    };
    if (offeredProtocols.length) headers['sec-websocket-protocol'] = offeredProtocols.join(', ');
    if (offeredExtensions) headers['sec-websocket-extensions'] = offeredExtensions;
    const upstream = http.request({ hostname: '127.0.0.1', port: options.upstreamPort,
      path: '/api/websockets', headers, agent: false, maxHeaderSize: 16384 });
    let peer = null;
    let stopped = false;
    const connection = { session, stop: () => {
      if (stopped) return;
      stopped = true;
      upstream.destroy();
      if (peer && !peer.destroyed) peer.destroy();
      socket.destroy();
      connections.delete(connection);
      session.activeConnections = Math.max(0, session.activeConnections - 1);
      session.lastDisconnectedAt = now();
      persist();
    } };
    connections.add(connection);
    session.activeConnections += 1;
    const deadline = setTimeout(connection.stop, 30000);
    upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      peer = upstreamSocket;
      clearTimeout(deadline);
      const expected = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      const protocol = response.headers['sec-websocket-protocol'];
      const extensions = response.headers['sec-websocket-extensions'];
      if (response.statusCode !== 101 || response.headers['sec-websocket-accept'] !== expected
        || response.headers.upgrade?.toLowerCase() !== 'websocket'
        || (protocol !== undefined && !offeredProtocols.includes(protocol))
        || (extensions !== undefined && !offeredExtensions.includes(extensions))) { connection.stop(); return; }
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${expected}\r\n${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ''}${extensions ? `Sec-WebSocket-Extensions: ${extensions}\r\n` : ''}Cache-Control: no-store\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) peer.write(head);
      peer.on('error', connection.stop);
      peer.on('close', connection.stop);
      socket.pipe(peer).pipe(socket);
    });
    upstream.on('response', response => { response.resume(); connection.stop(); });
    upstream.on('error', connection.stop);
    socket.on('error', connection.stop);
    socket.on('close', connection.stop);
    upstream.end();
  }

  restore();
  for (const session of sessions.values()) scheduleExpiry(session);
  const timer = setInterval(async () => {
    if (closed) return;
    const currentSessions = [...sessions.values()];
    // Lease scheduling must not wait behind socket authorization. A session
    // may own several media sockets, but needs only one shared proof per tick.
    for (const session of currentSessions) {
      if (session.activeConnections > 0
        && !closed && sessions.get(session.cookieId) === session
        && !session.finalizing
        && now() < session.expiresAt
        && session.expiresAt - now() <= renewalLeadMs
        && now() >= session.nextRenewalAttemptAt) void renew(session);
    }
    // Renewal dispatch stays independent of an outstanding authorization tick.
    // renew() shares its in-flight promise, so later intervals cannot duplicate it.
    if (tickRunning) return;
    tickRunning = true;
    try {
      for (let offset = 0; offset < currentSessions.length && !closed; offset += 4) {
        await Promise.all(currentSessions.slice(offset, offset + 4).map(async session => {
          if (closed || sessions.get(session.cookieId) !== session) return;
          const disconnectedTooLong = session.activeConnections === 0
            && now() - session.lastDisconnectedAt >= disconnectGraceMs;
          const authorized = now() < session.expiresAt && !disconnectedTooLong
            && await authorize(session, true);
          if (closed || sessions.get(session.cookieId) !== session) return;
          if (now() >= session.expiresAt || disconnectedTooLong || !authorized) {
            for (const connection of [...connections]) if (connection.session === session) connection.stop();
            await finalize(session, now() >= session.expiresAt ? 'computer_stopping' : 'connection_closed');
          }
        }));
      }
    } finally { tickRunning = false; }
  }, recheckMs);
  timer.unref();

  return Object.freeze({
    handleHttp,
    handleUpgrade,
    sessionCount: () => sessions.size,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const connection of [...connections]) connection.stop();
      for (const session of [...sessions.values()]) await finalize(session, 'computer_stopping');
    },
  });
}

module.exports = { COOKIE_NAME, createRemoteDesktopBroker, handoffHtml };
