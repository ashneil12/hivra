# Verification status

This file is the public, sanitized index of Hivra acceptance evidence. Detailed
Canary receipts remain in the private engineering history because they contain
disposable instance identities, host placement, network addresses, local paths,
and other environment-specific operational data.

## Source and self-hosting

- The credential gate for the fresh source-only repository is reconciled.
  Four active targets were checked; zero authorized the historical key.
  Strict host-key checking remained enabled.
  No host authorization, provider resource, customer row, current credential, or Git history was changed by that read-only reconciliation.
- The current source-only export has a root Apache-2.0 license, notices,
  deterministic dependency and asset inventories, a source/runtime boundary,
  credential reconciliation, secret scanning, and a clean-tree export gate.
- A fresh exported source tree has completed the documented self-host bootstrap,
  loopback binding, operator login, persistence, infrastructure registration,
  hosted-billing guard, encrypted backup/restore, key rotation, recovery, and
  unconditional cleanup checks.
- The initial reviewed source export is published, as recorded in
  [the public transition](PUBLIC-TRANSITION.md). Future source candidates require
  review of their exact revision. A separately built runtime, image, desktop
  bundle, or mirror remains its own artifact class.

## Portable infrastructure

- Provider connection, host preparation, capability detection, resource
  allocation, launch, power, resize, recovery, deletion, and cleanup contracts
  have automated regression coverage.
- Disposable Canary checks have exercised the managed and provider-owned paths.
  Exact host, VM, account, operation, and network identities are intentionally
  excluded from this public source tree.
- New self-host installs start with an empty host registry. Hivra-managed fleet
  inventory is deployment data, not a public migration seed.
- The 2026-09-04 Canary release-gate repair admits provisioner bundle
  `2026.09.04.4`. The deployed admission and native-identity function bodies
  match the committed migration, with execution still limited to `service_role`.
  The executable PostgreSQL regression checks current and historical admission,
  unknown versions, crossed bundle hashes, and owner/lease boundaries.
- Direct Hetzner server-type resizing is not yet live-accepted. Its acceptance
  requires a disposable computer's real create, prepare, launch, work, stop,
  resize, start, persisted-file readback, and deletion through the user path.
  Automated lifecycle coverage does not establish that result.

## Agent and computer surfaces

- The catalog and lifecycle contracts support the established Hermes/Codex and
  multi-agent paths plus Hivra-owned adapters for Buzz, DeepSeek Harness, and
  Omarchy.
- Buzz has passed a signed cross-agent relay and real-reply check on a disposable
  Canary environment.
- DeepSeek Harness has passed native UI, model, PTY, restart, credential revoke,
  reply, and cleanup checks. Its ACP orchestration lane is not yet accepted.
- Omarchy has passed isolated KVM installation, desktop boot, and Sunshine
  preparation. Native Moonlight video/input/audio, reconnect, and measured
  interaction-latency acceptance are still pending suitable disposable capacity.
- Remote-computer browser transport, session brokering, owner authorization,
  and timing instrumentation have automated coverage. “Local-feeling” daily
  driver performance is not claimed until native client measurements pass.
- The Canary Ubuntu browser desktop has been exercised for single-refresh
  reconnection and viewport/fullscreen resizing with a useful desktop interaction.
  This does not establish acceptance for every agent, Omarchy/Windows access,
  or restoration of computer data onto a fresh computer.

## Evidence policy

Reusable tests, protocols, provisioners, recovery code, and sanitized runbooks
remain public. Raw incident reports, customer or disposable instance identities,
live host inventory, access endpoints, developer-machine paths, and generated
temporary receipts do not.

## Phase 1 checkpoints (August 2026)

Moved here from [the roadmap](../../ROADMAP.md) on 2026-09-25. The text is
unchanged except that "Latest" was dropped from the first heading, the receipt
links (which pointed at this file) became plain text, and one dated update note
was added. Each entry records the state at its own revision; later entries and
later work supersede parts of earlier ones, and none of them closes Phase 1.
Where an entry names a receipt, the detailed receipt is in the private
engineering history described at the top of this file.

**Live checkpoint (2026-08-28):** the original UI now passed a bounded
real Hetzner create, firewall-before-power preparation, exact-computer handoff,
Codex installation, real metered model/tool work, independent file readback,
restart persistence, and complete teardown. The final cleanup correction
`66ae1095246d51e916ab538720a9f6a3b1451d35` passed a fresh native-access launch and
one-confirmation removal of all five original provider resources, with tunnel
and DNS absence independently verified. Its full gate passed 9,894 tests,
lint, typecheck and build. Both temporary Hivra connections and issued test
model keys are removed/revoked; revocation of the temporary Hetzner project
token remains unverified because the Arc UI is unavailable. See the
revision-bound acceptance receipt.
This does not close Phase 1: user-owned Proxmox, whole-catalog/every-key
acceptance, full self-host packaging, and the Phase 0 release gates remain
separate. The following checkpoints record their earlier revision's state.

