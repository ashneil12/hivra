// Hivra agents — provision (POST) + list (GET).
// Reuses the existing Proxmox SSH machinery (runProxmoxHostScript) to kick the
// host-side orchestrator (hivra-provision-on-host.sh) on the selected Proxmox
// host in the background, and tracks each agent in the hivra_agents table.

export const runtime = "nodejs";
// Allocation may wait behind the 60-second host lock and then wait up to 60
// seconds for the exact provider identity receipt. Keep headroom so the control
// plane cannot terminate between durable intent and DB identity persistence.
export const maxDuration = 180;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { posthogClient } from "@/lib/posthog";
import { getManagedVeniceProxyBaseUrl } from "@/lib/venice/managed-endpoints";
import {
  DEFAULT_PROXMOX_VM_DISK_GB,
  getReservedProxmoxVmidsForNode,
  runProxmoxHostScript,
} from "@/lib/services/proxmox-instance-service";
import { resolveRamBurst } from "@/lib/services/ram-burst";
import { selectAvailableProxmoxProvisionTarget } from "@/lib/services/instance-service";
import { BoxTunnelProvisionError, deleteBoxTunnel, isTunnelConfigured } from "@/lib/services/cloudflare-tunnel";
import { provisionHivraAgentTunnel } from "@/lib/hivra/agent-tunnel-provisioning";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { getOrCreatePoolId } from "@/lib/pools/pool-service";
import { priorityToCpuUnits } from "@/lib/proxmox/cpu-priority";
import { validateResourceEnvelope } from "@/lib/launch/resource-envelope";
import { checkHostWakeCapacity } from "@/lib/proxmox/wake-admission";
import { GOALS } from "@/lib/hivra/agent-identity";
import { MAX_CONTEXT_LEN } from "@/lib/hivra/agent-limits";
import { validateAgentResources, isActiveComputeStatus, planAgentLimitMessage, resolvePlanAgentSlots } from "@/lib/hivra/resource-gate";
import { getAgent, resizeFloor } from "@/lib/hivra/agent-catalog";
import { getComputerTemplate, type ComputerTemplateId } from "@/lib/hivra/computer-catalog";
import { validateLlmInput, sanitizeHivraAgentRow, type StoredLlmConfig } from "@/lib/hivra/agent-llm";
import { getTemplateForLaunch, type TemplateIdentity } from "@/lib/hivra/agent-templates";
import { bankrSkillsDirForType } from "@/lib/hivra/bankr-skills-seed";
import { coerceSkillIds } from "@/lib/hivra/template-skills";
import { createManagedVeniceProxyKey, revokeManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { encryptApiKey } from "@/lib/crypto";
import { getInfrastructureDeploymentTarget, InfrastructureConnectionStoreError } from "@/lib/infrastructure/connection-store";
import { isGvisorDeploymentTarget, isProxmoxDeploymentTarget } from "@/lib/infrastructure/contracts";
import type { ProxmoxHostCapacityPolicy } from "@/lib/infrastructure/contracts";
import {
  buildHostCapacityAdmissionCommand,
  DEFAULT_PROXMOX_HOST_CAPACITY_POLICY,
} from "@/lib/infrastructure/host-capacity-policy";
import { launchProviderAgent, ProviderAgentLaunchError, type ProviderAgentLaunchInput } from "@/lib/hivra/provider-agent-launch";
import { GvisorComputerError, launchGvisorComputer } from "@/lib/hivra/gvisor-computer-service";
import { createLaunchModelAdmissionService, type LaunchModelAdmission } from "@/lib/hivra/launch-model-admission";
import { LaunchModelRequestError, LaunchPlanAgentLimitError } from "@/lib/hivra/launch-model-store";
import { ModelKeyStoreError } from "@/lib/hivra/model-key-store";
import {
  createHivraLaunchOperationService,
  HivraLaunchOperationRequestError,
  HivraLaunchOperationStoreError,
  type HivraLaunchOperationAdmission,
  type HivraLaunchOperationReplay,
  type HivraLaunchRequestIntent,
} from "@/lib/hivra/launch-operation-store";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
import { isLocalAuthMode } from "@/lib/self-host/config";
import {
  parseAgentDeploymentDestination,
  targetSupportsCatalogRuntime,
  targetSupportsLaunchModelSettings,
} from "@/lib/hivra/agent-placement";
import {
  SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL,
  hivraInfrastructureBindingTag,
} from "@/lib/hivra/agent-authority";
import {
  beginHivraAgentVmAllocation,
  checkpointHivraAgentOperation,
  completeHivraAgentDelete,
  failHivraAgentBeforeAllocation,
  isHivraAgentAuthorityConflict,
  persistHivraAgentProvisionIdentity,
  recordHivraAgentOperationFailure,
  releaseHivraAgentOperation,
} from "@/lib/hivra/agent-operation-store";
import {
  ProxmoxExecutionContextError,
  resolveSelfManagedProxmoxExecutionContext,
  type PortableProxmoxRuntime,
} from "@/lib/infrastructure/proxmox-execution-context";
import { checkManagedHivraHostReadiness } from "@/lib/hivra/managed-provisioner-readiness";
import {
  managedHivraProvisionerChannelConfiguration,
  managedHivraProvisionerChannelForServerEnvironment,
  type ManagedHivraProvisionerChannel,
  type ManagedHivraRuntimePaths,
} from "@/lib/hivra/managed-provisioner-channel";
import {
  resolveHivraClaudeCodeProxmoxHost,
  resolveHivraIpLastOctetStart,
  resolveHivraNetworkConfig,
  resolveHivraProxmoxHost,
  resolveHivraVmidEnd,
  resolveHivraVmidStart,
  shellQuote,
} from "@/lib/hivra/proxmox-target";
import {
  activityControlOrigin,
  issueActivityCollectorCredential,
  recordActivityCollectorIssued,
  supportsNativeTracing,
  type ActivityCollectorCredential,
} from "@/lib/activity-observability/collectors";
import {
  PORTABLE_HIVRA_PROVISIONER_VERSION,
  provisionerSupportsActivityTelemetry,
} from "@/lib/infrastructure/portable-provisioner-contract";

// Process-lifetime once-guard for the hivra-lane box_created emit. Same
// rationale as emittedBoxCreatedInstanceIds in instance-service.ts (#353):
// $insert_id only collapses duplicates inside PostHog's ingestion window, so
// retries / duplicate POSTs that re-reach the emit in a warm process need an
// in-memory claim to give effective exactly-once semantics.
const emittedBoxCreatedAgentIds = new Set<string>();

// Catalog agent ids this route can provision as a Hivra box. claude-code/codex
// run the bux image; aeon + openclaw host a web dashboard/Control UI. The box
// selects its runtime from agentKind. Hermes is a separate lane (/api/instances).
const LAUNCHABLE_BOX_TYPES: ReadonlySet<string> = new Set(["claude-code", "codex", "aeon", "openclaw", "agent-zero", "linux-desktop"]);

// Printed by phase 1 only after it wrote the reporter credential into the
// handoff file for a host bundle that consumes it (the start path uses the
// same line). Issuance is recorded only when this line is observed.
const ACTIVITY_CREDENTIAL_STAGED = "HIVRA_ACTIVITY_CREDENTIAL_STAGED";

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function clampCpu(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  const halfStep = Math.round(n * 2) / 2;
  return Math.min(max, Math.max(min, halfStep));
}

// Trim a free-text field to a hard ceiling; null when empty so we don't persist
// "" over a meaningful default.
function clampStr(v: unknown, max: number): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : null;
}

function launchOperationReplayResponse(replay: HivraLaunchOperationReplay) {
  if (replay.state === "accepted") {
    return apiSuccess({
      agent: sanitizeHivraAgentRow(replay.agent),
      launchRequestId: replay.requestId,
      launch: { state: "accepted", phase: "accepted" },
    }, replay.responseStatus);
  }
  if (replay.state === "failed") {
    const messages: Record<string, string> = {
      agent_insert_conflict: "The selected infrastructure authority changed before launch. Refresh and start a new request.",
      agent_insert_failed: "The computer could not be created. Start a new launch request.",
      provider_model: "This model connection is not ready for the selected computer.",
      provider_template: "Installing template skills on this cloud computer is not supported yet.",
      provider_capacity: "This computer does not have enough measured free resources for that agent.",
      provider_conflict: "This computer is already assigned or its connection changed.",
      provider_not_ready: "This cloud computer is not ready for launch.",
      provider_access: "Secure access is not configured on this Hivra installation.",
      plan_agent_limit: "Your plan's agent limit was reached before this computer was created. Upgrade for more slots, or remove an agent first.",
    };
    return apiError(messages[replay.failureCode] ?? "The launch failed before a computer was created.",
      replay.failureStatus, undefined, {
        code: replay.failureCode,
        launchRequestId: replay.requestId,
        launch: { state: "failed", phase: "failed" },
      });
  }
  return apiSuccess({
    launchRequestId: replay.requestId,
    launch: { state: "reconciling", phase: replay.phase },
  }, 202);
}

function submittedLaunchRequestIntent(
  body: Record<string, unknown>,
  deployment: NonNullable<ReturnType<typeof parseAgentDeploymentDestination>>,
  templateRef: string | null,
): HivraLaunchRequestIntent {
  const optionalString = (value: unknown, trim = false): string | null => {
    if (value === undefined || value === null || value === "") return null;
    const stringValue = String(value);
    return trim ? stringValue.trim() || null : stringValue;
  };
  const optionalNumber = (value: unknown): number | null => {
    if (value === undefined || value === null || value === "") return null;
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  };
  return {
    type: optionalString(body.type),
    name: optionalString(body.name, true),
    computerProfile: typeof body.computerProfile === "string" && body.computerProfile.trim()
      ? body.computerProfile.trim() : null,
    cpu: optionalNumber(body.cpu),
    ram: optionalNumber(body.ram),
    ...(body.maximumCpu === undefined ? {} : { maximumCpu: optionalNumber(body.maximumCpu) }),
    ...(body.maximumRam === undefined ? {} : { maximumRam: optionalNumber(body.maximumRam) }),
    browser: body.browser === true,
    goal: clampStr(body.goal, 32),
    context: clampStr(body.context, MAX_CONTEXT_LEN),
    personality: clampStr(body.personality, 48),
    emoji: clampStr(body.emoji, 16),
    managedVenice: body.managedVenice === true,
    templateRef,
    modelMode: body.llm === undefined || body.llm === null ? "native" : "explicit",
    deployment,
  };
}

// The bundle version a Proxmox launch will execute, when admission pins it.
// Self-managed targets carry verified evidence and the managed Canary channel
// admits only the current release. Managed default hosts may run any
// compatible predecessor, so it stays unknown and phase 1 probes the exact
// bundle on the host before staging the credential.
function launchProvisionerVersion(
  portableRuntime: PortableProxmoxRuntime | null,
  channel: ManagedHivraProvisionerChannel,
): string | null {
  if (portableRuntime) return portableRuntime.provisionerVersion;
  return channel === "canary" ? PORTABLE_HIVRA_PROVISIONER_VERSION : null;
}

