import "server-only";

import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  resolveHivraAgentExecutionContext,
  resolveHivraAgentTeardownExecutionContext,
  type HivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";
import { buildVmidBoundGuestExecPrelude } from "@/lib/hivra/vmid-bound-guest-exec";
import { syncManagedProvisionerBundle } from "@/lib/hivra/managed-provisioner-bundle-sync";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { PORTABLE_HIVRA_PROVISIONER_VERSION } from "@/lib/infrastructure/portable-provisioner-contract";
import { resolveRemoteDesktopProfileRuntime } from "@/lib/remote-computers/profile-runtime";
import {
  inspectRemoteDesktopCapability,
  type RemoteDesktopCapabilityInspectionResult,
} from "@/lib/remote-computers/capability-inspection";
import { supabaseAdmin } from "@/lib/supabase";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { beginDesktopPrepare, dispatchDesktopPrepare, cancelUndispatchedDesktopPrepare, completeDesktopPrepare,
  desktopPrepareAuthority, DESKTOP_PREPARE_KIND, DESKTOP_PREPARE_PENDING } from "./desktop-prepare-operation";
import { desktopPrepareGuestCommand, parseDesktopPrepareReceipt } from "./desktop-prepare-guest";
import { recordHivraAgentOperationFailure } from "@/lib/hivra/agent-operation-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_BYPASS_SECRET = /^[A-Za-z0-9_-]{16,256}$/;
const RESTART_MARKER = "HIVRA_REMOTE_DESKTOP_RESTARTED ";
const TRANSPORT_DIAGNOSTIC_MARKER = "HIVRA_QGA_TRANSPORT_DIAGNOSTIC_V1 ";
const DESKTOP_DIAGNOSTIC_MARKER = "HIVRA_SELKIES_RUNTIME_DIAGNOSTIC_V1 ";
const INSTALL_TIMEOUT_MS = 15 * 60_000;

export type RemoteDesktopAgentRow = {
  id: string;
  user_id: string;
  type?: unknown;
  computer_profile?: unknown;
  status: string | null;
  desired_state: string | null;
  operation_id: string | null;
  operation_kind: string | null;
  vmid: number | null;
  ip: string | null;
  chat_url: string | null;
  computer_substrate?: unknown;
  provider_capacity_order_id?: unknown;
  provider_enrollment_attempt_id?: unknown;
  provider_server_id?: unknown;
  deployment_mode?: unknown;
  proxmox_host?: unknown;
  infrastructure_connection_id?: unknown;
  deployment_target_id?: unknown;
  infrastructure_connection_revision?: unknown;
  infrastructure_binding_token_hash?: unknown;
  infrastructure_binding_token_enforced?: unknown;
  managed_provisioner_channel?: unknown;
};

export type RemoteDesktopGuestInstallationResult = {
  ok: boolean;
  agentId: string;
  targetId: string | null;
  vmid: number | null;
  changed?: boolean;
  capability?: RemoteDesktopCapabilityInspectionResult;
  error?: string;
  code?: "computer_not_ready" | "desktop_prepare_pending" | "desktop_prepare_failed";
};

export type RemoteDesktopGuestRestartResult = {
  ok: boolean;
  agentId: string;
  targetId: string | null;
  vmid: number | null;
  workspaceMarkerSha256?: string;
  capability?: RemoteDesktopCapabilityInspectionResult;
  error?: string;
};

export type RemoteDesktopGuestTransportDiagnosticResult = {
  ok: boolean;
  agentId: string;
  targetId: string | null;
  vmid: number | null;
  probes?: Array<{
    label: "true" | "rm" | "printf" | "shell";
    dispatchExit: number;
    exited: boolean;
    exitcode: number | null;
    exitedTokenClass: "integer-one" | "boolean-true" | "string" | "other" | "missing";
    exitcodeTokenClass: "integer" | "string" | "other" | "missing";
    strictDecodeValid: boolean;
    resultKeys: string[];
    stdoutClass: "empty" | "diagnostic-marker" | "runtime-path" | "other";
    stdoutLength: number;
    stderrClass: "empty" | "missing-command" | "permission" | "agent-unavailable" | "timeout" | "other";
    stderrLength: number;
  }>;
  desktop?: {
    selkiesUnit: "active" | "inactive" | "failed" | "activating" | "deactivating" | "unknown";
    brokerUnit: "active" | "inactive" | "failed" | "activating" | "deactivating" | "unknown";
    containerState: "running" | "exited" | "restarting" | "created" | "paused" | "dead" | "missing" | "unknown";
    containerOomKilled: boolean | null;
    containerExitCode: number | null;
    containerRestartCount: number | null;
    basicAuthFile: boolean;
    unauthenticatedHttpStatus: number | null;
    authenticatedHttpStatus: number | null;
    logClass: "empty" | "encoder" | "port-conflict" | "authentication" | "oom" | "permission" | "runtime-error" | "other";
  };
  error?: string;
};

type Dependencies = {
  loadAgent: (agentId: string) => Promise<RemoteDesktopAgentRow | null>;
  resolveContext: (userId: string, agent: RemoteDesktopAgentRow) => Promise<HivraAgentExecutionContext>;
  resolveObservationContext: (userId: string, agent: RemoteDesktopAgentRow) => Promise<HivraAgentExecutionContext>;
  syncManagedBundle: typeof syncManagedProvisionerBundle;
  runHostScript: typeof runProxmoxHostScript;
  inspectCapability: typeof inspectRemoteDesktopCapability;
  beginPrepare: typeof beginDesktopPrepare;
  dispatchPrepare: typeof dispatchDesktopPrepare;
  cancelPrepare: typeof cancelUndispatchedDesktopPrepare;
  completePrepare: typeof completeDesktopPrepare;
  retainPrepare: typeof recordHivraAgentOperationFailure;
};

type RemoteDesktopInstallOptions = {
  controlBypassSecret?: string;
  controlBypassRequired?: boolean;
};

async function loadAgent(agentId: string): Promise<RemoteDesktopAgentRow | null> {
  if (!supabaseAdmin) throw new Error("Remote desktop database client is unavailable.");
  const { data, error } = await supabaseAdmin.from("hivra_agents").select([
    "id", "user_id", "type", "computer_profile", "status", "desired_state", "operation_id", "operation_kind", "vmid", "ip", "chat_url",
    "computer_substrate", "provider_capacity_order_id", "provider_enrollment_attempt_id", "provider_server_id",
    "deployment_mode", "proxmox_host", "infrastructure_connection_id", "deployment_target_id",
    "infrastructure_connection_revision", "infrastructure_binding_token_hash", "infrastructure_binding_token_enforced", "managed_provisioner_channel",
  ].join(",")).eq("id", agentId).maybeSingle();
  if (error) throw new Error("Remote desktop agent lookup failed.");
  return (data as RemoteDesktopAgentRow | null) ?? null;
}

const DEFAULT_DEPENDENCIES: Dependencies = {
  loadAgent,
  resolveContext: resolveHivraAgentExecutionContext,
  resolveObservationContext: resolveHivraAgentTeardownExecutionContext,
  syncManagedBundle: syncManagedProvisionerBundle,
  runHostScript: runProxmoxHostScript,
  inspectCapability: inspectRemoteDesktopCapability,
  beginPrepare: beginDesktopPrepare,
  dispatchPrepare: dispatchDesktopPrepare,
  cancelPrepare: cancelUndispatchedDesktopPrepare,
  completePrepare: completeDesktopPrepare,
  retainPrepare: recordHivraAgentOperationFailure,
};

function canonicalHttpsOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.origin === value && !parsed.username && !parsed.password
      ? parsed.origin
      : null;
  } catch { return null; }
}

function validIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every(part => {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return false;
    const octet = Number(part);
    return octet >= 0 && octet <= 255;
  });
}

function validAbsoluteRuntimePath(value: string): boolean {
  return /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(value)
    && !value.split("/").some(part => part === "." || part === "..");
}

function normalizeControlBypassSecret(value: unknown): string {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || !CONTROL_BYPASS_SECRET.test(value)) {
    throw new Error("Remote desktop control bypass secret is invalid.");
  }
  return value;
}

export function buildRemoteDesktopGuestInstallScript(input: {
  vmid: number;
  guestIp: string;
  provisionerDirectory: string;
  infrastructureBindingTag: string;
  computerId: string;
  controlOrigin: string;
  publicOrigin: string;
  controlBypassSecret?: string;
  operationId: string;
  observeOnly?: boolean;
}): string {
  const controlBypassSecret = normalizeControlBypassSecret(input.controlBypassSecret);
  if (!Number.isSafeInteger(input.vmid) || input.vmid < 100 || !validIpv4(input.guestIp)
    || !UUID.test(input.computerId) || !UUID.test(input.operationId) || !canonicalHttpsOrigin(input.controlOrigin)
    || !canonicalHttpsOrigin(input.publicOrigin) || !input.infrastructureBindingTag
    || !validAbsoluteRuntimePath(input.provisionerDirectory)) {
    throw new Error("Remote desktop guest install target is invalid.");
  }
  return `#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
umask 077
VMID=${input.vmid}
GUEST_IP=${shellQuote(input.guestIp)}
EXPECTED_BINDING_TAG=${shellQuote(input.infrastructureBindingTag)}
COMPUTER_ID=${shellQuote(input.computerId)}
OPERATION_ID=${shellQuote(input.operationId)}
OBSERVE_ONLY=${input.observeOnly ? "1" : "0"}
CONTROL_ORIGIN=${shellQuote(input.controlOrigin)}
PUBLIC_ORIGIN=${shellQuote(input.publicOrigin)}
CONTROL_BYPASS_SECRET_B64=${shellQuote(Buffer.from(controlBypassSecret, "utf8").toString("base64"))}
PROVISIONER_DIR=${shellQuote(input.provisionerDirectory)}
SOURCE="$PROVISIONER_DIR/remote-desktop"
EXPECTED_VERSION=${shellQuote(PORTABLE_HIVRA_PROVISIONER_VERSION)}
INSTALL_PHASE='target_vmid'
emit_install_phase_failure() {
  status=$?
  trap - ERR
  printf 'HIVRA_REMOTE_DESKTOP_HOST_FAILURE %s\n' "$INSTALL_PHASE" >&2
  exit "$status"
}
set_install_phase() {
  INSTALL_PHASE="$1"
  printf 'HIVRA_REMOTE_DESKTOP_PHASE %s\n' "$INSTALL_PHASE" >&2
}
trap emit_install_phase_failure ERR
set_install_phase lifecycle_lock
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { printf 'HIVRA_REMOTE_DESKTOP_HOST_FAILURE lifecycle_lock\n' >&2; exit 1; }
# Recheck the exact identity only after acquiring the same lock as Destroy and Restart.
set_install_phase target_vmid
[[ "$VMID" =~ ^[0-9]+$ ]] && [ "$VMID" -ge 100 ]
set_install_phase target_running
TARGET_RUNNING=0
for _ in $(seq 1 30); do
  if [ "$(qm status "$VMID" 2>/dev/null | tr -d '\r' | awk '/^status:/{print $2; exit}')" = 'running' ]; then
    TARGET_RUNNING=1
    break
  fi
  sleep 2
done
[ "$TARGET_RUNNING" = '1' ]
VM_CONFIG="$(qm config "$VMID")"
TAGS="$(printf '%s\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p')"
set_install_phase target_binding_tag
printf '%s\n' "$TAGS" | tr ';' '\n' | grep -Fxq "$EXPECTED_BINDING_TAG"
set_install_phase target_guest_ip
printf '%s\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\n' | grep -Fxq "ip=$GUEST_IP/24"
set_install_phase target_guest_identity
${buildVmidBoundGuestExecPrelude()}
set_install_phase target_guest_exec_ready
GUEST_EXEC_READY=0
for _ in $(seq 1 30); do
  if qm guest cmd "$VMID" ping >/dev/null 2>&1 \
    && run_vmid_bound_guest_exec /usr/bin/true >/dev/null 2>&1; then
    GUEST_EXEC_READY=1
    break
  fi
  sleep 2
done
[ "$GUEST_EXEC_READY" = '1' ]
REMOTE_DIR="/run/hivra-remote-desktop-install.$COMPUTER_ID.$OPERATION_ID"
[[ "$REMOTE_DIR" =~ ^/run/hivra-remote-desktop-install\\.[0-9a-f-]{36}\\.[0-9a-f-]{36}$ ]]
if [ "$OBSERVE_ONLY" = '1' ]; then
  ${desktopPrepareGuestCommand({ operationId: input.operationId, computerId: input.computerId, vmid: input.vmid, guestIp: input.guestIp, bindingTag: input.infrastructureBindingTag }, "observe")}
  # Observe emits only an exact terminal receipt while holding the guest lock.
  run_vmid_bound_guest_exec /usr/bin/rm -rf -- "$REMOTE_DIR" >/dev/null
  cleanup_hivra_qga_result
  exit 0
fi
set_install_phase target_bundle_version
[ "$(tr -d '[:space:]' < "$PROVISIONER_DIR/VERSION")" = "$EXPECTED_VERSION" ]
set_install_phase target_source_closure
for candidate in broker.cjs install-guest.py server.cjs; do
  [ -f "$SOURCE/$candidate" ] && [ ! -L "$SOURCE/$candidate" ] \
    && [ -s "$SOURCE/$candidate" ] && [ "$(stat -c '%s' "$SOURCE/$candidate")" -le 262144 ]
done
set_install_phase guest_temp_directory_path
set_install_phase guest_temp_directory_reset
run_vmid_bound_guest_exec /usr/bin/rm -rf -- "$REMOTE_DIR"
set_install_phase guest_temp_directory_create
run_vmid_bound_guest_exec /usr/bin/install -d -o 0 -g 0 -m 0700 -- "$REMOTE_DIR"
cleanup() {
  # A disconnected observer must not delete source beneath a still-running guest installer.
  cleanup_hivra_qga_result || true
}

trap cleanup EXIT HUP INT TERM
transfer_guest_source() {
  local candidate="$1"
  local phase="$2"
  local source_payload source_sha status
  set_install_phase "$phase"_encode
  source_payload="$(/usr/bin/base64 -w 0 < "$SOURCE/$candidate")" || {
    status=$?; printf 'HIVRA_REMOTE_DESKTOP_HOST_FAILURE %s\n' "$INSTALL_PHASE" >&2; return "$status"
  }
  [ -n "$source_payload" ] || {
    printf 'HIVRA_REMOTE_DESKTOP_HOST_FAILURE %s\n' "$INSTALL_PHASE" >&2; return 1
  }
  set_install_phase "$phase"_write
  run_vmid_bound_guest_exec /bin/bash -c 'set -euo pipefail; umask 077; printf "%s" "$1" | /usr/bin/base64 --decode > "$2"' hivra "$source_payload" "$REMOTE_DIR/$candidate" || {
    status=$?; printf 'HIVRA_REMOTE_DESKTOP_HOST_FAILURE %s\n' "$INSTALL_PHASE" >&2; return "$status"
  }
  set_install_phase "$phase"_chmod
  run_vmid_bound_guest_exec /usr/bin/chmod 0600 "$REMOTE_DIR/$candidate" || {
    status=$?; printf 'HIVRA_REMOTE_DESKTOP_HOST_FAILURE %s\n' "$INSTALL_PHASE" >&2; return "$status"
  }
  set_install_phase "$phase"_hash
  source_sha="$(/usr/bin/sha256sum "$SOURCE/$candidate" | /usr/bin/awk '{print $1}')" || {
    status=$?; printf 'HIVRA_REMOTE_DESKTOP_HOST_FAILURE %s\n' "$INSTALL_PHASE" >&2; return "$status"
  }
  set_install_phase "$phase"_integrity
  run_vmid_bound_guest_exec /bin/bash -c 'set -euo pipefail; printf "%s  %s\\n" "$2" "$1" | /usr/bin/sha256sum --check --status' hivra "$REMOTE_DIR/$candidate" "$source_sha" || {
    status=$?; printf 'HIVRA_REMOTE_DESKTOP_HOST_FAILURE %s\n' "$INSTALL_PHASE" >&2; return "$status"
  }
  [ -n "$source_sha" ] || {
    printf 'HIVRA_REMOTE_DESKTOP_HOST_FAILURE %s\n' "$INSTALL_PHASE" >&2; return 1
  }
}
transfer_guest_source broker.cjs guest_source_transfer_broker
transfer_guest_source install-guest.py guest_source_transfer_installer
transfer_guest_source server.cjs guest_source_transfer_server
CONTROL_BYPASS_FILE="$REMOTE_DIR/control-bypass-secret"
if [ -n "$CONTROL_BYPASS_SECRET_B64" ]; then
  set_install_phase guest_control_bypass_write
  run_vmid_bound_guest_exec_stdin /bin/bash -c 'set -euo pipefail; umask 077; /usr/bin/base64 --decode > "$1"; /usr/bin/chown 0:0 "$1"; /usr/bin/chmod 0600 "$1"' hivra "$CONTROL_BYPASS_FILE" <<<"$CONTROL_BYPASS_SECRET_B64"
  CONTROL_BYPASS_ARGS=(--control-bypass-file "$CONTROL_BYPASS_FILE")
else
  CONTROL_BYPASS_ARGS=()
fi
set_install_phase guest_installer
PREPARE_RECEIPT="$(${desktopPrepareGuestCommand({ operationId: input.operationId, computerId: input.computerId, vmid: input.vmid, guestIp: input.guestIp, bindingTag: input.infrastructureBindingTag }, "run")} /usr/bin/python3 "$REMOTE_DIR/install-guest.py" --apply --computer-kind hivra-agent --computer-id "$COMPUTER_ID" --control-origin "$CONTROL_ORIGIN" --public-origin "$PUBLIC_ORIGIN" "${"$"}{CONTROL_BYPASS_ARGS[@]}" --source-dir "$REMOTE_DIR")"
printf '%s\n' "$PREPARE_RECEIPT"
if ! printf '%s\n' "$PREPARE_RECEIPT" | grep -Fq '"exitCode":0'; then
  run_vmid_bound_guest_exec /usr/bin/rm -rf -- "$REMOTE_DIR" >/dev/null
  cleanup_hivra_qga_result
  exit 0
fi
set_install_phase guest_capability_evidence
run_vmid_bound_guest_exec /usr/bin/test -f /opt/hivra/remote-desktop/capability.json
set_install_phase guest_isolation_evidence
run_vmid_bound_guest_exec /usr/bin/test -f /opt/hivra/remote-desktop/input-isolation
set_install_phase guest_cleanup
run_vmid_bound_guest_exec /usr/bin/rm -rf -- "$REMOTE_DIR" >/dev/null
cleanup_hivra_qga_result
trap - EXIT HUP INT TERM ERR
`;
}

