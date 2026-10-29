#!/usr/bin/env bash
# proxmox-host-vm-antispoof.sh: pin every guest NIC on a Proxmox host to its own
# MAC and configured IPv4 address, outside the guest.
#
# Why: guest-to-guest frames are already dropped by `bridge hermes_vm_isolation`,
# but frames from a guest to the HOST are not checked at all. Every host reuses
# the same private /24, the Proxmox firewall is off, and nothing ties a tap to
# its MAC or IP. A guest can therefore send ARP replies claiming a neighbour's
# IP; the host's neighbour cache then sends that neighbour's traffic (the host
# Caddy proxy, host-to-guest SSH carrying secrets) to the attacker.
#
# This script renders one nftables table, `bridge hermes_vm_antispoof`, from the
# guest configs in /etc/pve/qemu-server and /etc/pve/lxc. For each NIC:
#   - frames whose Ethernet source is not the NIC's configured MAC are dropped;
#   - ARP whose sender MAC is not that MAC, or (static IP only) whose sender IP
#     is not the configured IP, is dropped (0.0.0.0 is allowed for ARP probes);
#   - IPv4 whose source is not the configured IP is dropped (static IP only;
#     DHCP discover from 0.0.0.0 is allowed);
#   - IPv6 other than link-local and the unspecified address is dropped. The
#     host has no routed IPv6 for guests, so nothing legitimate uses it.
# NICs with `ip=dhcp` or no ipconfig (BYO-ISO desktops, the DHCP lab) are pinned
# by MAC only and listed as such, because the host cannot know their IP.
#
# The table is replaced atomically on every run, so it always mirrors the
# current configs. A NIC created after the last run is unpinned until the next
# one; --install-triggers closes that gap with a udev rule that reruns this on
# every new tap/veth, plus a one-minute timer that also drops stale entries.
#
# Usage:
#   proxmox-host-vm-antispoof.sh --render            print the table (no root)
#   sudo proxmox-host-vm-antispoof.sh --check        exit 1 if the live table differs
#   sudo proxmox-host-vm-antispoof.sh --apply        validate with nft -c, then load
#   sudo proxmox-host-vm-antispoof.sh --install-triggers
#
# Environment (tests): QEMU_CONF_DIR, LXC_CONF_DIR, NFT_BIN, ANTISPOOF_LOCK, ANTISPOOF_TMPDIR.
# Read-only except --apply and --install-triggers. Bash 3.2 compatible.

set -euo pipefail

QEMU_CONF_DIR="${QEMU_CONF_DIR:-/etc/pve/qemu-server}"
LXC_CONF_DIR="${LXC_CONF_DIR:-/etc/pve/lxc}"
NFT_BIN="${NFT_BIN:-nft}"
ANTISPOOF_LOCK="${ANTISPOOF_LOCK:-/run/hivra-vm-antispoof.lock}"
TABLE_NAME="hermes_vm_antispoof"
INSTALL_PATH="/usr/local/sbin/hivra-vm-antispoof"
MODE=""
QUIET=0

log() { [ "$QUIET" = 1 ] || printf '[hermes-vm-antispoof] %s\n' "$*"; }
fatal() { printf '[hermes-vm-antispoof] FATAL: %s\n' "$*" >&2; exit 2; }

usage() {
  sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --render) MODE="render" ;;
    --check) MODE="check" ;;
    --apply) MODE="apply" ;;
    --install-triggers) MODE="install" ;;
    --quiet) QUIET=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fatal "unknown argument: $1" ;;
  esac
  shift
done
[ -n "$MODE" ] || { usage; exit 2; }

