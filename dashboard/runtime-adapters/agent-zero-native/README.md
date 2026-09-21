# Agent Zero native editor lifecycle adapter

**Status: source adapter with pinned regression fixtures.** Runtime distribution
and provider acceptance are separate from these source tests; see the public
[runtime boundary](../../../docs/release/RUNTIME-DISTRIBUTION.md).

The regression fixture captures a blank editor on first New File, followed by
a working editor after one cancel/reopen. The
exact guest's source calls `scheduleEditorInit()` immediately after starting an
asynchronous modal load. Two animation frames later, `initEditor()` silently
returns if the modal's container does not exist. No mount callback retries it.
The original-source regression reproduces that lost initialization offline.

`../../provisioner/hivra-chat/agent-zero-editor.cjs` transforms only the two exact captured v2.2 source hashes:
it removes the frame-count assumption and attaches initialization to the native
Alpine container's `x-init` / `$nextTick` lifecycle. The callback carries its
actual DOM node, rejects closed/replaced nodes, and does not replace an already
active editor. Existing-file loading still controls whether that container is
mounted. Per-open generation checks prevent stale load, save, and modal-close
callbacks from publishing into a later editor. The save request still uses the
native API and its original captured path/content; a superseded request is not
cancelled or undone. No model, credentials, chat, gateway authentication or
provider behavior is changed by the candidate.

Source fixtures are unmodified MIT-licensed Agent Zero code. Their license is
retained in `fixtures/LICENSE`. They came from the owned Canary guest running
`agent0ai/agent-zero@sha256:d8fd86114b02e9b4b6f14ef6f696b1ba7af46e52327734bb8a77f7aaf8556cf0`.
Both fixture hashes were checked against the live guest before teardown.

Run the focused tests from the repository root:

```sh
node --test dashboard/runtime-adapters/agent-zero-native/editor-lifecycle.test.cjs
```

The test harness loads the actual pinned native model. It verifies the original
lost initialization, new/existing delayed mounts, idempotent initialization,
stale-node rejection, close/reopen cleanup, loading/error/ACE-unavailable states,
exact-source eligibility, both A-close-B response orders, stale load errors,
stale modal closures, and superseded save responses/callbacks. It is not an Alpine renderer or a live browser.
The markup assertion plus model tests do not prove the deployed UI lifecycle.

## Release integration and limits

The gateway integrates these two coupled transformations at the existing
authenticated Agent Zero native-asset proxy, not as browser-injected scripts or
a replacement file manager. Public root/mounted URL routing and owner
authentication remain unchanged. It requests full identity representations,
rejects source drift and unexpected MIME/status, bounds bytes and total time
including login, removes original validators/lengths, and serves the transformed
pair uncached. HEAD validates an upstream GET but returns no body. The real
loopback proxy test exercises both representations and failure paths.
Retain the native license notice. The candidate's unknown-path `null` result is
not authorization to broaden the routing allowlist.

The new immutable provisioner release includes the full manifest and retained
predecessor compatibility. `.10` was not rewritten. Independent review, Canary
deployment and one disposable fixture passed: the first-ever New File mounted
the editor, typing/save produced the expected 25-byte marker, native Open in
Editor read it back, a subsequent New File started clean, and teardown was
verified. No warmed second open or longer timer was counted as first-open
acceptance. The native Open in Editor action uses a separate editor surface;
the legacy modal's existing-file asynchronous path has model regressions, not
a distinct live public-path claim. The earlier dashboard cold-rendering,
WebSocket and rapid-input observations remain separate issues.
