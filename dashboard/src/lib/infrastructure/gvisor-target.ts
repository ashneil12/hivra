import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { supabaseAdmin } from "@/lib/supabase";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { beginInfrastructureConnectionPreflight, completeInfrastructureConnectionPreflight,
  loadInfrastructureConnectionSecret } from "./connection-store";
import { buildUserProxmoxEnvironment, resolveValidatedSshDestination } from "./connection-runtime";
import type { HostDiscoverySnapshot } from "./host-discovery-contracts";
import {
  hasHostAdministratorAuthority,
  hasRuntimeHostAuthority,
  LINUX_SANDBOX_PRIVILEGE_COPY,
  loadCurrentHostDiscoverySnapshot,
} from "./host-authority";
import { resolveProxmoxHostCapacityPolicy } from "./host-capacity-policy";
import { HIVRA_GVISOR_ADAPTER_VERSION, HIVRA_GVISOR_IMAGE } from "@/lib/hivra/gvisor-computer-contract";

const MARKER = "HIVRA_GVISOR_PREFLIGHT_V1 ";

export class GvisorTargetError extends Error {
  constructor(readonly code: "not_found" | "discovery_required" | "unsupported" | "remote_failed" | "database_failed", message: string) {
    super(message); this.name = "GvisorTargetError";
  }
}

function db() {
  if (!supabaseAdmin) throw new GvisorTargetError("database_failed", "The infrastructure store is unavailable.");
  return supabaseAdmin;
}

async function adapterDigest() {
  const bytes = await readFile(path.join(process.cwd(), "provisioner", "gvisor", "hivra-gvisor-adapter.py"));
  return createHash("sha256").update(bytes).digest("hex");
}

function preflightScript(expectedAdapterSha: string, expectedBundleSha: string) {
  return `#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
[ "$(id -u)" -eq 0 ]
[ "$(uname -s)" = Linux ]
[ "$(uname -m)" = x86_64 ]
[ -r /sys/fs/cgroup/cgroup.controllers ]
command -v docker >/dev/null
command -v runsc >/dev/null
systemctl is-active --quiet docker
[ "$(stat -c '%U:%G:%a' /opt/hivra/gvisor-adapter/hivra-gvisor-adapter)" = 'root:root:700' ]
[ "$(sha256sum /opt/hivra/gvisor-adapter/hivra-gvisor-adapter | awk '{print $1}')" = '${expectedAdapterSha}' ]
[ "$(stat -c '%U:%G:%a' /opt/hivra/gvisor-adapter/bundle.sha256)" = 'root:root:600' ]
[ "$(stat -c '%U:%G:%a' /opt/hivra/gvisor-adapter/runsc.sha256)" = 'root:root:600' ]
[ "$(stat -c '%U:%G:%a' /opt/hivra/gvisor-adapter/gvisor-bin.sha256)" = 'root:root:600' ]
[ "$(stat -c '%U:%G:%a' /usr/local/bin/gvisor-bin)" = 'root:root:755' ]
for sidecar in checkpointgofer gvisor-sentry-prewarmer gvisor_sentry runsc-metric-server; do
  [ "$(stat -c '%U:%G:%a' "/usr/local/bin/gvisor-bin/$sidecar")" = 'root:root:755' ]
done
[ "$(cat /opt/hivra/gvisor-adapter/bundle.sha256)" = '${expectedBundleSha}' ]
runsc_sha="$(cat /opt/hivra/gvisor-adapter/runsc.sha256)"
[[ "$runsc_sha" =~ ^[0-9a-f]{64}$ ]]
[ "$(sha256sum /usr/local/bin/runsc | awk '{print $1}')" = "$runsc_sha" ]
(cd / && sha256sum -c /opt/hivra/gvisor-adapter/gvisor-bin.sha256 >/dev/null)
docker info --format '{{json .Runtimes}}' | grep -q '"runsc"'
[ "$(readlink -f "$(docker info --format '{{(index .Runtimes "runsc").Path}}')")" = /usr/local/bin/runsc ]
cpu="$(getconf _NPROCESSORS_ONLN)"
memory="$(awk '$1=="MemTotal:" {printf "%.0f",$2/1024}' /proc/meminfo)"
memory_available="$(awk '$1=="MemAvailable:" {printf "%.0f",$2/1024}' /proc/meminfo)"
storage="$(df -B1 -P /var/lib/docker | awk 'NR==2 {print $2" "$4}')"
runsc_version="$(runsc --version | head -n 1 | base64 | tr -d '\\r\\n')"
printf '${MARKER}{"adapterVersion":"${HIVRA_GVISOR_ADAPTER_VERSION}","adapterSha256":"${expectedAdapterSha}","bundleSha256":"${expectedBundleSha}","runscSha256":"%s","cpu":%s,"memoryMb":%s,"memoryAvailableMb":%s,"storageTotalBytes":%s,"storageAvailableBytes":%s,"runscVersionBase64":"%s","image":"${HIVRA_GVISOR_IMAGE}"}\\n' "$runsc_sha" "$cpu" "$memory" "$memory_available" \
  "$(printf '%s' "$storage" | awk '{print $1}')" "$(printf '%s' "$storage" | awk '{print $2}')" "$runsc_version"
`;
}

