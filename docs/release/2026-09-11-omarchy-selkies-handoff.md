# Omarchy Selkies desktop: handoff

Snapshot: 2026-09-11, Europe/London

Goal: open the existing Omarchy (Wayland/Hyprland) desktop inside the Hivra
browser page over Selkies, with working pointer and keyboard input. Selkies is
the wanted path; Sunshine/Moonlight stays only as an optional extra tab.

Two independent blockers were found and fixed. The database one is live and
verified. The guest-preparation one is committed and pushed; confirm the deploy
before testing.

## Where the work lives

- Worktree: `/tmp/hivra-native-focus.M53aIp`
- Branch: `codex/native-desktop-focus`
- Base branch: `codex/hivra-integrated-window` (`68711c043`)
- Pull request: <https://github.com/ashneil12/hermesdeploy-canary/pull/611>

Do not work in `/Users/example/Projects/Hermesdeploy-canary`; that checkout holds
unrelated user work. Continue in the worktree above.

## Live Canary target

- Computer: `MY_OMARCHY_DESKTOP`
- Computer ID: `00000000-0000-4000-8000-000000001145`
- PVE host: `node-b`; VMID: `2099`; private IPv4: `10.240.20.99`
- Public broker origin: <https://omarchy-canary.hermesos.cloud>
- Canary UI:
  <https://canary.hermesos.cloud/dashboard/agent/00000000-0000-4000-8000-000000001145?tab=desktop>

The VM is left running deliberately. Do not rebuild it: the existing desktop is
the acceptance target.

## Blocker 1: Wayland admission in the database (FIXED, LIVE)

`selkies-websocket` was admitted on Wayland at session **issue** only. Three
later RPCs on the same path kept the original X11-only gate, so a Wayland
session was issued and then rejected on the next call:

- `exchange_hivra_remote_desktop_session`
- `authorize_hivra_remote_desktop_session`
- `renew_hivra_remote_desktop_session_by_token`

Exchange returned `capability_unavailable` → HTTP 409 → the guest broker
collapses any non-200 control response to 401 → the UI showed "The secure
desktop handoff was rejected", with `exchanged_at` null.

Fixed by
`dashboard/supabase/migrations/20260910120000_omarchy_wayland_web_admission_consistency.sql`,
which rewrites the three remaining RPCs and nothing else. `selkies-webrtc` stays
X11-only; `sunshine-moonlight` still requires proven private-network
reachability. Applied to the Canary database and recorded in
`supabase_migrations.schema_migrations`. Post-apply verification:

| RPC | `admits_wayland` | `still_x11_only` |
|---|---|---|
| `authorize_hivra_remote_desktop_session` | true | false |
| `exchange_hivra_remote_desktop_session` | true | false |
| `issue_hivra_remote_desktop_session_v2` | true | false |
| `renew_hivra_remote_desktop_session_by_token` | true | false |

Reproduce with:

```bash
cd /tmp/hivra-native-focus.M53aIp && bash scripts/finish-omarchy-selkies-handoff.sh
```

Both migrations are idempotent, so re-running is safe.

## Blocker 2: guest preparation deadlock (FIXED, PUSHED — confirm deploy)

After blocker 1, the tab rendered the **Web desktop / Native Moonlight** pair
with Web selected, then reported "Remote desktop isn't ready on this computer"
(HTTP 409 `capability_refresh_failed`).

Cause: the capability inspector hashes the guest's own runtime files and fails
`web_source_mismatch` when one differs from its pinned constant. A diagnostic
log had been applied directly to the guest's
`/usr/local/libexec/hivra/omarchy-web-server.cjs`, so it no longer matched. That
made the file uninspectable — and separately unreplaceable, because `install()`
in the install program refused to overwrite content that was not a named
predecessor, and none of the five affected files had a predecessor slot. Refresh
could not clear it and prepare could not either: no in-product route out.

Fixed by making prepare **converge** those files onto the pinned release:

- `install()` takes a `converge` flag. After the unchanged regular-file,
  root-owned, single-link checks pass, it replaces the file with the pinned
  bytes and prints `HIVRA_PREPARATION_REPLACED <name> <replaced-sha256>`.
- Both content drift and mode drift converge; a caller cannot distinguish them
  from the error code, and both produce the same failure.
- A refused file reports `HIVRA_PREPARATION_OBSERVED <name> sha256=… mode=… uid=…
  gid=… nlink=…` on stderr, and the transport reason surfaces it, so a future
  block names its own cause instead of only failing.
- Strict refusal stays the default for calls that do not opt in, so this is a
  deliberate prepare-time convergence rather than a blanket relaxation.

