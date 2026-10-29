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
#   - VLAN-tagged frames (802.1Q, 802.1ad) are dropped: a tag hides ARP from the
#     ARP matches, and the host still handles VID 0 frames as untagged;
#   - frames whose Ethernet source is not the NIC's configured MAC are dropped;
#   - ARP whose sender MAC is not that MAC is dropped;
#   - static-IP NICs: ARP and IPv4 whose source is not the configured IP are
#     dropped (ARP probes and DHCP discover from 0.0.0.0 are allowed). The IP is
#     taken from [special:cloudinit] when present, which is what the guest
#     actually booted with, else from the main config;
#   - NICs with `ip=dhcp` or no ipconfig (BYO-ISO desktops, the DHCP lab) are
#     pinned by MAC and may not claim any address in the set `pinned_v4` (every
#     static guest IP plus the configured gateways); other addresses stay open
#     to them because the host cannot know which one is theirs;
#   - IPv6 router advertisements and redirects are dropped, and IPv6 sources
#     other than link-local and :: are dropped. The host routes no IPv6 for
#     guests. Link-local neighbour discovery is otherwise left alone.
#
# The table is replaced in one nft transaction on every run, so it mirrors the
# current configs; never add rules to it by hand (a quarantine rule belongs in
# its own table). --install-triggers adds a udev rule that reruns this on every
# new tap/veth, plus a one-minute timer that also drops removed guests. A NIC
# hot-plugged into a running VM can stay unpinned until the next timer run.
# `flush ruleset` in /etc/nftables.conf (an nftables reload, the perimeter or
# NTP guard --apply) removes this table until the next run, up to a minute.
#
# Usage:
#   proxmox-host-vm-antispoof.sh --render              print the table (no root)
#   sudo proxmox-host-vm-antispoof.sh --audit-neighbours
#                                                      read-only: would any guest the host
#                                                      has seen be cut off? Run before
#                                                      the first --apply on a host.
#   sudo proxmox-host-vm-antispoof.sh --check          exit 1 on drift, unreadable NIC configs
#                                                      or live guest ports with no config
#   sudo proxmox-host-vm-antispoof.sh --apply          validate with nft -c, then load; refuses
#                                                      an empty render while guests run
#   sudo proxmox-host-vm-antispoof.sh --install-triggers
#   sudo proxmox-host-vm-antispoof.sh --uninstall      rollback: stop the triggers, delete the table
#
# Environment (tests): QEMU_CONF_DIR, LXC_CONF_DIR, NFT_BIN, ANTISPOOF_LOCK,
# ANTISPOOF_TMPDIR, SYS_CLASS_NET, ANTISPOOF_BRIDGE.
# Read-only except --apply, --install-triggers and --uninstall. Bash 3.2 compatible.

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
  sed -n '2,60p' "$0" | sed -n '/^#/!q;p' | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --render) MODE="render" ;;
    --check) MODE="check" ;;
    --apply) MODE="apply" ;;
    --install-triggers) MODE="install" ;;
    --audit-neighbours) MODE="audit-neighbours" ;;
    --uninstall) MODE="uninstall" ;;
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

def sections(path):
    # The main section holds the live config. "[special:cloudinit]" holds the
    # cloud-init values last written to the guest's drive, which is what the
    # guest actually booted with when ipconfig was changed later. Snapshot
    # sections describe old states and are ignored.
    main, cloudinit, current = {}, {}, "main"
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line.startswith("["):
                current = "cloudinit" if line.strip() == "[special:cloudinit]" else "other"
                continue
            m = re.match(r'^([a-z0-9]+):\s*(.*)$', line)
            if not m:
                continue
            if current == "main":
                main[m.group(1)] = m.group(2)
            elif current == "cloudinit":
                cloudinit[m.group(1)] = m.group(2)
    return main, cloudinit

def kv(value):
    parts = {}
    for item in value.split(","):
        if "=" in item:
            k, v = item.split("=", 1)
            parts[k.strip().lower()] = v.strip()
        elif item.strip():
            parts[item.strip().lower()] = ""
    return parts

def nic_mac(fields, keys):
    # Proxmox writes "<model>=<mac>" (virtio, e1000, e1000-82540em, ...) or
    # "model=<model>,macaddr=<mac>"; containers write "hwaddr=<mac>".
    for k in keys:
        v = fields.get(k, "").lower()
        if MAC.match(v):
            return v
    for k, v in fields.items():
        if k in ("bridge", "tag", "trunks", "rate", "queues", "mtu", "firewall", "link_down", "name", "type", "gw", "gw6", "ip", "ip6"):
            continue
        if MAC.match(v.lower()):
            return v.lower()
    return ""

def static_ipv4(value):
    fields = kv(value)
    ip = fields.get("ip", "")
    if not ip or ip in ("dhcp", "manual"):
        return None, None
    try:
        addr = str(ipaddress.IPv4Interface(ip).ip)
    except ValueError:
        return None, None
    gw = fields.get("gw", "")
    try:
        gw = str(ipaddress.IPv4Address(gw)) if gw else None
    except ValueError:
        gw = None
    return addr, gw

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
gateways = set()

