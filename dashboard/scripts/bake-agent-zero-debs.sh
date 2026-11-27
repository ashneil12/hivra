read_agent_zero_deb_lock() {
  local mode="$1" stage="$2" snapshot status_sha sha package version relative extra file
  AGENT_ZERO_DEBS=()
  AGENT_ZERO_DEB_VERSIONS=()
  {
    read -r snapshot status_sha extra
    [[ "$snapshot" =~ ^[0-9]{8}T[0-9]{6}Z$ && "$status_sha" =~ ^[0-9a-f]{64}$ && -z "$extra" ]] || return 1
    if [ "$mode" = verify ]; then
      printf '%s  /var/lib/dpkg/status\n' "$status_sha" | sha256sum --strict --check --status - \
        || { printf 'Agent Zero deb lock does not match the base dpkg status\n' >&2; return 1; }
    fi
    while read -r sha package version relative extra; do
      [[ "$sha" =~ ^[0-9a-f]{64}$ && "$package" =~ ^[a-z0-9.+-]+$ && "$version" =~ ^[a-zA-Z0-9.+:~-]+$ \
        && "$relative" =~ ^pool/(main|universe)/[a-z0-9]+/[a-z0-9.+-]+/"${package}"_[A-Za-z0-9.+~_-]+_amd64\.deb$ \
        && "$relative" != *..* && -z "$extra" ]] || return 1
      file="$stage/debs/${relative##*/}"
      if [ "$mode" = fetch ]; then
        fetch "https://snapshot.ubuntu.com/ubuntu/$snapshot/$relative" "$sha" "$file" || return 1
      else
        [ -f "$file" ] && [ ! -L "$file" ] \
          && printf '%s  %s\n' "$sha" "$file" | sha256sum --strict --check --status - \
          || { printf 'Agent Zero locked deb failed verification: %s\n' "$package" >&2; return 1; }
      fi
      AGENT_ZERO_DEBS+=("$file")
      AGENT_ZERO_DEB_VERSIONS+=("$package=$version")
    done
  } < "$stage/agent-zero-debs.lock"
  [ "${#AGENT_ZERO_DEBS[@]}" -gt 0 ]
}