export async function preflightGvisorTarget(userId: string, connectionId: string, expectedBundleSha: string,
  existingLease?: { runId: string; connectionRevision: number }) {
  if (!/^[0-9a-f]{64}$/.test(expectedBundleSha)) throw new GvisorTargetError("unsupported", "This Hivra installation has not pinned a supported gVisor release.");
  const connection = await loadInfrastructureConnectionSecret(userId, connectionId);
  if (!hasRuntimeHostAuthority(connection)) {
    throw new GvisorTargetError("unsupported", LINUX_SANDBOX_PRIVILEGE_COPY);
  }
  let snapshot: HostDiscoverySnapshot | null;
  try {
    snapshot = await loadCurrentHostDiscoverySnapshot(userId, connectionId, connection.revision);
  } catch {
    throw new GvisorTargetError("database_failed", "Host discovery evidence could not be read.");
  }
  if (!snapshot) {
    throw new GvisorTargetError("discovery_required", "Inspect this Linux host again before checking gVisor readiness.");
  }
  // The snapshot must have reached root the way the connection does now.
  if (!hasHostAdministratorAuthority(connection, snapshot) || snapshot.host.os.family !== "linux"
    || snapshot.host.kernel.architecture !== "amd64" || snapshot.host.environment.cgroupVersion !== 2) {
    throw new GvisorTargetError("unsupported", "This host needs Linux amd64, root or passwordless sudo, and cgroup v2 for the gVisor adapter.");
  }
  if (existingLease && existingLease.connectionRevision !== connection.revision) {
    throw new GvisorTargetError("not_found", "The infrastructure connection changed during preparation.");
  }
  const runId = existingLease?.runId ?? randomUUID();
  if (!existingLease && !await beginInfrastructureConnectionPreflight(userId, connectionId, connection.revision, runId, new Date().toISOString())) {
    throw new GvisorTargetError("database_failed", "Another infrastructure preparation or inspection is already running.");
  }
  try {
  const destination = await resolveValidatedSshDestination(connection.endpoint.sshHost);
  const env = buildUserProxmoxEnvironment({ id: connection.id, sshHost: connection.endpoint.sshHost,
    sshPort: connection.endpoint.sshPort, sshUser: connection.endpoint.sshUser,
    sshHostFingerprintSha256: connection.endpoint.sshHostFingerprintSha256!, sshPrivateKey: connection.credentials.sshPrivateKey,
    sshPrivilege: connection.endpoint.sshPrivilege, sshHostKeyType: connection.endpoint.sshHostKeyType }, destination);
  const sha = await adapterDigest();
  const result = await runProxmoxHostScript(preflightScript(sha, expectedBundleSha), env, { timeoutMs: 60_000, maxOutputBytes: 16 * 1024 });
  if (!result.ok) throw new GvisorTargetError("remote_failed", "The gVisor adapter did not pass its strict readiness check.");
  const line = result.stdout.split("\n").find(value => value.startsWith(MARKER));
  let report: { adapterVersion: string; adapterSha256: string; bundleSha256: string; runscSha256: string; cpu: number; memoryMb: number; memoryAvailableMb: number; storageTotalBytes: number;
    storageAvailableBytes: number; runscVersionBase64: string; image: string };
  try { report = JSON.parse(line?.slice(MARKER.length) ?? ""); } catch { throw new GvisorTargetError("remote_failed", "The gVisor readiness evidence was invalid."); }
  if (report.adapterVersion !== HIVRA_GVISOR_ADAPTER_VERSION || report.adapterSha256 !== sha || report.bundleSha256 !== expectedBundleSha
    || !/^[0-9a-f]{64}$/.test(report.runscSha256) || report.image !== HIVRA_GVISOR_IMAGE
    || !Number.isSafeInteger(report.cpu) || report.cpu < 1 || !Number.isSafeInteger(report.memoryMb) || report.memoryMb < 1024
    || !Number.isSafeInteger(report.memoryAvailableMb) || report.memoryAvailableMb < 0 || report.memoryAvailableMb > report.memoryMb
    || !Number.isSafeInteger(report.storageTotalBytes) || !Number.isSafeInteger(report.storageAvailableBytes)
    || report.storageAvailableBytes > report.storageTotalBytes || typeof report.runscVersionBase64 !== "string"
    || report.runscVersionBase64.length < 4 || report.runscVersionBase64.length > 1024
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(report.runscVersionBase64)
    || !Buffer.from(report.runscVersionBase64, "base64").toString("utf8").startsWith("runsc version")) {
    throw new GvisorTargetError("remote_failed", "The gVisor readiness evidence was invalid.");
  }
  const now = new Date().toISOString();
  const reserveMb = resolveProxmoxHostCapacityPolicy(connection.configuration?.capacityPolicy).hostMemoryReserveMb;
  const target = {
    externalId: `gvisor-${snapshot.hostIdentityDigest.slice(0, 24)}`, status: "ready",
    capacity: { cpu: { totalCores: report.cpu, utilizationRatio: null }, memoryBytes: { total: report.memoryMb * 1024 * 1024,
      available: Math.max(0, report.memoryAvailableMb - reserveMb) * 1024 * 1024 },
      storageBytes: { total: report.storageTotalBytes, available: report.storageAvailableBytes } },
    capabilities: { kind: "gvisor", launchReady: true, hostIdentityDigest: snapshot.hostIdentityDigest,
      adapter: { version: HIVRA_GVISOR_ADAPTER_VERSION, sha256: sha },
      runtime: { path: "/usr/local/bin/runsc", sha256: report.runscSha256 },
      runtimeCompatibility: { contractVersion: 1, supportedWorkloadKinds: ["linux-terminal"] },
      resourcePolicy: { reservationEqualsMaximum: true, aggregateAdmission: "serialized-host-headroom-v1" },
      access: { terminal: "owner-gated-command-v1", publicPorts: false }, desktop: false, windows: false },
    supportedIsolationDrivers: ["gvisor-runsc"], isolationClass: "application-kernel",
  };
  const { data, error } = await db().rpc("commit_hivra_gvisor_target_preflight", {
    p_user_id: userId,
    p_connection_id: connectionId,
    p_expected_revision: connection.revision,
    p_checked_at: now,
    p_run_id: runId,
    p_target: target,
  }).single();
  if (error || !data) throw new GvisorTargetError("database_failed", "The gVisor target evidence could not be saved.");
  return data;
  } catch (error) {
    await completeInfrastructureConnectionPreflight(userId, connectionId, connection.revision, runId, {
      connectionStatus: "error", checkedAt: new Date().toISOString(), lastErrorCode: "PROVISIONER_UNAVAILABLE", target: null,
    }).catch(() => false);
    throw error;
  }
}
