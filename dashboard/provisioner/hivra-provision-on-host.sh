#!/usr/bin/env bash
# hivra-provision-on-host.sh — run ON a Proxmox host as root.
#
# Creates a fresh Ubuntu VM, provisions the selected agent or Linux computer
# profile through provision-claude-code-box.sh, opens a cloudflared http2 tunnel
# to its authenticated access gateway, and prints a single JSON result line.
# This is the host-side primitive the Hivra dashboard SSHes in to invoke.
#
# Usage: hivra-provision-on-host.sh VMID LAST_OCTET [CORES] [MEM_MB] [AGENT_KIND] [CPU_LIMIT]
#   VMID        Proxmox VM id (e.g. 1098)
#   LAST_OCTET  guest IP last octet on the prepared Hivra /24
#   CORES       vCPUs (default 4)        <- the dashboard "Advanced" CPU choice
#   MEM_MB      RAM in MB (default 8192) <- the dashboard "Advanced" RAM choice
#   AGENT_KIND  claude | codex | aeon | openclaw | agent-zero | deepseek-harness | linux-desktop (default claude) <- which runtime the box runs
#               (aeon + openclaw + agent-zero host a web dashboard/Control UI instead of a chat CLI)
#
# Result (stdout, last line):
#   {"vmid":1098,"ip":"10.250.20.241","cores":4,"mem_mb":8192,"agent_kind":"claude","chat_url":"https://x.trycloudflare.com","ready":true}
#
# Prereqs on the host are installed by prepare-proxmox-host.sh.
set -euo pipefail
umask 077

VMID="${1:?usage: hivra-provision-on-host.sh VMID LAST_OCTET [CORES] [MEM_MB] [AGENT_KIND]}"
OCTET="${2:?need LAST_OCTET}"
CORES="${3:-4}"
MEM_MB="${4:-8192}"
AGENT_KIND="${5:-claude}"
CPU_LIMIT="${6:-$CORES}"
case "$AGENT_KIND" in claude|codex|aeon|openclaw|agent-zero|deepseek-harness|linux-desktop) ;; *)
  echo "[hivra-prov] unsupported agent kind" >&2
  exit 1
;; esac

SUBNET_PREFIX="${HIVRA_SUBNET_PREFIX:-10.251.20}"
GW="${HIVRA_GW:-${SUBNET_PREFIX}.1}"
BRIDGE="${HIVRA_BRIDGE:-hivra0}"
IMG="${HIVRA_UBUNTU_IMG:-/var/lib/vz/template/iso/hivra-ubuntu-jammy.img}"
PROV_DIR="${HIVRA_PROV_DIR:-/opt/hivra/provisioner}"
STORAGE="${HIVRA_STORAGE:-local-lvm}"
DISK_GB="${HIVRA_DISK_GB:-40}"
CHAT_PORT="${HIVRA_CHAT_PORT:-8080}"
NAMESERVERS="${HIVRA_NAMESERVERS:-185.12.64.1 185.12.64.2 1.1.1.1 8.8.8.8}"
VM_KEY="${HIVRA_VM_SSH_KEY_PATH:-/etc/hivra/keys/vm-orchestrator}"
IP="${SUBNET_PREFIX}.${OCTET}"
ALLOCATION_LOCK_FD="${HIVRA_ALLOCATION_LOCK_FD:-}"
OPERATION_ID="${HIVRA_OPERATION_ID:-}"
OPERATION_TAG=""
BINDING_TAG="${HIVRA_BINDING_TAG:-}"
SECRET_RESULT_FILE="${HIVRA_SECRET_RESULT_FILE:-/var/lib/hivra/provision-results/${VMID}.secret}"
SECRET_TMP=""
SECRET_ENV_FILE="${HIVRA_SECRET_ENV_FILE:-}"
ALLOCATION_RECEIPT_FILE="/run/hivra-provision/${VMID}.allocated"
GUEST_SSH_IDENTITY_DIR=""
CLOUD_INIT_SNIPPET=""
CLOUD_INIT_SNIPPET_STORAGE="${HIVRA_CLOUD_INIT_SNIPPET_STORAGE:-local}"
CLOUD_INIT_SNIPPET_DIR="${HIVRA_CLOUD_INIT_SNIPPET_DIR:-/var/lib/vz/snippets}"

log() { echo "[hivra-prov] $*" >&2; }
fail() { log "$*"; exit 1; }

