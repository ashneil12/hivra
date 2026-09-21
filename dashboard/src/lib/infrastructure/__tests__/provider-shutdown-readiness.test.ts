/** @jest-environment node */
import { spawnSync } from "node:child_process";
import { PROVIDER_SHUTDOWN_READINESS_SCRIPT, parseProviderShutdownReadiness } from "../provider-shutdown-readiness";

const boot = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function probe(change = "ready") {
  const fixture = `import io, subprocess, types
from unittest.mock import patch
change = ${JSON.stringify(change)}
reads = 0
calls = 0
def opened(path):
    global reads
    if path == '/proc/sys/kernel/random/boot_id':
        reads += 1
        return io.StringIO('${boot}' if change != 'reboot' or reads == 1 else 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    return io.StringIO('Power Button' if change != 'keyboard-only' else 'AT Translated Set 2 keyboard')
def run(*args, **kwargs):
    global calls
    calls += 1
    if change == 'timeout':
        raise subprocess.TimeoutExpired('systemctl', 2)
    state = 'activating' if change == 'early-boot' else 'active'
    pid = 763 if change == 'handler-restarted' and calls > 1 else 762
    return types.SimpleNamespace(stdout='ActiveState=%s\\nSubState=running\\nMainPID=%s\\n' % (state, pid))
with patch('builtins.open', side_effect=opened), patch('os.listdir', return_value=[] if change == 'no-device' else ['5']), patch('os.readlink', return_value='/dev/input/event0'), patch('subprocess.run', side_effect=run):
    exec(${JSON.stringify(PROVIDER_SHUTDOWN_READINESS_SCRIPT)})
`;
  const result = spawnSync("python3", ["-I", "-B", "-c", fixture], { encoding: "utf8", timeout: 5_000 });
  expect(result.status).toBe(0);
  return parseProviderShutdownReadiness(result.stdout);
}

it("requires the actual active handler with an open Power Button device in the same boot", () => {
  expect(probe()).toEqual({ version: 1, ready: true, bootId: boot, powerHandlerPid: 762 });
});
it.each(["early-boot", "no-device", "keyboard-only", "handler-restarted", "reboot", "timeout"])(
  "does not declare shutdown ready on %s", change => {
    expect(probe(change)).toEqual({ version: 1, ready: false });
  },
);
it.each([
  "HIVRA_SHUTDOWN_READY_V1 {}",
  'HIVRA_SHUTDOWN_READY_V1 {"version":1,"ready":true}',
  'HIVRA_SHUTDOWN_READY_V1 {"version":1,"ready":false,"bootId":"unexpected"}',
  'untrusted line\nHIVRA_SHUTDOWN_READY_V1 {"version":1,"ready":false}',
  "x".repeat(1_025),
])("rejects malformed or mixed receipt output", output => {
  expect(() => parseProviderShutdownReadiness(output)).toThrow();
});
