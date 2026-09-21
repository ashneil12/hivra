# Canary weekend continuation

The owner authorized continued work through the weekend of 5–6 September 2026,
including desktop apps, Windows/Omarchy launch acceptance, visual improvements
and onboarding, with **GBP 10 total cumulative Hetzner spend**. This expands the
earlier web-only execution scope; it does not declare those paths implemented
or accepted. Production release, PR merge, public distribution, other purchases
and legal-agreement acceptance are not implied.

## Continuity and cost control

- The current task has hourly follow-ups ending Monday 7 September at 09:00
  Europe/London. Local execution requires the computer and app to remain running.
- Preserve existing computers, data and unrelated working-tree changes. Use
  disposable named fixtures and normal product cleanup for test mutations.
- Refresh prices before every billable action; carry cumulative cost forward
  between runs. Count rounded-up server hours and separately billed IPs, including
  powered-off time. Do not treat a new run as a new GBP 10 allowance.
- Initial owned Hetzner fixture: one cx23 in Helsinki with Ubuntu 22.04, requested
  at 23:13 UTC on 4 September. Quoted gross USD 0.01368/hour including IPv4,
  USD 8.508 monthly cap, with 20 TiB included traffic. No other weekend-paid
  resource has been created at this checkpoint. All five original provider
  resources were confirmed absent through both the cleanup UI and independent
  exact-ID provider reads at 23:28:44 UTC. Actual invoice cost is pending;
  the rate is not a zero-spend claim or permission to leave resources indefinitely.
  Reserve GBP 0.10 from the cumulative budget for this completed run (a
  conservative budget allowance, not an invoice or currency conversion), leaving
  GBP 9.90 unreserved. No paid test resource remains active from this run.
- Resource IDs and exact cleanup state are retained in the private task history,
  not in this public source tree. Check that history before creating or deleting.

## Current checkpoint

- Canary revision `73f3fc9b00fe0f57aa513437bb5eeeb371f972b8` has the provider
  admission repair and disk-preserving Hetzner resize implementation deployed.
  The real campaign created the VM, applied its firewall and started it, but
  enrollment failed at deployment routing: the public machine callback redirects
  to Vercel SSO before reaching the application. Setup was paused and all owned
  resources removed. Launch, resize and persistence remain unaccepted on this
  target. No Vercel protection was disabled or bypass secret sent to the guest.
- A disposable managed OpenClaw computer rendered its native dashboard, executed
  a browser-terminal command, and retained a file through the actual Restart
  control and subsequent Files readback. Its normal Manage destruction flow then
  removed the completed fixture and test file: it disappeared from the Home
  inventory, the provider VM is absent, and its retained database row is marked
  deleted with no VM ID or operation lease. The test disk/file are not recoverable.
  Original user computers were not cleanup targets. Model inference is not claimed.
- `89bfa6910` corrects agent-specific native-sign-in guidance (24 focused UI tests
  passed). Canary `5a7ed023c` rendered the correct OpenClaw guidance on its actual
  Manage screen after reload.
- Separate work is addressing a self-host public-callback onboarding mismatch
  and an explicitly limited Hivra-folder restore onto a different computer.
  Neither is a claim of complete fresh-install or full-disk recovery acceptance.
- `4a6525446` fixes the self-host callback check (28 focused tests and independent
  review passed): unsupported HTTPS ports are rejected and the actual enrollment
  endpoint is checked without credentials, rather than accepting any apex page.
- `3345f4f85` preserves WebKit's normal browser identity in the Mac app. The actual
  native app sent its complete browser identity plus the Hivra suffix to a local
  capture page and rendered that page. The focused Swift test and ad-hoc release
  build passed; the temporary profile and capture server were removed. This is
  local native acceptance, not a public signed/notarized release.
- The guided provider create route now checks the configured public machine
  callback before a new purchase. It requires the endpoint's credential-free
  `401 {"accepted":false}` response, rejects redirects, and leaves dispatched
  requests recoverable. Focused helper/route checks passed (33 tests), along with
  the user-facing rejection test, typecheck and helper/route lint. The live probe
  correctly rejects Canary's protected callback. Canary `5a7ed023c` then passed
  the actual fresh quote / guided billing-button rejection: the normal UI showed
  the error and returned to Choose; its saved quote retained no server or SSH-key
  dispatch marker or provider resource ID. No second provider resource was
  created. The warning was below the fold, so a small follow-up moves it ahead of
  the configuration fields (focused UI ordering regression passed).
- A disposable managed Agent Zero computer reached running and its normal Box
  Terminal wrote and hashed a test file. Its actual native page remained blank.
  Public reads isolated a nested-module routing failure: a module referred from
  `/agent-zero/index.js` returned JavaScript, but a nested import referred from
  `/js/messages.js` returned 404. `1d09731d1` keeps authenticated GET/HEAD imports
  on the canonical mount with temporary redirects; writes retain one original
  proxy dispatch. Twenty-three focused runtime/authentication checks and an
  independent review passed. Only the exact owned test guest was patched after
  checking its original file hash, provider binding and lifecycle lease; its
  gateway restarted with the API token and test-file hash unchanged. Public
  redirect and nested-module reads now pass, but the native page still fails to
  render and is under separate diagnosis. This is not complete launch acceptance
  or a fleet runtime deployment. `bb364260b` corrects the pre-launch model-setup
  promise (focused regression passed); rendered acceptance awaits the next build.
- `c0ed4f4d6` implements the deliberately limited encrypted Ubuntu Hivra-folder
  transfer. Eighty-one focused checks, an isolated PostgreSQL journal/session
  harness, typecheck and independent review passed. The exact migration is now
  applied on Canary: function bodies, permissions, RLS and trigger match; the
  previous 265 history entries are unchanged, with only this migration added.
  Canary dashboard `e00d748ed` is deployed and its recovery page renders. The
  two-computer transfer is still pending. Two disposable Ubuntu fixtures have
  been requested through the regular launch UI using included managed capacity;
  they do not consume a new Hetzner allowance. The source desktop rendered and
  opened its native Konsole from the application launcher, but writing into
  Hivra failed: the desktop user is UID/GID 1000 while the mode-0700 shared folder
  belongs to the host's bux UID/GID 1001. No recovery fixture bytes were written.
  A coherent desktop/host user mapping is required before transfer acceptance;
  widening permissions or changing the host owner is not the repair.
- `f6aa11f07` additionally fixes Agent Zero's no-referrer blob-module imports,
  retains rotated native login/CSRF sessions inside the gateway, strips upstream
  Set-Cookie responses, and withholds the Hivra management bearer from the native
  backend. Thirty focused runtime/auth checks and independent review passed;
  follow-up test lint is clean. The exact owned guest was patched with token and
  fixture hash preservation. Public blob-module redirect, native CSRF, and
  authenticated extension-load checks pass; browser rendering still fails and
  is undergoing a bounded startup-error capture. No fleet rollout is claimed.
- `97d73ac91` exposes computer/agent naming outside Advanced and replaces internal
  receipt wording with truthful launch feedback; 13 focused checks and lint pass.
  `3cdfe1d89` adds inspection-only prepared Omarchy evidence, with 35 focused checks,
  lint and independent review. Omarchy remains non-launchable: client-route and
  input-takeover evidence are deliberately false. Neither commit is a native
  Windows/Omarchy launch-acceptance claim. Canary `01602a5b0` is deployed: the
  normal Ubuntu launch journey visibly exposes the name field, Advanced still
  expands the recommended CPU/RAM controls, and the Omarchy readiness link opens
  the correct status section without launching or buying anything. Full dashboard
  typecheck also passed. The revised in-flight confirmation wording has not been
  exercised with another deployment request.
- A single temporary startup-error capture on the owned Agent Zero fixture
  identified module resource failures rather than an application exception. Its
  original native HTML was restored with the exact original hash, owner, mode
  and timestamp; the diagnostic backup was removed. No gateway token or user
  fixture bytes changed during this diagnostic cycle. Native rendering remains
  unaccepted. `e7eaebd93` repairs the exact authenticated static `/index.js`
  import needed by five native modules (32 focused checks, independent review).
  The owned guest's gateway was patched and restarted with its token and fixture
  hash preserved, but the actual embedded page is still blank. Further work must
  capture the browser's failed request or module error instead of inferring
  success from another HTTP-only graph check.
- Follow-up onboarding wording removes internal evidence-revision/mutation
  terminology, explains the existing-capacity purchase boundary, and stops
  calling manually chosen resources a recommendation. The 13 focused launch
  tests, lint and independent review pass. Canary `7d27b7131` renders the new
  hosting/resource instructions and the review's existing-capacity/no-new-server
  explanation in the normal flow. The check stopped before Launch.
- Agent Zero's isolated Chromium capture had no request or console errors, but
  the actual Chrome screenshot exposed duplicated chats, input fields and other
  controls. Hydration counts were not acceptance. An isolated browser fixture
  proved the underlying module identity defect: mounted entries and redirected
  root imports initialize the same modules twice. A single canonical root path
  initializes them once. The bounded repair is in progress; no native settings
  or chat action was invoked against the duplicated UI. The short-lived bootstrap
  form server was stopped and its in-memory credentials cleared. The in-app
  browser's blank page/client-side module navigation block remains a separate
  unverified client behavior, not a proven WebKit or application-auth defect.
- `770650ee3` establishes one canonical native module identity. The actual
  Chrome page now renders one Agent Zero interface and its real Settings dialog
  loads and closes without saving. `940bbbaba` adds the exact native extension
  and Socket.IO paths, with 52 focused checks including Chromium and independent
  review. Only the owned guest was patched; its token and fixture were preserved.
  Its regular Manage Restart returned to Running, and Files read back the
  original persistence text afterward. Fresh normal Chrome still reports a
  failed dynamic extension import and degraded polling sync; a separate isolated
  browser receives the extension itself successfully, so that HTTP result does
  not close the browser issue. Native inference remains untested.
- `7d5bc7af4` seals provisioner `2026.09.05.1`, including the Agent Zero gateway
  fixes and the Ubuntu shared-workspace identity repair. The latter derives the
  pinned desktop image with its named user mapped to the actual host user,
  checks the recipe/image lineage and runtime write-through, and preserves the
  private shared-folder permissions. Fifty-two Ubuntu checks, 84 release/native/
  admission checks, the ownership harness, full typecheck, local migration reset
  and independent review passed. Canary dashboard deployment
  `dpl_14iH6sBrrdJnsXz33Ln29wx7sK5F` is Ready at that exact revision. The owned
  source-desktop image prebuild failed before a lifecycle lease or service
  change: the pinned image contains two legitimate inherited special-mode paths
  rejected by the new blanket guard. A bounded exact-metadata repair is being
  prepared as a new immutable release; the earlier release is not being edited
  in place. Actual native writes and two-computer recovery remain pending. No
  original desktop is being upgraded automatically.
- Agent Zero's remaining sync failure is now traced to the private native CSRF
  cookie boundary: native HTTP accepts its token header, while native WebSocket
  activation also requires the runtime-scoped cookie normally made by client
  JavaScript. The gateway drops browser cookies by design. The repair derives
  only that cookie from the exact authenticated native response and keeps it
  server-side, without relaxing auth or forwarding browser cookies. It is under
  focused regression/review, not yet patched live. The separate normal-Chrome
  module navigation reports `ERR_BLOCKED_BY_CLIENT`; its source is not proven.
- `ad9b04cd7` improves the Mac's unreachable-local first-run choices. The actual
  native app at its minimum window size opened the existing Canary connection,
  local controls, and custom-connection form; returning/cancelling preserved the
  two existing profiles and did not start services or access Keychain credentials.
  Canary reached the normal Vercel login page, not an authenticated dashboard.
  Fifteen Swift tests and the ad-hoc build passed. The screenshot then exposed
  poor contrast over WebKit's white failed-page background. `0d8c9c92d` fixes that
  with an opaque recovery backdrop/card and a tested contrast palette; its
  focused test, build, independent review, actual native screenshot, and
  Add-custom/Cancel click passed. This remains a local ad-hoc Alpha, not a
  public signed/notarized release or complete hosted sign-in acceptance.
- New managed launches still read the host-global provisioner, not the Vercel
  artifact automatically. The inspected managed target is shared by production
  and Canary. No global provisioner sync is authorized by Canary-only scope.
  A separate persisted Canary-channel path is being designed before any host
  delivery; manually patched fixture acceptance must not be reported as proof
  that every new managed launch has received the fixes.

### 02:28 UTC continuation

- `d86645f4e` repairs the private Agent Zero native CSRF/session boundary.
  Focused regressions and independent review passed. On the owned VM1120,
  normal Chrome rendered a single native interface with `Connected (push sync
  healthy)`, including after the normal Manage Restart. The post-restart web
  terminal reported boot time `2026-09-05 02:08:34`; Files read back the exact
  `hivra-agentzero-persistence-12ba0023` fixture text. Model inference and the
  embedded browser remain unaccepted. The temporary sign-in listener, form and
  token were cleared. Normal Destroy then removed only
  `CANARY_E2E_AGENTZERO_0905`: VM1120 is absent, and its owned database row is
  deleted with no VM or active operation. Its disposable disk/test data cannot
  be recovered; the original computers remain running.
- `737cda607` seals corrected release `2026.09.05.2`, preserving the two exact
  special-mode paths in the pinned Ubuntu image and incorporating the accepted
  Agent Zero gateway. Release manifest SHA-256 is
  `f1f5f05367fb58247e47b86fdef73938c23627f7a6bbccef690c7b638cb91232`.
  The commit is pushed to PR #600 and custom Canary deployment
  `dpl_HJ34zkmS3ECKA741T21tjkcrFGfD` is Ready at that exact SHA, with both Canary
  aliases. Narrow Canary migration apply added only
  `051100` and `051300`; read-only postcheck confirms all 266 prior history
  entries unchanged, 268 total, exact sealed function bodies and unchanged
  service-role-only application grants. Channel migration `051400` is absent.
  The corrected owned source Ubuntu prebuild subsequently failed before its
  lease/apply. The failed build container shows the user changed to 1001 but
  group ownership still 1000, narrowing failure to rootfs UID remapping before
  the group pass. Disk space is sufficient; the old actual desktop container
  remains healthy. Reopening an old `prepare=1` fixture URL also invoked normal
  preparation; that process has now exited and the parameter was removed. The
  current UI truthfully reports the old runtime unverified. A bounded build-only
  diagnostic is pending; no blind install retry is authorized. Native folder
  write and two-computer recovery remain unaccepted. No production-global
  provisioner update or original computer mutation is part of this operation.
- Static follow-up found normal desktop preparation does not claim the durable
  lifecycle operation or hold the host allocation lock used by Restart/Destroy.
  It also writes persistent runtime/auth files before image build, so an exited
  build does not prove on-disk connection settings unchanged. The owned source's
  old container is healthy, but its on-disk preparation state needs inspection.
  A dedicated preparation-operation fix is scoped for migration `051500` and
  shared-lock/exact-identity regression coverage; no live migration is approved
  yet. Moving image validation before persistent writes belongs to the Ubuntu
  installer correction. Neither repair has been accepted live.
- `790f6cd53` clarifies that desktop `/home/ubuntu/Hivra` and host terminal/files
  `/home/bux/Hivra` are the same limited recovery folder. Its focused component
  test and touched-file lint pass; Canary `dpl_APgyKFDwXFzEbP5HQCLuVe86x7hj`
  was Ready at that exact revision and the actual page displayed both paths.
  This small
  onboarding clarification does not change the recovery scope or imply transfer
  acceptance.
- Rollout gap: the current desktop inspector requires only the current bundle
  revision. A new release can therefore reject an older prepared runtime during
  refresh even without changing that VM. A known-version inspection/explicit
  upgrade policy is still needed; pins must not be weakened and original
  computers must not be silently upgraded to hide this gap.
- The actual recovery screenshot then exposed invisible action backgrounds and
  zero-spacing inputs. Global unlayered reset rules override the component's
  layered utility styling. `460695ac7` adds a page-scoped stylesheet using the
  existing theme tokens, without changing the global reset or recovery logic.
  The focused component test, Chromium cascade regression in both themes, and
  touched-file lint pass. Canary `dpl_97qnh54HMB6z55WMRFywBEkxz31B` is Ready at
  that exact SHA; real screenshots and computed styles show visible 44px
  controls, spacing and correct contrasting backgrounds in dark and light.
  The original dark preference was restored. No passphrase, export or restore
  was submitted. Source/destination remain owned fixtures for pending recovery.

### 02:52 UTC preparation boundary correction

- Read-only host inspection found the normal Prepare call at 02:27:56 UTC had
  implicitly synchronized `.05.2` to shared `/root/hivra-provisioner`. This
  corrects the earlier assumption that no shared provisioner update occurred.
  That directory is used by production and Canary; the effect was unintended.
- Root restored only this attributable directory change under the existing
  FD8 allocation lock, after checking for active provisioner readers and
  validating the current and retained manifests. The exact preimage was
  `/root/.hivra-provisioner-rollbacks/2026.09.05.2.jYs07CtU`, version
  `2026.09.04.4`, manifest SHA-256
  `6e71628f396712e77aaf2598c929c5f7472dedd16f5a57e28a10cb04c3fc0e63`.
  All manifest files verify after restoration; VM inventory and Caddy service
  state are unchanged. The displaced `.05.2` directory is retained recoverably
  at `/root/.hivra-provisioner-rollbacks/owned-canary-unintended-20260905-022756`.
  No VM restart or data deletion was part of this rollback.
- The preparation source repair will fail closed for protected Canary when the
  persisted channel is not `canary`, and normal Prepare will no longer sync
  the shared default bundle. No automatic channel reassignment is authorized.
  Further normal preparation tests wait for this fix and isolated delivery.
- The one actual image-build-only diagnostic completed with the old running
  container/image/service identity unchanged. It retained stderr privately;
  the failure still needs identification from the failed build's filesystem.
  Diagnostic wrapper failures before Docker started were not image-build
  attempts and made no guest/runtime changes. No further build retry is planned
  without a concrete root cause.
- `5a94d9ce2` prevents choosing the source computer as its own recovery
  destination and clears a destination that becomes the newly selected source.
  Two component tests and lint passed. Exact Canary deployment
  `dpl_Ai3PE6xFkrJ9xcZ2TfbHX7PJj1z1` is Ready; normal browser selections on the
  two disposable fixtures verified filtering and clearing. The intended source
  was restored, with no passphrase, file upload or transfer submission.

- `99d6774ef` contains the unsafe preparation delivery path while the permanent
  fix is built. Exact Canary deployment `dpl_HzrFSe1QuJDhJz3jokomSXaDoJgU`
  is Ready. One normal Prepare click on the owned source returned the explicit
  temporary pause message. Before/after shared bundle manifest hashes and
  directory modification time match; VM1123 remains running. Read-only refresh
  is still available. This is containment, not successful desktop preparation.
- The completed failed-image inspection found 279 old-UID symlinks after the
  UID pass; group remapping had not begun. Docker reports the `overlayfs`
  driver. The exact storage mechanism is an inference, not proven by tar
  metadata alone. The next immutable `.05.3` repair will recreate only selected
  links with the same targets and verified metadata, retain full no-old-ID
  checks, and validate the image before persistent runtime/auth writes.
  Release migration `051600` is reserved; no new image build or live apply has
  been authorized before review of that correction.

After each completed slice, select another concrete in-scope improvement. Do not
repeat broad tests without a relevant change, replace user-path checks with
proof infrastructure, or call the whole goal complete because one slice passes.

### First-boot callback boundary follow-up

- Vercel's current [Deployment Protection Exceptions documentation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/deployment-protection-exceptions)
  describes whole preview-domain exceptions, not a POST-path exception, and
  requires Enterprise or the Pro Advanced Deployment Protection add-on.
  Therefore a domain exception is not a narrow fix for the blocked enrollment
  callback. No exception, add-on purchase, or global protection change was made.
- A future machine-only relay would need its own reviewed exact-path/method,
  bounded request/response, fixed upstream, secret custody and negative-route
  contract before deployment. It is a design option, not an implemented or
  approved replacement. The existing pre-purchase callback guard remains in
  place; no additional Hetzner resource was purchased during this investigation.

### 03:21 UTC isolated delivery and preparation lifecycle

- Source commits `35bf599c6` and `9f392e76d` add the immutable managed delivery
  channel and durable preparation lease/guest terminal receipt. Existing rows
  stay `default`; no reassignment or shared default synchronization is allowed
  from protected Canary Prepare. Unknown guest outcomes retain the lease, and
  the UI distinguishes paused/unconfirmed preparation from retryable failures.
  The temporary Canary hold is still enabled.
- Ubuntu correction `df1e86550` and immutable release seal `fc1f46506` preserve
  selected symlink targets/metadata while remapping identity and move the image
  and workspace checks ahead of persistent broker/auth writes. Version
  `2026.09.05.3` has manifest SHA-256
  `335f365b4233534b1ae98cbd6a01b2ec1b5c47747a7b915d8491e0fb785ef2e9`
  and desktop revision
  `fea9cca814b4a1db98585a15c9fc2b589a53f88cb1f3edfd72877879990c6cab`.
  Focused release/recipe/lease/channel regressions, SQL harnesses, lint and
  final full typecheck passed. These are source checks, not live acceptance.
- Exact migrations `051400`, `051500`, `051600` were applied only to Canary
  `srrwbdvxlqvqjuexitaf` from the narrow reviewed stage, after a dry-run listed
  exactly those three files and no seeds/roles. Postcheck found 271 history
  entries with the prior 268 unchanged, all 11 function bodies matching the
  reviewed SQL, an empty private preparation journal and all existing channel
  values still `default`.
- The sealed revision is pushed to PR #600. Deployment
  `dpl_SR2njKw3apPMtgBGQTkfW5niuqrT` is Ready at exact `fc1f46506` with the
  Canary aliases; CLI inspection confirms target `canary`. A normal owned-source
  Prepare click and rendered screenshot show the explicit paused state with no
  misleading retry button. The shared `.04.4` manifest hash and directory
  modification time remained unchanged. This accepts the containment UI only.
  One exact
  owned-source Ubuntu `.05.3` prebuild is running; no destination update or
  isolated host-bundle sync has been attempted. The shared host bundle was
  rechecked as exact `.04.4`, and both owned recovery VMs were running before
  this attempt. No further Hetzner spend.

### 03:35 UTC real Ubuntu write and isolated fresh launch

- The one `.05.3` source attempt completed successfully on owned VM1123,
  `00000000-0000-4000-8000-000000001015`, operation
  `00000000-0000-4000-8000-000000001016`. The exact release image built and was
  installed; the scoped harness confirmed workspace/API token/control bypass
  preservation, rotated loopback Basic credentials/capability generation, and
  desktop UID/GID write-through. This compares against the current partially
  prepared fixture baseline, not a claim that the earlier failed preparation
  left all on-disk settings untouched. A private rollback backup remains.