def load(kind, directory, prefix, mac_keys):
    for gid in guest_ids(directory):
        path = os.path.join(directory, f"{gid}.conf")
        try:
            conf, cloudinit = sections(path)
        except OSError as err:
            skipped.append(f"{kind} {gid}: unreadable config ({err.__class__.__name__})")
            continue
        if conf.get("template") == "1":
            continue
        for key in sorted(k for k in conf if re.match(r'^net\d+$', k)):
            n = key[3:]
            fields = kv(conf[key])
            mac = nic_mac(fields, mac_keys)
            if not mac:
                skipped.append(f"{kind} {gid} {key}: no MAC in config")
                continue
            if kind == "lxc":
                ip, gw = static_ipv4(conf[key])
            else:
                ipconfig = cloudinit.get(f"ipconfig{n}") or conf.get(f"ipconfig{n}", "")
                ip, gw = static_ipv4(ipconfig)
            if gw:
                gateways.add(gw)
            nics.append((f"{prefix}{gid}i{n}", mac, ip, f"{kind} {gid} {key}"))

load("qemu", qemu_dir, "tap", ("macaddr", "virtio", "e1000", "e1000e", "rtl8139", "vmxnet3"))
load("lxc", lxc_dir, "veth", ("hwaddr",))

pinned = sorted({n[2] for n in nics if n[2]} | gateways, key=lambda a: ipaddress.IPv4Address(a))
lines = [
    f"table bridge {table}",
    f"delete table bridge {table}",
    f"table bridge {table} {{",
    "\tset pinned_v4 {",
    "\t\ttype ipv4_addr",
]
if pinned:
    lines.append("\t\telements = { " + ", ".join(pinned) + " }")
lines += [
    "\t}",
    "\tchain prerouting {",
    "\t\ttype filter hook prerouting priority -300; policy accept;",
]
for iface, mac, ip, label in nics:
    q = f'iifname "{iface}"'
    lines.append(f"\t\t# {label}{'' if ip else ' (no static IPv4: MAC pin, and no claiming a pinned IPv4)'}")
    # VLAN-tagged frames would hide ARP from the arp matches below while the
    # host still processes VID 0 frames as untagged. Guests have no VLAN use here.
    lines.append(f"\t\t{q} ether type {{ 8021q, 8021ad }} drop")
    lines.append(f"\t\t{q} ether saddr != {mac} drop")
    lines.append(f"\t\t{q} arp saddr ether != {mac} drop")
    if ip:
        lines.append(f"\t\t{q} arp saddr ip != {{ 0.0.0.0, {ip} }} drop")
        lines.append(f"\t\t{q} ip saddr 0.0.0.0 udp sport 68 udp dport 67 accept")
        lines.append(f"\t\t{q} ip saddr != {ip} drop")
    else:
        lines.append(f"\t\t{q} arp saddr ip @pinned_v4 drop")
        lines.append(f"\t\t{q} ip saddr @pinned_v4 drop")
    lines.append(f"\t\t{q} icmpv6 type {{ nd-router-advert, nd-redirect }} drop")
    lines.append(f"\t\t{q} ip6 saddr != {{ ::, fe80::/10 }} drop")
lines += ["\t}", "}"]
print("\n".join(lines))
for item in skipped:
    print(f"# skipped: {item}")
print(f"# skipped_count={len(skipped)}")
print(f"# pinned {len(nics)} NIC(s), {sum(1 for n in nics if n[2])} with a static IPv4")
PY
}

