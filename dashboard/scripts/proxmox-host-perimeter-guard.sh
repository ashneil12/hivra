#!/usr/bin/env bash
#
# HermesOS Proxmox host perimeter & guest-to-host security guard.
#
# Run on a Proxmox VE 8/9 host as root. Default is audit-only. Use --apply
# during host standup or an approved fleet remediation to install the sshd
# hardening drop-in and rewrite /etc/nftables.conf so that:
#
#   - guest VMs on vmbr1 cannot reach host SSH (22), the Proxmox Web UI
#     (8006), or host Caddy (80/443)
#   - the Proxmox Web UI accepts Tailscale (tailscale0) traffic only and is
#     never exposed to the public internet
#   - 80/443 origin accepts are restricted to the published Cloudflare ranges
#   - guest VMs cannot forward to RFC1918, CGNAT, or link-local destinations
#     over the WAN bridge
#
# Usage:
#   sudo bash proxmox-host-perimeter-guard.sh --check
#   sudo bash proxmox-host-perimeter-guard.sh --apply
#   bash proxmox-host-perimeter-guard.sh --rewrite-nft-only /path/to/nftables.conf
#   bash proxmox-host-perimeter-guard.sh --write-sshd-dropin-only /path/to/dropin.conf
#
# The *-only modes are pure file transforms for unit tests on macOS/CI; they
# do not require root or the systemctl/nft/sshd binaries.

set -euo pipefail

MODE="check"
NFT_CONF="/etc/nftables.conf"
SSHD_DROPIN="/etc/ssh/sshd_config.d/99-hermes-hardening.conf"
NFT_TARGET=""
SSHD_TARGET=""

SSHD_DIRECTIVES=(
  "PasswordAuthentication no"
  "KbdInteractiveAuthentication no"
  "ChallengeResponseAuthentication no"
  "PermitRootLogin prohibit-password"
  "MaxAuthTries 3"
  "X11Forwarding no"
)

CF_IPV4_CIDRS=(
  "173.245.48.0/20" "103.21.244.0/22" "103.22.200.0/22" "103.31.4.0/22"
  "141.101.64.0/18" "108.162.192.0/18" "190.93.240.0/20" "188.114.96.0/20"
  "197.234.240.0/22" "198.41.128.0/17" "162.158.0.0/15" "104.16.0.0/13"
  "104.24.0.0/14" "172.64.0.0/13" "131.0.72.0/22"
)
CF_IPV6_CIDRS=(
  "2400:cb00::/32" "2606:4700::/32" "2803:f800::/32" "2405:b500::/32"
  "2405:8100::/32" "2a06:98c0::/29" "2c0f:f248::/32"
)

NFT_REQUIRED_LINES=(
  'set cloudflare_ipv4'
  'set cloudflare_ipv6'
  'iifname "vmbr1" udp dport 123 accept'
  'iifname "vmbr1" tcp dport { 22, 80, 443, 8006 } drop'
  'iifname "vmbr1" drop'
  'iifname "tailscale0" tcp dport 8006 accept'
  'ip saddr @cloudflare_ipv4 tcp dport { 80, 443 } accept'
  'ip6 saddr @cloudflare_ipv6 tcp dport { 80, 443 } accept'
  'ip saddr @cloudflare_ipv4 udp dport 443 accept'
  'ip6 saddr @cloudflare_ipv6 udp dport 443 accept'
  'iifname "vmbr1" ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } drop'
)

usage() {
  cat <<'EOF'
Usage: proxmox-host-perimeter-guard.sh [--check|--apply]
       proxmox-host-perimeter-guard.sh --rewrite-nft-only <path>
       proxmox-host-perimeter-guard.sh --write-sshd-dropin-only <path>

--check                  Audit only. Exits non-zero if the sshd drop-in, the
                         effective sshd config, /etc/nftables.conf, or the live
                         nftables ruleset is missing a required perimeter rule.
--apply                  Install the sshd drop-in, reload sshd, then rewrite,
                         validate, and apply /etc/nftables.conf.
--rewrite-nft-only       Rewrite an nftables.conf file in place (no root, only
                         python3). For unit tests.
--write-sshd-dropin-only Write the sshd hardening drop-in to a path (no root).
                         For unit tests.
EOF
}

