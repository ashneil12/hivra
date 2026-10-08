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

## Registering from CI

The agent fork's workflow can register the image it just built and proved, so ops start
at step 3 above instead of pasting a tag. It calls one route:

`POST /api/ops/hermes-releases/ci` with `Authorization: Bearer <token>` and a JSON body
`{ "imageRepo": "ghcr.io/ashneil12/vanilla-hermes-agent-canary", "tag": "<upstream tag>-<sha7>", "digest": "sha256:..." }`.
`digest` is optional and only cross-checks: the dashboard always resolves the digest
from GHCR itself, and refuses (409) if the registry holds a different one.

What the token can and cannot do:

- It can register one immutable build of an allowlisted repository
  (`CI_ALLOWED_IMAGE_REPOS` in `dashboard/src/lib/hermes-releases/ci-auth.ts`). The tag
  must end in `-<7 hex commit>`; `stable`, `latest` and branch names are refused.
- The release lands at "Registered": canary channel, 0% rollout, never promoted, offered
  to nobody. The route has no field for a stage, channel, halt or rollout, and a request
  that carries one is refused. Promoting, setting stable, halting and unhalting stay with
  a signed-in ops admin.
- Registering an image that is already registered changes nothing (promoted and halted
  releases included) and returns the existing release, so a re-run workflow is safe.
- The registration is recorded as a `registered` event and `created_by` of `ci`, and
  reported to ops.
- Limits: 20 requests a minute per address (token guesses count), and at most 10 new
  releases from CI per hour.

On the fork side, `register-hivra-release.yml` (in `ashneil12/vanilla-hermes-agent-canary`)
makes this call. `upstream-sync-followup.yml` runs it after a proven build, and it can be
dispatched by hand with an existing image tag.

Setting the token (once per Vercel project that should accept CI):

1. Generate a secret of at least 32 characters, for example `openssl rand -base64 48`.
2. Add it to the Vercel project as `HERMES_RELEASE_CI_TOKEN` (Canary: `hermesos-canary`,
   Production environment, which is the environment Canary builds in). Mark it sensitive.
3. Add the same value to the agent fork as the repository secret
   `HERMES_RELEASE_CI_TOKEN`.
4. The next Canary build picks it up; an env change does not reach a running deployment.

While the variable is unset, or shorter than 32 characters, the route answers 503 and
registers nothing. To revoke, delete the variable and redeploy through the normal Git
build. Production has its own registry; it accepts CI registration only after it is
promoted and given its own token.

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
