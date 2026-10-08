/**
 * Recovery sweep for hivra_agents rows stranded in `provisioning`.
 *
 * Why this exists: the provisioning status flip is CLIENT-driven — the agent
 * detail page polls GET /api/hivra/agents/[id] every 5s, and that handler is
 * what reads the host orchestrator log and flips the row to `running`. If the
 * customer closes the tab (or the poll loop dies on a transient fetch failure)
 * during the ~4-minute provision, the VM and tunnel converge but the row stays
 * `provisioning` forever — there was no server-side reconciliation. This sweep
 * is that reconciliation (prod incident: vmids 1093/2100/2106 on fixturenodea, all
 * with a `ready:true` marker sitting in the host log and nobody left polling).
 *
 * Decision table per stale operation lease (any lifecycle status, older than 10 min):
 *   - SSH probe fails ............................ skip (transient; retry next sweep)
 *   - log marker ready:true + chat_url ........... flip to running (full data incl api_token)
 *   - log marker ready:false ..................... probe tunnel healthz; healthy → flip,
 *                                                  unreachable → mark error (terminal)
 *   - no marker, VM gone ......................... mark error (provision died)
 *   - no marker, VM exists ....................... probe tunnel healthz; healthy → flip;
 *                                                  lifecycle settles exact VM/config state;
 *                                                  provision stays pending without a terminal result
 *   - no vmid at all ............................. probe tunnel healthz; healthy → flip,
 *                                                  else skip + warn (needs an operator)
 *
 * Stale desktop_prepare leases have their own pass (recoverStaleDesktopPreparation):
 * the lease guard admits release only with exact terminal evidence, so a guest
 * that was powered off mid-preparation used to pin the row at `running` and
 * return 409 to every power action forever.
 *
 * Marking `error` only happens on DEFINITIVE evidence (orchestrator finished
 * without a tunnel, or the VM no longer exists). Anything ambiguous is left
 * alone for the next sweep so a slow-but-healthy provision is never killed.
 */

