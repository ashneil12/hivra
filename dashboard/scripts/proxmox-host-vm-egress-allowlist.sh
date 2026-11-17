#!/usr/bin/env bash
# proxmox-host-vm-egress-allowlist.sh: limit which internet sites an agent's
# computer may reach, enforced on the Proxmox host, outside the guest.
#
# Why on the host: an agent with root inside its own computer can change any
# firewall the guest runs. Rules in the host's forward path cannot be changed
# from inside the guest.
#
# Off unless an owner turns it on. A computer with no policy file is not
# touched. A policy file is /etc/hivra/egress/<vmid>.json, written by Hivra
# when the owner saves the list in Manage:
#
#   {"version":1,"vmid":2104,"binding_tag":"hivra-bind-<32 hex>",
#    "sites":["github.com","api.openai.com"],
#    "required":["hivra.cloud","198.41.192.0/24"]}
#
# "sites" are the owner's. "required" are what Hivra itself needs for the
# computer to keep working (its connection service, its tunnel). Each entry is
# a host name (resolved to IPv4 addresses on the host every run) or an IPv4
# address or CIDR. Wildcards are not supported: list each host name.
#
# The policy only applies while the VM's config still carries the same
# binding tag, so a VMID reused by another computer, or a computer moved to
# another host, never inherits a stale list.
#
# For each policy the rendered `table inet hivra_vm_egress` lets the guest's
# static IPv4 (its source address is pinned to its NIC by
# proxmox-host-vm-antispoof.sh):
#   - continue replies on connections it already has;
#   - reach DNS (port 53, TCP and UDP) so names still resolve, and NTP
#     (UDP 123) so its clock stays right;
#   - reach the resolved addresses of its sites and Hivra's required ones;
# and rejects everything else it sends through the host. The chain only
# rejects or passes traffic on; an accept here does not skip the host's other
# firewall chains. IPv6 is not routed for guests, so nothing is added for it.
#
# Limits, said plainly: a site behind a CDN can answer the guest with an
# address the host did not see when it resolved the name, so a listed site can
# be blocked for minutes until the next run. DNS itself stays open, so this is
# a guard against an agent wandering to sites it should not use, not a seal
# against a determined program inside the computer.
#
# Usage:
#   proxmox-host-vm-egress-allowlist.sh --render          print the table (no root)
#   sudo proxmox-host-vm-egress-allowlist.sh --check      exit 1 when the live table drifts
#   sudo proxmox-host-vm-egress-allowlist.sh --apply      validate with nft -c, then load
#   sudo proxmox-host-vm-egress-allowlist.sh --install    install, plus a five-minute timer
#   sudo proxmox-host-vm-egress-allowlist.sh --uninstall  rollback: stop the timer, delete the table
#
# Environment (tests): QEMU_CONF_DIR, EGRESS_POLICY_DIR, NFT_BIN, EGRESS_LOCK,
# EGRESS_TMPDIR, EGRESS_RESOLVE_FIXTURE (a JSON file {"name": ["1.2.3.4"]}
# used instead of DNS).
# Read-only except --apply, --install and --uninstall. Bash 3.2 compatible.

set -euo pipefail

QEMU_CONF_DIR="${QEMU_CONF_DIR:-/etc/pve/qemu-server}"
EGRESS_POLICY_DIR="${EGRESS_POLICY_DIR:-/etc/hivra/egress}"
NFT_BIN="${NFT_BIN:-nft}"
EGRESS_LOCK="${EGRESS_LOCK:-/run/hivra-vm-egress.lock}"
TABLE_NAME="hivra_vm_egress"
INSTALL_PATH="/usr/local/sbin/hivra-vm-egress"
MODE=""
QUIET=0

log() { [ "$QUIET" = 1 ] || printf '[hivra-vm-egress] %s\n' "$*"; }
fatal() { printf '[hivra-vm-egress] FATAL: %s\n' "$*" >&2; exit 2; }

usage() {
  sed -n '2,60p' "$0" | sed -n '/^#/!q;p' | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --render) MODE="render" ;;
    --check) MODE="check" ;;
    --apply) MODE="apply" ;;
    --install) MODE="install" ;;
    --uninstall) MODE="uninstall" ;;
    --quiet) QUIET=1 ;;
    -h|--help) usage; exit 0 ;;
    *) fatal "unknown argument: $1" ;;
  esac
  shift
done
[ -n "$MODE" ] || { usage; exit 2; }

