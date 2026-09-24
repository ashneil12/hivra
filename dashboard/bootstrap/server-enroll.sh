# Hivra server setup script: the body.
#
# Design and threat model:
#   docs/superpowers/specs/2026-09-24-server-enrollment-command.md
#
# This file defines functions and nothing else, so running it on its own does
# nothing. Every download from Hivra is this file plus exactly one final line:
# a single brace group that calls hivra_enroll_entry, hivra_uninstall_entry or
# hivra_refuse. bash runs a brace group only after it has read the closing
# brace, so a download cut short at any byte runs nothing at all.
#
# Its version and sha256 are pinned in
# dashboard/src/lib/infrastructure/server-enrollment-script.ts. Hivra refuses
# to serve this file if it hashes differently. Change the file, the version
# and the sha256 together.
#
# Internal function names start with hse_, so none of them is a prefix of an
# entry function name.

hse_init() {
  # The fixed environment for every run. The offline tests replace only this
  # function, to point the script at a test directory and stub commands.
  PATH=/usr/sbin:/usr/bin:/sbin:/bin
  LC_ALL=C
  export PATH LC_ALL
  hse_root=
  hse_root_uid=0
  hse_euid=$EUID
  hse_tty=/dev/tty
  hse_home=/home/hivra
}

hse_version() {
  printf '%s' '2026.09.24.1'
}

hse_say() {
  printf '%s\n' "$*" >&2
}

# The plan and questions go to the terminal when there is one, so they are
# seen even when output is redirected, and to stderr otherwise.
hse_show() {
  if [ "${hse_has_tty:-0}" = 1 ]; then
    printf '%s\n' "$*" >&3
  else
    printf '%s\n' "$*" >&2
  fi
}

hse_incomplete() {
  hse_say "This setup script arrived incomplete or was run with options it doesn't know. Nothing was changed. Copy the command from Hivra again."
  exit 2
}

hse_matches() {
  [[ $1 =~ $2 ]]
}

# Split $1 on spaces into hse_words, with globbing off, so a "*" in a value
# from the server's configuration can never expand to file names.
hse_split() {
  local saved_ifs=$IFS
  set -f
  IFS=' '
  hse_words=($1)
  IFS=$saved_ifs
  set +f
}

hse_valid_origin() {
  [ "${#1}" -le 261 ] && hse_matches "$1" '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
}

hse_valid_code() {
  hse_matches "$1" '^hse1_[a-z2-7]{32}$'
}

hse_valid_key() {
  hse_matches "$1" '^ssh-ed25519 [A-Za-z0-9+/]{68}$'
}

hse_valid_account() {
  hse_matches "$1" '^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'
}

# The exact argument contract: zero, one or two caller flags (--dry-run,
# --yes, neither repeated), then HIVRA_ARGS_V1, four values that each match
# their pattern, and HIVRA_END_V1 last. Anything else is refused before a
# single fact is read.
hse_parse_enroll_args() {
  local total=$# flags=0
  hse_dry_run=0
  hse_yes=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run)
        [ "$hse_dry_run" = 0 ] || return 1
        hse_dry_run=1
        ;;
      --yes)
        [ "$hse_yes" = 0 ] || return 1
        hse_yes=1
        ;;
      *) break ;;
    esac
    flags=$((flags + 1))
    shift
  done
  [ "$total" -eq $((flags + 6)) ] || return 1
  [ "$#" -eq 6 ] || return 1
  [ "$1" = HIVRA_ARGS_V1 ] || return 1
  [ "$6" = HIVRA_END_V1 ] || return 1
  hse_valid_origin "$2" || return 1
  hse_valid_code "$3" || return 1
  hse_valid_key "$4" || return 1
  hse_valid_account "$5" || return 1
  hse_origin=$2
  hse_code=$3
  hse_admin_key=$4
  hse_account=$5
}

hse_parse_uninstall_args() {
  hse_dry_run=0
  hse_yes=0
  case "$#" in
    1) [ "$1" = HIVRA_END_V1 ] || return 1 ;;
    2)
      [ "$2" = HIVRA_END_V1 ] || return 1
      case "$1" in
        --dry-run) hse_dry_run=1 ;;
        --yes) hse_yes=1 ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

hse_open_terminal() {
  hse_has_tty=0
  # A terminal is asked whatever flags were passed. --yes stands in for the
  # answer only when there is no terminal to ask.
  if ( exec 3<>"$hse_tty" ) 2>/dev/null; then
    exec 3<>"$hse_tty"
    hse_has_tty=1
  fi
}

# Ask on the terminal. Default is No. Without a terminal, --yes answers.
hse_ask() {
  local answer=
  if [ "$hse_has_tty" = 1 ]; then
    printf '%s ' "$1" >&3
    IFS= read -r answer <&3 || answer=
    case "$answer" in
      y|Y|yes|YES|Yes) return 0 ;;
      *) return 1 ;;
    esac
  fi
  [ "$hse_yes" = 1 ]
}

hse_tempdir() {
  hse_tmp=$(mktemp -d "${TMPDIR:-/tmp}/hivra-enroll.XXXXXX") || {
    hse_say "This server couldn't make a temporary folder. Nothing was changed."
    exit 1
  }
}

hse_on_exit() {
  local status=$?
  set +e
  if [ "${hse_rollback_armed:-0}" = 1 ]; then
    hse_rollback
  fi
  if [ -n "${hse_tmp:-}" ] && [ -d "$hse_tmp" ]; then
    rm -rf -- "$hse_tmp"
  fi
  exit "$status"
}

