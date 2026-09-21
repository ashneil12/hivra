import { randomBytes } from "crypto";
import { gzipSync } from "zlib";
import { buildCodexHermesAuthStore, type CodexVaultBundle } from "@/lib/codex-oauth";
import { buildNousHermesAuthStore, type NousVaultBundle } from "@/lib/nous-oauth";
import { isCodexAuthProvider } from "@/lib/provider-auth";
import { resolveHermesHomeDir, resolveTerminalCwd, resolveTerminalExecUser } from "@/lib/hermes-home";
import { normalizeModelValue } from "@/lib/models";
import type { InstanceBankrAgentConfig } from "@/lib/billing/bankr-instance-wallets";
import {
  DEFAULT_AUTO_UPDATE_ENABLED,
  DEFAULT_AUTO_UPDATE_TIME,
  type A2ASettings,
  type AutoUpdateConfig,
  type MemorySystemConfig,
} from "@/lib/instance-settings";
import { PROVIDER_ID_MAP, resolveProviderBaseUrl, resolveProviderFallbackModel } from "@/lib/services/provider-config";
import { HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE } from "@/lib/services/sidecar-script";
import { buildInstanceUpdateReporterShell } from "@/lib/services/update-status-reporting";
import { log } from "@/lib/logger";
import {
  buildEnsureBusyboxAvailableScript,
  buildWebUIContainerCliShimCommand,
  buildWebUIDeveloperToolBootstrapCommand,
  buildWebUIHermesPythonRuntimeCommand,
  buildWebUIPersistentStatePermissionRepairCommand,
  buildWebUIPersistentStateShimCommand,
  buildWebUIToolchainDiagnosticCommand,
  WEBUI_PERSISTENT_INSTALL_ENV_KEYS,
  WEBUI_PERSISTENT_INSTALL_ENV_LINES,
} from "@/lib/services/webui-runtime-env";

const LOG_SOURCE = "hetzner-instance-builders";

function buildWebUIAutoUpdateToolchainEnvRepairScript(containerName: string): string {
  const managedEnvKeys = WEBUI_PERSISTENT_INSTALL_ENV_KEYS.join(" ");
  const managedEnvLines = WEBUI_PERSISTENT_INSTALL_ENV_LINES.join("\n");

  return `# Repair dashboard-managed toolchain env keys in persisted WebUI state.
docker run --rm -i \\
  -v ${containerName}_webui-state:/state \\
  -v "$(pwd)":/seed \\
  busybox sh <<'SH'
set -e
mkdir -p /state
cat > /tmp/hermes-managed-env <<'HERMES_MANAGED_ENV'
${managedEnvLines}
HERMES_MANAGED_ENV
# Build the updated env in a temp file on the SAME volume, then publish with an
# atomic rename. The agent gateway reloads /state/.env every turn; editing it in
# place (sed -i / truncate) exposes a sub-second window where OPENAI_API_KEY is
# absent -> the agent sends "Bearer no-key-required" and the managed proxy 401s.
managed_env_tmp="/state/.env.managed.$$"
if [ -f /state/.env ]; then
  cp /state/.env "$managed_env_tmp"
elif [ -f /seed/hermes.env ]; then
  cp /seed/hermes.env "$managed_env_tmp"
else
  : > "$managed_env_tmp"
fi
managed_env_keys='${managedEnvKeys}'
echo "[webui-update] Repair dashboard-managed toolchain env keys in persisted WebUI state"
for managed_env_key in $managed_env_keys; do
  managed_env_line="$(grep -m1 "^\${managed_env_key}=" /tmp/hermes-managed-env || true)"
  [ -n "$managed_env_line" ] || continue
  if grep -q "^\${managed_env_key}=" "$managed_env_tmp"; then
    sed -i "s|^\${managed_env_key}=.*|\${managed_env_line}|" "$managed_env_tmp"
  else
    printf "\\n%s\\n" "$managed_env_line" >> "$managed_env_tmp"
  fi
done
chmod 600 "$managed_env_tmp"
# Publish atomically, and only when something actually changed, so routine
# live-updates don't needlessly rewrite the file the gateway reloads.
if [ ! -f /state/.env ] || ! cmp -s "$managed_env_tmp" /state/.env; then
  mv -f "$managed_env_tmp" /state/.env
else
  rm -f "$managed_env_tmp"
fi
cp /state/.env /seed/.env
cp /state/.env /seed/hermes.env
chmod 600 /state/.env /seed/.env /seed/hermes.env
rm -f /tmp/hermes-managed-env /state/models_dev_cache.json /state/webui/models_cache.json
# Guard against the SQLite WAL race: on idle instances *.db-wal/-shm can be
# checkpointed away mid-recurse, making chown -R error "No such file" and (under
# set -e) abort the whole live-update before the image pull. Never let cosmetic
# ownership repair block the update.
chown -R 1024:1024 /state 2>/dev/null || true
SH`;
}

function buildHermesAutoUpdateDiskCleanupFunctions(): string {
  return `prune_dangling_docker_images() {
  docker image ls -a --filter dangling=true -q 2>/dev/null | sort -u | while IFS= read -r image_id; do
    [ -n "$image_id" ] || continue
    docker image rm "$image_id" 2>/dev/null || true
  done
}

# Selective tagged-image cleanup for the two hermes-managed repos. The
# \`:hermes-last-known-good\` tag is preserved here (and the unfiltered
# \`docker image prune\` below switches off \`-a\`) so the rollback path has
# something to restore on a failed update.
prune_old_unused_hermes_repo_images() {
  repo="$1"
  [ -n "$repo" ] || return 0
  cutoff_epoch="$(date -u -d '24 hours ago' +%s 2>/dev/null || echo 0)"
  [ "$cutoff_epoch" -gt 0 ] || return 0

  used_image_ids="$(docker ps -a --format '{{.Image}}' | while IFS= read -r container_image; do
    [ -n "$container_image" ] || continue
    docker image inspect "$container_image" --format '{{.Id}}' 2>/dev/null || true
  done | sort -u)"

  docker image ls "$repo" --format '{{.Repository}}:{{.Tag}}' | while IFS= read -r image_ref; do
    case "$image_ref" in
      *:"<none>"|"<none>":*|*:hermes-last-known-good) continue ;;
    esac
    image_id="$(docker image inspect "$image_ref" --format '{{.Id}}' 2>/dev/null || true)"
    [ -n "$image_id" ] || continue
    if printf '%s\\n' "$used_image_ids" | grep -qx "$image_id"; then
      continue
    fi
    created="$(docker image inspect "$image_ref" --format '{{.Created}}' 2>/dev/null || true)"
    created_epoch="$(date -u -d "$created" +%s 2>/dev/null || echo 0)"
    if [ "$created_epoch" -gt 0 ] && [ "$created_epoch" -lt "$cutoff_epoch" ]; then
      docker image rm "$image_ref" 2>/dev/null || true
    fi
  done
}

prune_old_unused_hermes_agent_images() {
  prune_old_unused_hermes_repo_images 'ghcr.io/ashneil12/vanilla-hermes-agent'
}

prune_old_unused_hermes_webui_images() {
  prune_old_unused_hermes_repo_images 'ghcr.io/ashneil12/hermes-webui'
}

hermes_volume_safe_update_cleanup() {
  cleanup_phase="\${1:-manual}"
  echo "[hermes-update-cleanup] phase=\${cleanup_phase} disk before: $(df -h / 2>/dev/null | tail -1 || true)"
  docker system df 2>/dev/null || true

  if [ -x /usr/local/bin/hermes-disk-cleanup ]; then
    if ! /usr/local/bin/hermes-disk-cleanup; then
      echo "[hermes-update-cleanup] WARN: /usr/local/bin/hermes-disk-cleanup failed; continuing with inline volume-safe cleanup" >&2
    fi
  else
    echo "[hermes-update-cleanup] WARN: /usr/local/bin/hermes-disk-cleanup missing; using inline volume-safe cleanup" >&2
  fi

  prune_dangling_docker_images
  prune_old_unused_hermes_agent_images
  prune_old_unused_hermes_webui_images
  # Plain \`-f\` (not \`-af\`) so tagged-but-unused images like
  # \`<repo>:hermes-last-known-good\` survive cleanup for the rollback path.
  docker image prune -f 2>/dev/null | tail -1 || true
  docker builder prune -af 2>/dev/null | tail -1 || true
  docker container prune -f --filter "until=24h" 2>/dev/null | tail -1 || true
  docker network prune -f 2>/dev/null | tail -1 || true
  ctr -n moby content prune references 2>/dev/null && echo "[hermes-update-cleanup] containerd content pruned" || true
  journalctl --vacuum-size=50M 2>/dev/null | tail -1 || true
  apt-get clean -qq 2>/dev/null || true
  find /var/lib/docker/containers -name '*-json.log' -type f -size +100M -exec truncate -s 0 {} \\; 2>/dev/null || true
  fstrim -av 2>/dev/null | tail -5 || true

  echo "[hermes-update-cleanup] phase=\${cleanup_phase} disk after: $(df -h / 2>/dev/null | tail -1 || true)"
  docker system df 2>/dev/null || true
}

hermes_verify_update_disk_headroom() {
  min_free_mb="\${HERMES_UPDATE_MIN_FREE_MB:-4096}"
  free_mb="$(df -Pm / 2>/dev/null | awk 'NR==2 {print $4 + 0}')"
  if [ -z "$free_mb" ] || ! [ "$free_mb" -ge 0 ] 2>/dev/null; then
    echo "[hermes-update-cleanup] WARN: could not calculate free disk; continuing update" >&2
    return 0
  fi
  echo "[hermes-update-cleanup] free_mb=\${free_mb} min_free_mb=\${min_free_mb}"
  if [ "$free_mb" -lt "$min_free_mb" ] 2>/dev/null; then
    echo "ERROR: only \${free_mb}MB free after cleanup; refusing update before image pulls (need \${min_free_mb}MB)" >&2
    docker system df >&2 2>/dev/null || true
    return 1
  fi
}
`;
}

export { PROVIDER_ID_MAP };

export interface HonchoSettings {
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  peerName?: string;
  aiPeer?: string;
  memoryMode?: "hybrid" | "honcho";
  recallMode?: "hybrid" | "context" | "tools";
  configMode?: "simple" | "advanced";
  heartbeatModel?: string;
}

export interface AgentSettings {
  runtimeMode?: "managed" | "developer";
  maxIterations: number;
  toolProgressMode: string;
  compressionThreshold: number;
  sessionResetMode: string;
  fastMode?: boolean;
  gatewayTimeoutMins?: number;
  showInterimAssistantMessages?: boolean;
  showToolCallsInChat?: boolean;
  autoApproveToolCalls?: boolean;
  systemPrompt?: string;
  browserProvider?: string;
  enableSearxng?: boolean;
  // Pro-tier-gated. Persisted as a user opt-in; provisioning code separately
  // verifies the user's tier still qualifies before emitting the compose block.
  browserSidecarEnabled?: boolean;
  browserbaseApiKey?: string;
  browserbaseProjectId?: string;
  browserUseApiKey?: string;
  tavilyApiKey?: string;
  exaApiKey?: string;
  firecrawlApiKey?: string;
  webUseGateway?: boolean;
  imageGenUseGateway?: boolean;
  ttsUseGateway?: boolean;
  browserUseGateway?: boolean;
  fallbackModels?: string;
  subagentModel?: string;
  subagentProvider?: string;
  subagentApiKey?: string;
  // Auxiliary "cheap" model used for context summarization / compaction. Routes
  // the box config.yaml's auxiliary.compression.{provider,model}. Empty/absent =
  // inherit the main model (the agent's default). This is what makes the sliding
  // context engine cheap without touching the primary inference model.
  compressionProvider?: string;
  compressionModel?: string;
  // Context engine the agent runs: "compressor" (default, batch summarization)
  // or "sliding" (the streaming context engine). Emitted as context.engine when
  // set; absent = the agent's own default (compressor).
  contextEngine?: "compressor" | "sliding";
  enableRootAccess?: boolean;
  // Where the agent's shell tool runs commands. "docker" = throwaway container
  // per command via the host docker socket — effective only in root mode, which
  // mounts the socket and runs as root (the non-root hermes user can't reach the
  // socket); docker-cli is bundled in the agent image. "modal" / "daytona" are
  // CLOUD sandboxes (no root, no local socket): modal goes via the Nous tool
  // gateway, daytona needs a BYO DAYTONA_API_KEY. Defaults to "local".
  terminalBackend?: "local" | "docker" | "modal" | "daytona";
  // BYO Daytona cloud-sandbox key. Decrypted before it reaches the builder and
  // emitted into the box .env as DAYTONA_API_KEY.
  daytonaApiKey?: string;
  mountPersistentSource?: boolean;
  browserProxyHost?: string;
  browserProxyPort?: string;
  browserProxyUsername?: string;
  browserProxyPassword?: string;
  browserProxyPasswordEncrypted?: string;
  customLlmBaseUrl?: string;
}

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : fallback;
}

function isNousAuthProvider(provider: string): boolean {
  return provider === "nous" || provider === "nous-portal";
}

function supportsHermesAuthStore(provider: string): boolean {
  return isCodexAuthProvider(provider) || isNousAuthProvider(provider);
}

function renderEmbeddedFileWrite(
  path: string,
  content: string,
  options?: { chmod?: string }
): string {
  const raw = Buffer.from(content, "utf8");
  const compressed = gzipSync(raw, { level: 9 });
  const shouldCompress = compressed.length < raw.length;
  const encoded = (shouldCompress ? compressed : raw).toString("base64");
  const decodePipeline = shouldCompress ? "base64 -d | gunzip" : "base64 -d";

  return `printf '%s' '${encoded}' | ${decodePipeline} > ${path}${options?.chmod ? `\nchmod ${options.chmod} ${path}` : ""}`;
}

const HERMES_RUNTIME_UID = 10000;
const HERMES_RUNTIME_GID = 10000;

// Collapse runs of 3+ blank lines into a single blank line. The agent script
// is templated from many conditional branches that often expand to "", which
// leaves big stretches of empty lines in the rendered output. These don't
// affect shell semantics but they do eat into the 32 KB user_data budget.
function collapseBlankLineRuns(script: string): string {
  return script.replace(/\n{3,}/g, "\n\n");
}

