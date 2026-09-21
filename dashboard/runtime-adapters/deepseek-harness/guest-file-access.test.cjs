'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const { once } = require('node:events');
const { createRequire } = require('node:module');

test('guest HTTP file/Git previews and attachment admission do not disclose protected files or aliases', { skip: process.platform !== 'linux' }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hivra-guest-files-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const home = path.join(directory, 'home'); fs.mkdirSync(home);
  fs.mkdirSync(path.join(home, '.hivra/deepseek/.dsh'), { recursive: true });
  fs.mkdirSync(path.join(home, 'repo'));
  fs.writeFileSync(path.join(home, '.hivra/api-token'), 'a'.repeat(64));
  fs.writeFileSync(path.join(home, '.hivra/deepseek/.dsh/.credentials.yaml'), 'synthetic-native-key');
  fs.writeFileSync(path.join(home, 'repo/.env'), 'synthetic-env-key');
  fs.writeFileSync(path.join(home, 'repo/work.txt'), 'ordinary text');
  fs.symlinkSync(path.join(home, '.hivra/api-token'), path.join(home, 'repo/ordinary.txt'));
  const serverPath = path.resolve(__dirname, '../../provisioner/hivra-chat/server.js');
  const requireServer = createRequire(serverPath);
  const requests = [], peers = new Set();
  let server;
  const context = vm.createContext({
    require(name) {
      if (name === 'http') return { ...http, createServer(handler) {
        server = http.createServer(handler);
        server.on('connection', socket => { peers.add(socket); socket.on('close', () => peers.delete(socket)); });
        return server;
      } };
      if (name === 'child_process') return {
        spawn() { throw new Error('No real agent process allowed'); },
        execFile(_bin, args, _options, callback) {
          requests.push(args);
          if (args.includes('rev-parse')) return callback(null, path.join(home, 'repo'));
          if (args.includes('status')) return callback(null, args.at(-1) === '.env' ? ' M .env\n' : args.at(-1) === 'removed/guide.md' ? ' D removed/guide.md' : '?? ' + args.at(-1));
          if (args.includes('diff')) return callback(null, args.at(-1) === 'removed/guide.md' ? '-deleted text' : '+synthetic-env-key');
          throw new Error('Unexpected process in fixture');
        },
      };
      return requireServer(name);
    },
    process: { env: { HOME: home, HIVRA_CHAT_PORT: '0', HIVRA_AGENT_KIND: 'generic' } },
    __dirname: path.dirname(serverPath), Buffer, URL, URLSearchParams, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
  });
  // Optional old, local source snapshot demonstrates the regression; never
  // download or execute a user-selected remote file. Production uses no hook.
  const source = process.env.HIVRA_TEST_BASELINE_SERVER || serverPath;
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source, timeout: 2000 });
  t.after(async () => { for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)); });
  if (!server.listening) await once(server, 'listening');
  function request(url, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, method: body ? 'POST' : 'GET', agent: false,
        headers: { authorization: 'Bearer ' + 'a'.repeat(64), 'content-type': 'application/json' } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.once('error', reject); req.setTimeout(2000, () => req.destroy(new Error('fixture timeout'))); req.end(body && JSON.stringify(body));
    });
  }
  for (const filename of ['repo/ordinary.txt', '.hivra/deepseek/.dsh/.credentials.yaml', 'repo/.env']) {
    assert.equal((await request('/api/file?path=' + encodeURIComponent(filename))).status, 403, filename);
    assert.equal((await request('/api/file', { path: filename, content: 'do-not-overwrite' })).status, 403, filename);
  }
  for (const filename of ['ordinary.txt', '.env', '.']) {
    const result = await request('/api/git/diff?dir=repo&path=' + encodeURIComponent(filename));
    assert.equal(result.status, 403, `Git ${filename}`);
    assert.equal(JSON.stringify(result.body).includes('synthetic-env-key'), false);
  }
  const read = await request('/api/file?path=repo/work.txt');
  assert.equal(read.status, 200); assert.equal(read.body.content, 'ordinary text');
  const diff = await request('/api/git/diff?dir=repo&path=work.txt');
  assert.equal(diff.status, 200); assert.equal(diff.body.diff, 'ordinary text');
  assert.ok(requests.some(args => args[0] === '--literal-pathspecs' && args.includes('status')));
  assert.equal(requests.some(args => args.includes('diff')), false, 'private tracked path never reaches Git diff');
  const deleted = await request('/api/git/diff?dir=repo&path=removed%2Fguide.md');
  assert.equal(deleted.status, 200); assert.equal(deleted.body.diff, '-deleted text');
  assert.ok(requests.some(args => args.includes('diff') && args.includes('--no-ext-diff') && args.includes('--no-textconv')));
  const admitAttachments = vm.runInContext('admittedAttachmentPaths', context);
  assert.deepEqual(Array.from(admitAttachments(['repo/ordinary.txt', 'repo/.env', 'repo/work.txt', '.hivra/deepseek/.dsh/.credentials.yaml'])), [path.join(home, 'repo/work.txt')]);
  assert.equal(fs.readFileSync(path.join(home, '.hivra/api-token'), 'utf8'), 'a'.repeat(64));
  assert.equal(fs.readFileSync(path.join(home, 'repo/.env'), 'utf8'), 'synthetic-env-key');
});
