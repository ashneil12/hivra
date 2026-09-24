// Claim-bound DeepSeek Harness acceptance launcher for managed Canary Proxmox.
//
// This is deliberately an operator-only fixture. It does not enable the public
// catalog. Every mutation is fenced to an explicitly allowlisted target/VMID,
// recorded in a local mode-0600 ledger, and reversible only after the host-side
// claim, VM tags and private IP all match the same operation.

import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  isProxmoxProvisioningConfigured,
  resolveProxmoxTargetConfiguration,
  runProxmoxHostScript,
} from "../src/lib/services/proxmox-instance-service";
import {
  resolveHivraIpLastOctetStart,
  resolveHivraNetworkConfig,
  resolveHivraVmidEnd,
  resolveHivraVmidStart,
  shellQuote,
} from "../src/lib/hivra/proxmox-target";
import { managedHivraProvisionerChannelConfiguration } from "../src/lib/hivra/managed-provisioner-channel";
import { managedProvisionerBundleManifestFile } from "../src/lib/hivra/managed-provisioner-bundle-sync";
import { loadPortableProvisionerBundle } from "../src/lib/infrastructure/connection-preparation";
import { PORTABLE_HIVRA_PROVISIONER_VERSION } from "../src/lib/infrastructure/portable-provisioner-contract";
import {
  createBoxTunnel,
  getTunnelConfig,
  type BoxTunnelJournal,
} from "../src/lib/services/cloudflare-tunnel";
import { deleteBoxTunnelVerified } from "../src/lib/services/cloudflare-tunnel-cleanup";

// Fenced to the Canary origin, so admit the bundle the way Canary's own managed
// launches do (managedHivraHostReadinessScript, canary provision): the canary
// delivery directory and its VERSION at exactly the current portable
// provisioner release. A hard-coded release goes stale at the next sealed bundle
// and the harness then refuses every current Canary host. The readiness
// script's other checks (ownership-contract greps, bridge/storage presence,
// start-helper receipts) are not repeated here: this harness checks capacity
// and ownership itself.
export const DEEPSEEK_CANARY_VERSION = PORTABLE_HIVRA_PROVISIONER_VERSION;
export const DEEPSEEK_CANARY_RUNTIME_PATHS = managedHivraProvisionerChannelConfiguration("canary").runtime;
export const DEEPSEEK_CANARY_ORIGIN = "https://canary.hermesos.cloud";

const BUNDLE_MANIFEST_LINE = /^[a-f0-9]{64} {2}[A-Za-z0-9._+@/-]{1,160}$/;

// A VERSION string does not identify a release: every delivery path reseals
// BUNDLE.sha256 from the bytes it ships, so a changed bundle that kept VERSION
// still verifies against its own manifest. The pinned release is the operator
// checkout's bundle, sealed exactly as managed bundle sync seals the Canary
// directory, and a host is admitted only if its manifest is those bytes.
export async function loadDeepSeekCanaryBundleManifest(
  bundleRoot = path.resolve(__dirname, "..", "provisioner"),
): Promise<string> {
  return managedProvisionerBundleManifestFile(await loadPortableProvisionerBundle(bundleRoot));
}

function assertBundleManifest(manifest: string): void {
  const lines = manifest.endsWith("\n") ? manifest.slice(0, -1).split("\n") : [];
  if (lines.length === 0 || !lines.every(line => BUNDLE_MANIFEST_LINE.test(line))
    || !lines.some(line => line.endsWith("  VERSION"))) {
    throw new Error("The pinned DeepSeek Canary bundle manifest is malformed.");
  }
}

// Defines admit_canary_bundle; each script calls it before the allocation lock
// (fail fast) and again once the lock is held, because bundle sync swaps the
// directory under that same lock. Only the second call binds what the script
// then inventories or dispatches. The host manifest must equal the pinned one
// byte for byte, and every file must still match it, so neither a resealed
// same-VERSION bundle nor a hand edit is admitted. An empty manifest is refused
// explicitly because not every sha256sum rejects one.
function bundleAdmission(manifest: string): string {
  assertBundleManifest(manifest);
  return `PROVISIONER_DIR=${shellQuote(DEEPSEEK_CANARY_RUNTIME_PATHS.provisionerDirectory)}
EXPECTED_BUNDLE_MANIFEST=${shellQuote(manifest)}
admit_canary_bundle() {
  [ "$(tr -d '[:space:]' < "$PROVISIONER_DIR/VERSION")" = ${shellQuote(DEEPSEEK_CANARY_VERSION)} ] \\
    || { echo "HIVRA_DEEPSEEK_VERSION_MISMATCH" >&2; exit 4; }
  [ -f "$PROVISIONER_DIR/BUNDLE.sha256" ] && [ ! -L "$PROVISIONER_DIR/BUNDLE.sha256" ] && [ -s "$PROVISIONER_DIR/BUNDLE.sha256" ] \\
    || { echo "HIVRA_DEEPSEEK_BUNDLE_MANIFEST_MISSING" >&2; exit 4; }
  printf '%s' "$EXPECTED_BUNDLE_MANIFEST" | cmp -s - "$PROVISIONER_DIR/BUNDLE.sha256" \\
    || { echo "HIVRA_DEEPSEEK_BUNDLE_RELEASE_MISMATCH" >&2; exit 4; }
  (cd "$PROVISIONER_DIR" && sha256sum -c --status BUNDLE.sha256) \\
    || { echo "HIVRA_DEEPSEEK_BUNDLE_INTEGRITY_MISMATCH" >&2; exit 4; }
}`;
}

type Phase = "planned" | "tunnel_intent" | "tunnel_created" | "launched" | "tunnel_clean" | "clean";

export interface DeepSeekCanaryLedger {
  schemaVersion: 1;
  phase: Phase;
  createdAt: string;
  updatedAt: string;
  target: string;
  expectedHostname: string;
  vmid: number;
  ip: string;
  operationId: string;
  bindingTag: string;
  tunnel?: { tunnelId?: string; hostname: string };
  launch?: { url: string; cpu: number; memoryMb: number };
  cleanup?: { vmAbsent: boolean; volumesAbsent: boolean; hostArtifactsAbsent: boolean; tunnelAbsent: boolean };
}

