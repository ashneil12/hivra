# Agent run tracing contract

Status: target contract for automatic agent run reporting (2026-09-22). This
document is the single wire and state contract shared by the guest reporter,
the launch and start paths, the dashboard ingest/renewal routes, the Activity
feed, and the Activity UI. Current behaviour becomes "shipped" only after the
Canary acceptance recorded in the release PR.

## What it proves and what it does not

Hivra records what a supported agent's own session transcript says happened:
when a task started and ended, which tools it called, how long they took, and
whether the agent recorded a failure. It never records prompts, replies,
commands, file contents, tool inputs or tool outputs.

This is agent-reported evidence read from inside the computer. It is not an
OS-level audit: a process that bypasses the agent CLI, edits transcripts, or
stops the reporter is not caught by this layer. Silence is shown as a
coverage gap, never as proof that nothing happened.

Supported producers (catalog ids): `claude-code` (Claude Code, transcripts in
`/home/bux/.claude/projects`) and `codex` (Codex CLI, rollouts in
`/home/bux/.codex/sessions`) on Proxmox computers (`computer_substrate =
proxmox-kvm`). Every other agent type or substrate is `unsupported` until a
verified producer exists.

## Guest reporter layout

| Path | Mode | Owner | Purpose |
|---|---|---|---|
| `/opt/hivra/agent-trace/hivra-agent-trace.py` | 0644 | root | Reporter (stdlib Python 3.10+) |
| `/etc/systemd/system/hivra-agent-trace.service` | 0644 | root | Unit (`User=root`, `StateDirectory=hivra-agent-trace`) |
| `/var/lib/hivra-agent-trace/credential.json` | 0600 | root | `{endpoint, resourceId, token, expiresAt}` |
| `/var/lib/hivra-agent-trace/state.json` | 0600 | root | File offsets and bounded parser state |

Installation is one idempotent entry point, used by the launch installer, by
the start path and by the in-place runtime update:

```
python3 -I -B <dir>/hivra-agent-trace.py install --source-dir <dir>
```

It reads exactly one credential document on stdin (never argv or env),
validates it strictly, installs or replaces the script, unit and credential
atomically, runs `daemon-reload`, `enable`, `restart`, and exits 0 only when
the unit is active. It prints one status line to stderr and never prints the
token.

Reporter installation is fail-open everywhere: a malformed credential document
is refused, but a failure to install or start the reporter never fails a
launch, a start or a runtime update. The launch installer and the start helper each emit exactly
one marker line into the host log (the in-place runtime updater emits the same
line on its host-authored stdout),
`HIVRA_ACTIVITY_COLLECTOR status=installed` or
`HIVRA_ACTIVITY_COLLECTOR status=failed reason=<enum>`, which the control plane
records as the computer's install status. Issuance is recorded only when the
host bundle actually staged the credential.

### Credential document (launch document v4 field `activityTelemetry`)

Exactly these keys:

- `endpoint`: `https://<dashboard origin>/api/activity/ingest` (https only,
  no userinfo, no query, no fragment, path exactly `/api/activity/ingest`)
- `resourceId`: lower-case UUID of the `hivra_agents` row
- `token`: `^hvra_otlp_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`, at most 4096 bytes
- `expiresAt`: ISO-8601 UTC timestamp

The renewal URL is derived, never configured: the same origin with path
`/api/activity/collector/renew`.

## Wire format (reporter to ingest)

`POST {endpoint}` with `Authorization: Bearer <token>`,
`X-Hivra-Resource-Id: <resourceId>`, `Content-Type: application/json`, body an
OTLP/JSON `resourceLogs` document. Resource attribute
`service.namespace = "hivra.native"` marks native records. At most 400 log
records per request.

Each log record carries `timeUnixNano` (decimal string, UTC, sub-second
precision preserved), `severityNumber` (9 info, 13 warning, 17 error) and
these attributes only:

