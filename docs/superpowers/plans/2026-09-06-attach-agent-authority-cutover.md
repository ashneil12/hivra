# Attach-agent implementation sequence

Status: partial database groundwork for approved core-experience Slice 2B.
The additive binding/provenance checks and staged database-owner-only metadata
authority transfer below are implemented locally. Application cutover, the
attach API, installer integration, and live acceptance remain unimplemented.
The pinned private Codex stager and its guest journal are source-only components,
not an enabled attachment workflow.

Baseline: `d30e4259f`, inspected 2026-09-06. Governing documents are `VISION.md`,
`docs/PRODUCT-ARCHITECTURE.md`, the 2026-08-24 agent-computers design, and the
2026-09-04 core-experience reset plan. This document refines their implementation
sequence; it does not replace their acceptance gates or grant new authority.

## Finding

Attaching a managed agent to an existing Computer is unimplemented target
behavior, not merely a missing button. Three existing boundaries prevent safely
implementing it as a second call to Launch Agent:

1. `dashboard/supabase/migrations/20260904100000_hivra_canonical_resource_shadow.sql`
   fixes `write_authority` to `legacy`. Its source mappings require a Computer
   to have no identity, installation, or primary-binding IDs. Projection rejects
   a source resource-kind change. The inventory read-mode switch does not
   transfer write authority.
2. `dashboard/src/lib/agent-computers/canonical-shadow.ts` deliberately enforces
   those same compatibility invariants. It is not the authoritative future
   attachment model. Relaxing only its schema would not change the database or
   prevent later source events from overwriting new relationships.
3. `dashboard/provisioner/provision-claude-code-box.sh` prepares a fresh machine:
   it writes agent persona files, and its Linux Desktop branch removes coding
   CLIs, persona files, `.codex`, `.claude`, and `.agents`. Running that installer
   against an existing user's desktop is not a data-preserving attach operation.

No existing computer should be converted by rewriting its legacy `type` or
`computer_profile`. Do not create another computer record, tunnel, VM, billing
allocation, or lifecycle lane to represent the attached agent.

## A. Establish per-entity write authority first

Implement additive migrations after the existing shadow migration; never edit
the deployed migration in place. Preserve canonical IDs and legacy aliases.

- Define versioned authority and generation for each affected entity, including
  computer lifecycle, identity, installation, and binding. Keep legacy lifecycle
  authoritative until its own cutover gate passes. Relationship authority must
  not implicitly authorize a provider operation.
- Separate immutable source provenance from mutable current relationships.
  Existing source mappings continue identifying their original legacy resource;
  current bindings are queried independently, not derived from the legacy
  resource kind or forced back into its original relationship slots.
- Update projection, parity, and read adapters together. A legacy status event
  may update its authorized lifecycle fields but must not erase, resurrect, or
  claim an independently authoritative relationship.
- Reject stale-generation and duplicate-authority writes transactionally.
  Preserve owner-composite foreign keys. Enforce one active primary binding per
  computer and one active computer binding per identity for v1; selecting an
  already-bound identity requires the separately designed migration flow.
- Couple accepted commands and their outbox records in one transaction. Workers
  claim exact operation/generation IDs, recheck authority before dispatch, and
  record observed results separately from desired state. A timeout is unknown
  outcome requiring reconciliation, not permission to install again.
- Share a per-computer execution fence with the existing lifecycle path. Attach
  and legacy restart, restore, and delete must acquire the same durable lease
  and generation at the database/dispatch boundary, including retained older
  callers; a new attachment route's preflight check alone cannot enforce this.
  Dispatch and completion both validate that fence. Define cancellation handoff
  and observed process release before another operation can take over. A lost
  acknowledgement or expired worker lease does not prove the guest stopped
  executing; reconcile that operation before allowing conflicting guest writes.
- Fail closed when an older application encounters an unsupported authority
  generation. Before accepting canonical-only writes, rollback may restore the
  old read path. Afterwards, rollback must retain a compatible relationship
  reader/writer or perform a verified reverse migration; changing the inventory
  flag alone is not rollback.

Acceptance: a local real PostgreSQL fixture for representative Hermes, Hivra
agent, and Ubuntu rows proves stable IDs, owner boundaries, replay ordering,
concurrent writers, deletion/recovery semantics, parity, and both rollback
boundaries. Include attach racing restart/restore/delete, cancellation, lease
expiry, lost acknowledgements, and stale completion after a new generation.
SQL string tests alone cannot close `UC-DOMAIN-MIGRATION-01`.
Run the same migration path in the self-host harness. Review independently
before any Canary migration; do not toggle existing live resource authority as
part of exploration.

