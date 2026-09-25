import "server-only";

import { buildVmidBoundGuestSshPrelude } from "@/lib/hivra/vmid-bound-guest-ssh";
import {
  resolveHivraAgentExecutionContext,
  type HivraAgentExecutionContext,
  type HivraAgentInfrastructureBinding,
} from "@/lib/hivra/agent-execution-context";
import {
  runProxmoxHostScript,
  runProxmoxHostScriptWithStdin,
  type HostScriptResult,
} from "@/lib/services/proxmox-instance-service";
import {
  buildTailscaleInstallScript,
  parseTailscaleStatusJson,
} from "@/lib/services/tailscale-private-access";
import { privateNetworkReason, type PrivateNetworkReason } from "@/lib/hivra/lifecycle-support";

export const DEFAULT_TAILSCALE_LOGIN_SERVER = "https://controlplane.tailscale.com";

export type HivraPrivateAccessAgentRow = HivraAgentInfrastructureBinding & {
  id: string;
  user_id: string;
  type: string;
  computer_profile: string | null;
  status: string;
  desired_state: string;
  operation_id: string | null;
  operation_kind: string | null;
  vmid: number | null;
  ip: string | null;
  managed_provisioner_channel?: unknown;
};

export type HivraTailscaleReceipt = {
  state: "connected" | "disconnected" | "unknown" | "error";
  machineName?: string;
  magicDnsName?: string;
  tailnetName?: string;
  ipv4?: string;
  ipv6?: string;
  sshEnabled: false;
  loginServer: string;
  connectedAt?: string;
  observedAt: string;
  failureCode?: string;
};

type Dependencies = {
  resolveContext: typeof resolveHivraAgentExecutionContext;
  runHostScript: typeof runProxmoxHostScript;
  runHostScriptWithStdin: typeof runProxmoxHostScriptWithStdin;
  now: () => Date;
};

const defaults: Dependencies = {
  resolveContext: resolveHivraAgentExecutionContext,
  runHostScript: runProxmoxHostScript,
  runHostScriptWithStdin: runProxmoxHostScriptWithStdin,
  now: () => new Date(),
};

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const BINDING_TAG = /^hivra-bind-[a-f0-9]{32}$/;
const MARKER = "HIVRA_TAILSCALE_STATUS ";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function bounded(value: unknown, maximum = 253): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum ? trimmed : undefined;
}

export function normalizeTailscaleLoginServer(value: unknown): string | null {
  if (value == null || value === "") return DEFAULT_TAILSCALE_LOGIN_SERVER;
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function hivraPrivateAccessAuthority(agent: HivraPrivateAccessAgentRow): Record<string, unknown> {
  return {
    id: agent.id,
    user_id: agent.user_id,
    type: agent.type,
    computer_profile: agent.computer_profile,
    computer_substrate: agent.computer_substrate ?? null,
    deployment_mode: agent.deployment_mode ?? null,
    proxmox_host: agent.proxmox_host ?? null,
    infrastructure_connection_id: agent.infrastructure_connection_id ?? null,
    deployment_target_id: agent.deployment_target_id ?? null,
    infrastructure_connection_revision: agent.infrastructure_connection_revision ?? null,
    infrastructure_binding_token_hash: agent.infrastructure_binding_token_hash ?? null,
    infrastructure_binding_token_enforced: agent.infrastructure_binding_token_enforced ?? null,
    vmid: agent.vmid,
    ip: agent.ip,
    managed_provisioner_channel: typeof agent.managed_provisioner_channel === "string"
      ? agent.managed_provisioner_channel : "default",
  };
}

export function sameHivraPrivateAccessAuthority(left: unknown, right: Record<string, unknown>): boolean {
  if (!left || typeof left !== "object" || Array.isArray(left)) return false;
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)]));
  };
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

/**
 * A running, owner-bound Ubuntu computer on Proxmox with no operation in
 * progress. The static half (kind and binding) and the live half (running,
 * idle, addressable) live in lifecycle-support.ts, which Manage shares, so the
 * reason a computer is refused is the one Manage shows.
 */
export function isCompatibleHivraPrivateAccessAgent(agent: HivraPrivateAccessAgentRow): boolean {
  return privateNetworkReason(agent) === null;
}