function buildHermesWritableVolumeInitScript(params: {
  instanceId: string;
  hermesImage: string;
  mountPersistentSource?: boolean;
  enableRootAccess?: boolean;
}): string {
  const volumeNames = [
    "agent-memories",
    "agent-sessions",
    "agent-logs",
    "agent-audio",
    "agent-image",
    "agent-profiles",
    ...(params.mountPersistentSource ? ["agent-source"] : []),
  ];
  const projectVolumeNames = volumeNames
    .map((name) => `"${params.instanceId}_${name}"`)
    .join(" ");
  const ownershipBootstrap = params.enableRootAccess
    ? `  p=$(docker volume inspect -f '{{.Mountpoint}}' "$volume_name")
  rm -f "$p/.hermes-perms-v1"
`
    : `  volume_mountpoint="$(docker volume inspect -f '{{ .Mountpoint }}' "$volume_name" 2>/dev/null || true)"
  if [ -n "$volume_mountpoint" ] && [ -f "$volume_mountpoint/.hermes-perms-v1" ]; then
    continue
  fi
  docker run --rm --user root -v "$volume_name:/target" --entrypoint sh ${params.hermesImage} -lc 'mkdir -p /target && chown -R ${HERMES_RUNTIME_UID}:${HERMES_RUNTIME_GID} /target && touch /target/.hermes-perms-v1 && chown ${HERMES_RUNTIME_UID}:${HERMES_RUNTIME_GID} /target/.hermes-perms-v1'
`;

  return `for volume_name in ${projectVolumeNames}; do
  docker volume create "$volume_name" >/dev/null
${ownershipBootstrap}done
`;
}

function buildHermesBindMountedRuntimeFileOwnershipScript(params: {
  enableRootAccess?: boolean;
}): string {
  if (params.enableRootAccess) {
    return "";
  }

  return `chown ${HERMES_RUNTIME_UID}:${HERMES_RUNTIME_GID} .env config.yaml SOUL.md honcho.json
`;
}

function buildBindMountedConfigPatchScript(containerNames: string[]): string {
  const containers = containerNames.join(" ");

  return `# Patch Hermes runtime so bind-mounted config writes survive EBUSY
resolve_running_container_name() {
  requested_name="$1"
  docker ps --format '{{.Names}}' 2>/dev/null | awk -v requested="$requested_name" '$0 == requested || $0 ~ ("_" requested "$") { print; exit }'
}

resolved_containers=""
for container_name in ${containers}; do
  ready=0
  resolved_name=""
  for i in 1 2 3 4 5; do
    resolved_name="$(resolve_running_container_name "$container_name")"
    if [ -n "$resolved_name" ]; then
      ready=1
      break
    fi
    sleep 2
  done
  [ "$ready" = "1" ] || { echo "FATAL: $container_name did not start before runtime patching" >&2; exit 1; }
  resolved_containers="$resolved_containers $resolved_name"

  docker exec -i -u 0 "$resolved_name" python3 - <<'PY'
from pathlib import Path
import re

p = Path("/opt/hermes/utils.py")
t = p.read_text(encoding="utf-8")

if "import errno" not in t:
    nl = "\\n" if t.endswith("\\n") else ""
    ls = t.splitlines()
    i = 0
    while i < len(ls) and (not ls[i].strip() or ls[i].startswith("#!")):
        i += 1
    ls.insert(i, "import errno")
    t = "\\n".join(ls) + nl

def patch(t, name):
    m = re.search(rf"(?ms)^def {re.escape(name)}\\(.*?(?=^def |^class |\\Z)", t)
    if not m:
        return t, 0
    b = m.group(0)
    if "errno.EBUSY" in b:
        return t, 1
    def repl(n):
        i = n["indent"]
        s = n["src"].strip()
        d = n["dst"].strip()
        return "\\n".join((
            f"{i}try:",
            f"{i}    os.replace({s}, {d})",
            f"{i}except OSError as exc:",
            f"{i}    if exc.errno != errno.EBUSY: raise",
            f'{i}    with open({s}, "r", encoding="utf-8") as a, open({d}, "w", encoding="utf-8") as b:',
            f"{i}        b.write(a.read()); b.flush(); os.fsync(b.fileno())",
            f"{i}    os.unlink({s})",
        ))
    nb, c = re.subn(r'(?m)^(?P<indent>\\s*)os\\.replace\\((?P<src>[^,\\n]+), (?P<dst>[^)\\n]+)\\)$', repl, b, count=1)
    if not c:
        raise SystemExit(f"expected bind-mount-safe os.replace() call in {name}")
    return t[:m.start()] + nb + t[m.end():], 1

o = t
h = 0
for n in ("atomic_yaml_write", "rewrite_env_file"):
    t, hit = patch(t, n)
    h += hit
if h == 0 and "errno.EBUSY" not in t:
    raise SystemExit("expected atomic_yaml_write or rewrite_env_file for EBUSY patch")
if t != o:
    b = Path("/opt/hermes/utils.py.bak.ebusy-bind-mount")
    if not b.exists():
        b.write_text(o, encoding="utf-8")
    p.write_text(t, encoding="utf-8")
PY
done
[ -n "$resolved_containers" ] && docker restart $resolved_containers >/dev/null
sleep 3
`;
}

function buildRootDeveloperToolBootstrapScript(containerNames: string[]): string {
  if (containerNames.length === 0) {
    return "";
  }

  const containers = containerNames.join(" ");

  return `# Ensure root-enabled Hermes runtimes expose usable developer tools
resolve_running_container_name() {
  requested_name="$1"
  docker ps --format '{{.Names}}' 2>/dev/null | awk -v requested="$requested_name" '$0 == requested || $0 ~ ("_" requested "$") { print; exit }'
}

for container_name in ${containers}; do
  ready=0
  resolved_name=""
  for i in 1 2 3 4 5; do
    resolved_name="$(resolve_running_container_name "$container_name")"
    if [ -n "$resolved_name" ]; then
      ready=1
      break
    fi
    sleep 2
  done
  [ "$ready" = "1" ] || { echo "FATAL: $container_name did not start before developer tool bootstrap" >&2; exit 1; }

  docker exec -i -u 0 "$resolved_name" /bin/sh <<'SH'
APT_UPDATED=0

install_deb_package() {
  if ! command -v apt-get >/dev/null 2>&1; then
    return 1
  fi

  if [ "$APT_UPDATED" != "1" ]; then
    apt-get update >/dev/null 2>&1 || true
    APT_UPDATED=1
  fi

  DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" >/dev/null 2>&1
}

if ! command -v sudo >/dev/null 2>&1; then
  install_deb_package sudo || true
fi

if ! command -v curl >/dev/null 2>&1; then
  install_deb_package curl ca-certificates || install_deb_package curl || true
fi

if ! command -v docker >/dev/null 2>&1; then
  install_deb_package docker.io || install_deb_package docker-ce-cli || true
fi

if [ -x /opt/hermes/.venv/bin/python ] && ! /opt/hermes/.venv/bin/python -c 'import yaml' >/dev/null 2>&1; then
  if command -v uv >/dev/null 2>&1; then
    uv pip install --python /opt/hermes/.venv/bin/python pyyaml >/dev/null 2>&1 || true
  elif [ -x /opt/hermes/.venv/bin/pip ]; then
    /opt/hermes/.venv/bin/pip install pyyaml >/dev/null 2>&1 || true
  fi
fi

if ! command -v sudo >/dev/null 2>&1; then
  cat > /usr/local/bin/sudo <<'EOSUDO'
#!/bin/sh
if [ "$#" -eq 0 ]; then
  exec /bin/sh
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      shift
      break
      ;;
    -u)
      if [ "\${2:-root}" != "root" ] && [ "\${2:-#0}" != "#0" ]; then
        echo "sudo shim only supports root in Hermes root mode" >&2
        exit 1
      fi
      shift 2
      ;;
    -*)
      shift
      ;;
    *)
      break
      ;;
  esac
done

exec "$@"
EOSUDO
  chmod +x /usr/local/bin/sudo
fi
SH
done
`;
}

export function buildHostCaddyReloadScript(options: { optionalCompose?: boolean } = {}): string {
  const optionalComposeGuard = options.optionalCompose
    ? `
  [ -f /opt/hermes/docker-compose.yml ] || [ -f /opt/hermes/compose.yml ] || [ -f /opt/hermes/compose.yaml ] || {
    echo "[host-caddy] no /opt/hermes compose file present; skipping reload"; return 0; }
  services="$(cd /opt/hermes && docker compose config --services 2>/tmp/hermes-caddy-services.log)" || {
    echo "FATAL: host caddy compose config is invalid" >&2
    cat /tmp/hermes-caddy-services.log >&2 || true
    exit 1; }
  printf '%s\\n' "$services" | grep -qx caddy || {
    echo "[host-caddy] no caddy service in /opt/hermes compose; skipping reload"; return 0; }
`
    : "";
  return `reload_host_caddy() {
  rm -f /tmp/hermes-caddy-validate.log /tmp/hermes-caddy-reload.log
${optionalComposeGuard}

  for i in $(seq 1 15); do
    if cd /opt/hermes && docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile > /tmp/hermes-caddy-validate.log 2>&1; then
      if cd /opt/hermes && docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile > /tmp/hermes-caddy-reload.log 2>&1; then
        rm -f /tmp/hermes-caddy-validate.log /tmp/hermes-caddy-reload.log
        return 0
      fi
    fi
    sleep 2
  done

  echo "FATAL: caddy reload failed after startup" >&2
  cat /tmp/hermes-caddy-validate.log >&2 || true
  cat /tmp/hermes-caddy-reload.log >&2 || true
  exit 1
}

reload_host_caddy
`;
}

// Seeds a systemd-timesyncd drop-in pointing at the default gateway.
// On Proxmox VMs the gateway IS the pve host, which now serves chrony on
// vmbr1 — this avoids the outbound-NTP conntrack failure mode that strands
// older guests at boot-time clock. Public Hetzner servers are also explicit
// NTP= candidates because timesyncd does not consult FallbackNTP while a
// configured primary keeps timing out. Kept terse so the gateway-enabled
// bootstrap stays under Hetzner's 32KB user_data limit.
const SYSTEMD_TIMESYNCD_LOCAL_NTP_BLOCK = `_hsnt(){ g=$(ip r 2>/dev/null|awk '/^default/{print $3;exit}');[ -z "$g" ]&&return;mkdir -p /etc/systemd/timesyncd.conf.d;printf '[Time]\\nNTP=%s ntp1.hetzner.de ntp2.hetzner.de ntp3.hetzner.de\\nFallbackNTP=ntp1.hetzner.de ntp2.hetzner.de ntp3.hetzner.de\\n' "$g" >/etc/systemd/timesyncd.conf.d/hermes-ntp.conf;}`;

export function buildHostTimeSyncRepairScript(options: {
  aptUpdateCommand?: string;
  aptInstallCommand?: string;
  includeInstallFallback?: boolean;
  /**
   * When true, also writes a systemd-timesyncd drop-in pointing at the
   * default gateway. Set this only on Proxmox provisioning paths — on
   * those hosts the gateway is the pve host's chrony server, which
   * sidesteps the conntrack failure that strands older Proxmox tenants
   * on a frozen clock. Off by default to keep the legacy Hetzner Cloud
   * bootstrap script under its 32KB user_data ceiling.
   */
  seedLocalNtp?: boolean;
} = {}): string {
  const aptUpdateCommand = options.aptUpdateCommand ?? "apt-get -o DPkg::Lock::Timeout=300 update -qq";
  const aptInstallCommand =
    options.aptInstallCommand ?? "apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends";
  const seedBlock = options.seedLocalNtp ? `${SYSTEMD_TIMESYNCD_LOCAL_NTP_BLOCK}\n` : "";
  const seedCall = options.seedLocalNtp ? "_hsnt; " : "";
  const seedCallGuarded = options.seedLocalNtp ? "r _hsnt; " : "";
  if (options.includeInstallFallback === false) {
    return `${seedBlock}hermes_ensure_time_sync(){ l=/var/log/hermes-time-sync.log; { echo "=== Hermes time sync $(date -u -Iseconds 2>/dev/null||date -u) ==="; ${seedCall}timedatectl set-timezone UTC; timedatectl set-ntp true; systemctl enable --now systemd-timesyncd.service; systemctl restart systemd-timesyncd.service; for _ in $(seq 1 10);do [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]&&break;sleep 2;done; hwclock --systohc --utc; echo "after=$(date -u +%s 2>/dev/null||echo unknown) NTPSynchronized=$(timedatectl show -p NTPSynchronized --value 2>/dev/null||echo unknown)"; }>>"$l" 2>&1||true; }
hermes_ensure_time_sync
`;
  }
  const installFallback =
    `||(${aptUpdateCommand}>>"$l" 2>&1||true; ${aptInstallCommand} systemd-timesyncd>>"$l" 2>&1||${aptInstallCommand} chrony>>"$l" 2>&1||true; systemctl enable --now $s>>"$l" 2>&1||systemctl enable --now $c>>"$l" 2>&1||true)`;

  return `${seedBlock}hermes_ensure_time_sync(){ l=/var/log/hermes-time-sync.log; s=systemd-timesyncd.service; c=chrony.service; r(){ "$@" >>"$l" 2>&1||true; }; echo "=== Hermes time sync $(date -u -Iseconds 2>/dev/null||date -u) before=$(date -u +%s 2>/dev/null||echo unknown) ===">>"$l"; ${seedCallGuarded}r timedatectl set-timezone UTC; r timedatectl set-ntp true; r systemctl unmask $s; systemctl enable --now $s>>"$l" 2>&1${installFallback}; r systemctl restart $s; r systemctl restart $c; for _ in $(seq 1 20); do [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null||echo unknown)" = yes ]&&break; sleep 2; done; r chronyc -a makestep; r hwclock --systohc --utc; echo "after=$(date -u +%s 2>/dev/null||echo unknown) NTPSynchronized=$(timedatectl show -p NTPSynchronized --value 2>/dev/null||echo unknown)">>"$l"; }
hermes_ensure_time_sync
`;
}

function buildInstalledHostTimeSyncRepairScript(): string {
  return `hermes_ensure_time_sync(){ l=/var/log/hermes-time-sync.log; { echo "=== time sync $(date -u -Iseconds 2>/dev/null||date -u) ==="; timedatectl set-timezone UTC; timedatectl set-ntp true; systemctl restart systemd-timesyncd.service; sleep 5; hwclock --systohc --utc; date -u -Iseconds 2>/dev/null||date -u; }>>"$l" 2>&1||true; }
hermes_ensure_time_sync
`;
}

