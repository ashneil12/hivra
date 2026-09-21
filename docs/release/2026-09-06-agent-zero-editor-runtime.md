# Agent Zero native editor runtime release

Release `2026.09.06.1`, 49 pinned assets, based on source milestone `8c754d642`.
Bundle SHA-256:
`61ab17bececd79e77464acc2653bb549d811628544a36942302b597473d2900c`.

## Scope

The native editor adapter now lives in `provisioner/hivra-chat/agent-zero-editor.cjs`.
The existing owner-authenticated Agent Zero proxy transforms only its exact two
captured editor assets. GET and HEAD both validate the upstream full identity
response against its source hash; HEAD emits no body. Unexpected status, MIME,
encoding, oversized/drifting sources and requests exceeding one ten-second
login/retry/header/body deadline fail closed. Original validators are removed,
responses are uncached, and backend cookies remain private. File APIs and login
authority are unchanged. The MIT native fixture license remains retained.

The installer, updater, native gateway deployment and receipt paths include the
helper. Earlier manifests are unchanged. Retained `.05.10` identities, worker
pins, cleanup contracts and desktop deadlines use their original releases.
Fresh provider desktop placement still requires the current prepared bundle;
retained compatibility does not advertise an unlaunchable older placement.
Workspace observation expects eleven gateway files only on the new release,
and ten on retained releases.

## Source checks

- Native editor model: 15 passing; actual delayed loads, draft preservation,
  both cross-file response orders and stale save/modal callbacks.
- Real loopback gateway routing/authentication: 90 passing, one existing skip.
  Includes expired-session GET/HEAD refresh and hung-login/header/body bounds.
- Release, portable contract, provider native/desktop worker and runtime suites:
  171 passing. The initial fixed-ten workspace assertion failed and was corrected
  with a version-bound count; no ownership condition was removed.
- Managed sync/readiness and provider guest worker/bundle: 111 passing.
- DeepSeek gateway isolation: three passing.
- Scoped ESLint, full dashboard TypeScript, touched Bash/Node syntax and diff
  whitespace checks passed. One typecheck was mistakenly run from the repository
  root and invoked npm's unrelated `tsc` package; it did not validate anything.
  The accepted check used `dashboard/node_modules/.bin/tsc` from the dashboard.
- Independent reviewer `core_gap_map` found and resolved a HEAD refresh gap and
  an overbroad fresh-placement condition, then returned source GREEN. The reviewer
  performed no edits or live mutations.

The selected actual PostgreSQL schema harness includes migration `06110000`;
the generated migration inventory includes it as well. The complete
`node scripts/test-provider-computer-ownership.cjs` run finished with exit zero
at 03:34 UTC: actual new-version admission, native/desktop identities, owner and
lease fences, worker cleanup, retained power/recovery, workspace sessions and
terminal teardown checks passed. No live database was used by that harness.

## Live acceptance status

PASS for rollout and first-ever native New File typing/save/readback on one
disposable Canary computer, as recorded below. This closes the reproduced
blank-first-New-File defect for this tested release and path. It is not a
claim that all existing computers were updated or the broader core is complete.

Authority remains Canary only, excluding the actual production project and all
pre-existing guest updates. No new Hetzner spend was incurred while preparing
this release. Rollback is the previous Canary deployment and the preserved
previous host bundle; migration adds version pairs without removing predecessors.

## Canary rollout

Source `ed1c41bd779ee325d5dc0fd8a02d22c8dea3a59c` was built from clean archive
`/tmp/hivra-editor-deploy.KHdcZ5` in project **hermesos-canary**. Deployment
`dpl_2G7xzCL2Xc8PqhWTfSmFTaFmo7nm` became Ready and was explicitly promoted;
fresh inspection of `https://canary.hermesos.cloud` resolved to that deployment.
URL: `https://hermesos-canary-nmln765ah-ashneil12s-projects.vercel.app`.
Previous deployment: `dpl_BcYPx64yw3s1KuhE69xTKbQduDnE`.

Only migration `20260906110000` was executed on linked Canary database
`srrwbdvxlqvqjuexitaf` and recorded as applied. Readback confirmed new version
admission, both exact new identity digests, and retained predecessor admission.
No unrelated pending migration was applied.

The reviewed host sync helper updated only `node-b`'s
`/root/hivra-provisioner-canary`, with all 49 assets verified before dispatch.
Wrapper `/tmp/hivra-editor-release.A09Npv/sync.cjs`; executed script SHA
`a6a7d9567b86c4f041fd34bf805b18010f10cdf93ca58a0cb29ad7e20dc71922`.
It returned exit zero and separate provision readiness `HIVRA_HOST_READY`.
No source readers or in-flight Canary operations were observed before the swap.
Rollback `.05.10` copy:
`/root/.hivra-provisioner-canary-rollbacks/2026.09.06.1.txwA3cam/original`.