- The normal public Desktop path rendered Ubuntu. From its actual Konsole,
  `ubuntu` UID/GID 1001 created `canary-recovery-4e7f7f1d/note.txt` and
  `sample.bin` inside `/home/ubuntu/Hivra`. The visible SHA-256 output matched
  independently calculated expected bytes:
  - 52-byte text: `5bc458e1d08b1209f4b1ea7460b1ee30d89e8faeb9804d938e9a284be1356e6b`.
  - 12-byte binary: `3c0af7fe44ee5b571e36e54a3a5287e353d2e4d75e0961297a864e5118e4e43c`.
  The terminal was closed. Normal recovery Export downloaded the 792-byte
  encrypted archive; the page confirmed source sessions remained unchanged.
  Restore/reboot/reconnect are still pending. The destination's single `.05.3`
  prebuild/update is running; it has not been retried.
- The reviewed sync installed `.05.3` only into previously absent
  `/root/hivra-provisioner-canary` on node-b. Its preservation receipt matched VM,
  Caddy and storage state; independent surrounding guards verified the shared
  default manifest and mtime unchanged. No shared default update or existing
  computer channel reassignment occurred.
- A normal Agent Zero launch created disposable `CANARY_CHANNEL_A0_0905`,
  `00000000-0000-4000-8000-000000001017`, VM1119/IP10.70.20.69 on node-b,
  with persisted channel `canary`, 1 CPU/2 GB, and no managed model credits.
  The UI automatically advanced to Setting up; native-dashboard acceptance and
  cleanup remain pending. No additional Hetzner resources or spend.

### 03:49 UTC restore, reboot and fresh native dashboard acceptance

- The destination's single `.05.3` update completed on owned VM1124,
  `00000000-0000-4000-8000-000000001018`, operation
  `00000000-0000-4000-8000-000000001019`. Normal Recovery UI uploaded the
  exported fixture archive and restored two files / 64 bytes to the distinct
  empty destination. The success response confirmed hash verification and
  revocation of existing source desktop sessions, with both computers retained.
- Normal Manage Restart on the destination completed. Its actual public Box
  Terminal reported boot `2026-09-05 03:41:02`; both restored file hashes exactly
  matched the two source hashes above. Switching to Desktop rendered Ubuntu
  again (displayed setup 2.2 seconds). This is actual restore/reboot/terminal/
  desktop acceptance at deployed `fc1f46506`, not only an internal health check.
- The old source stream stopped after revocation, but its outer header still
  said Desktop connected. This is an observed remaining feedback defect, not
  evidence that revocation failed. Diagnosis found the broker announces
  connection on session exchange and never forwards terminal stream closure.
  A real correction needs the pinned transport-close hook, a new sealed broker
  release and the dashboard listener; do not alter sealed `.05.3` or hide the
  issue behind automatic reconnect. Existing fixtures are retained for this
  bounded follow-up; original user computers were not touched.
- Fresh `CANARY_CHANNEL_A0_0905` advanced through the normal launch flow to
  Running and rendered the embedded native Agent Zero dashboard. Its Settings
  dialog loaded real configuration and was closed using Cancel without edits.
  This accepts fresh isolated-channel launch/UI delivery, not model inference.
- Commit `c62b1c2fa` adds exact finite predecessor desktop identity compatibility
  for read-only refresh, while keeping new launch and Prepare current-only by
  default. Legacy identity-less runtimes get an explicit update-needed state.
  The 71 focused tests, scoped lint and independent review passed. Deployment
  and historical-runtime live acceptance remain distinct pending checks.
- No further Hetzner resources or spend. Weekend hourly heartbeat remains active
  through Monday 7 September 08:00 UTC; it requires this Mac/Codex to run and is
  not a guarantee of uninterrupted execution.

### 03:50 UTC source-session handoff acceptance failure

- Opening a fresh source Desktop tab initially rendered Ubuntu, then showed
  `Connection Terminated: a new primary client connected connection killed`.
  The old source tab, which had stopped after recovery, regained the stream
  without a user reload. Clicking its Ubuntu launcher opened the actual menu
  (198 ms displayed input-to-frame sample), proving resumed input, not merely a
  stale frame. Both source tabs were then closed to stop competing sessions.
- Thus folder transfer and destination reboot persistence pass, but full
  source-session handoff/revocation acceptance **fails**. A later session's
  shared browser cookie being reused by the old tab is the current hypothesis,
  not yet the confirmed mechanism. Inspect pinned Selkies reconnect and broker
  per-handoff binding before repair; preserve the reproduction and add a
  regression against old-tab adoption of a newer session. Do not report this
  as only a cosmetic header defect or as fully verified recovery.

### 03:53 UTC compatibility deployment

- `fbcc530c4ce882437e21e5e11d31af74d20e753f` is Ready on exact Canary
  deployment `dpl_Hq1p3vkBFdYagWrF18k36sNwKMvC`; Vercel API confirms both
  Canary aliases. A fresh destination document rendered the existing `.05.3`
  Ubuntu desktop (displayed setup 2.1 seconds). This checks current-runtime
  continuity only; historical `.05.1/.05.2` acceptance remains source-tested,
  not exercised against a live predecessor.
- Switching away and back in the older destination document left a Play Stream
  / Connecting overlay beneath its stale connected header. Closing that
  document and opening the fresh document restored rendering. Keep this
  remount symptom alongside the confirmed cross-tab session-reuse failure for
  the upcoming broker lifecycle repair; do not claim it fixed by compatibility.

### Source-session reuse diagnosis — confirmed mechanism, repair not implemented

- The fresh destination document also accepted a real launcher-menu click
  (448 ms displayed sample, n=1). This confirms useful current `.05.3` input,
  not recovery of an older document or safe source-session handoff. Both
  source documents were closed after the old source regained real input; the
  two recovery computers and their files remain retained for the next check.
- Read-only inspection used exact owner/id/name/type/VM1123/IP/binding and
  running/idle guards, then VMID-scoped QEMU Guest Agent and `docker exec` to
  read installed static assets. No guest files, services, sessions or browser
  state were changed, and no credentials were printed or retained.
- Installed client source is
  `/usr/local/lib/python3.14/dist-packages/selkies/selkies_web/assets/selkies-core-BmcZD_0O.js`
  (362,465 bytes; SHA-256
  `e82544ce171394e308cbad5e7f8c88bed822895f482d58562a07a6cbe27ee76d`).
  Its `src/selkies-core.js` copy has identical bytes. Entry asset
  `assets/index-4mOJQmIr.js` hashes to
  `a50b5985da7b051d7da54492ba66ab21ad4e64cf02008acd2886f6e40236c579`.
  These observations are bound to the retained `.05.3` source container and
  pinned Selkies base, not an assumed current upstream branch.

The failure is a code defect at the guest browser-session boundary:

1. `dashboard/provisioner/remote-desktop/broker.cjs:552` gives every exchange
   the same `__Secure-hivra-rd` cookie name and `/desktop` path. A new tab's
   successful exchange replaces the cookie for every old document on that
   guest origin. `sessionFor` at line 479 and the upgrade handler at line 617
   authorize whichever session the current cookie names; they do not bind the
   request to the document's original handoff.
2. The pinned client's ordinary WebSocket `onclose` (compiled character offset
   340337) starts a five-second reload loop (offset 341524). Its auth probe
   also performs a same-origin HEAD using browser cookies. Therefore a revoked
   old document can reload and open its WebSocket with a later tab's still-valid
   cookie. The old session record need not be resurrected: the old document
   adopts the new session's authority.
3. The upstream primary-client replacement branch is installed
   `selkies/selkies.py:3560`. It sends the observed new-primary-client KILL reason
   to the existing stream. Client KILL handling (offset 323368) disables its
   `.onclose` callback and displays Connection Terminated. This explains why the
   new visible document can be killed when the older document reconnects.
4. The stale header is a second, related propagation defect. The broker sends
   `connected.v1` immediately after exchange, before media readiness, and never
   sends terminal closure. `HivraRemoteDesktop.tsx:342` clears pending handoff
   and sets connected; subsequent `failed.v1` handling only accepts a pending
   handoff. Its capability refresh is not a current-session connectivity check.

Smallest proposed repair boundary (requires approval/implementation and a new
immutable bundle; do not modify sealed `.05.3`):

- Bind each media document to its original **nonsecret session ID** in a
  canonical path such as `/desktop/sessions/<id>/`. Scope the opaque HttpOnly
  Secure cookie to that exact path, preferably with an exact session-specific
  cookie name so an existing legacy root cookie cannot shadow it. Require
  cookie-session/path identity equality before every HTTP or WebSocket proxy;
  never fall back to the latest origin-wide cookie. Reject legacy unscoped
  media requests. Session IDs are routing selectors, not bearer credentials;
  codes, verifiers and opaque cookies remain out of URLs/logs. This addresses
  automatic old-document adoption, not a claim to isolate malicious scripts
  sharing the same guest origin.
- This path design is compatible with the observed client's URL construction:
  helper `i()` (offset 1328) derives the directory from `location.pathname`, and
  socket setup (offset 314786) appends `api/websockets` to that directory. Keep
  that prefix when stripping only the broker's routing prefix upstream; verify
  all relative asset/HTTP paths instead of globally rewriting native scripts.
- Reuse the existing same-origin wrapper and trusted parent-message bridge.
  The client exposes `window.selkiesTransport` immediately after construction
  (offset 315050). Both its WebSocket and worker facade implement independent
  `addEventListener` hooks; the facade forwards close/error/open at offset
  301537. A close listener is not removed by native KILL overwriting `.onclose`.
  Bind to the exact child window/transport, emit a categorical terminal event,
  and tear down the child before native reconnect can run. Do not forward raw
  close reasons, credentials or native message bodies. The path/cookie binding
  remains the authority fence even if a browser listener races or is suspended.
- Parent handling must validate exact origin, frame source and current session,
  show disconnected without the input-isolation assurance, clear the current
  handoff and stop its activity. Media-ready, not exchange success alone, should
  establish the connected label. Reopening requires an explicit user action;
  no automatic new session or installer after terminal closure. A pipeline
  video=false event alone is insufficient because normal hidden-tab behavior
  deliberately pauses video.

Focused regressions needed in the existing suites:

- `runtime-adapters/remote-desktop/broker.test.cjs`: exchange A, revoke A,
  exchange B in the same cookie jar; old A HTTP/WS retries with B's cookie must
  fail before upstream dispatch, while B remains usable. Cover missing,
  duplicate/mismatched and legacy-root cookies plus unchanged origin/auth fences.
- `scripts/test-remote-desktop-handoff-browser.cjs`: two real browser documents
  sharing one context/cookie jar; simulate native worker/native socket close,
  reload and KILL. A never gains B's input; close emits once and stale handlers
  cannot terminate B. Retain the no-URL-credential assertion.
- `HivraRemoteDesktop.test.tsx`: connected requires current media readiness;
  authenticated terminal status removes connected/isolation claims, ignores
  wrong-origin/source/session and late events, and creates no replacement
  session until a user clicks Reconnect. Keep the remount reproduction in live
  acceptance instead of assuming it shares only one cause.

No repair code, sealed assets or migrations were changed in this diagnosis.
After a reviewed new release, root must repeat the actual recovery revoke ->
fresh source session -> old-tab interaction sequence and confirm B stays usable
while A cannot regain input, plus destination remount/reconnect. The current
source-session handoff acceptance remains FAIL until that live result exists.

### 04:06 UTC fresh isolated Agent Zero restart acceptance

- On retained `CANARY_CHANNEL_A0_0905` / VM1119, the actual Box Terminal
  created a non-overwriting 51-byte owned fixture
  `/home/bux/canary-channel-0905.txt`. This agent does not have the Ubuntu-only
  `/home/bux/Hivra` directory; the initial attempt there failed without writing
  anything, and the test used its existing home directory instead.
- Normal Manage Restart completed automatically. Public terminal boot time
  changed from `2026-09-05 03:34:50` to `2026-09-05 04:00:44`; file SHA-256
  remained `bca053f9262c2734adc6ce72803953731f3a149c097541d544169cc829e16df4`,
  matching independently calculated test bytes. The native Agent Zero dashboard
  reconnected and its Settings dialog populated after reboot; Cancel closed it
  without changes. No model credentials or inference were exercised.
- The fresh computer still uses the isolated `canary` delivery channel, running
  the `.05.3` launch installation with Canary control deployment `fbcc530c4`.
  It and the single owned test file remain for later lifecycle/cleanup work.
  No paid resources were created and no original user computer was modified.

### Session binding repair committed; live release pending

- `eb2edbb6166f002490ccb5716d82dc05786ad969` binds each media document to its
  original canonical nonsecret session path and exactly one corresponding
  scoped HttpOnly cookie. HTTP and WebSocket proxying require matching session
  identity; an old document cannot adopt a newer document's cookie. The
  wrapper ends the child on terminal transport closure/KILL, while the parent
  validates origin, frame and current session, clears connection claims and
  offers manual Reconnect. Connected now requires open transport and video data.
  Broker source SHA-256 is
  `6c7f3b56e4643bf3039c9ea68cdd18e1e3f3a298812e9b384656b10abc264d41`.
- Broker tests 18/18, UI tests 23/23, real Chromium shared-cookie-jar A/B
  revocation/input tests, native and worker KILL teardown, scoped lint, syntax
  and diff checks passed. Independent five-file review found no P1/P2 issue.
  The exact pinned client's ordinary resize/DPR handling changes geometry and
  input mapping within the document, not by reloading; it remains unchanged.
  Explicit native debug/transport-mode settings that reload now require manual
  Reconnect. Actual monitor unplug remains untested.
- `32b1be7e22ced36491667cfe3d2cea852fcc7619` gates selected Selkies sessions
  for both computer kinds at issue, exchange, authorization and renewal on the
  current reviewed runtime revision. Other transports and revocation/release
  remain available. Independent review caught and corrected an application-clock
  liveness shortcut: matching old protocol evidence is always gated, and SQL
  remains authoritative for expiry/revocation. Thus old rolling leases are not
  incorrectly assumed to disappear after five minutes.
- The private owned-source installer is inert until the independently sealed
  `.05.4` manifest/revision hashes are explicitly pinned. It now also binds the
  exact Canary Supabase origin, `.05.3` installed broker/server bytes and
  capability origin, rechecks row/binding authority after the restart claim,
  and bounds prebuild inside the guest. Independent operational review passed.
- Read-only host refresh verified shared default `.04.4` hash/mtime unchanged
  and all 41 isolated Canary files equal the immutable `.05.3` manifest.
  Its host `BUNDLE.sha256` hash is
  `ea3d740e0932327619b61ea2c46db8d449bdaa3cf9e7c4d765186aac71cbb67e`
  (distinct from the JSON release-manifest hash and aggregate bundle digest).
  Canary DB history remains 271 entries through `051600`; pre-`051700` history
  digest is `4189442410f5e13e321b9f668200fa74` using the private stage's recorded
  SQL. No `.05.4` migration, host sync or guest install has happened yet.
- Planned actual acceptance reuses the retained source, launches a new empty
  Ubuntu destination through the normal isolated Canary path, and repeats
  Recovery with old source tab A open, followed by fresh tab B. A must remain
  ended while B accepts input. The former destination and original user
  computers are preserved. Source-session acceptance stays FAIL until that
  deployed flow passes; source tests are not its replacement.

### `.05.4` Canary release applied; fresh Ubuntu acceptance in progress

- Immutable release commit `3267e6627bd4293171bafa4f6e594772e7743278`
  is READY on Canary deployment `dpl_F9HGJureiFuBt5JGvTSbaqbj3yaL`.
  Migration `20260905170000` was applied once against Canary project
  `srrwbdvxlqvqjuexitaf`: the prior 271 history entries and their digest remained
  unchanged, and both resulting function bodies matched the reviewed SQL.
- Owned source VM1123 updated successfully to `.05.4` under operation
  `00000000-0000-4000-8000-000000001020`, with workspace bytes, API configuration
  and control bypass preserved. Its normal Desktop rendered and launcher input
  changed the frame (155 ms browser measurement; not optical latency proof).
- The isolated `/root/hivra-provisioner-canary` sync completed successfully on
  node-b. Backup is
  `/root/.hivra-provisioner-canary-rollbacks/2026.09.05.4.tCGHuHiW`.
  VM counts, active Caddy and storage counters matched before/after; shared
  default bundle hash and directory mtime remained unchanged.
- The retained old destination VM1124 remains `.05.3`. Its normal Desktop now
  renders `Desktop update needed` with no automatic session/install loop.
- Normal launch created owned `CANARY_BINDING_DEST_0905`, computer
  `00000000-0000-4000-8000-000000001021`, 2 CPU / 4 GB on Hivra Cloud.
  Provisioning and recovery/two-tab acceptance are still in progress, not PASS.
  No new paid resource or original user computer was changed.

### Cold Ubuntu launch exposed premature recovery compensation

- The new destination was allocated as VM1120 / `10.240.20.70`, node-b,
  persisted `canary` channel, operation `00000000-0000-4000-8000-000000001022`.
  Launch event: `2026-09-05T04:38:07.748229Z`. Host observations showed guest
  SSH attestation, completed cloud-init and runtime installation. Read-only QGA
  observations then showed Docker/Python installation work and a temporary
  image-build container; no second launch or operator restart was submitted.
- At `2026-09-05T04:49:03.157853Z`, its durable failure event recorded
  `stuck_provisioning_no_result`. The browser changed to Error: provisioning
  did not publish a healthy result and the exactly owned VM was removed.
  Subsequent host observation confirmed VM1120 absent and its provision log
  removed. This disposable empty destination was automatically destroyed by
  recovery; its VM/disk is not recoverable. The retained archive, source and
  former destination were not recovery targets and remain preserved.
- Root cause is a code defect, not merely missing progress feedback: the
  ten-minute evidence sweep called cancellation-style cleanup for a VM with
  no terminal result and no healthy public tunnel. That cleanup can kill the
  still-running installer. VM ownership does not prove installation failure.
  This contradicted the sweep's stated slow-install preservation contract.
- The controller repair now retains the operation fence and VM when no
  terminal provision result exists. Explicit owner cancellation, terminal
  `ready:false`, confirmed VM absence and successful convergence keep their
  existing paths. It does not raise a timeout or assume a missing process proves
  guest execution ended. An unprovable outcome remains pending for inspection.
- Running/stopped no-terminal-result regressions failed against the prior
  implementation, then passed with the repair. All 44 recovery-suite tests,
  full typecheck, scoped lint and diff checks passed. The delete-race regression
  now uses a genuine terminal failed result, retaining that cleanup coverage.
  Canary deployment and another fresh normal launch remain to be verified.
- The generic setup wording also lacks concrete stage feedback and understates
  this cold-install duration. That is a separate UX improvement still pending.
  Recovery/two-tab live acceptance remains FAIL/unverified; no new Hetzner spend.

### Repair deployed; second cold launch underway

- `c39bab225e31d2b1c559a06842f6c876c346801a` is READY on Canary deployment
  `dpl_E7sttrRwXa5qZngsQqtBpsiC7esF`, with `canary.hermesos.cloud` confirmed
  among its aliases. The immutable guest release remains `.05.4`; no new host
  sync, migration or source guest update was needed for this controller repair.
- A single normal UI launch created `CANARY_COLD_DEST_0905`, computer
  `00000000-0000-4000-8000-000000001023`, at `2026-09-05T04:55:16.673950Z`.
  It uses 2 CPU / 4 GB, Hivra Cloud, persisted `canary` channel, operation
  `00000000-0000-4000-8000-000000001024`. It is still provisioning; do not
  recreate it because observation times out. The prior failed row is retained
  as evidence, but its old VM1120 identity must not be treated as current.
- The new allocation is VM1125 / `10.240.20.75` on node-b. A read-only host
  check confirmed it running and the installer at guest identity attestation.
- On retained source VM1123, one normal browser reload reconnected in 5.3 s;
  no second refresh was submitted. The Ubuntu launcher rendered and responded
  to input afterward (179 ms browser input-to-changed-frame sample). Switching
  Desktop -> Manage -> Desktop also retained a usable stream and input, with
  the same session path; this is a view-switch check, not proof of component
  remount or physical monitor unplug. No source files or settings were changed.

### Setup feedback refinement prepared locally

- The onboarding review found two separate feedback gaps: the setup copy
  promised a few minutes despite a longer cold image build, and a failed status
  poll silently kept the old setup screen with no freshness warning.
- The page now records the time of a successful controller status response.
  During provisioning it labels that timestamp as a status check, explicitly
  not installation progress. A failed subsequent poll preserves the previous
  timestamp and shows an unavailable-status warning, which clears after the
  next successful response. Existing polling cadence, runtime authority and
  lifecycle behavior are unchanged. The frequently updated timestamp is not a
  live-region announcement.
- Setup copy no longer promises a few minutes, and explains that users can
  leave and return. There is no invented progress percentage or inferred stage.
  Concrete installer-stage reporting remains separate work.
- Both actual page and activity suites passed: 73 tests, including failed poll
  -> preserved timestamp -> successful response. Full typecheck, scoped lint
  and diff checks passed. This refinement is local only until the current cold
  launch acceptance reaches a result; no claim of deployed visual acceptance.

- Normal Manage -> Destroy cleanup of the earlier failed, empty
  `CANARY_BINDING_DEST_0905` completed after its irreversible-action checkbox
  and exact-name confirmation. The UI returned to Computers and removed that
  entry; its row is `deleted` with VM and operation fields cleared. The earlier
  automatic destruction had already removed its disk; no user data was present
  to recover. This does not independently assert provider API/DNS absence.
  `MY_UBUNTU_DESKTOP` and `CODEX_AGENT` remained running with idle operations;
  retained source VM1123 also remained running. The new VM1125 launch was still
  provisioning under the same operation just beyond ten minutes.

### Second cold launch failed: stale scheduled controller identified

- `CANARY_COLD_DEST_0905` subsequently failed at
  `2026-09-05T05:07:01.593428Z`, with durable reason
  `stuck_provisioning_no_result`. Its installer had been observed alive under
  the exact operation identity; no owner retry or restart was submitted.
  The normal browser now shows ERROR / Provisioning failed and says the
  exactly owned VM was removed. VM1125 and its installer log were removed by
  that cleanup. The failed row remains; it is not a reusable live VM identity.
- The repaired browser deployment was not the scheduled writer. Vercel's
  `hermesos-canary` project (`prj_XEG52ZLtihRGP8Fg6pDZwQCATzVA`) still schedules
  recovery against `dpl_4iYNtyycw8An4NZT2aehwcRyzJV3`, revision
  `3fd37ccfc148f366ad234c9dbc95dc879fc12c9d`. The actual scheduled request at
  `05:06:43.126Z` on that deployment contains the failed fixture identity;
  the current browser deployment `dpl_E7sttrRwXa5qZngsQqtBpsiC7esF` did not
  receive it. Further owned launches are paused until writer alignment.
- Vercel cron follows a project's production slot, not its custom Canary
  environment alias. The existing Canary release verifier already requires
  that production-slot metadata. This is the dedicated Canary project, not
  the actual product production project. Public environment comparisons confirm
  its production slot uses `https://canary.hermesos.cloud` and Canary Supabase
  `srrwbdvxlqvqjuexitaf`; the actual `hermesos` production project uses different
  public app and database URLs. This does not alone establish all shared-host,
  auth or scheduled-resource boundaries.