Groundwork checkpoint for A (2026-09-06): additive migration
`20260906150000_hivra_canonical_binding_provenance.sql` enforces one active
computer per identity and immutable original source mapping fields, while
allowing the projection cursor to advance monotonically. It grants no new write
authority and has **not been applied to Canary**. The actual shadow and additive
SQL run in `dashboard/scripts/test-hivra-canonical-provenance.cjs` using isolated
PGlite PostgreSQL. The duplicate-binding regression failed before the addition.
The passing fixture covers representative Hermes, Hivra agent, and Ubuntu
projection, stable identifiers, cross-owner denial, old-event replay, immutable
provenance, tombstone retention, detached history, legacy/shadow read switching,
and service-role write denial. It also checks rejection of a migration over
pre-existing duplicate active bindings without deleting rows, and rejection of
detached-history reactivation that conflicts with an active identity. A standard
Jest wrapper runs this SQL fixture alongside the existing canonical contracts:
3 suites / 19 tests pass; wrapper lint and diff checks pass. Independent scoped
review found no blocking defect. This is not concurrent-worker, authority-cutover, full self-host migration,
or runtime attachment acceptance; all remaining A gates above remain open.

Read-gate correction (2026-09-06): real SQL testing then exposed a current
implementation defect, not missing attachment behavior. The original parity
function counted canonical rows but only compared rows reached through source
mappings, so an unmapped canonical Computer still yielded `ready: true`.
`20260906160000_hivra_canonical_parity_coverage.sql` retains all existing
projection/tombstone checks and adds explicit unmapped Computer, identity,
installation, and binding counts. Any nonzero count blocks the legacy shadow
read switch without deleting data. All four cases, presentation rollback with
truthful `ready: false`, and the preserved service/authenticated RPC privileges
are covered by the real SQL fixture; 3 suites / 19 tests pass. This migration
received independent scoped review with no blocking finding and a separate
passing SQL execution. It is local/source-only, not applied to Canary. When canonical-only attachments
are implemented, their authority-aware reader and parity rules must be changed
together; do not remove this check merely to admit invisible relationships.

Metadata-authority checkpoint (2026-09-06):
`20260906170000_hivra_canonical_relationship_authority.sql` adds separate entity
authority epochs and a per-computer relationship controller. Computer lifecycle
remains legacy-only. A staged, database-owner-only transfer checks exact owner,
source event/payload, idle running lifecycle, and expected generation. It stores
one command and an audit outbox event atomically, with exact replay and
owner/computer/generation foreign keys. This event is **not an installer job**.
The legacy projector no longer overwrites canonical relationship rows. Parity
checks the owning epochs and reports unsupported authority instead of enabling
the old reader; the scalar control marker truthfully becomes `mixed`.

No browser or service-role execution grant exists for the transfer RPC. It is
not an attachment API or permission to perform guest work. A preselected shadow
reader blocks transfer under the same administrative lock as read-mode changes.
Actual PGlite SQL tests cover Hermes, Hivra-agent and bare-Ubuntu metadata,
replay, stale epoch/source, busy lifecycle, outbox-failure rollback, owner-bound
commands and preservation across legacy rename/stop/delete. The standard
focused run passes 4 suites / 21 tests. Separate isolated PostgreSQL sessions
prove observed lock contention for read-switch-first, transfer-first with exact
replay, and a competing legacy update producing a stale transfer. This does not
prove the full production legacy schema, self-host migration path, or guest
operation fence. The local container was removed; Canary was not migrated.
See `docs/release/2026-09-06-canonical-relationship-authority.md` for exact scope.

Independent reader checkpoint (2026-09-06): staged migration
`20260906180000_hivra_canonical_relationship_reader.sql` reads owner-scoped
relationships independently of immutable launch mapping slots, in one SQL
snapshot. Its strict TypeScript contract preserves bigint precision, detached
history and observed installation states. The server-side reader distinguishes
an actual missing computer from database errors or malformed responses. Actual
PGlite output is parsed by the TypeScript tests, including a bare computer with
later relationships, owner isolation and service-only SQL execution. Five
focused tests, lint and TypeScript checking pass. This is a read layer only:
no route, inventory cutover, live migration, attachment or runtime acceptance.
See `docs/release/2026-09-06-canonical-relationship-reader.md`.

