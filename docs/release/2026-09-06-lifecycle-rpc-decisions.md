# Lifecycle RPC decision validation

Scope: source-only prerequisite repair on `codex/hivra-core-experience-plan`,
based on `e149a9337`. This does not implement agent attachment or claim a
Canary rollout. No live data, computers, sessions, or provider capacity changed.

## Root cause and change

`agent-operation-store.ts` treated every non-`true` boolean RPC response as
`false`, including null, strings, objects, and arrays. A malformed response was
therefore indistinguishable from a verified lost claim. Delete arbitration
used `String(data)`, accepting arrays such as `["claimed"]` as valid decisions.
Rejected RPC transport promises could also escape with private error details.

The shared RPC boundary now rejects malformed envelopes and decisions with the
existing categorical `database_error`. Boolean decisions require a literal
boolean, and delete arbitration requires one of the four literal strings.
Transport failures use that same safe error category without retrying. Valid
database authority-conflict codes retain their existing mapping. The missing
database client still produces `database_unavailable`.

No SQL, authority scope, timeout, retry, provider dispatch, or cleanup policy
was changed. This is not a claim that all database failures preserve a lease:
existing ownership-bound compensation paths retain their prior behavior.

## Verification

- Before implementation, the expanded store suite produced 16 failures and 31
  passes against the old boundary. Those failures reproduced malformed decision
  acceptance/misclassification and unsanitized transport rejection.
- Final focused store suite: 51 tests pass. Covers exact valid decisions,
  malformed data/envelopes, returned conflict errors, transport failures, and
  provider cleanup proof rejection before access revocation.
- Route regressions use the real operation store with the existing mocked
  database/host boundaries. A malformed delete claim produces HTTP 500 without
  host dispatch or tunnel cleanup. A null checkpoint with pending deletion
  produces HTTP 500 without cancellation cleanup or changes to the fixture's
  original row/operation. These are local fault-injection checks, not live tests.
- Eight suites together: 405 tests pass, including store, launch, owner detail,
  portable authority, lifecycle action, snapshot, provider delete, and stuck
  provisioning recovery. Full TypeScript check and ESLint on all three changed
  code/test files pass. `git diff --check` passes.
- Independent reviewer examined the store change and surrounding compensation
  paths and reran the 51-test store suite: no actionable P1/P2 findings. This
  review does not substitute for post-deployment acceptance.

## Release boundary and next action

Local source/regression gate: PASS. At the source checkpoint, live acceptance
was not run. The subsequent Canary result is recorded below. Do not
deliberately corrupt a live database response to
reproduce the negative cases. Before marking the repair live-accepted, deploy
the exact reviewed source to Canary and exercise normal launch/lifecycle/delete
on one newly created owned fixture, with cleanup. Do not restart or delete a
retained computer for this check. No new spend was incurred.

Rollback is a reviewed revert of the source commit before rollout; no database
rollback or fixture cleanup is needed for this source-only checkpoint.

The attachment implementation still needs the authority cutover and shared
dispatch fence in
`docs/superpowers/plans/2026-09-06-attach-agent-authority-cutover.md`.
The existing `hivra_agents.operation_id` slot and desktop-preparation trigger
demonstrate a reusable lifecycle exclusion mechanism; do not create a separate
attachment lock that restart/restore/delete can bypass. This repair alone does
not add that attachment fence, a runtime installer, or an Attach action.

## Canary rollout and owned-fixture acceptance

On 2026-09-06, deployed exact source
`4a9a6ef212082bbf85d93f5925c9bbc8422b6d39` from a clean archive to the authorized
`hermesos-canary` Vercel project, never the separate production project.
Deployment `dpl_BgQgoW5ySZixG5n3hycdXd4YNHKi` was Ready and the
`https://canary.hermesos.cloud` alias resolved to
`https://hermesos-canary-h3fl2yux5-ashneil12s-projects.vercel.app`.
The deployed source module SHA-256 was
`08f4f631141683415741dcb5e3a4ad0be35466871fabbb4f2808ef1d04a62fd6`.
Previous Canary deployment, available as the rollback target:
`dpl_C3kYB9fN4oRKBKffL2PJVo8VqK5C`. Rollback was not exercised.

Through the existing authenticated Hivra macOS app, refreshed once onto the new
release and followed Home → Launch → Computer → Ubuntu Desktop → Hivra Cloud.
Reviewed and launched exactly one owned fixture, `CANARY_RPC_UBUNTU_0906`, at
2 CPU / 4 GB, using existing included capacity. No Hetzner resource or model
charge was created. The original four Computers and two Agents were preserved.

- Computer: `00000000-0000-4000-8000-000000001114`; created
  `2026-09-06T08:30:28.855794Z`.
- Launch/allocation operation: `00000000-0000-4000-8000-000000001115`.
- Canary-channel guest: VM 1130 on node-b, 40 GB disk
  `local-lvm:vm-1130-disk-0`, binding tag
  `hivra-bind-a44349fdeeafaef56556b2dab39259d5`.
- One original installer PID, 3923154, remained alive through setup. The UI
  automatically opened setup and kept receiving status responses. No second
  refresh, duplicate launch, or worker restart was used.
- Desktop opened automatically around 08:43 UTC. Clicked the guest launcher,
  opened Konsole, typed `sha256sum /etc/machine-id`, and observed its result in
  the streamed desktop. This is real pointer, keyboard, application, and command
  acceptance through the public desktop path, not just a health response.
- Selected Manage → Restart at approximately 08:44:54 UTC. The page moved
  through Restarting back to Running automatically, and its operation cleared.
  Guest boot identity changed from `00000000-0000-4000-8000-000000001116` to
  `00000000-0000-4000-8000-000000001117`.