Preserved before/after: full `qm list` hash
`6bcd71708f0374d062cd039a8957e635efa8539fe653739a40fe5631939d66cf`,
VM counts `30/20/50`, active Caddy and complete `/etc/caddy` fingerprint
`ce4fc539496e362ddab5064a8da748b628a495fb3646e419304208185da4046e`,
shared-default bundle fingerprint
`7881c0697afea1e91a686d9854e3eb9c048491726f470a587211946cfbb1f94f`,
and storage total/used/free `870318080/558918270/311399809`.

Normal app refresh displayed the original four computers and two agents, all
Running. Agents → Deploy Agent → Agent Zero submitted only
`CANARY_A0_EDITOR_0906`, 2 CPU / 4 GB, managed Venice unchecked. The new owned
agent is `00000000-0000-4000-8000-000000001056`, created
`2026-09-06 03:39:04.838061+00`, channel Canary, provisioning operation
`00000000-0000-4000-8000-000000001057`. The launch confirmation appeared in the
normal UI. The acceptance/cleanup deadline is 03:59 UTC. Outcomes follow below.

Allocation bound VM 1130 on `node-b`, disk `local-lvm:vm-1130-disk-0` (40 GB),
2 cores / 4096 MiB, with tags `hivra-bind-b1dc497f3f0ea95599598e7d1981ee41`
and `hivra-op-3a6fea8add8c44358673d23df08d30ac`. The UI advanced to Setting up
without refresh. Installer PID `3743776` was observed running; its PID file is
`/run/hivra-provision/1130.pid`. At 03:43 UTC it had reached the Agent Zero
Docker installation stage. A PID file alone was not treated as liveness proof.

## Actual native acceptance

The page advanced automatically to Running, and its first observed dashboard
render at 03:45:13 UTC showed normal fonts, icons and layout with no observed
polling warning. No refresh, model configuration, account login or model task
was used. This one observation does not resolve earlier cold-rendering or
WebSocket uncertainty across all instances.

The guest's installed editor module SHA matched
`9fc4c52c42d937ceff8e0aaae0bdfef68d16b4b81b1457d9a0efa0c4fd9f40a3`,
and gateway SHA matched
`ada31a51e27443f17ebef02e21af93a66b6cf7130b5857251ad807dcd1a4b01a`.
An unauthenticated public request to the exact native store asset returned 401
at `agents-canary-box-redacted.hermesos.cloud`.

Using Agent Zero's own More options → Files interface:

1. Navigated to `/a0/usr`, created a disposable folder, then opened it. The
   rapid type-and-create sequence produced `canary-a0-editor-0`, not the intended
   longer name. The attempted longer path correctly returned not found. Native
   listing established the actual owned name; no second folder or speculative
   input patch was created. The cause of that shortened input is not established.
2. Clicked **New file for the first time** on this fresh computer. The native
   modal rendered its ACE editor immediately in the first inspected result.
   No cancel/reopen, refresh, injected script, manual editor initialization or
   alternative file API was used to make it work.
3. Typed `first-open.txt`, inspected the complete filename, then typed
   `HIVRA_A0_FIRST_EDITOR_OK` plus a newline and inspected the complete text.
   One native Save closed the editor and listed the file as 25 Bytes.
4. Native **Open in Editor** displayed the exact saved text. This is Agent Zero's
   separate editor surface, not an assertion that the legacy modal `openFile`
   path was reached. Its cross-file races remain covered by the model tests.
5. Returned to Files and opened New file again: both name and content were empty
   with a fresh visible editor. Cancelled without saving another file.

Independent guest readback of
`/opt/a0/usr/canary-a0-editor-0/first-open.txt` matched the locally calculated
25-byte marker SHA-256:
`b6990e0b1bf589e52e06f59f5191dd7cf0e6c480e871fdc2f8e095e05fa15d92`.
The file was created solely through the native UI, not by that readback check.

## Cleanup and remaining boundaries

Normal Manage → Destroy, irreversible-action checkbox, exact owned name and
Permanently Destroy removed only this fixture. By 03:52:36 UTC, before the
03:59 deadline, checks confirmed:

- Agent tombstone deleted; VM and active operation fields null; API token and
  Cloudflare tunnel reference cleared.
- VM 1130 configuration absent; `pvesm list local-lvm --vmid 1130` empty;
  original installer PID 3743776 and its `/run/hivra-provision/1130.pid` absent.
- Both authoritative Cloudflare nameservers returned NXDOMAIN for the owned
  public hostname. The external tunnel object was not separately enumerated.
- Full VM inventory, Caddy state/content and shared-default bundle fingerprints
  returned to the exact pre-test values recorded above. Canary bundle integrity
  passed at `2026.09.06.1`.
- Native Hivra Home returned to the original four computers and two agents,
  all Running. No existing guest was updated, restarted or resized.

The disposable VM, folder and marker were irreversibly erased. No active owned
test resource remains. No new Hetzner spend or model usage was incurred; campaign
reservations remain GBP 5.90 / GBP 10, not invoice totals. No rollback was needed.

This is scoped editor/launch acceptance, not complete catalog, native app,
monitor-unplug, inference, Windows or Omarchy acceptance. Existing computers
retain their previous runtimes, and the rapid-input observation remains open.
