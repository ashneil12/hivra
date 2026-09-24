# Hetzner first boot and prepared computers

Date: 2026-08-27
Status: Canary implementation integrated; real-provider end-to-end acceptance pending
Parent: `2026-08-26-hivra-infrastructure-onboarding-design.md`

## Current implementation boundary (2026-08-28)

Canary now exposes the separately selected guided setup path described in the
[preparation checkpoint](../../release/VERIFICATION-STATUS.md)
and the existing-catalog [provider launch adapter](../../release/VERIFICATION-STATUS.md).
Capacity-only creation remains powered off. Guided setup verifies the provider
firewall before requesting startup, pins guest identity, and checks the setup
bundle and capacity before a separate agent launch can be admitted. The current
adapter covers Claude Code, Codex, Aeon, OpenClaw and Agent Zero; Hermes' separate
instance lane does not yet have this provider adapter. The subsequent
[model-selection checkpoint](../../release/VERIFICATION-STATUS.md)
adds explicit Codex/Venice own-key or Hivra model-credit admission only for
matching model-capable targets; infrastructure and model credentials stay separate.

These are implemented Canary paths, not completed real-provider acceptance.
The owned-computer create, prepare, native-agent use, restart/persistence and
complete cleanup gate below remains open. Earlier implementation checkpoints
retain their evidence at the recorded revision; statements that their public
callers are not yet implemented describe those historical checkpoints.

## Outcome and current gap

A Simple-mode user supplies a dedicated Hetzner project token, chooses capacity,
reviews provider billing and preparation separately, and gets a computer that can
run the existing agent catalog without assembling SSH keys. A Cloud VM remains
one provider-VM isolation boundary. It is not a nested Proxmox host, and this
work must not silently create a shared-kernel multi-tenant host.

At this design's initial checkpoint, Canary creation stopped at an
original-receipted powered-off server.
Cleanup existed; first boot, identity enrollment, readiness and agent
placement did not. This was unimplemented target behavior, not a reason to mark
inventory ready or substitute the ambient managed Hetzner credential.

## Operating envelope

Task: Hetzner first boot, owner-scoped capacity-to-ready-computer path.
Base: `0748b36716a71f74a0640b6b78e489061713c65e`.
Blast radius: high risk (guest identity, provider mutation, credentials).
Authority: the user's request to build the portable deployment system and
explicitly permitted disposable Canary/Hetzner acceptance. Existing customer
resources, production hosts, bare-metal installation, paid-plan changes and
unrelated credentials are excluded. Code/migration review is not authorization
to use a different provider project.

The terminal condition is a real approved project creating one computer,
preparing it deterministically, launching a supported existing agent with a
user-owned runtime/model credential, using its native surface, restarting
without lost data, and verifying complete teardown. Unit tests alone cannot
close this condition. Until then, the public capability remains false.

## User flow

1. Keep capacity-only creation available and powered off.
2. Add a separately explained preparation choice to a fresh capacity quote.
   Billing consent does not imply boot/preparation consent. Both choices and
   their exact recipe version must be covered by the durable confirmed intent.
3. A prepare-enabled fresh creation embeds a narrowly scoped enrollment
   capability. Create remains `start_after_create=false`; only the distinct,
   persisted preparation intent can authorize power-on after the creation
   receipt is complete.
4. Explain observable stages: creating capacity, starting computer, verifying
   identity, preparing environment, checking readiness, ready to launch.
   These are factual states with failure/recovery paths, not percentages.
5. Only a strict post-install readiness check publishes a provider-VM target.
   Starting the agent remains a separate action using the existing catalog.
6. Existing capacity-only servers without this enrollment recipe are not
   silently rebuilt or trusted on first SSH contact. A later explicitly
   confirmed rebuild/adoption flow must explain data loss or require a trusted
   out-of-band identity. The ordinary create-and-prepare path must not require
   manual fingerprint copying.

## First-boot identity

The control plane generates a random 256-bit, single-purpose capability with
a maximum 15-minute lifetime. Its verifier is bound to the owner, project
connection/revision, capacity order, preparation attempt, recipe and expiry.
It permits only enrollment of one Ed25519 SSH host public key for that exact
attempt. It cannot fetch account data, provision resources, run commands,
retrieve model keys, or access another computer.

This is a deliberate extension beyond the current non-secret capacity-only
cloud-init recipe: a prepare-enabled recipe contains this one-time bootstrap
capability, never a provider token, model key, reusable login, long-lived
computer credential, or general control-plane key. Hetzner and the trusted
guest image can read user data; they are already infrastructure trust roots.
Cloud-init may retain expired capability bytes in its cache and the provider
may retain user data. The implementation must not claim all copies were
erased. Expiry/consumption, not file deletion, removes its authority.

