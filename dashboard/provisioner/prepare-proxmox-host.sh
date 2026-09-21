#!/usr/bin/env bash
# Install a versioned Hivra provisioner on a Proxmox VE 8/9 host.
# This is the only mutating step in connection setup. It prepares reusable
# host assets but never creates an agent VM.
set -euo pipefail

SOURCE_DIR="${HIVRA_SOURCE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
INSTALL_DIR="${HIVRA_INSTALL_DIR:-/opt/hivra/provisioner}"
STATE_DIR="${HIVRA_STATE_DIR:-/etc/hivra}"
KEY_DIR="${HIVRA_KEY_DIR:-${STATE_DIR}/keys}"
LOG_DIR="${HIVRA_LOG_DIR:-/var/log/hivra}"
BRIDGE="${HIVRA_BRIDGE:-hivra0}"
SUBNET_PREFIX="${HIVRA_SUBNET_PREFIX:-10.251.20}"
GATEWAY="${HIVRA_GW:-${SUBNET_PREFIX}.1}"
IP_LAST_OCTET_START="${HIVRA_IP_LAST_OCTET_START:-50}"
VMID_START="${HIVRA_VMID_START:-200}"
VMID_END="${HIVRA_VMID_END:-399}"
UBUNTU_IMAGE="${HIVRA_UBUNTU_IMG:-/var/lib/vz/template/iso/hivra-ubuntu-jammy.img}"
UBUNTU_IMAGE_URL="${HIVRA_UBUNTU_IMG_URL:-https://cloud-images.ubuntu.com/releases/jammy/release-20260807/ubuntu-22.04-server-cloudimg-amd64.img}"
UBUNTU_IMAGE_SHA256="${HIVRA_UBUNTU_IMG_SHA256:-ff271290a23279ce764561dbe2e9c3ec29da899535b571a987c37b47970c2ad9}"
VM_KEY="${HIVRA_VM_SSH_KEY_PATH:-${KEY_DIR}/vm-orchestrator}"
NETWORK_OWNER_MARKER="${STATE_DIR}/network-owner"
NETWORK_SERVICE="/etc/systemd/system/hivra-network.service"
VERSION="$(tr -d '[:space:]' < "${SOURCE_DIR}/VERSION")"

fail() { echo "[hivra-prepare] $*" >&2; exit 1; }
log() { echo "[hivra-prepare] $*" >&2; }
valid_path() {
  local value="$1"
  [[ "$value" =~ ^/[A-Za-z0-9._/+:-]+$ ]] || return 1
  [ "$value" != "/" ] || return 1
  [[ "$value" != *"/../"* && "$value" != */.. && "$value" != *"/./"* && "$value" != */. ]]
}
valid_octet() {
  [[ "$1" =~ ^[0-9]{1,3}$ ]] && [ "$((10#$1))" -le 255 ]
}
valid_subnet_prefix() {
  local first second third extra
  IFS=. read -r first second third extra <<< "$1"
  [ -z "${extra:-}" ] && valid_octet "$first" && valid_octet "$second" && valid_octet "$third"
}
valid_ipv4() {
  local first second third fourth extra
  IFS=. read -r first second third fourth extra <<< "$1"
  [ -z "${extra:-}" ] && valid_octet "$first" && valid_octet "$second" && valid_octet "$third" && valid_octet "$fourth"
}

