# Hermes fleet update: recon and plan

Status: recon only. Nothing here has been rolled to a customer box. Evidence level
for each claim is marked (read-only check on 2026-10-08, or UNVERIFIED).

## Where things stand

| Item | State |
|---|---|
| Production `:stable` agent image | Built 2026-09-02, Hermes 0.21.0, from the production agent fork (not thinned). |
| Upstream | Release `v0.21.6` (2026-10-08); tag `v2026.9.24` (0.21.5) is what the canary fork is based on. |
| Canary agent fork | Thinned onto `v2026.9.24` (0.21.5), PR 186 merged 2026-10-08, 24 marked seam files. Follow-up fixes 187, 189, 191 merged. Release sync workflow dispatches succeed and the first run is a dry-run style report. |
| Fork PR 190 (register images with the Hivra registry) | Open. Failing: `Python tests / e2e` (also red on the merged PR 186 head, so a fork-wide failure rather than this PR) and `Review label gate`. |
| Fork `All required checks pass` on PR 186 | Reported FAILURE yet the PR is merged. The protection rule on the canary fork needs a look (UNVERIFIED how it was merged). |
| Immutable image build from the thinned fork | No `docker-build-immutable.yml` run has produced a `<tag>-<sha7>` image that I could confirm (package listing needs a `read:packages` scope I do not have). UNVERIFIED. |
| Hivra release registry (dashboard PRs 229, 235, 249, 250) | Merged and served on Canary. Canary registry table exists and holds 0 releases. |
| CI registration route `POST /api/ops/hermes-releases/ci` | Served on Canary. Never called; waits on fork PR 190 and a built image. |
| Production | Still serves the retired private build (CLI deployment). The registry migration is not applied to the production database and the registry code is not in the production deployment. |
| Production fleet | 49 running boxes across four hosts (14/15/11/9). All follow `:stable` through the on-box idle roller and the daily fleet-sync cron. |

## Ranked blockers

1. **Production cannot use the registry yet.** The production deployment is the retired
   build, and the registry migration is absent from the production database. Moving
   boxes onto digest-governed releases needs: a fresh release PR to `main`, the
   production schema catch-up, the owner's Promote, then a production CI token.
   All of those are owner decisions (RED).
2. **No proven image from the thinned fork exists.** Until `docker-build-immutable.yml`
   (or a proof build) runs on the fork `main` and its artifact proof passes (revision
   label, packaged version equals pyproject, boots), there is nothing to register.
   Canary-side, so safe to do without asking; see step A below.
3. **Fork CI is red on `Python tests / e2e`** on the merged thinning commit and on PR 190.
   Needs diagnosis; the build gate must not be bypassed.
4. **PR 190 is not merged**, so nothing calls the CI route. Needs the `ci-reviewed`
   label (workflow files change) and a green gate.
5. **Production fork is not thinned and sits at 0.21.0.** Even the old route (move
   `:stable`, boxes idle-roll within about an hour, plus the 10:00 UTC cron) means
   syncing the production fork first, then an owner-approved `docker-publish.yml`
   dispatch. That is a fleet release.
6. **Agents cannot self-update by design.** In the container `hermes update` refuses
   because the install is managed (`is_managed()` in `hermes_cli/config.py`). The only
   supported update paths are the idle-gated roller, the daily fleet-sync cron and
   UPDATE NOW on the agent page, all of which follow the registry (once it governs
   the repository) or `:stable` (until then). Fix is to make the dashboard path
   reachable, not to enable `hermes update` in the box. The agent's own guidance
   should point at "Update available" on the agent page.
7. **Upstream moved again**: `v0.21.6` after the fork base. The fork sync workflow
   will propose it; take it before the first rollout to avoid rolling a stale base.
8. **Registry rollout mechanics are untested end to end** (zero releases ever
   registered, no box has reported a digest). The first rollout is also the first
   real test, so it needs the ladder: canary channel box, one pilot, 10%, 100%.

## Plan

