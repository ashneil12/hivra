# Canary holder lifecycle fixture

This is an operator-only fixture, not a plan, wallet qualification or product
availability claim. It is off by default and must stay unset in production.
It needs the reviewed holder placement schema and the QA admission migration.
Neither enabling access nor applying a live migration is part of merging its code.

After separately authorised Canary setup, set the single row in the Canary
database's `hivra_canary_qa_holder_settings` table. Set `enabled` to true,
`owner_id` to the exact authorised standing owner, `host_id` to the only
authorised host, and `expires_at` to a UTC deadline no more than 24 hours
ahead. The allocator does not spill to other hosts. The deployed app can only read the row
and only honors it on canonical Git Canary. A disabled or expired row takes
precedence over all environment settings.

If the table has no row, the existing deployment settings still work as a
fallback. An unavailable database read does not fall back to environment:

| Variable | Value |
| --- | --- |
| `HIVRA_CANARY_QA_HOLDER_ENABLED` | `true` |
| `HIVRA_CANARY_QA_HOLDER_USER_ID` | The exact Clerk user ID of one authorised standing QA account |
| `HIVRA_CANARY_QA_HOLDER_EXPIRES_AT` | An absolute UTC ISO timestamp with milliseconds, no more than 24 hours ahead |

Use an existing standing account with no occupied agent slot or real holder
qualification/admission. The account can have a paid plan; leave it unchanged.
Ordinary launches, including ones with the fixture's exact name, use real
entitlements as usual. Only the explicit QA operation selects this fixture.

From an authorised same-origin session, submit a managed Hermes launch named
exactly `Canary holder QA` with 2 vCPU, 4 GB RAM, no template or model override,
and no Hivra credits. Send the exact header `x-hivra-canary-holder-qa: 1` to
the authenticated `POST /api/hivra/agents` route. A present but invalid header
or unauthorised QA request is refused, never retried as a paid launch. The
database allows only one non-deleted fixture and
requires a normal available account slot, the holder cohort's CPU/RAM
ceiling, an eligible host with space, and no eligible holder waiting ahead.
The ordinary automatic sleep, named wake, and managed provisioning prerequisites
still apply. The computer's holder funding and the audit deadline are immutable;
the deadline is stored on that one lifecycle row, not on the account.

On the verified Git-served revision, run the agreed launch → idle nap → hibernate
→ authenticated wake check through the public access path. Record only
sanitised evidence. Stop and delete the exact fixture you created, then verify
its allocation and access are gone. A failed launch occupies the fixture slot
until its lifecycle record is cleaned up.

Expiry, disabling the row or fallback flag, changing the configured account, or leaving the
canonical Canary deployment blocks new fixture admissions and further start or
wake requests. Vercel environment changes take effect on the Git deployment
that serves those settings; the persisted deadline applies to the current
deployment without a rebuild. Changing the configured deadline cannot extend
an existing seat. Work already admitted can settle, and an already running VM
is not deleted on revocation.
If live lapse enforcement is enabled, the Canary sweep stops a revoked running
fixture without billing email; otherwise, use the normal stop/delete actions.
Disable the row after the test, or remove it after verifying no fallback
environment settings can grant access. Keep production settings unset.
