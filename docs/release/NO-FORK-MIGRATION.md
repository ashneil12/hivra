# Moving existing agents onto upstream Hermes, and keeping them there

Status: built and proven on Canary with disposable boxes. Nothing here has touched a production or
customer box (PROD HOLD is on). Evidence level is marked on every claim: PROVEN (run, output seen),
SOURCE (read in code or covered by a test), UNVERIFIED (not run).

Date: 2026-10-09. Follows `docs/release/NO-FORK-PLAN.md` (why there is no fork) and uses the overlay in
`agent-overlay/`.

## 1. What the user sees

A button on the agent page: **Update to latest Hermes**.

> Your chats, memory, skills, settings and files stay exactly as they are. We back everything up first
> and check it all afterwards. If anything is off, your agent goes back to how it was by itself. Your
> agent restarts once, in about five minutes.

While it runs the card lists five real steps and ticks them off as the box reports them (no invented
percentages): checking the agent is ready, backing up everything, installing the new version, checking
chats, memory, skills and files are all still there, turning on updates straight from Hermes.

It ends in one of three honest states:

- **Your agent runs the latest Hermes.** The box is on upstream Hermes and follows upstream by itself.
- **Not updated, and nothing was lost.** Something did not check out, so the box put everything back
  and says what. (The agent is as it was; the old version keeps running.)
- **The update needs attention.** Rollback itself could not prove the data identical. The backup is kept
  and the box is paused for an operator. This is the only state that needs a person.

Nothing is shown unless the release registry offers an overlay release to that box and the box is
running on the old image. A box that already moved never sees the card again.

## 2. What the move does (on the box)

One script runs on the box as a detached unit, so closing the browser does not interrupt it. Source:
`dashboard/src/lib/services/no-fork-migration-builder.ts`. Operators get the same script from
`dashboard/scripts/nofork-migrate-emit.ts`.

