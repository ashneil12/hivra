# Hivra Infrastructure Onboarding

**Status:** approved product direction; implementation evidence remains feature-specific

**Date:** 2026-08-26

**Parent specification:** `2026-08-24-hivra-agent-computers-design.md`

## Purpose

Make adding capacity feel like a product setup flow, not a server-administration form.
Every supported provider or host still becomes an owner-scoped infrastructure
connection with discovered capacity, but the user should not have to understand
SSH fingerprints, Proxmox, placement drivers, or host preparation before choosing
what they want to add.

This specification refines the onboarding surface only. It does not change the
parent architecture's separation between connecting credentials, creating or
adopting capacity, preparing a host, and launching an agent.

## Entry Information Architecture

The primary action is **Add capacity**. It opens an outcome-led chooser in this
order:

1. **Use Hivra Cloud** — recommended when the user wants Hivra to operate the
   underlying infrastructure. An active entitlement and its managed computers
   appear automatically; otherwise the user chooses a compute pool and enters
   the existing secure subscription checkout.
2. **Create or connect Hetzner Cloud** — simple self-managed cloud capacity.
3. **Use a server I already have** — guided setup for a Linux server, bare-metal
   host, or existing Proxmox environment.
4. **Advanced providers and manual SSH** — raw connection details, Hetzner
   Dedicated/Robot, and future provider-specific adapters.

These are not three equal technical cards. The recommended path should be
visually obvious, the existing-server path should be easy to find, and manual
SSH should be a tertiary disclosure.

The zero-capacity page should lead with this chooser. Hivra Cloud is visually
primary, while Hetzner and an existing host remain clearly available without
being presented as managed products. Summary metrics and operator diagnostics
become useful after at least one managed entitlement or self-managed connection
exists and must not push the first action below a large dashboard header.

## Hivra Cloud Managed Path

Hivra Cloud uses the existing managed subscription and agent provisioning
contracts. Infrastructure does not create a second billing or lifecycle lane.

1. Read the same effective subscription and compute budgets enforced by launch
   and resize gates.
2. If an entitlement is active, show the managed pool and only computers that
   consume Hivra-managed capacity. Self-managed agents never appear as managed
   usage.
3. Show remaining CPU, RAM, and agent slots from server-returned budgets.
4. Route each existing computer to its current native agent surface.
5. Let an unsubscribed or Free user choose an existing paid plan and cadence,
   then enter the existing Stripe Checkout. No charge occurs in Infrastructure.
6. Let the user allocate CPU and RAM during the existing agent launch or resize
   flow. The server-side resource gate remains authoritative.

Hivra Cloud capacity is a managed compute pool, not a representation of a
specific physical Hivra host. The UI must not expose fleet credentials, host
inventory, or imply that plan entitlement alone proves current physical-host
health.

## Hetzner Cloud Beginner Path

Hetzner does not publish a general third-party OAuth connection for the Cloud
API. The supported flow is therefore a guided project API token:

1. Open or create a dedicated project in Hetzner Console.
2. Generate a **Read & Write** project API token. Hivra discloses that the
   stored credential grants broad mutation authority inside that project even
   though connecting it performs no purchase. The user can revoke it in
   Hetzner Console at any time.
3. Paste the token into Hivra once and give the connection a local display name.
4. Hivra validates the token with a read-only request, encrypts it, and never
   returns it to the browser or logs it. This proves read access, not write
   scope; a later approved create reports a specific remediation if the token
   is read-only.
5. Hivra inventories the servers already visible to that project.
6. The user chooses one policy-bounded shared-CPU size, currently available
   location, and matching Ubuntu system image from the live provider catalog.
7. Hivra fetches a fresh, short-lived observation of provider rates and shows
   the generated non-personal server name, server price, IPv4 price, IPv6 price,
   base hourly rate, monthly cap, included traffic, and variable per-TB traffic
   overage in the project currency.
