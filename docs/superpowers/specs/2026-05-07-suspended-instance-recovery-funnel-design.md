# Suspended Instance Recovery Funnel Design

## Goal

When an agent is stopped by entitlement enforcement, the dashboard should say why it stopped and give the user a polished path to recover: re-enable compute, restart after fixing billing, or upgrade for better capacity.

## User Experience

Stopped instances that are also `lifecycle_state="suspended"` render a dedicated recovery panel instead of the generic "Agent Offline" state. The panel shows a clear reason:

- `entitlement_reason="insufficient_credits"` -> compute credits ran out.
- `entitlement_reason="token_holding_below_minimum"` -> token eligibility dropped below the qualifying amount.
- unknown suspended reason -> agent was paused and needs billing or support review.

The panel includes:

- a calm headline and direct explanation that the agent data is retained,
- a primary "Re-enable compute" link to billing with the instance id,
- a secondary "Upgrade for more compute" link to billing,
- a "Restart agent" button for users who already fixed eligibility,
- a compact perks rail explaining why upgrading is the better long-term path.

## Data Flow

The dashboard already reads `hermes_instances` rows with `select("*")`, but the shared TypeScript instance types do not expose entitlement fields. Add these fields to the instance type surfaces:

- `entitlement_state`
- `entitlement_reason`
- `entitlement_grace_started_at`
- `entitlement_grace_ends_at`
- `entitlement_suspended_at`

No secret or billing balance is exposed. The UI only uses reason/state strings that already drive lifecycle enforcement.

## Error Handling

The recovery panel must not block restart. If the reason is unknown, it falls back to a neutral "paused" message. Billing links are plain dashboard links, so a billing route failure is handled by the billing page itself.

## Testing

Add focused component tests for the recovery panel:

- credit-suspended instances show the credit reason, re-enable CTA, upgrade CTA, retained-data reassurance, and restart action.
- token-suspended instances show the token eligibility reason.
- non-suspended stopped instances continue to use the generic start path.
