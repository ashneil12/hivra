# Reliable agent model-key delivery

Status: implementation in progress. Guest, transport, custody and the original
settings API/UI are source-verified and the exact Canary release is verified.
Custody migration `20260828080000` was applied without adopting or changing
existing rows. One disposable managed guest passed live save/readback, reboot
persistence, clear, a browser-terminal command and complete teardown. It required
an explicitly scoped guest asset update; shared host bundles remain unchanged.
Model-aware allocation now has a separately verified source/SQL checkpoint;
welcome-flow activation, actual inference and live interrupted-ack recovery
remain incomplete. See the
[API/UI checkpoint](../../release/VERIFICATION-STATUS.md) and
[guest capability evidence](../../release/VERIFICATION-STATUS.md).

Authority: the existing portable-agent/BYOK work. Preserve the original catalog,
native interfaces, existing computers and operator customization. No production
rollout, credential rotation or purchases are authorized by this document.

## Observed gap

At `723e7622dea1f1c3b069e4fe32be89323cde6241`, the model-settings endpoint saves
before the browser delivers the key to the guest. Clear revokes before saving;
Manage ignores a guest clear result of `ok:false`. The guest's legacy handler
also interprets malformed JSON as a clear, masks unlink failures, and writes
the active credential in place. Provider launch rejects automatic model-key
delivery. These are code defects and unimplemented target behavior, not a
reason to replace the multi-agent UI.

## Required end state

1. An owner submits one explicit setting change or clear. Inputs are validated
   before key creation, storage or delivery; no secret is returned to clients,
   logs, events or URLs. Native runtime login remains available.
2. A private durable operation binds the owner, agent, original computer
   allocation, runtime, request identity and encrypted pending credential.
   The previous active setting stays intact until the guest confirms application.
3. Control-plane delivery uses the original named HTTPS origin, per-computer
   authentication, connection-time SSRF checks, no redirects and bounded I/O.
   Browser-provided URLs, keys for another computer and ambient fleet credentials
   cannot select the recipient.
4. The guest applies to a private atomic, fsynced record. Its receipt binds the
   operation and actual payload with a MAC using the per-computer token. Expected
   prior-state checks reject stale writes; repeated identical operations return
   the original result without replacing settings again. Clear retains a receipt.
5. Lost replies remain pending, not failed/succeeded by inference. Reconciliation
   observes the existing receipt. An explicit resume reuses the same encrypted
   input and operation, never mints another key or purchases a computer.
6. Database settlement verifies that receipt and original ownership before
   replacing active metadata. Managed-key activation/revocation is transactional
   with settlement; interruption does not orphan a newly minted key or revoke
   the still-active predecessor. No cross-wallet fallback is added.
7. Concurrent changes, provisioning, power transitions and deletion have explicit
   fences. Deletion retains pending credential evidence until terminal cleanup,
   then revokes pending/current managed keys and wipes ciphertext.
8. Manage displays saved and pending state separately, handles guest
   rejection truthfully and offers explicit recovery. API-key values are never
   persisted in browser storage. Older guests without the required capability
   are identified honestly; no silent downgrade to best-effort delivery.

## Implementation sequence

- [x] Guest atomic application/receipt primitive and real filesystem regressions.
- [x] Integrate the primitive into authenticated guest routes, preserve native
  reads and legacy explicit actions, and version the provisioner bundle.
- [x] Private operation schema, exact-owner RPCs, pending key custody and
  lifecycle/deletion fences, exercised against actual PostgreSQL fixtures.
- [x] Server-only bounded transport and coordinator with interrupted-request,
  stale-target, duplicate-operation and settlement tests.
- [x] Original settings API/UI using the same operation path, with adopted-key
  wallet guidance and independent review/source/build checks.
- [x] Scoped additive Canary custody migration, preserving existing rows.
- [ ] Launch integration using the same operation path.
  - [x] Private pre-readiness reservation and promotion foundation, with
    local PostgreSQL/guest integration and independent race review.
  - [x] Apply the additive launch precursor schema after its live preservation gate.
  - [x] Wire original model-settings recovery controls and private admission helpers.
  - [x] Wire stable server launch IDs, owner-only lookup and actual capability/allocation admission.
  - [ ] Wire stable client request retention, welcome-form selection and post-launch continuation.
- [x] Canary API/UI release verification and real owned-guest save/readback,
  restart persistence, clear, terminal round trip and verified teardown.
- [ ] Live interrupted-acknowledgement recovery and real model inference.

The first guest adapter follows the existing declared Codex/Venice settings
capability. That is an implementation compatibility boundary, not a Codex-first
product strategy. Daemon runtimes need their actual config/reload acknowledgement;
do not claim support by writing a file they do not read. Provider-computer launch
must remain explicit about unsupported key delivery until its full path passes.

### Current integration boundary

