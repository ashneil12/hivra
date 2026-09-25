import { BROWSER_SIDECAR_MIN_RAM_MB } from "@/lib/browser-sidecar/deployment-gate";
import { DEFAULT_WAKE_ORIGIN } from "@/lib/services/caddy-wake-fallback";
import type { InstanceBackend } from "@/lib/services/hetzner-instance-service";
import {
  buildHostCaddyfile,
  buildHostTimeSyncRepairScript,
} from "@/lib/services/hetzner-instance-builders";
import {
  assertSupportedProxmoxGatewayHost,
  buildProxmoxGatewayCaddySite,
  isCoveredByProxmoxStaticOriginCert,
} from "@/lib/services/proxmox-gateway-caddy-site";
import {
  buildHermesBrowserSidecarCacheCleanupFunction,
  buildHermesDockerImageCleanupFunctions,
  buildHermesMemoryGuardProvisioningScript,
  buildHermesTaggedImageCleanupFunctions,
} from "@/lib/services/webui-instance-builder";
import { isWebfreeBackend } from "@/lib/types/instance";
import { buildVmidReferenceLedgerScript, type VmidReferenceLedger } from "@/lib/proxmox/vmid-reference-ledger";
import {
  buildEnsureQemuGuestAgentChannelScript,
  buildHermesVmidBoundGuestSshPrelude,
  buildPinnedGuestSshReadinessWait,
} from "@/lib/proxmox/hermes-guest-ssh";

/**
 * Pure host-side bash/Python script generators for Proxmox guests.
 *
 * Extracted verbatim from proxmox-instance-service.ts so the orchestration
 * module reads as orchestration rather than a 2k-line string literal wall.
 * Everything here is side-effect free: same inputs, byte-identical output.
 */
/**
 * Balloon floor for a VM booting at `memoryMb`.
 *
 * Elastic floors (RAM burst / PROXMOX_VM_BALLOON_FLOOR_MB) stay allowed so
 * a fat host can reclaim unused guest RAM. A sidecar-sized ceiling must
 * never be balloon-starved below BROWSER_SIDECAR_MIN_RAM_MB. Jarvis
 * (fixturenodea/1200) booted memory=4096 / balloon=1024, the guest only saw
 * ~843 MB, and the sidecar exited 0 forever.
 */
export function resolveProxmoxBalloonFloorMb(
  memoryMb: number,
  balloonFloorMb?: number,
): number {
  const memory = Math.max(64, Math.floor(memoryMb));
  const raw =
    balloonFloorMb !== undefined && balloonFloorMb > 0
      ? Math.min(Math.max(64, Math.floor(balloonFloorMb)), memory)
      : memory;
  if (memory >= BROWSER_SIDECAR_MIN_RAM_MB) {
    return Math.max(raw, BROWSER_SIDECAR_MIN_RAM_MB);
  }
  return raw;
}
export const DEFAULT_PROXMOX_VM_DISK_GB = 30;
export function shQuote(value: string | number): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
export function buildProxmoxGuestBootstrapScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Block until cloud-init's first-boot work is done. The template ships
# with \`package_upgrade: true\`, so cloud-init runs apt-get on first boot
# and holds /var/lib/apt/lists/lock for a few minutes. SSH frequently
# comes up before that finishes, and DPkg::Lock::Timeout below covers
# the dpkg lock but NOT the apt-lists lock — so apt-get update would die
# instantly with "Could not get lock /var/lib/apt/lists/lock" and Phase 2
# would tear the VM down. Cap the wait so a broken cloud-init can't hang
# bootstrap forever.
#
# Exit codes from \`cloud-init status --wait\`:
#   0   → done cleanly
#   2   → "degraded done" — recoverable errors during cloud-init (e.g. the
#         in-cloud-init apt-update returned non-zero on a flaky mirror) but
#         cloud-init is FINISHED and has released its locks. Proceeding is
#         correct — our own run_apt_get retries below will fix what
#         cloud-init couldn't. Treating this as fatal was the regression
#         that left every freshly-cloned VM aborting after ~56s.
#   1   → unrecoverable cloud-init failure — abort.
#   124 → \`timeout\` killed cloud-init at 600s — abort.
ci_rc=0
timeout 600 cloud-init status --wait >/dev/null || ci_rc=$?
case "$ci_rc" in
  0|2) ;;
  *)
    echo "cloud-init exited with status $ci_rc — aborting bootstrap" >&2
    cloud-init status --long >&2 2>/dev/null || true
    exit 1
    ;;
esac

# apt-get's own DPkg::Lock::Timeout (apt 1.9.11+, in Debian Bullseye and
# every Ubuntu LTS we ship templates from) waits up to N seconds for the
# dpkg/frontend lock instead of failing immediately — BUT it does NOT wait
# on /var/lib/apt/lists/lock, the lock \`apt-get update\` itself needs. So
# even after \`cloud-init status --wait\` returns and releases cloud-init's
# own lock, an apt-daily / unattended-upgrades run fired by its systemd
# timer (independent of cloud-init) can still hold the lists lock, and our
# first \`apt-get update\` dies instantly with "Could not get lock
# /var/lib/apt/lists/lock" → bootstrap aborts under set -euo pipefail →
# Phase 2 tears the fresh-signup VM down. Observed on fixturenodea vmid 2031
# (2026-06-13). Three layers of defence:
#   (1) stop the apt-daily timers so no NEW auto-apt run starts mid-bootstrap
#       (restored on exit — long-term auto-update policy is unchanged);
#   (2) wait_for_apt_locks: poll the lists/dpkg locks until a run already in
#       flight releases them, before we touch apt;
#   (3) run_apt_get retries on failure, riding out a lock grabbed in the race
#       window between the wait and our own apt-get.
# We deliberately do NOT use fuser for the wait: fuser ships in psmisc which
# isn't on every minimal cloud image, and the old fuser-only wait silently
# no-op'd when absent (command-not-found → "! fuser" true) and let apt race.
# lslocks ships in util-linux (priority: required) on every template we use.
APT_LOCK_WAIT_SECONDS=300

# (1) Pause apt's periodic timers for the duration of bootstrap. Stop only
# the update service if one is mid-run (interrupting an in-flight
# \`apt-get update\` is safe — it just aborts a lists download); never
# force-kill apt-daily-upgrade.service (could interrupt dpkg mid-configure).
# Restored on EXIT, preserving the triggering exit status so a failed
# bootstrap still surfaces non-zero to Phase 2.
resume_apt_periodic() {
  _apt_resume_rc=$?
  systemctl start apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
  exit "$_apt_resume_rc"
}
trap resume_apt_periodic EXIT
systemctl stop apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true
timeout 120 systemctl stop apt-daily.service >/dev/null 2>&1 || true

# (2) "busy" (return 0) while any apt/dpkg lock is held. lslocks (util-linux)
# lists the paths of all held file locks; grep ours out of that. If lslocks
# is somehow absent we report "free" and fall back on the retry loop below
# rather than silently looping forever.
apt_locks_busy() {
  command -v lslocks >/dev/null 2>&1 || return 1
  local f
  for f in /var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock; do
    lslocks -no PATH 2>/dev/null | grep -qF "$f" && return 0
  done
  return 1
}

wait_for_apt_locks() {
  local waited=0
  while apt_locks_busy; do
    if [ "$waited" -ge "$APT_LOCK_WAIT_SECONDS" ]; then
      echo "apt/dpkg locks still held after $APT_LOCK_WAIT_SECONDS s; proceeding (run_apt_get will retry)" >&2
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
}

# (3) DPkg::Lock::Timeout covers the dpkg lock; the retry loop covers the
# lists lock (which it does not) by waiting it out between attempts.
run_apt_get() {
  local attempt=1
  local rc=0
  while [ "$attempt" -le 4 ]; do
    rc=0
    apt-get -o DPkg::Lock::Timeout="$APT_LOCK_WAIT_SECONDS" "$@" && return 0 || rc=$?
    if [ "$attempt" -ge 4 ]; then
      echo "run_apt_get: 'apt-get $*' failed after $attempt attempts (rc=$rc)" >&2
      return "$rc"
    fi
    echo "run_apt_get: 'apt-get $*' failed (rc=$rc, attempt $attempt/4); waiting for apt locks before retry" >&2
    wait_for_apt_locks
    sleep 10
    attempt=$((attempt + 1))
  done
  return "$rc"
}

wait_for_apt_locks
run_apt_get update -qq
run_apt_get install -y --no-install-recommends curl ca-certificates qemu-guest-agent
systemctl enable --now qemu-guest-agent >/dev/null 2>&1 || true

${buildHostTimeSyncRepairScript({
  aptUpdateCommand: "run_apt_get update -qq",
  aptInstallCommand: "run_apt_get install -y --no-install-recommends",
  // Point timesyncd at the pve host (default gateway), which now runs
  // chrony on vmbr1. Without this, NTP replies get black-holed by the
  // host's conntrack on older pve hosts and the VM is stranded on its
  // boot-time clock — see incident 2026-05-14 (Rdeweerd's VM, 13.6h drift).
  seedLocalNtp: true,
})}

mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/hermes-lean-vm.conf << 'JOURNALDEOF'
[Journal]
SystemMaxUse=50M
RuntimeMaxUse=25M
MaxRetentionSec=3day
JOURNALDEOF
systemctl restart systemd-journald >/dev/null 2>&1 || true
systemctl enable --now fstrim.timer >/dev/null 2>&1 || true
${buildHermesMemoryGuardProvisioningScript()}

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

mkdir -p /etc/docker
cat > /etc/docker/daemon.json << 'DOCKEREOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "20m",
    "max-file": "3"
  }
}
DOCKEREOF
if systemctl is-active docker >/dev/null 2>&1; then
  systemctl restart docker
else
  systemctl enable --now docker >/dev/null 2>&1 || true
fi

if ! docker compose version >/dev/null 2>&1; then
  run_apt_get update -qq
  run_apt_get install -y docker-compose-plugin
fi

docker network create hermes_net >/dev/null 2>&1 || true
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

volumes:
  caddy_data:
  caddy_config:

networks:
  hermes_net:
    external: true
COMPOSEEOF

# Note: no host-level compute-cap gate is installed here. hermes-warden
# (the per-box daily-compute-cap enforcer) was decommissioned fleet-wide
# (2026-07); POST /api/chat/start is a plain reverse_proxy everywhere now.

docker compose pull caddy
docker compose up -d caddy

# ── Disk cleanup timer ────────────────────────────────────────────────
# Per-instance Proxmox guest VM, so this is a single-tenant cleanup.
# Crucially we do NOT pass --volumes to \`docker system prune\`: if the
# user (or our own update flow) ever has the webui container stopped
# when this fires, --volumes would happily nuke webui-state,
# webui-workspace, and agent-source — i.e. their entire chat history,
# saved profiles, and workspace files. We remove dangling images by ID
# because Docker's time-filtered image prune missed real dead Hermes layers
# in production; tagged unused Hermes images still keep a 24h rollback window.
cat > /usr/local/bin/hermes-disk-cleanup << 'CLEANUPEOF'
#!/bin/bash
set -u
LOG="/var/log/hermes-disk-cleanup.log"
exec >> "$LOG" 2>&1
echo "=== Disk Cleanup: $(date) ==="

${buildHermesDockerImageCleanupFunctions()}
${buildHermesTaggedImageCleanupFunctions()}
${buildHermesBrowserSidecarCacheCleanupFunction()}

docker container prune -f --filter "until=24h" 2>/dev/null | tail -1
prune_dangling_docker_images
prune_old_unused_hermes_agent_images
docker builder prune -f --filter "until=24h" 2>/dev/null | tail -1
docker network prune -f 2>/dev/null | tail -1
ctr -n moby content prune references 2>/dev/null && echo "containerd content pruned" || true
journalctl --vacuum-size=50M 2>/dev/null | tail -1
apt-get clean -qq 2>/dev/null
find /var/log -name '*.gz' -mtime +3 -delete 2>/dev/null
find /var/log -name '*.1' -mtime +3 -delete 2>/dev/null
find /var/lib/docker/containers -name '*-json.log' -type f -size +100M -exec truncate -s 0 {} \\; 2>/dev/null || true
find /tmp /var/tmp -mindepth 1 -xdev -mtime +2 \\
  ! -path '/tmp/systemd-private-*' \\
  ! -path '/var/tmp/systemd-private-*' \\
  -exec rm -rf {} + 2>/dev/null || true

