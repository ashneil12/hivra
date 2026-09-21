'use strict';

const { createWorkspaceSessions } = require('./workspace-sessions.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^hws1_[A-Za-z0-9_-]{43}$/;
const ownKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const BINDING = ['sessionId', 'computerId', 'surface', 'audience'];
const GRANT = [...BINDING, 'userId', 'expiresAt'];

// Guest-side connection to the canonical ledger. The caller must supply origins
// and computer identity from installed configuration, never a browser URL.
// Only the opaque cookie receipt escapes exchangeAndMint; the hws1 credential
// remains inside the local session adapter and is never persisted here.
function createWorkspaceControl({ computerId, publicOrigin, controlOrigin, fetchFn = globalThis.fetch, now = Date.now }) {
  for (const value of [publicOrigin, controlOrigin]) {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.origin !== value) throw new Error('workspace_control_configuration_invalid');
  }
  if (!UUID.test(computerId) || typeof fetchFn !== 'function') throw new Error('workspace_control_configuration_invalid');
  let closed = false;
  const pending = new Set();
  function validGrant(data, binding, withToken) {
    const current = now();
    return ownKeys(data, withToken ? [...GRANT, 'sessionToken'] : GRANT)
      && BINDING.every(key => data[key] === binding[key])
      && typeof data.userId === 'string' && data.userId.length > 0 && data.userId.length <= 256
      && Number.isFinite(current) && Number.isFinite(data.expiresAt)
      && data.expiresAt > current && data.expiresAt <= current + 240000
      && (!withToken || (typeof data.sessionToken === 'string' && TOKEN.test(data.sessionToken)));
  }
  async function request(kind, body, token, signal) {
    if (closed || signal?.aborted) throw new Error('workspace_control_unavailable');
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, 5000);
    signal?.addEventListener('abort', abort, { once: true });
    pending.add(controller);
    let reader;
    try {
      const url = `${controlOrigin}/api/workspace/sessions/${kind}`;
      const response = await fetchFn(url, { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body), signal: controller.signal });
      if (controller.signal.aborted || response.status !== 200 || response.redirected
        || (response.url && response.url !== url) || response.headers.has('set-cookie')
        || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel(); throw new Error('workspace_control_unavailable');
      }
      reader = response.body?.getReader();
      if (!reader) throw new Error('workspace_control_unavailable');
      const chunks = []; let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (controller.signal.aborted || closed) throw new Error('workspace_control_unavailable');
        if (done) break;
        size += value.length;
        if (size > 4096) throw new Error('workspace_control_unavailable');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      controller.abort(); clearTimeout(timer); pending.delete(controller);
      signal?.removeEventListener('abort', abort);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
  async function authorizeGrant(grant, signal) {
    try {
      const binding = Object.fromEntries(BINDING.map(key => [key, grant[key]]));
      if (!validGrant(grant, binding, true) || grant.computerId !== computerId || grant.audience !== publicOrigin) return false;
      const result = await request('authorize', binding, grant.sessionToken, signal);
      return ownKeys(result, ['authorized', 'data']) && result.authorized === true
        && validGrant(result.data, binding, false) && result.data.userId === grant.userId
        && result.data.expiresAt === grant.expiresAt;
    } catch { return false; }
  }
  const sessions = createWorkspaceSessions({ computerId, publicOrigin, authorizeGrant, now });
  async function exchangeAndMint(input) {
    try {
      if (closed || !ownKeys(input, ['sessionId', 'surface', 'exchangeCode', 'verifier'])
        || typeof input.sessionId !== 'string' || !UUID.test(input.sessionId)
        || !['files', 'box-terminal'].includes(input.surface)
        || typeof input.exchangeCode !== 'string' || !/^hwe1_[A-Za-z0-9_-]{43}$/.test(input.exchangeCode)
        || typeof input.verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier)) return null;
      const binding = { sessionId: input.sessionId, computerId, surface: input.surface, audience: publicOrigin };
      const result = await request('exchange', { ...binding, exchangeCode: input.exchangeCode, verifier: input.verifier });
      // Exchange's HTTP envelope uses the shared success/data response contract.
      if (!ownKeys(result, ['success', 'data']) || result.success !== true || !validGrant(result.data, binding, true)) return null;
      return await sessions.mint(result.data);
    } catch { return null; }
  }
  function close() { closed = true; for (const controller of pending) controller.abort(); sessions.close(); }
  return { exchangeAndMint, authorize: sessions.authorize, attachSocket: sessions.attachSocket, sweep: sessions.sweep, close };
}

module.exports = { createWorkspaceControl };