The guest reports its public key over certificate-verified HTTPS, using an
Authorization header, never a URL parameter. The receiver must:

- reject invalid, expired, cross-owner/project/revision/order/attempt/recipe
  credentials and an attempt not authorized for preparation;
- bind the reported provider ID to the immutable server receipt and fresh
  project API evidence;
- atomically consume the capability and pin one canonical public key;
- allow an identical, bounded acknowledgement replay while rejecting a
  different key, revoked attempt or stale connection;
- independently verify subsequent SSH using that pinned host key before
  sending any administrative command, runtime secret or agent payload.

Guest metadata and claimed OS/firewall status are not independent attestation.
Enrollment authenticates the provisioned bootstrap capability; readiness
still requires a control-plane check through pinned SSH. Do not disable
`StrictHostKeyChecking`, use `accept-new` as identity proof, or treat an
SSH connection to the expected IP as sufficient identity.

### Start-armed window (recipe 2026.09.24.1)

Hivra creates the server powered off, so a window counted from creation
expired for any owner who waited more than 15 minutes before Start setup. For
recipe 2026.09.24.1 the capability's `expiresAt` only bounds delivery (staging
to the server request). The challenge carries `armed_at` / `armed_expires_at`,
set once, by the database, in the same transaction as the setup power-on
checkpoint (`power_dispatch`): `armed_at` equals the recorded power-on and the
window is 15 minutes plus 2 minutes for Hetzner to boot. Consumption accepts a
proof only while `armed_at <= now < armed_expires_at`; an unarmed challenge is
always refused, so a leaked token is useless before Start setup. Arming is
allowed only while the attempt awaits identity and no power-on has ever been
recorded for it, and never a second time; after a recorded power-on the
recovery is a rebuild. Triggers refuse any other arming path and any recorded
power-on without its arming. The guest helper no longer receives an absolute
expiry: it enforces 15 minutes from this machine's first boot (`/proc/uptime`,
with its configuration in `/run`, written by cloud-init on the first boot
only), so a skewed guest clock does not matter; Hivra checks its own clock.
Recipe 2026.08.27.1 servers keep their 15 minutes from creation unchanged.

### Persisted identity after enrollment

The enrollment window limits enrollment, not the lifetime of the pinned host
identity. After successful enrollment, a fresh enrolled-only operation claim
may verify that same guest using current owner, connection revision, original
order/receipt and unrevoked pin authority. It shares the existing bounded
operation lease and cleanup/disconnect locks. It must not restore the consumed
token, extend its expiry, replace the pin or admit a second boot mutation.
An expired, never-enrolled attempt remains expired and cannot use this path.

Before administrator authentication, recheck the exact live server, Primary IPs,
original creation and power actions, firewall rules and attachments. Only the
saved original administrator key and enrolled host pin are allowed. Identity
verification alone publishes no target and performs no guest installation.
Current implementation/review status is recorded in
`docs/release/VERIFICATION-STATUS.md`.

## Deterministic preparation and recovery

The bootstrap renderer is versioned, bounded, and generated only on the server.
It creates the non-root administrative user with the generated public key,
disables password/root SSH, configures a deny-inbound host policy, and invokes
a vendored enrollment helper without arbitrary shell input or floating
installer URLs. A provider-level first-boot firewall must be installed and
observed before power-on for the enabled path; cleanup must own its exact ID
and remove it only if no other resources use it.

After identity is pinned, reuse a versioned guest runtime installer, with
explicit OS/architecture/capacity support and verified artifacts. Do not require
Proxmox guest-agent hardware on a regular Cloud VM. Preparation must preserve
the catalog rather than silently selecting another runtime.

The preparation record owns each mutation and lease. A request or browser
closing must not lose the operation or spawn a replacement purchase. Expired
work cannot dispatch provider mutations. Timeout means a persisted failed
stage, not ready. A retry cannot reuse an expired enrollment capability or
silently rebuild a disk. Cleanup, disconnect and preparation must share one
authority/lease boundary so a stale worker cannot resume after access is
revoked. Automatic rollback power-off/deletion is allowed only if explicitly
included in the user's confirmed operation; otherwise retain the resources
and show the exact recovery action and continuing billing.

## Acceptance gates

- Cryptographic scope/expiry/canonical-key and redaction tests.
- Actual transactional single-consumption, replay, revision change, lease,
  disconnect and cleanup tests.
- Vendored guest-helper tests for HTTPS-only transport, no redirects/proxy
  credential forwarding, bounded responses/timeouts/retries, safe diagnostics,
  acknowledgement binding, and temporary secret-file handling.
- Strict server-identity and readiness tests; guest self-report never makes a
  target ready.