**Current canary evidence (2026-08-26):** The existing launch and agent-detail experience now has an additive Hivra Cloud/self-managed destination selector, an owner-scoped Proxmox connection and target registry, explicit host preparation, exact target-bound launch and lifecycle authority, and a versioned in-repository provisioner. The exact database migrations were transaction-tested and applied while preserving the existing managed agents, and commit `f68dbae54` passed the canary build plus authenticated, non-destructive desktop and mobile checks for the infrastructure registry, Simple/Advanced setup, original agent catalog, Codex launch form, destination fail-closed behavior, and affected read APIs. This is not the Phase 1 exit: `UC-PORTABLE-AGENT-01` must still pass on an approved user-owned target, including real provisioning, native interface access, restart, and verified deletion with no residual resource.

**Managed launch and access checkpoint (2026-08-27):** After the initial
`.8`/`.9` disposable test, a second Codex computer launched directly with
provisioner `2026.08.26.10` without guest repair. The original launch/detail
flow, native terminal, files, Git empty state, landscape browser, saved context,
restart, and independently verified teardown were exercised on one allowlisted
managed host. Both disposable computers were removed without residual VM,
disks, runtime artifacts, DNS records, or live tunnels. Final dashboard commit
`28ad356bd` reached the verified Canary alias and passed full verification:
762 suites / 7,373 tests plus lint, typecheck, and production build. No model
login or inference run was performed, and fullscreen window behavior remains
unaccepted. See the redacted acceptance receipt
for distinct revision/deployment evidence. Older guest upgrades, fleet
readiness, user-owned Proxmox/BYOK and real Hetzner acceptance, browser sandbox
hardening, durable failure-path cleanup, canonical access grants, and Phase 0
publication safety remain separate work. This does not close a roadmap phase.

**Managed guest runtime-update checkpoint (2026-08-29):** Canary revision
`312d65bfa37a25ca560f8bcc928402bfc59d8d48` adds a bounded, version-checked
host bundle synchronizer and a truthful `Update & restart` operation in the
original agent Manage screen. All four configured Canary managed targets
reported exact bundle `2026.08.29.1`. A disposable Codex computer preserved its
agent, host and VM identities across the live update, reconnected its terminal,
then passed verified VM, volume, runtime-artifact, tunnel and DNS cleanup. The
pre-existing managed Codex computer remained running. The same revision passed
a fresh real signup-to-agent-reply journey with no teardown residue; that is a
1/1 checkpoint, not the complete 19/20 campaign. See the
acceptance receipt.
Provider-computer updates, self-managed-target updates, whole-catalog acceptance
and full self-host packaging remain open.

**Installed-runtime receipt checkpoint (2026-08-29):** Canary revision
`b145091e35beb4804eb58e9a0db5af30f1a6a937` records the actual installed guest
state and deterministically derives a private CycloneDX 1.6 SBOM plus
notice/source-review manifest. A fresh original-UI Codex launch on exact bundle
`2026.08.29.4` verified Ubuntu 22.04, all three byte-bound evidence artifacts,
708 SBOM components, exact missing-notice counts, both terminal surfaces and
public HTTP health, then passed bounded teardown while the pre-existing managed
computer stayed running. All four managed hosts now pass unchanged `.29.4`
inspection. The evidence remains explicitly `releaseApproved: false`; it does
not replace vulnerability, rights, complete notice/source-offer or public-release
review. See the
acceptance receipt.

**Standalone provider-to-agent checkpoint (2026-08-29):** The independent
single-operator source-checkout path now starts a loopback-only local Supabase
control plane, uses installation-owned authentication, removes hosted billing
surfaces, and accepts an operator-owned Hetzner token. A fresh Hetzner CPX21
computer was created and prepared with pinned bundle `2026.08.29.5`; the
original catalog launched Codex, exposed its first-party chat, terminal, files,
Git and native-login surfaces, and generated byte-bound installed-state receipt,
CycloneDX SBOM and notice-review artifacts. The test then deleted the agent and
confirmed exact absence of its server, IPv4, IPv6, SSH key and firewall. No paid
provider resources were retained. The evidence is still
`releaseApproved: false`: provider-agent restart, model login/inference,
clean-machine repetition from the exact committed public-source candidate, and
the remaining Phase 0 rights/history/security gates are open.

