'use strict';

const http = require('node:http');
const { readFileSync, statSync } = require('node:fs');
const { createRemoteDesktopBroker } = require('./broker.cjs');

const CONTROL_BYPASS_FILE = '/opt/hivra/remote-desktop/control-protection-bypass';
const CONTROL_BYPASS_SECRET_RE = /^[A-Za-z0-9_-]{16,256}$/;

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalControlBypassSecret() {
  const path = String(process.env.HIVRA_REMOTE_DESKTOP_CONTROL_BYPASS_FILE || '');
  if (!path) return '';
  if (path !== CONTROL_BYPASS_FILE) throw new Error('control bypass file is invalid');
  try {
    const info = statSync(path);
    if (!info.isFile() || info.uid !== 0 || info.gid !== process.getgid()
      || (info.mode & 0o777) !== 0o640 || info.size < 16 || info.size > 256) {
      throw new Error('invalid');
    }
    const secret = readFileSync(path, 'ascii');
    if (!CONTROL_BYPASS_SECRET_RE.test(secret)) throw new Error('invalid');
    return secret;
  } catch {
    throw new Error('control bypass file is invalid');
  }
}

const broker = createRemoteDesktopBroker({
  controlOrigin: required('HIVRA_REMOTE_DESKTOP_CONTROL_ORIGIN'),
  publicOrigin: required('HIVRA_REMOTE_DESKTOP_PUBLIC_ORIGIN'),
  computerKind: required('HIVRA_REMOTE_DESKTOP_COMPUTER_KIND'),
  computerId: required('HIVRA_REMOTE_DESKTOP_COMPUTER_ID'),
  transport: required('HIVRA_REMOTE_DESKTOP_TRANSPORT'),
  upstreamPort: Number(required('HIVRA_REMOTE_DESKTOP_UPSTREAM_PORT')),
  basicAuthorization: `Basic ${readFileSync(required('HIVRA_REMOTE_DESKTOP_BASIC_AUTH_FILE'), 'ascii').trim()}`,
  statePath: required('HIVRA_REMOTE_DESKTOP_STATE_FILE'),
  controlBypassSecret: optionalControlBypassSecret(),
  verifyInputIsolation: async () => {
    try {
      return readFileSync(required('HIVRA_REMOTE_DESKTOP_INPUT_ISOLATION_FILE'), 'utf8').trim()
        === 'selkies-container-no-agent-input-v1';
    } catch { return false; }
  },
});

const port = Number(required('HIVRA_REMOTE_DESKTOP_BROKER_PORT'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('broker port is invalid');
const server = http.createServer((req, res) => { void broker.handleHttp(req, res); });
server.on('upgrade', (req, socket, head) => { void broker.handleUpgrade(req, socket, head); });
server.listen(port, '127.0.0.1');

async function shutdown() {
  server.close();
  await broker.close();
  process.exit(0);
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
