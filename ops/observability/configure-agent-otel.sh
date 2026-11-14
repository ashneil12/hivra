#!/usr/bin/env bash
set -euo pipefail

collector_endpoint="${1:-http://127.0.0.1:4318}"
agent_home="${2:-/home/bux}"
system_root="${3:-/}"
if [[ ! "$collector_endpoint" =~ ^http://(127\.0\.0\.1|localhost):([0-9]{1,5})$ ]]; then echo "collector endpoint must be loopback HTTP with an explicit port" >&2; exit 2; fi
collector_port="${BASH_REMATCH[2]}"; if (( 10#$collector_port < 1 || 10#$collector_port > 65535 )); then echo "collector port must be 1..65535" >&2; exit 2; fi
if test -L "$agent_home" || ! test -d "$agent_home"; then echo "agent home must be a real directory: $agent_home" >&2; exit 2; fi

# The agent user owns its home, so root never touches a path under it. The Codex
# config is written by the agent user itself (below), which means a link the agent
# planted there can only ever point at files the agent could already change.
agent_user="$(stat -c '%U' "$agent_home")"
agent_uid="$(stat -c '%u' "$agent_home")"
if [ "$agent_uid" = 0 ] || [ "$agent_user" = root ]; then echo "agent home must belong to a non-root user: $agent_home" >&2; exit 2; fi

# Runs as the agent user with the body on stdin, as hivra-codex-config-pin.py does.
# Exit 3 (unmanaged [otel]) and exit 4 (symlink in the way) come back unchanged.
runuser -u "$agent_user" -- env -i PATH=/usr/bin:/bin HOME="$agent_home" LANG=C.UTF-8 bash -s -- "$collector_endpoint" <<'AGENT'
set -euo pipefail
collector_endpoint="$1"
codex_dir="$HOME/.codex"; codex_config="$codex_dir/config.toml"
if test -L "$codex_dir" || test -L "$codex_config"; then
  echo "refusing to write $codex_config: it or its directory is a symlink" >&2; exit 4
fi
if test -e "$codex_dir" && ! test -d "$codex_dir"; then echo "$codex_dir is not a directory" >&2; exit 4; fi
if test -f "$codex_config" && grep -Eq '^\[otel\]' "$codex_config" && ! grep -Fq '# hivra-activity-otel:start' "$codex_config"; then
  echo "Existing unmanaged [otel] block found; refusing to overwrite $codex_config" >&2; exit 3
fi
mkdir -p -m 0700 "$codex_dir"
tmp="$(mktemp "$codex_dir/.config.toml.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
if test -f "$codex_config"; then awk '/^# hivra-activity-otel:start$/{skip=1} /^# hivra-activity-otel:end$/{skip=0;next} !skip{print}' "$codex_config" >"$tmp"; fi
cat >>"$tmp" <<EOF

# hivra-activity-otel:start
[otel]
environment = "hivra"
log_user_prompt = false
exporter = { otlp-http = { endpoint = "${collector_endpoint}/v1/logs", protocol = "binary" } }
# hivra-activity-otel:end
EOF
chmod 0600 "$tmp"
# mv replaces the directory entry itself; it never writes through a link there.
mv -f "$tmp" "$codex_config"
AGENT
# Only after the agent step succeeds: a refusal (exit 3 or 4) leaves no root-side
# write behind, so a refused run never reports a half-applied setup.
profile_dir="${system_root%/}/etc/profile.d"; profile_file="${profile_dir}/hivra-agent-otel.sh"
install -d -m 0755 "$profile_dir"
cat >"$profile_file" <<EOF
export CLAUDE_CODE_ENABLE_TELEMETRY='1'
export OTEL_LOGS_EXPORTER='otlp'
export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL='http/json'
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT='${collector_endpoint}/v1/logs'
export OTEL_LOG_USER_PROMPTS='0'
export OTEL_LOG_ASSISTANT_RESPONSES='0'
export OTEL_LOG_TOOL_DETAILS='0'
export OTEL_LOG_TOOL_CONTENT='0'
export OTEL_LOG_RAW_API_BODIES='0'
EOF
chmod 0644 "$profile_file"
echo "Configured Claude Code and Codex to send redacted OTLP logs to the local collector. Restart the agent process to apply it." >&2
