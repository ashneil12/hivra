# Agent install checks

The cheap check each agent gets when it changes, so testing does not grow with
the catalog. `agent-checks.yml` is a workflow for the same **private** runner
repository as `ops/launch-sweep-runner/launch-sweep.yml`, on the same runner VM.

After every Canary merge it works out which agent kinds the merge changed
(`scripts/release/agent-container-check.mjs changed`). For each one, `run.sh`:

1. boots a throwaway Ubuntu 24.04 container with systemd (`Dockerfile`), a
   stand-in for a fresh computer;
2. runs the real guest installer, `dashboard/provisioner/provision-claude-code-box.sh`,
   for that kind;
3. asks the box's own chat "What is 389 + 448?" and expects 837;
4. deletes the container.

A change to an agent's own files checks that agent. A change to shared install
code (the installer, the box chat) checks the reference agent (`claude`); the
nightly rotating full launch covers the rest. A merge that changes no agent
records green without installing anything. The result is the informational
`agent-checks` commit status; Promote is gated by the customer path
(`launch-sweep`).

No computer is launched and no Canary account is used: it costs a few minutes
of the runner VM and one model call per changed agent.

## Setup

On the runner VM, in addition to the launch sweep runner setup:

- Docker, with the runner user in the `docker` group. The check runs
  privileged containers, because the installer manages systemd units.
- Secret `AGENT_CHECK_MODEL_KEY`: a Hivra managed-model key minted on Canary
  for a standing test account (`POST /api/managed-venice/keys` while signed in
  as that account), the same kind of key a launched agent gets. Its calls bill
  that account's wallet, a few cents per check.
- Variable `AGENT_CHECK_MODEL`: the model id the agents answer with. Optional:
  `AGENT_CHECK_MODEL_ORIGIN` (default `https://canary.hermesos.cloud`).

Copy `agent-checks.yml` to `.github/workflows/`. To check kinds by hand, run the
workflow with `kinds` (for example `openclaw,hermes`); a run by hand records no
status. Locally, from the repository root:

```bash
CHECK_MODEL_KEY=... CHECK_MODEL_ORIGIN=https://canary.hermesos.cloud CHECK_MODEL=... ops/agent-container-check/run.sh openclaw
```

Logs (the install log and the container's journal) are in `out/agent-checks/`.