- Reopened Desktop after reboot, opened Konsole, and repeated the command.
  The displayed machine-ID hash matched. This verifies that specific stable
  value and usable access, not all user files or a full byte-preservation audit.
  Secure-session setup telemetry was 12.6 seconds initially and 4.5 seconds
  after restart; neither is an input-latency claim.

### Cleanup and preservation

Used Manage → Destroy and the exact name confirmation. Deletion operation
`00000000-0000-4000-8000-000000001118` completed. By 08:49:14 UTC, before the
08:50 cleanup deadline:

- Database state was `deleted`; VM ID and operation ID were null; API token and
  tunnel reference were cleared.
- VM config, all VM-1130 LVM volumes, installer PID file, and original installer
  process were absent. Caddy remained active. Full `qm list` hash matched the
  pre-test value `337f1c3b2eee15e644950801a1e886f9fd37be360b74de05b16f8e0cc2beb868`.
- Session `00000000-0000-4000-8000-000000001119` was revoked at 08:44:54.022513Z
  and input released at 08:44:54.232304Z. Post-reboot session
  `00000000-0000-4000-8000-000000001120` was revoked at 08:48:03.795203Z and
  input released at 08:48:04.024232Z.
- Both authoritative Cloudflare nameservers returned NXDOMAIN for
  `agents-canary-box-redacted.hermesos.cloud`. The external tunnel object
  was not separately enumerated; the verified evidence is cleared database
  reference, authoritative DNS absence, and the completed cleanup workflow.
- UI returned to four running retained Computers. The exact owned local
  deployment export was removed after checking its source hash.

Canary happy-path gate for this repair: PASS. Negative malformed-response tests
remain local fault injection; no live database faults were introduced.

### Follow-up found during the real launch

First setup took roughly 13 minutes. The base desktop image was 7.17 GB; the
guest then spent several minutes in `/usr/bin/docker build`, producing a
14.1 GB local desktop image. At a mid-build check the root filesystem had
23 GB free, so that observation did not indicate disk exhaustion. Investigate
the derived-image build before attributing all elapsed time to network pull or
claiming a root cause; no timing optimization was made in this rollout.

Input-to-frame telemetry showed two-second timeout samples despite visibly
successful launcher/terminal actions. Do not present this campaign as measured
low-latency acceptance. Physical keyboard/monitor changes, Windows, Omarchy,
attachment, other providers, and the complete product acceptance remain open.

### Read-only build investigation after cleanup

At source `a5973091f`, inspected `identity_image_recipe()` and
`build_identity_image()` in `dashboard/provisioner/remote-desktop/install-guest.py`.
The derived recipe remaps the base image's Ubuntu UID/GID 1000 to the actual
guest `bux` identity so the desktop and shared workspace agree. It preserves
the named user, verifies collisions, rewrites owned inodes, preserves special
mode and symlink contracts, and checks the resulting config and layer ancestry.
This is not an optional cosmetic build step. Removing it without an equivalent
ownership contract would be a functional/security regression.

Read-only Docker inspection on retained VM 1120 corroborated a large derived
layer; no container, service, image, file, session, or guest state was changed.
This is a corroborating retained image, not the deleted VM 1130's image:

- Base image ID: `sha256:6ee5ddc3aa50ec9b3f22d2090ee1b0d2161e7be5acd9f385717e7c3603f6b3aa`;
  33 RootFS layers.
- Derived image ID: `sha256:7d6fb9e21d4e132c50b4b39e225ac4117d35ae30307ab33cff9e3701ca5943da`;
  34 RootFS layers.
- `docker history --human=false` reports 4,901,744,640 bytes for the added
  filesystem step (`cb2544d613a7...`); subsequent config/label steps report zero.
- `docker image ls` displays 7.17 GB base / 14.1 GB derived, while image-inspect
  `Size` reports 2,093,537,725 / 4,124,798,296 bytes. These are recorded as distinct
  Docker output metrics, not interchangeable exact disk-use measurements.

The live installer was observed in `docker build` for several minutes, and the
recipe plus layer history identifies substantial per-launch derivation work.
There is not yet a phase-by-phase timing breakdown assigning all thirteen
minutes between download, inode changes, layer export, and service startup.

Next implementation target: an identity-specific prepared-image artifact path,
not removal of the UID/GID rewrite or a new progress percentage. It must:

1. Build from the exact pinned base and unchanged reviewed recipe, recording
   full base image ID, recipe digest, UID/GID, runtime image ID, and artifact
   digest. Never capture an existing user's running desktop/container as a base.
2. Admit a prepared image only through an independently verified immutable
   artifact reference. Labels and a mutable tag alone cannot prove provenance.
   Match full recipe/base/identity/config/ancestry before use; unknown guest
   UID/GID pairs retain the existing real derivation path.
3. Keep the self-hosted source-build path fully available without dependence on
   a private managed registry. Preserve special-mode, symlink/xattr, collision,
   shared-workspace, broker isolation, and runtime-readiness checks.
4. Treat image preparation, artifact distribution, guest installation, and live
   acceptance as separate milestones. Select an authorized Canary-only artifact
   target before publishing; this investigation does not authorize a new public
   image or rewrite any retained guest.
5. Prove a fresh launch uses the exact prepared image, real desktop/terminal work
   still succeeds, restart and shared-file behavior hold, and cleanup is complete.
   Measure launch duration on that path before claiming a speed improvement.

No optimization has been implemented or deployed in this investigation, and no
additional capacity or model spend was incurred. The investigation narrows the
next action to moving the existing verified derivation out of the launch path;
it does not close attachment, Windows, Omarchy, or full-core acceptance.
