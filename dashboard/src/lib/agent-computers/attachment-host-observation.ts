import { isIP } from "node:net";
import { z } from "zod";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { buildDetachedVmidBoundGuestExecPrelude, buildVmidBoundGuestExecPrelude } from "@/lib/hivra/vmid-bound-guest-exec";

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
// a writable /run/lock is acceptable only with the sticky bit set. The step
// gets the lock on fd 9 and releases it itself (see attachmentHostStepBody).
export const ATTACHMENT_HOST_LOCK_FD = 9;
const ATTACHMENT_HOST_STDIN_FD = 8;
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
if lock!=9:
 os.dup2(lock,9)
 os.close(lock)
os.set_inheritable(9,True)
os.execv('/bin/bash',['bash','-c',sys.argv[1]])
`;

export const ATTACHMENT_TARGET_REFUSALS = ["computer_not_running", "binding_mismatch", "address_mismatch"] as const;
export type AttachmentTargetRefusal = typeof ATTACHMENT_TARGET_REFUSALS[number];

/** The exact VM, checked under the host allocation lock (the same lock as
 * create, destroy and restart): running, carrying the binding tag, on the
 * guest address with any prefix length. A refusal is printed as one line and
 * nothing runs in the guest.
 */
function attachmentHostTargetCheck(target: AttachmentObservationTarget): string {
  return `export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
umask 077
VMID=${target.vmid}
EXPECTED_BINDING_TAG=${shellQuote(target.bindingTag)}
GUEST_IP=${shellQuote(target.guestIp)}
# Bound each QGA/status call even if the outer SSH observer disconnects.
qm() { command timeout --kill-after=5 20 qm "$@"; }
refuse_attachment_target() { printf 'HIVRA_ATTACHMENT_TARGET_REFUSED %s\\n' "$1"; exit 3; }
[ "$(qm status "$VMID" | awk '{print $2}')" = running ] || refuse_attachment_target computer_not_running
VM_CONFIG="$(qm config "$VMID")"
printf '%s\\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\\n' | grep -Fxq "$EXPECTED_BINDING_TAG" \\
  || refuse_attachment_target binding_mismatch
printf '%s\\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\\n' \\
  | awk -F/ -v want="ip=$GUEST_IP" '$1 == want && NF == 2 && $2 ~ /^[0-9]+$/ && $2 >= 8 && $2 <= 32 { found = 1 } END { exit !found }' \\
  || refuse_attachment_target address_mismatch
${buildVmidBoundGuestExecPrelude()}`;
}

/** The refusal line a host step printed before anything ran in the guest. */
export function parseAttachmentTargetRefusal(stdout: unknown): AttachmentTargetRefusal | null {
  if (typeof stdout !== "string") return null;
  const lines = stdout.split("\n").filter((line) => line.startsWith("HIVRA_ATTACHMENT_TARGET_REFUSED "));
  if (lines.length !== 1) return null;
  const reason = lines[0].slice("HIVRA_ATTACHMENT_TARGET_REFUSED ".length).trim();
  return (ATTACHMENT_TARGET_REFUSALS as readonly string[]).includes(reason) ? reason as AttachmentTargetRefusal : null;
}

/**
 * The one line a pinned guest runner prints when its program raised: the
 * program ran in the VM and ended there, refused, so there is no answer left
 * to wait for. Only a fixed name from the caller's list is read; anything else
 * is not a refusal (T3: a named refusal ends the step, it is never held).
 */
export function parseGuestStepRefusal<T extends string>(stdout: unknown, names: readonly T[]): T | null {
  if (typeof stdout !== "string") return null;
  const lines = stdout.split("\n").filter((line) => line.startsWith("HIVRA_GUEST_STEP_REFUSED "));
  if (lines.length !== 1) return null;
  const reason = lines[0].slice("HIVRA_GUEST_STEP_REFUSED ".length).trim();
  return (names as readonly string[]).includes(reason) ? reason as T : null;
}

/** Linux refuses to exec with any one argument of 128 KiB or more
 * (MAX_ARG_STRLEN, counting its NUL): `Argument list too long`, before the VM
 * is ever checked. The step body is one argument (to python3, then bash), so
 * a guest program's stdin never travels inside it. */
export const HOST_ARGUMENT_MAX_BYTES = 128 * 1024 - 1;

function underHostLock(body: string): string {
  if (Buffer.byteLength(body, "utf8") > HOST_ARGUMENT_MAX_BYTES) throw new Error("Attachment host step exceeds the host argument limit.");
  return `#!/usr/bin/env bash\nset -Eeuo pipefail\nexec /usr/bin/python3 -I -B -c ${shellQuote(ATTACHMENT_HOST_LOCK_PROGRAM)} ${shellQuote(body)}\n`;
}

/**
 * One guest step that may run for minutes (stage, activate, Change access,
 * Remove). The host allocation lock is held only while the VM is checked and
 * the program is handed to its guest agent; it is released before the wait,
 * so launches, starts, restarts and snapshots on the same host never queue
 * behind an attach step. Only the wait gets the step's deadline.
 *
 * The program's stdin is the host script's own stdin: run the script with
 * runProxmoxHostScriptWithStdin. An attached agent's bundle (about 150 KB) is
 * over the host's argument limit, so it never goes inside the script.
 */
export function buildAttachmentHostStepScript(input: AttachmentObservationTarget, program: string,
  guestSeconds: number): string {
  const target = Target.parse(input);
  if (!Number.isSafeInteger(guestSeconds) || guestSeconds < 1 || guestSeconds > 900) throw new Error("Invalid guest step deadline.");
  return underHostLock(`#!/usr/bin/env bash
set -Eeuo pipefail
# Keep the program's stdin aside on fd ${ATTACHMENT_HOST_STDIN_FD} so no check before the start reads it.
exec ${ATTACHMENT_HOST_STDIN_FD}<&0 </dev/null
${attachmentHostTargetCheck(target)}
${buildDetachedVmidBoundGuestExecPrelude()}
HIVRA_GUEST_PID="$(dispatch_vmid_bound_guest_exec_stdin /usr/bin/python3 -I -B -c ${shellQuote(program)} <&${ATTACHMENT_HOST_STDIN_FD})"
exec ${ATTACHMENT_HOST_STDIN_FD}<&-
# The program now runs in this exact VM. Nothing below needs the host lock.
flock -u ${ATTACHMENT_HOST_LOCK_FD}
exec ${ATTACHMENT_HOST_LOCK_FD}>&-
await_vmid_bound_guest_exec "$HIVRA_GUEST_PID" ${guestSeconds}
`);
}

/** Only invoke after owner/operation/generation admission on the resolved host.
 * This read-only probe does not reserve a boot in SQL or grant dispatch. It is
 * bounded at 20 s and keeps the lock for its whole run.
 */
export function buildAttachmentHostObservationScript(input: AttachmentObservationTarget): string {
  const target = Target.parse(input);
  return underHostLock(`#!/usr/bin/env bash
set -Eeuo pipefail
${attachmentHostTargetCheck(target)}
run_vmid_bound_guest_exec /usr/bin/python3 -I -B -c ${shellQuote(GUEST_PROBE)} ${shellQuote(JSON.stringify(target))}
`);
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
