# Hivra Product Architecture

**Status:** Canonical target architecture with a code-verified current-state map

**Last verified:** 2026-09-02. The bounded Hetzner/Codex lifecycle and cleanup evidence below remains the portable reference; the later private-preview and remote-desktop checkpoints describe their own exact revision and scope. Temporary provider-token revocation, user-owned Proxmox, whole-catalog, and full reference-release acceptance remain pending. Earlier checkpoints describe their state at the recorded revision, not the final current capability summary.

**Product direction updated:** 2026-09-04

**Approved target experience:** Agent and Computer are sibling entry choices in
one resumable Launch journey. Web/Canary is the authorized implementation and
acceptance surface for this reset. Code implementation, Canary deployment, and
bounded launch tests on clearly identified Hivra-owned Canary capacity are
authorized. The owner's 2026-09-05 weekend continuation additionally authorizes
local native/desktop-app work, visual/onboarding improvements, Windows/Omarchy
acceptance work, and at most GBP 10 cumulative Hetzner test-capacity spend,
including preparation and lifecycle testing of those disposable resources.
Production/public release, PR merge, other purchases, trial-policy changes,
legal-agreement acceptance, and unrelated live mutations remain outside that
authority. This approval changes target direction
and implementation order; it does not make an unimplemented route current or
weaken the existing portable-agent acceptance contract. Test-scoped lifecycle
actions may affect only disposable guest resources created for an approved
Canary check; they must preserve every pre-existing host, VM, volume, datum,
provider project, and credential and produce exact cleanup evidence.

The [remote-computers addendum](superpowers/specs/2026-08-31-hivra-remote-computers.md)
records the requested Buzz collaboration, DeepSeek Harness runtime, Omarchy
computer profile and low-latency desktop work. Buzz now has an account-scoped
connection surface plus a real signed cross-agent runtime/reply campaign.
DeepSeek has a pinned private runtime/gateway and provider installer with real
native UI, BYOK model inference, PTY, restart, revocation and cleanup evidence;
its guest identity is now attested before secret delivery instead of trusting
an unauthenticated bootstrap SSH connection. ACP and public launch authority
remain closed. Omarchy has a pinned, non-launchable profile
whose exact KVM install, owner desktop, reboot, Sunshine guest preparation and
claim-bound teardown passed on fixturenodea. The deployment catalog links to all three with those exact states;
neither a preview card nor installed code is release acceptance. Desktop
engineering may proceed alongside portable-release closure; projects and a
replacement workspace are not prerequisites.

The managed remote-desktop acceptance
now proves one disposable Selkies browser journey with decoded video, input
frames, reconnect, restart, revocation and zero surviving test computer. The UI
fullscreens the authenticated iframe in place so it retains the established
decoder/input session. This does not yet prove optical latency, a native client,
Sunshine/Moonlight, Omarchy capture or regional daily-driver performance.
An owner preparation checkpoint
adds the missing in-product install action for current identity-bound Proxmox
computers. The Desktop surface first attempts one owner-scoped, read-only
capability refresh and issues a fresh session when the guest is already ready;
only an explicit owner action may install missing capability. Legacy unbound
computers fail closed with a current-launch message; the path does not silently
rebind or mutate them. An exchanged Selkies controller now uses rolling
server-side leases: the guest-held bearer is renewed in four-minute increments,
the browser keeps the owner/capability proof current, and every renewal rechecks
the exact owner, computer, capability generation, transport and controller
state. A lease can never pass the capability expiry or the twelve-hour
continuous-session bound. Local broker acceptance proves that an active stream
can cross its original lease without reconnecting and that a failed renewal
closes media and releases agent input. A real current-bound Canary guest has not
yet been available to prove this continuity in the deployed runtime. The guest
bytes are pinned by immutable provisioner release `2026.09.01.8`; `.7` remains
accepted for exact retained recovery rather than being rewritten in place.
The Desktop surface reports its selected WebSocket/WebCodecs lane and measured
secure-session setup duration, while explicitly leaving click-to-frame latency
unmeasured. Setup time is browser telemetry, not optical input-to-visible proof.

The current private DeepSeek path is staged through immutable managed-Proxmox
provisioner `2026.09.02.4`. A `.3` fresh-stock Ubuntu campaign failed closed
before secret delivery because the base image did not yet have a running QEMU
guest agent; its unconditional cleanup passed. `.4` supplies a root-owned,
operation-scoped cloud-init vendor-data snippet that installs and enables QEMU
guest agent, attests the guest SSH host key through that authenticated host-to-
guest channel, then removes both `cicustom` and the exact snippet before secret
provisioning. A fresh claim-bound disposable fixturenodea campaign passed the native
UI, a BYOK DeepSeek V4 Flash reply through DeepSeek Harness's own settings and
credential APIs, six-command non-root public WebSocket PTY, restart with a new
boot identity, old-cookie rejection, post-restart model inference, revocation
and unconditional teardown with no QGA snippet left behind. ACP remains
unverified, so the public catalog entry stays closed. See the
combined live acceptance.

