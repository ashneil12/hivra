# Agent, terminal and files integration — bounded Canary evidence

Date: 2026-09-15. Task: agent terminal and files integration.

## Environment and evidence boundary

The source baseline was `5ed3785d76ae2a367ced02037c013e4d5ea440c5` on `codex/desktop-runtime-repair-20260914`. Changes were isolated in `codex/agent-computer-integration-20260915`; concurrent root-checkout work was preserved.

Vercel inspection independently returned READY deployment `dpl_H7Sv6mF5VWajNmVdGQL2RwkRxiRg` for `canary.hermesos.cloud`, matching the supplied deployment. The desktop reliability task separately reported checking its revision metadata against `5ed3785d7`. Later inspection returned newer READY deployment `dpl_CksP52MTYVYEVdX7PnythJQYhWR9` at the same alias while parallel work was active. The source branch also advanced to `ec14a71ba`. Therefore the browser observations below span a changing shared Canary environment; they establish the observed interactions, but cannot all be attributed to one immutable dashboard revision. They are not post-change acceptance of this task. No deployment was performed by this task at this checkpoint.

## Browser acceptance performed

Used an authenticated Chrome tab through the normal Canary dashboard and per-resource detail page. No service-health or powered-on VM state was substituted for the interactions below.

### Ubuntu computer

Opened UBUNTU_CANARY_CURRENT through Home -> computer -> Box Terminal. `pwd`, `hostname`, and `id -un` returned `/home/bux/Hivra`, `hivra-cc-1108`, and `bux`.

Created one new directory `hivra-integration-20260915-2c4d` with `mkdir` (no overwrite or recursive creation), then wrote `probe.txt` containing a unique non-sensitive marker. Opened Files, entered that directory, and read the marker. Edited only that file in the Files editor, saved `HIVRA_INTEGRATION_2C4D_FILES`, returned to Box Terminal, and read the exact edited marker from the same path.

The Desktop view reported an existing controller. No forced takeover, restart, controller release, or interruption was attempted.

### Codex agent computer

Opened CODEX_E2E_DELIVERY through the dashboard. The native Codex terminal rendered an update prompt, which was left untouched. In Chat, sent one bounded instruction to run `pwd`, `hostname`, and `id -un`, create a new uniquely named directory, write one marker, and touch no other files.

The UI displayed a real Bash tool call followed by `/home/bux`, `hivra-cc-1130`, `bux`, and the marker path. Independently opened Files and read `HIVRA_2C4D_AGENT_OK` from `hivra-integration-20260915-2c4d-agent/probe.txt`. Then opened Tools -> Box Terminal and independently ran identity commands plus `cat` against that exact absolute path; the computer, user, working directory, and marker agreed with the agent action.

Reloaded the browser detail page, reconnected the Box Terminal, and read the same file again with the same `/home/bux` working directory. This proves browser-reconnection persistence, not reboot persistence.

### Windows

Opened MY_WINDOWS_DESKTOP from Home and inspected Files and Terminal. Files rendered guidance to use File Explorer inside Desktop and explicitly stated that dedicated web file browsing/upload/download was unavailable. Terminal rendered guidance to use PowerShell inside Desktop, including `Get-Location`, and explicitly stated that a dedicated web terminal was unavailable.

No Windows file, shell, setup, lifecycle, or RDP input mutation was performed. These are accepted capability messages, not Windows shell/file runtime acceptance.

## Preservation and cleanup

Removed only the two owned `probe.txt` files using exact absolute paths, then removed their empty directories using `rmdir`. `test ! -e` returned success and the terminals printed `HIVRA_2C4D_CLEAN` and `HIVRA_AGENT_2C4D_CLEAN`. No wildcard or recursive cleanup was used. No retained computer, disk, credential, existing file, running agent process, or user session was deleted or restarted. The non-sensitive integration chat remains as a test receipt; unrelated chats were untouched.

## Remaining limits

- No restart/reboot persistence test against retained desktops.
- No whole-catalog or cross-tenant live acceptance.
- Modern Desktop controller isolation relies on its no-agent-input runtime topology; it does not prove suspension of a running managed agent attached to that desktop.
- Legacy agent BrowserView uses direct noVNC without an enforced agent input handoff. A read-only browser default is a UI safeguard, not server-side security isolation; an authenticated owner can alter client options.
- Shared lifecycle/session fencing belongs to the desktop reliability task and is not replaced here.
- Updated source requires coordinated Canary integration and post-deployment browser verification before being called deployed or live-accepted.

