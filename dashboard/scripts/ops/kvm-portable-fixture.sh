#!/bin/bash
set -Eeuo pipefail
umask 077

base_sha=d80fe50055e780901549d0dfab203551d79e31cb0fa9ac2b4d45efa1e8a51052
base_url=https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-amd64.img
max_disk=$((12 * 1024**3))
sha_regex='^[0-9a-f]{64}$'
key_regex='^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43}$'

die() { printf 'kvm fixture: %s\n' "$*" >&2; exit 1; }
sha() { timeout 90 sha256sum -- "$1" | cut -d ' ' -f1; }
absent() { [[ ! -e "$1" && ! -L "$1" ]]; }
private_file() {
  [[ -f "$1" && ! -L "$1" && "$(stat -c '%u:%a:%h' -- "$1")" == 0:600:1 ]]
}
present_exact() { grep -Fxq -- "$1" <<< "$2"; }

usage() {
  printf '%s\n' 'Usage: kvm-portable-fixture.sh ACTION RUN SOURCE_HOST SOURCE_VMID TARGET_HOST TARGET_VMID [UTC_DEADLINE]' \
    'Actions: prepare (requires UTC deadline), fence-source, boot-target, cleanup' \
    'RUN: exactly 32 lowercase hex digits; deadline: YYYY-MM-DDTHH:MM:SSZ'
}

validate() {
  (( $# == 6 || $# == 7 )) || die "expected an action and exact fixture pair (see --help)"
  action=$1 run=$2 source_host=$3 source_id=$4 target_host=$5 target_id=$6 deadline=${7-}
  [[ "$run" =~ ^[0-9a-f]{32}$ ]] || die "invalid run ID"
  [[ "$source_host" =~ ^pve[0-9]{1,4}$ && "$target_host" =~ ^pve[0-9]{1,4}$ && "$source_host" != "$target_host" ]] \
    || die "expected two distinct exact Proxmox hosts"
  [[ "$source_id" =~ ^93[0-9]{2}$ && "$target_id" =~ ^93[0-9]{2}$ && "$source_id" != 9302 && "$target_id" != 9302 && "$source_id" != "$target_id" ]] \
    || die "expected distinct VMIDs 9300–9399, excluding 9302"
  case "$action" in
    prepare)
      [[ $# == 7 && "$deadline" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || die "invalid UTC deadline"
      local now end
      now=$(date +%s)
      end=$(date -u -d "$deadline" +%s) || die "invalid UTC deadline"
      (( end > now + 180 && end <= now + 3600 )) || die "deadline must be between 3 and 60 minutes away"
      ;;
    fence-source|boot-target|cleanup) [[ $# == 6 ]] || die "unexpected deadline" ;;
    *) die "unknown action" ;;
  esac
}

identify() {
  node=$(hostname -s)
  if [[ "$node" == "$source_host" ]]; then
    role=source vm=$source_id
  elif [[ "$node" == "$target_host" ]]; then
    role=target vm=$target_id
  else
    die "this host is not in the exact fixture pair"
  fi
  [[ "$action" != fence-source || "$role" == source ]] || die "fence-source must run on the source"
  [[ "$action" != boot-target || "$role" == target ]] || die "boot-target must run on the target"
  binding="$run $source_host $source_id $target_host $target_id"
  port=$((49000 + vm - 9300))
  dir="/var/tmp/hivra-kvm-portable-$run"
  cfg="/etc/pve/qemu-server/$vm.conf"
  lxc_cfg="/etc/pve/lxc/$vm.conf"
  pid="/run/qemu-server/$vm.pid"
  name="hivra-kvm-$run"
  tag="hivra-kvm-$role-$run"
  timer="hivra-kvm-$vm-$run-deadline"
  mac="02:51:${run:0:2}:${run:2:2}:${run:4:2}:${run:6:2}"
  uuid="$(printf '%s' "$binding" | sha256sum | cut -c1-32)"
  uuid="${uuid:0:8}-${uuid:8:4}-${uuid:12:4}-${uuid:16:4}-${uuid:20:12}"
  args="-drive if=none,id=qadisk,file=$dir/guest.qcow2,format=qcow2,cache=none,bps=33554432,iops=500"
  args+=" -device virtio-blk-pci,drive=qadisk,bootindex=1"
  args+=" -drive if=none,id=qaseed,file=$dir/seed.iso,format=raw,readonly=on"
  args+=" -device virtio-blk-pci,drive=qaseed"
  args+=" -netdev user,id=qan,restrict=on,ipv6=off,hostfwd=tcp:127.0.0.1:$port-:22"
  args+=" -device virtio-net-pci,netdev=qan,mac=$mac"
}

pressure() {
  awk '$1=="full" && $2 ~ /^avg10=[0-9]+(\.[0-9]+)?$/ {
    split($2, a, "="); allowed = a[2] <= 1; seen++
  } END { exit !(seen == 1 && allowed) }' /proc/pressure/io || die "I/O full PSI avg10 exceeded 1% or is unavailable"
}

admission() {
  pressure
  [[ -c /dev/kvm ]] || die "KVM unavailable"
  awk '$1=="MemAvailable:" && $2>=62914560 { ok=1 } END { exit !ok }' /proc/meminfo \
    || die "less than 60 GiB MemAvailable"
  case "$(findmnt -n -o FSTYPE --target /var/tmp)" in
    ext4|xfs|zfs|btrfs) ;;
    *) die "/var/tmp is not on an admitted local filesystem" ;;
  esac
  local free
  free=$(df -B1 --output=avail /var/tmp | tail -1 | tr -d ' ')
  if [[ ! "$free" =~ ^[0-9]+$ ]] || (( free < 40 * 1024**3 )); then die "less than 40 GiB fixture space"; fi
}

