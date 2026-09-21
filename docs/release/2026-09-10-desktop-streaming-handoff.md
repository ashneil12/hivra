# Hivra desktop streaming handoff

Snapshot: 2026-09-10, Europe/London

Status: Ubuntu and Windows have usable browser paths. Omarchy's browser path is
installed and reachable, and its handoff failure is root-caused and fixed in
this worktree. The control plane was rejecting the exchange; the guest broker
was not. Do not call the Omarchy web path complete until a real browser session
displays the existing Hyprland desktop and accepts input.

## Product decision

- Daily desktop paths must not use VNC.
- Browser use is the default experience.
- Ubuntu uses the existing Selkies browser stream.
- Windows uses the browser RDP/Guacamole path. VNC is not an offered daily
  Windows path.
- Omarchy should use Selkies in the browser by capturing the already-running
  Wayland/Hyprland session. It must not create a second desktop session.
- Native Sunshine/Moonlight remains an explicit optional Omarchy tab in the
  Mac app, not the default and not the only way to use Omarchy.
- HQ is the default stream profile. Performance, QHD 1440p and 4K are explicit
  choices; 4K is never selected automatically.

## Source and delivery state

- Working tree: `/tmp/hivra-native-focus.M53aIp`
- Branch: `codex/native-desktop-focus`
- Base branch: `codex/hivra-integrated-window`
- Pull request: <https://github.com/ashneil12/hermesdeploy-canary/pull/611>
- Pushed commits at this snapshot:
  - `64e06d6c0` removes VNC from daily desktop choices.
  - `6eb71baac` makes native desktop child shutdown reliable.
  - `912ff5c37` adds HQ/Performance/QHD/4K resolution profiles.
  - `4146b76d3` adds the Omarchy browser desktop.
  - `172440ad3` verifies the Omarchy broker host binding.
- PR 611 is open. The latest implementation commit before this handoff is
  `172440ad3`.
- Canary was promoted from a Vercel build containing `172440ad3`. The browser
  currently renders the new **Web desktop** and **Native Moonlight** Omarchy
  tabs, with Web desktop selected by default.
- Uncommitted work carried forward into this snapshot:
  - `dashboard/supabase/migrations/20260909163000_omarchy_wayland_web_transport.sql`
    (admitted `selkies-websocket` on Wayland at session issue only)
  - `dashboard/supabase/migrations/20260910120000_omarchy_wayland_web_admission_consistency.sql`
    (extends that admission to exchange, authorize and renewal — the actual fix)
  - `dashboard/__tests__/remote-desktop-session-admission.test.ts` and the
    matching block in `dashboard/scripts/test-remote-desktop-sessions.cjs`
    (behavioral regression coverage for the above)
  - The live diagnostic log previously added to the guest's
    `omarchy-web-server.cjs` has been reverted; leaving it in place breaks the
    pinned bundle identity and blocks re-preparation. See "Resume here".

Do not work in `/Users/example/Projects/Hermesdeploy-canary`; that checkout contains
unrelated user work. Continue in the worktree above.

## What was implemented

### Daily-path and resolution changes

- The desktop chooser no longer presents VNC as a normal Ubuntu, Windows or
  Omarchy option.
- Desktop profile selection is carried through session issue and transport
  setup rather than being a cosmetic control.
- HQ remains the default; QHD and 4K are opt-in.
- The Mac Moonlight bridge uses fixed, app-owned launch arguments and profile
  directories. The webpage cannot choose an executable, arbitrary host, key or
  command.

### Omarchy browser transport

New runtime files:

- `dashboard/provisioner/remote-desktop/install-omarchy-web.py`
- `dashboard/provisioner/remote-desktop/omarchy-web-broker.cjs`
- `dashboard/provisioner/remote-desktop/omarchy-web-server.cjs`

The installer creates two permanent services:

- `hivra-omarchy-web.service`: pinned Selkies container using the CPU capture
  path against `/run/user/1000/wayland-1`.
- `hivra-omarchy-web-broker.service`: authenticated broker which exchanges the
  one-time browser handoff, owns the controller cookie and proxies only the
  admitted Selkies HTTP/WebSocket surface.

Pinned images:

- Selkies:
  `ghcr.io/selkies-project/selkies/desktop@sha256:395336daf8a8552949da12a969e0d7a0893309a01e65c81fb75bb0cbab3e3756`
