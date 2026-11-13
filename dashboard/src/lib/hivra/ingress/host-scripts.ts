// Host scripts for the wake proxy install step (WP5). Pure builders: they take
// what the caller already proved (target id, channel, the reviewed digests of
// the five wake-proxy bundle files) and return bash for runProxmoxHostScript.
// Nothing here talks to the network or the database.
//
// The install step is separate from bundle sync so the sync keeps proving that
// nothing else on the host changed. It copies the wake proxy out of the
// channel's checked bundle directory (the units run as a non-root user with
// ProtectHome, so they cannot read /root), installs a pinned, digest-checked
// cloudflared as /usr/local/bin/hivra-cloudflared, writes each file only when
// it differs, starts the helper and the forwarder, and health-checks them.
// Any failure after the first change restores every previous file and unit
// state and prints HIVRA_WAKE_PROXY_RESULT status=rolled_back.
//
// Fail toward awake: nothing here touches a VM, a guest or a route file.
// Removal refuses while any route file, connector env file or running host
// connector exists, because a computer would then lose its only way in.
//
// Nothing host-specific lives here: the host is identified by `hostname -s`
// at run time and every path below is the same on every host.

import {
  HIVRA_HOST_CLOUDFLARED_RELEASE,
} from "@/lib/infrastructure/portable-provisioner-contract";
import {
  managedHivraProvisionerChannelConfiguration,
  type ManagedHivraProvisionerChannel,
} from "@/lib/hivra/managed-provisioner-channel";
import { shellQuote } from "@/lib/hivra/proxmox-target";

export const WAKE_PROXY_RESULT_MARKER = "HIVRA_WAKE_PROXY_RESULT";
export const WAKE_PROXY_STATUS_MARKER = "HIVRA_WAKE_PROXY_STATUS";

/** Where the install step puts each wake-proxy bundle file, and its mode. */
export const HOST_WAKE_PROXY_PLACEMENTS = [
  { bundlePath: "hivra-wake-proxy.py", dest: "/usr/local/lib/hivra-ingress/hivra-wake-proxy.py", mode: "0644" },
  { bundlePath: "hivra-wake-helper.service", dest: "/etc/systemd/system/hivra-wake-helper.service", mode: "0644" },
  { bundlePath: "hivra-wake-proxy.service", dest: "/etc/systemd/system/hivra-wake-proxy.service", mode: "0644" },
  { bundlePath: "hivra-cf-template.service", dest: "/etc/systemd/system/hivra-cf@.service", mode: "0644" },
  { bundlePath: "hivra-ingress.tmpfiles.conf", dest: "/etc/tmpfiles.d/hivra-ingress.conf", mode: "0644" },
] as const;

export type HostWakeProxyBundlePath = (typeof HOST_WAKE_PROXY_PLACEMENTS)[number]["bundlePath"];
export const HOST_WAKE_PROXY_BUNDLE_FILES: readonly HostWakeProxyBundlePath[] =
  HOST_WAKE_PROXY_PLACEMENTS.map((entry) => entry.bundlePath);

export const HOST_CLOUDFLARED_PATH = "/usr/local/bin/hivra-cloudflared";
export const HOST_WAKE_PROXY_LIB_DIR = "/usr/local/lib/hivra-ingress";
export const HOST_WAKE_PROXY_UNITS = ["hivra-wake-helper.service", "hivra-wake-proxy.service"] as const;

/** The pinned cloudflared the host connector runs. */
export type HostCloudflaredRelease = {
  version: string;
  url: string;
  sha256: string;
};

export type HostWakeProxyInstallInput = {
  targetId: string;
  channel: ManagedHivraProvisionerChannel;
  /** The provisioner VERSION the channel's bundle directory must hold. */
  bundleVersion: string;
  /** sha256 (hex) of each wake-proxy file, from this deployment's reviewed bundle. */
  fileDigests: Readonly<Record<HostWakeProxyBundlePath, string>>;
  cloudflared?: HostCloudflaredRelease;
  /** Canary drill only: fail the health check on purpose to prove the rollback. */
  forceHealthFailure?: boolean;
  /** How long the services get to become healthy. Default 30 s. */
  healthDeadlineSeconds?: number;
};

