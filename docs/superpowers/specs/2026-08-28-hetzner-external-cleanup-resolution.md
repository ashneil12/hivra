# Verified external cleanup of an ambiguous Hetzner purchase

Status: implementation design under the approved portable-deployment work;
not shipped or live-accepted. This closes a current recovery gap, not a change
to original resource ownership or the account capacity limit.

## Narrow owner action

An authenticated owner explicitly selects **Verify external cleanup** on an
ambiguous purchase. The server uses the original bound project credential and
revision. This operation never purchases, boots, deletes, or adopts a resource.
It cannot resolve a purchase whose server identity is unknown, whose original
SSH key was not accepted, or which reached preparation/allocation.

Admission requires the original known server and generated key IDs, no original
creation receipt, no first-boot operation, no enrolled host, no deployment target
or agent, no cleanup, and expired original dispatch/reconciliation windows.
The existing ambiguous lifecycle and error remain intact.

Because original IP receipts are missing, this bounded version requires the
entire original project to have **zero servers and zero Primary IPs**. It checks
exact server/key IDs for provider JSON `not_found`, and checks strict complete
empty first-page inventories. Nonempty, incomplete, stale, redirected, malformed,
unauthorized, or unavailable evidence cannot release the slot. Unrelated SSH
keys, firewalls, and other project resources are not touched. A nonempty project
needs a future, separately specified recovery path; this one never guesses which
unreceipted IP belongs to the order.

## Durable resolution

The backend obtains an owner/order/connection/revision-bound pre-state digest,
performs bounded read-only provider checks, and commits within a short freshness
window. A restricted idempotent transaction locks the connection then order,
rechecks the exact state and eligibility, appends an immutable resolution ledger,
revokes bootstrap/enrollment secrets, and attaches the resolution marker. It
does not reconstruct a POST receipt or populate automatic cleanup success.

The partial capacity index excludes only orders bearing a valid resolution;
the DTO applies the same rule. The UI says **External cleanup verified**, reports
the released slot, and retains the original failure. Original-key replay returns
that history without contacting or mutating the provider. Late order writes,
first-boot authority, and stale inventory cannot resurrect resolved capacity.
The owner can later disconnect the credential without deleting the ledger.

## Required proof

- Real SQL: wrong owner/connection/revision, unknown IDs, receipt/boot/target/agent
  presence, active dispatch, changed pre-state, stale/future evidence, conflicting
  replay, immutable ledger/order, late callbacks, and unchanged other claims.
- Provider client: exact JSON absence only; strict complete-empty pagination;
  nonempty/incomplete/error responses fail closed; GET-only fixed origin.
- Service and route: no client-supplied evidence or resource IDs, owner-bound
  credential, revision and time checks, same-origin/auth/body/rate limits.
- UI: explicit action, factual result/error, no auto-retry or new purchase,
  responsive padding and useful return to the normal capacity flow.
- Independent high-risk review and revision-bound Canary check. The actual
  manually cleaned test may then exercise this path; normal automatic teardown
  still requires a new complete deployment test.

Rollback must preserve the ledger and resolved history. Do not roll back the
database by deleting resolution rows or restoring a bootstrap credential.