function buildRootModeEntrypointScript(): string {
  return `#!/bin/bash
set -e

export HERMES_HOME="\${HERMES_HOME:-/root/.hermes}"
export HOME="\${HOME:-/root}"
INSTALL_DIR="/opt/hermes"

source "\${INSTALL_DIR}/.venv/bin/activate"

ROOT_BASHRC="/root/.bashrc"
touch "$ROOT_BASHRC"
if ! grep -Fq '# Hermes root terminal bootstrap' "$ROOT_BASHRC"; then
  cat >> "$ROOT_BASHRC" <<'EOF'
# Hermes root terminal bootstrap
export HERMES_HOME="\${HERMES_HOME:-/root/.hermes}"
export HOME="\${HOME:-/root}"
if [ -d /opt/hermes/.venv/bin ]; then
  case ":$PATH:" in
    *:/opt/hermes/.venv/bin:*) ;;
    *) export PATH="/opt/hermes/.venv/bin:$PATH" ;;
  esac
fi
if [ -f /opt/hermes/.venv/bin/activate ]; then
  . /opt/hermes/.venv/bin/activate >/dev/null 2>&1 || true
fi
EOF
fi

mkdir -p "$HERMES_HOME"/{cron,sessions,logs,hooks,memories,skills,skins,plans,workspace,home}

if [ ! -f "$HERMES_HOME/.env" ]; then
  cp "\${INSTALL_DIR}/.env.example" "$HERMES_HOME/.env"
fi

if [ ! -f "$HERMES_HOME/config.yaml" ]; then
  cp "\${INSTALL_DIR}/cli-config.yaml.example" "$HERMES_HOME/config.yaml"
fi

if [ ! -f "$HERMES_HOME/SOUL.md" ]; then
  cp "\${INSTALL_DIR}/docker/SOUL.md" "$HERMES_HOME/SOUL.md"
fi

if [ -d "\${INSTALL_DIR}/skills" ]; then
  python3 "\${INSTALL_DIR}/tools/skills_sync.py"
fi

if [ "$#" -eq 0 ]; then
  exec hermes
fi

if command -v "$1" >/dev/null 2>&1; then
  exec "$@"
fi

exec hermes "$@"
`;
}

type AgentMemoryOverlayPlan = {
  enabled: boolean;
  dockerfileContent?: string;
  hindsightConfigContent?: string;
};

const HINDSIGHT_DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
  gemini: "gemini-2.5-flash",
  groq: "openai/gpt-oss-120b",
  openrouter: "qwen/qwen3.5-9b",
  minimax: "MiniMax-M2.7",
  ollama: "gemma3:12b",
  lmstudio: "local-model",
  openai_compatible: "your-model-name",
};

function normalizeHindsightMode(mode?: MemorySystemConfig["hindsightMode"]): "cloud" | "local_embedded" {
  return mode === "local" ? "local_embedded" : "cloud";
}

function buildHindsightConfig(memorySystem?: MemorySystemConfig): string | null {
  if (memorySystem?.provider !== "hindsight") {
    return null;
  }

  const mode = normalizeHindsightMode(memorySystem.hindsightMode);
  const config: Record<string, unknown> = {
    mode,
    bank_id: memorySystem.hindsightBankId?.trim() || "hermes",
    recall_budget: memorySystem.hindsightBudget || "mid",
  };

  if (mode === "local_embedded") {
    const llmProvider = memorySystem.hindsightLlmProvider?.trim() || "openai";
    config.llm_provider = llmProvider;
    config.llm_model = memorySystem.hindsightLlmModel?.trim() || HINDSIGHT_DEFAULT_MODELS[llmProvider] || "gpt-4o-mini";
    if (llmProvider === "openai_compatible" && memorySystem.hindsightLlmBaseUrl?.trim()) {
      config.llm_base_url = memorySystem.hindsightLlmBaseUrl.trim();
    }
  }

  return `${JSON.stringify(config, null, 2)}\n`;
}

function buildAgentMemoryOverlay(params: {
  hermesImage: string;
  memorySystem?: MemorySystemConfig;
}): AgentMemoryOverlayPlan {
  const { hermesImage, memorySystem } = params;
  if (!memorySystem || !["mem0", "hindsight", "byterover", "supermemory"].includes(memorySystem.provider)) {
    return { enabled: false };
  }

  const pythonDeps = [
    "mem0ai",
    "hindsight-client>=0.4.22",
    "supermemory",
    ...(memorySystem.provider === "hindsight" && normalizeHindsightMode(memorySystem.hindsightMode) === "local_embedded"
      ? ["hindsight-all"]
      : []),
  ];

  const pythonDepArgs = pythonDeps.map((dep) => JSON.stringify(dep)).join(" ");

  return {
    enabled: true,
    dockerfileContent: `FROM ${hermesImage}
USER root
RUN uv pip install --python /opt/hermes/.venv/bin/python ${pythonDepArgs} \\
    && npm install -g byterover-cli \\
    && rm -rf /root/.cache/uv /root/.npm /tmp/*
`,
    hindsightConfigContent: buildHindsightConfig(memorySystem) || undefined,
  };
}

const VALID_SERVER_TYPES = new Set([
  "cx23", "cx33", "cx43", "cx53",
  "cpx11", "cpx21", "cpx31", "cpx41", "cpx51",
  "cpx12", "cpx22", "cpx32", "cpx42", "cpx52", "cpx62",
  "ccx13", "ccx23", "ccx33", "ccx43", "ccx53", "ccx63",
  "cax11", "cax21", "cax31", "cax41",
]);

export function pickServerType(tier?: string, _userId?: string): string {
  if (tier === "operator") return "cx23";
  if (tier === "fleet") return "cx43";
  if (tier === "command") return "cx53";

  const raw = env("HETZNER_SERVER_TYPE", "cx23");
  if (/^\d+$/.test(raw)) {
    log.error(
      "HETZNER_SERVER_TYPE is a deprecated numeric ID, falling back to cx23",
      new Error("deprecated numeric server type"),
      {
        source: LOG_SOURCE,
        failureType: "deprecated_numeric_server_type",
        rawValue: raw,
      }
    );
    return "cx23";
  }
  if (!VALID_SERVER_TYPES.has(raw)) {
    log.warn("HETZNER_SERVER_TYPE not in known slug list, proceeding anyway", {
      source: LOG_SOURCE,
      failureType: "unknown_server_type_slug",
      rawValue: raw,
    });
  }
  return raw;
}

export function getServerSpecs(serverType: string): { cpu: number; ram: number } {
  switch (serverType) {
    case "cx23": return { cpu: 2, ram: 4096 };
    case "cx33": return { cpu: 4, ram: 8192 };
    case "cx43": return { cpu: 8, ram: 16384 };
    case "cx53": return { cpu: 16, ram: 32768 };
    case "cpx11": return { cpu: 2, ram: 2048 };
    case "cpx21": return { cpu: 3, ram: 4096 };
    case "cpx31": return { cpu: 4, ram: 8192 };
    case "cpx41": return { cpu: 8, ram: 16384 };
    case "cpx51": return { cpu: 16, ram: 32768 };
    default: return { cpu: 2, ram: 4096 };
  }
}

// Hetzner gateway URL resolver. Two branches:
//
//  1. `dnsDomain` is set AND `subdomain` is non-null →
//     `<subdomain>.<dnsDomain>`. The CALLER must have already minted the
//     matching Cloudflare A record (see services/cloudflare-dns.ts).
//     `<subdomain>.hermesos.cloud` URLs that resolve to NXDOMAIN are
//     exactly the bug class that brought the Hetzner fleet down on
//     2026-04-30 — the gateway resolver itself does not provision DNS,
//     it only formats the FQDN.
//  2. Otherwise → `<dashed-ipv4>.sslip.io`. sslip is structurally immune
//     to provisioning gaps because the IP is encoded in the hostname —
//     every host's URL Just Works on first boot, no API call required.
//
// Provision call sites should pass `dnsDomain` only after a successful
// `mintInstanceDns()` call. Redeploy / resync call sites should pass
// `dnsDomain` only when the existing `instance.gateway_url` already
// resolves under that domain (use deriveDnsDomainFromGatewayUrl), so a
// re-derived FQDN matches what's already running on the box.
export function resolveGatewayConfiguration(params: {
  subdomain: string | null;
  ipv4: string;
  dnsDomain?: string | null;
}): { fqdn: string; gatewayUrl: string } {
  const dnsDomain = params.dnsDomain?.trim().replace(/^\.+|\.+$/g, "") || null;
  if (dnsDomain && params.subdomain) {
    const fqdn = `${params.subdomain}.${dnsDomain}`;
    return { fqdn, gatewayUrl: `https://${fqdn}` };
  }

  const sslipFqdn = `${params.ipv4.replace(/\./g, '-')}.sslip.io`;
  return {
    fqdn: sslipFqdn,
    gatewayUrl: `https://${sslipFqdn}`,
  };
}

/**
 * Per-image agent port wiring. Hardcoding these in the Caddyfile
 * generator (the previous shape) was the bug class that brought the
 * Hetzner WebUI fleet down on 2026-04-30 — a new agent image landed
 * (`vanilla-hermes-agent:v0.11.x-ash-003`) that listened on 8787/8788
 * instead of 8642/9090, but the Caddy generator kept emitting the old
 * port numbers, so every reverse_proxy directive pointed at "connection
 * refused" and the gateway returned timeouts on every request. Pulling
 * the ports out into named presets means: (1) the WebUI vs legacy
 * choice happens once at the call site, (2) when an image's ports
 * change, only the preset moves, and (3) tests can pin them.
 */
export interface AgentPortMapping {
  /** Main agent HTTP port — catch-all `handle { reverse_proxy <agent>:<port> }`. */
  agent: number;
  /** Sidecar HTTP port — `/_sidecar*`, `/web-api/*`, dashboard-browser cookie route. */
  sidecar: number;
}

export const LEGACY_AGENT_PORTS: AgentPortMapping = { agent: 8642, sidecar: 9090 };
export const WEBUI_AGENT_PORTS: AgentPortMapping = { agent: 8787, sidecar: 8788 };

export function agentPortsForBackend(backend: string | null | undefined): AgentPortMapping {
  return backend === "webui" ? WEBUI_AGENT_PORTS : LEGACY_AGENT_PORTS;
}

export function buildAgentCaddyfile(
  fqdn: string,
  containerName: string,
  a2a?: A2ASettings,
  profileRoutes?: { name: string; port: number }[],
  ports: AgentPortMapping = LEGACY_AGENT_PORTS,
): string {
  const dashboardSessionCookie = "hermes_dashboard_session";
  const publicSiteLabel = fqdn === "localhost" ? ":80" : fqdn;
  const mainBlock = `${publicSiteLabel} {
  encode zstd gzip

  @options {
    method OPTIONS
  }
  handle @options {
    header Access-Control-Allow-Origin "*"
    header Access-Control-Allow-Methods "GET, POST, OPTIONS"
    header Access-Control-Allow-Headers "Content-Type, Authorization, x-hermes-trace-id"
    header Access-Control-Max-Age "3600"
    respond 204
  }

  ${a2a?.enableAcp ? `
  handle_path /acp* {
    reverse_proxy ${containerName}:8643
  }` : ""}
  ${a2a?.enableMcp ? `
  handle_path /mcp* {
    reverse_proxy ${containerName}:8644
  }` : ""}
  handle_path /_sidecar* {
    reverse_proxy ${containerName}-sidecar:${ports.sidecar}
  }

  ${(profileRoutes || []).map(p => `
  handle_path /profiles/${p.name}* {
    reverse_proxy ${containerName}:${p.port}
  }`).join("")}

  handle_path /web-api/* {
    reverse_proxy ${containerName}-sidecar:${ports.sidecar} {
      lb_try_duration 10s
      lb_try_interval 1s
    }
  }

  @dashboard_browser {
    header_regexp Cookie "(^|;\\\\s*)${dashboardSessionCookie}="
  }
  handle @dashboard_browser {
    reverse_proxy ${containerName}-sidecar:${ports.sidecar} {
      lb_try_duration 10s
      lb_try_interval 1s
    }
  }

  handle {
    header Access-Control-Allow-Origin "*"
    header Access-Control-Expose-Headers "Content-Type"

    reverse_proxy ${containerName}:${ports.agent} {
      lb_try_duration 30s
      lb_try_interval 1s
      header_up X-Forwarded-Proto {scheme}
      header_up -Origin
    }
  }
}`;

  return mainBlock;
}

export function buildHostCaddyfile(): string {
  // Global block configures JSON access logging into /var/log/caddy/access.log.
  // This file is written into BOTH lanes (the docker-compose Hetzner lane and
  // the Proxmox guest VM). It used to also define a `(warden_check)` snippet for
  // the hermes-warden daily-compute-cap gate; warden was decommissioned
  // fleet-wide (2026-07) so the snippet is gone and no vhost imports it.
  return `{
\tlog {
\t\toutput file /var/log/caddy/access.log {
\t\t\troll_size 100mb
\t\t\troll_keep 5
\t\t}
\t\tformat json
\t\tlevel INFO
\t}
}

import /opt/hermes/instances/*/Caddyfile`;
}

