# Free Tier → Conversion Machine: End-to-End Plan

*2026-06-10. Grounded in prod DB (30-day cohort, n=1,854) + PostHog (project 368999) + code audit of every upgrade surface.*

---

## 1. Diagnosis (measured, not guessed)

**The funnel today (30-day cohort):**

| Stage | Users | % |
|---|---|---|
| Signed up | 1,854 (~62/day) | 100% |
| Deployed an agent | 848 | 46% |
| Agent went active | 818 | 44% |
| Still using after day 1 | 272 | **15%** |
| Paid | 50 | 2.7% |

**Core facts that shape the strategy:**

1. **Paid conversion is a day-0 event, not a product outcome.** Median signup→paid is under 2 minutes. 103 of 127 conversions (60d) happened at the `/get-started` plan picker. True free→paid upgrades: **21 in 60 days (~0.35/day)**.
2. **There is no upgrade motion.** No lifecycle emails (welcome only), no in-app paywalls, no usage nudges. The only upgrade surfaces are the billing page and a 2nd-agent limit error.
3. **The product never pulls users back.** The agent is passive: it answers when spoken to and never initiates. No channel connection is required at onboarding, so returning requires remembering a URL. Only 7.3% of new visitors ever return on a second day.
4. **Hard product breakage is eating activation:**
   - Codex OAuth: **1,049 failures / 74 people in 30d**, ~0 completions. Every Codex-box user dead-ends.
   - `webui_iframe_error`: **400 of 806 chat users** hit chat-load errors (concentrated on hivra.cloud instance pages + mobile).
   - 615 people rage-clicked; 248 hit JS exceptions.
5. **Traffic shifted to low-intent.** April cohorts (~50/wk, launch/community buyers) converted 40–60%. The May wave (300–600/wk; Google organic 1,017 + direct 579 + t.co 141) converts 1.5–3%. **Zero UTM tagging** — attribution is blind.
6. **Measurement is broken.** `agent_first_message_sent` stopped firing 2026-05-11. `activation_*` events only exist since 2026-06-06 and `activation_failed` has no reason property. No `upgraded_at` in the DB (plan mutates in place on `hermes_subscriptions`).
7. **Paid churn is 39%** (52 of 133 ever-paid canceled) — the value-delivery problem continues after payment.
8. Warm pool right now: **258 engaged free users** (running instance + activity ≤7d).

**Strategic frame:** the aha moment for an agent product is *the agent doing something useful for you without being asked, somewhere you already live (Telegram/Discord/email)*. Everything below is organized around manufacturing that moment in the first 24 hours, then charging for more of it.

**North-star activation metric:** *agent delivers a useful message to the user on an external channel within 24h of deploy.* Secondary: user sends ≥3 messages across ≥2 distinct days in week 1.

---

## 2. Phase 0 — See clearly + stop the hard bleeding (days 1–3)

Engineering-only, no strategy risk. Everything else depends on this.

**0.1 Fix the broken instrumentation**
- Restore `agent_first_message_sent` (dead since May 11).
- Add `reason`/`stage` properties to `activation_failed`.
- Add `upgraded_at` + `upgrade_source` (paywall_modal | email | billing_page | limit_error | signup) to `hermes_subscriptions`; backfill where inferable from `current_period_start`.
- Capture UTM + initial referrer at signup (persist to DB, not just PostHog person props).
- New events: `paywall_viewed`, `paywall_dismissed`, `upgrade_clicked` (with `source`), `channel_connected` (with type), `agent_initiated_message_sent`.

**0.2 Fix the activation killers**
- **Codex OAuth** (74 ppl/30d, ~100% failure) — diagnose and fix; this is the single largest measured dead-end.
- **webui iframe errors** (400 ppl/30d) — triage top error causes; prioritize mobile + hivra.cloud instance pages.
- Sweep the rage-click ($rageclick 615 ppl) and $exception (248 ppl) hotspots via PostHog session replays.

**0.3 Funnel dashboard**
- Add a funnel panel to `/dashboard/insights` (infra exists): daily signups → deployed → active → day-1 retained → week-1 retained → paid, split by source and by day-0 vs later upgrade. The weekly cohort SQL from this audit is the spec.

---

## 3. Phase 1 — Make day 1 magical (week 1–2) ← the emphasis

Goal: move "still using after day 1" from 33% of activated users → 55%+, by making the agent earn a second session.