export function buildRemoteDesktopGuestTransportDiagnosticScript(input: {
  vmid: number;
  guestIp: string;
  infrastructureBindingTag: string;
}): string {
  if (!Number.isSafeInteger(input.vmid) || input.vmid < 100 || !validIpv4(input.guestIp)
    || !input.infrastructureBindingTag) {
    throw new Error("Remote desktop guest transport diagnostic target is invalid.");
  }
  // Keep raw service/container logs and Basic credentials inside the selected
  // guest. Only categorical state and HTTP status receipts cross QGA/SSH.
  const desktopDiagnosticProgram = String.raw`#!/usr/bin/env bash
set -u
export LC_ALL=C
unit_state() {
  value="$(/usr/bin/timeout 8 /usr/bin/systemctl is-active "$1" 2>/dev/null || true)"
  case "$value" in active|inactive|failed|activating|deactivating) printf '%s' "$value" ;; *) printf 'unknown' ;; esac
}
SELKIES_UNIT="$(unit_state hivra-selkies-desktop.service)"
BROKER_UNIT="$(unit_state hivra-remote-desktop-broker.service)"
CONTAINER_STATE=unknown
CONTAINER_OOM=null
CONTAINER_EXIT=null
CONTAINER_RESTARTS=null
LOG_CLASS=empty
INSPECT="$(/usr/bin/timeout 8 /usr/bin/docker inspect --format '{{.State.Status}}|{{.State.OOMKilled}}|{{.State.ExitCode}}|{{.RestartCount}}' hivra-selkies-desktop 2>&1)"
INSPECT_STATUS=$?
if [ "$INSPECT_STATUS" -eq 0 ]; then
  IFS='|' read -r RAW_STATE RAW_OOM RAW_EXIT RAW_RESTARTS <<EOF
$INSPECT
EOF
  case "$RAW_STATE" in running|exited|restarting|created|paused|dead) CONTAINER_STATE="$RAW_STATE" ;; *) CONTAINER_STATE=unknown ;; esac
  case "$RAW_OOM" in true|false) CONTAINER_OOM="$RAW_OOM" ;; esac
  case "$RAW_EXIT" in ''|*[!0-9]*) ;; *) CONTAINER_EXIT="$RAW_EXIT" ;; esac
  case "$RAW_RESTARTS" in ''|*[!0-9]*) ;; *) CONTAINER_RESTARTS="$RAW_RESTARTS" ;; esac
  LOGS="$(/usr/bin/timeout 8 /usr/bin/docker logs --tail 160 hivra-selkies-desktop 2>&1 || true)"
  LOWER_LOGS="$(printf '%s' "$LOGS" | /usr/bin/tr '[:upper:]' '[:lower:]')"
  if [ -z "$LOWER_LOGS" ]; then LOG_CLASS=empty
  elif [ "$CONTAINER_OOM" = true ] || printf '%s' "$LOWER_LOGS" | /usr/bin/grep -Eq 'out of memory|oom-kill|killed process'; then LOG_CLASS=oom
  elif printf '%s' "$LOWER_LOGS" | /usr/bin/grep -Eq 'address already in use|bind[^[:cntrl:]]*(failed|error)'; then LOG_CLASS=port-conflict
  elif printf '%s' "$LOWER_LOGS" | /usr/bin/grep -Eq '(encoder|gstreamer|nvh264|x264)[^[:cntrl:]]*(failed|error|unavailable)|no supported[^[:cntrl:]]*encoder'; then LOG_CLASS=encoder
  elif printf '%s' "$LOWER_LOGS" | /usr/bin/grep -Eq 'permission denied'; then LOG_CLASS=permission
  elif printf '%s' "$LOWER_LOGS" | /usr/bin/grep -Eq '(authentication|password)[^[:cntrl:]]*(failed|error|missing|required|invalid)'; then LOG_CLASS=authentication
  elif printf '%s' "$LOWER_LOGS" | /usr/bin/grep -Eq 'error|failed|fatal|traceback'; then LOG_CLASS=runtime-error
  else LOG_CLASS=other
  fi
elif printf '%s' "$INSPECT" | /usr/bin/grep -Eqi 'no such (object|container)'; then
  CONTAINER_STATE=missing
fi
BASIC_AUTH_FILE=false
UNAUTH_STATUS=null
AUTH_STATUS=null
if [ -s /var/lib/hivra/remote-desktop/basic-auth.b64 ]; then BASIC_AUTH_FILE=true; fi
RAW_UNAUTH="$(/usr/bin/timeout 8 /usr/bin/curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 http://127.0.0.1:8088/ 2>/dev/null || true)"
case "$RAW_UNAUTH" in [1-5][0-9][0-9]) UNAUTH_STATUS="$RAW_UNAUTH" ;; esac
if [ "$BASIC_AUTH_FILE" = true ]; then
  BASIC_PAIR="$(/usr/bin/tr -d '\r\n' < /var/lib/hivra/remote-desktop/basic-auth.b64)"
  if [ "${"$"}{#BASIC_PAIR}" -ge 32 ] && [ "${"$"}{#BASIC_PAIR}" -le 256 ] && [[ "$BASIC_PAIR" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
    RAW_AUTH="$({ printf 'header = "Authorization: Basic %s"\n' "$BASIC_PAIR"; } \
      | /usr/bin/timeout 8 /usr/bin/curl --config - --silent --output /dev/null --write-out '%{http_code}' --max-time 5 http://127.0.0.1:8088/ 2>/dev/null || true)"
    case "$RAW_AUTH" in [1-5][0-9][0-9]) AUTH_STATUS="$RAW_AUTH" ;; esac
  fi
fi
printf '${DESKTOP_DIAGNOSTIC_MARKER}{"selkiesUnit":"%s","brokerUnit":"%s","containerState":"%s","containerOomKilled":%s,"containerExitCode":%s,"containerRestartCount":%s,"basicAuthFile":%s,"unauthenticatedHttpStatus":%s,"authenticatedHttpStatus":%s,"logClass":"%s"}\n' \
  "$SELKIES_UNIT" "$BROKER_UNIT" "$CONTAINER_STATE" "$CONTAINER_OOM" "$CONTAINER_EXIT" "$CONTAINER_RESTARTS" \
  "$BASIC_AUTH_FILE" "$UNAUTH_STATUS" "$AUTH_STATUS" "$LOG_CLASS"
`;
  const desktopDiagnosticProgramBase64 = Buffer.from(desktopDiagnosticProgram, "utf8").toString("base64");
  return `#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C
umask 077
VMID=${input.vmid}
GUEST_IP=${shellQuote(input.guestIp)}
EXPECTED_BINDING_TAG=${shellQuote(input.infrastructureBindingTag)}
DIAGNOSTIC_PHASE=target_running
emit_diagnostic_phase_failure() {
  status=$?
  trap - ERR
  printf 'HIVRA_QGA_DIAGNOSTIC_HOST_FAILURE %s\n' "$DIAGNOSTIC_PHASE" >&2
  exit "$status"
}
trap emit_diagnostic_phase_failure ERR
[ "$(qm status "$VMID" 2>/dev/null | tr -d '\r' | awk '/^status:/{print $2; exit}')" = 'running' ]
DIAGNOSTIC_PHASE=target_config
VM_CONFIG="$(qm config "$VMID")"
DIAGNOSTIC_PHASE=target_binding_tag
printf '%s\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p' | tr ';' '\n' | grep -Fxq "$EXPECTED_BINDING_TAG"
DIAGNOSTIC_PHASE=target_guest_ip
printf '%s\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\n' | grep -Fxq "ip=$GUEST_IP/24"
run_diagnostic_probe() {
  label="$1"
  shift
  DIAGNOSTIC_PHASE="probe_\${label}_allocate"
  result_file="$(mktemp /run/hivra-qga-diagnostic-result.XXXXXXXX)"
  error_file="$(mktemp /run/hivra-qga-diagnostic-error.XXXXXXXX)"
  dispatch_exit=0
  DIAGNOSTIC_PHASE="probe_\${label}_dispatch"
  qm guest exec "$VMID" --timeout 0 -- "$@" >"$result_file" 2>"$error_file" || dispatch_exit=$?
  DIAGNOSTIC_PHASE="probe_\${label}_classify"
  /usr/bin/perl -MJSON::PP - "$label" "$dispatch_exit" "$result_file" "$error_file" <<'HIVRA_QGA_DIAGNOSTIC'
use strict;
use warnings;
my ($label, $dispatch_exit, $result_path, $error_path) = @ARGV;
my $document = {};
my $result_raw = '';
eval {
    open my $result_stream, '<', $result_path or die "open";
    local $/;
    $result_raw = <$result_stream> // '';
    my $candidate = JSON::PP::decode_json($result_raw);
    close $result_stream;
    $document = $candidate if ref($candidate) eq 'HASH';
};
my $dispatch_error = '';
if (open my $error_stream, '<', $error_path) {
    local $/;
    $dispatch_error = <$error_stream> // '';
    close $error_stream;
}
my $stdout = exists($document->{'out-data'}) && !ref($document->{'out-data'}) ? $document->{'out-data'} : '';
my $stderr = exists($document->{'err-data'}) && !ref($document->{'err-data'}) ? $document->{'err-data'} : '';
my $combined = lc($stderr . "\n" . $dispatch_error);
my $stdout_class = $stdout eq '' ? 'empty' : $stdout eq 'diag-output' ? 'diagnostic-marker'
    : index($stdout, '/run/hivra-qga-diag.') == 0 ? 'runtime-path' : 'other';
my $stderr_class = $combined !~ /\S/ ? 'empty' : $combined =~ /no such file/ ? 'missing-command'
    : $combined =~ /permission denied/ ? 'permission' : $combined =~ /agent is not running/ ? 'agent-unavailable'
    : $combined =~ /timeout/ ? 'timeout' : 'other';
my $exitcode_value = $document->{exitcode};
my $exitcode = exists($document->{exitcode}) && defined($exitcode_value) && !ref($exitcode_value)
    && $exitcode_value =~ /^\\d+$/ ? 0 + $exitcode_value : undef;
my $exited_token_class = $result_raw =~ /"exited"\\s*:\\s*1(?:\\s*[,}])/ ? 'integer-one'
    : $result_raw =~ /"exited"\\s*:\\s*true(?:\\s*[,}])/ ? 'boolean-true'
    : $result_raw =~ /"exited"\\s*:\\s*"/ ? 'string'
    : exists($document->{exited}) ? 'other' : 'missing';
my $exitcode_token_class = $result_raw =~ /"exitcode"\\s*:\\s*-?\\d+(?:\\s*[,}])/ ? 'integer'
    : $result_raw =~ /"exitcode"\\s*:\\s*"/ ? 'string'
    : exists($document->{exitcode}) ? 'other' : 'missing';
my @strict_exitcode_tokens = $result_raw =~ /"exitcode"\\s*:\\s*(\\d+)/g;
my @strict_exited_tokens = $result_raw =~ /"exited"\\s*:\\s*(?:1|true)(?:\\s*[,}])/g;
my $strict_decode_valid = defined($exitcode_value) && !ref($exitcode_value)
    && @strict_exitcode_tokens == 1 && @strict_exited_tokens == 1
    && "$exitcode_value" eq "$strict_exitcode_tokens[0]";
my $value = {label => $label, dispatchExit => 0 + $dispatch_exit,
    exited => $document->{exited} ? JSON::PP::true : JSON::PP::false, exitcode => $exitcode,
    exitedTokenClass => $exited_token_class, exitcodeTokenClass => $exitcode_token_class,
    strictDecodeValid => $strict_decode_valid ? JSON::PP::true : JSON::PP::false,
    resultKeys => [sort keys %$document], stdoutClass => $stdout_class, stdoutLength => length($stdout),
    stderrClass => $stderr_class, stderrLength => length($stderr) + length($dispatch_error)};
print "${TRANSPORT_DIAGNOSTIC_MARKER}" . JSON::PP::encode_json($value) . "\n";
HIVRA_QGA_DIAGNOSTIC
  DIAGNOSTIC_PHASE="probe_\${label}_cleanup"
  truncate -s 0 "$result_file" "$error_file"
  unlink "$result_file"
  unlink "$error_file"
}
run_diagnostic_probe true /usr/bin/true
run_diagnostic_probe rm /usr/bin/rm -rf -- /run/hivra-qga-diag.nonexistent
run_diagnostic_probe printf /usr/bin/printf diag-output
run_diagnostic_probe shell /bin/bash -c 'set -e; path=$(/usr/bin/mktemp -d /run/hivra-qga-diag.XXXXXXXX); printf "%s" "$path"; /usr/bin/rm -rf -- "$path"'
${buildVmidBoundGuestExecPrelude()}
DIAGNOSTIC_PHASE=shared_decoder_true
run_vmid_bound_guest_exec /usr/bin/true >/dev/null
DIAGNOSTIC_PHASE=shared_decoder_rm
run_vmid_bound_guest_exec /usr/bin/rm -rf -- /run/hivra-remote-desktop-install.00000000-0000-4000-8000-000000000000 >/dev/null
DIAGNOSTIC_PHASE=desktop_runtime
DESKTOP_DIAGNOSTIC_PROGRAM_BASE64=${shellQuote(desktopDiagnosticProgramBase64)}
run_vmid_bound_guest_exec /bin/bash -c 'printf "%s" "$1" | /usr/bin/base64 --decode | /bin/bash -s' hivra "$DESKTOP_DIAGNOSTIC_PROGRAM_BASE64"
trap - ERR
`;
}