export function renderHostUserData(): string {
  return `#!/usr/bin/env bash
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get upgrade -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold"
apt-get install -y --no-install-recommends curl ca-certificates gzip ufw fail2ban unattended-upgrades systemd-timesyncd

${buildHostTimeSyncRepairScript({ includeInstallFallback: false })}

sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config

mkdir -p /etc/systemd/system/ssh.service.d
cat > /etc/systemd/system/ssh.service.d/99-always-restart.conf << 'DROPIN'
[Service]
Restart=always
RestartSec=2s
DROPIN
systemctl daemon-reload
systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true

ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl enable fail2ban && systemctl start fail2ban

set -euo pipefail
curl -fsSL https://get.docker.com | sh
docker network create hermes_net || true

mkdir -p /opt/hermes/instances
cd /opt/hermes

cat > Caddyfile << 'CADDYEOF'
${buildHostCaddyfile()}
CADDYEOF

cat > docker-compose.yml << 'COMPOSEEOF'
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    networks:
      - hermes_net
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./instances:/opt/hermes/instances:ro
      - caddy_data:/data
      - caddy_config:/config
      - caddy_logs:/var/log/caddy

volumes:
  caddy_data:
  caddy_config:
  caddy_logs:

networks:
  hermes_net:
    external: true
COMPOSEEOF

if [ -f /opt/hermes/.env ]; then
  set -a; . /opt/hermes/.env; set +a
fi

docker compose pull caddy
docker compose up -d

cat > /usr/local/bin/hermes-disk-cleanup << 'CLEANUPEOF'
#!/bin/bash
set -u
LOG="/var/log/hermes-disk-cleanup.log"
exec >> "$LOG" 2>&1
echo "=== Disk Cleanup: $(date) ==="
docker images -f dangling=true -q|xargs -r docker rmi
ctr -n moby content prune references 2>/dev/null
journalctl --vacuum-size=50M 2>/dev/null | tail -1
apt-get clean -qq 2>/dev/null
find /var/log -name '*.gz' -mtime +3 -delete 2>/dev/null
find /var/log -name '*.1' -mtime +3 -delete 2>/dev/null

DISK_PCT=$(df / --output=pcent | tail -1 | tr -dc '0-9')
if [ "$DISK_PCT" -gt 85 ] 2>/dev/null; then
  echo "WARN: Disk at \${DISK_PCT}% — running aggressive prune"
  docker image prune -af 2>/dev/null | tail -1
  ctr -n moby content prune references 2>/dev/null || true
fi

if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

echo "Disk after cleanup: $(df -h / | tail -1)"
echo ""
CLEANUPEOF
chmod +x /usr/local/bin/hermes-disk-cleanup

rm -f /etc/cron.weekly/docker-prune

cat > /etc/systemd/system/hermes-disk-cleanup.service << 'SVCEOF'
[Unit]
Description=Hermes disk cleanup

[Service]
Type=oneshot
ExecStart=/usr/local/bin/hermes-disk-cleanup
Nice=19
IOSchedulingClass=idle
SVCEOF

cat > /etc/systemd/system/hermes-disk-cleanup.timer << 'TIMEREOF'
[Unit]
Description=Hermes disk cleanup timer

[Timer]
OnBootSec=10min
OnUnitActiveSec=6h
RandomizedDelaySec=30min

[Install]
WantedBy=timers.target
TIMEREOF

systemctl daemon-reload
systemctl enable --now hermes-disk-cleanup.timer
`;
}

export function renderCompressedAgentBootstrapForUserData(agentScript: string): string {
  const bootstrapPath = "/tmp/hermes-agent-bootstrap.sh";

  return `# Keep the agent bootstrap under Hetzner's 32 KiB user_data ceiling.
${renderEmbeddedFileWrite(bootstrapPath, agentScript, { chmod: "+x" })}
bash ${bootstrapPath}
rm -f ${bootstrapPath}
`;
}

export function renderCompressedProvisioningUserData(
  hostScript: string,
  agentScript: string
): string {
  const fullScript = `${hostScript.trimEnd()}\n${agentScript.trimStart()}`;
  const encoded = gzipSync(Buffer.from(fullScript, "utf8"), { level: 9 }).toString("base64");

  return `#!/usr/bin/env bash
set -euo pipefail
printf '%s' '${encoded}' | base64 -d | gunzip | bash
`;
}

export function buildAutoUpdateTimerProvisioningScript(params: {
  instanceId: string;
  containerName: string;
  autoUpdate?: AutoUpdateConfig;
  agentSettings?: AgentSettings;
  memorySystem?: MemorySystemConfig;
  hermesImage?: string;
  apiServerKey?: string;
  dashboardUrl?: string;
  /** "gateway" (legacy) or "webui". Defaults to "gateway" for legacy callers. */
  backend?: "gateway" | "webui";
  /**
   * WebUI agent runtime image (only consulted when backend === "webui").
   * Pulled separately and re-seeded into the agent-source named volume,
   * since hermes-agent runs as Python source under the WebUI container,
   * not as its own compose service.
   */
  webuiAgentImage?: string;
  includeHostTimeSyncInstallFallback?: boolean;
}): string {
  const backend = params.backend === "webui" ? "webui" : "gateway";
  const hermesImage = params.hermesImage ?? env("HERMES_DOCKER_IMAGE", "ghcr.io/ashneil12/vanilla-hermes-agent:latest");
  const agentMemoryOverlay = buildAgentMemoryOverlay({
    hermesImage,
    memorySystem: params.memorySystem,
  });
  const needsComposeBuild =
    backend === "gateway" && Boolean(agentMemoryOverlay.enabled);
  const timerName = `hermes-auto-update-${params.instanceId}`;
  const executablePath = `/usr/local/bin/${timerName}`;
  const servicePath = `/etc/systemd/system/${timerName}.service`;
  const timerPath = `/etc/systemd/system/${timerName}.timer`;
  const autoUpdateEnabled = params.autoUpdate?.enabled ?? DEFAULT_AUTO_UPDATE_ENABLED;

  if (!autoUpdateEnabled) {
    return `systemctl disable --now ${timerName}.timer >/dev/null 2>&1 || true
rm -f ${executablePath} ${servicePath} ${timerPath}
systemctl daemon-reload
systemctl reset-failed ${timerName}.service ${timerName}.timer >/dev/null 2>&1 || true`;
  }

  const scheduledTime = params.autoUpdate?.time?.trim() || DEFAULT_AUTO_UPDATE_TIME;
  const autoUpdateTimeSyncRepairScript = params.includeHostTimeSyncInstallFallback === false
    ? buildInstalledHostTimeSyncRepairScript()
    : buildHostTimeSyncRepairScript();

  // Backend-specific update body. The shared shell on either side is the
  // pull → recreate → wait-for-ready → drop dangling layers loop.
  let updateBody: string;
  if (backend === "webui") {
    const webuiAgentImage =
      params.webuiAgentImage ??
      env(
        "HERMES_WEBUI_AGENT_UPDATE_IMAGE",
        env("HERMES_WEBUI_AGENT_IMAGE", env("HERMES_DOCKER_IMAGE", "ghcr.io/ashneil12/vanilla-hermes-agent:stable"))
      );
    // WebUI auto-update:
    //   1. Save the currently-running image digests as :hermes-last-known-good
    //      so a failed pull/recreate can be rolled back to the prior good state.
    //   2. Always pull both images (no inspect-skip — `:stable` is a moving tag)
    //   3. Re-seed the agent-source volume from the freshly-pulled agent image
    //   4. --force-recreate webui+sidecar so they re-import the new agent source
    //      (`docker compose up -d` alone would no-op if only the volume changed)
    //   5. Wait for readiness; on failure restore the LKG tags and re-apply so
    //      the VM lands on the prior-good runtime instead of staying broken.
    //   6. `docker image prune -f` (not -af) so the LKG tag survives cleanup;
    //      tagged-but-unused images stay around for the next rollback window.
    updateBody = `${buildHermesAutoUpdateDiskCleanupFunctions()}
hermes_lkg_tag_for_ref() {
  ref="$1"
  base="\${ref%:*}"
  printf '%s:hermes-last-known-good' "$base"
}

hermes_managed_image_refs() {
  # Prints the agent image ref + every compose-managed image ref, one per line.
  printf '%s\\n' "${webuiAgentImage}"
  docker compose config --images 2>/dev/null | sort -u | while IFS= read -r r; do
    [ -n "$r" ] || continue
    printf '%s\\n' "$r"
  done
}

hermes_save_last_known_good() {
  saved=0
  for ref in "${webuiAgentImage}" $(docker compose config --images 2>/dev/null | sort -u); do
    [ -n "$ref" ] || continue
    digest="$(docker image inspect "$ref" --format '{{.Id}}' 2>/dev/null || true)"
    [ -n "$digest" ] || continue
    lkg="$(hermes_lkg_tag_for_ref "$ref")"
    if docker tag "$digest" "$lkg" 2>/dev/null; then
      echo "[hermes-update] saved LKG: $ref -> $lkg ($digest)"
      saved=$((saved + 1))
    fi
  done
  echo "[hermes-update] LKG saved_count=$saved"
}

hermes_restore_last_known_good() {
  restored_any=0
  for ref in "${webuiAgentImage}" $(docker compose config --images 2>/dev/null | sort -u); do
    [ -n "$ref" ] || continue
    lkg="$(hermes_lkg_tag_for_ref "$ref")"
    if docker image inspect "$lkg" >/dev/null 2>&1; then
      if docker tag "$lkg" "$ref" 2>/dev/null; then
        echo "[hermes-update] restored LKG for $ref"
        restored_any=1
      fi
    fi
  done
  echo "[hermes-update] LKG restored_any=$restored_any"
  [ "$restored_any" = "1" ]
}

hermes_apply_webui_runtime() {
  docker run --rm \\
    -v ${params.containerName}_agent-source:/target \\
    --entrypoint sh \\
    ${webuiAgentImage} -lc 'set -e; test -f /opt/hermes/pyproject.toml; find /target -mindepth 1 -maxdepth 1 -exec rm -rf {} +; cp -a /opt/hermes/. /target/; chown -R 1024:1024 /target; chmod -R u+w /target'
${buildWebUIAutoUpdateToolchainEnvRepairScript(params.containerName)}
${buildWebUIPersistentStatePermissionRepairCommand(params.containerName)}
${buildWebUIPersistentStateShimCommand(params.containerName)}
  docker compose up -d --remove-orphans --force-recreate
${buildWebUIContainerCliShimCommand(params.containerName)}
}

hermes_save_last_known_good
hermes_volume_safe_update_cleanup pre-pull
hermes_verify_update_disk_headroom
docker pull ${webuiAgentImage}
docker compose pull --ignore-pull-failures
${buildEnsureBusyboxAvailableScript()}
hermes_apply_webui_runtime

update_failed=0
for c in "${params.containerName}" "${params.containerName}-sidecar" "${params.containerName}-gateway"; do
if ! docker inspect "$c" >/dev/null 2>&1; then
continue
fi

ok=0
for i in $(seq 1 45); do
run=$(docker inspect --format='{{.State.Running}}' "$c" 2>/dev/null || echo false)
if [ "$run" != "true" ]; then
sleep 2
continue
fi

h=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || echo none)
if [ "$h" = "healthy" ] || [ "$h" = "none" ]; then
ok=1
break
fi

if [ "$h" = "unhealthy" ]; then
break
fi

sleep 2
done

if [ "$ok" != "1" ]; then
echo "ERROR: $c failed readiness after auto update"
docker logs --tail 50 "$c" 2>/dev/null || true
update_failed=1
break
fi
done

if [ "$update_failed" = "1" ]; then
  echo "[hermes-update] attempting rollback to last-known-good"
  if hermes_restore_last_known_good; then
    if hermes_apply_webui_runtime; then
      echo "[hermes-update] rollback applied; VM is on last-known-good runtime"
    else
      echo "[hermes-update] rollback apply failed; VM may be in degraded state" >&2
    fi
  else
    echo "[hermes-update] no last-known-good image present; VM left on failed update" >&2
  fi
  return 1
fi

${buildWebUIDeveloperToolBootstrapCommand(params.containerName)}
${buildWebUIHermesPythonRuntimeCommand(params.containerName)}
${buildWebUIToolchainDiagnosticCommand(params.containerName)}
docker exec --user 1024 ${params.containerName} sh -lc 'test -x "$(command -v hermes)" && test -x "$(command -v hermes-cli)"'
hermes_volume_safe_update_cleanup post-success
echo "Hermes auto update finished."`;
  } else {
    const pullCommand = agentMemoryOverlay.enabled
      ? `docker pull ${hermesImage}`
      : "docker compose pull agent";
    const upCommand = `docker compose up -d --remove-orphans ${needsComposeBuild ? "--build" : ""}`.trim();
    updateBody = `${pullCommand}
${upCommand}

for c in "${params.containerName}" "${params.containerName}-web"; do
if ! docker inspect "$c" >/dev/null 2>&1; then
continue
fi

ok=0
for i in $(seq 1 45); do
run=$(docker inspect --format='{{.State.Running}}' "$c" 2>/dev/null || echo false)
if [ "$run" != "true" ]; then
sleep 2
continue
fi

h=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || echo none)
if [ "$h" = "healthy" ] || [ "$h" = "none" ]; then
ok=1
break
fi

if [ "$h" = "unhealthy" ]; then
break
fi

sleep 2
done

if [ "$ok" != "1" ]; then
echo "ERROR: $c failed readiness after auto update"
docker logs --tail 50 "$c" 2>/dev/null || true
return 1
fi
done

docker image prune -f >/dev/null 2>&1 || true
echo "Hermes auto update finished."`;
  }

  const updateReporterShell = buildInstanceUpdateReporterShell({
    instanceId: params.instanceId,
    dashboardUrl: params.dashboardUrl,
    apiServerKey: params.apiServerKey,
    runType: "scheduled",
  });
  const autoUpdateScript = `#!/bin/bash
set -euo pipefail
LOG="/var/log/${timerName}.log"
${updateReporterShell}
run() {
echo "=== Hermes auto update (${params.instanceId}) $(date -u -Iseconds) ==="

if [ -f /etc/hermes/auto-update-disabled ]; then
  echo "[hermes-auto-update] skipped: /etc/hermes/auto-update-disabled present"
  sed -e 's/^/[hermes-auto-update]   reason: /' /etc/hermes/auto-update-disabled 2>/dev/null || true
  return 0
fi

${autoUpdateTimeSyncRepairScript}

cd /opt/hermes/instances/${params.instanceId}

${updateBody}
}

exec >> "$LOG" 2>&1

if ! run; then
  status=$?
  ru "failed" "exit_status_\${status}" "$LOG" || true
  exit "$status"
fi`;
  const serviceFile = `[Unit]
Description=Hermes auto update for ${params.instanceId}
After=docker.service network-online.target
Wants=network-online.target
ConditionPathExists=/opt/hermes/instances/${params.instanceId}/docker-compose.yml

[Service]
Type=oneshot
ExecStart=${executablePath}
TimeoutStartSec=15min`;
  const timerFile = `[Unit]
Description=Daily Hermes auto update for ${params.instanceId}

[Timer]
OnCalendar=*-*-* ${scheduledTime}:00 UTC
Persistent=true
AccuracySec=1min
Unit=${timerName}.service

[Install]
WantedBy=timers.target`;

  return `${renderEmbeddedFileWrite(executablePath, autoUpdateScript, { chmod: "+x" })}
${renderEmbeddedFileWrite(servicePath, serviceFile)}
${renderEmbeddedFileWrite(timerPath, timerFile)}
systemctl daemon-reload
systemctl reset-failed ${timerName}.service ${timerName}.timer >/dev/null 2>&1 || true
systemctl enable ${timerName}.timer >/dev/null 2>&1 || true
systemctl restart ${timerName}.timer >/dev/null 2>&1 || systemctl start ${timerName}.timer >/dev/null 2>&1`;
}

