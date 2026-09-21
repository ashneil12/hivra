'use strict';

const { randomBytes, createHash } = require('node:crypto');
const { workspaceRequestAllowed } = require('./workspace-access-policy.cjs');

const COOKIE = '__Host-hivra_workspace';
const MAX_TTL = 4 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = value => createHash('sha256').update(value).digest('hex');

// Guest-local adapter for an already exchanged canonical grant. Not an issuer:
// no HTTP mint route or management-token fallback exists here. authorizeGrant
// must check the original grant against current control-plane authority. Its
// input stays guest-side; the browser gets only an unrelated opaque cookie.
function createWorkspaceSessions({ computerId, publicOrigin, authorizeGrant, now = Date.now, maxSessions = 64 }) {
  const origin = new URL(publicOrigin);
  if (!UUID.test(computerId) || origin.protocol !== 'https:' || origin.origin !== publicOrigin
    || typeof authorizeGrant !== 'function' || !Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 256) {
    throw new Error('workspace_session_configuration_invalid');
  }
  const sessions = new Map();
  let closed = false;
  let sweeping = false;
  const time = () => { const value = now(); return Number.isFinite(value) ? value : Infinity; };

  function revoke(key) {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    clearTimeout(session.expiryTimer);
    for (const close of session.sockets) { try { close(); } catch {} }
    session.sockets.clear();
  }
  function prune() {
    const current = time();
    for (const [key, session] of sessions) if (current >= session.expiresAt) revoke(key);
  }
  function validGrant(grant, current) {
    return grant && UUID.test(grant.sessionId) && grant.computerId === computerId
      && typeof grant.userId === 'string' && grant.userId.length > 0 && grant.userId.length <= 256
      && grant.audience === publicOrigin && ['files', 'box-terminal'].includes(grant.surface)
      && Number.isFinite(grant.expiresAt) && grant.expiresAt > current && grant.expiresAt <= current + MAX_TTL;
  }
  async function verify(grant) {
    const controller = new AbortController();
    let timeout;
    try {
      return await Promise.race([
        Promise.resolve().then(() => authorizeGrant(structuredClone(grant), controller.signal)).then(value => value === true),
        new Promise(resolve => { timeout = setTimeout(() => { controller.abort(); resolve(false); }, 5000); }),
      ]);
    } catch { return false; }
    finally { clearTimeout(timeout); controller.abort(); }
  }
  async function mint(raw) {
    if (closed) return null;
    prune();
    const current = time();
    const grant = raw && structuredClone(raw);
    if (!validGrant(grant, current) || sessions.size >= maxSessions || !await verify(grant)) return null;
    // Awaiting authorization can cross expiry or shutdown. Never extend it.
    prune();
    if (closed || time() >= grant.expiresAt || sessions.size >= maxSessions
      || [...sessions.values()].some(session => session.grant.sessionId === grant.sessionId)) return null;
    const token = randomBytes(32).toString('hex');
    const key = digest(token);
    const remaining = grant.expiresAt - time();
    if (remaining <= 0) return null;
    const expiryTimer = setTimeout(() => revoke(key), remaining);
    expiryTimer.unref?.();
    sessions.set(key, { grant, expiresAt: grant.expiresAt, sockets: new Set(), expiryTimer });
    return { cookie: `${COOKIE}-${grant.sessionId}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor((grant.expiresAt - time()) / 1000)}`,
      sessionId: grant.sessionId, expiresAt: grant.expiresAt, surface: grant.surface };
  }
  // The router must derive expectedSessionId from the immutable handoff path,
  // not from whichever cookie is currently present. Old documents must never
  // adopt a newer session merely because it shares this guest's origin.
  function lookup(expectedSessionId, req) {
    if (closed || !UUID.test(expectedSessionId) || !req || req.headers?.host !== origin.host) return null;
    const name = `${COOKIE}-${expectedSessionId}`;
    const values = String(req.headers.cookie || '').split(';').map(value => value.trim())
      .filter(value => value.startsWith(`${name}=`)).map(value => value.slice(name.length + 1));
    if (values.length !== 1 || !/^[a-f0-9]{64}$/.test(values[0])) return null;
    const key = digest(values[0]), session = sessions.get(key);
    if (!session || session.grant.sessionId !== expectedSessionId) return null;
    if (time() >= session.expiresAt) { revoke(key); return null; }
    if (!workspaceRequestAllowed(session.grant.surface, req)) return null;
    const mutation = req.method !== 'GET' || Boolean(req.headers.upgrade);
    // A later handoff must be same-site. Cross-site embedding requires an
    // explicit reviewed cookie/origin protocol, not loosening this gate.
    if ((mutation || req.headers.origin) && req.headers.origin !== publicOrigin) return null;
    return { key, session };
  }
  async function authorize(expectedSessionId, req) {
    const found = lookup(expectedSessionId, req);
    if (!found) return false;
    if (!await verify(found.session.grant)) { revoke(found.key); return false; }
    return !closed && sessions.get(found.key) === found.session && time() < found.session.expiresAt;
  }
  async function attachSocket(expectedSessionId, req, close) {
    if (typeof close !== 'function' || req?.headers?.upgrade?.toLowerCase() !== 'websocket' || !await authorize(expectedSessionId, req)) return null;
    const found = lookup(expectedSessionId, req);
    if (!found) return null;
    found.session.sockets.add(close);
    return () => found.session.sockets.delete(close);
  }
  // Reauthorization failure closes existing streams, not merely their next
  // HTTP request. A hung authority request is bounded to five seconds.
  async function sweep() {
    if (closed || sweeping) return;
    sweeping = true;
    try {
      prune();
      await Promise.all([...sessions].map(async ([key, session]) => {
        if (!await verify(session.grant) || time() >= session.expiresAt) revoke(key);
      }));
    } finally { sweeping = false; }
  }
  const maintenance = setInterval(() => { void sweep(); }, 5000);
  maintenance.unref?.();
  function close() { closed = true; clearInterval(maintenance); for (const key of sessions.keys()) revoke(key); }
  return { mint, authorize, attachSocket, sweep, close };
}

module.exports = { createWorkspaceSessions };