[ "$(id -u)" -eq 0 ] || fail "run as root"
case "$VERSION" in *[!A-Za-z0-9._+-]*|'') fail "invalid provisioner version" ;; esac
case "$BRIDGE" in *[!A-Za-z0-9_.:-]*|'') fail "invalid bridge name" ;; esac
[ "${#BRIDGE}" -le 15 ] || fail "bridge name is longer than Linux permits"
valid_subnet_prefix "$SUBNET_PREFIX" || fail "subnet prefix must contain three valid IPv4 octets"
valid_ipv4 "$GATEWAY" || fail "gateway must be a valid IPv4 address"
[[ "$GATEWAY" == "${SUBNET_PREFIX}."* ]] || fail "gateway must be inside the selected /24"
GATEWAY_OCTET="${GATEWAY##*.}"
[ "$GATEWAY_OCTET" -ge 1 ] && [ "$GATEWAY_OCTET" -le 254 ] || fail "gateway cannot be the network or broadcast address"
[[ "$IP_LAST_OCTET_START" =~ ^[0-9]+$ ]] && [ "$IP_LAST_OCTET_START" -ge 2 ] && [ "$IP_LAST_OCTET_START" -le 254 ] || fail "invalid IP start"
[[ "$VMID_START" =~ ^[0-9]+$ && "$VMID_END" =~ ^[0-9]+$ ]] || fail "invalid VMID range"
[ "$VMID_START" -ge 100 ] && [ "$VMID_END" -ge "$VMID_START" ] || fail "invalid VMID range"
for path in "$SOURCE_DIR" "$INSTALL_DIR" "$STATE_DIR" "$KEY_DIR" "$LOG_DIR" "$UBUNTU_IMAGE" "$VM_KEY" "$NETWORK_OWNER_MARKER" "$NETWORK_SERVICE"; do
  valid_path "$path" || fail "unsafe path: $path"
