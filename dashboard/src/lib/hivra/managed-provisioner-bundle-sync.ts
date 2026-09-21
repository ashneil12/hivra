import "server-only";

import { createHash } from "node:crypto";

import {
  loadPortableProvisionerBundle,
  type PortableProvisionerBundleAsset,
} from "@/lib/infrastructure/connection-preparation";
import {
  PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES,
  PORTABLE_HIVRA_PROVISIONER_VERSION,
} from "@/lib/infrastructure/portable-provisioner-contract";
import {
  checkManagedHivraHostReadiness,
  managedHivraHostReadinessScript,
} from "@/lib/hivra/managed-provisioner-readiness";
import {
  managedHivraProvisionerChannelConfiguration,
  type ManagedHivraProvisionerChannel,
} from "@/lib/hivra/managed-provisioner-channel";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import {
  resolveProxmoxTargetCandidateIds,
  resolveProxmoxTargetConfiguration,
  runProxmoxHostScript,
  type HostScriptResult,
} from "@/lib/services/proxmox-instance-service";

const SYNC_MARKER = "HIVRA_MANAGED_BUNDLE_SYNC";
const MAX_SYNC_OUTPUT_BYTES = 64 * 1024;
const SYNC_TIMEOUT_MS = 120_000;
const RESERVED_MANAGED_TARGET_IDS = new Set(["all", "default", "global"]);

const EXECUTABLE_ASSETS = new Set([
  "hivra-agent-shell",
  "hivra-guest-ssh-known-hosts",
  "hivra-browser-apply",
  "hivra-network-preflight",
  "hivra-runtime-receipt.py",
  "hivra-provision-on-host.sh",
  "hivra-start-on-host.sh",
  "hivra-tg-apply",
  "hivra-update-guest-runtime.sh",
  "local-browser-keeper.py",
  "prepare-proxmox-host.sh",
  "provision-claude-code-box.sh",
  "remote-desktop/install-guest.py",
]);

export type ManagedProvisionerBundleSyncResult = {
  ok: boolean;
  targetId: string;
  channel: ManagedHivraProvisionerChannel;
  requestedVersion: typeof PORTABLE_HIVRA_PROVISIONER_VERSION;
  changed: boolean;
  observedVersion: string | null;
  preservation?: {
    hostname: string;
    vmStateBefore: string;
    vmStateAfter: string;
    caddyBefore: string;
    caddyAfter: string;
    storageBefore: string;
    storageAfter: string;
  };
  error?: string;
};

export function isSafeManagedProvisionerTargetId(value: string): boolean {
  return (
    /^[a-z][a-z0-9_]{0,62}$/.test(value) &&
    !RESERVED_MANAGED_TARGET_IDS.has(value)
  );
}

type SyncDependencies = {
  loadBundle: typeof loadPortableProvisionerBundle;
  runHostScript: typeof runProxmoxHostScript;
  checkReadiness: typeof checkManagedHivraHostReadiness;
};

const DEFAULT_DEPENDENCIES: SyncDependencies = {
  loadBundle: loadPortableProvisionerBundle,
  runHostScript: runProxmoxHostScript,
  checkReadiness: checkManagedHivraHostReadiness,
};

function wrapBase64(value: Buffer): string {
  return value.toString("base64").match(/.{1,76}/g)?.join("\n") ?? "";
}

function assertExactBundle(assets: PortableProvisionerBundleAsset[]): void {
  const expected = new Set<string>(PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES);
  if (
    assets.length !== expected.size ||
    assets.some((asset) => !expected.delete(asset.relativePath)) ||
    expected.size !== 0
  ) {
    throw new Error("Managed provisioner bundle does not match its allowlist.");
  }
}

function bundleManifest(assets: PortableProvisionerBundleAsset[]): string {
  return assets
    .map((asset) => `${createHash("sha256").update(asset.content).digest("hex")}  ${asset.relativePath}`)
    .join("\n");
}