8. The user confirms the observed configuration and rates and selects **Create
   server and start billing**. The review states that Hetzner does not lock the
   observed rates and remains authoritative for final billing. No earlier
   interaction can create a provider resource.
9. Hivra creates the server with public IPv4 and IPv6, backups off, no volumes,
   and `start_after_create=false`. Success is shown only after the provider
   action succeeds and a subsequent provider read observes the server powered
   off. The node remains unprepared and blocked from agent launch.

For this canary, durable spend control permits at most one non-rejected in-app
Hetzner server claim (`creating`, `ambiguous`, or `created_off`) per Hivra
account across all Hetzner connections. The choose, review, and result screens
disclose that limit. Disconnecting a project or externally deleting the server
does not automatically free the slot. The scoped cleanup milestone now offers
explicit deletion reconciliation for original-receipted, unprepared,
powered-off servers: only verified absence of the server, both original IPs,
and generated SSH key releases the slot. Other unresolved/legacy requests
remain manual, and additional simultaneous capacity remains unsupported. A rejected
request that created no provider resource, including no project SSH key, does
not consume the slot and can retry. The operation result includes persisted
`canarySlotHeld` evidence, and the UI uses it rather than inferring slot release
from `provider_rejected` alone. This is a temporary canary guard, not the target
multi-server model.

One connection represents one Hetzner project because Hetzner API tokens are
project-scoped. A user can add multiple project connections.

Legacy v1 project credentials remain eligible for compatible read-only
inventory and catalog access, but billable quote/create paths fail closed with
`credential_reconnect_required`. The UI tells the owner to disconnect and
reconnect the project with a current Read & Write token before in-app creation.

### Create a new server

Hivra reads server types, location availability, and pricing from the current
Hetzner API. It may present friendly presets, but it must not hard-code a price
or imply that a temporarily unavailable plan can be purchased.

The final review shows at least:

- server-generated non-personal name and quantity;
- region and architecture;
- vCPU, memory, and disk;
- live server-plan, IPv4, and IPv6 price line items;
- gross base hourly rate and monthly cap in the project currency;
- included traffic and the separately billed additional-traffic-per-TB rate;
- fixed backups-off and no-volume policy;
- the real isolation class; and
- the powered-off result and access policy planned for a later approved first
  boot, without implying that preparation or agent launch occurred.

Creating capacity is a billable provider mutation. It requires a separate,
explicit **Create server and start billing** confirmation tied to the observed
configuration and rates. Hetzner does not bind or lock the observation to the
later create request, so the UI discloses possible provider rejection or drift
before submission. Connecting a token,
refreshing inventory, opening an agent launch form, or selecting a recommended
size must never create a server.

Hetzner bills the base resources by the hour with a monthly cap and rounds
partial hours up. A powered-off server remains billable until deletion. Primary
IPs are priced and billed as separate line items while they exist. Included
traffic is fixed by the offer; additional outgoing traffic is variable usage
outside the base total. The UI offers scoped cleanup for eligible receipted
servers, while directing unresolved or changed resources to Hetzner Console
for manual review of the server and any retained Primary IPs.

Every created cloud server is a separate provider VM and appears as its own
infrastructure node. Additional servers can be purchased later and appear on
the same inventory surface. Hivra may coordinate placement across them, but it
must not imply that separate servers are a Proxmox cluster or share ambient
host trust.

Externally created servers are reconciled when the user refreshes the
connection or during bounded background inventory sync. The public Hetzner
Cloud API does not currently provide a webhook contract that Hivra can rely on
for instantaneous discovery.

### Bootstrap and isolation truth