export interface CliArgs {
  mode: "inspect" | "launch" | "read-access" | "restart" | "teardown";
  target: string;
  expectedHostname: string;
  ledgerPath: string;
  tokenFile: string | null;
  vmid: number | null;
  octet: number | null;
  cpu: number;
  memoryMb: number;
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function token(value: string | undefined, pattern: RegExp, label: string): string {
  const trimmed = value?.trim() || "";
  if (!pattern.test(trimmed)) throw new Error(`Invalid ${label}.`);
  return trimmed;
}

function integer(value: string | undefined, label: string, minimum: number, maximum: number): number {
  if (!value || !/^[0-9]+$/.test(value)) throw new Error(`Invalid ${label}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Invalid ${label}.`);
  return parsed;
}

export function parseDeepSeekCanaryArgs(argv = process.argv.slice(2)): CliArgs {
  const selected = (["inspect", "launch", "read-access", "restart", "teardown"] as const)
    .filter(mode => argv.includes(`--${mode}`));
  if (selected.length !== 1) throw new Error("Choose exactly one operation: --inspect, --launch, --read-access, --restart or --teardown.");
  const mode = selected[0];
  const target = token(valueAfter(argv, "--target"), /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, "--target");
  const expectedHostname = token(valueAfter(argv, "--expected-hostname"), /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/, "--expected-hostname");
  const ledgerPath = path.resolve(valueAfter(argv, "--ledger") || "");
  if (!valueAfter(argv, "--ledger") || ledgerPath === path.parse(ledgerPath).root) throw new Error("--ledger must be a specific file path.");
  const tokenFileRaw = valueAfter(argv, "--token-file");
  const tokenFile = tokenFileRaw ? path.resolve(tokenFileRaw) : null;
  if (tokenFile && tokenFile === path.parse(tokenFile).root) throw new Error("--token-file must be a specific file path.");
  const needsIdentity = mode === "launch";
  return {
    mode,
    target,
    expectedHostname,
    ledgerPath,
    tokenFile,
    vmid: valueAfter(argv, "--vmid") ? integer(valueAfter(argv, "--vmid"), "--vmid", 100, 999_999_999) : needsIdentity ? integer(undefined, "--vmid", 100, 999_999_999) : null,
    octet: valueAfter(argv, "--octet") ? integer(valueAfter(argv, "--octet"), "--octet", 2, 254) : needsIdentity ? integer(undefined, "--octet", 2, 254) : null,
    cpu: integer(valueAfter(argv, "--cpu") || "2", "--cpu", 1, 64),
    memoryMb: integer(valueAfter(argv, "--memory-mb") || "4096", "--memory-mb", 1024, 262_144),
  };
}

function canaryOrigin(env: Record<string, string | undefined>): string {
  return (env.NEXT_PUBLIC_APP_URL || env.NEXT_PUBLIC_SITE_URL || env.APP_URL || "").trim().replace(/\/$/, "");
}

export function assertDeepSeekCanaryAuthorized(
  targetId: string,
  expectedHostname: string,
  env: Record<string, string | undefined>,
  vmid?: number,
): void {
  if (canaryOrigin(env) !== DEEPSEEK_CANARY_ORIGIN) {
    throw new Error(`DeepSeek live acceptance is fenced to ${DEEPSEEK_CANARY_ORIGIN}.`);
  }
  const targets = (env.HIVRA_DEEPSEEK_LAB_TARGETS || "").split(/[\s,]+/).map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!targets.includes(targetId.toLowerCase())) throw new Error(`Target ${targetId} is not authorized by HIVRA_DEEPSEEK_LAB_TARGETS.`);
  if (expectedHostname.toLowerCase() !== targetId.toLowerCase()) throw new Error("The expected hostname must exactly match the selected Canary target.");
  const mode = (env.PROXMOX_EXEC_MODE || "ssh").trim().toLowerCase();
  if (mode !== "ssh") throw new Error("DeepSeek Canary acceptance requires pinned SSH transport.");
  if (!env.PROXMOX_SSH_HOST_FINGERPRINT?.trim()) throw new Error("DeepSeek Canary acceptance requires a pinned SSH host fingerprint.");
  if (vmid !== undefined) {
    const key = targetId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const start = integer(env[`HIVRA_DEEPSEEK_LAB_TARGET_${key}_VMID_START`], "authorized VMID start", 100, 999_999_999);
    const end = integer(env[`HIVRA_DEEPSEEK_LAB_TARGET_${key}_VMID_END`], "authorized VMID end", 100, 999_999_999);
    if (start > end || vmid < start || vmid > end) throw new Error(`VMID ${vmid} is outside the authorized DeepSeek range ${start}-${end}.`);
  }
}

function readLedger(filename: string): DeepSeekCanaryLedger {
  if (!existsSync(filename)) throw new Error(`DeepSeek ledger does not exist: ${filename}`);
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("DeepSeek ledger must be a private regular file.");
  }
  const mode = readFileSync(filename);
  let parsed: unknown;
  try { parsed = JSON.parse(mode.toString("utf8")); } catch { throw new Error("DeepSeek ledger is invalid JSON."); }
  const value = parsed as Partial<DeepSeekCanaryLedger>;
  if (value.schemaVersion !== 1 || typeof value.operationId !== "string" || typeof value.bindingTag !== "string"
    || typeof value.vmid !== "number" || typeof value.ip !== "string" || typeof value.target !== "string"
    || typeof value.expectedHostname !== "string" || typeof value.phase !== "string") {
    throw new Error("DeepSeek ledger has an invalid schema.");
  }
  return value as DeepSeekCanaryLedger;
}

function writeLedger(filename: string, ledger: DeepSeekCanaryLedger, create = false): void {
  const directory = path.dirname(filename);
  if (!existsSync(directory)) throw new Error(`Ledger directory does not exist: ${directory}`);
  const next = { ...ledger, updatedAt: new Date().toISOString() };
  if (create) {
    const fd = openSync(filename, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, "utf8"); } finally { closeSync(fd); }
    chmodSync(filename, 0o600);
    return;
  }
  const temp = `${filename}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, "utf8"); } finally { closeSync(fd); }
  chmodSync(temp, 0o600);
  renameSync(temp, filename);
}

function updateLedger(filename: string, apply: (ledger: DeepSeekCanaryLedger) => DeepSeekCanaryLedger): DeepSeekCanaryLedger {
  const next = apply(readLedger(filename));
  writeLedger(filename, next);
  return next;
}

export function buildDeepSeekInventoryScript(params: {
  expectedHostname: string;
  vmidStart: number;
  vmidEnd: number;
  ipLastOctetStart: number;
  subnetPrefix: string;
  bundleManifest: string;
}): string {
  return `#!/usr/bin/env bash