const SHA256_RE = /^[0-9a-f]{64}$/;
const TARGET_RE = /^[a-z][a-z0-9_]{0,62}$/;
const VERSION_RE = /^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]{1,3}$/;
const CLOUDFLARED_VERSION_RE = /^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,3}$/;
const CLOUDFLARED_URL_RE = /^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\/[0-9.]+\/cloudflared-linux-amd64$/;

function assertTarget(targetId: string): void {
  if (!TARGET_RE.test(targetId)) throw new Error("Wake proxy scripts require an explicit Proxmox host id.");
}

/** Throws unless the pin is a real version, the official asset URL and a 64-hex digest. */
export function assertHostCloudflaredRelease(release: HostCloudflaredRelease): void {
  if (!CLOUDFLARED_VERSION_RE.test(release.version)) throw new Error("cloudflared pin has no valid version.");
  if (!CLOUDFLARED_URL_RE.test(release.url) || !release.url.includes(`/download/${release.version}/`)) {
    throw new Error("cloudflared pin does not name the official linux-amd64 release asset.");
  }
  if (!SHA256_RE.test(release.sha256)) throw new Error("cloudflared pin has no verified sha256; install is blocked.");
}

function channelDirectory(channel: ManagedHivraProvisionerChannel): string {
  return managedHivraProvisionerChannelConfiguration(channel).runtime.provisionerDirectory;
}

