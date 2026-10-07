# Hermes agent releases

How a new Hermes agent image reaches the boxes. The release registry replaces the
floating `:stable` tag as the thing that decides which image a box runs.

## The idea

Every release is an exact image: a repository and a `sha256` digest, registered once
and never moved. A box is told to run `repo@sha256:...`, not a tag. A release goes
through a ladder, one rung at a time, and halts itself if boxes fail it:

| Stage | Who gets it |
|---|---|
| Registered | nobody |
| Canary | boxes enrolled in the canary channel |
| 1 box | the canary boxes plus one chosen pilot box |
| 10% | canary boxes, the pilot, and a stable 10% of the other boxes |
| 100% | every box |

The 10% is a hash of (release, box), so a box admitted at 10% stays admitted at 100%
and the same boxes are not always first in line.

A box is offered the newest eligible release of the image repository its compose
runs. A box that runs a halted release is moved back to the newest release that is
not halted.

## Who follows the registry

Three paths take their image from the registry. Nothing else changes the image a box
runs.

- The hourly idle-gated roller on each box asks the dashboard which digest to run.
- The daily fleet-sync cron recreates boxes the registry wants moved and skips boxes
  already on their target.
- UPDATE NOW on the agent page moves the box to its release. Config redeploys,
  resizes and recovery keep the image the box already runs.

A repository the registry has no release of yet is not governed: its boxes follow
`:stable` exactly as before. The first registered release of a repository switches it
over. From then on, a lookup the box cannot complete (dashboard unreachable, nothing
offered) leaves the box where it is. It never falls back to a floating tag.

## Registering and promoting a release

Ops admins use `/dashboard/ops/releases`. The same actions exist as API calls under
`/api/ops/hermes-releases`.

1. Publish an immutable image tag in the image repository (the fork's build does this).
   Every build keeps its tag; tags are never moved or deleted, because boxes pull by
   digest.
2. Register it by tag. The dashboard resolves the digest from the registry. It starts
   at "Registered" and is offered to nobody.
3. Enrol one or two boxes in the canary channel, then promote to Canary and watch them.
4. Promote to 1 box (choose the pilot), then 10%, then 100%. A release moves one rung
   at a time.
5. To stop a release, halt it. Boxes on it move back to the newest release that is not
   halted. Unhalt to offer it again.

## What a box does on an update

The roller and the update script share the same safety:

1. Save the running image as last-known-good and copy the compose file aside (only if
   the stack is healthy; a box that was already broken has nothing to go back to).
2. Pull the exact digest. A failed pull fails the update. It never keeps the old image
   and reports success.
3. Recreate the stack on that image and wait for it to be healthy.
4. Check the agent's sessions came through: `state.db` still opens and passes its
   integrity check, and the session count did not fall by more than 10% (at least 5).
   If the database cannot be read at all, the check does not block the update.
5. On any failure, restore the last-known-good image, compose file and agent source,
   recreate, and report a rollback. The hourly roller then pauses itself.

The box reports the digest it runs, the outcome, and every pause to the dashboard. The
agent page shows the version and "Update available". A release is halted
automatically when its failures pass the threshold in
`dashboard/src/lib/hermes-releases/policy.ts`: the first failure at the canary or
pilot stage, or about one in five reporting boxes (or three boxes) at wider stages.
Only a failure that comes from changing the image counts against a release.

## Boxes that need attention

`/dashboard/ops/releases` lists boxes whose update stack is paused, failed or rolled
back, with the reason the box gave. A paused roller stays paused until someone clears
`/var/lib/hermes-roll-paused-<instance id>` on the box. A healthy dashboard update also
clears it.

## Rolling this out

- Migration `20261007120000_hermes_releases.sql` must be applied before the dashboard
  code that reads it. Code that cannot find the registry tables treats every box as
  not governed.
- Existing boxes get the new roll script on their next update through the dashboard.
  Until then they follow `:stable` as before. A box reports which update stack it runs
  (`update_stack_version`), so the console shows how many boxes have the new one.
- Do not move `:stable` for a release once boxes are governed. The manual script
  `dashboard/scripts/fleet-pull-stable-image.ts` still pulls `:stable` and would move a
  governed box's local alias.