set -euo pipefail
EXPECTED_HOSTNAME=${shellQuote(params.expectedHostname)}
VMID_START=${params.vmidStart}
VMID_END=${params.vmidEnd}
OCTET_START=${params.ipLastOctetStart}
SUBNET_PREFIX=${shellQuote(params.subnetPrefix)}
[ "$(hostname -s)" = "$EXPECTED_HOSTNAME" ] || { echo "HIVRA_DEEPSEEK_HOST_MISMATCH" >&2; exit 2; }
for command in qm pct pvesh pvesm flock awk sed grep sha256sum cmp; do command -v "$command" >/dev/null 2>&1 || { echo "HIVRA_DEEPSEEK_MISSING_COMMAND $command" >&2; exit 3; }; done
${bundleAdmission(params.bundleManifest)}
admit_canary_bundle
exec 8>/run/lock/hivra-allocation.lock
flock -s -w 60 8 || { echo "HIVRA_DEEPSEEK_INVENTORY_LOCK_TIMEOUT" >&2; exit 5; }
admit_canary_bundle
cluster_json="$(pvesh get /cluster/resources --type vm --output-format json)"
cluster_vmids="$(printf '%s' "$cluster_json" | grep -oE '"vmid":[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | sort -un || true)"
qm_inventory="$(qm list 2>/dev/null)" \
  || { echo "HIVRA_DEEPSEEK_QM_INVENTORY_UNKNOWN" >&2; exit 6; }
pct_inventory="$(pct list 2>/dev/null)" \
  || { echo "HIVRA_DEEPSEEK_LXC_INVENTORY_UNKNOWN" >&2; exit 6; }
candidate_vmid=""
for candidate in $(seq "$VMID_START" "$VMID_END"); do
  printf '%s\n' "$cluster_vmids" | grep -qx "$candidate" || { candidate_vmid="$candidate"; break; }
done
[ -n "$candidate_vmid" ] || { echo "HIVRA_DEEPSEEK_NO_FREE_VMID" >&2; exit 6; }
qm_network_configs="$(for id in $(printf '%s\n' "$qm_inventory" | awk 'NR>1 {print $1}'); do qm config "$id" 2>/dev/null || exit 1; done)" \
  || { echo "HIVRA_DEEPSEEK_QM_INVENTORY_UNKNOWN" >&2; exit 6; }
claimed_octets="$(printf '%s\n' "$qm_network_configs" \
  | grep -oE 'ip=[0-9.]+/' | awk -F. '{print $NF}' | tr -d '/' | sort -un || true)"
preferred=$((OCTET_START + candidate_vmid - VMID_START))
candidate_octet=""
for candidate in "$preferred" $(seq "$OCTET_START" 254); do
  [ "$candidate" -ge 2 ] && [ "$candidate" -le 254 ] || continue
  printf '%s\n' "$claimed_octets" | grep -qx "$candidate" || { candidate_octet="$candidate"; break; }
done
[ -n "$candidate_octet" ] || { echo "HIVRA_DEEPSEEK_NO_FREE_OCTET" >&2; exit 7; }
host_total_mb="$(awk '$1=="MemTotal:" {print int($2/1024)}' /proc/meminfo)"
qemu_claimed_mb=0
for id in $(printf '%s\n' "$qm_inventory" | awk 'NR>1 {print $1}'); do
  guest_config="$(qm config "$id" 2>/dev/null)" \
    || { echo "HIVRA_DEEPSEEK_QM_INVENTORY_UNKNOWN" >&2; exit 6; }
  printf '%s\n' "$guest_config" | grep -Eq '^template:[[:space:]]*1([[:space:]]|$)' && continue
  guest_memory_mb="$(printf '%s\n' "$guest_config" | awk '$1=="memory:" {print $2; exit}')"
  [[ "$guest_memory_mb" =~ ^[0-9]+$ ]] \
    || { echo "HIVRA_DEEPSEEK_MEMORY_INVENTORY_UNKNOWN" >&2; exit 6; }
  qemu_claimed_mb=$((qemu_claimed_mb + guest_memory_mb))
done
lxc_claimed_mb=0
for id in $(printf '%s\n' "$pct_inventory" | awk 'NR>1 {print $1}'); do
  guest_config="$(pct config "$id" 2>/dev/null)" \
    || { echo "HIVRA_DEEPSEEK_LXC_INVENTORY_UNKNOWN" >&2; exit 6; }
  printf '%s\n' "$guest_config" | grep -Eq '^template:[[:space:]]*1([[:space:]]|$)' && continue
  guest_memory_mb="$(printf '%s\n' "$guest_config" | awk '$1=="memory:" {print $2; exit}')"
  [[ "$guest_memory_mb" =~ ^[0-9]+$ ]] \
    || { echo "HIVRA_DEEPSEEK_MEMORY_INVENTORY_UNKNOWN" >&2; exit 6; }
  lxc_claimed_mb=$((lxc_claimed_mb + guest_memory_mb))
done
storage_status="$(pvesm status --content images 2>/dev/null)" \
  || { echo "HIVRA_DEEPSEEK_STORAGE_INVENTORY_UNKNOWN" >&2; exit 7; }
storage_available_kb="$(printf '%s\n' "$storage_status" | awk '$1=="${DEEPSEEK_CANARY_RUNTIME_PATHS.storage}" && $3=="active" {print $6; exit}')"
[[ "$host_total_mb" =~ ^[0-9]+$ && "$storage_available_kb" =~ ^[0-9]+$ ]] \
  || { echo "HIVRA_DEEPSEEK_CAPACITY_INVENTORY_UNKNOWN" >&2; exit 7; }
capacity_admits_4gb=false
[ $((qemu_claimed_mb + lxc_claimed_mb + 4096 + 2048)) -le "$host_total_mb" ] && [ "$storage_available_kb" -ge $((45 * 1024 * 1024)) ] && capacity_admits_4gb=true
printf 'HIVRA_DEEPSEEK_INVENTORY {"hostname":"%s","candidateVmid":%s,"candidateIp":"%s.%s","hostMemoryMb":%s,"claimedVmMemoryMb":%s,"claimedLxcMemoryMb":%s,"storageAvailableKb":%s,"capacityAdmits4Gb":%s,"provisionerVersion":"%s"}\n' \
  "$EXPECTED_HOSTNAME" "$candidate_vmid" "$SUBNET_PREFIX" "$candidate_octet" "$host_total_mb" "$qemu_claimed_mb" "$lxc_claimed_mb" "$storage_available_kb" "$capacity_admits_4gb" ${shellQuote(DEEPSEEK_CANARY_VERSION)}
`;
}

export function buildDeepSeekLaunchScript(params: {
  expectedHostname: string;
  vmid: number;
  ip: string;
  octet: number;
  subnetPrefix: string;
  gateway: string;
  operationId: string;
  bindingTag: string;
  cpu: number;
  memoryMb: number;
  tunnelToken: string;
  tunnelUrl: string;
  bundleManifest: string;
}): string {
  const operationTag = `hivra-op-${params.operationId.replace(/-/g, "")}`;
  const claim = `${params.operationId}|${params.bindingTag}|${params.expectedHostname}|${params.vmid}|${params.ip}`;
  const secret = (value: string) => Buffer.from(value, "utf8").toString("base64");
  return `#!/usr/bin/env bash
