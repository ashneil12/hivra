import "server-only";

import {
  PORTABLE_HIVRA_COMPATIBLE_PROXMOX_VERSIONS,
  PORTABLE_HIVRA_MODEL_SETTINGS_VERSIONS,
  PORTABLE_HIVRA_PROVISIONER_VERSION,
} from "@/lib/infrastructure/portable-provisioner-contract";
import {
  runProxmoxHostScript,
  type HostScriptResult,
} from "@/lib/services/proxmox-instance-service";
import {
  managedHivraProvisionerChannelConfiguration,
  type ManagedHivraProvisionerChannel,
} from "./managed-provisioner-channel";
import { shellQuote } from "./proxmox-target";

export { MANAGED_HIVRA_RUNTIME_PATHS } from "./managed-provisioner-channel";

export type ManagedHivraHostReadinessResult =
  | { ok: true }
  | {
      ok: false;
      status: number;
      message: string;
      error: Record<string, unknown>;
    };

export type ManagedHivraHostReadinessPurpose = "provision" | "lifecycle" | "runtime-update";
type ManagedHivraHostEnvironment = Record<string, string | undefined>;

export function managedHivraHostReadinessScript(
  channel: ManagedHivraProvisionerChannel,
  purpose: ManagedHivraHostReadinessPurpose = "provision",
  requireModelSettings = false,
): string {
  const runtimePaths = managedHivraProvisionerChannelConfiguration(channel).runtime;
  const versions = purpose === "runtime-update" || (channel === "canary" && purpose === "provision")
    ? [PORTABLE_HIVRA_PROVISIONER_VERSION]
    : requireModelSettings ? PORTABLE_HIVRA_MODEL_SETTINGS_VERSIONS : PORTABLE_HIVRA_COMPATIBLE_PROXMOX_VERSIONS;
  const modelCapabilities = requireModelSettings ? `need_file "$PROVISIONER_DIR/hivra-chat/llm-application.js"
need_file "$PROVISIONER_DIR/hivra-chat/server.js"` : "";
  const provisionPrerequisites = purpose === "provision"
    ? `need_file "$PROVISION_SCRIPT"
need_file "$PROVISIONER_DIR/provision-claude-code-box.sh"
need_file "$PROVISIONER_DIR/hivra-chat/server.js"
need_readable ${shellQuote(runtimePaths.ubuntuImage)}
need_readable ${shellQuote(`${runtimePaths.vmSshKeyPath}.pub`)}`
    : "";
  const provisionCapabilities = purpose === "provision"
    ? `# The launch path requires atomic binding tags and a root-owned
# .allocated receipt before it will persist provider identity.
grep -Fq 'BINDING_TAG="\${HIVRA_BINDING_TAG:-}"' "$PROVISION_SCRIPT" \\
  || { echo "Hivra provisioner lacks binding-tag enforcement" >&2; exit 1; }
grep -Fq -- '--tags "\${BINDING_TAG};\${OPERATION_TAG}"' "$PROVISION_SCRIPT" \\
  || { echo "Hivra provisioner lacks atomic ownership tagging" >&2; exit 1; }
grep -Fq 'ALLOCATION_RECEIPT_FILE="/run/hivra-provision/\${VMID}.allocated"' "$PROVISION_SCRIPT" \\
  || { echo "Hivra provisioner lacks allocation receipts" >&2; exit 1; }
grep -Fq 'mv "$ALLOCATION_RECEIPT_TMP" "$ALLOCATION_RECEIPT_FILE"' "$PROVISION_SCRIPT" \\
  || { echo "Hivra provisioner lacks atomic allocation receipt publication" >&2; exit 1; }
ip link show ${shellQuote(runtimePaths.bridge)} >/dev/null 2>&1 \\
  || { echo "${runtimePaths.bridge} bridge is missing" >&2; exit 1; }
pvesm status | awk '$1=="${runtimePaths.storage}"{found=1} END{exit found?0:1}' \\
  || { echo "${runtimePaths.storage} storage is missing" >&2; exit 1; }
bash -n "$PROVISION_SCRIPT"
bash -n "$PROVISIONER_DIR/provision-claude-code-box.sh"`
    : "";
  const runtimeUpdateCapabilities = purpose === "runtime-update"
    ? `need_file "$PROVISIONER_DIR/hivra-update-guest-runtime.sh"`
    : "";
  return `#!/usr/bin/env bash
set -euo pipefail
PROVISIONER_DIR=${shellQuote(runtimePaths.provisionerDirectory)}
PROVISION_SCRIPT="$PROVISIONER_DIR/hivra-provision-on-host.sh"
START_SCRIPT="$PROVISIONER_DIR/hivra-start-on-host.sh"
missing=""
need_file() {
  if [ ! -f "$1" ]; then missing="$missing $1"; fi
}
need_readable() {
  if [ ! -r "$1" ]; then missing="$missing $1"; fi
}
need_file "$START_SCRIPT"
need_file "$PROVISIONER_DIR/VERSION"
need_file "$PROVISIONER_DIR/BUNDLE.sha256"
need_readable ${shellQuote(runtimePaths.vmSshKeyPath)}
${provisionPrerequisites}
${modelCapabilities}
${runtimeUpdateCapabilities}
if [ -n "$missing" ]; then
  echo "missing required Hivra provisioner prerequisites:$missing" >&2
  exit 1
fi
command -v qm >/dev/null || { echo "qm is not installed on this host" >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "sha256sum is not installed on this host" >&2; exit 1; }
OBSERVED_VERSION="$(tr -d '[:space:]' < "$PROVISIONER_DIR/VERSION")"
case "$OBSERVED_VERSION" in
  ${versions.map(shellQuote).join("|")}) ;;
  *) echo "Hivra provisioner version mismatch" >&2; exit 1 ;;
esac
(cd "$PROVISIONER_DIR" && sha256sum -c --status BUNDLE.sha256) \
  || { echo "Hivra provisioner bundle integrity check failed" >&2; exit 1; }
# VERSION admission is backed by exact capability checks so a stale or
# hand-copied script cannot opt into the current ownership contract merely by
# changing one text file.
${provisionCapabilities}
grep -Fq 'RESULT_LOG_PATH="\${HIVRA_RESULT_LOG_PATH:-\${LOG_DIR}/provision-\${VMID}.log}"' "$START_SCRIPT" \
  || { echo "Hivra start helper lacks an exact lifecycle result path" >&2; exit 1; }
grep -Fq "printf 'HIVRA_OPERATION_ID %s\\n' \\\"\\\$OPERATION_ID\\\"" "$START_SCRIPT" \
  || { echo "Hivra start helper lacks a durable operation receipt" >&2; exit 1; }
bash -n "$START_SCRIPT"
${purpose === "runtime-update" ? 'bash -n "$PROVISIONER_DIR/hivra-update-guest-runtime.sh"' : ""}
printf 'HIVRA_HOST_READY\\n'
`;
}