Authenticated reader routing checkpoint (2026-09-06):
`GET /api/hivra/computers/[id]/relationships` now wraps that reader using the
server-authenticated owner, a canonical UUID, the existing Hivra surface gate,
an authenticated rate limit and no-store responses. It never takes an owner
from request input, mutates relationships or acquires a guest operation. Missing
or foreign computers return 404; unavailable storage returns a sanitized 503.
Five route tests plus the five SQL/reader tests pass, as do lint and full
TypeScript checking. This source-only endpoint has no UI consumer or live
acceptance and does not bypass the outstanding migration/cutover gates.

Attachment admission checkpoint (2026-09-06): staged migration
`20260906190000_hivra_attachment_lease.sql` reserves the existing
`hivra_agents.operation_id` slot as `agent_attach` and atomically records exact
owner, computer, relationship generation, guest identity and installer intent
with an outbox event. Only exact command/intent replay is accepted. Initial
admission supports a new Codex identity on a bare Ubuntu Proxmox Computer;
neither an identity nor an installed runtime is created by the reservation.
The update guard prevents older generic release/recovery callers from clearing
it; delete intent remains pending and undispatched cancellation preserves it.
Actual legacy lifecycle and canonical SQL tests cover these boundaries, event
failure rollback and existing desktop-preparation admission. The projection
now retains unknown-but-occupied newer operation kinds
instead of failing the canonical row constraint. Generic recovery cannot refresh
the reserved timestamp. Admission and
cancellation remain database-owner-only; no dispatch or terminal-result RPC,
installer, expiry takeover, migration or live acceptance is supplied here.
See `docs/release/2026-09-06-attachment-lease-admission.md` for fixture limits.

Private dispatch checkpoint (2026-09-06): additive migration
`20260906200000_hivra_attachment_dispatch.sql` admits the exact staged command
to `dispatched` once, with a unique dispatch ID and atomic audit record. It
rechecks owner, relationship generation, original guest identity, installer
digest, current projection and infrastructure readiness under the source lock.
Both claimed and dispatched reservations retain the shared lifecycle guard and
uniqueness constraints. Cancellation and pending deletion block dispatch; once
dispatched, cancellation and generic timeout recovery cannot release the slot.
Repeated dispatch returns false, including after a hypothetical lost response.
The actual SQL fixture covers these transitions and audit-write rollback. This
is database transition evidence, not proof that a guest worker executed once.
There are still no application-role grants, installer or terminal-release RPC.
See `docs/release/2026-09-06-attachment-dispatch.md`.

Next: terminal/reconciliation handling for the shared guest
lease, followed by the non-destructive adapter. Do not expose transfer or
attachment before their remaining gates pass. No reverse-authority migration
or canonical-only-write rollback is implemented by this checkpoint.

## B. Implement a non-destructive runtime attachment adapter

Staging checkpoint (2026-09-06): `dashboard/provisioner/stage-attached-codex.py`
installs verified standalone Codex 0.149.1 bytes into a unique root-owned path
with a new unprivileged account/private home. It does not reuse the fresh-machine
bux installer, change existing CLI/configuration, install global packages,
activate a service, authenticate or call a model. An owned network-isolated
local Linux amd64 container ran the actual pinned binary as that account and
passed preservation, collision, restrictive-umask and actual-home-denial checks.
Only a staged receipt is emitted; partial failure remains for reconciliation.
ARM64 artifact identity is pinned but execution is unverified. Guest-worker
integration, service/access setup, terminal receipts, detach and live acceptance
remain open. See `docs/release/2026-09-06-attached-codex-staging.md`.

Staging-result boundary (2026-09-06): the TypeScript receipt parser now requires
the expected operation, distinct installation field and architecture, exact
private account/paths, non-root numeric IDs, pinned runtime/version, archive and
executable hashes. It accepts only `staged`, never `ready`, and is bounded and
strict about unknown fields. Twenty synthetic protocol tests plus a stager
source-hash drift check pass. This is not authenticated guest observation or
permission to release a lease. The reservation checkpoint below supplies
explicit installation and binding IDs before dispatch; do not infer those IDs
from an agent identity or accept a receipt-selected ID. See
`docs/release/2026-09-06-attachment-staging-receipt.md`.