export function buildManagedProvisionerBundleSyncScript(
  channel: ManagedHivraProvisionerChannel,
  assets: PortableProvisionerBundleAsset[],
  targetId: string,
): string {
  assertExactBundle(assets);
  if (!isSafeManagedProvisionerTargetId(targetId)) {
    throw new Error("Managed provisioner bundle sync requires an explicit Proxmox host id.");
  }
  const directories = Array.from(
    new Set(
      assets
        .map((asset) => asset.relativePath.split("/").slice(0, -1).join("/"))
        .filter(Boolean),
    ),
  ).sort();
  const directorySetup = directories
    .map((directory) => `install -d -m 0700 "$UPLOAD_DIR/${directory}"`)
    .join("\n");
  const writes = assets
    .map((asset, index) => {
      const delimiter = `HIVRA_MANAGED_ASSET_${index}`;
      return `base64 -d > "$UPLOAD_DIR/${asset.relativePath}" <<'${delimiter}'\n${wrapBase64(asset.content)}\n${delimiter}`;
    })
    .join("\n");
  const executableSetup = assets
    .filter((asset) => EXECUTABLE_ASSETS.has(asset.relativePath))
    .map((asset) => `chmod 0700 "$UPLOAD_DIR/${asset.relativePath}"`)
    .join("\n");
  const manifest = bundleManifest(assets);
  const channelConfiguration = managedHivraProvisionerChannelConfiguration(channel);
  const target = channelConfiguration.runtime.provisionerDirectory;
  const readiness = managedHivraHostReadinessScript(channel, "runtime-update");

  return `#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
umask 077
TARGET=${shellQuote(target)}
EXPECTED_VERSION=${shellQuote(PORTABLE_HIVRA_PROVISIONER_VERSION)}
EXPECTED_HOSTNAME=${shellQuote(targetId)}
ROLLBACK_ROOT=${shellQuote(channelConfiguration.rollbackRoot)}
command -v base64 >/dev/null 2>&1
command -v sha256sum >/dev/null 2>&1
command -v mktemp >/dev/null 2>&1
command -v flock >/dev/null 2>&1
command -v qm >/dev/null 2>&1
command -v pvesm >/dev/null 2>&1
ACTUAL_HOSTNAME="$(hostname -s | tr '[:upper:]' '[:lower:]')"
[ "$ACTUAL_HOSTNAME" = "$EXPECTED_HOSTNAME" ] \
  || { echo "managed bundle target identity mismatch" >&2; exit 1; }
host_vm_state() {
  qm list | awk 'NR > 1 { total += 1; if ($3 == "running") running += 1; else if ($3 == "stopped") stopped += 1 } END { printf "%d/%d/%d", running, stopped, total }'
}
host_caddy_state() {
  systemctl is-active caddy 2>/dev/null || printf 'unknown'
}
host_storage_state() {
  pvesm status | awk '$1 == "local-lvm" { printf "%s/%s/%s", $4, $5, $6; found = 1 } END { if (!found) printf "missing" }'
}
UPLOAD_DIR="$(mktemp -d ${shellQuote(channelConfiguration.uploadTemplate)})"
BACKUP_DIR=""
BACKUP_PARENT=""
SWAPPED=0
TARGET_EXISTED=0
UPLOAD_IDENTITY=""
ORIGINAL_IDENTITY=""
directory_identity() {
  python3 -c 'import os,stat,sys; s=os.lstat(sys.argv[1]); assert stat.S_ISDIR(s.st_mode); print(str(s.st_dev)+":"+str(s.st_ino))' "$1"
}
move_exclusive() {
  # GNU mv may report success when -n skips an occupied destination. Check
  # both identities; -T forbids nesting a source inside a replacement target.
  source_identity="$(directory_identity "$1")" || return 1
  mv -T -n -- "$1" "$2" || return 1
  [ ! -e "$1" ] && [ ! -L "$1" ] && [ "$(directory_identity "$2")" = "$source_identity" ]
}
cleanup() {
  if [ -n "$UPLOAD_DIR" ] && [ -d "$UPLOAD_DIR" ]; then rm -rf -- "$UPLOAD_DIR"; fi
  if [ -n "$BACKUP_PARENT" ] && [ -d "$BACKUP_PARENT" ]; then rmdir -- "$BACKUP_PARENT" 2>/dev/null || true; fi
}
rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ "$SWAPPED" = '1' ]; then
    if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
      if [ "$(directory_identity "$TARGET" 2>/dev/null)" = "$UPLOAD_IDENTITY" ]; then
        rm -rf -- "$TARGET" || status=1
      elif [ -n "$BACKUP_DIR" ] && [ -e "$BACKUP_DIR" ] || [ "$TARGET_EXISTED" = '0' ]; then
        echo "managed bundle rollback found a foreign target; original backup retained" >&2
        cleanup
        exit 1
      fi
    fi
    if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
      # The backup's existence proves the first rename completed, including
      # when a signal arrived before the next shell assignment.
      if [ "$(directory_identity "$BACKUP_DIR")" = "$ORIGINAL_IDENTITY" ]; then
        move_exclusive "$BACKUP_DIR" "$TARGET" || status=1
      else
        echo "managed bundle backup identity changed; reconciliation required" >&2
        status=1
      fi
    fi
  fi
  cleanup
  exit "$status"
}
emit_preservation_receipt() {
  HOST_VM_STATE_AFTER="$(host_vm_state)"
  HOST_CADDY_AFTER="$(host_caddy_state)"
  HOST_STORAGE_AFTER="$(host_storage_state)"
  [ "$HOST_VM_STATE_AFTER" = "$HOST_VM_STATE_BEFORE" ] \
    || { echo "managed bundle sync changed the VM inventory" >&2; exit 1; }
  [ "$HOST_CADDY_AFTER" = "$HOST_CADDY_BEFORE" ] \
    || { echo "managed bundle sync changed the Caddy service state" >&2; exit 1; }
  printf 'HIVRA_MANAGED_HOST_PRESERVED target=%s vm_before=%s vm_after=%s caddy_before=%s caddy_after=%s storage_before=%s storage_after=%s\\n' \
    "$ACTUAL_HOSTNAME" "$HOST_VM_STATE_BEFORE" "$HOST_VM_STATE_AFTER" \
    "$HOST_CADDY_BEFORE" "$HOST_CADDY_AFTER" "$HOST_STORAGE_BEFORE" "$HOST_STORAGE_AFTER"
}
trap rollback EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
${directorySetup}
${writes}
cat > "$UPLOAD_DIR/BUNDLE.sha256" <<'HIVRA_MANAGED_BUNDLE_MANIFEST'
${manifest}
HIVRA_MANAGED_BUNDLE_MANIFEST
${executableSetup}
(
  cd "$UPLOAD_DIR"
  sha256sum -c --status BUNDLE.sha256
)
[ "$(tr -d '[:space:]' < "$UPLOAD_DIR/VERSION")" = "$EXPECTED_VERSION" ]
for candidate in "$UPLOAD_DIR"/*.sh; do bash -n "$candidate"; done
for candidate in "$UPLOAD_DIR"/*.py; do
  python3 -c 'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(), sys.argv[1], "exec")' "$candidate"
done
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "timed out waiting for the Hivra provisioner bundle lock" >&2; exit 1; }
HOST_VM_STATE_BEFORE="$(host_vm_state)"
HOST_CADDY_BEFORE="$(host_caddy_state)"
HOST_STORAGE_BEFORE="$(host_storage_state)"
if [ -d "$TARGET" ] && [ -f "$TARGET/BUNDLE.sha256" ] && \
   cmp -s "$UPLOAD_DIR/BUNDLE.sha256" "$TARGET/BUNDLE.sha256" && \
   (cd "$TARGET" && sha256sum -c --status BUNDLE.sha256); then
  rm -rf -- "$UPLOAD_DIR"
  UPLOAD_DIR=""
(
${readiness}
)
  emit_preservation_receipt
  printf '${SYNC_MARKER} status=noop version=%s\\n' "$EXPECTED_VERSION"
  exit 0
fi
install -d -m 0700 "$ROLLBACK_ROOT"
UPLOAD_IDENTITY="$(directory_identity "$UPLOAD_DIR")"
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  ORIGINAL_IDENTITY="$(directory_identity "$TARGET")"
  TARGET_EXISTED=1
fi
SWAPPED=1
if [ -d "$TARGET" ]; then
  BACKUP_PARENT="$(mktemp -d "$ROLLBACK_ROOT/${PORTABLE_HIVRA_PROVISIONER_VERSION}.XXXXXXXX")"
  # This child must not exist until the original directory has been renamed.
  # An empty mktemp directory itself cannot prove that the first move happened.
  BACKUP_DIR="$BACKUP_PARENT/original"
  move_exclusive "$TARGET" "$BACKUP_DIR"
fi
move_exclusive "$UPLOAD_DIR" "$TARGET"
(
${readiness}
)
emit_preservation_receipt
SWAPPED=0
UPLOAD_DIR=""
printf '${SYNC_MARKER} status=updated version=%s backup=%s\\n' "$EXPECTED_VERSION" "${'${BACKUP_DIR:-none}'}"
`;
}

