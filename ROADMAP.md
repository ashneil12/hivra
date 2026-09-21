# Hivra Agent Computers Roadmap

**Status:** Active product roadmap

**Design authority:** [`docs/superpowers/specs/2026-08-24-hivra-agent-computers-design.md`](docs/superpowers/specs/2026-08-24-hivra-agent-computers-design.md)

**Core experience:** the target is a clear Agent-or-Computer entry, followed by revision-bound Canary verification. See [the product architecture](docs/PRODUCT-ARCHITECTURE.md). Target direction does not imply shipped behavior.

**Execution authority:** Code implementation, Canary deployment, and bounded
launch tests on clearly identified Hivra-owned Canary capacity are authorized.
Native-app work, production or public release, provider-capacity purchase, trial
policy, host preparation, and unrelated or destructive live mutations are
excluded. Test-scoped lifecycle actions may affect only disposable resources
created for an approved Canary check and must preserve pre-existing resources
and produce exact cleanup evidence.

## Approved web/Canary execution order

The reset slices are the active implementation order. The numbered phases below
remain foundation and acceptance tracks; their requirements do not become
current merely because related implementation is pulled forward.

| Reset slice | Relationship to the existing phase gates |
| --- | --- |
| Slice 0 — Product truth | **Complete 2026-09-04:** all canonical documents record the approval, crosswalk, unchanged portable gate, and authority scope. This does not close the separate Phase 0 public-release exit. |
| Slice 1 — Launch contract and shell | Pulls forward Phase 2 contracts behind a gated web shell while Phase 1 portable closure continues. |
| Slice 2 — Hivra Cloud golden paths | Runs one managed Agent alongside Phases 1/3 and Ubuntu Computer alongside Phase 8; neither substitutes for portable acceptance. |
| Slice 2B — Attach Agent | Adds explicit binding between runtime consolidation and full Computer use. |
| Slice 3 — Customer-owned capacity | Carries the Phase 1/3 reference path and `UC-PORTABLE-AGENT-01` unchanged. |
| Slices 4A-4C — Recovery and linking | Split Phase 4 into self-host control-plane recovery, Computer data portability, and separately threat-modelled optional Cloud linking. |
| Slice 5 — Linux Computer | Carries Phase 8 desktop performance acceptance. |
| Slice 6 — Windows guest | Carries the Windows-guest part of Phase 9. |
| Slice 7 — Native clients | Later separately authorized release track; excluded from current execution scope. |
| Slice 8 — Orchestration | Carries Phase 7 after real single-agent execution, authority, recovery, and bounded stops; Phase 6 workspace is not a prerequisite. |

The working agent catalogue, launch path, detail screens, and native surfaces
remain available until migration, parity, rollback, and acceptance gates pass.
A new shell, managed path, Ubuntu path, mock, or contract test cannot close the
portable reference or public-release gates.

### Responsibility vocabulary

The UI selects **Hivra-hosted** or **Self-hosted Hivra** for the control plane
independently from **Hivra Cloud capacity**, **My cloud**, or **My server** for
capacity. Each capacity resource and operation persists its control-plane
operator, infrastructure-credential custodian, spend owner, capacity operator,
upgrade/monitoring/recovery owner, and support party. The compatibility labels
`self-managed` and `hivra-managed` remain stable names for existing acceptance
profiles only when that exact field mapping is declared; one binary label cannot
silently assign authority or responsibility.

## Roadmap rules

- One real end-to-end path outranks broad simulated coverage.
- Current implementation and target architecture must remain clearly labeled.
- No new product lane may bypass the canonical agent-computer contracts.
- No fake progress, completion, queue, task, subagent, or fleet state.
- Each phase has an evidence-based exit gate before the next phase depends on it.
- Existing production reliability work continues when necessary, but it does not redefine product architecture.

The prior HermesOS marketing and maintenance backlog remains available in Git history. Items from it must be re-triaged against this roadmap before implementation.

## Phase 0 — Canonical truth and public-release safety

**Status:** Building

**Goal:** Establish one product source of truth and determine whether the repository can be released publicly with preserved history.

- [x] Approve and commit the agent-computers platform design.
- [x] Synchronize local and remote `main` without losing local work.
- [x] Establish canonical vision, product architecture, security model, open-source boundary, and documentation precedence.
- [x] Align the approved 2026-09-04 core-experience reset across `VISION.md`,
  product architecture, the canonical Agent Computers design, this roadmap, and
  its implementation plan without changing the portable reference gate.