log() { printf '[hermes-perimeter-guard] %s\n' "$*"; }
fatal() { printf '[hermes-perimeter-guard] FATAL: %s\n' "$*" >&2; exit 2; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || fatal "required command missing: $1"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    --apply) MODE="apply" ;;
    --rewrite-nft-only)
      shift
      [ "$#" -gt 0 ] || fatal "--rewrite-nft-only requires a file path"
      MODE="rewrite-nft"
      NFT_TARGET="$1"
      ;;
    --write-sshd-dropin-only)
      shift
      [ "$#" -gt 0 ] || fatal "--write-sshd-dropin-only requires a file path"
      MODE="sshd-dropin"
      SSHD_TARGET="$1"
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

write_sshd_dropin_to() {
  local target="$1"
  install -d -m 0755 "$(dirname "$target")"
  cat > "$target" <<'EOF'
# Managed by proxmox-host-perimeter-guard.sh
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
X11Forwarding no
EOF
}

rewrite_nft_conf_file() {
  local target="$1"
  [ -f "$target" ] || fatal "$target is missing"
  grep -Fq 'table inet filter' "$target" || fatal "$target missing table inet filter"
  python3 - "$target" <<'PY'
import re
import sys
from pathlib import Path

CF_V4 = (
    "173.245.48.0/20, 103.21.244.0/22, 103.22.200.0/22, 103.31.4.0/22, "
    "141.101.64.0/18, 108.162.192.0/18, 190.93.240.0/20, 188.114.96.0/20, "
    "197.234.240.0/22, 198.41.128.0/17, 162.158.0.0/15, 104.16.0.0/13, "
    "104.24.0.0/14, 172.64.0.0/13, 131.0.72.0/22"
)
CF_V6 = (
    "2400:cb00::/32, 2606:4700::/32, 2803:f800::/32, 2405:b500::/32, "
    "2405:8100::/32, 2a06:98c0::/29, 2c0f:f248::/32"
)

RULE_INDENT = "        "
SET_INDENT = "    "

SET_V4 = [
    SET_INDENT + "set cloudflare_ipv4 {",
    SET_INDENT + "    type ipv4_addr",
    SET_INDENT + "    flags interval",
    SET_INDENT + "    elements = { " + CF_V4 + " }",
    SET_INDENT + "}",
]
SET_V6 = [
    SET_INDENT + "set cloudflare_ipv6 {",
    SET_INDENT + "    type ipv6_addr",
    SET_INDENT + "    flags interval",
    SET_INDENT + "    elements = { " + CF_V6 + " }",
    SET_INDENT + "}",
]

MANAGED_INPUT = {
    'iifname "vmbr1" udp dport 123 accept',
    'iifname "vmbr1" tcp dport { 22, 8006 } drop',
    'iifname "vmbr1" tcp dport { 22, 80, 443, 8006 } drop',
    'iifname "vmbr1" drop',
}

VMBR1_INPUT_BLOCK = [
    'iifname "vmbr1" udp dport 123 accept',
    'iifname "vmbr1" tcp dport { 22, 80, 443, 8006 } drop',
    'iifname "vmbr1" drop',
]

CLOUDFLARE_ACCEPTS = [
    'ip saddr @cloudflare_ipv4 tcp dport { 80, 443 } accept',
    'ip6 saddr @cloudflare_ipv6 tcp dport { 80, 443 } accept',
    'ip saddr @cloudflare_ipv4 udp dport 443 accept',
    'ip6 saddr @cloudflare_ipv6 udp dport 443 accept',
]

FWD_DROP = (
    'iifname "vmbr1" ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, '
    '172.16.0.0/12, 192.168.0.0/16 } drop'
)


def norm(line):
    return line.split("#", 1)[0].strip()


def block_end(lines, start):
    depth = 0
    for i in range(start, len(lines)):
        depth += lines[i].count("{") - lines[i].count("}")
        if depth == 0:
            return i
    raise SystemExit("unbalanced braces near line %d" % (start + 1))


def find_block(lines, head_re):
    for i, line in enumerate(lines):
        if head_re.match(line):
            return (i, block_end(lines, i))
    return None


def drop_named_blocks(lines, kind, name):
    head = re.compile(r"^\s*" + kind + r"\s+" + re.escape(name) + r"\s*\{\s*$")
    out = []
    i = 0
    while i < len(lines):
        if head.match(lines[i]):
            i = block_end(lines, i) + 1
            continue
        out.append(lines[i])
        i += 1
    return out


NON_WAN_PREFIXES = (
    "ct ", "ip protocol", "ip6 ", "meta ", "type ", "policy",
    "jump", "goto", "counter", "limit ", "reject", "drop", "oifname",
)


def is_wan_accept(n):
    if "accept" not in n or not n:
        return False
    if n.startswith('iifname "vmbr1"') or n.startswith('iifname "lo"') or n.startswith('iif "lo"'):
        return False
    return not n.startswith(NON_WAN_PREFIXES)


def is_fwd_wan_accept(n):
    return (
        n.startswith('iifname "vmbr1"')
        and "accept" in n
        and 'oifname "vmbr1"' not in n
        and 'oifname "lo"' not in n
    )


def harden_input(inner):
    out = []
    for line in inner:
        n = norm(line)
        if n in MANAGED_INPUT:
            continue
        if re.fullmatch(r"tcp dport 8006 accept", n):
            out.append(RULE_INDENT + 'iifname "tailscale0" tcp dport 8006 accept')
            continue
        if re.fullmatch(r"tcp dport \{ 80, 443 \} accept", n):
            out.extend(RULE_INDENT + r for r in CLOUDFLARE_ACCEPTS)
            continue
        out.append(line)
    anchor = next(
        (i for i, line in enumerate(out) if is_wan_accept(norm(line))),
        len(out),
    )
    out[anchor:anchor] = [RULE_INDENT + r for r in VMBR1_INPUT_BLOCK]
    return out


def harden_forward(inner):
    out = [line for line in inner if norm(line) != FWD_DROP]
    anchor = next(
        (i for i, line in enumerate(out) if is_fwd_wan_accept(norm(line))),
        len(out),
    )
    out.insert(anchor, RULE_INDENT + FWD_DROP)
    return out


path = Path(sys.argv[1])
lines = path.read_text().split("\n")

table = find_block(lines, re.compile(r"^\s*table inet filter\s*\{\s*$"))
if table is None:
    raise SystemExit("missing table inet filter")
ts, te = table
inner = lines[ts + 1 : te]

inner = drop_named_blocks(inner, "set", "cloudflare_ipv4")
inner = drop_named_blocks(inner, "set", "cloudflare_ipv6")

for chain_name, hardener in (("chain input", harden_input), ("chain forward", harden_forward)):
    found = find_block(inner, re.compile(r"^\s*" + chain_name + r"\s*\{"))
    if found is None:
        raise SystemExit("table inet filter missing " + chain_name)
    s, e = found
    inner = inner[: s + 1] + hardener(inner[s + 1 : e]) + inner[e:]

inner = SET_V4 + SET_V6 + inner
lines = lines[: ts + 1] + inner + lines[te:]
path.write_text("\n".join(lines))
PY
}

