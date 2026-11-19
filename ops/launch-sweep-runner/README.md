# Launch sweep runner

The launch sweep (`dashboard/e2e/launch-sweep.spec.ts`) launches every tile on
Canary's Launch page as a new customer, chats with it and deletes it. This folder
holds what runs it automatically, outside this public repository:

- `launch-sweep.yml`: the workflow for a **private** runner repository. It sweeps
  Canary nightly, and within 15 minutes of Canary serving a new commit (every
  merge into `canary`). It then records the verdict on that commit in
  `ashneil12/hivra` as the `launch-sweep` commit status.
- `scripts/release/launch-sweep-status.mjs` (in this repository): finds the commit
  Canary serves, writes the status, and runs the pre-Promote gate that reads it.

The workflow lives in a private repository because the sweep needs Canary admin
secrets and launches real, billed computers. This repository's workflows stay
read-only and hold no hosting credentials
([release process](../../docs/release/MANAGED-HOSTING-RELEASES.md#ci-and-live-credentials)).

## Test accounts

The sweep needs no standing test account. Each run creates throwaway Canary users
through Clerk's admin API (emails starting `firstrun-audit-`), signs in with a
one-time sign-in ticket, grants the plan under test, and deletes the user, its
agents and its computers at the end. `npm run audit:first-run:cleanup` removes
anything a crashed run left; the workflow runs it after every sweep.

## Set it up once

1. Create a private repository (for example `ashneil12/hivra-launch-sweep`) and
   copy `launch-sweep.yml` to its `.github/workflows/`.
2. Register a self-hosted runner on it with the labels `self-hosted` and
   `launch-sweep`. A small Linux VM (2 vCPU, 4 GB, Ubuntu 24.04) is enough: the
   computers it launches run on Hivra's own hosts, and the 15-minute poll costs
   nothing on a self-hosted runner. A full sweep takes a few hours, which is
   more than GitHub's free Actions minutes cover; to use GitHub-hosted runners
   anyway, set the repository variable `LAUNCH_SWEEP_RUNS_ON` to
   `["ubuntu-latest"]`.

   To register the VM, take a registration token from the private repository
   (it lasts an hour), then on the VM as a normal user with sudo:

   ```bash
   # On a machine with gh signed in as the repository owner:
   gh api -X POST repos/ashneil12/hivra-launch-sweep/actions/runners/registration-token --jq .token

   # On the VM (Ubuntu 24.04):
   sudo apt-get update && sudo apt-get install -y curl jq tar
   mkdir -p ~/actions-runner && cd ~/actions-runner
   V=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//')
   curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v${V}/actions-runner-linux-x64-${V}.tar.gz"
   tar xzf runner.tar.gz
   ./config.sh --unattended --url https://github.com/ashneil12/hivra-launch-sweep \
     --token <registration token> --name launch-sweep-1 --labels launch-sweep
   sudo ./svc.sh install && sudo ./svc.sh start
   ```

   `self-hosted` is added automatically. The workflow installs Node and the
   browser itself (`playwright install --with-deps` uses sudo, so the runner
   user needs passwordless sudo, which Ubuntu's default cloud user has).
3. Add these repository secrets:

   | Secret | What |
   | --- | --- |
   | `LAUNCH_SWEEP_CLERK_SECRET_KEY` | Canary's Clerk secret key (`sk_test_…`; a live key is refused) |
   | `LAUNCH_SWEEP_SUPABASE_URL` | Canary's Supabase project URL |
   | `LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY` | Canary's Supabase service-role key |
   | `HIVRA_STATUS_TOKEN` | Fine-grained token for `ashneil12/hivra` only, with **Commit statuses: read and write** and **Deployments: read** |

4. Optional variables: `LAUNCH_SWEEP_WORKERS` (parallel targets, default 1: two launches at once on Canary's single host have failed at kickoff) and
   `LAUNCH_SWEEP_RUNS_ON` (a JSON list of runner labels).
5. Run the workflow once by hand with `only` set to `linux-computer` to check
   the setup; its results are in the run's artifacts. A run limited with `only`
   records no status. Then run it by hand without `only` and check that the
   swept commit in `ashneil12/hivra` shows a `launch-sweep` status.

## Reading a result

The status description gives the counts (`8/12 passed, 4 known broken`). Its link
opens the private run, whose summary has the full table and whose artifact has
the per-target JSON and failure screenshots. A red status means a launch
customers use is broken, something was left running, or the sweep could not
finish; see `dashboard/e2e/README.md` (LAUNCH SWEEP) for the categories.