DISK_PCT=$(df / --output=pcent | tail -1 | tr -dc '0-9')
if [ "$DISK_PCT" -gt 85 ] 2>/dev/null; then
  echo "WARN: Disk at \${DISK_PCT}% — running aggressive (still volume-safe) prune"
  docker image prune -af 2>/dev/null | tail -1
  docker builder prune -af 2>/dev/null | tail -1
  ctr -n moby content prune references 2>/dev/null || true
  # Relief valve: a ballooned browser-sidecar Chrome cache is the usual culprit
  # at this disk level. Cache-only prune (cookies/logins/profile preserved).
  prune_browser_sidecar_cache
fi
if [ "$DISK_PCT" -gt 90 ] 2>/dev/null; then
  echo "CRITICAL: Disk at \${DISK_PCT}% after cleanup"
  date -Iseconds > /var/log/hermes-disk-pressure.warn
else
  rm -f /var/log/hermes-disk-pressure.warn
fi

fstrim -av 2>/dev/null | tail -5 || true

if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

echo "Disk after cleanup: $(df -h / | tail -1)"
echo ""
CLEANUPEOF
chmod +x /usr/local/bin/hermes-disk-cleanup

cat > /etc/systemd/system/hermes-disk-cleanup.service << 'SVCEOF'
[Unit]
Description=Hermes disk cleanup (Docker, logs)

[Service]
Type=oneshot
ExecStart=/usr/local/bin/hermes-disk-cleanup
Nice=19
IOSchedulingClass=idle
SVCEOF

cat > /etc/systemd/system/hermes-disk-cleanup.timer << 'TIMEREOF'
[Unit]
Description=Run Hermes disk cleanup every 6 hours

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
export function buildProxmoxInfrastructureDiscoveryScript(params: {
  vmName: string;
}): string {
  return `#!/usr/bin/env bash
set -euo pipefail
VM_NAME=${shQuote(params.vmName)}

VMID="$(qm list | awk -v name="$VM_NAME" 'NR>1 && $2 == name { print $1; exit }')"
if [ -z "$VMID" ]; then
  echo "HERMES_PROXMOX_DISCOVERY missing"
  exit 0
fi

ipconfig="$(qm config "$VMID" 2>/dev/null | sed -n 's/^ipconfig0: //p' | head -n1)"
private_ip="$(printf '%s\\n' "$ipconfig" | sed -n 's/.*ip=\\([^,\\/]*\\).*/\\1/p')"
if [ -z "$private_ip" ]; then
  echo "HERMES_PROXMOX_DISCOVERY invalid"
  exit 0
fi

printf 'HERMES_PROXMOX_DISCOVERY {"vmid":%s,"privateIpv4":"%s"}\\n' "$VMID" "$private_ip"
`;
}
// Shell pipeline (prints one VMID per line) for every VMID that still owns a
// `vm-<vmid>-*` logical volume on the host. A crashed `qm clone` can leave
// vm-<vmid>-cloudinit / vm-<vmid>-disk-* LVs behind WITHOUT an /etc/pve
// qemu-server config. `qm list` only sees VMs that have a config, so the
// allocator would keep re-picking that VMID and every later clone would die
// "lvcreate 'vg0/vm-<vmid>-cloudinit' error: ... already exists" — a silent
// doom-loop that broke ~5 fresh signups on 2026-06-13 (vmid 1246 on fixturenodea)
// until the leftover LVs were lvremove'd by hand. Folding LV-owning VMIDs into
// the "claimed" set makes the allocator skip them. Scans every VG (LVs are
// named the same regardless of pool). Best-effort: callers wrap with `|| true`
// so an lvs failure prints nothing and falls back to the qm-list+DB behaviour.
const PROXMOX_ORPHAN_LV_VMID_SCAN =
  `lvs --noheadings -o lv_name 2>/dev/null | sed -n 's/^[[:space:]]*vm-\\([0-9][0-9]*\\)-.*/\\1/p' | sort -u`;
// Bash helper injected into both Phase 1 and Phase 2 provision scripts: remove
// any leftover `vm-<vmid>-*` logical volumes for a VMID across all VGs.
// `qm destroy --purge` only removes LVs it can resolve from the VM's config, so
// when a clone dies mid-way (or the config is otherwise gone) the cloudinit /
// disk LVs survive and doom-loop the allocator (see PROXMOX_ORPHAN_LV_VMID_SCAN
// — incident 2026-06-13, vmid 1246 on fixturenodea). Callers must already own the VMID
// claim. Best-effort: never fails the cleanup trap it runs inside.
const PROXMOX_REMOVE_VMID_LVS_FN = `hermes_remove_vmid_lvs() {
  _hrvl_vmid="\$1"
  [ -n "\$_hrvl_vmid" ] || return 0
  lvs --noheadings -o vg_name,lv_name 2>/dev/null | awk -v id="\$_hrvl_vmid" '\$2 ~ ("^vm-" id "-") {print \$1 "/" \$2}' | while read -r _hrvl_lvpath; do
    [ -n "\$_hrvl_lvpath" ] || continue
    lvremove -f "\$_hrvl_lvpath" >/dev/null 2>&1 || true
  done || true
  return 0
}`;
/**
 * Docker control inside a tenant VM is root-equivalent for that guest. Before
 * enabling it, require the Proxmox host's east-west bridge firewall to be both
 * active and persisted. This is intentionally a host-side guard: checking
 * inside the guest cannot prove that another VM on the same bridge is
 * unreachable.
 */
