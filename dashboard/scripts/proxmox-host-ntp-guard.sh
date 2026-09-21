#!/usr/bin/env bash
#
# HermesOS Proxmox host NTP guard.
#
# Run on a Proxmox host as root. Default is audit-only. Use --apply during
# host standup or an approved fleet remediation to install the Hetzner chrony
# sources and persist the vmbr1 guest-NTP nftables allow rule.
#
# Incident guard, 2026-06-06: newer Hetzner PVE hosts could reach Hetzner NTP
# only. Public Debian/Google/Cloudflare/pool NTP timed out, chrony never
# synced, VMs inherited slow boot clocks, and short-lived WebUI sidecar login
# tokens were rejected as future-dated.
#
# Usage:
#   sudo bash proxmox-host-ntp-guard.sh --check
#   sudo bash proxmox-host-ntp-guard.sh --apply

set -euo pipefail

MODE="check"
WAIT_SECONDS=120
CHRONY_DROPIN="/etc/chrony/conf.d/hermes-hetzner-ntp.conf"
CHRONY_CONF="/etc/chrony/chrony.conf"
NFT_CONF="/etc/nftables.conf"
VM_SUBNET_ALLOW="allow 10.250.0.0/16"
NTP_RULE='        iifname "vmbr1" udp dport 123 accept'
NTP_SOURCES=(
  "server 213.239.239.165 iburst"
  "server ntp1.hetzner.de iburst"
  "server ntp2.hetzner.de iburst"
  "server ntp3.hetzner.de iburst"
)

usage() {
  cat <<'EOF'
Usage: proxmox-host-ntp-guard.sh [--check|--apply] [--wait-seconds N]

--check          Audit only. Exits non-zero if chrony/nftables are not guarded.
--apply          Install or repair the guard, restart chrony, and apply nftables.
--wait-seconds   Seconds to wait for chrony Leap status Normal. Default: 120.
EOF
}

log() { printf '[hermes-ntp-guard] %s\n' "$*"; }
fatal() { printf '[hermes-ntp-guard] FATAL: %s\n' "$*" >&2; exit 2; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    --apply) MODE="apply" ;;
    --wait-seconds)
      shift
      [ "$#" -gt 0 ] || fatal "--wait-seconds requires a value"
      WAIT_SECONDS="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fatal "unknown argument: $1"
      ;;
  esac
  shift
done

case "$MODE" in
  check|apply) ;;
  *) fatal "invalid mode: $MODE" ;;
esac

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  fatal "run as root on the Proxmox host"
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || fatal "required command missing: $1"
}

for cmd in awk grep sed systemctl chronyc; do
  require_command "$cmd"
done

chrony_dropin_is_correct() {
  [ -f "$CHRONY_DROPIN" ] || return 1
  local expected
  for expected in "${NTP_SOURCES[@]}" "$VM_SUBNET_ALLOW"; do
    grep -Fxq "$expected" "$CHRONY_DROPIN" || return 1
  done
}

chrony_has_active_debian_pool() {
  [ -f "$CHRONY_CONF" ] || return 1
  grep -Eq '^[[:space:]]*pool[[:space:]]+2\.debian\.pool\.ntp\.org([[:space:]]|$)' "$CHRONY_CONF"
}

write_chrony_dropin() {
  install -d -m 0755 "$(dirname "$CHRONY_DROPIN")"
  if [ -f "$CHRONY_DROPIN" ] && ! chrony_dropin_is_correct; then
    cp "$CHRONY_DROPIN" "$CHRONY_DROPIN.bak-hermes-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  cat > "$CHRONY_DROPIN" <<'EOF'
server 213.239.239.165 iburst
server ntp1.hetzner.de iburst
server ntp2.hetzner.de iburst
server ntp3.hetzner.de iburst
allow 10.250.0.0/16
EOF
}

disable_debian_pool() {
  if chrony_has_active_debian_pool; then
    cp "$CHRONY_CONF" "$CHRONY_CONF.bak-hermes-ntp-$(date -u +%Y%m%dT%H%M%SZ)"
    sed -i -E 's/^([[:space:]]*pool[[:space:]]+2\.debian\.pool\.ntp\.org.*)$/# hermes disabled unreachable default pool: \1/' "$CHRONY_CONF"
  fi
}

