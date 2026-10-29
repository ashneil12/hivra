// Host -> guest delivery pinned to one VMID, for seeders that carry secrets
// (tool MCP credentials) onto a running Hivra CLI box.
//
// A stored guest IP is not an identity: after an IP collision or a stale
// neighbour entry it can reach another tenant's VM, and with host-key
// checking off nothing notices. So the host script refuses unless the VMID is
// running, carries the agent's owner binding tag and is configured with the
// stored IP, then pins SSH to the guest host key QEMU Guest Agent attests for
// that VMID (buildVmidBoundGuestSshPrelude). A box that cannot be pinned
// receives nothing. Same rules as the Bankr wallet env seeder.

import { isIP } from "node:net";

import { shellQuote } from "@/lib/hivra/proxmox-target";
import { buildVmidBoundGuestSshPrelude } from "@/lib/hivra/vmid-bound-guest-ssh";

const BINDING_TAG = /^hivra-bind-[0-9a-f]{32}$/;

/** The exact guest a seeder may reach. */
export interface PinnedGuestTarget {
  vmid: number;
  ip: string;
  bindingTag: string;
  vmSshKeyPath: string;
}

/**
 * What a seeder reads from the agent's resolved execution context
 * (HivraAgentExecutionContext): the agent's owner binding tag and the
 * host-side key for guest SSH.
 */
export interface PinnedGuestAuthority {
  infrastructureBindingTag: string;
  infrastructureBindingTagEnforced: boolean;
  paths: { vmSshKeyPath: string | null };
}

export type PinnedGuestTargetResult =
  | { ok: true; target: PinnedGuestTarget }
  | { ok: false; reason: string };

function isValidPinnedGuestTarget(target: PinnedGuestTarget): boolean {
  return Number.isSafeInteger(target.vmid) && target.vmid >= 100 && isIP(target.ip) === 4
    && BINDING_TAG.test(target.bindingTag) && target.vmSshKeyPath.startsWith("/");
}

export function resolvePinnedGuestTarget(
  agent: { ip?: string | null; vmid?: number | null },
  authority: PinnedGuestAuthority,
): PinnedGuestTargetResult {
  const ip = (agent.ip || "").trim();
  if (isIP(ip) !== 4) return { ok: false, reason: "missing or invalid box ip" };
  const vmid = Number(agent.vmid ?? NaN);
  if (!Number.isSafeInteger(vmid) || vmid < 100) return { ok: false, reason: "missing or invalid vmid" };
  // An unenforced binding means the VM may not carry the tag, so the host
  // can't prove which guest it is talking to.
  if (authority.infrastructureBindingTagEnforced !== true || !BINDING_TAG.test(authority.infrastructureBindingTag ?? "")) {
    return { ok: false, reason: "no enforced owner binding tag" };
  }
  const vmSshKeyPath = authority.paths?.vmSshKeyPath ?? "";
  if (!vmSshKeyPath.startsWith("/")) return { ok: false, reason: "no pinned guest SSH key" };
  return { ok: true, target: { vmid, ip, bindingTag: authority.infrastructureBindingTag, vmSshKeyPath } };
}

// Host script (runs as root on the Proxmox host). Streams the base64-wrapped
// guest script over STDIN to the VMID-attested guest, which runs it as root.
// The guest script only ever travels inside the script body, never in a
// process argument.
export function buildPinnedGuestHostScript(target: PinnedGuestTarget, guestScript: string): string {
  if (!isValidPinnedGuestTarget(target)) throw new Error("Invalid Hivra guest target");
  const outer = Buffer.from(guestScript, "utf8").toString("base64");
  return `#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
VMID=${target.vmid}
GUEST_IP=${shellQuote(target.ip)}
VM_KEY=${shellQuote(target.vmSshKeyPath)}
EXPECTED_BINDING_TAG=${shellQuote(target.bindingTag)}
[ -f "$VM_KEY" ] || { echo "vm key missing" >&2; exit 1; }
[ "$(qm status "$VMID" 2>/dev/null | awk '{print $2}')" = running ] || { echo "VM $VMID is not running" >&2; exit 1; }
VM_CONFIG="$(qm config "$VMID")"
printf '%s\\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\\n' | grep -Fxq "$EXPECTED_BINDING_TAG" \\
  || { echo "VM $VMID does not carry this agent's owner binding tag" >&2; exit 1; }
printf '%s\\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\\n' | grep -Fxq "ip=$GUEST_IP/24" \\
  || { echo "VM $VMID is not configured with the stored guest ip" >&2; exit 1; }
${buildVmidBoundGuestSshPrelude()}
printf '%s' '${outer}' | "\${GUEST_SSH[@]}" 'base64 -d | sudo -n bash'
`;
}
