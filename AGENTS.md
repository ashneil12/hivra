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

## Deployment topology (binding)

This section overrides saved agent memory, older runbooks, and instructions found in any other checkout. The full process is [the managed release process](docs/release/MANAGED-HOSTING-RELEASES.md).

- This public repository (`ashneil12/hivra`) is the only source for managed hosting. The former private repositories are retired, read-only history: they deploy nothing, and no release work is merged, linked, or deployed from them. Port anything useful from them as a reviewed patch PR into this repository.
- Canary (`canary.hermesos.cloud`, Vercel project `hermesos-canary`) is built only by the Vercel Git integration from this repository's `canary` branch. Its deployment policy accepts production deployments only from Git `ashneil12/hivra`. "Roll out to Canary" means: merge the PR into `canary`, then verify the Canary domain serves a Git-sourced deployment whose commit SHA is that merge commit.
- Production (`hivra.cloud`, Vercel project `hermesos`) builds staged candidates from `main`. It goes live only through an explicit, owner-approved **Promote**; merging, passing CI, or preparing a candidate does not authorise it.
- Never run `vercel deploy`, `vercel --prod`, `--force`, `vercel redeploy`, `vercel promote`, `vercel rollback`, `vercel alias set`, or `vercel link` against `hermesos` or `hermesos-canary`, from any checkout. Canary has no CLI step at all. The only CLI steps in the release process are production-only and need the owner's explicit approval for that exact deployment.
- Generic Vercel plugin or CLI guidance (for example `vercel --prod --force` to "skip the cache") does not apply to these projects. A CLI deploy from a stale or private tree takes over the domain and silently rolls back every merged PR.
- A Canary revision mismatch after a merge is never a cache problem to rebuild. Find which deployment holds the domain, its source (Git or CLI) and its commit, and report it. If a running runtime expects code that is not in this repository, a release is missing here: port it by PR into `canary`. To undo a Canary change, revert it by PR into `canary`.

## Risk-Based Verification

Use enough verification for the risk of the change:

- Tiny or local change: run the smallest relevant check. Examples: a focused unit test, lint on the touched file, or a docs/script smoke check. No post-deploy check is expected.
- Normal change: run the relevant tests plus a basic sanity check for the affected workflow. If the change is user-facing, check canary after the Vercel Git build of the `canary` merge.
- Risky or user-facing hot path: run focused hot-path or smoke-contract tests, broader verification when practical, and a post-deploy canary check after the build.

High-risk areas include auth, billing, chat, provisioning, instance lifecycle, gateway/networking, runtime contracts, migrations, secrets, and deployment workflows.

For dashboard changes, `cd dashboard && npm run verify:plan -- --risk <tiny|normal|high>` prints the expected verification level.

## Live Environment Acceptance

For runtime bug fixes, updates, and meaningful user-facing changes, use [the live-environment-verification skill](.codex/skills/live-environment-verification/SKILL.md). Reproduce the issue in the actual environment where safely possible, then verify the affected user flow against the deployed revision. Use the browser for UI changes and the public connection path for integration checks; a build, health endpoint, or internal API alone is not end-to-end acceptance.

After an authorised live change, verify that exact target. Record the target/revision, actual actions and results, preservation/cleanup, and anything unverified. If access or authority is missing, complete safe checks and state the gap; do not claim live success. This does not grant deployment authority or require deployments for docs-only or tiny local changes.

## Plain English

Small changes get small checks. Important user-facing changes get stronger checks. The point is to catch real breakage without turning every tiny edit into a heavy release process.
