# HermesOS v2 Build Plan

> **Historical document — superseded 2026-08-24.** Do not execute this plan as current product direction. Use `VISION.md`, `docs/PRODUCT-ARCHITECTURE.md`, `ROADMAP.md`, and `docs/superpowers/specs/2026-08-24-hivra-agent-computers-design.md`. This file remains for implementation history and evidence only.

*Working document. Update as decisions land. Last updated April 28, 2026.*

---

## Locked decisions

### Architecture
- **Credits** are the user-facing balance. Everyone has them.
- **$HermesOS** is access (tier threshold), discount (cheaper subs), and future microtxn rail.
- **Stripe** for card path (top-ups and subscriptions).
- **Bankr** for crypto path: non-custodial wallet provisioning, balance reads, deposit detection.
- **Proxmox** on Hetzner AX41 for compute.
- **x402** designed-for, not enabled in v1. Ledger and entitlement engine built so it slots in cleanly later.

### Tiers and pricing

| Tier | vCPU | RAM | Card monthly | $HermesOS monthly (30% off) | $HermesOS yearly (40% off card annualised) | $HermesOS hold (TBD) |
|------|------|-----|--------------|------------------------------|---------------------------------------------|----------------------|
| Free | 0.5 | 1GB | Free | Free | Free | Small threshold |
| Pro | 2 | 4GB | £9.99 | £6.99 | £71.88 | Mid threshold |
| Power | 4 | 8GB | £24.99 | £17.99 | £179.88 | High threshold |

Optional Ultra (8 vCPU / 16GB) added post-launch only if demand justifies.

**Discount logic:**
- Card monthly is the headline price. Don't inflate it.
- $HermesOS monthly is 30% off card monthly. Real reason to use the token, healthy margin preserved.
- $HermesOS yearly is 40% off the card annualised. Drives commitment, locks in revenue, gives you the "40% off" headline number where it actually makes sense.

### Resource caps (not session timers)

Agents run as long as the user wants. Abuse caught by resource caps and behavioural rules.

**Free tier:**
- CPU: 0.5 vCPU hard cap, no burst
- RAM: 1GB hard cap, OOM kill if exceeded
- Storage: 5GB
- Outbound bandwidth: 50GB/month
- Outbound request rate: 60/min
- Concurrent agents: 1
- Priority: low (queueable, throttleable under load)

**Pro tier:**
- CPU: 2 vCPU
- RAM: 4GB
- Storage: 25GB
- Outbound bandwidth: 250GB/month
- Outbound request rate: 300/min
- Concurrent agents: 3
- Priority: medium

**Power tier:**
- CPU: 4 vCPU (burstable to 6 if node has capacity)
- RAM: 8GB
- Storage: 75GB
- Outbound bandwidth: 1TB/month
- Outbound request rate: 1000/min
- Concurrent agents: 6
- Priority: high

**Behavioural kill rules (all tiers):**
- Free tier CPU at 100% sustained 60s+ → throttle, then suspend if continuous
- 3+ container crashes in 24h → pause, require manual restart
- Outbound TOR/proxy traffic → flag and review
- Known mining pool DNS lookups → block and notify user
- Network rate limit breach → throttle, then suspend after repeated breach
- Repeated TOS violations → permanent suspend

**Oversubscription targets:**
- Free: up to 6:1 on CPU, watch RAM headroom
- Pro: 2.5:1 on CPU, 1.5:1 on RAM
- Power: 1.5:1 on CPU, 1:1 on RAM (these users expect headroom)

### Token deposit mechanic (no lock)

- User gets a Bankr-provisioned wallet (non-custodial, they hold keys)
- Send $HermesOS into wallet to maintain tier threshold
- Withdraw anytime
- If balance drops below threshold: 48h grace period, then instance suspend, then 7 days later instance delete
- UI clearly shows: "If your balance drops below X $HermesOS, your instance pauses in 48h"
- Threshold defined in $HermesOS units, not USD, so price moves don't trigger pauses
- Email notifications at threshold breach, 24h-to-suspend, suspend, delete-warning

### Forbidden language (run all posts through this)

Never:
- "earn", "yield", "rewards", "passive income", "accrue"
- "buy now to be early", "first movers", "early supporters benefit"
- "holders benefit from activity"
- "lock for X to receive Y" framing
- Discussion of price, market cap, token activity, holders count, rankings
- Reservation framed as gated by token holding

OK to say:
- "access mechanism"
- "pay with $HermesOS for a discount"
- "hold $HermesOS to maintain your tier"
- "reserve your spot on the waitlist"
- Product features, deployment flow, capabilities, integrations

---

## Sprints

### Sprint 0: Foundation (now → Wednesday EOD)

**Goal:** Proxmox provisioning stable end-to-end. Reservation page live for Thursday podcast.

**Claude Code tasks:**
1. Fix Proxmox socket issue in production environment
2. End-to-end test: create instance, suspend, resume, delete, all programmatic, all under 5 seconds each
3. Per-instance metering: CPU time, RAM peak, disk used, runtime hours, network out
4. One-account-one-free-instance enforcement at provisioning layer
5. Admin kill switch: force suspend, force delete by user_id
6. Verify metering numbers match Hetzner billing within 5%