/** Shared prelude: strict bash, identity check, uptime clock. */
function prelude(targetId: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
EXPECTED_HOSTNAME=${shellQuote(targetId)}
uptime_ms() { awk '{ printf "%d", $1 * 1000 }' /proc/uptime; }
STARTED_MS="$(uptime_ms)"
ACTUAL_HOSTNAME="$(hostname -s | tr '[:upper:]' '[:lower:]')"
[ "$ACTUAL_HOSTNAME" = "$EXPECTED_HOSTNAME" ] \\
  || { echo "wake proxy target identity mismatch" >&2; printf '${WAKE_PROXY_RESULT_MARKER} status=failed step=identity changed=0 ms=0\\n'; exit 1; }
LIB_DIR=${shellQuote(HOST_WAKE_PROXY_LIB_DIR)}
PY="$LIB_DIR/hivra-wake-proxy.py"
CF_BIN=${shellQuote(HOST_CLOUDFLARED_PATH)}
ROUTES_DIR=/etc/hivra/ingress/routes
front_door_code() {
  python3 -I -c 'import http.client,sys; c=http.client.HTTPConnection("127.0.0.1",8080,timeout=3); c.request("GET","/",headers={"Host":"hivra-health.invalid"}); print(c.getresponse().status)' 2>/dev/null || printf '0\\n'
}
route_count() {
  if [ -d "$ROUTES_DIR" ]; then find "$ROUTES_DIR" -maxdepth 1 -type f -name '*.json' | wc -l; else printf '0\\n'; fi
}
connector_env_count() {
  if [ -d /etc/hivra/ingress ]; then find /etc/hivra/ingress -maxdepth 1 -type f -name '*.env' | wc -l; else printf '0\\n'; fi
}
active_connector_count() {
  systemctl list-units --type=service --state=active --no-legend --plain 'hivra-cf@*' 2>/dev/null | grep -c . || true
}
`;
}

/**
 * Install (or converge) the wake proxy on one host. Idempotent: a second run
 * with nothing changed restarts nothing and reports status=unchanged.
 */
export function buildHostWakeProxyInstallScript(input: HostWakeProxyInstallInput): string {
  assertTarget(input.targetId);
  if (!VERSION_RE.test(input.bundleVersion)) throw new Error("Wake proxy install needs an exact bundle version.");
  const cloudflared = input.cloudflared ?? HIVRA_HOST_CLOUDFLARED_RELEASE;
  assertHostCloudflaredRelease(cloudflared);
  for (const name of HOST_WAKE_PROXY_BUNDLE_FILES) {
    if (!SHA256_RE.test(input.fileDigests[name] ?? "")) {
      throw new Error(`Wake proxy install has no reviewed digest for ${name}.`);
    }
  }
  const healthDeadlineSeconds = input.healthDeadlineSeconds ?? 30;
  if (!Number.isInteger(healthDeadlineSeconds) || healthDeadlineSeconds < 1 || healthDeadlineSeconds > 120) {
    throw new Error("Wake proxy health deadline must be 1 to 120 seconds.");
  }
  const healthDeadlineMs = healthDeadlineSeconds * 1000;
  const bundleChecks = HOST_WAKE_PROXY_PLACEMENTS.map(
    (entry) =>
      `grep -qxF ${shellQuote(`${input.fileDigests[entry.bundlePath]}  ${entry.bundlePath}`)} "$BUNDLE/BUNDLE.sha256" \\
  || { echo ${shellQuote(`bundle manifest does not list the reviewed ${entry.bundlePath}`)} >&2; exit 1; }
[ "$(sha256sum < "$BUNDLE/${entry.bundlePath}" | cut -d' ' -f1)" = ${shellQuote(input.fileDigests[entry.bundlePath])} ] \\
  || { echo ${shellQuote(`bundle file ${entry.bundlePath} does not match its reviewed digest`)} >&2; exit 1; }`,
  ).join("\n");
  const placements = HOST_WAKE_PROXY_PLACEMENTS.map(
    (entry, index) =>
      `place_file "$BUNDLE/${entry.bundlePath}" ${shellQuote(entry.dest)} ${entry.mode} ${index}`,
  ).join("\n");

  return `${prelude(input.targetId)}umask 022
MARK=${shellQuote(WAKE_PROXY_RESULT_MARKER)}
BUNDLE=${shellQuote(channelDirectory(input.channel))}
CHANNEL=${shellQuote(input.channel)}
EXPECTED_VERSION=${shellQuote(input.bundleVersion)}
CF_VERSION=${shellQuote(cloudflared.version)}
CF_URL=${shellQuote(cloudflared.url)}
CF_SHA256=${shellQuote(cloudflared.sha256)}
FORCE_HEALTH_FAILURE=${input.forceHealthFailure ? "1" : "0"}
STEP=preflight
CHANGED=0
TOUCHED=0
COMMITTED=0
CREATED_USER=0
CREATED_LIB_DIR=0
STAGE=""
HELPER_WAS_ACTIVE=0
PROXY_WAS_ACTIVE=0
HELPER_WAS_ENABLED=0
PROXY_WAS_ENABLED=0
emit() {
  printf '%s status=%s step=%s changed=%s cloudflared=%s ms=%s\\n' "$MARK" "$1" "$STEP" "$CHANGED" "$CF_VERSION" "$(( $(uptime_ms) - STARTED_MS ))"
}
digest_of() { sha256sum < "$1" | cut -d' ' -f1; }
# Write DEST from SRC only when it differs; keep the previous file for rollback.
place_file() {
  src="$1"; dest="$2"; mode="$3"; idx="$4"
  if [ -f "$dest" ] && [ ! -L "$dest" ] && cmp -s -- "$src" "$dest"; then return 0; fi
  TOUCHED=1
  if [ -e "$dest" ] || [ -L "$dest" ]; then cp -a -- "$dest" "$STAGE/prev.$idx"; fi
  printf '%s\\n' "$dest" > "$STAGE/dest.$idx"
  install -m "$mode" -o root -g root -- "$src" "$dest.hivra-new"
  mv -f -- "$dest.hivra-new" "$dest"
  CHANGED=1
}
restore_files() {
  for marker in "$STAGE"/dest.*; do
    [ -f "$marker" ] || continue
    idx="\${marker##*.}"
    dest="$(cat "$marker")"
    rm -f -- "$dest.hivra-new"
    if [ -e "$STAGE/prev.$idx" ] || [ -L "$STAGE/prev.$idx" ]; then
      mv -f -- "$STAGE/prev.$idx" "$dest"
    else
      rm -f -- "$dest"
    fi
  done
}
# Before the files go back: stop and disable what was not running or enabled before.
unwind_unit() {
  unit="$1"; was_active="$2"; was_enabled="$3"
  [ "$was_active" = 1 ] || systemctl stop "$unit" 2>/dev/null
  [ "$was_enabled" = 1 ] || systemctl disable "$unit" 2>/dev/null
}
# After the files are back: run what ran before, on its previous files.
resume_unit() {
  unit="$1"; was_active="$2"; was_enabled="$3"
  [ "$was_enabled" = 0 ] || systemctl enable "$unit" 2>/dev/null
  if [ "$was_active" = 1 ]; then
    if [ "$CHANGED" = 1 ]; then systemctl restart "$unit"; else systemctl start "$unit"; fi
  fi
}
cleanup() {
  if [ -n "$STAGE" ] && [ -d "$STAGE" ]; then rm -rf -- "$STAGE"; fi
}
on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$COMMITTED" = 1 ]; then cleanup; exit "$status"; fi
  set +e
  [ "$status" != 0 ] || status=1
  if [ "$TOUCHED" = 1 ]; then
    unwind_unit hivra-wake-proxy.service "$PROXY_WAS_ACTIVE" "$PROXY_WAS_ENABLED"
    unwind_unit hivra-wake-helper.service "$HELPER_WAS_ACTIVE" "$HELPER_WAS_ENABLED"
    restore_files
    systemctl daemon-reload
    resume_unit hivra-wake-helper.service "$HELPER_WAS_ACTIVE" "$HELPER_WAS_ENABLED"
    resume_unit hivra-wake-proxy.service "$PROXY_WAS_ACTIVE" "$PROXY_WAS_ENABLED"
    if [ "$CREATED_LIB_DIR" = 1 ]; then rmdir -- "$LIB_DIR" 2>/dev/null; fi
    if [ "$CREATED_USER" = 1 ]; then
      # A first install: no computer can have a nap marker or route here yet.
      rm -rf -- /run/hivra-ingress /run/hivra-ingress-fwd /run/hivra-ingress-state
      rmdir -- /etc/hivra/ingress/routes /etc/hivra/ingress 2>/dev/null
      userdel hivra-ingress 2>/dev/null
    fi
    emit rolled_back
  else
    emit failed
  fi
  cleanup
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
for tool in python3 systemctl systemd-tmpfiles sha256sum flock curl install cmp mktemp getent useradd ss awk; do
  command -v "$tool" >/dev/null 2>&1 || { echo "wake proxy install needs $tool" >&2; exit 1; }
done
[ "$(uname -m)" = x86_64 ] || { echo "wake proxy install supports x86_64 hosts only" >&2; exit 1; }
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "timed out waiting for the Hivra allocation lock" >&2; exit 1; }
STEP=bundle
[ -d "$BUNDLE" ] && [ -f "$BUNDLE/BUNDLE.sha256" ] || { echo "channel bundle directory is missing" >&2; exit 1; }
(cd "$BUNDLE" && sha256sum -c --status BUNDLE.sha256) || { echo "channel bundle does not match its BUNDLE.sha256" >&2; exit 1; }
[ "$(tr -d '[:space:]' < "$BUNDLE/VERSION")" = "$EXPECTED_VERSION" ] \\
  || { echo "channel bundle is not the expected provisioner version" >&2; exit 1; }