// Phase 1 (synchronous over SSH): pick a free VMID in range, kick the host
// orchestrator in the background (it does VM create + provisioner + tunnel,
// ~10 min), and print a marker so this call returns in seconds.
function phase1Script(params: {
  cpu: number;
  cpuLimit: number;
  memMb: number;
  guaranteedMemMb: number;
  agentKind: string;
  modelKey?: string;
  modelBaseUrl?: string;
  model?: string;
  tunnelToken: string;
  tunnelUrl: string;
  wantBrowser: boolean;
  subnetPrefix: string;
  gateway: string;
  vmidStart: number;
  vmidEnd: number;
  reservedVmids: ReadonlyArray<number>;
  ipLastOctetStart: number;
  operationId: string;
  infrastructureBindingTag: string;
  managedRuntimePaths: ManagedHivraRuntimePaths;
  portableRuntime?: PortableProxmoxRuntime | null;
  computerId?: string;
  controlOrigin?: string;
  capacityPolicy: ProxmoxHostCapacityPolicy;
  // Travels only in the root-only secret handoff file, never argv or logs.
  activityTelemetry?: ActivityCollectorCredential | null;
}): string {
  const runtime = params.portableRuntime ?? null;
  const runtimePaths = runtime ?? params.managedRuntimePaths;
  const logDirectory = runtimePaths.logDirectory;
  const logName = runtime ? `provision-$VMID.log` : `hivra-prov-$VMID.log`;
  const provisionerDirectory = runtimePaths.provisionerDirectory;
  const operationTag = `hivra-op-${params.operationId.replace(/-/g, "")}`;
  // The desktop profile has its own contained desktop and explicitly rejects
  // the agent-browser option. The shared launcher historically serialized a
  // false toggle as "0"; that is correct for agent guests, but the desktop
  // provisioner treats any non-empty value as an attempted agent-browser
  // configuration. Keep the variable empty for this distinct runtime.
  const wantBrowserEnvValue = params.agentKind === "linux-desktop"
    ? ""
    : params.wantBrowser ? "1" : "0";
  // Exactly the four keys the host and guest validators accept. Empty when
  // absent, so an older host bundle simply reads no credential.
  const telemetry = params.activityTelemetry ?? null;
  const activityTelemetryDocument = telemetry
    ? JSON.stringify({
        endpoint: telemetry.endpoint,
        resourceId: telemetry.resourceId,
        token: telemetry.token,
        expiresAt: telemetry.expiresAt,
      })
    : "";
  // Admission accepts compatible predecessor bundles that silently drop the
  // credential. Stage it only when this exact bundle consumes it end to end:
  // the host script reads the handoff key, the guest installer reports the
  // reporter's install status (fail-open), and the reporter sources ship
  // alongside. The key is always written (empty when not staged), and only a
  // staged credential prints the marker the route records issuance from.
  const activityTelemetryProbe = telemetry
    ? `HIVRA_ACTIVITY_STAGE=0
if grep -Fq HIVRA_ACTIVITY_TELEMETRY_B64 ${shellQuote(`${provisionerDirectory}/hivra-provision-on-host.sh`)} 2>/dev/null \\
  && grep -Fq HIVRA_ACTIVITY_COLLECTOR ${shellQuote(`${provisionerDirectory}/hivra-install-agent.py`)} 2>/dev/null \\
  && [ -f ${shellQuote(`${provisionerDirectory}/hivra-agent-trace.py`)} ] \\
  && [ -f ${shellQuote(`${provisionerDirectory}/hivra-agent-trace.service`)} ]; then
  HIVRA_ACTIVITY_STAGE=1
fi`
    : "HIVRA_ACTIVITY_STAGE=0";
  const activityTelemetryHandoff = telemetry
    ? `printf 'HIVRA_ACTIVITY_TELEMETRY_B64='; if [ "$HIVRA_ACTIVITY_STAGE" = 1 ]; then write_secret_b64 ${shellQuote(activityTelemetryDocument)}; else printf '\\n'; fi`
    : `printf 'HIVRA_ACTIVITY_TELEMETRY_B64='; write_secret_b64 ''`;
  const hostEnvironment = [
    `HIVRA_PROV_DIR=${shellQuote(runtimePaths.provisionerDirectory)}`,
    `HIVRA_STORAGE=${shellQuote(runtimePaths.storage)}`,
    `HIVRA_BRIDGE=${shellQuote(runtimePaths.bridge)}`,
    `HIVRA_UBUNTU_IMG=${shellQuote(runtimePaths.ubuntuImage)}`,
    `HIVRA_VM_SSH_KEY_PATH=${shellQuote(runtimePaths.vmSshKeyPath)}`,
    `HIVRA_LOG_DIR=${shellQuote(runtimePaths.logDirectory)}`,
    `HIVRA_COMPUTER_ID=${shellQuote(params.computerId ?? "")}`,
    `HIVRA_CONTROL_ORIGIN=${shellQuote(params.controlOrigin ?? "")}`,
  ].join(" ") + " ";
  const hostCapacityAdmission = buildHostCapacityAdmissionCommand({
    provisionerDirectory: runtimePaths.provisionerDirectory,
    floorMemoryMb: params.guaranteedMemMb,
    maximumMemoryMb: params.memMb,
    maximumCpu: params.cpuLimit,
    policy: params.capacityPolicy,
  });
  const portableStorageAdmission = runtime
    ? `STORAGE_AVAILABLE_KB="$(pvesm status --content images 2>/dev/null | awk -v target=${shellQuote(runtime.storage)} 'NR>1 && $1==target && $3=="active" {print $6; exit}')"
[[ "$STORAGE_AVAILABLE_KB" =~ ^[0-9]+$ ]] \
  || { echo "could not measure live storage capacity" >&2; exit 1; }
STORAGE_REQUIRED_KB=$(((${DEFAULT_PROXMOX_VM_DISK_GB} + 5) * 1024 * 1024))
if [ "$STORAGE_AVAILABLE_KB" -lt "$STORAGE_REQUIRED_KB" ]; then
  echo "insufficient live storage headroom for this launch" >&2
  exit 1
fi`
    : "";
  const kickoff = runtime
    ? `nohup env HIVRA_PID_FILE="$PIDFILE" HIVRA_SECRET_ENV_FILE="$SECRET_ENV_FILE" HIVRA_OPERATION_ID=${shellQuote(params.operationId)} HIVRA_BINDING_TAG=${shellQuote(params.infrastructureBindingTag)} HIVRA_ALLOCATION_LOCK_FD=8 ${hostEnvironment}HIVRA_WANT_BROWSER=${shellQuote(wantBrowserEnvValue)} HIVRA_SUBNET_PREFIX=${shellQuote(params.subnetPrefix)} HIVRA_GW=${shellQuote(params.gateway)} bash ${shellQuote(provisionerDirectory)}/hivra-provision-on-host.sh "$VMID" "$OCTET" "${params.cpu}" "${params.memMb}" "${params.agentKind}" "${params.cpuLimit}" >> "$LOG" 2>&1 < /dev/null &
PROVISION_PID=$!
printf '%s\\n' "$PROVISION_PID" > "$PIDFILE"
disown`
    : `REAL_QM="$(command -v qm)"
case "$REAL_QM" in /*) ;; *) echo "could not resolve the real qm executable" >&2; exit 1 ;; esac
[ -x "$REAL_QM" ] || { echo "real qm executable is unavailable" >&2; exit 1; }
[ "$(stat -Lc '%u:%g' "$REAL_QM" 2>/dev/null)" = "0:0" ] \\
  || { echo "real qm executable is not root-owned" >&2; exit 1; }
EXPECTED_IP="${params.subnetPrefix}.$OCTET"
WRAPPER_DIR=${shellQuote(`/run/hivra-provision/operation-${params.operationId}.bin`)}
QM_WRAPPER="$WRAPPER_DIR/qm"
install -d -o root -g root -m 0700 "$WRAPPER_DIR"
install -o root -g root -m 0700 /dev/null "$QM_WRAPPER"
cat > "$QM_WRAPPER" <<'HIVRA_QM_WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
: "\${HIVRA_REAL_QM:?}"
: "\${HIVRA_EXPECTED_VMID:?}"
: "\${HIVRA_OPERATION_TAG:?}"
: "\${HIVRA_BINDING_TAG:?}"
if [ "\${1:-}" = create ] && [ "\${2:-}" = "$HIVRA_EXPECTED_VMID" ]; then
  existing_tags=""
  forward_args=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --tags)
        [ "$#" -ge 2 ] || { echo "qm create supplied --tags without a value" >&2; exit 64; }
        tag_value="\${2%;}"
        tag_value="\${tag_value#;}"
        [ -z "$tag_value" ] || existing_tags="\${existing_tags:+$existing_tags;}$tag_value"
        shift 2
        ;;
      --tags=*)
        tag_value="\${1#--tags=}"
        tag_value="\${tag_value%;}"
        tag_value="\${tag_value#;}"
        [ -z "$tag_value" ] || existing_tags="\${existing_tags:+$existing_tags;}$tag_value"
        shift
        ;;
      *)
        forward_args+=("$1")
        shift
        ;;
    esac
  done
  combined_tags="$existing_tags"
  for required_tag in "$HIVRA_BINDING_TAG" "$HIVRA_OPERATION_TAG"; do
    if ! printf '%s\\n' "$combined_tags" | tr ';' '\\n' | grep -Fxq "$required_tag"; then
      combined_tags="\${combined_tags:+$combined_tags;}\${required_tag}"
    fi
  done
  exec "$HIVRA_REAL_QM" "\${forward_args[@]}" --tags "$combined_tags"
fi
exec "$HIVRA_REAL_QM" "$@"
HIVRA_QM_WRAPPER
chown root:root "$QM_WRAPPER"
chmod 0700 "$QM_WRAPPER"
(
  exec 8>&-
  exec 9>&-
  read_secret_b64() { sed -n "s/^$1=//p" "$SECRET_ENV_FILE" | head -1 | base64 -d; }
  export HIVRA_TUNNEL_TOKEN="$(read_secret_b64 HIVRA_TUNNEL_TOKEN_B64)"
  export HIVRA_TUNNEL_URL="$(read_secret_b64 HIVRA_TUNNEL_URL_B64)"
  export HIVRA_MODEL_KEY="$(read_secret_b64 HIVRA_MODEL_KEY_B64)"
  export HIVRA_MODEL_BASE_URL="$(read_secret_b64 HIVRA_MODEL_BASE_URL_B64)"
  export HIVRA_HERMES_MODEL="$(read_secret_b64 HIVRA_HERMES_MODEL_B64)"
  export HIVRA_ACTIVITY_TELEMETRY="$(read_secret_b64 HIVRA_ACTIVITY_TELEMETRY_B64)"
  rm -f -- "$SECRET_ENV_FILE"
  exec env PATH="$WRAPPER_DIR:\${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}" HIVRA_REAL_QM="$REAL_QM" HIVRA_EXPECTED_VMID="$VMID" HIVRA_PID_FILE="$PIDFILE" HIVRA_OPERATION_ID=${shellQuote(params.operationId)} HIVRA_OPERATION_TAG=${shellQuote(operationTag)} HIVRA_BINDING_TAG=${shellQuote(params.infrastructureBindingTag)} ${hostEnvironment}HIVRA_WANT_BROWSER=${shellQuote(wantBrowserEnvValue)} HIVRA_SUBNET_PREFIX=${shellQuote(params.subnetPrefix)} HIVRA_GW=${shellQuote(params.gateway)} bash ${shellQuote(provisionerDirectory)}/hivra-provision-on-host.sh "$VMID" "$OCTET" "${params.cpu}" "${params.memMb}" "${params.agentKind}"
) >> "$LOG" 2>&1 < /dev/null &
PROVISION_PID=$!
printf '%s\\n' "$PROVISION_PID" > "$PIDFILE"
disown
# Survive an SSH/control-plane disconnect without reopening VMID/IP allocation.
# The legacy child closes FD8/FD9; this detached guardian keeps both locks until
# the operation-scoped qm wrapper has atomically stamped the exact tags and the
# provisioner has committed the expected private IP. A foreign VM that races into
# the VMID remains untagged, never receives a receipt, and cannot be rolled back
# as Hivra-owned. Keep the wrapper until the child exits because later qm set/start
# calls in the legacy script still resolve through its operation-scoped PATH.
(
  cleanup_wrapper() {
    rm -f -- "$QM_WRAPPER"
    rmdir -- "$WRAPPER_DIR" 2>/dev/null || true
  }
  child_is_exact_operation() {
    local cmd
    [ -r "/proc/$PROVISION_PID/cmdline" ] && [ -r "/proc/$PROVISION_PID/environ" ] || return 1
    cmd="$(tr '\\0' ' ' < "/proc/$PROVISION_PID/cmdline")"
    printf '%s' "$cmd" | grep -Fq ${shellQuote(`hivra-provision-on-host.sh $VMID `)} || return 1
    tr '\\0' '\\n' < "/proc/$PROVISION_PID/environ" \
      | grep -Fxq ${shellQuote(`HIVRA_OPERATION_ID=${params.operationId}`)} || return 1
    tr '\\0' '\\n' < "/proc/$PROVISION_PID/environ" \
      | grep -Fxq ${shellQuote(`HIVRA_BINDING_TAG=${params.infrastructureBindingTag}`)}
  }
  vm_has_exact_identity_and_ip() {
    local config tags ipconfig
    config="$(qm config "$VMID" 2>/dev/null)" || return 1
    tags="$(printf '%s\\n' "$config" | sed -n 's/^tags:[[:space:]]*//p')"
    ipconfig="$(printf '%s\\n' "$config" | sed -n 's/^ipconfig0:[[:space:]]*//p')"
    printf '%s\\n' "$tags" | tr ';' '\\n' | grep -Fxq ${shellQuote(params.infrastructureBindingTag)} \
      && printf '%s\\n' "$tags" | tr ';' '\\n' | grep -Fxq ${shellQuote(operationTag)} \
      && printf '%s\\n' "$ipconfig" | tr ',' '\\n' | grep -Fxq "ip=$EXPECTED_IP/24" \
      && [ "$(qm status "$VMID" 2>/dev/null | awk '{print $2}')" = "running" ]
  }
  child_confirmed=0
  for _ in $(seq 1 40); do
    if child_is_exact_operation; then child_confirmed=1; break; fi
    kill -0 "$PROVISION_PID" 2>/dev/null || break
    sleep 0.05
  done
  [ "$child_confirmed" = 1 ] || { cleanup_wrapper; exit 0; }
  while ! vm_has_exact_identity_and_ip; do
    child_is_exact_operation || { cleanup_wrapper; exit 0; }
    sleep 0.25
  done
  ALLOCATION_RECEIPT="/run/hivra-provision/$VMID.allocated"
  RECEIPT_TMP="$ALLOCATION_RECEIPT.tmp.guardian.$$"
  install -o root -g root -m 0600 /dev/null "$RECEIPT_TMP"
  printf 'operation_id=%s\\nbinding_tag=%s\\nvmid=%s\\nip=%s\\n' \
    ${shellQuote(params.operationId)} ${shellQuote(params.infrastructureBindingTag)} "$VMID" "$EXPECTED_IP" \
    > "$RECEIPT_TMP"
  mv -f -- "$RECEIPT_TMP" "$ALLOCATION_RECEIPT"
  flock -u 8
  flock -u 9
  exec 8>&-
  exec 9>&-
  while child_is_exact_operation; do sleep 1; done
  cleanup_wrapper
) >/dev/null 2>&1 &
LOCK_GUARDIAN_PID=$!
disown`;
  return `#!/usr/bin/env bash
set -euo pipefail
umask 077
VMID=""
RESERVED_VMIDS=${shellQuote(params.reservedVmids.map(String).join("\n"))}
command -v flock >/dev/null 2>&1 || { echo "flock is required for safe VMID allocation" >&2; exit 1; }
command -v base64 >/dev/null 2>&1 || { echo "base64 is required for secret handoff" >&2; exit 1; }
install -d -m 0755 /run/lock/hivra-vmids
install -d -m 0755 /run/hivra-provision
install -d -m 0700 /var/lib/hivra/provision-operations
# Serialize the short allocation window across every Hivra launch on this
# target. A per-VMID lock prevents duplicate VM identities, but without this
# host-wide lock two concurrent launches can both observe the same unused IP
# before either background provisioner writes its VM configuration. FD 8 is
# inherited by the provisioner and released after the VM is configured and
# running, so another launch cannot admit against capacity before this one is
# active and visible in the host inventory.
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "timed out waiting for the Hivra allocation lock" >&2; exit 1; }
# Inventory is intentionally captured only after FD 8 is held. A launcher that
# waited behind another provision must observe the predecessor's committed VM
# configuration and private IP, rather than allocate from its pre-wait snapshot.
local_vmids="$(qm list | awk 'NR>1{print $1}')"
cluster_resources="$(pvesh get /cluster/resources --type vm --output-format json 2>/dev/null)" \
  || { echo "could not read cluster-wide VMID inventory" >&2; exit 1; }
cluster_vmids="$(printf '%s' "$cluster_resources" | grep -oE '"vmid":[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | sort -un || true)"
intent_vmids="$(for intent in /var/lib/hivra/provision-operations/operation-*.selected; do
  [ -f "$intent" ] || continue
  awk -F= '$1=="vmid" && $2 ~ /^[0-9]+$/ {print $2}' "$intent"
done | sort -un)"
${hostCapacityAdmission}
${portableStorageAdmission}
claimed_vmids="$(printf '%s\\n%s\\n' "$cluster_vmids" "$intent_vmids" | sed '/^$/d' | sort -un)"
if [ -n "$RESERVED_VMIDS" ]; then
  claimed_vmids="$(printf '%s\\n%s\\n' "$claimed_vmids" "$RESERVED_VMIDS" | sed '/^$/d' | sort -un)"
fi
for c in $(seq ${params.vmidStart} ${params.vmidEnd}); do
  if printf '%s\\n' "$claimed_vmids" | grep -qx "$c"; then continue; fi
  exec 9>"/run/lock/hivra-vmids/$c.lock"
  if flock -n 9; then VMID="$c"; break; fi
  exec 9>&-
done
[ -n "$VMID" ] || { echo "no free vmid in ${params.vmidStart}-${params.vmidEnd}" >&2; exit 1; }
# Last octets already configured on this host's private subnet, read from every
# VM's cloud-init ipconfig0. The octet MUST avoid these: a VMID-derived octet is
# not collision-safe because out-of-band VMs (an older vmid->octet scheme, manual
# boxes) can already occupy an octet in this range. A duplicate IP makes the new
# guest unreachable (host->guest ARP races) and lets later lifecycle/maintenance
# ssh hit the wrong tenant's box.
claimed_octets="$(
  for v in $local_vmids; do qm config "$v" 2>/dev/null || true; done \
    | grep -oE 'ip=[0-9.]+/' | awk -F. '{print $NF}' | tr -d '/'
  for intent in /var/lib/hivra/provision-operations/operation-*.selected; do
    [ -f "$intent" ] || continue
    awk -F= '$1=="ip" {split($2, parts, "."); if (parts[4] ~ /^[0-9]+$/) print parts[4]}' "$intent"
  done
)"
claimed_octets="$(printf '%s\\n' "$claimed_octets" | sed '/^$/d' | sort -un)"
# Prefer the VMID-aligned octet (keeps IPs tidy when free); fall back to the first
# free octet in range when it collides.
pref=$((${params.ipLastOctetStart} + VMID - ${params.vmidStart}))
OCTET=""
for cand in "$pref" $(seq ${params.ipLastOctetStart} 254); do
  if [ "$cand" -ge 2 ] && [ "$cand" -le 254 ] && ! printf '%s\\n' "$claimed_octets" | grep -qx "$cand"; then OCTET="$cand"; break; fi
done
[ -n "$OCTET" ] || { echo "no free private IPv4 octet on this host for VMID $VMID (start octet ${params.ipLastOctetStart})" >&2; exit 1; }
install -d -m 0750 ${shellQuote(logDirectory)}
LOG=${shellQuote(logDirectory)}/${logName}
install -m 0600 /dev/null "$LOG"
install -d -m 0755 /run/hivra-provision
PIDFILE="/run/hivra-provision/$VMID.pid"
SECRET_ENV_FILE="/run/hivra-provision/$VMID.env"
INTENT_FILE=${shellQuote(`/var/lib/hivra/provision-operations/operation-${params.operationId}.selected`)}
INTENT_TMP="$INTENT_FILE.tmp.$$"
{
  printf 'operation_id=%s\\n' ${shellQuote(params.operationId)}
  printf 'vmid=%s\\n' "$VMID"
  printf 'ip=${params.subnetPrefix}.%s\\n' "$OCTET"
  printf 'binding_tag=%s\\n' ${shellQuote(params.infrastructureBindingTag)}
  printf 'binding_enforced=%s\\n' 1
} > "$INTENT_TMP"
chmod 0600 "$INTENT_TMP"
mv -f -- "$INTENT_TMP" "$INTENT_FILE"
printf 'HIVRA_ALLOCATION_SELECTED {"vmid":%s,"ip":"${params.subnetPrefix}.%s"}\\n' "$VMID" "$OCTET"
${activityTelemetryProbe}
install -m 0600 /dev/null "$SECRET_ENV_FILE"
write_secret_b64() { printf '%s' "$1" | base64 -w 0; printf '\n'; }
{
  printf 'HIVRA_TUNNEL_TOKEN_B64='; write_secret_b64 ${shellQuote(params.tunnelToken)}
  printf 'HIVRA_TUNNEL_URL_B64='; write_secret_b64 ${shellQuote(params.tunnelUrl)}
  printf 'HIVRA_MODEL_KEY_B64='; write_secret_b64 ${shellQuote(params.modelKey ?? "")}
  printf 'HIVRA_MODEL_BASE_URL_B64='; write_secret_b64 ${shellQuote(params.modelBaseUrl ?? "")}
  printf 'HIVRA_HERMES_MODEL_B64='; write_secret_b64 ${shellQuote(params.model ?? "")}
  ${activityTelemetryHandoff}
} > "$SECRET_ENV_FILE"
if [ "$HIVRA_ACTIVITY_STAGE" = 1 ]; then echo ${ACTIVITY_CREDENTIAL_STAGED}; fi
${kickoff}
ALLOCATION_RECEIPT="/run/hivra-provision/$VMID.allocated"
allocation_receipt_is_exact() {
  [ -f "$ALLOCATION_RECEIPT" ] || return 1
  [ "$(stat -Lc '%a:%u:%g' "$ALLOCATION_RECEIPT" 2>/dev/null)" = "600:0:0" ] || return 1
  grep -Fxq ${shellQuote(`operation_id=${params.operationId}`)} "$ALLOCATION_RECEIPT" \\
    && grep -Fxq ${shellQuote(`binding_tag=${params.infrastructureBindingTag}`)} "$ALLOCATION_RECEIPT" \\
    && grep -Fxq "vmid=$VMID" "$ALLOCATION_RECEIPT"
}
# A selected VMID is only an intent. Publish the control-plane result after the
# exact root-owned ownership receipt exists. This protects both the portable
# provisioner and the managed compatibility guardian from a foreign VM claiming
# the inventory gap after selection. Allow a short grace after child exit so the
# detached guardian can atomically move its receipt into place.
dead_checks=0
for _ in $(seq 1 240); do
  allocation_receipt_is_exact && break
  if kill -0 "$PROVISION_PID" 2>/dev/null; then
    dead_checks=0
  else
    dead_checks=$((dead_checks + 1))
    [ "$dead_checks" -lt 20 ] || break
  fi
  sleep 0.25
done
allocation_receipt_is_exact \\
  || { echo "provisioner exited before producing an ownership receipt" >&2; exit 1; }
printf 'HIVRA_PROVISION_RESULT {"vmid":%s,"ip":"${params.subnetPrefix}.%s"}\\n' "$VMID" "$OCTET"
`;
}