done
[ -d "$SOURCE_DIR" ] || fail "provisioner source directory is missing"
[ -x "$SOURCE_DIR/hivra-network-preflight" ] || fail "network collision preflight is missing or not executable"
[[ "$UBUNTU_IMAGE_URL" == https://* ]] || fail "Ubuntu image URL must use HTTPS"
[[ "$UBUNTU_IMAGE_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "Ubuntu image checksum must be a lowercase SHA-256 digest"

for command in pveversion qm pvesm ip ssh-keygen curl qemu-img iptables ip6tables nft sha256sum flock stat systemctl python3; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required"
done
pveversion | grep -Eq '^pve-manager/(8|9)\.' || fail "Proxmox VE 8 or 9 is required"
[ -e /dev/kvm ] || fail "KVM is unavailable"

install -d -m 0755 /run/lock
exec 9>/run/lock/hivra-host-prepare.lock
flock -n 9 || fail "another Hivra host preparation is already running"

STORAGE="${HIVRA_STORAGE:-}"
if [ -z "$STORAGE" ]; then
  STORAGE="$(pvesm status --content images 2>/dev/null | awk 'NR>1 && $3=="active" {print $1; exit}')"
fi
[ -n "$STORAGE" ] || fail "no active VM-capable Proxmox storage was found"
case "$STORAGE" in *[!A-Za-z0-9_.:-]*|'') fail "invalid storage name" ;; esac
pvesm status --content images 2>/dev/null | awk 'NR>1 && $3=="active" {print $1}' | grep -Fxq "$STORAGE" || fail "selected storage is not active and VM-capable"

# This check is deliberately before the first filesystem/network mutation.
# A fixed private subnet or unit name is never safe to adopt by convention: an
# exact, root-owned Hivra marker is the only authority to upgrade an existing
# bridge/service. Route overlap is rejected even when the bridge name is free.
"$SOURCE_DIR/hivra-network-preflight" \
  "$BRIDGE" "$SUBNET_PREFIX" "$GATEWAY" "$NETWORK_OWNER_MARKER" "$NETWORK_SERVICE" \
  >/dev/null

install -d -m 0755 "$(dirname "$INSTALL_DIR")" "$STATE_DIR" "$KEY_DIR" "$LOG_DIR" "$(dirname "$UBUNTU_IMAGE")"
STAGE="${INSTALL_DIR}.new.$$"
PREVIOUS="${INSTALL_DIR}.previous"
valid_path "$STAGE" || fail "unsafe staging path"
valid_path "$PREVIOUS" || fail "unsafe previous-install path"
INSTALL_SWAPPED=0
PREVIOUS_PRESENT=0
cleanup_stage() {
  local status=$?
  [ ! -e "$STAGE" ] || rm -rf -- "$STAGE"
  if [ "$status" -ne 0 ] && [ "$INSTALL_SWAPPED" = "1" ]; then
    rm -rf -- "$INSTALL_DIR"
    if [ "$PREVIOUS_PRESENT" = "1" ] && [ -d "$PREVIOUS" ]; then
      mv "$PREVIOUS" "$INSTALL_DIR"
    fi
  fi
  return "$status"
}
trap cleanup_stage EXIT
rm -rf "$STAGE"
install -d -m 0755 "$STAGE"
cp -a "${SOURCE_DIR}/." "$STAGE/"
find "$STAGE" -type f -name '*.sh' -exec chmod 0755 {} +
chmod 0755 "$STAGE/hivra-browser-apply" "$STAGE/hivra-guest-ssh-known-hosts" "$STAGE/hivra-tg-apply"
(
  cd "$STAGE"
  find . -type f ! -name BUNDLE.sha256 -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    | sed 's#  \./#  #' > BUNDLE.sha256
  sha256sum -c --status BUNDLE.sha256
)
chmod 0644 "$STAGE/BUNDLE.sha256"
if [ -d "$INSTALL_DIR" ]; then
  rm -rf -- "$PREVIOUS"
  mv "$INSTALL_DIR" "$PREVIOUS"
  PREVIOUS_PRESENT=1
fi
mv "$STAGE" "$INSTALL_DIR"
INSTALL_SWAPPED=1

if [ ! -f "$VM_KEY" ]; then
  log "creating host-to-guest key"
  ssh-keygen -q -t ed25519 -N '' -C 'hivra-host-to-guest' -f "$VM_KEY"
fi
chmod 0600 "$VM_KEY"
chmod 0644 "${VM_KEY}.pub"

if [ ! -s "$UBUNTU_IMAGE" ] || \
   ! qemu-img info "$UBUNTU_IMAGE" >/dev/null 2>&1 || \
   ! printf '%s  %s\n' "$UBUNTU_IMAGE_SHA256" "$UBUNTU_IMAGE" | sha256sum -c - >/dev/null 2>&1; then
  log "downloading Ubuntu cloud image"
  IMAGE_TMP="${UBUNTU_IMAGE}.download.$$"
  rm -f "$IMAGE_TMP"
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --output "$IMAGE_TMP" "$UBUNTU_IMAGE_URL"
  printf '%s  %s\n' "$UBUNTU_IMAGE_SHA256" "$IMAGE_TMP" | sha256sum -c - >/dev/null \
    || fail "Ubuntu cloud image checksum verification failed"
  qemu-img info "$IMAGE_TMP" >/dev/null 2>&1 || fail "downloaded cloud image is invalid"
  chmod 0644 "$IMAGE_TMP"
  mv "$IMAGE_TMP" "$UBUNTU_IMAGE"
fi

# Claim the exact network contract atomically before creating either owned
# object. If a later preparation step fails, the durable marker lets the next
# run safely repair the partial Hivra-owned state instead of misclassifying it
# as foreign infrastructure.
NETWORK_OWNER_TMP="${NETWORK_OWNER_MARKER}.new.$$"
install -m 0644 /dev/null "$NETWORK_OWNER_TMP"
cat > "$NETWORK_OWNER_TMP" <<EOF
schema=1
owner=hivra
bridge=${BRIDGE}
subnet=${SUBNET_PREFIX}.0/24
gateway=${GATEWAY}
service=${NETWORK_SERVICE}
EOF
chown root:root "$NETWORK_OWNER_TMP"
mv -f -- "$NETWORK_OWNER_TMP" "$NETWORK_OWNER_MARKER"

if ip link show "$BRIDGE" >/dev/null 2>&1; then
  ip -d link show "$BRIDGE" | grep -q 'bridge' || fail "$BRIDGE exists but is not a bridge"
else
  ip link add name "$BRIDGE" type bridge
fi
ip address show dev "$BRIDGE" | grep -Fq " ${GATEWAY}/24 " || ip address add "${GATEWAY}/24" dev "$BRIDGE"
ip link set "$BRIDGE" up

cat > "${STATE_DIR}/network-apply" <<EOF
#!/usr/bin/env bash
set -euo pipefail
sysctl -q -w net.ipv4.ip_forward=1
ip link show ${BRIDGE} >/dev/null 2>&1 || ip link add name ${BRIDGE} type bridge
ip address show dev ${BRIDGE} | grep -Fq ' ${GATEWAY}/24 ' || ip address add ${GATEWAY}/24 dev ${BRIDGE}
ip link set ${BRIDGE} up

# Prevent one agent VM from reaching another agent VM at layer 2. The bridge
# family sees switched traffic that never traverses the normal IP FORWARD hook.
nft delete table bridge hivra_isolation 2>/dev/null || true
nft -f - <<'HIVRA_NFT'
table bridge hivra_isolation {
  chain forward {
    type filter hook forward priority -200; policy accept;
    meta ibrname "${BRIDGE}" meta obrname "${BRIDGE}" drop comment "Hivra agent east-west isolation"
  }
}
HIVRA_NFT

# Guests may use the host as a router, but cannot initiate connections to the
# Proxmox host itself or reach private/link-local management networks behind it.
iptables -N HIVRA_INPUT 2>/dev/null || true
iptables -F HIVRA_INPUT
iptables -A HIVRA_INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A HIVRA_INPUT -j REJECT
while iptables -D INPUT -i ${BRIDGE} -j HIVRA_INPUT 2>/dev/null; do :; done
iptables -I INPUT 1 -i ${BRIDGE} -j HIVRA_INPUT

iptables -N HIVRA_EGRESS 2>/dev/null || true
iptables -F HIVRA_EGRESS
iptables -A HIVRA_EGRESS -d 0.0.0.0/8 -j REJECT
iptables -A HIVRA_EGRESS -d 10.0.0.0/8 -j REJECT
iptables -A HIVRA_EGRESS -d 100.64.0.0/10 -j REJECT
iptables -A HIVRA_EGRESS -d 127.0.0.0/8 -j REJECT
iptables -A HIVRA_EGRESS -d 169.254.0.0/16 -j REJECT
iptables -A HIVRA_EGRESS -d 172.16.0.0/12 -j REJECT
iptables -A HIVRA_EGRESS -d 192.168.0.0/16 -j REJECT
iptables -A HIVRA_EGRESS -d 198.18.0.0/15 -j REJECT
iptables -A HIVRA_EGRESS -d 224.0.0.0/4 -j REJECT
iptables -A HIVRA_EGRESS -d 240.0.0.0/4 -j REJECT
iptables -A HIVRA_EGRESS -j RETURN
while iptables -D FORWARD -i ${BRIDGE} -j HIVRA_EGRESS 2>/dev/null; do :; done
iptables -I FORWARD 1 -i ${BRIDGE} -j HIVRA_EGRESS

iptables -t nat -C POSTROUTING -s ${SUBNET_PREFIX}.0/24 ! -d ${SUBNET_PREFIX}.0/24 -j MASQUERADE 2>/dev/null || \
  iptables -t nat -A POSTROUTING -s ${SUBNET_PREFIX}.0/24 ! -d ${SUBNET_PREFIX}.0/24 -j MASQUERADE

# IPv6 has no supported guest egress contract yet. Guests still acquire
# link-local addresses automatically, so enforce equivalent host isolation and
# reject all bridge-originated routed IPv6 rather than leaving an unfiltered
# path around the IPv4 policy.
ip6tables -N HIVRA6_INPUT 2>/dev/null || true
ip6tables -F HIVRA6_INPUT
ip6tables -A HIVRA6_INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
ip6tables -A HIVRA6_INPUT -j REJECT
while ip6tables -D INPUT -i ${BRIDGE} -j HIVRA6_INPUT 2>/dev/null; do :; done
ip6tables -I INPUT 1 -i ${BRIDGE} -j HIVRA6_INPUT

ip6tables -N HIVRA6_EGRESS 2>/dev/null || true
ip6tables -F HIVRA6_EGRESS
ip6tables -A HIVRA6_EGRESS -j REJECT
while ip6tables -D FORWARD -i ${BRIDGE} -j HIVRA6_EGRESS 2>/dev/null; do :; done
ip6tables -I FORWARD 1 -i ${BRIDGE} -j HIVRA6_EGRESS
EOF
chmod 0755 "${STATE_DIR}/network-apply"
cat > "$NETWORK_SERVICE" <<EOF
[Unit]
Description=Hivra isolated agent network
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=${STATE_DIR}/network-apply
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now hivra-network.service >/dev/null

cat > "${STATE_DIR}/target.env" <<EOF
HIVRA_PROV_DIR=${INSTALL_DIR}
HIVRA_STORAGE=${STORAGE}
HIVRA_BRIDGE=${BRIDGE}
HIVRA_SUBNET_PREFIX=${SUBNET_PREFIX}
HIVRA_GW=${GATEWAY}
HIVRA_IP_LAST_OCTET_START=${IP_LAST_OCTET_START}
HIVRA_VMID_START=${VMID_START}
HIVRA_VMID_END=${VMID_END}
HIVRA_UBUNTU_IMG=${UBUNTU_IMAGE}
HIVRA_VM_SSH_KEY_PATH=${VM_KEY}
HIVRA_LOG_DIR=${LOG_DIR}
EOF
chmod 0644 "${STATE_DIR}/target.env"

cat > "${INSTALL_DIR}/TARGET.json" <<EOF
{"schemaVersion":1,"version":"${VERSION}","bridge":"${BRIDGE}","storage":"${STORAGE}","subnetPrefix":"${SUBNET_PREFIX}","gateway":"${GATEWAY}","ipLastOctetStart":${IP_LAST_OCTET_START},"vmidStart":${VMID_START},"vmidEnd":${VMID_END}}
EOF
chmod 0644 "${INSTALL_DIR}/TARGET.json"

# The preparation receipt is a readiness claim, so prove the installed bundle,
# image, key ownership/modes, and both IP-family isolation policies again after
# all mutations have completed. A partial host never receives a success marker.
( cd "$INSTALL_DIR" && sha256sum -c --status BUNDLE.sha256 ) \
  || fail "installed provisioner bundle failed checksum verification"
printf '%s  %s\n' "$UBUNTU_IMAGE_SHA256" "$UBUNTU_IMAGE" | sha256sum -c --status - \
  || fail "installed Ubuntu image failed checksum verification"
[ "$(stat -c '%a:%U:%G' "$VM_KEY")" = "600:root:root" ] \
  || fail "VM orchestrator private key has unsafe ownership or mode"
[ "$(stat -c '%a:%U:%G' "${VM_KEY}.pub")" = "644:root:root" ] \
  || fail "VM orchestrator public key has unsafe ownership or mode"
systemctl is-active --quiet hivra-network.service || fail "Hivra network service is not active"
[ "$(stat -c '%a:%U:%G' "$NETWORK_OWNER_MARKER")" = "644:root:root" ] \
  || fail "network ownership marker has unsafe ownership or mode"
"$INSTALL_DIR/hivra-network-preflight" \
  "$BRIDGE" "$SUBNET_PREFIX" "$GATEWAY" "$NETWORK_OWNER_MARKER" "$NETWORK_SERVICE" \
  >/dev/null || fail "installed network ownership contract failed validation"
iptables -C INPUT -i "$BRIDGE" -j HIVRA_INPUT >/dev/null 2>&1 \
  || fail "IPv4 guest-to-host isolation is not active"
iptables -C FORWARD -i "$BRIDGE" -j HIVRA_EGRESS >/dev/null 2>&1 \
  || fail "IPv4 guest egress isolation is not active"
ip6tables -C INPUT -i "$BRIDGE" -j HIVRA6_INPUT >/dev/null 2>&1 \
  || fail "IPv6 guest-to-host isolation is not active"
ip6tables -C FORWARD -i "$BRIDGE" -j HIVRA6_EGRESS >/dev/null 2>&1 \
  || fail "IPv6 guest egress isolation is not active"
nft list chain bridge hivra_isolation forward 2>/dev/null | grep -Fq drop \
  || fail "layer-2 guest isolation is not active"

trap - EXIT
log "prepared Proxmox target with Hivra ${VERSION}"
printf 'HIVRA_PREPARE_RESULT {"version":"%s","bridge":"%s","storage":"%s","subnetPrefix":"%s","gateway":"%s"}\n' \
  "$VERSION" "$BRIDGE" "$STORAGE" "$SUBNET_PREFIX" "$GATEWAY"