${bundleChecks}
python3 -I -c 'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(), sys.argv[1], "exec")' "$BUNDLE/hivra-wake-proxy.py"
STEP=preflight
systemctl is-active --quiet hivra-wake-helper.service && HELPER_WAS_ACTIVE=1
systemctl is-active --quiet hivra-wake-proxy.service && PROXY_WAS_ACTIVE=1
systemctl is-enabled --quiet hivra-wake-helper.service 2>/dev/null && HELPER_WAS_ENABLED=1
systemctl is-enabled --quiet hivra-wake-proxy.service 2>/dev/null && PROXY_WAS_ENABLED=1
if [ "$PROXY_WAS_ACTIVE" = 0 ] && ss -Hltn '( sport = :8080 )' | grep -q .; then
  echo "port 8080 is already in use on this host" >&2; exit 1
fi
STAGE="$(mktemp -d /root/.hivra-wake-proxy-install.XXXXXXXX)"
STEP=cloudflared
NEED_CF=1
if [ -f "$CF_BIN" ] && [ ! -L "$CF_BIN" ] && [ "$(digest_of "$CF_BIN")" = "$CF_SHA256" ]; then NEED_CF=0; fi
if [ "$NEED_CF" = 1 ]; then
  curl --proto '=https' --tlsv1.2 -fsSL --retry 2 --connect-timeout 10 --max-time 180 -o "$STAGE/cloudflared" "$CF_URL" \\
    || { echo "cloudflared download failed" >&2; exit 1; }
  [ "$(digest_of "$STAGE/cloudflared")" = "$CF_SHA256" ] \\
    || { echo "cloudflared download does not match the pinned sha256" >&2; exit 1; }