function parseObservedVersion(stdout: string): string | null {
  const match = stdout.match(/(?:^|\n)VERSION=([^\n]*)/);
  const value = match?.[1]?.trim() ?? "";
  return value && value !== "missing" ? value : null;
}

function parsePreservationReceipt(
  stdout: string,
): ManagedProvisionerBundleSyncResult["preservation"] | null {
  const match = stdout.match(
    /(?:^|\n)HIVRA_MANAGED_HOST_PRESERVED target=(\S+) vm_before=(\S+) vm_after=(\S+) caddy_before=(\S+) caddy_after=(\S+) storage_before=(\S+) storage_after=(\S+)(?:\n|$)/,
  );
  if (!match) return null;
  return {
    hostname: match[1],
    vmStateBefore: match[2],
    vmStateAfter: match[3],
    caddyBefore: match[4],
    caddyAfter: match[5],
    storageBefore: match[6],
    storageAfter: match[7],
  };
}

function targetIsConfigured(targetId: string, env: NodeJS.ProcessEnv): boolean {
  return resolveProxmoxTargetCandidateIds(env).includes(targetId);
}

export async function inspectManagedProvisionerBundle(
  channel: ManagedHivraProvisionerChannel,
  targetId: string,
  dependencies: Partial<SyncDependencies> = {},
): Promise<ManagedProvisionerBundleSyncResult> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  if (!targetIsConfigured(targetId, process.env)) {
    return {
      ok: false,
      targetId,
      channel,
      requestedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
      changed: false,
      observedVersion: null,
      error: "Target is not in the configured managed host rotation.",
    };
  }
  const runtimePaths = managedHivraProvisionerChannelConfiguration(channel).runtime;
  const candidate = resolveProxmoxTargetConfiguration(process.env, targetId);
  const probe = await deps.runHostScript(
    `set -euo pipefail
printf 'VERSION='
if [ -f ${shellQuote(`${runtimePaths.provisionerDirectory}/VERSION`)} ]; then
  tr -d '[:space:]' < ${shellQuote(`${runtimePaths.provisionerDirectory}/VERSION`)}
  printf '\n'
else
  printf 'missing\n'
fi
`,
    candidate.env,
    { timeoutMs: 20_000, maxOutputBytes: 4096 },
  );
  if (!probe.ok) {
    return {
      ok: false,
      targetId,
      channel,
      requestedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
      changed: false,
      observedVersion: parseObservedVersion(probe.stdout),
      error: probe.error ?? (probe.stderr.slice(0, 300) || "Host probe failed."),
    };
  }
  const readiness = await deps.checkReadiness(
    { targetId, env: candidate.env, channel, purpose: "runtime-update" },
    deps.runHostScript,
  );
  return {
    ok: readiness.ok,
    targetId,
    channel,
    requestedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
    changed: false,
    observedVersion: parseObservedVersion(probe.stdout),
    ...(!readiness.ok ? { error: readiness.message } : {}),
  };
}