set -euo pipefail
umask 077
VMID=${params.vmid}
OCTET=${params.octet}
EXPECTED_IP=${shellQuote(params.ip)}
EXPECTED_HOSTNAME=${shellQuote(params.expectedHostname)}
OPERATION_ID=${shellQuote(params.operationId)}
BINDING_TAG=${shellQuote(params.bindingTag)}
OPERATION_TAG=${shellQuote(operationTag)}
CLAIM=${shellQuote(claim)}
CLAIM_DIR=/var/lib/hivra/deepseek-canary-claims
CLAIM_FILE="$CLAIM_DIR/$VMID.claim"
SECRET_ENV_FILE="/run/hivra-provision/$VMID.env"
PIDFILE="/run/hivra-provision/$VMID.pid"
[ "$(hostname -s)" = "$EXPECTED_HOSTNAME" ] || { echo "HIVRA_DEEPSEEK_HOST_MISMATCH" >&2; exit 2; }
for command in qm pct pvesm flock sha256sum cmp; do command -v "$command" >/dev/null 2>&1 || { echo "HIVRA_DEEPSEEK_MISSING_COMMAND $command" >&2; exit 3; }; done
${bundleAdmission(params.bundleManifest)}
admit_canary_bundle
install -d -m 0700 "$CLAIM_DIR"
install -d -m 0755 /run/lock /run/hivra-provision
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "HIVRA_DEEPSEEK_ALLOCATION_LOCK_TIMEOUT" >&2; exit 5; }
admit_canary_bundle
qm_inventory="$(qm list 2>/dev/null)" \
  || { echo "HIVRA_DEEPSEEK_QM_INVENTORY_UNKNOWN" >&2; exit 6; }
if printf '%s\n' "$qm_inventory" | awk -v wanted="$VMID" 'NR > 1 && $1 == wanted { found=1 } END { exit found ? 0 : 1 }'; then
  echo "HIVRA_DEEPSEEK_VMID_EXISTS" >&2
  exit 6
fi
pct_inventory="$(pct list 2>/dev/null)" \
  || { echo "HIVRA_DEEPSEEK_LXC_INVENTORY_UNKNOWN" >&2; exit 7; }
storage_inventory="$(pvesm list ${shellQuote(DEEPSEEK_CANARY_RUNTIME_PATHS.storage)} 2>/dev/null)" \
  || { echo "HIVRA_DEEPSEEK_STORAGE_INVENTORY_UNKNOWN" >&2; exit 7; }
if printf '%s\n' "$storage_inventory" | awk -v prefix="vm-$VMID-" 'NR > 1 { name=$1; sub(/^.*:/, "", name); if (index(name, prefix) == 1) found=1 } END { exit found ? 0 : 1 }'; then
  echo "HIVRA_DEEPSEEK_VOLUME_EXISTS" >&2
  exit 7
fi
for artifact in "/run/hivra-provision/$VMID.env" "/run/hivra-provision/$VMID.pid" "/run/hivra-provision/$VMID.allocated" "/var/lib/hivra/provision-results/$VMID.secret"; do
  [ ! -e "$artifact" ] || { echo "HIVRA_DEEPSEEK_HOST_ARTIFACT_EXISTS" >&2; exit 7; }
done
qemu_claimed_mb=0
for id in $(printf '%s\n' "$qm_inventory" | awk 'NR>1 {print $1}'); do
  qm_config="$(qm config "$id" 2>/dev/null)" \
    || { echo "HIVRA_DEEPSEEK_QM_INVENTORY_UNKNOWN" >&2; exit 8; }
  printf '%s\n' "$qm_config" | grep -Eq "^ipconfig0:.*ip=$EXPECTED_IP/" \
    && { echo "HIVRA_DEEPSEEK_IP_EXISTS" >&2; exit 8; }
  printf '%s\n' "$qm_config" | grep -Eq '^template:[[:space:]]*1([[:space:]]|$)' && continue
  guest_memory_mb="$(printf '%s\n' "$qm_config" | awk '$1=="memory:" {print $2; exit}')"
  [[ "$guest_memory_mb" =~ ^[0-9]+$ ]] \
    || { echo "HIVRA_DEEPSEEK_MEMORY_INVENTORY_UNKNOWN" >&2; exit 8; }
  qemu_claimed_mb=$((qemu_claimed_mb + guest_memory_mb))
done
[ -r /proc/meminfo ] || { echo "HIVRA_DEEPSEEK_MEMORY_INVENTORY_UNKNOWN" >&2; exit 8; }
host_total_mb="$(awk '$1=="MemTotal:" {print int($2/1024)}' /proc/meminfo)"
lxc_claimed_mb=0
for id in $(printf '%s\n' "$pct_inventory" | awk 'NR>1 {print $1}'); do
  pct_config="$(pct config "$id" 2>/dev/null)" \
    || { echo "HIVRA_DEEPSEEK_LXC_INVENTORY_UNKNOWN" >&2; exit 8; }
  printf '%s\n' "$pct_config" | grep -Eq '^template:[[:space:]]*1([[:space:]]|$)' && continue
  guest_memory_mb="$(printf '%s\n' "$pct_config" | awk '$1=="memory:" {print $2; exit}')"
  [[ "$guest_memory_mb" =~ ^[0-9]+$ ]] \
    || { echo "HIVRA_DEEPSEEK_MEMORY_INVENTORY_UNKNOWN" >&2; exit 8; }
  lxc_claimed_mb=$((lxc_claimed_mb + guest_memory_mb))
done
[[ "$host_total_mb" =~ ^[0-9]+$ && "$qemu_claimed_mb" =~ ^[0-9]+$ && "$lxc_claimed_mb" =~ ^[0-9]+$ ]] \
  || { echo "HIVRA_DEEPSEEK_MEMORY_INVENTORY_UNKNOWN" >&2; exit 8; }
[ $((qemu_claimed_mb + lxc_claimed_mb + ${params.memoryMb} + 2048)) -le "$host_total_mb" ] \
  || { echo "HIVRA_DEEPSEEK_INSUFFICIENT_RESERVED_MEMORY" >&2; exit 8; }