render() {
  python3 - "$QEMU_CONF_DIR" "$LXC_CONF_DIR" "$TABLE_NAME" <<'PY'
import ipaddress, os, re, sys

qemu_dir, lxc_dir, table = sys.argv[1], sys.argv[2], sys.argv[3]
MAC = re.compile(r'^[0-9a-f]{2}(:[0-9a-f]{2}){5}$')
NIC_MODELS = {"virtio", "e1000", "e1000e", "rtl8139", "vmxnet3", "ne2k_pci", "pcnet", "i82551", "i82557b", "i82559er", "ne2k_isa"}

def main_section(path):
    # Snapshot sections start at the first "[" line and describe old states.
    out = {}
    with open(path) as fh:
        for line in fh:
            if line.startswith("["):
                break
            m = re.match(r'^([a-z0-9]+):\s*(.*)$', line.rstrip("\n"))
            if m:
                out[m.group(1)] = m.group(2)
    return out

def kv(value):
    parts = {}
    for item in value.split(","):
        if "=" in item:
            k, v = item.split("=", 1)
            parts[k.strip()] = v.strip()
        elif item.strip():
            parts[item.strip()] = ""
    return parts

def static_ipv4(value):
    ip = kv(value).get("ip", "")
    if not ip or ip == "dhcp" or ip == "manual":
        return None
    try:
        return str(ipaddress.IPv4Interface(ip).ip)
    except ValueError:
        return None

def guest_ids(directory):
    if not os.path.isdir(directory):
        return []
    ids = []
    for name in os.listdir(directory):
        m = re.match(r'^(\d+)\.conf$', name)
        if m:
            ids.append(int(m.group(1)))
    return sorted(ids)

nics = []      # (iface, mac, ip or None, label)
skipped = []
for vmid in guest_ids(qemu_dir):
    conf = main_section(os.path.join(qemu_dir, f"{vmid}.conf"))
    if conf.get("template") == "1":
        continue
    for key in sorted(k for k in conf if re.match(r'^net\d+$', k)):
        n = key[3:]
        fields = kv(conf[key])
        mac = next((v.lower() for k, v in fields.items() if k in NIC_MODELS and v), "")
        if not MAC.match(mac):
            skipped.append(f"qemu {vmid} {key}: no MAC in config")
            continue
        ip = static_ipv4(conf.get(f"ipconfig{n}", ""))
        nics.append((f"tap{vmid}i{n}", mac, ip, f"qemu {vmid} {key}"))
for ctid in guest_ids(lxc_dir):
    conf = main_section(os.path.join(lxc_dir, f"{ctid}.conf"))
    if conf.get("template") == "1":
        continue
    for key in sorted(k for k in conf if re.match(r'^net\d+$', k)):
        n = key[3:]
        fields = kv(conf[key])
        mac = fields.get("hwaddr", "").lower()
        if not MAC.match(mac):
            skipped.append(f"lxc {ctid} {key}: no hwaddr in config")
            continue
        nics.append((f"veth{ctid}i{n}", mac, static_ipv4(conf[key]), f"lxc {ctid} {key}"))

lines = [
    f"table bridge {table}",
    f"delete table bridge {table}",
    f"table bridge {table} {{",
    "\tchain prerouting {",
    "\t\ttype filter hook prerouting priority -300; policy accept;",
]
for iface, mac, ip, label in nics:
    q = f'iifname "{iface}"'
    lines.append(f"\t\t# {label}{'' if ip else ' (no static IPv4: MAC pin only)'}")
    lines.append(f"\t\t{q} ether saddr != {mac} drop")
    lines.append(f"\t\t{q} arp saddr ether != {mac} drop")
    if ip:
        lines.append(f"\t\t{q} arp saddr ip != {{ 0.0.0.0, {ip} }} drop")
        lines.append(f"\t\t{q} ip saddr 0.0.0.0 udp sport 68 udp dport 67 accept")
        lines.append(f"\t\t{q} ip saddr != {ip} drop")
    lines.append(f"\t\t{q} ip6 saddr != {{ ::, fe80::/10 }} drop")
lines += ["\t}", "}"]
print("\n".join(lines))
for item in skipped:
    print(f"# skipped: {item}")
print(f"# pinned {len(nics)} NIC(s), {sum(1 for n in nics if n[2])} with a static IPv4")
PY
}

with_lock() {
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$ANTISPOOF_LOCK"
    flock -w 30 9 || fatal "another run holds $ANTISPOOF_LOCK"
  fi
}

case "$MODE" in
  render)
    render
    ;;
  check)
    rendered="$(render)"
    expected="$(printf '%s\n' "$rendered" | grep -E '^[[:space:]]+iifname ' | sed 's/^[[:space:]]*//' | sort)"
    live="$("$NFT_BIN" list table bridge "$TABLE_NAME" 2>/dev/null | grep -E '^[[:space:]]+iifname ' | sed 's/^[[:space:]]*//' | sort || true)"
    if [ "$expected" = "$live" ]; then
      log "OK: live table matches the guest configs ($(printf '%s\n' "$rendered" | tail -1 | sed 's/^# //'))"
      exit 0
    fi
    log "DRIFT: live table bridge $TABLE_NAME differs from the guest configs"
    diff <(printf '%s\n' "$expected") <(printf '%s\n' "$live") | sed 's/^/  /' || true
    exit 1
    ;;
  apply)
    [ "$(id -u)" = 0 ] || fatal "--apply must run as root"
    with_lock
    tmp="$(mktemp "${ANTISPOOF_TMPDIR:-/run}/hivra-vm-antispoof.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT
    render | grep -v '^# ' > "$tmp"
    "$NFT_BIN" -c -f "$tmp" || fatal "rendered ruleset failed nft -c; live table left unchanged"
    "$NFT_BIN" -f "$tmp" || fatal "nft -f failed; the previous table stays loaded (the replace is one transaction)"
    log "applied: $(render | tail -1 | sed 's/^# //')"
    ;;
  install)
    [ "$(id -u)" = 0 ] || fatal "--install-triggers must run as root"
    install -m 0755 "$0" "$INSTALL_PATH"
    cat > /etc/systemd/system/hivra-vm-antispoof.service <<EOF
[Unit]
Description=Pin guest NICs to their MAC and IP (bridge $TABLE_NAME)
After=nftables.service

[Service]
Type=oneshot
ExecStart=$INSTALL_PATH --apply --quiet
EOF
    cat > /etc/systemd/system/hivra-vm-antispoof.timer <<'EOF'
[Unit]
Description=Re-pin guest NICs every minute (drops entries for removed guests)

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s

[Install]
WantedBy=timers.target
EOF
    cat > /etc/udev/rules.d/90-hivra-vm-antispoof.rules <<'EOF'
# A new guest NIC appeared: re-render the anti-spoof table right away.
ACTION=="add", SUBSYSTEM=="net", KERNEL=="tap*|veth*", RUN+="/usr/bin/systemctl --no-block start hivra-vm-antispoof.service"
EOF
    systemctl daemon-reload
    udevadm control --reload
    systemctl enable --now hivra-vm-antispoof.timer
    systemctl start hivra-vm-antispoof.service
    log "installed: udev trigger, service and one-minute timer"
    ;;
esac