function parseGuestTransportDiagnostics(stdout: string): RemoteDesktopGuestTransportDiagnosticResult["probes"] | null {
  const values = stdout.split("\n").filter(line => line.startsWith(TRANSPORT_DIAGNOSTIC_MARKER));
  if (values.length !== 4) return null;
  const labels = ["true", "rm", "printf", "shell"] as const;
  try {
    const probes = values.map(line => JSON.parse(line.slice(TRANSPORT_DIAGNOSTIC_MARKER.length)) as Record<string, unknown>);
    if (probes.some((probe, index) => probe.label !== labels[index]
      || !Number.isSafeInteger(probe.dispatchExit) || Number(probe.dispatchExit) < 0
      || typeof probe.exited !== "boolean"
      || !(probe.exitcode === null || Number.isSafeInteger(probe.exitcode))
      || !["integer-one", "boolean-true", "string", "other", "missing"].includes(String(probe.exitedTokenClass))
      || !["integer", "string", "other", "missing"].includes(String(probe.exitcodeTokenClass))
      || typeof probe.strictDecodeValid !== "boolean"
      || !Array.isArray(probe.resultKeys) || probe.resultKeys.some(key => typeof key !== "string")
      || !["empty", "diagnostic-marker", "runtime-path", "other"].includes(String(probe.stdoutClass))
      || !Number.isSafeInteger(probe.stdoutLength) || Number(probe.stdoutLength) < 0
      || !["empty", "missing-command", "permission", "agent-unavailable", "timeout", "other"].includes(String(probe.stderrClass))
      || !Number.isSafeInteger(probe.stderrLength) || Number(probe.stderrLength) < 0)) return null;
    return probes as NonNullable<RemoteDesktopGuestTransportDiagnosticResult["probes"]>;
  } catch { return null; }
}