export async function syncManagedProvisionerBundle(
  channel: ManagedHivraProvisionerChannel,
  targetId: string,
  dependencies: Partial<SyncDependencies> = {},
): Promise<ManagedProvisionerBundleSyncResult> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  if (!targetIsConfigured(targetId, process.env)) {
    return {
      ok: false,
      targetId,
      channel,
      requestedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
      changed: false,
      observedVersion: null,
      error: "Target is not in the configured managed host rotation.",
    };
  }
  const assets = await deps.loadBundle();
  const candidate = resolveProxmoxTargetConfiguration(process.env, targetId);
  const result: HostScriptResult = await deps.runHostScript(
    buildManagedProvisionerBundleSyncScript(channel, assets, targetId),
    candidate.env,
    { timeoutMs: SYNC_TIMEOUT_MS, maxOutputBytes: MAX_SYNC_OUTPUT_BYTES },
  );
  const changed = result.stdout.includes(`${SYNC_MARKER} status=updated`);
  const noop = result.stdout.includes(`${SYNC_MARKER} status=noop`);
  const preservation = parsePreservationReceipt(result.stdout);
  if (!result.ok || (!changed && !noop) || !preservation) {
    return {
      ok: false,
      targetId,
      channel,
      requestedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
      changed: false,
      observedVersion: null,
      error: result.error ?? (result.stderr.slice(0, 300) || "Bundle sync or preservation receipt was missing."),
    };
  }
  return {
    ok: true,
    targetId,
    channel,
    requestedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
    changed,
    observedVersion: PORTABLE_HIVRA_PROVISIONER_VERSION,
    preservation,
  };
}