open_lease() {
  [[ -d "$dir" && ! -L "$dir" && "$(stat -c '%u:%a' -- "$dir")" == 0:700 ]] || die "wrong fixture directory"
  exec 7<"$dir"
  flock -x -w 120 7 || die "fixture operation still holds the lease"
  [[ "$dir" -ef /proc/$$/fd/7 ]] || die "fixture directory changed"
}

check_lease() {
  local -a lease
  private_file "$dir/lease" || die "missing private fixture lease"
  mapfile -t lease < "$dir/lease"
  [[ ${#lease[@]} == 3 && "${lease[0]}" == "$binding" && "${lease[1]}" == "$role" ]] || die "fixture lease mismatch"
  deadline=${lease[2]}
}

check_time() {
  [[ "$(date -u +%FT%TZ)" < "$deadline" ]] || die "fixture deadline expired"
  systemctl is-active --quiet "$timer.timer" || die "fixture cleanup timer is not active"
}

check_provision_absent() {
  local file
  for file in "/run/hivra-provision/$vm."{allocated,env,pid,secret} "/var/lib/hivra/provision-results/$vm.secret"; do
    absent "$file" || die "VMID has a Hivra provision artifact"
  done
  for file in /var/lib/hivra/provision-operations/operation-*.selected; do
    [[ -f "$file" ]] || continue
    if grep -Fxq "vmid=$vm" "$file"; then die "VMID has a Hivra provision intent"; fi
  done
}

claim_vm() {
  mkdir -p /run/lock/hivra-vmids
  exec 8>>/run/lock/hivra-allocation.lock
  flock -w 20 8 || die "Hivra allocation lock busy"
  command timeout -k 1 1 logger --socket-errors=off -t hivra-allocation-lock -- "event=acquired mode=exclusive operation=portable-fixture-create holder_pid=$BASHPID" </dev/null >/dev/null 2>&1 8>&- 9>&- || :
  exec 9>>"/run/lock/hivra-vmids/$vm.lock"
  flock -n 9 || die "VMID allocation lock busy"
  check_provision_absent
  if ! absent "$cfg" || ! absent "$lxc_cfg" || ! absent "$pid"; then die "VMID has local state"; fi
  [[ "$(pvesh get /cluster/nextid --vmid "$vm")" == "$vm" ]] || die "VMID is not free cluster-wide"
  port_free
  : > "$dir/claim-attempt"
  local -a opts=()
  if [[ "$role" == target ]]; then opts+=(--lock backup); fi
  timeout 25 qm create "$vm" --name "$name" --tags "$tag" --onboot 0 \
    --memory 2048 --cores 2 --cpulimit 1 --cpu x86-64-v2-AES --ostype l26 --bios seabios --machine pc-i440fx-8.1 \
    --smbios1 "uuid=$uuid" --vmgenid "$uuid" --args "$args" "${opts[@]}"
  exec 9>&- 8>&-
}

check_vm() {
  local lock=$1 config line
  if [[ ! -f "$cfg" ]] || ! absent "$lxc_cfg"; then die "missing or conflicting Proxmox fixture"; fi
  check_provision_absent
  if grep -Eq '^\[' "$cfg"; then die "VM has pending changes or snapshots"; fi
  config=$(qm config "$vm" --current 1) || die "cannot read fixture config"
  for line in "name: $name" "tags: $tag" "args: $args" "smbios1: uuid=$uuid" "vmgenid: $uuid" \
    'onboot: 0' 'memory: 2048' 'cores: 2' 'cpulimit: 1' 'cpu: x86-64-v2-AES' 'ostype: l26' 'bios: seabios' 'machine: pc-i440fx-8.1'; do
    present_exact "$line" "$config" || die "unexpected fixture config: ${line%%:*}"
  done
  if [[ "$lock" == none ]]; then
    if grep -q '^lock:' <<< "$config"; then die "unexpected Proxmox lock"; fi
  else
    present_exact "lock: $lock" "$config" || die "missing exact Proxmox fence"
  fi
  while IFS= read -r line; do
    if [[ "$line" =~ ^boot:[[:space:]]*(order=)?$ ]]; then continue; fi
    case "${line%%:*}" in
      args|bios|cores|cpu|cpulimit|lock|machine|memory|meta|name|onboot|ostype|smbios1|tags|vmgenid) ;;
      *) die "refusing unexpected Proxmox setting: ${line%%:*}" ;;
    esac
  done <<< "$config"
}

port_free() {
  local listeners
  listeners=$(ss -lntH "sport = :$port") || die "cannot inspect fixture port"
  [[ -z "$listeners" ]] || die "fixture port $port is already listening"
}

stopped() {
  [[ "$(qm status "$vm")" == 'status: stopped' ]] && absent "$pid"
}

verify_base() {
  if ! private_file "$dir/base.img" || [[ "$(sha "$dir/base.img")" != "$base_sha" ]]; then die "pinned base hash or ownership mismatch"; fi
}

verify_disk() {
  local mode=$1 info
  private_file "$dir/guest.qcow2" || die "guest.qcow2 is not root-owned, private and regular"
  info=$(timeout 20 qemu-img info -f qcow2 --output=json "$dir/guest.qcow2")
  python3 -c '
import json
import sys

mode, base, size = sys.argv[1:]
info = json.load(sys.stdin)
data = info["format-specific"]["data"]
valid = (
    info["format"] == "qcow2"
    and info["virtual-size"] == int(size)
    and not info.get("snapshots")
    and data["corrupt"] is False
    and not data.get("data-file")
)
if mode == "delta":
    valid = valid and (
        info.get("backing-filename") == "base.img"
        and info.get("full-backing-filename") == base
        and info.get("backing-filename-format") == "qcow2"
    )
else:
    valid = valid and not any(k in info for k in ("backing-filename", "full-backing-filename"))
sys.exit(not valid)
' "$mode" "$dir/base.img" "$max_disk" <<< "$info" || die "restored qcow2 has unexpected geometry or dependencies"
}

seed() {
  local pub
  pub=$(ssh-keygen -y -f "$dir/client.key" | cut -d ' ' -f1,2)
  [[ "$pub" =~ $key_regex ]] || die "invalid fixture SSH client key"
  printf 'instance-id: %s\nlocal-hostname: %s\n' "$name" "$name" > "$dir/meta-data"
  cat > "$dir/user-data" <<EOF
#cloud-config
disable_root: true
ssh_pwauth: false
users:
  - name: fixture
    lock_passwd: true
    shell: /bin/bash
    ssh_authorized_keys:
      - $pub
EOF
  if [[ "$role" == source ]]; then
    ssh-keygen -q -t ed25519 -N '' -f "$dir/host.key"
    cat >> "$dir/user-data" <<EOF
ssh_keys:
  ed25519_public: $(cut -d ' ' -f1,2 "$dir/host.key.pub")
  ed25519_private: |
$(sed 's/^/    /' "$dir/host.key")
EOF
    pin "$(cut -d ' ' -f1,2 "$dir/host.key.pub")"
  fi
  timeout 20 genisoimage -quiet -output "$dir/seed.iso" -volid cidata -joliet -rock "$dir/user-data" "$dir/meta-data"
  rm -- "$dir/user-data" "$dir/meta-data"
  if [[ "$role" == source ]]; then rm -- "$dir/host.key" "$dir/host.key.pub"; fi
}

pin() {
  [[ "$1" =~ $key_regex ]] || die "invalid fixture SSH host pin"
  printf '[127.0.0.1]:%s %s\n' "$port" "$1" > "$dir/known_hosts"
}

guest() {
  timeout 12 ssh -F /dev/null -i "$dir/client.key" -p "$port" \
    -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o ConnectTimeout=3 \
    -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$dir/known_hosts" \
    -o GlobalKnownHostsFile=/dev/null -o UpdateHostKeys=no -o LogLevel=ERROR \
    "fixture@127.0.0.1" "$@"
}

start_guest() {
  local lock=$1
  local -a opts=()
  if [[ "$lock" != none ]]; then opts+=(--skiplock 1); fi
  admission
  check_vm "$lock"
  stopped || die "fixture is not stopped"
  port_free
  check_time
  (( $(date -u -d "$deadline" +%s) - $(date +%s) > 180 )) || die "less than three minutes before fixture cleanup"
  : > "$dir/boot-attempt"
  timeout 55 qm start "$vm" "${opts[@]}" 7>&- 8>&- 9>&-
  local end=$((SECONDS + 150))
  while (( SECONDS < end )); do
    check_time
    if [[ "$(guest 'hostname -s' 2>/dev/null)" == "$name" ]]; then return; fi
    sleep 2
  done
  die "guest did not answer on the pinned loopback SSH endpoint"
}

prepare() {
  local calendar
  calendar=$(date -u -d "$deadline" '+%F %T UTC')
  admission
  mkdir -m 700 -- "$dir" || die "run directory already exists"
  open_lease
  printf '%s\n' "$binding" "$role" "$deadline" > "$dir/lease"
  install -m 0700 -- "${BASH_SOURCE[0]}" "$dir/runner"
  systemd-run --quiet --unit="$timer" --on-calendar="$calendar" \
    --timer-property=AccuracySec=1s --property=RuntimeMaxSec=240s --collect \
    /bin/bash "$dir/runner" cleanup "$run" "$source_host" "$source_id" "$target_host" "$target_id"
  check_time
  claim_vm
  curl -fsSL --proto '=https' --proto-redir '=https' --max-time 130 --limit-rate 5M --max-filesize 400000000 -o "$dir/base.img" "$base_url"
  verify_base
  if [[ "$role" == source ]]; then
    timeout 20 qemu-img create -f qcow2 -F qcow2 -b base.img "$dir/guest.qcow2" "$max_disk"
    verify_disk delta
    ssh-keygen -q -t ed25519 -N '' -f "$dir/client.key"
    rm -- "$dir/client.key.pub"
    seed
    start_guest none
    local token
    token=$(cat /proc/sys/kernel/random/uuid)
    [[ "$token" =~ ^[0-9a-f-]{36}$ ]] || die "failed to generate synthetic witness"
    guest "umask 077; set -C; printf '%s\\n' '$token' > .hivra-portable-witness && sync"
  else
    check_vm backup
    stopped || die "reserved target is not stopped"
  fi
  printf 'prepared %s %s/%s (%s) deadline=%s\n' "$role" "$node" "$vm" "$dir" "$deadline"
}

fence_source() {
  check_time
  pressure
  check_vm none
  absent "$dir/fence.receipt" || die "fixture was already fenced"
  verify_base
  local witness overlay host_pin
  witness=$(guest 'sync && sha256sum .hivra-portable-witness | cut -d " " -f1')
  [[ "$witness" =~ $sha_regex ]] || die "invalid source witness"
  host_pin=$(cut -d ' ' -f2,3 "$dir/known_hosts")
  [[ "$host_pin" =~ $key_regex ]] || die "missing source host pin"
  timeout 55 qm shutdown "$vm" --timeout 45
  stopped || die "source did not shut down"
  timeout 25 qm set "$vm" --lock backup
  check_vm backup
  stopped || die "fenced source is not stopped"
  port_free
  pressure
  verify_disk delta
  overlay=$(sha "$dir/guest.qcow2")
  check_time
  check_vm backup
  stopped || die "source fence readback failed"
  printf '%s\n' hivra-kvm-fence-v1 "$binding" "$deadline" "$base_sha" "$overlay" "$witness" "$host_pin" > "$dir/fence.receipt"
  printf 'fenced %s/%s; copy %s/fence.receipt and fixture-only client.key privately\n' "$node" "$vm" "$dir"
}

boot_target() {
  check_time
  admission
  check_vm backup
  stopped || die "target is not stopped"
  absent "$dir/boot-attempt" || die "target fixture permits one boot attempt"
  local -a fence wake
  local file
  for file in fence.receipt verified-wake.receipt client.key guest.qcow2; do
    private_file "$dir/$file" || die "missing or unsafe staged $file"
    if [[ "$file" != guest.qcow2 ]]; then
      (( $(stat -c '%s' -- "$dir/$file") <= 4096 )) || die "staged $file exceeds fixture bound"
    fi
  done
  mapfile -t fence < "$dir/fence.receipt"
  mapfile -t wake < "$dir/verified-wake.receipt"
  [[ ${#fence[@]} == 7 && "${fence[0]}" == hivra-kvm-fence-v1 && "${fence[1]}" == "$binding" &&
     "${fence[2]}" == "$deadline" && "${fence[3]}" == "$base_sha" && "${fence[4]}" =~ $sha_regex &&
     "${fence[5]}" =~ $sha_regex && "${fence[6]}" =~ $key_regex ]] || die "source fence receipt mismatch"
  [[ ${#wake[@]} == 4 && "${wake[0]}" == hivra-kvm-verified-wake-v1 && "${wake[1]}" == "$(sha "$dir/fence.receipt")" &&
     ( "${wake[2]}" == delta || "${wake[2]}" == whole ) && "${wake[3]}" =~ $sha_regex ]] || die "verified wake receipt mismatch"
  if [[ "${wake[2]}" == delta && "${wake[3]}" != "${fence[4]}" ]]; then die "delta does not match the fenced source overlay"; fi
  verify_base
  (( $(stat -c '%s' -- "$dir/guest.qcow2") <= max_disk + 1024**3 )) || die "qcow2 exceeds fixture bound"
  [[ "$(sha "$dir/guest.qcow2")" == "${wake[3]}" ]] || die "restored disk hash mismatch"
  verify_disk "${wake[2]}"
  pressure
  timeout 90 qemu-img check -f qcow2 "$dir/guest.qcow2"
  pin "${fence[6]}"
  seed
  start_guest backup
  local witness
  witness=$(guest 'sha256sum .hivra-portable-witness | cut -d " " -f1')
  [[ "$witness" == "${fence[5]}" ]] || die "restored guest witness mismatch"
  printf 'verified %s wake on %s/%s: pinned SSH host and source disk witness matched\n' "${wake[2]}" "$node" "$vm"
  timeout 55 qm shutdown "$vm" --timeout 45 --skiplock 1
  check_vm backup
  stopped || die "target did not return to the stopped fence"
  port_free
  printf 'target stopped and fenced on %s/%s\n' "$node" "$vm"
}

cleanup() {
  local lock=none config booted=0
  local -a opts=()
  if ! absent "$dir/boot-attempt"; then booted=1; fi
  if ! absent "$dir/claim-attempt" && ! absent "$cfg"; then
    config=$(qm config "$vm" --current 1)
    if present_exact 'lock: backup' "$config"; then lock=backup; opts+=(--skiplock 1); fi
    check_vm "$lock"
    if ! stopped; then timeout 35 qm stop "$vm" --timeout 25 "${opts[@]}"; fi
    check_vm "$lock"
    stopped || die "refusing to destroy a fixture not proven stopped"
    timeout 30 qm destroy "$vm" --purge 0 --destroy-unreferenced-disks 0 "${opts[@]}"
  fi
  if ! absent "$dir/claim-attempt"; then
    if ! absent "$cfg" || ! absent "$lxc_cfg" || ! absent "$pid"; then die "VM state remains after cleanup"; fi
  fi
  if [[ "$(systemctl show --property=LoadState --value "$timer.timer")" != not-found ]]; then
    systemctl stop "$timer.timer"
  fi
  rm -rf --one-file-system -- "$dir"
  absent "$dir" || die "fixture files remain after cleanup"
  if (( booted )); then port_free; fi
  printf 'cleaned %s/%s (%s)\n' "$node" "$vm" "$dir"
}

main() {
  if [[ $# == 1 && "$1" == --help ]]; then usage; return; fi
  validate "$@"
  (( EUID == 0 )) || die "run as root on the named Proxmox host"
  identify
  if [[ "$action" == prepare ]]; then prepare; return; fi
  if [[ "$action" == cleanup ]] && absent "$dir"; then
    if ! absent "$cfg" || ! absent "$lxc_cfg" || ! absent "$pid"; then die "VM state exists without an owned fixture lease"; fi
    printf 'no fixture lease or local VM state for %s/%s\n' "$node" "$vm"
    return
  fi
  open_lease
  check_lease
  case "$action" in
    fence-source) fence_source ;;
    boot-target) boot_target ;;
    cleanup) cleanup ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