export function buildProxmoxTenantIsolationGuard(
  persistentConfigPath = "/etc/nftables.conf"
): string {
  return `# Docker-in-guest requires an active, persistent cross-tenant boundary.
TENANT_ISOLATION_CONFIG=${shQuote(persistentConfigPath)}
if ! command -v nft >/dev/null 2>&1; then
  echo "host $(hostname) cannot enable guest Docker access: nft is unavailable" >&2
  exit 1
fi
if ! systemctl is-enabled --quiet nftables; then
  echo "host $(hostname) cannot enable guest Docker access: nftables is not enabled" >&2
  exit 1
fi
if ! systemctl is-active --quiet nftables; then
  echo "host $(hostname) cannot enable guest Docker access: nftables is not active" >&2
  exit 1
fi

hermes_require_tenant_isolation_chain() {
  _tenant_chain_output="$1"
  _tenant_chain_source="$2"
  if [ -z "$_tenant_chain_output" ]; then
    echo "host $(hostname) cannot enable guest Docker access: $_tenant_chain_source forward chain is absent" >&2
    return 1
  fi
  # Rule text in an ordinary/unhooked chain is inert. Require nft's canonical
  # base-chain declaration so these drops are actually on the bridge forward
  # path.
  if ! printf '%s\n' "$_tenant_chain_output" | grep -Eq 'type[[:space:]]+filter[[:space:]]+hook[[:space:]]+forward([[:space:];]|$)'; then
    echo "host $(hostname) cannot enable guest Docker access: $_tenant_chain_source chain is not hooked to bridge forward" >&2
    return 1
  fi
  for tenant_isolation_rule in \
    'iifname "tap*" oifname "tap*" drop' \
    'iifname "fwln*" oifname "fwln*" drop' \
    'iifname "tap*" oifname "fwln*" drop' \
    'iifname "fwln*" oifname "tap*" drop'
  do
    if ! printf '%s\n' "$_tenant_chain_output" | grep -Fq "$tenant_isolation_rule"; then
      echo "host $(hostname) cannot enable guest Docker access: $_tenant_chain_source tenant-isolation rule is missing: $tenant_isolation_rule" >&2
      return 1
    fi
  done
}

active_tenant_isolation_chain="$(nft list chain bridge hermes_vm_isolation forward 2>/dev/null || true)"
if ! hermes_require_tenant_isolation_chain "$active_tenant_isolation_chain" "active"; then
  exit 1
fi

if [ ! -f "$TENANT_ISOLATION_CONFIG" ]; then
  echo "host $(hostname) cannot enable guest Docker access: $TENANT_ISOLATION_CONFIG is absent" >&2
  exit 1
fi
if ! command -v unshare >/dev/null 2>&1; then
  echo "host $(hostname) cannot enable guest Docker access: unshare is unavailable for persistent firewall validation" >&2
  exit 1
fi
# Load the service-persisted config into a disposable network namespace and
# ask nft for the resulting chain. This ignores comments by construction and
# proves the saved rules create the same hooked base chain without touching the
# host's live ruleset.
if ! persistent_tenant_isolation_chain="$(
  unshare --net sh -c '
    set -eu
    nft -f "$1" >/dev/null
    nft list chain bridge hermes_vm_isolation forward
  ' sh "$TENANT_ISOLATION_CONFIG" 2>/dev/null
)"; then
  echo "host $(hostname) cannot enable guest Docker access: persisted nftables config does not load the tenant-isolation forward chain" >&2
  exit 1
fi
if ! hermes_require_tenant_isolation_chain "$persistent_tenant_isolation_chain" "persisted"; then
  exit 1
fi
echo "HERMES_TENANT_ISOLATION_READY"
`;
}
export function buildProxmoxProvisionScript(params: {
  instanceId: string;
  vmName: string;
  templateId: number;
  vmidStart: number;
  vmidEnd: number;
  ipLastOctetStart: number;
  privateSubnetPrefix: string;
  privateCidr: number;
  privateGateway: string;
  nameserver: string;
  cores: number;
  cpuLimit?: number;
  memoryMb: number;
  /** Optional minimum guaranteed RAM (MB) for `--balloon`. When set lower than
   *  `memoryMb`, Proxmox can dynamically reclaim guest RAM down to this floor
   *  under host memory pressure. Omit (or set equal to memoryMb) for the
   *  legacy fully-pinned allocation. */
  balloonFloorMb?: number;
  diskSizeGb?: number;
  deployScript: string;
  vmSshUser: string;
  vmSshKeyPath: string;
  gatewayHost: string;
  /**
   * Deprecated. Cloudflare-proxied hostnames still need a normal HTTPS Caddy
   * site label because the production zone connects to origins with TLS. An
   * http:// label makes Caddy HTTP-only and causes Cloudflare 525 at startup.
   */
  gatewayHttpOnly?: boolean;
  caddySitesDir: string;
  apiServerKey: string;
  /** Dashboard origin, e.g. https://hermesos.cloud. When set, the
   *  per-instance Caddy site emits CORS headers for browser requests
   *  from this origin; when omitted we emit the plain bearer-only
   *  config. */
  dashboardOrigin?: string;
  backend?: InstanceBackend;
  /** VMIDs claimed by other non-deleted DB rows on this Proxmox node. The
   *  in-VM picker skips both `qm list` occupants AND this list so two
   *  concurrent provisions can't race for a VMID that `qm list` shows free
   *  but a stranded `(proxmox_node, proxmox_vmid)` row still owns at DB
   *  level — that race surfaced as `post_provision_proxmox_metadata_conflict_active`
   *  for ~25 users before this guard. */
  reservedVmids?: ReadonlyArray<number>;
  /** Cross-plane host ledger: publish this plane's references, skip other planes'. */
  vmidLedger?: VmidReferenceLedger | null;
  /** Require the host's active and persistent tenant firewall before this VM
   * receives root-equivalent control of its own Docker daemon. */
  requireTenantIsolation?: boolean;
}): string {
  const deployB64 = Buffer.from(params.deployScript, "utf8").toString("base64");
  const bootstrapB64 = Buffer.from(buildProxmoxGuestBootstrapScript(), "utf8").toString("base64");
  const backend: InstanceBackend = params.backend === "webui" ? "webui" : "gateway";
  const diskSizeGb = Number.isFinite(params.diskSizeGb)
    ? Math.max(1, Math.floor(params.diskSizeGb ?? DEFAULT_PROXMOX_VM_DISK_GB))
    : DEFAULT_PROXMOX_VM_DISK_GB;
  // Readiness probe differs by stack:
  //   webfree (webui|gateway): the per-instance dashboard answers on :80. Since
  //     the Jun-2026 auth-hardening /health sits BEHIND the login gate, so it
  //     302-redirects to /login?next=/health — a bare GET never returns 200.
  //     We therefore follow redirects (-L) and accept any 2xx/3xx/401/403 as
  //     ready: every one of those proves Caddy + the dashboard are up and
  //     routing, which is all readiness needs to confirm before the signed
  //     handoff (which does its own auth). This mirrors isHandoffProbeReachable
  //     in webui-login-url/route.ts. Demanding a bare 200 here made EVERY new
  //     webfree box fail readiness for 600s and get torn down by the Phase 2
  //     cleanup trap while perfectly healthy. The heavy webfree boot still needs
  //     the 300-attempt (~10min) budget.
  //   legacy (dormant): /v1/models on the gateway requires the API_SERVER_KEY
  //     bearer and returns 200 directly; ~2min budget. No backend value reaches
  //     this branch post-collapse.
  const readinessProbe =
    isWebfreeBackend(backend)
      ? `curl -sSL --max-time 5 -o "/tmp/hermes-proxmox-\${VMID}.health" -w '%{http_code}' "http://\${PRIVATE_IP}/health" 2>/dev/null || true`
      : `curl -sS --max-time 5 -o "/tmp/hermes-proxmox-\${VMID}.models" -w '%{http_code}' -H "Authorization: Bearer \${API_SERVER_KEY}" "http://\${PRIVATE_IP}/v1/models" 2>/dev/null || true`;
  const readinessProbeArtifact =
    isWebfreeBackend(backend) ? "health" : "models";
  // Shell `case` glob of HTTP codes that count as ready. Webfree: any
  // 2xx/3xx/401/403 (server up + routing, auth-gated or not). Legacy: strictly
  // 200 (a 401 there means a bad bearer, not readiness).
  const readinessReadyPattern =
    isWebfreeBackend(backend) ? "2[0-9][0-9]|3[0-9][0-9]|401|403" : "200";
  const readinessAttempts = isWebfreeBackend(backend) ? 300 : 60;
  const readinessIntervalSeconds = 2;
  // The deploy and every later guest SSH call are bound to the new VMID: the
  // host reads the guest's SSH host key through the QEMU Guest Agent (which the
  // bootstrap installs) and pins SSH to it. Phase 2 has no request deadline, so
  // it waits up to ~2 min (12 x 5s ping + 5s sleep) for the agent to answer.
  const phase2GuestSshPrelude = buildHermesVmidBoundGuestSshPrelude({
    sshUser: params.vmSshUser,
    agentAttempts: 12,
    callerOwnsExitTrap: true,
  });
  const phase2PinnedSshReadiness = buildPinnedGuestSshReadinessWait({ attempts: 6, sleepSeconds: 5 });
  assertSupportedProxmoxGatewayHost(params.gatewayHost);
  const gatewayCaddySite = buildProxmoxGatewayCaddySite({
    gatewayHost: "\${GATEWAY_SITE_LABEL}",
    privateIp: "\${PRIVATE_IP}",
    instanceId: params.instanceId,
    dashboardOrigin: params.dashboardOrigin ? "\${DASHBOARD_ORIGIN}" : "",
    wakeRedirectUrl: "\${WAKE_REDIRECT_URL}",
    useStaticOriginTls: isCoveredByProxmoxStaticOriginCert(params.gatewayHost),
  });

  return `#!/usr/bin/env bash
set -euo pipefail

# Serialize provisions with a mkdir-based mutex. We deliberately avoid flock(1)
# here: flock keeps the lock file open as a file descriptor, child processes
# (qm -> kvm) inherit it, and POSIX file locks survive exec(2). Once any kvm
# inherits the lock fd, the lock cannot be released until that VM exits, which
# deadlocks every subsequent provision. mkdir leaves no fd behind.
HERMES_PROXMOX_LOCK_DIR=/run/lock/hermes-proxmox-provision.lock.d
HERMES_PROXMOX_LOCK_DEADLINE=$((SECONDS + 600))
while ! mkdir "$HERMES_PROXMOX_LOCK_DIR" 2>/dev/null; do
  if [ -d "$HERMES_PROXMOX_LOCK_DIR" ]; then
    holder_pid="$(cat "$HERMES_PROXMOX_LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "$holder_pid" ] && ! kill -0 "$holder_pid" 2>/dev/null; then
      rm -rf "$HERMES_PROXMOX_LOCK_DIR"
      continue
    fi
  fi
  if [ "$SECONDS" -ge "$HERMES_PROXMOX_LOCK_DEADLINE" ]; then
    echo "Timed out waiting for hermes-proxmox provision lock" >&2
    exit 1
  fi
  sleep 1
done
echo "$$" > "$HERMES_PROXMOX_LOCK_DIR/pid"
trap 'rm -rf "$HERMES_PROXMOX_LOCK_DIR"' EXIT

bash <<'HERMES_PROXMOX_LOCKED'
set -euo pipefail

INSTANCE_ID=${shQuote(params.instanceId)}
VM_NAME=${shQuote(params.vmName)}
TEMPLATE_ID=${shQuote(params.templateId)}
VMID_START=${shQuote(params.vmidStart)}
VMID_END=${shQuote(params.vmidEnd)}
# Newline-separated VMIDs already claimed in the dashboard DB by other
# non-deleted rows on this Proxmox node. The picker treats these as
# occupied even when \`qm list\` shows the slot free — a stranded row's
# Proxmox-side VM may have been destroyed long ago while its
# (proxmox_node, proxmox_vmid) DB columns still hold a unique-key lock.
# Without this guard the picker reuses the VMID, \`qm clone\` succeeds,
# then the post-provision UPDATE 23505s and the user is stranded.
RESERVED_VMIDS=${shQuote((params.reservedVmids ?? []).map(String).join("\n"))}
IP_LAST_OCTET_START=${shQuote(params.ipLastOctetStart)}
PRIVATE_SUBNET_PREFIX=${shQuote(params.privateSubnetPrefix)}
PRIVATE_CIDR=${shQuote(params.privateCidr)}
PRIVATE_GATEWAY=${shQuote(params.privateGateway)}
NAMESERVER=${shQuote(params.nameserver)}
CORES=${shQuote(params.cores)}
CPU_LIMIT=${shQuote(Math.max(0.1, params.cpuLimit ?? params.cores))}
MEMORY_MB=${shQuote(params.memoryMb)}
BALLOON_FLOOR_MB=${shQuote(
    resolveProxmoxBalloonFloorMb(params.memoryMb, params.balloonFloorMb)
  )}
DISK_SIZE_GB=${shQuote(diskSizeGb)}
DEPLOY_B64=${shQuote(deployB64)}
BOOTSTRAP_B64=${shQuote(bootstrapB64)}
VM_SSH_USER=${shQuote(params.vmSshUser)}
VM_SSH_KEY_PATH=${shQuote(params.vmSshKeyPath)}
GATEWAY_HOST=${shQuote(params.gatewayHost)}
GATEWAY_SITE_LABEL=${shQuote(params.gatewayHost)}
CADDY_SITES_DIR=${shQuote(params.caddySitesDir)}
API_SERVER_KEY=${shQuote(params.apiServerKey)}
READINESS_ATTEMPTS=${shQuote(readinessAttempts)}
READINESS_INTERVAL_SECONDS=${shQuote(readinessIntervalSeconds)}
# Empty string when the dashboard origin isn't configured for this
# deployment. The Caddy site below skips the CORS headers when this
# is empty.
DASHBOARD_ORIGIN=${shQuote(params.dashboardOrigin || "")}
# Gateway auto-wake: where the vhost's 502 fallback sends browsers when this
# VM is parked (scale-to-zero). Prefer the deployment's dashboard origin;
# fall back to the canonical prod dashboard.
WAKE_REDIRECT_URL="\${DASHBOARD_ORIGIN:-${DEFAULT_WAKE_ORIGIN}}/wake/\${INSTANCE_ID}"

VMID=""
SITE_FILE=""
SSH_KNOWN_HOSTS_FILE=""
PHASE1_OK=0

mkdir -p /run/hermes-vm-claims

${PROXMOX_REMOVE_VMID_LVS_FN}

# Reload host Caddy with retry + auto-restart on dead service. Caddy's
# admin reload codepath has a known goroutine race ("panic: context:
# internal error: missing cancel error") that has crashed the host service
# under reload churn — when several provisions reload back-to-back, the
# 2nd or 3rd reload can panic the running daemon, leaving subsequent
# reloads to error out with "caddy.service is not active, cannot reload"
# and every public ingress gone. This helper validates first, then
# attempts reload up to three times, and falls back to systemctl start
# (with reset-failed) if the daemon is no longer running. Use the Caddy
# CLI directly instead of systemctl reload: when the daemon panics during
# ExecReload, systemd can keep the reload job stuck until its timeout even
# though Caddy is already gone, preventing this script from reaching the
# recovery branch.
hermes_caddy_reload() {
  # Older hosts may still carry systemd-provided Caddy environment values.
  # Pull the daemon's resolved env before validate so any temporary {env.X}
  # references surface consistently while the fleet finishes migrating to
  # static Cloudflare Origin CA files.
  if command -v systemctl >/dev/null 2>&1; then
    for kv in $(systemctl show caddy -p Environment --value 2>/dev/null); do
      [ -n "$kv" ] && export "$kv"
    done
  fi
  # Capture validate output so the actual reason (e.g. dangling cert symlink,
  # broken per-tenant site file, missing env token) surfaces through stderr
  # → SSH → orchestrator → dashboard banner. Without this the user only sees
  # the opaque "refusing to reload" line and has to SSH to the host to find
  # out what's actually wrong (see the fixturenodea wildcard-symlink incident on
  # 2026-05-17 where storage cleanup left dangling cert symlinks and every
  # welcome-flow deploy failed with no visible reason). Tail to 10 lines so
  # a long Caddyfile dump doesn't blow up the UI banner.
  #
  # The \`if !\` form is load-bearing: the surrounding LOCKED block runs
  # under \`set -euo pipefail\`, and a bare \`VAR=\$(cmd)\` assignment whose
  # command substitution exits non-zero is itself a failing simple command,
  # which trips errexit and kills the script BEFORE any subsequent rc
  # capture or echo runs. That was the regression in the prior shape that
  # captured the rc into a separate variable and tested it on the next
  # line — caddy-validate failures stopped producing ANY stderr and
  # surfaced to users as the opaque "Remote bash exited with code 1"
  # (incident 2026-05-17, ~6h of silent deploy failures). Inside an \`if\`
  # condition errexit is suppressed, so the assignment still happens (the
  # substitution populates VALIDATE_ERR before the non-zero exit propagates)
  # and we land in the failure branch with the captured output intact.
  if ! VALIDATE_ERR=$(timeout 20s caddy validate --config /etc/caddy/Caddyfile 2>&1); then
    echo "hermes_caddy_reload: invalid Caddyfile, refusing to reload" >&2
    printf '%s\n' "$VALIDATE_ERR" | tail -n 10 >&2
    return 1
  fi
  hermes_caddy_verify() {
    curl -ksS --max-time 5 --resolve "\${GATEWAY_HOST}:443:127.0.0.1" \
      -o /dev/null "https://\${GATEWAY_HOST}/"
  }
  if systemctl is-active caddy >/dev/null 2>&1; then
    for _ in 1 2 3; do
      if timeout 20s caddy reload --config /etc/caddy/Caddyfile --force >/dev/null 2>&1; then
        if hermes_caddy_verify; then return 0; fi
        echo "hermes_caddy_reload: reload completed but local TLS verification failed" >&2
        break
      fi
      if ! systemctl is-active caddy >/dev/null 2>&1; then break; fi
      sleep 2
    done
  fi
  # A daemon can remain systemd-active while its admin endpoint is wedged.
  # Exhausted bounded reloads therefore require a restart, not another
  # is-active check. Verify the data plane before reporting success.
  systemctl reset-failed caddy >/dev/null 2>&1 || true
  if ! systemctl restart caddy; then
    echo "hermes_caddy_reload: restart failed after bounded reload attempts" >&2
    return 1
  fi
  for _ in 1 2 3 4 5; do
    if hermes_caddy_verify; then
      return 0
    fi
    sleep 1
  done
  echo "hermes_caddy_reload: recovery verification failed" >&2
  return 1
}

# Phase 1 cleanup: tears down the partially-built VM if anything between
# VMID allocation and Phase 2 fork fails. Once Phase 1 sets PHASE1_OK=1,
# Phase 2 owns the VM lifecycle and has its own cleanup trap; this trap
# becomes a no-op so we don't kill a healthy VM on LOCKED's exit.
#
# The VMID claim file gates \`qm destroy\`. A failed prior provision's
# Phase 2 can wake up ~6 min later (after exhausting its SSH-wait loop)
# and try to clean up its old VMID — but VMIDs get recycled, so by then
# a healthy fresh tenant VM may be sitting at that VMID. The claim file
# names which provision currently owns the VMID; cleanup only destroys
# when the claim still names this provision.
cleanup_phase1() {
  exit_code="$1"
  if [ "$PHASE1_OK" = "0" ] && [ -n "$VMID" ]; then
    claim=$(cat "/run/hermes-vm-claims/$VMID.claim" 2>/dev/null || true)
    if [ "$claim" = "$INSTANCE_ID" ]; then
      qm stop "$VMID" --skiplock 1 >/dev/null 2>&1 || true
      qm destroy "$VMID" --purge 1 >/dev/null 2>&1 || true
      # Belt-and-braces after --purge: a clone that died before/while writing
      # the VM config leaves vm-<vmid>-cloudinit / vm-<vmid>-disk-* LVs that
      # --purge can't map (no config), and those orphans then doom-loop the
      # VMID allocator. Remove any leftover LVs for THIS vmid directly.
      hermes_remove_vmid_lvs "$VMID"
      rm -f "/run/hermes-vm-claims/$VMID.claim"
    fi
    if [ -n "$SITE_FILE" ]; then rm -f "$SITE_FILE"; fi
    hermes_caddy_reload >/dev/null 2>&1 || true
  fi
  if [ "$PHASE1_OK" = "0" ] && [ -n "$SSH_KNOWN_HOSTS_FILE" ]; then
    rm -f "$SSH_KNOWN_HOSTS_FILE"
  fi
  exit "$exit_code"
}
trap 'cleanup_phase1 "$?"' EXIT

# Verify the private bridge exists before we touch anything. When a
# Proxmox host reboots and \`vmbr1\` was only configured at runtime (not
# persisted into /etc/network/interfaces.d/), the bridge silently
# disappears — \`qm clone\` succeeds (the cloned config still names
# vmbr1) and \`qm start\` fails with "bridge 'vmbr1' does not exist".
# That surfaces in the dashboard as an opaque 500 with no host name, so
# every retry burns a VMID before failing. Checking here names the
# host in stderr so ops can fix the missing /etc/network/interfaces.d
# entry instead of chasing a generic error in ops_events. Incident
# 2026-05-17: fixturenodea+fixturenodea rebooted, vmbr1 was runtime-only on both, every
# new provision 500'd until the bridge was restored.
if ! ip link show vmbr1 >/dev/null 2>&1; then
  echo "host $(hostname) is missing private bridge vmbr1 — persist /etc/network/interfaces.d/vmbr1 and \\\`ifup vmbr1\\\` on the host before retrying" >&2
  exit 1
fi

${params.requireTenantIsolation ? buildProxmoxTenantIsolationGuard() : ""}

existing_vmids="$(qm list | awk 'NR>1 {print $1}')"
# Orphaned-LV guard: a crashed \`qm clone\` can leave vm-<vmid>-cloudinit /
# vm-<vmid>-disk-* logical volumes WITHOUT an /etc/pve qemu-server config.
# \`qm list\` only reports VMs that have a config, so without this the
# allocator would keep re-picking that VMID and every clone would fail
# "lvcreate 'vg0/vm-<vmid>-cloudinit' ... already exists" — a silent
# doom-loop that broke ~5 fresh signups on 2026-06-13 (vmid 1246, fixturenodea).
# Treat any VMID that still owns vm-<vmid>-* LVs as claimed so we skip it.
# Best-effort: an lvs failure prints nothing and we fall back to the
# qm-list + DB behaviour rather than blocking the whole provision.
orphan_lv_vmids="$(${PROXMOX_ORPHAN_LV_VMID_SCAN} || true)"
# Merge host-side (qm list) + DB-side (RESERVED_VMIDS) + orphan-LV claims so a
# single grep -qx pass covers all of them. RESERVED_VMIDS may be empty when the
# caller can't reach the DB; falling back to qm-list-only matches the legacy
# behaviour rather than failing the whole provision.
claimed_vmids="$existing_vmids"
if [ -n "$RESERVED_VMIDS" ]; then
  claimed_vmids="$(printf '%s\n%s\n' "$existing_vmids" "$RESERVED_VMIDS")"
fi
# VMIDs other control planes on this host still reference (their rows may
# outlive an out-of-band destroy), published to the shared host ledger.
${buildVmidReferenceLedgerScript(params.vmidLedger)}hivra_vmid_reference_sync
if [ -n "$HIVRA_FOREIGN_VMIDS" ]; then
  claimed_vmids="$(printf '%s\n%s\n' "$claimed_vmids" "$HIVRA_FOREIGN_VMIDS")"
fi
if [ -n "$orphan_lv_vmids" ]; then
  claimed_vmids="$(printf '%s\n%s\n' "$claimed_vmids" "$orphan_lv_vmids")"
fi
# Occupied last-octets from EVERY local VM, including guests whose VMID
# no longer matches 50+vmid-start (recreated boxes keep / steal an old
# IP). Skipping only free VMIDs is how 1217 cloned onto osideus .67.
used_octets="$(grep -h '^ipconfig0:' /etc/pve/qemu-server/*.conf 2>/dev/null | sed -n 's/.*ip=[0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*\\.\\([0-9][0-9]*\\).*/\\1/p' | sort -n | uniq || true)"
for candidate in $(seq "$VMID_START" "$VMID_END"); do
  if printf '%s\n' "$claimed_vmids" | grep -qx "$candidate"; then
    continue
  fi
  cand_last=$((IP_LAST_OCTET_START + candidate - VMID_START))
  if [ "$cand_last" -gt 254 ]; then
    continue
  fi
  if printf '%s\n' "$used_octets" | grep -qx "$cand_last"; then
    echo "Skipping VMID $candidate — last-octet $cand_last already assigned" >&2
    continue
  fi
  VMID="$candidate"
  break
done

if [ -z "$VMID" ]; then
  echo "No free Proxmox VMID in range \${VMID_START}-\${VMID_END}" >&2
  exit 1
fi
hivra_vmid_reference_record "$VMID"

# Stamp the VMID claim BEFORE the clone so the Phase 1 cleanup trap can tear
# down a clone that dies mid-way. Writing it only after \`qm start\` (as it was)
# meant a \`qm clone\`/\`qm start\` failure left the trap with an empty claim →
# no teardown → orphaned vm-<vmid>-* LVs with no config, which then doom-loop
# the allocator. The claim names THIS provision, so a stale prior-provision
# trap still can't destroy a recycled VMID.
printf '%s' "$INSTANCE_ID" > "/run/hermes-vm-claims/$VMID.claim"

IP_LAST=$((IP_LAST_OCTET_START + VMID - VMID_START))
if [ "$IP_LAST" -gt 254 ]; then
  echo "No free private IPv4 left for VMID $VMID with start octet $IP_LAST_OCTET_START" >&2
  exit 1
fi
PRIVATE_IP="\${PRIVATE_SUBNET_PREFIX}.\${IP_LAST}"
SSH_KNOWN_HOSTS_FILE="/tmp/hermes-proxmox-known-hosts-\${VMID}"
rm -f "$SSH_KNOWN_HOSTS_FILE"

# Linked clone (--full 0): instant for templates whose disks are on
# block storage like LVM-thin / ZFS / Ceph (a few seconds for the
# config-only copy, no GiB-scale data transfer). Falls back to a full
# clone if the storage doesn't support snapshots — qm refuses with a
# clear error in that case and we surface it.
#
# With the baked template (vmid 9001 — Docker + agent + WebUI + caddy
# images pre-pulled) full clones cost ~60s for the 20GB transfer alone,
# eating most of Vercel's 300s function budget before the bootstrap
# even starts. Linked clones drop that to ~3s.
qm clone "$TEMPLATE_ID" "$VMID" --name "$VM_NAME" --full 0
CURRENT_DISK_GB="$(qm config "$VMID" | sed -n 's/^scsi0: .*size=\\([0-9][0-9]*\\)G.*/\\1/p' | head -n1)"
if [ -z "$CURRENT_DISK_GB" ] || [ "$CURRENT_DISK_GB" -lt "$DISK_SIZE_GB" ]; then
  qm resize "$VMID" scsi0 "\${DISK_SIZE_GB}G"
fi
SCSI0_DISK="$(qm config "$VMID" | sed -n 's/^scsi0: \\([^,]*\\).*/\\1/p' | head -n1)"
if [ -n "$SCSI0_DISK" ]; then
  # aio=threads is required for UNMAP/TRIM to reach the LVM thin pool.
  # With Proxmox's default aio=io_uring, fstrim inside the guest reports
  # success but the thin pool never reclaims blocks (verified fixturenodea VMID
  # 9999, 2026-05-16). Without this flag tenants slowly fill the pool.
  qm set "$VMID" --scsi0 "$SCSI0_DISK,discard=on,aio=threads"
fi
qm set "$VMID" --cores "$CORES" --cpulimit "$CPU_LIMIT" --memory "$MEMORY_MB" --balloon "$BALLOON_FLOOR_MB"
qm set "$VMID" --ipconfig0 "ip=\${PRIVATE_IP}/\${PRIVATE_CIDR},gw=\${PRIVATE_GATEWAY}" --nameserver "$NAMESERVER" --onboot 1
# Phase 2 attests this VM's SSH host key through the QEMU Guest Agent before
# the deploy (which carries the box's secrets) goes over SSH. The agent's
# virtio channel only exists if it is configured before boot, so set it here
# whatever the template carries.
${buildEnsureQemuGuestAgentChannelScript()}
qm start "$VMID"

# (The VMID claim file was stamped right after allocation, before the clone,
# so the cleanup traps can own a clone/start that dies mid-way.)

# Outer-host Caddy site lands BEFORE Phase 2 runs so the moment the inner
# backend answers, the public hostname routes correctly. Writing it after
# bootstrap would create a window where the agent is up but the
# gateway host returns 502, looking to the dashboard like "still
# provisioning."
mkdir -p "$CADDY_SITES_DIR"
# Origin TLS: Cloudflare edge certs are browser-facing; Proxmox origins use
# a static Cloudflare Origin CA cert to avoid Let's Encrypt duplicate wildcard
# rate limits. Hosts must have these files seeded during standup. Do not
# regenerate the old DNS-01 wildcard minter here: fresh provisions run this
# block repeatedly and would reintroduce a CLOUDFLARE_API_TOKEN dependency into
# plain-shell caddy validate.
mkdir -p /etc/caddy/wildcards
CADDY_WILDCARD_CERT=/etc/caddy/wildcards/hermesos.cloud.crt
CADDY_WILDCARD_KEY=/etc/caddy/wildcards/hermesos.cloud.key
if [ ! -r "$CADDY_WILDCARD_CERT" ] || [ ! -r "$CADDY_WILDCARD_KEY" ]; then
  echo "[caddy] missing Cloudflare Origin CA cert/key at /etc/caddy/wildcards/hermesos.cloud.{crt,key}; seed the host before provisioning" >&2
  exit 1
fi
cat > /etc/caddy/Caddyfile <<MAINCADDY
{
  log {
    output file /var/log/caddy/access.log {
      roll_size 100mb
      roll_keep 5
    }
    format json
    level INFO
  }
}

# Cloudflare Origin CA wildcard cert for Cloudflare -> Proxmox origin TLS.
# Browsers see Cloudflare edge certificates; origins use this static cert to avoid
# Let's Encrypt duplicate wildcard rate limits during fleet expansion.
*.hermesos.cloud, hermesos.cloud {
  tls /etc/caddy/wildcards/hermesos.cloud.crt /etc/caddy/wildcards/hermesos.cloud.key
  respond "Hermes — unknown agent" 404
}

import \${CADDY_SITES_DIR}/*.caddy
MAINCADDY
SITE_FILE="\${CADDY_SITES_DIR}/\${GATEWAY_HOST}.caddy"
cat > "$SITE_FILE" <<CADDY
${gatewayCaddySite}
CADDY
hermes_caddy_reload

# Phase 1 done. Emit metadata so the orchestrator can persist the VM
# identity (vmid / privateIpv4 / gatewayHost) before Phase 2's long-running
# bootstrap. Historically this line was emitted ONLY after a synchronous
# full bootstrap (SSH-ready wait + apt + docker pull + agent setup +
# backend-ready wait — 3-7 minutes), which routinely exceeded Vercel's
# 300s function timeout. When Vercel killed the lambda mid-bootstrap, the
# instance row was left in DB with status='provisioning' and no
# gateway_url/proxmox_vmid forever — the agent had to be deleted by hand.
# Now the line lands well within the 300s budget; Phase 2 finishes async
# on the host. The dashboard's /api/instances/[id] poll picks up the new
# row, runs the gateway probe, and flips status to 'running' once the
# guest's /health endpoint answers.
# stdbuf -oL forces the spawned coreutils printf to use line-buffered
# stdio. Bash's builtin printf uses bash libc FILE* which defaults to
# fully-buffered when stdout is a pipe — so the kickoff line could sit in
# bash 4KB buffer until the LOCKED subshell exits, which by then can be
# many seconds later (the cat-heredoc capture for Phase 2 forks a child;
# the backgrounded line forks an inner bash). Vercel ssh2 client never sees
# the marker arrive separately; orchestrator hangs on the runner await
# and dies at the 300s function timeout. Spawning printf via stdbuf -oL
# cuts the buffer to a line, so the marker hits the wire the instant the
# newline is written.
stdbuf -oL printf 'HERMES_PROXMOX_RESULT {"vmid":%s,"privateIpv4":"%s","gatewayHost":"%s"}\n' "$VMID" "$PRIVATE_IP" "$GATEWAY_HOST"

# Phase 2: SSH-ready wait + guest bootstrap + agent deploy + backend-ready
# wait. Disowned + nohup'd so it survives both the LOCKED subshell exit and
# the orchestrator's SSH session close. Stdout/stderr go to a per-VM log
# file on the Proxmox host for postmortem if bootstrap fails.
#
# Keep the large base64 payloads OFF the nohup/env argv. WebUI deploy scripts
# can be hundreds of KiB after Caddy + compose + runtime config expansion; on
# real fixturenodea this hit /usr/bin/nohup: "Argument list too long" and left the VM
# booted but empty. Stage payloads in root-only files and pass only tiny paths
# into Phase 2.
mkdir -p /var/log/hermes
PHASE2_LOG="/var/log/hermes/bootstrap-\${VMID}.log"
PHASE2_PAYLOAD_DIR="/run/hermes-proxmox-phase2-\${VMID}"
PHASE2_BOOTSTRAP_B64_FILE="\${PHASE2_PAYLOAD_DIR}/bootstrap.b64"
PHASE2_DEPLOY_B64_FILE="\${PHASE2_PAYLOAD_DIR}/deploy.b64"
PHASE2_SCRIPT_FILE="\${PHASE2_PAYLOAD_DIR}/phase2.sh"
rm -rf "$PHASE2_PAYLOAD_DIR"
mkdir -p "$PHASE2_PAYLOAD_DIR"
chmod 700 "$PHASE2_PAYLOAD_DIR"
printf '%s' "$BOOTSTRAP_B64" > "$PHASE2_BOOTSTRAP_B64_FILE"
printf '%s' "$DEPLOY_B64" > "$PHASE2_DEPLOY_B64_FILE"
chmod 600 "$PHASE2_BOOTSTRAP_B64_FILE" "$PHASE2_DEPLOY_B64_FILE"
{
  printf 'Phase 2 payloads staged at %s\n' "$(date -Is)"
  wc -c "$PHASE2_BOOTSTRAP_B64_FILE" "$PHASE2_DEPLOY_B64_FILE" 2>/dev/null || true
} > "$PHASE2_LOG"

cat > "$PHASE2_SCRIPT_FILE" <<'PHASE2_BOOTSTRAP'
set -euo pipefail

# Trust-on-first-use SSH, only for what runs before the guest agent can attest
# the guest's host key: the SSH-ready wait (sudo -n true) and the bootstrap,
# which is the fixed buildProxmoxGuestBootstrapScript with no secrets in it.
# Anything carrying this box's secrets goes through GUEST_SSH, set up below.
UNATTESTED_GUEST_SSH_OPTS=(-i "$VM_SSH_KEY_PATH" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$SSH_KNOWN_HOSTS_FILE")

${PROXMOX_REMOVE_VMID_LVS_FN}

cleanup_phase2_payloads() {
  case "\${PHASE2_PAYLOAD_DIR:-}" in
    /run/hermes-proxmox-phase2-*) rm -rf "$PHASE2_PAYLOAD_DIR" ;;
    "") ;;
    *) echo "Refusing to remove unexpected Phase 2 payload dir: $PHASE2_PAYLOAD_DIR" >&2 ;;
  esac
}

# Phase 2 cleanup: tear the VM down on bootstrap failure so the dashboard's
# Proxmox sync flips status to 'stopped' (qm status returns "missing"),
# making the dead row visible to the user instead of forever-spinning.
# On success, exit 0 and leave the VM running.
#
# Identity-gated: a failed Phase 2 from a prior provision can wake up
# ~6 min late (after exhausting its 72×5s SSH-wait loop) and try to
# destroy what is, by then, a healthy fresh tenant VM that recycled the
# same VMID. The claim file written in Phase 1 names the current owner;
# only destroy when the claim still names this provision.
cleanup_phase2() {
  exit_code="$1"
  # The guest identity prelude leaves its EXIT trap to this one, so a refusal
  # inside it still tears the VM down and removes the staged payloads.
  if declare -F cleanup_hivra_guest_ssh_identity >/dev/null; then
    cleanup_hivra_guest_ssh_identity || true
  fi
  if [ "$exit_code" != "0" ] && [ -n "$VMID" ]; then
    claim=$(cat "/run/hermes-vm-claims/$VMID.claim" 2>/dev/null || true)
    if [ "$claim" = "$INSTANCE_ID" ]; then
      qm stop "$VMID" --skiplock 1 >/dev/null 2>&1 || true
      qm destroy "$VMID" --purge 1 >/dev/null 2>&1 || true
      # Mirror Phase 1: clear any leftover vm-<vmid>-* LVs that --purge couldn't
      # map from a (now-deleted) config, so a failed bootstrap can't leave an
      # allocator-blocking orphan behind.
      hermes_remove_vmid_lvs "$VMID"
      rm -f "/run/hermes-vm-claims/$VMID.claim"
      if [ -n "$SITE_FILE" ]; then rm -f "$SITE_FILE"; fi
      # Inline reload retry (Phase 2 runs in a separate shell from the
      # outer hermes_caddy_reload helper). Recovers from the goroutine-
      # race panic that crashed Caddy under reload churn. Use bounded
      # direct Caddy reload; systemctl reload can hang inside systemd after
      # the Caddy process has already panicked, blocking the recovery start.
      for _ in 1 2 3; do
        if timeout 20s caddy reload --config /etc/caddy/Caddyfile --force >/dev/null 2>&1; then break; fi
        if ! systemctl is-active caddy >/dev/null 2>&1; then
          systemctl reset-failed caddy >/dev/null 2>&1 || true
          systemctl start caddy >/dev/null 2>&1 || true
          break
        fi
        sleep 2
      done
    fi
  fi
  if [ -n "$SSH_KNOWN_HOSTS_FILE" ]; then rm -f "$SSH_KNOWN_HOSTS_FILE"; fi
  cleanup_phase2_payloads
  exit "$exit_code"
}
trap 'cleanup_phase2 "$?"' EXIT

ssh_ready=0
for _attempt in $(seq 1 72); do
  if ssh -n "\${UNATTESTED_GUEST_SSH_OPTS[@]}" -o ConnectTimeout=5 "$VM_SSH_USER@$PRIVATE_IP" "sudo -n true" >/dev/null 2>&1; then
    ssh_ready=1
    break
  fi
  sleep 5
done
if [ "$ssh_ready" != "1" ]; then
  echo "VM $VMID did not become reachable over SSH at $PRIVATE_IP" >&2
  exit 1
fi

# Run a base64-encoded script on the guest over SSH, retrying a few times
# before letting set -e fall through to the teardown trap. The single most
# common bootstrap failure is transient apt-lock / mirror contention on a
# freshly-cloned VM (the run_apt_get layers above ride most of it out, but a
# stray SSH/mirror blip — e.g. "server not responding" — can still bubble a
# non-zero out of the pipe). Both the bootstrap and deploy scripts are
# idempotent (apt installs, file writes, \`docker compose up -d\`; the deploy
# script is re-run verbatim on every fleet redeploy), so a retry is safe.
# Only a PERSISTENT failure exhausts the attempts and tears the VM down —
# this is what distinguishes a transient hiccup from a real, fatal failure.
# Arguments: label, payload file, then the ssh command up to and including
# its destination, so each call site shows which connection it trusts.
run_guest_script() {
  local label="$1"
  local b64_file="$2"
  shift 2
  local attempt=1
  local rc=0
  while [ "$attempt" -le 3 ]; do
    rc=0
    base64 -d < "$b64_file" | "$@" "sudo bash -s" && return 0 || rc=$?
    if [ "$attempt" -ge 3 ]; then
      echo "guest $label failed after $attempt attempts (rc=$rc) — tearing VM down" >&2
      return "$rc"
    fi
    echo "guest $label failed (rc=$rc, attempt $attempt/3) — retrying in 20s" >&2
    sleep 20
    attempt=$((attempt + 1))
  done
  return "$rc"
}

run_guest_script bootstrap "$BOOTSTRAP_B64_FILE" ssh "\${UNATTESTED_GUEST_SSH_OPTS[@]}" "$VM_SSH_USER@$PRIVATE_IP"

# The deploy carries this box's secrets (hermes.env with the LLM key and the
# WebUI bearer, the Bankr config), and the private IP is not an identity: a
# neighbour on the bridge can answer for it. From here on every connection is
# bound to VM $VMID. The host checks the VM's config names this IP, reads the
# guest's SSH host key through the guest agent over the VMID's virtio channel,
# and pins SSH to that key; any mismatch exits before a byte is sent and the
# EXIT trap tears the VM down.
#
# A provision that wakes late can find its VMID recycled for another instance.
# The claim file then names that instance, and even a pinned connection would
# reach its VM, so check ownership first. The EXIT trap leaves a VM alone when
# the claim names someone else.
deploy_claim="$(cat "/run/hermes-vm-claims/$VMID.claim" 2>/dev/null || true)"
if [ "$deploy_claim" != "$INSTANCE_ID" ]; then
  echo "VM $VMID is no longer claimed by instance $INSTANCE_ID; nothing was sent to it" >&2
  exit 1
fi
${phase2GuestSshPrelude}
${phase2PinnedSshReadiness}
run_guest_script deploy "$DEPLOY_B64_FILE" "\${GUEST_SSH[@]}"

backend_ready=0
last_readiness_code=""
for _attempt in $(seq 1 "$READINESS_ATTEMPTS"); do
  code="$(${readinessProbe})"
  last_readiness_code="$code"
  case "$code" in
    ${readinessReadyPattern})
      backend_ready=1
      break
      ;;
  esac
  sleep "$READINESS_INTERVAL_SECONDS"
done
if [ "$backend_ready" != "1" ]; then
  waited_seconds=$((READINESS_ATTEMPTS * READINESS_INTERVAL_SECONDS))
  echo "Hermes ${backend} did not become ready inside VM $VMID after \${waited_seconds}s (last HTTP status: \${last_readiness_code:-none})" >&2
  cat "/tmp/hermes-proxmox-\${VMID}.${readinessProbeArtifact}" >&2 2>/dev/null || true
  exit 1
fi
${isWebfreeBackend(backend) ? `
echo "[phase2] running Hermes disk cleanup after WebUI readiness"
if "\${GUEST_SSH[@]}" "if [ -x /usr/local/bin/hermes-disk-cleanup ]; then sudo -n /usr/local/bin/hermes-disk-cleanup; else echo '[phase2] WARN: /usr/local/bin/hermes-disk-cleanup missing' >&2; exit 42; fi; printf 'PHASE2_DISK_AFTER_CLEANUP '; sudo -n df -h / | tail -1" </dev/null; then
  :
else
  echo "[phase2] WARN: Hermes disk cleanup after readiness failed" >&2
fi
` : ""}

exit 0
PHASE2_BOOTSTRAP
chmod 700 "$PHASE2_SCRIPT_FILE"
nohup env INSTANCE_ID="$INSTANCE_ID" VMID="$VMID" PRIVATE_IP="$PRIVATE_IP" SITE_FILE="$SITE_FILE" SSH_KNOWN_HOSTS_FILE="$SSH_KNOWN_HOSTS_FILE" VM_SSH_USER="$VM_SSH_USER" VM_SSH_KEY_PATH="$VM_SSH_KEY_PATH" PHASE2_PAYLOAD_DIR="$PHASE2_PAYLOAD_DIR" DEPLOY_B64_FILE="$PHASE2_DEPLOY_B64_FILE" BOOTSTRAP_B64_FILE="$PHASE2_BOOTSTRAP_B64_FILE" API_SERVER_KEY="$API_SERVER_KEY" READINESS_ATTEMPTS="$READINESS_ATTEMPTS" READINESS_INTERVAL_SECONDS="$READINESS_INTERVAL_SECONDS" bash "$PHASE2_SCRIPT_FILE" >> "$PHASE2_LOG" 2>&1 < /dev/null &
disown

PHASE1_OK=1
HERMES_PROXMOX_LOCKED
`;
}
export function buildProxmoxVmidAvailabilityScript(params: {
  vmidStart: number;
  vmidEnd: number;
  vmidLedger?: VmidReferenceLedger | null;
}): string {
  return `#!/usr/bin/env bash
set -euo pipefail
VMID_START=${shQuote(params.vmidStart)}
VMID_END=${shQuote(params.vmidEnd)}
echo "HERMES_PROXMOX_VMID_RANGE $VMID_START $VMID_END"
existing_vmids="$(qm list | awk 'NR>1 {print $1}')"
# A crashed clone can leave vm-<vmid>-* LVs with no config; qm list can't see
# those, so fold LV-owning VMIDs into the occupied set. This keeps the
# dashboard preflight honest about an LV-landmined VMID (mirrors the
# provisioner's allocator — see the doom-loop incident 2026-06-13, fixturenodea).
orphan_lv_vmids="$(${PROXMOX_ORPHAN_LV_VMID_SCAN} || true)"
${buildVmidReferenceLedgerScript(params.vmidLedger)}hivra_vmid_reference_sync
occupied_vmids="$(printf '%s\\n%s\\n%s\\n' "$existing_vmids" "$orphan_lv_vmids" "$HIVRA_FOREIGN_VMIDS")"
for candidate in $(seq "$VMID_START" "$VMID_END"); do
  if printf '%s\\n' "$occupied_vmids" | grep -qx "$candidate"; then
    echo "HERMES_PROXMOX_VMID_OCCUPIED $candidate"
  else
    echo "HERMES_PROXMOX_VMID_FREE $candidate"
  fi
done
`;
}
export function buildProxmoxTemplateAvailabilityScript(params: { templateId: number }): string {
  return `#!/usr/bin/env bash
set -euo pipefail
TEMPLATE_ID=${shQuote(params.templateId)}
echo "HERMES_PROXMOX_TEMPLATE_CHECK $TEMPLATE_ID"
tmp_config="$(mktemp)"
tmp_error="$(mktemp)"
cleanup_template_check() {
  rm -f "$tmp_config" "$tmp_error"
}
trap cleanup_template_check EXIT

if ! qm config "$TEMPLATE_ID" >"$tmp_config" 2>"$tmp_error"; then
  echo "HERMES_PROXMOX_TEMPLATE_MISSING $TEMPLATE_ID"
  sed 's/^/HERMES_PROXMOX_TEMPLATE_ERROR /' "$tmp_error"
  exit 0
fi

if ! grep -qx "template: 1" "$tmp_config"; then
  echo "HERMES_PROXMOX_TEMPLATE_NOT_TEMPLATE $TEMPLATE_ID"
  exit 0
fi

echo "HERMES_PROXMOX_TEMPLATE_READY $TEMPLATE_ID"
`;
}
export function buildProxmoxStatusScript(vmid: number): string {
  return `#!/usr/bin/env bash
set -euo pipefail
if ! qm status ${shQuote(vmid)} >/dev/null 2>&1; then
  echo "STATUS missing"
  exit 0
fi
status_line="$(qm status ${shQuote(vmid)} 2>/dev/null || true)"
status_value="$(echo "$status_line" | awk '{print $2}')"
echo "STATUS \${status_value:-unknown}"
`;
}
// Batched variant. One `qm list` SSH call per host gives us the status of
// every VM on that host; the previous shape (one `qm status <vmid>` SSH
// per VM) made the dashboard's instance-list endpoint pay N × SSH-RTT.
//
// `qm list` columns are: VMID, NAME, STATUS, MEM(MB), BOOTDISK(GB), PID
// We only need columns 1 and 3. VMIDs absent from the table are reported
// as `{ status: "stopped", vmMissing: true }` to match the single-vmid
// helper's semantics.
export function buildProxmoxStatusBatchScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
qm list 2>/dev/null | awk 'NR>1 { print $1 " " $3 }'
`;
}
export function buildProxmoxMetricsScript(
  vmid: number,
  opts: { vmSshUser?: string; vmSshKeyPath?: string } = {}
): string {
  // Emit verbose qm status. We grep for the keys we care about and prefix
  // each with METRIC for unambiguous parsing on the orchestrator side.
  return `#!/usr/bin/env bash