[[ "$VMID" =~ ^[0-9]+$ ]] && [ "$VMID" -ge 100 ] || fail "invalid VMID"
[[ "$OCTET" =~ ^[0-9]+$ ]] && [ "$OCTET" -ge 2 ] && [ "$OCTET" -le 254 ] || fail "invalid IP octet"
[[ "$CORES" =~ ^[0-9]+$ ]] && [ "$CORES" -ge 1 ] && [ "$CORES" -le 256 ] || fail "invalid vCPU count"
[[ "$CPU_LIMIT" =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "invalid CPU limit"
[[ "$MEM_MB" =~ ^[0-9]+$ ]] && [ "$MEM_MB" -ge 512 ] || fail "invalid memory size"
[[ "$DISK_GB" =~ ^[0-9]+$ ]] && [ "$DISK_GB" -ge 8 ] || fail "invalid disk size"
[[ "$OPERATION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || fail "HIVRA_OPERATION_ID must be a lowercase UUID"
OPERATION_TAG="hivra-op-${OPERATION_ID//-/}"
[[ "$BINDING_TAG" =~ ^hivra-bind-[0-9a-f]{32}$ ]] \
  || fail "HIVRA_BINDING_TAG must be an exact Hivra binding tag"
[[ "$SECRET_RESULT_FILE" =~ ^/var/lib/hivra/provision-results/${VMID}\.secret$ ]] \
  || fail "invalid secret result path"
[ ! -e "/etc/pve/qemu-server/${VMID}.conf" ] || fail "refusing to overwrite existing VMID $VMID"
qm status "$VMID" >/dev/null 2>&1 && fail "refusing to overwrite existing VMID $VMID"

[ -f "$IMG" ] || { echo "ubuntu image $IMG missing" >&2; exit 1; }
[ -d "$PROV_DIR" ] || { echo "provisioner dir $PROV_DIR missing" >&2; exit 1; }
[ -f "$PROV_DIR/hivra-install-agent.py" ] || fail "shared guest launch entrypoint is missing"
[ -f "$VM_KEY" ] || { echo "VM ssh key $VM_KEY missing" >&2; exit 1; }
command -v timeout >/dev/null 2>&1 || fail "timeout is required for bounded guest boot checks"
command -v python3 >/dev/null 2>&1 || fail "python3 is required for the guest launch document"
[ "$CLOUD_INIT_SNIPPET_STORAGE" = "local" ] || fail "unsupported cloud-init snippet storage"
[ "$CLOUD_INIT_SNIPPET_DIR" = "/var/lib/vz/snippets" ] || fail "unsupported cloud-init snippet directory"
[ -r /proc/uptime ] || fail "Linux monotonic uptime is required for guest boot checks"

# Cloud-init authorized keys: the VM-orchestrator pub (host->guest) plus any
# optional operator key configured explicitly for direct access. The guest
# must authorize a key the HOST holds privately so we can drive it below.
CIKEYS="$(mktemp "/run/hivra-ci-keys-${VMID}.XXXXXX.pub")"
CREATED=0
release_allocation_lock() {
  if [ "$ALLOCATION_LOCK_FD" = "8" ]; then
    flock -u 8 2>/dev/null || true
    exec 8>&-
    ALLOCATION_LOCK_FD=""
  fi
}
vm_owned_by_operation() {
  local tags
  tags="$(qm config "$VMID" 2>/dev/null | sed -n 's/^tags:[[:space:]]*//p')" || return 1
  printf '%s\n' "$tags" | tr ';' '\n' | grep -Fxq "$OPERATION_TAG" \
    && printf '%s\n' "$tags" | tr ';' '\n' | grep -Fxq "$BINDING_TAG"
}
cleanup() {
  local status=$? cleanup_failed=0 volume_list=""
  rm -f -- "$CIKEYS"
  [ -z "$SECRET_TMP" ] || rm -f -- "$SECRET_TMP"
  [ -z "$SECRET_ENV_FILE" ] || rm -f -- "$SECRET_ENV_FILE"
  case "${GUEST_SSH_IDENTITY_DIR:-}" in
    /run/hivra-guest-ssh-identity."${VMID}".*) rm -rf -- "$GUEST_SSH_IDENTITY_DIR" ;;
    "") ;;
    *) cleanup_failed=1; log "cleanup refused unexpected guest SSH identity path" ;;
  esac
  case "${CLOUD_INIT_SNIPPET:-}" in
    /var/lib/vz/snippets/hivra-qga-"${VMID}"-"${OPERATION_ID}".yaml) rm -f -- "$CLOUD_INIT_SNIPPET" ;;
    "") ;;
    *) cleanup_failed=1; log "cleanup refused unexpected cloud-init snippet path" ;;
  esac
  if [[ "${HIVRA_PID_FILE:-}" =~ ^/run/hivra-provision/[0-9]+\.pid$ ]]; then
    rm -f -- "$HIVRA_PID_FILE"
  fi
  if [ "$CREATED" = "1" ]; then
    log "provisioning failed; removing newly-created VM $VMID with verification"
    if qm status "$VMID" >/dev/null 2>&1; then
      if ! vm_owned_by_operation; then
        cleanup_failed=1
        log "cleanup refused: VMID $VMID lacks this operation's ownership tags"
      else
      for _ in 1 2 3; do
        qm status "$VMID" >/dev/null 2>&1 || break
        vm_owned_by_operation || break
        qm stop "$VMID" --timeout 30 >/dev/null 2>&1 || true
        qm destroy "$VMID" --purge 1 --destroy-unreferenced-disks 1 >/dev/null 2>&1 || true
        sleep 1
      done
      fi
    fi
    if qm status "$VMID" >/dev/null 2>&1; then
      cleanup_failed=1
      log "cleanup verification failed: VMID $VMID still exists"
    fi
    if volume_list="$(pvesm list "$STORAGE" 2>/dev/null)"; then
      if printf '%s\n' "$volume_list" | grep -Eq "vm-${VMID}-"; then
        cleanup_failed=1
        log "cleanup verification failed: VMID $VMID still has volumes on $STORAGE"
      fi
    else
      cleanup_failed=1
      log "cleanup verification failed: could not inspect storage $STORAGE"
    fi
  fi
  # Keep FD8 through ownership checks, destroy retries, and absence/storage
  # verification. Releasing it earlier would let a concurrent allocator reuse
  # this VMID while cleanup was still deciding what it owned.
  release_allocation_lock
  if [ "$status" -ne 0 ]; then
    rm -f -- "$ALLOCATION_RECEIPT_FILE"
    rm -f -- "$SECRET_RESULT_FILE"
    if [ "$cleanup_failed" = "1" ]; then
      printf '{"vmid":%s,"ip":"%s","agent_kind":"%s","ready":false,"error":"provisioning failed and cleanup could not be verified; inspect the host log"}\n' \
        "$VMID" "$IP" "$AGENT_KIND"
    else
      printf '{"vmid":%s,"ip":"%s","agent_kind":"%s","ready":false,"error":"provisioning failed; cleanup verified; inspect the host log"}\n' \
        "$VMID" "$IP" "$AGENT_KIND"
    fi
  fi
}
trap cleanup EXIT
if [ -n "$SECRET_ENV_FILE" ]; then
  [[ "$SECRET_ENV_FILE" =~ ^/run/hivra-provision/${VMID}\.env$ ]] \
    || fail "invalid secret input path"
  [ -f "$SECRET_ENV_FILE" ] || fail "secret input file is missing"
  [ "$(stat -c '%a:%U:%G' "$SECRET_ENV_FILE" 2>/dev/null)" = "600:root:root" ] \
    || fail "secret input file has unsafe ownership or mode"
  read_secret_b64() {
    local key="$1" line encoded
    line="$(grep -m1 -E "^${key}=" "$SECRET_ENV_FILE" 2>/dev/null)" \
      || fail "secret input is missing $key"
    encoded="${line#*=}"
    [[ "$encoded" =~ ^[A-Za-z0-9+/]*={0,2}$ ]] || fail "secret input contains invalid base64"
    printf '%s' "$encoded" | base64 -d || fail "secret input could not be decoded"
  }
  HIVRA_TUNNEL_TOKEN="$(read_secret_b64 HIVRA_TUNNEL_TOKEN_B64)"
  HIVRA_TUNNEL_URL="$(read_secret_b64 HIVRA_TUNNEL_URL_B64)"
  HIVRA_MODEL_KEY="$(read_secret_b64 HIVRA_MODEL_KEY_B64)"
  HIVRA_MODEL_BASE_URL="$(read_secret_b64 HIVRA_MODEL_BASE_URL_B64)"
  HIVRA_HERMES_MODEL="$(read_secret_b64 HIVRA_HERMES_MODEL_B64)"
  HIVRA_ACTIVITY_TELEMETRY="$(read_secret_b64 HIVRA_ACTIVITY_TELEMETRY_B64)"
  rm -f -- "$SECRET_ENV_FILE"
  SECRET_ENV_FILE=""