function parseDesktopRuntimeDiagnostic(stdout: string): RemoteDesktopGuestTransportDiagnosticResult["desktop"] | null {
  const values = stdout.split("\n").filter(line => line.startsWith(DESKTOP_DIAGNOSTIC_MARKER));
  if (values.length !== 1) return null;
  try {
    const value = JSON.parse(values[0].slice(DESKTOP_DIAGNOSTIC_MARKER.length)) as Record<string, unknown>;
    const unitStates = ["active", "inactive", "failed", "activating", "deactivating", "unknown"];
    const containerStates = ["running", "exited", "restarting", "created", "paused", "dead", "missing", "unknown"];
    const logClasses = ["empty", "encoder", "port-conflict", "authentication", "oom", "permission", "runtime-error", "other"];
    const nullableStatus = (candidate: unknown) => candidate === null
      || (Number.isSafeInteger(candidate) && Number(candidate) >= 100 && Number(candidate) <= 599);
    const nullableCount = (candidate: unknown) => candidate === null
      || (Number.isSafeInteger(candidate) && Number(candidate) >= 0);
    if (Object.keys(value).sort().join(",") !== [
      "authenticatedHttpStatus", "basicAuthFile", "brokerUnit", "containerExitCode", "containerOomKilled",
      "containerRestartCount", "containerState", "logClass", "selkiesUnit", "unauthenticatedHttpStatus",
    ].sort().join(",")
      || !unitStates.includes(String(value.selkiesUnit))
      || !unitStates.includes(String(value.brokerUnit))
      || !containerStates.includes(String(value.containerState))
      || !(value.containerOomKilled === null || typeof value.containerOomKilled === "boolean")
      || !nullableCount(value.containerExitCode)
      || !nullableCount(value.containerRestartCount)
      || typeof value.basicAuthFile !== "boolean"
      || !nullableStatus(value.unauthenticatedHttpStatus)
      || !nullableStatus(value.authenticatedHttpStatus)
      || !logClasses.includes(String(value.logClass))) return null;
    return value as NonNullable<RemoteDesktopGuestTransportDiagnosticResult["desktop"]>;
  } catch { return null; }
}