set -euo pipefail
VMID=${shQuote(vmid)}
VM_SSH_USER=${shQuote(opts.vmSshUser || "")}
VM_SSH_KEY_PATH=${shQuote(opts.vmSshKeyPath || "")}

if ! qm status "$VMID" >/dev/null 2>&1; then
  echo "METRIC status=missing"
  exit 0
fi
out="$(qm status "$VMID" --verbose 2>/dev/null || true)"
# qm status --verbose emits 'key: value' lines; some Proxmox versions wrap
# nested structures (e.g. balloon, ballooninfo) over multiple indented
# lines. We only consume scalar top-level keys here.
echo "$out" | awk -F': ' '/^[a-zA-Z][a-zA-Z0-9_-]*:/ { gsub(/^ +| +$/, "", $2); printf "METRIC %s=%s\\n", $1, $2 }'

# Cumulative CPU time of the VM's kvm process. A one-shot 'qm status' cannot
# report CPU: PVE derives 'cpu' from two /proc samples taken inside one
# long-lived process (pvestatd), so on PVE 9 it prints no cpu line and no
# cputime at all. utime+stime of the kvm process is the real monotonic counter
# (all vCPU threads, since VM start). Fields are counted after the last ')'
# because the comm field may contain spaces.
pid_file="/var/run/qemu-server/$VMID.pid"
if [ -r "$pid_file" ]; then
  kvm_pid="$(tr -dc '0-9' < "$pid_file")"
  # Guard against a stale pid file whose pid was reused by another process.
  if [ -n "$kvm_pid" ] && [ -r "/proc/$kvm_pid/stat" ] \\
    && tr '\\0' ' ' < "/proc/$kvm_pid/cmdline" 2>/dev/null | grep -qE -- "(^| )-id $VMID( |\\$)"; then
    stat_rest="$(sed 's/^.*) //' "/proc/$kvm_pid/stat")"
    cpu_ticks="$(printf '%s\\n' "$stat_rest" | awk '{ print $12 + $13 }')"
    clk_tck="$(getconf CLK_TCK 2>/dev/null || true)"
    case "$cpu_ticks" in ''|*[!0-9]*) cpu_ticks="" ;; esac
    case "$clk_tck" in ''|*[!0-9]*|0) clk_tck="" ;; esac
    if [ -n "$cpu_ticks" ] && [ -n "$clk_tck" ]; then
      echo "METRIC proc_cpu_ticks=$cpu_ticks"
      echo "METRIC clk_tck=$clk_tck"
    fi
  fi