fi
STEP=user
if ! getent passwd hivra-ingress >/dev/null 2>&1; then
  TOUCHED=1
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin hivra-ingress
  CREATED_USER=1
fi
STEP=files
if [ ! -d "$LIB_DIR" ]; then TOUCHED=1; install -d -m 0755 -o root -g root "$LIB_DIR"; CREATED_LIB_DIR=1; fi
if [ "$NEED_CF" = 1 ]; then place_file "$STAGE/cloudflared" "$CF_BIN" 0755 cf; fi
${placements}
printf 'channel=%s version=%s cloudflared=%s\\n' "$CHANNEL" "$EXPECTED_VERSION" "$CF_VERSION" > "$STAGE/SOURCE"
place_file "$STAGE/SOURCE" "$LIB_DIR/SOURCE" 0644 source
STEP=start
# The drill's forced failure must exercise the rollback even when nothing changed.
[ "$FORCE_HEALTH_FAILURE" = 0 ] || TOUCHED=1
systemd-tmpfiles --create /etc/tmpfiles.d/hivra-ingress.conf
if [ "$CHANGED" = 1 ]; then systemctl daemon-reload; fi
if [ "$HELPER_WAS_ENABLED" = 0 ] || [ "$PROXY_WAS_ENABLED" = 0 ]; then
  TOUCHED=1
  systemctl enable hivra-wake-helper.service hivra-wake-proxy.service
fi
if [ "$CHANGED" = 1 ]; then
  systemctl restart hivra-wake-helper.service
  systemctl restart hivra-wake-proxy.service
elif [ "$HELPER_WAS_ACTIVE" = 0 ] || [ "$PROXY_WAS_ACTIVE" = 0 ]; then
  TOUCHED=1
  systemctl start hivra-wake-helper.service hivra-wake-proxy.service
fi
STEP=health
health_ok() {
  [ "$FORCE_HEALTH_FAILURE" = 0 ] || return 1
  systemctl is-active --quiet hivra-wake-helper.service || return 1
  systemctl is-active --quiet hivra-wake-proxy.service || return 1
  python3 -I -B "$PY" ctl health > "$STAGE/health.json" 2>/dev/null || return 1
  python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("ok") is True and d.get("forwarder") is True else 1)' "$STAGE/health.json" || return 1
  [ "$(front_door_code)" = 503 ] || return 1
}
HEALTH_DEADLINE_MS=$(( $(uptime_ms) + ${healthDeadlineMs} ))
until health_ok; do
  if [ "$FORCE_HEALTH_FAILURE" = 1 ] || [ "$(uptime_ms)" -ge "$HEALTH_DEADLINE_MS" ]; then echo "wake proxy health check failed" >&2; exit 1; fi
  sleep 0.5
