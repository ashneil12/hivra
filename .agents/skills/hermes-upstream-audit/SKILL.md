---
name: hermes-upstream-audit
description: Use when checking Hermes Deploy against upstream Hermes Agent main, planning a fork sync, auditing dashboard API drift, or preparing a recurring upstream compatibility report.
---

# Hermes Upstream Audit

Use this skill to compare Hermes Deploy against the current upstream Hermes Agent codebase before proposing any merge, release-sync, or dashboard integration change.

## What This Skill Is For

- Verifying the current upstream `NousResearch/hermes-agent` main branch
- Comparing it against the deployed fork `ashneil12/vanilla-hermes-agent`
- Checking whether Hermes Deploy still depends on fork-only endpoints or behavior
- Producing a fresh markdown audit with exact SHAs, versions, risk levels, and a product-level update brief

## Run The Audit

From the repo root, run:

```bash
./.agents/skills/hermes-upstream-audit/scripts/run-audit.sh
```

Default output:

- `dashboard/hermes_upstream_audit.md`

Optional flags:

```bash
./.agents/skills/hermes-upstream-audit/scripts/run-audit.sh --output dashboard/hermes_upstream_audit.md
```

## What The Audit Checks

- Upstream and fork `main` SHAs
- `pyproject.toml` versions for upstream and fork
- Current upstream release notes when available
- Current upstream Tool Gateway / browser / image generation / TTS docs when relevant
- Upstream gateway API surface
- Upstream web dashboard API surface
- Fork gateway API surface
- Hermes Deploy contract files for:
  - `/api/config`
  - `/api/config/schema`
  - `/api/config/defaults`
  - `/api/skills`
  - `/v1/models`
  - `/v1/responses`

## Required Output Sections

Every audit report should include all of the following:

- `Repository State`
- `Release Highlights`
- `What Matters`
- `Interesting Changes`
- `Community / Content Angles`
- `Current Hermes Deploy Support`
- `Missing Or Partial Support`
- `Product Opportunity Deep Dive`
- `Implementation Plan`
- `Decisions Needed`
- `Expose Now`
- `Expose Later`
- `Keep Advanced / Hidden For Now`
- `Rollout Notes`
- `API Surface Drift`
- `Dashboard Contracts`
- `High / Medium / Low risk`

This is intentional: the audit is not only for merge safety. It should also answer:

- What is genuinely important in this upstream update?
- What is interesting enough to mention publicly or use in posts/changelog notes?
- Which new upstream capabilities should Hermes Deploy expose?
- Which settings should stay advanced or deferred?
- What community-visible story does this release actually tell?

## How To Interpret It

- `High risk`
  - The dashboard still bypasses `agentWebApi` for config or skills management
  - Upstream no longer exposes an endpoint the dashboard still needs
- `Medium risk`
  - Upstream and fork still differ on management APIs
  - Session-token bootstrap changes could break dashboard auth
  - Fork version still lags upstream
- `Low risk`
  - Additive upstream endpoints Hermes Deploy does not currently consume

## Reporting Standard

Do not stop at a route diff. The audit should clearly separate:

- compatibility findings
- product-significant upstream changes
- community-interesting changes
- dashboard exposure recommendations
- implementation-ready product opportunities grounded in current Hermes Deploy code
- decisions the user needs to approve before work starts
- rollout notes

If upstream introduces an optional system like Nous Tool Gateway, the audit must explain:

- how upstream enables it
- whether Hermes Deploy supports it today
- what is missing
- what should be exposed now versus later
- what should remain advanced-only

## Current Safe Baseline

- Config management should go through `agentWebApi`
- Skills management should go through `agentWebApi`
- Do not reintroduce direct gateway `/api/config` writes
- Do not rely on fork-only `/api/skills/categories`

When optional upstream features exist, prefer first-class dashboard toggles over asking users to hand-edit config files or discover hidden env vars.

## If New Drift Appears

1. Re-run the audit and read `dashboard/hermes_upstream_audit.md`
2. Verify the affected dashboard route and the corresponding upstream source file
3. Keep the change surface minimal
4. Prefer upstream web dashboard APIs over fork-only gateway endpoints
5. Update `dashboard/hermes_changelog.md` if the repo contract changed in a meaningful way
