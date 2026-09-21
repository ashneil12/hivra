#!/usr/bin/env bash
set -euo pipefail

collector_endpoint="${1:-http://127.0.0.1:4318}"
agent_home="${2:-/home/bux}"
system_root="${3:-/}"
if [[ ! "$collector_endpoint" =~ ^http://(127\.0\.0\.1|localhost):([0-9]{1,5})$ ]]; then echo "collector endpoint must be loopback HTTP with an explicit port" >&2; exit 2; fi
collector_port="${BASH_REMATCH[2]}"; if (( 10#$collector_port < 1 || 10#$collector_port > 65535 )); then echo "collector port must be 1..65535" >&2; exit 2; fi
test -d "$agent_home" || { echo "agent home does not exist: $agent_home" >&2; exit 2; }

codex_dir="${agent_home}/.codex"; codex_config="${codex_dir}/config.toml"
if test -f "$codex_config" && grep -Eq '^\[otel\]' "$codex_config" && ! grep -Fq '# hivra-activity-otel:start' "$codex_config"; then
  echo "Existing unmanaged [otel] block found; refusing to overwrite $codex_config" >&2; exit 3
fi
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

codex_dir_created=0; if ! test -d "$codex_dir"; then install -d -m 0700 "$codex_dir"; codex_dir_created=1; fi
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
if test -f "$codex_config"; then awk '/^# hivra-activity-otel:start$/{skip=1} /^# hivra-activity-otel:end$/{skip=0;next} !skip{print}' "$codex_config" >"$tmp"; fi
cat >>"$tmp" <<EOF

# hivra-activity-otel:start
[otel]
environment = "hivra"
log_user_prompt = false
exporter = { otlp-http = { endpoint = "${collector_endpoint}/v1/logs", protocol = "binary" } }
# hivra-activity-otel:end
EOF
install -m 0600 "$tmp" "$codex_config"
owner="$(stat -c '%U:%G' "$agent_home" 2>/dev/null || true)"; if test -n "$owner"; then chown "$owner" "$codex_config"; test "$codex_dir_created" = 0 || chown "$owner" "$codex_dir"; fi
echo "Configured Claude Code and Codex to send redacted OTLP logs to the local collector. Restart the agent process to apply it." >&2
