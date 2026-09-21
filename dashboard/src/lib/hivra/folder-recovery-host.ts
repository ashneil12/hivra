import { isIP } from "node:net";
import { shellQuote } from "./proxmox-target";
import { buildVmidBoundGuestSshPrelude } from "./vmid-bound-guest-ssh";
import { FOLDER_RECOVERY_GUEST_PYTHON } from "./folder-recovery-guest";
import { FolderRecoveryError, type FolderRecoveryEntry } from "./folder-recovery-artifact";

export type FolderRecoveryHostTarget = { vmid: number; ip: string; bindingTag: string; vmSshKeyPath: string };
export function buildFolderRecoveryHostScript(target: FolderRecoveryHostTarget, request:
  | { action: "export" }
  | { action: "restore"; operationId: string; artifactSha256: string; tokenSha256: string; entries: FolderRecoveryEntry[] },
): string {
  if (!Number.isSafeInteger(target.vmid) || target.vmid < 1 || isIP(target.ip) !== 4
    || !/^hivra-bind-[0-9a-f]{32}$/.test(target.bindingTag) || !target.vmSshKeyPath.startsWith("/")) {
    throw new FolderRecoveryError("The computer's exact guest identity is unavailable.", 409);
  }
  // Files/passphrases are never command-line arguments. Program bytes and JSON
  // go through SSH stdin. QGA attestation occurs after exact VM tag and IP checks.
  const program = Buffer.from(`${FOLDER_RECOVERY_GUEST_PYTHON}\nmain()\n`).toString("base64");
  const payload = Buffer.from(JSON.stringify(request)).toString("base64");
  return `set -euo pipefail
VMID=${target.vmid}
GUEST_IP=${shellQuote(target.ip)}
VM_KEY=${shellQuote(target.vmSshKeyPath)}
EXPECTED_BINDING_TAG=${shellQuote(target.bindingTag)}
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 45 8 || exit 1
[ "$(qm status "$VMID" | awk '{print $2}')" = running ] || exit 1
CONFIG="$(qm config "$VMID")"
printf '%s\n' "$CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\n' | grep -Fxq "$EXPECTED_BINDING_TAG" || exit 1
CONFIGURED_IP="$(printf '%s\n' "$CONFIG" | sed -n 's/^ipconfig0:.*ip=\\([^, /]*\\).*/\\1/p')"
[ "$CONFIGURED_IP" = "$GUEST_IP" ] || exit 1
${buildVmidBoundGuestSshPrelude()}
printf '%s' ${shellQuote(payload)} | base64 -d | "\${GUEST_SSH[@]}" ${shellQuote(`sudo -n python3 -c ${shellQuote(`import base64;exec(base64.b64decode('${program}'))`)}`)}
`;
}

export function parseFolderRecoveryHostResult(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n").filter((line) => line.startsWith("HIVRA_FOLDER_RESULT "));
  if (lines.length !== 1) throw new FolderRecoveryError("Computer verification was incomplete. No success has been recorded.", 503);
  try {
    const value: unknown = JSON.parse(lines[0].slice("HIVRA_FOLDER_RESULT ".length));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new FolderRecoveryError("The computer returned invalid folder evidence.", 503); }
}