- [x] Mark conflicting hosting-era plans historical in the milestone change set.
- [x] Inventory the current tree and complete intended Git history.
- [x] Scan secrets, sensitive operational data, customer data, large objects, generated files, and private assets. See the [redacted public-release audit](docs/release/VERIFICATION-STATUS.md).
- [x] Reconcile confirmed historical credentials and prepare a cleaned source
  candidate boundary. The historical Stripe credential is invalid or revoked;
  the historical SSH identity is absent from every active managed target and the
  current operator Hetzner project; private history is excluded from the fresh
  repository. See the [redacted reconciliation](docs/release/VERIFICATION-STATUS.md).
  Earlier reproducible candidates remain historical evidence; a final candidate
  must be regenerated from the accepted clean commit.
- [x] Audit dependencies, source assets, and source-only third-party runtime
  distribution rights.
  - Reproducible offline npm SBOM generation and an explicit runtime-input coverage
    inventory are available in [dependency evidence](docs/release/DEPENDENCIES.md).
    All four npm components have lockfile coverage; a fail-closed exact-artifact
    review classifies every current npm license and preserves unresolved notice,
    attribution, reciprocal, source-choice and artifact-identity work as explicit
    candidate gaps. A second exact-tree gate now covers every tracked visual
    asset: 18 unused starter/legacy/duplicate files and five superseded held
    files were removed, the Hivra mark was rebuilt as project-authored SVG, and
    three replacement litepaper illustrations retain exact prompts, output
    receipts, hashes, terms review and visual acceptance. All seven remaining
    assets are classified for inclusion and the asset-review blocker is closed.
    Both Worker builds have local runtime smoke checks. The first public artifact
    is explicitly source-only: no third-party runtime/image bytes are embedded,
    all external inputs have immutable upstream identities, and the browser
    sidecar bases are digest-pinned. Exact notices and SBOMs for a separately
    distributed built image or runtime mirror remain a separate future gate.
- [x] Identify the exact Buzz project and complete the bounded integration
  assessment. The canonical upstream is `block/buzz`; DeepSeek Harness is
  `deepseek-ai/deepseek-harness`. Their distinct roles, exact reviewed source
  identities, license boundaries, and fail-closed adapter contracts are recorded
  in the [integration assessment](docs/release/VERIFICATION-STATUS.md).
- [x] Select and commit Apache-2.0 for Hivra-owned source, a repository notice,
  contribution terms, trademark policy, security reporting policy, reproducible
  npm SBOM evidence, and explicit portable-installer distribution decisions.
- [x] Generate exact source-tree notice/source evidence and a fail-closed
  source-only runtime boundary. Installed computers generate private exact
  runtime receipts; Hivra-built images or mirrored runtime artifacts are excluded
  from the source release until their separate byte-level evidence is complete.
- [x] Decide preserved-history versus fresh-public-repository using an independent
  review. The public release will start from an exact reviewed current-tree export;
  the private Canary history will not be published or rewritten. See the
  [decision record](docs/release/PUBLIC-REPOSITORY-DECISION.md).

**Exit:** A clean, licensed, independently reviewed public-release candidate and one unambiguous documentation hierarchy.

## Phase 1 — Portable existing agents and bring your own keys

**Status:** Canary implementation under release verification; Phase 0 public-release safety remains separate

**Goal:** Preserve the original agent launch path as the portable acceptance
surface while making it portable enough to run with user-owned credentials. The
approved sibling web shell may proceed in parallel but cannot replace this gate.

**Latest live checkpoint (2026-08-28):** the original UI now passed a bounded
real Hetzner create, firewall-before-power preparation, exact-computer handoff,
Codex installation, real metered model/tool work, independent file readback,
restart persistence, and complete teardown. The final cleanup correction
`66ae1095246d51e916ab538720a9f6a3b1451d35` passed a fresh native-access launch and
one-confirmation removal of all five original provider resources, with tunnel
and DNS absence independently verified. Its full gate passed 9,894 tests,
lint, typecheck and build. Both temporary Hivra connections and issued test
model keys are removed/revoked; revocation of the temporary Hetzner project
token remains unverified because the Arc UI is unavailable. See the
[revision-bound acceptance receipt](docs/release/VERIFICATION-STATUS.md).
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
unaccepted. See the [redacted acceptance receipt](docs/release/VERIFICATION-STATUS.md)
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
[acceptance receipt](docs/release/VERIFICATION-STATUS.md).
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
[acceptance receipt](docs/release/VERIFICATION-STATUS.md).

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
gates. See the [receipt](docs/release/VERIFICATION-STATUS.md).

