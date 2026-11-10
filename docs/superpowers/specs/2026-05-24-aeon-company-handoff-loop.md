# AEON to Company OS Handoff Loop — 2026-05-24

## Goal

Turn AEON outputs into routed company work instead of raw notification noise.

AEON remains the autonomous worker. Augustine and department profiles decide action, quality, and escalation.

## Current routing

- Fleet/Proxmox/security/backup -> Benedict -> `#ops-alerts`
- Upstream/code/CI/repo -> Aquinas -> `#dev-review`
- Growth/PostHog/social -> Chrysostom -> `#growth-desk`
- Finance/cost/revenue/risk -> Anselm -> `#finance-risk`
- Raw/fallback -> Gabriel -> `#agent-runs`
- Approval/incident -> Augustine/Ash -> `#ash-approval` / `#incidents`

## Loop design

1. AEON runs skill and writes `.outputs/<skill>.md` plus any structured output.
2. AEON sends a terse route notification to the department channel.
3. Hermes handoff cron inspects changed AEON outputs.
4. Handoff cron classifies:
   - `WATCH`: no immediate work.
   - `ACTION`: owner should work next.
   - `APPROVAL`: Augustine/Ash decision needed.
   - `INCIDENT`: urgent ops/security/customer-impacting issue.
5. Handoff cron sends only concise owner-ready summaries.
6. Augustine receives final daily rollup, not raw logs.

## Handoff summary format

```txt
[AEON -> <owner>] <status>: <skill>
Evidence: <1-3 facts>
Action: <next concrete step>
Gate: none | Augustine | Ash
Source: <run/output path or GitHub Actions URL>
```

## Privacy rules

- Never include raw person identifiers from PostHog.
- Never include secret values or key prefixes/suffixes.
- Never mention token price, yield, staking, buybacks, fee sharing, or inducement framing.
- For wallet/billing outputs, route to Anselm/Augustine before public/user-facing copy.

## First concrete handoffs from current AEON state

### Aquinas

From PostHog:

- Fix `/dashboard/wallet` RPC internal errors.
- Instrument `/get-started/activate` stall causes.
- Repair PostHog funnel prefetch query.

### Chrysostom

From PostHog/growth desk:

- Rewrite activation/welcome copy once stall cause is known.
- Keep public messaging product-led: managed, persistent, one-click agent hosting. No token inducement.

### Benedict

From backup/fleet outputs:

- Decide backup target and run first canary restore drill.
- Keep gateway watchdog and fleet SSH watchdog silent-on-clean.

### Anselm

From finance/risk:

- Review Opus-heavy AEON run cost and propose which mechanical checks can downgrade to Sonnet.
- Track revenue darkness until Stripe/Bankr reporting is wired.

## Automation plan

Implement a Hermes cron job:

- Schedule: daily after AEON morning jobs, plus manual run anytime.
- Script context: clone/pull `ashneil12/aeon`, list changed `.outputs/*.md` since last handoff state.
- Agent prompt: summarize changed outputs and use `send_message` for routed owner summaries.
- State: `~/.hermes/state/aeon_company_handoff.json` stores last processed AEON HEAD and output mtimes.
- Delivery: final Augustine rollup to `#augustine-briefs`.

## Acceptance criteria

- New AEON outputs produce one concise routed owner summary.
- No duplicate summary if AEON repo/output state has not changed.
- Raw PostHog identifiers and secrets never appear in Discord.
- Approval-gated items go to Augustine/Ash, not straight to implementation.
