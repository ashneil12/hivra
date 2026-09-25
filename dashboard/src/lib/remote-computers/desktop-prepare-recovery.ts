import { shellQuote } from "@/lib/hivra/proxmox-target";
import { buildVmidBoundGuestExecPrelude } from "@/lib/hivra/vmid-bound-guest-exec";
import { parseDesktopPrepareReceipt } from "./desktop-prepare-guest";
import type { DesktopPrepareReceipt } from "./desktop-prepare-operation";

/**
 * Host-side fence for one preparation operation. The Ubuntu install script
 * refuses a fenced operation after taking FD8, so once recovery has observed a
 * quiescent guest and written the fence under that same lock, no late request
 * for the same lease can dispatch the guest installer again.
 */
export const DESKTOP_PREPARE_FENCE_DIRECTORY = "/var/lib/hivra/desktop-prepare-fences";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARKER = "HIVRA_DESKTOP_PREPARE_RECOVERY ";
const GUEST_MARKER = "HIVRA_DESKTOP_PREPARE_GUEST ";

type Identity = Pick<DesktopPrepareReceipt, "operationId" | "computerId" | "vmid" | "guestIp" | "bindingTag">;

// Read-only apart from a non-blocking try-lock. The guest installer holds
// installer.lock for its whole run and passes it to every child, so a free
// lock proves no installer process from any operation is alive in the guest.
export const DESKTOP_PREPARE_GUEST_OBSERVER = String.raw`import fcntl,json,os,pathlib,stat,sys
operation=sys.argv[1]
root=pathlib.Path('/var/lib/hivra/desktop-preparations')
def say(value): print('HIVRA_DESKTOP_PREPARE_GUEST '+value); raise SystemExit(0)
try: info=os.lstat(root)
except FileNotFoundError: say('absent')
if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o700: raise SystemExit(2)
try: lock_fd=os.open(root/'installer.lock',os.O_RDWR|os.O_NOFOLLOW)
except FileNotFoundError: lock_fd=None
if lock_fd is not None:
 info=os.fstat(lock_fd)
 if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o600: raise SystemExit(2)
 try: fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError: say('running')
receipt=root/(operation+'.json')
try: fd=os.open(receipt,os.O_RDONLY|os.O_NOFOLLOW)
except FileNotFoundError: say('absent')
with os.fdopen(fd,'rb') as stream:
 info=os.fstat(stream.fileno())
 if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or stat.S_IMODE(info.st_mode)!=0o600 or info.st_size>4096: raise SystemExit(2)
 value=json.loads(stream.read(4097))
if isinstance(value,dict) and 'exitCode' in value and 'phase' not in value:
 say('terminal '+json.dumps(value,separators=(',',':')))
say('exited')
`;

/**
 * One FD8-locked observation of a stale Ubuntu desktop preparation. Quiescence
 * is proven only by a stopped VM (no guest process can run) or by a free
 * guest installer lock; in either case the exact operation is fenced on the
 * host before the evidence is printed.
 */