storage_available_kb="$(pvesm status --content images | awk '$1=="${DEEPSEEK_CANARY_RUNTIME_PATHS.storage}" && $3=="active" {print $6; exit}')"
[[ "$storage_available_kb" =~ ^[0-9]+$ ]] || { echo "HIVRA_DEEPSEEK_STORAGE_INVENTORY_UNKNOWN" >&2; exit 8; }
[ "$storage_available_kb" -ge $((45 * 1024 * 1024)) ] || { echo "HIVRA_DEEPSEEK_INSUFFICIENT_STORAGE" >&2; exit 8; }
[ ! -e "$CLAIM_FILE" ] || { echo "HIVRA_DEEPSEEK_CLAIM_EXISTS" >&2; exit 9; }
(set -o noclobber; printf '%s\n' "$CLAIM" > "$CLAIM_FILE") 2>/dev/null || { echo "HIVRA_DEEPSEEK_CLAIM_RACE" >&2; exit 9; }
chmod 0600 "$CLAIM_FILE"
install -m 0600 /dev/null "$SECRET_ENV_FILE"
cat > "$SECRET_ENV_FILE" <<'HIVRA_DEEPSEEK_SECRETS'
HIVRA_TUNNEL_TOKEN_B64=${secret(params.tunnelToken)}
HIVRA_TUNNEL_URL_B64=${secret(params.tunnelUrl)}
HIVRA_MODEL_KEY_B64=
HIVRA_MODEL_BASE_URL_B64=
HIVRA_HERMES_MODEL_B64=
HIVRA_DEEPSEEK_SECRETS
printf '%s\n' "$$" > "$PIDFILE"
exec env \
  HIVRA_PID_FILE="$PIDFILE" \
  HIVRA_SECRET_ENV_FILE="$SECRET_ENV_FILE" \
  HIVRA_OPERATION_ID="$OPERATION_ID" \
  HIVRA_BINDING_TAG="$BINDING_TAG" \
  HIVRA_ALLOCATION_LOCK_FD=8 \
  HIVRA_PROV_DIR=${shellQuote(DEEPSEEK_CANARY_RUNTIME_PATHS.provisionerDirectory)} \
  HIVRA_STORAGE=${shellQuote(DEEPSEEK_CANARY_RUNTIME_PATHS.storage)} \
  HIVRA_BRIDGE=${shellQuote(DEEPSEEK_CANARY_RUNTIME_PATHS.bridge)} \
  HIVRA_UBUNTU_IMG=${shellQuote(DEEPSEEK_CANARY_RUNTIME_PATHS.ubuntuImage)} \
  HIVRA_VM_SSH_KEY_PATH=${shellQuote(DEEPSEEK_CANARY_RUNTIME_PATHS.vmSshKeyPath)} \
  HIVRA_LOG_DIR=${shellQuote(DEEPSEEK_CANARY_RUNTIME_PATHS.logDirectory)} \
  HIVRA_SUBNET_PREFIX=${shellQuote(params.subnetPrefix)} \
  HIVRA_GW=${shellQuote(params.gateway)} \
  HIVRA_WANT_BROWSER=0 \
  bash ${shellQuote(`${DEEPSEEK_CANARY_RUNTIME_PATHS.provisionerDirectory}/hivra-provision-on-host.sh`)} \
  "$VMID" "$OCTET" ${params.cpu} ${params.memoryMb} deepseek-harness ${params.cpu}
`;
}

// Read-only. Run after a launch returns: the provisioner releases the allocation
// lock once the guest is running and copies the bundle into it afterwards, so a
// bundle sync in that window would put unadmitted bytes on the guest.
export function buildDeepSeekBundleCheckScript(params: { expectedHostname: string; bundleManifest: string }): string {
  return `#!/usr/bin/env bash
set -euo pipefail
EXPECTED_HOSTNAME=${shellQuote(params.expectedHostname)}
[ "$(hostname -s)" = "$EXPECTED_HOSTNAME" ] || { echo "HIVRA_DEEPSEEK_HOST_MISMATCH" >&2; exit 2; }
for command in flock sha256sum cmp; do command -v "$command" >/dev/null 2>&1 || { echo "HIVRA_DEEPSEEK_MISSING_COMMAND $command" >&2; exit 3; }; done
${bundleAdmission(params.bundleManifest)}
exec 8>/run/lock/hivra-allocation.lock
flock -s -w 60 8 || { echo "HIVRA_DEEPSEEK_BUNDLE_CHECK_LOCK_TIMEOUT" >&2; exit 5; }
admit_canary_bundle
printf 'HIVRA_DEEPSEEK_BUNDLE_ADMITTED {"provisionerVersion":"%s"}\\n' ${shellQuote(DEEPSEEK_CANARY_VERSION)}
`;
}

function ownershipPrelude(ledger: DeepSeekCanaryLedger, claimRequired = true): string {
  const operationTag = `hivra-op-${ledger.operationId.replace(/-/g, "")}`;
  const claim = `${ledger.operationId}|${ledger.bindingTag}|${ledger.expectedHostname}|${ledger.vmid}|${ledger.ip}`;
  return `VMID=${ledger.vmid}
EXPECTED_HOSTNAME=${shellQuote(ledger.expectedHostname)}
EXPECTED_IP=${shellQuote(ledger.ip)}
OPERATION_ID=${shellQuote(ledger.operationId)}
BINDING_TAG=${shellQuote(ledger.bindingTag)}
OPERATION_TAG=${shellQuote(operationTag)}
CLAIM=${shellQuote(claim)}
CLAIM_FILE="/var/lib/hivra/deepseek-canary-claims/$VMID.claim"
[ "$(hostname -s)" = "$EXPECTED_HOSTNAME" ] || { echo "HIVRA_DEEPSEEK_HOST_MISMATCH" >&2; exit 2; }
CLAIM_PRESENT=0
if [ -e "$CLAIM_FILE" ]; then
  [ "$(cat "$CLAIM_FILE" 2>/dev/null || true)" = "$CLAIM" ] || { echo "HIVRA_DEEPSEEK_CLAIM_MISMATCH" >&2; exit 3; }
  CLAIM_PRESENT=1
fi
${claimRequired ? '[ "$CLAIM_PRESENT" = 1 ] || { echo "HIVRA_DEEPSEEK_CLAIM_MISSING" >&2; exit 3; }' : ""}
vm_owned() {
  config="$(qm config "$VMID" 2>/dev/null)" || return 1
  tags="$(printf '%s\n' "$config" | sed -n 's/^tags:[[:space:]]*//p')"
  printf '%s\n' "$tags" | tr ';' '\n' | grep -Fxq "$OPERATION_TAG" \
    && printf '%s\n' "$tags" | tr ';' '\n' | grep -Fxq "$BINDING_TAG" \
    && printf '%s\n' "$config" | grep -Eq "^ipconfig0:.*ip=$EXPECTED_IP/24([,[:space:]]|$)"
}`;
}

export function buildDeepSeekReadAccessScript(ledger: DeepSeekCanaryLedger): string {
  return `#!/usr/bin/env bash