**Other tasks:**
1. Reservation page at hermesos.cloud/reserve
   - Email capture
   - Tier intent ("I want Free / Pro / Power")
   - Position in queue display
   - Soft launch date
2. Twitter post drafted, run through forbidden language check, scheduled for Thursday
3. Reservation list goes to a Postgres table, ready for invite waves

**Done when:**
- Backend can create, suspend, delete real Proxmox VMs reliably
- Metering matches Hetzner usage data
- Reservation page live and accepting signups
- 50+ reservations within 48 hours

---

### Sprint 1: Credits ledger + Stripe (week of May 4-10)

**Goal:** Card path working end-to-end. Balances are reliable, ledger is sound.

**Claude Code tasks:**

Database schema:
- `credit_accounts` (user_id, balance_pence, currency='GBP')
- `credit_ledger_entries` (id, account_id, amount_pence, type, source, reference_id, created_at)
- `payment_transactions` (id, stripe_event_id UNIQUE, amount_pence, status, user_id)
- All append-only. Balance is derived from sum of ledger entries (not stored separately as truth).

Stripe integration:
- Stripe Checkout for top-ups (£10, £25, £50, £100 packages)
- Stripe Subscription products for Pro (£9.99/mo) and Power (£24.99/mo)
- Webhook handler with idempotency by stripe_event_id
- On successful payment: append credit ledger entry within same transaction
- Subscription cancellation triggers entitlement engine (Sprint 2) to start grace

Admin tools:
- View user's full ledger
- Manual credit/debit (logged with admin user_id)
- Reconciliation report against Stripe

Dashboard UI:
- Balance display top right
- Transaction history page
- Top-up button → Stripe Checkout
- Manage Subscription → Stripe Customer Portal

**Test cases that must pass:**
- Stripe webhook fires twice (network retry) → only one ledger entry (idempotency)
- Stripe payment fails → no ledger entry, error shown
- Balance always equals sum of ledger entries (invariant test)
- Subscription cancel mid-month → entitled until end of paid period

**Done when:**
- 5 test users top up via Stripe with correct balances
- 3 test users on Pro subscription, billed monthly correctly
- Manual reconciliation against Stripe dashboard matches 100%

---

### Sprint 2: Entitlement engine (week of May 11-17)

**Goal:** Decouple tier access from payment method. Provisioning asks "what is this user entitled to?" and gets a clean answer.

**Claude Code tasks:**

Tier definitions in config (not code):
- JSON or YAML file with all tier specs
- Loaded at startup, hot-reloadable

Entitlement check function:
```
getEntitlement(user_id) → {
  tier: 'free' | 'pro' | 'power',
  can_provision: boolean,
  should_pause: boolean,
  should_delete_at: timestamp | null,
  reason: string,
  source: 'stripe_sub' | 'token_balance' | 'free'
}
```

Inputs:
- Active Stripe subscription
- Credit balance vs tier minimum
- $HermesOS balance vs tier threshold (Sprint 3)
- Grace period state

Provisioning service refactor:
- Every action checks entitlement first
- If entitlement says pause: pause within 5 minutes
- If entitlement says delete: queue for deletion at given timestamp

Grace period state machine:
- active → grace_started → grace_warning_sent → suspended → delete_warning_sent → deleted
- 48h grace before suspend
- 7d after suspend before delete
- Email notifications at each transition

**Test cases:**
- User cancels Stripe sub mid-month → keeps tier until end of paid period, then 48h grace, then suspend
- User's credit balance hits zero mid-month → 48h grace, email, then suspend
- User tops up during grace → grace cancelled, returns to active

**Done when:**
- Entitlement function is the only place tier is decided
- All provisioning routes through entitlement
- 5 downgrade scenarios work end-to-end with email at each transition

---

### Sprint 3: Token verification (week of May 18-24)

**Goal:** $HermesOS holders get tier access automatically based on wallet balance.

**Claude Code tasks:**