**First-boot cleanup checkpoint (2026-08-27):** The same cleanup now includes
the original setup firewall, separate started-computer confirmation, and a
locked expected-receipt check against setup races. All five absence checks are
required before release. Independent review, actual-SQL tests, full verification
and simulated browser interaction passed; the scoped Canary schema is verified.
Public first boot, pinned SSH/readiness, target-aware retirement and real
provider acceptance remain open. See the
[receipt](docs/release/VERIFICATION-STATUS.md).

**Guided preparation checkpoint (2026-08-28):** the original create-server
review can include a separately approved first-boot recipe. A resumable setup
dialog uses the existing firewall, enrollment, pinned SSH and bundle delivery
operations. It publishes only an unavailable, bundle-prepared computer; the
public provider agent adapter and real Hetzner lifecycle acceptance remain
unfinished. See the [receipt](docs/release/VERIFICATION-STATUS.md)
for current checks and delivery status.

**Provider deletion integration (2026-08-28):** the original agent lifecycle
now routes provider-computer removal through exact owner/operation-bound
installer cancellation, target retirement and five-resource cleanup. The
management screen retains pending state until terminal proof. Launch admission,
native access acceptance, power controls and real-provider acceptance remain
open; see the [receipt](docs/release/VERIFICATION-STATUS.md).

**Provider readiness integration (2026-08-28):** the original agent status path
observes the original installer, checks pinned guest services/authentication and
the named public connection, then uses the shared terminal state guard. The page
shows observed setup stages and keeps removal accessible. This does not admit
launches or prove model login, inference or real-provider acceptance; see the
[receipt](docs/release/VERIFICATION-STATUS.md).

**Provider power foundation (2026-08-28):** explicit owner-token transport and a
private original-operation journal/store now support bounded, single-dispatch
start/stop/restart contracts. Shared finalizers require actual state and reboot
identity proof, with deletion races retaining the original operation. This does
not expose power controls or admit launches; provider observation/dispatch
integration and real lifecycle acceptance remain open. See the
[receipt](docs/release/VERIFICATION-STATUS.md).

**Provider power integration (2026-08-28):** the original action/status/removal
routes now use the owner-bound coordinator. Explicit actions can send one
provider request; status/removal only observe it. Actual off state or verified
guest/public services are required for completion, with changed boot identity
for restart. Manage shows the observed operation and retains uncertain requests.
Allocated provider resize remains unavailable. Provider launch admission and
real Hetzner lifecycle acceptance remain open; see the
[receipt](docs/release/VERIFICATION-STATUS.md).

**Provider launch integration (2026-08-28):** Canary commit `1fbabd12e` and the
verified `20260828060000` migration connect prepared exclusive Hetzner computers
to the existing five-runtime launch route. Separate admission, original-operation
reservation/dispatch, readiness, native handoff, power and deletion now form one
implemented provider path. Whole-computer UI controls and native model sign-in
preserve the original agent experience. Automatic model-key/template-skill
delivery and Hermes' separate provider lane remain unimplemented. Full tests,
actual SQL fixtures, independent review and deployed UI/authentication sanity
passed; the real Hetzner create-to-cleanup acceptance is still pending a connected
test project. See the [launch receipt](docs/release/VERIFICATION-STATUS.md).

- Keep the existing agent catalog, launch flow, agent detail screens, and useful
  runtime-native interfaces working while the sibling web shell is introduced;
  retain the original flow for its unchanged portable acceptance.
- Accept supported user-owned runtime or model API keys without requiring Hivra-managed model credits.
- Accept supported user-owned host or provider credentials for self-managed computers. The entry action is connect a host, not connect Proxmox.
- Store infrastructure connections separately from runtime keys and first inspect hosts without mutation. Persist revision-bound, non-secret evidence about operating system, capacity, virtualization support, installed substrates, and candidate isolation drivers.
- Keep provider onboarding outcome-led: the Hetzner Cloud slice asks for a
  project-scoped Read & Write token, discloses its broad project authority and
  that read-only validation cannot prove write scope,
  inventories separate existing servers, and creates only a policy-bounded
  powered-off provider VM after a fresh provider-rate observation and explicit billing
  confirmation. Separate setup can prepare its environment; neither capacity
  creation nor bundle preparation is represented as an agent-ready computer.
- Treat preparation as a separate, explicitly approved operation. Discovery alone must not create launch authority, and the first launchable self-managed adapter remains existing Proxmox KVM until another adapter passes equivalent lifecycle acceptance.
- Validate credentials and required capabilities without exposing reusable values to the browser, logs, events, or other users.
- Let the user choose control plane and capacity independently, then review and
  persist the exact credential, spend, capacity-operation, recovery, and support
  responsibility assignment before provisioning. Existing `self-managed` and
  `hivra-managed` acceptance profiles keep their explicit mapped semantics.