fi

# Prefer the guest filesystem's real usage when the orchestrator can SSH
# into the VM. Proxmox qm status --verbose often reports disk=0 unless
# qemu-guest-agent is fully wired up, and falling back to maxdisk makes every
# 30GB VM look full for capacity planning. This read is best-effort and
# never blocks the billing sample if guest SSH is temporarily unavailable.
private_ip="$(qm config "$VMID" 2>/dev/null | sed -n 's/^ipconfig0: .*ip=\\([^,\\/]*\\).*/\\1/p' | head -n1)"
if [ -n "$private_ip" ] && [ -n "$VM_SSH_USER" ] && [ -n "$VM_SSH_KEY_PATH" ] && [ -r "$VM_SSH_KEY_PATH" ]; then
  known_hosts="$(mktemp /tmp/hermes-metrics-known-hosts.XXXXXX)"
  trap 'rm -f "$known_hosts"' EXIT
  guest_out="$(ssh -i "$VM_SSH_KEY_PATH" \\
    -o BatchMode=yes \\
    -o StrictHostKeyChecking=accept-new \\
    -o UserKnownHostsFile="$known_hosts" \\
    -o ConnectTimeout=5 \\
    "$VM_SSH_USER@$private_ip" \\
    "df -B1 / | awk 'NR==2 { gsub(/%/, \\"\\", \\$5); print \\$2, \\$3, \\$5 }'; systemctl is-active hermes-disk-cleanup.timer 2>/dev/null || true" \\
    2>/dev/null || true)"
  disk_line="$(printf '%s\\n' "$guest_out" | head -n1)"
  guest_total="$(printf '%s\\n' "$disk_line" | awk '{ print $1 }')"
  guest_used="$(printf '%s\\n' "$disk_line" | awk '{ print $2 }')"
  guest_pct="$(printf '%s\\n' "$disk_line" | awk '{ print $3 }')"
  case "$guest_total" in ''|*[!0-9]*) guest_total="" ;; esac
  case "$guest_used" in ''|*[!0-9]*) guest_used="" ;; esac
  case "$guest_pct" in ''|*[!0-9]*) guest_pct="" ;; esac
  if [ -n "$guest_used" ] && [ -n "$guest_total" ]; then
    echo "METRIC guest_disk_used_bytes=$guest_used"
    echo "METRIC guest_disk_total_bytes=$guest_total"
    [ -n "$guest_pct" ] && echo "METRIC guest_disk_used_pct=$guest_pct"
  fi
  cleanup_timer="$(printf '%s\\n' "$guest_out" | awk 'NR==2 { print $1 }')"
  [ -n "$cleanup_timer" ] && echo "METRIC cleanup_timer=$cleanup_timer"
