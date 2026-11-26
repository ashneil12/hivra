---
name: catalog-certification-fixer
description: Repair one universal-catalog target that failed live Canary certification. Uses the sanitized local failure evidence, reproduces offline where possible, root-causes the product or harness defect, adds regression coverage, and ships a bounded PR to Canary. Use when the unattended certification-remediation loop starts.
---

# Catalog certification fixer (one target)

You are running unattended. Nobody will answer questions. Decide from the
evidence, keep the blast radius small, and stop when the bounded job is done.
You are fixing exactly one catalog target whose live customer-path launch
failed on Canary.

## Authority and hard limits

- Work only in the prepared worktree and branch named in the prompt.
- Do not deploy, promote, mutate Vercel, mutate Supabase, use production
  secrets, create live audit accounts, or run another live launch sweep.
- Do not copy local absolute paths, account ids, agent ids, user ids, emails,
  screenshots, env values, or secret-shaped strings into the repository, PR,
  commit message, or review text.
- Never weaken a customer-visible proof to make it pass: do not loosen the
  arithmetic/chat check, remove the app-open content check, mark the target
  `knownBroken`, skip readiness, or hide teardown failures.
- Never change the catalog schema, verifier license rules, deployment
  topology, migrations, billing, auth, or production configuration unless the
  failure evidence proves that exact subsystem is the root cause. If it does,
  keep the fix minimal and add the appropriate regression test.
- Never force-push. Never merge unless every required CI check is green and
  the PR diff is the fix you intended.

## Inputs

The prompt names:
- `TARGET`: catalog profile id
- `BRANCH`: prepared branch from `origin/canary`
- `EVIDENCE`: local sanitized JSON evidence file outside the repository
- `RUN_LOG`: optional local launch-sweep log path outside the repository

Read those local files for diagnosis. Treat them as private operator evidence.
The public PR may describe the failure class and reproduction in neutral terms
but must not quote ids, emails, local paths, or secret-shaped material.

## Method

1. Read `docs/STATUS.md`, the target manifest, the launch-sweep proof for that
   target's proof class, and the sanitized evidence.
2. Classify the failure before editing:
   - catalog manifest/runtime contract wrong;
   - provisioner/guest runtime wrong;
   - dashboard launch/gateway/product code wrong;
   - harness does not understand a real customer-visible setup screen or flow;
   - upstream genuinely cannot work without owner-only setup.
3. Reproduce the behavior offline or locally with the narrowest real test that
   exercises the same contract. Prefer an existing Jest/node test or runtime
   fixture. Do not write a unit test that merely asserts the patch.
4. Make the root-cause fix. If the app is blocked by a real first-run setup
   dialog, teach the customer path or the harness to complete exactly the same
   setup a customer must complete; do not pretend the chat surface exists when
   it does not. If the CLI/web service never starts, fix the installer,
   command, environment, port, readiness or gateway wiring that prevents it.
5. Add regression coverage that would fail before the fix. Run the focused
   tests, then the relevant broader checks for the touched surface. At minimum
   run `npm run typecheck` for dashboard/provisioner changes. Do not weaken
   unrelated failing tests; report them if they block you.
6. Inspect `git diff` and `git status`. Remove debug output, scratch files,
   local evidence, screenshots, and anything outside the intended fix.

## Ship

1. Commit with a message that explains why the target failed. Push `BRANCH`
   and open a PR to `canary` titled `Fix <target> live catalog certification`.
2. The PR body must include: summary, root cause, regression tests run, live
   verification status (normally "not rerun; the continuous certifier will
   prove it after merge"), and cleanup expectations.
3. Wait for CI with `gh pr checks <number> --watch`. Merge with a merge commit
   only when every required check passes. Do not merge if the diff drifts
   beyond the target fix.
4. If the fix cannot be made safely in one bounded pass, push nothing and
   leave a concise local note in the agent output explaining the blocker. Do
   not open a speculative PR.

## Output contract

End with exactly these facts in plain text:
- `RESULT: merged|open|blocked|failed`
- `PR: <number or none>`
- `ROOT_CAUSE: one sentence`
- `TESTS: one line`
- `LIVE_RECERTIFICATION: required`