export async function checkManagedHivraHostReadiness(
  candidate: {
    targetId: string | null;
    env: ManagedHivraHostEnvironment;
    channel: ManagedHivraProvisionerChannel;
    purpose?: ManagedHivraHostReadinessPurpose;
    requireModelSettings?: boolean;
  },
  runner: (
    script: string,
    env: ManagedHivraHostEnvironment,
    options?: { timeoutMs?: number },
  ) => Promise<HostScriptResult> = runProxmoxHostScript,
): Promise<ManagedHivraHostReadinessResult> {
  const result = await runner(managedHivraHostReadinessScript(
    candidate.channel,
    candidate.purpose,
    candidate.requireModelSettings,
  ), candidate.env, {
    timeoutMs: 20_000,
  });
  if (result.ok && result.stdout.includes("HIVRA_HOST_READY")) return { ok: true };

  return {
    ok: false,
    status: 503,
    message: candidate.purpose === "runtime-update"
      ? "This computer cannot be updated until its infrastructure target has the current Hivra runtime bundle. Prepare the target, then try again."
      : candidate.requireModelSettings
        ? "Could not confirm model-settings support on this host. Use native sign-in or choose a prepared model-capable host."
        : "Deployment target is temporarily unavailable while the Hivra provisioner is being prepared. Please try again shortly.",
    error: {
      code: "HIVRA_HOST_READINESS_FAILED",
      targetId: candidate.targetId,
      reason: result.error ?? "readiness marker missing",
      stdout: result.stdout.slice(0, 300),
      stderr: result.stderr.slice(0, 300),
    },
  };
}