A. Canary side, no owner approval needed:
   1. Diagnose and fix the e2e failure on the fork; get `All required checks pass` green.
   2. Merge PR 190 (with `ci-reviewed` once reviewed), merge the v0.21.6 sync PR.
   3. Dispatch the immutable build; run proof rungs 1 and 2 (`hermes-upstream-sync`).
   4. Dispatch `register-hivra-release.yml` for that tag; confirm the release lands at
      Registered on Canary (this is the end-to-end test of the CI route).
B. Needs the owner (stage in decisions, RED):
   1. Fresh release PR and Promote with production schema catch-up (registry migration included).
   2. Sync the production fork and publish `:stable`, OR register the thinned image in
      the production registry after Promote. Preferred: the registry, because it gives
      staged rollout, halt and rollback and never moves a floating tag.
C. Rollout, handed to the fleet SRE lane after approval, per `hivra-vm-side-rollout`:
   one real box first (owner's if one exists), then per-host representatives, then
   batches of two to three per host, with last-known-good rollback ready. Success is
   per-box evidence (running image id, agent-source volume version, health, an
   authenticated sessions call) against a fresh inventory, never `last_synced_at`.

## Not verified

- Whether any immutable image exists for the thinned fork.
- Why PR 186 merged with the required check red.
- Whether boxes carry the new roll script (`update_stack_version`); the production
  database has no such column, so the answer today is no.

## Canary registry acceptance: status 2026-10-08 (night)

Canary only. Prod untouched (PROD HOLD).

Done:
- CI registration route (`HERMES_RELEASE_CI_TOKEN`, PR 249) is served on Canary; an
  unauthenticated call returns 401.
- First immutable image built and proven in the Canary image repository:
  `v2026.9.24-a440677` (hermes-agent 0.21.5, `sha256:e975...2e98`). `:stable` and
  `:latest` were not moved.
- Baseline release row registered by hand for the old `:stable` image
  (`sha256:2c44e99e...`), notes "Baseline ... Test only". It is at Registered (offered
  to nobody). Registering it made the Canary image repository governed: boxes there
  hold their current image instead of following `:stable`.
- A disposable fixture box (owned by the first-run audit identity, named in the
  private ops notes) is running on the stable channel with no release reported yet. The three QA banner boxes
  and the other stable boxes were not touched.

Not done (blocked, not failed):
- The console steps (promote the baseline to the Canary stage, enrol only the fixture
  box in the canary channel, register the new tag, promote it) need a signed-in ops
  admin browser. The computer-use driver would not start this run (daemon never became
  ready), and no other signed-in session exists. No credential was minted or borrowed.
- So the box has not reported a version, and no update was observed. Update acceptance
  through the real agent path is UNVERIFIED.
- Rollback acceptance needs a deliberately broken image, which needs a registry token
  with package write scope. Not available.

Console steps for whoever runs it (`/dashboard/ops/releases` on Canary):
1. Promote the baseline row to Canary.
2. Move only the fixture box to the canary channel.
3. After the next :07 tick, check the box reports the old version (the
   `agent_version` and `agent_image_digest` columns fill in).
4. Register `ghcr.io/ashneil12/vanilla-hermes-agent-canary` tag `v2026.9.24-a440677`
   in the same form (this works without the fork's CI workflow), promote it to Canary,
   then press UPDATE NOW on the fixture box or wait for the next idle roll.
5. Confirm the box reports 0.21.5 and the new digest, and answer an authenticated
   `/api/sessions` call.
6. Cleanup: halt the baseline row, move the fixture box back to stable, delete the
   fixture through the product's delete path.

Learnings for the no-fork plan:
- The registry only needs an immutable tag in a package repository. It does not need
  the fork's CI workflow: manual registration through the console works, so the
  register-on-CI job (fork PR 190) is optional convenience, not a dependency.
- Whatever builds the image must still publish immutable tags with a revision label
  and never move `:stable`. That requirement moves with the build, wherever it lives.
- The first registered release flips a whole repository from "follow `:stable`" to
  "hold unless offered". Register the baseline before or together with the first real
  release, never alone on a shared environment.