Installation-ID checkpoint (2026-09-06): staged migration
`20260906210000_hivra_attachment_installation_reservation.sql` records unique
installation/binding UUIDs, architecture and the reviewed stager hash against
the exact owned command/generation. Exact replay returns the saved reservation;
different IDs or architecture cannot replace it. A dispatch-transition guard
rejects commands without that reservation. Existing historical runtime IDs and
IDs reserved by another command cannot be reused. These records are not runtime
installations or active bindings. The private command has no application grants.
Actual SQL and receipt tests pass (3 suites/23 tests); no live migration or guest
work occurred. See `docs/release/2026-09-06-attachment-installation-reservation.md`.

Start with one pinned Linux runtime on a disposable Ubuntu Computer; other
runtimes remain unavailable until their adapters pass. Do not claim Windows or
Omarchy attachment from the Linux result.

- Use a distinct installation ID, private installation root, dedicated service
  identity, and an exact owned-file manifest. Never replace existing user
  configuration, shell startup files, global packages, or manually installed
  runtime directories. Reject path/symlink/ownership collisions before writing.
- Admit the exact computer, owner, capability generation, OS/runtime revision,
  and requested authority before dispatch. Separate installation readiness from
  binding activation and model authentication; installation is not useful-work
  acceptance and must not create an undisclosed model charge.
- Specify actual files, command execution, browser, network, and credential
  access. Do not advertise narrower access than the OS identity and runtime
  really enforce. Grants contain references, not reusable credentials.
- Persist operation progress and an audit receipt. On partial failure, revoke
  dispatch credentials and stop only the owned service. Preserve user files and
  expose recovery of the exact operation rather than a blind reinstallation.
- Detach revokes new work and access, terminates owned processes/sessions, and
  waits for observed release before permitting another primary binding.
  Uninstallation and deletion of agent-owned data are separate explicit actions;
  neither deletes the computer or unrelated user bytes. Manual software is not
  labeled a managed binding and is never removed by this workflow.
- Specify reboot, snapshot restore, export/import, and recovery behavior before
  enabling attachment: old grants must not revive, detached agents must not
  restart, and preserved identities must not acquire a second active computer.

## C. Expose owner review and real progress

Guest staging fence checkpoint (2026-09-06):
`dashboard/provisioner/run-attached-codex-stage.py` verifies the exact pinned
stager bytes, publishes a root-private durable `started` journal before spawning
the fixed isolated Python interpreter, and passes its guest lock to that child.
The journal binds computer, source, operation, dispatch, installation, binding,
architecture and boot identity. An exact same-boot staged replay returns the
recorded result without execution. Uncertain, malformed, conflicting or old-boot
records refuse redispatch. There is deliberately no reset/expiry/unlock path.
Eight isolated Linux tests include a real pinned Codex installation and replay;
this is not an actual SSH-disconnect, VM-reboot or browser acceptance result.
The host worker, database completion, service/access lifecycle, reconciliation,
detach, and UI remain to be connected and verified before enabling attachment.
See `docs/release/2026-09-06-attachment-guest-staging-fence.md` for exact evidence.

Guest result contract checkpoint (2026-09-06):
`attachment-guest-result.ts` validates the worker envelope against independently
supplied dispatch identity and boot ID, then validates its nested staged receipt.
The exact worker bytes and artifact pins have drift checks. Two focused suites
pass 41 synthetic contract tests. This does not add a host caller or authorize
database lease release; persist the pre-dispatch boot observation and integrate
the exact bound worker before accepting this result in the attachment workflow.
See `docs/release/2026-09-06-attachment-guest-result-contract.md`.

Pre-dispatch boot checkpoint (2026-09-06): migration `20260906220000` now reserves
the independently observed boot and reviewed worker digest, rejects stale/future
observations at dispatch, and never refreshes or replaces an existing observation.
The guest worker requires that expected boot before any staging mutation. The
SQL/contract suites pass 22 tests; the real Linux worker suite passes 9 tests.
No application grants, host integration or database release were added. All
attachment migrations remain unapplied to Canary. See
`docs/release/2026-09-06-attachment-boot-observation.md` for scope and limits.