function buildAgentConfigYaml(params: {
  provider: string;
  model: string;
  /**
   * Clean-slate BYOK (deploy-card Managed=OFF): omit the entire `model:` block
   * (default + provider + base_url) so the agent's _has_any_provider_configured()
   * returns false → its native onboarding overlay fires and the user configures a
   * provider after the box is up. Mirrors webui-instance-builder's modelBlock gate.
   * Without this, a clean-slate gateway box bakes the reconciled openrouter default
   * (openai/gpt-5.4-pro) with no key → "No LLM provider configured".
   */
  unconfigured?: boolean;
  bankr?: InstanceBankrAgentConfig | null;
  agentSettings?: AgentSettings;
  memorySystem?: MemorySystemConfig;
  globalSettings?: {
    memoryContextLimit?: number;
    userContextLimit?: number;
    sessionExpiryHours?: number;
    dashboardUrl?: string;
  };
}): string {
  let configYamlProvider = PROVIDER_ID_MAP[params.provider] ?? params.provider;
  if (params.provider === "custom_llm") {
    configYamlProvider = "custom";
  }
  const resolvedBaseUrl = resolveProviderBaseUrl(params.provider, params.agentSettings?.customLlmBaseUrl);
  const configYamlBaseUrl = resolvedBaseUrl ? `\n  base_url: "${resolvedBaseUrl}"` : "";

  const requestedModel = params.model || resolveProviderFallbackModel(params.provider);
  const resolvedModel = normalizeModelValue(requestedModel, params.provider);

  let fallbackProvidersYaml = "fallback_providers: []\n";
  if (params.agentSettings?.fallbackModels) {
    try {
      const parsed = JSON.parse(params.agentSettings.fallbackModels);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const entries = parsed.map((item: { provider?: string; model?: string; apiKey?: string }) => {
          const requestedProvider = item.provider || "openrouter";
          let p = requestedProvider;
          let bUrl = "";
          const key = item.apiKey || "";

          p = PROVIDER_ID_MAP[p] ?? p;
          if (requestedProvider === "codex" || p === "openai-codex") {
            bUrl = `\n    base_url: "https://chatgpt.com/backend-api/codex"`;
          }
          if (requestedProvider === "xai-oauth" || p === "xai-oauth") {
            bUrl = `\n    base_url: "https://api.x.ai/v1"`;
          }

          let entry = `  - provider: ${JSON.stringify(p)}\n    model: ${JSON.stringify(item.model || "")}${bUrl}`;
          if (key) entry += `\n    api_key: ${JSON.stringify(key)}`;
          return entry;
        });
        fallbackProvidersYaml = `fallback_providers:\n${entries.join("\n")}\n`;
      }
    } catch {
      // Ignore malformed fallback config and keep the safest empty default.
    }
  }

  const memSys = params.memorySystem;
  const memProviderLine = memSys?.provider && memSys.provider !== "holographic"
    ? `  provider: "${memSys.provider}"\n`
    : memSys?.provider === "holographic" ? `  provider: "holographic"\n` : "";

  const holographicPluginYaml = memSys?.provider === "holographic"
    ? `plugins:\n  hermes-memory-store:\n    auto_extract: ${memSys.holographicAutoExtract ?? false}\n    default_trust: ${memSys.holographicDefaultTrust ?? 0.5}\n`
    : "";

  let delegationYaml = "";
  if (params.agentSettings?.subagentModel) {
    const subParts = params.agentSettings.subagentModel.split(":");
    const subProvider = params.agentSettings.subagentProvider || (subParts.length > 1 ? subParts[0] : params.provider);
    const subModelStr = subParts.length > 1 ? subParts.slice(1).join(":") : subParts[0];

    const configYamlSubProvider = PROVIDER_ID_MAP[subProvider] ?? subProvider;
    let subApiKeyYaml = "";
    const resolvedSubBaseUrl = resolveProviderBaseUrl(subProvider);
    const configYamlSubBaseUrl = resolvedSubBaseUrl ? `\n  base_url: "${resolvedSubBaseUrl}"` : "";

    if (params.agentSettings.subagentApiKey) {
      subApiKeyYaml = `\n  api_key: "${params.agentSettings.subagentApiKey}"`;
    }

    delegationYaml = `delegation:\n  provider: "${configYamlSubProvider}"\n  model: "${subModelStr}"${configYamlSubBaseUrl}${subApiKeyYaml}\n`;
  }

  const hasWebKey = !!(params.agentSettings?.tavilyApiKey || params.agentSettings?.exaApiKey || params.agentSettings?.firecrawlApiKey);
  const webUseGateway = params.agentSettings?.webUseGateway === true;
  const imageGenUseGateway = params.agentSettings?.imageGenUseGateway === true;
  const ttsUseGateway = params.agentSettings?.ttsUseGateway === true;
  const browserUseGateway = params.agentSettings?.browserUseGateway === true;
  const webBackend = params.agentSettings?.firecrawlApiKey ? "firecrawl"
    : params.agentSettings?.tavilyApiKey ? "tavily"
    : params.agentSettings?.exaApiKey ? "exa"
    : null;
  const webToolsetYaml = (hasWebKey || webUseGateway) ? `  - web\n` : "";
  const nativeMediaToolsetYaml = params.provider === "venice" ? `  - video_gen\n` : "";
  const resolvedWebBackend = webUseGateway ? "firecrawl" : webBackend;
  const webSectionYaml = resolvedWebBackend
    ? `web:\n  backend: ${resolvedWebBackend}${webUseGateway ? `\n  use_gateway: true` : ""}\n`
    : "";

  const resolvedBrowserCloudProvider = browserUseGateway
    ? "browser-use"
    : params.agentSettings?.browserProvider === "browser_use"
      ? "browser-use"
      : params.agentSettings?.browserProvider === "browserbase"
        ? "browserbase"
        : "local";
  const browserSectionYaml = `browser:\n  cloud_provider: ${resolvedBrowserCloudProvider}${browserUseGateway ? `\n  use_gateway: true` : ""}\n`;
  const imageGenSectionYaml = imageGenUseGateway
    ? `image_gen:\n  use_gateway: true\n`
    : "";
  const ttsSectionYaml = ttsUseGateway
    ? `tts:\n  provider: openai\n  use_gateway: true\n`
    : "";
  // Docker backend requires root mode (socket mount + root user); outside root
  // mode we always emit "local" so a stray docker selection can't leave the box
  // pointing at an unreachable socket (the agent would fall back to local
  // anyway, but emitting local keeps config.yaml honest).
  // Backend selection:
  //   - "modal": managed cloud sandbox via the Nous gateway — cloud, so it
  //     needs neither root nor a local socket. Emitted in any mode.
  //   - "docker": local throwaway containers — needs the host socket + root
  //     user, so only effective in root mode; otherwise falls back to local.
  //   - "local" (default): in-container execution; the terminal section is only
  //     emitted at all in root mode (to pin cwd), matching prior behaviour.
  //   - "daytona": Daytona cloud sandbox — cloud, no root/socket; needs a BYO
  //     DAYTONA_API_KEY (emitted to .env). Selecting it without a key would
  //     fail at runtime, so we only emit it when a key is actually present and
  //     otherwise fall back to local rather than hand the box a dead backend.
  const selectedBackend = params.agentSettings?.terminalBackend ?? "local";
  const rootOn = !!params.agentSettings?.enableRootAccess;
  const hasDaytonaKey = Boolean(params.agentSettings?.daytonaApiKey?.trim());
  const wantsModal = selectedBackend === "modal";
  const wantsDaytona = selectedBackend === "daytona" && hasDaytonaKey;
  const wantsDocker = selectedBackend === "docker";
  const effectiveTerminalBackend = wantsModal
    ? "modal"
    : wantsDaytona
      ? "daytona"
      : rootOn && wantsDocker
        ? "docker"
        : "local";
  const emitTerminalSection = rootOn || wantsModal || wantsDaytona;
  const modalModeLine =
    effectiveTerminalBackend === "modal" ? "  modal_mode: managed\n" : "";
  // The cwd line pins the local working dir and is only meaningful in root mode
  // (a cloud modal sandbox has its own cwd), so keep it gated on root.
  const terminalCwdLine = rootOn
    ? `  cwd: ${JSON.stringify(
        params.agentSettings?.mountPersistentSource
          ? `${resolveHermesHomeDir(true)}/hermes-agent`
          : "/opt/hermes"
      )}\n`
    : "";
  const terminalSectionYaml = emitTerminalSection
    ? `terminal:\n  backend: ${effectiveTerminalBackend}\n${modalModeLine}${terminalCwdLine}`
    : "";
  const bankrSectionYaml = params.bankr
    ? `bankr:\n  walletAddress: ${JSON.stringify(params.bankr.walletAddress)}\n  apiKey: ${JSON.stringify(params.bankr.apiKey)}\n  walletId: ${JSON.stringify(params.bankr.walletId)}\n  withdrawalDestination: ${params.bankr.withdrawalDestination ? JSON.stringify(params.bankr.withdrawalDestination) : "null"}\n`
    : "";

  // Clean-slate BYOK: drop the model block entirely so the agent boots
  // unconfigured and its native onboarding overlay fires (see param docs).
  const modelBlock = params.unconfigured
    ? ""
    : `model:
  default: ${JSON.stringify(resolvedModel)}
  provider: ${JSON.stringify(configYamlProvider)}${configYamlBaseUrl}
`;

  return `# Generated by Hermes Deploy — model and provider are injected from dashboard settings.
${modelBlock}${fallbackProvidersYaml}${delegationYaml}toolsets:
  - hermes-cli
${webToolsetYaml}${nativeMediaToolsetYaml}agent:
  max_turns: ${params.agentSettings?.maxIterations || 60}
  fast_mode: ${params.agentSettings?.fastMode ? "true" : "false"}
display:
  interim_assistant_messages: ${params.agentSettings?.showInterimAssistantMessages === false ? "false" : "true"}
compression:
  enabled: true
  threshold: ${params.agentSettings?.compressionThreshold || 0.50}
memory:
  memory_char_limit: ${params.globalSettings?.memoryContextLimit || 2200}
  user_char_limit: ${params.globalSettings?.userContextLimit || 1375}
${memProviderLine}session_reset:
  mode: "${params.agentSettings?.sessionResetMode || 'both'}"
  idle_minutes: ${params.agentSettings?.gatewayTimeoutMins || ((params.globalSettings?.sessionExpiryHours || 24) * 60)}
${webSectionYaml}${browserSectionYaml}${terminalSectionYaml}${imageGenSectionYaml}${ttsSectionYaml}${bankrSectionYaml}${holographicPluginYaml}`;
}

interface BuildAgentDeployScriptParams {
  instanceId: string;
  containerName: string;
  apiServerKey: string;
  provider: string;
  apiKey: string;
  model: string;
  /**
   * Clean-slate BYOK (deploy-card Managed=OFF): boot the agent with NO provider,
   * model, or key seeded so its native onboarding overlay collects one after the
   * box is up. Threaded into buildHermesEnvLines + buildAgentConfigYaml. Without
   * it, the reconciled openrouter default model (openai/gpt-5.4-pro) is baked with
   * no credential → runtime "No LLM provider configured". (webui-instance-builder
   * already honors this; the gateway path silently dropped it.)
   */
  unconfigured?: boolean;
  bankr?: InstanceBankrAgentConfig | null;
  fqdn: string;
  cpuLimit: number;
  ramLimit: number;
  /** RAM burst ceiling (MB) for the agent container's cgroup memory limit. When
   *  above ramLimit, the agent may use burst headroom before a cgroup OOM-kill +
   *  auto-restart. Absent / ≤ ramLimit → limit stays at ramLimit (unchanged). */
  ramBurstMb?: number;
  migrationUrl?: string;
  honchoSettings?: HonchoSettings;
  agentSettings?: AgentSettings;
  a2aSettings?: A2ASettings;
  autoUpdate?: AutoUpdateConfig;
  memorySystem?: MemorySystemConfig;
  globalSettings?: {
    memoryContextLimit?: number;
    userContextLimit?: number;
    sessionExpiryHours?: number;
    dashboardUrl?: string;
  };
  profileRoutes?: { name: string; port: number }[];
  profilesToRestore?: { name: string; port: number }[];
  codexAuthBundle?: CodexVaultBundle;
  nousAuthBundle?: NousVaultBundle;
  // GHCR token to use for `docker login ghcr.io` in the bootstrap.
  // Caller decides whether to source this from process.env — keeping the
  // builder pure means the test suite renders deterministic-size output
  // regardless of the test runner's env (CI sets GHCR_TOKEN; local
  // jest doesn't), which is what the user_data 32 KB size assertion
  // depends on. Empty/null/undefined → docker-login block is omitted.
  ghcrToken?: string | null;
  /**
   * Existing-host/live-update scripts must repair the host clock because no
   * host bootstrap runs. Fresh Hetzner provisioning already runs the repair in
   * renderHostUserData(), so callers can disable this to stay below the 32 KB
   * user_data ceiling.
   */
  includeHostTimeSyncRepair?: boolean;
}

interface BuildAgentComposeContentParams {
  params: BuildAgentDeployScriptParams;
  instanceId: string;
  containerName: string;
  agentBuildBlock: string;
  rootModeEntrypointServiceLine: string;
  rootModeEntrypointVolumeLine: string;
  hermesHomeDir: string;
  shellHomeDir: string;
  cpuLimit: number;
  ramLimit: number;
  /** Burst ceiling (MB) for the agent container cgroup memory limit; falls back
   *  to ramLimit when absent or not above it. */
  ramBurstMb?: number;
  agentRuntimeImage: string;
  hindsightVolumeLine: string;
  authStoreVolumeLines: string;
  needsLegacyOptDataMirror: boolean;
  isRootEnabled: boolean;
  terminalExecUser: string;
  terminalShellCwd: string;
  terminalTuiCwd: string;
}