fi
`;
}
export function buildProxmoxTemplateAuditScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
echo "HERMES_PROXMOX_TEMPLATE_AUDIT_BEGIN"

if command -v qm >/dev/null 2>&1; then
  qm list | awk 'NR>1 { printf "QMLIST|%s|%s|%s\\n", $1, $2, $3 }'
  for vmid in $(qm list | awk 'NR>1 { print $1 }'); do
    config="$(qm config "$vmid" 2>/dev/null || true)"
    encoded="$(printf '%s' "$config" | base64 | tr -d '\\n')"
    printf 'QMCONFIG|%s|%s\\n' "$vmid" "$encoded"
  done
fi

if command -v lvs >/dev/null 2>&1; then
  lvs --noheadings --separator '|' -o vg_name,lv_name,origin,lv_attr 2>/dev/null \\
    | sed 's/^ *//;s/ *$//' \\
    | awk -F'|' '{ printf "LVM|%s|%s|%s|%s\\n", $1, $2, $3, $4 }' || true
fi

if command -v zfs >/dev/null 2>&1; then
  zfs get -H -t volume -o name,value origin 2>/dev/null \\
    | awk -F'\\t' '{ printf "ZFS|%s|%s\\n", $1, $2 }' || true
fi

echo "HERMES_PROXMOX_TEMPLATE_AUDIT_END"
`;
}
export function buildProxmoxTemplatePruneScript(templateVmids: number[]): string {
  const uniqueVmids = Array.from(new Set(templateVmids))
    .filter((vmid) => Number.isFinite(vmid) && vmid > 0)
    .sort((a, b) => a - b);
  const vmidList = uniqueVmids.map((vmid) => String(vmid)).join(" ");

  return `#!/usr/bin/env bash
set -euo pipefail
TEMPLATE_VMIDS=(${vmidList})
for vmid in "\${TEMPLATE_VMIDS[@]}"; do
  if [ -z "$vmid" ]; then
    continue
  fi
  if ! qm config "$vmid" >/tmp/hermes-template-prune-$vmid.config 2>/dev/null; then
    echo "Template VMID $vmid does not exist" >&2
    exit 1
  fi
  if ! grep -q '^template: 1$' "/tmp/hermes-template-prune-$vmid.config"; then
    echo "Refusing to destroy VMID $vmid because it is not a Proxmox template" >&2
    exit 1
  fi
  qm destroy "$vmid" --purge 1
  rm -f "/tmp/hermes-template-prune-$vmid.config"
  echo "HERMES_TEMPLATE_PRUNED $vmid"
done
`;
}
const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Stdout marker for a VMID that exists but is not this instance's VM. Hosts are
// shared (prod Hermes, Canary Hivra, operator placeholders), so a stale row can
// name a VMID that was destroyed and reused by another control plane. The guard
// also prints PROXMOX_VM_MISSING_MARKER: for every caller this instance has no
// VM at that VMID, which is exactly what the missing-VM handling expects.
export const PROXMOX_VM_IDENTITY_MISMATCH_MARKER = "HERMES_VM_IDENTITY_MISMATCH";