- Node:
  `node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32`

The Omarchy capability now admits both `selkies-websocket` and
`sunshine-moonlight`. The browser UI issues `selkies-websocket`; the native tab
issues Sunshine/Moonlight.

### Live database correction

The v2 session-issue RPC previously allowed Selkies only on X11. That rejected
the legitimate inspected Wayland transport even after the browser service was
installed. The new migration changes admission to:

- `selkies-webrtc`: X11 only
- `selkies-websocket`: X11 or Wayland
- `sunshine-moonlight`: requires private-network reachability

The migration was executed directly against the linked Canary database and is
idempotent. It has not yet been committed or deployed through the normal
migration release path. After it was applied, Canary successfully issued an
Omarchy `selkies-websocket` session.

## Live Canary target

- Computer: `MY_OMARCHY_DESKTOP`
- Computer ID: `00000000-0000-4000-8000-000000001145`
- PVE host: `node-b`
- VMID: `2099`
- Private IPv4: `10.240.20.99`
- Public broker origin: <https://omarchy-canary.hermesos.cloud>
- Canary UI:
  <https://canary.hermesos.cloud/dashboard/agent/00000000-0000-4000-8000-000000001145?tab=desktop>

Persistent live infrastructure:

- Cloudflare has a proxied A record from `omarchy-canary.hermesos.cloud` to the
  node-b public address.
- node-b Caddy has
  `/etc/caddy/hermes.d/omarchy-canary.hermesos.cloud.caddy`, proxying to
  `10.240.20.99:8090`.
- Both Omarchy web services are enabled and running in VM 2099.
- `https://omarchy-canary.hermesos.cloud/desktop/handoff` returned HTTP 200 at
  this snapshot.
- `https://omarchy-canary.hermesos.cloud/healthz` returned HTTP 200 with
  `{"status":"ok","protocol":"hivra-remote-desktop-guest-v1"}`.
- The VM should be left running for real user acceptance.

The capability recorded in Canary before the final diagnostic edit reported:

- compositor: Wayland
- installed transports: `selkies-websocket`, `sunshine-moonlight`
- broker origin: `https://omarchy-canary.hermesos.cloud`
- input takeover support: true
- observed revision:
  `aa80831ebc28a2e982d3e2d222d9cdecd7de3debfcadc6830500fc02b5b5db93`

## Root cause (found 2026-09-10)

Status: **fixed and applied to the Canary database.** All four admission RPCs
now admit `selkies-websocket` on Wayland and no longer carry the X11-only gate;
see "Applied state" below.

The failure is in the database admission rules, not in the broker's request
checks and not in Selkies capture.

The v2 session-issue RPC was widened to admit `selkies-websocket` on Wayland,
but three other RPCs on the same handoff path kept the original X11-only
Selkies gate:

- `exchange_hivra_remote_desktop_session` —
  `20260901020000_hivra_remote_desktop_sessions.sql:352`, returns
  `capability_unavailable`.
- `authorize_hivra_remote_desktop_session` — same file, line 460, returns
  `denied`.
- `renew_hivra_remote_desktop_session_by_token` —
  `20260901210000_hivra_remote_desktop_session_renewal.sql:85`, returns
  `capability_unavailable`.

A Wayland session is therefore issued successfully and then rejected on the
very next call. Exchange returned `capability_unavailable`, which
`session-broker.ts` maps to HTTP 409. The guest broker treats every control
response that is not exactly 200 as a 401 (`broker.cjs:594`), so the handoff
document saw 401 and posted `handoff-rejected`. `exchanged_at` stayed null
because the exchange RPC rejected before it could record the exchange. The
final `released`/`user_revoked` state came from the issue RPC's expiry sweep,
not from a user action.

The evidence below was read at the time as a broker-side request rejection.
That reading was wrong: the broker's `Host`, `Origin`, `Sec-Fetch-Site` and
content-type guards were never reached, because the control plane answered 409
and the broker collapsed it to 401.

This was proven, not inferred. Loading the real migrations into an in-memory
PostgreSQL (PGlite), recording a Wayland capability and issuing a
`selkies-websocket` session reproduces `capability_unavailable` from exchange;
the same harness passes once the migration below is applied.

### Session row that exposed it

- session ID: `00000000-0000-4000-8000-000000001151`
- transport: `selkies-websocket`
- `exchanged_at`: null
- `last_authorized_at`: null
- final state: released / `user_revoked`