else
  HIVRA_TUNNEL_TOKEN="${HIVRA_TUNNEL_TOKEN:-}"
  HIVRA_TUNNEL_URL="${HIVRA_TUNNEL_URL:-}"
  HIVRA_MODEL_KEY="${HIVRA_MODEL_KEY:-}"
  HIVRA_MODEL_BASE_URL="${HIVRA_MODEL_BASE_URL:-}"
  HIVRA_HERMES_MODEL="${HIVRA_HERMES_MODEL:-}"
fi
HIVRA_COMPUTER_ID="${HIVRA_COMPUTER_ID:-}"
HIVRA_CONTROL_ORIGIN="${HIVRA_CONTROL_ORIGIN:-}"
validate_named_tunnel_input() {
  if [ -n "${HIVRA_TUNNEL_TOKEN:-}" ] || [ -n "${HIVRA_TUNNEL_URL:-}" ]; then
    [[ "${HIVRA_TUNNEL_URL:-}" == https://* ]] || fail "named tunnel URL must use HTTPS"
    [[ "${HIVRA_TUNNEL_TOKEN:-}" =~ ^[A-Za-z0-9._=-]+$ ]] || fail "named tunnel token has an invalid format"
  fi
}
validate_named_tunnel_input
validate_linux_desktop_input() {
  [ "$AGENT_KIND" = "linux-desktop" ] || return 0
  [ -n "${HIVRA_TUNNEL_TOKEN:-}" ] && [ -n "${HIVRA_TUNNEL_URL:-}" ] \
    || fail "Linux Desktop requires pre-journaled named HTTPS access"
  [ -z "${HIVRA_WANT_BROWSER:-}" ] \
    || fail "Linux Desktop does not accept the agent browser option"
  [ -z "$HIVRA_MODEL_KEY" ] && [ -z "$HIVRA_MODEL_BASE_URL" ] && [ -z "$HIVRA_HERMES_MODEL" ] \
    || fail "Linux Desktop does not accept agent model settings"
  [[ "$HIVRA_COMPUTER_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
    || fail "Linux Desktop requires a lowercase computer UUID"
  if ! printf '%s\0%s\0' "$HIVRA_CONTROL_ORIGIN" "$HIVRA_TUNNEL_URL" | python3 -I -B -c '
import re, sys
values = sys.stdin.buffer.read(1025).decode("ascii").split("\0")
if len(values) != 3 or values[-1] != "": raise SystemExit(1)
for value in values[:2]:
    if len(value) > 261 or not value.startswith("https://"): raise SystemExit(1)
    host = value[8:]
    if "." not in host or not re.fullmatch(r"[a-z0-9.-]+", host): raise SystemExit(1)
    if any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split(".")): raise SystemExit(1)
'; then
    fail "Linux Desktop origins must be canonical HTTPS origins"
  fi
}
validate_linux_desktop_input
if [ "$AGENT_KIND" = "deepseek-harness" ] && { [ -z "${HIVRA_TUNNEL_TOKEN:-}" ] || [ -z "${HIVRA_TUNNEL_URL:-}" ]; }; then
  fail "DeepSeek Harness requires pre-journaled named HTTPS access"
fi
install -m 0600 "${VM_KEY}.pub" "$CIKEYS"
if [ -n "${HIVRA_OPERATOR_PUBLIC_KEY_PATH:-}" ] && [ -f "${HIVRA_OPERATOR_PUBLIC_KEY_PATH}" ]; then
  cat "${HIVRA_OPERATOR_PUBLIC_KEY_PATH}" >> "$CIKEYS"
fi

# The stock Ubuntu cloud image does not consistently include QEMU Guest Agent.
# Install it through VMID-owned vendor data so the hypervisor channel can
# attest the guest SSH key before any network connection carries credentials.
install -d -o root -g root -m 0700 "$CLOUD_INIT_SNIPPET_DIR"
CLOUD_INIT_SNIPPET="$CLOUD_INIT_SNIPPET_DIR/hivra-qga-${VMID}-${OPERATION_ID}.yaml"
( set -o noclobber
  cat > "$CLOUD_INIT_SNIPPET" <<'HIVRA_QGA_VENDOR_DATA'
#cloud-config
package_update: true
packages:
  - qemu-guest-agent
runcmd:
  - [systemctl, enable, --now, qemu-guest-agent.service]
HIVRA_QGA_VENDOR_DATA
) 2>/dev/null || fail "could not create operation-scoped QEMU Guest Agent vendor data"
chmod 0600 "$CLOUD_INIT_SNIPPET"

log "creating VM $VMID (${CORES} vCPU / ${MEM_MB} MB) at $IP"
qm create "$VMID" --name "hivra-cc-${VMID}" --memory "$MEM_MB" --cores "$CORES" --cpu host \
  --cpulimit "$CPU_LIMIT" \
  --tags "${BINDING_TAG};${OPERATION_TAG}" \
  --net0 "virtio,bridge=${BRIDGE}" --scsihw virtio-scsi-single --serial0 socket --vga serial0 \
  --ostype l26 --agent enabled=1 >/dev/null
CREATED=1
# This receipt is emitted only after atomic VM creation stamped both ownership
# tags. The dashboard never persists or rolls back a VMID merely observed in a
# stale inventory snapshot; it waits for this exact operation/binding proof.
install -d -m 0755 /run/hivra-provision
ALLOCATION_RECEIPT_TMP="${ALLOCATION_RECEIPT_FILE}.tmp.$$"
install -m 0600 /dev/null "$ALLOCATION_RECEIPT_TMP"
printf 'operation_id=%s\nbinding_tag=%s\nvmid=%s\n' \
  "$OPERATION_ID" "$BINDING_TAG" "$VMID" > "$ALLOCATION_RECEIPT_TMP"
mv "$ALLOCATION_RECEIPT_TMP" "$ALLOCATION_RECEIPT_FILE"
qm set "$VMID" --scsi0 "${STORAGE}:0,import-from=${IMG},discard=on,ssd=1" >/dev/null
qm disk resize "$VMID" scsi0 "${DISK_GB}G" >/dev/null
qm set "$VMID" --ide2 "${STORAGE}:cloudinit" >/dev/null
qm set "$VMID" --boot order=scsi0 --ciuser ubuntu --sshkeys "$CIKEYS" >/dev/null
qm set "$VMID" --ipconfig0 "ip=${IP}/24,gw=${GW}" >/dev/null
qm set "$VMID" --cicustom "vendor=${CLOUD_INIT_SNIPPET_STORAGE}:snippets/$(basename "$CLOUD_INIT_SNIPPET")" >/dev/null
qm set "$VMID" --nameserver "$NAMESERVERS" >/dev/null
qm start "$VMID" >/dev/null
# Keep capacity, VMID, and IP allocation serialized until the new guest is an
# active member of the inventory. Guest setup continues concurrently afterward.
release_allocation_lock

guest_boot_uptime() {
  local uptime
  IFS=' ' read -r uptime _ < /proc/uptime || return 1
  uptime="${uptime%%.*}"
  [[ "$uptime" =~ ^[0-9]{1,12}$ ]] || return 1
  printf '%s\n' "$uptime"
}

prepare_guest_ssh_identity() {
  local started now deadline attempt qga_document host_key=""
  vm_owned_by_operation || fail "VM ownership changed before guest SSH identity binding"
  qm config "$VMID" 2>/dev/null | grep -Eq "^ipconfig0: .*ip=${IP}/24([,]|$)" \
    || fail "VM private IP changed before guest SSH identity binding"
  started="$(guest_boot_uptime)" || fail "guest boot clock is unavailable"
  deadline=$((started + 600))
  for attempt in $(seq 1 120); do
    now="$(guest_boot_uptime)" || fail "guest boot clock is unavailable"
    [ "$now" -lt "$deadline" ] || break
    qga_document="$(qm guest exec "$VMID" -- /bin/cat /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null || true)"
    if [ -n "$qga_document" ]; then
      host_key="$(printf '%s' "$qga_document" | /usr/bin/python3 -c '
import base64, binascii, json, sys
try:
    document = json.load(sys.stdin)
    fields = document.get("out-data", "").strip().split()
    raw = base64.b64decode(fields[1], validate=True)
    expected = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20"
    if (document.get("exited") != 1 or document.get("exitcode") != 0 or
            len(fields) < 2 or fields[0] != "ssh-ed25519" or
            len(raw) != 51 or not raw.startswith(expected)):
        raise ValueError("invalid VMID-bound SSH host key")
except (IndexError, KeyError, TypeError, ValueError, binascii.Error, json.JSONDecodeError):
    raise SystemExit(1)
print("ssh-ed25519 " + fields[1])
' 2>/dev/null || true)"
      [ -z "$host_key" ] || break
    fi
    sleep 5
  done
  [ -n "$host_key" ] || fail "guest SSH host identity could not be attested through QEMU Guest Agent"
  GUEST_SSH_IDENTITY_DIR="$(mktemp -d "/run/hivra-guest-ssh-identity.${VMID}.XXXXXXXX")"
  chmod 0700 "$GUEST_SSH_IDENTITY_DIR"
  GUEST_SSH_KNOWN_HOSTS="$GUEST_SSH_IDENTITY_DIR/known_hosts"
  GUEST_SSH_HOST_ALIAS="hivra-vmid-$VMID"
  printf '%s %s\n' "$GUEST_SSH_HOST_ALIAS" "$host_key" > "$GUEST_SSH_KNOWN_HOSTS"
  chmod 0600 "$GUEST_SSH_KNOWN_HOSTS"
}

log "attesting guest SSH host identity through VMID $VMID"
prepare_guest_ssh_identity
GSSH=(ssh -i "$VM_KEY" -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UpdateHostKeys=no \
  -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile="$GUEST_SSH_KNOWN_HOSTS" \
  -o HostKeyAlias="$GUEST_SSH_HOST_ALIAS" -o ConnectTimeout=10)
GSCP=(scp -i "$VM_KEY" -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UpdateHostKeys=no \
  -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile="$GUEST_SSH_KNOWN_HOSTS" \
  -o HostKeyAlias="$GUEST_SSH_HOST_ALIAS" -o ConnectTimeout=10)

wait_for_guest_cloud_init() {
  local started now deadline remaining probe_budget pause attempt output exit_code
  local last_state="SSH unavailable"
  started="$(guest_boot_uptime)" || fail "guest boot clock is unavailable"
  deadline=$((started + 600))
  # SSH and cloud-init are expected to be unavailable/running during first
  # boot. Poll their read-only state; never mask a completed failure as ready.
  # Each probe is killable, and late success cannot outlive the overall budget.
  for attempt in $(seq 1 60); do
    now="$(guest_boot_uptime)" || fail "guest boot clock is unavailable"
    remaining=$((deadline - now))
    [ "$remaining" -gt 2 ] || break
    probe_budget=$((remaining - 2))
    [ "$probe_budget" -le 20 ] || probe_budget=20
    exit_code=0
    output="$(timeout --kill-after=2s "${probe_budget}s" "${GSSH[@]}" \
      -o BatchMode=yes -o ConnectionAttempts=1 -o ServerAliveInterval=5 \
      -o ServerAliveCountMax=2 -n "ubuntu@${IP}" \
      'LC_ALL=C sudo -n cloud-init status' 2>/dev/null)" || exit_code=$?
    now="$(guest_boot_uptime)" || fail "guest boot clock is unavailable"
    [ "$now" -lt "$deadline" ] || break
    case "$exit_code" in
      0)
        case "$output" in
          'status: done') log "guest cloud-init completed"; return 0 ;;
          'status: running') last_state="cloud-init running" ;;
          'status: not run') last_state="cloud-init not started" ;;
          'status: disabled') fail "guest cloud-init is disabled; refusing runtime installation" ;;
          *) fail "guest cloud-init returned an unrecognized status; refusing runtime installation" ;;
        esac
        ;;
      255) last_state="SSH unavailable" ;;
      124|137) last_state="SSH probe timed out" ;;
      *) fail "guest cloud-init check failed (exit ${exit_code}); inspect cloud-init status and logs before retrying" ;;
    esac
    # Guest diagnostics can contain user-data. Log only the classified reason,
    # not command output. The caller's existing EXIT trap owns VM cleanup.
    pause=$((deadline - now))
    [ "$pause" -le 8 ] || pause=8
    sleep "$pause"
  done
  fail "guest boot timed out (${last_state}); runtime installation was not started"
}