/** Why the computer can't use a private network right now, or null. */
export function hivraPrivateAccessReason(agent: HivraPrivateAccessAgentRow): PrivateNetworkReason | null {
  return privateNetworkReason(agent);
}

export function buildHivraTailscaleGuestInvocation(program: string): string {
  const encoded = Buffer.from(program, "utf8").toString("base64");
  const launcher = `import base64,os;os.execv('/bin/bash',['bash','-c',base64.b64decode('${encoded}').decode()])`;
  // OpenSSH joins every command argument with spaces before handing it to the
  // remote login shell. Quote the complete command for the local shell so it
  // arrives as one argument, while retaining the inner Python argument quotes
  // for that remote shell to parse.
  return shellQuote(`sudo -n /usr/bin/python3 -c ${shellQuote(launcher)}`);
}

function buildHostScript(input: {
  vmid: number;
  guestIp: string;
  vmKeyPath: string;
  bindingTag: string;
  guestProgram: string;
  secretStdin: boolean;
}): string {
  if (!Number.isSafeInteger(input.vmid) || input.vmid < 100 || !IPV4.test(input.guestIp)
    || !input.vmKeyPath.startsWith("/") || !BINDING_TAG.test(input.bindingTag)) {
    throw new Error("Invalid Hivra private access target");
  }
  return `#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
VMID=${input.vmid}
GUEST_IP=${shellQuote(input.guestIp)}
VM_KEY=${shellQuote(input.vmKeyPath)}
EXPECTED_BINDING_TAG=${shellQuote(input.bindingTag)}
[ "$(qm status "$VMID" 2>/dev/null | awk '{print $2}')" = running ]
VM_CONFIG="$(qm config "$VMID")"
printf '%s\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\n' | grep -Fxq "$EXPECTED_BINDING_TAG"
printf '%s\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\n' | grep -Fxq "ip=$GUEST_IP/24"
${buildVmidBoundGuestSshPrelude()}
${input.secretStdin ? `IFS= read -r TAILSCALE_AUTH_KEY
[ -n "$TAILSCALE_AUTH_KEY" ]
printf '%s\n' "$TAILSCALE_AUTH_KEY" | "\${GUEST_SSH[@]}" ${buildHivraTailscaleGuestInvocation(input.guestProgram)}
unset TAILSCALE_AUTH_KEY` : `"\${GUEST_SSH[@]}" ${buildHivraTailscaleGuestInvocation(input.guestProgram)}`}
`;
}

const STATUS_PROGRAM = `set -euo pipefail
if ! command -v tailscale >/dev/null 2>&1; then
  printf '${MARKER}{"BackendState":"NeedsLogin"}\n'
  exit 0
fi
python3 - <<'PY'
import json, subprocess
try:
    status=json.loads(subprocess.check_output(["tailscale","status","--json"], text=True, stderr=subprocess.DEVNULL))
except Exception:
    print('${MARKER}{"BackendState":"Unknown"}')
else:
    try:
        prefs=json.loads(subprocess.check_output(["tailscale","debug","prefs"], text=True, stderr=subprocess.DEVNULL))
        status["HivraPrefs"]={key:prefs.get(key) for key in ("RunSSH","ControlURL","RouteAll","AdvertiseRoutes","ExitNodeID","ExitNodeIP")}
    except Exception:
        status["HivraPrefs"]=None
    print('${MARKER}'+json.dumps(status, separators=(',',':')))
PY`;

export function buildHivraTailscaleConnectProgram(loginServer: string): string {
  const install = buildTailscaleInstallScript();
  return `set -euo pipefail
umask 077
AUTH_FILE="$(mktemp /run/hivra-tailscale-auth.XXXXXXXX)"
cleanup() { rm -f -- "$AUTH_FILE"; }
trap cleanup EXIT HUP INT TERM
IFS= read -r AUTH_KEY
[ -n "$AUTH_KEY" ] && [ "\${#AUTH_KEY}" -le 1024 ]
printf '%s' "$AUTH_KEY" > "$AUTH_FILE"
unset AUTH_KEY
${install}
tailscale up --reset --auth-key="file:$AUTH_FILE" --login-server=${shellQuote(loginServer)} --ssh=false --accept-routes=false --advertise-exit-node=false
rm -f -- "$AUTH_FILE"
${STATUS_PROGRAM}`;
}

