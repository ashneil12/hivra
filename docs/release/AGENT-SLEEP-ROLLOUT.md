# Agent sleep and wake: rollout

Idle agents nap (VM paused, memory kept) and then hibernate (VM saved to disk,
memory freed). Opening the agent, or any user action on it, wakes it first.
Everything is off by default.

## Switches

All of these must allow it before an agent sleeps:

| Switch | Where | Values |
|---|---|---|
| `HIVRA_SLEEP_MODE` | server env | `off` (default), `observe` (log only), `canary`, `on` (both require an eligible saved sleep policy) |
| `HIVRA_SLEEP_TRIM_MEMORY` | server env | `1`: a running computer writes out and drops its file cache just before it sleeps, so the host gets that memory back during a nap and a hibernate saves less. A failed trim never stops the sleep. Unset (default) is off |
| `proxmox_hosts.sleep_mode` | database, per host | `off` (default), `canary`, `on` |
| `hivra_agents.sleep_policy` | database, per agent | `off` (default), `t1`, `t3`, `full` |
| `hivra_agents.always_on` | database, per agent | `true` means never sleep |
| `NEXT_PUBLIC_HIVRA_AGENT_SLEEP` | build env | `1` shows the Asleep status, wake-on-open and the Manage settings |

Optional timing: `HIVRA_SLEEP_NAP_AFTER_SECONDS` (default 300) and
`HIVRA_SLEEP_HIBERNATE_AFTER_SECONDS`.

Automatic nap and hibernate require a saved policy that permits the tier and
Keep awake off, in either acting server mode. The sleep lease checks those
settings again before granting the action. An authenticated owner's separate
Sleep now action does not require an idle sleep policy.