import { reconcileBankrEnvAfterHivraBoot } from "@/lib/agent-wallets/hivra-lane";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import { captureHivraAgentComputerReady } from "@/lib/hivra/agent-ready-telemetry";
import {
  checkHivraAgentRecoveryAuthority,
  hivraAgentProvisionLogPath,
  hivraAgentProvisionSecretPath,
  hivraAgentStartLogPath,
  resolveHivraAgentTeardownExecutionContext,
  type HivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";
import {
  validateHivraChatOrigin,
  validateHivraHostRunningResult,
} from "@/lib/hivra/agent-host-result";
import {
  checkpointHivraAgentOperation,
  completeHivraAgentDelete,
  completeHivraAgentOperation,
  completeHivraAgentRunning,
  completeHivraAgentSnapshot,
  completeHivraAgentSnapshotRestore,
  continueHivraAgentOperation,
  continueHivraAgentResizeOperation,
  claimHivraAgentOperationRecovery,
  failHivraAgentSnapshot,
  failHivraAgentSnapshotRestore,
  persistHivraAgentProvisionIdentity,
  releaseHivraAgentOperation,
} from "@/lib/hivra/agent-operation-store";
import {
  prepareHivraTailscaleForDelete,
  type HivraPrivateAccessAgentRow,
} from "@/lib/hivra/tailscale-private-access";
import {
  buildHivraSnapshotObservationScript,
  parseHivraSnapshotObservation,
} from "@/lib/hivra/agent-snapshots";
import {
  resolveHivraSubnetPrefix,
  resolveHivraVmidEnd,
  resolveHivraVmidStart,
  shellQuote,
} from "@/lib/hivra/proxmox-target";
import { log } from "@/lib/logger";
import {
  abandonDesktopPrepare,
  cancelUndispatchedDesktopPrepare,
  completeDesktopPrepare,
  DESKTOP_PREPARE_KIND,
} from "@/lib/remote-computers/desktop-prepare-operation";
import {
  buildDesktopPrepareRecoveryScript,
  parseDesktopPrepareRecoveryOutput,
} from "@/lib/remote-computers/desktop-prepare-recovery";
import { deleteBoxTunnel } from "@/lib/services/cloudflare-tunnel";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

const LOG_SOURCE = "hivra/recover-stuck-provisioning";

const STUCK_AGENT_COLUMNS = "id, user_id, type, computer_profile, computer_substrate, status, vmid, ip, proxmox_host, deployment_mode, managed_provisioner_channel, infrastructure_connection_id, deployment_target_id, infrastructure_connection_revision, infrastructure_binding_token_hash, infrastructure_binding_token_enforced, cf_tunnel_id, cf_hostname, chat_url, api_token, provisioned_at, desired_state, operation_id, operation_kind, operation_started_at, operation_payload, allocation_operation_id, created_at";

/**
 * Start observing after the normal provisioning window and the DB recovery
 * lease's ten-minute minimum. Every branch
 * below requires affirmative evidence before changing state, so a slow box is
 * only re-probed and never failed merely for crossing this threshold.
 */
export const STUCK_PROVISIONING_THRESHOLD_MS = 10 * 60 * 1000;

/** Per-run cap: each candidate costs an SSH round-trip (and maybe an HTTPS probe). */
const MAX_CANDIDATES_PER_RUN = 12;

/**
 * Desktop preparation runs a guest installer bounded at 15 minutes. Its lease
 * is observed only well past that bound, and the recovery claim renews the
 * lease timestamp, so a preserved (still busy) preparation is re-examined at
 * most once per threshold instead of every sweep.
 */
export const STALE_DESKTOP_PREPARE_THRESHOLD_MS = 30 * 60 * 1000;
const MAX_DESKTOP_PREPARE_CANDIDATES_PER_RUN = 4;

const HEALTHZ_TIMEOUT_MS = 8_000;
// Reconciliation may wait up to 60s for the shared FD8 mutation lock and, for
// verified delete/cancellation, another bounded stop/destroy cycle. The cron
// route has a 300s budget; a 120s per-candidate ceiling preserves headroom while
// avoiding a client timeout that is shorter than the host-side safety bound.
const SSH_TIMEOUT_MS = 120_000;

interface StuckAgentRow {
  id: string;
  user_id: string;
  type: string | null;
  computer_profile: string | null;
  computer_substrate: string | null;
  status: string;
  vmid: number | null;
  ip: string | null;
  proxmox_host: string | null;
  deployment_mode: string | null;
  managed_provisioner_channel?: string | null;
  infrastructure_connection_id: string | null;
  deployment_target_id: string | null;
  infrastructure_connection_revision: number | null;
  infrastructure_binding_token_hash: string | null;
  infrastructure_binding_token_enforced: boolean;
  cf_tunnel_id: string | null;
  cf_hostname: string | null;
  chat_url: string | null;
  api_token: string | null;
  provisioned_at: string | null;
  desired_state: string | null;
  operation_id: string | null;
  operation_kind: string | null;
  operation_started_at: string | null;
  operation_payload: Record<string, unknown> | null;
  allocation_operation_id: string | null;
  created_at: string;
}

interface ProvisionMarker {
  vmid?: number;
  ip?: string;
  api_token?: string;
  chat_url?: string;
  ready?: boolean;
}

type StuckRecoveryAction =
  | "recovered_from_log"
  | "recovered_via_tunnel"
  | "cancelled_delete"
  | "marked_error"
  | "released_desktop_prepare"
  | "skipped";

interface StuckRecoveryResult {
  agentId: string;
  vmid: number | null;
  action: StuckRecoveryAction;
  reason: string;
}

export interface RecoverStuckHivraProvisioningSummary {
  scanned: number;
  recovered: number;
  markedError: number;
  cancelled: number;
  skipped: number;
  results: StuckRecoveryResult[];
}

function buildCancelledProvisionCleanupScript(
  context: HivraAgentExecutionContext,
  row: StuckAgentRow,
): string {
  const vmid = Number(row.vmid);
  const operationId = String(row.operation_id);
  const operationTag = `hivra-op-${operationId.replace(/-/g, "").toLowerCase()}`;
  const cleanupPaths = [
    hivraAgentProvisionLogPath(context, vmid),
    hivraAgentStartLogPath(context, vmid),
    hivraAgentProvisionSecretPath(context, vmid),
    `/run/hivra-provision/${vmid}.env`,
    `/run/hivra-provision/${vmid}.allocated`,
    `/var/lib/hivra/provision-operations/operation-${operationId}.selected`,
  ].filter((path): path is string => Boolean(path)).map((path) => shellQuote(path)).join(" ");
  return `set -euo pipefail
VMID=${vmid}
OPERATION_ID=${shellQuote(operationId)}
OPERATION_TAG=${shellQuote(operationTag)}
BINDING_TAG=${shellQuote(context.infrastructureBindingTag)}
STORAGE=${shellQuote(context.paths.storage)}
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "timed out waiting for cancellation cleanup lock" >&2; exit 1; }
PIDFILE="/run/hivra-provision/$VMID.pid"
if [ -r "$PIDFILE" ]; then
  PID="$(tr -dc '0-9' < "$PIDFILE")"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    CMD="$(tr '\\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)"
    [ -r "/proc/$PID/environ" ] \
      && printf '%s' "$CMD" | grep -Fq "hivra-provision-on-host.sh $VMID " \
      && tr '\\0' '\\n' < "/proc/$PID/environ" | grep -Fxq "HIVRA_OPERATION_ID=$OPERATION_ID" \
      && tr '\\0' '\\n' < "/proc/$PID/environ" | grep -Fxq "HIVRA_BINDING_TAG=$BINDING_TAG" \
      || { echo "refusing to stop an unowned provision process" >&2; exit 1; }
    kill "$PID"
    for _ in $(seq 1 40); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$PID" 2>/dev/null && { echo "provision process did not stop" >&2; exit 1; }
  fi
fi
if qm status "$VMID" >/dev/null 2>&1; then
  TAGS="$(qm config "$VMID" 2>/dev/null | sed -n 's/^tags:[[:space:]]*//p')"
  printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq "$OPERATION_TAG" \
    && printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq "$BINDING_TAG" \
    || { echo "refusing to destroy a foreign VM during cancellation" >&2; exit 1; }
  for _ in 1 2 3; do
    qm status "$VMID" >/dev/null 2>&1 || break
    TAGS="$(qm config "$VMID" 2>/dev/null | sed -n 's/^tags:[[:space:]]*//p')"
    printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq "$OPERATION_TAG" \
      && printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq "$BINDING_TAG" \
      || { echo "VM ownership changed during cancellation" >&2; exit 1; }
    qm stop "$VMID" --timeout 30 >/dev/null 2>&1 || true
    qm destroy "$VMID" --purge 1 --destroy-unreferenced-disks 1 >/dev/null 2>&1 || true
    sleep 1
  done
fi
qm status "$VMID" >/dev/null 2>&1 && { echo "VM still exists after cancellation" >&2; exit 1; }
VOLUMES="$(pvesm list "$STORAGE" 2>/dev/null)" \
  || { echo "could not verify storage after cancellation" >&2; exit 1; }
printf '%s\\n' "$VOLUMES" | grep -Eq "vm-${vmid}-" \
  && { echo "VM volumes remain after cancellation" >&2; exit 1; }
rm -f -- "$PIDFILE" ${cleanupPaths}
printf 'HIVRA_CANCELLED_PROVISION_CLEANED %s\\n' "$VMID"`;
}

function buildRecoveredDeleteCleanupScript(
  context: HivraAgentExecutionContext,
  row: StuckAgentRow,
): string {
  const vmid = Number(row.vmid);
  const allocationTag = row.allocation_operation_id
    ? `hivra-op-${row.allocation_operation_id.replace(/-/g, "").toLowerCase()}`
    : null;
  const allowManagedLegacy =
    row.deployment_mode === "hivra-managed" &&
    row.infrastructure_binding_token_enforced === false;
  const cleanupPaths = [
    hivraAgentProvisionLogPath(context, vmid),
    hivraAgentStartLogPath(context, vmid),
    hivraAgentProvisionSecretPath(context, vmid),
    `/run/hivra-provision/${vmid}.env`,
    `/run/hivra-provision/${vmid}.allocated`,
    `/var/lib/hivra/provision-results/${vmid}.secret`,
    row.operation_id
      ? `/var/lib/hivra/provision-operations/operation-${row.operation_id}.selected`
      : null,
  ].filter((path): path is string => Boolean(path)).map(shellQuote).join(" ");
  return `set -euo pipefail
VMID=${vmid}
STORAGE=${shellQuote(context.paths.storage)}
BINDING_TAG=${shellQuote(context.infrastructureBindingTag)}
ALLOCATION_TAG=${shellQuote(allocationTag ?? "")}
ALLOW_MANAGED_LEGACY=${allowManagedLegacy ? "1" : "0"}
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "timed out waiting for delete reconciliation lock" >&2; exit 1; }
# Migration-window managed provisioners predate operation/binding tags and did
# not inherit FD8. A user-requested delete may still reconcile those exact
# managed host/VMID rows, but only after every exact legacy provision child for
# this VMID has been stopped and observed gone. New managed and every portable
# row take the tagged path below instead.
if [ "$ALLOW_MANAGED_LEGACY" = 1 ]; then
  for PROC in /proc/[0-9]*; do
    [ -r "$PROC/cmdline" ] || continue
    CMD="$(tr '\\0' ' ' < "$PROC/cmdline" 2>/dev/null || true)"
    printf '%s' "$CMD" | grep -Fq "hivra-provision-on-host.sh $VMID " || continue
    PID="\${PROC##*/}"
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$PID" 2>/dev/null \
      && { echo "legacy provision process $PID did not stop" >&2; exit 1; }
  done
fi
owned() {
  [ "$ALLOW_MANAGED_LEGACY" = 1 ] && return 0
  [ -n "$ALLOCATION_TAG" ] || return 1
  tags="$(qm config "$VMID" 2>/dev/null | sed -n 's/^tags:[[:space:]]*//p')" || return 1
  printf '%s\\n' "$tags" | tr ';' '\\n' | grep -Fxq "$BINDING_TAG" \
    && printf '%s\\n' "$tags" | tr ';' '\\n' | grep -Fxq "$ALLOCATION_TAG"
}
if qm status "$VMID" >/dev/null 2>&1; then
  owned || { echo "refusing to destroy an unowned VM" >&2; exit 1; }
  for _ in 1 2 3; do
    qm status "$VMID" >/dev/null 2>&1 || break
    owned || { echo "VM ownership changed during delete reconciliation" >&2; exit 1; }
    qm stop "$VMID" --timeout 30 >/dev/null 2>&1 || true
    qm destroy "$VMID" --purge 1 --destroy-unreferenced-disks 1 >/dev/null 2>&1 || true
    sleep 1
  done
fi
qm status "$VMID" >/dev/null 2>&1 && { echo "VM still exists after delete reconciliation" >&2; exit 1; }
VOLUMES="$(pvesm list "$STORAGE" 2>/dev/null)" \
  || { echo "could not verify storage after delete reconciliation" >&2; exit 1; }
printf '%s\\n' "$VOLUMES" | grep -Eq "vm-${vmid}-" \
  && { echo "VM volumes remain after delete reconciliation" >&2; exit 1; }
rm -f -- ${cleanupPaths}
printf 'HIVRA_RECOVERED_DELETE_OK %s\\n' "$VMID"`;
}

export interface RecoverStuckHivraProvisioningOptions {
  /** Limit the sweep to one agent (ops escape hatch: ?id= on the cron route). */
  agentId?: string | null;
  now?: Date;
}

// One SSH round-trip per candidate: read the orchestrator's result marker from
// the FULL log (the poll route's old `tail -n 12` window was a fragility — any
// post-marker append would bury it) and report whether the VM still exists.
function buildProbeScript(
  context: HivraAgentExecutionContext,
  row: StuckAgentRow,
  vmid: number,
): string {
  const logPath = row.operation_kind === "provision"
    ? hivraAgentProvisionLogPath(context, vmid)
    : hivraAgentStartLogPath(context, vmid);
  const secretPath = hivraAgentProvisionSecretPath(context, vmid);
  const allocationTag = context.infrastructureBindingTagEnforced && row.operation_kind === "provision" && row.operation_id
    ? `hivra-op-${row.operation_id.replace(/-/g, "").toLowerCase()}`
    : null;
  const ownershipChecks = [
    context.infrastructureBindingTagEnforced
      ? `printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq ${shellQuote(context.infrastructureBindingTag)}`
      : "true",
    allocationTag
      ? `printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq ${shellQuote(allocationTag)}`
      : null,
  ].filter((check): check is string => Boolean(check)).join(" && ");
  return `set -u
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "timed out waiting for Hivra recovery evidence lock" >&2; exit 1; }
LOG=${shellQuote(logPath)}
MARKER="$(grep -oE '\\{"vmid":[^{}]*"ready":(true|false)[^{}]*\\}' "$LOG" 2>/dev/null | tail -1 || true)"
if grep -Fxq ${shellQuote(`HIVRA_OPERATION_ID ${row.operation_id ?? ""}`)} "$LOG" 2>/dev/null; then
  OPERATION_RECEIPT=match
else
  OPERATION_RECEIPT=missing
fi
if qm status ${vmid} >/dev/null 2>&1; then
  VM=exists
  CONFIG="$(qm config ${vmid} 2>/dev/null)"
  VM_STATUS="$(qm status ${vmid} 2>/dev/null | awk '{print $2}')"
  TAGS="$(printf '%s\\n' "$CONFIG" | sed -n 's/^tags:[[:space:]]*//p')"
  VM_CORES="$(printf '%s\\n' "$CONFIG" | awk '$1=="cores:" {print $2; exit}')"
  VM_CPULIMIT="$(printf '%s\\n' "$CONFIG" | awk '$1=="cpulimit:" {print $2; exit}')"
  VM_MEMORY="$(printf '%s\\n' "$CONFIG" | awk '$1=="memory:" {print $2; exit}')"
  VM_BALLOON="$(printf '%s\\n' "$CONFIG" | awk '$1=="balloon:" {print $2; exit}')"
  [ -n "$VM_BALLOON" ] || VM_BALLOON="$VM_MEMORY"
  if ${ownershipChecks}; then
    OWNERSHIP=match
  else
    OWNERSHIP=mismatch
  fi
else
  VM=missing
  VM_STATUS=missing
  VM_CORES=""
  VM_CPULIMIT=""
  VM_MEMORY=""
  VM_BALLOON=""
  OWNERSHIP=match
fi
printf 'HIVRA_RECOVERY_VM %s\\n' "$VM"
printf 'HIVRA_RECOVERY_VM_STATUS %s\\n' "$VM_STATUS"
printf 'HIVRA_RECOVERY_VM_CONFIG %s %s %s %s\\n' "$VM_CORES" "$VM_CPULIMIT" "$VM_MEMORY" "$VM_BALLOON"
printf 'HIVRA_RECOVERY_OWNERSHIP %s\\n' "$OWNERSHIP"
printf 'HIVRA_RECOVERY_OPERATION_RECEIPT %s\\n' "$OPERATION_RECEIPT"
if [ -n "$MARKER" ]; then printf 'HIVRA_RECOVERY_MARKER %s\\n' "$MARKER"; fi
${secretPath ? `if [ -f ${shellQuote(secretPath)} ]; then
  TOKEN="$(tr -d '[:space:]' < ${shellQuote(secretPath)})"
  if [ "\${#TOKEN}" -eq 64 ] && ! printf '%s' "$TOKEN" | grep -q '[^0-9a-f]'; then
    printf 'HIVRA_RECOVERY_SECRET %s\\n' "$TOKEN"
  fi
fi` : ""}
`;
}

function parseProbeOutput(stdout: string): {
  vmExists: boolean | null;
  vmStatus: "running" | "stopped" | "missing" | null;
  vmConfig: { cores: number; cpuLimit: number; memoryMb: number; balloonMb: number | null } | null;
  marker: ProvisionMarker | null;
  secret: string | null;
  ownershipMatches: boolean;
  operationReceiptMatches: boolean;
} {
  const vmLine = stdout.match(/^HIVRA_RECOVERY_VM\s+(exists|missing)\s*$/m);
  const vmStatusLine = stdout.match(/^HIVRA_RECOVERY_VM_STATUS\s+(running|stopped|missing)\s*$/m);
  const vmConfigLine = stdout.match(/^HIVRA_RECOVERY_VM_CONFIG\s+([0-9]+)\s+([0-9.]+)\s+([0-9]+)(?:\s+([0-9]+))?\s*$/m);
  const markerLine = stdout.match(/^HIVRA_RECOVERY_MARKER\s+(\{.*\})\s*$/m);
  const secretLine = stdout.match(/^HIVRA_RECOVERY_SECRET\s+([0-9a-f]{64})\s*$/m);
  const ownershipLine = stdout.match(/^HIVRA_RECOVERY_OWNERSHIP\s+(match|mismatch)\s*$/m);
  const operationReceiptLine = stdout.match(/^HIVRA_RECOVERY_OPERATION_RECEIPT\s+(match|missing)\s*$/m);
  let marker: ProvisionMarker | null = null;
  if (markerLine) {
    try {
      marker = JSON.parse(markerLine[1]) as ProvisionMarker;
    } catch {
      marker = null;
    }
  }
  return {
    vmExists: vmLine ? vmLine[1] === "exists" : null,
    vmStatus: vmStatusLine ? vmStatusLine[1] as "running" | "stopped" | "missing" : null,
    vmConfig: vmConfigLine ? {
      cores: Number(vmConfigLine[1]),
      cpuLimit: Number(vmConfigLine[2]),
      memoryMb: Number(vmConfigLine[3]),
      balloonMb: vmConfigLine[4] === undefined ? null : Number(vmConfigLine[4]),
    } : null,
    marker,
    secret: secretLine?.[1] ?? null,
    ownershipMatches: ownershipLine?.[1] === "match",
    operationReceiptMatches: operationReceiptLine?.[1] === "match",
  };
}

async function recoverPersistedProvisionIntent(
  row: StuckAgentRow,
  context: HivraAgentExecutionContext,
): Promise<{ vmid: number; ip: string } | null> {
  if (!row.operation_id || row.operation_kind !== "provision") return null;
  const intentPath = `/var/lib/hivra/provision-operations/operation-${row.operation_id}.selected`;
  const result = await runProxmoxHostScript(
    `set -euo pipefail
INTENT=${shellQuote(intentPath)}
[ "$(stat -c '%a:%U:%G' "$INTENT" 2>/dev/null)" = "600:root:root" ] \
  || { echo "persistent operation intent is missing or has unsafe ownership" >&2; exit 1; }
grep -Fxq ${shellQuote(`operation_id=${row.operation_id}`)} "$INTENT"
VMID="$(awk -F= '$1=="vmid" {print $2; exit}' "$INTENT")"
IP="$(awk -F= '$1=="ip" {print $2; exit}' "$INTENT")"
[[ "$VMID" =~ ^[0-9]+$ ]] || exit 1
printf 'HIVRA_RECOVERY_INTENT %s %s\\n' "$VMID" "$IP"`,
    context.env,
    { timeoutMs: SSH_TIMEOUT_MS },
  );
  if (!result.ok) return null;
  const match = result.stdout?.match(/^HIVRA_RECOVERY_INTENT\s+([0-9]+)\s+([^\s]+)\s*$/m);
  if (!match) return null;
  const vmid = Number(match[1]);
  const ip = match[2];
  const vmidStart = resolveHivraVmidStart(context.env);
  const vmidEnd = resolveHivraVmidEnd(context.env, vmidStart);
  const prefix = resolveHivraSubnetPrefix(context.env);
  const octet = Number(ip.slice(`${prefix}.`.length));
  if (
    !Number.isSafeInteger(vmid) || vmid < vmidStart || vmid > vmidEnd ||
    !Number.isInteger(octet) || octet < 2 || octet > 254 ||
    ip !== `${prefix}.${octet}`
  ) return null;
  const persisted = await persistHivraAgentProvisionIdentity({
    userId: row.user_id,
    agentId: row.id,
    operationId: row.operation_id,
    vmid,
    ip,
  });
  return persisted ? { vmid, ip } : null;
}

/**
 * End-to-end tunnel health: DNS + Cloudflare edge + named tunnel + the box's
 * chat server (which serves /healthz). Strictly stronger evidence than the
 * Cloudflare API's tunnel status, and needs no extra token scope.
 */
async function probeChatHealthz(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/healthz`, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function chatUrlForRow(row: StuckAgentRow, marker: ProvisionMarker | null): string | null {
  const namedHostname = row.cf_hostname || null;
  if (marker?.chat_url) return validateHivraChatOrigin(marker.chat_url, namedHostname);
  if (row.chat_url) return validateHivraChatOrigin(row.chat_url, namedHostname);
  if (namedHostname) return validateHivraChatOrigin(`https://${namedHostname}`, namedHostname);
  return null;
}

function resizeEnvelope(row: StuckAgentRow): {
  cpu: number;
  ram: number;
  maximumCpu: number;
  maximumRam: number;
  explicitMaximum: boolean;
} | null {
  const cpu = Number(row.operation_payload?.cpu);
  const ram = Number(row.operation_payload?.ram);
  const explicitMaximum = Object.prototype.hasOwnProperty.call(row.operation_payload ?? {}, "maximumCpu") ||
    Object.prototype.hasOwnProperty.call(row.operation_payload ?? {}, "maximumRam");
  const maximumCpu = Number(row.operation_payload?.maximumCpu ?? cpu);
  const maximumRam = Number(row.operation_payload?.maximumRam ?? ram);
  if (![cpu, ram, maximumCpu, maximumRam].every(Number.isFinite) || !Number.isInteger(ram) || !Number.isInteger(maximumRam)) {
    return null;
  }
  if (maximumCpu < cpu || maximumRam < ram) return null;
  return { cpu, ram, maximumCpu, maximumRam, explicitMaximum };
}

/**
 * A box this sweep brings to running gets the wallet row applied to its
 * bankr.env, as a polled boot does. No context is passed: the helper resolves
 * a lifecycle one instead of this sweep's relaxed teardown context. Best
 * effort; it never changes the recovery outcome.
 */
async function reconcileWalletIfRunning(
  row: StuckAgentRow,
  vmStatus: string | null,
  ip?: string | null,
): Promise<void> {
  if (vmStatus !== "running") return;
  try {
    await reconcileBankrEnvAfterHivraBoot({
      userId: row.user_id,
      agent: { ...row, status: "running", ip: ip || row.ip },
      trigger: "recovery",
    });
  } catch (error) {
    log.warn("recovered hivra agent wallet boot sync threw", {
      source: LOG_SOURCE,
      failureType: "hivra_agent_wallet_boot_env_sync_failed",
      agentId: row.id,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

function resizeProviderConfigMatches(
  envelope: NonNullable<ReturnType<typeof resizeEnvelope>>,
  vmConfig: { cores: number; cpuLimit: number; memoryMb: number; balloonMb: number | null } | null,
): boolean {
  return vmConfig !== null &&
    vmConfig.cores === Math.max(1, Math.ceil(envelope.maximumCpu)) &&
    vmConfig.cpuLimit === envelope.maximumCpu &&
    vmConfig.memoryMb === envelope.maximumRam * 1024 &&
    (!envelope.explicitMaximum || vmConfig.balloonMb === envelope.ram * 1024);
}

async function flipToRunning(
  row: StuckAgentRow,
  fields: { chat_url: string; ip?: string | null; api_token?: string | null },
  via: "log_marker" | "tunnel_healthz",
  now: Date,
): Promise<boolean> {
  const operationKind = ["provision", "start", "restart", "resize"].includes(
    String(row.operation_kind),
  ) ? row.operation_kind as "provision" | "start" | "restart" | "resize" : null;
  if (!row.operation_id || !operationKind || row.desired_state !== "running") return false;
  const isFirstProvision = operationKind === "provision" && !row.provisioned_at;
  if (operationKind !== "provision" && row.status !== "provisioning") {
    const envelope = operationKind === "resize" ? resizeEnvelope(row) : null;
    if (operationKind === "resize" && !envelope) return false;
    const continued = envelope
      ? await continueHivraAgentResizeOperation({
          userId: row.user_id, agentId: row.id, operationId: row.operation_id,
          expectedDesiredState: "running", status: "provisioning",
          cpu: envelope.cpu, ram: envelope.ram,
          maximumCpu: envelope.maximumCpu, maximumRam: envelope.maximumRam,
        })
      : await continueHivraAgentOperation({
          userId: row.user_id, agentId: row.id, operationId: row.operation_id,
          expectedDesiredState: "running", status: "provisioning",
        });
    if (!continued) return false;
    row.status = "provisioning";
  }
  const flipped = await completeHivraAgentRunning({
    userId: row.user_id,
    agentId: row.id,
    operationId: row.operation_id,
    operationKind,
    chatUrl: fields.chat_url,
    ip: fields.ip || row.ip,
    apiToken: fields.api_token || row.api_token || null,
    provisionedAt: row.provisioned_at || now.toISOString(),
  });
  if (!flipped) return false;
  await logHivraAgentEvent({
    userId: row.user_id,
    event: "provisioned",
    agentId: row.id,
    agentType: row.type,
    detail: { vmid: row.vmid, recovered: true, via },
  });
  if (isFirstProvision) {
    await captureHivraAgentComputerReady({
      userId: row.user_id,
      agentId: row.id,
      agentType: row.type,
      deploymentMode: row.deployment_mode,
      operationId: row.operation_id,
      vmid: row.vmid,
      evidence: via === "log_marker" ? "recovery_log_marker" : "recovery_tunnel_healthz",
    });
  }
  log.info("recovered stuck hivra agent to running", {
    source: LOG_SOURCE,
    agentId: row.id,
    vmid: row.vmid,
    proxmoxHost: row.proxmox_host,
    via,
    hasApiToken: Boolean(fields.api_token || row.api_token),
  });
  await reconcileWalletIfRunning(row, "running", fields.ip);
  return true;
}

async function markError(row: StuckAgentRow, reason: string, message: string): Promise<boolean> {
  if (!row.operation_id || row.desired_state === "deleted") return false;
  const flipped = await releaseHivraAgentOperation({
    userId: row.user_id,
    agentId: row.id,
    operationId: row.operation_id,
    error: message.slice(0, 300),
    markError: true,
  });
  // The row is now terminal and nothing re-drives it, so release the named
  // tunnel + CNAME created before kickoff — otherwise every terminal failure
  // leaks an orphaned Cloudflare tunnel. Gated on the guarded update actually
  // flipping the row: zero rows matched means a concurrent poll moved it past
  // provisioning (possibly to running), and that live box's tunnel must be
  // left alone. Best-effort by contract — deleteBoxTunnel never throws.
  if (flipped && (row.cf_tunnel_id || row.cf_hostname)) {
    await deleteBoxTunnel({ tunnelId: row.cf_tunnel_id, hostname: row.cf_hostname });
  }
  await logHivraAgentEvent({
    userId: row.user_id,
    event: "failed",
    agentId: row.id,
    agentType: row.type,
    detail: { vmid: row.vmid, reason },
  });
  log.error("stuck hivra agent marked as failed", new Error(message), {
    source: LOG_SOURCE,
    failureType: "hivra_agent_stuck_provisioning_terminal",
    agentId: row.id,
    vmid: row.vmid,
    proxmoxHost: row.proxmox_host,
    reason,
  });
  return flipped;
}

async function settleStaleLifecycleFromProviderState(
  row: StuckAgentRow,
  vmStatus: "running" | "stopped" | "missing" | null,
  vmConfig: { cores: number; cpuLimit: number; memoryMb: number; balloonMb: number | null } | null,
  evidenceReason: string,
): Promise<StuckRecoveryResult> {
  const base = { agentId: row.id, vmid: row.vmid };
  if (
    !row.operation_id ||
    !["start", "restart", "resize"].includes(String(row.operation_kind))
  ) {
    return { ...base, action: "skipped", reason: "stale lifecycle operation identity is incomplete" };
  }
  if (vmStatus !== "running" && vmStatus !== "stopped") {
    const marked = await markError(
      row,
      "stale_lifecycle_vm_missing",
      "The VM disappeared while lifecycle work was in progress.",
    );
    return marked
      ? { ...base, action: "marked_error", reason: "stale lifecycle found no provider VM" }
      : { ...base, action: "skipped", reason: "stale lifecycle error completion was superseded" };
  }

  let resizeConfigMatches = true;
  if (row.operation_kind === "resize") {
    const envelope = resizeEnvelope(row);
    resizeConfigMatches = Boolean(envelope && resizeProviderConfigMatches(envelope, vmConfig));
    if (resizeConfigMatches && envelope) {
      const persisted = await continueHivraAgentResizeOperation({
        userId: row.user_id, agentId: row.id, operationId: row.operation_id,
        expectedDesiredState: "running", status: "provisioning",
        cpu: envelope.cpu, ram: envelope.ram,
        maximumCpu: envelope.maximumCpu, maximumRam: envelope.maximumRam,
      });
      if (!persisted) return { ...base, action: "skipped", reason: "stale resize envelope persistence was superseded" };
    }
  }

  const completed = await completeHivraAgentOperation({
    userId: row.user_id,
    agentId: row.id,
    operationId: row.operation_id,
    expectedDesiredState: "running",
    status: vmStatus,
  });
  if (!completed) {
    return { ...base, action: "skipped", reason: "stale lifecycle completion was superseded" };
  }
  await reconcileWalletIfRunning(row, vmStatus);
  return {
    ...base,
    action: vmStatus === "running" && resizeConfigMatches ? "recovered_from_log" : "skipped",
    reason: row.operation_kind === "resize" && !resizeConfigMatches
      ? `stale resize did not reach its requested configuration; intent reset to ${vmStatus}`
      : `${evidenceReason}; exact provider state settled to ${vmStatus}`,
  };
}

async function compensateFailedOwnedProvision(
  row: StuckAgentRow,
  context: HivraAgentExecutionContext,
  reason: string,
  message: string,
): Promise<StuckRecoveryResult> {
  const base = { agentId: row.id, vmid: row.vmid };
  if (
    !row.operation_id ||
    !row.vmid ||
    row.operation_kind !== "provision" ||
    row.allocation_operation_id !== row.operation_id ||
    !context.infrastructureBindingTagEnforced
  ) {
    return { ...base, action: "skipped", reason: "provision cleanup lacks exact provider ownership evidence" };
  }
  const cleanup = await runProxmoxHostScript(
    buildCancelledProvisionCleanupScript(context, row),
    context.env,
    { timeoutMs: SSH_TIMEOUT_MS },
  );
  if (!cleanup.ok) {
    return { ...base, action: "skipped", reason: "failed provision cleanup could not be verified" };
  }

  // DELETE never steals the provision lease. Re-check desired state only after
  // provider cleanup, then use that same operation id for the matching terminal
  // CAS. This closes the delete-arrives-during-compensation window without
  // resurrecting or orphaning the VM.
  const stillWantsRunning = await checkpointHivraAgentOperation({
    userId: row.user_id,
    agentId: row.id,
    operationId: row.operation_id,
    expectedDesiredState: "running",
  });
  if (stillWantsRunning) {
    const marked = await markError(row, reason, message);
    return marked
      ? { ...base, action: "marked_error", reason: "exact owned provision allocation was compensated" }
      : { ...base, action: "skipped", reason: "failed provision completion was superseded" };
  }

  const deleted = await completeHivraAgentDelete({
    userId: row.user_id,
    agentId: row.id,
    operationId: row.operation_id,
  });
  if (!deleted) {
    return { ...base, action: "skipped", reason: "compensated provision delete completion was superseded" };
  }
  return { ...base, action: "cancelled_delete", reason: "delete superseded an exactly compensated provision" };
}

async function recoverOne(row: StuckAgentRow, now: Date): Promise<StuckRecoveryResult> {
  const base = { agentId: row.id, vmid: row.vmid };
  if (!row.operation_id || !row.operation_started_at) {
    return { ...base, action: "skipped", reason: "durable operation recovery evidence is missing" };
  }

  // An interrupted access-setup request can have an unknown provider POST or
  // key-revocation outcome. Missing VM intent is not proof that those resources
  // are absent. Keep its lease/identities; never run legacy hostname-only cleanup.
  if (row.operation_kind === "provision" && !row.vmid && (
    row.operation_payload?.stage === "pre_allocation_access" ||
    (row.cf_hostname && !row.cf_tunnel_id)
  )) {
    return { ...base, action: "skipped", reason: "pre-allocation access setup requires reconciliation" };
  }

  // Resolve and exercise the exact teardown authority before renewing the DB
  // lease. This is deliberately only an SSH/authentication check: it performs
  // no qm read or mutation, and the stale operation_id still excludes every
  // normal provider mutator. The exact timestamp CAS below remains the sole
  // recovery-owner election. A DELETE with no provider coordinate is the one
  // exception because it can complete entirely in the database.
  let recoveryContext: HivraAgentExecutionContext | null = null;
  const needsProviderAuthority = row.operation_kind !== "delete" || row.vmid !== null;
  if (needsProviderAuthority) {
    try {
      recoveryContext = await resolveHivraAgentTeardownExecutionContext(row.user_id, row);
    } catch (error) {
      log.warn("stale hivra operation authority is unavailable before recovery claim", {
        source: LOG_SOURCE,
        failureType: "hivra_stale_operation_preclaim_context_unavailable",
        agentId: row.id,
        vmid: row.vmid,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return { ...base, action: "skipped", reason: "owner-bound recovery authority unavailable" };
    }

    const authorityCheck = await checkHivraAgentRecoveryAuthority(recoveryContext);
    if (!authorityCheck.ok) {
      log.warn("stale hivra operation host authority check failed before recovery claim", {
        source: LOG_SOURCE,
        failureType: "hivra_stale_operation_preclaim_authority_failed",
        agentId: row.id,
        vmid: row.vmid,
        proxmoxHost: row.proxmox_host,
        errorMessage: authorityCheck.error ?? null,
        stderr: authorityCheck.stderr?.slice(0, 300) ?? null,
      });
      return { ...base, action: "skipped", reason: "owner-bound host authority unavailable" };
    }
  }

  const recoveryClaimed = await claimHivraAgentOperationRecovery({
    userId: row.user_id,
    agentId: row.id,
    operationId: row.operation_id,
    expectedOperationStartedAt: row.operation_started_at,
    recoveredAt: now.toISOString(),
  });
  if (!recoveryClaimed) {
    return { ...base, action: "skipped", reason: "operation is fresh, superseded, or claimed by another reconciler" };
  }

  // A DELETE that arrives while provision owns the durable lease is a
  // cancellation request, not permission to re-drive the launch. Only the
  // original provision operation may compensate, and only after exact
  // operation + stable binding ownership is verified under the host lock.
  if (row.desired_state === "deleted") {
    const nMinusOneCompatibility =
      row.deployment_mode === "hivra-managed" &&
      !row.infrastructure_binding_token_enforced &&
      row.operation_payload?.compatibility === "n_minus_one";
    if (row.operation_kind === "delete") {
      if (!row.vmid) {
        const deleted = await completeHivraAgentDelete({
          userId: row.user_id,
          agentId: row.id,
          operationId: row.operation_id,
        });
        return deleted
          ? { ...base, action: "cancelled_delete", reason: "delete had no provider identity" }
          : { ...base, action: "skipped", reason: "delete completion was superseded" };
      }
      let teardownContext: HivraAgentExecutionContext;
      try {
        teardownContext = recoveryContext ?? await resolveHivraAgentTeardownExecutionContext(row.user_id, row);
      } catch (error) {
        log.warn("stale delete teardown context is unavailable", {
          source: LOG_SOURCE,
          failureType: "hivra_stale_delete_context_unavailable",
          agentId: row.id,
          vmid: row.vmid,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return { ...base, action: "skipped", reason: "owner-bound teardown context unavailable" };
      }
      const privateAccessCleanup = await prepareHivraTailscaleForDelete({
        ...row,
        type: row.type ?? "",
        computer_profile: row.computer_profile,
        desired_state: row.desired_state ?? "",
      } as HivraPrivateAccessAgentRow, teardownContext);
      if (!privateAccessCleanup.ok) {
        return { ...base, action: "skipped", reason: "private-access logout could not be verified" };
      }
      const cleanup = await runProxmoxHostScript(
        buildRecoveredDeleteCleanupScript(teardownContext, row),
        teardownContext.env,
        { timeoutMs: SSH_TIMEOUT_MS },
      );
      if (!cleanup.ok) {
        return { ...base, action: "skipped", reason: "delete provider cleanup could not be verified" };
      }
      const deleted = await completeHivraAgentDelete({
        userId: row.user_id,
        agentId: row.id,
        operationId: row.operation_id,
      });
      if (!deleted) return { ...base, action: "skipped", reason: "delete completion was superseded" };
      return { ...base, action: "cancelled_delete", reason: "stale delete provider cleanup verified" };
    }
    if (["start", "stop", "restart", "resize", "snapshot", "restore"].includes(String(row.operation_kind))) {
      if (!row.vmid) {
        return { ...base, action: "skipped", reason: "superseded lifecycle lacks a provider coordinate" };
      }
      let lifecycleContext: HivraAgentExecutionContext;
      try {
        lifecycleContext = recoveryContext ?? await resolveHivraAgentTeardownExecutionContext(row.user_id, row);
      } catch (error) {
        log.warn("superseded lifecycle teardown context is unavailable", {
          source: LOG_SOURCE,
          failureType: "hivra_superseded_lifecycle_context_unavailable",
          agentId: row.id,
          vmid: row.vmid,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return { ...base, action: "skipped", reason: "owner-bound teardown context unavailable" };
      }
      // The probe acquires the same FD8 host lock as every lifecycle mutation.
      // Once it returns, no qm mutation from the superseded operation remains
      // in flight. Exact binding evidence (or verified VM absence) is required
      // before releasing the DB lease for a retrying DELETE.
      const lifecycleProbe = await runProxmoxHostScript(
        buildProbeScript(lifecycleContext, row, row.vmid),
        lifecycleContext.env,
        { timeoutMs: SSH_TIMEOUT_MS },
      );
      if (!lifecycleProbe.ok) {
        return { ...base, action: "skipped", reason: "superseded lifecycle provider quiescence is unverified" };
      }
      const lifecycleEvidence = parseProbeOutput(lifecycleProbe.stdout || "");
      if (
        lifecycleEvidence.vmExists === null ||
        !lifecycleEvidence.ownershipMatches
      ) {
        return { ...base, action: "skipped", reason: "superseded lifecycle provider ownership is unverified" };
      }
      const released = await releaseHivraAgentOperation({
        userId: row.user_id,
        agentId: row.id,
        operationId: row.operation_id,
        error: "Lifecycle operation was superseded by delete.",
        markError: false,
      });
      return released
        ? { ...base, action: "skipped", reason: "provider-quiescent lifecycle lease released for delete retry" }
        : { ...base, action: "skipped", reason: "superseded lifecycle release lost CAS" };
    }
    if (row.operation_kind === "provision" && !row.vmid) {
      let intentContext: HivraAgentExecutionContext;
      try {
        intentContext = recoveryContext ?? await resolveHivraAgentTeardownExecutionContext(row.user_id, row);
      } catch {
        return { ...base, action: "skipped", reason: "owner-bound teardown context unavailable" };
      }
      const recoveredIntent = await recoverPersistedProvisionIntent(row, intentContext);
      if (recoveredIntent) {
        row.vmid = recoveredIntent.vmid;
        row.ip = recoveredIntent.ip;
        if (row.infrastructure_binding_token_enforced) row.allocation_operation_id = row.operation_id;
      } else if (nMinusOneCompatibility) {
        return { ...base, action: "skipped", reason: "legacy launch has no provider coordinate; manual reconciliation required" };
      } else {
        const deleted = await completeHivraAgentDelete({
          userId: row.user_id,
          agentId: row.id,
          operationId: row.operation_id,
        });
        return deleted
          ? { ...base, action: "cancelled_delete", reason: "cancelled provision had no durable provider allocation" }
          : { ...base, action: "skipped", reason: "provider-absence delete completion was superseded" };
      }
    }
    if (row.operation_kind === "provision" && nMinusOneCompatibility && row.vmid) {
      // Migration-first/N-1 managed launches predate provider tags and cannot
      // satisfy the strict allocation-operation gate below. They retain only
      // the deliberately narrow pre-existing managed host/VMID authority. A
      // delete request may use that compatibility authority after FD8 is held
      // and every exact legacy provision child for the VMID is stopped; the
      // cleanup script still verifies VM and storage absence before DB delete.
      let legacyContext: HivraAgentExecutionContext;
      try {
        legacyContext = recoveryContext ?? await resolveHivraAgentTeardownExecutionContext(row.user_id, row);
      } catch {
        return { ...base, action: "skipped", reason: "legacy managed teardown context unavailable" };
      }
      const cleanup = await runProxmoxHostScript(
        buildRecoveredDeleteCleanupScript(legacyContext, row),
        legacyContext.env,
        { timeoutMs: SSH_TIMEOUT_MS },
      );
      if (!cleanup.ok) {
        return { ...base, action: "skipped", reason: "legacy managed provider cleanup could not be verified" };
      }
      const deleted = await completeHivraAgentDelete({
        userId: row.user_id,
        agentId: row.id,
        operationId: row.operation_id,
      });
      if (!deleted) {
        return { ...base, action: "skipped", reason: "legacy managed delete completion was superseded" };
      }
      return { ...base, action: "cancelled_delete", reason: "migration-window managed provision cleanup verified" };
    }
    if (
      row.operation_kind !== "provision" ||
      !row.operation_id ||
      row.allocation_operation_id !== row.operation_id ||
      !row.vmid
    ) {
      return {
        ...base,
        action: "skipped",
        reason: "delete cancellation lacks a persisted owner-bound allocation identity",
      };
    }
    let teardownContext: HivraAgentExecutionContext;
    try {
      teardownContext = recoveryContext ?? await resolveHivraAgentTeardownExecutionContext(row.user_id, row);
    } catch (error) {
      log.warn("cancelled provision teardown context is unavailable", {
        source: LOG_SOURCE,
        failureType: "hivra_cancelled_provision_context_unavailable",
        agentId: row.id,
        vmid: row.vmid,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return { ...base, action: "skipped", reason: "owner-bound teardown context unavailable" };
    }
    if (!teardownContext.infrastructureBindingTagEnforced) {
      return { ...base, action: "skipped", reason: "provider ownership tag is not enforced" };
    }
    const cleanup = await runProxmoxHostScript(
      buildCancelledProvisionCleanupScript(teardownContext, row),
      teardownContext.env,
      { timeoutMs: SSH_TIMEOUT_MS },
    );
    if (!cleanup.ok) {
      log.warn("cancelled provision cleanup could not be verified", {
        source: LOG_SOURCE,
        failureType: "hivra_cancelled_provision_cleanup_unverified",
        agentId: row.id,
        vmid: row.vmid,
        errorMessage: cleanup.error ?? cleanup.stderr?.slice(0, 300) ?? null,
      });
      return { ...base, action: "skipped", reason: "cancellation cleanup could not be verified" };
    }
    const deleted = await completeHivraAgentDelete({
      userId: row.user_id,
      agentId: row.id,
      operationId: row.operation_id,
    });
    if (!deleted) {
      return { ...base, action: "skipped", reason: "delete completion was superseded" };
    }
    return { ...base, action: "cancelled_delete", reason: "owner-bound provision allocation removed" };
  }

  let context: HivraAgentExecutionContext;
  try {
    context = recoveryContext ?? await resolveHivraAgentTeardownExecutionContext(row.user_id, row);
  } catch (error) {
    log.warn("stuck hivra agent execution context is unavailable; will retry after owner repair", {
      source: LOG_SOURCE,
      failureType: "hivra_agent_stuck_provisioning_context_unavailable",
      agentId: row.id,
      vmid: row.vmid,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return { ...base, action: "skipped", reason: "owner-bound execution context unavailable" };
  }

  if (row.operation_kind === "snapshot" || row.operation_kind === "restore") {
    const snapshotId = typeof row.operation_payload?.snapshotId === "string"
      ? row.operation_payload.snapshotId
      : "";
    const providerSnapshotId = typeof row.operation_payload?.providerSnapshotId === "string"
      ? row.operation_payload.providerSnapshotId
      : "";
    if (
      !row.vmid
      || !context.infrastructureBindingTagEnforced
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(snapshotId)
      || !/^hivra_[0-9a-f]{32}$/.test(providerSnapshotId)
    ) {
      return { ...base, action: "skipped", reason: "snapshot operation identity is incomplete" };
    }
    const { data: snapshot, error: snapshotError } = await supabaseAdmin!
      .from("hivra_agent_snapshots")
      .select("id, status, provider_snapshot_id, snapshot_config_sha256, create_operation_id, restore_operation_id")
      .eq("id", snapshotId)
      .eq("agent_id", row.id)
      .eq("user_id", row.user_id)
      .maybeSingle();
    if (snapshotError || !snapshot || snapshot.provider_snapshot_id !== providerSnapshotId) {
      return { ...base, action: "skipped", reason: "durable snapshot identity is unavailable" };
    }
    const observed = await runProxmoxHostScript(
      buildHivraSnapshotObservationScript({
        vmid: row.vmid,
        bindingTag: context.infrastructureBindingTag,
        providerSnapshotId,
        operationId: row.operation_id,
      }),
      context.env,
      { timeoutMs: SSH_TIMEOUT_MS },
    );
    const evidence = observed.ok
      ? parseHivraSnapshotObservation(observed.stdout || "")
      : null;
    if (!evidence) {
      return { ...base, action: "skipped", reason: "snapshot provider observation is unavailable" };
    }

    if (row.operation_kind === "snapshot") {
      if (
        snapshot.status === "creating"
        && snapshot.create_operation_id === row.operation_id
        && evidence.snapshotConfigSha256
      ) {
        const completed = await completeHivraAgentSnapshot({
          userId: row.user_id,
          agentId: row.id,
          operationId: row.operation_id,
          snapshotId,
          providerStatus: evidence.providerStatus,
          snapshotConfigSha256: evidence.snapshotConfigSha256,
        });
        return completed
          ? { ...base, action: "recovered_from_log", reason: "provider snapshot and exact configuration receipt verified" }
          : { ...base, action: "skipped", reason: "snapshot completion was superseded" };
      }
      const failed = await failHivraAgentSnapshot({
        userId: row.user_id,
        agentId: row.id,
        operationId: row.operation_id,
        snapshotId,
        providerStatus: evidence.providerStatus,
        error: "The provider snapshot was not present after reconciliation.",
      });
      return failed
        ? { ...base, action: "skipped", reason: "absent snapshot operation was released after provider verification" }
        : { ...base, action: "skipped", reason: "snapshot failure completion was superseded" };
    }

    const expectedHash = typeof snapshot.snapshot_config_sha256 === "string"
      ? snapshot.snapshot_config_sha256
      : "";
    const restored =
      snapshot.status === "restoring"
      && snapshot.restore_operation_id === row.operation_id
      && /^[0-9a-f]{64}$/.test(expectedHash)
      && evidence.providerStatus === "stopped"
      && evidence.snapshotConfigSha256 === expectedHash
      && evidence.currentConfigSha256 === expectedHash;
    // A restore always ends stopped. The restored disk's bankr.env is brought
    // back in line with the wallet row when the box next boots.
    if (restored) {
      const completed = await completeHivraAgentSnapshotRestore({
        userId: row.user_id,
        agentId: row.id,
        operationId: row.operation_id,
        snapshotId,
        snapshotConfigSha256: expectedHash,
      });
      return completed
        ? { ...base, action: "recovered_from_log", reason: evidence.restoreReceiptMatches
            ? "restore receipt and exact provider configuration verified"
            : "selected snapshot already equals the stopped provider configuration" }
        : { ...base, action: "skipped", reason: "restore completion was superseded" };
    }
    const failed = await failHivraAgentSnapshotRestore({
      userId: row.user_id,
      agentId: row.id,
      operationId: row.operation_id,
      snapshotId,
      providerStatus: evidence.providerStatus,
      error: "The selected restore point was not applied exactly; the observed provider state was preserved.",
    });
    return failed
      ? { ...base, action: "skipped", reason: "unapplied restore operation was released after provider verification" }
      : { ...base, action: "skipped", reason: "restore failure completion was superseded" };
  }

  // POST can lose its SSH transport after the host durably selected a VMID/IP
  // but before the DB received that coordinate. Recover only the exact root-
  // owned persistent operation intent, then let the normal ownership probe
  // decide whether provider work exists or failed.
  if (!row.vmid) {
    const recoveredIntent = await recoverPersistedProvisionIntent(row, context);
    if (recoveredIntent) {
      row.vmid = recoveredIntent.vmid;
      row.ip = recoveredIntent.ip;
      if (row.infrastructure_binding_token_enforced) {
        row.allocation_operation_id = row.operation_id;
      }
    } else {
      const nMinusOneCompatibility =
        row.deployment_mode === "hivra-managed" &&
        !row.infrastructure_binding_token_enforced &&
        row.operation_payload?.compatibility === "n_minus_one";
      if (!nMinusOneCompatibility) {
        const marked = await markError(
          row,
          "stale_provision_intent_missing",
          "Provisioning never produced a durable provider allocation intent.",
        );
        return marked
          ? { ...base, action: "marked_error", reason: "no durable provider allocation intent exists" }
          : { ...base, action: "skipped", reason: "missing-intent completion was superseded" };
      }
      log.warn("legacy migration-window provision has no recoverable vmid", {
      source: LOG_SOURCE,
      failureType: "hivra_agent_stuck_provisioning_no_vmid",
      agentId: row.id,
      createdAt: row.created_at,
      cfHostname: row.cf_hostname,
      });
      return { ...base, action: "skipped", reason: "legacy launch has no provider coordinate; manual reconciliation required" };
    }
  }
  const nMinusOneCompatibility =
    row.deployment_mode === "hivra-managed" &&
    !row.infrastructure_binding_token_enforced &&
    row.operation_payload?.compatibility === "n_minus_one";
  if (!context.infrastructureBindingTagEnforced && row.operation_kind === "provision" && !nMinusOneCompatibility) {
    return { ...base, action: "skipped", reason: "legacy provision lacks provider ownership evidence" };
  }
  const probe = await runProxmoxHostScript(buildProbeScript(context, row, row.vmid), context.env, {
    timeoutMs: SSH_TIMEOUT_MS,
  });
  if (!probe.ok) {
    log.warn("stuck hivra agent host probe failed; will retry next sweep", {
      source: LOG_SOURCE,
      failureType: "hivra_agent_stuck_provisioning_probe_failed",
      agentId: row.id,
      vmid: row.vmid,
      proxmoxHost: row.proxmox_host,
      errorMessage: probe.error ?? null,
      stderr: probe.stderr?.slice(0, 300) ?? null,
    });
    return { ...base, action: "skipped", reason: "host probe failed (transient)" };
  }

  const {
    vmExists,
    vmStatus,
    vmConfig,
    marker,
    secret,
    ownershipMatches,
    operationReceiptMatches,
  } = parseProbeOutput(probe.stdout || "");
  if (!ownershipMatches) {
    const released = await markError(
      row,
      "stale_operation_provider_ownership_mismatch",
      "The provider VM no longer carries this agent's ownership receipt.",
    );
    return released
      ? { ...base, action: "marked_error", reason: "VM ownership receipt does not match this agent" }
      : { ...base, action: "skipped", reason: "ownership mismatch completion was superseded" };
  }

  if (row.operation_kind === "stop") {
    if (vmStatus === "running" || vmStatus === "stopped") {
      const completed = await completeHivraAgentOperation({
        userId: row.user_id,
        agentId: row.id,
        operationId: row.operation_id,
        expectedDesiredState: "stopped",
        status: vmStatus,
      });
      return completed
        ? {
            ...base,
            action: vmStatus === "stopped" ? "recovered_from_log" : "skipped",
            reason: vmStatus === "stopped"
              ? "stale stop converged from verified provider state"
              : "stale stop never changed provider state; intent reset to running",
          }
        : { ...base, action: "skipped", reason: "stale stop completion was superseded" };
    }
    const marked = await markError(row, "stale_stop_vm_missing", "The VM disappeared while stop was in progress.");
    return marked
      ? { ...base, action: "marked_error", reason: "stale stop found no provider VM" }
      : { ...base, action: "skipped", reason: "stale stop error completion was superseded" };
  }

  if (["start", "restart", "resize"].includes(String(row.operation_kind)) && !operationReceiptMatches && !nMinusOneCompatibility) {
    if (vmStatus !== "running" && vmStatus !== "stopped") {
      const marked = await markError(row, "stale_lifecycle_vm_missing", "The VM disappeared while lifecycle work was in progress.");
      return marked
        ? { ...base, action: "marked_error", reason: "stale lifecycle found no provider VM" }
        : { ...base, action: "skipped", reason: "stale lifecycle error completion was superseded" };
    }
    if (row.operation_kind === "resize") {
      const envelope = resizeEnvelope(row);
      const configMatches = Boolean(envelope && resizeProviderConfigMatches(envelope, vmConfig));
      if (configMatches && envelope) {
        const persisted = await continueHivraAgentResizeOperation({
          userId: row.user_id, agentId: row.id, operationId: row.operation_id,
          expectedDesiredState: "running", status: "provisioning",
          cpu: envelope.cpu, ram: envelope.ram,
          maximumCpu: envelope.maximumCpu, maximumRam: envelope.maximumRam,
        });
        if (!persisted) return { ...base, action: "skipped", reason: "stale resize envelope persistence was superseded" };
      }
      const completed = await completeHivraAgentOperation({
        userId: row.user_id,
        agentId: row.id,
        operationId: row.operation_id,
        expectedDesiredState: "running",
        status: vmStatus,
      });
      if (completed) await reconcileWalletIfRunning(row, vmStatus);
      return completed
        ? {
            ...base,
            action: configMatches ? "recovered_from_log" : "skipped",
            reason: configMatches
              ? "stale resize converged from exact provider configuration"
              : `stale resize never reached its operation receipt; intent reset to ${vmStatus}`,
          }
        : { ...base, action: "skipped", reason: "stale resize completion was superseded" };
    }
    const completed = await completeHivraAgentOperation({
      userId: row.user_id,
      agentId: row.id,
      operationId: row.operation_id,
      expectedDesiredState: "running",
      status: vmStatus,
    });
    if (completed) await reconcileWalletIfRunning(row, vmStatus);
    return completed
      ? {
          ...base,
          action: "skipped",
          reason: `stale ${row.operation_kind} never reached its operation receipt; intent reset to ${vmStatus}`,
        }
      : { ...base, action: "skipped", reason: "stale lifecycle completion was superseded" };
  }

  if (marker?.ready && marker.chat_url) {
    if (!row.ip) return { ...base, action: "skipped", reason: "persisted VM IP is unavailable" };
    const validated = validateHivraHostRunningResult({
      result: marker,
      expectedVmid: row.vmid,
      expectedIp: row.ip,
      namedHostname: row.cf_hostname,
      oneShotApiToken: secret,
      existingApiToken: row.api_token,
    });
    if (!validated.ok) {
      return { ...base, action: "skipped", reason: `host result validation failed: ${validated.reason}` };
    }
    const flipped = await flipToRunning(
      row,
      {
        chat_url: validated.value.chatUrl,
        ip: validated.value.ip,
        api_token: validated.value.apiToken,
      },
      "log_marker",
      now,
    );
    if (!flipped) {
      return { ...base, action: "skipped", reason: "status changed concurrently before recovery" };
    }
    const secretPath = hivraAgentProvisionSecretPath(context, row.vmid);
    if (secretPath && secret) {
      const cleanup = await runProxmoxHostScript(
        `rm -f -- ${shellQuote(secretPath)} && [ ! -e ${shellQuote(secretPath)} ]`,
        context.env,
        { timeoutMs: SSH_TIMEOUT_MS },
      );
      if (!cleanup.ok) {
        log.warn("recovered provision secret cleanup failed", {
          source: LOG_SOURCE,
          failureType: "hivra_agent_stuck_provisioning_secret_cleanup_failed",
          agentId: row.id,
          vmid: row.vmid,
          errorMessage: cleanup.error ?? cleanup.stderr?.slice(0, 300) ?? null,
        });
      }
    }
    return { ...base, action: "recovered_from_log", reason: "orchestrator log marker ready:true" };
  }

  if (marker && marker.ready === false) {
    // Orchestrator finished without a tunnel URL. A named tunnel can still have
    // come up after its in-script wait expired — trust a live healthz over the
    // stale marker; only a dead tunnel makes this terminal.
    const url = chatUrlForRow(row, marker);
    if (url && (await probeChatHealthz(url))) {
      const token = secret ?? marker.api_token ?? row.api_token;
      if (!row.ip) return { ...base, action: "skipped", reason: "persisted VM IP is unavailable" };
      const validated = validateHivraHostRunningResult({
        result: { ready: true, vmid: row.vmid, ip: row.ip, chat_url: url, api_token: token },
        expectedVmid: row.vmid,
        expectedIp: row.ip,
        namedHostname: row.cf_hostname,
        oneShotApiToken: secret,
        existingApiToken: row.api_token,
      });
      if (!validated.ok) {
        return { ...base, action: "skipped", reason: `tunnel result validation failed: ${validated.reason}` };
      }
      const flipped = await flipToRunning(
        row,
        { chat_url: validated.value.chatUrl, ip: validated.value.ip, api_token: validated.value.apiToken },
        "tunnel_healthz",
        now,
      );
      if (!flipped) return { ...base, action: "skipped", reason: "running completion was superseded" };
      return { ...base, action: "recovered_via_tunnel", reason: "marker ready:false but tunnel serves healthz" };
    }
    if (["start", "restart", "resize"].includes(String(row.operation_kind))) {
      return settleStaleLifecycleFromProviderState(
        row,
        vmStatus,
        vmConfig,
        "lifecycle helper published terminal ready:false",
      );
    }
    if (vmExists !== false && row.operation_kind === "provision") {
      if (nMinusOneCompatibility) {
        return { ...base, action: "skipped", reason: "legacy provision failed without owner tags; manual reconciliation required" };
      }
      return compensateFailedOwnedProvision(
        row,
        context,
        "stuck_provisioning_no_tunnel",
        "Provisioning finished without a reachable tunnel; the exactly owned VM was removed.",
      );
    }
    if (vmExists !== false) {
      return { ...base, action: "skipped", reason: "terminal helper result cannot be reconciled for this operation kind" };
    }
    const marked = await markError(row, "stuck_provisioning_no_tunnel", "Provisioning finished, cleanup removed the VM, and the box tunnel never became reachable");
    return marked
      ? { ...base, action: "marked_error", reason: "ready:false, tunnel unreachable, and VM absent" }
      : { ...base, action: "skipped", reason: "error completion was superseded" };
  }

  if (vmExists === false) {
    const marked = await markError(row, "stuck_provisioning_vm_missing", `VM ${row.vmid} no longer exists on ${row.proxmox_host ?? "host"} and provisioning never completed`);
    return marked
      ? { ...base, action: "marked_error", reason: "VM missing and no completion marker" }
      : { ...base, action: "skipped", reason: "error completion was superseded" };
  }

  // VM exists but no marker yet: either a slow provision still in flight or a
  // lost log. A healthy tunnel proves the box end-to-end either way.
  const url = chatUrlForRow(row, null);
  if (url && (await probeChatHealthz(url))) {
    const token = secret ?? row.api_token;
    if (!row.ip) return { ...base, action: "skipped", reason: "persisted VM IP is unavailable" };
    const validated = validateHivraHostRunningResult({
      result: { ready: true, vmid: row.vmid, ip: row.ip, chat_url: url, api_token: token },
      expectedVmid: row.vmid,
      expectedIp: row.ip,
      namedHostname: row.cf_hostname,
      oneShotApiToken: secret,
      existingApiToken: row.api_token,
    });
    if (!validated.ok) {
      return { ...base, action: "skipped", reason: `tunnel result validation failed: ${validated.reason}` };
    }
    const flipped = await flipToRunning(
      row,
      { chat_url: validated.value.chatUrl, ip: validated.value.ip, api_token: validated.value.apiToken },
      "tunnel_healthz",
      now,
    );
    if (!flipped) return { ...base, action: "skipped", reason: "running completion was superseded" };
    return { ...base, action: "recovered_via_tunnel", reason: "no marker yet but tunnel serves healthz" };
  }
  if (["start", "restart", "resize"].includes(String(row.operation_kind))) {
    return settleStaleLifecycleFromProviderState(
      row,
      vmStatus,
      vmConfig,
      "lifecycle helper exited without a healthy result",
    );
  }
  if (row.operation_kind === "provision" && !nMinusOneCompatibility) {
    // The observation threshold is not an installation deadline. A cold desktop
    // image can still be building with no public tunnel or completion marker.
    // Ownership proves which VM this is, not that its installer has failed.
    // Preserve the operation fence and provider state until a terminal result
    // arrives (or the owner explicitly requests cancellation). Even a missing
    // process/log alone would not prove the outcome of dispatched guest work.
    return {
      ...base,
      action: "skipped",
      reason: "VM exists with no terminal provision result; preserving pending installation",
    };
  }
  return { ...base, action: "skipped", reason: "VM exists, no marker, tunnel not healthy yet" };
}

/**
 * Release a stale Ubuntu desktop preparation lease only on host evidence that
 * no guest installer can still run, reconciling the row with the observed VM:
 *   - prepare never dispatched (phase claimed) ... existing atomic cancel
 *   - VM stopped ................................. fence + abandon; row -> stopped
 *   - VM running, installer lock free ............ fence; exact terminal receipt
 *                                                   completes, otherwise abandon
 *   - installer running / guest unreachable ...... preserve the lease
 *   - VM missing or ownership tag mismatch ....... preserve for an operator
 * The fence is written under FD8 before evidence is reported, so a late retry
 * of the same lease can never dispatch the installer after it is released.
 */
async function recoverStaleDesktopPreparation(row: StuckAgentRow, now: Date): Promise<StuckRecoveryResult> {
  const base = { agentId: row.id, vmid: row.vmid };
  if (!row.operation_id || !row.operation_started_at || row.operation_kind !== DESKTOP_PREPARE_KIND) {
    return { ...base, action: "skipped", reason: "desktop preparation identity is incomplete" };
  }
  // Omarchy and Windows preparation run outside FD8 and do not honour the
  // host fence, so their leases still need their own terminal receipt.
  if (row.type !== "linux-desktop" || (row.computer_profile ?? "ubuntu-desktop") !== "ubuntu-desktop") {
    return { ...base, action: "skipped", reason: "profile has no automatic desktop preparation recovery" };
  }
  if (!row.vmid || !row.ip || row.infrastructure_binding_token_enforced !== true) {
    return { ...base, action: "skipped", reason: "desktop preparation lacks an identity-bound provider coordinate" };
  }

  let context: HivraAgentExecutionContext;
  try {
    context = await resolveHivraAgentTeardownExecutionContext(row.user_id, row);
  } catch (error) {
    log.warn("stale desktop preparation authority is unavailable", {
      source: LOG_SOURCE,
      failureType: "hivra_stale_desktop_prepare_context_unavailable",
      agentId: row.id,
      vmid: row.vmid,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return { ...base, action: "skipped", reason: "owner-bound recovery authority unavailable" };
  }
  if (!context.infrastructureBindingTagEnforced) {
    return { ...base, action: "skipped", reason: "provider ownership tag is not enforced" };
  }
  const authorityCheck = await checkHivraAgentRecoveryAuthority(context);
  if (!authorityCheck.ok) {
    return { ...base, action: "skipped", reason: "owner-bound host authority unavailable" };
  }
  const claimed = await claimHivraAgentOperationRecovery({
    userId: row.user_id,
    agentId: row.id,
    operationId: row.operation_id,
    expectedOperationStartedAt: row.operation_started_at,
    recoveredAt: now.toISOString(),
  });
  if (!claimed) {
    return { ...base, action: "skipped", reason: "operation is fresh, superseded, or claimed by another reconciler" };
  }

  // A journal that never obtained dispatch authority has no provider work;
  // the existing cancel wins or loses atomically against a late dispatch.
  if (await cancelUndispatchedDesktopPrepare(row.user_id, row.operation_id)) {
    return { ...base, action: "released_desktop_prepare", reason: "undispatched desktop preparation cancelled" };
  }

  const identity = {
    operationId: row.operation_id,
    computerId: row.id,
    vmid: row.vmid,
    guestIp: row.ip,
    bindingTag: context.infrastructureBindingTag,
  };
  const probe = await runProxmoxHostScript(buildDesktopPrepareRecoveryScript(identity), context.env, {
    timeoutMs: SSH_TIMEOUT_MS,
  });
  const observation = probe.ok ? parseDesktopPrepareRecoveryOutput(probe.stdout || "", identity) : null;
  if (!observation) {
    log.warn("stale desktop preparation host observation failed; will retry", {
      source: LOG_SOURCE,
      failureType: "hivra_stale_desktop_prepare_probe_failed",
      agentId: row.id,
      vmid: row.vmid,
      proxmoxHost: row.proxmox_host,
      errorMessage: probe.error ?? null,
      stderr: probe.stderr?.slice(0, 300) ?? null,
    });
    return { ...base, action: "skipped", reason: "desktop preparation host observation failed" };
  }
  if (observation.kind === "missing" || observation.kind === "ownership_mismatch") {
    log.error("stale desktop preparation targets a VM this computer does not own", new Error(observation.kind), {
      source: LOG_SOURCE,
      failureType: "hivra_stale_desktop_prepare_provider_identity",
      agentId: row.id,
      vmid: row.vmid,
      proxmoxHost: row.proxmox_host,
      observation: observation.kind,
    });
    return { ...base, action: "skipped", reason: `desktop preparation preserved: ${observation.kind.replace("_", " ")}` };
  }
  if (observation.kind === "busy") {
    return { ...base, action: "skipped", reason: `desktop preparation preserved: ${observation.reason.replace(/_/g, " ")}` };
  }
  if (observation.kind === "terminal") {
    const completed = await completeDesktopPrepare(row.user_id, observation.receipt);
    return completed
      ? { ...base, action: "released_desktop_prepare", reason: "exact guest terminal receipt completed the preparation" }
      : { ...base, action: "skipped", reason: "desktop preparation completion was superseded" };
  }
  const abandoned = await abandonDesktopPrepare(row.user_id, {
    version: 1,
    operationId: row.operation_id,
    computerId: row.id,
    vmid: row.vmid,
    bindingTag: context.infrastructureBindingTag,
    ...(observation.vmStatus === "stopped"
      ? { vmStatus: "stopped", guestInstaller: "powered_off" }
      : { vmStatus: "running", guestInstaller: observation.guestInstaller }),
  });
  if (!abandoned) {
    return { ...base, action: "skipped", reason: "desktop preparation release was superseded" };
  }
  await logHivraAgentEvent({
    userId: row.user_id,
    event: "failed",
    agentId: row.id,
    agentType: row.type,
    detail: { vmid: row.vmid, reason: "desktop_prepare_abandoned", vmStatus: observation.vmStatus },
  });
  log.warn("stale desktop preparation released from quiescent provider state", {
    source: LOG_SOURCE,
    failureType: "hivra_stale_desktop_prepare_released",
    agentId: row.id,
    vmid: row.vmid,
    proxmoxHost: row.proxmox_host,
    vmStatus: observation.vmStatus,
    guestInstaller: observation.guestInstaller,
  });
  return {
    ...base,
    action: "released_desktop_prepare",
    reason: `guest installer quiescent (${observation.guestInstaller}); row reconciled to ${observation.vmStatus}`,
  };
}

export async function runRecoverStuckHivraProvisioningSweep(
  options: RecoverStuckHivraProvisioningOptions = {},
): Promise<RecoverStuckHivraProvisioningSummary> {
  const summary: RecoverStuckHivraProvisioningSummary = {
    scanned: 0,
    recovered: 0,
    markedError: 0,
    cancelled: 0,
    skipped: 0,
    results: [],
  };
  if (!supabaseAdmin) {
    log.error("supabase admin client unavailable; cannot sweep", new Error("supabaseAdmin missing"), {
      source: LOG_SOURCE,
      failureType: "hivra_stuck_sweep_no_db",
    });
    return summary;
  }

  const now = options.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - STUCK_PROVISIONING_THRESHOLD_MS).toISOString();

  let query = supabaseAdmin
    .from("hivra_agents")
    .select(STUCK_AGENT_COLUMNS)
    .not("operation_id", "is", null)
    // Desktop preparation has its own evidence rules and candidate cap below,
    // and an attached agent's steps end only through the attach worker's own
    // receipts; their long-lived leases must not be cleared by, or starve,
    // this limited lifecycle sweep.
    .not("operation_kind", "in", "(desktop_prepare,agent_attach,agent_access_change,agent_detach)")
    .lt("operation_started_at", cutoffIso)
    // Folder transfers have a dedicated encrypted-artifact resume path. Their
    // intentionally retained leases must not fill the oldest-12 snapshot/
    // lifecycle sweep forever and starve unrelated recoverable computers.
    .or("operation_kind.neq.restore,operation_payload->>folderRecoveryId.is.null")
    .order("operation_started_at", { ascending: true })
    .limit(MAX_CANDIDATES_PER_RUN);
  if (options.agentId) query = query.eq("id", options.agentId);

  const { data, error } = await query;
  if (error) {
    throw new Error(`stuck-provisioning candidate query failed: ${error.message}`);
  }

  const rows = (Array.isArray(data) ? data : []) as StuckAgentRow[];

  let prepareQuery = supabaseAdmin
    .from("hivra_agents")
    .select(STUCK_AGENT_COLUMNS)
    .eq("operation_kind", DESKTOP_PREPARE_KIND)
    .eq("type", "linux-desktop")
    .or("computer_profile.is.null,computer_profile.eq.ubuntu-desktop")
    .lt("operation_started_at", new Date(now.getTime() - STALE_DESKTOP_PREPARE_THRESHOLD_MS).toISOString())
    .order("operation_started_at", { ascending: true })
    .limit(MAX_DESKTOP_PREPARE_CANDIDATES_PER_RUN);
  if (options.agentId) prepareQuery = prepareQuery.eq("id", options.agentId);
  const { data: prepareData, error: prepareError } = await prepareQuery;
  if (prepareError) {
    throw new Error(`stale desktop preparation candidate query failed: ${prepareError.message}`);
  }
  const prepareRows = (Array.isArray(prepareData) ? prepareData : []) as StuckAgentRow[];
  summary.scanned = rows.length + prepareRows.length;

  // Sequential on purpose: each probe is an SSH session against a prod Proxmox
  // host; a stampede of parallel sessions is worse than a slightly longer cron.
  const candidates = [
    ...rows.map(row => ({ row, recover: recoverOne })),
    ...prepareRows.map(row => ({ row, recover: recoverStaleDesktopPreparation })),
  ];
  for (const { row, recover } of candidates) {
    try {
      const result = await recover(row, now);
      summary.results.push(result);
      if (
        result.action === "recovered_from_log" ||
        result.action === "recovered_via_tunnel" ||
        result.action === "released_desktop_prepare"
      ) {
        summary.recovered += 1;
      } else if (result.action === "marked_error") {
        summary.markedError += 1;
      } else if (result.action === "cancelled_delete") {
        summary.cancelled += 1;
      } else {
        summary.skipped += 1;
      }
    } catch (err) {
      summary.skipped += 1;
      summary.results.push({
        agentId: row.id,
        vmid: row.vmid,
        action: "skipped",
        reason: `sweep step threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      log.error("stuck hivra agent recovery step failed", err, {
        source: LOG_SOURCE,
        failureType: "hivra_agent_stuck_recovery_step_failed",
        agentId: row.id,
        vmid: row.vmid,
        proxmoxHost: row.proxmox_host,
      });
    }
  }

  if (summary.scanned > 0) {
    log.info("stuck hivra provisioning sweep finished", {
      source: LOG_SOURCE,
      scanned: summary.scanned,
      recovered: summary.recovered,
      markedError: summary.markedError,
      cancelled: summary.cancelled,
      skipped: summary.skipped,
    });
  }
  return summary;
}