log "waiting for guest ssh + cloud-init"
wait_for_guest_cloud_init

# The package and generated SSH host key now live on the guest disk. Remove the
# operation-scoped vendor-data reference and host file so no bootstrap material
# survives or can be replayed by a later VMID reuse.
qm set "$VMID" --delete cicustom >/dev/null
rm -f -- "$CLOUD_INIT_SNIPPET"
CLOUD_INIT_SNIPPET=""

copy_prepared_desktop_image() {
  [ "$AGENT_KIND" = "linux-desktop" ] || return 0
  # Optional operator-owned sibling cache, never part of the recursive bundle
  # copy or required for self-hosted source builds. Keep these pins aligned with
  # remote-desktop/install-guest.py; the guest independently hashes before load.
  local image_sha=08e5d4f557da6f037ada4630bcd4ba9bf96083cbe11f98c84105bcf08e4b8578
  local cache_dir="${PROV_DIR}.desktop-images"
  local archive="${cache_dir}/${image_sha}.tar"
  [ -e "$archive" ] || [ -L "$archive" ] || return 0
  vm_owned_by_operation || fail "VM ownership changed before desktop image transfer"
  log "copying pinned desktop image candidate"
  python3 -I -B "$PROV_DIR/hivra-copy-desktop-image.py" --cache "$cache_dir" -- \
    "${GSSH[@]}" "ubuntu@${IP}" 'sudo -n /bin/sh -c '\''
set -eu
umask 077
for directory in /var /var/cache /var/cache/hivra /var/cache/hivra/desktop-images; do
  test ! -L "$directory"
  if test ! -e "$directory"; then /usr/bin/install -d -o root -g root -m 0700 "$directory"; fi
  test -d "$directory"
  test "$(stat -Lc %u "$directory")" = 0
  test -z "$(find "$directory" -maxdepth 0 -perm /022 -print -quit)"
done
/bin/dd of=/var/cache/hivra/desktop-images/08e5d4f557da6f037ada4630bcd4ba9bf96083cbe11f98c84105bcf08e4b8578.tar conv=excl status=none
'\''' || fail "prepared desktop image transfer failed"
}
copy_prepared_desktop_image

