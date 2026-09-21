# Tailscale Private Access Design

**Date:** 2026-04-20

**Status:** Proposed

## Summary

Add native Tailscale support to the existing dashboard as a **customer-owned private access feature**.

The v1 design is intentionally conservative:

- Hermes does **not** own the customer's tailnet
- Hermes does **not** become responsible for Tailscale billing
- Hermes does **not** replace the current public instance URL model
- Hermes does **not** use Tailscale Funnel by default
- Hermes does **not** store long-lived Tailscale auth keys after setup

Instead, Hermes gives the customer a guided way to attach their host to **their own** Tailscale network from inside the dashboard, using the same visual language and settings model as the rest of the product.

This gives users a much better private-access story without breaking the existing dashboard and gateway flows that still depend on one stored `gateway_url` per instance.

## Why this shape is best

The current codebase treats the instance `gateway_url` as the main remote control surface in many places:

- instance health checks
- official dashboard handoff
- integrations
- terminal/browser helper routes
- model and streaming routes

Because of that, the safest first release is **not** "replace public URL with Tailscale".

The safest first release is:

1. Keep the current public web path working
2. Add Tailscale as a clearly safer **private/admin access lane**
3. Keep Tailscale ownership with the customer

That is the best middle point between:

- easy for non-technical users
- flexible enough for developers
- low support burden
- low billing liability
- low regression risk

## Goals

- Let a customer enable Tailscale from the normal dashboard UI
- Keep setup short and understandable for non-technical users
- Preserve enough advanced control that developers do not feel boxed in
- Treat Tailscale as a real security improvement, not marketing garnish
- Avoid introducing a long-lived shared secret burden into Hermes
- Avoid breaking any existing feature that relies on `gateway_url`

## Non-goals

- Replacing Hermes dashboard auth with Tailscale
- Making Tailscale mandatory for all customers
- Running Hermes-managed Tailscale networks on behalf of customers
- Using Tailscale Funnel as the default product path
- Re-architecting the app around a Tailscale-only routing model in v1

## Product decision

### Recommended v1

Ship **customer-owned Tailscale enrollment for private host access**, surfaced on the instance settings screen.

The user experience is:

1. User opens an instance in the dashboard
2. User goes to the normal configuration/settings area
3. User sees a new **Tailscale Private Access** panel
4. User clicks **Enable Tailscale**
5. User pastes a Tailscale auth key from their own tailnet
6. Hermes installs and configures Tailscale on the host
7. Hermes shows connection status, machine name, private network details, and optional Tailscale SSH state

### Important v1 scope choice

In v1, Tailscale is primarily a **private host access and Tailscale SSH feature**, not a replacement for the instance's public web URL.

That means:

- the existing public instance URL remains the app's primary browser entry point
- Tailscale gives the customer a private network path to the host
- Tailscale SSH can be enabled for secure admin access without exposing SSH publicly
- the dashboard clearly explains that Tailscale is the safer private/admin route

This is the right first step because it is strong security value with low product risk.

## UX design

### Placement

Add a new panel to the existing instance configuration UI in the same style as the rest of the dashboard.

Recommended placement:

- [dashboard/src/app/dashboard/instances/[id]/console/tabs/ConfigurationTab.tsx](/Users/example/Projects/Hermesdeploy/dashboard/src/app/dashboard/instances/[id]/console/tabs/ConfigurationTab.tsx)
- new panel component beside the existing host/collaboration panels

Suggested panel title:

- `Tailscale Private Access`

Suggested helper copy:

- `Connect this host to your own Tailscale network for safer private access and optional Tailscale SSH.`

### Default state

When Tailscale is not configured:

- short explanation of what it does
- one primary action: `Enable Tailscale`
- one sentence clarifying ownership:
  - `Uses your own Tailscale account and network. Hermes does not manage your tailnet.`

### Setup state

Default visible input:

- `Tailscale auth key`

Collapsed advanced section:

- optional machine name override
- optional tags
- optional `Enable Tailscale SSH`

Default UX principle:

- keep the normal path short
- keep the advanced path available but hidden until asked for

### Connected state

Once connected, show:

- connection status
- machine name
- MagicDNS hostname if available
- Tailscale IPs
- whether Tailscale SSH is enabled
- actions:
  - `Reconnect`
  - `Disable Tailscale`

Also show a small security note:

- `Public web access still works separately. Tailscale is the safer private/admin route.`

### Error state

Error copy should be plain English, not infrastructure jargon.

Examples:

- `Tailscale installed, but this host could not join your network. Double-check the auth key and try again.`
- `This host joined Tailscale, but SSH could not be enabled automatically. You can still use private network access.`

## Shared-host behavior

This part matters.

Tailscale is a **host-level** feature, not a container-only feature in this architecture.

If a user has multiple instances sharing one host, enabling Tailscale affects the host those instances run on.

So the UI must say this clearly when applicable:

- `This setting applies to the underlying host used by this instance.`

If we can detect sibling instances on the same host, the panel should also mention that the host is shared.

This keeps the feature honest and prevents surprise.

## Security defaults

### Customer-owned networking

The customer must bring their own Tailscale network.

Reasons:

- avoids Hermes paying for customer networking
- avoids confusing ownership boundaries
- avoids Hermes becoming the operator of customer private networks
- matches enterprise expectations better

### No Funnel by default

Do **not** use Tailscale Funnel in v1.

Reason:

- Funnel makes a service public again
- this feature is supposed to improve private/admin access, not create a second public path

### Do not store the raw auth key long-term

The setup flow should treat the auth key as a **transient setup secret**.