Cloud server creation selects a provider-listed matching Ubuntu system image,
public IPv4 and IPv6, a generated Ed25519 enrollment key, non-secret cloud-init,
and strict provider labels that make the request identifiable. The server is
created powered off and remains unbooted and untested by Hivra in this
milestone, so cloud-init has not run and the node is not prepared. Before
preparation or production use, Hivra still requires acceptance evidence for the
pinned image identifier and version plus a real first boot covering cloud-init
completion, generated SSH access, and UFW enforcement. In this canary milestone
Hivra does not request or manage a provider firewall; an existing
Hetzner project policy, including a matching label selector, may still attach
one. The host firewall applies only on a later approved first boot. An
ambiguous or rejected request may leave the Hivra-created project SSH key and
separately billable Primary IPv4 or IPv6 resources. The result directs the user
to reconcile the server, inspect and remove any unused key and retained Primary
IPs in Hetzner Console, and states that Hivra does not auto-delete them in v1.
If a strict provider observation reports `running` or `starting`, the result
instead adds a prominent action to inspect and power off the server in Hetzner
Console immediately. It states that Hivra did not authorize agent launch and
will not power the server off automatically. A verified `off` result remains a
point-in-time observation rather than durable power isolation: Hetzner documents
rare migration or hardware-failure recovery cases in which an off server can be
powered on when its prior state is unknown. Until provider-firewall, boot, and
monitoring acceptance exists, the owner must inspect or delete the resource in
Hetzner Console.

Ordinary connection deletion is rejected while capacity work is `creating`,
while either provider mutation is pending or inside its reconciliation lease,
and for every post-attempt ambiguous request even after that lease expires. For
the last case only, Canary may expose a separate typed force-forget action after
the request becomes idle. That action wipes Hivra's stored token and sole
private key, ends Hivra reconciliation, and preserves the audit record and
account-wide Canary capacity slot. It never calls Hetzner or claims provider
cleanup, so retained servers, Primary IPs, public keys, and billing remain the
owner's responsibility in Hetzner Console.

Long-lived credentials, model keys, and control-plane secrets must not be placed
in cloud-init user data.

Ordinary Hetzner Cloud VMs do not support nested virtualization. They are
provider-VM capacity, not Proxmox/KVM hosts. A compatible workload may run
directly in that provider VM or, after separate acceptance evidence, use an
application-kernel or explicitly labelled shared-kernel driver. The UI must not
claim hardware-VM isolation inside an ordinary cloud VM.

Hetzner Dedicated/Robot is a separate advanced adapter with separate
credentials and ordering semantics. A physical dedicated server can later be
prepared with Proxmox/KVM when its detected capabilities and an explicit
preparation plan support it.

## Existing Server Path

The default existing-server flow asks only for information the user is likely
to know and explains where to find it. Port `22` and user `root` may be hidden
behind Advanced when those defaults apply. The setup should offer a generated
enrollment command or key-file path before falling back to raw private-key and
fingerprint entry.

Manual SSH remains available because it is portable and auditable, but it is an
advanced mechanism rather than the product's front door. A host fingerprint is
still pinned before administrative SSH is trusted; the simpler presentation
must not weaken that security boundary.

After connection, Hivra performs read-only discovery and leads with one plain
outcome:

- ready to run a supported adapter check;
- preparation available, with an exact plan and explicit consent; or
- not yet supported, with the detected limitation and a practical next step.

Raw CPU, memory, virtualization, storage, and engine evidence belongs in an
expandable technical-details section.

## Guides and Links

Every path includes contextual help instead of sending a user to a generic docs
home page. The Hetzner path links directly to:

- Hetzner Cloud: <https://www.hetzner.com/cloud/>
- Hetzner projects: <https://console.hetzner.com/projects>
- API-token guide: <https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/>
- server-creation guide: <https://docs.hetzner.com/cloud/servers/getting-started/creating-a-server/>
- token revocation location in the selected project's **Security > API tokens**
  screen.

Hivra documentation must also explain the difference between a Cloud VM,
Cloud dedicated-vCPU plan, and a physical Dedicated/Robot server. Referral or
affiliate URLs must not be invented; use ordinary official links unless an
approved program and disclosure exist.

## Connection and Launch Boundaries