function disconnectProgram(): string {
  return `set -euo pipefail
if command -v tailscale >/dev/null 2>&1; then
  tailscale logout
fi
printf '${MARKER}{"BackendState":"NeedsLogin"}\n'`;
}

function parseConnectionPresence(stdout: string): boolean | null {
  const lines = stdout.split("\n").filter(line => line.startsWith(MARKER));
  if (lines.length !== 1) return null;
  try {
    const raw = JSON.parse(lines[0].slice(MARKER.length)) as { BackendState?: unknown };
    if (raw.BackendState === "Running") return true;
    if (raw.BackendState === "NeedsLogin") return false;
    return null;
  } catch {
    return null;
  }
}

function resultFailureCode(result: HostScriptResult): string {
  const message = result.error ?? "";
  if (/timed out/i.test(message)) return "host_timeout";
  if (/output exceeded/i.test(message)) return "host_output_limit";
  if (/SSH connection failed|SSH exec failed|SSH connect threw|code 255/i.test(message)) return "guest_unreachable";
  return "guest_command_failed";
}

export function parseHivraTailscaleReceipt(
  stdout: string,
  loginServer: string,
  now = new Date(),
): HivraTailscaleReceipt | null {
  const lines = stdout.split("\n").filter(line => line.startsWith(MARKER));
  if (lines.length !== 1) return null;
  try {
    const raw = JSON.parse(lines[0].slice(MARKER.length)) as {
      BackendState?: unknown;
      Self?: { Online?: unknown };
      HivraPrefs?: { RunSSH?: unknown; ControlURL?: unknown; RouteAll?: unknown;
        AdvertiseRoutes?: unknown; ExitNodeID?: unknown; ExitNodeIP?: unknown };
    };
    const backend = bounded(raw.BackendState, 64) ?? "Unknown";
    const observedAt = now.toISOString();
    if (backend !== "Running" || raw.Self?.Online === false) {
      return { state: backend === "NeedsLogin" ? "disconnected" : "unknown", sshEnabled: false,
        loginServer, observedAt, ...(backend === "Unknown" ? { failureCode: "status_unknown" } : {}) };
    }
    const snapshot = parseTailscaleStatusJson(lines[0].slice(MARKER.length));
    const prefs = raw.HivraPrefs;
    if (!prefs) return null;
    const hasPreference = (key: string) => Object.prototype.hasOwnProperty.call(prefs, key);
    const routesAreEmpty = hasPreference("AdvertiseRoutes")
      && (prefs?.AdvertiseRoutes === null
        || (Array.isArray(prefs?.AdvertiseRoutes) && prefs.AdvertiseRoutes.length === 0));
    const exitNodeIdIsEmpty = hasPreference("ExitNodeID")
      && (prefs?.ExitNodeID === null || prefs.ExitNodeID === "");
    const exitNodeIpIsEmpty = hasPreference("ExitNodeIP")
      && (prefs?.ExitNodeIP === null || prefs.ExitNodeIP === "");
    if (prefs.RunSSH !== false || prefs.RouteAll !== false
      || !routesAreEmpty || !exitNodeIdIsEmpty || !exitNodeIpIsEmpty
      || normalizeTailscaleLoginServer(prefs.ControlURL) !== loginServer
      || snapshot.sshEnabled === true) return null;
    const ipv4 = bounded(snapshot.ipv4, 45);
    const ipv6 = bounded(snapshot.ipv6, 64);
    if (!ipv4 || !IPV4.test(ipv4)) return null;
    return {
      state: "connected",
      machineName: bounded(snapshot.machineName),
      magicDnsName: bounded(snapshot.magicDnsName),
      tailnetName: bounded(snapshot.tailnetName),
      ipv4,
      ...(ipv6 ? { ipv6 } : {}),
      sshEnabled: false,
      loginServer,
      connectedAt: observedAt,
      observedAt,
    };
  } catch {
    return null;
  }
}

const DELETE_SKIPPED_MARKER = "HIVRA_TAILSCALE_DELETE ";

export type HivraTailscaleDeletePreparation = {
  ok: boolean;
  disposition: "guest_logged_out" | "guest_stopped" | "provider_absent" | "unconfirmed";
  failureCode?: string;
};

/**
 * Revokes Hivra-managed guest credentials before a Proxmox VM is destroyed.
 * A stopped guest is never booted solely for logout: the immediately following
 * verified destroy removes its node key from the guest disk, although the
 * coordination server may retain an offline device record.
 */