## Reading rule

Sections labeled **Current** describe repository behavior that exists today. Sections labeled **Target** describe the approved architecture and must not be marketed as shipped until its acceptance tests pass.

## Current system

The repository already contains a mature control plane and meaningful agent-computer substrate, but it does not yet have one canonical backend model.

### Current control plane

`dashboard/` is a Next.js application containing authenticated UI, API routes, Supabase-backed persistence, provisioning, lifecycle operations, billing, credentials, runtime configuration, recovery jobs, and observability.

Primary implementation areas include:

- `dashboard/src/app/` — product pages and API routes;
- `dashboard/src/lib/services/instance-service.ts` — high-level Hermes instance service;
- `dashboard/src/lib/services/instance-orchestrator.ts` — runtime deployment and update orchestration;
- `dashboard/src/lib/services/hetzner-instance-service.ts` — Hetzner instance construction and operations;
- `dashboard/src/lib/services/proxmox-instance-service.ts` — Proxmox guest and host operations;
- `dashboard/src/lib/instance-lifecycle.ts` — current Hermes lifecycle vocabulary and transition helpers;
- `dashboard/src/lib/recovery/` — health, missing-resource, orphan, and stuck-instance reconciliation;
- `dashboard/src/lib/browser-vnc.ts` and browser-sidecar modules — browser automation and live visual access; and
- `dashboard/supabase/migrations/` — current persisted schema and security migrations.

### Current lane 1: Hermes instances

The mature lane is centered on `hermes_instances`, instance-scoped routes, provider selection, the Hermes/WebUI runtime, profiles, lifecycle and recovery systems, and both Hetzner and Proxmox infrastructure.

The current lifecycle already documents drift between `status` and `lifecycle_state`. This is evidence for the target architecture's separate desired, observed, health, and operation state axes.

### Current lane 2: Hivra agent boxes

The newer agent-computer pilot is centered on:

- `hivra_agents` migrations and API records;
- `dashboard/src/app/api/hivra/agents/`;
- `dashboard/src/lib/hivra/agent-catalog.ts`;
- `dashboard/src/lib/hivra/agent-api.ts`; and
- agent-specific chat, dashboard, tool, template, resource, archive, and recovery helpers.

This repository exposes catalog entries, launch routes, and route tests for several agent types. The Hivra-managed lane now requires the reviewed, versioned provisioner from `dashboard/provisioner/`, while retaining the managed host layout under `/root/hivra-provisioner`. Admission checks the expected version, bundle integrity, required provision/lifecycle capabilities, and host prerequisites before using that target. The executable checks live in `dashboard/src/lib/hivra/managed-provisioner-readiness.ts`. This is fail-closed admission, not an automatic fleet rollout or an upgrade of existing guests.

The Infrastructure surface also projects the existing effective subscription
as one Hivra Cloud managed compute pool. It reads the same CPU, RAM, agent-slot,
and allocation data enforced by managed launch and resize gates, lists only
managed computers consuming that pool, and reuses the existing Stripe
subscription checkout. This is presentation over the mature billing and agent
lanes, not a new provider, subscription, or computer lifecycle. Hivra Cloud
remains a managed pool rather than an exposed physical-host inventory.

The portable-target canary adds an owner-scoped infrastructure registry, generic SSH host connections with read-only capability discovery, an explicit host-preparation action for the supported Proxmox path, stable discovered targets, exact target bindings on agent records, target-aware lifecycle operations, and a versioned provisioner bundle under `dashboard/provisioner/`. The launch UI keeps Hivra Cloud as the default and lets a user select a ready self-managed target without silently falling back to Hivra-managed infrastructure. The database migration and authenticated non-destructive deployment checks passed on canary for commit `f68dbae54`; this is still not a shipped portability claim until a destructive end-to-end acceptance run on an approved user-owned host proves real provisioning, native access, restart, and deletion without residual resources.

The 2026-08-27 managed Canary checkpoint records two bounded disposable Codex checks with 2 CPU, 4 GB RAM, and browser support: an initial `.8` creation followed by a `.9` connection-service update, then a fresh `2026.08.26.10` launch without guest repair. Native terminals, files, Git no-repository guidance, saved context, and the landscape noVNC browser were checked through the real UI. Restarts produced matching durable operation receipts, changed guest boot identities, healthy services, and reconnected access. Both deletions were independently checked for absence of VM, disks, runtime artifacts, DNS, and live tunnels. Final dashboard commit `28ad356bd` reached the verified Canary alias and passed full verification. No model login/inference, full-screen window transition, user-owned-target, whole-catalog, or fleet-wide acceptance is claimed; subsequent revisions need their own evidence. Existing browser sandbox and durable cleanup failure-path gaps are explicit release gates in the receipt.

Later bounded checkpoints verify strict managed deletion and its pre-allocation
access journal, plus another fresh managed launch with native access, file
persistence across two restarts, and independently verified complete teardown.
See the managed persistence and cleanup receipt
and resize capacity receipt.
Revision `42ff3e982` also corrects cross-family managed resize budgets,
fixed-size slot-only agents, unknown-plan handling, and truthful lifecycle
guidance. These close their specific recorded defects, not the remaining
browser-sandbox, model-inference, provider-portability, or public-release gates.

