# Managed hosting releases

Hivra uses one public repository and separate decisions for accepting code,
testing it, and serving it to managed customers. Optional self-hosting capability
remains public; managed operators choose the configurations they support.

## Branches and deployment controls

| Source | Vercel project | Effect |
| --- | --- | --- |
| `main` | `hermesos` | Builds a staged production candidate; does not move the live domains |
| `canary` | `hermesos-canary` | Automatically updates the Canary service |
| Contributor PR / other branch | Neither hosting project | Automatic preview deployments disabled |

Both branches require a pull request, current-tree safety, resolved conversations,
and prohibit force pushes and deletion, including for administrators. This is a
solo-maintainer repository: a second person's approval is not enforced. Only grant
write/admin access to people trusted to approve changes. CODEOWNERS identifies the
maintainer; it is not itself a second-review enforcement mechanism.

Vercel production has **Auto-assign Custom Production Domains disabled**. The
project still builds accepted main code with production build configuration, so
review build scripts and dependency installation before merging. A staged build
can access configured services; lack of a public alias is not a sandbox.

Both hosting projects retain Git Fork Protection and Vercel authentication on
generated deployment URLs. Automatic preview deployment is disabled on these
credential-bearing projects. Do not authorize arbitrary fork code to run there.
Use local/disposable environments without managed credentials for contributor
previews. Creating such a preview service requires its own scoped setup.

## Test on Canary before accepting a contribution

Canary is a separate deployment fed by the `canary` branch in this repository.
A branch is a saved line of work, not a separate GitHub repository. Existing work
in an older private repository or local checkout is not copied here automatically.
The older private repositories are retired, read-only history and deploy nothing;
a change made there reaches Canary only after it is ported here by PR.

Canary changes only through the Vercel Git integration building a merge into
`canary`. The `hermesos-canary` deployment policy accepts production deployments
only from Git `ashneil12/hivra`; CLI production uploads are refused. Never
CLI-deploy, redeploy, promote, roll back, force-rebuild, or re-alias Canary, from
any checkout. If the Canary domain serves an unexpected revision, identify which
deployment holds it, its source (Git or CLI) and its commit, and report it. A
mismatch means a change is missing from or unmerged into `canary`, not a stale
cache. To undo a Canary change, revert it by PR into `canary`.

Keep experiments on feature branches. After reviewing a contributor's proposed
code and build scripts, a maintainer can apply the selected commits to a branch
based on `canary` and open a PR into `canary`. This allows testing before accepting
the original contribution into `main`. Record the original PR and exact tested
commits, and resolve conflicts explicitly. Do not merge an entire private history
into this public repository; transfer reviewed patches only.

The managed Canary has credentials and real integrations: review code before
running it there. Unreviewed contributions belong in a disposable environment.
Once testing is satisfactory, open or complete the PR into `main`, verify that the
production candidate contains the tested changes, and use the separate promotion
steps below. Neither merging into Canary nor accepting into main releases to live.
Do not overwrite Canary experiments with a blanket reset to main.

## Release one exact revision

1. Review and merge an accepted contribution into `main`. CI is read-only and
   external contributor runs require approval. Inspect changed workflows and
   dependency scripts before approving a run.
2. Open a PR selecting the intended main revision into `canary`. Test the resulting
   Canary revision and affected workflows. Record its commit, results, database
   migration requirements, managed settings, costs, and rollback deployment.
3. Select the production candidate whose source tree matches the verified revision.
   If main advanced, do not promote its newest deployment automatically. If no
   candidate exists for the chosen revision, the owner may build one explicitly
   with `vercel deploy --prod --skip-domain`, only from a clean checkout of public
   `ashneil12/hivra` at that exact commit, linked to project `hermesos` (never
   `hermesos-canary`, a retired private repository, or a feature worktree). That
   build must not move any domain; it only stages a candidate for step 4. Canary is
   never CLI-deployed. Keep credentials out of GitHub PRs, logs, and source control.
4. Review the exact candidate and approve production separately. In Vercel select
   the `hermesos` deployment and **Promote**. A trusted operator may instead use
   `vercel promote <verified-deployment-id>`. This action changes live traffic;
   merging a PR, passing CI, or preparing a candidate does not authorize it.
5. Confirm the custom domain points to that deployment, then verify the affected
   authenticated user workflow and preservation of existing state. If it regresses,
   restore the recorded prior deployment and investigate before trying again.

