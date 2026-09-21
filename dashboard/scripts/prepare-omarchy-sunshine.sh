#!/usr/bin/env bash

# Prepare the pinned Omarchy v4.0.2 desktop for Hivra's native
# Sunshine/Moonlight lane. Run this as the enrolled desktop owner, after the
# graphical session exists. Firewall access is deny-by-default: callers must
# name every approved client or relay CIDR explicitly.

set -euo pipefail

readonly EXPECTED_OMARCHY_VERSION="4.0.2-1"
readonly EXPECTED_SUNSHINE_VERSION="2026.516.143833-4"
readonly SUNSHINE_UNIT="app-dev.lizardbyte.app.Sunshine.service"
readonly UNIT_DIRECTORY="${HIVRA_SYSTEMD_USER_UNIT_DIR:-/usr/lib/systemd/user}"

allowed_cidrs=()
added_firewall_rules=()
preparation_complete=0
sunshine_was_active=0
sunshine_was_enabled=0

usage() {
  cat <<'EOF'
Usage: prepare-omarchy-sunshine.sh [--allow-cidr <IPv4 CIDR>]...

Installs and verifies the Sunshine build tested with Omarchy v4.0.2. No
network ingress is opened unless one or more explicit --allow-cidr values are
provided. Use a client /32 or a Hivra-owned private relay CIDR; never pass a
public catch-all.
EOF
}

