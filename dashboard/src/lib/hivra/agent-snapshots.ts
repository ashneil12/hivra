import "server-only";

import { shellQuote } from "./proxmox-target";

const SNAPSHOT_ID_RE = /^hivra_[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function checkedVmid(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid Hivra snapshot VMID");
  return value;
}

function checkedProviderSnapshotId(value: string): string {
  if (!SNAPSHOT_ID_RE.test(value)) throw new Error("Invalid Hivra provider snapshot id");
  return value;
}

function checkedHash(value: string): string {
  if (!SHA256_RE.test(value)) throw new Error("Invalid Hivra snapshot configuration hash");
  return value;
}

function checkedOperationId(value: string): string {
  if (!OPERATION_ID_RE.test(value)) throw new Error("Invalid Hivra restore operation id");
  return value;
}

function lifecyclePrelude(vmid: number, bindingTag: string): string {
  if (!/^hivra-bind-[0-9a-f]{32}$/.test(bindingTag)) {
    throw new Error("Hivra snapshots require an enforced infrastructure binding tag");
  }
  return `set -euo pipefail
VMID=${checkedVmid(vmid)}
EXPECTED_BINDING_TAG=${shellQuote(bindingTag)}
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "timed out waiting for the Hivra lifecycle lock" >&2; exit 1; }
qm status "$VMID" >/dev/null
TAGS="$(qm config "$VMID" 2>/dev/null | sed -n 's/^tags:[[:space:]]*//p')"
printf '%s\n' "$TAGS" | tr ';' '\n' | grep -Fxq "$EXPECTED_BINDING_TAG" \
  || { echo "refusing snapshot operation without the exact Hivra binding tag" >&2; exit 1; }`;
}

const normalizedConfigFunctions = `normalized_snapshot_config() {
  qm config "$VMID" --snapshot "$SNAPSHOT" \
    | sed -E '/^(description|parent|running-nets-host-mtu|runningcpu|runningmachine|snaptime|vmgenid|vmstate):/d' \
    | LC_ALL=C sort
}
normalized_current_config() {
  qm config "$VMID" \
    | sed -E '/^(description|parent|running-nets-host-mtu|runningcpu|runningmachine|snaptime|vmgenid|vmstate):/d' \
    | LC_ALL=C sort
}`;

export function buildHivraSnapshotCreateScript(input: {
  vmid: number;
  bindingTag: string;
  providerSnapshotId: string;
  snapshotId: string;
  agentId: string;
}): string {
  const providerSnapshotId = checkedProviderSnapshotId(input.providerSnapshotId);
  return `${lifecyclePrelude(input.vmid, input.bindingTag)}
SNAPSHOT=${shellQuote(providerSnapshotId)}
DESCRIPTION=${shellQuote(`Hivra restore point ${input.snapshotId} for agent ${input.agentId}`)}
${normalizedConfigFunctions}
if qm config "$VMID" --snapshot "$SNAPSHOT" >/dev/null 2>&1; then
  echo "refusing to replace an existing provider snapshot" >&2
  exit 1
fi
BEFORE_STATUS="$(qm status "$VMID" | awk '{print $2}')"
[ "$BEFORE_STATUS" = running ] || [ "$BEFORE_STATUS" = stopped ] \
  || { echo "unsupported VM status before snapshot" >&2; exit 1; }
qm snapshot "$VMID" "$SNAPSHOT" --description "$DESCRIPTION" --vmstate 0 >/dev/null
normalized_snapshot_config >/dev/null
SNAPSHOT_CONFIG_SHA256="$(normalized_snapshot_config | sha256sum | awk '{print $1}')"
AFTER_STATUS="$(qm status "$VMID" | awk '{print $2}')"
[ "$AFTER_STATUS" = "$BEFORE_STATUS" ] \
  || { echo "VM power state changed while snapshotting" >&2; exit 1; }
printf 'HIVRA_SNAPSHOT_READY %s %s %s\n' "$SNAPSHOT" "$AFTER_STATUS" "$SNAPSHOT_CONFIG_SHA256"`;
}

export function buildHivraSnapshotRestoreScript(input: {
  vmid: number;
  bindingTag: string;
  providerSnapshotId: string;
  snapshotConfigSha256: string;
  operationId: string;
}): string {
  const providerSnapshotId = checkedProviderSnapshotId(input.providerSnapshotId);
  const expectedHash = checkedHash(input.snapshotConfigSha256);
  const operationId = checkedOperationId(input.operationId);
  const receiptPath = `/var/lib/hivra/restore-results/${checkedVmid(input.vmid)}-${operationId}.restored`;
  return `${lifecyclePrelude(input.vmid, input.bindingTag)}
SNAPSHOT=${shellQuote(providerSnapshotId)}
EXPECTED_SNAPSHOT_SHA256=${shellQuote(expectedHash)}
RESTORE_OPERATION_ID=${shellQuote(operationId)}
RESTORE_RECEIPT=${shellQuote(receiptPath)}
${normalizedConfigFunctions}
OBSERVED_SNAPSHOT_SHA256="$(normalized_snapshot_config | sha256sum | awk '{print $1}')"
[ "$OBSERVED_SNAPSHOT_SHA256" = "$EXPECTED_SNAPSHOT_SHA256" ] \
  || { echo "provider snapshot configuration does not match its durable receipt" >&2; exit 1; }
CURRENT_STATUS="$(qm status "$VMID" | awk '{print $2}')"
if [ "$CURRENT_STATUS" != stopped ]; then
  if ! qm shutdown "$VMID" --timeout 50 >/dev/null; then qm stop "$VMID" >/dev/null; fi
fi
[ "$(qm status "$VMID" | awk '{print $2}')" = stopped ] \
  || { echo "VM did not stop before restore" >&2; exit 1; }
qm rollback "$VMID" "$SNAPSHOT" >/dev/null
TAGS="$(qm config "$VMID" 2>/dev/null | sed -n 's/^tags:[[:space:]]*//p')"
printf '%s\n' "$TAGS" | tr ';' '\n' | grep -Fxq "$EXPECTED_BINDING_TAG" \
  || { echo "restored VM lost its exact Hivra binding tag" >&2; exit 1; }
CURRENT_CONFIG_SHA256="$(normalized_current_config | sha256sum | awk '{print $1}')"
[ "$CURRENT_CONFIG_SHA256" = "$EXPECTED_SNAPSHOT_SHA256" ] \
  || { echo "restored VM configuration does not match the selected restore point" >&2; exit 1; }
[ "$(qm status "$VMID" | awk '{print $2}')" = stopped ] \
  || { echo "restored VM is not stopped" >&2; exit 1; }
install -d -m 0700 /var/lib/hivra/restore-results
umask 077
RECEIPT_TMP="$RESTORE_RECEIPT.tmp.$$"
printf 'HIVRA_RESTORE_APPLIED %s %s %s\n' "$RESTORE_OPERATION_ID" "$SNAPSHOT" "$CURRENT_CONFIG_SHA256" > "$RECEIPT_TMP"
chmod 0600 "$RECEIPT_TMP"
mv -f "$RECEIPT_TMP" "$RESTORE_RECEIPT"
printf 'HIVRA_RESTORE_COMPLETE %s %s %s\n' "$SNAPSHOT" stopped "$CURRENT_CONFIG_SHA256"`;
}

export function buildHivraSnapshotObservationScript(input: {
  vmid: number;
  bindingTag: string;
  providerSnapshotId: string;
  operationId: string;
}): string {
  const providerSnapshotId = checkedProviderSnapshotId(input.providerSnapshotId);
  const operationId = checkedOperationId(input.operationId);
  const receiptPath = `/var/lib/hivra/restore-results/${checkedVmid(input.vmid)}-${operationId}.restored`;
  return `${lifecyclePrelude(input.vmid, input.bindingTag)}
SNAPSHOT=${shellQuote(providerSnapshotId)}
RESTORE_RECEIPT=${shellQuote(receiptPath)}
${normalizedConfigFunctions}
STATUS="$(qm status "$VMID" | awk '{print $2}')"
printf 'HIVRA_SNAPSHOT_OBSERVED_STATUS %s\n' "$STATUS"
if qm config "$VMID" --snapshot "$SNAPSHOT" >/dev/null 2>&1; then
  SNAPSHOT_SHA="$(normalized_snapshot_config | sha256sum | awk '{print $1}')"
  printf 'HIVRA_SNAPSHOT_OBSERVED_PRESENT %s\n' "$SNAPSHOT_SHA"
else
  printf 'HIVRA_SNAPSHOT_OBSERVED_ABSENT\n'
fi
CURRENT_SHA="$(normalized_current_config | sha256sum | awk '{print $1}')"
printf 'HIVRA_SNAPSHOT_OBSERVED_CURRENT %s\n' "$CURRENT_SHA"
if [ -r "$RESTORE_RECEIPT" ] \
  && grep -Fxq "HIVRA_RESTORE_APPLIED ${operationId} ${providerSnapshotId} $CURRENT_SHA" "$RESTORE_RECEIPT"; then
  printf 'HIVRA_SNAPSHOT_OBSERVED_RESTORE_RECEIPT\n'
fi`;
}

export type HivraSnapshotHostEvidence = {
  providerStatus: "running" | "stopped";
  providerSnapshotId: string;
  snapshotConfigSha256: string;
};

export function parseHivraSnapshotCreateEvidence(
  stdout: string,
  expectedProviderSnapshotId: string,
): HivraSnapshotHostEvidence | null {
  const expected = checkedProviderSnapshotId(expectedProviderSnapshotId);
  const matches = [...stdout.matchAll(/^HIVRA_SNAPSHOT_READY (hivra_[0-9a-f]{32}) (running|stopped) ([0-9a-f]{64})$/gm)];
  if (matches.length !== 1 || matches[0][1] !== expected) return null;
  return {
    providerSnapshotId: matches[0][1],
    providerStatus: matches[0][2] as "running" | "stopped",
    snapshotConfigSha256: matches[0][3],
  };
}

export function parseHivraSnapshotRestoreEvidence(
  stdout: string,
  expectedProviderSnapshotId: string,
  expectedConfigSha256: string,
): HivraSnapshotHostEvidence | null {
  const expected = checkedProviderSnapshotId(expectedProviderSnapshotId);
  const expectedHash = checkedHash(expectedConfigSha256);
  const matches = [...stdout.matchAll(/^HIVRA_RESTORE_COMPLETE (hivra_[0-9a-f]{32}) (stopped) ([0-9a-f]{64})$/gm)];
  if (matches.length !== 1 || matches[0][1] !== expected || matches[0][3] !== expectedHash) return null;
  return {
    providerSnapshotId: matches[0][1],
    providerStatus: "stopped",
    snapshotConfigSha256: matches[0][3],
  };
}

export type HivraSnapshotObservation = {
  providerStatus: "running" | "stopped";
  snapshotConfigSha256: string | null;
  currentConfigSha256: string;
  restoreReceiptMatches: boolean;
};

export function parseHivraSnapshotObservation(stdout: string): HivraSnapshotObservation | null {
  const status = stdout.match(/^HIVRA_SNAPSHOT_OBSERVED_STATUS (running|stopped)$/m)?.[1];
  const present = stdout.match(/^HIVRA_SNAPSHOT_OBSERVED_PRESENT ([0-9a-f]{64})$/m)?.[1] ?? null;
  const current = stdout.match(/^HIVRA_SNAPSHOT_OBSERVED_CURRENT ([0-9a-f]{64})$/m)?.[1];
  if ((status !== "running" && status !== "stopped") || !current) return null;
  return {
    providerStatus: status,
    snapshotConfigSha256: present,
    currentConfigSha256: current,
    restoreReceiptMatches: /^HIVRA_SNAPSHOT_OBSERVED_RESTORE_RECEIPT$/m.test(stdout),
  };
}
