#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf 'Canary memory QA clone: %s\n' "$1" >&2; exit 1; }
absent() { [[ ! -e "$1" && ! -L "$1" ]]; }
root_file() {
  local owner mode
  [[ -f "$1" && ! -L "$1" ]] || return 1
  read -r owner mode < <(stat -c '%u %a' -- "$1")
  [[ "$owner" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 022) == 0 ))
}
private_receipt() {
  root_file "$1" && [[ "$(stat -c '%a %h' -- "$1")" == '600 1' ]]
}
publish_exact() {
  local path="$1" value="$2" mode="$3" tmp
  tmp="$(mktemp "$(dirname "$path")/.qa-memory.XXXXXXXX")"
  if ! printf '%s\n' "$value" >"$tmp" || ! chmod "$mode" -- "$tmp" || ! ln -T -- "$tmp" "$path"; then
    rm -f -- "$tmp"
    return 1
  fi
  rm -- "$tmp"
}

[[ $# -ge 5 ]] || fail "action and exact owner, VMID, tag and template VMID are required"
action="$1" owner_id="$2" vmid="$3" tag="$4" template_vmid="$5"
shift 5
[[ "$vmid" =~ ^93[0-9]{2}$ && "$vmid" != 9302 && "$tag" =~ ^hivra-qa-mem-[0-9a-f]{32}$ \
  && "$owner_id" =~ ^user_[a-zA-Z0-9]+$ \
  && "$template_vmid" =~ ^[1-9][0-9]{0,8}$ && ! "$template_vmid" =~ ^93[0-9]{2}$ ]] || fail "invalid fixture scope"
case "$action" in
  start)
    [[ $# == 2 && "$1" =~ ^[0-9a-f]{64}$ && "$2" =~ ^[1-9][0-9]{0,8}$ ]] || fail "template config digest and CPU budget are required"
    template_digest="$1" cpu_budget_milli="$2"
    ;;
  qualify) [[ $# == 0 ]] || fail "unexpected qualification arguments" ;;
  *) fail "unknown fixture action" ;;
esac
provisioner=/root/hivra-provisioner-canary
host_id="${HIVRA_CAPACITY_CANARY_HOST_ID:-}"
[[ "$EUID" == 0 && "$host_id" =~ ^[a-z0-9][a-z0-9-]{0,62}$ && "$(cat /proc/sys/kernel/hostname)" == "$host_id" \
  && "$(readlink -e -- "${BASH_SOURCE[0]}")" == "$provisioner/hivra-canary-memory-qa-clone.sh" ]] || fail "wrong host or bundle"
[[ -n "${HIVRA_CAPACITY_CANARY_OVERCOMMIT_MILLI:-}" && -n "${HIVRA_CAPACITY_CANARY_OVERCOMMIT_UNTIL:-}" \
  && "|${HIVRA_CAPACITY_CANARY_MEASURED_GUESTS:-}|" == *"|$vmid:$tag|"* ]] || fail "current exact pilot permit is required"
permit_current() {
  local now
  printf -v now '%(%s)T' -1
  [[ "$HIVRA_CAPACITY_CANARY_OVERCOMMIT_UNTIL" =~ ^[1-9][0-9]{0,11}$ ]] \
    && (( HIVRA_CAPACITY_CANARY_OVERCOMMIT_UNTIL > now )) || fail "current exact pilot permit is required"
}

ops=/var/lib/hivra/provision-operations
references=/var/lib/hivra/vmid-references
enrollment="$ops/qa-memory-$vmid.enrolled"
started="$ops/qa-memory-$vmid.started"
wake="$ops/wake-$vmid.selected"
ledger="$references/qa-memory-$vmid.operator.list"
qemu_configs="/etc/pve/nodes/$host_id/qemu-server"
lxc_configs="/etc/pve/nodes/$host_id/lxc"
cfg="$qemu_configs/$vmid.conf"
pidfile="/run/qemu-server/$vmid.pid"
memory=4096
cpu=0.25
storage=local-lvm

for dir in "$ops" "$references" "/run/qemu-server" "$qemu_configs" "$lxc_configs"; do
  [[ -d "$dir" && ! -L "$dir" && -r "$dir" && -x "$dir" ]] || fail "required host inventory is unavailable"
done
install -d -m 0755 /run/lock/hivra-vmids
[[ /proc/self/fd/8 -ef /run/lock/hivra-allocation.lock ]] && flock -nx 8 || fail "the allocation lock is required on FD 8"
exec 9>>"/run/lock/hivra-vmids/$vmid.lock"
flock -xn 9 || fail "VMID is busy"
permit_current

hazard='^(args|hookscript|ivshmem|hostpci[0-9]+|usb[0-9]+|virtiofs[0-9]+|tpmstate[0-9]+|efidisk[0-9]+|unused[0-9]+|lock):'
verify_config() {
  local config line
  config="$(timeout 10 qm config "$vmid" --current 1)" || fail "could not verify fixture configuration"
  for line in "name: $tag" "tags: $tag" 'onboot: 0' "memory: $memory" "balloon: $memory" "cpulimit: $cpu"; do
    grep -Fxq "$line" <<<"$config" || fail "fixture configuration was not applied or has changed"
  done
  if grep -Eq "$hazard|^template:|^net[0-9]+:|^\[" <<<"$config"; then fail "fixture is not isolated"; fi
}

process_start() {
  local exe info
  exe="$(readlink -e -- "/proc/$pid/exe")" || return 1
  [[ "$exe" == /usr/bin/kvm || "$exe" == /usr/bin/qemu-system-x86_64 ]] || return 1
  tr '\0' '\n' <"/proc/$pid/cmdline" | awk -v vmid="$vmid" '
    $0 == "-id" {ids++}
    ($0 "x") == (vmid "x") && previous == "-id" {matches++}
    {previous=$0}
    END {exit !(matches == 1 && ids == 1)}
  ' || return 1
  info="$(cat "/proc/$pid/stat")" || return 1
  awk 'NF >= 20 && $1 !~ /^(X|Z)$/ && $20 ~ /^[1-9][0-9]*$/ {print $20}' <<<"${info##*) }"
}

running_identity() {
  root_file "$pidfile" || fail "missing fixture PID evidence"
  pid="$(cat "$pidfile")"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || fail "invalid fixture PID evidence"
  boot="$(cat /proc/sys/kernel/random/boot_id)"
  [[ "$boot" =~ ^[0-9a-f-]{36}$ ]] || fail "invalid host boot identifier"
  start="$(process_start)" || fail "fixture VMID and QEMU PID do not match"
  [[ -n "$start" ]] || fail "missing PID start time"
  timeout -k 1 5 python3 - "/run/qemu-server/$vmid.qmp" "$pid" <<'PY' || fail "fixture is not confirmed running by its QMP peer"
import json
import socket
import struct
import sys

with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as monitor:
    monitor.settimeout(1)
    monitor.connect(sys.argv[1])
    peer_pid, _, _ = struct.unpack("3i", monitor.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    if peer_pid != int(sys.argv[2]):
        sys.exit(1)
    with monitor.makefile("rb") as replies:
        def receive():
            line = replies.readline(65537)
            if not 0 < len(line) <= 65536 or not line.endswith(b"\n"):
                sys.exit(1)
            return json.loads(line)

        if "QMP" not in receive():
            sys.exit(1)
        for command in ("qmp_capabilities", "query-status"):
            monitor.sendall(json.dumps({"execute": command, "id": command}).encode() + b"\r\n")
            for _ in range(16):
                reply = receive()
                if reply.get("id") == command:
                    break
            if reply.get("id") != command or not isinstance(reply.get("return"), dict):
                sys.exit(1)
        status = reply["return"]
        if status.get("running") is not True or status.get("status") != "running":
            sys.exit(1)
PY
  [[ "$(cat "$pidfile")" == "$pid" && "$(process_start)" == "$start" ]] || fail "fixture process changed during QMP proof"
  identity="v1 $vmid $tag $boot $pid $start"
  start_receipt="$identity $owner_id $template_vmid"
}

if [[ "$action" == qualify ]]; then
  absent "$wake" || fail "fixture start is still fenced"
  private_receipt "$started" && root_file "$ledger" && [[ "$(cat "$ledger")" == "$vmid" ]] \
    || fail "missing exact fixture start claim"
  verify_config
  running_identity
  [[ "$(cat "$started")" == "$start_receipt" ]] || fail "fixture start identity changed"
  timeout -k 1 3 qm guest cmd "$vmid" ping 8>&- 9>&- >/dev/null 2>&1 || fail "fixture guest health is unconfirmed"
  verify_config
  running_identity
  [[ "$(cat "$started")" == "$start_receipt" ]] || fail "fixture changed during guest health proof"
  permit_current
  if absent "$enrollment"; then
    publish_exact "$enrollment" "$identity" 0600 || fail "could not record exact healthy clone"
  else
    private_receipt "$enrollment" && [[ "$(cat "$enrollment")" == "$identity" ]] || fail "fixture enrollment identity changed"
  fi
  printf 'HIVRA_CANARY_MEMORY_QA_QUALIFIED %s %s\n' "$vmid" "$tag"
  exit 0
fi

for file in "$cfg" "$lxc_configs/$vmid.conf" "$pidfile" "$started" "$enrollment" "$wake" "$ledger" \
  /run/hivra-provision/"$vmid".{allocated,env,pid,secret} "/var/lib/hivra/provision-results/$vmid.secret"; do
  absent "$file" || fail "VMID has existing host state"
done
[[ "$(pvesh get /cluster/nextid --vmid "$vmid")" == "$vmid" ]] || fail "VMID is not free cluster-wide"
for list in "$references"/*.list; do
  absent "$list" && continue
  root_file "$list" || fail "VMID reference ledger is not trusted"
  status=0
  grep -Fxq -- "$vmid" "$list" || status=$?
  [[ "$status" == 1 ]] || fail "VMID is referenced or its ledger is unreadable"
done
for intent in "$ops"/operation-*.selected; do
  absent "$intent" && continue
  root_file "$intent" || fail "VMID operation inventory is not trusted"
  status=0
  grep -Fxq "vmid=$vmid" "$intent" || status=$?
  [[ "$status" == 1 ]] || fail "VMID has a managed claim or unreadable intent"
done

template="$(timeout 10 qm config "$template_vmid" --current 1)" || fail "could not read stock template"
[[ "$(printf '%s\n' "$template" | sha256sum | cut -d ' ' -f1)" == "$template_digest" ]] || fail "stock template config digest changed"
grep -Fxq 'template: 1' <<<"$template" && grep -Fxq 'ostype: l26' <<<"$template" || fail "template is not stock Linux"
awk '$1 == "onboot:" {seen++; if ($0 != "onboot: 0") bad=1} END {exit (bad || seen > 1)}' <<<"$template" \
  || fail "template autostart is not safely disabled"
if grep -Eq "$hazard|^\[" <<<"$template"; then fail "template has unsupported host configuration"; fi
awk -v storage="$storage" -v vmid="$template_vmid" '
  $1 ~ /^(ide|virtio|scsi|sata)[0-9]+:$/ {
    if ($2 ~ /-cloudinit(,|$)/) next
    if ($2 !~ ("^" storage ":base-" vmid "-disk-[0-9]+,")) exit 1
    if ($2 !~ /(^|,)size=([1-9]|[1-3][0-9]|40)G(,|$)/) exit 1
    disks++
  }
  END {if (disks != 1) exit 1}
' <<<"$template" || fail "template must have one bounded local linked disk"

host_cpu="$(nproc)"
[[ "$host_cpu" =~ ^[1-9][0-9]{0,5}$ ]] || fail "could not read host CPU capacity"
density=$((cpu_budget_milli / host_cpu))
if (( density > 4000 )); then density=4000; fi
(( density >= 1000 )) || fail "CPU budget is below the supported host admission envelope"
admit() {
  bash "$provisioner/hivra-host-capacity-admission" "$1" "$memory" "$memory" "$cpu" 8192 1 "$density" 1000 0 "$storage" 40 5
}
admit -
publish_exact "$ledger" "$vmid" 0644 || fail "could not reserve exact VMID"
timeout 35 qm clone "$template_vmid" "$vmid" --name "$tag" --full 0 8>&- 9>&- || fail "clone not confirmed; inspect the reserved VMID"
clone="$(timeout 10 qm config "$vmid" --current 1)" || fail "could not read exact clone"
grep -Fxq "name: $tag" <<<"$clone" || fail "clone identity mismatch"
if grep -Eq "$hazard|^template:|^\[" <<<"$clone"; then fail "clone has unsupported host configuration"; fi
network="$(awk '$1 ~ /^net[0-9]+:$/ {sub(/:$/, "", $1); print $1}' <<<"$clone" | paste -sd,)"
if [[ -n "$network" ]]; then timeout 15 qm set "$vmid" --delete "$network"; fi
timeout 15 qm set "$vmid" --tags "$tag" --onboot 0 --memory "$memory" --balloon "$memory" \
  --cores 1 --sockets 1 --cpulimit "$cpu" --agent enabled=1
verify_config
timeout 10 qm status "$vmid" | grep -Fx 'status: stopped' >/dev/null || fail "fixture is not stopped"
admit "$vmid"
publish_exact "$wake" "v1 $vmid $tag $memory" 0600 || fail "could not record pending start"
timeout -k 10 30 qm start "$vmid" 8>&- 9>&- </dev/null >/dev/null || fail "start not confirmed; inspect the wake fence"
verify_config
running_identity
publish_exact "$started" "$start_receipt" 0600 || fail "could not record exact full-charge clone"
rm -- "$wake"
printf 'HIVRA_CANARY_MEMORY_QA_RUNNING_FULL_CHARGE %s %s\n' "$vmid" "$tag"