set -euo pipefail
${ownershipPrelude(ledger)}
vm_owned || { echo "HIVRA_DEEPSEEK_VM_IDENTITY_MISMATCH" >&2; exit 4; }
TOKEN_FILE="/var/lib/hivra/provision-results/$VMID.secret"
[ "$(stat -Lc '%a:%u:%g' "$TOKEN_FILE" 2>/dev/null)" = "600:0:0" ] || { echo "HIVRA_DEEPSEEK_TOKEN_MODE_INVALID" >&2; exit 5; }
token="$(tr -d '[:space:]' < "$TOKEN_FILE")"
[[ "$token" =~ ^[a-f0-9]{64}$ ]] || { echo "HIVRA_DEEPSEEK_TOKEN_INVALID" >&2; exit 6; }
printf 'HIVRA_DEEPSEEK_ACCESS_B64 %s\n' "$(printf '%s' "$token" | base64 -w 0)"
`;
}

export function buildDeepSeekRestartScript(ledger: DeepSeekCanaryLedger): string {
  return `#!/usr/bin/env bash
set -euo pipefail
${ownershipPrelude(ledger)}
VM_KEY=${shellQuote(DEEPSEEK_CANARY_RUNTIME_PATHS.vmSshKeyPath)}
SSH_IDENTITY_HELPER=${shellQuote(`${DEEPSEEK_CANARY_RUNTIME_PATHS.provisionerDirectory}/hivra-guest-ssh-known-hosts`)}
[ "$(stat -Lc '%a:%u:%g' "$VM_KEY" 2>/dev/null)" = "600:0:0" ] \
  || { echo "HIVRA_DEEPSEEK_VM_KEY_INVALID" >&2; exit 5; }
[ -f "$SSH_IDENTITY_HELPER" ] && [ ! -L "$SSH_IDENTITY_HELPER" ] && [ -x "$SSH_IDENTITY_HELPER" ] \
  || { echo "HIVRA_DEEPSEEK_SSH_IDENTITY_HELPER_INVALID" >&2; exit 5; }
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "HIVRA_DEEPSEEK_RESTART_LOCK_TIMEOUT" >&2; exit 6; }
vm_owned || { echo "HIVRA_DEEPSEEK_VM_IDENTITY_MISMATCH" >&2; exit 7; }
GUEST_SSH_IDENTITY_DIR="$(mktemp -d "/run/hivra-guest-ssh-identity.\${VMID}.XXXXXXXX")"
chmod 0700 "$GUEST_SSH_IDENTITY_DIR"
cleanup_guest_ssh_identity() { rm -rf -- "$GUEST_SSH_IDENTITY_DIR"; }
trap cleanup_guest_ssh_identity EXIT
"$SSH_IDENTITY_HELPER" "$VMID" "$EXPECTED_IP" "$GUEST_SSH_IDENTITY_DIR"
GSSH=(ssh -n -i "$VM_KEY" -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UpdateHostKeys=no \
  -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile="$GUEST_SSH_IDENTITY_DIR/known_hosts" \
  -o HostKeyAlias="hivra-vmid-$VMID" -o ConnectTimeout=3 -o ConnectionAttempts=1)
boot_before="$("\${GSSH[@]}" "ubuntu@$EXPECTED_IP" 'cat /proc/sys/kernel/random/boot_id' 2>/dev/null || true)"
[[ "$boot_before" =~ ^[a-f0-9-]{36}$ ]] \
  || { echo "HIVRA_DEEPSEEK_PRE_RESTART_BOOT_ID_UNAVAILABLE" >&2; exit 8; }
qm reboot "$VMID" --timeout 60
for _ in $(seq 1 120); do
  vm_owned || { echo "HIVRA_DEEPSEEK_VM_IDENTITY_CHANGED" >&2; exit 9; }
  boot_after="$("\${GSSH[@]}" "ubuntu@$EXPECTED_IP" 'cat /proc/sys/kernel/random/boot_id' 2>/dev/null || true)"
  if [[ "$boot_after" =~ ^[a-f0-9-]{36}$ ]] && [ "$boot_after" != "$boot_before" ] \
     && "\${GSSH[@]}" "ubuntu@$EXPECTED_IP" \
       'systemctl is-active --quiet bux-hivra-chat.service \
          && systemctl is-active --quiet hivra-cf-tunnel.service \
          && [ "$(curl -fsS http://127.0.0.1:8080/healthz)" = ok ]' \
       >/dev/null 2>&1; then
    printf 'HIVRA_DEEPSEEK_RESTARTED {"vmid":%s,"ip":"%s","bootChanged":true,"nativeReady":true}\n' "$VMID" "$EXPECTED_IP"
    exit 0
  fi
  sleep 2
done
echo "HIVRA_DEEPSEEK_RESTART_TIMEOUT" >&2
exit 10
`;
}

export function buildDeepSeekTeardownScript(ledger: DeepSeekCanaryLedger): string {
  return `#!/usr/bin/env bash
set -euo pipefail
${ownershipPrelude(ledger, false)}
STORAGE=${shellQuote(DEEPSEEK_CANARY_RUNTIME_PATHS.storage)}
QGA_SNIPPET="/var/lib/vz/snippets/hivra-qga-$VMID-$OPERATION_ID.yaml"
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "HIVRA_DEEPSEEK_TEARDOWN_LOCK_TIMEOUT" >&2; exit 5; }
PIDFILE="/run/hivra-provision/$VMID.pid"
QM_INVENTORY=""
STORAGE_INVENTORY=""
capture_qm_inventory() {
  if ! QM_INVENTORY="$(qm list)"; then
    echo "HIVRA_DEEPSEEK_QM_INVENTORY_UNKNOWN" >&2
    return 1
  fi
}
vm_present_in_inventory() {
  printf '%s\n' "$QM_INVENTORY" | awk -v id="$VMID" 'NR > 1 && $1 == id { found=1 } END { exit(found ? 0 : 1) }'
}
capture_storage_inventory() {
  if ! STORAGE_INVENTORY="$(pvesm list "$STORAGE")"; then
    echo "HIVRA_DEEPSEEK_STORAGE_INVENTORY_UNKNOWN" >&2
    return 1
  fi
}
volume_present_in_inventory() {
  printf '%s\n' "$STORAGE_INVENTORY" | awk -v id="$VMID" '$1 ~ (":vm-" id "-") { found=1 } END { exit(found ? 0 : 1) }'
}
if [ "$CLAIM_PRESENT" = 0 ]; then
  capture_qm_inventory || exit 6
  if vm_present_in_inventory; then echo "HIVRA_DEEPSEEK_UNCLAIMED_VM" >&2; exit 6; fi
  capture_storage_inventory || exit 6
  if volume_present_in_inventory; then echo "HIVRA_DEEPSEEK_UNCLAIMED_VOLUME" >&2; exit 6; fi
  rm -f -- "$QGA_SNIPPET"
  for artifact in "/run/hivra-provision/$VMID.env" "/run/hivra-provision/$VMID.pid" "/run/hivra-provision/$VMID.allocated" "/var/lib/hivra/provision-results/$VMID.secret" "$QGA_SNIPPET"; do
    [ ! -e "$artifact" ] || { echo "HIVRA_DEEPSEEK_UNCLAIMED_ARTIFACT" >&2; exit 6; }
  done
  printf 'HIVRA_DEEPSEEK_CLEAN {"vmid":%s,"operationId":"%s","vmAbsent":true,"volumesAbsent":true,"hostArtifactsAbsent":true}\n' "$VMID" "$OPERATION_ID"
  exit 0
