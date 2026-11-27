# Managed gVisor idle-stop pilot

This is a release candidate, not an availability or reclamation claim. It
applies only to a paid managed Linux Sandbox using the expiring, single-owner,
canonical Git Canary cohort on its exact registered host. It excludes
self-managed hosts, Proxmox VMs, provider sessions, and agent or browser
workloads with services or background processes that need to remain running.
Only the bounded, one-shot Terminal command contract is eligible.

The pilot can stop a running sandbox after ten minutes without confirmed
command activity or a recent Start. A sandbox first enters consideration
after a confirmed pilot command. The existing cron takes at most one
eligible claim per invocation without changing the Proxmox sweep. A claimed
or unconfirmed command prevents automatic stop, as does a pending lifecycle
operation. An uncertain Stop stays held for reconciliation rather than being
resent. Existing explicit, signed-in owner **Start** is the wake path; page
loads, foreign users and Terminal commands do not wake a stopped sandbox.
The existing workspace volume stays attached; processes and in-memory
`/tmp` are not preserved. No checkpoint support is proposed here.

## Canary evidence and repeat checks

On canonical Git Canary build `be8cf08d`, the scoped standing-account test
recorded three automatic stops, three explicit owner Starts and matching
workspace markers after every Start. Controlled admission pressure denied a
Create and a Start without filling the filesystem. The sandbox and fixture
were removed; after the enrollment expired, both tested accounts saw the
managed Launch path disabled. These are fixture results, not evidence of
physical host RAM savings, production quotas or capacity, or public access.
The exact-build run did not establish a cron sweep overlapping an active
command. Repeat the checks below for any subsequent authorised cohort.

- Have the exact additive pilot migration applied and verified by an
  authorized operator. Confirm the exact Git-sourced build, hash-pinned
  runtime/image, standing owner and denial tenant, and isolated target
  revision. Only in an explicitly approved, fresh QA window set
  `HIVRA_MANAGED_GVISOR_IDLE_PILOT_ENABLED=true` on the existing owner-only
  expiring cohort, with general admission off. Until then leave it unset.
- On one owned sandbox, run and flush a new workspace marker on each of at
  least three cycles. Confirm a sweep while work is in flight cannot stop it,
  then allow ten minutes past confirmed completion and verify the scheduler
  actually stopped it. Check the ordinary second tenant cannot wake or run it.
  Start it as the owner and verify the latest marker digest and a useful
  Terminal command each time. Exercise an uncertain outcome offline without
  replaying an unknown mutation live.
- Measure cgroup memory and CPU plus the physical host boundary before sleep,
  while stopped, and after wake. Record workload- and placement-accounting
  differences; released guest cgroup memory does not establish physical RAM
  reclamation. Account reservations and workspace storage are unchanged.
- Stop new checks early enough to delete the owned sandbox, revoke its target,
  remove the fixture lease, remove the pilot and cohort settings, and verify the
  served gate is off. Explicit Start remains available to the owner if the
  pilot is disabled. Keep low-disk admission, workspace quotas, checkpoint
  sizing and physical reserve thresholds separate; this candidate changes
  none of them.