Bankr partner API integration:
- Wallet provisioning at signup (background job, doesn't block UX)
- Store user's Bankr wallet address against their account
- Non-custodial: user holds keys

$HermesOS balance read:
- On-chain via Bankr API or direct Base RPC fallback
- Cache 5 minutes per user (don't hammer chain)
- Snapshot to `token_holding_snapshots` table every 6 hours per user

Threshold logic:
- Config: `pro_threshold_tokens`, `power_threshold_tokens`
- Add to entitlement engine inputs
- User holds threshold → tier unlocked
- User drops below → grace period via existing engine

Wallet UI:
- Show $HermesOS balance, current tier, threshold for next tier
- Deposit address visible, copy button
- Clear warning: "If your balance drops below X tokens, your instance pauses in 48h"

**Threshold calibration (TBD before launch):**
- Base on current token supply and market cap
- Pro threshold should be meaningfully more than free, less than power
- Calibrate so that Pro threshold is roughly equivalent to 6-12 months of Pro subscription cost

**Test cases:**
- User holds threshold → has Pro access
- User sells 30% but stays above threshold → still Pro
- User sells below threshold → 48h grace → suspend → email at each step

**Done when:**
- 5 test wallets at various balances correctly mapped to tiers
- Snapshot recheck runs reliably every 6h
- Withdrawal-triggered grace period verified end-to-end

---

### Sprint 4: Crypto top-ups + token subscription path (week of May 25-31)

**Goal:** Pay subscriptions or top up credits with $HermesOS, get the bonus.

**Claude Code tasks:**

Deposit detection:
- Watch user's Bankr wallet for incoming $HermesOS and USDC transfers (Base only)
- On detection: oracle price check, convert to GBP value, append credit ledger entry
- Apply $HermesOS bonus (configurable, start at 30%)
- Sweep funds to treasury wallet asynchronously

Token subscription path:
- User selects "Pay with $HermesOS" on Pro or Power subscription
- Monthly: debit £6.99 / £17.99 equivalent in $HermesOS from wallet on billing date (30% off card)
- Yearly: lump sum debit £71.88 / £179.88 equivalent in $HermesOS, entitled for 12 months from payment (40% off card annualised)

UX:
- "Pay with $HermesOS" button on subscription page
- Show conversion rate clearly
- Show savings vs card price ("save 30% monthly" / "save 40% yearly")

**Test cases:**
- USDC top-up of $100 → 100 credits added (1:1)
- $HermesOS top-up of $100 worth → 130 credits added (with bonus)
- Token monthly subscription debits correctly at 30% off
- Token yearly subscription debits correctly at 40% off annualised
- Failed transactions don't create ledger entries

**Done when:**
- 5 test users have topped up via $HermesOS
- 3 test users on $HermesOS monthly subscription
- 1 test user on $HermesOS yearly subscription
- Oracle price feeds working with fallback path

---

### Sprint 5: Closed beta (week of June 1-7)

**Goal:** Invite first reservations. Find bugs. Measure real usage.

- Invite first 20 reservations from waitlist
- Monitor real per-instance utilisation
- Bug bash from real user behaviour
- Adjust oversubscription ratios based on data, not theory
- Identify and fix conversion friction points

**Metrics to track:**
- Avg CPU per Pro user (want <50% sustained)
- Avg RAM per Pro user (want <70% peak)
- Free → Pro conversion rate
- Token-path vs card-path uptake
- Monthly vs yearly $HermesOS uptake
- Support ticket volume per user
- Time to first agent deployed
- 7-day retention

---

### Sprint 6: Public launch (week of June 8-14)

**Goal:** Open free tier. Active marketing. First operator pack live.

- Free tier publicly available
- Pro and Power available via Stripe and $HermesOS
- First operator pack (Research Operator) shipped
- Twitter announcement
- Podcast and community pushes
- Onboarding flow tightened based on beta data

---

## Deferred (architecture supports, not in v1)

- x402 endpoints for agent-to-agent payments
- Operator pack marketplace
- Hive Mind early access
- Agent-level wallets
- Governance
- White-label / public API
- Rebrand (only after v2 has live paying users for 6+ weeks)

---

## Things to never do (without lawyer sign-off)

- Lock-and-return mechanic (the FCA staking pattern)
- "Earn" / "yield" / "rewards" framing anywhere user-facing
- Reservation gated by token holding
- Public posts about price, market cap, holders, rankings, trading volume
- Holder-only benefits in promotional posts
- "Buy token to be early" or any urgency-financial framing

---

## Twitter post draft for Thursday

Run through forbidden language check before posting.

> Reservations open: hermesos.cloud/reserve
>
> Free plan access for running AI agents is coming. Managed instances, fair-use limits, no subscription required to start.
>
> Pro and Power tiers available with monthly subscription, or pay in $HermesOS for a discount.
>
> Live within days. Reserve your spot.

If this works on the podcast, follow up post for $HermesOS community framed as utility:

> If you hold $HermesOS, the system will read your balance from your provisioned wallet on launch day so your tier is set up automatically. Send tokens any time after signup.

Both posts focus on product. Token mentioned only as access/discount mechanism. No price, no market, no "early supporters benefit" framing.

---

## Weekly review questions

- Are servers healthy? (CPU avg, RAM pressure, IO wait per box)
- Are paying users having a good time? (support tickets, churn, NPS-style feedback)
- Is utilisation telling us to tighten or loosen oversubscription?
- Did anything we shipped this week reduce trust or create regulatory risk?
- What's the conversion rate this week, free → Pro?
- What's the token-path vs card-path split?
- What's the monthly vs yearly $HermesOS subscription split?

---

## Key invariants (never break these)

- Balance always equals sum of ledger entries
- All money operations idempotent by external reference (stripe_event_id, tx_hash)
- All access decisions route through entitlement engine
- Free tier always works without any payment or token
- User can always withdraw $HermesOS (with grace period if it drops them below threshold)
- No silent failures on money/access logic; fail closed
- Token-related public communication runs through forbidden language check