| Attribute | Type | Rule |
|---|---|---|
| `event.name` | string | Closed list below |
| `event.id` | string | 32 lower-case hex; stable for the same logical event across restarts and replays |
| `service.name` | string | `codex`, `claude-code`, or `hivra-agent-trace` (heartbeat only) |
| `conversation.id` | string | Producer session/thread id, `^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,119}$` |
| `session.id` | string | Run id (Codex `turn_id`, Claude `promptId`, Claude subagent `agent:<agentId>`), same charset |
| `tool.name` | string | `^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$`, otherwise omitted |
| `success` | bool | Only when the producer recorded a structured result |
| `duration_ms` | int | 0..604800000 |
| `error.type` | string | `^[a-z0-9_]{1,40}$` producer error enum only (never a message) |
| `parent.span.id` | string | 16 lower-case hex |

`event.name` closed list:

| Role | Meaning | Outcome |
|---|---|---|
| `run.started` | A new human/SDK task began | unknown |
| `run.completed` | The producer recorded a normal end of the task (Claude: `end_turn`/`stop_sequence`/`refusal`, never `max_tokens`, which Claude Code continues from) | success |
| `run.failed` | The producer recorded an error end (`error.type` when known) | failure |
| `run.stopped` | The task was interrupted or replaced before finishing | unknown |
| `tool.started` | A tool call was issued | unknown |
| `tool.completed` | The tool call returned (`success` only when structured) | success if `success=true`, else unknown |
| `tool.failed` | The producer recorded a structured tool failure | failure |
| `collector.heartbeat` | The reporter is alive and able to deliver | not an activity event |

Identifiers (all SHA-256 derived, lower-case hex):

- `traceId` (32) = H("trace", producer, conversation, run)
- run span (16) = H("run", producer, conversation, run); used by every `run.*` record of that run
- tool span (16) = H("tool", producer, conversation, callId); used by the tool's start and end records; `parent.span.id` = run span
- heartbeats carry no trace, span, run or conversation.

Ingest dedupes native records on `(resourceId, event.id)`, so replays after a
crash or restart are idempotent.

## Reporter behaviour

- Loop every 10 s. Heartbeat every 300 s in its own request, even when there
  is nothing else to send. A heartbeat means "alive and delivering": while
  event delivery has failed continuously for 300 s or more, or the reporter is
  stuck re-reading the same unread bytes, heartbeats stop so Activity shows the
  gap as stale instead of healthy.
- Files first seen with an mtime older than the reporter's first start are
  skipped to EOF (no historical backfill); files created later are read from
  offset 0.
- Offsets advance only after a 200 response. On 400/413 drop the batch and
  advance. On 401 attempt renewal once; if renewal fails record `expired`
  locally and back off (re-read the credential file every loop so a pushed
  replacement is picked up). On 403/404 back off 5 min. On 5xx, network and
  incomplete-read errors back off exponentially up to 5 min.
- Renew when less than half of the 7-day lifetime remains (`expiresAt - now <
  3.5 days`); write the new credential atomically.
- Parse cost is bounded, not just line length: a line is parsed as JSON only
  when it is at most 4 MiB and a cheap byte count of `{` and `[` shows at
  most 100k containers; the unit's memory ceiling must hold the worst
  admitted line with margin. Any other line is never fully parsed, the offset
  still advances, and only a bounded head and tail (8 KiB each) may be
  inspected with fixed patterns to recover structural fields such as `type`,
  `payload.type`, `call_id`, `tool_use_id`, `is_error` and `timestamp`. A line that crashed the reporter
  is skipped on the next start (in-progress marker), so one line can never
  blind a computer permanently.
- Parser state is bounded: open runs and tools older than 24 h are pruned and
  entries for deleted files are dropped; truncated or replaced files
  (inode change or size below offset) restart from 0 with fresh parser state.

## Credential lifecycle

- Token: `hvra_otlp_v1` HMAC token, claims `{v:1, userId, resourceIds:[agentId], iat, exp}`, TTL 7 days.
- Issued at launch (claude-code/codex on Proxmox) and re-issued on every
  start, restart, resize and runtime update of such a computer. Both paths
  record issuance in `hivra_activity_collectors`.
- `POST /api/activity/collector/renew` (bearer token + `X-Hivra-Resource-Id`,
  body `{}`): requires a valid, unexpired token scoped to exactly that one
  resource; the agent row must belong to the token's user, have `status` and
  `desired_state` other than `deleted`, and be a supported type. Returns
  `{token, expiresAt}` with a fresh 7-day token. Returns 429 if the presented
  token was issued less than 1 hour ago.
