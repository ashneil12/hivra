#!/usr/bin/env bash
#
# Drop common cryptocurrency mining pool ports on the user-VM bridge of a
# Proxmox host. Run this once on each pve host (and re-run whenever the
# bridge changes). Idempotent: rules are only inserted if not already
# present.
#
# Usage (on the pve host as root):
#     scp pve-egress-firewall.sh root@pveN:/root/
#     ssh root@pveN bash /root/pve-egress-firewall.sh
#
# Customer-facing legitimacy: the dashboard's Terms of Service include
# "We monitor for abuse including unauthorized cryptocurrency mining.
# Detection is automated and may include network traffic analysis."
# This script is the detection-and-block side of that statement.
#
# What this catches: lazy mining configurations that hit Stratum-protocol
# pools on the canonical mining ports (3333, 4444, 8888, 14444, plus a
# few other common variants). Sophisticated mining over 443 won't be
# caught here — it shows up via the resource-watchdog's CPU heuristic
# instead.
#
# What this does NOT do: drop existing established connections. Live
# miners need a kill — `iptables -nvL FORWARD` will show their packet
# counts climb. Investigate the VM via the dashboard.

set -euo pipefail

BRIDGE="${VM_BRIDGE:-vmbr1}"
PORTS_TCP="${HERMES_BLOCKED_TCP_PORTS:-3333,4444,8888,14444,5555,7777,9999}"
PORTS_UDP="${HERMES_BLOCKED_UDP_PORTS:-3333,4444,8888,14444}"
COMMENT="hermes-egress-firewall"

if ! command -v iptables >/dev/null 2>&1; then
  echo "[hermes-firewall] iptables not found on PATH — skipping"
  exit 0
fi

if ! ip link show "$BRIDGE" >/dev/null 2>&1; then
  echo "[hermes-firewall] bridge $BRIDGE does not exist — skipping. Set VM_BRIDGE if your hosts use a different name."
  exit 0
fi

ensure_rule() {
  local proto="$1"
  local ports="$2"
  if iptables -C FORWARD -i "$BRIDGE" -p "$proto" -m multiport --dports "$ports" -m comment --comment "$COMMENT" -j DROP 2>/dev/null; then
    echo "[hermes-firewall] $proto $ports rule already present"
    return 0
  fi
  iptables -I FORWARD 1 -i "$BRIDGE" -p "$proto" -m multiport --dports "$ports" -m comment --comment "$COMMENT" -j DROP
  echo "[hermes-firewall] inserted DROP rule: $proto dports=$ports bridge=$BRIDGE"
}

ensure_rule tcp "$PORTS_TCP"
ensure_rule udp "$PORTS_UDP"

# Persist with iptables-persistent if available so the rules survive a
# reboot. If not installed, the operator should `apt install
# iptables-persistent` and re-run, or wire `/etc/network/if-up.d/iptables`
# manually.
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save
  echo "[hermes-firewall] netfilter-persistent save done"
else
  echo "[hermes-firewall] netfilter-persistent not installed — rules will be lost on reboot. apt install iptables-persistent to persist."
fi

echo "[hermes-firewall] done"
