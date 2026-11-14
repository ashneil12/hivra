#!/usr/bin/env bash
#
# HermesOS Proxmox host perimeter & guest-to-host security guard.
#
# Run on a Proxmox VE 8/9 host as root. Default is audit-only. Use --apply
# during host standup or an approved fleet remediation to install the sshd
# hardening drop-in and rewrite /etc/nftables.conf so that:
#
#   - guest VMs on vmbr1 cannot open new connections to the host (SSH 22,
#     the Proxmox Web UI 8006, host Caddy 80/443, or anything else) except
#     NTP and the guest allows (DHCP, DNS) that the host config already had;
#     replies to host-initiated connections still pass
#   - the Proxmox Web UI accepts Tailscale (tailscale0) traffic only and is
#     never exposed to the public internet (use an SSH tunnel otherwise)
#   - guest VMs cannot forward to RFC1918, CGNAT, or link-local destinations
#     over the WAN bridge
#   - optionally (--cloudflare-origin-only), 80/443 origin accepts are
#     restricted to the published Cloudflare ranges. This is off by default
#     because sslip.io and unproxied gateway hostnames reach the host directly;
#     --apply refuses it unless every Caddy site resolves to Cloudflare only.
#
# Guest-to-guest traffic on the same bridge is NOT decided here: it rests on
# the `table bridge hermes_vm_isolation` table, which this guard leaves as is.
#
# --apply validates the rewritten ruleset on a temp copy before it touches the
# live file, prints the diff, and restores the previous file and ruleset if
# loading or the post-apply check fails.
#
# Usage:
#   sudo bash proxmox-host-perimeter-guard.sh --check [--cloudflare-origin-only]
#   sudo bash proxmox-host-perimeter-guard.sh --apply [--cloudflare-origin-only]
#   bash proxmox-host-perimeter-guard.sh --rewrite-nft-only /path/to/nftables.conf
#   bash proxmox-host-perimeter-guard.sh --write-sshd-dropin-only /path/to/dropin.conf
#
# The *-only modes are pure file transforms for unit tests on macOS/CI; they
# do not require root or the systemctl/nft/sshd binaries.

set -euo pipefail

MODE="check"
NFT_CONF="${PERIMETER_GUARD_NFT_CONF:-/etc/nftables.conf}"
SSHD_DROPIN="${PERIMETER_GUARD_SSHD_DROPIN:-/etc/ssh/sshd_config.d/00-hermes-hardening.conf}"
SSHD_DROPIN_LEGACY="${PERIMETER_GUARD_SSHD_DROPIN_LEGACY:-/etc/ssh/sshd_config.d/99-hermes-hardening.conf}"
NFT_TARGET=""
SSHD_TARGET=""
CLOUDFLARE_ONLY="${PERIMETER_GUARD_CLOUDFLARE_ONLY:-0}"
CADDY_CONFIG_DIR="${PERIMETER_GUARD_CADDY_DIR:-/etc/caddy}"

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
  'iifname "vmbr1" ct state invalid drop'
  'iifname "vmbr1" ct state new drop'
  'iifname "tailscale0" tcp dport 8006 accept'
  'iifname "vmbr1" ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } drop'
)
NFT_CLOUDFLARE_LINES=(
  'ip saddr @cloudflare_ipv4 tcp dport { 80, 443 } accept'
  'ip6 saddr @cloudflare_ipv6 tcp dport { 80, 443 } accept'
  'ip saddr @cloudflare_ipv4 udp dport 443 accept'
  'ip6 saddr @cloudflare_ipv6 udp dport 443 accept'
)

usage() {
  cat <<'EOF'
Usage: proxmox-host-perimeter-guard.sh [--check|--apply] [--cloudflare-origin-only]
       proxmox-host-perimeter-guard.sh --rewrite-nft-only <path> [--cloudflare-origin-only]
       proxmox-host-perimeter-guard.sh --write-sshd-dropin-only <path>

--check                  Audit only. Exits non-zero if the sshd drop-in, the
                         effective sshd config, /etc/nftables.conf, or the live
                         nftables ruleset is missing a required perimeter rule.
--apply                  Install the sshd drop-in, reload sshd, then rewrite a
                         temp copy of /etc/nftables.conf, validate it, show
                         the diff, and apply it (restoring on failure).
--cloudflare-origin-only Also restrict 80/443 to Cloudflare's ranges. --apply
                         refuses unless every Caddy site resolves only to
                         Cloudflare (no sslip.io, raw IPs, catch-all :80/:443
                         blocks, env placeholders or unproxied names). This
                         is a point-in-time check: the dashboard can still
                         mint an sslip.io gateway later when the Cloudflare
                         DNS mint fails, and that tenant would be cut off.
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
    --cloudflare-origin-only) CLOUDFLARE_ONLY=1 ;;
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
  CLOUDFLARE_ONLY="$CLOUDFLARE_ONLY" python3 - "$target" <<'PY'