fi
if [ -r "$PIDFILE" ]; then
  pid="$(tr -dc '0-9' < "$PIDFILE")"
  if [ -n "$pid" ] && [ -r "/proc/$pid/environ" ]; then
    if tr '\0' '\n' < "/proc/$pid/environ" | grep -Fxq "HIVRA_OPERATION_ID=$OPERATION_ID" \
       && tr '\0' '\n' < "/proc/$pid/environ" | grep -Fxq "HIVRA_BINDING_TAG=$BINDING_TAG"; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    fi
  fi
fi
capture_qm_inventory || exit 6
if vm_present_in_inventory; then
  vm_owned || { echo "HIVRA_DEEPSEEK_VM_IDENTITY_MISMATCH" >&2; exit 6; }
  qm stop "$VMID" --timeout 30 >/dev/null 2>&1 || true
  vm_owned || { echo "HIVRA_DEEPSEEK_VM_IDENTITY_CHANGED" >&2; exit 7; }
  qm destroy "$VMID" --purge 1 --destroy-unreferenced-disks 1
fi
capture_qm_inventory || exit 8
if vm_present_in_inventory; then echo "HIVRA_DEEPSEEK_TEARDOWN_VM_SURVIVES" >&2; exit 8; fi
capture_storage_inventory || exit 9
if volume_present_in_inventory; then
  while IFS= read -r volume; do
    if [ -n "$volume" ]; then pvesm free "$volume"; fi
  done < <(printf '%s\n' "$STORAGE_INVENTORY" | awk -v id="$VMID" '$1 ~ (":vm-" id "-") {print $1}')
fi
capture_storage_inventory || exit 9
if volume_present_in_inventory; then echo "HIVRA_DEEPSEEK_TEARDOWN_VOLUME_SURVIVES" >&2; exit 9; fi
rm -f "/run/hivra-provision/$VMID.env" "/run/hivra-provision/$VMID.pid" "/run/hivra-provision/$VMID.allocated" \
  "/var/lib/hivra/provision-results/$VMID.secret"
rm -f -- "$QGA_SNIPPET"
for artifact in "/run/hivra-provision/$VMID.env" "/run/hivra-provision/$VMID.pid" "/run/hivra-provision/$VMID.allocated" "/var/lib/hivra/provision-results/$VMID.secret" "$QGA_SNIPPET"; do
  [ ! -e "$artifact" ] || { echo "HIVRA_DEEPSEEK_TEARDOWN_ARTIFACT_SURVIVES" >&2; exit 10; }
done
rm -f "$CLAIM_FILE"
[ ! -e "$CLAIM_FILE" ] || { echo "HIVRA_DEEPSEEK_TEARDOWN_CLAIM_SURVIVES" >&2; exit 11; }
printf 'HIVRA_DEEPSEEK_CLEAN {"vmid":%s,"operationId":"%s","vmAbsent":true,"volumesAbsent":true,"hostArtifactsAbsent":true}\n' "$VMID" "$OPERATION_ID"
`;
}

function resultJson(stdout: string, marker: string): Record<string, unknown> {
  const match = stdout.match(new RegExp(`${marker}\\s+(\\{[^\\n]+\\})`));
  if (!match) throw new Error(`Host did not emit ${marker}.`);
  try { return JSON.parse(match[1]) as Record<string, unknown>; } catch { throw new Error(`Host emitted invalid ${marker}.`); }
}

function targetContext(args: CliArgs) {
  const target = resolveProxmoxTargetConfiguration(process.env, args.target);
  if (!isProxmoxProvisioningConfigured(target.env)) throw new Error(`Proxmox target ${args.target} is not fully configured.`);
  assertDeepSeekCanaryAuthorized(args.target, args.expectedHostname, target.env, args.vmid ?? undefined);
  const network = resolveHivraNetworkConfig(args.target, target.env);
  const vmidStart = resolveHivraVmidStart(target.env);
  const vmidEnd = resolveHivraVmidEnd(target.env, vmidStart);
  if (args.vmid !== null && (args.vmid < vmidStart || args.vmid > vmidEnd)) {
    throw new Error(`VMID ${args.vmid} is outside the configured target range ${vmidStart}-${vmidEnd}.`);
  }
  return { target, network, vmidStart, vmidEnd, ipLastOctetStart: resolveHivraIpLastOctetStart(target.env) };
}

async function runHost(script: string, env: Record<string, string | undefined>, timeoutMs: number) {
  const result = await runProxmoxHostScript(script, env, { timeoutMs, maxOutputBytes: 2 * 1024 * 1024 });
  if (!result.ok) throw new Error(result.stderr.trim() || result.error || "DeepSeek Canary host operation failed.");
  return result.stdout;
}

export async function launchDeepSeekCanary(args: CliArgs): Promise<void> {
  const { target, network } = targetContext(args);
  const bundleManifest = await loadDeepSeekCanaryBundleManifest();
  const vmid = args.vmid!;
  const operationId = randomUUID();
  const bindingTag = `hivra-bind-${randomBytes(16).toString("hex")}`;
  const ip = `${network.subnetPrefix}.${args.octet}`;
  const now = new Date().toISOString();
  writeLedger(args.ledgerPath, {
    schemaVersion: 1, phase: "planned", createdAt: now, updatedAt: now,
    target: args.target, expectedHostname: args.expectedHostname, vmid, ip, operationId, bindingTag,
  }, true);
  const journal: BoxTunnelJournal = {
    async beforeCreate({ hostname }) { updateLedger(args.ledgerPath, ledger => ({ ...ledger, phase: "tunnel_intent", tunnel: { hostname } })); },
    async cancelBeforeCreate() { updateLedger(args.ledgerPath, ledger => ({ ...ledger, phase: "planned", tunnel: undefined })); },
    async created({ tunnelId, hostname }) { updateLedger(args.ledgerPath, ledger => ({ ...ledger, phase: "tunnel_created", tunnel: { tunnelId, hostname } })); },
    async cleanupConfirmed() { updateLedger(args.ledgerPath, ledger => ({ ...ledger, phase: "planned", tunnel: undefined })); },
  };
  const tunnel = await createBoxTunnel(`deepseek-canary-${operationId.slice(0, 8)}`, { port: 8080, journal });
  if (!tunnel) throw new Error("Named Cloudflare tunnel configuration is unavailable.");
  try {
    const stdout = await runHost(buildDeepSeekLaunchScript({
      expectedHostname: args.expectedHostname, vmid, ip, octet: args.octet!, subnetPrefix: network.subnetPrefix,
      gateway: network.gateway, operationId, bindingTag, cpu: args.cpu, memoryMb: args.memoryMb,
      tunnelToken: tunnel.token, tunnelUrl: tunnel.url, bundleManifest,
    }), target.env, 30 * 60_000);
    const result = JSON.parse(stdout.trim().split(/\r?\n/).filter(line => line.startsWith("{")).at(-1) || "null") as Record<string, unknown> | null;
    if (!result || result.vmid !== vmid || result.ip !== ip || result.agent_kind !== "deepseek-harness" || result.chat_url !== tunnel.url || result.ready !== true) {
      throw new Error("DeepSeek provisioner returned a mismatched launch receipt.");
    }
    const admitted = resultJson(await runHost(buildDeepSeekBundleCheckScript({
      expectedHostname: args.expectedHostname, bundleManifest,
    }), target.env, 2 * 60_000), "HIVRA_DEEPSEEK_BUNDLE_ADMITTED");
    if (admitted.provisionerVersion !== DEEPSEEK_CANARY_VERSION) {
      throw new Error("The Canary bundle changed while the DeepSeek computer was being set up.");
    }
    updateLedger(args.ledgerPath, ledger => ({ ...ledger, phase: "launched", launch: { url: tunnel.url, cpu: args.cpu, memoryMb: args.memoryMb } }));
    console.log(JSON.stringify({ mode: "launched", target: args.target, vmid, ip, url: tunnel.url, operationId, provisionerVersion: DEEPSEEK_CANARY_VERSION }));
  } catch (error) {
    const ledger = readLedger(args.ledgerPath);
    let cleanupError: unknown = null;
    try { await runHost(buildDeepSeekTeardownScript(ledger), target.env, 10 * 60_000); } catch (caught) { cleanupError = caught; }
    try { await deleteBoxTunnelVerified({ tunnelId: tunnel.tunnelId, hostname: tunnel.hostname }, getTunnelConfig()); }
    catch (caught) { cleanupError ||= caught; }
    if (cleanupError) throw new Error(`DeepSeek launch failed and cleanup is unverified: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    updateLedger(args.ledgerPath, current => ({ ...current, phase: "clean", cleanup: { vmAbsent: true, volumesAbsent: true, hostArtifactsAbsent: true, tunnelAbsent: true } }));
    throw error;
  }
}