guest_ports() {
  # tap/veth interfaces that exist on this host right now.
  ls "${SYS_CLASS_NET:-/sys/class/net}" 2>/dev/null | grep -E '^(tap|veth)[0-9]+i[0-9]+$' || true
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
    summary="$(printf '%s\n' "$rendered" | tail -1 | sed 's/^# //')"
    skipped_count="$(printf '%s\n' "$rendered" | sed -n 's/^# skipped_count=//p')"
    listing="$("$NFT_BIN" list table bridge "$TABLE_NAME" 2>/dev/null || true)"
    problems=0
    if [ -z "$listing" ]; then
      log "DRIFT: table bridge $TABLE_NAME is not loaded"
      problems=1
    else
      printf '%s\n' "$listing" | grep -q 'type filter hook prerouting priority dstnat; policy accept;' \
        || { log "DRIFT: chain prerouting is not hooked at priority dstnat (-300) with policy accept"; problems=1; }
      expected="$(printf '%s\n' "$rendered" | grep -E '^[[:space:]]+iifname ' | sed 's/^[[:space:]]*//' | sort)"
      live="$(printf '%s\n' "$listing" | grep -E '^[[:space:]]+iifname ' | sed 's/^[[:space:]]*//' | sort)"
      if [ "$expected" != "$live" ]; then
        log "DRIFT: live rules differ from the guest configs"
        diff <(printf '%s\n' "$expected") <(printf '%s\n' "$live") | sed 's/^/  /' || true
        problems=1
      fi
    fi
    if [ "${skipped_count:-0}" != 0 ]; then
      log "UNPINNED: $skipped_count NIC(s) could not be read from config:"
      printf '%s\n' "$rendered" | sed -n 's/^# skipped: /  /p'
      problems=1
    fi
    unconfigured="$(guest_ports | while read -r port; do printf '%s\n' "$rendered" | grep -q "iifname \"$port\"" || echo "$port"; done)"
    if [ -n "$unconfigured" ]; then
      log "UNPINNED: live guest ports with no matching config entry: $(echo $unconfigured)"
      problems=1
    fi
    [ "$problems" = 0 ] && log "OK: live table matches the guest configs ($summary)"
    exit "$problems"
    ;;
  audit-neighbours)
    # Read-only pre-rollout check: would the pins cut off a guest whose real
    # address differs from its config? Compares the host's neighbour table
    # (what guests actually use) with the rendered pins.
    rendered="$(render)"
    bridge="${ANTISPOOF_BRIDGE:-vmbr1}"
    mismatches=0
    while read -r ip _ _ _ mac _; do
      [ -n "$mac" ] || continue
      pin_ip="$(printf '%s\n' "$rendered" | grep -E "ether saddr != $mac drop" | head -1 | sed -E 's/^[[:space:]]*iifname "([^"]+)".*/\1/')"
      [ -n "$pin_ip" ] || continue
      if printf '%s\n' "$rendered" | grep -q "iifname \"$pin_ip\" ip saddr != "; then
        want="$(printf '%s\n' "$rendered" | sed -n "s/^[[:space:]]*iifname \"$pin_ip\" ip saddr != \([0-9.]*\) drop$/\1/p")"
        if [ "$want" != "$ip" ]; then
          log "MISMATCH: $pin_ip (mac $mac) is seen at $ip but would be pinned to $want"
          mismatches=$((mismatches + 1))
        fi
      elif printf '%s\n' "$rendered" | grep -q "elements = {.* $ip[,} ]"; then
        log "MISMATCH: MAC-only $pin_ip (mac $mac) uses $ip, which is another guest's pinned address"
        mismatches=$((mismatches + 1))
      fi
    done < <(ip neigh show dev "$bridge" 2>/dev/null | awk '$2=="lladdr"{print $1, "dev", "x", "lladdr", tolower($3)}' | awk '{print $1, $2, $3, $4, $5}')
    [ "$mismatches" = 0 ] && log "OK: every guest the host has seen uses the address it would be pinned to"
    exit $(( mismatches > 0 ))
    ;;
  apply)
    [ "$(id -u)" = 0 ] || fatal "--apply must run as root"
    with_lock
    tmp="$(mktemp "${ANTISPOOF_TMPDIR:-/run}/hivra-vm-antispoof.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT
    rendered="$(render)"
    # An empty render while guests are running means the configs are not
    # readable (pmxcfs not mounted, pve-cluster restarting). Loading it would
    # silently remove every pin, so keep the current table instead.
    if ! printf '%s\n' "$rendered" | grep -qE '^[[:space:]]+iifname ' && [ -n "$(guest_ports)" ]; then
      fatal "no guest NIC found in $QEMU_CONF_DIR or $LXC_CONF_DIR while guest ports exist; refusing to load an empty table"
    fi
    printf '%s\n' "$rendered" | grep -v '^# ' > "$tmp"
    "$NFT_BIN" -c -f "$tmp" || fatal "rendered ruleset failed nft -c; live table left unchanged"
    "$NFT_BIN" -f "$tmp" || fatal "nft -f failed; the previous table stays loaded (the replace is one transaction)"
    log "applied: $(printf '%s\n' "$rendered" | tail -1 | sed 's/^# //')"
    if [ "$(printf '%s\n' "$rendered" | sed -n 's/^# skipped_count=//p')" != 0 ]; then
      printf '%s\n' "$rendered" | sed -n 's/^# skipped: /[hermes-vm-antispoof] UNPINNED: /p' >&2
    fi
    ;;
  install)
    [ "$(id -u)" = 0 ] || fatal "--install-triggers must run as root"
    install -m 0755 "$0" "$INSTALL_PATH"
    cat > /etc/systemd/system/hivra-vm-antispoof.service <<EOF
[Unit]
Description=Pin guest NICs to their MAC and IP (bridge $TABLE_NAME)
After=nftables.service pve-cluster.service
ConditionPathIsMountPoint=/etc/pve

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
  uninstall)
    # Rollback. Stop the triggers first, or the timer reloads the table within
    # a minute of it being deleted.
    [ "$(id -u)" = 0 ] || fatal "--uninstall must run as root"
    systemctl disable --now hivra-vm-antispoof.timer 2>/dev/null || true
    rm -f /etc/udev/rules.d/90-hivra-vm-antispoof.rules /etc/systemd/system/hivra-vm-antispoof.timer /etc/systemd/system/hivra-vm-antispoof.service
    systemctl daemon-reload
    udevadm control --reload
    "$NFT_BIN" delete table bridge "$TABLE_NAME" 2>/dev/null || true
    rm -f "$INSTALL_PATH"
    log "uninstalled: triggers removed and table bridge $TABLE_NAME deleted"
    ;;
esac