log "copying provisioner + running it (kind=${AGENT_KIND}, this takes several minutes)"
GUEST_PROVISIONER=/tmp/hivra-provisioner
if [ "$AGENT_KIND" = "deepseek-harness" ]; then
  # Native modules are imported under root authority and deliberately reject
  # an agent-writable /tmp handoff. Stream only this reviewed root-owned bundle
  # into a fresh non-listable root directory; no guest user may replace it
  # between validation and import.
  command -v tar >/dev/null 2>&1 || fail "tar is required for the native provisioner handoff"
  [ -z "$(find "$PROV_DIR" -xdev ! -user root -print -quit)" ] \
    || fail "native provisioner source is not root-owned"
  [ -z "$(find "$PROV_DIR" -xdev \( -type l -o \( ! -type f ! -type d \) \) -print -quit)" ] \
    || fail "native provisioner source contains an unsupported entry"
  [ -z "$(find "$PROV_DIR" -xdev -perm /022 -print -quit)" ] \
    || fail "native provisioner source is group/other writable"
  GUEST_PROVISIONER=/opt/hivra/provider-bundle
  "${GSSH[@]}" "ubuntu@${IP}" \
    'sudo -n /bin/sh -c '\''set -eu; umask 077; test ! -e /opt/hivra/provider-bundle; /usr/bin/install -d -o root -g root -m 0711 /opt/hivra; /usr/bin/install -d -o root -g root -m 0700 /opt/hivra/provider-bundle'\'''
  tar -C "$PROV_DIR" -cf - . | "${GSSH[@]}" "ubuntu@${IP}" \
    'sudo -n /bin/sh -c '\''set -eu; umask 077; /bin/tar --no-same-owner --no-same-permissions -xf - -C /opt/hivra/provider-bundle'\'''