import os
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

CLOUDFLARE_ONLY = os.environ.get("CLOUDFLARE_ONLY") == "1"

# Earlier releases of this guard wrote a bare `iifname "vmbr1" drop`; it is
# recognised so a re-run upgrades it.
MANAGED_INPUT = {
    'iifname "vmbr1" udp dport 123 accept',
    'iifname "vmbr1" tcp dport { 22, 8006 } drop',
    'iifname "vmbr1" tcp dport { 22, 80, 443, 8006 } drop',
    'iifname "vmbr1" drop',
    'iifname "vmbr1" ct state invalid drop',
    'iifname "vmbr1" ct state new drop',
    'iifname "vmbr1" meta l4proto { icmp, ipv6-icmp } accept',
}

# The catch-all drops are limited to new/invalid connections so replies from
# guests to host-initiated connections (Caddy reverse proxy, host SSH into a
# guest) still reach the `ct state established,related accept` rule, wherever
# that rule sits in the chain.
VMBR1_INPUT_BLOCK = [
    'iifname "vmbr1" udp dport 123 accept',
    'iifname "vmbr1" meta l4proto { icmp, ipv6-icmp } accept',
    'iifname "vmbr1" tcp dport { 22, 80, 443, 8006 } drop',
    'iifname "vmbr1" ct state invalid drop',
    'iifname "vmbr1" ct state new drop',
]

HOST_SERVICE_PORTS = (22, 80, 443, 8006)


def opens_host_service_port(dport_expr):
    # True when a dport expression (single port, set, or range) covers any
    # host service port. Unparseable expressions count as covering one.
    for token in re.findall(r"[0-9]+(?:-[0-9]+)?|[A-Za-z_]+", dport_expr):
        if token.isalpha() or "_" in token:
            if token in ("accept", "jump", "goto", "comment", "counter"):
                break
            return True
        lo, _, hi = token.partition("-")
        lo, hi = int(lo), int(hi or lo)
        if any(lo <= port <= hi for port in HOST_SERVICE_PORTS):
            return True
    return False

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


def strip_comment(n):
    return re.sub(r'\s+comment\s+"[^"]*"$', "", n)


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


def is_fwd_wan_accept(n):
    return (
        n.startswith('iifname "vmbr1"')
        and "accept" in n
        and 'oifname "vmbr1"' not in n
        and 'oifname "lo"' not in n
    )


def is_hoistable_guest_allow(n):
    # An explicit guest allow (DHCP, DNS, a jump to a hivra_* service chain)
    # must stay ahead of the catch-all drop. A blanket accept, or one that
    # opens a host service port, is not hoisted: the drop is meant to shadow it.
    n = strip_comment(n)
    if not n.startswith('iifname "vmbr1"') or n in MANAGED_INPUT or "oifname" in n:
        return False
    if " jump " in n or " goto " in n:
        return True
    if not n.endswith(" accept") or "dport" not in n:
        return False
    return not opens_host_service_port(n.split("dport", 1)[1])