case "$MODE" in
  rewrite-nft)
    require_command python3
    rewrite_nft_conf_file "$NFT_TARGET"
    log "rewrote $NFT_TARGET"
    exit 0
    ;;
  sshd-dropin)
    write_sshd_dropin_to "$SSHD_TARGET"
    log "wrote $SSHD_TARGET"
    exit 0
    ;;
  check|apply) ;;
  *) fatal "invalid mode: $MODE" ;;
esac

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  fatal "run as root on the Proxmox host"
fi

for cmd in grep python3; do
  require_command "$cmd"
done

sshd_dropin_is_correct() {
  [ -f "$SSHD_DROPIN" ] || return 1
  local expected
  for expected in "${SSHD_DIRECTIVES[@]}"; do
    grep -Fxq "$expected" "$SSHD_DROPIN" || return 1
  done
}

effective_sshd_hardened() {
  local out
  out="$(sshd -T 2>/dev/null)" || return 1
  printf '%s\n' "$out" | grep -Fxq "passwordauthentication no" || return 1
  printf '%s\n' "$out" | grep -Fxq "kbdinteractiveauthentication no" || return 1
  printf '%s\n' "$out" | grep -Fxq "challengeresponseauthentication no" || return 1
  printf '%s\n' "$out" | grep -Fxq "permitrootlogin prohibit-password" || return 1
  printf '%s\n' "$out" | grep -Fxq "maxauthtries 3" || return 1
  printf '%s\n' "$out" | grep -Fxq "x11forwarding no" || return 1
}

write_sshd_dropin() {
  if [ -f "$SSHD_DROPIN" ] && ! sshd_dropin_is_correct; then
    cp "$SSHD_DROPIN" "$SSHD_DROPIN.bak-hermes-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  write_sshd_dropin_to "$SSHD_DROPIN"
}