function parsePhase1AllocationIdentity(input: {
  stdout: string;
  vmidStart: number;
  vmidEnd: number;
  subnetPrefix: string;
}): { vmid: number; ip: string; receipt: "allocated" | "selected" } | null {
  const markers: Array<{ pattern: RegExp; receipt: "allocated" | "selected" }> = [
    { pattern: /HIVRA_PROVISION_RESULT\s+(\{[^}]*\})/, receipt: "allocated" },
    { pattern: /HIVRA_ALLOCATION_SELECTED\s+(\{[^}]*\})/, receipt: "selected" },
  ];
  for (const marker of markers) {
    const match = input.stdout.match(marker.pattern);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]) as { vmid?: unknown; ip?: unknown };
      const vmid = Number(parsed.vmid);
      const ip = typeof parsed.ip === "string" ? parsed.ip : "";
      const octet = Number(ip.slice(`${input.subnetPrefix}.`.length));
      if (
        Number.isSafeInteger(vmid) &&
        vmid >= input.vmidStart &&
        vmid <= input.vmidEnd &&
        ip.startsWith(`${input.subnetPrefix}.`) &&
        Number.isInteger(octet) &&
        octet >= 2 &&
        octet <= 254 &&
        ip === `${input.subnetPrefix}.${octet}`
      ) {
        return { vmid, ip, receipt: marker.receipt };
      }
    } catch {
      // Try the next marker; malformed host output never becomes authority.
    }
  }
  return null;
}

function rollbackAllocatedVmScript(
  vmid: number,
  operationId: string,
  storage: string,
  infrastructureBindingTag: string,
): string {
  const operationTag = `hivra-op-${operationId.replace(/-/g, "")}`;
  return `#!/usr/bin/env bash
set -euo pipefail
VMID=${vmid}
OPERATION_ID=${shellQuote(operationId)}
OPERATION_TAG=${shellQuote(operationTag)}
BINDING_TAG=${shellQuote(infrastructureBindingTag)}
STORAGE=${shellQuote(storage)}
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "timed out waiting for the Hivra rollback lock" >&2; exit 1; }
PIDFILE="/run/hivra-provision/$VMID.pid"
vm_owned_by_operation() {
  tags="$(qm config "$VMID" 2>/dev/null | sed -n 's/^tags:[[:space:]]*//p')" || return 1
  printf '%s\\n' "$tags" | tr ';' '\\n' | grep -Fxq "$OPERATION_TAG" \
    && printf '%s\\n' "$tags" | tr ';' '\\n' | grep -Fxq "$BINDING_TAG"
}
if [ -r "$PIDFILE" ]; then
  PID="$(tr -dc '0-9' < "$PIDFILE")"
  if [ -n "$PID" ] && [ -r "/proc/$PID/cmdline" ] && [ -r "/proc/$PID/environ" ]; then
    CMD="$(tr '\\0' ' ' < "/proc/$PID/cmdline")"
    if printf '%s' "$CMD" | grep -Fq "hivra-provision-on-host.sh $VMID " \
       && tr '\\0' '\\n' < "/proc/$PID/environ" | grep -Fxq "HIVRA_OPERATION_ID=$OPERATION_ID" \
       && tr '\\0' '\\n' < "/proc/$PID/environ" | grep -Fxq "HIVRA_BINDING_TAG=$BINDING_TAG"; then
      kill "$PID" 2>/dev/null || true
      for _ in $(seq 1 40); do
        kill -0 "$PID" 2>/dev/null || break
        sleep 0.25
      done
    fi
  fi
fi
if qm status "$VMID" >/dev/null 2>&1; then
  vm_owned_by_operation || { echo "refusing to destroy VMID $VMID without operation ownership tag" >&2; exit 1; }
  for _ in 1 2 3; do
    qm status "$VMID" >/dev/null 2>&1 || break
    vm_owned_by_operation || { echo "VMID $VMID ownership changed during rollback" >&2; exit 1; }
    qm stop "$VMID" --timeout 30 >/dev/null 2>&1 || true
    qm destroy "$VMID" --purge 1 --destroy-unreferenced-disks 1 >/dev/null 2>&1 || true
    sleep 1
  done
fi
qm status "$VMID" >/dev/null 2>&1 && { echo "VMID $VMID still exists after rollback" >&2; exit 1; }
VOLUMES="$(pvesm list "$STORAGE" 2>/dev/null)" \
  || { echo "could not verify storage $STORAGE after rollback" >&2; exit 1; }
printf '%s\\n' "$VOLUMES" | grep -Eq "vm-${vmid}-" \
  && { echo "VMID $VMID still has volumes on $STORAGE" >&2; exit 1; }
rm -f -- "$PIDFILE" "/run/hivra-provision/$VMID.env" "/run/hivra-provision/$VMID.secret" "/run/hivra-provision/$VMID.allocated" "/var/lib/hivra/provision-results/$VMID.secret"
printf 'HIVRA_VM_ROLLBACK_OK %s\\n' "$VMID"
`;
}