def is_chain_preamble(n):
    # Lines the guest block may follow: the chain's type/policy statement,
    # loopback accepts, blank lines and comments.
    return (
        not n
        or n.startswith(("type ", "policy"))
        or n in ('iif "lo" accept', 'iifname "lo" accept')
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
        if CLOUDFLARE_ONLY and re.fullmatch(r"tcp dport \{ 80, 443 \} accept", n):
            out.extend(RULE_INDENT + r for r in CLOUDFLARE_ACCEPTS)
            continue
        out.append(line)
    # The block goes right after the chain preamble, ahead of every other
    # accept or jump, so no host service rule can sit above it. Because the
    # drops only match new/invalid connections this is safe above the
    # established/related accept too.
    anchor = 0
    while anchor < len(out) and is_chain_preamble(norm(out[anchor])):
        anchor += 1
    hoisted = [line for line in out[anchor:] if is_hoistable_guest_allow(norm(line))]
    rest = [line for line in out[anchor:] if not is_hoistable_guest_allow(norm(line))]
    return out[:anchor] + hoisted + [RULE_INDENT + r for r in VMBR1_INPUT_BLOCK] + rest


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

if [ "$(id -u)" -ne 0 ]; then
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
  printf '%s\n' "$out" | grep -Exq "permitrootlogin (prohibit-password|without-password)" || return 1
  printf '%s\n' "$out" | grep -Fxq "maxauthtries 3" || return 1
  printf '%s\n' "$out" | grep -Fxq "x11forwarding no" || return 1
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SSHD_DROPIN_BACKUP=""
SSHD_LEGACY_BACKUP=""

# Backups sit next to the drop-ins without a .conf suffix, so sshd's
# `Include sshd_config.d/*.conf` never loads them.
write_sshd_dropin() {
  if [ -f "$SSHD_DROPIN" ]; then
    SSHD_DROPIN_BACKUP="$SSHD_DROPIN.bak-hermes-$STAMP"
    cp -p "$SSHD_DROPIN" "$SSHD_DROPIN_BACKUP"
  fi
  if [ -f "$SSHD_DROPIN_LEGACY" ]; then
    SSHD_LEGACY_BACKUP="$SSHD_DROPIN_LEGACY.bak-hermes-$STAMP"
    cp -p "$SSHD_DROPIN_LEGACY" "$SSHD_LEGACY_BACKUP"
  fi
  write_sshd_dropin_to "$SSHD_DROPIN"
  rm -f "$SSHD_DROPIN_LEGACY"
}

restore_sshd_dropin() {
  if [ -n "$SSHD_DROPIN_BACKUP" ]; then
    cp -p "$SSHD_DROPIN_BACKUP" "$SSHD_DROPIN"
  else
    rm -f "$SSHD_DROPIN"
  fi
  if [ -n "$SSHD_LEGACY_BACKUP" ]; then
    cp -p "$SSHD_LEGACY_BACKUP" "$SSHD_DROPIN_LEGACY"
  fi
}

reload_sshd() {
  systemctl reload ssh 2>/dev/null \
    || systemctl reload sshd 2>/dev/null \
    || systemctl restart ssh
}

nft_conf_has_open_wan_rules() {
  [ -f "$NFT_CONF" ] || return 1
  grep -Eq '^[[:space:]]*tcp dport 8006 accept([[:space:]]*#.*)?$' "$NFT_CONF" && return 0
  if [ "$CLOUDFLARE_ONLY" = "1" ]; then
    grep -Eq '^[[:space:]]*tcp dport \{ 80, 443 \} accept([[:space:]]*#.*)?$' "$NFT_CONF" && return 0
  fi
  grep -Fq 'iifname "vmbr1" tcp dport { 22, 8006 } drop' "$NFT_CONF" && return 0
  grep -Eq '^[[:space:]]*iifname "vmbr1" drop([[:space:]]*#.*)?$' "$NFT_CONF" && return 0
  return 1
}

nft_conf_is_hardened() {
  [ -f "$NFT_CONF" ] || return 1
  local rule cidr
  for rule in "${NFT_REQUIRED_LINES[@]}"; do
    grep -Fq "$rule" "$NFT_CONF" || return 1
  done
  if [ "$CLOUDFLARE_ONLY" = "1" ]; then
    for rule in "${NFT_CLOUDFLARE_LINES[@]}"; do
      grep -Fq "$rule" "$NFT_CONF" || return 1
    done
    for cidr in "${CF_IPV4_CIDRS[@]}" "${CF_IPV6_CIDRS[@]}"; do
      grep -Fq "$cidr" "$NFT_CONF" || return 1
    done
  fi
  ! nft_conf_has_open_wan_rules
}

nft_ruleset_has_open_wan_rules() {
  grep -Eq '^[[:space:]]*tcp dport 8006 accept([[:space:]]*#.*)?$' <<<"$1" && return 0
  if [ "$CLOUDFLARE_ONLY" = "1" ]; then
    grep -Eq '^[[:space:]]*tcp dport \{ 80, 443 \} accept([[:space:]]*#.*)?$' <<<"$1" && return 0
  fi
  return 1
}

# --cloudflare-origin-only drops every 80/443 packet that does not come from
# Cloudflare, so it is only safe when every site this host's Caddy serves is
# proxied. Refuse unless each site address resolves only to Cloudflare ranges.
caddy_sites_are_cloudflare_only() {
  python3 - "$CADDY_CONFIG_DIR" <<'PY'
import ipaddress
import re
import socket
import sys
from pathlib import Path

CF = [ipaddress.ip_network(c) for c in (
    "173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 "
    "141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 "
    "197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 "
    "104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 "
    "2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 "
    "2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32"
).split()]

root = Path(sys.argv[1]).resolve()
queue = [p for p in root.rglob("*") if p.is_file() and (p.name == "Caddyfile" or p.suffix == ".caddy" or p.parent.name in ("conf.d", "sites", "sites-enabled"))] if root.is_dir() else []
if not queue:
    sys.exit("no Caddy site config under %s; cannot prove every site is proxied" % root)


def addresses(text):
    return [a for a in re.split(r"[\s,]+", text.strip()) if a]


# At the top level a Caddyfile holds only the global options block, snippet
# definitions, imports and site address lists (which may span lines joined by
# commas) followed by their block. A file with no site block is a single site
# whose address is its first line. Imported files are parsed too.
hosts = set()
bad = []
seen = set()
while queue:
    f = queue.pop(0).resolve()
    if f in seen:
        continue
    seen.add(f)
    depth = 0
    pending = []
    snippets = set()
    first_line = None
    blocks = 0
    for raw in f.read_text(errors="replace").split("\n"):
        line = raw.split("#", 1)[0].strip()
        if line and first_line is None:
            first_line = line
        if depth == 0 and line:
            words = line.split()
            if words[0] == "import":
                target = words[1] if len(words) > 1 else ""
                if target in snippets or not target:
                    pass
                else:
                    pattern = Path(target) if target.startswith("/") else f.parent / target
                    if not str(pattern.resolve()).startswith(str(root) + "/"):
                        bad.append("import %s (outside %s; cannot verify)" % (target, root))
                    else:
                        queue.extend(q for q in Path("/").glob(str(pattern.resolve()).lstrip("/")) if q.is_file())
                pending = []
            elif line.startswith("("):
                snippets.add(line[1:].split(")", 1)[0])
                pending = []
            elif line == "{":
                if pending:
                    blocks += 1
                hosts.update(pending)
                pending = []
            elif line.endswith("{"):
                blocks += 1
                hosts.update(pending + addresses(line[:-1]))
                pending = []
            else:
                pending += addresses(line)
        depth += raw.count("{") - raw.count("}")
    if blocks == 0 and first_line and not first_line.startswith(("{", "(", "import")):
        hosts.update(addresses(first_line))

if not hosts:
    bad.append("no site addresses found in %s; cannot prove every site is proxied" % root)

for addr in sorted(hosts):
    host = re.sub(r"^[a-z]+://", "", addr).split("/", 1)[0]
    host = host.rsplit(":", 1)[0] if host.count(":") == 1 else host.strip("[]")
    if "{$" in addr or "{env." in addr:
        bad.append(addr + " (placeholder address; cannot verify)")
        continue
    if host == "":
        bad.append(addr + " (catch-all site serves direct-IP traffic)")
        continue
    if host == "localhost" or host.startswith(("127.", "unix")):
        continue
    if host.endswith((".sslip.io", ".nip.io")):
        bad.append(host + " (direct-IP hostname)")
        continue
    try:
        ipaddress.ip_address(host)
        bad.append(host + " (raw IP)")
        continue
    except ValueError:
        pass
    probe = "perimeter-guard-probe" + host[1:] if host.startswith("*.") else host
    try:
        addrs = {ai[4][0] for ai in socket.getaddrinfo(probe, 443, proto=socket.IPPROTO_TCP)}
    except OSError as exc:
        bad.append("%s (does not resolve: %s)" % (host, exc))
        continue
    direct = [a for a in addrs if not any(ipaddress.ip_address(a) in n for n in CF)]
    if direct:
        bad.append("%s (resolves outside Cloudflare: %s)" % (host, ", ".join(sorted(direct))))

if bad:
    print("Caddy sites not behind Cloudflare:", file=sys.stderr)
    for b in bad:
        print("  - " + b, file=sys.stderr)
    sys.exit(1)
print("%d Caddy site address(es) resolve only to Cloudflare" % len(hosts))
PY
}

nft_runtime_is_hardened() {
  command -v nft >/dev/null 2>&1 || return 1
  local input forward ruleset
  input="$(nft list chain inet filter input 2>/dev/null)" || return 1
  forward="$(nft list chain inet filter forward 2>/dev/null)" || return 1
  ruleset="$(nft list ruleset 2>/dev/null)" || return 1
  printf '%s\n' "$input" | grep -Fq 'iifname "vmbr1" udp dport 123 accept' || return 1
  printf '%s\n' "$input" | grep -Fq 'iifname "vmbr1" tcp dport { 22, 80, 443, 8006 } drop' || return 1
  printf '%s\n' "$input" | grep -Fq 'iifname "vmbr1" ct state invalid drop' || return 1
  printf '%s\n' "$input" | grep -Fq 'iifname "vmbr1" ct state new drop' || return 1
  printf '%s\n' "$input" | grep -Fq 'iifname "tailscale0" tcp dport 8006 accept' || return 1
  if [ "$CLOUDFLARE_ONLY" = "1" ]; then
    printf '%s\n' "$input" | grep -Fq 'ip saddr @cloudflare_ipv4 tcp dport { 80, 443 } accept' || return 1
    printf '%s\n' "$input" | grep -Fq 'ip6 saddr @cloudflare_ipv6 tcp dport { 80, 443 } accept' || return 1
  fi
  printf '%s\n' "$forward" | grep -Fq 'iifname "vmbr1" ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } drop' || return 1
  grep -Fq 'set cloudflare_ipv4' <<<"$ruleset" || return 1
  grep -Fq 'set cloudflare_ipv6' <<<"$ruleset" || return 1
  ! nft_ruleset_has_open_wan_rules "$input"
}

if [ "$MODE" = "apply" ]; then
  for cmd in sshd systemctl nft install; do
    require_command "$cmd"
  done

  [ -f "$NFT_CONF" ] || fatal "$NFT_CONF is missing"
  if [ "$CLOUDFLARE_ONLY" = "1" ]; then
    caddy_sites_are_cloudflare_only \
      || fatal "--cloudflare-origin-only refused: a Caddy site reaches this host directly"
  fi

  # Rewrite and validate a temp copy first; the live file is only replaced
  # once nft accepts the new ruleset.
  NFT_CANDIDATE="$(mktemp "${NFT_CONF}.perimeter-candidate.XXXXXX")"
  trap 'rm -f "$NFT_CANDIDATE"' EXIT
  cp -p "$NFT_CONF" "$NFT_CANDIDATE"
  rewrite_nft_conf_file "$NFT_CANDIDATE"
  nft -c -f "$NFT_CANDIDATE" || fatal "nft -c rejected the rewritten ruleset; $NFT_CONF left unchanged"
  log "nftables change to be applied:"
  diff -u "$NFT_CONF" "$NFT_CANDIDATE" || true

  log "applying sshd hardening drop-in"
  write_sshd_dropin
  if ! sshd -t; then
    restore_sshd_dropin
    fatal "sshd -t rejected $SSHD_DROPIN; previous sshd drop-ins restored, sshd not reloaded"
  fi
  reload_sshd

  log "applying perimeter nftables guard"
  NFT_BACKUP="$NFT_CONF.bak-hermes-perimeter-$STAMP"
  cp -p "$NFT_CONF" "$NFT_BACKUP"
  mv -f "$NFT_CANDIDATE" "$NFT_CONF"
  if ! nft -f "$NFT_CONF" || ! nft_runtime_is_hardened; then
    cp -p "$NFT_BACKUP" "$NFT_CONF"
    nft -f "$NFT_CONF" || log "WARNING: restoring the previous ruleset also failed; check nftables now"
    fatal "applied ruleset failed or lacked required rules; restored $NFT_CONF from $NFT_BACKUP"
  fi
else
  require_command sshd
  require_command nft
  sshd_dropin_is_correct || fatal "$SSHD_DROPIN missing required hardening directives"
  effective_sshd_hardened || fatal "effective sshd config (sshd -T) is not hardened"
  nft_conf_is_hardened || fatal "$NFT_CONF is missing required perimeter rules or still has open WAN accepts"
  nft_runtime_is_hardened || fatal "live nftables ruleset is missing required perimeter rules"
fi

log "sshd: hardening drop-in applied and effective"
if [ "$CLOUDFLARE_ONLY" = "1" ]; then
  log "nftables: vmbr1 guest-to-host drops, tailscale-only 8006, Cloudflare-only 80/443, RFC1918 forward drop present"
else
  log "nftables: vmbr1 guest-to-host drops, tailscale-only 8006, RFC1918 forward drop present (80/443 left open to all origins)"
fi
log "done"