Staging result recording checkpoint (2026-09-06): migration `20260906230000`
records the exact dispatch/boot/installation-bound staging envelope through a
private RPC. SQL validates nested runtime pins, account IDs and owned paths;
exact replay does not overwrite evidence. Pending deletion can retain evidence
without activation or lifecycle release. Three SQL/contract suites pass 42 tests.
No canonical relationship or ready state is created. The bound host executor,
service/access lifecycle and UI remain to be integrated. See
`docs/release/2026-09-06-attachment-staging-result-recording.md`.

Host boot observer checkpoint (2026-09-06): the internal server observer now
resolves the existing owned host context and builds a read-only boot probe under
the shared allocation lock and VMID QGA transport. It checks owner/source/lease,
running Ubuntu profile, enforced binding, exact host tag/IP, and strict result
correspondence. No application caller, SQL mutation or guest installer is
enabled. Host runner tests are mocked and do not prove live QGA execution. See
`docs/release/2026-09-06-attachment-host-boot-observer.md`.

Artifact acquisition checkpoint (2026-09-06): the pinned guest fetcher obtains
the fixed release over verified HTTPS into a private no-overwrite cache, with
size/hash/deadline/boot checks and final pathname identity validation. Real
download-to-durable-staging passed in an owned Linux container; 8 Linux cases
and 42 parser/pin tests pass. No live host/UI integration or activation is
enabled. See `docs/release/2026-09-06-attachment-artifact-fetch.md` for evidence,
the review-found namespace regression and remaining limits.

Transport bundle checkpoint (2026-09-06): a server-side loader now packages only
the exact pinned runner/fetcher/worker/stager, with a 65 KiB packet cap. The guest
runner verifies all assets before loading code and separates fetch from stage;
stage never downloads and cleans up only its owned temporary stager. Six real
Linux cases and 46 TypeScript checks pass. No host action/UI caller is enabled;
read-only lost-result reconciliation must precede exposing a resumed flow. See
`docs/release/2026-09-06-attachment-transport-bundle.md`.

Read-only reconciliation checkpoint (2026-09-06): the bundle's internal observe
action recovers only an exact same-boot staged receipt under the existing shared
journal lock. Missing, busy, changed or incomplete state cannot create files,
reinstall or release a lease. Seven Linux cases (including real staging followed
by read-only receipt recovery) and 47 TypeScript tests pass. Host/DB/UI wiring
remains open. See `docs/release/2026-09-06-attachment-readonly-reconciliation.md`.

Host action transport checkpoint (2026-09-06): internal builder/executor binds
the three pinned actions to an owned held operation and enforced VMID/tag/IP
under the shared allocation lock, with separate deadlines and strict fetch or
staged-result decoding. Fifty-four focused tests and the exact Linux host-lock
fixture pass. No route/DB caller is enabled; the durable worker must obtain the
one-time dispatch CAS before stage and use observe on uncertainty. See
`docs/release/2026-09-06-attachment-host-action-transport.md`.

Staging coordinator checkpoint (2026-09-06): a consistent owner-bound SQL read
and strict store/parser now feed a one-pass internal coordinator. Only a literal
true dispatch CAS in that pass permits stage; already dispatched work uses
observe only, and ambiguous prerequisites/results stay held. Actual SQL fixture
outputs feed the TypeScript parser. No worker/route registration or mutation
permission activation is included. See
`docs/release/2026-09-06-attachment-staging-coordinator.md` for checks and limits.

Native-service checkpoint (2026-09-06): the pinned Codex app-server initialized
and reconnected over WebSocket-over-Unix as the private account in an owned
network-disabled Linux fixture, with mode-0600 socket and empty account process
inventory after stop. A strict service-definition builder now specifies the
private account/home/socket and supervision policy, including creating an absent
CODEX_HOME before startup. No unit is installed or enabled; systemd execution,
activation authority, access routing and detach remain open. See
`docs/release/2026-09-06-attached-codex-native-service.md` for failed-probe context
and precise acceptance limits.

Real-systemd checkpoint (2026-09-06): a newly launched owned Ubuntu Canary
computer ran the exact generated unit through two start/stop cycles, each with
two native Unix WebSocket initializations. Private account/socket checks,
process/runtime-directory release and scoped desktop configuration/marker
preservation passed. The public terminal and desktop reconnect still worked;
normal UI Destroy removed the fixture, disks, hostname and session access.
This operator-only test does not activate attachment authority or expose a
product route. See `docs/release/2026-09-06-attached-codex-systemd-canary.md`.