- Fresh-context independent review before activation.
- Existing capacity-only, managed and multi-agent paths remain compatible.
- Browser-verified Simple/Advanced flow, including failure and recovery.
- Real approved Hetzner creation, enrollment, preparation, native agent access,
  restart/persistence and verified deletion of every owned provider resource.

### Exclusive ownership implementation checkpoint

The additive provider-computer ownership schema now uses the existing
`hivra_agents` provision/delete operations, with an explicit provider substrate
and immutable original order/enrollment/server identity. A unique order
reservation prevents reuse, and target retirement excludes further preparation.
Deletion requires the original five-resource absence receipt before access
revocation or binding release. Current review, transactional tests and Canary
schema evidence are in the
[ownership receipt](../../release/VERIFICATION-STATUS.md).

This is not public provider activation. The next adapter must retain this
existing agent operation while a bounded guest installer runs; release that
operation only after the worker has actually stopped, before claiming delete.
Do not restore a separate first-boot lease after allocation, invent a Proxmox
VMID, or treat an expired agent lease as evidence that a guest worker is gone.
Ready publication, the actual installer/power/recovery adapter, and real
Hetzner acceptance remain open gates.

## Historical implementation evidence

No live first-boot capability is enabled by this design document.
No Hetzner resource has been created for this step.

The offline proof, vendored guest helper and digest-checked renderer now have
focused regression and independent review evidence in
`docs/release/VERIFICATION-STATUS.md`. The private durable
ledger and sealed-delivery adapter are now implemented, independently reviewed
and schema-verified on Canary; see
`docs/release/VERIFICATION-STATUS.md`. The machine receiver now
authenticates the scoped capability, validates fresh exact server/IP/create-
action identity in the bound provider project, and atomically pins the key;
see `docs/release/VERIFICATION-STATUS.md`. No public flow stages
or arms an enrollment yet. The private implementations described below do not
enable public first boot, pinned SSH readiness or agent placement. Receiver
acknowledgement does not certify any of those outcomes.

The private first-boot firewall transport and exact resource/action policy are
implemented and independently reviewed; evidence is recorded in
`docs/release/VERIFICATION-STATUS.md`.
Those pure policy/transport functions cannot authorize boot by themselves.
The current public flow remains capacity-only.

The private shared lease and mutation journal are now implemented, independently
reviewed and schema-verified on Canary; see
`docs/release/VERIFICATION-STATUS.md`. The journal retains
original firewall/power receipts and prevents four-resource cleanup from
discarding a possible fifth resource. Stop setup revokes only the preparation
capability; provider/admin access and billing remain until separately handled.
Five-resource cleanup now extends that same lifecycle, with an exact locked
firewall-receipt expectation and distinct started-computer confirmation; see
`docs/release/VERIFICATION-STATUS.md`. Its schema is verified on
Canary; code delivery and real-provider acceptance are tracked in that receipt.
Published targets remain excluded until their exact retirement path is wired.
Public coordination, pinned SSH/readiness, target-aware teardown and
existing-catalog placement remain unimplemented acceptance gates.

The private first-boot controller now composes the shared lease, exact firewall
checks, enrollment arm and once-only power dispatch; see
`docs/release/VERIFICATION-STATUS.md`. It advances only an
already-staged preparation and has no public caller. Creation-consent/recipe
binding, authenticated recovery, pinned SSH/readiness and the full target
lifecycle remain outstanding; an enrolled identity is not a ready computer.

The private prepared-capacity entry point now stages/reuses the original
delivery and binds its exact recipe to atomic server-POST admission, while
keeping the existing capacity-only public route unchanged; see
`docs/release/VERIFICATION-STATUS.md`. Public consent
copy, coordinator/recovery routes, readiness and complete agent lifecycle
acceptance remain gates, not claimed shipped behavior.

The private pinned-SSH transport now has a real local client/server check for
the enrolled host key and original administrator key; see
`docs/release/VERIFICATION-STATUS.md`. It runs no command and has no
public caller. The enrolled-guest checker now connects that transport to fresh
owner/receipt/firewall evidence and a shared lifecycle lease, including after
the consumed enrollment token expires; see
`docs/release/VERIFICATION-STATUS.md`. Its private implementation
is independently reviewed and its additive schema is verified on Canary.
Environment preparation, target readiness and the public provider lifecycle
remain outstanding.

Private read-only guest inspection now composes the same owner lease and exact
provider checks with a fixed probe over the pinned, signed SSH session. It
returns a separate provider-guest facts contract and cannot advertise supported
nested isolation engines. Local tests and independent review are recorded in
`docs/release/VERIFICATION-STATUS.md`. This is not installation,
a public setup action, launch readiness or real-provider acceptance.
