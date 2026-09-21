'use strict';

// Runs only in the guest-origin handoff document. Parent messages select a
// previously issued grant, never a fetch URL or a management credential.
function startWorkspaceHandoff(controlOrigin) {
  const status = document.getElementById('status');
  const terminal = document.getElementById('terminal');
  const nonce = crypto.randomUUID();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  let used = false, ended = false, sessionId = null, surface = null, expiresAt = 0;
  const requests = new Set(), activeIds = new Set();
  let expiryTimer;
  const post = message => window.parent.postMessage({ ...message, nonce, ...(sessionId ? { sessionId, surface } : {}) }, controlOrigin);
  function end(reason) {
    if (ended) return;
    ended = true; clearTimeout(expiryTimer);
    for (const controller of requests) controller.abort();
    terminal.remove();
    status.hidden = false; status.textContent = 'Workspace disconnected. Reconnect from Hivra when ready.';
    post({ type: 'hivra.workspace.ended.v1', reason });
  }
  async function jsonRequest(path, body, limit = 2 * 1024 * 1024) {
    const controller = new AbortController(); requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 25000);
    let reader;
    try {
      const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
      if (ended || controller.signal.aborted || response.redirected
        || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('invalid_response');
      reader = response.body?.getReader();
      if (!reader) throw new Error('invalid_response');
      const chunks = []; let length = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (ended || controller.signal.aborted) throw new Error('request_ended');
        if (done) break;
        length += value.length;
        if (length > limit) throw new Error('response_too_large');
        chunks.push(value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { ok: response.ok, status: response.status, data: JSON.parse(new TextDecoder().decode(bytes)) };
    } finally {
      controller.abort(); requests.delete(controller); clearTimeout(timer);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
  async function receive(event) {
    if (ended || event.origin !== controlOrigin || event.source !== window.parent || window.parent === window) return;
    const data = event.data;
    if (!data || data.nonce !== nonce) return;
    if (data.type === 'hivra.workspace.init.v1') {
      if (used || !exact(data, ['type', 'nonce', 'sessionId', 'surface', 'exchangeCode', 'verifier'])
        || typeof data.sessionId !== 'string' || !uuid.test(data.sessionId)
        || !['files', 'box-terminal'].includes(data.surface)
        || typeof data.exchangeCode !== 'string' || !/^hwe1_[A-Za-z0-9_-]{43}$/.test(data.exchangeCode)
        || typeof data.verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(data.verifier)) return;
      used = true;
      try {
        const result = await jsonRequest('/workspace/exchange', { sessionId: data.sessionId, surface: data.surface,
          exchangeCode: data.exchangeCode, verifier: data.verifier }, 4096);
        const receipt = result.data;
        const destination = `/workspace/sessions/${data.sessionId}${data.surface === 'files' ? '/api/files' : '/box-terminal/'}`;
        if (!result.ok || !exact(receipt, ['sessionId', 'surface', 'expiresAt', 'path'])
          || receipt.sessionId !== data.sessionId || receipt.surface !== data.surface || receipt.path !== destination
          || !Number.isFinite(receipt.expiresAt) || receipt.expiresAt <= Date.now() || receipt.expiresAt > Date.now() + 240000) return end('exchange-denied');
        sessionId = receipt.sessionId; surface = receipt.surface; expiresAt = receipt.expiresAt;
        clearTimeout(expiryTimer); expiryTimer = setTimeout(() => end('expired'), expiresAt - Date.now());
        if (surface === 'files') {
          // Exchange JSON alone does not prove that the browser accepted the
          // HttpOnly cookie (notably in unsupported cross-site embeddings).
          const probe = await jsonRequest(destination);
          if (!probe.ok || typeof probe.data?.path !== 'string' || !Array.isArray(probe.data?.entries)) return end('files-unavailable');
          status.textContent = 'Secure file access connected.';
          post({ type: 'hivra.workspace.connected.v1', expiresAt });
        } else {
          terminal.addEventListener('load', () => {
            if (ended) return;
            try {
              if (terminal.contentDocument?.contentType !== 'text/html'
                || !terminal.contentDocument.getElementById('terminal-container')) return end('terminal-unavailable');
              status.hidden = true; terminal.hidden = false;
              // ttyd initialized while hidden; fit again using its now-visible
              // dimensions instead of waiting for a monitor/window resize.
              const child = terminal.contentWindow;
              if (child) child.dispatchEvent(new child.Event('resize'));
              // Mounted is not a claim that the terminal socket or shell is ready.
              post({ type: 'hivra.workspace.mounted.v1', expiresAt });
            } catch { end('terminal-unavailable'); }
          }, { once: true });
          terminal.src = destination;
        }
      } catch { end('exchange-unavailable'); }
      return;
    }
    if (data.type !== 'hivra.workspace.files.v1' || !sessionId || surface !== 'files'
      || data.sessionId !== sessionId || Date.now() >= expiresAt) return;
    const keys = ['type', 'nonce', 'sessionId', 'requestId', 'operation', 'path'];
    if (!exact(data, data.operation === 'write' ? [...keys, 'content'] : keys)
      || typeof data.requestId !== 'string' || !uuid.test(data.requestId)
      || !['list', 'read', 'write'].includes(data.operation) || typeof data.path !== 'string' || data.path.length > 4096
      || (data.operation === 'write' && (typeof data.content !== 'string' || new TextEncoder().encode(data.content).length > 512 * 1024))) return;
    if (activeIds.has(data.requestId)) return;
    if (activeIds.size >= 4) return post({ type: 'hivra.workspace.result.v1', requestId: data.requestId, ok: false, error: 'Workspace busy' });
    activeIds.add(data.requestId);
    try {
      const base = `/workspace/sessions/${sessionId}/api/${data.operation === 'list' ? 'files' : 'file'}`;
      const result = data.operation === 'write'
        ? await jsonRequest(base, { path: data.path, content: data.content })
        : await jsonRequest(base + '?' + new URLSearchParams({ path: data.path }));
      if (result.status === 403 && result.data?.code === 'workspace_authorization_denied') return end('authorization-lost');
      if (!ended) post({ type: 'hivra.workspace.result.v1', requestId: data.requestId,
        ok: result.ok, status: result.status, data: result.data });
    } catch { if (!ended) post({ type: 'hivra.workspace.result.v1', requestId: data.requestId, ok: false, error: 'Workspace request failed' }); }
    finally { activeIds.delete(data.requestId); }
  }
  window.addEventListener('message', receive);
  window.addEventListener('pagehide', () => { end('document-closed'); window.removeEventListener('message', receive); }, { once: true });
  expiryTimer = setTimeout(() => end('handoff-timeout'), 30000);
  post({ type: 'hivra.workspace.ready.v1' });
}

function workspaceHandoffHtml(controlOrigin) {
  const origin = new URL(controlOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== controlOrigin) throw new Error('workspace_handoff_configuration_invalid');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening workspace</title><style>html,body{margin:0;width:100%;height:100%;background:#090909;color:#bbb;font:14px system-ui}#status{margin:0;display:grid;place-items:center;height:100%}#terminal{width:100%;height:100%;border:0}#terminal[hidden],#status[hidden]{display:none}</style></head><body><p id="status">Connecting securely…</p><iframe id="terminal" title="Box Terminal" hidden></iframe><script>(${startWorkspaceHandoff.toString()})(${JSON.stringify(controlOrigin).replace(/</g, '\\u003c')});</script></body></html>`;
}

module.exports = { workspaceHandoffHtml };