Activation-dispatch checkpoint (2026-09-06): a private SQL gate now records one
service-start authorization and its audit event after exact staged-result and
current authority checks. Pending delete, replay and competing canonical runtime
state are refused without releasing the shared lease. A strict internal adapter
binds the generated service digest and accepts only literal confirmations.
Actual SQL output feeds its TypeScript tests. No guest activation, app caller,
mutation privilege or live migration is enabled. See
`docs/release/2026-09-06-attachment-activation-dispatch.md` for evidence and limits.

Guest-preflight checkpoint (2026-09-06): a read-only pinned-verifier preflight
now checks the saved staging journal, current boot, real account/private paths,
installed receipt and complete binary hash. Its independent service rendering
matches the server byte-for-byte. Nine owned Linux fixture tests passed after
review-found stale-evidence and service-user traversal fixes; no
service is installed/started, no lease released and no host caller enabled.
The durable activation journal, systemd execution and observed readiness remain
next. See `docs/release/2026-09-06-attachment-activation-preflight.md`.

Guest-starter checkpoint (2026-09-06): the one-time starter now holds a private
activation journal, validates original namespace/lock/journal ownership, checks
actual loaded commands/security policy and records intent before one service
start. Thirteen Linux tests passed with real staging/preflight and simulated
systemd after independent review corrections. It has no DB/host caller and
does not report native readiness or release a lease. An owned fresh Ubuntu
campaign passed actual systemd start, two native initialize connections, replay
refusal, private-process shutdown, preserved desktop/marker, public Box Terminal
and normal-UI destroy with verified cleanup. This was an operator fixture, not
the future DB/host attachment caller. See
`docs/release/2026-09-06-attachment-service-starter.md` for evidence and limits.

Activation-observer checkpoint (2026-09-06): a pinned read-only observer can
inspect an existing attempt under its shared journal lock without redispatch.
It reports process-running, inactive or unresolved observations, never readiness
or release. Ten Linux tests passed with real staging/preflight and simulated
systemd; a bounded pure packet builder matches actual SQL records and guest
parsers. Eleven focused Jest tests, type/lint checks and independent reviews
passed. No host caller, mutation privilege, live deployment or new VM is enabled.
See `docs/release/2026-09-06-attachment-activation-observer.md`.

Activation-transport checkpoint (2026-09-06): an unregistered internal adapter
now binds the saved activation to owner/VM/tag/IP, the shared allocation lock,
fixed QGA execution and strict result parsing. Pending deletion can observe but
not start; ambiguity does not retry or release authority. Eleven focused tests,
type/lint checks and independent review passed with mocked host execution. No
dispatch privilege, caller registration or live QGA acceptance is claimed. See
`docs/release/2026-09-06-attachment-activation-host.md`.

Activation-coordinator checkpoint (2026-09-06): a one-pass internal coordinator
requires a fresh literal-true grant and re-read before start; saved/uncertain
attempts recover through observation only. A new private SQL gate appends exact
observations and audit events without publishing bindings or releasing authority.
The actual PostgreSQL fixture, 25 focused tests, type/lint checks and independent
review passed. The migration is unapplied and no caller or mutation privilege is
enabled. Sequential mocks do not prove concurrent-worker or live acceptance.
See `docs/release/2026-09-06-attachment-activation-coordinator.md`.

Native-protocol transport checkpoint (2026-09-07): a source-only fixed initialize
client now validates the WebSocket upgrade, strict response identity and expected
private Codex home with bounded framing/control traffic and one I/O deadline.
Eight focused simulated-connection tests pass. It is not wired into the guest
observer and does not report ready; socket/peer identity, activation continuity,
actual native compatibility and live acceptance remain open. See
`docs/release/2026-09-07-attachment-native-protocol-transport.md`.

Native-protocol Linux checkpoint (2026-09-07): the exact new transport now
initializes and reconnects to actual pinned Codex 0.149.1 in an owned offline
Linux container. The fixture checks the real private socket and peer process,
then verifies process/runtime cleanup. Initial fixture setup and orphan-reaping
failures were corrected and documented; a fresh container passed and both test
containers/volumes were removed. No live readiness observer or attachment flow
is enabled. See `docs/release/2026-09-07-attachment-native-protocol-linux.md`.