Recommended behavior:

1. receive the auth key through a dedicated setup endpoint
2. use it immediately to join the host to the customer's tailnet
3. discard it after setup succeeds or fails
4. store only non-secret metadata needed for status display

This is one of the most important design decisions in the whole feature.

It means reconnecting or re-enrolling later may require the user to provide a fresh key again, which is acceptable for v1 and significantly safer.

### Prefer safer auth key guidance

The UI should recommend:

- one-time or short-lived auth key when possible
- tag-based keys for server enrollment

It should not force users to understand all of Tailscale's terminology, but it should nudge them toward good practice.

### Optional Tailscale SSH

Offer Tailscale SSH as an advanced toggle.

Reason:

- strong security value for developers and operators
- not every user needs it
- should not clutter the main setup path for non-technical customers

## Data model

Do **not** overload this into `agentSettings`.

Tailscale is infrastructure/private-access state, not normal agent runtime behavior.

Recommended additive config shape:

```ts
config.privateAccess = {
  tailscale: {
    enabled: boolean,
    hostScoped: boolean,
    state: "disconnected" | "connecting" | "connected" | "error",
    machineName?: string,
    magicDnsName?: string,
    tailnetName?: string,
    ipv4?: string,
    ipv6?: string,
    sshEnabled?: boolean,
    tags?: string[],
    connectedAt?: string,
    lastError?: string | null
  }
}
```

Important:

- store metadata only
- do not store the raw auth key in instance config

## API design

Recommended instance-scoped API surface:

- `GET /api/instances/[id]/private-access/tailscale`
  - returns current status and stored metadata
- `POST /api/instances/[id]/private-access/tailscale`
  - accepts transient setup payload
  - installs/configures Tailscale on the host
  - stores resulting metadata
- `DELETE /api/instances/[id]/private-access/tailscale`
  - disconnects Tailscale from the host for this managed setup path
  - clears stored metadata

Suggested POST payload:

```ts
{
  authKey: string
  machineName?: string
  tags?: string[]
  enableSsh?: boolean
}
```

## Host orchestration design

Implementation should happen at the host layer, alongside the existing SSH-driven deploy and redeploy model.

Recommended service responsibilities:

- install Tailscale if missing
- enable/start `tailscaled`
- enroll the host using the provided auth key
- optionally enable Tailscale SSH
- query status using `tailscale status --json` or equivalent
- store non-secret metadata in Supabase

Command construction should avoid leaking the auth key into shell history or logs more than necessary.

At minimum:

- pass the key via environment variable instead of embedding it into a saved script file
- avoid writing the key to long-lived host files
- redact it from error/reporting paths

## Browser and URL behavior

### v1 rule

The current `gateway_url` stays unchanged and remains the primary web surface for the app.

This is deliberate.

Many existing features directly call or derive behavior from the current `gateway_url`, including:

- health checks
- browser sessions
- integrations
- official dashboard handoff
- streaming and model routes

Changing that contract in the first Tailscale release would create unnecessary regression risk.

### Future enhancement

If we later want a true private Tailscale web URL inside the product, that should be a follow-up phase after we fully map:

- single-instance host behavior
- shared-host behavior
- safe per-instance routing over a host-level Tailscale attachment

That work should not be bundled into v1.

## Copy principles

All user-facing copy should be plain English.

Avoid:

- tailnet
- ACL jargon
- MagicDNS jargon without explanation
- "advertise tags" language in the main path

Prefer:

- `your Tailscale network`
- `private access`
- `host name`
- `developer options`

Advanced copy can expose more precise terms for users who need them.

## Rollout plan

### Phase 1

Ship:

- dashboard panel
- host enrollment
- status display
- optional Tailscale SSH
- remove/reconnect actions
- clear host-scoped messaging

### Phase 2

Only after Phase 1 is stable, consider:

- richer diagnostics
- customer guidance links
- optional private web entrypoint over Tailscale
- stronger host-sharing intelligence
- automated short-lived key minting via customer-side OAuth client flow

## Testing strategy

Add regression coverage in four areas:

### 1. UI tests

Cover:

- disabled state
- setup state
- connected state
- error state
- advanced drawer behavior
- shared-host warning copy

### 2. API route tests

Cover:

- auth required
- user ownership enforcement
- happy path setup
- setup failure
- delete/reset path
- no raw auth key echoed back in responses

### 3. service tests

Cover:

- install command generation
- `tailscale up` command generation
- redaction of secrets in errors
- status parsing
- SSH enable/disable behavior

### 4. safety tests

Cover:

- existing `gateway_url` remains unchanged after Tailscale setup
- no existing health/integration/dashboard routes regress
- shared-host metadata is preserved correctly

## Risks

### Risk: users think Tailscale replaces dashboard auth

Mitigation:

- explicit copy that Tailscale is an extra private-access layer
- no wording that implies it replaces app auth

### Risk: long-lived key leakage

Mitigation:

- transient setup-only handling
- no raw key persistence
- redaction in logs and API errors

### Risk: confusing host-scoped behavior

Mitigation:

- explicit messaging in the panel
- detect and display shared-host context where possible

### Risk: trying to solve private web routing too early

Mitigation:

- keep v1 focused on secure enrollment and host access
- defer private web URL behavior to a later, more deliberate phase

## Final recommendation

Ship Tailscale as a **guided, customer-owned, host-scoped private access feature** in the existing dashboard UI.

That is the best middle ground for this product right now:

- simple enough for non-technical users
- respectable for developers
- meaningfully better for security posture
- low billing and ownership burden for Hermes
- low regression risk against the current gateway-based architecture