reload_sshd() {
  systemctl reload ssh 2>/dev/null \
    || systemctl reload sshd 2>/dev/null \
    || systemctl restart ssh
}

nft_conf_has_open_wan_rules() {
  [ -f "$NFT_CONF" ] || return 1
  grep -Eq '^[[:space:]]*tcp dport 8006 accept([[:space:]]*#.*)?$' "$NFT_CONF" && return 0
  grep -Eq '^[[:space:]]*tcp dport \{ 80, 443 \} accept([[:space:]]*#.*)?$' "$NFT_CONF" && return 0
  grep -Fq 'iifname "vmbr1" tcp dport { 22, 8006 } drop' "$NFT_CONF" && return 0
  return 1
}

nft_conf_is_hardened() {
  [ -f "$NFT_CONF" ] || return 1
  local rule cidr
  for rule in "${NFT_REQUIRED_LINES[@]}"; do
    grep -Fq "$rule" "$NFT_CONF" || return 1
  done
  for cidr in "${CF_IPV4_CIDRS[@]}" "${CF_IPV6_CIDRS[@]}"; do
    grep -Fq "$cidr" "$NFT_CONF" || return 1
  done
  ! nft_conf_has_open_wan_rules
}

nft_ruleset_has_open_wan_rules() {
  nft list chain inet filter input 2>/dev/null \
    | grep -Eq '^[[:space:]]*tcp dport (8006|\{ 80, 443 \}) accept([[:space:]]*#.*)?$'
}

nft_runtime_is_hardened() {
  command -v nft >/dev/null 2>&1 || return 1
  local input forward
  input="$(nft list chain inet filter input 2>/dev/null)" || return 1
  forward="$(nft list chain inet filter forward 2>/dev/null)" || return 1
  printf '%s\n' "$input" | grep -Fq 'iifname "vmbr1" udp dport 123 accept' || return 1
  printf '%s\n' "$input" | grep -Fq 'iifname "vmbr1" tcp dport { 22, 80, 443, 8006 } drop' || return 1
  printf '%s\n' "$input" | grep -Eq '^[[:space:]]*iifname "vmbr1" drop$' || return 1
  printf '%s\n' "$input" | grep -Fq 'iifname "tailscale0" tcp dport 8006 accept' || return 1
  printf '%s\n' "$input" | grep -Fq 'ip saddr @cloudflare_ipv4 tcp dport { 80, 443 } accept' || return 1
  printf '%s\n' "$input" | grep -Fq 'ip6 saddr @cloudflare_ipv6 tcp dport { 80, 443 } accept' || return 1
  printf '%s\n' "$forward" | grep -Fq 'iifname "vmbr1" ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } drop' || return 1
  nft list ruleset 2>/dev/null | grep -Fq 'set cloudflare_ipv4' || return 1
  nft list ruleset 2>/dev/null | grep -Fq 'set cloudflare_ipv6' || return 1
  ! nft_ruleset_has_open_wan_rules
}

if [ "$MODE" = "apply" ]; then
  for cmd in sshd systemctl nft install; do
    require_command "$cmd"
  done

  log "applying sshd hardening drop-in"
  write_sshd_dropin
  sshd -t || fatal "sshd -t rejected configuration including $SSHD_DROPIN"
  reload_sshd

  log "applying perimeter nftables guard"
  [ -f "$NFT_CONF" ] || fatal "$NFT_CONF is missing"
  cp "$NFT_CONF" "$NFT_CONF.bak-hermes-perimeter-$(date -u +%Y%m%dT%H%M%SZ)"
  rewrite_nft_conf_file "$NFT_CONF"
  nft -c -f "$NFT_CONF" || fatal "nft -c rejected rewritten $NFT_CONF"
  nft -f "$NFT_CONF"
  nft_runtime_is_hardened || fatal "applied ruleset still missing required perimeter rules"
else
  require_command sshd
  require_command nft
  sshd_dropin_is_correct || fatal "$SSHD_DROPIN missing required hardening directives"
  effective_sshd_hardened || fatal "effective sshd config (sshd -T) is not hardened"
  nft_conf_is_hardened || fatal "$NFT_CONF is missing required perimeter rules or still has open WAN accepts"
  nft_runtime_is_hardened || fatal "live nftables ruleset is missing required perimeter rules"
fi

log "sshd: hardening drop-in applied and effective"
log "nftables: vmbr1 guest-to-host drops, tailscale-only 8006, Cloudflare-only 80/443, RFC1918 forward drop present"
log "done"
