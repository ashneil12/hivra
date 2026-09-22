# Hivra Activity OpenTelemetry adapter

This directory runs the upstream OpenTelemetry Collector Contrib distribution and forwards OTLP traces and logs as JSON to Hivra's authenticated activity adapter. It does not collect OS activity. An event means the instrumented agent reported it.

## Collector

1. Set `HIVRA_ACTIVITY_INGEST_BASE_URL`, `HIVRA_ACTIVITY_RESOURCE_ID`, and a short-lived `HIVRA_ACTIVITY_COLLECTOR_TOKEN` minted for that exact resource.
2. Run `docker compose -f ops/observability/docker-compose.yaml config`, then `docker compose -f ops/observability/docker-compose.yaml up -d`.
3. Point instrumented producers at `http://127.0.0.1:4318`. The collector accepts standard OTLP HTTP paths `/v1/traces` and `/v1/logs`.

The image is pinned to Collector Contrib `0.161.0`. The exporter uses explicit trace and log endpoints because Hivra accepts both signals at `/api/activity/ingest`.

## Scoped credential

`mint-collector-token.mjs` creates an expiring HMAC-signed token with a tenant and exact resource allowlist. It requires `ACTIVITY_COLLECTOR_SIGNING_SECRET` and writes a new mode-0600 file; it never prints the token. The dashboard must have the same signing secret. Rotate by minting a replacement and restarting only the collector.

## Agent producers

Run `configure-agent-otel.sh` as root inside a Hivra guest with the local collector endpoint. It enables Claude Code OTLP logs through `/etc/profile.d`, keeps prompt/assistant/tool-body/raw-API capture explicitly disabled, and adds a bounded `[otel]` block to the user's Codex config. It refuses to replace an existing unmanaged Codex telemetry block.

Claude Code documents OTLP logs/events and the content gates at <https://code.claude.com/docs/en/monitoring-usage>. Codex documents its user-level `[otel]` exporter and `log_user_prompt = false` at <https://learn.chatgpt.com/docs/config-file/config-advanced>. Neither producer proves host or OS activity; coverage becomes observed only after Hivra receives valid telemetry.

