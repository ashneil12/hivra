# Agent Zero managed launch sizing

## Scope and reason

The prior owned launch is recorded in
`2026-09-06-dashboard-launch-feedback.md`: at the default 1 CPU / 2 GB, native
startup initially rendered poorly and later recovered without a refresh. The
resource panel observed pressure. A later resize to 2 CPU / 4 GB and retained
file check passed, but warm caches and elapsed startup time prevent a causal
claim about the earlier rendering failure.

Source inspection found that the managed dashboard-agent form always submitted
the catalog minimum and exposed size controls only for self-managed Proxmox.
Agent Zero's upstream [VPS deployment guide](https://github.com/agent0ai/agent-zero/blob/main/docs/setup/vps-deployment.md),
read 2026-09-06, distinguishes minimum 1 vCPU / 2 GB from recommended 2+ vCPU /
4+ GB. The minimum is therefore retained, not relabelled unsupported.

The change gives managed Agent Zero a visible recommended 2 CPU / 4 GB default
and an explicit minimum 1 CPU / 2 GB choice before submission. The summary and
request use the same selection. Plan per-agent limits and observed remaining
pool constrain both buttons and launch; insufficient recommended capacity does
not silently select the minimum. Choices freeze during the existing request.
This is a sizing improvement, **not a fix or acceptance for cold rendering**.

No catalog floor, backend admission, isolation, provider purchase, model-credit
default, existing machine or runtime bundle is changed. Other dashboard agents
keep their existing floor. Self-managed selections remain measured-host choices
and do not consume or depend on managed pool capacity.

## Local evidence

- Three initial regression cases failed because the choices did not exist.
- Final WelcomeFlow suite: 82 passed, six pre-existing skips. Coverage includes
  both request sizes, display/payload agreement, remaining CPU and RAM,
  per-agent CPU and RAM, explicit minimum choice, frozen pending controls,
  unrelated dashboard runtimes, and Agent Zero's self-managed 4 CPU / 4 GB
  selection despite a full managed pool.
- Catalog suite: 24 passed; the minimum remains 1 CPU / 2 GB.
- Agent create-route and resource-gate suites: 135 passed.
- Hot-path suites: 318 passed in 18 suites.
- Full TypeScript passed. Scoped ESLint: zero errors, two pre-existing warnings
  (unused Link and selectedPersonaId callback dependency). Diff check passed.
- Full repository `verify` was not repeated: focused launch/admission tests,
  hot paths, TypeScript and the release build are the bounded verification scope
  for this change. They do not establish a live launch result.

Independent non-implementing review found no actionable P1/P2 in the code and
regression diff. It verified selection/admission/payload agreement and preserved
self-managed behavior, and explicitly did not accept the separate cold-load
issue. The reviewer did not rerun tests or perform live actions.

Source `4c2f05da34489218ee4c54d999d69bab5ee18e87` was committed and pushed to the
existing PR branch. A clean archive at `/tmp/hivra-a0-sizing.AxmR92`
was built in the exact **hermesos-canary** project
`prj_XEG52ZLtihRGP8Fg6pDZwQCATzVA`, using its production slot with automatic
domain assignment disabled. Actual production is excluded. Prior Ready
deployment `dpl_5wUwAu9KTkLzeBLpdzD1QMauVmah` is the rollback candidate.
Deployment `dpl_BcYPx64yw3s1KuhE69xTKbQduDnE` built Ready, was explicitly promoted,
and fresh inspection of `https://canary.hermesos.cloud` resolved to it:
`hermesos-canary-qovx07drp-ashneil12s-projects.vercel.app`.

## Live fixture

Refreshed the authenticated root-path Mac Alpha once to load this release.
The original four computers and two agents remained Running. Normal Agents →
Deploy Agent → Agent Zero showed the recommended choice selected and a matching
2 CPU / 4 GB pool summary. Clicking Minimum changed the selection and summary
to 1 CPU / 2 GB; clicking Recommended restored 2 CPU / 4 GB. Screenshot and
accessibility state confirmed distinct selected styling and readable controls.

With managed Venice still unchecked, one launch of
`CANARY_A0_RECOMMENDED_0906` was submitted. Both size choices became disabled,
the pending confirmation message appeared, and the normal setup page opened
without another refresh or submission.

