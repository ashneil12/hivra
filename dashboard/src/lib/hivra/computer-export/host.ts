import { isIP } from "node:net";
import { shellQuote } from "../proxmox-target";
import { buildVmidBoundGuestSshPrelude } from "../vmid-bound-guest-ssh";
import { COMPUTER_EXPORT_GUEST_PYTHON } from "./guest";

export type ComputerExportHostTarget = { vmid: number; ip: string; bindingTag: string; vmSshKeyPath: string };

export class ComputerExportError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/**
 * Host script that checks the VM is the owner's exact computer (binding tag,
 * configured IP, then the QEMU-attested SSH host key) and pipes the request,
 * read from the host's stdin, into the guest program. The request (passphrase
 * and upload links included) is never part of the script or any argument.
 */
export function buildComputerExportHostScript(target: ComputerExportHostTarget): string {
  if (!Number.isSafeInteger(target.vmid) || target.vmid < 1 || isIP(target.ip) !== 4
    || !/^hivra-bind-[0-9a-f]{32}$/.test(target.bindingTag) || !target.vmSshKeyPath.startsWith("/")) {
    throw new ComputerExportError("The computer's exact guest identity is unavailable.", 409);
  }
  const program = Buffer.from(`${COMPUTER_EXPORT_GUEST_PYTHON}\nmain()\n`).toString("base64");
  return `set -euo pipefail
VMID=${target.vmid}
GUEST_IP=${shellQuote(target.ip)}
VM_KEY=${shellQuote(target.vmSshKeyPath)}
EXPECTED_BINDING_TAG=${shellQuote(target.bindingTag)}
[ "$(qm status "$VMID" | awk '{print $2}')" = running ] || exit 1
CONFIG="$(qm config "$VMID")"
printf '%s\\n' "$CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\\n' | grep -Fxq "$EXPECTED_BINDING_TAG" || exit 1
CONFIGURED_IP="$(printf '%s\\n' "$CONFIG" | sed -n 's/^ipconfig0:.*ip=\\([^, /]*\\).*/\\1/p')"
[ "$CONFIGURED_IP" = "$GUEST_IP" ] || exit 1
${buildVmidBoundGuestSshPrelude({ quiet: true })}
"\${GUEST_SSH[@]}" ${shellQuote(`sudo -n python3 -c ${shellQuote(`import base64;exec(base64.b64decode('${program}'))`)}`)}
`;
}

export function parseComputerExportResult(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n").filter((line) => line.startsWith("HIVRA_EXPORT_RESULT "));
  if (lines.length !== 1) throw new ComputerExportError("The computer did not answer the export request.", 503);
  try {
    const value: unknown = JSON.parse(lines[0].slice("HIVRA_EXPORT_RESULT ".length));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ComputerExportError("The computer returned an invalid export answer.", 503);
  }
}