That rules out Selkies capture, post-exchange input takeover and WebSocket
proxying as the failure point: the request was rejected before the exchange
ever succeeded.

## Applied state (2026-09-10)

Both migrations are applied to the Canary database
(`srrwbdvxlqvqjuexitaf`) and recorded in
`supabase_migrations.schema_migrations`. The post-apply verification query
returned, for all four admission RPCs:

| RPC | `admits_wayland` | `still_x11_only` |
|---|---|---|
| `authorize_hivra_remote_desktop_session` | true | false |
| `exchange_hivra_remote_desktop_session` | true | false |
| `issue_hivra_remote_desktop_session_v2` | true | false |
| `renew_hivra_remote_desktop_session_by_token` | true | false |

The database no longer rejects the Wayland `selkies-websocket` transport at any
point on the handoff path.

The branch `codex/native-desktop-focus` (`9d1d96cde`) was also promoted to
production and aliased to `canary.hermesos.cloud`, so the deployed build now
contains the Omarchy **Web desktop / Native Moonlight** surfaces. Before that
deploy, Canary was running a build from the PR base branch, where Omarchy had no
browser-desktop UI at all: it rendered the VNC recovery console instead, which
is what the "not using selkies" observation was.

### Guest source mismatch confirmed on the live computer

**Observed.** After the Canary deploy, the Omarchy tab rendered the **Web
desktop / Native Moonlight** pair with Web selected, then showed "Remote
desktop isn't ready on this computer" with a **PREPARE DESKTOP** action.

That message is produced by the `action: "refresh"` path returning HTTP 409
`capability_refresh_failed` (`remote-desktop/route.ts:305-307`). The browser
reaches it from `HivraRemoteDesktop` after a 409 `capability_unavailable` on
session issue triggers exactly one refresh attempt (`:241-262`).

**Cause.** The live diagnostic edit was applied to the guest's
`/usr/local/libexec/hivra/omarchy-web-server.cjs`, so that guest file no longer
matches `OMARCHY_WEB_SERVER_SHA256`. The guest capability inspector hashes its
own files and calls `fail('web_source_mismatch')` on mismatch
(`omarchy-native-capability.ts:381-383`), so inspection fails, no fresh
capability row is written, and the refresh can never succeed while the drift
remains. Retrying the refresh cannot clear it.

**Remedy.** Press **PREPARE DESKTOP** (or open with `?prepare=1`, or POST
`{"action":"prepare"}`). Preparation installs the committed
`install-omarchy-web.py`, `broker.cjs`, `omarchy-web-broker.cjs` and
`omarchy-web-server.cjs` over the guest copies
(`omarchy-native-preparation-host.ts:214-222`) and restarts the service pair,
which reconciles the drift and re-inspects. All four files are git-tracked, so
the deployed build carries the correct copies.

Preparation needs an idle operation slot and returns `computer_not_ready` if
another operation is in flight on that computer.

### Preparation itself had to be repaired first

Press PREPARE DESKTOP *before* the fix below produced
`guest_transport_failed_guest_installed_source_conflict` (surfaced as HTTP 409
`desktop_prepare_pending`; see `omarchy-native-preparation.ts:165`).

Cause: `install()` in the install program refused to overwrite an existing file
whose sha256 was not in that call's `replace_hashes`, and none of the five
affected files had any allowed predecessor
(`omarchy-native-preparation-host.ts:188-197`). A guest carrying a build that was
applied directly to it therefore rejected its own re-preparation, and refresh
could not clear it either, so there was no in-product route out.

Fixed by making prepare **converge** those files onto the pinned release:

- `install()` takes a `converge` flag. When set, and after the unchanged
  ownership/uid/gid/nlink/mode and `O_EXCL|O_NOFOLLOW` checks pass, it replaces
  the file with the pinned bytes and prints
  `HIVRA_PREPARATION_REPLACED <name> <replaced-sha256>` so the repair is
  auditable. The strict content-identity check remains the default for any call
  that does not opt in.
- The five prepare call sites opt in. No knowledge of the drifted bytes is
  required, which matters because the guest never reports them.

Do **not** fix this by naming the drifted hash as a predecessor. An earlier
attempt did exactly that, using a hash reconstructed from the worktree rather
than read from the guest; it would have silently done nothing if the live bytes
differed by one character. The constant and its fixture were removed.