export async function prepareHivraTailscaleForDelete(
  agent: HivraPrivateAccessAgentRow,
  context: HivraAgentExecutionContext,
  dependencies: Partial<Dependencies> = {},
): Promise<HivraTailscaleDeletePreparation> {
  const deps = { ...defaults, ...dependencies };
  if (agent.operation_kind !== "delete" || agent.desired_state !== "deleted"
    || typeof agent.operation_id !== "string" || !agent.infrastructure_binding_token_enforced
    || agent.computer_substrate !== "proxmox-kvm" || !Number.isSafeInteger(agent.vmid)
    || Number(agent.vmid) < 100 || typeof agent.ip !== "string" || !IPV4.test(agent.ip)) {
    return { ok: false, disposition: "unconfirmed", failureCode: "authority_unavailable" };
  }
  try {
    if (!context.infrastructureBindingTagEnforced || !context.paths.vmSshKeyPath) {
      return { ok: false, disposition: "unconfirmed", failureCode: "binding_unavailable" };
    }
    const vmid = Number(agent.vmid);
    const prefix = `#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
VMID=${vmid}
if ! qm status "$VMID" >/dev/null 2>&1; then
  VM_LIST="$(qm list 2>/dev/null)" \\
    || { echo "could not verify provider absence before private-access cleanup" >&2; exit 1; }
  if printf '%s\\n' "$VM_LIST" | awk -v vmid="$VMID" 'NR > 1 && $1 == vmid { found=1 } END { exit found ? 0 : 1 }'; then
    echo "VM status query failed while provider inventory still contains the VM" >&2
    exit 1
  fi
  printf '${DELETE_SKIPPED_MARKER}provider_absent\\n'
  exit 0
fi
GUEST_IP=${shellQuote(agent.ip)}
EXPECTED_BINDING_TAG=${shellQuote(context.infrastructureBindingTag)}
VM_CONFIG="$(qm config "$VMID")"
printf '%s\\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\\n' | grep -Fxq "$EXPECTED_BINDING_TAG"
printf '%s\\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\\n' | grep -Fxq "ip=$GUEST_IP/24"
if [ "$(qm status "$VMID" | awk '{print $2}')" != running ]; then
  printf '${DELETE_SKIPPED_MARKER}guest_stopped\\n'
  exit 0
fi
VM_KEY=${shellQuote(context.paths.vmSshKeyPath)}
${buildVmidBoundGuestSshPrelude()}
"\${GUEST_SSH[@]}" ${buildHivraTailscaleGuestInvocation(disconnectProgram())}`;
    const result = await deps.runHostScript(prefix, context.env, { timeoutMs: 60_000, maxOutputBytes: 16 * 1024 });
    if (!result.ok) return { ok: false, disposition: "unconfirmed", failureCode: resultFailureCode(result) };
    if (result.stdout.includes(`${DELETE_SKIPPED_MARKER}provider_absent`)) {
      return { ok: true, disposition: "provider_absent" };
    }
    if (result.stdout.includes(`${DELETE_SKIPPED_MARKER}guest_stopped`)) {
      return { ok: true, disposition: "guest_stopped" };
    }
    const receipt = parseHivraTailscaleReceipt(result.stdout, DEFAULT_TAILSCALE_LOGIN_SERVER, deps.now());
    return receipt?.state === "disconnected"
      ? { ok: true, disposition: "guest_logged_out" }
      : { ok: false, disposition: "unconfirmed", failureCode: "guest_command_failed" };
  } catch {
    return { ok: false, disposition: "unconfirmed", failureCode: "authority_unavailable" };
  }
}

async function execution(agent: HivraPrivateAccessAgentRow, deps: Dependencies, allowPrivateAccessOperation = false) {
  const resumable = allowPrivateAccessOperation && agent.operation_kind === "private_access"
    && typeof agent.operation_id === "string";
  if (!isCompatibleHivraPrivateAccessAgent({ ...agent,
    ...(resumable ? { operation_id: null, operation_kind: null, desired_state: "running" } : {}) })) throw new Error("computer_not_ready");
  const context = await deps.resolveContext(agent.user_id, agent);
  if (!context.infrastructureBindingTagEnforced || !context.paths.vmSshKeyPath) {
    throw new Error("binding_unavailable");
  }
  return { context, vmid: Number(agent.vmid), guestIp: agent.ip as string };
}

