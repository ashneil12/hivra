// Hivra Bankr wallet env seeding — push a provisioned per-box Bankr wallet's
// credentials onto a running Hivra CLI box so its agent can transact.
//
// The Hermes lane injects these as `BANKR_*` env into the agent config YAML at
// build time (webui-instance-builder.ts → buildBankrEnvLines). A Hivra box is
// provisioned by an out-of-repo provisioner and the wallet is created LAZILY
// after launch, so we deliver the creds post-provision over host->guest SSH:
// write `~/.hivra/bankr.env` (0600, bux-owned). The box's chat server sources
// that file into the agent CLI's environment on each spawn (no restart needed)
// — see hivra-provisioner hivra-chat/server.js.
//
// The key is a secret, so it only travels over the VMID-bound path: the host
// checks the exact VM's owner binding tag and configured IP, then pins SSH to
// the guest host key QEMU Guest Agent attests for that VMID. A stored guest IP
// alone is not an identity: after an IP collision it can reach another
// tenant's VM. A box that cannot be pinned never receives the key.

import { isIP } from "node:net";

import { runProxmoxHostScript, type HostScriptResult } from "@/lib/services/proxmox-instance-service";
import type { InstanceBankrAgentConfig } from "@/lib/billing/bankr-instance-wallets";
import { bankrSkillsDirForType } from "@/lib/hivra/bankr-skills-seed";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { buildVmidBoundGuestSshPrelude } from "@/lib/hivra/vmid-bound-guest-ssh";

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

// KEY=VALUE env file. We emit every alias the Hermes lane + the curated Bankr
// skills look for (BANKR_API_KEY is the primary; WALLET_ADDRESS is what the
// 0xwork/read-only skills read), so a skill written for either lane just works.
export function buildBankrEnvFileContent(cfg: InstanceBankrAgentConfig): string {
  const lines = [
    `BANKR_API_KEY=${cfg.apiKey}`,
    `BANKR_AGENT_API_KEY=${cfg.apiKey}`,
    `WALLET_ADDRESS=${cfg.walletAddress}`,
    `BANKR_WALLET_ADDRESS=${cfg.walletAddress}`,
    `BANKR_AGENT_WALLET_ADDRESS=${cfg.walletAddress}`,
    `BANKR_AGENT_WALLET_ID=${cfg.walletId}`,
  ];
  if (cfg.withdrawalDestination) {
    lines.push(`BANKR_AGENT_WITHDRAWAL_DESTINATION=${cfg.withdrawalDestination}`);
  }
  return lines.join("\n") + "\n";
}

// Guest script (runs as root via sudo on the box). Writes the env file 0600 and
// bux-owned. base64-wrapped so no credential ever touches the shell.
export function buildBankrEnvGuestScript(envContent: string): string {
  return `set -e
BUX=/home/bux
[ -d "$BUX" ] || { echo "no box home" >&2; exit 1; }
umask 077
mkdir -p "$BUX/.hivra"
printf '%s' '${b64(envContent)}' | base64 -d > "$BUX/.hivra/bankr.env"
chown -R bux:bux "$BUX/.hivra" 2>/dev/null || true
chmod 0600 "$BUX/.hivra/bankr.env" 2>/dev/null || true
echo HIVRA_BANKR_ENV_OK
`;
}

const BINDING_TAG = /^hivra-bind-[0-9a-f]{32}$/;

/** The exact guest a wallet env script may reach. */
export interface BankrEnvGuestTarget {
  vmid: number;
  ip: string;
  bindingTag: string;
  vmSshKeyPath: string;
}

function isValidGuestTarget(target: BankrEnvGuestTarget): boolean {
  return Number.isSafeInteger(target.vmid) && target.vmid >= 100 && isIP(target.ip) === 4
    && BINDING_TAG.test(target.bindingTag) && target.vmSshKeyPath.startsWith("/");
}