Covered by a regression test that runs the shipped install helper against
content the repo has never seen, asserts convergence, asserts already-pinned
content is left alone, and asserts the strict path still refuses. Verified to
fail without the change.


## Resume here: shortest path

The database fix is live and the Canary build now carries the Omarchy web
desktop. What remains is one real browser acceptance.

1. Refresh the capability, then open the browser. A capability row lives for 9
   minutes; an expired row fails issue with `capability_unavailable` even though
   admission is now correct. Use the **TRY AGAIN** path in the Canary UI, or
   `POST /api/hivra/agents/<id>/remote-desktop` with `{"action":"refresh"}`.
   Do not run a refresh concurrently with an in-flight handoff: the refresh
   re-records the capability row and can move the generation underneath it.
2. If that refresh fails with "This computer's current desktop runtime could not
   be verified", press **PREPARE DESKTOP**. That is the guest source mismatch
   described above, and a refresh can never clear it — re-preparing rewrites the
   guest runtime files from the committed source and re-inspects.
3. Open the Canary UI URL above and confirm the existing Hyprland desktop
   appears and accepts pointer and keyboard input.

If the guest ever needs to be re-prepared, note that the runtime rejects its own
bundle before dispatching anything when a source file does not match its pinned
hash. The live diagnostic edit to
`/usr/local/libexec/hivra/omarchy-web-server.cjs` has been reverted in this
worktree for exactly that reason: with it applied the bundle loads as
`bundle_unavailable` and preparation can never run. Keep the guest's
`/usr/local/libexec/hivra/omarchy-web-server.cjs` byte-identical to the
committed file. Do not bump `OMARCHY_WEB_SERVER_SHA256` to match a drifted
guest: that constant feeds the revision chain, and changing it invalidates the
capability generation and forces a fresh inspection.

Re-preparation also requires an idle operation slot: it is rejected with
`computer_not_ready` while any other agent operation is in flight.

### Deploy and acceptance

5. Wait for the Vercel preview check, promote that exact preview to
   `canary.hermesos.cloud`, and verify the deployed revision.
6. Perform one real end-to-end browser acceptance:
   - Web desktop remains the selected default.
   - Existing Omarchy/Hyprland desktop becomes visible.
   - Pointer and keyboard input work.
   - HQ is selected by default.
   - QHD can be selected without silently choosing 4K.
   - Stop/reconnect works without creating a second compositor session.
   - Native Moonlight remains available as an explicit optional tab.
9. Leave only the intended VM and permanent service pair running. Revoke any
   abandoned session and remove any probe container.

## Verification already completed

- Focused dashboard/runtime suite: 9 suites, 179 tests passed.
- Dashboard production build passed.
- Route, grant, capability and Omarchy UI tests passed after the source changes.
- Real Canary UI displays the new Omarchy Web/Native choice and defaults to Web.
- Real public handoff and health endpoints return HTTP 200.
- Real capability inspection succeeded after the Wayland database admission
  patch.
- Real browser session issue succeeded after the database patch.

There is one known inherited verification mismatch:
`dashboard/src/lib/infrastructure/__tests__/provisioner-release.test.ts` compares
the current shared broker source with the immutable `2026.09.08.3` release
manifest. Do not mutate that historical release to hide the mismatch. Resolve
it only through a deliberate new provisioner release when that is actually in
scope.

## Preservation and cleanup notes

- The stale native guardian namespace was not deleted. It was moved from
  `/var/lib/hivra/omarchy-native-v3/00000000-0000-4000-8000-000000001145`
  to a `.superseded-20260909T1718Z` backup after proving there was no active
  native lease, then a current namespace was prepared.
- The temporary Selkies probe container was removed. The permanent
  `hivra-omarchy-web` and `hivra-omarchy-web-broker` containers remain.
- No SSH tunnel process was present at handoff time. The temporary tunnel key
  `/tmp/node-b-omarchy-web-tunnel.key` was zeroed.
- Do not recreate Ubuntu or Omarchy VMs to fix this handoff. The existing data
  and desktop are the acceptance target.

## Completion definition

This milestone is complete only when the real deployed Canary page opens the
existing Omarchy desktop in-browser, accepts trusted pointer/keyboard input,
survives one reconnect, and leaves the VM and agent state intact. A green build,
HTTP 200 health check, issued database session or visible iframe alone is not
completion.