The server-only `guest-llm-transport.ts` is implemented and locally reviewed,
and is now called through the owner-only settings coordinator/API. It reads the declared guest capability and
authentication gate before sending a bearer, uses the original named HTTPS
origin with connection-time DNS checks, and compares the exact canonical guest
receipt (including its authenticated state and payload). It sends at most one
POST; an uncertain reply remains unconfirmed. Reconciliation can recognize the
same applied operation without another write. Its parameters are not ownership
authority, and its payload URL schema is not an approved-provider registry.

The integrated coordinator/API preserves these constraints:

- Admit a private operation under the agent lock, using the current owner,
  runtime, allocation identity, named tunnel/hostname and per-computer token
  identity. Reject deleted, provisioning or conflicting lifecycle state. An
  old browser request cannot supply a different recipient or provider URL.
- Normalize and validate the complete model request before any key creation.
  Persist one request identity, the exact encrypted pending key, server-resolved
  provider URL/model, requested wallet, prior active metadata and expected guest
  state. Reconciliation must not rebuild the request from a changed environment
  or mint a different key. Retain operation-ID history after completion.
- For managed mode, generate a candidate secret in memory, then insert its
  paused proxy-key record and pending operation in one database transaction.
  A failed/duplicate admission must not leave a new usable key. Preserve the
  explicitly requested wallet; no inferred cross-wallet fallback is added.
- Record possible dispatch before the POST. Only a verified exact receipt may
  atomically activate the pending managed key, replace active agent metadata
  and ciphertext, and revoke the previous managed key. Failure rolls back all
  of those database changes. Clear follows the same receipt/settlement path.
- Fence legacy model writes and recipient changes during a pending operation
  and after protocol adoption. Delete intent stops further delivery and
  settlement; terminal resource cleanup must revoke pending/current managed
  keys and wipe pending ciphertext without discarding uncertain evidence early.
  Power/recovery coordination must not trap the owner permanently behind an
  unreachable guest or allow concurrent key delivery during a conflicting run.
- Expose only active/pending summaries and an explicit reconciliation action
  through the existing Manage API. Remove browser plaintext delivery only when
  this complete path is wired. Unsupported older guests need an honest upgrade
  state; the new bundle does not upgrade existing computers automatically.

These are constraints for the complete integration, not a live-delivery claim.
The following checkpoints distinguish source and schema from guest acceptance.

### Launch foundation checkpoint

The private launch precursor and coordinator adapter have
[scoped source and integration evidence](../../release/VERIFICATION-STATUS.md).
They are now called by the original model-selected allocation path; see the
[allocation checkpoint](../../release/VERIFICATION-STATUS.md).
The original welcome-form selector now has
[client recovery and browser-fixture evidence](../../release/VERIFICATION-STATUS.md).
Migration `20260828090000` was
applied only to Canary with zero request adoption and preserved existing rows.
The original settings API/UI now has a separately verified
[recovery slice](../../release/VERIFICATION-STATUS.md). Client request
retention and form wiring are implemented; live provider launch-to-model
acceptance and preparation of older hosts remain open.
The foundation reserves the original agent and encrypted intent together, then
promotes into the existing model journal only after readiness. One automatic
attempt cannot resume another attempt's uncertain journal. Native launch remains
the unchanged default. A model-selected launch requires its complete capability
contract; this code does not upgrade hosts or certify real inference.

### Custody checkpoint

The private operation schema and transactional managed-key custody now have
[local PostgreSQL/guest-record and independent-review evidence](../../release/VERIFICATION-STATUS.md).
The exact migration was applied to Canary with zero journal operations and
unchanged existing data. Later owned-guest acceptance created two operations;
both were terminally cleared when the disposable guest was destroyed. The settings coordinator/API validates and resolves the
complete request, verifies the guest observation, enforces the short delivery
lease, and exposes saved versus pending summaries. Preserve the existing
server-side provider URL registry; never accept an arbitrary model endpoint
from a browser. Applied schema does not prove live delivery.

Credential-only infrastructure repair is deliberately not a recipient change:
the journal retains its admission revision for audit, while exact allocation,
host, VM, owner, connection/target identity, tunnel and guest bearer stay bound.
Adopted managed keys use the agent clear/delete workflow; wallet key controls
now return explicit recovery guidance. Accounting pauses
and top-up recovery remain supported without reviving revoked keys.

### Coordinator checkpoint

The server coordinator and private store now have
[focused and actual PostgreSQL/guest integration evidence](../../release/VERIFICATION-STATUS.md).
They are now called by the original settings route. Resume reconstructs the original encrypted
request and checks both absolute and monotonic lease deadlines before network
dispatch. The original API/UI and adopted-key wallet guidance are integrated.
Scoped live delivery/clear and reboot persistence passed on one updated disposable
guest; this does not prove actual inference, live fault recovery, other runtime
adapters, or automatic upgrade/rollout to installed computers.

## Evidence and rollout

Use synthetic keys in local fixtures and owned disposable computers for live
checks. Never touch the existing protected user's Codex computer. Record exact
source, bundle, migration and deployed identities separately. Source tests do not
prove live inference or provider lifecycle. New guest assets do not upgrade
installed computers automatically. A rollback must retain pending operations and
credential evidence rather than silently restoring the unsafe write sequence.