Agent `00000000-0000-4000-8000-000000001058`, created
`2026-09-06 02:47:21.841154+00`, managed channel `canary`, operation
`00000000-0000-4000-8000-000000001059`, records 2 CPU / 4 GB. Fresh host evidence
binds it to VM 1130 with cores 2, memory 4096, 40 GB
`local-lvm:vm-1130-disk-0`, tags
`hivra-bind-11665ce600b3c418c989825efd9eee8e` and
`hivra-op-9b24770c38db4e4ab59d3cca16e9ccc6`. Installer PID 3711690 was alive at
02:48 UTC; log metadata showed current activity. No native readiness is inferred
from this allocation check.

Deadline **03:05 UTC including cleanup**. No model request, account import,
additional Hetzner reservation or provider purchase. Pre-test full `qm list`
SHA-256 `6bcd71708f0374d062cd039a8957e635efa8539fe653739a40fe5631939d66cf`.

### Native result and newly isolated editor failure

By 02:53:38 UTC (about six minutes after creation), the native Agent Zero v2.2
dashboard had automatically opened. The first observed screenshot had correct
fonts, icons and layout. Native Files opened a correctly rendered `/a0` listing.
No polling-fallback warning was observed in this bounded check; this is not
protocol-level WebSocket acceptance or proof of absence on every launch.
The initial resource panel reported 86% CPU (two cores), 2.05/3.82 GB RAM and
load 2.78/1.37/0.56. No model inference was invoked.

Native Files → `/a0/usr` → New folder successfully created the owned
`canary-a0-recommended-0906` directory. Navigating into it and choosing New File
opened the native dialog but **no editing area appeared**, including after
waiting and entering `proof.txt`. Save was not clicked in that broken state.
Cancelled the unsaved dialog, then opened New File once more: the ACE editing
area now appeared. This one warm reopen is evidence about the failure, not an
implemented retry or a clean first-open pass.

The reopened native editor accepted `HIVRA_A0_NATIVE_FILE_OK\n` and one Save.
The native listing displayed `proof.txt`, 24 bytes. A read-only guest check of
`/opt/a0/usr/canary-a0-recommended-0906/proof.txt` produced SHA-256
`6b50e83971aaf1116adcae8ba57a2fdeb993e765046de93fc0095cb1f113aacf`, independently
matching the intended 24-byte string locally. This proves the successful native
write after reopening; it does not erase the initial editor failure. No restart
or resize was performed in this fixture.

Read-only inspection of the exact guest code found a likely lifecycle race:
`openNewFile` calls `openModal`, then schedules editor initialization after two
animation frames. `initEditor` returns without another scheduled attempt when
`file-editor-container` does not exist. Meanwhile `openModal` asynchronously
loads its component and emits `modal-content-loaded` only afterwards; its
returned promise resolves on modal removal, not initial readiness. This source
behavior matches the cold-fail/warm-success observation but still needs an
offline regression and a lifecycle-bound fix rather than longer sleeps.

Exact MIT-licensed upstream sources, including LICENSE and `modals.js`, were
captured for that follow-up at `/tmp/hivra-a0-editor.PsITBY`. Local and
guest SHA-256 matched:

- `file-editor-store.js`:
  `0b5c2f4a00bf9c5b7b8059ee6c9797a139470b06039d08b9a419c0c7d62be5bd`.
- `file-edit-modal.html`:
  `897f2a7f036db3a0e039101dab24ece725dac8ca04c66ed5700822735fc74a84`.

No guest source, runtime image or sealed provisioner bundle was patched.

### Cleanup and scope of acceptance

Normal Manage → Destroy, irreversible checkbox, exact fixture name and
Permanently Destroy removed only this owned computer. Fresh checks confirmed
deleted status, null VM/operation, cleared token and tunnel references, absent
VM configuration and volumes, absent installer PID file and original PID
3711690, and the exact pre-test full VM-list hash above. All cleanup checks were
complete by 03:00:27 UTC, before the 03:05 deadline. Both authoritative
Cloudflare nameservers returned NXDOMAIN for
`agents-canary-box-redacted.hermesos.cloud`. The external tunnel object was
not independently enumerated. Home again showed the original four computers
and two agents, all Running. The fixture and its marker were irreversibly
deleted; existing resources and sessions were preserved. No additional spend.

The managed size-selection milestone is live-accepted on this exact revision:
rendered choices, selected allocation, native dashboard and a useful native
file operation were exercised. The native editor's first-open failure remains
**FAIL**, with the captured code providing a bounded next investigation. The
earlier intermittent cold-render issue, model authentication/replies and the
remaining whole-catalog/core-experience requirements remain unaccepted.