## Omarchy follow-up

Opened MY_OMARCHY_DESKTOP through Computers. Desktop established a Selkies connection and rendered the remote viewport. Switched to Box Terminal and Files; both rendered `Not ready` / `The box isn't reachable yet.` This contradicts an implication that the whole computer is unreachable: the terminal/files endpoint is missing while Desktop is reachable. No Omarchy shell, file, reboot, or input mutation was performed. The task is correcting these web-tool panels to explain the missing connection and offer the Desktop route; no dedicated Omarchy web-terminal/file runtime acceptance is claimed.

## Source changes and checks

The isolated branch was rebased onto the newer shared source `ec14a71ba` to preserve the concurrent resource-configuration changes. Source milestones are `afe145321` (Windows capability/hidden-terminal guard and legacy browser read-only default) and `81b61b499` (actionable disconnected computer tools).

The capability milestone passed six focused suites / 145 tests, 17 smoke-contract suites / 335 tests, TypeScript typechecking, touched-file ESLint, and `git diff --check`. The additional Omarchy regression and final rebased checks are recorded with the pull request. Source review confirmed the Windows profile reaches each production workspace projector caller and that existing Windows guidance does not bootstrap a hidden generic Linux terminal.

The real execution path is owner-scoped detail lookup -> the selected agent's recorded chat endpoint -> guest chat CLI process / file API / authenticated terminal bootstrap. Agent-box CLI and shell start at `/home/bux`, matching its guarded Files root. The checked Ubuntu desktop terminal and Files root are `/home/bux/Hivra`. No alternate execution framework or lifecycle was added.

## Post-deployment acceptance — 2026-09-15

After Ash explicitly requested pushing and proceeding, the integration branch merged the latest shared commit `115cb687699374fe161300be44bb05674baf7198`. Runtime release revision is `2dee8050aed8f1ae38e2f7232f2a53800c5d9c11`.

Built that exact clean checkout in the existing `hermesos-canary` project with automatic custom-domain promotion disabled. Vercel deployment `dpl_CAQytcdTxWqaYBt4airEHnHgMjmW` passed compilation, TypeScript and build completion. Immediately before assigning only `canary.hermesos.cloud`, a guard verified the alias still pointed to the expected prior deployment and the current shared checkout HEAD was an ancestor of the release. The alias then moved successfully to `hermesos-canary-5i1f4kv6h-ashneil12s-projects.vercel.app`; a subsequent inspection confirmed that exact READY deployment. Concurrent uncommitted private-access work in the shared checkout was untouched.

Fresh authenticated browser checks on this deployment:

- Omarchy Files and Terminal display the new missing-web-tool guidance. Open Desktop changes to the existing desktop surface and starts its stream rather than a generic unreachable error.
- Windows Files and Terminal retain their File Explorer/PowerShell guidance. DOM inspection of its Files panel found zero iframes and zero terminal bootstrap forms.
- Codex legacy Browser displays the read-only limitation, connects its viewer, grants only origin-scoped fullscreen permission, and the actual noVNC `noVNC_setting_view_only` checkbox is checked. This accepts the client read-only default, not a server-enforced agent pause.
- Codex Chat ran a new Bash tool call creating `/home/bux/hivra-release-2dee-2c4d/probe.txt`. Files independently read `HIVRA_RELEASE_2DEE_AGENT`, then saved `HIVRA_RELEASE_2DEE_FILES`. Box Terminal independently returned `/home/bux`, `hivra-cc-1130`, `bux`, and the exact edited marker. Cleanup removed only that file and its empty directory; an absence test printed `HIVRA_RELEASE_2DEE_CLEAN`.
- The public root returned HTTP 200 and `X-Robots-Tag: noindex, nofollow`; robots.txt retained `Disallow: /`. An unauthenticated HEAD request to /dashboard returned 404 and was not used as workflow acceptance.

The later pushed scanner-metadata-only correction `f6dde2baa` is separate from this runtime deployment. It updates three existing synthetic-fixture fingerprints and their aggregate hash; metadata tests passed 14/14. The full exact-archive scanner still reports six unrelated baseline candidates, left unsuppressed and sent to the security task. Public-source release gates are not claimed complete.

Remaining functional limits are unchanged: no server-enforced legacy human takeover, no retained-computer reboot test, and no dedicated Windows or Omarchy web-shell/file runtime acceptance. Production was not changed and the PR was not merged into the production branch.