- Provide a Simple setup that automatically selects the strongest compatible placement and an Advanced setup that exposes only supported driver, node, resource, network, storage, repair, and spending controls.
- Provision from the existing flow after explicit capacity, image, network, storage, DNS, and permission preflight.
- Never fall back to ambient Hivra fleet credentials, silently purchase provider capacity, or silently downgrade isolation.
- Remove hidden dependencies on Hivra-only hosts, mutable scripts, environment assumptions, and business-only wiring from the portable path.
- Preserve each runtime's working Hivra or native interface after launch.
- Keep `/dashboard/workspace` optional; do not make it a dependency of portable provisioning.

**Exit:** A user can launch one supported existing agent with their own runtime key on supported user-owned infrastructure, open its working interface, restart it, and remove it without Hivra-held credentials or Hivra model credits.

## Phase 2 — Canonical contracts and versioned provisioning

**Status:** Slice 1 contract and gated-shell work is authorized in parallel with
Phase 1. The Phase 2 exit remains pending and cannot be claimed until its own
contract, migration, conformance, and reconciliation evidence passes.

**Goal:** Put the portable existing flow on reproducible contracts while a gated
sibling shell consumes the same contracts. Starting that shell does not replace
the portable acceptance UI or satisfy the Phase 2 exit.

- Define canonical identifiers and persisted relationships.
- Define separate run delivery and execution state contracts.
- Define desired, observed, health, and operation state for computers.
- Define provider and runtime capability documents and version negotiation.
- Define infrastructure-connection ownership, capacity inventory, placement policy, and isolation-driver contracts.
- Define computer identity, command transport, access grants, events, artifacts, and credential bindings.
- Commit the per-entity migration and write-authority contract.
- Bring load-bearing Hivra provisioner, guest runtime, and image assets into version control.
- Add fake provider and fake runtime conformance harnesses.
- Wrap existing Hermes and Hivra lanes with compatibility adapters.

**Exit:** The existing agent launch path can create, observe, reconcile, and retire a canonical fake agent computer without a legacy-specific backend dependency.

## Phase 3 — Portable existing-agent reference slice

**Status:** Pending Phase 2

**Goal:** Prove the portable original agent flow through the shared contracts.

- Connect and inspect a user-managed host, recommend a supported substrate, obtain explicit preparation consent when work is needed, then run the strict adapter preflight. The first reference path uses existing Proxmox KVM and provisions a versioned image through the public Proxmox adapter.
- Support user-owned and Hivra-owned provider credential modes.
- Select one mature currently supported runtime as the acceptance fixture; this is not a preferred-runtime product decision.
- Support its user-owned runtime or model credential without routing usage through Hivra credits.
- Enroll the computer runtime and install the pinned selected-runtime adapter.
- Authenticate without exposing reusable access secrets.
- Deliver one idempotent run and stream ordered resumable events.
- Produce verifiable Git, test, and artifact outputs.
- Recover from computer-supervisor and control-plane-worker restarts.
- Persist the conversation, workspace, event history, and terminal outcome.
- Verify target ownership, capacity admission, start, stop, resize, snapshot, restore, delete reconciliation, and absence of residual provider resources after success or induced failure.

**Exit:** `UC-PORTABLE-AGENT-01` passes through the original agent-first UI in both operating modes with exactly one truthful terminal outcome. The current catalog remains visible, and the fixture runtime is not presented as Hivra's preferred runtime.

## Phase 4 — Complete self-hosted operations

**Status:** Pending Phase 3

**Goal:** Turn the portable launch slice into a maintainable self-hosted product.

- Secure provider credential setup through UI or documented CLI.
- Add prepared Linux and Hetzner Cloud connections through the same capacity model, with capability-selected provider-VM, gVisor application-kernel, or explicitly labelled shared-kernel drivers.
- Add Hetzner dedicated-server bootstrap into Proxmox without assuming a normal cloud VM supports nested KVM.
- Upgrade, diagnostics, backup, restore rehearsal, export, and uninstall.
- Self-hosted master-key bootstrap, recovery, and rotation.
- Public operator runbooks shared with Hivra-managed operation.
- Reproduce the control plane and provisioner from version-controlled assets on a clean supported environment.

**Exit:** A fresh supported environment completes installation, `UC-PORTABLE-AGENT-01`, upgrade, backup/restore rehearsal, and export/uninstall without private intervention, while displaying the real selected isolation class.

## Phase 5 — Runtime consolidation