The infrastructure registry now also has a provider-specific Hetzner Cloud
connection and bounded-create slice. It asks for an owner-supplied,
project-scoped Read & Write API token, validates its read access with an
inventory request, encrypts the token, persists sanitized project inventory,
and displays each provider VM as a separate non-launchable node. The UI
discloses that the stored
credential grants broad project mutation authority even though connection alone
performs no purchase. The connection check cannot prove write scope; an approved
create returns a specific remediation if the token is read-only. A failed
refresh is persisted as the latest provider observation; prior successful
inventory is retained only as visibly stale
evidence.

Legacy v1 Hetzner credentials may remain valid for read-only inventory and
catalog access, but billable quote/create paths reject them with
`credential_reconnect_required`. The UI instructs the owner to disconnect and
reconnect the project with a current Read & Write credential before in-app
capacity creation.

For creation, the server selects policy-bounded shared-CPU offers from a fresh
provider catalog, generates a non-personal server identity, and returns a
revision-bound short-lived quote. The quote separates server, IPv4, IPv6, and
variable traffic pricing and binds fixed public networking, backups off, no
volumes, generated Ed25519 access, and `start_after_create=false`. It records
freshly observed rates for informed consent; Hetzner does not lock those rates
to the later create request and remains authoritative for final billing.
Capacity-only creation does not request or manage a provider firewall, though
an existing project policy may still attach one. The separately selected guided
setup path below applies and verifies its exact provider firewall before
requesting power-on; selecting the setup option alone performs no mutation.
A create request requires the
literal spending confirmation and a UUID idempotency key. The canary accepts
at most one non-rejected in-app Hetzner server claim per Hivra account across
all Hetzner connections. Disconnecting the project or externally deleting its
server does not automatically free the slot. The separately confirmed cleanup
flow now releases an eligible original-receipted server's slot only after
verifying absence of the server, both original Primary IPs, and generated SSH
key. Legacy/ambiguous resources without complete original evidence remain
manual, and additional simultaneous capacity remains unsupported. Rejected
requests that created no provider resource, including no project SSH key, do
not consume the slot and can retry. The public operation exposes the persisted
`canarySlotHeld` evidence; the UI uses that field rather than inferring slot
release from `provider_rejected` alone.
Multi-server creation remains target behavior.
Only a successful provider action followed by a strict provider read observing
`off` is reported as created. Creating or ambiguous operations remain
reconciliable through replay of the same key. If provider evidence instead
observes `running` or `starting`, the result presents an urgent Hetzner Console
action: Hivra did not authorize agent launch and does not power the server off
automatically. Even a verified `off` result is only a point-in-time observation:
Hetzner documents rare live-migration or hardware-failure recovery cases where
an off server can be powered on when its prior state is unknown. This Canary
therefore does not claim durable power isolation or monitoring; the owner must
inspect or delete the resource in Hetzner Console. Immediately before the
confirmed provider POST, the browser
stores a strictly parsed, bounded record containing only the connection, quote,
and idempotency UUIDs.
Reopening the dialog offers an explicit same-request check and never submits on
page load. The record is cleared only after verified `created_off`, a rejected
operation with `canarySlotHeld=false`, or a provider-safe pre-mutation quote or
capacity-limit error. An ambiguous or rejected request may leave the
Hivra-created project SSH key and separately billable Primary IPv4 or IPv6
resources. After reconciliation, the user must inspect and remove any unused
key and retained Primary IPs in Hetzner Console; Hivra does not auto-delete
them in v1.

Disconnecting a Hetzner connection permanently removes the encrypted project
token and Hivra's only stored generated server private key. It does not delete
the provider server, Primary IPs, or Hivra-created public key; billing continues
and regaining access may require Hetzner rescue mode or a rebuild. The server
rejects ordinary disconnect while a capacity operation is `creating`, while a
provider mutation is still pending or inside its reconciliation lease, and for
every post-attempt ambiguous operation even after that lease expires. For the
last case only, Canary exposes a separate typed force-forget action once the
operation is idle. Force-forget wipes the local token and sole private key but
does not call Hetzner, perform provider cleanup, delete audit evidence, or free
the account-wide Canary capacity slot. The owner must first inspect and clean up
any retained provider resources and billing in Hetzner Console.

**Scoped cleanup checkpoint (2026-08-27):** Commit `6a5cb21af` deployed to Canary
with migration `20260827160000` verified on the linked Canary database. Cleanup
uses owner/project credentials, original resource receipts, current provider
identity/protection/assignment checks, one mutation per request, durable leases,
and a local mutation deadline. Verified terminal cleanup removes inventory,
wipes the bootstrap private key, and releases the account slot; delayed
inventory callbacks cannot recreate deleted resources. Explicit abandonment
of an idle failed cleanup instead wipes local access, retains the unresolved
claim, and does not stop provider billing. Broad tests, independent review,
isolated browser interaction checks, and signed-in Infrastructure sanity passed;
real Hetzner resource acceptance remains pending. See the
scoped cleanup receipt.