chrony_leap_status() {
  chronyc tracking 2>/dev/null | awk -F: '/^Leap status/ {gsub(/^[ \t]+/, "", $2); print $2; exit}'
}

wait_for_chrony_normal() {
  local deadline now status
  deadline=$(( $(date +%s) + WAIT_SECONDS ))
  while true; do
    status="$(chrony_leap_status || true)"
    if [ "$status" = "Normal" ]; then
      return 0
    fi
    now=$(date +%s)
    [ "$now" -lt "$deadline" ] || break
    sleep 2
  done

  log "chronyc tracking output:"
  chronyc tracking >&2 || true
  log "chronyc sources output:"
  chronyc sources -v >&2 || true
  return 1
}

restart_and_verify_chrony() {
  systemctl enable --now chrony
  systemctl restart chrony
  chronyc -a 'burst 4/4' || true
  wait_for_chrony_normal || fatal "chrony did not reach Leap status: Normal via Hetzner NTP"
  chronyc -a makestep || true
  hwclock --systohc --utc 2>/dev/null || true
}

nft_config_has_rule() {
  [ -f "$NFT_CONF" ] || return 1
  grep -Fq 'iifname "vmbr1" udp dport 123 accept' "$NFT_CONF"
}

nft_runtime_has_rule() {
  command -v nft >/dev/null 2>&1 || return 1
  nft list chain inet filter input 2>/dev/null | grep -Eq 'iifname "vmbr1".*udp dport 123.*accept'
}

insert_nft_rule() {
  [ -f "$NFT_CONF" ] || fatal "$NFT_CONF is missing"
  grep -Fq 'table inet filter' "$NFT_CONF" || fatal "$NFT_CONF missing table inet filter"
  grep -Fq 'table bridge hermes_vm_isolation' "$NFT_CONF" || fatal "$NFT_CONF missing table bridge hermes_vm_isolation"

  if nft_config_has_rule; then
    return 0
  fi

  cp "$NFT_CONF" "$NFT_CONF.bak-hermes-ntp-$(date -u +%Y%m%dT%H%M%SZ)"
  python3 - "$NFT_CONF" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text()
rule = '        iifname "vmbr1" udp dport 123 accept\n'
if rule.strip() in text:
    raise SystemExit(0)
needles = [
    '        iifname "vmbr1" tcp dport { 22, 8006 } drop\n',
    '        tcp dport 22 accept\n',
]
for needle in needles:
    idx = text.find(needle)
    if idx != -1:
        path.write_text(text[:idx] + rule + text[idx:])
        raise SystemExit(0)
raise SystemExit('could not find a safe insertion point for vmbr1 UDP/123 allow rule')
PY
}

validate_and_apply_nftables() {
  require_command nft
  nft -c -f "$NFT_CONF"
  nft -f "$NFT_CONF"
  nft_runtime_has_rule || fatal "runtime nftables input chain missing vmbr1 UDP/123 allow rule"
}

if [ "$MODE" = "apply" ]; then
  log "applying Hetzner chrony guard"
  write_chrony_dropin
  disable_debian_pool
  restart_and_verify_chrony

  log "applying vmbr1 guest-NTP nftables guard"
  insert_nft_rule
  validate_and_apply_nftables
else
  chrony_dropin_is_correct || fatal "$CHRONY_DROPIN missing required Hetzner NTP sources or allow 10.250.0.0/16"
  if chrony_has_active_debian_pool; then
    fatal "$CHRONY_CONF still has active unreachable Debian pool NTP"
  fi
  [ "$(chrony_leap_status || true)" = "Normal" ] || fatal "chrony Leap status is not Normal"
  nft_config_has_rule || fatal "$NFT_CONF missing iifname \"vmbr1\" udp dport 123 accept"
  nft_runtime_has_rule || fatal "runtime nftables input chain missing vmbr1 UDP/123 allow rule"
fi

log "chrony: Leap status Normal"
log "nftables: vmbr1 UDP/123 accept present"
log "done"