async function resolveStickyHivraProxmoxHost(userId: string): Promise<string | null> {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("hivra_agents")
    .select("id, proxmox_host, status, created_at")
    .eq("user_id", userId)
    .eq("deployment_mode", "hivra-managed")
    .neq("status", "deleted");

  if (error) {
    log.warn("hivra sticky host lookup failed; falling back to allocator", {
      source: "hivra/agents",
      failureType: "hivra_agent_sticky_host_lookup_failed",
      userId,
      errorMessage: String(error.message ?? error),
    });
    return null;
  }

  const rows = (Array.isArray(data) ? data : []).filter((row) =>
    isActiveComputeStatus((row as { status?: unknown }).status)
  );
  const hostStats = new Map<string, { count: number; oldestCreatedAt: string; sampleAgentId: string | null }>();
  for (const row of rows) {
    const record = row as { id?: unknown; proxmox_host?: unknown; created_at?: unknown };
    const host = typeof record.proxmox_host === "string" ? record.proxmox_host.trim() : "";
    if (!host) continue;
    const createdAt = typeof record.created_at === "string" && record.created_at.trim()
      ? record.created_at.trim()
      : "9999-12-31T23:59:59.999Z";
    const existing = hostStats.get(host);
    if (existing) {
      existing.count += 1;
      if (createdAt < existing.oldestCreatedAt) existing.oldestCreatedAt = createdAt;
      continue;
    }
    hostStats.set(host, {
      count: 1,
      oldestCreatedAt: createdAt,
      sampleAgentId: typeof record.id === "string" ? record.id : null,
    });
  }

  if (hostStats.size === 0) return null;

  const rankedHosts = Array.from(hostStats.entries()).sort(([hostA, a], [hostB, b]) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.oldestCreatedAt !== b.oldestCreatedAt) return a.oldestCreatedAt < b.oldestCreatedAt ? -1 : 1;
    return hostA.localeCompare(hostB);
  });
  const [selectedHost, selectedStats] = rankedHosts[0];
  if (rankedHosts.length > 1) {
    log.warn("hivra user has agents on multiple Proxmox hosts; sticking new launches to dominant host", {
      source: "hivra/agents",
      failureType: "hivra_agent_multi_host_sticky_selection",
      userId,
      selectedHost,
      selectedCount: selectedStats.count,
      hosts: rankedHosts.map(([host, stats]) => ({ host, count: stats.count })),
      recoveryAction: "migrate_existing_agents_to_selected_host_or_set_explicit_override",
    });
  }

  log.info("hivra sticky Proxmox host selected from existing user agents", {
    source: "hivra/agents",
    userId,
    proxmoxHost: selectedHost,
    existingAgentCountOnHost: selectedStats.count,
    sampleAgentId: selectedStats.sampleAgentId,
  });
  return selectedHost;
}

