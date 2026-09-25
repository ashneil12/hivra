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

## After launch

Updated 2026-09-25. What comes after launch, in order; each item says what it
needs. This list changes none of the phase gates below.

**Where things stand.** On Canary, not yet on hivra.cloud: Launch is the only
way in, and every catalog agent launches from it; Hetzner guided setup;
connecting a server you already have with one command (its main path passed
live); DigitalOcean Managed Agents (not yet tested against the live DigitalOcean
API); the Computer Contract; agent work that survives refreshes, closed tabs and
restarts; the plan's agent limit enforced by the database for Hivra Cloud
launches; and adding Codex to an Ubuntu Desktop you already have (Canary only;
the first live add, Change access and Remove passed). None of this reaches
hivra.cloud until the owner approves a production promotion; adding Codex to an
existing computer stays Canary-only even then (see Next, item 5).

**Next**

1. **Home and office machines through Hivra's relay.** A machine with no open
   inbound port keeps one outbound connection to the approved Cloudflare relay;
   SSH stays end to end. The relay and connector are built (#87, #95). Needs:
   the relay deployed for Canary, the connection transport, `--outbound` in the
   one-command setup, the "At home" path in Connect, and a no-inbound-port test.
2. **Sign in with DigitalOcean, and a real DigitalOcean team test.** Needs: a
   DigitalOcean OAuth app, confirmation that its sign-in can grant Managed
   Agents access, and a team in DigitalOcean's Managed Agents preview.
3. **Hivra desktop app for Mac, Windows and Linux.** The current Mac alpha stays
   until the new app matches it. Needs: engineering, code signing for each
   platform, and the separate release approval Slice 7 requires.
4. **Better testing.** First, in progress: Dashboard checks on every merge into
   `canary`, a check that every test file runs somewhere, and size limits for
   what Hivra sends to a computer. Then fixtures for computers made by older
   releases, browser journeys on Canary, and a nightly check on real Canary
   computers. Needs: engineering, and the owner for required-check settings and
   a nightly test account.
5. **More agents on computers you already have:** other agents and computers,
   in-place updates, then hivra.cloud. Needs: engineering, real-computer tests.
6. **Launch follow-ups:** several Hetzner servers per account, updating older
   computers, finishing a Start when no page is open. Needs: engineering.

**After the announcement**

- **Hivra Orchestrator:** one chat to talk to all your agents, switch between
  them, see who is working or stuck, and pass work between them, over the same
  agents and computers (Phases 6 and 7). Needs: design, then engineering.
- Adding an agent you already have to another computer, or letting an added
  agent use the desktop or browser. Needs: an owner decision and a threat model.
- Windows and Omarchy out of private preview; macOS computers; custom images.
- Complete self-hosting (Phase 4).

**Not planned:** replacing an agent's own interface with a Hivra chat. Hermes,
Agent Zero and other agents with their own interface keep it as the main one.

## Approved web/Canary execution order

The reset slices are the active implementation order. The numbered phases below
remain foundation and acceptance tracks; their requirements do not become
current merely because related implementation is pulled forward.

| Reset slice | Relationship to the existing phase gates |
| --- | --- |
| Slice 0 — Product truth | **Complete 2026-09-04:** all canonical documents record the approval, crosswalk, unchanged portable gate, and authority scope. This does not close the separate Phase 0 public-release exit. |
| Slice 1 — Launch contract and shell | Pulls forward Phase 2 contracts behind a gated web shell while Phase 1 portable closure continues. **Status (Canary):** Launch is the only way in (#104), with one Choose screen and resume (#97), and every catalog agent launches from it (#100). This does not close `UC-PORTABLE-AGENT-01`. |
| Slice 2 — Hivra Cloud golden paths | Runs one managed Agent alongside Phases 1/3 and Ubuntu Computer alongside Phase 8; neither substitutes for portable acceptance. **Status (Canary):** Codex and Ubuntu Desktop run on Hivra Cloud, and agent work keeps running across refreshes, closed tabs and restarts (#98, #124, #136). This does not close `UC-PORTABLE-AGENT-01`. |
| Slice 2B — Attach Agent | Adds explicit binding between runtime consolidation and full Computer use. **Status (Canary only):** add Codex to an Ubuntu Desktop you already have on Hivra Cloud or My server (#134, with fixes #138, #140, #143, #144); the first live add, Change access and Remove passed on 2026-09-25. Off on hivra.cloud. See [Slice 2B status](#slice-2b-status). |
| Slice 3 — Customer-owned capacity | Carries the Phase 1/3 reference path and `UC-PORTABLE-AGENT-01` unchanged. **Status (Canary):** Hetzner guided setup (#96, #99, #108); connect a server you already have with one command (#127, main path passed live on 2026-09-24); DigitalOcean as a Launch destination (#105, not yet tested against the live DigitalOcean API); the home-machine relay is built but not deployed or wired in (#87, #95). This does not close `UC-PORTABLE-AGENT-01`. |
| Slices 4A-4C — Recovery and linking | Split Phase 4 into self-host control-plane recovery, Computer data portability, and separately threat-modelled optional Cloud linking. |
| Slice 5 — Linux Computer | Carries Phase 8 desktop performance acceptance. **Status:** Ubuntu Desktop is available in the catalog, and a fix that lets Ubuntu Desktops made by older releases Start again is merged to Canary (#148); Omarchy is in private preview as a prepared Canary computer. Measured desktop performance acceptance is still open. |
| Slice 6 — Windows guest | Carries the Windows-guest part of Phase 9. **Status:** Windows is in private preview: it runs on the owner's own Proxmox host, from their own licensed Windows ISO. |
| Slice 7 — Native clients | Later separately authorized release track; excluded from current execution scope. |
| Slice 8 — Orchestration | Carries Phase 7 after real single-agent execution, authority, recovery, and bounded stops; Phase 6 workspace is not a prerequisite. |

### Slice 2B status

**Updated 2026-09-25.** Adding Codex to an Ubuntu Desktop the owner already has
is merged and on Canary (#134, with fixes #138, #140, #143 and #144). It is on
only on Canary: the switch reads the deployment's own channel, so hivra.cloud
keeps it off with no setting to change. The first pair is Codex on an existing
Ubuntu Desktop on Proxmox KVM (Hivra Cloud or My server); every other computer
says it is not available yet. What is built, and where it differs from the
design, is section 0.1 of
[the agent computer contract and attach spec](docs/superpowers/specs/2026-09-24-agent-computer-contract-and-attach.md#01-slice-15-attach-implementation-status).
In short:

- **What exists.** Add an agent, progress from receipts, Change access and
  Remove on the computer's Manage page; a Chat tab once Codex is ready; the
  Computer Contract delivered to the added agent and read back; the routes
  (`POST /api/hivra/computers/[id]/agents`, `PATCH` and `DELETE`
  `…/agents/[attachmentId]`); the minute worker
  (`/api/cron/progress-agent-attachments`); the completion, failure,
  change-access, detach and computer-delete transitions; and `EXECUTE` for the
  service role only on the functions they call. The first release grants
  `~/Hivra`, the agent's own user and internet access, nothing more.
- **Live evidence.** On Canary on 2026-09-25, adding Codex reached Chat ready in
  61 s, Change access (stop sharing `~/Hivra`) delivered contract revision 2,
  and Remove finished with `~/Hivra` kept. That first run found two defects the
  unit tests missed, both fixed (#143, #144).
- **What is missing.** Signing in to ChatGPT inside the added agent's Chat
  (AC-A2, which needs an approved test account) and the spec's other Canary
  checks; the "One of my computers" choice in Where it runs; added agents in the
  ⌘K palette; an in-place update for an added Codex (today: Remove, then add
  again); a time limit for steps that stay held; other agents and computer
  types; and production. Adding an existing agent to another computer, and
  desktop, browser or sudo access for an added agent, wait on an owner decision
  and their own threat model.
- **The relationships route.** `GET /api/hivra/computers/[id]/relationships`
  is live for a signed-in owner on Hivra hosts and no screen calls it yet.
  **Decision:** keep it as it is. It only reads: it answers for the signed-in
  owner's own computer (404 for any other), is rate-limited and uncached, and
  changes no state. Its planned consumer is the Slice 2B computer page
  ("Agents on this computer"), which the spec builds on the same reader.
  Revisit it if Slice 2B changes the relationship snapshot, or drop it if
  Slice 2B is withdrawn. **Update 2026-09-25:** the shipped Slice 2B page reads
  `GET /api/hivra/computers/[id]/agents`, not this route, so this route still
  has no caller.

The working agent catalogue, launch path, detail screens, and native surfaces
remain available until migration, parity, rollback, and acceptance gates pass.
A new shell, managed path, Ubuntu path, mock, or contract test cannot close the
portable reference or public-release gates.

**Open discrepancy (noted 2026-09-25):** #104, merged to Canary on 2026-09-24
and not yet in `main`, retired the original Welcome launcher and made Launch
the only way in before these gates passed. This paragraph, the Phase 1 item
"Keep the existing agent catalog, launch flow…" below,
[VISION.md](VISION.md) and
[the product architecture](docs/PRODUCT-ARCHITECTURE.md) still say the original
launch path stays until then. The owner has not yet decided whether this is
documentation drift (change the text) or a code change to undo (restore the
original launcher). Until that decision, none of these passages is changed.

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

The prior HermesOS marketing and maintenance backlog is kept in the private archive of the older repositories; it is not in this repository's history, which starts at the 2026-09-21 source release. Items from it must be re-triaged against this roadmap before implementation.

## Phase 0 — Canonical truth and public-release safety

**Status:** Complete for the initial source export, published on 2026-09-21
(see [verification status](docs/release/VERIFICATION-STATUS.md)). Each later
source candidate is reviewed at its exact revision, and a separately built
runtime, image, desktop bundle or mirror is its own release gate.

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

**Live checkpoints (2026-08-26 to 2026-08-29):** on 2026-08-28 the original UI
ran a real Hetzner create, Codex install, model work, restart and full teardown.
None closes Phase 1. Each dated entry, bound to its own revision, is in
[verification status](docs/release/VERIFICATION-STATUS.md#phase-1-checkpoints-august-2026).

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
  **Current:** on Canary, `/dashboard` opens the workspace view behind the server
  flag `HIVRA_WORKSPACE_SHELL_ENABLED`, and `/dashboard/workspace` forwards
  there; production still opens the Hermes command center at `/dashboard`.

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
- Follow the [2026-08-31 integration and remote-computers addendum](docs/superpowers/specs/2026-08-31-hivra-remote-computers.md): Buzz now has a real signed cross-agent runtime/reply campaign; DeepSeek Harness has real native UI, model, PTY, restart, revocation and cleanup evidence but remains gated on ACP; Omarchy belongs to computer profiles and now passes exact KVM install, desktop reboot, Sunshine guest preparation and teardown; it is in private preview as a prepared Canary computer, and its native Moonlight access remains gated on a scoped native route and real Moonlight interaction.
- Stop legacy writes after parity and rollback gates pass.
- Retire overlapping Workspace Cloud and legacy agent lanes.

**Exit:** Multiple runtimes pass shared contracts and retain working native surfaces.

## Phase 6 — Optional unified workspace

**Status:** Pending Phase 5 and real evidence that it improves the original agent experience.
On Canary the workspace is already the `/dashboard` home behind a server flag;
production is unchanged. That Canary setting does not pass this phase's exit.

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

**Status:** Ubuntu Desktop is available in the catalog, and Omarchy is in
private preview as a prepared Canary computer. Measured desktop performance
acceptance (`UC-DESKTOP-01`) is still open. Projects/tasks and a replacement
workspace are not prerequisites; each desktop profile remains gated on its own
lifecycle and security acceptance.

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

**Status:** Windows is in private preview: it runs on the owner's own Proxmox
host, from their own licensed Windows ISO, while ordinary provisioning waits for
a licensed image pipeline and the full remote-desktop lifecycle. macOS
computers are not in the catalog. The rest of this phase is pending Phase 8.

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