A verified `created_off` provider VM is powered off, billable, unprepared, and
blocked from agent launch. This slice publishes no deployment target and grants
no launch authority.

**Preparation groundwork (2026-08-27):** source contains a separately
confirmed first-boot creation recipe, exact enrollment admission, an owner-bound
firewall/power-on coordinator, and original-key/pinned-host SSH verification and
read-only environment inspection. These began as private integration points;
the 2026-08-28 setup checkpoint below now connects them to the Infrastructure UI.
Enrollment/discovery is not runtime readiness.
The versioned guest installer has an explicit `provider-vm` substrate that omits
the Proxmox QEMU channel requirement while retaining its supported runtime and
amd64 checks. Private prepared creation now admits only freshly revalidated
Ubuntu 22.04/x86 selections before new provider resources; it preserves
original-order reconciliation and does not constrain capacity-only creation.
This image admission
is not live image/install acceptance. Private guest bundle delivery now uses
the original owner lease and pinned SSH to atomically install and re-verify the
allowlisted runtime files without executing them. A lost acknowledgement keeps
the operation lease until expiry and retries reconcile exact original bytes;
this bundle delivery is not
package installation or a ready computer. Ready-target publication,
provider-aware agent launch/access/lifecycle and
real provider teardown acceptance remain unfinished. See the
installer boundary receipt.

The current owner/order/server/IP/action/firewall and enrolled-host checks are
also available as a shared private provider-receipt reader. Preparation callers
still own the original first-boot lease; the reader does not claim or renew
authority, open the administrator key, connect SSH or publish readiness. It is
groundwork for reusing those checks from the existing agent lifecycle, not a
separate execution lane. Its verification receipt
tracks source/review/delivery separately from real-provider acceptance.

The shared target read contract now distinguishes exclusive provider VMs from
Proxmox nodes. Existing Proxmox setup, runtime admission, execution and teardown
reject provider targets rather than inventing VMIDs or borrowing a managed
host. This target boundary is
still rejects provider launch-readiness claims until the complete adapter is
implemented and tested. Prepared-target publication is described below.
The subsequent private ownership and retirement implementation
adds exclusive original-order identity to the existing agent lifecycle,
one-way target retirement and five-resource cleanup checks before access
revocation or terminal binding release. Its receipt distinguishes local SQL
proof and schema delivery from the still-unimplemented public provider adapter.

The existing agent DELETE endpoint now has a provider-specific adapter that
preserves original ownership, stops the original installer before teardown,
retires the exact target and reuses the five-resource cleanup/finalization
proof. Its client advances acknowledged steps without treating pending or
uncertain responses as deletion. This deletion checkpoint
does not enable provider launches; its verification and delivery evidence are
separate from real provider lifecycle acceptance.

The subsequent readiness checkpoint
connects original installer observation to independent pinned guest and public
access-service checks before the shared running-state compare-and-set. The
original agent page shows observed readiness and keeps Manage/removal reachable
during setup. Installer success alone is not runtime readiness, and runtime
readiness is not model authentication or inference. Provider launch admission
remains closed pending the complete launch/lifecycle adapter and real acceptance.

The private power transport and
power-operation fence preserve
one original agent operation across start/stop/restart. Database guards require
the exact provider action and fresh actual-state proof; reboot additionally
requires a changed boot identity. They do not enable a public power route or
provider launch admission. Live observation/dispatch coordination and end-to-end
acceptance remain unimplemented target behavior at this checkpoint.

The subsequent power adapter connects
those contracts to the original action POST, status GET and deletion path. Only
an explicit POST can dispatch the first request; polling/removal cannot retry it.
Pinned boot observation is independent of runtime health, while successful
start/restart completion still requires both guest and public runtime checks.
The original page and Manage show factual pending/uncertain states. Provider
launch admission remains closed, allocated-provider resize is not implemented,
and real-provider power/launch/native acceptance is still outstanding.

The `.27.2` source bundle also replaces the Proxmox guest's masked, unbounded
cloud-init wait with noninteractive bounded status checks. Exact `.26.10` and
`.27.1` predecessors remain compatible and retain their observed versions;
dashboard delivery does not install the new bundle on existing hosts. The
boot-check receipt separates
source/Linux-fixture evidence from a real new-bundle launch, which remains open.

The `.27.3` source bundle moves native terminal configuration into the shared
guest installer rather than leaving it in the Proxmox host orchestration.
The agent and box terminals run as the agent user on loopback, use its home
directory, and must each pass service/HTTP checks. A missing selected CLI now
fails with repair guidance instead of falling back to another agent. This
native terminal portability
keeps existing runtime choices and access paths; it does not publish provider
targets, update installed computers, or prove live `.27.3` acceptance.