- Independent review found that a slot move also affects 58 scheduled jobs,
  and a delivery-channel override alone would accidentally lift the owner/ops
  Prepare hold. A local repair now validates the explicit server-only channel
  override and reuses it in those guards. Unknown or conflicting settings fail
  closed, and persisted legacy/default row routing is unchanged. Three focused
  suites passed (39 tests), and full typecheck passed; release review and live
  acceptance are still pending. No live environment setting or slot was changed.
- Before another launch, web, production-slot and cron deployment IDs must
  match the reviewed revision, a real scheduled invocation must be observed,
  and previous invocations must have finished. Instant Rollback alone does not
  update cron jobs; never restore the known destructive scheduler revision.
  Recovery two-tab acceptance remains unverified. No new Hetzner spend.
- Follow-up release preparation: independent source review found no P1/P2 in
  the six-file channel/hold repair. Scoped ESLint and full typecheck passed;
  the additional recovery, launch and bundle-route suites passed 175 tests.
  Private comparisons (values not printed) confirmed the production-slot and
  custom Canary Clerk keys, Supabase URL/service key, cron secret, Proxmox
  targets/SSH key and Hivra host settings match. Existing protection remains
  `all_except_custom_domains`, with no password protection change. Read-only
  node-b preflight still showed 47 VMs (27 running / 20 other), active Caddy,
  shared default BUNDLE hash `6e71628f396712e77aaf2598c929c5f7472dedd16f5a57e28a10cb04c3fc0e63`
  and directory mtime `1788566972` unchanged. The failed cold fixture has not
  been relaunched. These are release preconditions, not cold-launch acceptance.
- Commit `e1b0e08d8a1dd150eccfba5769c5a5f6d45e7fe9` was explicitly pushed to
  PR #600's branch. Added only the non-secret production-slot environment key
  `HIVRA_MANAGED_PROVISIONER_CHANNEL=canary` in the dedicated Canary project
  (environment record `68DWJbWfisDG3ojI`). No other configuration values changed.
  An exact Git-SHA production-slot build was submitted as
  `dpl_FFNgKicRdkQecQTKxkVEmxJHXS3q`; it was queued at the last observation.
  This is not yet scheduler or alias alignment. The custom Canary domain still
  belongs to its custom environment until the new slot is ready and verified.
- The second failed, empty test row was also removed through normal Manage ->
  Destroy, exact-name confirmation and irreversible-action checkbox. It returned
  to Computers and the entry disappeared; the row is `deleted`, with VM and
  operation cleared. Its disk was already removed by the stale sweep; no user
  data was present to recover. Both original computers and retained source1123
  were still running/idle with their persisted default channel unchanged.
- The production-slot build reached READY and the project's cron registration
  now points to `dpl_FFNgKicRdkQecQTKxkVEmxJHXS3q`. Real scheduled recovery
  requests on that deployment returned 200 at `05:28:43.391Z` and
  `05:30:43.215Z`; the latest observed old invocation was `05:26:43.266Z`.
  The old route's committed maxDuration is 300 seconds. Do not submit a new
  cold launch before `05:31:44Z`, and recheck if any newer old request appears.
- A domain configuration PATCH with null custom environment was unsuccessful;
  fresh read showed the custom-environment association unchanged. No repeated
  null PATCH was attempted. Normal `vercel alias set` then successfully pointed
  only `canary.hermesos.cloud` to the new production-slot deployment; the alias
  API confirms exact project/deployment IDs. Its future automatic domain
  association remains custom Canary: **a later branch push can move the alias
  again.** Until that binding is resolved, every explicit release must align
  web and scheduled deployment IDs; do not push during a live acceptance run.
- Normal browser reload on the new alias preserved authentication and showed
  all three retained Ubuntu computers running, with both failed entries absent.
  The STAGING banner disappeared in this environment; this is an observed
  public environment-label discrepancy, not a move to the production app/DB.
  Restore that truthful Canary label in a subsequent reviewed change. The next
  owned Ubuntu name `CANARY_ALIGNED_UBUNTU_0905` has been entered in normal
  launch review (2 CPU / 4 GB, Hivra Cloud); it has not yet been submitted.
- After the old-run 300-second window elapsed, one normal Launch click created
  `CANARY_ALIGNED_UBUNTU_0905` at `2026-09-05T05:32:01.751983Z`, computer
  `00000000-0000-4000-8000-000000001025`, operation
  `00000000-0000-4000-8000-000000001026`. Its persisted delivery channel is
  correctly `canary` despite the Vercel production-slot metadata. It is still
  provisioning, initially before VM assignment. Continue observing this exact
  operation; do not create another fixture because a UI check times out.

### Persistent domain alignment and current install observation

- The previous turn made concrete progress: source repair/review, deployment,
  scheduled-request acceptance and one owned launch. Current fresh state assigns
  that same operation to VM1120 / `10.240.20.70`; this is the new owned computer,
  not the earlier deleted VM1120 identity. Its installer PID remains alive with
  the exact `HIVRA_OPERATION_ID` matching the new operation; its log was updated
  at `05:35:11Z`. This is active installation evidence, not desktop readiness.
- The supported domain update using only `{ gitBranch: null }` succeeded and
  cleared the custom environment association. A fresh read confirms
  `canary.hermesos.cloud` has both `customEnvironmentId: null` and
  `gitBranch: null`. Alias, production-slot and cron IDs all equal
  `dpl_FFNgKicRdkQecQTKxkVEmxJHXS3q`; project protection is unchanged.
  This supersedes the previous future-custom-alias warning. Future Canary
  releases must still use this dedicated project's production slot, explicitly
  from a reviewed SHA, without touching actual product production or merging.
- The missing label was an absent production-slot public setting, not a source
  rendering defect: custom Canary uses `NEXT_PUBLIC_HERMES_DEPLOY_ENV=staging`
  but that key did not exist for this project's production slot. Added the same
  non-secret value for that slot only, record `8Lb8dOxO0GMEMmbp`. It takes effect
  on the next build; no new deployment was made during the cold-launch test.
- The existing unauthenticated first-boot readiness helper now returns true on
  `https://canary.hermesos.cloud`: it requires the application's exact 401 JSON
  denial and rejects redirects. No cookie, provider token, enrollment credential
  or deployment-bypass key was sent. This removes the previous routing blocker;
  it does not yet prove a real guest enrolls.
- A fresh normal UI quote for a second owned cx23 / Helsinki / Ubuntu22.04
  test observed gross USD0.01368/hour including Primary IPv4, USD8.508 monthly
  cap, and 20TiB included outgoing traffic, expiring at 05:47UTC. Guided setup
  will be explicitly selected. Reserve an additional GBP0.20 conservatively
  for this bounded run (not an invoice or FX quote): cumulative reservation
  GBP0.30, unreserved GBP9.70. Cleanup deadline for any newly created resource
  is 06:45UTC today; inspect before retry, use normal exact-resource cleanup,
  and do not leave it unattended or buy further capacity to bypass a failure.
- At approximately05:38UTC, one normal Create server and start billing click
  with billing and guided-setup consent created the second provider fixture.
  The existing request was polled, not recreated; the UI then reported created,
  powered off, not prepared at05:39:45UTC. Continue computer setup -> Continue
  setup was used on that exact selected server. At05:40UTC the normal flow is
  waiting for the computer to connect, with Pause after this step available.
  Billing is active; the GBP0.20 reservation and06:45UTC cleanup deadline above
  apply. Exact provider/order/action identities remain in this task's private
  history and retained browser tab36. No agent or desktop launch is claimed.
- Managed Ubuntu VM1120 remains provisioning with the same operation at
  05:40:28UTC. Continue both existing operations, do not restart either merely
  because an observation interval ends. Keep the source recovery desktop open
  for the later two-session revocation test, and preserve all original resources.
- At05:41UTC, the actual Hetzner guided-setup UI reached Environment prepared
  and linked its ready target. Choose an agent -> Agent Zero retained the exact
  provider host, showed measured2CPU /3.31GB available, and removed managed
  Venice billing from this self-managed flow. One Launch on this computer click
  created `CANARY_HETZNER_A0_0905`, agent
  `00000000-0000-4000-8000-000000001027`, at05:42:21.880644UTC, operation
  `00000000-0000-4000-8000-000000001028`. It is provisioning on the existing
  provider-vm target in self-managed mode; no additional server or model billing
  was requested. Native dashboard, restart, disk-preserving resize and cleanup
  remain to be exercised before calling this provider campaign accepted.
- Read-only QGA on the owned managed Ubuntu confirms cloud-init finished and
  containerd is consuming CPU during installation. The exact outer installer
  remains alive. Its unchanged outer log alone was not evidence of a stall;
  no installation retry or replacement was submitted.
- At05:45:12UTC the managed cold launch was Running, operation cleared, after
  the05:44:43 scheduled sweep on the repaired deployment. The first landing
  revealed a separate launch-link defect: `prepare=1` redundantly requested
  installation and hit the deliberate Prepare hold. Normal Computers -> owned
  computer connected its actual Desktop in4.5s and a launcher click rendered
  the menu (87ms browser sample). The local link repair removes only that query
  flag; it does not lift preparation holds or skip capability checks. Its updated
  regression failed on the prior link, then all13 launch-page tests, scoped lint,
  typecheck and independent review passed. It is not deployed yet.
- Normal recovery transferred the existing encrypted owned archive into the
  empty new Ubuntu: UI reported2files/64bytes restored and verified. Source
  sessionA (`00000000-0000-4000-8000-000000001029`) changed to Desktop disconnected
  with no media frame. A separate source sessionB
  (`00000000-0000-4000-8000-000000001030`) connected in4.6s and responded to its
  launcher click (206ms sample). Well beyond the prior native reconnect interval,
  A remained ended. Escape sent to A did not close B's menu; Escape sent to B
  did. This directly accepts the repaired live two-tab session handoff, not
  arbitrary revocation of every source access method. Both source tabs were
  then closed; original/source files and VM remain. Destination reboot and public
  file-hash verification are next, so complete folder-recovery acceptance is
  still pending at this checkpoint.
- At05:53UTC, the restored Ubuntu's public Box Terminal reported boot time
  05:51:41 after normal Restart. Both restored file SHA256 values matched the
  original archive fixture. Explicit Desktop Reconnect established a new native
  session in10.1s; at05:59UTC its launcher visibly opened with a148ms browser
  input sample. This completes this limited two-file Ubuntu folder-recovery
  campaign, including source two-tab revocation and destination reboot. It does
  not establish whole-computer recovery or physical monitor-switch acceptance.
- The owned Hetzner Agent Zero's native Settings rendered without changing
  inference configuration. A public terminal fixture at
  `/home/bux/canary-hetzner-0905.txt` retained SHA256
  `dc13d8b55252605420d77a1134e95870dcb6d2e111544d1553aca59681f64a24`
  after normal Restart: public terminal boot time changed from05:40:29 to
  05:53:00. No model request or model billing was enabled.
- At06:00UTC, normal Stop reached Stopped. A fresh resize review offered cpx22,
  2CPU/4GB, server-plan USD0.04416/hour and USD27.588/month, excluding existing
  separately billed IPv4. Accepted this exact owned server's disk-preserving
  change under the existing GBP0.20 run reservation and06:45UTC cleanup deadline.
  The UI promises the existing40GB disk remains unchanged and the server remains
  stopped for review. Actual resize completion/start/persistence/cleanup remain
  pending. Price labels expose excessive decimal precision; record this as a
  separate presentation defect, not a reason to repeat the provider operation.
- The resize failed before dispatch: saved operation
  `00000000-0000-4000-8000-000000001031` remained quoted with no billing claim,
  provider POST marker or action. A fresh Hetzner read confirmed the server was
  still off/cx23. The store compared PostgreSQL timestamp strings ending+00:00
  with identical JSON quote instants endingZ, rejecting the intact binding.
  The local repair compares equivalent instants while preserving fractional
  precision; genuine millisecond and microsecond differences still reject.
  Regressions reproduced quote-load and completed-shape failures before repair;
  all33 store/service tests now pass. Independent review and deployment pending.
- Normal exact-name Destroy removed only CANARY_HETZNER_A0_0905 and its
  disposable test file. The app returned to Home with originals still present.
  Capacity-order cleanup finished06:02:57UTC. Independent fresh provider GETs
  at06:03:29UTC confirmed server164641909, IPv4 148136651, IPv6 148136652,
  SSH key118374621 and firewall11577168 all absent. No paid fixture remains from
  this campaign. Cumulative conservative weekend reservation remainsGBP0.30
  (not an invoice); resize acceptance is FAILED, not silently counted as passed.
- The timestamp repair passed scoped ESLint, full dashboard typecheck and an
  independent read-only review: schema validation, null rejection, quote/owner/
  shape bindings and dispatch behavior remain intact. The price presentation
  repair removes only trailing provider decimal padding, retains every meaningful
  digit and at least two decimal places, and leaves reviewed payloads/consent
  unchanged. All5 resize-panel tests and scoped ESLint pass. Neither repair is
  live yet; the paid campaign must be repeated against the deployed repair before
  disk-preserving resize can be accepted.
- Commits86e57f116(timestamp repair) and94fffe1f4(price presentation) are pushed
  to the explicit PR600 branch. Combined launch/store/service/panel checks:
  51tests pass; full dashboard typecheck and scoped lint pass. The dedicated
  hermesos-canary project, not the actual hermesos production project, accepted
  deployment dpl_3JDkSs6DtaPwBY6caf3BwtJBakqV for exact SHA
  94fffe1f43335ec3e0472453f6265fbdf0a78793. It is QUEUED at this checkpoint,
  not yet live. On completion verify alias/production-slot/cron alignment, the
  pending staging banner env, and normal Ubuntu launch navigation. The existing
  live deployment remains e1b0e08d8 until promotion; do not accept this repair on
  that older revision. A new paid campaign needs a fresh quote/reservation and
  cleanup deadline, keeping the cumulativeGBP10 cap. No paid resources remain.
- Fresh preservation read after cleanup confirms MY_UBUNTU_DESKTOP/VM1115 and
  CODEX_AGENT/VM1104 still Running, idle, on their original default channel;
  owned Ubuntu VM1120 remains Running/idle on canary. No customer data mutation
  or whole-weekend completion is claimed. Hourly continuation remains active.
- At06:09UTC deployment dpl_3JDkSs6DtaPwBY6caf3BwtJBakqV was READY; fresh
  Vercel reads confirmed Canary alias, production-slot target and cron deployment
  all point to that exact94fffe1f4 release. The normal Home page reload visibly
  restored the STAGING non-production banner. No new paid server was created.
- The retained owned Ubuntu session908ab77b-a85b-40bf-8b2c-01f35d21be05
  expanded from the853x862 browser's embedded desktop to1512x948 full screen.
  After settling, the actual desktop filled it and its launcher opened; latest
  telemetry279ms/n2/stalls0. This occurred without a session replacement. However,
  after leaving full screen the embedded view remained cropped beyond30seconds,
  with the taskbar outside the viewport. This is a reproduced shrink-transition
  FAIL, not physical monitor-unplug acceptance. Escape first closed the native
  menu; the first attempted tab reload only exited fullscreen (same session and
  telemetry remained), so it cannot be counted as a fresh-page recovery test.
  Tab37 is deliberately retained in this failing state for read-only diagnosis.
- Relevant resize chain: HivraRemoteDesktop.tsx observes iframe/window/visual
  viewport/fullscreen/DPR changes and posts the strict viewport signal;
  provisioner/remote-desktop/broker.cjs forwards a child resize event and input
  resize. Owned guest1120's native bundle is under
  `/usr/local/lib/python3.14/dist-packages/selkies/selkies_web` inside
  `hivra-selkies-desktop`, with source bundle src/selkies-core.js and assets
  index-4mOJQmIr.js, index-CLRBk5j3.css, selkies-core-BmcZD_0O.js. It is minified:
  do not dump entire matching lines. Local upstream reference is
  `/tmp/hivra-selkies-src.FPUOPd/addons/selkies-web-core/selkies-ws-core.js`;
  verify parity with the installed pinned bundle before relying on its behavior.
  No viewport repair has been implemented yet. Continue root-cause diagnosis,
  then regression/review and a bounded live expand/shrink/input check; retain
  provider resize acceptance and all other unfinished goal requirements.
- Continued shrink diagnosis narrowed the failing boundary. Browser DOM reads
  show outer iframe783x654.609CSSpx, native video container783x654,
  video782x654CSSpx and decoded video1564x1308 (DPR2). The browser surface is
  not retaining the old fullscreen CSS dimensions. Owned guest1120's X display
  is:20 (observed socketX20), not:0/:1. Read-only xrandr reports root1568x1308,
  selkies-primary logical monitor1564x1308 and matching Xinerama bounds;
  _NET_DESKTOP_GEOMETRY/_NET_WORKAREA also reflect1568x1308.
- In contrast, xwininfo shows Plasma desktop0x1c00090 still3024x1896 and its
  panel0x1c000ac still3024x124 atY1772, wholly below the shrunken screen.
  One scoped experiment reasserted the already-current1568x1308 mode on output
  screen without changing applications/files; the panel remained atY1772.
  No shell/window-manager restart or repeated resolution toggle was used.
- Installed display_utils.py SHA256 is
  1eef404dab1e1c1cc561b71f75d826441e95b9bfba5684c2c23b851b27dafbc9;
  the local upstream reference differs (4ac431e6...), so it is reference only.
  Installed lines824-850 announce monitor changes with a RandR output-property
  update; lines851-946 replace monitors under a server grab and then announce.
  Official Qt6.9 source updateScreens handles CRTC/output changes, not that
  property notification: https://raw.githubusercontent.com/qt/qtbase/6.9/src/plugins/platforms/xcb/qxcbconnection_screens.cpp
  This supports investigating notification/order behavior, but does not yet prove
  the installed Qt version or the full causal path. Do not patch from a different
  upstream revision or call this repaired. Next: inspect the installed resize/
  monitor publication sequence and Qt version, add a targeted regression and
  correct the native notification boundary rather than forcing client reloads.
- Bounded follow-up rejects the simple notification-only repair. Installed
  Qt is6.10.2+dfsg-7; its matching upstream qxcbconnection.cpp lines558-563
  re-enumerate RandR1.5 monitors on root ConfigureNotify, while693-699 skip the
  older RandR event handler. Thus the prior updateScreens reference alone was
  incomplete, not proof of causality. Installed apply_extended_layout already
  publishes monitors before changing the framebuffer. Both kwin_x11 and
  plasmashell are alive, not exited.
- A single successfully sent current-root ConfigureNotify using the installed
  vendored selkies.Xlib produced no visible panel recovery. Earlier import/event
  construction errors had no mutations; the successful announcement changed no
  display mode, applications, files or process lifetimes. Do not ship this
  hypothesis. No viewport fix is committed or deployed. Keep tab37's failed
  state, stop expanding this diagnostic pass, and resume the pending real
  provider resize/launch acceptance on94fffe1f4 before returning to Plasma's
  screen/panel geometry propagation with a fresh focused approach. This honors
  the core-first priority and avoids an unbounded proof loop.
- At06:22UTC a fresh normal UI quote for cx23/Falkenstein fsn1/Ubuntu22.04
  offered USD0.01368/hour gross including IPv4, USD8.508 monthly base cap,
  20TiB traffic included (USD1.44/additionalTB), expiry06:31UTC. Next owned
  provider fixture name is hivra-a3376d13a96e4b678e46. Reserve anotherGBP0.20
  conservatively: cumulative weekend reservationGBP0.50, unreservedGBP9.50,
  not an invoice/FX claim. Cleanup deadline07:15UTC today. Guided setup will be
  explicitly selected; test only native launch/resize/persistence/cleanup, with
  no model usage. Inspect the same operation after uncertain outcomes; no
  duplicate creation or new deployment during this acceptance run.
- This third paid campaign created server164644193, original action653367611937179,
  capacity-order 00000000-0000-4000-8000-000000001032, setup SSH key118375770.
  Normal request reconciliation reached created/off at06:24:26UTC. Guided setup
  reached Environment prepared at06:26UTC and target
  00000000-0000-4000-8000-000000001033, measured2CPU/3.32GB available. Normal
  Agent Zero launch created CANARY_RESIZE_A0_0905, agent
  00000000-0000-4000-8000-000000001034. It is installing on the same provider VM;
  no additional server/model billing was requested. TheGBP0.20 run reservation
  and07:15UTC cleanup deadline remain active. Do not finish a turn leaving this
  paid fixture unattended; complete acceptance or exact-resource cleanup first.
- Local onboarding clarification labels retired entries in the computer setup
  selector and explains that their saved setup is reference-only, without
  claiming provider deletion/billing termination. History remains inspectable;
  existing live-first selection and terminal-state behavior are unchanged.
  All12 dialog tests and scoped lint pass. This local UI repair is not deployed
  during the current paid acceptance run.
- At06:34UTC the original paid Agent Zero installer reached Running. Native
  Settings rendered through the public dashboard; no settings/model inference
  were submitted. Public Box Terminal created owned marker
  /home/bux/canary-resize-a3376d13.txt, SHA256
  ef040edacef7f46ad69fad91e2fc36cc197d73aadbc338cc445beeb1d8fefc66;
  boot06:25:21, nproc2, RAM3815MiB. Normal Stop reached Stopped.
- Resize acceptance FAIL on94fffe1f4: fresh cpx22 quote USD0.04416/hour,
  USD27.588/month server-only, same2CPU/4GB, disk retention40GB, was confirmed
  through normal UI. Operation422cf7f5-e42c-484b-97a7-7d2532f521e9 dispatched
  once at06:36:29. Provider action653367611955351 completed06:37:17 with
  command change_server_type, not the code/DB's expected change_type. The
  rejected receipt left action null; migrating observation became manual_attention.
  Fresh exact server GET then showed cpx22/running/unlocked/40GB primary disk.
  There was no separate start action after resize. Do not claim Hivra completion,
  stopped-after-resize, increased CPU/RAM, or post-resize persistence acceptance.
- Normal Destroy was explicitly confirmed for this disposable fixture around
  06:39UTC, but is waiting on the locked resize. Root owns the bounded manual
  cleanup fallback for server164644193, primary IPs148140304/148140305,
  setup SSH key118375770 and attached setup firewall11577264. No other agent
  may mutate this fixture. Inspect exact original identity and terminal provider
  action, remove only these resources, and verify fresh absence. Do not clear
  the resize journal or claim the normal removal workflow passed.
- Local onboarding commit9f8d43013 also passes dashboard TypeScript noEmit.
- Manual owned cleanup dispatched delete_server action653367611959030 at
  06:40:02UTC after confirming the resize action was success and the exact
  server was unlocked. Both IPs had auto_delete=true and disappeared with it.
  The now-unattached original setup firewall and exact setup SSH key were then
  removed. Independent fresh GETs at06:41:06UTC confirmed all five resource
  identities absent. No paid fixture remains from this run; cumulative weekend
  conservative reservation remainsGBP0.50, unreservedGBP9.50 (not invoice spend).
  Only disposable marker/data was irreversibly removed. Both originals remained
  running, idle and on default channel. Normal delete acceptance remains FAIL:
  the journal still retains the resize operation, now with an absent server.
  Reconcile that record through a supported exact-absence recovery, not by
  falsifying successful resize or silently clearing its ownership lock.