export async function observeHivraTailscale(
  agent: HivraPrivateAccessAgentRow,
  loginServer = DEFAULT_TAILSCALE_LOGIN_SERVER,
  dependencies: Partial<Dependencies> = {},
): Promise<{ ok: boolean; receipt: HivraTailscaleReceipt; connectionPresent: boolean | null }> {
  const deps = { ...defaults, ...dependencies };
  try {
    const target = await execution(agent, deps, true);
    const result = await deps.runHostScript(buildHostScript({
      vmid: target.vmid, guestIp: target.guestIp, vmKeyPath: target.context.paths.vmSshKeyPath!,
      bindingTag: target.context.infrastructureBindingTag, guestProgram: STATUS_PROGRAM, secretStdin: false,
    }), target.context.env, { timeoutMs: 30_000, maxOutputBytes: 16 * 1024 });
    const receipt = result.ok ? parseHivraTailscaleReceipt(result.stdout, loginServer, deps.now()) : null;
    const connectionPresent = result.ok ? parseConnectionPresence(result.stdout) : null;
    if (receipt) return { ok: true, receipt, connectionPresent };
    return { ok: false, connectionPresent, receipt: { state: "unknown", sshEnabled: false, loginServer,
      observedAt: deps.now().toISOString(), failureCode: connectionPresent === true
        ? "unmanaged_connection" : resultFailureCode(result) } };
  } catch {
    return { ok: false, connectionPresent: null, receipt: { state: "unknown", sshEnabled: false, loginServer,
      observedAt: deps.now().toISOString(), failureCode: "authority_unavailable" } };
  }
}

export async function connectHivraTailscale(
  agent: HivraPrivateAccessAgentRow,
  authKey: string,
  loginServer: string,
  dependencies: Partial<Dependencies> = {},
): Promise<{ ok: boolean; receipt: HivraTailscaleReceipt }> {
  const deps = { ...defaults, ...dependencies };
  const target = await execution(agent, deps);
  // Refuse to replace a connection that was not enrolled through this owner-bound surface.
  const before = await observeHivraTailscale(agent, loginServer, deps);
  if (before.connectionPresent !== false) throw new Error("existing_connection");
  const result = await deps.runHostScriptWithStdin(buildHostScript({
    vmid: target.vmid, guestIp: target.guestIp, vmKeyPath: target.context.paths.vmSshKeyPath!,
    bindingTag: target.context.infrastructureBindingTag, guestProgram: buildHivraTailscaleConnectProgram(loginServer), secretStdin: true,
  }), `${authKey}\n`, target.context.env, { timeoutMs: 180_000, maxOutputBytes: 32 * 1024 });
  const receipt = result.ok ? parseHivraTailscaleReceipt(result.stdout, loginServer, deps.now()) : null;
  if (receipt?.state === "connected") return { ok: true, receipt };
  const observed = await observeHivraTailscale(agent, loginServer, deps);
  if (observed.receipt.state === "connected") return { ok: true, receipt: observed.receipt };
  return { ok: false, receipt: { ...observed.receipt, failureCode: resultFailureCode(result) } };
}

export async function disconnectHivraTailscale(
  agent: HivraPrivateAccessAgentRow,
  loginServer: string,
  dependencies: Partial<Dependencies> = {},
): Promise<{ ok: boolean; receipt: HivraTailscaleReceipt }> {
  const deps = { ...defaults, ...dependencies };
  const target = await execution(agent, deps);
  const result = await deps.runHostScript(buildHostScript({
    vmid: target.vmid, guestIp: target.guestIp, vmKeyPath: target.context.paths.vmSshKeyPath!,
    bindingTag: target.context.infrastructureBindingTag, guestProgram: disconnectProgram(), secretStdin: false,
  }), target.context.env, { timeoutMs: 60_000, maxOutputBytes: 16 * 1024 });
  const receipt = result.ok ? parseHivraTailscaleReceipt(result.stdout, loginServer, deps.now()) : null;
  if (receipt?.state === "disconnected") return { ok: true, receipt };
  const observed = await observeHivraTailscale(agent, loginServer, deps);
  if (observed.receipt.state === "disconnected") return { ok: true, receipt: observed.receipt };
  return { ok: false, receipt: { ...observed.receipt, failureCode: resultFailureCode(result) } };
}
