import { z } from "zod";

const Receipt = z.discriminatedUnion("ready", [
  z.object({ version: z.literal(1), ready: z.literal(false) }).strict(),
  z.object({ version: z.literal(1), ready: z.literal(true), bootId: z.string().uuid(),
    powerHandlerPid: z.number().int().positive().max(2_147_483_647) }).strict(),
]);
export type ProviderShutdownReadiness = z.infer<typeof Receipt>;
const PREFIX = "HIVRA_SHUTDOWN_READY_V1 ";

/** No power mutation, credential output, caller-selected paths or shell. A
 * running provider VM may still be booting before logind watches ACPI input.
 * This is readiness evidence, never proof that a later shutdown succeeded. */
export const PROVIDER_SHUTDOWN_READINESS_SCRIPT = `import json, os, re, subprocess

def handler():
    result = subprocess.run(['/usr/bin/systemctl', 'show', 'systemd-logind.service',
        '--property=ActiveState', '--property=SubState', '--property=MainPID'],
        check=True, capture_output=True, text=True, timeout=2)
    fields = dict(line.split('=', 1) for line in result.stdout.splitlines())
    if fields.get('ActiveState') != 'active' or fields.get('SubState') != 'running':
        raise ValueError('handler not active')
    pid = int(fields['MainPID'])
    if not 0 < pid <= 2147483647:
        raise ValueError('missing handler')
    return pid

def inspect():
    with open('/proc/sys/kernel/random/boot_id') as f:
        boot = f.read().strip()
    if not re.fullmatch('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', boot):
        raise ValueError('invalid boot')
    pid = handler()
    watched = False
    for fd in os.listdir('/proc/%s/fd' % pid):
        try:
            device = os.readlink('/proc/%s/fd/%s' % (pid, fd))
            match = re.fullmatch('/dev/input/(event[0-9]+)', device)
            if match:
                with open('/sys/class/input/%s/device/name' % match.group(1)) as f:
                    watched = watched or f.read().strip() == 'Power Button'
        except OSError:
            continue
    with open('/proc/sys/kernel/random/boot_id') as f:
        same_boot = f.read().strip() == boot
    if not watched or not same_boot or handler() != pid:
        raise ValueError('power handler not stable')
    return {'version': 1, 'ready': True, 'bootId': boot, 'powerHandlerPid': pid}

try:
    receipt = inspect()
except Exception:
    receipt = {'version': 1, 'ready': False}
print('${PREFIX}' + json.dumps(receipt, separators=(',', ':')))
`;

export function parseProviderShutdownReadiness(output: string): ProviderShutdownReadiness {
  if (output.length > 1_024) throw new Error("Invalid shutdown readiness receipt");
  const lines = output.trim().split("\n");
  if (lines.length !== 1 || !lines[0].startsWith(PREFIX)) throw new Error("Invalid shutdown readiness receipt");
  return Receipt.parse(JSON.parse(lines[0].slice(PREFIX.length)));
}