export async function diagnoseRemoteDesktopGuestTransport(
  agentId: string,
  dependencies: Partial<Dependencies> = {},
): Promise<RemoteDesktopGuestTransportDiagnosticResult> {
  if (!UUID.test(agentId)) return { ok: false, agentId, targetId: null, vmid: null, error: "Agent id is invalid." };
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const agent = await deps.loadAgent(agentId);
  if (!agent) return { ok: false, agentId, targetId: null, vmid: null, error: "Agent not found." };
  const profileRuntime = resolveRemoteDesktopProfileRuntime(agent);
  if (!profileRuntime.ok) {
    return { ok: false, agentId, targetId: null, vmid: null, error: profileRuntime.message };
  }
  const vmid = Number(agent.vmid);
  const guestIp = typeof agent.ip === "string" ? agent.ip.trim() : "";
  if (agent.status !== "running" || agent.desired_state !== "running" || agent.operation_id != null
    || agent.operation_kind != null || !Number.isSafeInteger(vmid) || vmid < 100 || !validIpv4(guestIp)
    || agent.infrastructure_binding_token_enforced !== true) {
    return { ok: false, agentId, targetId: null, vmid: Number.isSafeInteger(vmid) ? vmid : null, error: "Agent is not in a stable, identity-bound running state." };
  }
  const context = await deps.resolveContext(agent.user_id, agent);
  if (!context.infrastructureBindingTagEnforced) {
    return { ok: false, agentId, targetId: context.host, vmid, error: "Remote desktop diagnostic authority is unavailable." };
  }
  const result = await deps.runHostScript(buildRemoteDesktopGuestTransportDiagnosticScript({
    vmid,
    guestIp,
    infrastructureBindingTag: context.infrastructureBindingTag,
  }), context.env, { timeoutMs: 60_000, maxOutputBytes: 16 * 1024 });
  if (!result.ok) {
    const phase = result.stderr.match(/(?:^|\n)HIVRA_QGA_DIAGNOSTIC_HOST_FAILURE ([a-z0-9_]+)(?=\r?\n|$)/)?.[1];
    const qgaFailure = result.stderr.match(/(?:^|\n)HIVRA_QGA_FAILURE ([a-z0-9_]+)(?=\r?\n|$)/)?.[1];
    return { ok: false, agentId, targetId: context.host, vmid,
      error: phase && qgaFailure
        ? `Remote desktop guest transport diagnostic failed (host_${phase}_qga_${qgaFailure}).`
        : phase ? `Remote desktop guest transport diagnostic failed (host_${phase}).`
          : qgaFailure ? `Remote desktop guest transport diagnostic failed (qga_${qgaFailure}).`
            : "Remote desktop guest transport diagnostic failed." };
  }
  const probes = parseGuestTransportDiagnostics(result.stdout);
  const desktop = parseDesktopRuntimeDiagnostic(result.stdout);
  if (!probes || !desktop) return { ok: false, agentId, targetId: context.host, vmid, error: "Remote desktop guest transport diagnostic receipt is invalid." };
  return { ok: true, agentId, targetId: context.host, vmid, probes, desktop };
}

export function buildRemoteDesktopGuestRestartScript(input: {
  vmid: number;
  guestIp: string;
  infrastructureBindingTag: string;
  publicOrigin: string;
  workspaceMarkerSha256: string;
}): string {
  if (
    !Number.isSafeInteger(input.vmid) || input.vmid < 100 || !validIpv4(input.guestIp)
    || !input.infrastructureBindingTag
    || !canonicalHttpsOrigin(input.publicOrigin)
    || !/^[a-f0-9]{64}$/.test(input.workspaceMarkerSha256)
  ) throw new Error("Remote desktop guest restart target is invalid.");
  const publicHost = new URL(input.publicOrigin).host;
  const restartProgram = `#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
WORKSPACE_MARKER_SHA256=${shellQuote(input.workspaceMarkerSha256)}
PUBLIC_HOST_HEADER=${shellQuote(`Host: ${publicHost}`)}
WORKSPACE=/home/bux/Hivra
BUX_UID="$(/usr/bin/id -u bux)"
BUX_GID="$(/usr/bin/id -g bux)"
[ -d "$WORKSPACE" ] && [ ! -L "$WORKSPACE" ]
[ "$(/usr/bin/stat -c %u "$WORKSPACE")" = "$BUX_UID" ]
[ "$(/usr/bin/stat -c %g "$WORKSPACE")" = "$BUX_GID" ]
[ "$(/usr/bin/stat -c %a "$WORKSPACE")" = '700' ]
/usr/bin/install -o "$BUX_UID" -g "$BUX_GID" -m 0600 /dev/null "$WORKSPACE/.hivra-restart-proof"
printf '%s\\n' "$WORKSPACE_MARKER_SHA256" > "$WORKSPACE/.hivra-restart-proof"
/usr/bin/chown "$BUX_UID:$BUX_GID" "$WORKSPACE/.hivra-restart-proof"
/usr/bin/systemctl restart hivra-selkies-desktop.service hivra-remote-desktop-broker.service
for _ in $(seq 1 60); do
  if /usr/bin/systemctl is-active --quiet hivra-selkies-desktop.service \\
    && /usr/bin/systemctl is-active --quiet hivra-remote-desktop-broker.service \\
    && /usr/bin/systemctl is-active --quiet bux-hivra-chat.service \\
    && [ "$(/usr/bin/cat "$WORKSPACE/.hivra-restart-proof")" = "$WORKSPACE_MARKER_SHA256" ] \\
    && /usr/bin/curl --fail --silent --show-error --max-time 5 -H "$PUBLIC_HOST_HEADER" http://127.0.0.1:8090/healthz >/dev/null; then
    printf '${RESTART_MARKER}{"protocol":"hivra-remote-desktop-restarted-v1","workspaceMarkerSha256":"%s"}\\n' "$WORKSPACE_MARKER_SHA256"
    exit 0
  fi
  sleep 2
done
exit 1
`;
  const restartProgramBase64 = Buffer.from(restartProgram, "utf8").toString("base64");
  return `#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
umask 077
VMID=${input.vmid}
GUEST_IP=${shellQuote(input.guestIp)}
EXPECTED_BINDING_TAG=${shellQuote(input.infrastructureBindingTag)}
RESTART_PROGRAM_BASE64=${shellQuote(restartProgramBase64)}
[[ "$VMID" =~ ^[0-9]+$ ]] && [ "$VMID" -ge 100 ]
[ "$(qm status "$VMID" 2>/dev/null | tr -d '\r' | awk '/^status:/{print $2; exit}')" = 'running' ]
VM_CONFIG="$(qm config "$VMID")"
TAGS="$(printf '%s\n' "$VM_CONFIG" | sed -n 's/^tags:[[:space:]]*//p')"
printf '%s\n' "$TAGS" | tr ';' '\n' | grep -Fxq "$EXPECTED_BINDING_TAG"
printf '%s\n' "$VM_CONFIG" | sed -n 's/^ipconfig0:[[:space:]]*//p' | tr ',' '\n' | grep -Fxq "ip=$GUEST_IP/24"
${buildVmidBoundGuestExecPrelude()}
run_vmid_bound_guest_exec /bin/bash -c 'printf "%s" "$1" | /usr/bin/base64 --decode | /bin/bash -s' hivra "$RESTART_PROGRAM_BASE64"
`;
}

function observedRestartMarker(stdout: string, expected: string): boolean {
  const lines = stdout.split("\n").filter(line => line.startsWith(RESTART_MARKER));
  if (lines.length !== 1) return false;
  try {
    const value = JSON.parse(lines[0].slice(RESTART_MARKER.length)) as Record<string, unknown>;
    return Object.keys(value).length === 2
      && value.protocol === "hivra-remote-desktop-restarted-v1"
      && value.workspaceMarkerSha256 === expected;
  } catch { return false; }
}