valid_ipv4_cidr() {
  local value="$1" address prefix octet
  [[ "$value" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]] || return 1
  address="${value%/*}"
  prefix="${value#*/}"
  [[ -n "$prefix" ]] || return 1
  IFS=. read -r -a octets <<<"$address"
  for octet in "${octets[@]}"; do
    ((10#$octet <= 255)) || return 1
  done
}

safe_stream_source_cidr() {
  local value="$1" address prefix first second third fourth ip mask network
  address="${value%/*}"
  prefix="${value#*/}"
  IFS=. read -r first second third fourth <<<"$address"
  ip=$(( (10#$first << 24) | (10#$second << 16) | (10#$third << 8) | 10#$fourth ))
  if ((prefix == 0)); then
    mask=0
  else
    mask=$(( (0xffffffff << (32 - prefix)) & 0xffffffff ))
  fi
  network=$((ip & mask))
  ((network == ip)) || return 1
  ((prefix == 32)) && return 0
  ((first == 10 && prefix >= 8)) && return 0
  ((first == 172 && second >= 16 && second <= 31 && prefix >= 12)) && return 0
  ((first == 192 && second == 168 && prefix >= 16)) && return 0
  return 1
}

cidr_already_allowed() {
  local candidate="$1" existing
  for existing in "${allowed_cidrs[@]-}"; do
    [[ -n "$existing" ]] || continue
    [[ "$existing" == "$candidate" ]] && return 0
  done
  return 1
}

while (($#)); do
  case "$1" in
    --allow-cidr)
      (($# >= 2)) || { echo "--allow-cidr requires a value" >&2; exit 2; }
      valid_ipv4_cidr "$2" || { echo "Invalid IPv4 CIDR: $2" >&2; exit 2; }
      safe_stream_source_cidr "$2" || {
        echo "Sunshine access must use a client /32 or an RFC1918 private relay subnet: $2" >&2
        exit 2
      }
      cidr_already_allowed "$2" || allowed_cidrs+=("$2")
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ "$(id -u)" -ne 0 ]] || { echo "Run as the enrolled Omarchy desktop owner, not root" >&2; exit 3; }

omarchy_version="$(pacman -Q omarchy | awk '{print $2}')"
[[ "$omarchy_version" == "$EXPECTED_OMARCHY_VERSION" ]] || {
  echo "Unsupported Omarchy package: ${omarchy_version:-missing}; expected $EXPECTED_OMARCHY_VERSION" >&2
  exit 4
}

if ! pacman -Q sunshine >/dev/null 2>&1; then
  sync_directory="${HIVRA_PACMAN_SYNC_DIRECTORY:-/var/lib/pacman/sync}"
  if [[ ! -s "$sync_directory/core.db" || ! -s "$sync_directory/extra.db" ]]; then
    sudo pacman -Sy --noconfirm
  fi
  sudo pacman -S --needed --noconfirm sunshine
fi

sunshine_version="$(pacman -Q sunshine | awk '{print $2}')"
[[ "$sunshine_version" == "$EXPECTED_SUNSHINE_VERSION" ]] || {
  echo "Unsupported Sunshine package: ${sunshine_version:-missing}; expected $EXPECTED_SUNSHINE_VERSION" >&2
  exit 5
}
[[ -f "$UNIT_DIRECTORY/$SUNSHINE_UNIT" ]] || {
  echo "Pinned Sunshine user unit is missing: $SUNSHINE_UNIT" >&2
  exit 5
}

tcp_ports=(47984 47989 48010)
udp_ports=(5353 47998 47999 48000 48002 48010)
command -v ufw >/dev/null 2>&1 || { echo "UFW is required before Sunshine can listen" >&2; exit 6; }

firewall_status="$(sudo ufw status verbose)"
printf '%s\n' "$firewall_status" | grep -Fxq "Status: active" || {
  echo "UFW must be active before Sunshine can start" >&2
  exit 6
}
printf '%s\n' "$firewall_status" | grep -Eq '^Default: deny \(incoming\)(,|$)' || {
  echo "UFW must deny incoming traffic by default before Sunshine can start" >&2
  exit 6
}

firewall_rule_present() {
  local rules="$1" cidr="$2" port="$3" protocol="$4" normalized="$2"
  [[ "${cidr#*/}" != "32" ]] || normalized="${cidr%/*}"
  printf '%s\n' "$rules" | awk -v token="${port}/${protocol}" -v cidr="$cidr" -v normalized="$normalized" '
    index($0, token) && index($0, "ALLOW IN") &&
      (index(" " $0 " ", " " cidr " ") || index(" " $0 " ", " " normalized " ")) &&
      index($0, "hivra-sunshine") { found=1 }
    END { exit(found ? 0 : 1) }
  '
}

sunshine_destination_overlaps() {
  local destination="$1" kind="${2:-stream}" specification protocol part start end protected
  destination="${destination% (v6)}"
  # Numbered UFW output prefixes a port with the bound destination address
  # when a rule targets one interface address (for example
  # `10.240.0.1 53/udp`). The address narrows the rule; it does not make the
  # following, parseable port specification ambiguous.
  if [[ "$destination" =~ ^[0-9A-Fa-f:.]+[[:space:]]+(.+)$ ]]; then
    destination="${BASH_REMATCH[1]}"
  fi
  if [[ ! "$destination" =~ ^([0-9]+([,:-][0-9]+)*)(/(tcp|udp))?$ ]]; then
    # An application profile or catch-all destination cannot be proven not to
    # expose a Sunshine port from `ufw status`; fail closed below.
    return 0
  fi
  specification="${BASH_REMATCH[1]}"
  protocol="${BASH_REMATCH[4]:-both}"
  IFS=, read -r -a parts <<<"$specification"
  for part in "${parts[@]}"; do
    if [[ "$part" =~ ^([0-9]+)[:\-]([0-9]+)$ ]]; then
      start="${BASH_REMATCH[1]}"
      end="${BASH_REMATCH[2]}"
    elif [[ "$part" =~ ^[0-9]+$ ]]; then
      start="$part"
      end="$part"
    else
      return 0
    fi
    ((start <= end && end <= 65535)) || return 0
    if [[ "$protocol" != "udp" ]]; then
      if [[ "$kind" == "admin" ]]; then
        ((47990 >= start && 47990 <= end)) && return 0
      else
        for protected in "${tcp_ports[@]}"; do
          ((protected >= start && protected <= end)) && return 0
        done
      fi
    fi
    if [[ "$kind" != "admin" && "$protocol" != "tcp" ]]; then
      for protected in "${udp_ports[@]}"; do
        ((protected >= start && protected <= end)) && return 0
      done
    fi
  done
  return 1
}

# Streaming admission never authorizes the administrator bootstrap endpoint.
# Check it before adding rules and again before startup. This also rejects
# opaque application profiles whose covered ports cannot be established here.
verify_admin_firewall() {
  local rules="$1" line payload destination action
  while IFS= read -r line; do
    # UFW LIMIT admits initial connections too; it is not an admin-port deny.
    if [[ "$line" == *"ALLOW IN"* ]]; then action="ALLOW IN"
    elif [[ "$line" == *"LIMIT IN"* ]]; then action="LIMIT IN"
    else continue
    fi
    payload="$line"
    if [[ "$payload" =~ ^\[[^]]+\][[:space:]]*(.*)$ ]]; then
      payload="${BASH_REMATCH[1]}"
    fi
    destination="${payload%%"$action"*}"
    destination="${destination#"${destination%%[![:space:]]*}"}"
    destination="${destination%"${destination##*[![:space:]]}"}"
    if sunshine_destination_overlaps "$destination" admin; then
      echo "Unscoped or ambiguous inbound firewall rule overlaps Sunshine administration; port 47990 must stay blocked: $line" >&2
      return 1
    fi
  done <<<"$rules"
}

firewall_source_approved() {
  local source="$1" cidr normalized
  source="${source% (v6)}"
  for cidr in "${allowed_cidrs[@]-}"; do
    [[ -n "$cidr" ]] || continue
    normalized="$cidr"
    [[ "${cidr#*/}" != "32" ]] || normalized="${cidr%/*}"
    [[ "$source" == "$cidr" || "$source" == "$normalized" ]] && return 0
  done
  return 1
}

rollback_partial_preparation() {
  local status=$? index spec cidr protocol port
  if [[ "$preparation_complete" != "1" && "$status" -ne 0 ]]; then
    if [[ "$sunshine_was_active" != "1" ]]; then
      systemctl --user stop "$SUNSHINE_UNIT" >/dev/null 2>&1 || true
    fi
    if [[ "$sunshine_was_enabled" != "1" ]]; then
      systemctl --user disable "$SUNSHINE_UNIT" >/dev/null 2>&1 || true
    fi
    if ((${#added_firewall_rules[@]})); then
      for ((index=${#added_firewall_rules[@]}-1; index>=0; index--)); do
        spec="${added_firewall_rules[$index]}"
        IFS='|' read -r cidr protocol port <<<"$spec"
        sudo ufw --force delete allow in proto "$protocol" from "$cidr" to any port "$port" comment hivra-sunshine >/dev/null 2>&1 || true
      done
      sudo ufw reload >/dev/null 2>&1 || true
    fi
  fi
  trap - EXIT
  exit "$status"
}
trap rollback_partial_preparation EXIT

[[ "$(systemctl --user is-active "$SUNSHINE_UNIT" 2>/dev/null || true)" == "active" ]] && sunshine_was_active=1
[[ "$(systemctl --user is-enabled "$SUNSHINE_UNIT" 2>/dev/null || true)" == "enabled" ]] && sunshine_was_enabled=1

firewall_rules_before="$(sudo ufw status numbered)"
verify_admin_firewall "$firewall_rules_before" || exit 6
for cidr in "${allowed_cidrs[@]-}"; do
  [[ -n "$cidr" ]] || continue
  for port in "${tcp_ports[@]}"; do
    if ! firewall_rule_present "$firewall_rules_before" "$cidr" "$port" tcp; then
      sudo ufw allow in proto tcp from "$cidr" to any port "$port" comment hivra-sunshine >/dev/null
      added_firewall_rules+=("$cidr|tcp|$port")
    fi
  done
  for port in "${udp_ports[@]}"; do
    if ! firewall_rule_present "$firewall_rules_before" "$cidr" "$port" udp; then
      sudo ufw allow in proto udp from "$cidr" to any port "$port" comment hivra-sunshine >/dev/null
      added_firewall_rules+=("$cidr|udp|$port")
    fi
  done
done
((${#added_firewall_rules[@]} == 0)) || sudo ufw reload >/dev/null

firewall_status="$(sudo ufw status verbose)"
printf '%s\n' "$firewall_status" | grep -Fxq "Status: active"
printf '%s\n' "$firewall_status" | grep -Eq '^Default: deny \(incoming\)(,|$)'
firewall_rules_after="$(sudo ufw status numbered)"
verify_admin_firewall "$firewall_rules_after" || exit 6
verify_firewall_rules() {
  local rules="$1" token line cidr normalized approved matches count payload destination source
  shift
  while IFS= read -r line; do
    [[ "$line" == *"ALLOW IN"* ]] || continue
    payload="$line"
    if [[ "$payload" =~ ^\[[^]]+\][[:space:]]*(.*)$ ]]; then
      payload="${BASH_REMATCH[1]}"
    fi
    destination="${payload%%ALLOW IN*}"
    destination="${destination#"${destination%%[![:space:]]*}"}"
    destination="${destination%"${destination##*[![:space:]]}"}"
    sunshine_destination_overlaps "$destination" || continue
    source="${payload#*ALLOW IN}"
    source="${source#"${source%%[![:space:]]*}"}"
    source="${source%%[[:space:]]*}"
    firewall_source_approved "$source" || {
      echo "Unscoped or ambiguous inbound firewall rule overlaps Sunshine: $line" >&2
      return 1
    }
  done <<<"$rules"
  for token in "$@"; do
    matches="$(printf '%s\n' "$rules" | awk -v token="$token" 'index($0, token) && index($0, "ALLOW IN")')"
    if [[ -n "$matches" ]]; then
      while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        approved=0
        for cidr in "${allowed_cidrs[@]-}"; do
          [[ -n "$cidr" ]] || continue
          normalized="$cidr"
          [[ "${cidr#*/}" != "32" ]] || normalized="${cidr%/*}"
          if [[ (" $line " == *" $cidr "* || " $line " == *" $normalized "*) &&
            "$line" == *"hivra-sunshine"* ]]; then
            ((approved += 1))
          fi
        done
        [[ "$approved" -eq 1 ]] || return 1
      done <<<"$matches"
    fi
    for cidr in "${allowed_cidrs[@]-}"; do
      [[ -n "$cidr" ]] || continue
      normalized="$cidr"
      [[ "${cidr#*/}" != "32" ]] || normalized="${cidr%/*}"
      count="$(printf '%s\n' "$matches" | awk -v cidr="$cidr" -v normalized="$normalized" -v marker="hivra-sunshine" '
        (index(" " $0 " ", " " cidr " ") || index(" " $0 " ", " " normalized " ")) &&
          index($0, marker) { count += 1 }
        END { print count + 0 }
      ')"
      [[ "$count" -eq 1 ]] || return 1
    done
  done
  return 0
}
verify_firewall_rules "$firewall_rules_after" \
  "${tcp_ports[0]}/tcp" "${tcp_ports[1]}/tcp" "${tcp_ports[2]}/tcp" \
  "${udp_ports[0]}/udp" "${udp_ports[1]}/udp" "${udp_ports[2]}/udp" \
  "${udp_ports[3]}/udp" "${udp_ports[4]}/udp" "${udp_ports[5]}/udp" || {
    echo "Sunshine firewall verification failed" >&2
    exit 6
  }

# Omarchy v4.0.2 calls `systemctl --user enable --now sunshine`, but current
# Arch packaging exposes the canonical unit above and refuses the generated
# alias on subsequent runs. Start only after the network fence is proven.
systemctl --user enable --now "$SUNSHINE_UNIT"
[[ "$(systemctl --user is-enabled "$SUNSHINE_UNIT")" == "enabled" ]]
[[ "$(systemctl --user is-active "$SUNSHINE_UNIT")" == "active" ]]

encoder=""
for _ in {1..15}; do
  encoder="$(journalctl --user -u "$SUNSHINE_UNIT" -b --no-pager 2>/dev/null | sed -n 's/.*Found H\.264 encoder: //p' | tail -1)"
  [[ -n "$encoder" ]] && break
  sleep 1
done
[[ -n "$encoder" ]] || { echo "Sunshine started without an observed H.264 encoder" >&2; exit 7; }

http_status="$(curl -kfsS -o /dev/null -w '%{http_code}' https://127.0.0.1:47990/)"
[[ "$http_status" == "200" || "$http_status" == "307" ]] || {
  echo "Sunshine administration endpoint is not ready: HTTP $http_status" >&2
  exit 7
}

preparation_complete=1
printf 'HIVRA_OMARCHY_SUNSHINE_READY {"omarchy":"%s","sunshine":"%s","unit":"%s","encoder":"%s","firewallCidrs":%s}\n' \
  "$omarchy_version" "$sunshine_version" "$SUNSHINE_UNIT" "$encoder" "${#allowed_cidrs[@]}"