| Phase | What happens | Changes anything? |
|---|---|---|
| preflight | agent and dashboard container healthy; compose file valid; idle for 45 minutes (skipped by `HERMES_MIGRATE_FORCE=1`); free disk; downloads the overlay release and the stock upstream image it names, by digest, and checks the digest matches | no (only downloads) |
| snapshot | stops the agent briefly; reads a manifest of everything the user owns; backs up the state volume, compose, env, config, Caddy file, web bundles and the update units; keeps a copy of the old agent files as a volume; keeps the old image under a local tag | stops the agent |
| switching | stages the overlay, points the two agent services at the local image (official upstream plus the box's own `uv`, `gh`, `hermes`), removes a stale `HERMES_HOME` line, sets explicit Venice media providers on managed-Venice boxes, installs the new web bundles, reseeds the agent files from the new image with the overlay over them, starts | yes |
| verifying | both containers healthy and on the new image; the agent API answers with its key; the overlay loads; `uv`, `gh`, `hermes` on the agent's PATH; the manifest is compared with the one taken before; chats not lost | no |
| finishing | writes the upstream pin, installs the self-update stack for the local image, clears its own pause, records the result | yes |

Any failed check from the first stop onward runs the **rollback**: stop, put back compose, env, config,
Caddy file, the state volume (the new version may have upgraded the databases in place), the web
bundles, the update units and the old agent files, remove the local image tag, start the old image,
re-read the manifest and require it to be identical, only then report "not updated". If it cannot prove
that, it says "needs attention" and keeps the backup.

The check list for the user's data (`NOFORK_MANIFEST_PY`): every file in the state volume and the
workspace by hash (cache, logs, runtime locks and the box's own tool directory are skipped); every table
of every database by row count and row ids (a replaced row fails, a row added by the running agent does
not); env keys by name; config by parsed setting. Built-in skills Hermes refreshes itself are allowed to
change, **except** ones the user edited (the list comes from Hermes' own `list_user_modified_bundled_skills`);
a user's own skills must be byte identical.

The workspace volume is never written to, never copied, and compared by hash before and after.

## 3. After the move: no dependence on Hivra

Proven (section 6): with the control plane unreachable, a migrated box found a newer upstream Hermes by
itself, waited out the soak, took it, health-checked it and kept every chat.

How it works after the move:

- The box runs `hivra-local/hermes:stable`, a **local-only** tag. It is the official
  `nousresearch/hermes-agent` image with three small files added locally (`uv`, `gh`, a `hermes`
  wrapper). Nothing Hivra builds is in the loop; the tag cannot be pulled, so nothing can silently swap it.
- The box's hourly roll (the existing idle-gated update stack) now has a **direct mode** (marker file
  `/var/lib/hermes-upstream-direct-<id>`). It reads the policy in `<instance dir>/upstream.ref` (default
  `nousresearch/hermes-agent:stable`; only `nousresearch/hermes-agent` is accepted), pulls the official
  image (Docker verifies the content against its digest), lets a new digest **soak 24 hours**, adds the
  overlay tools locally, reseeds the agent files with the box's overlay over them, rolls with the same
  idle gate, last-known-good, session-survival check and automatic rollback every box already has.
- If the dashboard is reachable and says "hold", the box obeys (a bad release can be stopped by Hivra).
  If it is unreachable or says nothing, the box carries on by itself. It never waits for Hivra.
- The overlay lives in `<instance dir>/overlay/` (files, tools, web bundles). It is add-only and is laid
  over every fresh agent source, including the control plane's own update path (`agentSourceSeedCommand`).

What still comes from Hivra, and only that:

1. The dashboard and control plane (billing, access, chat window, console).
2. **Optional** overlay updates (new Hivra plugins, new web bundles for a new upstream), delivered as a
   new overlay release through the same one-click move. A box that never takes one keeps working on the
   overlay it has; the web bundle is then frozen at the version it had until an overlay update, which
   is the one honest coupling left: a future upstream may outgrow an old bundle (SOURCE, UNVERIFIED).

If Hivra's control plane is down: chat through the box's own address, the agent, cron, memory, skills,
channels and the box's own self-update all keep working. Nothing in the move or the update path calls
the control plane except best-effort status reports (they log "dashboard report failed - continuing").

## 4. Operator runbook

All commands run as root on the guest. Replace `<id>` with the instance id.

Start from the operator side (same script the button runs):

```
cd dashboard
npx tsx scripts/nofork-migrate-emit.ts --instance <id> --overlay <overlay image ref> --launcher > launch.sh
# add --force to skip the 45 minute idle gate (never on a customer box without their say-so)
# push launch.sh to the guest and run it with bash: it installs the script and starts a detached unit
```

Read progress, any time:

```
/usr/local/bin/hermes-nofork-migrate-<id> status      # JSON: state, phase, message, checks, snapshot path
tail -f /var/log/hermes-nofork-migrate.log
```

Pre-flight a whole host before a wave (read-only, one line per box, `PASS` or `FAIL:<why>`): run
`agent-overlay/scripts/fleet-preflight-check.sh` through the fleet audit's `--check-file`. It reports
free disk, healthy containers, compose shape, a compose override, state.db integrity, a paused roll and
the idle gate.

Go back, during the soak (the old image and old agent files are still there):

```
systemd-run --unit=hermes-nofork-revert-<id> --collect --property=Type=exec \
  /usr/local/bin/hermes-nofork-migrate-<id> revert
```

Revert puts the data back **as it was at the move**. What happened since is saved first at
`<backup dir>/state-at-revert.tgz`, so nothing is destroyed. Revert also puts back the old update units.

Clean up after the soak (7 days is the proposal): `hermes-nofork-migrate-<id> cleanup` removes the kept
old image and old agent files and all but the newest two backups. Until then the box carries about 4 GB
more than it needs; the pre-flight refuses boxes without the room.

Failure states and what to do:

| State | Meaning | Do |
|---|---|---|
| `refused` | a pre-flight check said no; nothing changed | read the message (idle, disk, health), fix, retry |
| `rolled_back` | a check failed after the stop; box restored and proven identical | read `<backup dir>/diag-*.log` (the new version's logs are kept), fix the cause, retry; if it repeats, stop and tell the platform owner |
| `failed` | rollback could not prove identical data | do not retry. The backup dir has `state.tgz`, compose, env, units. Restore by hand from it, then stop |

Also on the box: the roll pauses itself after a failed update (`/var/lib/hermes-roll-paused-<id>`). The
move never clears someone else's pause; it only clears its own.

## 5. What changed in the repository

- `dashboard/src/lib/services/no-fork-migration-builder.ts`: the box script, launcher, manifest tool,
  compose edit.
- `dashboard/src/lib/services/idle-gated-update-builder.ts`: direct mode (control plane unreachable is
  not a stop, soak, local overlay assembly, official-repo-only), the overlay laid over every reseed, and
  **a fix for a latent fleet bug**: on a box whose compose uses the current managed gateway command the
  hourly roll found neither of the two old `uv` forms and paused itself with "compose migration
  mismatch" (found when a migrated box tried its first roll). It now treats that compose as already
  migrated. Regression test red without the fix, green with it.
- `dashboard/src/lib/services/webui-instance-builder.ts`: the control plane's own agent-source reseed
  lays the box overlay over the fresh files when one exists.
- `dashboard/src/lib/hermes-releases/live-update.ts`: a box on the local image is never pulled or moved
  by the control plane (policy `keep`).
- `dashboard/src/lib/hermes-releases/no-fork.ts`, `src/app/api/instances/[id]/migrate-no-fork/route.ts`,
  `src/components/instances/NoForkMigrationCard.tsx` and the agent page: the offer, the start (owner
  only, 409 when nothing is offered or one is already running), the honest progress, and the record
  (`config.webuiAgentImage` = the local image, `config.agentSource` = `upstream-overlay`) written only
  after the box itself reports done.
- `agent-overlay/Dockerfile`: writes `hivra_overlay/FILES.txt` (exactly which paths are overlay) and
  re-declares `UPSTREAM_IMAGE` in the final stage. **The label `io.hivra.upstream.image` was coming out
  empty** (a global build arg is not visible inside a stage); the move reads that label to know which
  official image the release was built on, and refused until this was fixed.
- `agent-overlay/scripts/fleet-preflight-check.sh`.

Tests: `no-fork-migration-builder.test.ts` (script safety, ordering, every rollback, the embedded
manifest and compose tools run for real), `no-fork-update-path.test.ts`, `no-fork.test.ts`,
`NoForkMigrationCard.test.tsx`, the route test, `live-update.test.ts`, and in
`idle-gated-roll-releases.test.ts` the direct-mode and managed-compose cases against the real roll script.

## 6. What was proven on Canary

Two disposable boxes, both seeded through the agent's real API (real tool loop, stub model): 16 chats,
a memory file and a user profile, a user-written skill, a scheduled job, 2 workspace files (one with 500
lines), and a custom model setting. The second box is a clone of the Canary fixture on its own address
with its dashboard address pointed nowhere (so it also stands in for "Hivra unreachable"). Nothing else
was touched: not the retained computers, not the three QA banner boxes, no customer box.

Verification used the agent's own surface (the API with its key, the CLI inside the container, and the
workspace), diffed before and after.

| Test | Result |
|---|---|
| Idle gate | agent active 2 minutes ago: `refused ... moves after 45 idle minutes`, nothing changed (PROVEN) |
| **Forced failed move** (overlay with a planted import error) | new version never became healthy; `rolled_back`; state, compose, source, bundles restored; **every item identical** (16 chats and their message counts, cron job, memory, skill, workspace hashes, model setting) (PROVEN) |
| Move, box 2 (v0.20.5 fork to v0.21.6 upstream) | `done` in about 2 minutes; agent reports "Hermes Agent v0.21.6 upstream 818c13be"; **all user data identical**; `hermes`, `uv`, `gh` now on the agent's PATH (they were not before: the old image had no `hermes` for the agent's terminal) (PROVEN) |
| Move, fixture, through the idle gate with no force | `done`; data identical; public path afterwards: `/webchat/` 200 with the new bundle, `/dash/` 200, authenticated sessions call 200, unauthenticated 401 (PROVEN) |
| **Upstream release with Hivra unreachable** (box 2) | dashboard address dead; the roll logged "following upstream directly", pulled the official `rc.3-v0.21.7` image, soaked, added the overlay tools locally, rolled; agent reports v0.21.7; 16 sessions before and after; data identical; no pull from any registry but the official repository (PROVEN). The 24 hour soak was shortened by ageing the first-seen marker by hand; that is the only simulated step |
| Operator revert (fixture) | back on the fork image, update units restored, no pause, data identical (PROVEN) |
| Real failures the safety net caught while building | 3 times the "good" move rolled itself back for a real reason (the gateway's hardcoded `uv` path was missing, a probe that needed `docker exec -i`, Hermes refreshing built-in skills) and every time the box came back with its data identical; a fourth time the rollback's own check flagged a runtime marker file and wrongly reported "needs attention" (fixed) (PROVEN) |

Findings, all fixed in this change: the empty overlay image label; the `uv` path (`/usr/local/bin/uv`
is hardcoded in the gateway supervisor, so the tools are added to the image locally rather than to the
state volume); the roll's compose contract mismatch on current-generation compose; a rollback that
copied the old agent files back needed the network to rebuild (the old agent files are now kept as a
volume and put back with `cp -a`, and rollback also works offline of the registry).

Not proven, stated plainly:

- A real model reply. The test model is a stub that calls the real terminal tool.
- A connected channel (Telegram, Signal and so on): no bot token was available. Channel settings live in
  the env and the state volume, which the manifest covers by key name and by hash, but a live channel
  was not exercised.
- The dashboard button and route against a served Canary deployment. They need an overlay release in
  the release registry, which needs the `ghcr.io/ashneil12/hivra-hermes` package (owner step, staged in
  `decisions.md`). Covered by unit and route tests and the card tests only. The card is hidden until the
  registry offers a release, so shipping the code changes no box.
- The overlay image was built on the fixture and loaded locally, not pulled from a registry.
- Boxes with a connected wallet, large workspaces, or very full disks. The pre-flight refuses low disk;
  large workspaces are not copied but are hashed, which takes time (files over 20 MB are compared by size).
- Fleet facts: disk headroom, compose overrides and stale env lines on the 49 production boxes.

## 7. Production wave plan (hand to hivra-fleet-sre; GATED)

Do not start any of this. PROD HOLD is on, and each step needs Ash's go.

**Owner steps first (staged in `~/Projects/ops-notes/decisions.md`):**

1. Lift PROD HOLD, then Promote the dashboard with this change (the button and route are inert until a
   release exists).
2. Create the package `ghcr.io/ashneil12/hivra-hermes` (public pull) and a write token for the build
   machine.
3. Build and push the overlay as an immutable tag with `agent-overlay/scripts/build-overlay.sh` (never
   `:stable`/`:latest`), register it in the release registry (stage: canary channel, pilot list = the
   boxes in wave 2).
4. Decide keep/delete for the dormant metering seams, and whether to open the one recommended upstream
   PR (held lock) (see `NO-FORK-PLAN.md` section 11).

**Waves** (a wave starts only when the previous is clean for 24 hours; success is per-box evidence, never
`last_synced_at`):

| Wave | Boxes | Gate to enter | Evidence required |
|---|---|---|---|
| 0 | Canary fixture, through the dashboard button against a registered overlay release | owner steps 2 and 3 on Canary | card ticks through five steps; `done`; user-path diff identical; public path 200/401 |
| 1 | One real production box (Ash's, or the idlest) | Promote; pre-flight `PASS`; a fresh DB census | `status` = done; running image id and `hermes --version`; authenticated sessions 200; a real chat reply; the diff of chats, memory, skills, cron, workspace |
| 2 | One idle box per host (4 hosts) | wave 1 clean | same per host; disk after |
| 3 | 2 to 3 boxes per host per batch, then the rest | wave 2 clean | same; **stop on the first `rolled_back` or `failed`**, read the diag logs, fix the cause, retry |
| 4 | Soak, then `cleanup` on every box | 7 days after each box | disk reclaimed |

Pre-flight before each batch: run the fleet pre-flight check on the whole host. Defer busy boxes and
count them. Boxes that report a compose override, a paused roll, or low disk are listed and handled by
hand, not forced.

Rollback per box: the box rolls itself back on a failed check. After a clean move, `revert` during the
soak. A halted registry release stops the offer for boxes that have not moved.

After the fleet has moved and one upstream release has been taken by the boxes themselves, the fork
repositories can be archived (`NO-FORK-PLAN.md` section 8).

Honest cost to know: each box holds about 4 GB more during the soak (old image, old agent files,
backup). Boxes on small disks need the room first; the pre-flight says which.