render() {
  python3 - "$QEMU_CONF_DIR" "$EGRESS_POLICY_DIR" "$TABLE_NAME" "${EGRESS_RESOLVE_FIXTURE:-}" <<'PY'
import ipaddress, json, os, re, socket, sys

qemu_dir, policy_dir, table, fixture_path = sys.argv[1:5]
HOST = re.compile(r'^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$')
TAG = re.compile(r'^hivra-bind-[a-f0-9]{32}$')
MAX_ENTRIES = 200
fixture = None
if fixture_path:
    with open(fixture_path, encoding="utf-8") as fh:
        fixture = json.load(fh)

def resolve(name):
    if fixture is not None:
        return [a for a in fixture.get(name, []) if isinstance(a, str)]
    try:
        infos = socket.getaddrinfo(name, None, socket.AF_INET, socket.SOCK_STREAM)
    except OSError:
        return []
    return [info[4][0] for info in infos]

def vm_config(vmid):
    main, cloudinit, current = {}, {}, "main"
    path = os.path.join(qemu_dir, f"{vmid}.conf")
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line.startswith("["):
                current = "cloudinit" if line.strip() == "[special:cloudinit]" else "other"
                continue
            m = re.match(r'^([a-z0-9]+):\s*(.*)$', line)
            if not m:
                continue
            (main if current == "main" else cloudinit if current == "cloudinit" else {})[m.group(1)] = m.group(2)
    return main, cloudinit

def guest_ipv4(main, cloudinit):
    value = cloudinit.get("ipconfig0") or main.get("ipconfig0", "")
    for item in value.split(","):
        if item.startswith("ip="):
            try:
                return str(ipaddress.IPv4Interface(item[3:]).ip)
            except ValueError:
                return None
    return None

def entries(values, notes, label):
    nets = set()
    for raw in values[:MAX_ENTRIES]:
        if not isinstance(raw, str):
            continue
        item = raw.strip().lower().rstrip(".")
        try:
            net = ipaddress.IPv4Network(item, strict=False)
            if net.is_private or net.is_loopback or net.is_link_local or net.is_multicast or net.is_unspecified:
                notes.append(f"{label}: {item} is not a public address; ignored")
                continue
            nets.add(net)
            continue
        except ValueError:
            pass
        if not HOST.match(item):
            notes.append(f"{label}: {item!r} is not a host name; ignored")
            continue
        found = 0
        for addr in resolve(item):
            try:
                ip = ipaddress.IPv4Address(addr)
            except ValueError:
                continue
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_unspecified:
                continue
            nets.add(ipaddress.IPv4Network(f"{ip}/32"))
            found += 1
        if not found:
            notes.append(f"{label}: {item} did not resolve; nothing allowed for it this run")
    return nets

policies, notes = [], []
names = sorted(os.listdir(policy_dir)) if os.path.isdir(policy_dir) else []
for name in names:
    m = re.match(r'^(\d{3,9})\.json$', name)
    if not m:
        continue
    vmid = int(m.group(1))
    try:
        with open(os.path.join(policy_dir, name), encoding="utf-8") as fh:
            policy = json.load(fh)
    except (OSError, ValueError):
        notes.append(f"vm {vmid}: policy unreadable; not applied")
        continue
    if policy.get("version") != 1 or policy.get("vmid") != vmid or not TAG.match(str(policy.get("binding_tag", ""))):
        notes.append(f"vm {vmid}: policy malformed; not applied")
        continue
    try:
        main, cloudinit = vm_config(vmid)
    except OSError:
        notes.append(f"vm {vmid}: no VM config on this host; not applied")
        continue
    tags = [t for t in re.split(r'[;,\s]+', main.get("tags", "")) if t]
    if policy["binding_tag"] not in tags:
        notes.append(f"vm {vmid}: binding tag does not match this VM; not applied")
        continue
    ip = guest_ipv4(main, cloudinit)
    if not ip:
        notes.append(f"vm {vmid}: no static IPv4 in its config; not applied")
        continue
    sites = policy.get("sites") if isinstance(policy.get("sites"), list) else []
    required = policy.get("required") if isinstance(policy.get("required"), list) else []
    nets = entries(sites, notes, f"vm {vmid}") | entries(required, notes, f"vm {vmid} required")
    nets = list(ipaddress.collapse_addresses(sorted(nets)))
    policies.append((vmid, ip, nets, len(sites)))

lines = [
    f"table inet {table}",
    f"delete table inet {table}",
    f"table inet {table} {{",
]
for vmid, ip, nets, _ in policies:
    lines += [f"\tset allow_{vmid} {{", "\t\ttype ipv4_addr", "\t\tflags interval"]
    if nets:
        lines.append("\t\telements = { " + ", ".join(str(n) for n in nets) + " }")
    lines.append("\t}")
lines += [
    "\tchain forward {",
    "\t\ttype filter hook forward priority -5; policy accept;",
]
for vmid, ip, nets, count in policies:
    q = f"ip saddr {ip}"
    lines.append(f"\t\t# vm {vmid}: {count} site(s), {len(nets)} allowed range(s)")
    lines.append(f"\t\t{q} ct state established,related accept")
    lines.append(f"\t\t{q} meta l4proto {{ tcp, udp }} th dport 53 accept")
    lines.append(f"\t\t{q} udp dport 123 accept")
    lines.append(f"\t\t{q} ip daddr @allow_{vmid} accept")
    lines.append(f"\t\t{q} counter reject with icmpx admin-prohibited")
lines += ["\t}", "}"]
print("\n".join(lines))
for note in notes:
    print(f"# note: {note}")
print(f"# policies={len(policies)}")
PY
}

