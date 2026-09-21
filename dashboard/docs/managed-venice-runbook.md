# Managed Venice Runbook

<!-- SCRIPTURE_ANCHOR: runbook-write | Deuteronomy 31:19 | Verse: Now therefore write this song for yourselves, and teach it to the children of Israel. -->

This runbook covers the managed Venice path where HermesOS holds the Venice API key server-side, issues prepaid proxy keys to users, and deducts from the selected dashboard wallet.

## Launch Gates

- Confirm `VENICE_API_KEY`, `MANAGED_VENICE_PROXY_KEY_PEPPER`, `CRON_SECRET`, and `MANAGED_VENICE_SETTLEMENT_SECRET` are set in production.
- Confirm $HermesOS deposits fail closed until the primary price feed is fresh and the independent cross-check is available.
- Confirm `/api/ops/managed-venice/subsidy` is returning daily burn, weekly burn, top subsidy users, per-model spend, and kill-switch alert state.
- Confirm the wallet UI shows $HermesOS credit lots, card credits, proxy key prefixes only, launch cap usage, and kill-switch messaging.
- Get legal/accounting review before public launch: token-funded prepaid service terms, no-refund token deposit language, discount copy, financial-event retention, and treasury reserve policy.

## Venice Server Key Rotation

Scheduled rotation target: monthly.

1. Generate a new Venice API key in Venice.
2. Add the new value to production as `VENICE_API_KEY`.
3. Redeploy the dashboard.
4. Run a small managed Venice chat completion through a test proxy key.
5. Confirm settlement records a `managed_venice_usage_events` row and a `usage_capture` financial event.
6. Revoke the old Venice key after the new key is live.

Emergency rotation target: under one hour from decision to new key live.

1. Set `VENICE_API_KEY` to the new Venice key immediately.
2. Redeploy.
3. Temporarily pause new proxy key creation if compromise scope is unclear.
4. Review recent managed Venice usage, top spenders, and reconciliation items.
5. Revoke affected user proxy keys if user-side key leakage is suspected.

Never expose the Venice server key to user systems, logs, client bundles, screenshots, or proxy key responses.

## Proxy Key Compromise

1. Identify the affected proxy key prefix and user account.
2. Revoke the proxy key through the managed Venice key API or database admin path.
3. Check the user's reservations, usage rows, and financial events for unusual spend.
4. If final usage is missing or upstream billing cannot be proven, move the reservation to reconciliation rather than guessing.
5. Ask the user to create a replacement proxy key from the dashboard.

Proxy key logs must include safe IDs, prefix, user ID, reservation ID, model, cost, and settlement status. They must not include prompts, full responses, plaintext proxy keys, or Venice keys.

## Weekly Kill Switch

Threshold: `$1000/week` aggregate subsidy value.

Alerts:

- 50%: watch subsidy velocity and top users.
- 80%: prepare launch-wave communication and consider manual early step-down.
- 100% or manual trigger: launch-wave spend steps down to the 10% standard discount for all new spend.

Communication when fired:

- Show an in-app banner to users with a $HermesOS wallet balance.
- Email users who used managed Venice in the past 7 days.
- Use the approved wording: demand exceeded launch wave allocation.
- Do not claw back already-applied discounts.

The kill switch and the per-user $250 launch cap both step users to 10%; they do not chain to 0%.

## Reconciliation Queue

Use reconciliation when HermesOS cannot prove the exact billable amount.

Common causes:

- Venice response or stream completed without final `usage`.
- Upstream returned a partial/billable error.
- Reservation capture failed after Venice accepted the request.
- Late token deposit confirmation missed the 60-second quote window.

Operator flow:

1. Review the reservation, usage event, upstream status, and financial events by `reference_id`.
2. Compare against Venice billing if available.
3. If Venice charged, capture the actual consumed amount and release only the unused reservation.
4. If Venice did not charge, release the full reservation.
5. Record the action as a reconciliation adjustment and close the queue item.

Do not patch reconciliation by retrying upstream calls. The user already got or failed to get that inference response; reconciliation is accounting repair.

## Treasury Reserve

Target: maintain a USDC operational reserve covering at least 30 days of expected Venice spend.

- Review token-in vs Venice-cost-out daily for the first two weeks after launch.
- Sell $HermesOS to USDC in weekly batches to maintain the reserve floor.
- Do not sell reactively on every Venice invoice.
- If $HermesOS price drops sharply enough that maintaining the reserve risks a reflexive selloff, pause new launch-wave discounts until the reserve target is restored.

## Account Deletion

Account deletion removes managed Venice wallet, reservation, key, quote, usage, and reconciliation rows in dependency order.

`managed_venice_financial_events` is intentionally append-only and is not included in the deletion table list in v1. Treat it as financial/accounting retention data until legal review says a different anonymization process is required.