export async function POST(request: NextRequest) {
  const response = await launchAgent(request);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function launchAgent(request: NextRequest) {
  try {
    // Canary/prod gate: Hivra boxes only launch where the feature is explicitly
    // enabled. Host selection is separate and uses the Proxmox allocator unless
    // ops deliberately pins a dedicated lane.
    if (!isHivraApiAllowed(request.headers.get("host"))) return apiError("Not found", 404);
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    // Every destination can carry model credentials or reserve resources.
    // Gate the actual launch endpoint before reading a potentially secret body,
    // not just the provider adapter after parsing and target discovery.
    if (!isSameOriginMutationRequest(request)) return apiError("Open launch from this dashboard to create a computer.", 403);
    if (!hasStrictJsonContentType(request)) return apiError("Send launch settings as JSON.", 415);
    const limited = enforceAuthenticatedRouteRateLimit(request, { routeKey: "hivra_agent_launch", userId, limit: 10, windowMs: 5 * 60_000 });
    if (limited) return limited;
    const parsedBody = await readBoundedJson(request, 32 * 1024, 5000);
    if (!parsedBody.ok) return apiError("Send complete launch settings of at most 32 KB.", parsedBody.reason === "too_large" ? 413 : 400);
    if (!parsedBody.body || typeof parsedBody.body !== "object" || Array.isArray(parsedBody.body)) return apiError("Launch settings must be a JSON object.", 400);
    const body = parsedBody.body as Record<string, unknown>;
    const deployment = parseAgentDeploymentDestination(body.deployment);
    if (!deployment) return apiError("Invalid deployment destination", 400);

    // Wave 5.2 "use template" / fork: a launch may reference a saved template by
    // id or slug. Resolve it through the registry-style loader (which enforces
    // visibility + strips `context` for non-owners) and use its identity fields
    // as the BASE — any field explicitly set on the request body still wins, so
    // "fork then tweak" works. The template carries only the portable identity
    // (type/name/goal/context/personality/emoji/llm_config), never any secret;
    // the LLM key + minted proxy key are re-derived/re-minted below as usual.
    // A bad/forbidden templateId is a hard 400 rather than a silent direct
    // launch — the user asked to fork a specific thing.
    const templateRef =
      typeof body.templateId === "string" && body.templateId.trim()
        ? body.templateId.trim()
        : typeof body.templateSlug === "string" && body.templateSlug.trim()
          ? body.templateSlug.trim()
          : null;
    const submittedRequestIntent = submittedLaunchRequestIntent(body, deployment, templateRef);
    if (body.launchRequestId === undefined
      && (submittedRequestIntent.type === "codex" || submittedRequestIntent.type === "linux-desktop"
        || submittedRequestIntent.type === "linux-terminal")) {
      return apiError("Include a valid stable launch request ID and complete launch settings.", 400,
        undefined, { code: "invalid_request" });
    }
    let earlyLaunchOperations: ReturnType<typeof createHivraLaunchOperationService> | null = null;
    if (body.launchRequestId !== undefined) {
      // Receipt lookup depends only on the owner, stable request ID, and the
      // secret-free fields the client submitted. It deliberately precedes
      // mutable template/catalog/tunnel checks so a previously accepted launch
      // remains replayable after installation configuration drifts.
      earlyLaunchOperations = createHivraLaunchOperationService();
      const existing = await earlyLaunchOperations.lookup(userId, body.launchRequestId, submittedRequestIntent);
      if (existing.existing) return launchOperationReplayResponse(existing.existing);
    }
    let managedProvisionerChannel: ManagedHivraProvisionerChannel = "default";
    if (deployment.mode === "hivra-managed") {
      try {
        managedProvisionerChannel = managedHivraProvisionerChannelForServerEnvironment(process.env);
      } catch (error) {
        log.error("managed Hivra provisioner deployment channel is invalid", error, {
          source: "hivra/agents",
          failureType: "hivra_agent_managed_provisioner_channel_invalid",
        });
        return apiError("Managed computer delivery is not configured safely in this environment.", 503);
      }
    }
    const managedRuntimePaths = managedHivraProvisionerChannelConfiguration(
      managedProvisionerChannel,
    ).runtime;
    let template: TemplateIdentity | null = null;
    if (templateRef) {
      template = await getTemplateForLaunch(templateRef, userId);
      if (!template) return apiError("Template not found or not available", 404);
    }
    const pick = (bodyVal: unknown, tplVal: unknown): unknown =>
      bodyVal !== undefined && bodyVal !== null && bodyVal !== "" ? bodyVal : tplVal ?? undefined;

    const type = String(pick(body.type, template?.type) || "claude-code");
    if (body.launchRequestId === undefined && (type === "codex" || type === "linux-desktop" || type === "linux-terminal")) {
      return apiError("Include a valid stable launch request ID and complete launch settings.", 400,
        undefined, { code: "invalid_request" });
    }
    const def = getAgent(type);
    const name = String(pick(body.name, template?.name) || def?.name || "Agent").trim();
    if (type === "linux-terminal") {
      if (templateRef || deployment.mode !== "self-managed") {
        return apiError("Linux terminal sandboxes require an exact connected gVisor host target.", 400);
      }
      if (body.computerProfile !== undefined && body.computerProfile !== "linux-terminal") {
        return apiError("Linux terminal sandboxes require the linux-terminal computer profile.", 400);
      }
      if (body.browser === true || body.managedVenice === true || body.llm !== undefined) {
        return apiError("Linux terminal sandboxes do not support browser, managed model, or model-key settings.", 400);
      }
      if (name.length < 1 || name.length > 60) return apiError("Name must be 1–60 characters", 400);
      const launchRequestId = typeof body.launchRequestId === "string" ? body.launchRequestId : "";
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(launchRequestId)) {
        return apiError("Include a valid stable launch request ID and complete launch settings.", 400);
      }
      const cpu = Number(body.cpu);
      const ram = Number(body.ram);
      const maximumCpu = body.maximumCpu === undefined ? cpu : Number(body.maximumCpu);
      const maximumRam = body.maximumRam === undefined ? ram : Number(body.maximumRam);
      if (!Number.isFinite(cpu) || cpu < 0.5 || cpu > 32 || Math.round(cpu * 2) !== cpu * 2
        || !Number.isInteger(ram) || ram < 1 || ram > 128
        || maximumCpu !== cpu || maximumRam !== ram) {
        return apiError("gVisor computers reserve their full CPU and memory limit; reserved and maximum values must match.", 400);
      }
      let target;
      try {
        target = await getInfrastructureDeploymentTarget(userId, deployment.targetId);
      } catch (error) {
        if (error instanceof InfrastructureConnectionStoreError && error.code === "not_found") {
          return apiError("Infrastructure target not found.", 404);
        }
        return apiError("Could not verify the selected infrastructure target.", 503);
      }
      if (!isGvisorDeploymentTarget(target)
        || target.status !== "ready"
        || !target.capabilities.launchReady
        || target.connectionId !== deployment.connectionId
        || target.evidenceConnectionRevision !== deployment.expectedConnectionRevision) {
        return apiError("Inspect the exact connected gVisor host again before launching.", 409);
      }
      try {
        const row = await launchGvisorComputer({
          userId,
          targetId: deployment.targetId,
          launchRequestId,
          name,
          cpu,
          ramGb: ram,
        });
        return apiSuccess({
          agent: sanitizeHivraAgentRow(row),
          launchRequestId,
          launch: { state: "accepted", phase: "accepted" },
        }, 201);
      } catch (error) {
        if (error instanceof GvisorComputerError) {
          const status = error.code === "not_found" ? 404
            : error.code === "conflict" || error.code === "not_ready" ? 409 : 503;
          return apiError(error.message, status, undefined, {
            code: error.code,
            launchRequestId,
            ...(error.computerId ? { computerId: error.computerId } : {}),
          });
        }
        throw error;
      }
    }
    const requestedComputerProfile = typeof body.computerProfile === "string"
      ? body.computerProfile.trim()
      : null;
    let computerProfile: ComputerTemplateId | null = null;
    let computerTemplate = null;
    if (def?.resourceKind === "computer") {
      computerProfile = (requestedComputerProfile || "ubuntu-desktop") as ComputerTemplateId;
      computerTemplate = getComputerTemplate(computerProfile);
      if (!computerTemplate) return apiError("Unknown computer profile", 400);
      if (!computerTemplate.launchable || computerTemplate.runtimeId !== type) {
        return apiError(`${computerTemplate.name} isn't launchable yet`, 409);
      }
      if (computerProfile === "omarchy" || computerProfile === "windows") {
        return apiError("Use the prepared Canary computer launch path for this profile.", 409);
      }
    } else if (requestedComputerProfile) {
      return apiError("Computer profiles can only be used when launching a computer", 400);
    }
    // Browser automation is opt-in at launch (paid-gated client-side). Only honor
    // it for agents that actually ship a browser stack — Codex's CLI has none.
    const wantBrowser = body.browser === true && Boolean(def?.browser);
    const poolExempt = Boolean(def?.poolExempt);
    const floor = resizeFloor(type, wantBrowser);
    // Pool-exempt dashboard hosts (Aeon) reserve a fixed, tiny footprint — there's
    // no resource picker, so the request is pinned to the agent's floor.
    const cpu = computerTemplate
      ? clampCpu(body.cpu, computerTemplate.requirements.cpu, computerTemplate.requirements.cpu, 8)
      : poolExempt ? floor.cpu : clampCpu(body.cpu, 0.5, 0.5, 8);
    const ram = computerTemplate
      ? clampInt(body.ram, computerTemplate.requirements.ramGb, computerTemplate.requirements.ramGb, 16)
      : poolExempt ? floor.ram : clampInt(body.ram, 1, 1, 16);
    const hasExplicitEnvelope = body.maximumCpu !== undefined || body.maximumRam !== undefined;
    const supportsUnifiedEnvelope = type === "codex"
      || (type === "linux-desktop" && computerProfile === "ubuntu-desktop");
    if (hasExplicitEnvelope && !supportsUnifiedEnvelope) {
      return apiError("Resource guarantees and maxima are supported only for Codex and Ubuntu Desktop launches.", 400);
    }
    const profileId = type === "linux-desktop" ? "ubuntu-desktop" : "codex";
    // Codex's floor depends on the browser sidecar actually being provisioned:
    // browser-off Codex keeps the same base floor as the legacy pinned launch.
    const envelopeResult = hasExplicitEnvelope
      ? validateResourceEnvelope(profileId, {
          cpu,
          ram,
          maximumCpu: clampCpu(body.maximumCpu, cpu, 0.5, 8),
          maximumRam: clampInt(body.maximumRam, ram, 1, 16),
        }, undefined, { browser: wantBrowser })
      : { ok: true as const, envelope: { cpu, ram, maximumCpu: cpu, maximumRam: ram } };
    if (!envelopeResult.ok) return apiError("Choose a resource maximum at or above the profile floor and reserved allocation.", 400);
    const maximumCpu = envelopeResult.envelope.maximumCpu;
    const maximumRam = envelopeResult.envelope.maximumRam;

    // Onboarding (the bootstrap system): what the agent is for + how it shows up.
    // goal is validated against the catalog; the rest are clamped free text. All
    // optional — a launch with no onboarding still gets a sensible derived
    // identity. When forking a template, the template's identity is the base and
    // any field set on the body overrides it (clampStr/validation still apply to
    // the merged value, so a stale template can't bypass the limits). For a
    // shared (non-owner) template `context` was already stripped upstream.
    const goalRaw = clampStr(pick(body.goal, template?.goal), 32);
    const goal = goalRaw && GOALS.some((g) => g.id === goalRaw) ? goalRaw : null;
    const context = clampStr(pick(body.context, template?.context), MAX_CONTEXT_LEN);
    const personality = clampStr(pick(body.personality, template?.personality), 48);
    const emoji = clampStr(pick(body.emoji, template?.emoji), 16);
    // Launch-time managed-Venice opt-in. Catalog-gated: only honored for agent
    // types whose box-side wiring exists (def.managedVenice), so a stray flag on
    // an unsupported type can never mark an agent "billed" with no way to spend
    // the wallet. The connect step defaults its wiring toggle from this column;
    // everything stays opt-in — the column defaults false.
    const managedVenice = body.managedVenice === true && Boolean(def?.managedVenice);

    // The launchable box agents (claude-code, codex, aeon). Guard so a mis-typed
    // or not-yet-available agent can't provision a box. (Hermes is a separate lane
    // provisioned via /api/instances, not here.)
    if (!def || !def.available || !LAUNCHABLE_BOX_TYPES.has(type)) {
      return apiError("That agent isn't launchable yet", 400);
    }
    // The runtime the box provisions: the chat CLI for claude-code/codex, or the
    // dashboard host kind for aeon/openclaw (no cliKind). Passed to the host script.
    const agentKind = def.provisionKind ?? def.cliKind ?? (type === "aeon" ? "aeon" : type === "openclaw" ? "openclaw"
      : type === "agent-zero" ? "agent-zero" : type === "deepseek-harness" ? "deepseek-harness" : "claude");
    const compatibilityRuntimeId = type;
    const desktopControlOrigin = type === "linux-desktop" ? activityControlOrigin() : null;
    if (type === "linux-desktop" && (!desktopControlOrigin || !isTunnelConfigured())) {
      return apiError(
        "Ubuntu Desktop requires this Hivra installation's canonical HTTPS access and named-tunnel configuration.",
        503,
      );
    }

    // Optional alternative LLM provider (Venice byok/managed). Validated against
    // the agent type's declared capability; absent = native vendor auth.
    const llmValidation = validateLlmInput(body.llm, type);
    if (!llmValidation.ok) return apiError(llmValidation.error || "Invalid LLM config", 400);
    const llmInput = llmValidation.input ?? null;
    // managedVenice:true (catalog type + wallet opt-in) auto-builds a managed llm
    // block when the client did not send one, so the box ALWAYS gets a brain key
    // baked at launch — BUT only for managed-Venice types that have NO connect
    // step (e.g. operatoros). Connect-flow agents (Aeon, def.connect set) mint
    // their managed key during the user-driven connect step instead
    // (HivraGitHubConnect → mintVeniceWiring), seeded from the persisted
    // managed_venice opt-in; auto-minting here would orphan a second proxy key.
    // Keying off `managedVenice && !def.connect` (rather than a hardcoded cliKind)
    // keeps today's behavior identical — operatoros: managedVenice + no connect →
    // auto-block; Aeon: managedVenice + connect → deferred — while staying correct
    // if operatoros becomes launchable or another no-connect managed type is added.
    const autoManagedLlmBlock = managedVenice && Boolean(def?.managedVenice) && !def?.connect;
    const resolvedLlmInput = (llmInput ?? (autoManagedLlmBlock
      ? { provider: "venice", mode: "managed", walletType: "hermesos" }
      : null)) as typeof llmInput;

    const templateSkills = template && bankrSkillsDirForType(type) ? coerceSkillIds(template.skills) : [];
    const launchModels = type === "codex" && resolvedLlmInput ? createLaunchModelAdmissionService() : null;
    let launchAdmission: LaunchModelAdmission | null = null;
    const launchOperations = (type === "codex" && !resolvedLlmInput) || type === "linux-desktop"
      ? earlyLaunchOperations ?? createHivraLaunchOperationService()
      : null;
    let launchOperationAdmission: HivraLaunchOperationAdmission | null = null;
    if (!launchModels && !launchOperations && body.launchRequestId !== undefined) {
      return apiError("A launch request ID is supported only for Codex and Ubuntu Desktop launches.", 400);
    }
    if (launchOperations) {
      // Close the lookup/reservation race and capture the effective integrity
      // digest. The submitted digest remains the replay/conflict authority.
      const prepared = await launchOperations.prepare(userId, body.launchRequestId, submittedRequestIntent, {
        resourceKind: def.resourceKind === "computer" ? "computer" : "agent",
        runtimeId: type,
        name,
        computerProfile,
        cpu,
        ram,
        maximumCpu,
        maximumRam,
        browser: wantBrowser,
        goal,
        context,
        personality,
        emoji,
        managedVenice,
        templateRef,
        templateSkills,
        desktopControlOrigin,
        deployment,
      });
      if (prepared.existing) return launchOperationReplayResponse(prepared.existing);
      launchOperationAdmission = prepared.admission;
    }
    if (launchModels) {
      // Resolve the original request BEFORE target selection or capacity work.
      // Retries cannot allocate again if the first acknowledgement was lost.
      const prepared = await launchModels.prepare(userId, body.launchRequestId, {
        type, name, cpu, ram,
        ...(hasExplicitEnvelope ? { maximumCpu, maximumRam } : {}),
        browser: wantBrowser, goal, context, personality, emoji,
        templateSkills, deployment, llm: resolvedLlmInput,
      });
      if (prepared.existing) return apiSuccess({ agent: sanitizeHivraAgentRow(prepared.existing.agent),
        launchRequestId: prepared.existing.requestId }, 200);
      launchAdmission = prepared.admission;
      if (!isTunnelConfigured() && !(isLocalAuthMode() && deployment.mode === "self-managed")) {
        return apiError("Secure model-settings access is not configured on this Hivra installation. Use native sign-in or configure named access before launching with a model key.", 503);
      }
    }

    if (deployment.mode === "self-managed") {
      // Select the substrate from the exact owner-bound target, never a browser
      // supplied host/server ID. A provider computer cannot enter the Proxmox
      // allocator, consume a managed pool, or mint an implicit model credit key.
      let target;
      try { target = await getInfrastructureDeploymentTarget(userId, deployment.targetId); }
      catch (error) {
        if (error instanceof InfrastructureConnectionStoreError && error.code === "not_found") return apiError("Infrastructure target not found.", 404);
        return apiError("Could not verify the selected infrastructure target.", 503);
      }
      if (!isProxmoxDeploymentTarget(target)) {
        if (def.resourceKind === "computer" && (type !== "linux-desktop" || computerProfile !== "ubuntu-desktop")) {
          return apiError(
            "This computer profile does not have a provider launch adapter yet.",
            409,
          );
        }
        try {
          if (launchOperations) {
            if (!launchOperationAdmission) throw new HivraLaunchOperationStoreError();
            const reservation = await launchOperations.reserve(launchOperationAdmission);
            if (!reservation.created) return launchOperationReplayResponse(reservation.existing);
          }
          const providerInput: ProviderAgentLaunchInput = { userId, targetId: deployment.targetId,
            connectionId: deployment.connectionId, expectedConnectionRevision: deployment.expectedConnectionRevision,
            type: type as ProviderAgentLaunchInput["type"], name, browser: wantBrowser,
            ...(type === "linux-desktop" ? { computerProfile: "ubuntu-desktop" as const } : {}),
            ...(launchOperationAdmission ? { launchOperationId: launchOperationAdmission.operationId } : {}),
            goal, context, personality, emoji, managedVenice, llm: resolvedLlmInput,
            templateSkills };
          const result = launchModels && launchAdmission
            ? await launchProviderAgent(providerInput, undefined, { service: launchModels, admission: launchAdmission })
            : await launchProviderAgent(providerInput);
          if (launchOperations && launchOperationAdmission) {
            const providerAgentId = typeof result.agent?.id === "string" ? result.agent.id : "";
            await launchOperations.bindAgent(launchOperationAdmission, providerAgentId);
            const accepted = await launchOperations.accept(launchOperationAdmission, providerAgentId, 202);
            return launchOperationReplayResponse(accepted);
          }
          const response = apiSuccess(result, 202);
          response.headers.set("Cache-Control", "no-store");
          return response;
        } catch (error) {
          if (error instanceof HivraLaunchOperationRequestError || error instanceof HivraLaunchOperationStoreError) throw error;
          if (error instanceof ProviderAgentLaunchError) {
            const status = ["model", "capacity", "template"].includes(error.code)
              ? 400 : error.code === "conflict" || error.code === "not_ready" ? 409 : 503;
            if (launchOperations && launchOperationAdmission) {
              if (error.code === "unconfirmed") {
                return launchOperationReplayResponse(await launchOperations.markReconciling(launchOperationAdmission));
              }
              return launchOperationReplayResponse(await launchOperations.fail(
                launchOperationAdmission, status, `provider_${error.code}`,
              ));
            }
            return apiError(error.message, status);
          }
          if (launchOperations && launchOperationAdmission) {
            return launchOperationReplayResponse(await launchOperations.markReconciling(launchOperationAdmission));
          }
          return apiError("Could not confirm cloud agent launch. Check your agents before trying again.", 503);
        }
      }
    }

    // Only the standalone provider adapter above can bind VM-owned HTTPS.
    // Proxmox/model-key launches still require their existing named access;
    // a browser-selected self-managed destination alone cannot relax it.
    if (launchModels && !isTunnelConfigured()) {
      return apiError("Secure model-settings access is not configured on this Hivra installation. Use native sign-in or configure named access before launching with a model key.", 503);
    }

    let env: Record<string, string | undefined>;
    let host: string;
    let portableRuntime: PortableProxmoxRuntime | null = null;
    let capacityPolicy: ProxmoxHostCapacityPolicy = DEFAULT_PROXMOX_HOST_CAPACITY_POLICY;
    let stickyHost: string | null = null;
    let explicitClaudeHost: string | null = null;

    if (deployment.mode === "self-managed") {
      // Subscription checks do not apply to user-owned compute, but the agent
      // runtime's real minimum still does. Enforce it at the API boundary so a
      // custom client cannot create an undersized, permanently unhealthy box.
      if (cpu < floor.cpu || ram < floor.ram) {
        return apiError(
          `${def.name} requires at least ${floor.cpu} CPU and ${floor.ram} GB RAM${wantBrowser ? " with browser automation" : ""}.`,
          400,
        );
      }
      try {
        const context = await resolveSelfManagedProxmoxExecutionContext(userId, {
          connectionId: deployment.connectionId,
          targetId: deployment.targetId,
          expectedConnectionRevision: deployment.expectedConnectionRevision,
        });
        env = context.env;
        host = context.runtime.node;
        portableRuntime = context.runtime;
        capacityPolicy = context.capacityPolicy ?? DEFAULT_PROXMOX_HOST_CAPACITY_POLICY;

        if (!targetSupportsCatalogRuntime(context.target, compatibilityRuntimeId)) {
          return apiError(
            `Run preflight again: this infrastructure target does not have compatibility evidence for ${def.name}.`,
            409,
          );
        }
        if (launchAdmission && !targetSupportsLaunchModelSettings(context.target, type)) {
          return apiError("This host needs the model-settings provisioner update before launch with an API key. Prepare it again, or launch with native sign-in.", 409);
        }

        const requestedMemoryBytes = ram * 1024 * 1024 * 1024;
        const requestedDiskBytes = DEFAULT_PROXMOX_VM_DISK_GB * 1024 * 1024 * 1024;
        const capacity = context.target.capacity;
        if (
          (capacity.cpu.totalCores !== null && maximumCpu > capacity.cpu.totalCores) ||
          (capacity.memoryBytes.available !== null && requestedMemoryBytes > capacity.memoryBytes.available) ||
          (capacity.memoryBytes.total !== null && maximumRam * 1024 * 1024 * 1024 > capacity.memoryBytes.total) ||
          (capacity.storageBytes?.available !== null &&
            capacity.storageBytes?.available !== undefined &&
            requestedDiskBytes > capacity.storageBytes.available)
        ) {
          return apiError("This infrastructure target does not have enough measured capacity for that agent.", 409);
        }
      } catch (error) {
        if (error instanceof ProxmoxExecutionContextError) {
          const status = error.code === "connection_not_found" || error.code === "target_not_found" ? 404 : 409;
          const message = error.code === "connection_stale"
            ? "This infrastructure connection changed. Run the check again before launching."
            : error.code === "network_unavailable"
              ? "Hivra cannot currently reach this infrastructure target."
              : error.code === "credential_unavailable"
                ? "This infrastructure credential must be replaced before launching."
                : error.code === "connection_not_found" || error.code === "target_not_found"
                  ? "Infrastructure target not found."
                  : "This infrastructure target is not ready to launch agents.";
          return apiError(message, status);
        }
        throw error;
      }
    } else {
      const resourceGate = await validateAgentResources({ userId, type, cpu, ram, maximumCpu, maximumRam, browser: wantBrowser, mode: "launch", poolExempt, floor, agentLabel: def.name });
      if (!resourceGate.ok) return apiError(resourceGate.message, resourceGate.status);

      explicitClaudeHost = LAUNCHABLE_BOX_TYPES.has(type) ? resolveHivraClaudeCodeProxmoxHost(process.env) : null;
      stickyHost = explicitClaudeHost ? null : await resolveStickyHivraProxmoxHost(userId);
      const forceTargetId = explicitClaudeHost ?? stickyHost;
      const placement = await selectAvailableProxmoxProvisionTarget({
        supabase: supabaseAdmin,
        env: process.env,
        hostConfig: null,
        userId,
        neededCpu: cpu,
        neededRamMb: ram * 1024,
        neededDiskGb: DEFAULT_PROXMOX_VM_DISK_GB,
        forceTargetId,
        skipTemplateAvailabilityCheck: true,
        readinessCheck: launchAdmission
          ? candidate => checkManagedHivraHostReadiness({
              ...candidate,
              channel: managedProvisionerChannel,
              requireModelSettings: true,
            })
          : candidate => checkManagedHivraHostReadiness({
              ...candidate,
              channel: managedProvisionerChannel,
            }),
      });
      if (!placement.ok) {
        log.warn("hivra launch blocked: no Proxmox placement target available", {
          source: "hivra/agents",
          failureType: "hivra_agent_no_proxmox_placement_target",
          userId,
          agentType: type,
          requestedCpu: cpu,
          requestedRam: ram,
          placementStatus: placement.status,
          placementMessage: placement.message,
          placementError: placement.error ?? null,
        });
        return apiError(placement.message, placement.status);
      }
      env = placement.env;
      host = placement.targetId ?? env.PROXMOX_NODE ?? resolveHivraProxmoxHost();
      if (hasExplicitEnvelope) {
        const maximumEvidence = await runProxmoxHostScript(`set -euo pipefail
HOST_CPU="$(nproc)"
HOST_RAM_MB="$(awk '$1=="MemTotal:" {print int($2/1024)}' /proc/meminfo)"
[[ "$HOST_CPU" =~ ^[0-9]+$ && "$HOST_RAM_MB" =~ ^[0-9]+$ ]] \\
  || { echo "could not measure selected host totals" >&2; exit 1; }
[ "$HOST_CPU" -ge ${Math.ceil(maximumCpu)} ] && [ "$HOST_RAM_MB" -ge ${maximumRam * 1024} ] \\
  || { echo "resource maximum exceeds selected host totals" >&2; exit 1; }
printf 'HIVRA_RESOURCE_MAXIMUM_FITS %s %s\\n' "$HOST_CPU" "$HOST_RAM_MB"`, env);
        if (!maximumEvidence.ok || !maximumEvidence.stdout.includes("HIVRA_RESOURCE_MAXIMUM_FITS ")) {
          return apiError("No managed host can enforce that CPU and memory maximum.", 409);
        }
      }
    }

    // Provision and compensation must inspect the same storage target. Managed
    // fleet environment records can still carry historical PROXMOX_STORAGE
    // values, but the admitted bundle above is explicitly launched against the
    // reviewed managed layout. Letting rollback consult that ambient value could
    // destroy the VM successfully and then falsely report leaked volumes on a
    // different datastore, retaining an ambiguous operation forever.
    const allocationStorage =
      portableRuntime?.storage ?? managedRuntimePaths.storage;

    const vmidStart = resolveHivraVmidStart(env);
    const vmidEnd = resolveHivraVmidEnd(env, vmidStart);
    const ipLastOctetStart = resolveHivraIpLastOctetStart(env);

    // Provision-time OOM guard. The start path already gates wakes on live host
    // RAM; new provisions had no such check, so a saturated host would boot the
    // guest into swap, miss the provisioner's ssh window, and strand a half-dead
    // box (the recurring fixturenodea failure). Fail fast with the "at capacity" UX
    // instead. Fails open on a flaky probe, so it never blocks on noise.
    const provisionCapacity = await checkHostWakeCapacity(ram * 1024, env);
    // Managed fleet admission has historically failed open so a transient
    // telemetry probe does not block every customer. A user-selected target is
    // different: before creating a DB row, tunnel, key, or VM, require live
    // memory evidence from that exact credential and target.
    if (deployment.mode === "self-managed" && provisionCapacity.freeMb === null) {
      return apiError(
        "Hivra could not verify live memory headroom on this computer. Check the connection and try again.",
        503,
      );
    }
    if (!provisionCapacity.ok) {
      log.warn("hivra provision blocked: host at capacity", {
        source: "hivra/agents",
        failureType: "hivra_agent_provision_host_at_capacity",
        userId,
        agentType: type,
        proxmoxHost: host,
        requestedRamMb: ram * 1024,
        freeMb: provisionCapacity.freeMb,
      });
      return apiError("Host is at capacity — try again shortly", 503);
    }

    log.info("hivra launch selected Proxmox placement target", {
      source: "hivra/agents",
      userId,
      agentType: type,
      proxmoxHost: host,
      vmidStart,
      vmidEnd,
      requestedCpu: cpu,
      requestedRam: ram,
      browser: wantBrowser,
      stickyHost,
      explicitClaudeHost,
      deploymentMode: deployment.mode,
      managedProvisionerChannel,
    });
    let networkConfig: { subnetPrefix: string; gateway: string };
    try {
      networkConfig = resolveHivraNetworkConfig(host, env);
    } catch (err) {
      log.error("hivra agent host network is not configured", err, {
        source: "hivra/agents",
        failureType: "hivra_agent_host_network_missing",
        userId,
        proxmoxHost: host,
        verboseErrors: true,
      });
      return apiError("Hivra host network is not configured", 500);
    }

    // Resolve the LLM config to persist: byok encrypts the user's key as-is;
    // managed mints a hven_live_* proxy key billed to the user's wallet. Minted
    // keys are revoked on every failure path below (releaseLlmKeyOnFailure) —
    // an error-marked row is terminal and nothing else would clean the key up.
    let llmConfig: StoredLlmConfig | null = null;
    let llmKeyEncrypted: string | null = null;
    let llmPlaintextKey: string | null = null;
    // Managed-Venice runtime wiring handed to the box: the OpenAI-compatible proxy
    // base URL + the served model. Null for byok/direct (native provider).
    let llmBaseUrl: string | null = null;
    let llmModel: string | null = null;
    // Codex's recoverable path keeps encrypted intent in the precursor until
    // guest readiness. It never mints or bakes an active-looking key here.
    if (resolvedLlmInput && !launchAdmission) {
      if (resolvedLlmInput.mode === "managed") {
        const proxyKey = await createManagedVeniceProxyKey({
          userId,
          name: `${name} (${type}) managed Venice`,
          defaultWalletType: resolvedLlmInput.walletType,
        });
        llmConfig = {
          provider: "venice",
          mode: "managed",
          model: resolvedLlmInput.model ?? null,
          proxyKeyId: proxyKey.id,
          keyPrefix: proxyKey.keyPrefix,
          walletType: resolvedLlmInput.walletType,
          enabledAt: new Date().toISOString(),
        };
        llmKeyEncrypted = encryptApiKey(proxyKey.plaintextKey);
        llmPlaintextKey = proxyKey.plaintextKey;
        llmBaseUrl = getManagedVeniceProxyBaseUrl();
        llmModel = resolvedLlmInput.model ?? "deepseek-v4-pro";
      } else {
        llmConfig = {
          provider: "venice",
          mode: "byok",
          model: resolvedLlmInput.model ?? null,
          enabledAt: new Date().toISOString(),
        };
        llmKeyEncrypted = encryptApiKey(resolvedLlmInput.apiKey as string);
        llmPlaintextKey = resolvedLlmInput.apiKey as string;
        llmModel = resolvedLlmInput.model ?? null;
      }
    }
    const releaseLlmKeyOnFailure = async () => {
      if (llmConfig?.proxyKeyId) {
        await revokeManagedVeniceProxyKey({ userId, keyId: llmConfig.proxyKeyId }).catch(() => {});
      }
    };

    // Carry the template's curated skills onto the new agent so the GET-poll
    // bootstrap can re-seed them onto the box (one-time, guarded by
    // template_skills_seeded_at). Only CLI box types have a skills dir; null when
    // not a template fork or there's nothing to seed.
    const templateSkillsColumn = templateSkills.length > 0 ? templateSkills : null;

    // Managed Hivra boxes keep the existing pool behavior. A self-managed box
    // belongs to the user's selected infrastructure target instead, so it must
    // never be charged against or scheduled through Hivra's managed pool.
    const poolId = deployment.mode === "hivra-managed"
      ? await getOrCreatePoolId(userId, "hermesos")
      : null;
    const deploymentBinding = deployment.mode === "self-managed"
      ? {
          infrastructure_connection_id: deployment.connectionId,
          deployment_target_id: deployment.targetId,
          infrastructure_connection_revision: deployment.expectedConnectionRevision,
        }
      : {};
    // Generic managed/self-managed Proxmox launches share the journal operation
    // ID with the lifecycle row. A lost insert/bind acknowledgement can then be
    // reconciled by exact owner + operation + runtime without a second insert.
    const provisionOperationId = launchOperations && launchOperationAdmission
      ? launchOperationAdmission.operationId
      : randomUUID();
    const infrastructureBindingTokenHash = createHash("sha256")
      .update(randomBytes(32))
      .digest("hex");
    const infrastructureBindingTag = hivraInfrastructureBindingTag(infrastructureBindingTokenHash);
    // The database counts the plan's agent slots again under the owner's slot
    // lock before it writes a Hivra-managed row (T35), so a launch racing an
    // attach or another launch cannot pass the limit the gate above checked.
    const slotPlan = deployment.mode === "hivra-managed" ? await resolvePlanAgentSlots(userId) : null;
    if (deployment.mode === "hivra-managed" && !slotPlan) {
      await releaseLlmKeyOnFailure();
      return apiError(`Plan access is required before launching ${def.name}.`, 403);
    }
    const agentLimit = slotPlan?.agentLimit ?? 0;
    const planLimitResponse = async (error: LaunchPlanAgentLimitError) => {
      await releaseLlmKeyOnFailure();
      log.warn("hivra launch refused by the database plan slot count", {
        source: "hivra/agents", failureType: "hivra_agent_plan_limit", userId, agentType: type,
        activeCount: error.activeCount, limit: error.limit,
      });
      if (launchOperations && launchOperationAdmission) {
        await launchOperations.fail(launchOperationAdmission, 403, "plan_agent_limit");
      }
      return apiError(planAgentLimitMessage(slotPlan?.planName ?? "current", error.limit), 403, undefined, { code: "plan_agent_limit" });
    };
    let reservedLaunch;
    try {
      reservedLaunch = launchAdmission && launchModels ? await launchModels.reserve(launchAdmission, {
        id: randomUUID(), type: "codex", name, cpu, ram,
        ...(hasExplicitEnvelope ? { cpu_max: maximumCpu, ram_max: maximumRam } : {}),
        deployment_mode: deployment.mode,
        computer_substrate: "proxmox-kvm", operation_id: provisionOperationId,
        managed_provisioner_channel: managedProvisionerChannel,
        proxmox_host: deployment.mode === "self-managed" ? SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL : host,
        infrastructure_binding_token_hash: infrastructureBindingTokenHash, pool_id: poolId,
        goal, context, personality, emoji, template_skills: templateSkillsColumn, ...deploymentBinding,
      }, agentLimit) : null;
    } catch (error) {
      if (error instanceof LaunchPlanAgentLimitError) return await planLimitResponse(error);
      throw error;
    }
    if (reservedLaunch && !reservedLaunch.created) return apiSuccess({
      agent: sanitizeHivraAgentRow(reservedLaunch.agent), launchRequestId: reservedLaunch.requestId,
    }, 200);
    if (launchOperations && launchOperationAdmission) {
      // This is the last safe boundary before the owner row mutation. Provider
      // launches reserve at their adapter boundary above.
      const reservation = await launchOperations.reserve(launchOperationAdmission);
      if (!reservation.created) return launchOperationReplayResponse(reservation.existing);
    }
    const agentRow = {
      user_id: userId,
      type,
      computer_profile: computerProfile,
      name,
      status: "provisioning",
      deployment_mode: deployment.mode,
      computer_substrate: "proxmox-kvm",
      managed_provisioner_channel: managedProvisionerChannel,
      desired_state: "running",
      operation_id: provisionOperationId,
      operation_kind: "provision",
      operation_payload: { stage: "pre_allocation_access" },
      operation_started_at: new Date().toISOString(),
      infrastructure_binding_token_hash: infrastructureBindingTokenHash,
      // Every new allocation is provider-bound. Portable hosts stamp tags in
      // the reviewed bundle; managed legacy hosts use an operation-scoped
      // root-owned qm wrapper that injects the same tags into the exact
      // atomic create. Only rows backfilled by the migration remain on the
      // narrow managed-legacy unenforced compatibility path.
      infrastructure_binding_token_enforced: true,
      proxmox_host: deployment.mode === "self-managed"
        ? SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL
        : host,
      cpu,
      ram,
      cpu_max: maximumCpu,
      ram_max: maximumRam,
      pool_id: poolId,
      goal,
      context,
      personality,
      emoji,
      managed_venice: managedVenice,
      llm_config: llmConfig,
      llm_api_key_encrypted: llmKeyEncrypted,
      template_skills: templateSkillsColumn,
      ...deploymentBinding,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stored row shape is the same one the insert returned before.
    const insertAgentRow = async (): Promise<{ data: any; error: unknown }> => {
      if (reservedLaunch) return { data: reservedLaunch.agent, error: null };
      if (deployment.mode !== "hivra-managed") {
        return await supabaseAdmin!.from("hivra_agents").insert(agentRow).select().single();
      }
      // A Hivra-managed row is written only by the database, after it counts
      // the owner's plan slots under the slot lock (T35).
      const { data, error } = await supabaseAdmin!.rpc("insert_hivra_managed_agent", { p_row: agentRow, p_agent_limit: agentLimit });
      if (error) return { data: null, error };
      const result = data as { status?: unknown; row?: unknown; activeCount?: unknown; limit?: unknown } | null;
      if (result?.status === "plan_agent_limit") {
        throw new LaunchPlanAgentLimitError(Number(result.activeCount) || 0, Number(result.limit) || agentLimit);
      }
      if (result?.status === "invalid_request") return { data: null, error: { code: "22023", message: "invalid managed agent row" } };
      if (result?.status !== "inserted" || !result.row || typeof result.row !== "object") return { data: null, error: null };
      return { data: result.row as Record<string, unknown>, error: null };
    };
    let insertResult: Awaited<ReturnType<typeof insertAgentRow>>;
    try {
      insertResult = await insertAgentRow();
    } catch (insertError) {
      if (insertError instanceof LaunchPlanAgentLimitError) return await planLimitResponse(insertError);
      await releaseLlmKeyOnFailure();
      log.error("hivra agent row insert acknowledgement was lost", insertError, {
        source: "hivra/agents",
        failureType: "hivra_agent_insert_unconfirmed",
        userId,
        agentType: type,
        requestedCpu: cpu,
        requestedRam: ram,
        poolId,
        verboseErrors: true,
      });
      if (launchOperations && launchOperationAdmission) {
        return launchOperationReplayResponse(await launchOperations.markReconciling(launchOperationAdmission));
      }
      throw insertError;
    }
    const { data: agent, error: insErr } = insertResult;
    if (insErr || !agent) {
      await releaseLlmKeyOnFailure();
      log.error("hivra agent row insert failed", insErr ?? new Error("No agent returned after insert"), {
        source: "hivra/agents",
        failureType: "hivra_agent_insert_failed",
        userId,
        agentType: type,
        requestedCpu: cpu,
        requestedRam: ram,
        poolId,
        verboseErrors: true,
      });
      if (launchOperations && launchOperationAdmission) {
        if (!insErr) {
          // A missing representation without a database error is ambiguous. It
          // may have committed; retain the exact operation for replay recovery.
          return launchOperationReplayResponse(await launchOperations.markReconciling(launchOperationAdmission));
        }
        const authorityConflict = isHivraAgentAuthorityConflict(insErr);
        return launchOperationReplayResponse(await launchOperations.fail(
          launchOperationAdmission,
          authorityConflict ? 409 : 500,
          authorityConflict ? "agent_insert_conflict" : "agent_insert_failed",
        ));
      }
      return isHivraAgentAuthorityConflict(insErr)
        ? apiError("The selected infrastructure authority changed before launch. Refresh and try again.", 409)
        : apiError("Could not create agent", 500);
    }
    if (launchOperations && launchOperationAdmission) {
      // Once the row is durably owner-bound it is an accepted resource, even
      // while access and VM kickoff continue. Replay can safely expose it and a
      // later successful kickoff upgrades the receipt from HTTP 202 to 201.
      await launchOperations.bindAgent(launchOperationAdmission, String(agent.id));
      await launchOperations.accept(launchOperationAdmission, String(agent.id), 202);
    }
    await logHivraAgentEvent({ userId, event: "launch_requested", agentId: agent.id, agentType: type, detail: { cpu, ram, goal } });

    // box_created (server-side funnel event) for the hivra lane. The Hermes lane
    // (/api/instances) has emitted this since #353's fix, but claude-code / codex /
    // aeon / openclaw / agent-zero deploys were invisible to the signup→box→use
    // funnel — the only completion signal was the client-side
    // welcome_box_launch_succeeded, which dies with the tab. Mirrors
    // captureBoxCreatedOnce in instance-service.ts: once-per-id claim-before-
    // capture, $insert_id for the cross-process tail, Clerk userId as distinctId
    // so the event merges onto the same person the client identifies. Best-effort:
    // telemetry must never fail a launch.
    try {
      if (!emittedBoxCreatedAgentIds.has(agent.id)) {
        emittedBoxCreatedAgentIds.add(agent.id);
        posthogClient.capture({
          distinctId: userId,
          event: "box_created",
          properties: {
            lane: "hivra",
            agent_type: type,
            instance_id: agent.id,
            cpu,
            ram,
            managed_venice: managedVenice,
            llm_mode: llmConfig?.mode ?? null,
            from_template: Boolean(template),
            $insert_id: `box_created_${agent.id}`,
            $set_once: { hermes_user_id: userId },
          },
        });
        await posthogClient.flush();
      }
    } catch (captureErr) {
      log.warn(
        "failed to capture hivra box_created",
        {
          source: "hivra/agents",
          failureType: "box_created_capture_failed",
          userId,
          agentId: agent.id,
        },
        captureErr
      );
    }

    // Stable per-box URL: provision a CloudFlare named tunnel for this box. Gated
    // on a Tunnel-scoped token. A configured named-tunnel failure stops launch;
    // its durable intent must not be hidden behind an ephemeral quick tunnel.
    let tunnelToken = "";
    let tunnelUrl = "";
    let cfTunnelId = "";
    let cfHostname = "";
    if (isTunnelConfigured()) {
      let t;
      try {
        t = await provisionHivraAgentTunnel({ userId, agentId: String(agent.id), operationId: provisionOperationId });
        if (launchAdmission && !t) throw new Error("Named model-settings access was not confirmed");
      } catch (tunnelError) {
        let cleanupVerified = tunnelError instanceof BoxTunnelProvisionError && tunnelError.cleanupVerified;
        let message = cleanupVerified
          ? "Secure access setup failed before launch. No VM was allocated; you can retry."
          : "Secure access setup is incomplete. No VM was allocated. Its recorded tunnel identity must be reconciled before retrying.";
        const operation = { userId, agentId: String(agent.id), operationId: provisionOperationId };
        try {
          if (llmConfig?.proxyKeyId) {
            await revokeManagedVeniceProxyKey({ userId, keyId: llmConfig.proxyKeyId });
          }
        } catch {
          cleanupVerified = false;
          message = "Launch stopped before VM allocation. Managed API key cleanup is unverified; setup requires reconciliation.";
        }
        if (cleanupVerified) {
          try {
            // Atomic desired-state CAS: a concurrent Delete must keep the
            // provision lease until the shared deletion finalizer succeeds.
            const failed = await failHivraAgentBeforeAllocation({ ...operation, error: message });
            if (!failed) {
              if (await completeHivraAgentDelete(operation)) {
                return apiError("Launch was cancelled before VM allocation; access cleanup is complete.", 409);
              }
              cleanupVerified = false;
            }
          } catch {
            cleanupVerified = false;
          }
          if (!cleanupVerified) message = "No VM was allocated. Setup cleanup could not be finalized; its recorded operation requires reconciliation.";
        }
        if (!cleanupVerified) {
          await recordHivraAgentOperationFailure({ ...operation, error: message }).catch(() => false);
        }
        return apiError(message, 502);
      }
      if (t) {
        tunnelToken = t.token;
        tunnelUrl = t.url;
        cfTunnelId = t.tunnelId;
        cfHostname = t.hostname;
      }
    }

    // A verified terminal provision failure will not be re-driven, so release
    // its named tunnel here. Ambiguous transport failures deliberately retain
    // both the durable operation lease and tunnel until recovery can verify or
    // compensate the provider outcome. Best-effort cleanup must not mask the
    // terminal provision failure being reported.
    const releaseTunnelForFailedProvision = async () => {
      if (cfTunnelId || cfHostname) {
        await deleteBoxTunnel({ tunnelId: cfTunnelId, hostname: cfHostname });
      }
    };

    const releaseProvisionOperation = async (
      error: string,
      markError: boolean,
    ) => {
      return releaseHivraAgentOperation({
        userId,
        agentId: agent.id,
        operationId: provisionOperationId,
        error,
        markError,
      }).catch(() => false);
    };

    const releaseProvisionIntent = async () => runProxmoxHostScript(
      `rm -f -- ${shellQuote(`/var/lib/hivra/provision-operations/operation-${provisionOperationId}.selected`)} && [ ! -e ${shellQuote(`/var/lib/hivra/provision-operations/operation-${provisionOperationId}.selected`)} ]`,
      env,
      { timeoutMs: 15_000 },
    );

    const retainAmbiguousProvisionOperation = async (error: string) => {
      await recordHivraAgentOperationFailure({
        userId,
        agentId: agent.id,
        operationId: provisionOperationId,
        error: error.slice(0, 300),
      }).catch(() => false);
    };

    const finishCancelledProvision = async (vmid: number | null) => {
      const rollback = vmid
        ? await runProxmoxHostScript(rollbackAllocatedVmScript(
            vmid,
            provisionOperationId,
            allocationStorage,
            infrastructureBindingTag,
          ), env, {
            timeoutMs: 90_000,
          })
        : { ok: true, stdout: "", stderr: "", error: undefined };
      await releaseTunnelForFailedProvision();
      await releaseLlmKeyOnFailure();
      const deleted = rollback.ok
        ? await completeHivraAgentDelete({
            userId,
            agentId: agent.id,
            operationId: provisionOperationId,
          }).catch(() => false)
        : false;
      if (!deleted) {
        if (rollback.ok) {
          await retainAmbiguousProvisionOperation("Delete cancellation could not be finalized; access cleanup remains recorded.");
        } else {
          await retainAmbiguousProvisionOperation(
            rollback.error || rollback.stderr || "Provision cancellation cleanup failed.",
          );
        }
      }
      if (rollback.ok && deleted) await releaseProvisionIntent();
      return { rollback, deleted };
    };

    // The host-side allocator reads `qm list`, which is authoritative for a
    // user-owned target. Managed reservations still include in-flight database
    // rows because those launches share Hivra's allocator. A target-scoped DB
    // uniqueness constraint protects the final self-managed write.
    const reservedVmids = deployment.mode === "hivra-managed"
      ? await getReservedProxmoxVmidsForNode({
          proxmoxNode: host,
          excludeInstanceId: agent.id,
        })
      : [];

    // The out-of-repo Hivra provisioner accepts a guest-visible core count.
    // Fractional free-tier CPU is a Proxmox scheduler cap, not a fractional
    // vCPU topology, so provision at one core and apply --cpulimit after VMID
    // allocation. This keeps 0.5 CPU launchable without asking qm --cores to do
    // something it cannot do.
    const provisionCores = Math.max(1, Math.ceil(maximumCpu));
    const ramEnvelope = resolveRamBurst(ram * 1024, process.env, maximumRam * 1024);
    const allocationStageAdvanced = await beginHivraAgentVmAllocation({
      userId, agentId: agent.id, operationId: provisionOperationId,
    });
    const launchStillCurrent = allocationStageAdvanced && await checkpointHivraAgentOperation({
      userId,
      agentId: agent.id,
      operationId: provisionOperationId,
      expectedDesiredState: "running",
    });
    if (!launchStillCurrent) {
      await finishCancelledProvision(null);
      return apiError("Launch was cancelled before provider allocation.", 409);
    }
    // Agent-run reporting (docs/superpowers/specs/2026-09-22-agent-run-tracing-contract.md):
    // a 7-day credential scoped to exactly this computer. It never fails the
    // launch: without a public origin or signing secret the computer launches
    // unreported and Activity shows missing coverage. Local-auth installs have
    // no guest-reachable ingest, and a bundle known to predate the reporter
    // would silently drop the credential, so neither receives one.
    const hostProvisionerVersion = launchProvisionerVersion(portableRuntime, managedProvisionerChannel);
    const activityTelemetryEligible = (agentKind === "claude" || agentKind === "codex")
      && supportsNativeTracing({ type, computer_substrate: agent.computer_substrate })
      && !isLocalAuthMode()
      && (hostProvisionerVersion === null || provisionerSupportsActivityTelemetry(hostProvisionerVersion));
    const activityTelemetry = activityTelemetryEligible
      ? issueActivityCollectorCredential({ userId, agentId: String(agent.id) })
      : null;
    if (activityTelemetryEligible && !activityTelemetry) {
      log.warn("hivra launch continues without an agent-run reporting credential", {
        source: "hivra/agents",
        failureType: "hivra_activity_collector_unavailable",
        userId,
        agentId: agent.id,
        agentType: type,
        controlOriginConfigured: activityControlOrigin() !== null,
      });
    }
    const result = await runProxmoxHostScript(phase1Script({
      cpu: provisionCores,
      cpuLimit: maximumCpu,
      memMb: ramEnvelope.ceilingMb,
      guaranteedMemMb: ramEnvelope.baselineMb,
      agentKind,
      modelKey: llmPlaintextKey ?? undefined,
      modelBaseUrl: llmBaseUrl ?? undefined,
      model: llmModel ?? undefined,
      tunnelToken,
      tunnelUrl,
      wantBrowser,
      subnetPrefix: networkConfig.subnetPrefix,
      gateway: networkConfig.gateway,
      vmidStart,
      vmidEnd,
      reservedVmids,
      ipLastOctetStart,
      operationId: provisionOperationId,
      infrastructureBindingTag,
      managedRuntimePaths,
      portableRuntime,
      computerId: type === "linux-desktop" ? String(agent.id) : undefined,
      controlOrigin: desktopControlOrigin ?? undefined,
      capacityPolicy,
      activityTelemetry,
    }), env, { earlyFinishMarker: "HIVRA_PROVISION_RESULT" });
    const activityCredentialStaged = activityTelemetry !== null
      && (result.stdout || "").split(/\r?\n/).some(line => line.trim() === ACTIVITY_CREDENTIAL_STAGED);
    if (activityTelemetry && !activityCredentialStaged) {
      // The host bundle predates the reporter (or the kickoff stopped before
      // the handoff), so the credential never left this request. Recording it
      // would later surface a false "credential expired" state.
      log.info("hivra launch host bundle did not stage the agent-run reporting credential", {
        source: "hivra/agents",
        failureType: "hivra_activity_collector_not_staged",
        userId,
        agentId: agent.id,
        agentType: type,
        kickoffOk: result.ok,
      });
    }
    if (activityTelemetry && activityCredentialStaged) {
      // Recorded once the host confirmed the credential is in the handoff
      // file, whatever the kickoff outcome: a computer compensated below
      // becomes deleted, which ingest and renewal refuse. Best effort and
      // bounded: a slow database must not hold the launch response.
      let recordTimer: ReturnType<typeof setTimeout> | undefined;
      const recorded = await Promise.race([
        recordActivityCollectorIssued(supabaseAdmin, {
          agentId: activityTelemetry.resourceId,
          userId,
          expiresAt: activityTelemetry.expiresAt,
          reason: "launch",
        }),
        new Promise<false>(resolve => { recordTimer = setTimeout(() => resolve(false), 5_000); }),
      ]).finally(() => clearTimeout(recordTimer));
      if (!recorded) {
        log.warn("hivra agent-run reporting credential issuance was not recorded", {
          source: "hivra/agents",
          failureType: "hivra_activity_collector_record_failed",
          userId,
          agentId: agent.id,
          agentType: type,
        });
      }
    }
    const allocationIdentity = parsePhase1AllocationIdentity({
      stdout: result.stdout || "",
      vmidStart,
      vmidEnd,
      subnetPrefix: networkConfig.subnetPrefix,
    });
    if (!result.ok) {
      let providerAbsenceVerified = false;
      let terminalPersisted = false;
      if (allocationIdentity) {
        await persistHivraAgentProvisionIdentity({
          userId,
          agentId: agent.id,
          operationId: provisionOperationId,
          vmid: allocationIdentity.vmid,
          ip: allocationIdentity.ip,
        }).catch(() => false);
        const rollback = await runProxmoxHostScript(rollbackAllocatedVmScript(
          allocationIdentity.vmid,
          provisionOperationId,
          allocationStorage,
          infrastructureBindingTag,
        ), env, { timeoutMs: 90_000 });
        providerAbsenceVerified = rollback.ok;
        if (rollback.ok) {
          terminalPersisted = await completeHivraAgentDelete({
            userId,
            agentId: agent.id,
            operationId: provisionOperationId,
          }).catch(() => false);
          if (!terminalPersisted) {
            terminalPersisted = await releaseProvisionOperation(
              "Provision kickoff failed after provider allocation was removed.",
              true,
            );
          }
        }
      }

      if (providerAbsenceVerified && terminalPersisted) {
        await releaseProvisionIntent();
        await releaseTunnelForFailedProvision();
        await releaseLlmKeyOnFailure();
        await logHivraAgentEvent({
          userId,
          event: "failed",
          agentId: agent.id,
          agentType: type,
          detail: { reason: "ssh_kickoff_compensated", vmid: allocationIdentity?.vmid ?? null },
        });
      } else {
        await retainAmbiguousProvisionOperation(
          result.error || result.stderr || "Provision kickoff outcome is unknown.",
        );
      }
      log.error("hivra agent provision kickoff failed", new Error(result.error || "ssh failed"), {
        source: "hivra/agents",
        failureType: "hivra_agent_provision_kickoff_failed",
        userId,
        agentId: agent.id,
        agentType: type,
        requestedCpu: cpu,
        requestedRam: ram,
        browser: wantBrowser,
        proxmoxHost: host,
        allocationIntentObserved: Boolean(allocationIdentity),
        allocationVmid: allocationIdentity?.vmid ?? null,
        providerAbsenceVerified,
        terminalPersisted,
        // Redact before logging: the kickoff env now carries the plaintext
        // managed-Venice proxy key (HIVRA_MODEL_KEY), so a failure that echoes the
        // command must not leak hven_* / tokens into ops logs.
        stdout: result.stdout ? redactSensitiveCommandOutput(result.stdout, 500) : null,
        stderr: result.stderr ? redactSensitiveCommandOutput(result.stderr, 500) : null,
        verboseErrors: true,
      });
      return apiError(
        providerAbsenceVerified && terminalPersisted
          ? "Provision kickoff failed. The selected VM was removed safely."
          : "Provision kickoff outcome is being reconciled. Do not retry this launch yet.",
        502,
      );
    }

    const vmid = allocationIdentity?.receipt === "allocated" ? allocationIdentity.vmid : null;
    const ip = allocationIdentity?.receipt === "allocated" ? allocationIdentity.ip : null;
    if (!vmid || !ip) {
      await retainAmbiguousProvisionOperation(
        ("valid allocation receipt missing: " + (result.stdout || "")).slice(0, 300),
      );
      return apiError("The provider allocation receipt is missing; recovery will reconcile this launch.", 502);
    }

    // Persist the VM identity before any post-allocation host step can fail.
    // Deletion relies on this VMID to destroy the Proxmox guest instead of only
    // hiding the failed database row.
    let vmIdentityPersisted = false;
    let vmIdentityError: unknown = null;
    try {
      vmIdentityPersisted = await persistHivraAgentProvisionIdentity({
        userId,
        agentId: agent.id,
        operationId: provisionOperationId,
        vmid,
        ip,
      });
    } catch (error) {
      vmIdentityError = error;
    }
    if (!vmIdentityPersisted) {
      const rollback = await runProxmoxHostScript(rollbackAllocatedVmScript(
        vmid,
        provisionOperationId,
        allocationStorage,
        infrastructureBindingTag,
      ), env, {
        timeoutMs: 90_000,
      });
      const cancelledDelete = rollback.ok
        ? await completeHivraAgentDelete({
            userId,
            agentId: agent.id,
            operationId: provisionOperationId,
          }).catch(() => false)
        : false;
      let terminalPersisted = cancelledDelete;
      if (!cancelledDelete) {
        if (rollback.ok) {
          terminalPersisted = await releaseProvisionOperation(
            "The allocated VM identity could not be reserved safely.",
            true,
          );
        } else {
          await retainAmbiguousProvisionOperation(
            rollback.error || rollback.stderr || "VM identity persistence and cleanup are ambiguous.",
          );
        }
      }
      if (rollback.ok && terminalPersisted) {
        await releaseProvisionIntent();
        await releaseTunnelForFailedProvision();
        await releaseLlmKeyOnFailure();
      }
      if (rollback.ok && terminalPersisted) {
        await logHivraAgentEvent({
          userId,
          event: "failed",
          agentId: agent.id,
          agentType: type,
          detail: { reason: "vm_identity_persist", vmid },
        });
      }
      log.error("hivra agent VM identity persistence failed", vmIdentityError ?? new Error("Provision operation no longer current"), {
        source: "hivra/agents",
        failureType: "hivra_agent_vm_identity_persist_failed",
        userId,
        agentId: agent.id,
        deploymentMode: deployment.mode,
        vmid,
        rollbackOk: rollback.ok,
        terminalPersisted,
        rollbackError: rollback.error ?? null,
        verboseErrors: true,
      });
      return rollback.ok && terminalPersisted
        ? apiError(
            cancelledDelete
              ? "Launch was cancelled and the allocated VM was removed."
              : "The selected VM slot changed during launch. The new VM was removed; please try again.",
            409,
          )
        : apiError("The selected VM slot changed and automatic VM cleanup could not be confirmed. Check the target before retrying.", 502);
    }

    const cpuLimitStillCurrent = await checkpointHivraAgentOperation({
      userId,
      agentId: agent.id,
      operationId: provisionOperationId,
      expectedDesiredState: "running",
    });
    if (!cpuLimitStillCurrent) {
      const cancelled = await finishCancelledProvision(vmid);
      return cancelled.rollback.ok
        ? apiError("Launch was cancelled and the allocated VM was removed.", 409)
        : apiError("Launch was cancelled, but VM cleanup could not be confirmed. Check the target before retrying.", 502);
    }

    const allocationVerificationScript = `set -euo pipefail
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8
TAGS="$(qm config ${vmid} | sed -n 's/^tags:[[:space:]]*//p')"
printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq ${shellQuote(infrastructureBindingTag)}
printf '%s\\n' "$TAGS" | tr ';' '\\n' | grep -Fxq ${shellQuote(`hivra-op-${provisionOperationId.replace(/-/g, "")}`)}
qm set ${vmid} --cores ${Math.max(1, Math.ceil(maximumCpu))} --cpulimit ${maximumCpu} --memory ${ramEnvelope.ceilingMb} --balloon ${ramEnvelope.baselineMb}
ACTUAL_CPULIMIT="$(qm config ${vmid} | awk '$1=="cpulimit:" {print $2; exit}')"
[ "$ACTUAL_CPULIMIT" = ${shellQuote(String(maximumCpu))} ] \
  || { echo "allocated VM has an unexpected CPU limit" >&2; exit 1; }
rm -f -- "/run/hivra-provision/${vmid}.allocated"
rm -f -- ${shellQuote(`/var/lib/hivra/provision-operations/operation-${provisionOperationId}.selected`)}
printf 'HIVRA_ALLOCATION_VERIFIED %s\\n' ${vmid}`;
    const cpuLimitResult = await runProxmoxHostScript(
      allocationVerificationScript,
      env
    );
    if (!cpuLimitResult.ok) {
      const rollback = await runProxmoxHostScript(rollbackAllocatedVmScript(
        vmid,
        provisionOperationId,
        allocationStorage,
        infrastructureBindingTag,
      ), env, {
        timeoutMs: 90_000,
      });
      const terminalPersisted = rollback.ok
        ? await releaseProvisionOperation(cpuLimitResult.error || "cpu limit apply failed", true)
        : await retainAmbiguousProvisionOperation(
            rollback.error || rollback.stderr || "Resource-cap rollback could not be verified.",
          ).then(() => false);
      if (rollback.ok && terminalPersisted) {
        await releaseProvisionIntent();
        await releaseTunnelForFailedProvision();
        await releaseLlmKeyOnFailure();
        await logHivraAgentEvent({ userId, event: "failed", agentId: agent.id, agentType: type, detail: { reason: "cpu_limit_apply", error: (cpuLimitResult.error || "cpu limit apply failed").slice(0, 200), cpu } });
      }
      log.error("hivra agent cpu limit apply failed after VM allocation", new Error(cpuLimitResult.error || "cpu limit apply failed"), {
        source: "hivra/agents",
        failureType: "hivra_agent_cpu_limit_apply_failed",
        userId,
        agentId: agent.id,
        vmid,
        cpu,
        rollbackOk: rollback.ok,
        terminalPersisted,
        rollbackError: rollback.error ?? null,
        verboseErrors: true,
      });
      return apiError(
        rollback.ok && terminalPersisted
          ? "Provision resource cap failed. The new VM was removed; please try again."
          : "Provision resource cap failed and automatic VM cleanup could not be confirmed. Check the target before retrying.",
        502,
      );
    }

    // Phase 5: set the VM's scheduling-priority weight from the pool tier at first
    // launch (the out-of-repo provisioner sizes cores/RAM but not cpuunits).
    const { data: poolRow } = poolId
      ? await supabaseAdmin.from("pools").select("priority").eq("id", poolId).maybeSingle()
      : { data: null };
    const cpuunits = priorityToCpuUnits((poolRow as { priority?: number } | null)?.priority);
    // CPU scheduling weight is best-effort (a misconfigured weight degrades
    // resource isolation but doesn't block a working agent), yet it must be
    // observable. runProxmoxHostScript resolves with { ok:false } on failure —
    // it never rejects, so the previous `.catch(() => {})` was dead code that
    // hid every failure, and the `|| true; echo ok` masked the `qm set` exit
    // status too. Run it unmasked and log a degraded warning if it fails.
    const cpuUnitsResult = await runProxmoxHostScript(
      `set -euo pipefail
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8
TAGS="$(qm config ${vmid} | sed -n 's/^tags:[[:space:]]*//p')"
printf '%s\n' "$TAGS" | tr ';' '\n' | grep -Fxq ${shellQuote(infrastructureBindingTag)}
printf '%s\n' "$TAGS" | tr ';' '\n' | grep -Fxq ${shellQuote(`hivra-op-${provisionOperationId.replace(/-/g, "")}`)}
qm set ${vmid} --cpuunits ${cpuunits}`,
      env
    );
    if (!cpuUnitsResult.ok) {
      log.warn("hivra agent cpu priority not applied; running with host default weight", {
        source: "hivra/agents",
        failureType: "hivra_agent_cpuunits_apply_failed",
        userId,
        agentId: agent.id,
        vmid,
        cpuunits,
        errorMessage: cpuUnitsResult.error ?? null,
      });
    }

    // Provisioning continues asynchronously on the host after POST returns.
    // Keep the durable provision lease until GET observes a terminal marker;
    // otherwise DELETE could destroy the VM while a stale poll resurrects it.
    const provisionStillCurrent = await checkpointHivraAgentOperation({
      userId,
      agentId: agent.id,
      operationId: provisionOperationId,
      expectedDesiredState: "running",
    });
    if (!provisionStillCurrent) {
      const cancelled = await finishCancelledProvision(vmid);
      return cancelled.rollback.ok
        ? apiError("Launch was cancelled and the allocated VM was removed.", 409)
        : apiError("Launch was cancelled, but VM cleanup could not be confirmed. Check the target before retrying.", 502);
    }

    const { data: updated } = await supabaseAdmin
      .from("hivra_agents")
      .select("*")
      .eq("id", agent.id)
      .eq("user_id", userId)
      .maybeSingle();

    if (launchOperations && launchOperationAdmission) {
      await launchOperations.accept(launchOperationAdmission, String(agent.id), 201);
    }
    return apiSuccess({ agent: sanitizeHivraAgentRow(updated || { ...agent, vmid, ip }),
      ...(launchAdmission ? { launchRequestId: launchAdmission.requestId } : {}),
      ...(launchOperationAdmission ? {
        launchRequestId: launchOperationAdmission.requestId,
        launch: { state: "accepted", phase: "accepted" },
      } : {}) }, 201);
  } catch (err) {
    if (err instanceof HivraLaunchOperationRequestError) {
      return apiError(err.message, err.code === "request_conflict" ? 409 : 400, undefined, { code: err.code });
    }
    if (err instanceof HivraLaunchOperationStoreError) {
      return apiError("The saved launch could not be confirmed. Check the original request before launching another computer.", 503,
        undefined, { code: "launch_unconfirmed" });
    }
    if (err instanceof LaunchModelRequestError) return apiError(err.message, err.code === "request_conflict" ? 409 : 400, undefined, { code: err.code });
    if (err instanceof ModelKeyStoreError) return apiError("The saved launch could not be confirmed. Check the original request before launching another computer.", 503, undefined, { code: "launch_unconfirmed" });
    return handleApiError(err);
  }
}

export async function GET(request: NextRequest) {
  try {
    if (!isHivraApiAllowed(request.headers.get("host"))) return apiError("Not found", 404);
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const { data, error } = await supabaseAdmin
      .from("hivra_agents")
      .select("*")
      .eq("user_id", userId)
      .neq("status", "deleted")
      .order("created_at", { ascending: false });
    if (error) return apiError("Failed to list agents", 500);
    const agents = (Array.isArray(data) ? data : [])
      .filter((row) => isActiveComputeStatus((row as { status?: unknown }).status))
      .map((row) => sanitizeHivraAgentRow(row as Record<string, unknown>));
    return apiSuccess({ agents });
  } catch (err) {
    return handleApiError(err);
  }
}
