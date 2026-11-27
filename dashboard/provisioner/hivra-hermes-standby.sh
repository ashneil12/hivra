standby_init() {
  STANDBY_HOST="${HIVRA_HERMES_STANDBY_HOST:?missing standby host identity}"
  [ "$EUID" = 0 ] && [[ "$STANDBY_HOST" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] \
    && [ "$(hostname -s)" = "$STANDBY_HOST" ] \
    && [ "$PROV_DIR" = /root/hivra-provisioner-canary ] \
    && [ "$AGENT_KIND:$PROVISION_MODE" = hermes:install ] \
    && [[ "$HERMES_IMAGE_SHA256" =~ ^[0-9a-f]{64}$ ]] \
    && [[ "$STANDBY_GENERATION" =~ $UUID_PATTERN ]] \
    && [[ "$VMID" =~ ^93[0-9]{2}$ && "$VMID" != 9302 && "$OCTET" =~ ^[1-9][0-9]{0,2}$ ]] \
    && [[ "$BRIDGE" =~ ^[a-zA-Z0-9_-]+$ && "$STORAGE" =~ ^[a-zA-Z0-9._-]+$ ]] \
    || fail "standby is restricted to the exact managed Canary host"
  python3 -I -B -c '
import ipaddress, sys
address, gateway = map(ipaddress.IPv4Address, sys.argv[1:])
network = ipaddress.IPv4Network(f"{address}/24", strict=False)
sys.exit(not (any(network.subnet_of(ipaddress.IPv4Network(p)) for p in
    ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")) and
    gateway in network.hosts() and address != gateway))
' "$IP" "$GW" || fail "standby requires an exact private IPv4 subnet"
  STANDBY_TAG="hivra-standby-${STANDBY_GENERATION//-/}"
  STANDBY_DESCRIPTION="Hivra Hermes standby $STANDBY_GENERATION sha256:$HERMES_IMAGE_SHA256"
  STANDBY_DIR=/var/lib/hivra/provision-operations
  STANDBY_FILE="$STANDBY_DIR/hermes-standby.slot"
  STANDBY_LEDGER_DIR=/var/lib/hivra/vmid-references
  STANDBY_LEDGER="$STANDBY_LEDGER_DIR/hivra-standby.hivra.list"
  STANDBY_STATE=building
  STANDBY_BOOT=
  STANDBY_DISK=
  STANDBY_OWNER=
  STANDBY_BINDING=
}

standby_lock() {
  if [ "$STANDBY_ACTION" = claim ]; then
    [ "$ALLOCATION_LOCK_FD" = 8 ] && [ /proc/self/fd/8 -ef /run/lock/hivra-allocation.lock ] \
      && flock -n 8 || fail "standby claim requires the allocation lock on FD 8"
  elif [ "$STANDBY_ACTION" != continue ]; then
    exec 8>/run/lock/hivra-allocation.lock
    flock -w 60 8 || fail "could not lock host allocation for standby maintenance"
    ALLOCATION_LOCK_FD=8
  fi
  install -d -m 0755 /run/lock/hivra-vmids
  exec 9>"/run/lock/hivra-vmids/$VMID.lock"
  flock -n 9 || fail "standby VMID is busy"
}

standby_record() {
  printf '%s\n' "1" "$STANDBY_GENERATION" "$VMID" "$IP" "$GW" "$HERMES_IMAGE_SHA256" \
    "$CORES" "$MEM_MB" "$CPU_LIMIT" "$STORAGE" "$DISK_GB" "$BRIDGE" \
    "$STANDBY_EXPIRY" "$STANDBY_STATE" "$STANDBY_BOOT" "$STANDBY_DISK" "$STANDBY_OWNER" "$STANDBY_BINDING"
}

standby_write() {
  local tmp
  tmp="$(mktemp "$STANDBY_DIR/.standby.XXXXXXXX")"
  standby_record > "$tmp"
  mv -fT -- "$tmp" "$STANDBY_FILE"
}

standby_read() {
  local -a record
  [ ! -L "$STANDBY_FILE" ] && [ -f "$STANDBY_FILE" ] \
    && [ "$(stat -c '%u:%g:%a:%h' "$STANDBY_FILE")" = 0:0:600:1 ] \
    && [ "$(stat -c '%s' "$STANDBY_FILE")" -le 2048 ] \
    || fail "no safe standby slot record"
  mapfile -t record < "$STANDBY_FILE"
  [ "${#record[@]}" = 18 ] || fail "invalid standby slot record"
  STANDBY_EXPIRY="${record[12]}" STANDBY_STATE="${record[13]}" STANDBY_BOOT="${record[14]}"
  STANDBY_DISK="${record[15]}" STANDBY_OWNER="${record[16]}" STANDBY_BINDING="${record[17]}"
  cmp -s "$STANDBY_FILE" <(standby_record) \
    && [[ "$STANDBY_EXPIRY" =~ ^[1-9][0-9]{9}$ ]] \
    || fail "standby slot does not match the exact requested identity and envelope"
  [ ! -L "$STANDBY_LEDGER" ] && [ -f "$STANDBY_LEDGER" ] \
    && [ "$(stat -c '%u:%g:%a:%h' "$STANDBY_LEDGER")" = 0:0:644:1 ] \
    && cmp -s "$STANDBY_LEDGER" <(printf '%s\n' "$VMID") \
    || fail "standby VMID reservation is missing or inconsistent"
}

standby_inventory() {
  local expected="$1" cluster
  cluster="$(pvesh get /cluster/resources --type vm --output-format json)" \
    || fail "could not read cluster VM inventory"
  printf '%s' "$cluster" | python3 -I -B -c '
import json, sys
vmid, expected = map(int, sys.argv[1:3])
target = sys.argv[3]
resources = json.load(sys.stdin)
matches = [row for row in resources if int(row["vmid"]) == vmid]
sys.exit(not (len(matches) == expected and all(
    row["node"] == target and row["type"] == "qemu" for row in matches)))
' "$VMID" "$expected" "$STANDBY_HOST" || fail "cluster inventory does not prove the standby VMID"
  [ -d /etc/pve/qemu-server ] || fail "local QEMU configuration inventory unavailable"
  local -a configs=() intents=()
  local path
  for path in /etc/pve/qemu-server/*.conf; do
    [ -e "$path" ] || continue
    [ "$path" != "/etc/pve/qemu-server/$VMID.conf" ] || continue
    configs+=("$path")
  done
  if [ "${#configs[@]}" -gt 0 ]; then
    awk -v target="ip=$IP/" '
      FNR == 1 { snapshot = 0 }
      /^\[/ { snapshot = ($0 != "[PENDING]") }
      !snapshot && /^ipconfig[0-9]+:/ {
        n = split($0, fields, /[ ,]+/)
        for (i=2; i<=n; i++) if (index(fields[i], target)==1) conflict=1
      }
      END {exit conflict}
    ' "${configs[@]}" || fail "standby private IP is already configured"
  fi
  for path in "$STANDBY_DIR"/operation-*.selected; do
    [ -e "$path" ] || continue
    intents+=("$path")
  done
  if [ "${#intents[@]}" -gt 0 ]; then
    awk -v vmid="vmid=$VMID" -v ip="ip=$IP" '$0==vmid || $0==ip {conflict=1} END {exit conflict}' \
      "${intents[@]}" || fail "standby conflicts with a pending operation"
  fi
}

standby_admit() {
  local target="$1"; shift
  [ "${HIVRA_HERMES_STANDBY_ENFORCE_CEILINGS:-}" = 1 ] || fail "standby requires enforced host ceilings"
  HIVRA_CAPACITY_BATCH_QEMU=1 bash "$PROV_DIR/hivra-host-capacity-admission" "$target" "$MEM_MB" "$MEM_MB" "$CPU_LIMIT" \
    "${HIVRA_HERMES_STANDBY_RESERVE_MB:?missing standby host reserve}" \
    "${HIVRA_HERMES_STANDBY_ENFORCE_CEILINGS:?missing standby ceiling policy}" \
    "${HIVRA_HERMES_STANDBY_CPU_DENSITY_MILLI:?missing standby CPU density}" \
    "${HIVRA_HERMES_STANDBY_MEMORY_DENSITY_MILLI:?missing standby memory density}" 0 "$@" \
    || fail "standby did not pass host capacity admission"
}

standby_stage_reserve() {
  local ttl="${HIVRA_HERMES_STANDBY_TTL_SECONDS:-900}" list ledger_tmp
  [ "${HIVRA_HERMES_STANDBY_BOOT_PROVEN_SHA256:-}" = "$HERMES_IMAGE_SHA256" ] \
    || fail "operator must confirm two independent boots of this exact image digest"
  [[ "$ttl" =~ ^[1-9][0-9]{0,3}$ ]] && [ "$ttl" -ge 60 ] && [ "$ttl" -le 3600 ] \
    || fail "standby TTL must be 60–3600 seconds"
  install -d -o root -g root -m 0700 "$STANDBY_DIR"
  install -d -o root -g root -m 0755 "$STANDBY_LEDGER_DIR"
  [ ! -e "$STANDBY_FILE" ] && [ ! -L "$STANDBY_FILE" ] \
    && [ ! -e "$STANDBY_LEDGER" ] && [ ! -L "$STANDBY_LEDGER" ] || fail "standby slot already reserved"
  for list in "$STANDBY_LEDGER_DIR"/*.list; do
    [ -e "$list" ] || continue
    [ -f "$list" ] && [ ! -L "$list" ] && [ -r "$list" ] || fail "VMID reference ledger is unreadable"
    local result=0
    grep -Fxq "$VMID" "$list" || result=$?
    [ "$result" = 1 ] || fail "standby VMID is referenced or its ledger could not be read"
  done
  standby_inventory 0
  [ ! -e "$ALLOCATION_RECEIPT_FILE" ] && [ ! -e "/run/hivra-provision/${VMID}.env" ] \
    && [ ! -e "/run/hivra-provision/${VMID}.pid" ] && [ ! -e "$SECRET_RESULT_FILE" ] \
    || fail "standby VMID has stale operation artifacts"
  standby_admit - "$STORAGE" "$DISK_GB" "${HIVRA_HERMES_STANDBY_STORAGE_HEADROOM_GB:?missing standby storage headroom}"
  STANDBY_EXPIRY=$(( $(date +%s) + ttl ))
  ledger_tmp="$(mktemp "$STANDBY_LEDGER_DIR/.standby.XXXXXXXX")"
  printf '%s\n' "$VMID" > "$ledger_tmp"
  chmod 0644 "$ledger_tmp"
  mv -fT -- "$ledger_tmp" "$STANDBY_LEDGER"
  standby_write
}

standby_config_field() {
  awk -v field="$1" 'index($0, field ": ") == 1 {count++; value=substr($0,length(field)+3)}
    END {if(count==1) print value; else if(count>1) exit 1}' <<< "$STANDBY_CONFIG"
}

standby_exact_tags() {
  local tags
  tags="$(standby_config_field tags)" || return 1
  case "$1" in
    standby) [ "$tags" = "$STANDBY_TAG" ] ;;
    claimed) [ "$tags" = "$OPERATION_TAG;$BINDING_TAG" ] || [ "$tags" = "$BINDING_TAG;$OPERATION_TAG" ] ;;
  esac
}

standby_verify_config() {
  local expected="$1" config disk
  STANDBY_CONFIG="$(qm config "$VMID" --current 1)" || fail "cannot read current standby config"
  config="$(qm config "$VMID")" || fail "cannot read effective standby config"
  [ "$config" = "$STANDBY_CONFIG" ] || fail "standby has pending configuration changes"
  awk -F: '/^[a-z][a-z0-9_-]*: / && seen[$1]++ {exit 1}' <<< "$STANDBY_CONFIG" \
    || fail "standby configuration has duplicate fields"
  standby_exact_tags "$expected" || fail "standby ownership tags differ"
  [ "$(standby_config_field description)" = "$STANDBY_DESCRIPTION" ] \
    && [ "$(standby_config_field name)" = "hivra-cc-$VMID" ] \
    && [ "$(standby_config_field ipconfig0)" = "ip=$IP/24,gw=$GW" ] \
    && [ "$(standby_config_field onboot)" = 0 ] \
    && [ "$(standby_config_field balloon)" = 0 ] \
    && [ "$(standby_config_field memory)" = "$MEM_MB" ] \
    && [ "$(standby_config_field cores)" = "$CORES" ] \
    && [ "$(standby_config_field cpulimit)" = "$CPU_LIMIT" ] \
    && [ -z "$(standby_config_field lock)" ] \
    && [ -z "$(standby_config_field template)" ] \
    && ! grep -Eq '^(net|ipconfig)[1-9][0-9]*:' <<< "$STANDBY_CONFIG" \
    || fail "standby ownership, address or resource envelope changed"
  local net
  net="$(standby_config_field net0)"
  [[ ",$net," == *",bridge=$BRIDGE,"* ]] || fail "standby bridge changed"
  disk="$(standby_config_field scsi0)"
  [[ "$disk" == "$STORAGE":* && ",$disk," == *",size=${DISK_GB}G,"* ]] \
    || fail "standby disk envelope changed"
  [ -z "$STANDBY_DISK" ] || [ "$STANDBY_DISK" = "$disk" ] || fail "standby boot disk changed"
  STANDBY_DISK="$disk"
  [ "$(qm status "$VMID" --verbose | awk '$1=="qmpstatus:" {print $2}')" = running ] \
    || fail "standby must be running"
}

standby_guest_proof() {
  local document proof
  document="$(timeout --kill-after=2s 8s qm guest exec "$VMID" -- /bin/sh -ec '
    cat /etc/machine-id /proc/sys/kernel/random/boot_id /etc/ssh/ssh_host_ed25519_key.pub
    ip -o -4 address show scope global | awk "{print \$4}"
    test ! -e /home/bux/.hivra/api-token
    test ! -e /home/bux/.hermes/.env
    test ! -e /etc/cloudflared/config.yml
    test ! -e /etc/systemd/system/cloudflared.service
    test ! -e /etc/systemd/system/bux-hivra-chat.service
  ' < /dev/null 2>/dev/null)" || fail "standby QEMU Guest Agent proof unavailable"
  proof="$(printf '%s' "$document" | python3 -I -B -c '
import base64, hashlib, json, re, sys
doc = json.load(sys.stdin)
assert doc.get("exited") == 1 and doc.get("exitcode") == 0
machine, boot, host_key, address = doc["out-data"].strip().splitlines()
assert re.fullmatch(r"[0-9a-f]{32}", machine) and int(machine, 16)
assert re.fullmatch(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}", boot)
algo, key, *_ = host_key.split()
raw = base64.b64decode(key, validate=True)
assert algo == "ssh-ed25519" and len(raw) == 51 and raw.startswith(b"\0\0\0\x0bssh-ed25519\0\0\0\x20")
assert address == sys.argv[1] + "/24"
print(hashlib.sha256(f"{machine} {boot} {algo} {key}".encode()).hexdigest(), algo, key)
' "$IP" 2>/dev/null)" || fail "standby guest identity, IP or pristine state could not be proved"
  [ -z "$STANDBY_BOOT" ] || [ "${proof%% *}" = "$STANDBY_BOOT" ] || fail "standby boot identity changed"
  STANDBY_BOOT="${proof%% *}"
  set_guest_ssh_identity "${proof#* }"
  [ "$(timeout --kill-after=2s 8s ssh -F /dev/null -i "$VM_KEY" -o BatchMode=yes -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 -o UpdateHostKeys=no \
    -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile="$GUEST_SSH_KNOWN_HOSTS" \
    -o HostKeyAlias="$GUEST_SSH_HOST_ALIAS" -o ConnectTimeout=5 -n "ubuntu@$IP" \
    'LC_ALL=C sudo -n cloud-init status' 2>/dev/null)" = "status: done" ] \
    || fail "standby guest SSH key or cloud-init completion could not be proved"
}

standby_check_expiry() {
  local now
  now="$(date +%s)"
  [ "$STANDBY_EXPIRY" -gt "$now" ] && [ "$STANDBY_EXPIRY" -le "$((now + 3600))" ] \
    || fail "standby reservation expired; retire it, never launch a replacement"
}

standby_claim() {
  local expected=standby receipt_tmp
  standby_read
  standby_check_expiry
  local list
  for list in "$STANDBY_LEDGER_DIR"/*.list; do
    [ -e "$list" ] || continue
    [ "$list" != "$STANDBY_LEDGER" ] || continue
    [ -f "$list" ] && [ ! -L "$list" ] && [ -r "$list" ] || fail "VMID reference ledger is unreadable"
    local result=0
    grep -Fxq "$VMID" "$list" || result=$?
    [ "$result" = 1 ] || fail "standby VMID has a conflicting reference or unreadable ledger"
  done
  case "$STANDBY_STATE" in
    ready) [ -z "$STANDBY_OWNER$STANDBY_BINDING" ] || fail "standby has unexpected claim state" ;;
    claiming|claimed)
      [ "$STANDBY_OWNER:$STANDBY_BINDING" = "$OPERATION_ID:$BINDING_TAG" ] || fail "standby belongs to another claim"
      STANDBY_CONFIG="$(qm config "$VMID" --current 1)"
      if standby_exact_tags claimed; then expected=claimed; fi ;;
    *) fail "standby is not claimable; recover the exact operation or retire the slot" ;;
  esac
  [[ "$STANDBY_BOOT" =~ ^[0-9a-f]{64}$ && -n "$STANDBY_DISK" ]] || fail "standby lacks recorded boot proof"
  standby_inventory 1
  standby_verify_config "$expected"
  standby_admit "$VMID"
  standby_guest_proof
  standby_verify_config "$expected"
  standby_check_expiry
  if [ "$expected" = standby ]; then
    STANDBY_OWNER="$OPERATION_ID" STANDBY_BINDING="$BINDING_TAG" STANDBY_STATE=claiming
    standby_write
    qm set "$VMID" --tags "${BINDING_TAG};${OPERATION_TAG}" >/dev/null
  fi
  standby_verify_config claimed
  STANDBY_STATE=claimed
  standby_write
  write_allocation_receipt
  receipt_tmp="$(mktemp "$STANDBY_DIR/.warm-claimed.XXXXXXXX")"
  standby_claim_receipt > "$receipt_tmp"
  mv -fT -- "$receipt_tmp" "$STANDBY_DIR/operation-$OPERATION_ID.warm-claimed"
}

standby_claim_receipt() {
  printf 'operation_id=%s\nbinding_tag=%s\nvmid=%s\nip=%s\ngeneration=%s\n' \
    "$OPERATION_ID" "$BINDING_TAG" "$VMID" "$IP" "$STANDBY_GENERATION"
}

standby_continue() {
  local receipt="$STANDBY_DIR/operation-$OPERATION_ID.warm-claimed"
  standby_read
  standby_check_expiry
  [ "$STANDBY_STATE:$STANDBY_OWNER:$STANDBY_BINDING" = "claimed:$OPERATION_ID:$BINDING_TAG" ] \
    || fail "standby continuation does not match a fresh exact claim"
  [[ "$STANDBY_BOOT" =~ ^[0-9a-f]{64}$ && -n "$STANDBY_DISK" ]] || fail "standby lacks recorded boot proof"
  [ ! -L "$receipt" ] && [ -f "$receipt" ] \
    && [ "$(stat -c '%u:%g:%a:%h' "$receipt")" = 0:0:600:1 ] \
    && cmp -s "$receipt" <(standby_claim_receipt) || fail "standby claim receipt does not match"
  standby_verify_config claimed
  standby_guest_proof
  standby_verify_config claimed
}

standby_retire() {
  standby_read
  if [ -f "/etc/pve/qemu-server/$VMID.conf" ]; then
    case "$STANDBY_STATE" in building|ready|claiming) ;; *)
      fail "retire refused: slot may have been handed to a tenant" ;;
    esac
    standby_inventory 1
    STANDBY_CONFIG="$(qm config "$VMID" --current 1)" || fail "cannot inspect standby config before retirement"
    standby_exact_tags standby && [ "$(standby_config_field description)" = "$STANDBY_DESCRIPTION" ] \
      && [ "$(standby_config_field ipconfig0)" = "ip=$IP/24,gw=$GW" ] \
      || fail "retire refused: VM does not have exact unassigned standby ownership"
    case "$(qm status "$VMID")" in
      'status: running') qm stop "$VMID" --timeout 30 >/dev/null ;;
      'status: stopped') ;;
      *) fail "standby power state is ambiguous" ;;
    esac
    STANDBY_CONFIG="$(qm config "$VMID" --current 1)"
    standby_exact_tags standby && [ "$(standby_config_field description)" = "$STANDBY_DESCRIPTION" ] \
      && [ "$(standby_config_field ipconfig0)" = "ip=$IP/24,gw=$GW" ] \
      || fail "standby ownership changed before destroy"
    qm destroy "$VMID" --purge 1 >/dev/null
  fi
  standby_inventory 0
  local volumes
  volumes="$(pvesm list "$STORAGE" --vmid "$VMID")" || fail "could not verify standby storage cleanup"
  awk 'NF && !($1=="Volid" && NR==1) {exit 1}' <<< "$volumes" \
    || fail "standby volumes remain; retaining its VMID reservation"
  rm -- "$STANDBY_FILE" "$STANDBY_LEDGER"
}
