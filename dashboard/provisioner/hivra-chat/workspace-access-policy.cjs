'use strict';

// Request policy for the forthcoming owner-bound workspace handoff. This is
// deliberately not an authentication mechanism: callers must independently
// verify a live owner/computer/audience-bound grant and its expiry/revocation.
// Callers must also enforce the canonical guest Host and CSRF/CWSH Origin
// checks, including periodic authorization of an already-open shell socket.
// Keep management, desktop and agent-native authority outside workspace grants.
function workspaceRequestAllowed(surface, req) {
  if (surface !== 'files' && surface !== 'box-terminal') return false;
  if (!req || typeof req !== 'object') return false;
  const raw = req.url;
  if (typeof raw !== 'string' || raw.length > 8192 || !raw.startsWith('/')
    || raw.startsWith('//') || /[\\\s\x00-\x1f\x7f#]/.test(raw)) return false;
  let target;
  try { target = new URL(raw, 'http://workspace.invalid'); } catch { return false; }
  // Never let URL normalization change the authority-bearing route.
  if (raw.split('?')[0] !== target.pathname) return false;
  const method = req.method;
  const upgrade = String(req.headers?.upgrade || '').toLowerCase();
  if (surface === 'files') {
    if (upgrade || (method !== 'GET' && method !== 'POST')) return false;
    if (target.pathname !== '/api/files' && target.pathname !== '/api/file') return false;
    // Writes carry their path in the JSON body; a query path is ambiguous.
    if (method === 'POST') return target.pathname === '/api/file' && !target.search;
    // Path confinement and credential-file denial remain in the file service.
    // Reject duplicate/unknown query parameters rather than disagreeing with it.
    const keys = [...target.searchParams.keys()];
    return keys.length <= 1 && keys.every(key => key === 'path');
  }
  // ttyd serves its document, token response and socket only. A shell grant
  // must not authorize arbitrary gateway paths, management APIs or terminals
  // belonging to a different agent runtime.
  if (method !== 'GET' || target.search) return false;
  if (upgrade) return upgrade === 'websocket' && target.pathname === '/box-terminal/ws';
  return target.pathname === '/box-terminal/' || target.pathname === '/box-terminal/token';
}

module.exports = { workspaceRequestAllowed };