- Next core repair must cover the actual change_server_type action contract in
  client/service/store/SQL and the real post-resize power behavior. Preserve
  single-dispatch identity and disk-retention checks, add regressions from the
  observed receipt and migrating/running transition, and obtain fresh review.
  Do not deploy an action-name-only patch as full resize acceptance. Also keep
  viewport shrink, real CPU/RAM increase, Windows/Omarchy native launch, native
  app auth and recovery work outstanding. No new paid server until this
  campaign's defects and orphan journal recovery have a reviewed repair.
- Source-only receipt repair now uses change_server_type consistently in the
  project client, service and persisted-action schema. The API path remains
  /actions/change_type and upgrade_disk remains false. The real-command client
  regression failed with502 before the repair, then passed. Added rejection
  cases cover the wrong command, wrong server and wrong resource type, retaining
  exactly one POST. The forward070000 migration preserves every prior action
  validator guard and refuses incompatible existing evidence instead of rewriting
  it; historical migration041300 is unchanged. This is not applied or deployed.
- Focused client/store/service/migration tests passed67/67, then two additional
  service regressions passed with the19-test service suite: an accepted running
  action remains pending through migration without a duplicate POST, and a
  running target cannot falsely satisfy the promised stopped result. Typecheck,
  scoped ESLint and diff whitespace check passed. The first negative test draft
  mistakenly checked providerCode instead of the existing local error code;
  corrected that assertion to code=response_invalid/status502 without changing
  implementation behavior. Fresh-context Pauli review is in progress.
- Read-only Canary preflight at06:46:51UTC found zero journal rows with a
  non-null provider action. Recheck before any future migration deployment;
  this observation is not rollout authority or SQL execution acceptance. The
  current paid fixture is already absent, so do not recreate it or resume its
  completed provider mutation. Fix post-resize power/recovery before another
  paid acceptance. Previous goal turn was progress: live evidence changed the
  diagnosis, paid cleanup completed, and the local onboarding fix was committed.
- Pauli's fresh-context review is GREEN for this narrow receipt patch, not full
  resize acceptance. Rollout must pause/drain resize mutation across the isolated
  migration/app cutover: the zero-row preflight is not a table lock, and the old
  parser cannot read new canonical receipts. Do not roll back to the old parser
  after new receipts exist. Apply only the new migration through the established
  narrow Canary procedure; no broad historical db push. Reviewer found no P1/P2
  introduced; same identity, disk, owner, connection and single-dispatch guards.
- Next source-only repair preserves the confirmed stopped-after-resize contract.
  Migration071000 adds one-use shutdown_attempted_at and exact shutdown_action
  evidence to the original resize journal. A separate guard requires a fresh
  exact target/running observation and successful resize action before claiming
  the shutdown. The existing resize identity/lifecycle/terminal guards remain.
  Canonical shutdown_server action must be successful AND the actual target
  must be off before releasing the computer. Missing receipts remain locked;
  no automatic second shutdown, force-off, restart or resize is allowed.
- GET/observe may read/reconcile but cannot dispatch shutdown. The protected
  apply POST resumes only the existing confirmed quote, then claims the marker,
  checks its local fence and re-reads exact original server/target/IP identity
  before one stop request. The UI continues the saved flagged operation once
  per mount; an uncertain POST is not automatically repeated. A manual continue
  remains available and database dispatch ownership remains authoritative.
- Source tests cover successful resize/shutdown/stopped completion, unknown
  shutdown response, deletion winning, rejected grants, changed final provider
  shape, expired local fence, no provider mutation through GET/observe, and no
  premature unlock. Manual-attention state follows an unverified shutdown after
  120seconds; the original operation is retained. This is a bounded failure,
  not full recovery of every ambiguous provider response.
- Independent review found an incidental-time comparison bug in the new final
  read: observedServer() includes locally generated observedAt. A regression
  advancing toISOString by1ms failed before correction. The comparison now
  normalizes only observedAt to the prior observation and compares all stable
  fields; regression passes. This reviewer finding was not shipped.
- Current focused service/store/UI/route suite56/56, TypeScript and scoped lint
  checks pass. scripts/test-provider-resize-shutdown.mjs executes the two new
  migrations using PGlite with explicitly minimal prerequisite tables. It passes
  owner/deletion checks, fresh observation/terminal resize preconditions,
  one-use marker retention, exact receipt/terminal immutability and RPC access
  checks. It is NOT execution of all historical migrations or full trigger-set
  integration. Final review is pending; no migration, push, deployment, paid
  fixture or live acceptance has occurred for this source repair. The retained
  absent-provider journal still needs a supported recovery path before rollout.
- Pauli's final bounded review is GREEN after the timestamp correction, with no
  remaining P1/P2 on this source patch. This is not deployment approval or full
  migration/live acceptance. Keep resize mutation paused/drained during the
  eventual070000 -> 071000 -> application cutover: both the canonical receipt
  parser and strict journal-column parsing make mixed old/new versions unsafe.
  No new spend in this goal turn; all prior paid test resources remain covered
  by the06:41 exact-absence receipt. The prior goal turn was progress through
  committed126d03acc and its confirmed regression, not a wait or blocker.
- Source-only absent-server recovery adds migration072000 after070000/071000.
  Only persisted explicit deletion intent and a fresh structured Hetzner
  not_found for the original server, using its exact bound connection revision,
  can terminalize the resize as removed. The original quote/action/POST evidence
  is retained; this is neither resize success nor proof of remaining-resource
  cleanup. Agent ownership releases to error/desired deleted and the ordinary
  deletion coordinator must still verify all five resources and retire the
  original target. No resize or power request is replayed by this handoff.
- Focused resize/store/delete/cleanup suites passed112/112, TypeScript and scoped
  lint passed. An additional store acceptance/rejection regression passed in the
  18-test store suite with another full typecheck. Actual-table PGlite execution
  of070000/071000/072000 passes with the real journal/lifecycle/shutdown guards
  and canonical delete claim. Wrong owner/server, stale evidence, missing delete
  intent, missing failure receipt and direct operation clearing are rejected.
  The infrastructure binding validator is explicitly fixture-only in this local
  harness; this is not full historical-schema or live migration acceptance.
- Local inspection hardened the new removed-stage failure-code CHECK against
  SQL NULL acceptance; its regression passes. Existing shutdown SQL harness
  still passes. Independent review is pending. Nothing in this source patch has
  been deployed or applied to the live database; no paid capacity was created.
- Read-only preflight07:17:53UTC confirms owned orphan2bad30ed still retains
  resize422cf7f5 in manual_attention with original POST06:36:29.683324 and null
  action; desired deleted is preserved. Originals24a2ed0a and4d41773d are both
  running with no operation. Retained desktop session908ab77b is still connected
  in tab37 with unchanged10.1s setup/279ms n2 evidence; no refresh discarded the
  cropping reproduction. Tab25 is also retained. Next release must coordinate
  a resize mutation drain and narrow070000 -> 071000 -> 072000 -> app cutover,
  followed first by normal orphan deletion acceptance without any new spend.
- Pauli's independent bounded review is GREEN with no remaining concrete P1/P2
  on the absence handoff. This approves the scoped source milestone, not live
  acceptance. Fresh CLI inspection confirms Canary still points to Ready
  dpl_3JDkSs6DtaPwBY6caf3BwtJBakqV at94fffe1f4 on the dedicated
  hermesos-canary project; no actual product-production target was touched.
- Rollout review caught a retained-deployment gap: moving the alias does not
  disable old Vercel URLs. Source073000 permanently replaces the legacy dispatch
  RPC with a nonmutating rejected tombstone and revokes its service-role grant.
  The new v2 RPC retains the original dispatch body byte-for-byte; only the new
  compatible store calls it. Local PGlite verifies body identity, effective ACLs,
  owner rejection, one-use dispatch/replay and legacy inertness. Store18tests,
  typecheck and scoped lint pass. Pauli independent review is GREEN. The first
  test draft compared two Date objects by reference; deep equality corrected
  the assertion without an implementation change.
- Before any live mutation, narrow CLI stage/tmp/hivra-resize-rollout.J82Zxj
  fetched the exact272 remote migrations; history digest86cd52716b52cf2458a90d8740fd452e.
  Only070000/071000/072000/073000 are added. Planned cutover revokes quote/claim/
  legacy begin and confirms effective denial, drains at least60seconds, requires
  the lone unchanged absent-server orphan and no other active provider actions,
  applies only those four migrations, then deploys the compatible app. Restore
  quote/claim only after verified Ready revision; never restore legacy dispatch.
  GET may persist reconciliation evidence even though it cannot send provider
  mutations, so the quiet-state check is required. No live pause has yet occurred.
- Canary cutover progressed: quote/claim/legacy begin grants revoked and effective
  denial verified at07:26:49.20125UTC. At07:28:09UTC the60s drain had elapsed,
  dispatch remained closed, no unexpected active resize and zero action rows
  existed. Independent exact Hetzner GETs at07:27:35UTC again found original
  server164644193, IPs148140304/148140305, key118375770 and firewall11577264 absent.
- Narrow CLI applied exactly070000/071000/072000/073000, no seeds or roles.
  Nine changed function bodies match reviewed SQL; the previous272 history
  records retain digest86cd52716b52cf2458a90d8740fd452e. Actual bound store read
  against Canary passes for orphan422cf7f5/manual_attention/desired deleted,
  with new shutdown/absence columns null. This is read acceptance, not cleanup.
- Source6b8ae15b21ed712014ec8dcf60ca666f4f29fd64 pushed explicitly to PR600 branch.
  Dedicated Canary deploymentdpl_8NciwjBJTnZRyHp96uNuV5nM9uZK is BUILDING at that
  exact SHA. Quote/claim remain revoked pending Ready+alias verification.
  Resume script/tmp/hivra-resize-rollout.J82Zxj/resume-resize.sql restores
  ONLY quote/claim, asserts all four migrations and inert/revoked legacy dispatch.
  V2 retains service-role execute. No paid fixture or actual product-production
  target was created/changed; do not roll back to an old application parser.
- Ready verification: deploymentdpl_8NciwjBJTnZRyHp96uNuV5nM9uZK at exact
  6b8ae15b21ed712014ec8dcf60ca666f4f29fd64 owns Canary alias, dedicated production
  slot and cron. Quote/claim resumed07:31:19UTC through the scoped resume script;
  current dispatch execute is true and legacy dispatch execute remains false.
- LIVE PASS for the owned absent-server recovery (not fresh resize acceptance):
  tab39 opened the normal agent page, reloaded the new app, Open Manage -> Destroy,
  acknowledged the already-disposable fixture and typed CANARY_RESIZE_A0_0905,
  then Permanently Destroy. The normal UI returned to Home and no longer lists
  that test computer. Agent2bad30ed is deleted/desired deleted/no operation;
  resize422cf7f5 is removed, failure provider_server_absent, with fresh absence
  07:32:28.502UTC and original failed resize evidence retained.
- Normal coordinator receipt records all five absence booleans true and cleanup
  finished07:32:29.538532UTC for ordera3376d13. Original targetb48962f9 is unavailable,
  retired07:32:28.886069UTC. No manual SQL lease clearing or provider POST was used
  for this recovery. All actual test resources had already been independently
  confirmed absent before the UI action; no additional disk data was erased.
  Original MY_UBUNTU_DESKTOP and CODEX_AGENT are visibly running in Home afterward.
- No new paid capacity this turn; conservative reservations remainGBP0.50 of
  the cumulativeGBP10 cap, not an invoice spend claim. Next core acceptance is
  one fresh bounded paid provision/resize/start/persistence/normal-destroy flow.
  Desktop cropping session in tab37 and Agent Zero tab25 remain preserved; no
  desktop refresh or guest mutation was needed for this controller release.
- Fourth paid acceptance reservation before creation: GBP0.20, bringing total
  conservative reservations toGBP0.70 ofGBP10 (GBP9.30 unreserved; not invoiced
  spend). Normal UI quote orderc1a55413-2502-4dee-a4e8-cf8272fb4eeb,
  namehivra-c1a5541325024deea4e8, cx23/2CPU/4GB/40GB, hel1, Ubuntu22.04.
  Fresh displayed rateUSD0.01368/hour gross including IPv4, monthly capUSD8.508,
  no backups/volumes; traffic overage excluded. Target release6b8ae15b2.
  Stop functional testing by08:10UTC and finish owned cleanup by08:20UTC at
  latest; earlier cleanup on failure. Start/guided setup/resize/persistence and
  normal destroy are the scope. Preserve original computers and all prior
  retained managed fixtures. No creation had occurred when reserving this cost.
- Fourth fixture created through the normal price/guided-setup confirmation at
  ~07:35:59UTC: server164648287, create action653376201928973, IPv4148146896,
  IPv6148146897, setup key118377764. Initial provider action running/server
  initializing is not launch acceptance. The original order ID and08:20UTC
  cleanup deadline above remain authoritative; no second creation is allowed.
- Guided preparation completed through UI: original firewall11577416 verified
  07:37:43.993UTC; power action653376201929347; attemptc3483b03-d40e-4456-bd68-375796298096;
  prepared targetf701afe7-ddd9-41e3-b474-e3d2fe331b3f. The live setup dialog defaults
  to this new server and labels all three previous orders Computer retired.
  Choose an agent -> Agent Zero -> nameCANARY_RESIZE_V2_0905 -> Launch on this
  computer created agentc235da4c-9766-4a59-ab28-e000006146fc, original provision
  operationc34fb0a1-641a-4100-a6c9-d6d271a026e0 on server164648287.
  Tab39 tracks that normal installer; no model billing option was selected.
- Fourth fixture native dashboard became Running by07:48UTC and native Settings
  rendered on a real click; cancelled without saving model settings. Public Box
  Terminal created/home/bux/canary-resize-c1a55413.txt with35-byte test line and
  SHA256feb3c26a6cb22b69cfef4e8e0b603ae9f3bb0efeef9c4a65da295d1232b577f7;
  nproc2, RAM3815MiB, boot07:37:57UTC. Normal Stop reached Stopped.
- Live hel1 catalog lacks larger shared-CPU sizes below the current policy price
  ceiling: cx33/cx43 unavailable, cpx32 isUSD50.388/month aboveUSD50 ceiling.
  This test therefore verifies the availablecx23 -> cpx22 plan-family change,
  not increased CPU/RAM. Quote showsUSD0.04416/hour server-only,USD27.588/month;
  originalIPv4 remains separately billed and original40GB disk must be retained.
- UI-confirmed resizedc5f68ab-cf60-4066-87d0-fc143fbec942 dispatched once at
  07:50:15.203225UTC. Actual provider receipt653376201933559 is now correctly
  retained with commandchange_server_type, exactserver164648287, statusrunning.
  UI reports accepted original request and waits for actual type, not an unknown
  action. Shutdown/result/persistence and cleanup are still pending at this point.
- Fourth run FAIL for the promised stopped-after-resize result. Resize action
  653376201933559 succeeded07:50:59UTC. UI automatically sent its single recorded
  shutdown653376201933701 at07:51:01 (provider success07:51:02), retaining the
  marker and receipt correctly. Provider GET07:52:24 still reported running,
  cpx22, original40GB disk, unlocked. UI correctly reached manual attention
  without a second shutdown or resize. Its parent header/power controls stayed
  stale at Stopped while the actual resize lease was active: separate UI refresh
  defect, not evidence the VM was off. No Start control was clicked afterward.
- Root-cause evidence from one pinned, read-only SSH inspection of this exact
  enrolled host: guest boot07:51:01; systemd-logind started and began watching
  the Power Button at07:51:09. The ACPI shutdown was delivered before the guest
  power-button handler was ready. The next repair must verify guest shutdown
  readiness before consuming the one-use provider shutdown marker, not add an
  arbitrary sleep, automatic second shutdown, force-off or false success.
  The diagnostic shell was closed. Its non-sudo sha256sum had no captured stdout;
  no post-resize file-persistence claim is made. No model inference was tested.
- Cleanup: normal UI Destroy saved explicit deletion intent but appropriately
  retained the unresolved resize while the server existed. Exact owner/order/
  server-name/labels/type/disk/unlocked checks preceded the scoped provider
  fallback DELETE for server164648287 only, action653376201935089 at07:56:07UTC.
  Normal UI cleanup then recovered the absent server at07:56:11.044UTC, removed
  the remaining setup resources itself and finished07:56:31.210113UTC. Agent is
  deleted/no operation; original resizedc5f68ab retained as removed, not succeeded.
  UI returned Home with both originals running. Only owned test disk data was
  irreversibly removed; original computers and managed fixtures were untouched.
- Independent GET07:57:08.416UTC confirms all five fourth-run resources absent:
  one server, one IPv4, one IPv6, one SSH key and one firewall (ids redacted).
  No active paid fixture remains. Total conservative reservationsGBP0.70; no
  invoice/FX spend assertion. Cleanup completed well before08:20UTC deadline.
- TEMPORARY CANARY RESIZE HOLD at07:58:20.216101UTC after checking zero active
  resize operations: service-role EXECUTE revoked from quote, claim and v2
  dispatch. Legacy dispatch remains inert/revoked. Do not reuse the previous
  resume script unchanged: it intentionally does not restore v2. Restore only
  reviewed current grants after the guest-readiness repair is deployed/verified.
  Server creation, agent launches, managed computers and other lifecycle controls
  were not disabled. Current deployed revision remains6b8ae15b2; this hold is not
  source completion. Prior goal turn was progress through the coordinated
  deployment and real orphan cleanup; this turn found new runtime evidence and
  completed owned teardown, not a no-progress wait.
- Readiness foundation implemented locally inprovider-shutdown-readiness.ts and
  the existing pinned first-boot SSH transport. Fixed read-only Python checks
  active/running systemd-logind MainPID, an actually open/dev/input/eventN named
  Power Button, and stable boot ID/PID; missing listener, early boot or exceptions
  return not-ready. Strict bounded single receipt contains no credentials.
  No caller-selected command/path and no power action is accepted by this probe.
- Focused probe + existing SSH suites110/110 pass, full TypeScript and scoped
  ESLint pass. Python recipe tests exercise actual script behavior with mocked
  kernel/systemctl reads, including early boot, missing/wrong device, handler
  restart, reboot and timeout. Existing transport retains enrolled host pin,
  in-memory signer/deadline, isolated interpreter, guest timeout and teardown.
- One read-only execution of the exact recipe through QGA on owned managed
  VM1120 returns ready true, boot71536dfb-1013-43f0-ba3a-f68e125a82a8, handlerPID649.
  No service restart, file write, desktop refresh or new paid capacity occurred.
  This validates listener detection on that managed Ubuntu VM, not a new Hetzner
  resize or the SSH wrapper against that provider. The previous paid guest is gone.
- Pauli independent foundation review GREEN/no P1/P2. Listener evidence is not
  proof of future shutdown, inhibitor policy or provider-off state. Integration
  must preserve exact owner/lease/pin, fresh current-boot evidence, single-use
  dispatch and final actual-off reconciliation. The new helper is not yet wired
  into resize and DOES NOT justify reopening quote/claim/v2 grants.
- Next: durable readiness observation/guard before beginShutdown, owner-bound
  probe integration, bounded boot-readiness waiting, and UI continuation only
  when readiness is available. Current once-per-mount continuation must not
  spend its one automatic attempt on an early not-ready result. Existing app
  handlers must fail closed through the database during cutover. Keep the
  separate stale parent status/power-control defect on the repair list.
- Added private provider-resize-readiness adapter: loads the owner-bound saved
  resize, requires its active stopped-desired lease and successful original
  resize receipt, then resolves the original enrollment pin and administrator
  key. It checks the live server against the journal target without weakening
  ordinary current-shape verification. Exact server/network identity, original
  image/labels/disk, bound connection revision and lease are checked; the lease
  is reloaded both before SSH and after its fixed read-only receipt. Observation
  freshness starts before provider I/O and the original monotonic fence is kept.
- Adapter plus resize/store tests 74/74 pass; full TypeScript and scoped ESLint
  pass. Negative tests cover owner/lease/deletion, prior shutdown, enrollment
  bindings, original host pin, server/network/shape/image changes, elapsed
  deadline and unauthenticated results. This adapter is not yet called from
  resize, does not journal readiness and cannot dispatch power. No new live
  mutation, deployment, paid server or reopening of held grants occurred.
- Canary Home was read through retained tab39: originals MY_UBUNTU_DESKTOP and
  CODEX_AGENT and all four retained managed fixtures still display Running.
  No desktop refresh or fixture data change was performed.
- Security follow-up: a diagnostic goal read accidentally repeated the supplied
  key in the task tool result. It is not copied into source or this receipt.
  User was notified to rotate it on return; no credential rotation or unrelated
  account mutation was performed. Future goal inspection must whitelist nested
  goal metadata fields explicitly, never spread the raw response or objective.
- Pauli fresh-context adapter review GREEN/no P1/P2, scoped to these two source
  files; reviewer did not rerun tests or access live. Durable journal freshness,
  current lease/boot binding, final provider identity fence and actual cold-boot
  shutdown acceptance remain required before reopening resize.
- Readiness integration is now locally implemented: private journal fields hold
  the immutable wait start and fresh pinned boot/PID receipt. New shutdown_v2
  requires the exact persisted receipt; old shutdown is inert/revoked. GET only
  probes/journals; protected continuation sends power once, only after readiness
  and final exact server identity plus <15s readiness-age checks. A fixed120s
  window ends in manual attention, never renewed waiting or forced power-off.
- UI displays readiness waiting and saves its automatic continuation until an
  eligible observation. A known no-marker waiting response can continue later;
  an ambiguous POST is still not automatically retried. Applying a resize now
  refreshes parent lifecycle state immediately instead of leaving stale Start.
- Independent review found and resolved a compatibility P2: retained v2 paid
  dispatch could otherwise resize then stall at the retired shutdown endpoint.
  New091000 migration tombstones/revokes paid-dispatch v2 and adds v3 with the
  exact original one-use body. Restore quote/claim/v3 only, NEVER v2. Pauli final
  integrated review GREEN/no remaining P1/P2, scoped source review not live proof.
- 99 focused service/store/adapter/UI/API/migration tests pass, full TypeScript
  and scoped ESLint pass. PGlite checks pass for fresh pin/lease/receipt gating,
  fixed timeout, inert old endpoints, one-use current dispatch and normal absent
  server deletion handoff with the new migrations. Minimal schema fixtures do
  not constitute full historical migration or live cold-boot acceptance.
- Before rollout, live Canary DB reports zero active resizes and v2 dispatch
  EXECUTE still false. No new paid capacity or fixture changes in this source
  step. Narrow090000/091000 migration and exact-revision deployment are next;
  readiness integration is not yet live-verified.