/**
 * Shell predicate: the VM name carries this instance's identity. Hermes VMs are
 * named `hermes-<slug>-<id8>` (current) or `hermes-<full uuid>` (older clones);
 * both forms are accepted, nothing else is.
 */
export function buildProxmoxVmOwnedByInstanceCheck(vmid: number, expectedInstanceId: string): string {
  if (!INSTANCE_ID_PATTERN.test(expectedInstanceId)) {
    throw new Error("Proxmox lifecycle instance identity is invalid.");
  }
  const id = expectedInstanceId.toLowerCase();
  return `hermes_vm_owned_by_instance() {
  local actual_name
  actual_name="$(qm config ${vmid} 2>/dev/null | sed -n 's/^name:[[:space:]]*//p' | head -1)"
  case "$actual_name" in
    *-${id.slice(0, 8)}|*${id}*) return 0 ;;
    *) return 1 ;;
  esac
}`;
}

export function buildProxmoxVmIdentityGuardScript(vmid: number, expectedInstanceId: string): string {
  return `${buildProxmoxVmOwnedByInstanceCheck(vmid, expectedInstanceId)}
if ! hermes_vm_owned_by_instance; then
  echo "${PROXMOX_VM_IDENTITY_MISMATCH_MARKER} ${vmid}"
  echo "${PROXMOX_VM_MISSING_MARKER}"
  exit 64
fi
`;
}

export function buildProxmoxDeleteScript(params: {
  vmid: number;
  expectedInstanceId: string;
  gatewayHost: string;
  caddySitesDir: string;
  /** Seconds to wait for graceful ACPI/agent shutdown before hard-stop. Default 30. */
  gracefulShutdownTimeoutSeconds?: number;
}): string {
  const siteFile = `${params.caddySitesDir.replace(/\/+$/g, "")}/${params.gatewayHost}.caddy`;
  const gracefulTimeout = Math.max(0, Math.floor(params.gracefulShutdownTimeoutSeconds ?? 30));

  // Two-phase stop: try graceful first so the in-VM webui / sidecar / Caddy
  // get a chance to flush state, then fall back to hard stop. For free-tier
  // auto-deletion this matters less (VM was already suspended), but it keeps
  // the user-initiated delete path clean — e.g. a paying user shutting down
  // their own agent doesn't want a kill -9 mid-request.
  return `#!/usr/bin/env bash
set -euo pipefail
expected_instance_id=${shQuote(params.expectedInstanceId)}
${buildProxmoxVmOwnedByInstanceCheck(params.vmid, params.expectedInstanceId)}
if [ -e ${shQuote(siteFile)} ] && ! grep -Fq "$expected_instance_id" ${shQuote(siteFile)} 2>/dev/null; then
  echo "HERMES_PROXMOX_DELETE_SITE_IDENTITY_MISMATCH ${params.vmid}" >&2
  exit 42
fi
if qm status ${params.vmid} >/dev/null 2>&1; then
  if ! hermes_vm_owned_by_instance || ! grep -Fq "$expected_instance_id" ${shQuote(siteFile)} 2>/dev/null; then
    echo "HERMES_PROXMOX_DELETE_IDENTITY_MISMATCH ${params.vmid}" >&2
    exit 42
  fi
  if qm shutdown ${params.vmid} --timeout ${gracefulTimeout} >/dev/null 2>&1; then
    echo "HERMES_PROXMOX_DELETE_VM_GRACEFUL_SHUTDOWN ${params.vmid}"
  else
    echo "HERMES_PROXMOX_DELETE_VM_GRACEFUL_TIMEOUT ${params.vmid}" >&2
    qm stop ${params.vmid} --skiplock 1 >/dev/null 2>&1 || true
  fi
  if qm destroy ${params.vmid} --purge 1; then
    echo "HERMES_PROXMOX_DELETE_VM_DESTROYED ${params.vmid}"
  elif qm status ${params.vmid} >/dev/null 2>&1; then
    echo "HERMES_PROXMOX_DELETE_VM_DESTROY_FAILED ${params.vmid}" >&2
    exit 1
  else
    echo "HERMES_PROXMOX_DELETE_VM_MISSING_AFTER_DESTROY ${params.vmid}"
  fi
else
  echo "HERMES_PROXMOX_DELETE_VM_MISSING ${params.vmid}"
fi
rm -f ${shQuote(siteFile)}
rm -f /run/hermes-vm-claims/${params.vmid}.claim
caddy_reload_ok=0
for _ in 1 2 3; do
  if timeout 20s caddy reload --config /etc/caddy/Caddyfile --force >/dev/null 2>&1; then
    caddy_reload_ok=1
    break
  fi
  if ! systemctl is-active caddy >/dev/null 2>&1; then
    systemctl reset-failed caddy >/dev/null 2>&1 || true
    if systemctl start caddy >/dev/null 2>&1; then
      caddy_reload_ok=1
      break
    fi
  fi
  sleep 2
done
if [ "$caddy_reload_ok" != "1" ]; then
  echo "HERMES_PROXMOX_DELETE_CADDY_RELOAD_FAILED ${shQuote(siteFile)}" >&2
fi
`;
}
/**
 * Build a host-side script that removes one or more per-instance Caddy site
 * files from a Proxmox host's caddy sites dir, then reloads host Caddy using
 * the same validate-then-reload + restart-on-dead-daemon pattern as the
 * hermes_caddy_reload helper baked into the provisioning script.
 *
 * Why this exists: the cold-archive path
 * (cold-storage-service.archiveInstance) destroys the source VM and nulls the
 * routing columns, but historically left `<caddySitesDir>/<gatewayHost>.caddy`
 * in place. That file still `reverse_proxy <private_ip>:80`. When the freed
 * VMID/private IP was later recycled to a DIFFERENT tenant on the same host,
 * the archived tenant's `<sub>.hermesos.cloud` hostname routed to the new
 * tenant's VM — a cross-tenant routing leak — and stale files bloat the
 * host's cert footprint. deleteProxmoxInstance already removes the file via
 * buildProxmoxDeleteScript; this builder closes the same gap for archive and
 * is reused by the fleet-wide orphan-site cleanup (scripts/cleanup-orphan-caddy-sites.ts).
 *
 * `gatewayHosts` are site basenames (e.g. "<sub>.hermesos.cloud"); the file
 * removed is `<caddySitesDir>/<host>.caddy`. Removing a reverse_proxy site can
 * never make the Caddyfile invalid, so a failed `caddy validate` here means a
 * DIFFERENT file on the host is already broken — in that case we refuse to
 * reload (matching hermes_caddy_reload) but the rm has already landed.
 */