- Adding a provider token does not buy capacity.
- Buying a server does not launch an agent.
- Discovering a server does not assert launch readiness.
- Preparing a server requires an exact reviewed plan and explicit consent.
- Only current adapter evidence can authorize agent placement.
- Agent launch consumes compatible existing capacity unless a separate,
  bounded create-capacity policy is explicitly approved at action time.
- Hivra Cloud and self-hosted Hivra use the same provider contracts; only
  credential ownership and operational responsibility differ.

## Current and Target Behavior

The repository implements the first Hetzner Cloud connection and bounded-create
slice. A user is asked for a project-scoped Read & Write token; Hivra validates
read access, encrypts the credential, and reports missing write scope only when
an approved mutation proves it. The user can then persist sanitized inventory,
sync it explicitly, select policy-bounded live
offers, obtain a revision-bound short-lived quote, explicitly confirm billing,
and submit one idempotent create request. The operation can report creating,
created powered off, ambiguous, or provider rejected; ambiguous and creating
results are replayed with the same idempotency key. Immediately before the
confirmed POST, the browser persists only a strictly parsed, bounded recovery
record with connection, quote, and idempotency UUIDs. On dialog reopen it
offers an explicit same-request check and never auto-submits after reload. The
record is cleared only after a safely
terminal result or a provider-safe pre-mutation error. Only a successful
provider action followed by a strict provider read of `off` produces the
created result. The resulting inventory remains non-launchable and unprepared.
A failed refresh is persisted while the last successful inventory remains
visibly stale.

Disconnecting a Hetzner connection permanently deletes Hivra's encrypted
project token and its only stored generated server private key. It does not
delete the provider server, Primary IPs, or Hivra-created public key. The
confirmation warns that billing continues and that retained server access may
require Hetzner rescue mode or a rebuild. Ordinary disconnect remains blocked
for active, pending, or post-attempt ambiguous work. An idle post-attempt
ambiguous request has a separate typed Canary force-forget path that wipes local
secrets without provider cleanup and deliberately retains its audit evidence
and account-wide capacity slot.

This code and its automated provider-contract tests are implementation evidence,
not a production-readiness claim. No real approved Hetzner project acceptance
has yet proven create, observe, restart, or delete with no residual resources.
Scoped receipted powered-off cleanup is implemented and deployed on Canary;
its independent review, tests, migration and UI evidence are recorded in
`docs/release/VERIFICATION-STATUS.md`. This is not a completed
real-provider acceptance run. Credential rotation, broader in-product deletion,
provider-VM preparation and launch,
and background sync remain target behavior. Canary can also inspect a generic
SSH host, while an existing supported Proxmox/KVM host is still the only
self-managed path that can proceed through strict preflight, preparation, and
agent launch.

Each implemented milestone must update this paragraph or the product
architecture with exact evidence. A visual card or mocked catalog is not proof
that provider capacity can be purchased or used for an agent.

## Acceptance Criteria

The beginner Hetzner flow is complete only when:

1. a project token can be validated, encrypted, revoked, and deleted without
   being returned or logged; rotation remains required before production-ready
   status;
2. owner isolation and project-scoped inventory are proven by tests;
3. live catalog prices and availability are refreshed at final review;
4. duplicate submissions and reload recovery reuse the same durable request and
   cannot create duplicate billable servers;
5. provider rejection or timeout produces a visible reconciliable operation,
   not an invented success state;
6. a created server appears in Infrastructure only after provider action
   success plus a post-action `off` observation, with its provider resource ID,
   real lifecycle state, size, region, address, and truthful isolation class;
7. deletion semantics distinguish disconnecting Hivra from deleting a billable
   provider resource and disclose permanent loss of Hivra's stored generated
   private key;
8. the original agent catalog and managed Hivra path remain intact; and
9. a real approved Hetzner project passes create, observe, restart, and delete
   acceptance with no residual resource before the feature is described as
   production-ready.