The `.27.4` source bundle adds a shared, bounded-input guest entrypoint for the
five portable catalog runtimes and a credential-preserving named-tunnel setup
path. A disposable managed Codex guest received those exact artifacts and
passed real installation, native terminal access, file access, supported
restart, file-byte persistence and independently verified complete teardown.
This shared-installer checkpoint
does not claim a new-bundle host rollout, the other runtimes' live acceptance,
model inference or a Hetzner lifecycle. The Proxmox caller remains responsible
for allocation and cleanup; the future provider caller must use the same
agent operation authority with exclusive computer ownership and retirement.

The `2026.08.28.1` bundle adds a private once-only provider installer worker and
pinned-SSH control primitive for that existing agent operation. A disposable
managed Linux computer verified the exact bundle, actual bounded systemd
settings, running child processes, cancellation with complete cgroup removal,
and normal full computer teardown. The worker receipt
separates this Linux primitive acceptance from the still-unimplemented
database-owning provider caller, readiness/access/lifecycle adapter and public
preparation UI. A running or stopped installer is not a ready agent computer;
no provider target is published by this checkpoint.

The subsequent private operation handoff
now binds that worker to the existing reserved agent operation. Its immutable
dispatch and stopped evidence survives recovery and prevents early operation
release; a repeated request cannot consume another launch grant. The exact
schema is verified on Canary. The caller reuses the original provider receipt
and pinned administrator key, but is not yet wired into a public launch route.
The retained recovery controller
now selects the original reviewed worker from the immutable journal, without
loading the current release or resending launch credentials. Its first registry
entry is `2026.08.28.1`; unknown releases remain held, not silently substituted.
Ready publication and the complete provider access/lifecycle path remain
unimplemented target behavior.

**Public computer preparation (2026-08-28, implementation checkpoint):** an
optional, explicit setup choice on the original capacity review now includes
the one-time enrollment recipe. After creation, Continue computer setup advances
the original server's firewall, power-on, pinned SSH inspection and verified
bundle delivery. Opening or refreshing the dialog is read-only; continuing is
explicit and pausing retains completed steps. Lost-response recovery retains
the original capacity request and preparation choice. Existing capacity-only
orders are not silently adopted or retrofitted.

Publication holds the same enrolled lease and records the exact successful
original power action, including when enrollment arrived before its status
was saved and the one-time token has since expired. It creates one unavailable
provider target with verified bundle/capacity evidence, not launch authority.
The unused-computer cleanup path first retires that exact target and refuses
retirement while an agent or active setup owns it. The existing catalog is
unchanged. Public launch integration and real agent installation, native access,
power lifecycle and Hetzner acceptance remain open. Delivery and verification are tracked in the
preparation receipt.

**Provider launch integration (2026-08-28):** the original launch API now reserves
an exclusively owned, prepared Hetzner computer after current owner, provider,
pinned SSH, bundle and capacity checks. Preparation and launch admission are
separate checkpoints under the same setup lease. The provider installer,
readiness, native-access handoff, power and deletion adapters share the original
agent operation and retain uncertain outcomes. The existing forms offer the whole
computer, not invented sub-VM resource partitions. Five reviewed runtimes are
admitted: Claude Code, Codex, Aeon, OpenClaw and Agent Zero. Native runtime sign-in
remains the default. The subsequent launch-model form checkpoint
also connects Codex's explicit Venice own-key or Hivra model-credit selection to
the reviewed model-aware launch contract. That path requires a matching
model-capable target and server-created launch admission; it does not enable
arbitrary model-key delivery to every runtime or older guest. Template-skill
delivery is not supported by this provider path. Hermes' separate instance lane
does not yet have this provider adapter. Real provider lifecycle and model
inference acceptance remain pending.
Source `1fbabd12e` and migration `20260828060000` are verified on Canary. See the
launch receipt for exact tests,
visual checks, schema and alias evidence; no real-provider success is claimed.

**Real provider acceptance (2026-08-28):** the existing flow passed real bounded
Hetzner creation, firewall-before-power preparation, pinned enrollment,
exact-computer launch handoff, Codex installation, metered model/tool work,
independent Files readback, and persistence across restart. The final cleanup
correction `66ae1095246d51e916ab538720a9f6a3b1451d35` reached the verified Canary
alias and passed a fresh native-access launch and one-confirmation teardown.
All five original provider resources, the tunnel and matching DNS were verified
absent; original resources and the managed agent were preserved. The full
frozen-source gate passed 9,894 tests, lint, typecheck and build. The
acceptance receipt separates
model/restart proof from final cleanup proof by revision. Test Hivra connections
and issued model credentials are removed/revoked; temporary provider-account
token revocation is still unverified because Arc's token UI is unavailable.
This is not native authenticated OpenAI inference, whole-catalog, or every-key
acceptance.