- Ingest and renewal both refuse a resource whose `status` or
  `desired_state` is `deleted`, so deletion revokes collection immediately.
- Expired tokens are rejected (401). Ingest records `last_rejected_reason =
  'expired'` for a correctly signed but expired token so Activity can show an
  explicit expired state instead of silence.

## Storage

`hivra_activity_collectors` (one row per agent; service role only):
`agent_id` (pk), `user_id`, `issued_at`, `credential_expires_at`,
`issue_reason` (`launch|start|renew`), `last_heartbeat_at` (server receive
time), `last_event_at`, `last_rejected_at`, `last_rejected_reason` (`expired|clock_skew`),
`last_install_status` (`installed|failed`), `last_install_reason`,
`last_install_at`, `updated_at`. Heartbeat timestamps are not subject to the
event time window (liveness uses the server receive time), so a guest with a
wrong clock still shows as reporting. Heartbeats never become `hivra_agent_events` rows.

Native events are stored in `hivra_agent_events` with `event = 'otel_log'`,
`detail.source = 'otlp_log'`, and `detail.telemetry` extended with
`role`, `producer`, `toolName`, `durationMs`, `conversationId`,
`parentSpanId`, `errorType`; the feed re-validates every field on read.

## Retention and deletion

Records stay content-free (no prompts, commands or file contents), and they are
kept for a bounded time (migration `20260923190000_hivra_activity_retention.sql`):

- **Computer deleted:** when `hivra_agents.status` becomes `deleted` (only after
  verified teardown, on every delete path), the trigger
  `delete_hivra_activity_after_agent_delete` deletes that computer's
  `hivra_agent_events` rows (up to 20,000; the job removes any rest) and its
  `hivra_activity_collectors` row in the same transaction. A `deleted`
  lifecycle event that a delete path logs after the flip is kept as a
  tombstone and ages out with the window. No audit consumer needs the rest:
  billing reads its own ledgers, and ops reads `ops_events`.
- **Age:** `/api/cron/prune-hivra-activity` (daily) calls
  `prune_hivra_activity(cutoff, batch, dry_run)` in bounded batches to delete
  rows older than `ACTIVITY_RETENTION_DAYS` (default and maximum 90, minimum 30), plus
  leftovers of computers deleted before the trigger existed. It is OFF unless
  `ACTIVITY_RETENTION_ENABLED=true`; while off, every run is a dry run that
  reports counts. `?dryRun=1` forces a preview.
- **Account deleted:** `ACCOUNT_DELETION_TABLES` deletes both tables by
  `user_id`. Account deletion refuses to apply while the user still has a Hivra
  computer that is not deleted.

## Coverage states (per computer, capability `native_tracing`)

Evaluated in order, first match wins:

1. `degraded`: the collectors lane could not be read.
2. `unsupported`: type is not `claude-code`/`codex`, or substrate is not `proxmox-kvm`.
3. `not_running`: agent status is not `running` (silence expected).
4. `missing`: no collector row (launched before reporting existed, or issuance failed), or the last install attempt after the latest issuance failed and nothing has checked in since ("could not be installed"; this outranks expiry).
5. `expired`: `credential_expires_at <= now` and a reporter checked in with that credential (otherwise `missing`, "never checked in"), or an `expired` rejection was recorded after both the latest issuance and the latest heartbeat.
6. `configured`: no heartbeat since the latest issuance, and that issuance was less than 10 min ago ("waiting for first report"; covers a fresh launch and a restart that re-issued the credential).
7. `missing`: issued 10 min or more ago and never heard from.
8. `stale`: last heartbeat older than 15 min, or the reporter checks in but its run records were refused for a wrong guest clock (`clock_skew`) within the last 15 min.
9. `observed`.

`stale` and `expired` on a running computer are Needs-attention items.
`run.failed` is Needs attention unless it is `run.stopped`. `tool.failed` is a
warning in History and in the run, not Needs attention.

## Run view

Runs group by `(agentId, runId)`. A tool's start and end records pair on span
id into one step. Run status comes only from an explicit `run.completed`,
`run.failed` or `run.stopped`; otherwise "No finish reported yet". A run whose
`run.started` is outside the loaded window is marked incomplete. Subagent runs
appear as their own runs in the same conversation.