- Narrow Canary rollout completed for090000/091000 only, no seeds/roles or other
  migration files applied. Six function bodies match reviewed source. The prior
  276 migration rows are unchanged (digestd59442e8f787f21b0c0a07d86a5de569 using
  ordered version plus statements); history now contains278 rows.
  Migration SHA256s:09000099ee04cd8c26ca727e02ee9bb8c06463e4f914309a024c524656cb0eddffc3b2;
  0910009d7855b1acf8ba80b20f2f6aa2c9c1b15b9f6f1eb4ea9b9f47b601db9d16c686.
- Dedicated hermesos-canary deploymentdpl_Hs2FvJRyQUQnNbZbBUTN6tLvgqRm is READY,
  revisionff65a4d7b7e6f5d8e95c824d2a4e8915590667c7,
  URLhttps://hermesos-canary-5tb680evm-ashneil12s-projects.vercel.app.
  canary.hermesos.cloud alias, this project's production slot and cron deployment
  all match this exact ID. Actual product-production project was not touched.
  Reloaded only retained Home tab39: normal authenticated STAGING Home renders
  originals and all four managed fixtures Running. Tabs25/37 retained unchanged
  and marked handoff, preserving the connected geometry failure. This is a
  deployed Home sanity check, not cold-boot resize acceptance.
- Fresh bound Hetzner offer read:cx23 andcx33 unavailable in all listed European
  locations; cpx22 available, cpx32 available but monthly gross50.388 exceeds the
  existing USD50 policy. No new paid server was created or policy widened for a
  test. Conservative cumulative reservation remains GBP0.70, GBP9.30 unreserved;
  not an invoice/FX spend claim. Next paid run needs an eligible source/target
  pair and renewed bounded fixture reservation/cleanup deadline first.
- Quote and claim remain held; paid-dispatch v3 was explicitly revoked again
  after the rollout and zero-active-resize check, while legacy v2 stays inert
  and revoked. Restore quote/claim/v3 only for the next reviewed acceptance run;
  never restore v2 or the legacy shutdown entry. Do not call readiness live-fixed
  before actual shutdown/stop/persistence/cleanup acceptance. While capacity is
  unavailable, continue the retained desktop geometry and other core work.
- Desktop geometry root cause isolated on owned VM1120 / computer
  00000000-0000-4000-8000-000000001025, runtime2026.09.05.4, retained browser
  tab37/session908ab77b-a85b-40bf-8b2c-01f35d21be05. Capture/logical monitor were
  1564x1308 while CVT realized a1568x1308 CRTC/root. Plasma retained its old
  fullscreen1512x948 logical screen and its taskbar was outside the capture.
  /proc/297/maps verifies the running Plasma actually links Qt6.10.2; KWin
  reports the new root but Plasma's read-only screenGeometry still reports the
  old size. Qt qxcbscreen.cpp setMonitor calls updateGeometry only when monitor
  and CRTC rectangles match; the unequal branch assigns geometry without the
  screen-geometry-change notification. Reference:
  https://raw.githubusercontent.com/qt/qtbase/v6.10.2/src/plugins/platforms/xcb/qxcbscreen.cpp
- One narrowly asserted diagnostic mutation used the installed Selkies helper
  to align the single logical monitor to the already-realized1568x1308 root.
  It immediately restored the desktop/taskbar in the same browser session,
  without refresh, guest/process restart or file changes. Helper source SHA256
  1eef404dab1e1c1cc561b71f75d826441e95b9bfba5684c2c23b851b27dafbc9.
  This monitor-only experiment is not the shipped repair: capture still differed
  by four physical pixels and all geometry layers need to agree.
- Enabled the existing native Force Aligned Resolution setting on this owned
  fixture only. Fullscreen then rendered the complete taskbar and desktop with
  root/monitor3008x1888. Installed settings.py verifies true|locked parsing and
  refusal of conflicting client values; selkies.py aligns dimensions before
  updating capture/display state. Added SELKIES_FORCE_ALIGNED_RESOLUTION=true|locked
  to the actual private Docker environment recipe, preserving auth, isolation,
  transport and workspace settings.34 guest-installation tests pass; Pauli
  independent exact-diff review GREEN, source review not independent live proof.
- Shrink acceptance remains incomplete: Escape and the native fullscreen toggle
  did not exit the outer fullscreen view through available browser controls.
  A temporary783x654 viewport override also did not change that fullscreen
  surface and was reset. No host-app workaround was attempted after access was
  denied. This exposes a separate need for a visible in-product exit control;
  it is not evidence that aligned shrink failed or passed. Tabs25/37/39 retained
  and marked handoff. No additional provider spend, fixture creation/deletion,
  global resize grant changes, blanket desktop restart or original-machine
  mutation occurred. The recipe is not yet in a new sealed runtime or deployed;
  fresh-fixture resize/reconnect and multi-display acceptance remain outstanding.
- Fullscreen exit follow-up: the Hivra UI now requests fullscreen on the existing
  desktop section instead of the bare iframe. The header remains in that surface
  with an explicit Exit full screen button, including after disconnection. Native
  fullscreenchange drives the label; failed exit remains visible and retryable.
  The same iframe, source and authenticated session remain mounted throughout.
  Regression covers the ancestor target, visible exit, browser exit event,
  rejected exit/retry and iframe identity.23 focused UI tests, full TypeScript
  and scoped ESLint pass. This is local implementation, not deployed browser
  acceptance. The geometry recipe also still needs a new immutable release and
  exact provider/runtime closure; do not push/deploy it as rewritten2026.09.05.4.
- Pauli independent fullscreen diff review GREEN/no P1/P2; unchanged frame
  ResizeObserver continues to publish the actual content dimensions. Browser
  enter/exit with guest focus and viewport restoration remain required. The unit
  test mocks fullscreen APIs and does not prove native browser fullscreen.
- Prepared immutable runtime2026.09.05.5 for alignment; historical manifests
  remain unchanged. Desktop revision
  23cdd4556859116021241cfb0349634f7eabc30de15503f295e586d639d5628c;
  provider bundle64f86f200ee20aa06e4ff2a56369daddd7b85a723a1688a5e113b8f16f98e596;
  workerbbf88b8f971e1166c29152a581a8caa4a4ea590caea134d655ab340cb8b833ad,
  27894bytes. Native cleanup closure is unchanged. Current worker/runtime imports
  advance while original .4 identities/recipes remain exact for recovery.
- The session gate now uses an explicit .4/.5 protocol list rather than forcing
  a disconnect for an installer-only release. Tests prove broker.cjs/server.cjs
  bytes still equal sealed .4 and reject pre-binding .3; issuance, authorization
  and renewal test both accepted revisions. Existing origin/PKCE/generation and
  database authority checks remain in place. New180000 migration normalizes
  exactly to170000 after removing only the new release identity/admission entry.
- Release/capability/native-worker/session/migration focused checks pass; current
  session suite25, portable compatibility26, immutable bundle checks4. TypeScript
  caught a missing new version literal in the identity union; corrected and full
  TypeScript now passes. Generated migration inventory also caught six previously
  committed resize migrations missing from that generated index. No migrations
  applied, push/deployment, guest update, provider spend or live grant change in
  this packaging step. Independent seal review and exact Canary rollout follow.
- Independent seal review GREEN/no P1/P2: all41 asset hashes, provider/desktop
  digests and migration normalization checked separately. Only VERSION, worker
  version and desktop installer differ from .4. Manifest SHA256
  6a43aa506f8e7c4ec8bfbbae79e7a187376ce60e3765b03fcea4652951b53575;
  migration SHA256b8741e7eb257192a879c1a2752b169f3c6d03b359935d5288c9bde6d6283d8ca.
  Reviewer performed no live actions. Fresh .5 fixture and browser acceptance
  remain required; this signoff does not close them.
- Applied only180000 to Canary project srrwbdvxlqvqjuexitaf after a one-file
  dry run, with no seeds/roles. Both live function bodies match reviewed source.
  History now279; the prior278 rows retain digest
  a39211e9edf5d7f89fed24fe6aeb965d (ordered version plus statements). Resize v3
  EXECUTE remains false. No guest or provider resource was changed.
- Pushed reviewed96685e63c6f64cd7bc9dfb640f3e0d96afa46938 to the existing PR
  branch. Dedicated hermesos-canary deploymentdpl_8CemxU5ttqaGJPgxW2nwTXC25jEi
  accepted that exact SHA and is queued, not yet live-verified. URL
  https://hermesos-canary-7axmvm8gm-ashneil12s-projects.vercel.app.
  Actual product-production project remains untouched. Continue observing this
  same deployment ID rather than dispatching another job on a polling timeout.
- Alignment deployment is READY. Canary custom alias, dedicated project's
  production slot and cron deployment all resolve to
  dpl_8CemxU5ttqaGJPgxW2nwTXC25jEi /96685e63c6f64cd7bc9dfb640f3e0d96afa46938.
  Session API route suites22/22 also pass. Bound Hetzner read now reports cx23
  available in fsn1/nbg1 (hel1 unavailable); cpx22 remains available. No purchase
  or resize grant reopening occurred; GBP0.70 reservation remains unchanged.
- Real browser exit acceptance passed on retained owned Ubuntu VM1120, not a
  fresh .5 guest. First reload from old iframe-only fullscreen did not replace
  page assets: its observed chunk15lj7ld6rcb0h still had no exit implementation.
  Navigation first exited fullscreen with ERR_ABORTED; normal Home navigation
  followed by reload outside fullscreen loaded current STAGING Home. Originals
  and four retained fixtures remain Running. Opening the owned computer through
  Home produced session 00000000-0000-4000-8000-000000001035 (4.5s setup).
  Full screen visibly includes the header and Exit full screen; clicking Exit
  restored the embedded desktop with the same session URL and connected state.
  No guest restart or upgrade occurred. Native .4 geometry remains outside the
  new recipe acceptance; next check must create a fresh .5 fixture and exercise
  shrink/expand/reconnect. Browser tabs25/37/39 retained for continuation.
- Fresh normal-UI launch CANARY_ALIGNED_V5_0905 uses existing managed Canary
  capacity,2CPU/4GB, no provider purchase. First submission returned the managed
  host readiness error before creating an agent/journal receipt: isolated node-b
  was still .4 while fresh Canary launch requires .5. This is a rollout ordering
  dependency, not evidence of an in-flight duplicate launch or guest failure.
- Synced only /root/hivra-provisioner-canary on node-b through the existing
  validated rollback-capable sync script. Local configured-target dispatcher
  returned unchanged/false; direct named-host SSH ran the same hostname-checked
  script. Sync reports .5 and preserves VM counts28/20/48, active Caddy, and
  storage870318080/538117668/332200411. Prior bundle retained at
  /root/.hivra-provisioner-canary-rollbacks/2026.09.05.5.AvDjbYWh.
  Shared /root/hivra-provisioner remains .04.4, VERSION mtime1788566972 unchanged.
- Resume Same Launch then bound one owned computer:
  00000000-0000-4000-8000-000000001036, operation
  00000000-0000-4000-8000-000000001037, VM1125 /10.240.20.75 onpve11,
  managed_provisioner_channel=canary. Browser navigated normally to its Desktop
  detail and shows Setting up with actual status-response timing. Still
  provisioning, not yet desktop acceptance. Test cleanup target is this exact
  fixture through normal Manage/Delete after checks, with09:45UTC cleanup audit
  deadline. Do not remove retained VM1119/1120/1123/1124 or originals. No new
  Hetzner spend or resize grant change occurred.
- Fresh .05.5 fixture became Running and connected through the public desktop
  path without an extra refresh. Guest capability revision is
  23cdd4556859116021241cfb0349634f7eabc30de15503f295e586d639d5628c;
  selected guest environment confirms SELKIES_FORCE_ALIGNED_RESOLUTION=true|locked.
  No manual alignment toggle was used on this fixture. Session
  00000000-0000-4000-8000-000000001038 stayed connected through outer fullscreen
  (3008x1696), visible Exit full screen back to embedded (2400x992), and an
  explicit 855x876 browser viewport (768x656 guest monitor). The complete taskbar
  remained visible. Clicking its folder icon opened Dolphin in the narrow view.
- Reset the browser viewport override, then performed one normal page reload
  outside fullscreen. Reconnected automatically with session
  00000000-0000-4000-8000-000000001039 and 5.3s secure setup; Dolphin remained
  open and the full taskbar was visible at restored browser dimensions. This is
  browser geometry/reconnect evidence, not physical display unplug, multiple
  logical monitors, native Selkies fullscreen, reboot, or input-to-photon proof.
- At approximately09:39UTC, normal Manage / Destroy with the exact disposable
  fixture name removed agent42598512-e81f-499e-be77-179507512693 and VM1125.
  Canary DB query returns no instance row; node-b qm list excludes1125 and
  pvesm list local-lvm --vmid1125 returns no volumes. Originals1104/1115 and
  retained1119/1120/1123/1124 remain Running. No user data was created in this
  disposable fixture; its disk deletion is irreversible. No Hetzner purchase.
- Cleanup feedback gap observed: after successful backend removal the detail
  page still displayed the old Running header and enabled controls, without
  automatically returning to inventory. One reload redirected to Computers.
  Record this as a separate UI follow-up, not a cleanup failure or desktop
  geometry failure. Fresh test cleanup completed before09:45UTC audit deadline.
- Next paid acceptance reservation: GBP0.20 for one new guided Ubuntu22.04
  cx23/fsn1 fixture and cx23-to-cpx22 compute-type transition, cleanup audit
  deadline2026-09-05T10:30:00Z. Conservative cumulative reservation GBP0.90,
  GBP9.10 unreserved (not invoice/FX spend). Preserve the primary40GB disk and
  verify a harmless owned file across resize/stop/start; remove this exact new
  order and its owned provider resources through normal cleanup afterwards.
  No CPU/RAM increase claim: cx33 remains unavailable in Europe; cpx32 exceeds
  the current product monthly price policy. cpx21 is available only in US
  locations, so it is not an eligible same-location resize from fsn1.
- Preflight revalidated current Canary alias/production slot/cron to deployment
  dpl_8CemxU5ttqaGJPgxW2nwTXC25jEi, READY at96685e63c6f64cd7bc9dfb640f3e0d96afa46938.
  Quote/claim/v2/v3 resize service grants remain false before the new fixture.
  Browser Infrastructure reports no provider servers; live cx23/fsn1 quote
  shows USD0.01368/hour including primaryIPv4 and USD8.508/month gross cap,
  excluding traffic overage. Ubuntu24.04 was inspected but not purchased:
  guided setup explicitly supports Ubuntu22.04 only; changed selection before
  creation. This reservation precedes any purchase; next receipt must bind the
  actual order/server IDs, or state if no purchase occurred.
- Submitted the single reviewed guided Ubuntu22.04 creation at09:43UTC:
  order 00000000-0000-4000-8000-000000001040, server164662066,
  name hivra-e6fbea8663f74362951b, create action653393381839672.
  First UI response is Creating / Initializing, not ready. Observe this exact
  request, never submit a duplicate. The10:30UTC cleanup audit and GBP0.20
  reservation apply to this order and all its owned resources.
- Same request became Created Off; independent provider read confirms server
  164662066 off with PrimaryIPv4 148160454 and PrimaryIPv6 148160455. Normal
  Continue Computer Setup / Continue Setup advanced through startup and
  authenticated first connection to Environment prepared. Enrollment
  00000000-0000-4000-8000-000000001041 is enrolled; target
  00000000-0000-4000-8000-000000001042 is ready, launchReady=true, .05.5 with
  provider bundle64f86f200ee20aa06e4ff2a56369daddd7b85a723a1688a5e113b8f16f98e596.
- Guided Ubuntu handoff cannot launch: the standalone linux-desktop provider
  profile is intentionally not accepted in portable-provisioner-contract.ts,
  and LaunchJourney filters Ubuntu to Proxmox. This is unimplemented provider
  desktop scope plus misleading setup handoff, not a failed guest preparation.
  Do not remove the gate without implementing and accepting that substrate.
- Used the same prepared server for the supported Codex lifecycle test. The
  unified wizard's default2CPU/4GB was blocked by measured3.32GB available even
  though the server is exclusive. Selected existing Advanced3GB to proceed;
  review displayed2CPU/3GB, but accepted agent is correctly the entire2CPU/4GB
  provider VM. This is a reproduced resource-selection/review defect, not a
  successful sizing UX. Source: LaunchJourney selectedTargetFits compares
  draft.resources against measuredTargetCapacity for all self-managed targets,
  despite provider launch using the whole computer. Fix and regress separately.
- At09:50UTC normal Launch accepted agent2538908a-1891-4d67-bfb8-da98256473ed,
  CANARY_RESIZE_READY_V5_0905, on the same paid server. Tab39 is its terminal
  detail showing Setting up / original installer checks. No second provider
  purchase, no resize action, and quote/claim/v3 still held. Cleanup deadline
  remains10:30UTC; use this agent's normal Manage deletion once acceptance is
  done, or normal original-order cleanup if launch cannot finish in time.
- Correction to the earlier DB cleanup query: Hivra computers are stored in
  hivra_agents, not hermes_instances. Current authoritative query confirms
  fresh managed42598512-e81f-499e-be77-179507512693 is status=deleted (retained
  tombstone), not an absent row. The independent VM1125/disk absence checks
  remain valid. Provider2538908a-1891-4d67-bfb8-da98256473ed is2CPU/4GB.
- Provider fixture reached Running and its public Box Terminal rendered as
  bux on hivra-e6fbea8663f74362951b. Created owned noclobber marker
  /home/bux/canary-resize-e6fbea86.txt; public terminal SHA256
  ec3179512f603b6ac4b01587f0222771f5cab56465e82da3fc3d963f30d9bc21.
  This is pre-resize evidence only. Native Codex inference is not accepted.
- Reopened exactly quote/claim/current-v3 service_role EXECUTE on Canary for
  this bounded paid run; v2 remains false. Restore these three to false after
  acceptance/cleanup. Normal Stop reached stopped in authoritative hivra_agents
  and UI. After settling, Manage offered cpx22 and Review Price & Downtime;
  requested that review, not yet confirmed a resize.10:30UTC cleanup unchanged.
- Confirmed reviewed cpx22 quote on the same stopped fixture. Resize operation
  00000000-0000-4000-8000-000000001043, provider action653393381845578 succeeded.
  Readiness wait began09:58:42.881058UTC, positive observation09:58:58.914UTC,
  one shutdown marker09:59:01.033642UTC/action653393381845856 succeeded. Independent
  provider read confirms same server164662066 is cpx22/off with unchanged IP IDs.
  DB observation agrees with target2CPU/4GB/80GB advertised and retained40GB disk.
  This passes the previously failing readiness-before-ACPI segment only.
- Completion remains FAIL: UI reports saved original operation/unverified;
  operation stays provider_pending despite successful provider actions/off.
  Read-only identity/shape checks match. A transaction-scoped completion
  diagnostic with rollback reproduces SQLSTATE55006: "First-boot setup owns
  the capacity order", from guard_first_boot_operation_order, rejecting the
  completion's infrastructure_capacity_orders current_server_shape update.
  Diagnostic made no durable state change. Do not retry resize or send another
  shutdown. Fix the guard/ownership transition with regression and independent
  review, then reconcile this original operation; cleanup audit10:30UTC remains.
  Tab39 moved from Manage to Box Terminal to stop extra UI resize polls; agent
  remains logically provisioning/resizing, provider physically off. File
  post-resize/start readback still pending; do not mark resize end-to-end PASS.
- Source fix c187b8bed removes fictional provider RAM slices in unified launch,
  uses existing runtime-floor headroom and whole-computer review text. Managed
  and Proxmox sizing unchanged.15 focused launch tests, full TypeScript and
  scoped lint pass. Initial fixture had non-integer byte count and a widened
  inherited error-code type; corrected test data before passing checks.
  Independent review GREEN/noP1/P2 confirms owner-bound backend ignores requested
  slices and persists actual provider size. Not pushed/deployed/live-accepted.
- Re-held quote/claim/v3 after finalization failure; current privilege read
  confirms all three false and legacyv2 false. Existing-operation observation
  and completion remain available for the repair; no new paid resize allowed.
- Fix83aa70600 adds a narrow inactive-setup-lease exception for only changed
  current_server_shape/fingerprint/updated_at on the same created_off order.
  Existing shape guard remains the strict terminal owner/order/server/chain/
  stopped-observation/disk authority. First-boot receipts, cleanup and deletion
  branches unchanged. Migration190000 SHA256
  bff7e6af45cdf1d6e1893d723893c65726d4ef4a9bf4583eb324bc35a2b76580.
  Actual old/new guard+shape-validator regression passes positive publication
  and negative active lease, unverified resize, wrong owner/server/disk/chain,
  receipt mutation and deletion; existing cleanup SQL test and49 resize/store
  tests pass. Independent review GREEN and byte-exact old guard preservation
  outside the exception verified. No security/identity gate removed.
- Rollback-only actual-Canary-schema completion test passed through all seven
  enabled order triggers. Verified afterwards that original function remained,
  shape was still unpublished and resize provider_pending. Applied only190000
  after exact one-file dry run, no seeds/roles. Live guard body matches source;
  history280, prior279 digest001af4c9d28cb9e1265e9e40381c8bdd unchanged.
- Normal Manage observation then completed original resize at10:10:31.52827UTC:
  succeeded, cpx22, retained40GB disk; agent stopped and operation_id cleared.
  No second resize/shutdown. Normal Start reached Running; public Box Terminal
  reconnected and SHA256 of /home/bux/canary-resize-e6fbea86.txt exactly matches
  pre-resize ec3179512f603b6ac4b01587f0222771f5cab56465e82da3fc3d963f30d9bc21.
  This accepts this whole-VM type-change/stop/start preservation path, not a
  CPU/RAM increase, native inference, provider Ubuntu Desktop or all profiles.
- Normal exact-name Manage/Destroy removed the disposable provider fixture and
  automatically returned to Home. Independent scoped GETs confirm absence of
  server164662066, IPv4 148160454, IPv6 148160455, SSH key118381268 and firewall
  11577743. Original two and four retained managed fixtures remain Running in
  Home. Disk/test marker deletion is irreversible; no user files were placed
  there. Cleanup completed before10:30UTC audit. No active paid fixture remains;
  conservative reservation GBP0.90, GBP9.10 unreserved, not invoice/FX spend.
  Quote/claim/v3 remain held; legacyv2 remains inert. Unified provider-sizing
  UI fix c187b8bed remains source-only, pending exact Canary deployment and
  browser acceptance. No actual product-production deployment occurred.
- Pushed exact1c0868ef19aab101f262c872da0ee655d8e89788 to existing PR600 branch
  codex/hivra-core-experience-plan. Dedicated Canary deployment
  dpl_6ZSxemp8LYgZf5kQ8rm5A6RJSQUX is READY at that SHA;
  https://hermesos-canary-l1oeoct5k-ashneil12s-projects.vercel.app.
  canary.hermesos.cloud alias, hermesos-canary production slot and cron all
  match this deployment. Actual hermesos product production untouched.
