# Agent network B1: identity and policy (delivered)

**Date:** 2026-10-08

**Status:** Package B1 of [the shared brain and agent network design](2026-10-07-shared-brain-and-agent-network.md)
is built and merged to Canary, behind a server flag that is off on every
deployment that is not Canary. B2 to B6 are not started. This document records
what exists, where the build differs from the design, and what the next
packages inherit. It adds no product claim and no marketing copy.

## Reading rule

Same as the design. **Current** means it exists in this repository at the
revision that merged B1. **Target** means the design proposes it and it does not
exist. Nothing in B1 is visible to a user: no route, page, agent tool or
runtime changed.

## Current

| Area | What exists |
| --- | --- |
| Tenancy (design 6.1) | Organizations, members, groups and principals, each addressed by `(org_id, id)`. Composite foreign keys keep a reference inside its organization; an id may exist in two organizations without being confused. D1 applied: our own tables keyed to the sign-in user ids, no dependency on the provider's organization feature. |
| Organization of one | `hivra_net_ensure_personal_org(user_id)` creates an account's personal organization on first use. Nothing runs it yet and no backfill ran, so no existing account has one. It has exactly one member (its owner), who cannot leave, and the network is off in revision 1. |
| Principals | One per agent instance, with the states `pending`, `joined`, `suspended`, `left` and an enforced transition table (`left` is terminal). D6 applied: a partial unique index allows one live principal per agent identity. The principal references `hivra_canonical_agent_identities (id, user_id)`, so its owner is the identity's owner. Joining is an explicit call by the agent's owner. |
| Policy (design 6.2) | Immutable, gap-free revisions. Settings, groups, group members, brain grants and agent edges are rows valid over a range of revisions; the policy at revision R is every row valid at R. Written only by `hivra_net_publish_policy_revision`. |
| Attenuation | Grants and edges have a `ceiling` layer (organization owner or admin) and a `narrow` layer (the agent's owner). The publish function rejects a narrowing row that exceeds the ceiling, and rejects a member who changes anything but narrowing rows for their own agents. The evaluator also takes the minimum, so a row that slipped past can only lower access. |
| Evaluator | `dashboard/src/lib/agent-network/policy-evaluator.ts`: one pure function, `evaluate(policy, principal, action, resource)`, returning `{ allow, reason, rule, revision, orgId }`. Default deny; a missing, malformed or unknown-revision policy denies; an explicit `none` row beats any allowing row; an `approve` edge returns `allow: false` with `requiresApproval: true`, so a caller that ignores the flag still denies. |
| Request authorizer | `authorize.ts`: deployment flag, request shape, one live read of `hivra_net_authz_context`, revision check, then `evaluate`. Every step that cannot complete denies. Principal state, member state and the newest revision are read live on every call. |
| Audit | `hivra_network_audit`: no INSERT, UPDATE, DELETE or TRUNCATE grant for any role, and a trigger refuses them anyway. Entries arrive only through `hivra_net_append_audit` (service role) and form a per-organization hash chain; `hivra_net_verify_audit_chain` finds a corrupted entry or a gap. Content-free: digest and size, never a body; the function rejects detail keys such as `body`, `token` and `secret`. |
| Agent key | A principal stores a public key and nothing that could hold a private one. `registerPrincipalKey` verifies a proof of possession first and accepts only a raw 32-byte Ed25519 public key. Hivra never holds an agent's private key. |
| Card signing keys | A separate key class (below). `hivra_card_signing_keys` holds public keys and the revocation list; `card-signing.ts` signs and verifies JWS cards (EdDSA over RFC 8785 canonical JSON, at most one hour of life). |
| Responsibility record | `hivra_network_responsibilities`: for the brain service and the broker, the control-plane operator, credential custodian, spend owner, capacity operator, recovery owner and support party, every one declared and none defaulted. |
| Lifecycle effects | Removing a member suspends their joined agents (and drops ones that never finished joining). An agent leaving ends its grants, edges and group memberships in a new revision. Both take effect at the next request. |
| Account deletion | `scripts/delete-user-account.ts` now calls `hivra_net_erase_personal_org`, which erases the user's organization of one with its policy history and audit log. The service role cannot delete these tables directly. |
| Flag | `isAgentNetworkEnabled()` is true only on Canary, from the deployment's own channel, as Slice 2B does. Production needs no environment change to keep it off. |

## Differences from the design

| Design | Built | Why |
| --- | --- | --- |
| Edge has a `direction` field | Edges are directed from sender to receiver; a reply direction is a second edge | Lets the two directions carry different modes and limits, and keeps the narrowing rule one-to-one |
| `org_settings` includes retention and external a2a | Neither is a column | Retention is decision D4, not yet made; cross-organization a2a is a non-goal. Adding a column later is additive |
| Policy objects written one at a time | One call publishes the complete desired policy; the database diffs it against the current policy and authorizes the difference by role | One revision per change, no partial states, and a rollback is publishing an older document. A stale `expectedRevision` is rejected |
| Groups | A group cannot be renamed in v1 | Keeps history immutable; a display-name table can come with the console |
| Access token lifetime "a B1 decision, proposed one hour" | Recorded as `ACCESS_TOKEN_TTL_SECONDS = 3600` | Nothing issues tokens yet; the gateway and broker will |
| "Cards are short-lived" | `MAX_CARD_LIFETIME_SECONDS = 3600`, no leeway on expiry | Same reason |
| Audit chain, signed heads, anchoring (B5) | The chain and its verifier exist; signed heads, export and compaction do not | Retrofitting columns onto an append-only table is awkward, so the chain is in the schema; the rest stays with B5 |

## Key classes

| Key | Held by | Purpose | Never |
| --- | --- | --- | --- |
| `ENCRYPTION_KEY` | The deployment | Seals stored secrets | Used to sign anything in the agent network |
| Card signing key (`HIVRA_CARD_SIGNING_KEY`, `HIVRA_CARD_SIGNING_KID`) | The deployment; public half in `hivra_card_signing_keys` | Signs short-lived agent cards | Derived from, or equal to, `ENCRYPTION_KEY` (the loader refuses an equal value and reads no other variable) |
| Agent key | The agent computer (generated by the agent link) | Proves the agent's identity | Stored, generated or accepted as a private key by Hivra |

Rotation: register the new public key, retire the old one (cards it signed
before retirement stay valid until they expire, and it can sign no new ones),
and revoke it if it is compromised (every card it signed fails at once).

## Verification

Each acceptance criterion and threat has an executable proof. Live acceptance
on Canary has not been run: B1 has no user path, and a real join needs the
package that ships the agent link (B3).

| Id | Proof |
| --- | --- |
| AC-B1-1 | `src/lib/agent-network/__tests__/policy-evaluator.test.ts` (79 rows, including no policy, malformed policy and unknown revisions) |
| AC-B1-2, B1-T2 | `scripts/test-agent-network-schema.cjs` (an id reused in two organizations; a grant, an edge and a direct insert naming another organization's principal all fail); `src/lib/agent-network/__tests__/authorize.test.ts` (context from the wrong organization) |
| AC-B1-3, B1-T3 | `scripts/test-agent-network-schema.cjs` (a member and an admin widening above the ceiling; a member editing a ceiling row, settings, groups or another member's agent; no revision written) |
| AC-B1-4 | `scripts/test-agent-network-schema.cjs` (an organization of one exists, idempotently, with one owner, the network off and no grants or edges) |
| AC-B1-5 | `scripts/test-agent-network-schema.cjs` (anon and authenticated cannot append; the service role cannot insert directly; no role can update, delete or truncate; the chain detects tampering and gaps) |
| B1-T1 | `src/lib/agent-network/__tests__/authorize.test.ts` (revision-skew matrix) and `scripts/test-agent-network-authorization.cjs` (a cache that predates a revoking revision is stale) |
| B1-T4 | `scripts/test-agent-network-authorization.cjs` (suspend, member removal, leave and organization pause each deny at the next request over the real policy tables); `agent-key.test.ts` and `store.test.ts` (private key material is refused) |
| B1-T5 | `src/lib/agent-network/__tests__/card-signing.test.ts` (rotate and verify; revoked and unknown keys fail; tampered, non-canonical, expired and over-long cards fail) |

The proofs were each checked by breaking the code they guard (attenuation,
member authorization, the audit grant, narrowing, deny-overrides, live state,
revision skew, revocation) and confirming a test fails.

## Rollout

- Canary database: the migration `20261008100000_agent_network_identity_policy`
  is additive and changes no existing object.
- Production: the migration is part of the next Promote packet; nothing reads
  it, and the flag is false there.
- Existing computers and customers: unaffected. No runtime, provisioner, box or
  customer-facing surface changed.

## What the next packages inherit

- **B2 (brain service)** needs decision D2 (hosting and spend). It reads grants
  through `hivra_net_authz_context` and must call `authorizeNetworkRequest` on
  every request.
- **B3 (join and attach)** is the first writer of organization rows for real
  accounts. It issues the one-time nonce for the key proof, consumes it once,
  and issues access tokens (lifetime constant above). It must call
  `ensurePersonalOrg` before `beginJoin`.
- **B5 (a2a broker)** keeps its own entry gate. It signs chain heads, exports
  and compacts the audit log, and decides what to audit per message. The
  hash-chain schema is here.
- **B6 (console)** adds role changes, group renames and the effective-reach view.
- Open: whether an agent that left an organization may be re-added by its
  owner without an admin (today it joins as a new principal and needs a fresh
  key), and the retention decision D4.