function buildProfileRestoreScript(params: {
  containerName: string;
  profilesToRestore?: { name: string; port: number }[];
  hermesHomeDir: string;
}): string {
  const profileRestoreJson = JSON.stringify(params.profilesToRestore || []);

  return params.profilesToRestore?.length
    ? `
# Restart profile gateways that were active before redeploy
docker exec -i ${params.containerName} python3 - <<'PY'
import json, os, socket, subprocess, time
from pathlib import Path

profiles = json.loads(${JSON.stringify(profileRestoreJson)})
hermes_home = Path(${JSON.stringify(params.hermesHomeDir)})
main_env = hermes_home / ".env"
api_server_key = ""

if main_env.exists():
    for raw_line in main_env.read_text().splitlines():
        if raw_line.startswith("API_SERVER_KEY="):
            api_server_key = raw_line.split("=", 1)[1].strip().strip('"')
            break

def resolve_hermes_bin() -> str:
    for candidate in ("/opt/venv/bin/hermes", "/opt/hermes/.venv/bin/hermes"):
        if os.path.exists(candidate):
            return candidate
    return "hermes"

def patch_profile_env(env_path: Path, profile_name: str, port: int) -> None:
    preserved_lines = []
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith((
                "API_SERVER_PORT=",
                "API_SERVER_HOST=",
                "API_SERVER_KEY=",
                "API_SERVER_ENABLED=",
                "PROFILE_NAME=",
            )):
                continue
            preserved_lines.append(line)

    preserved_lines.extend([
        f"API_SERVER_PORT={port}",
        "API_SERVER_HOST=0.0.0.0",
        f"API_SERVER_KEY={api_server_key}",
        "API_SERVER_ENABLED=true",
        f"PROFILE_NAME={profile_name}",
    ])
    env_path.write_text("\\n".join(preserved_lines).strip() + "\\n")

pending = {}
hermes_bin = resolve_hermes_bin()

for profile in profiles:
    name = profile.get("name")
    port = int(profile.get("port", 0) or 0)
    if not name or not port:
        continue

    profile_dir = hermes_home / "profiles" / name
    if not profile_dir.is_dir():
        continue

    try:
        patch_profile_env(profile_dir / ".env", name, port)
        pid_path = profile_dir / "gateway.pid"
        if pid_path.exists():
            pid_path.unlink(missing_ok=True)

        log_handle = open(profile_dir / "gateway.log", "ab", buffering=0)
        subprocess.Popen(
            [hermes_bin, "gateway", "run"],
            env={**os.environ, "HERMES_HOME": str(profile_dir), "PROFILE_NAME": name},
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        pending[name] = port
    except Exception as exc:
        print(f"[profile-restore] failed to launch {name}: {exc}")

deadline = time.time() + 20
while pending and time.time() < deadline:
    for name, port in list(pending.items()):
        with socket.socket() as sock:
            sock.settimeout(0.5)
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                pending.pop(name, None)
    if pending:
        time.sleep(0.5)

if pending:
    print("[profile-restore] profile gateways still warming: " + ", ".join(sorted(pending)))
PY
`
    : "";
}

function buildAgentComposeContent(params: BuildAgentComposeContentParams): string {
  const {
    params: deployParams,
    instanceId,
    containerName,
    agentBuildBlock,
    rootModeEntrypointServiceLine,
    rootModeEntrypointVolumeLine,
    hermesHomeDir,
    shellHomeDir,
    cpuLimit,
    ramLimit,
    agentRuntimeImage,
    hindsightVolumeLine,
    authStoreVolumeLines,
    needsLegacyOptDataMirror,
    isRootEnabled,
    terminalExecUser,
    terminalShellCwd,
    terminalTuiCwd,
    ramBurstMb,
  } = params;

  return `# hermes-deploy-root-access: ${isRootEnabled ? "enabled" : "disabled"}
services:
  agent:
${agentBuildBlock}    container_name: ${containerName}
${rootModeEntrypointServiceLine}    command: ["gateway", "run"]
    restart: unless-stopped
    env_file: .env
    environment:
      - HERMES_HOME=${hermesHomeDir}
      - HOME=${shellHomeDir}
${isRootEnabled ? "      - HERMES_ALLOW_ROOT_GATEWAY=1\n" : ""}    networks:
      - hermes_net
    deploy:
      resources:
        limits:
          cpus: '${cpuLimit}'
          memory: '${ramBurstMb && ramBurstMb > ramLimit ? ramBurstMb : ramLimit}M'
${isRootEnabled ? '    privileged: true\n    user: root' : ''}
    volumes:
${rootModeEntrypointVolumeLine}      - ./.env:${hermesHomeDir}/.env
      - ./config.yaml:${hermesHomeDir}/config.yaml
      - ./SOUL.md:${hermesHomeDir}/SOUL.md
      - ./honcho.json:${hermesHomeDir}/honcho.json
${hindsightVolumeLine}${authStoreVolumeLines}${needsLegacyOptDataMirror ? `      - ./.env:/opt/data/.env
      - ./config.yaml:/opt/data/config.yaml
      - ./SOUL.md:/opt/data/SOUL.md
      - ./honcho.json:/opt/data/honcho.json
` : ''}${isRootEnabled ? '      - /var/run/docker.sock:/var/run/docker.sock\n' : ''}      - agent-memories:${hermesHomeDir}/memories
      - agent-sessions:${hermesHomeDir}/sessions
      - agent-logs:${hermesHomeDir}/logs
      - agent-audio:${hermesHomeDir}/audio_cache
      - agent-image:${hermesHomeDir}/image_cache
      - agent-profiles:${hermesHomeDir}/profiles
${needsLegacyOptDataMirror ? '      - agent-profiles:/opt/data/profiles\n' : ''}\
${deployParams.agentSettings?.mountPersistentSource ? `      - agent-source:${hermesHomeDir}/hermes-agent\n` : ''}    expose:
      - "8642"
      - "8650-8670"
    init: true

  agent-web:
    image: ${agentRuntimeImage}
    container_name: ${containerName}-web
${rootModeEntrypointServiceLine}    command: ["dashboard", "--host", "0.0.0.0", "--no-open", "--insecure", "--tui"]
    restart: unless-stopped
    env_file: .env
    environment:
      - HERMES_HOME=${hermesHomeDir}
      - HOME=${shellHomeDir}
      - GATEWAY_HEALTH_URL=http://${containerName}:8642
      - HERMES_DASHBOARD_TUI=1
    depends_on:
      - agent
    networks:
      - hermes_net
${isRootEnabled ? '    privileged: true\n    user: root' : ''}
    volumes:
${rootModeEntrypointVolumeLine}      - ./.env:${hermesHomeDir}/.env
      - ./config.yaml:${hermesHomeDir}/config.yaml
      - ./SOUL.md:${hermesHomeDir}/SOUL.md
      - ./honcho.json:${hermesHomeDir}/honcho.json
${hindsightVolumeLine}${authStoreVolumeLines}${needsLegacyOptDataMirror ? `      - ./.env:/opt/data/.env
      - ./config.yaml:/opt/data/config.yaml
      - ./SOUL.md:/opt/data/SOUL.md
      - ./honcho.json:/opt/data/honcho.json
` : ''}      - agent-memories:${hermesHomeDir}/memories
      - agent-sessions:${hermesHomeDir}/sessions
      - agent-logs:${hermesHomeDir}/logs
      - agent-profiles:${hermesHomeDir}/profiles
${needsLegacyOptDataMirror ? '      - agent-profiles:/opt/data/profiles\n' : ''}\
    expose:
      - "9119"
    init: true

${deployParams.a2aSettings?.enableAcp ? `  agent-acp:
    image: ${agentRuntimeImage}
    container_name: ${containerName}-acp
${rootModeEntrypointServiceLine}    command: ["python3", "${hermesHomeDir}/a2a_bridge.py", "8643", "acp"]
    restart: unless-stopped
    env_file: .env
    environment:
      - HERMES_HOME=${hermesHomeDir}
      - HOME=${shellHomeDir}
    networks:
      - hermes_net
${isRootEnabled ? '    privileged: true\n    user: root' : ''}
    volumes:
${rootModeEntrypointVolumeLine}      - ./.env:${hermesHomeDir}/.env
${authStoreVolumeLines}      - ./a2a_bridge.py:${hermesHomeDir}/a2a_bridge.py
      - ./honcho.json:${hermesHomeDir}/honcho.json
${hindsightVolumeLine}      - agent-memories:${hermesHomeDir}/memories
      - agent-sessions:${hermesHomeDir}/sessions
      - agent-logs:${hermesHomeDir}/logs
    expose:
      - "8643"
    init: true
` : ""}${deployParams.a2aSettings?.enableMcp ? `  agent-mcp:
    image: ${agentRuntimeImage}
    container_name: ${containerName}-mcp
${rootModeEntrypointServiceLine}    command: ["python3", "${hermesHomeDir}/a2a_bridge.py", "8644", "mcp"]
    restart: unless-stopped
    env_file: .env
    environment:
      - HERMES_HOME=${hermesHomeDir}
      - HOME=${shellHomeDir}
    networks:
      - hermes_net
${isRootEnabled ? '    privileged: true\n    user: root' : ''}
    volumes:
${rootModeEntrypointVolumeLine}      - ./.env:${hermesHomeDir}/.env
${authStoreVolumeLines}      - ./a2a_bridge.py:${hermesHomeDir}/a2a_bridge.py
      - ./honcho.json:${hermesHomeDir}/honcho.json
${hindsightVolumeLine}      - agent-memories:${hermesHomeDir}/memories
      - agent-sessions:${hermesHomeDir}/sessions
      - agent-logs:${hermesHomeDir}/logs
    expose:
      - "8644"
    init: true
` : ""}

  sidecar:
    image: node:22-alpine
    container_name: ${containerName}-sidecar
    command: >
      sh -c "
      apk add --no-cache docker-cli ca-certificates util-linux python3 2>/dev/null;
      node /opt/data/server.js
      "
    restart: unless-stopped
    environment:
      - INSTANCE_ID=${instanceId}
      - API_SERVER_KEY=${deployParams.apiServerKey}
      - DASHBOARD_UPSTREAM_URL=http://${containerName}-web:9119
      - HOST_PROFILES_DIR=/profiles
      - MAIN_ENV_FILE=/opt/data/.env
      - TERMINAL_EXEC_USER=${terminalExecUser}
      - TERMINAL_CWD=${terminalShellCwd}
      - TERMINAL_SHELL_CWD=${terminalShellCwd}
      - TERMINAL_TUI_CWD=${terminalTuiCwd}
    networks:
      - hermes_net
    volumes:
      - ./sidecar_server.js:/opt/data/server.js
      - ./.env:/opt/data/.env
      - ./w:/opt/data/w
      - agent-profiles:/profiles
      - /var/run/docker.sock:/var/run/docker.sock
    expose:
      - "9090"

volumes:
  agent-memories:
    name: "${instanceId}_agent-memories"
    external: true
  agent-sessions:
    name: "${instanceId}_agent-sessions"
    external: true
  agent-logs:
    name: "${instanceId}_agent-logs"
    external: true
  agent-audio:
    name: "${instanceId}_agent-audio"
    external: true
  agent-image:
    name: "${instanceId}_agent-image"
    external: true
  agent-profiles:
    name: "${instanceId}_agent-profiles"
    external: true
${deployParams.agentSettings?.mountPersistentSource ? `  agent-source:
    name: "${instanceId}_agent-source"
    external: true
` : ''}
networks:
  hermes_net:
    external: true
`;
}

function buildA2ABridgeCode(): string {
  return `import asyncio, os, sys, subprocess
try: import websockets
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "websockets"])
    import websockets

port = int(sys.argv[1])
cmd_name = sys.argv[2]
auth_token = os.environ.get("API_SERVER_KEY")

async def handler(websocket, path):
    auth_header = websocket.request_headers.get("Authorization", "")
    query = path.split("?")[1] if "?" in path else ""
    if auth_token and auth_header != f"Bearer {auth_token}" and f"token={auth_token}" not in query:
        await websocket.close(1008, "Unauthorized")
        return

    cmd = ["hermes", cmd_name]
    if cmd_name == "mcp": cmd.extend(["serve"])

    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr)

    async def read_stdout():
        try:
            while True:
                line = await asyncio.get_event_loop().run_in_executor(None, proc.stdout.readline)
                if not line: break
                await websocket.send(line.decode('utf-8'))
        except Exception: pass

    async def write_stdin():
        try:
            async for msg in websocket:
                proc.stdin.write(msg.encode('utf-8') + b'\\n')
                proc.stdin.flush()
        except Exception: pass

    await asyncio.gather(read_stdout(), write_stdin())
    proc.terminate()

start_server = websockets.serve(handler, "0.0.0.0", port)
asyncio.get_event_loop().run_until_complete(start_server)
asyncio.get_event_loop().run_forever()`;
}

export function buildSslipPlaceholderResolutionScript(fqdn: string): string {
  return fqdn === "0-0-0-0.sslip.io"
    ? `
# Dynamic IP resolution for new hosts to fix 0-0-0-0.sslip.io placeholder
echo "Resolving public IP dynamically for 0-0-0-0.sslip.io placeholder..."
PUBLIC_IP=$(curl -s http://169.254.169.254/hetzner/v1/metadata/public-ipv4 || curl -s ifconfig.me)
if [ -n "$PUBLIC_IP" ]; then
  REAL_FQDN="$(echo $PUBLIC_IP | tr '.' '-').sslip.io"
  echo "Replacing placeholder with actual FQDN: $REAL_FQDN"
  sed -i "s/0-0-0-0\\\\.sslip\\\\.io/$REAL_FQDN/g" .env Caddyfile docker-compose.yml || true
fi
`
    : "";
}

function buildRootModeDeployGuardScript(isRootEnabled: boolean): string {
  return isRootEnabled
    ? `test -x root-mode-entrypoint.sh || { echo "FATAL: root-mode-entrypoint.sh missing for root access deployment" >&2; exit 1; }
grep -Fq 'entrypoint: ["/bin/bash", "/opt/hermes/docker/root-mode-entrypoint.sh"]' docker-compose.yml || { echo "FATAL: docker-compose.yml missing root-mode entrypoint for root access deployment" >&2; exit 1; }
grep -Fq './root-mode-entrypoint.sh:/opt/hermes/docker/root-mode-entrypoint.sh:ro' docker-compose.yml || { echo "FATAL: docker-compose.yml missing root-mode entrypoint mount for root access deployment" >&2; exit 1; }
`
    : "";
}

