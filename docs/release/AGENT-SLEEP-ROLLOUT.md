# Agent sleep and wake: rollout

Idle agents nap (VM paused, memory kept) and then hibernate (VM saved to disk,
memory freed). Opening the agent, or any user action on it, wakes it first.
Everything is off by default.

## Switches

All of these must allow it before an agent sleeps:

| Switch | Where | Values |
|---|---|---|
| `HIVRA_SLEEP_MODE` | server env | `off` (default), `observe` (log only), `canary` (only agents with a sleep policy), `on` |
| `proxmox_hosts.sleep_mode` | database, per host | `off` (default), `canary`, `on` |
| `hivra_agents.sleep_policy` | database, per agent | `off` (default), `t1`, `t3`, `full` |
| `hivra_agents.always_on` | database, per agent | `true` means never sleep |
| `NEXT_PUBLIC_HIVRA_AGENT_SLEEP` | build env | `1` shows the Asleep status, wake-on-open and the Manage settings |

Optional timing: `HIVRA_SLEEP_NAP_AFTER_SECONDS` (default 300) and
`HIVRA_SLEEP_HIBERNATE_AFTER_SECONDS`.

`NEXT_PUBLIC_` values are built in, so they take effect on the next Git build
of the branch, not when they are saved.

## Turning it on for one host and one agent

```sql
update public.proxmox_hosts set sleep_mode = 'canary', updated_at = now() where id = '<host id>';
update public.hivra_agents set sleep_policy = 'full', always_on = false where id = '<agent id>';
```

Then set `HIVRA_SLEEP_MODE=canary` and `NEXT_PUBLIC_HIVRA_AGENT_SLEEP=1` and
let the branch rebuild. The `sleep-idle-agents` cron runs every minute.

## Checking it

Every sleep and wake writes a row with its timings:

```sql
select at, kind, trigger, from_state, to_state, duration_ms, reason, detail
  from public.hivra_agent_sleep_events
 where agent_id = '<agent id>'
 order by at desc
 limit 20;
```

`detail` breaks the time down by step as `<step>_ms` keys (state read, probe,
suspend, admission, start, resume, fixup), with `script_ms` for the host
script and, for a wake, `total_ms` end to end.

Agents with live chat channels (Discord, Slack, WhatsApp and similar) never
sleep. Telegram is the exception below. An agent the idle check cannot read
counts as busy.

## Wake on Telegram messages (Hermes)

A Hermes agent whose only live channel is Telegram can sleep once its owner
turns on **Wake on Telegram messages** in Manage › Settings. While it sleeps,
the bot's webhook points at Hivra; the first message wakes the agent, the
webhook is removed before the computer resumes, and Hermes reads the queued
messages itself. It never replaces a webhook someone else set.

| Switch | Where | Values |
|---|---|---|
| `HIVRA_TELEGRAM_WAKE` | server env | `off` (default), `canary`, `on` |
| `HIVRA_TELEGRAM_WAKE_SECRET` | server env | random, at least 32 characters |
| `HIVRA_TELEGRAM_WAKE_BASE_URL` | server env | the site's public https origin |
| `NEXT_PUBLIC_HIVRA_TELEGRAM_WAKE` | build env | `1` shows the setting |

Migrations: `20261113100000_hivra_agent_telegram_wake` and
`20261113101000_hivra_agent_telegram_wake_after_failed_wake`.

To check a bot, compare `getWebhookInfo` with the agent's state: an awake
agent must have no webhook. Rows live in `public.hivra_agent_telegram_wake`
(state, failures, block time; the token is encrypted).

Rollback: set `HIVRA_TELEGRAM_WAKE=off` and keep the secret set until the
rows read `idle`. The sweep removes Hivra's webhooks and wakes any covered
agent that is asleep.

## Wake speed-ups

| Switch | Where | Values |
|---|---|---|
| `HIVRA_FAST_WAKE` | server env | comma list of `timing`, `fast_healthz`, `fast_qm`, `early_finish`, `deferred_log`, or `all` |
| `NEXT_PUBLIC_HIVRA_FAST_WAKE` | build env | `early_wake`: the page sends its wake beside its first read |

`timing` adds `host_ms` and `ssh_ready_ms` to each wake's `detail`, which
splits host time from connection time.

## Rollback

Set `HIVRA_SLEEP_MODE=off`, or the host's `sleep_mode` to `off`. Nothing new
goes to sleep; sleeping agents still wake when opened. To remove the feature,
wake every sleeping agent first.