Bound-native-probe checkpoint (2026-09-07): a pinned guest probe checks the exact
private socket/process and initializes Codex while preserving native handles
through final activation validation. Review caught and corrected a stale-socket
window. Five local envelope tests, eight transport tests, twelve Linux observer
tests and eleven bundle/host tests pass, alongside real pinned-binary helper
checks and cleanup. The helper and observer were verified at separate boundaries;
full real-systemd packet/host/UI integration is not claimed. No live mutation or
new spending occurred. See `docs/release/2026-09-07-attachment-bound-native-probe.md`.

Native-host transport checkpoint (2026-09-07): exact pinned native payloads and
strict activation-bound protocol results now use the existing owner/VM/tag/IP,
host lock and QGA transport through an unregistered internal action. Twenty-four
focused tests, TypeScript/lint and generated shell checks pass; host execution
is mocked, not live QGA acceptance. No native-result persistence, application
grant, caller or ready binding is enabled. See
`docs/release/2026-09-07-attachment-native-host-transport.md`.

Native-persistence checkpoint (2026-09-07): an additive private RPC migration
preserves immutable native-protocol observations under the existing exact
source/authority/activation fence and atomic outbox. The observation-only
coordinator rereads before/after probing and never starts or releases. Actual
PostgreSQL regressions, 29 focused tests, type/lint checks and independent review
pass. The migration is unapplied, all mutation roles remain denied, and no
worker or product flow is registered. See
`docs/release/2026-09-07-attachment-native-observation-persistence.md`.

Staging-grant reread correction (2026-09-07): the existing source coordinator
could stage from its old claimed snapshot after receiving dispatch confirmation,
without observing a newly pending deletion. It now rereads and accepts only the
exact granted dispatch transition before the host stage call. Missing/changed
state stays held; recovery still observes instead of restaging. The new regression
failed before repair; 55 staging/activation/host tests, typecheck, lint and
independent review pass. Commit `532dd3421` is source-only, with no migration,
grant, worker registration, live execution or spending. This does not eliminate
the final read-to-host race or replace terminal/release integration. See
`docs/release/2026-09-07-staging-grant-reread.md`.

Only after A and B pass, add an owner-visible Attach Agent action to the existing
Computer Manage flow. Select/create an identity, select an accepted runtime,
review exact access and data effects, then confirm once with an idempotent
operation key. No provider purchase or VM replacement is part of this action.

Display observed installing, failed, release-pending, detached, and ready states.
Explain unresolved operations and preserve their IDs across refresh. The agent
appears in its normal inventory/native interface while the original computer,
desktop, files, and lifecycle remain intact. Browser progress is not a fabricated
percentage or a substitute for actual runtime readiness.

## Bounded final Canary acceptance

Use one newly created owned Ubuntu fixture, not a retained user computer. Place
known marker bytes and conflicting configuration fixtures before attachment.
Through the normal UI, attach and perform real runtime work with an authorized
authentication method; test a competing attachment and cross-owner denial.
Then detach/revoke, verify session/process release, reboot/recover, and verify
the original markers and working desktop. Exercise only owned data for
export/delete cases. Capture exact source, provisioner, migration, operation,
computer, and installation identities. Destroy only the disposable fixture and
verify guest, volume, credential, session, route, and allocation cleanup.

`UC-ATTACH-AGENT-01` stays open until those results exist. Canary deployment,
unit tests, an installation receipt, or a visible Attach button alone do not
close it. Existing Windows licensing, Omarchy routing, public release, and the
cumulative GBP 10 Hetzner spending boundary remain unchanged.

## Planning checkpoint verification

At baseline `d30e4259f`, the existing canonical-shadow projection and migration
contract suites passed together: 2 suites, 18 tests, using
`node node_modules/jest/bin/jest.js --runInBand --runTestsByPath src/lib/agent-computers/__tests__/canonical-shadow.test.ts src/__tests__/hivra-canonical-resource-shadow-migration.test.ts`
from `dashboard/`. These verify the current shadow contract, not the proposed
authority cutover. This checkpoint changes documentation only; no new runtime
behavior, migration, deployment, live fixture, or spending is included.
An independent source review identified the shared execution-fence requirement
above: preserving relationship rows alone cannot prevent a legacy lifecycle
worker from mutating the same guest during installation. That requirement is
part of the proposal, not an assertion that existing workers already enforce it.