- Reloaded only Home/tab39 against that release. Authenticated STAGING Home
  renders all four computers and two agents Running, originals and retained
  fixtures preserved. This is release/inventory sanity, not live acceptance of
  the changed provider-sizing screen: no ready disposable provider target now
  exists after successful cleanup. Keep that narrow acceptance explicitly open.
- Restored quote/claim/current-v3 service_role EXECUTE after successful prior
  resize/persistence/cleanup and zero active resize check. All three verified
  true; obsoletev2 remains false/inert. One historical quoted row is expired,
  one resize succeeded, two removed. No new provider purchase or fixture.
- Next substantive core gap is standalone Ubuntu Desktop on connected provider
  VMs. Current setup supports agent runtimes only; implement and accept that
  adapter/identity/lifecycle path before lifting the linux-desktop provider gate.
  Reuse its future bounded fixture for deployed whole-computer sizing acceptance
  where compatible; do not buy another server solely to repeat a settled test.
- Onboarding fix8207a34469f41c706f53023b7258b5a9602e5948 now checks the existing
  provider-runtime support contract before returning a prepared target to launch.
  Ubuntu Desktop gets an explicit unsupported-provider warning and a computer
  journey link without targetId; no silent substitution with an agent. Launch
  links additionally require environment_prepared, not a stale retired ready flag.
  Sixteen focused ProviderComputerSetupDialog tests, full TypeScript, scoped lint
  and diff checks pass. No backend/runtime admission gate changed.
- Exact dedicated Canary deployment dpl_BqPnENUiipt3FP3hrUvNXizojDCi is READY
  at8207a34469f41c706f53023b7258b5a9602e5948. Alias, Canary production slot and
  cron all match. Browser tab39 reloaded the Ubuntu infrastructure journey,
  opened saved Computer Setup, rendered the warning and all five retired test
  records, then clicked Choose compatible capacity. It reached
  /dashboard/launch?kind=computer without a provider target, with Windows and
  Omarchy still gated. This verifies warning/return behavior on real retained
  history; the prepared-ready branch is regression-tested, not newly live-tested.
  No new provider purchase, setup dispatch or live-resource mutation occurred;
  GBP0.90 reservation/GBP9.10 unreserved unchanged. Original sessions preserved.
- Provider-desktop source trace: hivra-install-agent.py v3 currently permits
  Proxmox only; provider worker identity and store support v1 agents/v2 DeepSeek,
  and desktop capability inspection uses Proxmox/QGA. The remote-desktop route
  also deliberately rejects protected-Canary self-managed callbacks. These are
  unimplemented target behavior, not permission to remove the gates. Independent
  design review identified that v1 check_launch would otherwise admit a newly
  permitted non-DeepSeek desktop with no native cleanup obligation. Next work:
  distinct desktop worker identity and retained stop-only cleanup closure,
  explicit legacy negative admission, SQL cleanup/release fences, owner-bound
  provider inspection and scoped callback/session authority. Never disclose a
  project-wide Vercel protection secret to a user-root provider VM. Only then
  compose launch/readiness/lifecycle and run a bounded disposable desktop test.
- Fresh callback evidence refines the preceding access gap: hermesos-canary
  already has protection all_except_custom_domains. Without cookies, bearer
  tokens or bypass credentials, POST{} to canary.hermesos.cloud's five desktop
  callbacks reaches the application: exchange400 Invalid request; authorize401
  authorized:false; renew401 renewed:false; input-transition401 confirmed:false;
  terminate401 revoked:false. This is unauthenticated ingress/auth rejection,
  not a valid session or guest acceptance. No deployment setting was changed.
  The existing canonical browser origin can be used for the upcoming scoped
  callback path; a separate ingress deployment is not presently required.
- Added private provider-desktop-launch-contract.ts plus34 focused regressions.
  It binds the standalone v3 payload to the original server-selected computer,
  canonical control/browser origin and journaled direct hostname or named tunnel.
  Agent/model/browser variants, mismatched authorities and bypass credentials
  are rejected with credential-free diagnostics. TypeScript, scoped lint and
  diff checks pass. Independent Pauli review GREEN/noP1P2 for this uninstalled
  foundation only. No current caller, guest worker, SQL gate or public catalog
  was changed; no runtime bundle was resealed or deployed for this foundation.
  Next implementation remains desktop v3 worker identity/retained cleanup before
  dispatch, followed by provider-bound inspection and authenticated sessions.
  No new paid resources; GBP0.90 reserved/GBP9.10 unreserved remains unchanged.
- Staged cleanup foundation8153a9dcc adds remote-desktop/provider-service-owner.py,
  an uninstalled stop-only controller with no privileged CLI. Its caller must
  already hold manager/install locks, durable cancellation and the pre-activation
  ownership plan. It validates exact unit hashes/effective metadata and the
  recorded container ID/image/computer+operation labels before mutations; stops
  only broker/chat/Selkies units and that exact container, disables boot start,
  then freshly observes service/container cgroups and loopback listeners. The
  read-only observer never stops services or trusts a cached success. No lease
  release, workspace deletion, image/network removal or Docker daemon stop exists.
- Independent review found twoP2s, both repaired before commit: an alternative
  Docker cgroup parent could inspect the wrong scope, and AutoRemove could delete
  writable data on stop. Require explicit system.slice, Docker systemd/cgroupv2,
  AutoRemove=false and the running init's exact /proc/PID/cgroup. Foreign parent,
  auto-remove, foreign process cgroup, unit/container identity, unresolved shutdown,
  Linux-root, absence/partial state and real nofollow/link/mode regressions pass.
  Seventeen Python tests plus the Jest wrapper/existing legacy worker suite
  (28 Jest cases total), scoped lint and staged diff checks pass. Fresh independent
  re-review GREEN for this uninstalled foundation only; no Linux/provider live
  cleanup claimed. The immutable .05.5 bundle and deployed8207a3446 are unchanged.
- Integration must prepare/create before activation: the future v3 worker captures
  exact container ID and reviewed unit-plan hashes before any service starts,
  retains the stop closure, then activates under a once-only fenced grant. Units
  must reference that container ID, not rm/stop a name; provider Docker-create
  must set system.slice/no auto-remove. Never infer authority from resources seen
  at cleanup. Earlier missing-Docker/unloaded-unit partial failure is unverified
  and needs the worker's separate pre-activation recovery fence. This controller
  does not prove whole-VM cleanup or arbitrary daemon-submitted work has ended;
  original provider deletion authority and SQL release fences remain required.
  No new paid resource or live mutation in this checkpoint; budget unchanged.
- CANDIDATE HOLD: local provider integration now modifies
  provisioner/provision-claude-code-box.sh, which no longer matches the sealed
  .05.5 manifest. Do not push/deploy, load this local bundle, prepare targets or
  purchase another fixture until full v3 composition and an additive immutable
  release are sealed/reviewed. The running Canary remains8207a3446 with its
  existing immutable .05.5 runtime; no live deployment or shared host changed.
- The private HIVRA_PROVIDER_DESKTOP_PREPARE_ONLY=1 mode is admitted only for
  linux-desktop/provider-vm before package/service mutation. It installs the
  shared base but skips chat activation and returns before desktop installation,
  chat readiness and runtime receipt publication. Base terminals still follow
  the legacy setup path; this is not a no-services/whole-VM preparation claim.
  Mode0/default managed Ubuntu and DeepSeek paths remain unchanged. Twenty-one
  focused Jest cases (actual extracted Bash mode/activation/return gates plus
  existing LinuxDesktopgateway), Bash syntax, scoped lint and staged diff pass.
  Independent Pauli review GREEN for this candidate source delta only. No full
  root installer or provider live acceptance claimed.
- Next: compose provider Docker-create (explicit system.slice, no auto-remove,
  original computer/operation labels), deterministic exact-container-ID units,
  write-once ownership plan and activation intent in the existing install lock;
  retain cleanup before dispatch. Then connect v3 worker identity/SQL recovery,
  capability inspection and callback sessions before sealing/enabling. Earlier
  partial failures must not infer not-started merely from missing ownership data.
- Private provider service-plan foundation now journals create intent before a
  single stopped Docker create, recovers a lost acknowledgement by inspection
  only, and publishes exact-container-ID service texts plus ownership hashes.
  Unknown outcomes never dispatch another create. No activation or lease release
  exists in this helper. Independent review caught and resolved two P2s:
  additional Docker namespace/device/publishing authority and overridden image
  entrypoint/command. Strict configuration checks and rejection-before-publication
  regressions now cover both; independent re-review GREEN for this foundation.
  Fourteen Python cases, three focused Jest suites (20 cases including Python
  wrappers), scoped lint and diff checks pass. These are simulated checks, not
  Linux/provider acceptance. Locked durable journal callbacks, private credential
  binding, exact network-ID ownership, fresh activation checks and provider
  resource headroom remain integration requirements. The candidate hold above
  still applies; no push/deployment or paid resource was created. Budget unchanged.
- Candidate guest installer now separates prepare_guest from managed activation.
  Private slots-based PreparedGuest carries the original 12 local values without
  credential-bearing repr/dict; it is not a serialized journal or receipt.
  Managed install still composes both phases once. Main and independent AST
  comparisons confirmed every original executable installer statement preserved
  in order. Preparation still starts Docker and rotates private credentials, so
  provider recovery must not rerun it after an uncertain acknowledgement.
  Independent review caught an import regression from the initial dataclass;
  a plain class and the existing unregistered dynamic-import regression fixed it.
  Re-review GREEN for extraction only. Five Python phase tests and four focused
  Jest suites (23 cases) pass; existing guest-installation/capability/phase suites
  have 56 passes and ONE release-pin failure: source revision2e38779b442b066299b28682df9ce060f712f310ad4bbcf78696a43a26efab8c
  differs from sealed23cdd4556859116021241cfb0349634f7eabc30de15503f295e586d639d5628c.
  This is the expected unsealed candidate HOLD, not a green release suite. Do not
  update the pin alone or deploy this source. Scoped lint/diff pass. No guest,
  network, credential, provider resource or deployed runtime was changed live.
- Provider worker admission now uses explicit matching pairs: v1 with the five
  existing legacy runtimes, or v2 with DeepSeek. The former complement-of-native
  check could classify a future parser-admitted desktop as legacy, without its
  cleanup obligation. Both dispatch and execution invoke the explicit guard.
  Six executable boundary regressions preserve legacy/native acceptance, reject
  desktop/future/crossed/substrate pairs, and simulate future parser admission
  while proving control() rejects before ownership publication or dispatch.
  Three focused Jest wrappers (six boundary, fourteen service-plan and five
  installer-phase Python cases), scoped lint/diff pass; independent review GREEN.
  This closes a v3 integration prerequisite, not an exposed current launch bug:
  the existing parser already rejects provider desktop payloads. No v3 public
  gate was lifted. Worker bytes now also differ from the sealed .05.5 recipe;
  retain the candidate hold and historical pins until the additive release seal.
  No push, live mutation or new paid fixture; budget remains unchanged.
- Live Agent Zero acceptance check, 2026-09-05 11:30-11:36UTC: normal Canary
  Agents inventory -> retained CANARY_CHANNEL_A0_0905 -> Dashboard rendered the
  native Agent Zero interface. Exact agentbef3ddc0-857b-4b07-b7dd-ee9837f2ad26,
  VM1119/node-b; fresh receipt reports2026.09.05.3/schema2 and Docker reports
  running image sha256:d8fd86114b02e9b4b6f14ef6f696b1ba7af46e52327734bb8a77f7aaf8556cf0.
  Vercel CLI resolves Canary to READY dpl_BqPnENUiipt3FP3hrUvNXizojDCi,
  project hermesos-canary (existing deployment, not the local unsealed candidate).
  One no-tools prompt requesting HIVRA_AGENT_ZERO_CHAT_OK reached native chat,
  which showed the explicit connect-a-model gate. No model reply/inference
  acceptance: this fixture has no configured model. No credentials copied or
  provider/model setup altered. UI rendering and setup-gate behavior pass; real
  inference remains unverified until an authorized model is configured.
  The owned Chat #1 was closed through the native control; fresh page reload
  confirms No chats to list and no queued test message. Initial separate-tool
  Clear/Close confirmation attempts expired before confirmation; this was not
  a demonstrated deletion defect. Completing both clicks within the confirmation
  window worked. Only the disposable test chat was removed; retained computer,
  other agents and files were preserved. No new capacity or spending. Browser
  tab39 left on the retained Agent Zero dashboard and marked handoff.
- Provider service preparation now requires the original private desktop env
  bytes, checks exact security switches/generated credential shape, and binds
  the full pinned-image-plus-overrides environment into a digest-only intentv2.
  Recovery compares the container's actual environment before ownership is
  published; credential rotation, missing/extra/duplicate variables fail closed.
  Eighteen executable preparation cases pass, including evaluating the actual
  installer env expression for parity and checking no credential in journal,
  argv, result or surfaced error. Four focused wrappers (46 Python cases total)
  and diff checks pass; independent review GREEN for this private delta only.
  The captured inspection output is secret and must never be logged by the
  future command adapter. Checked-file provenance, exact network ownership and
  fresh pre-activation consistency still require composition; no launch gate was
  lifted. Unsealed candidate remains undeployed, budget unchanged, no live action.
- Provider network preparation is now create-once under the original journal:
  intent precedes Docker network create, computer/operation labels are checked,
  and lost acknowledgement recovers only the original observed network. Existing
  names without intent are never adopted. Service preparation requires the
  network ownership record, freshly verifies it, uses its exact ID for create,
  and binds that ID into private create-intentv3. Managed prepare_guest retains
  its existing default network behavior; a private in-process network callback
  connects provider preparation with no fallback. Provider handoffs cannot enter
  managed activation. No CLI/public admission option was added.
  Independent review caught the normal Docker created-but-unallocated endpoint
  form (empty NetworkID before first start). Strict empty operational fields are
  now admitted only with created/PID0 and exact HostConfig networkID; populated
  network IDs must match. Realistic positive fixture and foreign/missing-field
  negatives pass, as do unknown create-ack, changed network, and callback tests.
  Twenty-six Python service-plan cases and eight phase cases pass; focused Jest
  wrappers plus existing guest-installation checks pass. Diff check and independent
  re-review GREEN for this preparation slice. No Linux/provider activation or
  live launch acceptance claimed. Runtime/revision pins intentionally remain
  unchanged while the candidate is unsealed; no deployment or new spending.
- Provider base preparation now also leaves the chat unit file unwritten, so
  the owned publisher need not replace a competing legacy definition. The new
  private publish_units path reads original ownership, verifies deterministic
  unit hashes, and requires initially absent/stopped services before journaling
  intent. Recovery validates every existing file before exclusive publication of
  missing0644files; no foreign service is overwritten. Linux renameat2 uses
  RENAME_NOREPLACE, avoiding the link/unlink crash window. Completion requires
  fsync, daemon-reload and fresh loaded/stopped observation from the retained
  cleanup module. No enable/start, activation marker or readiness claim exists.
  Thirty-one service-plan Python cases (including real test-owned file/mode/inode
  partial-publication recovery), seventeen owner cases and four focused Jest
  suites (27 cases including wrappers), Bash syntax, scoped lint/diff pass.
  The Linux exclusive syscall and OS/service observations are substituted in
  macOS tests; actual Linux/systemd publication is unverified. Independent review
  GREEN for this slice. The v3 worker still must compose these private operations,
  perform fresh private-file/container checks and retain activation/cleanup fences.
  Candidate remains unsealed and undeployed, with no live mutation or new spend.
- Private provider activation now freshly reads the three configuration files
  using dirfd/no-follow, exact owners/groups/modes, single-link, bounded/stable
  file checks. Broker computer/origins/paths must agree with server-selected
  arguments and its Basic credential must agree with the desktop env; provider
  protection-bypass material is refused. The original container's full env,
  image and network are then checked against its retained preparation intent.
  Loaded, stopped owned services are required before an activation intent is
  journaled. Only then may enable/start run, with cancellation checked between
  calls. An existing activation intent prevents all redispatch after lost ack.
  No readiness receipt, compensation or lease release is inferred from this.
  Thirty-five service-plan cases and twelve installer-phase/config cases pass,
  including actual installer-expression parity, real file link/mode/owner checks,
  changed credentials, cancellation after intent and lost-ack/no-redispatch.
  Four focused Jest suites (37 cases including Python wrappers), diff check and
  independent review pass. These are local tests with OS/service observations
  substituted, not Linux activation acceptance. Verified retained modules, both
  original-operation locks and cleanup of partially activated services remain
  mandatory v3 worker caller obligations. Next: compose shared readiness checks
  and worker/SQL lifecycle fences, seal the additive runtime, then launch through
  Canary. No public gate lifted, push/deployment/live mutation or new spend.
- Shared guest readiness is now separated from managed activation. The private
  provider path requires its original exact container/network IDs, fresh private
  configuration, image/isolation checks and protected HTTP401/authenticated200
  observations. Credentials remain on curl stdin, not argv. After HTTP
  convergence it checks all three services and the exact running container and
  network again, without retries or starts, before capability publication.
  Independent review caught stale pre-HTTP process evidence; stopped-during-HTTP
  and final inactive-service regressions now prevent publication. Nineteen Python
  phase/config/readiness cases and three focused Jest suites (36 cases including
  wrappers) pass; diff check and independent re-review GREEN. OS and HTTP probes
  are substituted locally, not live browser acceptance. Managed behavior remains
  on its named-container path. Candidate remains unsealed, unpushed and
  undeployed; v3 worker/SQL composition and real Canary acceptance remain open.
  No live mutation, paid fixture or additional spend in this slice.
- The private install_prepared_base composition now journals preparation intent
  before any credential-rotating guest preparation, then connects owned network,
  exact container creation, unit publication, activation and shared readiness.
  Any predecessor phase record blocks re-entry; failures and cancellation never
  rerun preparation or infer a stopped/clean VM from absent ownership. The
  returned network and readiness computer identity must match, and the final
  journal binds original ownership to a capability digest without credentials.
  Forty service-plan Python cases and nineteen phase/config/readiness cases pass;
  three focused Jest suites (36 cases including wrappers), diff check and
  independent review GREEN. New composition cases substitute phase functions;
  these prove ordering/fences, not Linux execution. The private caller still
  requires original operation/install locks, bounded execution, retained cleanup,
  empty-VM preflight and completed prepare-only base installation. Public worker
  admission remains v1/v2 only: v3 lifecycle and SQL integration are next, not
  silently enabled by this helper. Candidate remains unsealed and undeployed;
  no live mutation or additional spend.
- Private desktop recovery now retains the original stop-only owner and worker
  bytes, validates both against the original manifest and executes the checked
  owner bytes without reading the current bundle. Cleanup requires cancellation,
  an empty installer worker, install lock and original computer/operation-bound
  ownership. Missing ownership after dispatch stays pending; it is not a
  not-started proof. Stop results require service/container/listener/boot-disable
  evidence, same boot and a fresh stopped observation. Historical proof is
  re-observed and bound to the ownership digest before reuse. Review identified
  interrupted publication residue: retention now rejects unexpected files before
  publishing and checks the complete folder before returning, without deleting
  residue. Eleven Python cases exercise real private files/digests/retained-code
  execution with substituted service observations; three focused Jest wrappers,
  scoped lint and diff check pass. No Linux service cleanup acceptance claimed.
  The broader guest/native worker suites are RED (36 failing cases at plan
  construction): the unsealed local worker differs from the .05.5 size/SHA
  recipes. Those gates remain unchanged, not waived by scoped test results.
  Public v3 identity/launch admission is still closed, and these private recovery
  functions must be wired to original dispatch/run/control and SQL authority
  before release. No push, deployment, live mutation or additional spend.
  Independent bounded re-review GREEN after the residue correction; this does
  not change the broader unsealed-release RED result.
- Shared guest installation now has a private owned-desktop callback path:
  prepare-only base, exact desktop readiness identity, runtime receipt, then
  access configuration. A provider desktop without that callable is rejected
  before commands, and non-desktop/managed runtimes reject the callable. Private
  parser admission is explicitly v3/provider-only; the ordinary stdin parser
  and provider worker admission remain closed. Failures prevent later steps,
  without retry or an inferred cleanup result. Twelve executable launch-boundary
  Python cases and three focused Jest suites (51 cases including wrappers),
  diff check and independent review pass. Commands/access are substituted in
  the new composition cases, not live provisioner acceptance. The original
  worker must still supply locks, preflight, once-only dispatch and retained
  cleanup; v3 worker/SQL integration and additive sealing remain open. No push,
  deployment, live mutation or additional spend.
- Provider desktop capability observation now has a private pinned SSH entrypoint.
  It snapshots the original ownership/access/transport before network activity,
  validates the retained ownership probe, and uses the existing fixed interpreter,
  host pin, original administrator key and bounded dispatch deadline. Returned
  capabilities must match the original computer/origin and current revision with
  fresh observation time. Regression coverage includes caller mutation, invalid
  identity, pin/deadline rejection, stale/duplicate/wrong-owner responses and
  nonzero remote exit. Both focused suites pass (130 tests), full typecheck and
  scoped lint pass, and independent transport review is GREEN. This is read-only
  source integration, not authenticated public-session or provider launch
  acceptance. No runtime asset or migration changes, push, deployment, live
  mutation or additional spend; readiness/public callers remain gated.
- Private provider desktop capability probe now verifies retained .05.6 worker
  and owner bytes, exact manifest, original successful worker/ownership/network/
  readiness journals and capability digest under existing non-creating locks.
  It observes owned services, original container/network/mount and empty worker
  before and after the shared desktop inspection, capturing output until the
  final check passes. The shared provider branch uses exact container/network
  IDs; managed/Omarchy behavior stays intact. No service starts, repair, current
  bundle substitution or credential rotation occur.31 focused tests pass,
  including11 generated Python cases using real private files/locks with root
  ancestor metadata, OS observations and the shared body substituted. Tests
  catch retained-byte drift, cancellation, foreign identity, unsafe/missing
  locks, changed capability/network and late stop/detach without output.
  Typecheck, scoped lint/diff and independent review pass. This is capability
  evidence, not authenticated browser acceptance: pinned SSH transport/caller,
  public session checks and actual provider launch remain required. No sealed
  runtime asset/migration changes, push, live mutation or additional spend.