// Host script (runs as root on the Proxmox host). Refuses unless VMID is
// running, carries the agent's owner binding tag and is configured with the
// stored IP, then streams the base64-wrapped guest script over STDIN to the
// guest whose SSH host key QEMU Guest Agent attests for that VMID. The key is
// only ever inside the script body, never in a process argument.
export function buildBankrEnvHostScript(target: BankrEnvGuestTarget, guestScript: string): string {
  if (!isValidGuestTarget(target)) throw new Error("Invalid Hivra wallet env target");
  const outer = b64(guestScript);
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

export interface BankrEnvSeedAgent {
  id: string;
  type?: string | null;
  ip?: string | null;
  vmid?: number | null;
}

/**
 * What the helpers read from the agent's resolved execution context
 * (HivraAgentExecutionContext): the host connection, the agent's owner binding
 * tag and the host-side key for guest SSH.
 */
export interface BankrEnvGuestAuthority {
  env: Parameters<typeof runProxmoxHostScript>[1];
  infrastructureBindingTag: string;
  infrastructureBindingTagEnforced: boolean;
  paths: { vmSshKeyPath: string | null };
}

export interface BankrEnvSeedResult {
  ok: boolean;
  skipped?: "unsupported_type";
  /** The box couldn't be pinned to its VMID, so nothing was sent and a retry won't help. */
  reason?: "identity_unverifiable";
  error?: string;
}

// Guest script that deletes the wallet env file. The chat server re-reads it
// on every spawn, so the agent's next turn runs without the key.
export function buildBankrEnvRemoveGuestScript(): string {
  return `set -e
BUX=/home/bux
[ -d "$BUX" ] || { echo "no box home" >&2; exit 1; }
rm -f "$BUX/.hivra/bankr.env"
[ ! -e "$BUX/.hivra/bankr.env" ] || { echo "bankr.env still present" >&2; exit 1; }
echo HIVRA_BANKR_ENV_REMOVED
`;
}

type PinnedGuestTarget = { ok: true; target: BankrEnvGuestTarget } | { ok: false; reason: string };

function pinnedGuestTarget(agent: BankrEnvSeedAgent, authority: BankrEnvGuestAuthority): PinnedGuestTarget {
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

async function runBankrEnvGuestScript(
  agent: BankrEnvSeedAgent,
  guestScript: string,
  okMarker: RegExp,
  authority: BankrEnvGuestAuthority,
  failurePrefix: string,
): Promise<BankrEnvSeedResult> {
  // Same CLI-only scope as the skills seeder (codex / claude-code).
  if (!bankrSkillsDirForType(agent.type)) return { ok: false, skipped: "unsupported_type" };
  const pinned = pinnedGuestTarget(agent, authority);
  if (!pinned.ok) {
    return {
      ok: false,
      reason: "identity_unverifiable",
      error: `${failurePrefix}: this box's identity can't be verified (${pinned.reason}), so nothing was sent to it`,
    };
  }

  let res: HostScriptResult;
  try {
    res = await runProxmoxHostScript(buildBankrEnvHostScript(pinned.target, guestScript), authority.env, 30_000);
  } catch (e) {
    return { ok: false, error: `${failurePrefix}: ${(e as Error).message.slice(0, 200)}` };
  }
  if (res.ok && okMarker.test(res.stdout || "")) return { ok: true };
  return { ok: false, error: `${failurePrefix}: ${(res.error || res.stderr || "env script failed").slice(0, 200)}` };
}

// Write the wallet creds onto a running CLI box. Best-effort; the caller logs
// failures (the wallet row is already provisioned, so this can be retried).
// Fails closed: a box that can't be pinned to its VMID gets nothing.
export async function seedBankrWalletEnvOntoBox(
  agent: BankrEnvSeedAgent,
  cfg: InstanceBankrAgentConfig,
  authority: BankrEnvGuestAuthority,
): Promise<BankrEnvSeedResult> {
  return runBankrEnvGuestScript(
    agent,
    buildBankrEnvGuestScript(buildBankrEnvFileContent(cfg)),
    /HIVRA_BANKR_ENV_OK/,
    authority,
    "wallet key write failed",
  );
}

// Remove the wallet creds from a running CLI box (user disconnected their
// Bankr account). Best-effort like the seed; the caller reports the outcome.
// Also fails closed, and every failure says the file may still be there.
export async function removeBankrWalletEnvFromBox(
  agent: BankrEnvSeedAgent,
  authority: BankrEnvGuestAuthority,
): Promise<BankrEnvSeedResult> {
  return runBankrEnvGuestScript(
    agent,
    buildBankrEnvRemoveGuestScript(),
    /HIVRA_BANKR_ENV_REMOVED/,
    authority,
    "wallet key file removal failed, so it may still be on the box",
  );
}