**Managed guest runtime update (2026-08-29):** managed hosts now have a
cron-secret-protected, explicit-target bundle synchronizer that defaults to a
dry run, validates the exact committed manifest and syntax, swaps atomically and
retains rollback state. The original Manage surface can request
`Update & restart`; the database owns it as a real restart operation, and the
host refuses any bundle other than the reviewed `2026.08.29.1` identity. A live
disposable Codex computer preserved its agent, target and VM identities, returned
to `running` and reconnected its terminal. Complete VM, volume, access-tunnel and
DNS cleanup was verified afterward while the pre-existing managed computer
remained running. The same source revision passed one fresh real
signup-to-agent-reply audit with zero surviving resources. See the
revision-bound receipt.
This is managed-guest update evidence only: provider computers, self-managed
targets, other catalog runtimes and the full 20-run reliability campaign remain
unaccepted.

The current portable code can inspect a generic Linux host, inventory an owner's
Hetzner Cloud project, create a policy-bounded provider VM after explicit billing
confirmation, prepare it and admit supported agents through the existing flow.
The bounded approved-project Codex path above has real lifecycle and resource
cleanup evidence; other runtimes and providers require their own acceptance.
Existing Proxmox launch remains separate. Allocated provider resize, automatic
Proxmox or isolation-engine installation on plain Linux, prepared generic Linux
targets, full self-hosted control-plane packaging, snapshots, restore and
cross-host mobility remain target behavior rather than current portable behavior.
The current Mac Alpha is a thin, ad-hoc-signed control shell that can open Local
Hivra, Canary, or a custom control plane and drive the existing local launcher
from a selected checkout. It is not a signed/notarized public release, a bundled
standalone distribution, or evidence of a Windows client. Native-app work and
client release remain outside the 2026-09-04 execution authority.

### Current lane 3: Workspace and native surfaces

Workspace Cloud, Hermes profiles, Hermes native WebUI/Desktop access, browser VNC, and CLI-oriented Hivra chat surfaces provide valuable working experiences but do not yet share one durable execution, identity, lifecycle, or capability contract.

The existing per-agent dashboard and agent-specific screens remain working
current surfaces while the approved sibling Launch journey is implemented. They
must not be removed before migration, parity, rollback, and portable-reference
gates pass. The `/dashboard/workspace` compatibility shell is an optional canary,
not the default replacement for these working surfaces.

The current top-level Launch presentation already offers separate Agent and
Computer choices, but their subsequent routes, stores, lifecycle behavior, and
acceptance are not yet one implementation. The Ubuntu Computer path still uses
the Hivra-agent storage lane, and attaching an agent to an existing Computer is
target behavior rather than a completed current path.

Hivra guest terminal, browser, and native-dashboard surfaces now probe the selected HTTPS origin's public `/api/meta` without credentials and require `surfaceAuth: "post-cookie-v1"` before sending the bearer in a POST body to `/auth/bootstrap`. The guest returns an opaque HttpOnly cookie and a clean local redirect; the dashboard no longer falls back to bearer-bearing URLs. Older guests without the capability show an explicit connection-update notice with support/admin guidance, and unreachable metadata produces a retry state that also recovers by itself once a later check succeeds (failures are logged once per reason as a client diagnostic). Gateways built from this bundle save each guest sign-in (a SHA-256 of the session secret and its expiry, bound to the computer's API token) in an owner-only file under `~/.hivra`, so an ordinary gateway restart (runtime update, crash, reboot) keeps every surface's cookie valid; rotating the API token signs every surface out. They advertise the saved store's random epoch as `bootId` in `/api/meta`, which changes only when sign-ins were actually lost (first start with a store, token rotation, an untrusted or corrupt store, or one that cannot be kept current). While a surface is on screen and active, the dashboard re-checks the metadata on window focus, `online`, the page becoming visible and every 30 seconds; when the `bootId` changes, appears or disappears it signs in again by posting the bootstrap into a newly mounted frame, so lost sign-ins do not leave the surface on a dead session and no browser history entry is added. An unchanged `bootId`, a failed check, or a gateway that never advertised one never reloads a loaded surface. Existing computers keep sign-ins in memory only, and lose them on every gateway restart, until their gateway is replaced (DeepSeek computers only through a fresh DeepSeek install, because Update & restart refuses DeepSeek). The restart behaviour is covered by tests that run the real gateway process; it has not yet been verified on a live computer. A DeepSeek native surface waits for `nativeReady: true` before it signs in and whenever a loaded one reports it false; that wait is bounded to 3 minutes (20 seconds if the gateway itself is unreachable), after which the dashboard says DeepSeek has not started and offers Try again. Header-authenticated APIs are unchanged. This transport fix is not the target access-grant model: current guest sessions last 12 hours and are box-wide, and the separate legacy Hermes WebUI handoff still needs bearer-URL hardening. Surface/user/audience binding, short expiry, revocation, and the full access-isolation matrix remain release gates.

### Current presentation unification

`dashboard/src/lib/hivra/unified-agent.ts` intentionally describes itself as presentation-only. It maps Hermes and Hivra records into one list while preserving separate APIs, stores, lifecycle semantics, and ownership. It is a useful compatibility view, not the target domain model.

## Target system

The target architecture introduces one canonical agent-computer control plane while preserving runtime- and provider-specific capabilities behind versioned adapters.