- Candidate worker v3 integration now binds Linux desktop computer IDs to the
  original operation and the future .05.6 desktop cleanup profile. It validates
  usable retained cleanup before once-only dispatch, executes the retained
  controller, consumes the launch once, runs the shared owned composition under
  the install lock, and separates immutable installer outcome from desktop
  cleanup status. Journal publication uses short manager locks, waiting only for
  ordinary status contention within the original boot/deadline/cancel fence.
  Fresh-base preflight refuses existing users/runtime paths, Docker/containerd
  state/configuration/socket or service definitions, and existing desktop/base
  units. This is not adoption of an existing Docker host. The host floor is
  2CPU and 6GiB actual RAM for the fixed4GiB desktop plus host headroom; provider
  quote/UI sizing must select a compatible tier (normally8GB) before enabling
  this contract. Narrow0700->0711 parent traversal allows non-root broker access
  without opening the0700 provider bundle or installer journal; custom trees
  fail closed. Review found and resolved lock-contention, state-parent traversal
  and alternate Docker-data-root gaps. Twenty-two Python worker/cleanup cases
  and six focused Jest suites (54 cases including wrappers) pass; diff check and
  independent re-review GREEN. Files, locks and publication boundaries are real
  local fixtures; service/installer/HTTP observations are substituted, not live
  launch evidence. Existing generated-wrapper release suites remain RED until
  the additive seal. Server TypeScript/SQL admission is still closed to desktop;
  .05.6 is a candidate label, not a sealed/deployed release. Next: server adapter,
  SQL dispatch/cleanup/readiness and sizing bindings, additive seal and actual
  Canary provider launch/delete. No push, live mutation or additional spend.
- Server operation binding now uses explicit legacy/native/desktop contracts,
  not the complement of a native boolean. Private desktop reads require both
  linux-desktop type and explicit ubuntu-desktop profile; Omarchy/Windows/null
  profiles and other runtimes are not reinterpreted. Existing loaders reject
  desktop before capacity reads. Original owner/operation/allocation and scoped
  capacity checks are preserved; desired-deleted and missing-access operations
  remain readable for recovery without granting dispatch. Twenty-nine focused
  binding tests cover runtime/profile/provenance and old-loader behavior.
  Typecheck found an existing candidate test subprocess env missing NODE_ENV;
  its isolated environment now explicitly uses test, with no ambient inheritance.
  Combined binding/base-prepare tests pass (51 cases), full TypeScript check,
  scoped lint/diff and independent loader review pass. Database responses are
  fixtures, not live SQL acceptance. The new binding has no production caller;
  desktop worker builder, SQL grants/readiness/sizing and additive seal remain
  next. No deployment, live mutation or additional spend.
- Additive .05.6 source seal created with43 assets (1,003,207 bytes), including
  the private desktop owner and service plan. Manifest SHA256
  cc20a601026563359549049bdc01082ef7bf411228267e165d35f88f986265fc;
  provider bundle1226dfc97e54f745b84b934e89246adc4453f85b3bdad1e14fc892d9ff5d1da4;
  worker69d9f21cfb5e592ce1d0fa2f587cb22812c6bb7e9543fa7233780910951b4a42,
  44,874bytes; desktopa3b299a308848f68063e4915219a1343bddf9550fabd80dc5be54384c3cd2f42;
  desktop stop closured3dd454b6f386deadb0d3f45f0eee3cb21999f5229c0a831b5dc62f82a578225.
  Native closure remains ec0ab1faeadd46c4a21f03bde01b24e88f5d2a7e89f632b9c0e193cb51713b91.
  Existing manifests/migrations are untouched. New200000 migration adds only
  prepared-computer/native-v2 release identities, normalizing byte-exact to180000
  after the intended additions; it does not authorize desktop dispatch. SHA256
  f268e081ed631287e9fea2dc78ff76b59f2bf27fd674b74d6866c68a03ccd641.
  Review caught current-constant predecessor loss; .05.5 is explicitly retained
  in Proxmox/LinuxDesktop/provider/model-setting gates, with regression coverage.
  .05.4/.05.5 session compatibility is retained with both broker/server byte
  hashes checked; insecure pre-binding revisions remain rejected. Historical
  .31.3 controller tests now read an exact pinned fixture (61229d0fa5a6383ab42f3a77967d0db9bcc2a5242eba91e900c4851b2a3f2b9f),
  not a version-string substitution of the newly different v3 program. Eight
  focused suites (186 cases), full typecheck, scoped lint/diff and independent
  seal review pass. This resolves the prior source-pin RED gate, not live
  acceptance. No push/deployment/migration application or new spend; provider
  desktop server builder, v3 SQL grants/readiness/sizing and actual launch/delete
  acceptance remain required before the overall deployment hold can lift.
- Private desktop server worker contract now binds v3 commands to the exact
  sealed .05.6 bundle, worker bytes, desktop cleanup closure, original computer,
  operation and provider scope. Start requires the server-owned computer/control
  origin/access binding; recovery carries only the original identity and a fresh
  guest clock, without reloading launch credentials. The generated wrapper uses
  the verified retained controller first and refuses a current-bundle fallback
  after dispatch. Strict receipts distinguish stopped installer outcome from
  current-boot desktop-service cleanup; neither grants whole-computer deletion.
  Three focused suites pass (111 cases), including the actual Python launch and
  closure parsers plus 42 generated recovery-wrapper executions using real
  temporary files. Full typecheck, scoped lint/diff and independent review pass.
  No runtime asset, sealed manifest or SQL migration changed. This remains a
  private contract with no dispatch caller: SQL grants, lifecycle/readiness,
  resource sizing and real Canary provider launch/delete acceptance are next.
  No push, deployment, live mutation or additional spend.
- Desktop worker transport is now wired to the existing pinned SSH boundary:
  request/authority/credentials/assets snapshot before awaits, clean signed guest
  clock channel followed by the exact verified worker script, and the original
  monotonic deadline across both channels. Returned cleanup proof is checked
  against that invocation's clock and original worker identity. It has no public
  caller and acquires/releases no lifecycle authority itself. The SSH suite
  passes all112 cases (14 new desktop cases); desktop cases use injected channels,
  while existing shared-transport cases exercise real signed loopback SSH.
  Typecheck, scoped lint/diff and independent transport review pass. No live
  service, runtime asset, manifest, migration or spend changed. Next integration
  gate is a dedicated desktop SQL dispatch/access/cleanup lifecycle contract;
  the legacy/native admission paths must remain separately constrained.
- Added the private .05.6 desktop cleanup SQL prerequisite in210000: exact v3
  identity/stopped-receipt validators, a service-role-read-only observation
  journal and owner/original-provision-scoped begin/record/verified functions.
  Only explicit Ubuntu provider desktops qualify. New observations invalidate
  old proof; expired grants, pending cleanup and conflicting outcomes cannot
  authorize verified cleanup. Direct journal writes and public-role access are
  denied. Actual isolated PostgreSQL tests exercise these functions, NULL/drift
  rejection, scope, supersession, expiry and permissions. The minimal agent
  fixture substitutes dispatch; it is not full lifecycle or live acceptance.
  Combined SQL/worker tests pass (49 cases), full typecheck, scoped lint/diff
  and independent SQL review pass. The migration is unapplied and does not
  widen shared identity admission, dispatch or release any operation. Next:
  desktop access/dispatch and lifecycle handoff guards, server adapter/readiness,
  sizing and actual Canary launch/delete. No new spend or live mutation.
- Staged220000 adds dedicated Ubuntu desktop access/dispatch and initial
  lifecycle handoff SQL. Exact v3 identities are recognized by the shared
  identity/stopped validators; legacy dispatch and running completion explicitly
  refuse desktop identities. Desktop access is journaled with dispatch, retained
  through the original operation, and checked against the provider address for
  running state. Cancellation blocks readiness even after an observation grant
  expires. A stopped outcome alone cannot release the original operation;
  fresh grant-bound desktop cleanup is required. Named/direct access and
  credential-free initial running CAS are covered by real migration fixtures.
  Review/test caught and fixed two stale parameter references and a direct-write
  v1 bypass for unsupported desktop profiles. Omarchy/Windows/null-profile
  direct writers now fail alongside the public RPC negatives. Existing legacy,
  native, power and ownership sections passed before the initial desktop
  parameter failure; corrected desktop checks then passed against the same full
  migrated schema using a focused entrypoint that skips unrelated timer tests.
  Both PostgreSQL Jest checks, full typecheck, scoped lint/diff and independent
  corrected initial-lifecycle review pass. Migration SHA256
  8a3ce8bc7a25664410e56ca1c7d852cd739611222ff344b17532769e268424b4.
  Unapplied: server adapter/public readiness, sizing and post-provision
  start/restart/resize completion remain integration gates before enablement.
  No runtime asset changes, push, deployment, live mutation or added spend.
- Private desktop server store/adapter now connects the v3 SQL contract to
  the pinned SSH worker. Fresh start binds the original computer/access plus
  runtime server-configured control origin before dispatch; recovery loads
  neither current assets nor launch/control-origin credentials. Original
  provider receipt, scope, host pin, deadline and installer outcome are checked
  before persistence. Cancellation acquires its observation grant before SSH;
  stale/superseded/lost-acknowledgement evidence retains the operation, never
  releases it or claims readiness. Actual adapter/store RPCs are exercised
  against the full isolated lifecycle schema, with provider/SSH responses
  substituted. Combined142 tests, full typecheck, scoped lint/diff and the
  completed independent adapter review pass. Public launch/delete callers,
  provider desktop capability/readiness, sizing and live acceptance remain
  unconnected. No runtime assets or migration bytes changed; no push,
  deployment, live mutation or additional spend.
- Initial provider Ubuntu readiness is now connected to the authenticated,
  owner-scoped status route. It retains the original provision operation across
  installer/provider/pinned desktop observations and public ingress checks,
  rechecks cancellation/binding before the dedicated desktop running CAS, and
  never mints/stores a desktop session or model credential. Unsupported/null
  desktop profiles cannot fall through to the legacy agent or Proxmox lanes.
  Normal owner/PKCE session issuance must still follow stable running state.
  Four focused suites pass (86 tests), full typecheck/scoped lint/diff pass,
  and independent review of the revised source slice is GREEN.
  **Release HOLD:** review exposed an actual gateway/broker mismatch. Public
  ingress goes through port8080, so health is plain `ok`, desktop metadata is
  provided by the gateway, and computer root returns404. The gate now matches
  those contracts, but correctly still requires the broker's exact framing CSP.
  Sealed .05.6 gateway `proxyHttp` strips `frame-ancestors` even on its desktop
  authority-preserving route. A real loopback gateway-plus-broker fixture
  reproduces the missing directive and proves readiness rejects it; this is
  failure evidence, not public desktop acceptance. Next additive runtime release
  must preserve desktop proxy framing headers and change that fixture to prove
  successful composition. Do not weaken the CSP gate or rewrite .05.6 seals.
  Running capability refresh/session routing, fresh launch/delete/sizing,
  post-provision lifecycle and actual provider/browser acceptance remain.
  No runtime assets/migration bytes changed, no push/deployment/live mutation
  and no additional spend. Full goal remains incomplete.
- Fixed the reproduced gateway framing defect and generated additive .05.7.
  The desktop-only authority-preserving proxy now retains broker CSP/XFO;
  other agent proxy header handling and credential stripping are unchanged.
  The actual gateway-plus-broker fixture now requires the exact control-origin
  framing policy and successful public-ingress readiness. Native gateway
  composition and existing gateway checks also pass. No session/rendering or
  live provider acceptance is implied by these loopback HTTP observations.
  The seal has43 assets/1003428 bytes; manifest SHA256
  e4068b1b490b33d580429edeff89e81032ea58720c8e16d40efb2d7157e4b635,
  bundle d3631ea66b7d74084e1f29e7795f2459e6e215c4f97a6e231ccf480f3cb9ba9b,
  worker3bc2aca851d67270b801e0885ac161c4cd71d274bc74ead91732f7a5e786bbd0
  (44822 bytes). Desktop broker/server/installer bytes and capability revision
  remain unchanged; the outer gateway is bound by the new provisioner bundle.
  Exact .05.6 native/desktop recovery identities and manifests remain readable;
  fresh starts require .05.7. All four portable compatibility lists retain .05.6.
  Additive230000 admits only the exact new release pairs; existing cleanup and
  lifecycle authority are preserved. Migration SHA256
  f1e624db19e2297e8842f24c253b63c0afd46856eed9d094e3671fd17db051c2.
  Eight focused suites/120 tests, full typecheck, scoped lint/syntax/diff checks
  and actual desktop adapter/store/lifecycle SQL against the full migrated
  isolated schema pass. Independent gateway fix and release reviews are GREEN;
  review also caught the stale generated migration inventory, now regenerated
  to include200000 through230000. All older manifests and migration bytes are
  untouched. Source-only: no push, deployment, applied live migration, paid
  resource or additional spend. The remaining provider launch/session/delete/
  sizing/lifecycle integrations and live acceptance still hold deployment.
- Stable provider Ubuntu capability refresh now joins the existing desktop
  access path without a Proxmox VM ID. The owner-scoped refresh route delegates
  to a strict running/idle provider loader, retaining original allocation,
  installer identity, access journal, enrollment scope, target and provider IP.
  It re-verifies the enrolled provider and SSH pin, executes the read-only
  desktop probe and public-ingress check, and reloads state before recording.
  New060000 wraps the existing capability ledger with a row lock and exact
  identity/access/IP/target/lifecycle checks. It creates no new session format,
  cookie, credential or installer; owner PKCE issuance remains unchanged.
  Provider Prepare is explicitly rejected rather than falling into Proxmox
  installation, and non-Ubuntu/null profiles cannot be adopted as Ubuntu.
  Three focused suites/65 tests, full typecheck and scoped lint pass. The actual
  TypeScript loader/RPC runs against the full isolated migrated schema under
  service_role: shared-ledger recording passes; changed IP/target, wrong owner,
  and a delete request after the observation reject refresh. Service-only RPC
  privileges are checked. Independent bounded review is GREEN. The generated
  migration inventory includes060000. This is local route/protocol/database
  integration, not live refresh or authenticated provider browser acceptance.
  .05.7 assets and all older migration bytes remain untouched. No push,
  deployment, live migration, extra resource or additional spend. Fresh
  launch/delete/sizing and post-provision lifecycle plus full live acceptance
  remain required; full goal stays incomplete.
- Provider desktop deletion now selects the v3 cancellation adapter only for
  an explicit Ubuntu provision, preserving profile and original allocation
  across intent/reloads. Provision release requires stopped installer plus
  separately recorded cancellation cleanup; pending, uncertain or expired
  proof holds the operation. Stable desktop removal retains the original
  five-resource absence gate and does not reinstall or dispatch guest cleanup.
  The focused delete suite passes75 tests; full typecheck and scoped lint pass.
  The actual delete adapter/owner loader/intent/release RPCs also pass against
  the isolated migrated SQL schema, including pending cleanup, superseded
  grant and a release response lost after commit. Independent bounded review
  is GREEN. No runtime asset changes, push, deployment, live migration,
  resources or spend. Launch admission/capacity and post-provision lifecycle
  remain the next local integrations before live provider desktop acceptance.
- The private provider launch adapter now accepts explicit Ubuntu only, rejects
  browser automation and browser-supplied control origin, and validates the
  runtime server origin before target/credential work. Admission requires exact
  .05.7 prepared bundle/scope,2 CPU and6 GiB quote plus freshly measured total
  and available host memory; the actual provider VM size is retained. This
  covers the4 GiB desktop container plus host headroom without pretending the
  desktop container is the entire VM. Reservation/reload bind runtime/profile
  as well as the original allocation; dispatch uses only v3 with server-chosen
  computer identity/access/origin and no model secret. Uncertain dispatch keeps
  the original provisioning row. Two focused suites/108 tests, full typecheck,
  scoped lint and independent GREEN review pass. Public launch/placement remain
  closed: this is private adapter integration, not real provider launch or SQL
  reservation acceptance. Public request/reservation, provider power completion,
  resize floor and live desktop/browser acceptance are still required. Sealed
  .05.7 assets untouched; no push/deploy/live migration/resource/spend.
- Added read-only provider desktop power observation: the original retained
  ownership probe can now capture the kernel boot UUID before inspection and
  verify it again after final ownership observation. A changed or invalid
  boot suppresses output; the bounded power receipt also validates the nested
  original desktop capability. The dedicated SSH entrypoint snapshots input
  and keeps the existing host pin, administrator authentication and deadline.
  Two focused suites/140 tests pass, including execution of both generated
  Python variants on private fixture files and13 power cases for ownership,
  drift and output suppression. Full typecheck, scoped lint and independent
  review are GREEN. This supplies restart observation, not power dispatch or
  completion. Next: connect the original power-operation store/adapter and
  desktop-specific running finalizer, then resize/public launch admission and
  actual browser acceptance. No sealed asset, live target, deployment or spend
  changes; the full goal remains active and incomplete.
- Provider Ubuntu now joins the existing power-operation store and adapter.
  The loader binds the original explicit profile,v3 identity,allocation,scope
  and journaled access. Pre-restart uses the enrolled pinned kernel clock so
  an unhealthy desktop service can be restarted; post-action convergence uses
  the retained desktop/boot probe and public gateway checks. The shared power
  journal still requires fresh provider/boot/runtime/public proof. New06010000
  provides a desktop-only no-token finalizer, preserving original allocation
  and rejecting stale proof, wrong owner/IP/origin or deletion intent. Generic
  running convergence remains closed to v3. Existing action/GET routes already
  delegate to this adapter; public desktop launch admission remains closed.
  Three focused suites/227 tests, full typecheck and scoped lint pass. The
  isolated full migrated SQL fixture passes restart plus a real RPC stop/start
  sequence, unverified/unchanged/stale boot and owner/access/delete rejection,
  and service-only ACL checks. Only stale fixture data is aged with its guard
  immediately restored; the completion function bytes remain unchanged.
  Independent review GREEN. Migration SHA256
  1b094d1161936942f0ce7dfca9ced749fafc8a6fea5bd3003a3b2d50d4b7eed5.
  No push/deploy/live migration/asset/resource/spend. Provider desktop live
  start/restart/stop remains unverified. Next: shared provider resize floor,
  public launch/reservation and live browser acceptance, then remaining core
  runtimes and recovery. Full goal remains active.
- Provider launch and resize now share the desktop2 CPU/6 GiB whole-VM floor.
  Resize offers cannot downgrade Ubuntu to a4 GiB host; saved undersized
  dispatch-pending quotes are cancelled before credentials/provider access.
  New06020000 also checks explicit Ubuntu and minimum capacity at SQL quote
  admission, claim and first-POST transitions. Historical cancellation and
  already-dispatched observation/cleanup remain possible; other runtime floors
  are unchanged. Two focused suites/107 tests, full typecheck, scoped lint and
  independent GREEN review pass. The actual additive trigger fixture covers
  old quotes, both dispatch gates, profile rejection and post-dispatch recovery.
  The desktop SQL composition fixture initially lacked the resize table; its
  selected migration chain now includes the base resize journal and all current
  resize successor migrations. It passes with the desktop lifecycle, power and
  capability tests. This is selected-chain SQL composition, not application of
  every repository migration or live desktop resize acceptance. No asset,
  deployment, live migration, resource or spend changes. Public launch and
  live provider desktop acceptance are next; the full goal remains incomplete.
- Public Ubuntu provider launch is now wired through the existing request
  journal, exact .05.7 placement admission and provider adapter. The UI uses
  the shared 2 CPU/6 GiB host floor. The server shares the launch operation
  with the original provider allocation, allowing lost-response recovery both
  during provisioning and after the lifecycle operation clears. Completed
  recovery verifies original allocation, worker identity and stopped outcome;
  it does not create a replacement VM or fall back to managed placement.
  Independent review found and resolved the initial 4 GiB UI floor and cleared
  operation recovery gaps. Six suites/289 tests, full TypeScript, scoped lint,
  diff check and the selected-chain desktop SQL fixture pass. The SQL fixture
  now reserves Ubuntu directly rather than retagging a Codex reservation.
  Reviewer recheck GREEN. This remains source acceptance: no new deployment,
  migration, provider resource or spend in this milestone. Canary project
  inspection confirms hermesos-canary, root directory dashboard. The next step
  is its narrow migration/release cutover and a real owned provider desktop
  browser launch, lifecycle and cleanup check; other platforms remain unverified.
- Shipped28292043a to Canary: seven exact additive migrations05200000 through
  06020000 applied against srrwbdvxlqvqjuexitaf with per-transaction baseline,
  hash, lock timeout and zero-active-provider guards. Live ledger hashes match
  all seven source files. No historical replay. The branch push succeeded.
  Vercel direct working-directory upload exceeded its request limit; the archive
  attempt was stopped while still locally packaging. A clean git archive of
  28292043a deployed to hermesos-canary as
  dpl_Adi3Y9Bws8eXFNBYEFGypyB7gb1S and was promoted after READY. Inspection of
  canary.hermesos.cloud resolves to that deployment. Actual hermesos production
  was untouched. The authenticated public Infrastructure page loads with its
  retained six managed computers and zero provider servers. This is dashboard
  acceptance, not a new Ubuntu desktop launch. No paid fixture exists.
- The real server-picker check found only4 GiB offers. A scoped owner-bound
  live catalog read explains the gap: cx33/8 GiB is unavailable in all listed
  regions; available cpx32/8 GiB costs USD50.388 monthly before IPs, just above
  the USD50 simple-mode ceiling. Raising only that product ceiling to USD60
  retains the separate GBP10 cumulative test-spend limit, fresh quote, explicit
  consent, modest shared-CPU bounds and unchanged EUR45 ceiling. Historical
  USD50 quote parsing remains supported. Review caught that resize SQL still
  enforced50; additive06030000 changes only that validator ceiling, preserving
  its exact owner/identity/disk/expiry/consent logic and existing ACLs. The
  PostgreSQL regression demonstrates the old rejection and new acceptance,
  boundary60/60.01, old49, unchangedEUR and negative guards. Selected-chain
  desktop SQL passes; four focused suites/206 tests plus tsc/lint pass. This
  pricing change is not yet deployed/applied. Migration SHA256
  a559460527d83d639197cd6721efefe3e5599a36728bba5100b77fd32ab2f935.
  Independent recheck GREEN; apply06030000 before exposing new resize offers.
  Next: ship the pricing alignment, then create one bounded
  owned8 GiB fixture through the browser and test Ubuntu launch/lifecycle and
  complete resource cleanup. No new spend; conservative reservation remains
  GBP0.90 from prior completed campaigns. Whole-core goal remains incomplete.
- Pricing revision56cfeffae is now live on Canary at
  dpl_6RBKMri1pRCqz1PxVTVThQqkkhEF;06030000 applied and live hash matched.
  The normal authenticated picker now offers cpx32/4 CPU/8 GiB. Browser quote
  accepted USD0.08196/hour gross including IPs, USD51.108 monthly cap, Helsinki,
  Ubuntu22.04. Guided setup selected; no agent automatically requested. One
  owned disposable campaign created server164694721, order
  00000000-0000-4000-8000-000000001044, name hivra-2a1599d872424658b3ef,
  IPv4 resource148206132/address2.29.45.62, IPv6 resource148206133.
  At16:55UTC the original create action653453510605091 was still initializing;
  it is not prepared or launched. Reserve GBP1 conservatively for this campaign
  (cumulative reserved GBP1.90, GBP8.10 unreserved). Target cleanup by18:00UTC
  on September5, including original server/IP/key/firewall absence verification.
  Preserve all six retained managed computers; only this new campaign is disposable.
