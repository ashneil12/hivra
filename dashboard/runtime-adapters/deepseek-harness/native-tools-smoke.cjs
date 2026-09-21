'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Exercise the pinned official subprocess service, not a substitute child
// process. Synthetic commands only; no provider credentials/model calls.
async function nativeToolsSmoke(runtimeDirectory) {
  const { Context } = await import(`${runtimeDirectory}/node_modules/@deepseek-ai/cordis/lib/index.js`);
  const { default: LocalSubprocessRuntime } = await import(`${runtimeDirectory}/node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js`);
  const context = new Context();
  const fiber = await context.plugin(LocalSubprocessRuntime);
  const home = '/tmp/native-tools-home';
  fs.mkdirSync(home, { mode: 0o700 });
  let timer;
  let terminal;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('native_tools_deadline')), 20000); });
    await Promise.race([deadline, (async () => {
      const handle = context.subprocess.spawn({ argv: ['/bin/bash', '-c', 'printf "hivra-native-shell\\n"'],
        cwd: home, env: { PATH: '/usr/bin:/bin', HOME: home }, graceMs: 200,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096, spill: { maxBytes: 4096 } }, stderr: { maxBytes: 4096, spill: { maxBytes: 4096 } } } });
      assert.equal((await handle.done).exitCode, 0);
      assert.equal(handle.collected.stdout.readFrom(0).text, 'hivra-native-shell\n');
      terminal = await context.subprocess.spawnTerminal({ argv: ['/bin/bash', '--noprofile', '--norc'],
        cwd: home, env: { PATH: '/usr/bin:/bin', HOME: home, TERM: 'xterm-256color' }, rows: 24, cols: 80, graceMs: 200 });
      let output = '';
      terminal.output.on('data', bytes => { output += bytes.toString(); assert.ok(output.length < 16384); });
      // Split the token so terminal echo cannot satisfy the output assertion.
      terminal.write("printf 'hivra-%s\\n' 'native-pty'; exit 0\n");
      assert.equal((await terminal.done).exitCode, 0);
      assert.match(output, /hivra-native-pty\r?\n/);
    })()]);
    return { officialSubprocessShell: true, officialInteractivePty: true };
  } finally {
    clearTimeout(timer);
    await fiber.dispose();
  }
}
module.exports = { nativeToolsSmoke };