async function main(): Promise<void> {
  const args = parseDeepSeekCanaryArgs();
  if (args.mode === "launch") return launchDeepSeekCanary(args);
  const { target, network, vmidStart, vmidEnd, ipLastOctetStart } = targetContext(args);
  if (args.mode === "inspect") {
    const bundleManifest = await loadDeepSeekCanaryBundleManifest();
    const stdout = await runHost(buildDeepSeekInventoryScript({ expectedHostname: args.expectedHostname, vmidStart, vmidEnd, ipLastOctetStart, subnetPrefix: network.subnetPrefix, bundleManifest }), target.env, 60_000);
    console.log(JSON.stringify({ mode: "inspect", target: args.target, ...resultJson(stdout, "HIVRA_DEEPSEEK_INVENTORY") }));
    return;
  }
  const ledger = readLedger(args.ledgerPath);
  if (ledger.target !== args.target || ledger.expectedHostname !== args.expectedHostname) throw new Error("Ledger target identity does not match the command.");
  assertDeepSeekCanaryAuthorized(args.target, args.expectedHostname, target.env, ledger.vmid);
  if (args.mode === "read-access") {
    if (!args.tokenFile) throw new Error("--token-file is required for --read-access.");
    const stdout = await runHost(buildDeepSeekReadAccessScript(ledger), target.env, 60_000);
    const match = stdout.match(/HIVRA_DEEPSEEK_ACCESS_B64\s+([A-Za-z0-9+/]+={0,2})/);
    const access = match ? Buffer.from(match[1], "base64").toString("utf8") : "";
    if (!/^[a-f0-9]{64}$/.test(access)) throw new Error("Host returned an invalid access token receipt.");
    const fd = openSync(args.tokenFile, "wx", 0o600);
    try { writeFileSync(fd, `${access}\n`, "utf8"); } finally { closeSync(fd); }
    console.log(JSON.stringify({ mode: "access-written", tokenFile: args.tokenFile, vmid: ledger.vmid }));
    return;
  }
  if (args.mode === "restart") {
    const stdout = await runHost(buildDeepSeekRestartScript(ledger), target.env, 5 * 60_000);
    console.log(JSON.stringify({ mode: "restarted", ...resultJson(stdout, "HIVRA_DEEPSEEK_RESTARTED") }));
    return;
  }
  let tunnelAbsent = !ledger.tunnel?.tunnelId;
  let tunnelError: unknown = null;
  if (ledger.tunnel?.tunnelId && ledger.tunnel.hostname) {
    try {
      await deleteBoxTunnelVerified({ tunnelId: ledger.tunnel.tunnelId, hostname: ledger.tunnel.hostname }, getTunnelConfig());
      tunnelAbsent = true;
      updateLedger(args.ledgerPath, current => ({ ...current, phase: "tunnel_clean" }));
    } catch (error) { tunnelError = error; }
  }
  let hostError: unknown = null;
  try {
    const stdout = await runHost(buildDeepSeekTeardownScript(ledger), target.env, 10 * 60_000);
    resultJson(stdout, "HIVRA_DEEPSEEK_CLEAN");
  } catch (error) { hostError = error; }
  if (hostError || tunnelError || !tunnelAbsent) {
    throw new Error(`DeepSeek teardown is unverified (host=${hostError instanceof Error ? hostError.message : hostError ? String(hostError) : "ok"}; tunnel=${tunnelError instanceof Error ? tunnelError.message : tunnelError ? String(tunnelError) : tunnelAbsent ? "ok" : "unknown"}).`);
  }
  updateLedger(args.ledgerPath, current => ({ ...current, phase: "clean", cleanup: { vmAbsent: true, volumesAbsent: true, hostArtifactsAbsent: true, tunnelAbsent: true } }));
  console.log(JSON.stringify({ mode: "clean", target: args.target, vmid: ledger.vmid, operationId: ledger.operationId, survives: false }));
}

if (require.main === module) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
