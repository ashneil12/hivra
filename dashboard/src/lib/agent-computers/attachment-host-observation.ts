import { isIP } from "node:net";
import { z } from "zod";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { buildVmidBoundGuestExecPrelude } from "@/lib/hivra/vmid-bound-guest-exec";

const Id = z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Target = z.object({
  operationId: Id, computerId: Id, sourceId: Id,
  vmid: z.number().int().min(100).max(999999999),
  guestIp: z.string().refine(value => isIP(value) === 4),
  bindingTag: z.string().length(43).regex(/^hivra-bind-[0-9a-f]{32}$/),
  architecture: z.enum(["x86_64", "aarch64"]),
}).strict();
const Observation = z.object({ version: z.literal(1), target: Target, bootId: Id }).strict();
export type AttachmentObservationTarget = z.infer<typeof Target>;
export type AttachmentHostObservation = z.infer<typeof Observation>;

export function snapshotAttachmentObservationTarget(input: unknown): AttachmentObservationTarget {
  return Target.parse(input);
}

// No filesystem writes, installer, package manager or shell command supplied by
// a caller. Host-side VMID QGA selection, not guest IP routing, binds execution.
const GUEST_PROBE = `import json,os,pathlib,platform,re,sys
target=json.loads(sys.argv[1])
if os.geteuid()!=0 or platform.system()!='Linux' or platform.machine()!=target['architecture']:
 raise SystemExit('attachment guest platform mismatch')
boot=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
if not re.fullmatch('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',boot):
 raise SystemExit('invalid attachment guest boot')
print(json.dumps(dict(version=1,target=target,bootId=boot),separators=(',',':')))
`;

// Preserve the shared directory and lock contents. Pin each directory by FD;
// a writable /run/lock is acceptable only with the sticky bit set.
export const ATTACHMENT_HOST_LOCK_PROGRAM = String.raw`import fcntl,os,stat,sys,time
run=os.open('/run',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
info=os.fstat(run)
if info.st_uid!=0 or info.st_mode&0o022: raise SystemExit('unsafe run directory')
directory=os.open('lock',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=run)
info=os.fstat(directory)
if info.st_uid!=0 or (info.st_mode&0o022 and not info.st_mode&stat.S_ISVTX):
 raise SystemExit('unsafe shared lock directory')
lock=os.open('hivra-allocation.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=directory)
info=os.fstat(lock)
if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_nlink!=1 or info.st_mode&0o022:
 raise SystemExit('unsafe shared allocation lock')
os.close(directory); os.close(run)
deadline=time.monotonic()+10
while True:
 try:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  break
 except BlockingIOError:
  if time.monotonic()>=deadline: raise SystemExit('allocation lock busy')
  time.sleep(0.1)
os.set_inheritable(lock,True)
os.execv('/bin/bash',['bash','-c',sys.argv[1]])
`;

/** Only invoke after owner/operation/generation admission on the resolved host.
 * This read-only probe does not reserve a boot in SQL or grant dispatch.
 */
export function buildAttachmentHostObservationScript(input: AttachmentObservationTarget): string {
  const target = Target.parse(input);
  const body = `#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
umask 077
VMID=${target.vmid}
EXPECTED_BINDING_TAG=${shellQuote(target.bindingTag)}
GUEST_IP=${shellQuote(target.guestIp)}
# Bound each QGA/status call even if the outer SSH observer disconnects.
qm() { command timeout --kill-after=5 20 qm "$@"; }
[ "$(qm status "$VMID" | awk '{print $2}')" = running ]
VM_CONFIG="$(qm config "$VMID")"
printf '%s\\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\\n' | grep -Fxq "$EXPECTED_BINDING_TAG"
printf '%s\\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\\n' | grep -Fxq "ip=$GUEST_IP/24"
${buildVmidBoundGuestExecPrelude()}
run_vmid_bound_guest_exec /usr/bin/python3 -I -B -c ${shellQuote(GUEST_PROBE)} ${shellQuote(JSON.stringify(target))}
`;
  return `#!/usr/bin/env bash\nset -Eeuo pipefail\nexec /usr/bin/python3 -I -B -c ${shellQuote(ATTACHMENT_HOST_LOCK_PROGRAM)} ${shellQuote(body)}\n`;
}

export function parseAttachmentHostObservation(stdout: string, expected: AttachmentObservationTarget): AttachmentHostObservation | null {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > 4096) return null;
  const target = Target.safeParse(expected);
  if (!target.success) return null;
  try {
    const parsed = Observation.safeParse(JSON.parse(stdout));
    if (!parsed.success || Object.entries(target.data).some(([key, value]) => parsed.data.target[key as keyof AttachmentObservationTarget] !== value)) return null;
    return parsed.data;
  } catch { return null; }
}