else
  "${GSCP[@]}" -r "$PROV_DIR" "ubuntu@${IP}:${GUEST_PROVISIONER}" >/dev/null
fi
# Model and tunnel credentials travel only through stdin. The shared guest
# entrypoint owns runtime selection, strict decoding and named-tunnel setup;
# the host retains VM allocation, public reachability and result convergence.
guest_launch_document() {
  printf '%s\0' "$AGENT_KIND" "${HIVRA_WANT_BROWSER:-}" "$HIVRA_MODEL_KEY" \
    "$HIVRA_MODEL_BASE_URL" "$HIVRA_HERMES_MODEL" "${HIVRA_TUNNEL_TOKEN:-}" "${HIVRA_TUNNEL_URL:-}" \
    "$HIVRA_COMPUTER_ID" "$HIVRA_CONTROL_ORIGIN" "${HIVRA_ACTIVITY_TELEMETRY:-}" \
    | python3 -I -B -c '
import json, sys
try:
    raw = sys.stdin.buffer.read(32769)
    if len(raw) > 32768:
        raise ValueError()
    values = raw.decode("utf-8").split("\0")
    if len(values) != 11 or values[-1] != "" or values[1] not in ("", "0", "1"):
        raise ValueError()
    native = values[0] == "deepseek-harness"
    desktop = values[0] == "linux-desktop"
    if native and (values[2] or values[3] or values[4] or not values[5] or not values[6]):
        raise ValueError()
    if desktop and (values[1] or values[2] or values[3] or values[4] or not values[5] or not values[6] or not values[7] or not values[8]):
        raise ValueError()
    document = {"version": 3 if desktop else 2 if native else 1, "agentKind": values[0], "computerSubstrate": "proxmox-kvm",
        "wantBrowser": None if values[1] == "" else values[1] == "1", "modelKey": values[2],
        "modelBaseUrl": values[3], "model": values[4], "tunnelToken": values[5] or None,
        "accessHostname": None}
    if native or desktop:
        document["publicOrigin"] = values[6]
    if desktop:
        document["computerId"] = values[7]
        document["controlOrigin"] = values[8]
    if values[9]:
        telemetry = json.loads(values[9])
        if values[0] not in ("claude", "codex") or not isinstance(telemetry, dict):
            raise ValueError()
        document["version"] = 4
        document["activityTelemetry"] = telemetry
    print(json.dumps(document))
except Exception:
    print("invalid guest launch input", file=sys.stderr)
    sys.exit(1)
'
}
guest_launch_document | "${GSSH[@]}" "ubuntu@${IP}" \
  "sudo -n /usr/bin/python3 -I -B ${GUEST_PROVISIONER}/hivra-install-agent.py" >&2