**1.1 Goal capture at deploy (welcome flow)**
Add one question to `WelcomeFlow`: *"What do you want your agent to handle first?"* — 4–6 presets (research & briefings, inbox/comms triage, project copilot, social/content, ops monitoring, "surprise me") + free text. This seeds everything downstream. (The Hivra bootstrap machinery — SOUL.md/USER.md/first-conversation, canary #112 — is exactly this; generalize it to the Hermes lane.)

**1.2 First five minutes: the agent performs**
On first boot, the agent (via bootstrap prompt):
- introduces itself by name with a personality derived from the goal,
- immediately *does* a small real task tied to the chosen goal (e.g. researches the user's stated topic and returns a structured brief),
- ends by proposing its first standing task ("Want me to do this every morning?").
"Do, don't show." No tour, no empty chat box.

**1.3 Channel connection as a first-class onboarding step**
Right after deploy: *"Your agent needs a way to reach you."* Telegram/Discord/email picker (integrations already exist). This is the retention lever — it converts "remember to visit a URL" into "my agent pings me." Track `channel_connected`; treat it as a top-of-funnel KPI.

**1.4 The day-1 deliverable (the pull loop)**
Give free tier exactly **one standing scheduled task** (e.g. a daily briefing on their goal topic), pre-configured by bootstrap. It fires the next morning on the connected channel. This is a deliberate, capped exception to the Pro cron gate: its job is to demo the habit. The message footer is a natural upsell surface ("I can run more of these, plus browse the web, on Pro").

**1.5 Onboarding checklist in the dashboard**
3 live items + 2 visibly locked: ① Deploy your agent ✓ ② Connect a channel ③ Give it its first task ④ 🔒 Enable web browsing (Pro) ⑤ 🔒 Add more scheduled tasks (Pro). Progress bar, dismissable. Locked items open the paywall modal (Phase 2).

**1.6 Lifecycle emails (Resend is already wired; welcome-only today)**
- Day 0: welcome (exists — sharpen CTA to "say this to your agent").
- Day 1, only if NOT activated: "Your agent is sitting idle — here are 3 things to ask it" (deep links).
- Day 1, if activated: celebrate + introduce the locked features with concrete examples.
- Day 3: use-case story matched to their chosen goal; show what browsing/memory/cron would add.
- Day 7: direct offer (see Phase 3 trial).
- Stalled (5 days inactive): "Your agent hasn't heard from you" — written *as the agent*.
All copy in Ash's voice (ash-copywriting skill) when shipping.

**1.7 Mobile**
A chunk of Google-organic signups arrive on mobile and hit iframe errors. Verify the deploy→chat path on mobile end-to-end; channel connection (1.3) matters double here since mobile dashboard reuse is unlikely.

---

## 4. Phase 2 — Build the upgrade motion (week 2–3)

Goal: later upgrades from 0.35/day → 1.5–2/day.

**2.1 Day-0 plan picker optimization** (where 81% of revenue already happens — cheapest win)
- Pre-select Pro, "Most popular" badge, anchor against Power.
- Free card states what it lacks: *no web browsing, no persistent memory, no scheduled tasks, 0.5 vCPU*.
- Show yearly toggle with savings inline. A/B via PostHog flags.

**2.2 Locked-feature paywalls in product**
Browser automation, Memory, Scheduled tasks appear in the free dashboard as visible-but-locked with a preview (screenshot/short clip) + one-click upgrade modal (`isProTierUser()` gate already exists server-side). Track `paywall_viewed → upgrade_clicked → checkout_payment_completed` by source.

**2.3 The agent sells, tastefully**
When a free user's request needs a gated capability, the agent says so once per topic: *"I can't browse the web on your current plan — on Pro I'd pull live prices for this."* One-line, with a link. Frequency-capped, never blocks the answer it CAN give. No other SaaS has an in-product salesperson the user already trusts; use it carefully.

**2.4 Warm-pool campaign (one-time)**
Email the 258 engaged free users: what their agent could be doing on Pro, tied to observed usage where possible. Announcement-broadcast infra exists (`resend-announcement-sync`).

**2.5 Contextual limit moments**
Compute-ceiling moments (slow/OOM on 0.5 vCPU) and the 2nd-agent attempt get a proper upgrade screen (current state: a bare error).

---

## 5. Phase 3 — Packaging, pricing, churn, traffic (week 3–4+)

**3.1 The trial experiment (biggest swing).** April's forced-choice cohorts converted 40–60%; today's freemium converts 2.7%. Test **7-day Pro trial with card-on-file** (mechanism already built for anti-abuse; `trialDays` is already in the plan schema) against the current free tier, 50/50 on new signups. Trial expiry emails at day 5/6/7 ("what your agent did this week" — generated from actual activity). Decide on data, not vibes: it's possible free-forever is simply the wrong shape for this product.

**3.2 Churn (39% of ever-paid).** Exit survey on cancel, save offers (pause, downgrade Pro↔Power, yearly discount), dunning for failed payments. Feed reasons back into onboarding.

**3.3 Traffic quality.** With UTMs live (Phase 0): identify what April's 40–60% channel was and buy/do more of it; build landing pages matching the Google-organic queries actually arriving; tag all token/CMC-driven links (CoinGecko referrers appear in the data) so crypto-curious traffic is segmented out of SaaS conversion math.

**3.4 Referral.** `users.referral_code` exists, unused. "Give a month, get a month" once activation is healthy. Sequenced last deliberately — referral amplifies whatever experience exists, good or bad.

---

## 6. Targets & review cadence

| Metric | Now | 30-day target |
|---|---|---|
| Signup → deployed | 46% | 60% (OAuth/iframe/mobile fixes) |
| Activated → still using day 2+ | 33% | 55% |
| Channel connected (new, of deployed) | ~0 enforced | 60% |
| North-star activation (agent → channel msg <24h) | ~0 | 50% of deploys |
| Later upgrades/day | 0.35 | 1.5–2 |
| Day-0 conversion | 2.7% | 4% |
| **Total paid/day** | **1–3** | **4–6** |

Weekly: review the cohort funnel in `/dashboard/insights`, kill or scale experiments. Every feature in Phases 1–2 ships with its PostHog events in the same PR — no more flying blind.

## 7. Sequencing summary

Week 1: Phase 0 entire + 1.1–1.3. Week 2: 1.4–1.7 + 2.1. Week 3: 2.2–2.5. Week 4: 3.1 trial experiment + 3.2. Canary first, prod trails per usual.