function safeInstallFailureCode(result: { ok: boolean; stdout: string; stderr: string; error?: string }): string {
  const guestFailure = result.stderr.match(/(?:^|\n)remote desktop install failed: ([^\r\n]+)(?:\r?\n|$)/)?.[1];
  if (guestFailure && /^[a-z0-9_]+$/.test(guestFailure)) return `guest_${guestFailure}`;
  const fixedGuestFailures: Record<string, string> = {
    "Selkies input isolation could not be verified": "guest_input_isolation_failed",
    "Selkies loopback authentication is not enforced": "guest_loopback_auth_failed",
    "Selkies loopback surface is not ready": "guest_loopback_surface_failed",
  };
  if (guestFailure && fixedGuestFailures[guestFailure]) return fixedGuestFailures[guestFailure];
  const hostPhase = result.stderr.match(/HIVRA_REMOTE_DESKTOP_HOST_FAILURE ([a-z0-9_]+)/)?.[1];
  const qgaFailure = result.stderr.match(/HIVRA_QGA_FAILURE ([a-z0-9_]+)/)?.[1];
  if (hostPhase && qgaFailure) return `host_${hostPhase}_qga_${qgaFailure}`;
  if (hostPhase) return `host_${hostPhase}`;
  if (qgaFailure) return `qga_${qgaFailure}`;
  const runnerError = result.error ?? "";
  if (/timed out/i.test(runnerError)) return "host_timeout";
  if (/output exceeded/i.test(runnerError)) return "host_output_limit";
  if (/SSH connection failed|SSH exec failed|SSH connect threw/i.test(runnerError)) return "host_ssh";
  if (/Remote bash exited/i.test(runnerError)) {
    const observedPhases = [...result.stderr.matchAll(/(?:^|\n)HIVRA_REMOTE_DESKTOP_PHASE ([a-z0-9_]+)(?=\r?\n|$)/g)];
    const lastPhase = observedPhases.at(-1)?.[1];
    return lastPhase ? `host_${lastPhase}_remote_exit` : "guest_remote_exit";
  }
  return "host_script_failed";
}

export async function installRemoteDesktopOnHivraAgent(
  agentId: string,
  controlOrigin: string,
  dependencies: Partial<Dependencies> = {},
  options: RemoteDesktopInstallOptions = {},
): Promise<RemoteDesktopGuestInstallationResult> {
  if (!UUID.test(agentId) || !canonicalHttpsOrigin(controlOrigin)) {
    return { ok: false, agentId, targetId: null, vmid: null, error: "Remote desktop install request is invalid." };
  }
  let normalizedControlBypassSecret = "";
  try {
    normalizedControlBypassSecret = normalizeControlBypassSecret(options.controlBypassSecret);
  } catch {
    return { ok: false, agentId, targetId: null, vmid: null, error: "Remote desktop install configuration is invalid." };
  }
  if ((options.controlBypassRequired !== undefined && typeof options.controlBypassRequired !== "boolean")
    || (options.controlBypassRequired === true && !normalizedControlBypassSecret)) {
    return { ok: false, agentId, targetId: null, vmid: null, error: "Remote desktop install configuration is invalid." };
  }
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const agent = await deps.loadAgent(agentId);
  if (!agent) return { ok: false, agentId, targetId: null, vmid: null, error: "Agent not found." };
  const profileRuntime = resolveRemoteDesktopProfileRuntime(agent);
  if (!profileRuntime.ok) {
    return { ok: false, agentId, targetId: null, vmid: null, error: profileRuntime.message };
  }
  const vmid = Number(agent.vmid);
  const guestIp = typeof agent.ip === "string" ? agent.ip.trim() : "";
  let publicOrigin = "";
  try { publicOrigin = new URL(agent.chat_url ?? "").origin; } catch {}
  const resuming = agent.operation_kind === DESKTOP_PREPARE_KIND && typeof agent.operation_id === "string" && UUID.test(agent.operation_id);
  if (agent.status !== "running" || (!resuming && agent.desired_state !== "running")
    || (!resuming && (agent.operation_id != null || agent.operation_kind != null))
    || !Number.isSafeInteger(vmid) || vmid < 100 || !validIpv4(guestIp)
    || agent.infrastructure_binding_token_enforced !== true || !canonicalHttpsOrigin(publicOrigin)) {
    return { ok: false, agentId, targetId: null, vmid: Number.isSafeInteger(vmid) ? vmid : null, error: "Agent is not in a stable, identity-bound running state." };
  }
  // A resumed operation cannot run the installer again. Reuse the existing
  // teardown binding contract for evidence-only observation after an allowed
  // credential repair, without granting fresh lifecycle dispatch authority.
  const context = await (resuming ? deps.resolveObservationContext : deps.resolveContext)(agent.user_id, agent);
  if (!context.infrastructureBindingTagEnforced) {
    return { ok: false, agentId, targetId: context.host, vmid, error: "Remote desktop install authority is unavailable." };
  }
  if (normalizedControlBypassSecret && context.kind !== "managed") {
    return { ok: false, agentId, targetId: context.host, vmid, error: "Remote desktop install configuration is invalid." };
  }
  if (options.controlBypassRequired && context.kind === "managed" && context.provisionerChannel !== "canary") {
    return { ok: false, agentId, targetId: context.host, vmid, code: "computer_not_ready",
      error: "This computer is not bound to isolated Canary preparation. Its shared host bundle was not changed." };
  }
  let claim;
  try { claim = await deps.beginPrepare(agent, randomUUID()); }
  catch {
    return { ok: false, agentId, targetId: context.host, vmid, code: "desktop_prepare_pending",
      error: "Desktop preparation authority could not be confirmed. Check preparation before attempting another installation." };
  }
  if (!claim) return { ok: false, agentId, targetId: context.host, vmid, code: "computer_not_ready", error: "Agent is not in a stable, identity-bound running state." };
  const pending = async (reason?: string): Promise<RemoteDesktopGuestInstallationResult> => {
    const error = DESKTOP_PREPARE_PENDING + (reason ? ` (${reason})` : "");
    await deps.retainPrepare({ userId: agent.user_id, agentId, operationId: claim.operationId, error }).catch(() => false);
    return { ok: false, agentId, targetId: context.host, vmid, code: "desktop_prepare_pending", error };
  };
  let dispatched = claim.phase === "dispatched";
  let completed = false;
  try {
    if (claim.resumed && !dispatched) {
      // Atomically cancel a request that never obtained dispatch authority. A
      // late original handler will lose dispatch CAS and cannot touch the VM.
      if (!await deps.cancelPrepare(agent.user_id, claim.operationId)) return pending();
      return { ok: false, agentId, targetId: context.host, vmid, code: "computer_not_ready", error: "The previous preparation stopped before guest dispatch. Prepare again when the computer is idle." };
    }
    // An owner preparing one guest is not authority to replace the shared
    // production/default host bundle. Only the persisted isolated Canary lane
    // may stage its own assets here; other lanes require prior operator setup.
    if (!claim.resumed && context.kind === "managed" && context.provisionerChannel === "canary") {
      const synced = await deps.syncManagedBundle(context.provisionerChannel, context.host);
      if (!synced.ok) {
        if (!await deps.cancelPrepare(agent.user_id, claim.operationId)) return pending();
        return { ok: false, agentId, targetId: context.host, vmid, error: "The managed host runtime could not be prepared." };
      }
    }
    const identity = { operationId: claim.operationId, computerId: agent.id, vmid, guestIp, bindingTag: context.infrastructureBindingTag };
    const runInstall = (observeOnly: boolean) => deps.runHostScript(
      buildRemoteDesktopGuestInstallScript({ ...identity,
        provisionerDirectory: context.paths.provisionerDirectory, infrastructureBindingTag: context.infrastructureBindingTag,
        controlOrigin, publicOrigin, controlBypassSecret: normalizedControlBypassSecret, observeOnly }),
      context.env, { timeoutMs: INSTALL_TIMEOUT_MS, maxOutputBytes: 32 * 1024 },
    );
    if (!claim.resumed) {
      if (!await deps.dispatchPrepare(agent.user_id, claim.operationId)) {
        if (!await deps.cancelPrepare(agent.user_id, claim.operationId)) return pending();
        return { ok: false, agentId, targetId: context.host, vmid, code: "computer_not_ready", error: "The computer changed before desktop preparation could start." };
      }
      dispatched = true;
    }
    let result = await runInstall(claim.resumed);
    let receipt = result.ok ? parseDesktopPrepareReceipt(result.stdout, identity) : null;
    // A dispatched lease can fail at host_target_running (qm status miss) after
    // the control plane already shows Running. Observe-only cannot mint a receipt
    // that never existed, so apply on the same operation instead of staying paused.
    if (!receipt && claim.resumed) {
      // The original dispatch may predate the current sealed desktop bundle.
      // Re-sync before re-applying that same lease, not before a successful
      // observe-only retry; retain the operation if source sync fails.
      if (context.kind === "managed" && context.provisionerChannel === "canary") {
        const synced = await deps.syncManagedBundle(context.provisionerChannel, context.host);
        if (!synced.ok) return pending("managed_bundle_sync");
      }
      result = await runInstall(false);
      receipt = result.ok ? parseDesktopPrepareReceipt(result.stdout, identity) : null;
    }
    if (!receipt) return pending(safeInstallFailureCode(result));
    const current = await deps.loadAgent(agentId);
    if (!current || JSON.stringify(desktopPrepareAuthority(current)) !== JSON.stringify(desktopPrepareAuthority(agent))
      || current.operation_id !== claim.operationId || current.operation_kind !== DESKTOP_PREPARE_KIND) return pending();
    if (receipt.exitCode !== 0 || current.desired_state === "deleted") {
      if (!await deps.completePrepare(agent.user_id, receipt)) return pending();
      return { ok: false, agentId, targetId: context.host, vmid, code: "desktop_prepare_failed",
        error: current.desired_state === "deleted" ? "Preparation has stopped; the pending computer deletion can now continue."
          : "The desktop installer stopped with an error. Its changes require inspection before another preparation." };
    }
    const capability = await deps.inspectCapability(agent.id, {
      loadAgent: async candidateId => candidateId === agent.id ? current : null,
      resolveContext: async (candidateUserId, candidateAgent) => {
        if (candidateUserId !== agent.user_id || candidateAgent !== current) throw new Error("Remote desktop inspection binding changed.");
        return context;
      }, runHostScript: deps.runHostScript,
    }, { preparationOperationId: claim.operationId });
    if (!await deps.completePrepare(agent.user_id, receipt)) return pending();
    completed = true;
    if (!capability.ok) return { ok: false, agentId, targetId: context.host, vmid,
      code: "desktop_prepare_failed", error: capability.error ?? "The guest installer stopped, but desktop readiness could not be verified." };
    const finalAgent = await deps.loadAgent(agentId);
    if (!finalAgent || finalAgent.status !== "running" || finalAgent.desired_state !== "running"
      || finalAgent.operation_id != null || finalAgent.operation_kind != null
      || JSON.stringify(desktopPrepareAuthority(finalAgent)) !== JSON.stringify(desktopPrepareAuthority(agent))) {
      return { ok: false, agentId, targetId: context.host, vmid, code: "computer_not_ready",
        error: "Desktop preparation finished, but the computer changed before readiness could be confirmed." };
    }
    return { ok: true, agentId, targetId: context.host, vmid, changed: !claim.resumed, capability };
  } catch {
    if (completed) return { ok: false, agentId, targetId: context.host, vmid, code: "computer_not_ready",
      error: "Desktop preparation finished, but the current computer state could not be checked." };
    if (!dispatched && await deps.cancelPrepare(agent.user_id, claim.operationId).catch(() => false)) {
      return { ok: false, agentId, targetId: context.host, vmid, error: "Desktop preparation stopped before guest dispatch." };
    }
    return pending();
  }
}