done
COMMITTED=1
if [ "$CHANGED" = 1 ]; then emit installed; else emit unchanged; fi
`;
}

/** Read-only: what is installed, what runs, and whether the front door answers 503 for an unknown host. */
export function buildHostWakeProxyStatusScript(targetId: string, cloudflared: HostCloudflaredRelease = HIVRA_HOST_CLOUDFLARED_RELEASE): string {
  assertTarget(targetId);
  return `${prelude(targetId)}CF_SHA256=${shellQuote(SHA256_RE.test(cloudflared.sha256) ? cloudflared.sha256 : "unverified")}
INSTALLED=0; [ -f "$PY" ] && INSTALLED=1
SOURCE_VERSION=none
if [ -f "$LIB_DIR/SOURCE" ]; then
  SOURCE_VERSION="$(sed -n 's/.* version=\\([0-9.]*\\).*/\\1/p' "$LIB_DIR/SOURCE" | head -n 1)"
  [ -n "$SOURCE_VERSION" ] || SOURCE_VERSION=unknown
fi
CF_STATE=missing
if [ -f "$CF_BIN" ]; then
  if [ "$(sha256sum < "$CF_BIN" | cut -d' ' -f1)" = "$CF_SHA256" ]; then CF_STATE=ok; else CF_STATE=mismatch; fi
fi
HELPER="$(systemctl is-active hivra-wake-helper.service 2>/dev/null || true)"
PROXY="$(systemctl is-active hivra-wake-proxy.service 2>/dev/null || true)"
HEALTH=0
if [ "$INSTALLED" = 1 ] && python3 -I -B "$PY" ctl health 2>/dev/null | python3 -I -c 'import json,sys; d=json.loads(sys.stdin.read() or "{}"); sys.exit(0 if d.get("ok") is True and d.get("forwarder") is True else 1)'; then HEALTH=1; fi
FRONT_DOOR=0
if [ "$PROXY" = active ]; then FRONT_DOOR="$(front_door_code)"; fi
printf '${WAKE_PROXY_STATUS_MARKER} installed=%s version=%s helper=%s proxy=%s cloudflared=%s routes=%s connectors=%s health=%s front_door=%s\\n' \\
  "$INSTALLED" "$SOURCE_VERSION" "\${HELPER:-unknown}" "\${PROXY:-unknown}" "$CF_STATE" "$(route_count)" "$(active_connector_count)" "$HEALTH" "$FRONT_DOOR"
`;
}

/**
 * Remove the wake proxy from a host. Refuses while any computer depends on it
 * (a route file, a connector env file or a running hivra-cf@ instance): those
 * must be rolled back to guest ingress first.
 */
export function buildHostWakeProxyRemoveScript(targetId: string): string {
  assertTarget(targetId);
  const files = [
    ...HOST_WAKE_PROXY_PLACEMENTS.map((entry) => entry.dest),
    `${HOST_WAKE_PROXY_LIB_DIR}/SOURCE`,
    HOST_CLOUDFLARED_PATH,
  ];
  return `${prelude(targetId)}MARK=${shellQuote(WAKE_PROXY_RESULT_MARKER)}
STEP=preflight
CHANGED=0
emit() {
  printf '%s status=%s step=%s changed=%s ms=%s\\n' "$MARK" "$1" "$STEP" "$CHANGED" "$(( $(uptime_ms) - STARTED_MS ))"
}
trap 'status=$?; trap - EXIT; if [ "$status" != 0 ]; then emit failed; fi; exit "$status"' EXIT
install -d -m 0755 /run/lock
exec 8>/run/lock/hivra-allocation.lock
flock -w 60 8 || { echo "timed out waiting for the Hivra allocation lock" >&2; exit 1; }
STEP=dependents
ROUTES="$(route_count)"; ENVS="$(connector_env_count)"; CONNECTORS="$(active_connector_count)"
if [ "$ROUTES" != 0 ] || [ "$ENVS" != 0 ] || [ "$CONNECTORS" != 0 ]; then
  echo "computers still use host ingress here (routes=$ROUTES env=$ENVS connectors=$CONNECTORS); roll them back first" >&2
  trap - EXIT
  emit refused
  exit 1