export function buildProxmoxCaddySiteCleanupScript(params: {
  gatewayHosts: string[];
  caddySitesDir: string;
}): string {
  const dir = params.caddySitesDir.replace(/\/+$/g, "");
  const rmBlock = params.gatewayHosts
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => {
      const file = `${dir}/${h}.caddy`;
      return `if [ -f ${shQuote(file)} ]; then rm -f ${shQuote(file)} && echo "HERMES_CADDY_SITE_REMOVED ${h}"; else echo "HERMES_CADDY_SITE_ABSENT ${h}"; fi`;
    })
    .join("\n");
  return `#!/usr/bin/env bash
set -uo pipefail
${rmBlock}
# validate-then-reload, mirroring the hermes_caddy_reload helper. Pull the
# daemon's resolved systemd env first so any {env.X} TLS tokens resolve during
# validate, then refuse to reload an invalid config (a failure can only come
# from some OTHER broken site file — our rm cannot invalidate the config).
if command -v systemctl >/dev/null 2>&1; then
  for kv in $(systemctl show caddy -p Environment --value 2>/dev/null); do
    [ -n "$kv" ] && export "$kv"
  done
fi
if ! VALIDATE_ERR=$(caddy validate --config /etc/caddy/Caddyfile 2>&1); then
  echo "HERMES_CADDY_CLEANUP_INVALID_CONFIG refusing to reload (a different site file is broken)" >&2
  printf '%s\\n' "$VALIDATE_ERR" | tail -n 10 >&2
  exit 1
fi
if ! systemctl is-active caddy >/dev/null 2>&1; then
  systemctl reset-failed caddy >/dev/null 2>&1 || true
  if systemctl start caddy >/dev/null 2>&1; then echo "HERMES_CADDY_CLEANUP_RELOADED"; exit 0; fi
  echo "HERMES_CADDY_CLEANUP_RELOAD_FAILED" >&2
  exit 1
fi
for _ in 1 2 3; do
  if timeout 20s caddy reload --config /etc/caddy/Caddyfile --force >/dev/null 2>&1; then
    echo "HERMES_CADDY_CLEANUP_RELOADED"
    exit 0
  fi
  if ! systemctl is-active caddy >/dev/null 2>&1; then
    systemctl reset-failed caddy >/dev/null 2>&1 || true
    if systemctl start caddy >/dev/null 2>&1; then echo "HERMES_CADDY_CLEANUP_RELOADED"; exit 0; fi
  fi
  sleep 2
done
echo "HERMES_CADDY_CLEANUP_RELOAD_FAILED" >&2
exit 1
`;
}
// Stdout marker emitted by buildProxmoxPowerScript when the target VM no
// longer exists on the Proxmox host (qm status returns "missing"). Callers
// detect this to flip the instance row to status='error' instead of
// surfacing a raw "Remote bash exited with code 255" — the underlying
// situation is "Phase 2 cleanup destroyed the VM after a failed bootstrap"
// (see cleanup_phase2 in the provisioning script), which is unrecoverable
// from a power action and needs the user to re-create the instance.
export const PROXMOX_VM_MISSING_MARKER = "HERMES_VM_MISSING";
// Stdout marker emitted by the shutdown branch of buildProxmoxPowerScript when
// the VM is STILL running after a graceful `qm shutdown`, a hard `qm stop`, and
// a bounded re-poll. `qm shutdown`/`qm stop` returning 0 does not by itself
// prove the guest powered off (a wedged guest can linger), so the script
// verifies and, if the VM refuses to die, fails with this marker. Callers that
// record a "stopped"/"paused" DB state MUST treat this as a failure and leave
// the row alone — writing paused while the VM runs is exactly the
// "paused-but-running" ghost the fleet-status-reconcile cron then has to clean
// up. The 30-min reconcile is the safety net; this is the source-side guard.
export const PROXMOX_VM_STILL_RUNNING_MARKER = "HERMES_STILL_RUNNING";
export function buildProxmoxPowerScript(params: {
  vmid: number;
  /** The row's instance id. A VMID holding any other VM is never touched. */
  expectedInstanceId: string;
  action: "start" | "shutdown" | "reboot";
  shutdownTimeoutSeconds?: number;
  /**
   * When set, also writes `qm set <vmid> --onboot <0|1>` after the power
   * action. Pausing an agent for inactivity passes 0 so a HOST reboot does NOT
   * auto-start the deliberately-paused VM (the root cause of the
   * "paused-but-running" DB drift); resuming passes 1 so an active agent
   * survives host reboots. Undefined = leave onboot untouched (every existing
   * caller's behaviour). Best-effort: a failed `qm set` never fails the power
   * action — onboot drift is self-healing via the fleet-status-reconcile cron.
   */
  setOnboot?: 0 | 1;
}): string {
  const timeout = Math.max(
    1,
    Math.min(600, Math.floor(params.shutdownTimeoutSeconds ?? 90))
  );
  const onbootScript =
    params.setOnboot === undefined
      ? ""
      : `qm set ${params.vmid} --onboot ${params.setOnboot} >/dev/null 2>&1 || true
`;
  let actionScript: string;
  if (params.action === "start") {
    actionScript = `if qm status ${params.vmid} | grep -q "status: running"; then
  exit 0
fi
qm start ${params.vmid}
`;
  } else if (params.action === "shutdown") {
    // Verify-down: `qm shutdown ... || qm stop ...` returning 0 means "the
    // command was accepted", NOT "the guest is powered off". A wedged guest can
    // linger after both. Since the caller writes status='stopped'/paused only on
    // a 0 exit, an unverified success mints a paused-but-running ghost. So after
    // requesting the stop we poll `qm status`, force a hard stop each round, and
    // only exit 0 once the host reports "status: stopped". If it never stops we
    // emit ${PROXMOX_VM_STILL_RUNNING_MARKER} and exit non-zero so the caller
    // leaves the DB row alone. Bounded (~8s) so it never approaches the SSH
    // timeout.
    actionScript = `if qm status ${params.vmid} | grep -q "status: stopped"; then
  exit 0
fi
qm shutdown ${params.vmid} --timeout ${timeout} || qm stop ${params.vmid} --skiplock 1
for _ in $(seq 1 8); do
  if qm status ${params.vmid} | grep -q "status: stopped"; then
    exit 0
  fi
  qm stop ${params.vmid} --skiplock 1 >/dev/null 2>&1 || true
  sleep 1
done
echo "${PROXMOX_VM_STILL_RUNNING_MARKER}"
exit 65
`;
  } else {
    actionScript = `if qm status ${params.vmid} | grep -q "status: stopped"; then
  qm start ${params.vmid}
  exit 0
fi
qm reboot ${params.vmid} --timeout ${timeout} || {
  qm shutdown ${params.vmid} --timeout ${timeout} || qm stop ${params.vmid} --skiplock 1
  qm start ${params.vmid}
}
`;
  }

  // Pre-flight: detect a missing VM up front so the orchestrator can flip
  // the row to status='error' instead of letting `qm start` fail with
  // exit 255 (which surfaces to the user as the meaningless "Remote bash
  // exited with code 255"). 64 is sysexits.h EX_USAGE — any non-{0,1,2}
  // code that we own would do; 64 leaves room for downstream callers to
  // map it back if they want to.
  // onbootScript runs BEFORE the power action (and so before any of the
  // action's early `exit 0` short-circuits) so onboot is corrected even when
  // the VM is already in the target power state — e.g. pausing a VM that a host
  // reboot already brought up, where `qm shutdown` early-exits on
  // "status: stopped" but we still need onboot cleared. It's `|| true`, so it
  // never blocks the power action.
  return `#!/usr/bin/env bash
set -euo pipefail
if ! qm status ${params.vmid} >/dev/null 2>&1; then
  echo "${PROXMOX_VM_MISSING_MARKER}"
  exit 64
fi
${buildProxmoxVmIdentityGuardScript(params.vmid, params.expectedInstanceId)}${onbootScript}${actionScript}`;
}
/**
 * Best-effort orphan-VM cleanup script for malformed Phase-1 output.
 * It must be claim-gated: a prior provision can recover "vmid=504" from
 * a malformed buffer after a newer provision has already recycled VMID 504
 * for a different tenant. Destroying without checking the claim file caused
 * fresh VMs to disappear while their DB rows still said "running".
 */
export function buildProxmoxOrphanCleanupScript(params: {
  vmid: number;
  instanceId: string;
  gatewayHost: string;
  caddySitesDir: string;
}): string {
  const siteFile = `${params.caddySitesDir.replace(/\/+$/g, "")}/${params.gatewayHost}.caddy`;
  return `#!/usr/bin/env bash
set +e
CLAIM_FILE=/run/hermes-vm-claims/${params.vmid}.claim
EXPECTED_INSTANCE_ID=${shQuote(params.instanceId)}
claim="$(cat "$CLAIM_FILE" 2>/dev/null || true)"
if [ "$claim" != "$EXPECTED_INSTANCE_ID" ]; then
  echo HERMES_PROXMOX_ORPHAN_CLEANUP_SKIPPED_CLAIM_MISMATCH
  exit 0
fi
qm stop ${params.vmid} 2>/dev/null
qm destroy ${params.vmid} --purge 2>/dev/null
# Remove any leftover vm-<vmid>-* LVs that --purge couldn't map from a missing
# config, so a half-cloned VMID can't doom-loop the allocator (incident
# 2026-06-13, vmid 1246 on fixturenodea).
lvs --noheadings -o vg_name,lv_name 2>/dev/null | awk -v id=${params.vmid} '$2 ~ ("^vm-" id "-") {print $1 "/" $2}' | while read -r lvpath; do
  [ -n "$lvpath" ] && lvremove -f "$lvpath" >/dev/null 2>&1 || true
done || true
rm -f "$CLAIM_FILE"
rm -f ${shQuote(siteFile)}
echo HERMES_PROXMOX_ORPHAN_CLEANUP done
`;
}
export function buildProxmoxDormantArchiveScript(params: {
  vmid: number;
  archiveDir: string;
  instanceId: string;
}): string {
  return `#!/usr/bin/env bash
set -euo pipefail
VMID=${shQuote(params.vmid)}
ARCHIVE_DIR=${shQuote(params.archiveDir)}
INSTANCE_ID=${shQuote(params.instanceId)}
mkdir -p "$ARCHIVE_DIR"
before="$(mktemp)"
find "$ARCHIVE_DIR" -maxdepth 1 -type f -name "vzdump-qemu-$VMID-*" -print 2>/dev/null | sort > "$before"
if ! qm status "$VMID" >/dev/null 2>&1; then
  echo "HERMES_DORMANT_ARCHIVE_VM_MISSING $VMID" >&2
  rm -f "$before"
  exit 1
fi
vzdump "$VMID" \\
  --mode stop \\
  --compress zstd \\
  --dumpdir "$ARCHIVE_DIR" \\
  --notes-template "Hermes dormant archive for $INSTANCE_ID" \\
  --remove 0
archive_path="$(find "$ARCHIVE_DIR" -maxdepth 1 -type f -name "vzdump-qemu-$VMID-*" -print 2>/dev/null | sort | comm -13 "$before" - | tail -1)"
rm -f "$before"
if [ -z "$archive_path" ]; then
  archive_path="$(find "$ARCHIVE_DIR" -maxdepth 1 -type f -name "vzdump-qemu-$VMID-*" -printf "%T@ %p\\n" 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)"
fi
if [ -z "$archive_path" ]; then
  echo "HERMES_DORMANT_ARCHIVE_PATH_NOT_FOUND $VMID" >&2
  exit 1
fi
archive_size_bytes="$(stat -c '%s' "$archive_path" 2>/dev/null || true)"
if ! printf '%s' "$archive_size_bytes" | grep -Eq '^[0-9]+$'; then
  echo "HERMES_DORMANT_ARCHIVE_SIZE_UNAVAILABLE $archive_path" >&2
  exit 1
fi
echo "HERMES_DORMANT_ARCHIVE_PATH=$archive_path"
echo "HERMES_DORMANT_ARCHIVE_SIZE_BYTES=$archive_size_bytes"
`;
}
export function buildProxmoxResizeScript(params: {
  vmid: number;
  /** The row's instance id. A VMID holding any other VM is never resized. */
  expectedInstanceId: string;
  cores: number;
  memoryMb: number;
  /** Optional --balloon floor (MB). See `buildProxmoxProvisionScript` for
   *  semantics. Omit to preserve the legacy fully-pinned allocation. */
  balloonFloorMb?: number;
}) {
  const cores = Math.max(1, Math.floor(params.cores));
  const cpuLimit = Math.max(0.1, params.cores);
  const memoryMb = Math.max(1024, Math.floor(params.memoryMb));
  const balloonFloorMb = resolveProxmoxBalloonFloorMb(memoryMb, params.balloonFloorMb);

  return `#!/usr/bin/env bash
set -euo pipefail
VMID=${shQuote(params.vmid)}
CORES=${shQuote(cores)}
CPU_LIMIT=${shQuote(cpuLimit)}
MEMORY_MB=${shQuote(memoryMb)}
BALLOON_FLOOR_MB=${shQuote(balloonFloorMb)}

if ! qm status "$VMID" >/dev/null 2>&1; then
  echo "VM $VMID not found" >&2
  exit 1
fi
${buildProxmoxVmIdentityGuardScript(params.vmid, params.expectedInstanceId)}
qm set "$VMID" --cores "$CORES" --cpulimit "$CPU_LIMIT" --memory "$MEMORY_MB" --balloon "$BALLOON_FLOOR_MB"
`;
}
/**
 * Container-name suffixes whose compose `deploy.resources.limits` carry the
 * TIER ceiling (see buildWebUICompose: both get `cpus: cpuLimit` /
 * `memory: ramCeilingMb`). The system sidecars — `-browser-sidecar` (1320M),
 * `-autoheal` (64M), `-dashboard-sidecar` — are deliberately fixed-size and
 * must NOT be resized with the tier.
 */
const TIER_CEILING_CONTAINER_SUFFIXES = ["gateway", "official-dashboard"] as const;