```text
User / Client
      |
      v
Hivra API + Sibling Agent/Computer Launch + Existing native surfaces
      |
      +-- Agent identity / Project / Conversation / Task
      +-- Durable run + event + artifact service
      +-- Credential bindings + access grants
      +-- Agent-computer lifecycle orchestrator
      +-- Infrastructure connections + capacity inventory
                    |
          +---------+----------+
          |                    |
   Runtime adapter       Provider adapter
   Codex/Hermes/Buzz     Proxmox/Hetzner
          |                    |
          +---------+----------+
                    |
          Capability-selected isolation driver
          provider VM / KVM / gVisor / system container
                    |
        Versioned computer runtime
                    |
       Agent runtime + OS + storage
```

## Canonical domains

### Agent identity

Portable behavioral and runtime definition: name, instructions, memory references, runtime selection, policy, credential bindings, and preferred surface.

### Agent computer

Isolated environment with provider placement, operating-system image, compute,
storage, network, identity, access surfaces, lifecycle, health, snapshots,
backup, restore, and eventual mobility. A Computer may initially host no agent
identity or managed runtime installation. Launch Agent creates or selects an
agent identity and binds a primary computer; attaching, detaching, or moving that
identity later is explicit. The first managed binding may enforce at most one
primary Hivra agent identity per computer without making that a permanent model
limit.

### Infrastructure connection and capacity

An infrastructure connection binds an owner to a supported provider API or host through encrypted credential references. A host connection does not assert Proxmox, an isolation boundary, or launch authority. Read-only discovery produces revision-bound, non-secret evidence about identity, operating system, capacity, virtualization support, installed substrates, and candidate drivers.

The normative host sequence is: connect host, inspect, recommend a supported substrate, show the exact preparation plan, obtain explicit consent, prepare, reconnect or reboot when required, run a fresh strict adapter preflight, then publish launchable target evidence. Current evidence may prove an existing Proxmox installation; future adapters may install or configure another substrate. Discovery evidence alone never creates a deployment target.

Provider spending policy belongs to the connection and is evaluated before mutation; a launch cannot silently purchase a server.

Connecting infrastructure does not create an Agent or Computer. Launching either
resource selects compatible existing capacity. Provider purchase remains a
separate operation requiring explicit policy and authority; it is excluded from
the 2026-09-04 web/Canary execution approval.

### Isolation driver

The isolation driver is the actual execution boundary selected for a computer. Drivers advertise requirements, compatibility, and an honest isolation class. Initial classes are `provider-vm`, `hardware-vm`, `application-kernel`, and `shared-kernel`. A shared lifecycle contract does not imply equal compromise isolation.

### Runtime installation and adapter

A runtime installation is the specific version and configuration running on a computer. The adapter declares and translates supported capabilities such as conversation, durable sessions, approvals, files, Git, terminal, browser, native web or desktop, structured plans, and artifacts.

### Provider placement and adapter

Provider adapters implement infrastructure behavior such as connection validation, capability and capacity discovery, provision, power, resize, volumes, snapshots, backup, restore, clone, migrate, console, private network, and accelerators.

Responsibility is not one binary provider attribute. Product copy uses two
independent choices: **Hivra-hosted** or **Self-hosted Hivra** for the control
plane, and **Hivra Cloud capacity**, **My cloud**, or **My server** for capacity.
For every capacity resource and operation, persisted policy identifies the
control-plane operator, infrastructure-credential custodian, spend owner,
capacity operator, upgrade/monitoring/recovery owner, and support party.

`self-managed` and `hivra-managed` remain compatibility summaries and names for
existing acceptance profiles, not provider adapters or sufficient write
authority by themselves. They may be used only when their exact responsibility
fields are declared. Both profiles use the same functional provider contracts;
no binary label may silently assign all responsibility fields.

## Setup and isolation selection

Simple mode asks whether the user wants an Agent or Computer, its runtime or OS
profile, and where it should run. It runs target and workload preflight and
chooses the strongest compatible driver with conservative resource defaults.
Advanced mode exposes only supported choices for driver, target node, resource
allocation, storage, network policy, dedicated or shared placement, repair
access, and provider-spending policy.

Selection is capability-driven rather than provider-name-driven. A normal cloud VM may support a direct provider-VM computer, rootless OCI, a gVisor application-kernel sandbox, or an unprivileged system container without supporting nested KVM. Bare metal or an existing Proxmox environment can offer hardware VMs. The API returns the selected driver, isolation class, reason, unmet requirements, and any downgrade warning. The control plane never silently substitutes a weaker driver.

Independent Proxmox servers and clusters register as separate capacity targets. Hivra coordinates placement above them; it does not require internet-spanning Proxmox clustering or ambient server-to-server trust.

### Conversation, run, task, and project

- A conversation is ordinary interaction and can exist without a project.
- A run is one durable execution attempt with delivery state, execution state, events, artifacts, and one truthful terminal outcome.
- A task is an optional durable objective spanning runs or agents.
- A project is optional organization for agents, computers, conversations, tasks, repositories, files, and shared context.

## State contracts