fi
STEP=stop
for unit in hivra-wake-proxy.service hivra-wake-helper.service; do
  if systemctl is-active --quiet "$unit" || systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    CHANGED=1
    systemctl disable --now "$unit" 2>/dev/null || systemctl stop "$unit"
  fi
done
STEP=files
for path in ${files.map(shellQuote).join(" ")}; do
  if [ -e "$path" ] || [ -L "$path" ]; then CHANGED=1; rm -f -- "$path"; fi
done
if [ -d "$LIB_DIR" ]; then CHANGED=1; rmdir -- "$LIB_DIR"; fi
systemctl daemon-reload
for dir in /run/hivra-ingress /run/hivra-ingress-fwd /run/hivra-ingress-state; do
  if [ -d "$dir" ]; then CHANGED=1; rm -rf -- "$dir"; fi
done
rmdir -- /etc/hivra/ingress/routes /etc/hivra/ingress 2>/dev/null || true
if getent passwd hivra-ingress >/dev/null 2>&1; then CHANGED=1; userdel hivra-ingress; fi
trap - EXIT
if [ "$CHANGED" = 1 ]; then emit removed; else emit absent; fi
`;
}

export type HostWakeProxyResult = {
  status: "installed" | "unchanged" | "rolled_back" | "failed" | "removed" | "absent" | "refused";
  step: string;
  changed: boolean;
  ms: number;
};

const RESULT_STATUSES = new Set<HostWakeProxyResult["status"]>([
  "installed", "unchanged", "rolled_back", "failed", "removed", "absent", "refused",
]);

/** The last HIVRA_WAKE_PROXY_RESULT line in the output, or null. */
export function parseHostWakeProxyResult(stdout: string): HostWakeProxyResult | null {
  const lines = stdout.split("\n").filter((line) => line.startsWith(`${WAKE_PROXY_RESULT_MARKER} `));
  const line = lines[lines.length - 1];
  if (!line) return null;
  const match = line.match(/ status=([a-z_]+) step=([a-z_]+) changed=([01])(?: cloudflared=\S+)? ms=(-?[0-9]+)$/);
  if (!match || !RESULT_STATUSES.has(match[1] as HostWakeProxyResult["status"])) return null;
  return {
    status: match[1] as HostWakeProxyResult["status"],
    step: match[2],
    changed: match[3] === "1",
    ms: Number(match[4]),
  };
}

export type HostWakeProxyStatus = {
  installed: boolean;
  version: string | null;
  helper: string;
  proxy: string;
  cloudflared: "ok" | "mismatch" | "missing";
  routes: number;
  connectors: number;
  healthy: boolean;
  frontDoor: number;
};

export function parseHostWakeProxyStatus(stdout: string): HostWakeProxyStatus | null {
  const line = stdout.split("\n").find((entry) => entry.startsWith(`${WAKE_PROXY_STATUS_MARKER} `));
  if (!line) return null;
  const match = line.match(
    / installed=([01]) version=(\S+) helper=([a-z-]+) proxy=([a-z-]+) cloudflared=(ok|mismatch|missing) routes=([0-9]+) connectors=([0-9]+) health=([01]) front_door=([0-9]+)$/,
  );
  if (!match) return null;
  return {
    installed: match[1] === "1",
    version: match[2] === "none" || match[2] === "unknown" ? null : match[2],
    helper: match[3],
    proxy: match[4],
    cloudflared: match[5] as HostWakeProxyStatus["cloudflared"],
    routes: Number(match[6]),
    connectors: Number(match[7]),
    healthy: match[8] === "1",
    frontDoor: Number(match[9]),
  };
}
