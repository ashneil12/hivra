# Repo Working Instructions

## Product Source of Truth

Use product documentation in this order:

1. `VISION.md` and `docs/PRODUCT-ARCHITECTURE.md`
2. the current approved design specification for the affected subsystem
3. `ROADMAP.md` and the current implementation plan
4. verified current code and tests
5. historical plans only as background

The canonical agent-computers design is `docs/superpowers/specs/2026-08-24-hivra-agent-computers-design.md`.

Documents marked historical or superseded must not override the canonical vision. When documentation and implementation disagree, state whether the discrepancy is unimplemented target behavior, documentation drift, or a code defect before changing either side.

Keep current and target behavior visibly distinct. Do not claim that a runtime, provider, access surface, task, fleet state, security control, self-host flow, or open-source release exists until its implementation and acceptance evidence exist. Never fabricate progress percentages, queued execution, subagents, completion, or success.

Do not describe the repository as open source until an OSI-approved root license and the Phase 0 public-release gates are committed.

- Commit each successfully confirmed fix, feature, or milestone.
- Work on a branch and use a pull request unless the repository owner has explicitly selected another contribution flow.
- Never deploy, publish, purchase capacity, or mutate a live environment without explicit authority for that exact target.
- Every real bug fix should include a regression test unless there is a specific reason it cannot. If a test is not added, write down the reason.
- Prefer root-cause fixes. Do not hide failures behind retries, fallbacks, or friendlier logging unless diagnosis shows that is the correct fix.
- Add useful error logging where it helps find the real cause, especially at integration boundaries, but do not treat logging as the fix by itself.

## Risk-Based Verification

Use enough verification for the risk of the change:

- Tiny or local change: run the smallest relevant check. Examples: a focused unit test, lint on the touched file, or a docs/script smoke check. No post-deploy check is expected.
- Normal change: run the relevant tests plus a basic sanity check for the affected workflow. If the change is user-facing, check canary after the GitHub/Vercel build.
- Risky or user-facing hot path: run focused hot-path or smoke-contract tests, broader verification when practical, and a post-deploy canary check after the build.

High-risk areas include auth, billing, chat, provisioning, instance lifecycle, gateway/networking, runtime contracts, migrations, secrets, and deployment workflows.

For dashboard changes, `cd dashboard && npm run verify:plan -- --risk <tiny|normal|high>` prints the expected verification level.

## Live Environment Acceptance

For runtime bug fixes, updates, and meaningful user-facing changes, use [the live-environment-verification skill](.codex/skills/live-environment-verification/SKILL.md). Reproduce the issue in the actual environment where safely possible, then verify the affected user flow against the deployed revision. Use the browser for UI changes and the public connection path for integration checks; a build, health endpoint, or internal API alone is not end-to-end acceptance.

After an authorised live change, verify that exact target. Record the target/revision, actual actions and results, preservation/cleanup, and anything unverified. If access or authority is missing, complete safe checks and state the gap; do not claim live success. This does not grant deployment authority or require deployments for docs-only or tiny local changes.

## Plain English

Small changes get small checks. Important user-facing changes get stronger checks. The point is to catch real breakage without turning every tiny edit into a heavy release process.