function buildAuthStoreInjectionScript(params: {
  enabled: boolean;
  authStoreRuntimeContainers: string[];
  hermesHomeDir: string;
  needsLegacyOptDataMirror: boolean;
}): string {
  if (!params.enabled) {
    return "";
  }

  const containers = params.authStoreRuntimeContainers.join(" ");

  return `# Inject Hermes auth.json into the container's writable filesystem.
for container_name in ${containers}; do
  for i in 1 2 3 4 5; do
    if docker inspect --format='{{.State.Running}}' "$container_name" 2>/dev/null | grep -q true; then break; fi
    sleep 2
  done
done
if [ -f auth.json.inject ]; then
  restarted_containers=""
  for container_name in ${containers}; do
    if ! docker inspect --format='{{.State.Running}}' "$container_name" 2>/dev/null | grep -q true; then
      continue
    fi
    docker cp auth.json.inject "$container_name:${params.hermesHomeDir}/auth.json" || true
    docker exec -u root "$container_name" sh -lc 'touch ${params.hermesHomeDir}/auth.lock 2>/dev/null || true${params.hermesHomeDir === "/opt/data" ? " && chown hermes:hermes /opt/data/auth.json /opt/data/auth.lock 2>/dev/null || true && chmod 600 /opt/data/auth.json /opt/data/auth.lock 2>/dev/null || true" : ""}' || true
${params.needsLegacyOptDataMirror ? `    docker cp auth.json.inject "$container_name:/opt/data/auth.json" || true
    docker exec -u root "$container_name" sh -lc 'touch /opt/data/auth.lock 2>/dev/null || true && chown hermes:hermes /opt/data/auth.json /opt/data/auth.lock 2>/dev/null || true && chmod 600 /opt/data/auth.json /opt/data/auth.lock 2>/dev/null || true' || true
` : ''}    restarted_containers="$restarted_containers $container_name"
  done
  rm -f auth.json.inject
  restarted_containers="\${restarted_containers# }"
  [ -n "$restarted_containers" ] && docker restart $restarted_containers 2>/dev/null || true
fi
`;
}

export function buildAgentDeployScript(params: BuildAgentDeployScriptParams): string {
  const { instanceId, containerName, cpuLimit, ramLimit, globalSettings } = params;
  const ghcrToken = (params.ghcrToken ?? "").trim();
  // Render the docker-login block only when the caller supplied a token.
  // Embedding the literal token in user_data is what blew the Hetzner
  // 32 KB cloud-init budget when env-derived strings of variable length
  // crept in (cf. the regression test guarding VERCEL_GIT_COMMIT_SHA).
  // Empty/missing token → render nothing; production keeps working
  // because the dashboard runtime always passes a value.
  const ghcrLoginBlock = ghcrToken
    ? `echo "${ghcrToken}" | docker login ghcr.io -u __token__ --password-stdin 2>/dev/null || true\n`
    : "";
  const hostTimeSyncRepairScript =
    params.includeHostTimeSyncRepair === false ? "" : buildHostTimeSyncRepairScript();

  const envLines = buildHermesEnvLines({ ...params, containerName }).join("\n");
  const hermesImage = env("HERMES_DOCKER_IMAGE", "ghcr.io/ashneil12/vanilla-hermes-agent:latest");
  const agentMemoryOverlay = buildAgentMemoryOverlay({ hermesImage, memorySystem: params.memorySystem });
  const honchoMemorySystem = params.memorySystem?.provider === "honcho" ? params.memorySystem : undefined;
  const normalizedHonchoMemoryMode: HonchoSettings["memoryMode"] = honchoMemorySystem?.honchoMemoryMode === "honcho"
    ? "honcho"
    : "hybrid";
  const normalizedHonchoRecallMode: HonchoSettings["recallMode"] =
    honchoMemorySystem?.honchoRecallMode === "context" || honchoMemorySystem?.honchoRecallMode === "tools"
      ? honchoMemorySystem.honchoRecallMode
      : "hybrid";
  const honchoSettings: HonchoSettings | undefined = honchoMemorySystem
    ? {
        ...params.honchoSettings,
        enabled: params.honchoSettings?.enabled ?? true,
        ...(Object.prototype.hasOwnProperty.call(honchoMemorySystem, "honchoApiKey")
          ? { apiKey: honchoMemorySystem.honchoApiKey?.trim() || undefined }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(honchoMemorySystem, "honchoBaseUrl")
          ? { baseUrl: honchoMemorySystem.honchoBaseUrl?.trim() || undefined }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(honchoMemorySystem, "honchoMemoryMode")
          ? { memoryMode: normalizedHonchoMemoryMode }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(honchoMemorySystem, "honchoRecallMode")
          ? { recallMode: normalizedHonchoRecallMode }
          : {}),
      }
    : params.honchoSettings;
  const honchoConfig = buildHonchoConfig(honchoSettings);
  const isRootEnabled = params.agentSettings?.enableRootAccess === true;
  const hermesHomeDir = resolveHermesHomeDir(isRootEnabled);
  const shellHomeDir = isRootEnabled ? "/root" : "/opt/data";
  const terminalExecUser = resolveTerminalExecUser(isRootEnabled);
  const terminalShellCwd = resolveTerminalCwd({
    enableRootAccess: isRootEnabled,
    mountPersistentSource: params.agentSettings?.mountPersistentSource,
    mode: "shell",
  });
  const terminalTuiCwd = resolveTerminalCwd({
    enableRootAccess: isRootEnabled,
    mountPersistentSource: params.agentSettings?.mountPersistentSource,
    mode: "tui",
  });
  const agentRuntimeImage = agentMemoryOverlay.enabled
    ? `${containerName}-memory-runtime:local`
    : hermesImage;
  const needsComposeBuild = Boolean(agentMemoryOverlay.enabled);
  const hindsightConfigContent = agentMemoryOverlay.hindsightConfigContent;
  const hindsightVolumeLine = hindsightConfigContent
    ? `      - ./hindsight:${hermesHomeDir}/hindsight\n`
    : "";
  const agentBuildBlock = agentMemoryOverlay.enabled
    ? `    build:\n      context: .\n      dockerfile: Dockerfile.agent-memory\n    image: ${agentRuntimeImage}\n`
    : `    image: ${hermesImage}\n`;
  const needsLegacyOptDataMirror = hermesHomeDir !== "/opt/data";
  const shouldInjectHermesAuthStore = supportsHermesAuthStore(params.provider);
  const authStoreRuntimeContainers = shouldInjectHermesAuthStore
    ? [
        `agent-${instanceId}`,
        `agent-${instanceId}-web`,
        ...(params.a2aSettings?.enableAcp ? [`agent-${instanceId}-acp`] : []),
        ...(params.a2aSettings?.enableMcp ? [`agent-${instanceId}-mcp`] : []),
      ]
    : [];
  const rootModeEntrypointContent = isRootEnabled ? buildRootModeEntrypointScript() : "";
  const rootRuntimeContainers = isRootEnabled
    ? [
        containerName,
        `${containerName}-web`,
        ...(params.a2aSettings?.enableAcp ? [`${containerName}-acp`] : []),
        ...(params.a2aSettings?.enableMcp ? [`${containerName}-mcp`] : []),
      ]
    : [];
  const rootModeEntrypointServiceLine = isRootEnabled
    ? '    entrypoint: ["/bin/bash", "/opt/hermes/docker/root-mode-entrypoint.sh"]\n'
    : "";
  const rootModeEntrypointVolumeLine = isRootEnabled
    ? '      - ./root-mode-entrypoint.sh:/opt/hermes/docker/root-mode-entrypoint.sh:ro\n'
    : "";
  const authStoreContent = shouldInjectHermesAuthStore
    ? (isCodexAuthProvider(params.provider)
        ? (params.codexAuthBundle
            ? buildCodexHermesAuthStore(params.codexAuthBundle)
            : `${JSON.stringify({ version: 1, providers: {} }, null, 2)}\n`)
        : (params.nousAuthBundle
            ? buildNousHermesAuthStore(params.nousAuthBundle)
            : `${JSON.stringify({ version: 1, providers: {} }, null, 2)}\n`))
    : "";
  const authStoreVolumeLines = "";

  const envFileContent = `${envLines}\nHERMES_DASHBOARD_URL=${env("NEXT_PUBLIC_APP_URL", "https://hivra.cloud")}\nHERMES_SUBDOMAIN=${params.fqdn}\n`;
  const managedEnvKeysContent = `${Object.keys(buildManagedEnvResetMap()).join("\n")}\n`;
  const honchoFileContent = honchoConfig || "{}";
  const configYamlContent = buildAgentConfigYaml({
    provider: params.provider,
    model: params.model,
    unconfigured: params.unconfigured,
    bankr: params.bankr,
    agentSettings: params.agentSettings,
    memorySystem: params.memorySystem,
    globalSettings,
  });

  const a2aBridgeCode = buildA2ABridgeCode();

  const caddyfileContent = buildAgentCaddyfile(
    params.fqdn,
    containerName,
    params.a2aSettings,
    params.profileRoutes
  );
  const profileRestoreScript = buildProfileRestoreScript({
    containerName,
    profilesToRestore: params.profilesToRestore,
    hermesHomeDir,
  });
  const sslipPlaceholderResolutionScript = buildSslipPlaceholderResolutionScript(params.fqdn);
  const rootModeDeployGuardScript = buildRootModeDeployGuardScript(isRootEnabled);
  const authStoreInjectionScript = buildAuthStoreInjectionScript({
    enabled: shouldInjectHermesAuthStore,
    authStoreRuntimeContainers,
    hermesHomeDir,
    needsLegacyOptDataMirror,
  });

  const composeContent = buildAgentComposeContent({
    params,
    instanceId,
    containerName,
    agentBuildBlock,
    rootModeEntrypointServiceLine,
    rootModeEntrypointVolumeLine,
    hermesHomeDir,
    shellHomeDir,
    cpuLimit,
    ramLimit,
    agentRuntimeImage,
    hindsightVolumeLine,
    authStoreVolumeLines,
    needsLegacyOptDataMirror,
    isRootEnabled,
    terminalExecUser,
    terminalShellCwd,
    terminalTuiCwd,
    ramBurstMb: params.ramBurstMb,
  });

  return collapseBlankLineRuns(`
mkdir -p /opt/hermes/instances/${instanceId}
cd /opt/hermes/instances/${instanceId}
:>w

${ghcrLoginBlock}
${hostTimeSyncRepairScript}

${renderEmbeddedFileWrite(".env.new", envFileContent)}
${renderEmbeddedFileWrite(".managed-env-keys", managedEnvKeysContent)}
if [ -f .env ]; then
  awk -F= 'NR==FNR {managed[$1]=1; next} /^[A-Za-z_][A-Za-z0-9_]*=/ && !managed[$1]' .managed-env-keys .env > .env.legacy
  awk -F= 'NR==FNR {a[$1]=1; next} /^[A-Za-z_][A-Za-z0-9_]*=/ && !a[$1]' .env.new .env.legacy >> .env.new
  rm -f .env.legacy
fi
rm -f .managed-env-keys
mv .env.new .env
${renderEmbeddedFileWrite("config.yaml", configYamlContent)}
${renderEmbeddedFileWrite("sidecar_server.js", HETZNER_BOOTSTRAP_SIDECAR_SERVER_CODE)}
${params.agentSettings?.systemPrompt ? renderEmbeddedFileWrite("SOUL.md", params.agentSettings.systemPrompt) : "touch SOUL.md"}
${renderEmbeddedFileWrite("honcho.json", honchoFileContent)}
${agentMemoryOverlay.dockerfileContent ? `${renderEmbeddedFileWrite("Dockerfile.agent-memory", agentMemoryOverlay.dockerfileContent)}
` : ""}${hindsightConfigContent ? `mkdir -p hindsight
${renderEmbeddedFileWrite("hindsight/config.json", hindsightConfigContent)}
` : ""}${isRootEnabled ? `${renderEmbeddedFileWrite("root-mode-entrypoint.sh", rootModeEntrypointContent, { chmod: "+x" })}
` : ""}${shouldInjectHermesAuthStore ? `${renderEmbeddedFileWrite("auth.json.inject", authStoreContent)}
` : ""}

${params.a2aSettings?.enableAcp || params.a2aSettings?.enableMcp ? renderEmbeddedFileWrite("a2a_bridge.py", a2aBridgeCode) : ""}

${renderEmbeddedFileWrite("Caddyfile", caddyfileContent)}

${renderEmbeddedFileWrite("docker-compose.yml", composeContent)}

${sslipPlaceholderResolutionScript}

${buildHermesBindMountedRuntimeFileOwnershipScript({ enableRootAccess: isRootEnabled })}
${agentMemoryOverlay.enabled ? `docker pull ${hermesImage}
` : `docker compose pull agent
`}${buildHermesWritableVolumeInitScript({
  instanceId,
  hermesImage,
  mountPersistentSource: params.agentSettings?.mountPersistentSource,
  enableRootAccess: isRootEnabled,
})}
${rootModeDeployGuardScript}docker compose up -d --remove-orphans ${needsComposeBuild ? "--build" : ""}
${buildHostCaddyReloadScript()}
${buildRootDeveloperToolBootstrapScript(rootRuntimeContainers)}
${buildBindMountedConfigPatchScript([containerName, `${containerName}-web`])}

${authStoreInjectionScript}

${profileRestoreScript}
${buildAutoUpdateTimerProvisioningScript({
  instanceId,
  containerName,
  autoUpdate: params.autoUpdate,
  agentSettings: params.agentSettings,
  memorySystem: params.memorySystem,
  hermesImage,
  apiServerKey: params.apiServerKey,
  dashboardUrl: globalSettings?.dashboardUrl,
  includeHostTimeSyncInstallFallback: params.includeHostTimeSyncRepair !== false,
})}
`);
}