Managed holder-funded computers also require a stored opt-in. Once enabled,
their timings are fixed at four idle minutes before nap and twelve more minutes
before saving memory. Server and host gates, activity checks and wake readiness
still apply.
See [token-holder access](../STATUS.md#token-holder-access) for launch requirements.

`NEXT_PUBLIC_` values are built in, so they take effect on the next Git build
of the branch, not when they are saved.

## Turning it on for one host and one agent

```sql
update public.proxmox_hosts set sleep_mode = 'canary', updated_at = now() where id = '<host id>';
```

Set `HIVRA_SLEEP_MODE=canary` and `NEXT_PUBLIC_HIVRA_AGENT_SLEEP=1` and let the
branch rebuild. On the scoped QA computer, sign in as its owner and enable
**Sleep when idle** under Manage with **Keep awake** off. Do not set an owner
policy directly in the database. The `sleep-idle-agents` cron runs every minute.

## Paid KVM placement

New paid KVMs that support idle sleep prefer a sleep-enabled host in the
existing managed rotation. A host must pass the normal placement and live
admission checks. If none can take the request, normal placement can still
choose a host with sleep off. An explicit operator host pin overrides the
preference. Confirm the effective pin and rotation before testing a release;
this preference does not expand the rotation. On the canonical Git Canary
deployment with the existing sleep and owner-wake flags acting, new eligible paid
managed KVMs start with the disk-only policy (`t3`). The sweep can hibernate
them directly after 12 idle minutes; a live session, job, terminal, unsupported
channel or an unavailable safety signal still prevents sleep. Existing
computers and holder seat terms keep their stored policy. Production launch
defaults are unchanged.

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

For schedules the guest probe understands, the sleep lease records
`next_wake_at` before the host can suspend the VM. If the reservation fails
or the host's last probe sees a different next job, the VM stays awake. A
hibernate from a nap keeps the existing reservation. The sleep event for the
original transition includes `next_job_at` and `scheduled_wake_at` when a job
is pending. Compare a schedule-triggered wake with the guest scheduler's own
run history: a wake event isn't proof that the job ran, and a job that only
runs after an owner opens the computer doesn't count as a scheduled wake.

Agents with a live chat channel that has no verified wake coverage stay awake.
For Discord, an allowed DM list for catch-up does not cover a new DM, so a bot
that accepts DMs stays awake even if one or more DM channels are on the list.
An agent the idle check cannot read counts as busy.

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
Matrix push gateway can wake it on eligible email and Matrix messages. The
Discord doorbell can detect messages but does not guarantee DM replay. Every
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

### Order for a host

1. Set the server switches above, then let the branch rebuild: server values
   also take effect only on a new deployment.
2. Set the host's `ingress_mode`, check the bundle sync has the wake proxy's
   release on the host, then run `install-wake-proxy` and `wake-proxy-status`.
3. Move one agent with the enable route, check `/status`, and time a few naps
   and wakes from `hivra_agent_sleep_events` before moving the next.
4. Run the rollback route and the enable route again once, to prove the way
   back, before leaving any agent on the host.

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

## WhatsApp Cloud wake

Not built, and there is no switch for it. A Hermes agent with a live WhatsApp
Business Cloud API channel (`hermes:whatsapp_cloud`, any `WHATSAPP_CLOUD_` key
in `~/.hermes/.env`) has no wake adapter, so it never sleeps. Listing
`whatsapp_cloud` in `HIVRA_CHANNEL_WAKE_CHANNELS` changes nothing.

The plan was: while the agent sleeps, point the phone number's callback
override at Hivra (`POST /<phone number id>` with
`webhook_configuration.override_callback_uri`), answer 503 so Meta redelivers,
wake the agent, and remove the override before the resume. Checked on
2026-11-17 against Meta's webhook pages and Hermes's `whatsapp_cloud` plugin:

- Confirmed: the override can be set, read and removed per phone number with
  the agent's own access token; a delivery that does not get a 200 is retried
  "with decreasing frequency" for up to 7 days; Hermes takes a redelivery as a
  normal message and drops duplicates by message id.
- Not documented, and it decides whether a message is lost: whether a retry
  goes to the callback that is current when it runs, or stays with the address
  that failed. If it stays, the message that woke the agent never reaches it.
- Not documented: when the retries come. Meta says "immediately", then a few
  more over 7 days. The immediate one lands while the agent is still waking, so
  the reply could be minutes or hours late.
- Hivra sets up WhatsApp through the QR bridge only (`WHATSAPP_ENABLED`). The
  Cloud API needs a public https address for port 8090 in the computer, which
  Hivra does not provide; only an owner who runs their own tunnel has one.
- Removing the override runs while the computer is still asleep, so the server
  would have to keep the access token (encrypted, as Telegram wake does). The
  channel wake table keeps fingerprints only.

To build it: a test Meta app and number to measure both undocumented points,
then an encrypted credential store and an owner switch.

## Host capacity alerts

With sleeping agents a host holds more agents than fit in its memory at once.
The `hivra-host-capacity` cron (every 5 minutes) reads each active host with
one read-only script and raises an ops event when a host, or every host, is
close to full. It never changes an agent or a host.

| Switch | Where | Values |
|---|---|---|
| `HIVRA_HOST_CAPACITY_ALERTS` | server env | `off` (default), `on` |
| `HIVRA_HOST_CAPACITY_DISK_WARN_PERCENT` | server env | default 80 |
| `HIVRA_HOST_CAPACITY_DISK_CRITICAL_PERCENT` | server env | default 90 |
| `HIVRA_HOST_CAPACITY_RAM_MARGIN_MB` | server env | default 2048 |
| `HIVRA_HOST_CAPACITY_STANDARD_AGENT_RAM_MB` | server env | default 8192 |
| `HIVRA_HOST_CAPACITY_HOSTS` | server env | comma list of host ids to read; unset reads every active host this deployment can reach. Set it where one registry lists hosts another deployment owns |
| `HIVRA_AGENT_MEMORY_SAMPLING` | server env | `1`: the capacity check also records each running agent's memory use without file cache (read from the host, no guest command) into `hivra_agent_memory_use`: the last sample and a daily peak for 14 days. Needs migration `20261117170000`. Unset (default) is off |
| `HIVRA_AGENT_MEMORY_FLOORS` | server env | `dry`: the daily memory floors run only reports what it would set. `on`: for each awake agent with at least a day of samples it sets the VM's balloon minimum to twice its measured peak plus 512 MB (never under 1 GB; an agent that uses most of its memory keeps all of it), so a host that runs short may take back unused memory. `restore`: gives every agent with a floor its full memory back. Honours `HIVRA_HOST_CAPACITY_HOSTS`. Needs migration `20261117180000`. Unset (default) is off |
| `HIVRA_SLEEP_DROP_MEMORY_AFTER_DAYS` | server env | A number of days (1 to 365). An agent that has been in deep sleep that long has its saved memory dropped and keeps its disk: the sleep sweep frees the saved-memory volume on the host (at most 2 agents a run) and leaves a mark, and the next wake admits and boots the computer from its disk (slower than a restore: allow about a minute). A stopped computer without the mark is still never started by a wake. Needs migration `20261117190000`. Unset (default) is off: nothing is dropped, and the wake script is unchanged |
| `HIVRA_SLEEP_STORE_AFTER_DAYS` | server env | A number of days (1 to 365). An eligible holder-funded computer whose saved memory was dropped and that has still not been used after this many days asleep has its disks packed into the backup storage and freed on the host. The computer itself (its number, settings and address) stays on the same host. The sleep sweep starts at most one such job per host at a time, uploads every disk, reads the copy back and compares it, checks the disk did not change meanwhile, and only then frees it and leaves a `stored` mark. A wake of a stored agent never boots the empty disks: it asks for the disks to come back, the sweep restores them ahead of any new packing on that host, and then wakes the agent (minutes, not seconds: about 3 on the first Canary test, of which the copy back was 68 s and the boot 35 s). The wake request also starts that work right after its response, and while an agent is on its way back the sweep looks again every few seconds within a run, so the wait is the copy and the boot rather than the sweep's once-a-minute clock. Bringing agents back keeps working when this setting is later unset. Paid and unknown funding keys are not eligible for new disk offloads; this does not change normal sleep and wake or strand an already-offloaded computer. Needs `HIVRA_SLEEP_DROP_MEMORY_AFTER_DAYS`, the computer backup key and storage (`HIVRA_COMPUTER_BACKUP_KEY`), and migrations `20261118010000` and `20261128164100`. Limits: the agent returns to the same host only, and a backup or packing job already running on that host is not interrupted, so a return waits for it. Unset (default) is off: nothing is packed |
| `HIVRA_WAKE_MAX_CONCURRENT_PER_HOST` | server env | How many deep-sleep wakes one server starts at once (1 to 32). A wake that finds them all taken waits for a turn, asking again every 3 s for up to 75 s while the agent shows as waking, and only then ends as `capacity_concurrency`. Each wake still passes the server's memory check. Measured on Canary: one wake takes 12 to 18 s; with two at once, ten together did not all fit the wait. Unset (default) is 4; the older `HERMES_WAKE_MAX_CONCURRENT_PER_HOST` is honoured when this is unset |
| `HIVRA_WAKE_MAKES_ROOM` | server env | `on` lets a deep-sleep wake that the server refuses for memory (`capacity_host_ram`, or the start's own `capacity` check) make room first: the server's longest-idle napping computers go into deep sleep, one at a time, and the wake is asked again after each. At most 4 nappers and 45 s per wake; an awake computer is never touched, and a napper with a job due soon is skipped. The wake event records `room_deepened` and `room_ms`. Unset (default) refuses the wake as before |
| `proxmox_hosts.wake_headroom_ram_mb` | database, per host | memory kept free for wakes (default 8192) |

Migration: `20261117150000_proxmox_hosts_capacity_reading`. Apply it before
turning the switch on.

A reading is the host's total and available memory, the size and fill of the
disk pool (the thin pool holding the VM disks and the saved memory of
hibernated agents, else the largest active `pvesm` image storage), the
running, paused and stopped VM counts, and from the database the memory of
every Hivra-managed agent on the host (what is needed if all of them woke)
and of the hibernated ones. It is stored in `proxmox_hosts.capacity_reading`.

| Reason | Warn | Critical |
|---|---|---|
| `ram_available_low` | available memory below wake headroom plus the margin | below the wake headroom |
| `disk_pool_high` | pool at 80% | pool at 90% |
| `wake_would_not_fit` | | the largest hibernated agent needs more memory than is available |

`oversubscriptionRatio` is the agents' memory over the host's total; above 1
the host relies on agents being asleep. Other VMs on the host are not in it.

The paused count comes from `qm list --full 1`; the short listing shows a
paused VM as running and is used only when the full one prints nothing. Not
yet confirmed on a real host: check one reading's `vms` against the host
before relying on that number. The verdict does not use it.

Ops events (sources). Only `fatal` pages an admin, once per fingerprint.

| Source | Severity | When |
|---|---|---|
| `hivra.host_capacity` | `warn` | a host is at warn; repeats update the one event, the numbers are in its metadata |
| `hivra.host_capacity` | `fatal` | a host is critical; pages once per host per day while it lasts |
| `hivra.host_capacity_unread` | `error` | a host could not be read and its last reading is over 15 minutes old (or it has none) |
| `hivra.fleet_capacity` | `fatal` | no host with a reading has room for a standard agent above its wake headroom |
| `hivra.host_capacity_recovered`, `hivra.fleet_capacity_recovered` | `info` | once when it clears |

The fleet check counts each host's reading from this run, or its stored one
when the host missed a run and the reading is under 15 minutes old. A host
unread for longer does not hold the alert back; it is listed in the event's
`unread_hosts`. With no host read in a run there is no fleet alert, only the
unread events. The fleet event pages again once a day while it lasts, and
again when the fleet fills after having had room (at most once an hour).

One host gets 45 seconds, and no host is started after the first minute of a
run; a host not started counts as unread. If the cron cannot load its hosts
or agents (for example the migration is missing) it answers 500.

Placement: with the switch on, a new Hivra-managed agent is not placed on a
host whose reading is critical and less than 15 minutes old, as long as
another host takes it. No reading, an old reading, every host critical, or no
other host able to take the launch: placement behaves as it did before. A
user's existing host (their other agents live there) and a pinned host are
not skipped.

```sql
select id, capacity_reading_at, capacity_reading->>'level' as level,
       capacity_reading->'reasons' as reasons,
       capacity_reading->>'memAvailableMb' as available_mb,
       capacity_reading->'pool'->>'usedPercent' as pool_percent,
       capacity_reading->>'oversubscriptionRatio' as oversubscription
  from public.proxmox_hosts order by id;
```

Rollback: set `HIVRA_HOST_CAPACITY_ALERTS=off`. The cron does nothing and
placement stops reading the column; stored readings can stay.

## Rollback

Set `HIVRA_SLEEP_MODE=off`, or the host's `sleep_mode` to `off`. Nothing new
goes to sleep; sleeping agents still wake when opened. To remove the feature,
wake every sleeping agent first.

## A deep sleep that does not end cleanly

A save to disk that does not end cleanly leaves Proxmox's `suspending` lock on the computer. Every state read then saw a state it did not know, so the sleep operation was never settled and the computer could not sleep, wake or be deleted until someone ran `qm unlock` by hand. Seen on Canary on 2026-11-18 while 13 to 14 computers were deep-slept at once: the save finished, then QEMU's `quit` timed out, and the computer was left off, locked, with its complete saved state.

The deep sleep script now settles this itself right after the save returns an error, and the sweep's recovery does the same for a computer it finds in that state (`interrupted_save`), then settles the record from what the computer is. Two cases:

- The save finished and only its last step failed: the computer is off, saved state is recorded, and the save's own `State saved, quitting` line is in the journal of `hivra-sleep-<vmid>.service` since this save began. The computer is marked as saved (`lock: suspended`), exactly where Proxmox would have left it, and wakes later like any deep sleeper.
- The save failed: Proxmox has removed the partial state and kept the lock on purpose. The lock is taken off; a computer the save left paused is resumed, one whose QEMU died is left off.

Nothing is done while a save is still running, and saved state that is recorded without that proof is never touched: it may be partial, and that still needs a person. Logs: `sleep_interrupted_save_recovered` (warning), `sleep_interrupted_save_not_recovered` (error).