/** Restart the contained desktop and prove its persistent workspace survived. */
export async function verifyRemoteDesktopRestartOnHivraAgent(
  agentId: string,
  dependencies: Partial<Dependencies> = {},
): Promise<RemoteDesktopGuestRestartResult> {
  if (!UUID.test(agentId)) {
    return { ok: false, agentId, targetId: null, vmid: null, error: "Agent id is invalid." };
  }
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const agent = await deps.loadAgent(agentId);
  if (!agent) return { ok: false, agentId, targetId: null, vmid: null, error: "Agent not found." };
  const profileRuntime = resolveRemoteDesktopProfileRuntime(agent);
  if (!profileRuntime.ok) {
    return { ok: false, agentId, targetId: null, vmid: null, error: profileRuntime.message };
  }
  const vmid = Number(agent.vmid);
  const guestIp = typeof agent.ip === "string" ? agent.ip.trim() : "";
  let publicOrigin = "";
  try { publicOrigin = new URL(agent.chat_url ?? "").origin; } catch {}
  if (
    agent.status !== "running" || agent.desired_state !== "running"
    || agent.operation_id != null || agent.operation_kind != null
    || !Number.isSafeInteger(vmid) || vmid < 100 || !validIpv4(guestIp)
    || agent.infrastructure_binding_token_enforced !== true
    || !canonicalHttpsOrigin(publicOrigin)
  ) return { ok: false, agentId, targetId: null, vmid: Number.isSafeInteger(vmid) ? vmid : null, error: "Agent is not in a stable, identity-bound running state." };

  const context = await deps.resolveContext(agent.user_id, agent);
  if (!context.infrastructureBindingTagEnforced) {
    return { ok: false, agentId, targetId: context.host, vmid, error: "Remote desktop restart authority is unavailable." };
  }
  const marker = createHash("sha256").update(randomBytes(32)).digest("hex");
  let result;
  try {
    result = await deps.runHostScript(buildRemoteDesktopGuestRestartScript({
      vmid,
      guestIp,
      infrastructureBindingTag: context.infrastructureBindingTag,
      publicOrigin,
      workspaceMarkerSha256: marker,
    }), context.env, { timeoutMs: 3 * 60_000, maxOutputBytes: 16 * 1024 });
  } catch {
    return { ok: false, agentId, targetId: context.host, vmid, error: "Remote desktop restart failed." };
  }
  if (!result.ok || !observedRestartMarker(result.stdout, marker)) {
    return { ok: false, agentId, targetId: context.host, vmid, error: "Remote desktop restart could not be verified." };
  }
  const capability = await deps.inspectCapability(agent.id);
  if (!capability.ok) {
    return { ok: false, agentId, targetId: context.host, vmid, error: "Remote desktop restarted but its capability proof failed." };
  }
  return { ok: true, agentId, targetId: context.host, vmid, workspaceMarkerSha256: marker, capability };
}