**Status:** Integration engineering requested; availability gated on portable
lifecycle, credentials and each runtime's acceptance.

**Goal:** Support multiple runtimes through one computer and execution model without discarding their best interfaces.

- Move every currently supported catalog runtime onto the shared target and execution contracts while retaining its native interface.
- Integrate Block's Buzz as an optional mediated identity, communication, and collaboration service rather than an infrastructure-control replacement.
- Add DeepSeek Harness and other runtimes one at a time behind pinned adapters and conformance tests.
- Follow the [2026-08-31 integration and remote-computers addendum](docs/superpowers/specs/2026-08-31-hivra-remote-computers.md): Buzz now has a real signed cross-agent runtime/reply campaign; DeepSeek Harness has real native UI, model, PTY, restart, revocation and cleanup evidence but remains gated on ACP; Omarchy belongs to computer profiles and now passes exact KVM install, desktop reboot, Sunshine guest preparation and teardown while remaining gated on a scoped native route and real Moonlight interaction.
- Stop legacy writes after parity and rollback gates pass.
- Retire overlapping Workspace Cloud and legacy agent lanes.

**Exit:** Multiple runtimes pass shared contracts and retain working native surfaces.

## Phase 6 — Optional unified workspace

**Status:** Pending Phase 5 and real evidence that it improves the original agent experience

**Goal:** Offer a shared workspace only where it is genuinely more useful than the existing agent-specific and native interfaces.

- Keep quick conversations available with no required project.
- Render real run events, approvals, input requests, blocks, recovery, and outcomes.
- Add selected-computer files, Git, terminal, browser, and native view only when backed by the selected runtime.
- Preserve direct access to Hermes, Buzz, Codex, and other useful native interfaces.
- Add collapsible computer controls and remembered layout/interface preferences.
- Support Hivra Dark, Vellum, and system themes without changing information architecture.
- Pass the named focused-workspace failure and recovery scenarios before considering it the default.

**Exit:** The optional workspace proves, through real use, that it improves the portable agent flow without hiding or duplicating runtime capabilities.

## Phase 7 — Projects, durable tasks, and fleet coordination

**Status:** Pending real single-agent execution, authority, and recovery; the
optional Phase 6 workspace is not a prerequisite

**Goal:** Coordinate durable work over proven single-computer primitives.

- Expand projects with repositories, instructions, context, policies, and shared views.
- Add durable tasks spanning conversations, runs, agents, approvals, and artifacts.
- Add delegation with real ownership and event semantics.
- Add project and fleet views driven by actual state.

**Exit:** Coordinated multi-agent work survives refresh, disconnection, restart, and partial failure without simulated state.

## Phase 8 — Full Linux desktop and computer mobility

**Status:** Desktop performance engineering requested alongside portable-release
closure. Projects/tasks and a replacement workspace are not prerequisites;
desktop launch remains gated on its own lifecycle and security acceptance.

- Add a general graphical Linux desktop.
- Compare existing noVNC, Selkies and Sunshine/Moonlight using measured
  input-to-photon latency, not FPS or ping alone (`UC-DESKTOP-01` in the addendum).
- Add Omarchy as a separately tested image/profile; do not treat its upstream
  server-edition plan as a shipped installer or overwrite existing hosts.
- Separate agent automation control from human takeover.
- Add snapshot, clone, and move where provider capabilities permit.
- Verify selected-computer isolation across all surfaces.

**Exit:** A user can safely operate the environment as a remote Linux computer as well as an agent runtime.

## Phase 9 — Additional operating systems

**Status:** Pending Phase 8

- Add Windows after Linux lifecycle, access, update, and recovery contracts mature.
- Add macOS only on legitimate Apple hardware with a compliant operational design.

## Deferred until evidence supports them

- Predictive percentage completion.
- Mandatory projects.
- Multi-agent delegation before durable single-agent execution.
- A separate closed hosted core.
- Replacing the original agent screens with a universal workspace before portable provisioning passes acceptance.
- Full desktop before portable agent access surfaces are reliable.
- Enterprise procurement and compliance suites.
- New pricing, token, marketplace, or growth mechanics that distract from the reference path.

### Optional token presentation and access integration

The public website leads with Agent Computers. Ecosystem maps the litepaper’s Available now, Next, Then and Research products; Token explains the existing $HermesOS contract and current access separately from proposed $HIVRA migration, utility and treasury rules. Billing leads with plans and card payment, with token controls disclosed intentionally and existing balances retained. This is presentation and integration of existing gated flows only. It does not ship new token mechanics, open a migration, enable crypto billing, or change payment settlement. Deployment and live acceptance are recorded separately.