**Current Hetzner create milestone (repository evidence, 2026-08-26):** The
bounded Simple-mode path now has live policy-filtered offer selection,
revision-bound short-lived provider-rate observations, explicit spend
confirmation, idempotent creation, provider-operation reconciliation, and a
reload-safe same-request recovery path, plus a powered-off/unprepared result
contract. It shows server, IPv4, IPv6, included traffic, variable overage, and
billing-lifecycle truth before submission. Disconnect copy warns that Hivra's
stored generated private key is destroyed while provider resources and billing
remain. This is not deployed-provider or production-readiness evidence; the
real approved-project create, observe, restart, delete, and residual-resource
acceptance gate remains open. Canary also limits each Hivra account to one
non-rejected in-app Hetzner server claim across all project connections.
Disconnecting or externally deleting the server does not automatically clear
the slot in v1; this is a spend guard, not the target multi-box model.

**Scoped cleanup checkpoint (2026-08-27):** Canary commit `6a5cb21af` adds
explicit cleanup of an original-receipted, unprepared, powered-off server and
its original IPs/generated SSH key. Only verified absence releases its account
slot. Failed cleanup can resume; separately confirmed local-access abandonment
retains the unresolved claim and does not stop billing. Independent review,
784 suites / 7,798 tests, a production build, and isolated browser checks passed;
the database migration and Canary alias were verified. Real Hetzner
create/cleanup, first boot, preparation, and agent placement remain acceptance
gates. See the receipt.

**First-boot cleanup checkpoint (2026-08-27):** The same cleanup now includes
the original setup firewall, separate started-computer confirmation, and a
locked expected-receipt check against setup races. All five absence checks are
required before release. Independent review, actual-SQL tests, full verification
and simulated browser interaction passed; the scoped Canary schema is verified.
Public first boot, pinned SSH/readiness, target-aware retirement and real
provider acceptance remain open. See the
receipt.

**Guided preparation checkpoint (2026-08-28):** the original create-server
review can include a separately approved first-boot recipe. A resumable setup
dialog uses the existing firewall, enrollment, pinned SSH and bundle delivery
operations. It publishes only an unavailable, bundle-prepared computer; the
public provider agent adapter and real Hetzner lifecycle acceptance remain
unfinished. See the receipt
for current checks and delivery status.

**Provider deletion integration (2026-08-28):** the original agent lifecycle
now routes provider-computer removal through exact owner/operation-bound
installer cancellation, target retirement and five-resource cleanup. The
management screen retains pending state until terminal proof. Launch admission,
native access acceptance, power controls and real-provider acceptance remain
open; see the receipt.

**Provider readiness integration (2026-08-28):** the original agent status path
observes the original installer, checks pinned guest services/authentication and
the named public connection, then uses the shared terminal state guard. The page
shows observed setup stages and keeps removal accessible. This does not admit
launches or prove model login, inference or real-provider acceptance; see the
receipt.

**Provider power foundation (2026-08-28):** explicit owner-token transport and a
private original-operation journal/store now support bounded, single-dispatch
start/stop/restart contracts. Shared finalizers require actual state and reboot
identity proof, with deletion races retaining the original operation. This does
not expose power controls or admit launches; provider observation/dispatch
integration and real lifecycle acceptance remain open. See the
receipt.

**Provider power integration (2026-08-28):** the original action/status/removal
routes now use the owner-bound coordinator. Explicit actions can send one
provider request; status/removal only observe it. Actual off state or verified
guest/public services are required for completion, with changed boot identity
for restart. Manage shows the observed operation and retains uncertain requests.
Allocated provider resize remains unavailable. Provider launch admission and
real Hetzner lifecycle acceptance remain open; see the
receipt.

**Provider launch integration (2026-08-28):** Canary commit `1fbabd12e` and the
verified `20260828060000` migration connect prepared exclusive Hetzner computers
to the existing five-runtime launch route. Separate admission, original-operation
reservation/dispatch, readiness, native handoff, power and deletion now form one
implemented provider path. Whole-computer UI controls and native model sign-in
preserve the original agent experience. Automatic model-key/template-skill
delivery and Hermes' separate provider lane remain unimplemented. (Update
2026-09-25: template skills and identity files now reach Claude Code and Codex
on provider VMs, #102. The code sends model settings in the installer's launch
document; that has not been re-checked live for this note.) Full tests,
actual SQL fixtures, independent review and deployed UI/authentication sanity
passed; the real Hetzner create-to-cleanup acceptance is still pending a connected
test project. See the launch receipt.