export function buildDesktopPrepareRecoveryScript(identity: Identity): string {
  if (!UUID.test(identity.operationId) || !Number.isSafeInteger(identity.vmid) || identity.vmid < 100) {
    throw new Error("Desktop preparation recovery identity is invalid.");
  }
  return `set -euo pipefail
VMID=${identity.vmid}
OPERATION_ID=${shellQuote(identity.operationId)}
EXPECTED_BINDING_TAG=${shellQuote(identity.bindingTag)}
FENCE_DIRECTORY=${shellQuote(DESKTOP_PREPARE_FENCE_DIRECTORY)}
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "timed out waiting for desktop preparation recovery lock" >&2; exit 1; }
${buildVmidBoundGuestExecPrelude()}
report() { printf '${MARKER}%s\\n' "$1"; exit 0; }
fence_operation() {
  install -d -o 0 -g 0 -m 0700 "$FENCE_DIRECTORY"
  : > "$FENCE_DIRECTORY/$OPERATION_ID"
  sync "$FENCE_DIRECTORY/$OPERATION_ID" "$FENCE_DIRECTORY"
}
qm status "$VMID" >/dev/null 2>&1 || report "vm=missing"
TAGS="$(qm config "$VMID" | sed -n 's/^tags:[[:space:]]*//p')"
printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq "$EXPECTED_BINDING_TAG" || report "ownership=mismatch"
case "$(qm status "$VMID" | awk '/^status:/{print $2; exit}')" in
  stopped) fence_operation; report "vm=stopped installer=powered_off" ;;
  running) ;;
  *) report "vm=unknown" ;;
esac
qm guest cmd "$VMID" ping >/dev/null 2>&1 || report "vm=running installer=unreachable"
GUEST="$(run_vmid_bound_guest_exec /usr/bin/python3 -I -B -c ${shellQuote(DESKTOP_PREPARE_GUEST_OBSERVER)} "$OPERATION_ID" 2>/dev/null)" \\
  || report "vm=running installer=unreachable"
GUEST_LINE="$(printf '%s\\n' "$GUEST" | grep -m1 '^${GUEST_MARKER}' || true)"
GUEST_STATE="\${GUEST_LINE#${GUEST_MARKER}}"
case "$GUEST_STATE" in
  absent|exited) fence_operation; report "vm=running installer=$GUEST_STATE" ;;
  terminal\\ *) fence_operation; report "vm=running installer=$GUEST_STATE" ;;
  running) report "vm=running installer=running" ;;
  *) report "vm=running installer=unreachable" ;;
esac`;
}

export type DesktopPrepareRecoveryObservation =
  | { kind: "missing" }
  | { kind: "ownership_mismatch" }
  | { kind: "busy"; reason: "installer_running" | "guest_unreachable" | "vm_state_unknown" }
  | { kind: "terminal"; receipt: DesktopPrepareReceipt }
  | { kind: "quiescent"; vmStatus: "stopped"; guestInstaller: "powered_off" }
  | { kind: "quiescent"; vmStatus: "running"; guestInstaller: "absent" | "exited" };

export function parseDesktopPrepareRecoveryOutput(stdout: string, identity: Identity): DesktopPrepareRecoveryObservation | null {
  const lines = stdout.split("\n").filter(line => line.startsWith(MARKER));
  if (lines.length !== 1) return null;
  const value = lines[0].slice(MARKER.length).trim();
  if (value === "vm=missing") return { kind: "missing" };
  if (value === "ownership=mismatch") return { kind: "ownership_mismatch" };
  if (value === "vm=unknown") return { kind: "busy", reason: "vm_state_unknown" };
  if (value === "vm=stopped installer=powered_off") return { kind: "quiescent", vmStatus: "stopped", guestInstaller: "powered_off" };
  if (value === "vm=running installer=absent") return { kind: "quiescent", vmStatus: "running", guestInstaller: "absent" };
  if (value === "vm=running installer=exited") return { kind: "quiescent", vmStatus: "running", guestInstaller: "exited" };
  if (value === "vm=running installer=running") return { kind: "busy", reason: "installer_running" };
  if (value === "vm=running installer=unreachable") return { kind: "busy", reason: "guest_unreachable" };
  const terminal = value.match(/^vm=running installer=terminal (\{.*\})$/);
  if (terminal) {
    // Reuse the installer's own strict receipt parser (exact identity, boot id
    // shape, exit code). Unlike observe-only, a receipt from an earlier boot is
    // accepted: it is the installer's own atomic terminal record, not a guess.
    const receipt = parseDesktopPrepareReceipt(`HIVRA_DESKTOP_PREPARE_TERMINAL ${terminal[1]}`, identity);
    return receipt ? { kind: "terminal", receipt } : null;
  }
  return null;
}
