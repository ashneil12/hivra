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

## Release one exact revision

1. Review and merge an accepted contribution into `main`. CI is read-only and
   external contributor runs require approval. Inspect changed workflows and
   dependency scripts before approving a run.
2. Open a PR selecting the intended main revision into `canary`. Test the resulting
   Canary revision and affected workflows. Record its commit, results, database
   migration requirements, managed settings, costs, and rollback deployment.
3. Select the production candidate whose source tree matches the verified revision.
   If main advanced, do not promote its newest deployment automatically. Build the
   chosen revision explicitly with `vercel deploy --prod --skip-domain` in the
   correctly linked production checkout if needed. Keep credentials out of GitHub
   PRs, logs, and source control.
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
