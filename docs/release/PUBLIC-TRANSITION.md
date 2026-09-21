# Public repository and hosted-service transition

Status: preparation plan; no repository visibility or deployment has changed.

## One product, separate installations

The public repository should become the canonical development source for the
complete functional platform. Hivra's hosted service deploys an approved revision
of that same source using private environment configuration. Self-host operators
use their own credentials, database and capacity. See the
[approved boundary](../OPEN-SOURCE-BOUNDARY.md).

Keep the existing private repositories and their history intact during the
transition. Do not flip their visibility, mirror their Git objects into the new
repository, or maintain a separate private functional core. Prepare the new
repository from the exact reviewed export described in the
[history decision](PUBLIC-REPOSITORY-DECISION.md).

## Before publication

1. Select the public owner/name and exact source revision. Resolve pending product
   PRs explicitly; a source export from main does not include unmerged work.
2. Generate the current-tree candidate, run its secret and provenance checks,
   rehearse exported-source bootstrap and recovery, and obtain the independent
   review and combined approval bound to those exact bytes. Older receipts do
   not approve a newer revision.
3. Stage a fresh root commit privately. Preserve license, notices, contributor
   attribution and the full self-hostable implementation. Add no private history.
4. Review the repository description, topics, default branch, README, contribution
   guide, security contact and issue forms. Enable and verify private vulnerability
   reporting when the target supports it; do not advertise an untested channel.
5. Review branch protection and workflow permissions for the target repository's
   plan. Public pull requests must not receive deployment credentials or execute
   untrusted code on machines with access to hosted infrastructure. Confirm which
   checks are required before configuring branch rules.

Record the initial public commit and archive digest in private release evidence.
Visibility changes apply only to the reviewed new repository after approval.

## Vercel transition

Inventory the existing projects before changing a Git connection. Record their
project IDs, source repositories, production branches, root directories, build
settings, domains, environment-variable names and last working deployment IDs.
Keep values in the existing secret stores; never put them in this document.

First connect a separate preview/staging project to the new repository with
isolated test services and credentials. Verify authentication, navigation, agent
and computer access, callback URLs and expected environment restrictions against
the exact deployed revision. Do not point public contributor previews at customer
data or production infrastructure.

After staging acceptance, schedule an explicit production cutover. Preserve the
existing production project, domains, data stores and credentials where possible;
changing the code source does not require moving customer data. Record the old
Git connection and deployment before changing it. Verify the public user flow
after the switch. On failure, restore the previous Git connection and known-good
deployment; avoid incompatible database migrations in this cutover.

## Continued development

Develop platform changes in the public repository once it is canonical. Use PRs,
reviewed merges and tested release revisions for hosted deployments. Keep private
incident records, customer information, secret values and environment inventory
outside public Git. Generic operator tooling and recovery instructions stay public.

Retain the old repositories through cutover and rollback verification. Before
archiving any repository, check all Vercel connections, Actions workflows, image
builds, package consumers, webhooks and active PRs. Record its replacement and
resolve open work. Renaming, deleting or archiving repositories is a separate,
explicitly scoped action; an inventory alone is not a reason to remove them.

## Actions consumption

Audit billed usage by repository, workflow, runner type and storage before
changing budgets. Distinguish jobs that actually ran from jobs rejected before
starting. Check schedules, duplicate push/PR triggers, cancellation, job timeouts
and artifact retention. Keep necessary security and regression checks intact.
Public-repository runner eligibility does not eliminate every Actions charge or
explain historical private-repository consumption.

## Preserve work across the repository boundary

Existing tasks continue in their current private-repository worktrees until the
cutover is coordinated. Do not change their remotes, reset or stash shared work,
or remove old worktrees during release preparation.

Before selecting the export revision, inventory open PRs, branch heads, working
tree changes (including untracked files), and each active task's test evidence.
Record the inventory privately because local paths and unfinished work may
contain operational information. Ask each active task for its checkpoint; a
snapshot taken while a task is writing is not a final transfer receipt.

Classify every open PR as included, already incorporated, deferred with an owner,
or superseded with evidence. Integrate selected changes in a separate branch and
verify the combined result. Preserve original branches and PRs in the private
repository even when their reviewed changes enter the public source snapshot.

Record the final private source commit/tree, source archive digest and fresh
public root commit as a private migration mapping. Preserve required attribution
in the released source. Old private commit hashes and Git history remain in the
private engineering archive; do not mirror all refs to the public repository.

For work completed after the snapshot, transfer only its reviewed delta onto a
branch based on the new public root, scan the transferred files, rerun affected
checks and open a new public PR. Review the patch's metadata as well as its code;
never push the old private branch directly. Refresh the outstanding-work list
until every active task has an explicit destination and no change is stranded.

Only then point new tasks at the new canonical project checkout. Existing tasks
must acknowledge their handoff before their old checkout is retired. Nibbii work
belongs to its own repository and is not part of the Hivra source migration.
