---
name: hermes-fleet-move
description: Run, watch, pause, resume or troubleshoot the automatic move of old Hermes agents (hermes_instances) onto the official Hermes (hivra_agents type hermes). Use for "move the agents", "is the move wave running", a paused wave, a failed or needs-attention move, moving one agent by hand, or undoing a move.
---

# Moving old Hermes agents onto the official Hermes

Design and data flow: `docs/release/HERMES-OFFICIAL-MOVE.md`. Code: `dashboard/src/lib/hermes-move/`
(`orchestrator.ts` is the state machine, `wave.ts` the automatic wave, `guest-jobs.ts` the scripts on
the two computers).

Every old agent must move; owners have no button. The wave moves a few a day, emails each owner the
day before and after, and keeps the old computer switched off for 7 days as the backup (Undo in the
new agent's Settings). A failed move puts the old agent back as it was.

## Ground rules

- Canary first. Production changes only reach production through the owner's Promote; never turn the
  wave on in production unless the owner asked for it in so many words.
- Never print secrets: `key_encrypted`, `api_token`, `llm_api_key_encrypted` and `.env` values stay out
  of queries' output and out of chat.
- The repo is public: no customer ids, emails, hostnames or IPs in commits, PRs or this file.

## Look at the wave

```sql
select enabled, per_day, paused_at, paused_reason, resumed_at from public.hermes_move_wave;

select state, initiated_by, count(*) from public.hermes_computer_moves group by 1, 2 order by 1, 2;

-- moves in flight and recent endings
select id, instance_id, initiated_by, state, step, message, error, started_at, finished_at
from public.hermes_computer_moves
where state not in ('done', 'undone') or finished_at > now() - interval '2 days'
order by started_at desc limit 50;

-- agents still to move, and who has been told
select count(*) filter (where config ? 'moveNoticeAt') as told, count(*) as left_to_move
from public.hermes_instances
where status = 'running' and backend in ('webui', 'gateway') and deleted_at is null and config->'movedTo' is null;
```

The cron's own result (`/api/cron/advance-hermes-moves`) includes `wave: { state, queued, told, busy, skipped }`.

## Turn it on, change the pace, resume

Preferred: `POST /api/ops/hermes-moves` as an ops admin.

- On: `{ "wave": { "enabled": true, "perDay": 5 } }`. Start at 5 a day; raise once a few days run clean.
- Off: `{ "wave": { "enabled": false } }`. Moves already queued or running still finish.
- Resume after a pause: `{ "wave": { "resume": true } }`. Do this only after reading why it paused.

On Canary the same can be done in SQL through the Supabase connector:

```sql
update public.hermes_move_wave set enabled = true, per_day = 5, updated_at = now();
update public.hermes_move_wave set paused_at = null, paused_reason = null, resumed_at = now(), updated_at = now();
```

## When the wave pauses

Any automatic move ending `failed` or `needs_attention` pauses everything and raises the ops alert
"The Hermes move wave paused itself".

1. Read the move: `select state, step, error, failure from public.hermes_computer_moves where id = '<move id>';`
   `failure.setupLog` holds a redacted tail of the new computer's setup log when setup failed.
2. `failed`: the old agent was restarted and the new computer removed. Confirm with
   `select status from public.hermes_instances where id = '<instance id>'` (expect `running`) and the new
   agent's `hivra_agents.status` (expect `deleted`). Find the cause, ship the fix to Canary, then resume;
   the failed agent is retried on a later run because its owner has already been told.
3. `needs_attention`: the old agent could not be started again. Treat it as an outage for that owner:
   get the old agent running first (the old VM and its containers are untouched apart from being
   stopped), then fix and resume.

Past causes, all fixed: the guest image lacked `libatomic1`; the old compose project is the bare
instance id, not `agent-<id>`; the checks wanted exact counts though the official install adds its own
bundled skills; old `.env` paths pointed at `/home/hermes`.

## Move one agent by hand

Through the ops route: `{ "instanceIds": ["<instance id>"] }` (add `"dryRun": true` to check it is
eligible). Or on Canary in SQL (the cron starts it within 2 minutes):

```sql
insert into public.hermes_computer_moves (user_id, instance_id, initiated_by, message)
select i.user_id, i.id, 'operator', 'Waiting to start.'
from public.hermes_instances i
where i.id = '<instance id>' and i.status = 'running' and i.deleted_at is null and i.config->'movedTo' is null
  and not exists (select 1 from public.hermes_computer_moves m where m.instance_id = i.id
                  and m.state not in ('done', 'failed', 'needs_attention', 'undone'))
returning id, state;
```

A move takes about 15 minutes: new computer (about 7), pack, copy, unpack and check, switch over.
Watch it with the move query above every few minutes, not in a tight loop.

## After a move

- `state = done`, the old row is `scheduled_for_deletion` with `config.movedTo`, the new agent is
  `running`. The owner can undo until `undo_until`.
- Check the new agent answers a chat message (the owner, or a test account on Canary). A health check
  alone is not proof.
- An owner who undoes is left out of the wave; find out why before moving them again by hand.
