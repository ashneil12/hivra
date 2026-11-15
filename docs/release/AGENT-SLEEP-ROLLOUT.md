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

## Host ingress and wake on any message

The agent's public connector can move from its computer to the host, behind a
small wake proxy, so a request wakes a napping agent; host doorbells and the
Matrix push gateway wake it on email, Discord and Matrix messages. Every
switch is off by default, and each one only ever keeps agents awake when it
is off.

| Switch | Where | Values |
|---|---|---|
| `HIVRA_HOST_INGRESS` | server env | `off`, `canary`, `on`. `off` is the kill switch: the sweep wakes every host-served agent and never naps it |
| `HIVRA_INGRESS_SECRET` | server env | random, at least 32 characters. Derives each route's ticket key. Needed for any enable |
| `proxmox_hosts.ingress_mode` | database, per host | `off` (default), `canary`, `on` |
| `hivra_agent_ingress.mode` | database, per agent | `guest` or `host`, written only by the enable and rollback routes |
| `HIVRA_HOST_WAKE_PROXY_ENABLED` | server env | `true` allows the `install-wake-proxy` bundle action |
| `HIVRA_INGRESS_HOST_CREDENTIAL` | server env | `true` lets hosts call Hivra (`wake-report`, `wake-request`). The doorbells need it: without it they do not cover any channel, and the sweep wakes agents armed on them |
| `HIVRA_WAKE_DOORBELLS` | server env | comma list of `email`, `discord` |
| `HIVRA_CHANNEL_WAKE` | server env | `off` (default), `canary`, `on` |
| `HIVRA_CHANNEL_WAKE_CHANNELS` | server env | comma list, for example `matrix,email` |
| `HIVRA_CHANNEL_WAKE_SECRET` | server env | random, at least 32 characters. Unset means off, and it must stay set until every channel row reads `idle` |
| `HIVRA_FAST_WAKE` | server env | add `ingress_ticket` for the server's ticket wake through the proxy |
| client-wake level | per host, `ctl client-wake ticket\|auth` as root | `ticket` (default) |

Once any agent has been moved to the host, keep `HIVRA_HOST_INGRESS` set
(`off` is fine) and `HIVRA_INGRESS_SECRET` set: with both unset the server
stops reading ingress rows altogether, so the kill switch no longer runs.
Roll every agent back (`/api/ops/hivra/ingress/rollback`) before removing them.

Operator routes (bearer `CRON_SECRET`): `/api/ops/hivra/ingress/enable`,
`/rollback` and `/status` per agent; the `provisioner-bundle` route's
`install-wake-proxy`, `wake-proxy-status`, `remove-wake-proxy` and
`revoke-host-credential` actions per host, plus the doorbell's own install,
status and remove actions. Remove the doorbell before the wake proxy.

A cutover that was cut short (an enable stopped mid-run, or a rollback that
could not hand the computer a working token) leaves a guest-mode row in phase
`forwarder` or `host_connector`, or `failed` with `last_error`
`recovery_failed`, `detach_failed` or `guest_token_stale`. Such an agent is
kept awake until a rollback finishes it; run the rollback again.

## Agent wake profiles

`HIVRA_AGENT_PROFILES` (server env, `off` by default, or `on`). Off, the idle
probe is the fixed program it always was. On, the server hands the probe the
wake profiles (`dashboard/src/lib/hivra/agent-profiles/`) as data, and the
probe evaluates them: busy processes, activity directories, scheduled jobs,
chat channels and app ports. Detection always uses every profile, whatever
the agent's type, because a user can install any agent on any computer (a
desktop where Hermes runs cron jobs must not sleep through them); the type's
own profile only adds to it and chooses its wake sources and the CPU safety
net's processes. For Hermes, OpenClaw, Claude
Code, Codex and Agent Zero it gives the same answer the fixed probe gave
(the comparison tests run both on the same fixture computers). It also adds
two safety nets for every agent, with or without a profile:

- an established connection to a known chat service (Telegram, Discord,
  Slack, WhatsApp, matrix.org, Signal; resolved by the server when it probes,
  and again on the guest with a two-second deadline) that no declared
  channel's own process holds is the live channel `unknown:<platform>`, which
  nothing ever covers, so the agent stays awake. Only the process holding the
  socket counts as the channel's, never a process started under it. Matching
  is by address, so it is best effort: services with stable addresses
  (Telegram) are reliably seen; ones routed by region or edge (Slack,
  WhatsApp) may be missed when their addresses change;
- an agent process (any non-root process, or one the profile names) using
  25% or more of a core over half a second counts as busy.

With profiles on, Telegram wake also covers any type whose profile declares
where its bot token lives and that Telegram queues its messages (today Hermes
and OpenClaw, polling only). The owner's switch appears for those types.
Turning profiles off again leaves such an opt-in in place but uncovered: an
OpenClaw agent that is asleep still wakes on its bot, and stays awake after.
The owner still sees the switch, on, while it is on, so they can turn it off
and Hivra forgets the bot token; it cannot be turned on again.

### Adding a new agent type

Add one entry to `AGENT_WAKE_PROFILES` in
`dashboard/src/lib/hivra/agent-profiles/profiles.ts`, keyed by its
`hivra_agents.type`:

- `busy`: processes whose presence means work is running (a coding CLI);
- `agentProcesses`: its long-running processes, for the CPU safety net
  (`{ cgroup: "docker" }` for a container);
- `activity`: directories whose newest file time is its last use;
- `schedules`: where its scheduled jobs live, with a reader kind
  (`hermes-jobs`, `json-next-run`, `json-nonempty`, `crontab`, `dir-nonempty`);
- `channels`: where it records its chat channels (`env-keys`,
  `json-channels`, `yaml-enabled`, `gateway-state`, `systemd-env`,
  `systemd-active`), with the process that holds each connection;
- `wake`: per platform with a wake adapter, where the credential lives (an
  `.env` key or a JSON path) and how it catches up (`none`, `server-queued`,
  `backfill-setting`). Declare `server-queued` only when the agent really
  reads what queued while it slept; otherwise leave the platform out;
- `appPorts`: the loopback ports its app serves on.

The registry test fails until every type in `agent-catalog.ts` has an entry.
No probe code changes for a new type unless it stores something in a shape
no reader kind knows; then add the reader to `sleep/profile-probe-program.ts`.

Without an entry, the probe evaluates every known profile together (as for
every type) and keeps no wake source: nothing of it is covered, any chat connection keeps it awake,
and so does any busy agent process.

## Rollback

Set `HIVRA_SLEEP_MODE=off`, or the host's `sleep_mode` to `off`. Nothing new
goes to sleep; sleeping agents still wake when opened. To remove the feature,
wake every sleeping agent first.
