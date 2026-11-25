# Continuous catalog certification runner

This runner closes the loop between catalog curation and customer truth:

1. the catalog curator proposes new open-source agents and apps in PRs to
   `canary`;
2. the certifier serially launches catalog entries on the exact public Canary
   revision customers are being served;
3. every run ends with teardown evidence plus the audit-account reaper;
4. a separate cheap-agent remediation worker picks up actionable product
   failures and tries to repair them in a bounded PR;
5. the certifier retries after Canary, the manifest, or the provisioner
   changes, so a fix is believed only after a new live pass.

The runner never promotes to production, never mutates Vercel or Supabase
configuration, and never uses production secrets. It creates only the same
throwaway Clerk test accounts and paid Canary computers already defined by the
launch sweep.

## Components

The implementation lives in `dashboard/scripts/catalog-certification/`:

- `served-canary-revision.mjs` — uses the operator's authenticated Vercel CLI
  read-only to prove which READY Git-sourced production deployment holds
  `canary.hermesos.cloud`, then validates repo, branch and exact commit SHA.
- `canary-test-env.mjs` — reads the Canary project's production-scoped test
  env through the Vercel v8 API and exports only `CLERK_SECRET_KEY`,
  `LAUNCH_SWEEP_SUPABASE_URL`, and
  `LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY` to the runner process. It refuses a
  non-`sk_test_` Clerk key. Values are not written to an env file or printed in
  logs.
- `certification-plan.mjs` — chooses one due target. New entries come first,
  with the runtime pilot matrix first of all. Passed entries are recertified
  when the manifest or provisioner changes and otherwise on a periodic
  revalidation cadence. Failures back off instead of hot-looping paid VMs.
- `run-once.sh` — checks out the exact served commit in a dedicated worktree,
  installs lockfile dependencies when they change, runs one-target launch
  sweep, appends sanitized evidence to the local ledger, then runs the reaper
  dry-run inventory and the scoped active reaper with
  `HIVRA_LIVE_AUDIT_AUTH=clerk-test-otp`.
- `run-continuous.sh` — keeps `run-once.sh` alive with idle/error backoff.
- `catalog-remediation.mjs` — dedupes actionable product failures by target
  and manifest fingerprint, skipping targets with open fix branches or recent
  attempts.
- `run-fixer-once.sh` / `run-fixer-continuous.sh` — start one bounded Codex
  remediation pass using `.devin/skills/catalog-certification-fixer/SKILL.md`.
  The default model is `gpt-reserve` with low reasoning; override with
  `REMEDIATION_MODEL` only deliberately.
- `install-macos-runner.sh` — copies the runner scripts into the operator
  state directory and installs the two LaunchAgents.

The curation producer remains `dashboard/scripts/catalog-curator/run-loop.sh`.
Codex is now its unattended default, also using `gpt-reserve` unless
`CURATOR_MODEL` is set. Devin remains available only as an explicit
`CURATOR_AGENT=devin` override.

## Operator state

By default both loops use:

- repository object store: `~/Projects/Hivra-public-canary`
- certification checkout: `~/Worktrees/hivra/catalog-certification-runner`
- fixer checkout: `~/Worktrees/hivra/catalog-fixer`
- state: `~/.local/state/hivra-catalog-certification`

Important state files:

- `certification-ledger.jsonl` — sanitized certification decisions. It omits
  account ids, agent ids, emails and secrets.
- `remediation-ledger.jsonl` — remediation attempts and dedupe state.
- `results/<runId>/` — raw sweep JSON, screenshots, runner log and reaper logs
  for local operator diagnosis.
- `remediation/` — sanitized fixer input evidence and cheap-agent logs.

These files are local operator evidence. Do not paste raw ids, local paths,
emails or secret-shaped strings into public git or GitHub output.

## Required operator configuration

The LaunchAgents need only non-secret configuration:

- `HIVRA_CANARY_VERCEL_PROJECT_ID` — the Canary Vercel project id
- `HIVRA_VERCEL_SCOPE` — the Vercel team scope used by the operator CLI

The machine must already have:

- macOS with launchd, Node 22, npm, Git, Docker for curator verification;
- `vercel` CLI signed in with read access to the Canary project;
- `gh` signed in for the public repository;
- `codex` signed in through ChatGPT for the cheap remediation/curator agent;
- Playwright Chromium (`run-once.sh` installs/validates it after dependency
  installation).

The Vercel project id and scope are configuration, not credentials. Clerk and
Supabase secret values are fetched process-locally at runtime and are never in
the plist.

## Install or refresh the 24/7 runners

From a checkout that contains this commit:

```bash
dashboard/scripts/catalog-certification/install-macos-runner.sh \
  --project-id <canary-vercel-project-id> \
  --scope <vercel-team-scope>
```

This installs and starts:

- `cloud.hivra.catalog-certifier` — continuous serial live certification
- `cloud.hivra.catalog-fixer` — continuous cheap-agent remediation

The installer copies scripts into `~/.local/state/hivra-catalog-certification/bin`
so the running shell files are not overwritten when the certification worktree
moves to a newer exact Canary commit. Re-run the installer after changes to the
runner scripts merge into `canary`.

Useful checks:

```bash
launchctl print gui/$(id -u)/cloud.hivra.catalog-certifier | head
launchctl print gui/$(id -u)/cloud.hivra.catalog-fixer | head
tail -f ~/.local/state/hivra-catalog-certification/logs/certifier-launchd.out.log
tail -f ~/.local/state/hivra-catalog-certification/logs/fixer-launchd.out.log
```

## Manual bounded operation

Run one certification target selection and launch without starting the loop:

```bash
HIVRA_CANARY_VERCEL_PROJECT_ID=<id> HIVRA_VERCEL_SCOPE=<scope> \
  dashboard/scripts/catalog-certification/run-once.sh
```

Exit `75` means no entry is currently due. Exit `1` means the target failed or
cleanup failed; inspect the run directory. Exit `2` means runner infrastructure
or revision evidence failed before a fair test.

Run one remediation attempt manually:

```bash
dashboard/scripts/catalog-certification/run-fixer-once.sh
```

The remediation worker is not allowed to run live sweeps or mutate live
configuration. Its output contract is a bounded PR, a blocker, or a failed
attempt with backoff. The certifier alone decides whether the fix worked.

## Safety invariants

- one certification launch at a time;
- one remediation agent at a time;
- exact public served Canary SHA recorded in every result;
- Clerk key must be `sk_test_`;
- audit emails stay `+clerk_test` on reserved example domains;
- the scoped reaper runs after every certification attempt;
- a passed sweep is invalidated if revision evidence mismatches or teardown
  leaves agents/instances behind;
- no automatic production promotion, ever.
