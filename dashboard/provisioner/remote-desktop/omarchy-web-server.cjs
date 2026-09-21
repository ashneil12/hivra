'use strict';

const http = require('node:http');
const { readFileSync } = require('node:fs');
const { createRemoteDesktopBroker } = require('./omarchy-web-broker.cjs');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const broker = createRemoteDesktopBroker({
  controlOrigin: required('HIVRA_REMOTE_DESKTOP_CONTROL_ORIGIN'),
  publicOrigin: required('HIVRA_REMOTE_DESKTOP_PUBLIC_ORIGIN'),
  computerKind: required('HIVRA_REMOTE_DESKTOP_COMPUTER_KIND'),
  computerId: required('HIVRA_REMOTE_DESKTOP_COMPUTER_ID'),
  transport: required('HIVRA_REMOTE_DESKTOP_TRANSPORT'),
  capturedCursor: true,
  upstreamPort: 8080,
  basicAuthorization: `Basic ${readFileSync(required('HIVRA_REMOTE_DESKTOP_BASIC_AUTH_FILE'), 'ascii').trim()}`,
  statePath: required('HIVRA_REMOTE_DESKTOP_STATE_FILE'),
  verifyInputIsolation: async () => {
    try { return readFileSync(required('HIVRA_REMOTE_DESKTOP_INPUT_ISOLATION_FILE'), 'utf8').trim() === 'selkies-container-no-agent-input-v1'; }
    catch { return false; }
  },
});

const server = http.createServer((req, res) => { void broker.handleHttp(req, res); });
server.on('upgrade', (req, socket, head) => { void broker.handleUpgrade(req, socket, head); });
server.listen(8090, '0.0.0.0');

async function shutdown() { server.close(); await broker.close(); process.exit(0); }
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
