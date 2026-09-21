# Agent Zero editor lifecycle: source milestone

## Decision and scope

PASS for the bounded, independently reviewed source adapter and its unit
regressions. **Not installed, not deployed, and not live-accepted.** This does
not close the blank-first-editor defect recorded in
`2026-09-06-agent-zero-launch-sizing.md`.

Target: `dashboard/runtime-adapters/agent-zero-native/`, based on repository
revision `d3236fd5d2c2e4bc35edac18ad4e2ab27144b5fa`. Work is confined to the
Canary project and its existing PR branch. No runtime, provider, database,
account, secret, or paid resource was changed for this milestone. Existing
sealed provisioner release `2026.09.05.10` is unchanged.

## Change and evidence

The exact captured native source tries to initialize ACE after two animation
frames even though modal loading is asynchronous. The adapter instead binds
initialization to the actual mounted native Alpine element, rejects obsolete
nodes, and preserves an already active editor/draft.

Independent review found that simply preserving the active editor allowed an
old file response to populate a later file's editor. The corrected adapter
uses per-open generations to ignore obsolete load/save results, errors, modal
close callbacks, and completion of an awaited save callback. A save already
sent is not cancelled or undone; its request retains the captured native path
and content.

Checks completed on 2026-09-06, by 03:16 UTC:

- `node --test dashboard/runtime-adapters/agent-zero-native/editor-lifecycle.test.cjs`:
  15 passing, including the original lost-initialization reproduction, both
  A-close-B response orders, actual B save-payload assertion, stale load error,
  stale modal closure, superseded save success/error/callback, delayed mounts,
  draft preservation, cleanup, source pinning, and native failure states.
- `node --check` on both candidate CJS files: passed.
- Reviewer `/root/core_gap_map`: fresh bounded review GREEN after independently
  reproducing both deferred-response orders against the corrected candidate.
  The reviewer did not implement the change or perform live actions.

Adapter SHA-256:
`14389d395b810cae1c9942bf1b7381f59fff705517baab61203fc5e528899b41`.
Test SHA-256:
`53cd5ee83f87049ea754d2256201c22d4e9e88303e8ccd53a7c1a30178cc27d5`.

Captured source hashes are enforced before transformation; original fixtures
and their MIT license are retained unmodified. Fixture whitespace is intentional
because those files are byte-exact acceptance inputs, not authored changes.

## Remaining work and rollback

The model harness is not Alpine or a browser. Integration must preserve the
authenticated native asset proxy and its existing routing/security boundaries,
validate and bound upstream responses, and ship both transformed assets in a
new immutable provisioner release. An owned disposable Canary computer must
then pass first-ever New File typing/save/readback, existing-file open,
close/reopen, and verified teardown. Do not count a warmed second open as a fix.

No deployment rollback or teardown was necessary: this milestone creates no
live resources. The source-only milestone can be reverted by its exact commit;
no rollback was exercised. Canary remains on the previously recorded release.
