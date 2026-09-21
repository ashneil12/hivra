// Hivra Bankr wallet env seeding — push a provisioned per-box Bankr wallet's
// credentials onto a running Hivra CLI box so its agent can transact.
//
// The Hermes lane injects these as `BANKR_*` env into the agent config YAML at
// build time (webui-instance-builder.ts → buildBankrEnvLines). A Hivra box is
// provisioned by an out-of-repo provisioner and the wallet is created LAZILY
// after launch, so we deliver the creds post-provision over the same host->guest
// SSH path as the skills seeder: write `~/.hivra/bankr.env` (0600, bux-owned).
// The box's chat server sources that file into the agent CLI's environment on
// each spawn (no restart needed) — see hivra-provisioner hivra-chat/server.js.

import { runProxmoxHostScript, type HostScriptResult } from "@/lib/services/proxmox-instance-service";
import type { InstanceBankrAgentConfig } from "@/lib/billing/bankr-instance-wallets";
import { bankrSkillsDirForType } from "@/lib/hivra/bankr-skills-seed";

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

// Host script (runs as root on the Proxmox host). Streams the base64-wrapped
// guest script to the guest over STDIN. Same key + ssh opts as the provisioner.
export function buildBankrEnvHostScript(ip: string, guestScript: string): string {
  const outer = b64(guestScript);
  return `#!/usr/bin/env bash
set -euo pipefail
KEY=/etc/hivra/keys/vm-orchestrator
[ -f "$KEY" ] || { echo "vm key $KEY missing" >&2; exit 1; }
printf '%s' '${outer}' | ssh -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o BatchMode=yes "ubuntu@${ip}" "base64 -d | sudo bash"
`;
}

export interface BankrEnvSeedAgent {
  id: string;
  type?: string | null;
  ip?: string | null;
}

export interface BankrEnvSeedResult {
  ok: boolean;
  skipped?: "unsupported_type";
  error?: string;
}

// Write the wallet creds onto a running CLI box. Best-effort; the caller logs
// failures (the wallet row is already provisioned, so this can be retried).
export async function seedBankrWalletEnvOntoBox(
  agent: BankrEnvSeedAgent,
  cfg: InstanceBankrAgentConfig,
  env: Parameters<typeof runProxmoxHostScript>[1],
): Promise<BankrEnvSeedResult> {
  // Same CLI-only scope as the skills seeder (codex / claude-code).
  if (!bankrSkillsDirForType(agent.type)) return { ok: false, skipped: "unsupported_type" };
  const ip = (agent.ip || "").trim();
  if (!/^[0-9.]+$/.test(ip)) return { ok: false, error: "missing or invalid box ip" };

  const script = buildBankrEnvHostScript(ip, buildBankrEnvGuestScript(buildBankrEnvFileContent(cfg)));
  let res: HostScriptResult;
  try {
    res = await runProxmoxHostScript(script, env, 30_000);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (res.ok && /HIVRA_BANKR_ENV_OK/.test(res.stdout || "")) return { ok: true };
  return { ok: false, error: (res.error || res.stderr || "env seed failed").slice(0, 200) };
}