The normative run and agent-computer state models live in the approved [platform design](superpowers/specs/2026-08-24-hivra-agent-computers-design.md).

Important rules:

- delivery acknowledgement and runtime execution are separate facts;
- accepted or running work requires durable delivery acknowledgement;
- terminal run states are immutable;
- uncertain cancellation remains quarantined and nonterminal until reconciled;
- desired computer state, provider observation, Hivra health, and in-flight operation are separate axes;
- provider drift is displayed and reconciled, never hidden by rewriting observation; and
- retries require idempotency or an explicit human decision.

## Computer runtime

Each agent computer receives a small versioned Hivra component that:

- establishes cryptographic computer identity;
- reports health and capabilities;
- accepts authorized run delivery and ownership leases;
- supervises the selected runtime;
- emits ordered resumable events and artifacts;
- brokers local terminal, files, browser, and native surfaces;
- persists recovery state; and
- supports diagnostics and safe upgrades.

This component and its installation assets must live in version control. Host-local scripts are migration inputs, not an acceptable final dependency.

## Access model

Every surface is bound to the authenticated user, selected computer, audience, capability, and short expiry.

- An Agent opens its existing Hivra or runtime-native interface by default.
- A Computer opens its accepted Desktop, Files, Terminal, or Manage surface
  without requiring an agent.
- The universal Hivra workspace is an optional later fallback over the same contracts, not a separate product lane.
- Native runtime web or desktop interfaces remain available when adapters advertise them.
- Terminal is explicit and auditable.
- Browser automation and human takeover are distinct control modes.
- A full general Linux desktop reuses the proven portable computer and access
  boundaries. Its performance work need not wait for an optional focused
  workspace; launch availability still requires its own live acceptance.
- Current Proxmox Ubuntu computers can enroll in an owner-selected Tailscale or
  HTTPS Headscale network with an owner-supplied one-time key. Hivra verifies the
  exact VM binding and guest SSH identity, keeps Tailscale SSH, accepted routes,
  advertised routes, and exit-node use disabled, and stores only sanitized
  connection observations. Disconnect logs the guest out and disables the
  service; deletion first logs out a running owned guest, while a stopped guest
  is never booted solely for logout and loses its local node key through the
  immediately verified VM destruction. Either path can leave an offline device
  record in the external coordination server until that server's retention or
  administrator cleanup removes it.

## Migration approach

Hivra uses incremental extraction rather than an in-place big-bang rewrite or a
disconnected greenfield product. The approved reset adds a sibling web Launch
shell over compatibility adapters; it does not create another lifecycle or make
the shell authoritative before the migration gates pass.

1. Preserve the working agent catalogue, launch path, agent-specific screens,
   native interfaces, and unchanged portable acceptance while the sibling shell
   is built.
2. Define canonical identifiers, resource and binding relationships, state
   machines, capability documents, adapters, migration ownership, and resumable
   launch operations.
3. Add the gated web/Canary sibling shell and prove one mature Agent path and
   Ubuntu Computer path on existing Hivra-owned capacity.
4. Add explicit attach/detach/rebind semantics without conflating an agent
   identity, runtime installation, and Computer.
5. Converge the existing customer-owned-capacity path and pass the original
   `UC-PORTABLE-AGENT-01` definition unchanged.
6. Complete self-host control-plane recovery, computer-data portability, and
   only then any separately threat-modelled Hivra Cloud link.
7. Continue runtime consolidation and desktop/OS work through their independent
   acceptance gates; native clients and public release require separate authority.
8. Add durable orchestration only after single-agent execution, recovery,
   authority lineage, and bounded-stop controls are real.
9. Stop legacy writes only after parity, reconciliation, and rollback pass.
10. Remove old lanes after a documented rollback window.

The migration contract must define canonical-to-legacy identifiers, per-phase write authority, session and credential mapping, outbox or dual-write behavior if any, reconciliation queries, cutover, and rollback.

## First reference acceptance path

The portable reference acceptance remains unchanged by the sibling-entry
approval. The first target release uses the existing agent-first launch flow to connect and preflight a prepared user-owned Proxmox target, then launch one mature existing agent through the same public adapter path used in managed mode. It must accept a user-owned runtime or model API key without routing usage through Hivra credits and prove target ownership, secret redaction, capacity admission, provision, enrollment, authentication, durable work delivery, ordered reconnectable events, artifact retrieval, restart recovery, workspace persistence, start, stop, resize, snapshot, restore, and deletion with no residual provider resource.

The runtime used for this acceptance test does not become the product's preferred runtime. No fleet or multi-agent claim substitutes for the single-computer proof, and no single-computer proof substitutes for running the same portable target contract across the current catalog.

## Related documents

- [`../VISION.md`](../VISION.md)
- [Approved platform design](superpowers/specs/2026-08-24-hivra-agent-computers-design.md)
- [Open-source boundary](OPEN-SOURCE-BOUNDARY.md)
- [Security model](SECURITY-MODEL.md)
- [`../ROADMAP.md`](../ROADMAP.md)
- [Core experience direction](CORE-EXPERIENCE.md)