A source/tree match is necessary but insufficient: production environment values
can differ from Canary. Check changed configuration and migration compatibility.
Keep the previous deployment available. Vercel rollback does not undo database
migrations or external side effects; those require a separately reviewed plan.

## Queued database steps

Some database changes break the code that is serving until the new code serves.
They are kept in `dashboard/supabase/_pending_destructive_migrations/`, outside
`dashboard/supabase/migrations/`, so no "apply every pending migration" run
(including the production schema catch-up at the first Promote) can apply one
early. Each is an explicit, ordered step in the Canary release record and in the
Promote packet, applied per environment only after the code it needs serves
there, following the steps in the file's header.

| Queued file | Apply only after | Check before and after |
|---|---|---|
| `hivra_agent_slot_writer_guard.sql` (plan agent limit, migration B) | `*_hivra_agent_slot_limit.sql` is applied and the code that writes Hivra-managed agents through `insert_hivra_managed_agent` and `reserve_hivra_launch_model_request_v3` is serving on that environment | Launch smoke test; start and restart of an existing agent, including one in `error` (the file's header lists every status writer it was audited against) |

Where each queued step stands:

- `hivra_agent_slot_writer_guard.sql`: **Canary** applied 2026-09-25 from this
  folder as ledger version `20260925151500_hivra_agent_slot_writer_guard`.
  Before the apply, a launch and a restart passed on the served revision; after
  it, a launch, stop and start, and restart passed, with no refusal logged. Start
  of an agent in `error` is proven only by `scripts/test-hivra-agent-slot-limit.cjs`:
  no Canary agent in `error` still has a computer. **Production** is pending:
  apply the same file with the same version only after the owner's Promote,
  never in the schema catch-up before it. The file stays here until then.

## Provisioner releases in flight

A provisioner release (`dashboard/provisioner/VERSION`, its sealed manifest and
its digest-bound admission migration) is sealed on the bundle it was built on.
When two open pull requests each carry one, whichever merges second is sealed
again on top of the other, at a number after it, before it merges; the one that
merged first keeps its number. A lower number is never shipped after a higher
one: hosts install the newest sealed bundle and a runtime update moves a
computer to it, so an older-numbered bundle released later would take back what
the higher release shipped.

Last pair: #124 (persistent sessions, 2026.09.24.2) merged first, so the
attach release (`claude/agent-computer`) is sealed again as 2026.09.24.3 on top
of it. Had the attach release merged first, #124 would have become 2026.09.24.4.
#130, which also used migration version `20260924220000`, moved to
`20260924231500` before it merged.

## Feature acceptance

A contributor may propose a new adapter or optional capability without it becoming
part of managed hosting. Require explicit configuration, safe defaults, disabled-path
coverage, tenant authorization, and resource/cost limits before enabling it for
managed users. Decline features that cannot be isolated safely or maintained.
This is a contribution/release policy, not a claim that a universal feature-flag
system exists or that every current integration has been audited.

## CI and live credentials

- Actions use commit-pinned dependencies and read-only repository tokens. Checkout
  credentials must not persist while contributor-controlled code is executed.
- Every external contributor's workflow run needs approval. This controls execution
  and cost, not the safety of the contributed code.
- Do not use `pull_request_target` or privileged `workflow_run` jobs to execute
  untrusted PR code. Do not put hosting credentials in repository-level secrets.
- Live Instance Smoke is manual-only, runs only from `main` and uses the `managed-live-smoke`
  environment. That environment permits only main, requires owner approval, and
  disallows administrator bypass. Put any future smoke credentials there, scoped
  to a disposable test identity; no live secrets are required for ordinary PR CI.
- A maintainer can approve their own live-smoke run in this solo-maintainer setup.
  That is an explicit operational approval, not independent code review.

## Check for configuration drift

An authenticated maintainer can run this read-only audit:

```sh
node scripts/release/check-managed-hosting-controls.mjs --live
```

It checks the named GitHub/Vercel controls and fails if required settings are
missing or weakened. It does not deploy, inspect secret values, certify application
security, or replace revision-bound release verification. The live configuration
is stored in GitHub/Vercel; committing this document alone does not enforce it.

Current broader dashboard CI failures remain tracked in issue #3; provider release
identity and staged desktop activation remain in issue #2. A passing current-tree
safety check does not certify those outstanding behaviors. Do not label a release
fully verified while relevant checks fail.