TUNNEL=""
# The shared guest entrypoint has configured the reboot-safe named tunnel.
# Observe it from outside the guest before returning a successful launch.
if [ -n "${HIVRA_TUNNEL_TOKEN:-}" ] && [ -n "${HIVRA_TUNNEL_URL:-}" ]; then
  log "checking CloudFlare NAMED tunnel -> ${HIVRA_TUNNEL_URL}"
  NAMED_READY=0
  for _ in $(seq 1 60); do
    if curl -fsS -m 8 "${HIVRA_TUNNEL_URL%/}/healthz" >/dev/null 2>&1; then NAMED_READY=1; break; fi
    sleep 5
  done
  if [ "$NAMED_READY" = "1" ]; then
    TUNNEL="${HIVRA_TUNNEL_URL}"
  else
    fail "named tunnel health check timed out"
  fi
fi

if [ -z "$TUNNEL" ]; then
  log "opening cloudflared http2 QUICK tunnel to chat port ${CHAT_PORT}"
  "${GSSH[@]}" "ubuntu@${IP}" "HIVRA_CHAT_PORT=${CHAT_PORT} bash -s" <<'TUN' >&2
set -e
command -v cloudflared >/dev/null 2>&1 || { echo "cloudflared is missing" >&2; exit 1; }
pkill -f "cloudflared tunnel" 2>/dev/null || true
tmux kill-session -t cf 2>/dev/null || true
# http2 is mandatory: default QUIC/UDP does not survive the isolated NAT.
tmux new-session -d -s cf "cloudflared tunnel --url http://localhost:${HIVRA_CHAT_PORT} --no-autoupdate --protocol http2 2>&1 | tee /tmp/cf.log"
TUN
  for _ in $(seq 1 60); do
    TUNNEL="$("${GSSH[@]}" "ubuntu@${IP}" 'grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" /tmp/cf.log 2>/dev/null | head -1' 2>/dev/null || true)"
    REG="$("${GSSH[@]}" "ubuntu@${IP}" 'grep -cE "Registered tunnel connection" /tmp/cf.log 2>/dev/null || echo 0' 2>/dev/null || echo 0)"
    if [ -n "$TUNNEL" ] && [ "$REG" -ge 1 ] && curl -fsS -m 8 "${TUNNEL%/}/healthz" >/dev/null 2>&1; then break; fi
    TUNNEL=""
    sleep 4
  done