hse_os_release_value() {
  local file="$hse_root/etc/os-release" line value
  [ -r "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$1="*)
        value=${line#*=}
        value=${value#\"}
        value=${value%\"}
        value=${value#\'}
        value=${value%\'}
        printf '%s' "$value"
        return 0
        ;;
    esac
  done < "$file"
}

# Read-only facts. Every value must match a strict pattern or it is dropped
# (sent as null). Nothing else is read: no interface or MAC addresses, no
# machine id, no user lists.
hse_read_facts() {
  local value kb
  hse_os_id=
  hse_os_version=
  hse_arch=
  hse_cpus=
  hse_memory=
  hse_hostname=
  hse_virt=
  hse_pve=
  hse_pve_found=0
  value=$(hse_os_release_value ID)
  hse_matches "$value" '^[a-z0-9._-]{1,64}$' && hse_os_id=$value
  value=$(hse_os_release_value VERSION_ID)
  hse_matches "$value" '^[0-9][0-9.]{0,15}$' && hse_os_version=$value
  value=$(uname -m 2>/dev/null || true)
  hse_matches "$value" '^[a-z0-9_]{1,32}$' && hse_arch=$value
  value=$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)
  hse_matches "$value" '^[0-9]{1,15}$' && hse_cpus=$value
  kb=$(awk '$1 == "MemTotal:" { print $2; exit }' "$hse_root/proc/meminfo" 2>/dev/null || true)
  if hse_matches "$kb" '^[0-9]{1,12}$'; then hse_memory=$((kb * 1024)); fi
  value=$(hostname 2>/dev/null || true)
  hse_matches "$value" '^[A-Za-z0-9.-]{1,253}$' && hse_hostname=$value
  value=$(systemd-detect-virt 2>/dev/null || true)
  hse_matches "$value" '^[a-z0-9_-]{1,32}$' && hse_virt=$value
  if command -v pveversion >/dev/null 2>&1 || [ -d "$hse_root/etc/pve" ]; then
    hse_pve_found=1
    value=$(pveversion 2>/dev/null || true)
    if [[ $value =~ ^pve-manager/([0-9][0-9.]{0,15})[/-] ]]; then hse_pve=${BASH_REMATCH[1]}; fi
  fi
  return 0
}

# Rules for particular addresses in sshd's own configuration. Hivra connects
# from changing internet addresses, so no single address evaluates them.
hse_read_match_rules() {
  local file
  hse_match_rules=false
  for file in "$hse_root/etc/ssh/sshd_config" "$hse_root"/etc/ssh/sshd_config.d/*.conf; do
    [ -f "$file" ] || continue
    if grep -Eiq '^[[:space:]]*Match[[:space:]].*(Address|Host|LocalAddress)' "$file" 2>/dev/null; then
      hse_match_rules=true
    fi
  done
  return 0
}

# The effective sshd settings for user hivra, from sshd itself. The address is
# a documentation address, not loopback, which often has its own rules.
hse_read_sshd() {
  local output line key rest
  hse_ssh_port=
  hse_pubkey=
  hse_authkeys=
  hse_allow_users=
  hse_allow_groups=
  hse_deny_users=
  hse_deny_groups=
  hse_hostkeys=
  output=$(sshd -T -C user=hivra,host=hivra-check,addr=192.0.2.1 2>/dev/null) || return 1
  while IFS= read -r line; do
    key=${line%% *}
    rest=${line#* }
    [ "$key" != "$line" ] || rest=
    case "$key" in
      port)
        if [ -z "$hse_ssh_port" ] && hse_matches "$rest" '^[0-9]{1,5}$' && [ "$rest" -ge 1 ] && [ "$rest" -le 65535 ]; then
          hse_ssh_port=$rest
        fi
        ;;
      pubkeyauthentication) hse_pubkey=$rest ;;
      authorizedkeysfile) hse_authkeys=$rest ;;
      allowusers) hse_allow_users="$hse_allow_users $rest" ;;
      allowgroups) hse_allow_groups="$hse_allow_groups $rest" ;;
      denyusers) hse_deny_users="$hse_deny_users $rest" ;;
      denygroups) hse_deny_groups="$hse_deny_groups $rest" ;;
      hostkey)
        if hse_matches "$rest" '^/[A-Za-z0-9._/-]{1,255}$'; then hse_hostkeys="$hse_hostkeys $rest"; fi
        ;;
    esac
  done <<EOF
$output
EOF
  return 0
}

# True when a user or group list from sshd lets "hivra" through. An entry
# restricted to particular addresses (user@host) doesn't count, because
# Hivra's address changes.
hse_list_allows_hivra() {
  local entry name host
  hse_split "$1"
  for entry in ${hse_words[@]+"${hse_words[@]}"}; do
    hse_matches "$entry" '^[A-Za-z0-9_.*?%:/@-]{1,128}$' || continue
    name=${entry%%@*}
    host=
    [ "$name" = "$entry" ] || host=${entry#*@}
    if [ -n "$host" ] && [ "$host" != '*' ]; then continue; fi
    # shellcheck disable=SC2053
    if [[ hivra == $name ]]; then return 0; fi
  done
  return 1
}

hse_list_denies_hivra() {
  local entry name
  hse_split "$1"
  for entry in ${hse_words[@]+"${hse_words[@]}"}; do
    name=${entry%%@*}
    # shellcheck disable=SC2053
    if [[ hivra == $name ]]; then return 0; fi
  done
  return 1
}

hse_authorized_keys_supported() {
  local token path wanted="$hse_home/.ssh/authorized_keys"
  hse_split "$hse_authkeys"
  for token in ${hse_words[@]+"${hse_words[@]}"}; do
    path=${token//\%h/$hse_home}
    path=${path//\%u/hivra}
    path=${path//\%\%/%}
    case "$path" in
      /*) ;;
      *) path="$hse_home/$path" ;;
    esac
    [ "$path" = "$wanted" ] && return 0
  done
  return 1
}

hse_sshd_lets_hivra_in() {
  hse_sshd_problem=
  if [ "$hse_pubkey" != yes ]; then
    hse_sshd_problem="This server's SSH settings turn off sign-in with a key (PubkeyAuthentication). Turn it on, then run the command again."
    return 1
  fi
  if ! hse_authorized_keys_supported; then
    hse_sshd_problem="This server's SSH settings read keys from a place Hivra doesn't set up (AuthorizedKeysFile). Include .ssh/authorized_keys, then run the command again."
    return 1
  fi
  if [ -n "${hse_allow_users// /}" ] && ! hse_list_allows_hivra "$hse_allow_users"; then
    hse_sshd_problem="This server's SSH settings (AllowUsers) don't let hivra sign in. Add hivra, then run the command again."
    return 1
  fi
  if [ -n "${hse_deny_users// /}" ] && hse_list_denies_hivra "$hse_deny_users"; then
    hse_sshd_problem="This server's SSH settings (DenyUsers) stop hivra from signing in. Remove that rule for hivra, then run the command again."
    return 1
  fi
  if [ -n "${hse_allow_groups// /}" ] && ! hse_list_allows_hivra "$hse_allow_groups"; then
    hse_sshd_problem="This server's SSH settings (AllowGroups) don't let hivra sign in. Add the hivra group, then run the command again."
    return 1
  fi
  if [ -n "${hse_deny_groups// /}" ] && hse_list_denies_hivra "$hse_deny_groups"; then
    hse_sshd_problem="This server's SSH settings (DenyGroups) stop hivra from signing in. Remove that rule for hivra, then run the command again."
    return 1
  fi
  return 0
}

# The host key sshd actually presents: derived from the Ed25519 private key
# it is configured with, not from a .pub file beside it.
hse_read_host_key() {
  local path output
  hse_host_key=
  hse_split "$hse_hostkeys"
  for path in ${hse_words[@]+"${hse_words[@]}"}; do
    output=$(ssh-keygen -y -f "$hse_root$path" 2>/dev/null || true)
    output=${output%%$'\n'*}
    if [[ $output =~ ^(ssh-ed25519\ [A-Za-z0-9+/]{68})(\ .*)?$ ]]; then
      hse_host_key=${BASH_REMATCH[1]}
      return 0
    fi
  done
  return 1
}

hse_fingerprint() {
  local output
  printf '%s hivra-fingerprint\n' "$1" > "$hse_tmp/key.pub"
  output=$(ssh-keygen -l -E sha256 -f "$hse_tmp/key.pub" 2>/dev/null || true)
  if [[ $output =~ ^256\ (SHA256:[A-Za-z0-9+/]{43})\  ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

# Ubuntu 22.04 or 24.04 on x86_64. Proxmox VE is handled on its own (see
# hse_proxmox_line): Proxmox launches need a root login until Hivra proves
# them through sudo, so this script version doesn't connect it.
hse_supported() {
  [ "$hse_arch" = x86_64 ] || return 1
  [ "$hse_pve_found" = 0 ] || return 1
  [ "$hse_os_id" = ubuntu ] || return 1
  case "$hse_os_version" in
    22.04|24.04) return 0 ;;
  esac
  return 1
}

hse_found_line() {
  local os arch
  if [ -n "$hse_pve" ]; then
    os="Proxmox VE $hse_pve"
  elif [ -n "$hse_os_id" ]; then
    os="$hse_os_id${hse_os_version:+ $hse_os_version}"
  else
    os="an operating system Hivra couldn't identify"
  fi
  arch=${hse_arch:-an unknown processor}
  printf 'This server runs %s on %s.' "$os" "$arch"
}

hse_rebuild_line() {
  printf '%s' "The setup command works with Ubuntu 22.04 or 24.04 on x86. Rebuild this server with a supported image, then run a new command."
}

hse_proxmox_line() {
  printf 'This server runs Proxmox VE%s. The setup command does not connect Proxmox VE yet: Proxmox VE servers connect with a root login for now. In Hivra, choose Connect with SSH details instead (advanced) and sign in as root.' "${hse_pve:+ $hse_pve}"
}

hse_json_string() {
  if [ -n "$1" ]; then printf '"%s"' "$1"; else printf 'null'; fi
}

hse_json_number() {
  if [ -n "$1" ]; then printf '%s' "$1"; else printf 'null'; fi
}

hse_facts_json() {
  printf '{"hostname":%s,"osId":%s,"osVersionId":%s,"architecture":%s,"cpuCount":%s,"memoryBytes":%s,"virtualization":%s,"proxmoxVersion":%s,"sshMatchRules":%s}' \
    "$(hse_json_string "$hse_hostname")" "$(hse_json_string "$hse_os_id")" \
    "$(hse_json_string "$hse_os_version")" "$(hse_json_string "$hse_arch")" \
    "$(hse_json_number "$hse_cpus")" "$(hse_json_number "$hse_memory")" \
    "$(hse_json_string "$hse_virt")" "$(hse_json_string "$hse_pve")" "${hse_match_rules:-false}"
}

hse_consent_value() {
  if [ "$hse_has_tty" = 1 ]; then printf 'terminal'; else printf 'no_terminal'; fi
}

hse_enrolled_report() {
  printf '{"version":1,"scriptVersion":"%s","kind":"enrolled","consent":"%s","hostPublicKey":%s,"adminKeyFingerprint":"%s","sshPort":%s,"reenrollment":%s,"facts":%s}' \
    "$(hse_version)" "$(hse_consent_value)" "$(hse_json_string "$hse_host_key")" "$hse_admin_fingerprint" \
    "$(hse_json_number "$hse_ssh_port")" "$hse_reenrollment" "$(hse_facts_json)"
}

hse_unsupported_report() {
  printf '{"version":1,"scriptVersion":"%s","kind":"unsupported","consent":"%s","hostPublicKey":null,"adminKeyFingerprint":null,"sshPort":null,"reenrollment":false,"facts":%s}' \
    "$(hse_version)" "$(hse_consent_value)" "$(hse_facts_json)"
}

hse_key_line() {
  printf 'restrict %s hivra-enrollment\n' "$hse_admin_key"
}

hse_sudoers_content() {
  printf '%s\n' 'hivra ALL=(ALL:ALL) NOPASSWD: ALL'
}

hse_uninstall_command() {
  printf "curl -fsS --proto '=https' %s/enroll/uninstall | sudo bash" "$hse_origin"
}

hse_marker_path() {
  printf '%s' "$hse_root/etc/hivra/enrollment.json"
}

hse_sudoers_path() {
  printf '%s' "$hse_root/etc/sudoers.d/hivra-enrollment"
}

# Hivra's marker, if this server has a valid one: sets hse_marker_status
# (pending or reported), hse_marker_date and hse_marker_origin.
hse_read_marker() {
  local marker listing
  marker=$(hse_marker_path)
  hse_marker_status=
  hse_marker_date=
  hse_marker_origin=
  [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
  listing=$(ls -ln -- "$marker" 2>/dev/null) || return 1
  hse_split "$listing"
  [ "${hse_words[2]:-}" = "$hse_root_uid" ] || return 1
  listing=$(head -c 2048 -- "$marker" 2>/dev/null) || return 1
  if [[ $listing =~ \"status\":\"(pending|reported)\" ]]; then hse_marker_status=${BASH_REMATCH[1]}; else return 1; fi
  if [[ $listing =~ \"writtenAt\":\"([0-9]{4}-[0-9]{2}-[0-9]{2})T ]]; then hse_marker_date=${BASH_REMATCH[1]}; fi
  if [[ $listing =~ \"origin\":\"(https://[a-z0-9.-]{1,253})\" ]]; then hse_marker_origin=${BASH_REMATCH[1]}; fi
  return 0
}

hse_human_date() {
  local year month day names
  if [[ $1 =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})$ ]]; then
    year=${BASH_REMATCH[1]}
    month=$((10#${BASH_REMATCH[2]}))
    day=$((10#${BASH_REMATCH[3]}))
    names=(Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec)
    if [ "$month" -ge 1 ] && [ "$month" -le 12 ]; then
      printf '%s %s %s' "$day" "${names[$((month - 1))]}" "$year"
      return 0
    fi
  fi
  printf 'an earlier date'
}

hse_user_exists() {
  getent passwd hivra >/dev/null 2>&1
}

# /etc/hivra must stay a root-owned directory that other users can traverse
# but not change, because Prepare and the DeepSeek gateway rely on that.
hse_hivra_dir_is_safe() {
  local dir="$hse_root/etc/hivra" listing mode
  [ -e "$dir" ] || return 0
  [ -d "$dir" ] && [ ! -L "$dir" ] || return 1
  listing=$(ls -ldn -- "$dir" 2>/dev/null) || return 1
  hse_split "$listing"
  mode=${hse_words[0]:-}
  [ "${hse_words[2]:-}" = "$hse_root_uid" ] || return 1
  # d, owner rwx, group read, no group write, group exec, other read, no
  # other write, then anything (other exec, sticky, ACL mark).
  case "$mode" in
    d????-??-*) return 0 ;;
  esac
  return 1
}

hse_requirements() {
  local sudoers home
  if ! command -v sudo >/dev/null 2>&1 || ! command -v visudo >/dev/null 2>&1; then
    hse_say "This server doesn't have sudo. Install it with \`apt install sudo\`, then run the command again."
    return 1
  fi
  if [ ! -d "$hse_root/etc/sudoers.d" ]; then
    hse_say "This server's sudo has no /etc/sudoers.d folder, which Hivra's sudo rule goes in. Nothing was changed."
    return 1
  fi
  hse_reenrollment=false
  if hse_user_exists; then
    if ! hse_read_marker; then
      hse_say "This server already has a user named hivra that Hivra's setup command didn't create, so Hivra won't take it over. If Hivra created this server on Hetzner, manage it from its card in Hivra. Nothing was changed."
      return 1
    fi
    home=$(getent passwd hivra 2>/dev/null | cut -d: -f6)
    if ! hse_matches "$home" '^/[A-Za-z0-9._/-]{1,200}$'; then
      hse_say "Hivra couldn't read the hivra user's home folder. Nothing was changed."
      return 1
    fi
    hse_home=$home
    hse_reenrollment=true
    if [ -L "$hse_root$hse_home" ] || [ -L "$hse_root$hse_home/.ssh" ] || [ -L "$hse_root$hse_home/.ssh/authorized_keys" ]; then
      hse_say "The hivra user's home or .ssh folder is a link, so Hivra won't write to it. Nothing was changed."
      return 1
    fi
  fi
  if ! hse_sshd_lets_hivra_in; then
    hse_say "$hse_sshd_problem"
    return 1
  fi
  sudoers=$(hse_sudoers_path)
  if [ -e "$sudoers" ] || [ -L "$sudoers" ]; then
    hse_sudoers_content > "$hse_tmp/sudoers.expected"
    if [ -L "$sudoers" ] || ! cmp -s -- "$sudoers" "$hse_tmp/sudoers.expected"; then
      hse_say "This server already has /etc/sudoers.d/hivra-enrollment with different contents. Hivra won't replace it. Nothing was changed."
      return 1
    fi
  fi
  if ! hse_hivra_dir_is_safe; then
    hse_say "/etc/hivra exists but isn't a root-owned folder that only root can change, so Hivra won't use it. Nothing was changed."
    return 1
  fi
  return 0
}

hse_print_plan() {
  hse_show ""
  hse_show "This will:"
  hse_show "  - create a user named hivra that can only sign in with Hivra's key ($hse_admin_fingerprint)"
  hse_show "  - let hivra run administrator commands without a password (sudo)"
  hse_show "  - send this server's SSH identity and basic facts to $hse_origin"
  hse_show "Nothing else is installed or changed. To undo it later:"
  hse_show "  $(hse_uninstall_command)"
  if [ "$hse_reenrollment" = true ]; then
    hse_show ""
    if [ "$hse_marker_status" = reported ]; then
      hse_show "Hivra's setup command already ran on this server on $(hse_human_date "$hse_marker_date") and reported to ${hse_marker_origin:-Hivra}. This server can't tell whether that Hivra account confirmed it. Continuing replaces the hivra user's key with this account's, so any earlier access stops working."
    else
      hse_show "An earlier Hivra setup on this server ($(hse_human_date "$hse_marker_date")) didn't finish. Continuing replaces what it left."
    fi
  fi
  hse_show ""
  hse_show "This gives the Hivra account with code $hse_account administrator access to this server."
  hse_show "Continue only if $hse_account is your account code (Hivra shows it next to the"
  hse_show "command and in your account menu) and you copied this command from Hivra yourself."
}

hse_marker_json() {
  # $1 status, $2 extra fields (already validated), no secrets.
  printf '{"version":1,"status":"%s","scriptVersion":"%s","origin":"%s","adminKeyFingerprint":"%s","hostKeyFingerprint":"%s","writtenAt":"%s"%s}\n' \
    "$1" "$(hse_version)" "$hse_origin" "$hse_admin_fingerprint" "$hse_host_fingerprint" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${2:-}"
}

# Steps 9 to 12. Each change is recorded before the next one starts, so the
# rollback undoes exactly what this run did.
hse_apply_changes() {
  local marker sudoers dir keys
  marker=$(hse_marker_path)
  sudoers=$(hse_sudoers_path)
  dir="$hse_root/etc/hivra"
  keys="$hse_root$hse_home/.ssh/authorized_keys"
  # This function runs as an if condition, where bash ignores set -e, so
  # every step checks its own result.
  hse_rollback_armed=1
  if ! hse_user_exists; then
    hse_did_user=created
    useradd --create-home --home-dir "$hse_home" --user-group --shell /bin/bash --comment Hivra hivra || return 1
    # '*' makes password sign-in impossible while keeping key sign-in valid
    # when sshd has UsePAM no; a '!' lock would block keys there.
    usermod -p '*' hivra || return 1
  elif [ -f "$keys" ]; then
    cp -p -- "$keys" "$hse_tmp/authorized_keys.previous" || return 1
    hse_did_keys=replaced
  else
    hse_did_keys=created
  fi
  install -d -m 0700 -o hivra -g hivra "$hse_root$hse_home/.ssh" || return 1
  hse_key_line > "$hse_tmp/authorized_keys" || return 1
  install -m 0600 -o hivra -g hivra "$hse_tmp/authorized_keys" "$keys" || return 1
  # sshd evaluates "Match Group" rules only for a user that exists, so the
  # check before any change couldn't see them. Ask sshd again now that hivra
  # and its group exist.
  if ! hse_read_sshd; then
    hse_say "Hivra couldn't read this server's SSH settings (sshd -T failed) after creating the hivra user."
    return 1
  fi
  if ! hse_sshd_lets_hivra_in; then
    hse_say "$hse_sshd_problem"
    return 1
  fi
  if [ ! -e "$sudoers" ]; then
    hse_sudoers_content > "$hse_tmp/sudoers" || return 1
    visudo -cf "$hse_tmp/sudoers" >/dev/null || return 1
    # A name with a dot is skipped by sudo, so the rule only takes effect at
    # the rename.
    hse_did_sudoers=1
    install -m 0440 -o root -g root "$hse_tmp/sudoers" "$hse_root/etc/sudoers.d/.hivra-enrollment.new" || return 1
    mv -f -- "$hse_root/etc/sudoers.d/.hivra-enrollment.new" "$sudoers" || return 1
  fi
  if ! sudo -l -U hivra 2>/dev/null | grep -q 'NOPASSWD: ALL'; then
    hse_say "sudo on this server doesn't read /etc/sudoers.d, so hivra couldn't use it."
    return 1
  fi
  if [ ! -d "$dir" ]; then
    hse_did_dir=1
    install -d -m 0755 -o root -g root "$dir" || return 1
  fi
  if [ -f "$marker" ]; then
    cp -p -- "$marker" "$hse_tmp/marker.previous" || return 1
    hse_did_marker=replaced
  else
    hse_did_marker=created
  fi
  hse_marker_json pending > "$hse_tmp/marker" || return 1
  install -m 0644 -o root -g root "$hse_tmp/marker" "$marker" || return 1
}

hse_rollback() {
  local failed=0 marker sudoers keys
  hse_rollback_armed=0
  marker=$(hse_marker_path)
  sudoers=$(hse_sudoers_path)
  keys="$hse_root$hse_home/.ssh/authorized_keys"
  case "${hse_did_marker:-}" in
    created) rm -f -- "$marker" || failed=1 ;;
    replaced) install -m 0644 -o root -g root "$hse_tmp/marker.previous" "$marker" || failed=1 ;;
  esac
  if [ "${hse_did_dir:-0}" = 1 ]; then rmdir -- "$hse_root/etc/hivra" 2>/dev/null || true; fi
  if [ "${hse_did_sudoers:-0}" = 1 ]; then
    rm -f -- "$sudoers" "$hse_root/etc/sudoers.d/.hivra-enrollment.new" || failed=1
  fi
  if [ "${hse_did_user:-}" = created ]; then
    userdel -r hivra >/dev/null 2>&1 || failed=1
  else
    case "${hse_did_keys:-}" in
      replaced) install -m 0600 -o hivra -g hivra "$hse_tmp/authorized_keys.previous" "$keys" || failed=1 ;;
      created) rm -f -- "$keys" || failed=1 ;;
    esac
  fi
  if [ "$failed" = 1 ]; then
    hse_say "This server couldn't undo every change. To finish it, run as root:"
    hse_say "  rm -f /etc/sudoers.d/hivra-enrollment /etc/hivra/enrollment.json"
    hse_say "  userdel -r hivra"
    hse_say "or run the uninstall command: $(hse_uninstall_command)"
  fi
}

hse_has_ipv6_route() {
  command -v ip >/dev/null 2>&1 && [ -n "$(ip -6 route show default 2>/dev/null || true)" ]
}

# One HTTPS request. The code travels only in a curl config read from a pipe
# and the body from another, so neither is in any process's argv or
# environment, and nothing is written to disk.
hse_post_once() {
  local family=$1 rc=0
  : > "$hse_tmp/response"
  : > "$hse_tmp/status"
  curl "--ipv$family" --silent --proto '=https' --max-redirs 0 --connect-timeout 10 --max-time 20 \
    --config <(printf 'header = "Authorization: Bearer %s"\n' "$hse_code") \
    --header 'Content-Type: application/json' \
    --data-binary @<(printf '%s' "$hse_report_body") \
    --output "$hse_tmp/response" --write-out '%{http_code}' \
    "$hse_origin/api/infrastructure/server-enrollments/report" > "$hse_tmp/status" 2>/dev/null || rc=$?
  hse_http_status=$(head -c 3 "$hse_tmp/status" 2>/dev/null || true)
  hse_matches "$hse_http_status" '^[0-9]{3}$' || hse_http_status=000
  return "$rc"
}

# The acknowledgement is fixed-format lines, checked one by one. Nothing in it
# is printed except the words and values that matched their patterns.
hse_read_acknowledgement() {
  local file="$hse_tmp/response" size line index=0 header= status= enrollment= words= host= extra=0
  hse_ack_status=malformed
  size=$(wc -c < "$file" | tr -d ' ')
  hse_matches "$size" '^[0-9]+$' && [ "$size" -le 512 ] || return 0
  if LC_ALL=C grep -q '[^ -~]' "$file"; then return 0; fi
  while IFS= read -r line || [ -n "$line" ]; do
    index=$((index + 1))
    case "$index" in
      1) header=$line ;;
      2) status=$line ;;
      3) enrollment=$line ;;
      4) words=$line ;;
      5) host=$line ;;
      *) extra=1 ;;
    esac
  done < "$file"
  [ "$header" = 'HIVRA_ENROLLMENT v1' ] && [ "$extra" = 0 ] || return 0
  case "$status:$hse_http_status:$index" in
    status=accepted:200:5)
      hse_matches "$enrollment" '^enrollment=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || return 0
      hse_matches "$words" '^words=[a-z]{2,10}-[a-z]{2,10}-[a-z]{2,10}$' || return 0
      [ "$host" = "host=$hse_host_fingerprint" ] || return 0
      hse_ack_enrollment=${enrollment#enrollment=}
      hse_ack_words=${words#words=}
      hse_ack_status=accepted
      ;;
    status=unsupported:200:2) hse_ack_status=unsupported ;;
    status=not_usable:401:2) hse_ack_status=not_usable ;;
    status=invalid_report:400:2) hse_ack_status=invalid_report ;;
    status=private_address:422:2) hse_ack_status=private_address ;;
    status=ipv4_required:422:2) hse_ack_status=ipv4_required ;;
  esac
  return 0
}

# Step 13: at most 6 attempts in 90 seconds over IPv4, retrying only 408,
# 429, 5xx and network errors, with the same body each time. If no IPv4
# attempt connected at all and there is an IPv6 route, one IPv6 attempt lets
# Hivra refuse it with a clear reason.
hse_send_report() {
  local attempt=0 delay=2 waited=0 connected=0
  hse_ack_status=no_answer
  while [ "$attempt" -lt 6 ]; do
    attempt=$((attempt + 1))
    hse_post_once 4 || true
    [ "$hse_http_status" = 000 ] || connected=1
    case "$hse_http_status" in
      200|400|401|422)
        hse_read_acknowledgement
        return 0
        ;;
      408|429|5??|000) ;;
      *)
        hse_ack_status=malformed
        return 0
        ;;
    esac
    [ "$attempt" -lt 6 ] || break
    [ $((waited + delay)) -le 90 ] || break
    sleep "$delay"
    waited=$((waited + delay))
    delay=$((delay * 2))
    [ "$delay" -le 30 ] || delay=30
  done
  if [ "$connected" = 0 ] && hse_has_ipv6_route; then
    hse_post_once 6 || true
    case "$hse_http_status" in
      200|400|401|422) hse_read_acknowledgement ;;
    esac
  fi
  return 0
}

hse_explain_refusal() {
  case "$1" in
    not_usable)
      hse_say "Hivra didn't accept this server's report: the command has expired, was already used, or was replaced by a new one."
      hse_say "If you didn't use it before, someone else may have it. In Hivra, choose No for any server you don't recognise, then get a new command."
      ;;
    invalid_report)
      hse_say "Hivra refused this server's report because it didn't match what this command expects. Get a new command in Hivra and run it again."
      ;;
    private_address)
      hse_say "Hosted Hivra can't reach servers on private networks. Nothing was kept."
      ;;
    ipv4_required)
      hse_say "Hosted Hivra can only reach servers over IPv4 for now. Give this server a public IPv4 address, then run a new command. Nothing was kept."
      ;;
    unsupported)
      hse_say "$(hse_found_line) $(hse_rebuild_line)"
      ;;
    *)
      hse_say "Hivra didn't confirm it received this server's report, so this server undid every change. If Hivra asks \"Is this your server?\" about this server, choose No, then run a new command."
      ;;
  esac
}

hse_header() {
  hse_say "Hivra server setup - script $(hse_version)"
}

hse_dry_run_output() {
  local skipped=
  hse_show ""
  hse_show "Dry run: nothing is changed and nothing is sent."
  hse_print_plan
  hse_show ""
  hse_show "The key line for /home/hivra/.ssh/authorized_keys:"
  hse_show "  $(hse_key_line)"
  hse_show "The line for /etc/sudoers.d/hivra-enrollment:"
  hse_show "  $(hse_sudoers_content)"
  hse_show "The report it would send to $hse_origin:"
  if [ "$hse_pve_found" = 1 ]; then
    hse_show "  None. $(hse_proxmox_line)"
  elif hse_supported; then
    hse_show "  $(hse_enrolled_report)"
  else
    hse_show "  $(hse_found_line) $(hse_rebuild_line)"
    hse_show "  $(hse_unsupported_report)"
  fi
  if [ "$hse_euid" != 0 ]; then
    skipped="Skipped without root: the SSH server settings, its host key, and the checks for an existing hivra user, sudoers file and /etc/hivra."
    hse_show "$skipped"
  fi
  return 0
}

hivra_refuse() {
  hse_init
  exec 0</dev/null
  if [ "$#" -ne 1 ]; then hse_incomplete; fi
  case "$1" in
    missing_code)
      hse_say "This command is missing its one-time code. Copy the whole command from Hivra again. Nothing was changed."
      ;;
    expired_or_used)
      hse_say "Hivra didn't accept this setup command: it has expired, was already used, or was replaced by a new one. Nothing was changed. Get a new command in Hivra."
      ;;
    fetch_limit)
      hse_say "This command was downloaded 20 times, which is Hivra's limit. Get a new command in Hivra. Nothing was changed."
      ;;
    *) hse_incomplete ;;
  esac
  exit 1
}

hivra_enroll_entry() {
  set -Eeuo pipefail
  hse_init
  umask 077
  exec 0</dev/null
  hse_parse_enroll_args "$@" || hse_incomplete
  hse_header
  if [ "$hse_dry_run" = 0 ] && [ "$hse_euid" != 0 ]; then
    hse_say "This needs administrator rights. Run it with sudo (... | sudo bash), or in a root shell. Nothing was changed."
    exit 1
  fi
  hse_tmp=
  hse_rollback_armed=0
  hse_did_user=
  hse_did_keys=
  hse_did_sudoers=0
  hse_did_dir=0
  hse_did_marker=
  hse_reenrollment=false
  hse_marker_status=
  hse_marker_date=
  hse_marker_origin=
  hse_host_key=
  hse_host_fingerprint=
  hse_ssh_port=
  hse_match_rules=false
  trap hse_on_exit EXIT
  trap 'exit 130' INT TERM HUP
  hse_tempdir
  hse_admin_fingerprint=$(hse_fingerprint "$hse_admin_key") || {
    hse_say "This server's ssh-keygen couldn't read Hivra's key. Nothing was changed."
    exit 1
  }

  # Step 3: facts, read-only.
  hse_read_facts
  hse_read_match_rules
  hse_open_terminal
  if [ "$hse_euid" = 0 ]; then
    if ! command -v sshd >/dev/null 2>&1; then
      hse_say "This server doesn't have an SSH server Hivra can sign in to. Install openssh-server, then run the command again. Nothing was changed."
      exit 1
    fi
    if ! hse_read_sshd; then
      hse_say "Hivra couldn't read this server's SSH settings (sshd -T failed). Check the SSH server's configuration, then run the command again. Nothing was changed."
      exit 1
    fi
    # Step 4: the host key sshd presents.
    if ! hse_read_host_key; then
      hse_say "This server's SSH server has no Ed25519 host key, which Hivra needs. Nothing was changed."
      exit 1
    fi
    hse_host_fingerprint=$(hse_fingerprint "$hse_host_key") || {
      hse_say "This server's ssh-keygen couldn't read its own host key. Nothing was changed."
      exit 1
    }
  fi
  if [ "$hse_match_rules" = true ]; then
    hse_say "This server's SSH settings have rules for particular addresses. Hivra connects from changing internet addresses, so make sure hivra can sign in from any address."
  fi

  if [ "$hse_dry_run" = 1 ]; then
    hse_dry_run_output
    exit 0
  fi

  # Proxmox VE: nothing is sent or changed, and the code stays valid.
  if [ "$hse_pve_found" = 1 ]; then
    hse_say "$(hse_proxmox_line) Nothing was sent or changed."
    exit 1
  fi

  # Step 5: nothing is sent without a terminal answer or, only without a
  # terminal, --yes.
  if [ "$hse_has_tty" = 0 ] && [ "$hse_yes" = 0 ]; then
    hse_say "This needs a terminal to ask you first. Run it in a terminal, or add \`-s -- --yes\` if you are automating it. Nothing was changed."
    exit 1
  fi

  # Step 6: an unsupported server enrolls nothing. With consent, it tells
  # Hivra what it found so Hivra can show the same instructions.
  if ! hse_supported; then
    hse_say "$(hse_found_line) $(hse_rebuild_line)"
    if hse_ask "Send these facts to the Hivra account with code $hse_account so it shows the same instructions? [y/N]"; then
      hse_report_body=$(hse_unsupported_report)
      hse_send_report
      case "$hse_ack_status" in
        unsupported) hse_say "Sent. Hivra shows the same instructions. Nothing on this server was changed." ;;
        *) hse_explain_refusal "$hse_ack_status" ;;
      esac
    else
      hse_say "Nothing was sent or changed. Your command stays valid until it expires."
    fi
    exit 1
  fi

  # Step 7: requirements, without changing anything.
  if ! hse_requirements; then
    exit 1
  fi

  # Step 8: consent. Default is No.
  hse_print_plan
  if ! hse_ask "Continue? [y/N]"; then
    hse_say "Nothing was changed or sent. Your command stays valid until it expires."
    exit 1
  fi

  # Steps 9 to 12: changes, rolled back unless Hivra accepts the report.
  if ! hse_apply_changes; then
    hse_rollback
    hse_say "This server undid every change."
    exit 1
  fi

  # Step 13: the report.
  hse_report_body=$(hse_enrolled_report)
  hse_send_report

  # Step 14: the outcome. The server never learns whether the owner said Yes,
  # so the marker never says more than "reported".
  if [ "$hse_ack_status" = accepted ]; then
    # Accepted: keep every change, whatever happens to the marker update.
    hse_rollback_armed=0
    if ! { hse_marker_json reported ",\"enrollment\":\"$hse_ack_enrollment\",\"reportedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"" > "$hse_tmp/marker" \
      && install -m 0644 -o root -g root "$hse_tmp/marker" "$(hse_marker_path)"; }; then
      hse_say "Hivra accepted the report, but /etc/hivra/enrollment.json still says pending."
    fi
    hse_say ""
    hse_say "Done. Hivra shows the same three words: ${hse_ack_words//-/ }. Go back to Hivra and confirm \"Is this your server?\""
    exit 0
  fi
  hse_rollback
  hse_explain_refusal "$hse_ack_status"
  if [ "$hse_ack_status" != no_answer ] && [ "$hse_ack_status" != malformed ]; then
    hse_say "This server undid every change."
  fi
  exit 1
}

hivra_uninstall_entry() {
  local sudoers marker hse_wait
  set -Eeuo pipefail
  hse_init
  umask 077
  exec 0</dev/null
  hse_parse_uninstall_args "$@" || hse_incomplete
  hse_say "Hivra server setup - uninstall - script $(hse_version)"
  if [ "$hse_dry_run" = 0 ] && [ "$hse_euid" != 0 ]; then
    hse_say "This needs administrator rights. Run it with sudo (... | sudo bash), or in a root shell. Nothing was changed."
    exit 1
  fi
  hse_tmp=
  trap hse_on_exit EXIT
  trap 'exit 130' INT TERM HUP
  hse_open_terminal
  if ! hse_read_marker; then
    hse_say "This server has no sign that Hivra's setup command ran here (/etc/hivra/enrollment.json), so there is nothing to remove. Nothing was changed."
    exit 1
  fi
  hse_show ""
  hse_show "This will:"
  hse_show "  - end the hivra user's sessions and delete the hivra user and its home folder"
  hse_show "  - remove /etc/sudoers.d/hivra-enrollment if it is the file Hivra wrote"
  hse_show "  - remove /etc/hivra/enrollment.json"
  hse_show "It leaves /etc/hivra in place, because Prepare may have put other files there."
  hse_show "Software that Prepare installed (Docker, gVisor, Proxmox settings) is not removed. Remove agents' computers in Hivra first."
  if [ "$hse_dry_run" = 1 ]; then
    hse_show "Dry run: nothing was changed."
    exit 0
  fi
  if [ "$hse_has_tty" = 0 ] && [ "$hse_yes" = 0 ]; then
    hse_say "This needs a terminal to ask you first. Run it in a terminal, or add \`-s -- --yes\` if you are automating it. Nothing was changed."
    exit 1
  fi
  if ! hse_ask "Continue? [y/N]"; then
    hse_say "Nothing was changed."
    exit 1
  fi
  hse_tempdir
  if hse_user_exists; then
    loginctl terminate-user hivra >/dev/null 2>&1 || true
    pkill -u hivra >/dev/null 2>&1 || true
    # Ending a session is asynchronous (systemd stops hivra's user manager
    # in the background), and userdel refuses a user with processes, so wait
    # for them, then end any that remain.
    hse_wait=0
    while pgrep -u hivra >/dev/null 2>&1 && [ "$hse_wait" -lt 20 ]; do
      sleep 0.5
      hse_wait=$((hse_wait + 1))
    done
    if pgrep -u hivra >/dev/null 2>&1; then
      pkill -KILL -u hivra >/dev/null 2>&1 || true
      hse_wait=0
      while pgrep -u hivra >/dev/null 2>&1 && [ "$hse_wait" -lt 10 ]; do
        sleep 0.5
        hse_wait=$((hse_wait + 1))
      done
    fi
    userdel -r hivra >/dev/null 2>&1 || {
      hse_say "The hivra user couldn't be deleted. Check that none of its processes are running, then run the uninstall command again."
      exit 1
    }
  fi
  sudoers=$(hse_sudoers_path)
  if [ -e "$sudoers" ]; then
    hse_sudoers_content > "$hse_tmp/sudoers.expected"
    if [ ! -L "$sudoers" ] && cmp -s -- "$sudoers" "$hse_tmp/sudoers.expected"; then
      rm -f -- "$sudoers"
    else
      hse_say "Left /etc/sudoers.d/hivra-enrollment in place because it isn't the file Hivra wrote."
    fi
  fi
  marker=$(hse_marker_path)
  rm -f -- "$marker"
  hse_say "Done. The hivra user and Hivra's sudo rule are gone. Hivra notices the next time it tries to sign in; Disconnect the server in Hivra to delete its key there."
  exit 0
}