with_lock() {
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$EGRESS_LOCK"
    flock -w 30 9 || fatal "another run holds $EGRESS_LOCK"
  fi
}

case "$MODE" in
  render)
    render
    ;;
  check)
    rendered="$(render)"
    listing="$("$NFT_BIN" list table inet "$TABLE_NAME" 2>/dev/null || true)"
    policies="$(printf '%s\n' "$rendered" | sed -n 's/^# policies=//p')"
    if [ -z "$listing" ]; then
      if [ "${policies:-0}" = 0 ]; then log "OK: no computer has an allowed-sites list"; exit 0; fi
      log "DRIFT: table inet $TABLE_NAME is not loaded but $policies policy file(s) apply"
      exit 1
    fi
    expected="$(printf '%s\n' "$rendered" | { grep -E '^[[:space:]]+ip saddr ' || true; } | sed -e 's/^[[:space:]]*//' -e 's/ counter / /' | sort)"
    live="$(printf '%s\n' "$listing" | { grep -E '^[[:space:]]+ip saddr ' || true; } | sed -e 's/^[[:space:]]*//' -e 's/ counter packets [0-9]* bytes [0-9]* / /' | sort)"
    if [ "$expected" != "$live" ]; then
      log "DRIFT: live rules differ from the policy files"
      diff <(printf '%s\n' "$expected") <(printf '%s\n' "$live") | sed 's/^/  /' || true
      exit 1
    fi
    log "OK: live table matches $policies policy file(s)"
    ;;
  apply)
    [ "$(id -u)" = 0 ] || fatal "--apply must run as root"
    with_lock
    tmp="$(mktemp "${EGRESS_TMPDIR:-/run}/hivra-vm-egress.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT
    rendered="$(render)"
    printf '%s\n' "$rendered" | grep -v '^# ' > "$tmp"
    "$NFT_BIN" -c -f "$tmp" || fatal "rendered ruleset failed nft -c; live table left unchanged"
    "$NFT_BIN" -f "$tmp" || fatal "nft -f failed; the previous table stays loaded (the replace is one transaction)"
    printf '%s\n' "$rendered" | sed -n 's/^# note: /[hivra-vm-egress] NOTE: /p' >&2
    log "applied: $(printf '%s\n' "$rendered" | sed -n 's/^# policies=//p') policy file(s)"
    ;;
  install)
    [ "$(id -u)" = 0 ] || fatal "--install must run as root"
    install -m 0755 "$0" "$INSTALL_PATH"
    install -d -m 0700 "$EGRESS_POLICY_DIR"
    cat > /etc/systemd/system/hivra-vm-egress.service <<EOF
[Unit]
Description=Apply per-computer allowed-sites lists (inet $TABLE_NAME)
After=nftables.service pve-cluster.service network-online.target
ConditionPathIsMountPoint=/etc/pve

[Service]
Type=oneshot
ExecStart=$INSTALL_PATH --apply --quiet
EOF
    cat > /etc/systemd/system/hivra-vm-egress.timer <<'EOF'
[Unit]
Description=Re-resolve allowed sites every five minutes

[Timer]
OnBootSec=45s
OnUnitActiveSec=300s

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now hivra-vm-egress.timer
    systemctl start hivra-vm-egress.service
    log "installed: service and five-minute timer"
    ;;
  uninstall)
    [ "$(id -u)" = 0 ] || fatal "--uninstall must run as root"
    systemctl disable --now hivra-vm-egress.timer 2>/dev/null || true
    systemctl stop hivra-vm-egress.service 2>/dev/null || true
    rm -f /etc/systemd/system/hivra-vm-egress.timer /etc/systemd/system/hivra-vm-egress.service
    systemctl daemon-reload
    rm -f "$INSTALL_PATH"
    if "$NFT_BIN" list table inet "$TABLE_NAME" >/dev/null 2>&1; then
      "$NFT_BIN" delete table inet "$TABLE_NAME" || fatal "timer removed, but deleting table inet $TABLE_NAME failed"
    fi
    log "uninstalled: timer removed and table inet $TABLE_NAME is gone (policy files kept in $EGRESS_POLICY_DIR)"
    ;;
esac