fi

[ -n "$TUNNEL" ] && READY=true || READY=false
if [ "$READY" != true ]; then
  fail "quick tunnel did not become healthy"
fi
APITOKEN="$("${GSSH[@]}" "ubuntu@${IP}" 'sudo cat /home/bux/.hivra/api-token 2>/dev/null' 2>/dev/null | tr -d '[:space:]')"
[ "${#APITOKEN}" -eq 64 ] && [[ "$APITOKEN" =~ ^[0-9a-f]+$ ]] || fail "guest API token is missing or invalid"
install -d -m 0700 /var/lib/hivra /var/lib/hivra/provision-results
SECRET_TMP="${SECRET_RESULT_FILE}.tmp.$$"
install -m 0600 /dev/null "$SECRET_TMP"
printf '%s\n' "$APITOKEN" > "$SECRET_TMP"
mv "$SECRET_TMP" "$SECRET_RESULT_FILE"
log "done: vmid=$VMID ip=$IP kind=$AGENT_KIND chat_url=${TUNNEL:-<none>} ready=$READY token=${APITOKEN:+set}"
printf '{"vmid":%s,"ip":"%s","cores":%s,"mem_mb":%s,"agent_kind":"%s","chat_url":"%s","ready":%s}\n' \
  "$VMID" "$IP" "$CORES" "$MEM_MB" "$AGENT_KIND" "$TUNNEL" "$READY"
CREATED=0
