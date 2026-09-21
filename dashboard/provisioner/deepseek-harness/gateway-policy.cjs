'use strict';
const fs = require('node:fs');

const CONFIG_PATH = '/etc/hivra/deepseek-native.json';
const RUNTIME_DIRECTORY = '/opt/hivra/deepseek-runtime';
const PRIVATE_HOME = '/home/bux/.hivra/deepseek';
function canonicalOrigin(value) {
  if (typeof value !== 'string' || value.length > 253 + 8) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.port
      && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname)
      // Match the typed guest parser's conservative ASCII DNS subset. Numeric
      // WHATWG-IP forms and IDN/punycode require a separate reviewed contract.
      && /^[a-z]{2,63}$/.test(url.hostname.split('.').at(-1))
      && url.hostname.includes('.') && url.hostname.split('.').every(label => !label.startsWith('xn--') && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
  } catch { return false; }
}
function loadConfiguration() {
  // Root-owned configuration is outside the agent's writable HOME. Never
  // infer the public authority from Host, Forwarded, Origin, or Referer.
  for (const directory of ['/etc', '/etc/hivra']) {
    const st = fs.lstatSync(directory);
    if (!st.isDirectory() || st.uid !== 0 || (st.mode & 0o022) || fs.realpathSync(directory) !== directory) throw new Error('deepseek_configuration_unsafe');
  }
  const fd = fs.openSync(CONFIG_PATH, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || (st.mode & 0o777) !== 0o644 || st.size > 1024) throw new Error('deepseek_configuration_unsafe');
    const raw = fs.readFileSync(fd, 'utf8');
    const value = JSON.parse(raw);
    if (Object.keys(value).sort().join(',') !== 'publicOrigin,version' || value.version !== 1 || !canonicalOrigin(value.publicOrigin)
      || raw !== JSON.stringify({ version: 1, publicOrigin: value.publicOrigin }) + '\n') throw new Error('deepseek_configuration_invalid');
    return Object.freeze({ publicOrigin: value.publicOrigin, runtimeDirectory: RUNTIME_DIRECTORY, home: PRIVATE_HOME });
  } finally { fs.closeSync(fd); }
}

const COMPUTER = new Set(['GET /api/files', 'GET /api/file', 'POST /api/file', 'POST /api/upload',
  'GET /api/browser/status', 'POST /api/browser/toggle', 'POST /api/cookies/import']);
const UNSUPPORTED = new Set(['GET /api/model', 'POST /api/model', 'GET /api/llm', 'POST /api/llm',
  'GET /api/restrict', 'POST /api/restrict', 'GET /api/mcp', 'POST /api/mcp', 'POST /api/chat',
  'GET /api/login/status', 'POST /api/login/start', 'POST /api/login/complete', 'GET /api/sessions',
  'GET /api/skills', 'GET /api/telegram/status', 'POST /api/telegram/connect', 'POST /api/telegram/disconnect',
  // Native tools manage their repository. Existing generic Git previews can
  // expose staged private state; do not advertise that surface for this kind.
  'GET /api/git/status', 'GET /api/git/diff', 'POST /api/git/commit', 'POST /api/git/checkout']);
function routeKind(method, pathname) {
  if (method === 'GET' && (pathname === '/healthz' || pathname === '/api/meta')) return 'public';
  if (method === 'POST' && pathname === '/auth/bootstrap') return 'bootstrap';
  if (['/terminal', '/box-terminal', '/vnc'].some(prefix => pathname === prefix || pathname.startsWith(prefix + '/'))) return 'surface';
  const key = `${method} ${pathname}`;
  if (COMPUTER.has(key)) return 'computer';
  if (UNSUPPORTED.has(key) || (pathname === '/api/llm/application' && method !== 'OPTIONS')
    || (method === 'GET' && pathname.startsWith('/api/sessions/'))
    || (method === 'DELETE' && (pathname.startsWith('/api/mcp/') || pathname.startsWith('/api/skills/')))) return 'unsupported';
  // In particular POST /api/skills/list and /api/session/* are upstream RPC.
  return 'native';
}
function matchesHost(req, origin) { return req.headers.host === new URL(origin).host; }
function surfaceOriginAllowed(req, origin) {
  if (!matchesHost(req, origin)) return false;
  if (req.headers.origin !== undefined && req.headers.origin !== origin) return false;
  if (req.headers.upgrade || !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return req.headers.origin === origin;
  return true;
}
module.exports = { canonicalOrigin, loadConfiguration, routeKind, matchesHost, surfaceOriginAllowed, CONFIG_PATH, RUNTIME_DIRECTORY, PRIVATE_HOME };
