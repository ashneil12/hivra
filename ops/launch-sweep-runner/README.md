# Canary release testing runner

`launch-sweep.yml` is the workflow for a **private** runner repository. Its cost
stays flat however many agents the catalog has:

- **After every Canary merge** (a poll every 15 minutes finds a served commit
  with no `launch-sweep` status): the one full customer path,
  `dashboard/e2e/trial-to-pro.spec.ts`. A new account starts the card trial,
  becomes Pro when the card is charged, then launches one reference agent
  (`CUSTOMER_PATH_AGENT`, default `claude-code`), gets a reply, sleeps and wakes
  it, and deletes it. Its result is the `launch-sweep` status on that commit in
  `ashneil12/hivra`, which the pre-Promote gate reads.
- **Nightly:** a full launch of a small rotating sample of the Launch tiles
  (`LAUNCH_SWEEP_SAMPLE_SIZE`, default 3), so every tile gets a full launch every
  few nights. It records the informational `launch-sample` status; it does not
  gate Promote.
- **By hand:** run the workflow in either mode. `only` limits a sample run to a
  few targets and then records no status.

It is not a workflow of the public repository because it needs Canary admin and
Stripe test secrets, and public run logs would show Canary's internals.

## Test accounts

The sweep needs no standing test account. Each run creates throwaway Canary users
through Clerk's admin API (emails starting `firstrun-audit-`), signs in with a
one-time sign-in ticket, grants the plan under test, and deletes the user, its
agents and its computers at the end. `npm run audit:first-run:cleanup` removes
anything a crashed run left; the workflow runs it after every sweep.

## Set it up once

1. Create a private repository (for example `ashneil12/hivra-launch-sweep`).
   From the same reviewed source revision, copy `launch-sweep.yml` to its
   `.github/workflows/` and `scripts/release/launch-sweep-status.mjs` to its
   root as `launch-sweep-status.mjs`. Commit them together. The private copy
   discovers Canary's served revision and writes statuses; it is not loaded
   from the tested tree, so release mode can verify the runner before the
   gate merges. Update the workflow and helper together.
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
   | `TRIAL_JOURNEY_STRIPE_SECRET_KEY` | Canary's Stripe secret key (`sk_test_…`; a live key is refused) |
   | `HIVRA_STATUS_TOKEN` | Fine-grained token for `ashneil12/hivra` only, with **Commit statuses: read and write** and **Deployments: read** |

4. Optional variables: `CUSTOMER_PATH_AGENT` (the reference agent, default `claude-code`), `LAUNCH_SWEEP_SAMPLE_SIZE` (tiles per night, default 3), `LAUNCH_SWEEP_WORKERS` (parallel targets, default 1: two launches at once on Canary's single host have failed at kickoff) and
   `LAUNCH_SWEEP_RUNS_ON` (a JSON list of runner labels).
5. With card trials enabled on Canary in Stripe test mode, run `release`
   by hand and check for a successful `launch-sweep` status on the served
   commit in `ashneil12/hivra`, linking to that private run. Verify this
   before merging the gate. To check just the launch harness, run `sample`
   mode with `only` set to `ubuntu-server`; that diagnostic writes no status.
   Scheduled rotation needs `test:launch-sweep:sample` in the served tree.

## Reading a result

The status description gives the counts (`8/12 passed, 4 known broken`). Its link
opens the private run, whose summary has the full table and whose artifact has
the per-target JSON and failure screenshots. A red status means a launch
customers use is broken, something was left running, or the sweep could not
finish; see `dashboard/e2e/README.md` (LAUNCH SWEEP) for the categories.