- Browser creation converged to created_off. Guided setup verified the firewall,
  powered on the same VM and enrolled attemptd930d18d-428d-4231-8456-2f978bc50e10
  at16:58:40UTC. Setup then stopped twice with409; after the first ambiguous UI
  pause the enrolled state justified one resume, but the same rejection recurred.
  Vercel request logs identify stage=load_bundle,failureType=ENOENT, before guest
  installation. This was not merely slow enrollment. Deployment source inventory
  lacks required dashboard/provisioner/.gitignore while all other bundle entries
  are present. The installed CLI adds .gitignore to default ignore rules before
  project rules. A narrow .vercelignore exception restores this exact immutable
  asset; the local ignore regression preserves unrelated dotfile/env/git/vendor
  exclusions. Existing Next tracing already explicitly includes the file. Sealed
  .7 assets are unchanged. Resume this original campaign after packaging is live;
  do not purchase a replacement or claim desktop acceptance yet.
- Packaging revision3b82e5f77 deployed and promoted as
  dpl_5oNTvs9oL2mVYV6zDMfgd6FYtqpA. Source inventory now includes the missing
  dotfile at its exact SHA1; Canary alias resolves to the READY deployment.
  Browser resumed the same enrolled VM and reached Environment prepared.
  Prepared target5f680df8-b85b-4f15-a4fc-536a2ef52a38 reported4 cores and7.11 GiB
  available. Its CTA still goes to the agent-only welcome picker, so Ubuntu
  required the sidebar Launch path; keep this onboarding mismatch outstanding.
  Normal Launch selected Ubuntu, My infrastructure and the exact owned target,
  named CANARY_PROVIDER_UBUNTU_V7_0905. Launch accepted and navigated to desktop
  pageaa3d70da-e800-473f-9e41-401bcdb63435. Original operation/allocation
  00000000-0000-4000-8000-000000001045 dispatched at17:11:58UTC with bundle.05.7.
  At17:12UTC it remains provisioning with no installer outcome. Public page
  reports4 CPU/8 GiB and checks the original installer automatically; no desktop
  acceptance yet. This new computer belongs to the same disposable campaign.
- Campaign result at17:31UTC: FAIL, not desktop acceptance. The original pinned
  SSH status adapter observed the worker running at17:17UTC. It later recorded
  immutable outcome=failed, stoppedAt17:20:03.690167UTC. Read-only SSH diagnostics
  against the original enrolled host pin found systemd Result=timeout,
  ExecMainStatus=15 and ActiveState=failed. Docker29.1.3 was installed by17:12:22;
  the pinned Selkies base image was present (7.17GB). An intermediate container
  55a6e8fd7ddb was created at17:20:00.599628703UTC, remained Created/not-running,
  and no desktop-ownership or desktop-ready journal existed. Thus the480-second
  worker limit expired during cold image preparation, before useful desktop
  service creation. Exact pull-versus-derivation time was not recorded; do not
  claim either phase alone consumed the entire window. No installer restart or
  replacement purchase was attempted. Private installer.log was absent for this
  desktop path; it uses in-process composition rather than run_installer logging.
- Normal browser Destroy was confirmed for this disposable computer. It remained
  at installer_stopping: cleanup_desktop deliberately returns pending when a
  dispatched install has no desktop-ownership.json. The public delete coordinator
  requires verified desktop cleanup before releasing provision, so this partial
  preparation cannot reach provider destruction. This is a recovery defect, not
  evidence that the original worker still runs. Navigated to Infrastructure to
  end the browser continuation before separate operator cleanup. Do not fabricate
  a desktop stopped proof or release the original allocation manually.
- Separate authorized operator removal used the original order and first-boot
  receipts, current bound provider credential in memory, and the existing strict
  assertHetznerCleanupSnapshot policy before each phase. Exact resources:
  one server, one IPv4, one IPv6, one SSH key and one firewall (ids redacted).
  Server delete action653462100553073; fresh reads then showed server and both
  auto-deleted IPs absent. Removed only the original now-unattached firewall/key.
  At17:31:46UTC all five individual provider reads confirmed absence. This VM's
  disk and intermediate build container were destroyed and are not recoverable.
  All retained managed fixtures were excluded. Cumulative conservative spend
  reservation remainsGBP1.90 ofGBP10 (not an invoice claim); no paid test fixture
  from this campaign remains. Local one-off diagnostic/removal scripts contain
  no credentials and are outside the repository under /tmp.
- Application reconciliation remains outstanding: original computer/order and
  allocation are retained, not silently marked deleted. Next root-cause work is
  a bounded cold-desktop installation budget with safe stage receipts, and a
  separately evidenced original-provider-absence handoff for failed preparation
  without a desktop ownership journal. Test both against their actual boundaries
  before another paid campaign. Also retain the observed onboarding CTA/stale
  desktop gate and erroneous unknown-resize message as pending UI fixes.
- Recovery prerequisite (local source only): observeAbsentProviderDesktopProvision
  now reads the exact original desktop provision, order, enrollment and bound
  provider connection. Only a structured provider not_found response is absence;
  timeout/auth/rate-limit/proxy errors are not. It rechecks owner/operation and
  connection revision after the read within a25-second monotonic window. It does
  not write SQL, release an allocation, delete a resource, or return a desktop
  stopped/cleanup receipt. Initial live execution exposed a strict owner-input
  mismatch also found independently by Pauli; both calls now pass only userId and
  agentId, with a strict-schema regression. At17:37:25.347UTC the corrected local
  adapter observed server164694721 absent for original operation
  00000000-0000-4000-8000-000000001045 through the real bound Canary connection.
  Pauli's independent review is GREEN for this read-only prerequisite only.
  It is not integrated into the public delete route and is not a completed fix.
  Next handoff must lock/revalidate the same original connection/order/target and
  provision operation in SQL, preserve immutable installer outcome, and record
  provider absence separately from guest cleanup. Remaining resource absence and
  access cleanup still gate final deletion; do not treat this server-only result
  as all-resource cleanup. Normal deletion of a still-present partial install also
  remains pending and must be covered before claiming recovery acceptance.
  Focused observer/delete suites passed94tests; full TypeScript no-emit check,
  touched-file ESLint and diff whitespace checks passed. No deployment or new
  provider purchase was performed for this read-only milestone.
- Absent-server handoff implementation23f880c11: a separate private SQL journal
  permits only an original stopped Ubuntu provider provision with explicit delete
  intent to hand off atomically to error/operation-null. Installer identity,
  outcome and allocation remain unchanged; the normal delete coordinator still
  requires all original resource absences and access cleanup. Parent-first locks,
  final binding/freshness recheck, exact-binding stale-proof refresh and rollback
  of failed proof publication address independent review findings. Real composed
  desktop SQL fixtures and97 focused tests passed. Review GREEN is limited to
  this already-absent-server path; still-present partial-install teardown remains
  outstanding. Migration20260906040000 was applied only to linked Canary after
  checking the288-row ledger, old guard hash and single held fixture. Stored SQL
  hash cb1f6f61619c748c86876d464d8a54d154b501550a5377664891264b85c74dad matched;
  live ledger is now289 migrations. Application build
  dpl_6fzwddT7dbwRdCVi79XtvmVeqm9C failed TypeScript on the final test's inferred
  Promise-never mock; it was not promoted. Explicit Promise-void annotation is
  the correction, not a runtime retry. Browser Sync servers confirmed zero cloud
  servers; the six retained managed computers remain visible. Public recovery
  acceptance awaits the corrected application build.
- Corrected revision4af6bc1db passed the final TypeScript check and focused
  observer suite, then deployed asdpl_9X9jKgQP2L3Nvfo6KicrMqZsK8mt. READY was
  verified before promotion; canary.hermesos.cloud resolves to this exact
  hermesos-canary deployment. Browser reloaded the original failed computer,
  opened Manage, confirmed its exact name and irreversible deletion, and resumed
  the existing Delete flow. It returned automatically to Computers; the failed
  fixture is absent while all four retained Ubuntu computers remain listed.
  SQL records show absenceObservedAt17:54:08.421UTC, target retirement
  17:54:14.322124UTC and cleanupFinishedAt17:54:15.026837UTC. Original order and
  agent are deleted, operationId is null, and all five absence flags are true
  (server,IPv4,IPv6,SSH key,firewall). Installer outcome remains failed. This is
  live browser acceptance of the already-absent-server recovery path, including
  the actual new observation/RPC/coordinator/finalizer integration that the
  mocked unit boundary alone did not prove. No replacement resource was bought.
  Still-present interrupted-install destruction and cold desktop timeout remain
  unimplemented fixes; this does not establish Ubuntu launch acceptance.
- Still-present interrupted-desktop teardown is now implemented locally (not yet
  deployed/applied). Migration20260906050000 admits original target retirement,
  leased provider cleanup and associated enrollment revocation only for the
  exclusive Ubuntu VM with explicit desired=deleted, original held provision,
  committed terminal installer outcome and matching durable cancellation grant.
  It does not weaken operation release or invent desktop cleanup evidence.
  The delete adapter continues exact original provider cleanup when the worker
  stopped before publishing desktop ownership. Even an all-absent result leaves
  provision held; the next continuation must use the separately verified server
  absence handoff before final deletion. Other runtimes retain their prior gates.
  Focused delete/absence suites pass98tests, full TypeScript and touched ESLint
  pass, and the composed PostgreSQL desktop suite includes the new retirement/
  cleanup-claim gate and continued rejection of premature release. Independent
  SQL and integration reviews are GREEN. The composed store fixture exercises
  real cancellation/termination/retirement SQL but substitutes the provider
  cleanup boundary; this is not live provider teardown acceptance. The fixture's
  old prohibition on same-step provider cleanup was updated for this intentionally
  narrow path, and real original first-boot records replace a mismatched mock.
  No new paid resource or live mutation was made for this implementation slice.
- Teardown release follow-through: final TypeScript no-emit check passed on
  d43e17b07. Applied only migration20260906050000 to linked Canary under the
  expected289-row ledger and zero-active-provider guard; stored SQL hash
  b6b7337d3468b7c0571688bda83575ad3369770eaf90f17a1b90bab8ca090edb matched.
  Live ledger is now290 migrations (generated repository manifest284 reflects
  the pre-existing historical ledger difference). Clean committed source deployed
  asdpl_4ZEiJ8i7hUJKZeKwJhGt8LTSCw9h, verified READY, then promoted only to
  hermesos-canary. canary.hermesos.cloud resolves to that exact deployment.
  Browser reload completed with the same four retained Ubuntu computers listed
  and running; no paid fixture exists or was bought. This is deployment/basic
  inventory evidence, NOT live teardown of a still-present interrupted VM.
- Cold-start diagnosis now also identifies the mismatched nested budgets:
  remote-desktop/install-guest.py allows each command up to15minutes, while
  hivra-provider-worker.py enforces RuntimeMaxSec=480s and DesktopJournal uses
  the same480000ms total bound. Coordinate the next desktop-specific bounded
  budget with the TypeScript safe-clock guard and a new immutable runtime release;
  retain v1/v2 limits and all prior release/controller identities. Do not edit
  sealed .05.7 assets in place or restart the deleted campaign. Runtime stage
  evidence should expose only reviewed non-secret stage names, not private
  command arguments/environment/output. New cold-launch and interrupted-teardown
  acceptance must use an explicitly tracked fixture inside the remaining budget.
- Cold-start release dc9e0752d: immutable .05.8 increases only desktop v3 total
  install/journal limits to1200seconds; v1/v2 remain480seconds. Prior .7/.6
  recovery retains original bytes, while fresh provider Ubuntu placement requires
  the current bundle. Independent review GREEN after correcting that placement
  gate. Focused Python24, Jest170, TypeScript and scoped lint passed. The full
  provider SQL chain exposed native-fixture module-cache leakage into desktop;
  test-only5caff4144 scopes cleanup to newly loaded source modules, independently
  reviewed GREEN. Full SQL rerun then passed native, desktop, power, ownership,
  capability, absence and teardown gates. This is not live desktop acceptance.
  Applied only06060000 to linked Canary with expected290-row ledger and zero
  active provider agents; ledger now291. Stored migration hash matches
  d66c2680c75e380f5d8376f2f8350c59302b4654241abb7345a746fa9bec3db0.
  Deployment dpl_DPaWRHN9LQjfMNPDV5o8AkaeNHXS was READY then promoted only to
  hermesos-canary; canary.hermesos.cloud resolves to that exact revision.
- Next owned cold-start campaign budget, reserved before purchase19:02UTC Sept5:
  £1 additional conservative reservation, cumulative£2.90 of£10 (not actual
  invoice/FX). One cpx32, Helsinki,4CPU8GB, fresh Ubuntu22.04 guided setup.
  Observed current gross rate USD0.08196/hour inclIPs,51.108monthly cap,
  20TiB traffic included,1.44/TB overage. No extra volumes/backups. Complete
  teardown by21:02UTC Sept5, or earlier on failure, using the original scoped
  UI deletion/cleanup path; inspect before any retry. Preserve all managed VMs.
  No server has yet been bought for this reservation; record actual IDs after
  creation. Do not reuse the deleted .05.7 campaign IDs or cleanup scripts.
- Purchase submitted through the current Canary UI19:01:30UTC: order
  00000000-0000-4000-8000-000000001046, server164704237,
  hivra-398b2cbe7c894dbead0b, SSHkey118396787, create action653479280504866.
  Initial response is creating/initializing, not prepared; no duplicate request.
  Connection remains878eee3f-2eff-425b-b68e-435d610bff1e revision1. This owned
  campaign is the sole new paid fixture, cleanup deadline21:02UTC Sept5.
- .05.8 fixture guided setup passed through the real UI. Enrollment
  00000000-0000-4000-8000-000000001047, target
  00000000-0000-4000-8000-000000001048, firewall11579535,
  IPv4resource148218654 (10.252.45.62), IPv6resource148218655.
  Real unified computer launch created CANARY_PROVIDER_UBUNTU_V8_0905,
  agent 00000000-0000-4000-8000-000000001049, original operation/allocation
  00000000-0000-4000-8000-000000001050. .05.8 dispatch19:05:51.725222UTC;
  systemd start19:05:55UTC. Read-only original-bound SSH diagnostic confirms
  RuntimeMaxUSec20min, active/running, base image7.17GB and build container
  263f02900fa6 running. This is intermediate preparation, not desktop readiness.
  /tmp/hivra-v8-provider-diagnostic.cjs is scoped to this order/server;
  no private credentials are in the file or receipt. Keep this fixture tracked
  until all original billable resources and access are cleaned up.
- Onboarding handoff ce94a4db6: generic prepared-computer CTA now opens unified
  launch with its original target, instead of the agent-only wizard. Ubuntu
  return is permitted but explicitly defers compatibility to fresh launch
  checks; it does not claim older bundles are launchable. Removed stale blanket
  provider-Ubuntu unsupported text.16focused UI tests and lint passed. Build
  pending; browser acceptance of this UI change not yet performed.
- Cold-start .05.8 browser acceptance: installer succeeded19:14:30.811564UTC,
  approximately8m39s from dispatch (beyond old480s), original operation released
  and agent running. Public desktop connected over WebSocket/WebCodecs. Actual
  streamed KDE menu opened, Konsole launched, typed echo produced
  HIVRA_DESKTOP_V8_INPUT_OK. Created only disposable
  /home/ubuntu/hivra-canary-v8-marker.txt containing HIVRA_V8_PERSISTENCE_20260905.
  Desktop container reports Ubuntu26.04.1 while underlying provider VM uses
  Ubuntu22.04; these are intentionally separate environments. Initial browser
  secure setup12.1s is telemetry, not physical-latency acceptance. Reload and
  lifecycle/persistence checks are now underway; fixture not yet cleaned up.
- Handoff deployment dpl_83LzLNVGTZAS7f4BgvSuyuzpPQop READY/promoted and exact
  Canary alias verified. Actual setup dialog showed the new desktop-or-agent
  wording and Choose what to launch link; clicking it opened unified launch with
  the exact original targetId. No second launch submitted. Follow-up e63c15b02
  removes inaccurate Nothing has been launched yet text from reopened setup
  history (16UI tests passed); this tiny copy correction is not deployed yet.
  Existing managed CODEX_AGENT was inspected read-only: its Chat interface says
  saved model connection needs a newer Hivra Chat runtime. No update was applied.
- Reload acceptance passed: new public desktop session reconnected in4.4s
  browser telemetry, retained Konsole contents and a fresh cat command read the
  marker. UI Restart claimed26082634-7f15-45ee-bc80-25df17a4a28b, dispatched
  19:17:53.910899UTC; Hetzner reboot action653479280514285 succeeded. Kernel
  changed 00000000-0000-4000-8000-000000001051 to
  00000000-0000-4000-8000-000000001052; original desktop container3ce58c220c3a
  is healthy and original tunnel/broker/desktop services active. Hivra restart
  nevertheless remains held: exact generated power-probe traceback proves
  FileNotFoundError for /run/hivra-agent-install.lock, cleared by reboot.
  Proposed dashboard-side observational-probe correction only recreates this
  ephemeral lock with600/no-follow/no-truncate and exclusive flock; persistent
  original controller/journal locks still cannot be recreated.74focused tests,
  TypeScript and lint pass, including held/symlink/unsafe lock rejection and
  missing-ephemeral reboot acceptance. Independent review pending. Do not rerun
  /tmp/hivra-v8-power-probe-diagnostic.cjs before deployment: it imports
  current local code and would create the lock before deployed acceptance.
  /tmp/hivra-v8-power-diagnostic.cjs only reads scoped service state.
- Ephemeral-lock review GREEN; committed24713d052. Clean-source Canary build
  underway, no promotion yet. This also includes the previously tested setup
  history wording correction. Existing CODEX_AGENT native terminal was opened
  read-only and reports older connection service/update required; Chat and
  native terminal acceptance both remain gated until that managed runtime update.
- Restart fix24713d052 deployed as dpl_DdAeKQMCayDyLacH2WES4VEib73A, verified
  READY then promoted only to Canary; exact alias verified. Reloaded the original
  browser page with no second restart POST. Original restart verified new boot
  00000000-0000-4000-8000-000000001052 at19:30:37.146UTC, released operation
  and returned running. Public desktop reconnected (11.5s browser setup metric),
  fresh KDE application menu input works. Post-restart file read is next.
- Post-restart Konsole read passed: original marker contained
  HIVRA_V8_PERSISTENCE_20260905. Actual UI Stop operation
  00000000-0000-4000-8000-000000001053 verified off19:35:40.667UTC;
  actual UI Start 00000000-0000-4000-8000-000000001054 verified running
  19:36:16.823UTC, new boot8df4f88e-3584-48e7-8861-38bdd42b6725.
  Public desktop rendered again and application-menu input works. Stopped resize
  UI reported no compatible same-architecture server type available in hel1;
  no resize submitted and real resize remains unverified. Current paid fixture
  remains owned and tracked for cleanup; no existing managed computer changed.
- Stop/start persistence passed through actual Konsole: original marker read
  matched after the new boot. Copied it without overwriting into existing
  /home/ubuntu/Hivra/hivra-canary-v8-marker.txt to test shared surfaces. Files
  rendered unauthorized; Box Terminal rendered Could not verify secure access.
  Public anonymous /api/meta independently returned200 and surfaceAuth
  post-cookie-v1, agentKind linux-desktop. Source explains the mismatch:
  provider-desktop-capability.ts intentionally requires api_token:null, while
  agent/[id]/page.tsx AuthenticatedSurface refuses a missing token and HivraFiles
  still uses the legacy bearer client. This is an unimplemented provider surface
  authentication integration, not an unreachable desktop runtime. Do not weaken
  authentication, populate a browser bearer ad hoc, or claim files/terminal pass.
  Next work: implement owner-bound provider workspace access compatible with the
  existing provider identity/session contracts, with negative authorization tests
  and fresh browser acceptance. No source repair for that gap has been made yet.
- Actual Manage destruction of this disposable fixture completed19:40:03.471907UTC.
  UI returned to the existing four-computer inventory. Original order398b2cbe-
  7c89-4dbe-ad0b-c7779864c0c1 is deleted; cleanup_absence records server,ipv4,
  ipv6,sshKey,firewall all true with no cleanup error. Original agentbfaef5d5-
  8003-4a4e-a7b3-c7ba7b7084de is deleted, desired_state deleted, operation null.
  Server164704237 and its original resources are no longer retained. Disposable
  marker files were intentionally destroyed with that disk and are not recoverable.
  This proves normal running-computer cleanup, not interrupted-install teardown.
  Conservative cumulative budget reservation remainsGBP2.90/10 (not an invoice);
  this campaign has no remaining billable resources. All prior managed computers
  were preserved. Overall multi-OS/core-experience work remains incomplete.
- Provider workspace repair prerequisite: added an unused, explicit files versus
  box-terminal request policy and38focused regression cases; tests, Node syntax,
  lint and diff check passed. Independent source review GREEN for this unused
  prerequisite only. No guest import, manifest, schema, route or live deployment
  changed. Keep guest-local API_TOKEN startup/write guards intact: the null field
  is the database/browser token, not the guest's private local bearer. Concrete
  next integration and acceptance boundaries are recorded in
  docs/superpowers/plans/2026-09-05-provider-workspace-access.md. The Files/terminal
  defect remains open; passing request-policy tests are not a surface repair.
- Added the unused guest workspace-session adapter: per-session opaque cookie,
  explicit immutable handoff ID, selected surface/owner/computer/audience checks,
  at-most-four-minute expiry, five-second authorization deadline with transport
  abort, bounded allocation and automatic socket revocation/expiry cleanup.
  Independent review found an initial single-cookie A-to-B adoption defect;
  corrected it with per-session cookie names plus explicit request identity and
  exact regression cases. Review is GREEN for the unintegrated adapter only.
  60focused policy/session tests and lint passed. Full TypeScript check found a
  test-only inferred optional-header typing mismatch in the preceding policy
  fixture; annotated its return shape. Full TypeScript,60tests and lint rerun
  all passed. No runtime guard
  was weakened. Grant ledger/exchange/router/dashboard integration, cross-site
  embedding protocol and deployed acceptance remain open. No live mutation or
  additional spend occurred in this step.
- Workspace control-plane ledger staged in20260906070000: owner-bound issue,
  locked one-use PKCE exchange, hash-only authorization, explicit revocation and
  automatic lifecycle/connection invalidation. Snapshot includes original
  allocation/provider server/enrollment/connection revision/target/install/access.
  Uses current provider authority helpers; no live migration or runtime admission.
  Corrected --desktop-only actual PostgreSQL chain passed, including real
  stop/start no-resurrection, connection error-to-ready no-resurrection, expiry,
  wrong identity/scope/owner and RLS/function privileges. An earlier full-chain
  run passed preparation/native/power/ownership sections then failed a fixture
  that attempted forbidden connection disabled; fixed the test to assert that
  guard and exercise allowed error instead. No guard disabled or production
  function weakened. Independent review GREEN for the ledger prerequisite only.
  Manifest now286 repository migrations; live ledger remains291/latest06060000.
  Canonical HTTP adapter and installed workspace-protocol verification still
  required before any issuance route is exposed. No extra spend or live changes.