**Do not fix this by naming the drifted hash as a predecessor.** An earlier
attempt did exactly that and failed on the live guest: the hash came from a
reconstruction in the worktree, not a read of the machine, and the guest never
reports its own digest. Any such constant is a guess. That constant and its
fixture were removed.

Covered by a regression test that runs the shipped install helper against
content the repo has never seen, plus mode drift, already-pinned content, and
the strict path. Verified to fail without the change.

### Confirm the deploy before testing

The fix is committed and pushed, but the deploy is the part that must be
verified, not assumed. Check that the build aliased to `canary.hermesos.cloud`
contains commit `da9cf52bf` or later:

```bash
cd /tmp/hivra-native-focus.M53aIp && vercel --prod
```

Run it from the repository root, not from `dashboard/`: the Vercel project's
Root Directory is already `dashboard`, so running from inside `dashboard/`
resolves `dashboard/dashboard` and fails.

If the deployed build predates the fix, PREPARE DESKTOP cannot work and its
failure will look identical to the old one.

## Remaining steps

1. Confirm the Canary deploy includes the converge fix (above).
2. Press **PREPARE DESKTOP** in the Canary UI, or open the desktop with
   `?prepare=1`, or `POST
   /api/hivra/agents/00000000-0000-4000-8000-000000001145/remote-desktop` with
   `{"action":"prepare"}`. This converges the guest runtime files and
   re-inspects.
3. Refresh the capability, then open the desktop. A capability row lives 9
   minutes; an expired row fails issue with `capability_unavailable` even though
   admission is correct.
4. Real end-to-end acceptance:
   - Web desktop is the selected default.
   - The existing Hyprland desktop appears in the browser.
   - Pointer and keyboard input work.
   - HQ is the default profile; QHD can be selected without silently choosing 4K.
   - Stop and reconnect work without creating a second compositor session.
   - Native Moonlight remains an available optional tab.
5. Leave only the intended VM and the permanent service pair running; revoke any
   abandoned session.

## Gotchas that will otherwise cost a cycle

- **Prepare is rate-limited to 3 per 15 minutes** (refresh to 8). Retrying after
  a failure returns "Wait before preparing this desktop again", which looks like
  the same failure. Wait the window out.
- **Preparation needs an idle operation slot** and returns `computer_not_ready`
  if another operation is in flight on that computer.
- **Never bump `OMARCHY_WEB_*_SHA256` to match a drifted guest.** Those constants
  feed the revision chain (`OMARCHY_NATIVE_INSPECTION_REVISION` →
  `OMARCHY_NATIVE_SESSION_REVISION` → `OMARCHY_DESKTOP_SESSION_REVISION`), so
  changing one invalidates the capability generation for every guest.
- **Never live-edit the guest's `/usr/local/libexec/hivra/*` files.** That is
  what caused blocker 2. Change the committed source and re-prepare.
- **Do not run a capability refresh concurrently with an in-flight handoff**: the
  refresh re-records the capability row and can move the generation underneath it.
- Editing the install program is safe: it is passed as `python3 -c`, is not
  written into the guest, and `OMARCHY_NATIVE_INSTALL_PROGRAM` feeds no revision
  constant. Watch the host-script size budget instead (a test asserts the
  assembled script stays under 250,000 bytes).

## Known unrelated failures

`dashboard/__tests__/scripts/omarchy-proxmox-lab.test.ts` and
`dashboard/__tests__/remote-desktop-handoff-browser.test.ts` fail in a
network-restricted sandbox (temp-file creation and local socket binding are
denied). They fail identically on a clean tree and are not caused by this work.

One inherited mismatch remains by design:
`dashboard/src/lib/infrastructure/__tests__/provisioner-release.test.ts`
compares the current shared broker source against the immutable `2026.09.08.3`
release manifest. Do not mutate that historical release to hide it; resolve it
only through a deliberate new provisioner release, when that is actually in
scope.

## Verification already completed

- Focused remote-desktop and Omarchy suites: 30 suites, 160 tests pass (the two
  environmental failures above aside).
- Typecheck clean; lint clean on every changed file.
- The Wayland admission migration is applied and verified in the Canary database.
- The converge regression test fails without the fix and passes with it.
- Blocker 1's diagnosis was independently confirmed by three adversarial review
  lenses against the source; blocker 2's by two, and the deadlock was reproduced
  empirically against the real installer logic.

## Completion definition

Complete only when the deployed Canary page opens the existing Omarchy desktop
in-browser, accepts trusted pointer and keyboard input, survives one reconnect,
and leaves the VM and agent state intact. A green build, an HTTP 200 health
check, an issued database session, or a visible iframe is not completion.