export function buildProviderEnv(provider: string, apiKey: string, customLlmBaseUrl?: string): string[] {
  switch (provider) {
    case "openrouter":
      return [`HERMES_INFERENCE_PROVIDER=openrouter`, `OPENROUTER_API_KEY=${apiKey}`];
    case "openai":
      return [`HERMES_INFERENCE_PROVIDER=custom`, `OPENAI_API_KEY=${apiKey}`, `OPENAI_BASE_URL=${resolveProviderBaseUrl(provider)!}`];
    case "bankr":
      return [`HERMES_INFERENCE_PROVIDER=custom`, `OPENAI_API_KEY=${apiKey}`, `OPENAI_BASE_URL=${resolveProviderBaseUrl(provider)!}`];
    case "venice": {
      const baseUrl = resolveProviderBaseUrl(provider, customLlmBaseUrl)!;
      return [
        `HERMES_INFERENCE_PROVIDER=custom`,
        `OPENAI_API_KEY=${apiKey}`,
        `OPENAI_BASE_URL=${baseUrl}`,
        `VENICE_API_KEY=${apiKey}`,
        `VENICE_BASE_URL=${baseUrl}`,
      ];
    }
    case "cometapi":
      return [`HERMES_INFERENCE_PROVIDER=custom`, `OPENAI_API_KEY=${apiKey}`, `OPENAI_BASE_URL=${resolveProviderBaseUrl(provider)!}`];
    case "surplus":
      return [`HERMES_INFERENCE_PROVIDER=custom`, `OPENAI_API_KEY=${apiKey}`, `OPENAI_BASE_URL=${resolveProviderBaseUrl(provider)!}`];
    case "codex":
      return [`HERMES_INFERENCE_PROVIDER=openai-codex`];
    case "anthropic":
      return [`HERMES_INFERENCE_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=${apiKey}`];
    case "nous":
    case "nous-portal":
      return apiKey
        ? [`HERMES_INFERENCE_PROVIDER=custom`, `OPENAI_API_KEY=${apiKey}`, `OPENAI_BASE_URL=${resolveProviderBaseUrl(provider)!}`]
        : [`HERMES_INFERENCE_PROVIDER=custom`, `OPENAI_BASE_URL=${resolveProviderBaseUrl(provider)!}`];
    case "crof":
      return [`HERMES_INFERENCE_PROVIDER=custom`, `OPENAI_API_KEY=${apiKey}`, `OPENAI_BASE_URL=${resolveProviderBaseUrl(provider)!}`];
    case "opengateway":
      return [
        `HERMES_INFERENCE_PROVIDER=custom`,
        `OPENAI_API_KEY=${apiKey || "gitlawb-open"}`,
        `OPENAI_BASE_URL=${resolveProviderBaseUrl(provider)!}`,
      ];
    case "deepseek":
      return [`HERMES_INFERENCE_PROVIDER=deepseek`, `DEEPSEEK_API_KEY=${apiKey}`];
    case "minimax":
      return [`HERMES_INFERENCE_PROVIDER=minimax`, `MINIMAX_API_KEY=${apiKey}`];
    case "groq":
      return [`HERMES_INFERENCE_PROVIDER=custom`, `OPENAI_API_KEY=${apiKey}`, `OPENAI_BASE_URL=${resolveProviderBaseUrl(provider)!}`];
    case "gemini":
      return [
        `HERMES_INFERENCE_PROVIDER=custom`,
        `OPENAI_API_KEY=${apiKey}`,
        `GEMINI_API_KEY=${apiKey}`,
        `OPENAI_BASE_URL=${resolveProviderBaseUrl(provider)!}`,
      ];
    case "moonshot":
      return [
        `HERMES_INFERENCE_PROVIDER=kimi-coding`,
        `KIMI_API_KEY=${apiKey}`,
        `KIMI_BASE_URL=${resolveKimiBaseUrlForKey(apiKey)}`,
      ];
    case "xai":
      return [`HERMES_INFERENCE_PROVIDER=custom`, `OPENAI_API_KEY=${apiKey}`, `OPENAI_BASE_URL=${resolveProviderBaseUrl(provider)!}`];
    case "zhipu":
      return [`HERMES_INFERENCE_PROVIDER=zai`, `GLM_API_KEY=${apiKey}`];
    case "alibaba":
      return [
        `HERMES_INFERENCE_PROVIDER=alibaba`,
        `DASHSCOPE_API_KEY=${apiKey || "sk-dummy"}`,
        `DASHSCOPE_BASE_URL=https://coding-intl.dashscope.aliyuncs.com/v1`,
      ];
    case "xiaomi":
      return [`HERMES_INFERENCE_PROVIDER=xiaomi`, `XIAOMI_API_KEY=${apiKey}`];
    default:
      return [`HERMES_INFERENCE_PROVIDER=openrouter`, `OPENROUTER_API_KEY=${apiKey}`];
  }
}

function resolveKimiBaseUrlForKey(apiKey: string): string {
  return apiKey.trim().startsWith("sk-kimi-")
    ? "https://api.kimi.com/coding"
    : "https://api.moonshot.ai/v1";
}

const PROVIDER_ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_BASE_URL",
  "VENICE_API_KEY",
  "VENICE_BASE_URL",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "MINIMAX_API_KEY",
  "KIMI_API_KEY",
  "KIMI_BASE_URL",
  "GLM_API_KEY",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE_URL",
  "XIAOMI_API_KEY",
] as const;

export function buildProviderEnvResetMap(): Record<string, string> {
  return Object.fromEntries(PROVIDER_ENV_KEYS.map((key) => [key, ""]));
}

const MANAGED_RUNTIME_ENV_KEYS = [
  "API_SERVER_ENABLED",
  "API_SERVER_HOST",
  "API_SERVER_PORT",
  "API_SERVER_KEY",
  "API_SERVER_CORS_ORIGINS",
  "HERMES_MODEL",
  "HERMES_SKIP_SETUP",
  "HERMES_TIMEZONE",
  "HERMES_EXEC_ASK",
  "PROFILE_NAME",
  "HERMES_MAX_ITERATIONS",
  "HERMES_TOOL_PROGRESS",
  "HERMES_COMPRESSION_THRESHOLD",
  "HERMES_SESSION_RESET_MODE",
  "HERMES_BROWSER_PROVIDER",
  "CAMOFOX_URL",
  "BROWSERBASE_API_KEY",
  "BROWSERBASE_PROJECT_ID",
  "BROWSER_USE_API_KEY",
  "TAVILY_API_KEY",
  "EXA_API_KEY",
  "FIRECRAWL_API_KEY",
  "DAYTONA_API_KEY",
  "HERMES_HEARTBEAT_MODEL",
  "HONCHO_API_KEY",
  "HONCHO_BASE_URL",
  "MEM0_API_KEY",
  "MEM0_USER_ID",
  "MEM0_AGENT_ID",
  "HINDSIGHT_API_KEY",
  "HINDSIGHT_MODE",
  "HINDSIGHT_BANK_ID",
  "HINDSIGHT_BUDGET",
  "HINDSIGHT_LLM_API_KEY",
  "OPENVIKING_ENDPOINT",
  "OPENVIKING_API_KEY",
  "RETAINDB_API_KEY",
  "RETAINDB_BASE_URL",
  "RETAINDB_PROJECT",
  "BRV_API_KEY",
  "SUPERMEMORY_API_KEY",
  "SUPERMEMORY_CONTAINER_TAG",
  "HERMES_DASHBOARD_URL",
  "HERMES_SUBDOMAIN",
  "API_KEY",
  "LLM_API_KEY",
  "MODEL",
  "PROVIDER",
  "LLM_PROVIDER",
  "HERMES_SUBAGENT_MODEL",
] as const;

const MANAGED_ENV_KEYS = [...PROVIDER_ENV_KEYS, ...MANAGED_RUNTIME_ENV_KEYS] as const;

export function buildManagedEnvResetMap(): Record<string, string> {
  return Object.fromEntries(MANAGED_ENV_KEYS.map((key) => [key, ""]));
}

export function buildHermesEnvLines(params: {
  containerName: string;
  apiServerKey: string;
  provider: string;
  apiKey?: string;
  model?: string;
  /**
   * Clean-slate BYOK (deploy-card Managed=OFF): seed NO provider env and NO
   * HERMES_MODEL so the agent boots unconfigured and its onboarding overlay fires.
   * Without this, an empty key + the reconciled openrouter default model bakes a
   * model name with no credential → "No LLM provider configured".
   */
  unconfigured?: boolean;
  agentSettings?: AgentSettings;
  honchoSettings?: HonchoSettings;
  memorySystem?: MemorySystemConfig;
}): string[] {
  const { containerName, provider, apiKey, model, agentSettings } = params;
  const normalizedModel = model ? normalizeModelValue(model, provider) : "";
  const apiServerKey = params.apiServerKey && params.apiServerKey !== "undefined"
    ? params.apiServerKey
    : randomBytes(32).toString("hex");
  const ms = params.memorySystem;
  const shouldIncludeProviderEnv =
    !params.unconfigured &&
    Boolean(provider) && (Boolean(apiKey) || supportsHermesAuthStore(provider));

  const memoryEnvLines: string[] = [];
  if (ms) {
    switch (ms.provider) {
      case "honcho":
        if (ms.honchoApiKey) memoryEnvLines.push(`HONCHO_API_KEY=${ms.honchoApiKey}`);
        if (ms.honchoBaseUrl) memoryEnvLines.push(`HONCHO_BASE_URL=${ms.honchoBaseUrl}`);
        break;
      case "mem0":
        if (ms.mem0ApiKey) memoryEnvLines.push(`MEM0_API_KEY=${ms.mem0ApiKey}`);
        if (ms.mem0UserId) memoryEnvLines.push(`MEM0_USER_ID=${ms.mem0UserId}`);
        if (ms.mem0AgentId) memoryEnvLines.push(`MEM0_AGENT_ID=${ms.mem0AgentId}`);
        break;
      case "hindsight":
        if (ms.hindsightApiKey) memoryEnvLines.push(`HINDSIGHT_API_KEY=${ms.hindsightApiKey}`);
        if (ms.hindsightMode) memoryEnvLines.push(`HINDSIGHT_MODE=${normalizeHindsightMode(ms.hindsightMode)}`);
        if (ms.hindsightBankId) memoryEnvLines.push(`HINDSIGHT_BANK_ID=${ms.hindsightBankId}`);
        if (ms.hindsightBudget) memoryEnvLines.push(`HINDSIGHT_BUDGET=${ms.hindsightBudget}`);
        if (ms.hindsightLlmApiKey) memoryEnvLines.push(`HINDSIGHT_LLM_API_KEY=${ms.hindsightLlmApiKey}`);
        break;
      case "openviking":
        if (ms.openVikingEndpoint) memoryEnvLines.push(`OPENVIKING_ENDPOINT=${ms.openVikingEndpoint}`);
        if (ms.openVikingApiKey) memoryEnvLines.push(`OPENVIKING_API_KEY=${ms.openVikingApiKey}`);
        break;
      case "retaindb":
        if (ms.retaindbApiKey) memoryEnvLines.push(`RETAINDB_API_KEY=${ms.retaindbApiKey}`);
        if (ms.retaindbBaseUrl) memoryEnvLines.push(`RETAINDB_BASE_URL=${ms.retaindbBaseUrl}`);
        if (ms.retaindbProject) memoryEnvLines.push(`RETAINDB_PROJECT=${ms.retaindbProject}`);
        break;
      case "byterover":
        if (ms.brvApiKey) memoryEnvLines.push(`BRV_API_KEY=${ms.brvApiKey}`);
        break;
      case "supermemory":
        if (ms.supermemoryApiKey) memoryEnvLines.push(`SUPERMEMORY_API_KEY=${ms.supermemoryApiKey}`);
        if (ms.supermemoryContainerTag) memoryEnvLines.push(`SUPERMEMORY_CONTAINER_TAG=${ms.supermemoryContainerTag}`);
        break;
      case "holographic":
        break;
    }
  }

  return [
    `API_SERVER_ENABLED=true`,
    `API_SERVER_HOST=0.0.0.0`,
    `API_SERVER_PORT=8642`,
    `API_SERVER_KEY=${apiServerKey}`,
    `API_SERVER_CORS_ORIGINS=*`,
    ...(shouldIncludeProviderEnv ? buildProviderEnv(provider, apiKey || "", agentSettings?.customLlmBaseUrl) : []),
    ...(!params.unconfigured && normalizedModel ? [`HERMES_MODEL=${normalizedModel}`] : []),
    `HERMES_SKIP_SETUP=1`,
    ...(agentSettings?.tavilyApiKey ? [`TAVILY_API_KEY=${agentSettings.tavilyApiKey}`] : []),
    ...(agentSettings?.exaApiKey ? [`EXA_API_KEY=${agentSettings.exaApiKey}`] : []),
    ...(agentSettings?.firecrawlApiKey ? [`FIRECRAWL_API_KEY=${agentSettings.firecrawlApiKey}`] : []),
    ...(agentSettings?.daytonaApiKey ? [`DAYTONA_API_KEY=${agentSettings.daytonaApiKey}`] : []),
    ...(params.honchoSettings?.heartbeatModel ? [`HERMES_HEARTBEAT_MODEL=${params.honchoSettings.heartbeatModel}`] : []),
    `HERMES_TIMEZONE=UTC`,
    `HERMES_EXEC_ASK=false`,
    `PROFILE_NAME=default`,
    ...(agentSettings ? [
      `HERMES_MAX_ITERATIONS=${agentSettings.maxIterations}`,
      `HERMES_TOOL_PROGRESS=${agentSettings.toolProgressMode}`,
      `HERMES_COMPRESSION_THRESHOLD=${agentSettings.compressionThreshold}`,
      `HERMES_SESSION_RESET_MODE=${agentSettings.sessionResetMode}`,
      `HERMES_BROWSER_PROVIDER=${agentSettings.browserProvider || "local"}`,
      ...(agentSettings.browserbaseApiKey ? [`BROWSERBASE_API_KEY=${agentSettings.browserbaseApiKey}`] : []),
      ...(agentSettings.browserbaseProjectId ? [`BROWSERBASE_PROJECT_ID=${agentSettings.browserbaseProjectId}`] : []),
      ...(agentSettings.browserUseApiKey ? [`BROWSER_USE_API_KEY=${agentSettings.browserUseApiKey}`] : []),
    ] : []),
    ...memoryEnvLines,
  ];
}

export function buildHonchoConfig(settings?: HonchoSettings): string | null {
  if (!settings) return null;

  const apiKey = settings.apiKey?.trim();
  const baseUrl = settings.baseUrl?.trim();
  const peerName = settings.peerName?.trim();
  const aiPeer = settings.aiPeer?.trim() || "hermes";
  const memoryMode = settings.memoryMode || "hybrid";
  const recallMode = settings.recallMode || "hybrid";

  if (!apiKey && !baseUrl) {
    return null;
  }

  const config: Record<string, unknown> = {
    hosts: {
      hermes: {
        workspace: "hermes",
        aiPeer,
        memoryMode,
        recallMode,
        enabled: settings.enabled,
      },
    },
  };

  if (apiKey) {
    config.apiKey = apiKey;
  }

  if (baseUrl) {
    config.baseUrl = baseUrl;
  }

  if (peerName) {
    const hosts = config.hosts as { hermes: Record<string, unknown> };
    hosts.hermes.peerName = peerName;
  }

  return JSON.stringify(config, null, 2);
}
