# Repository settings checklist

These settings live in GitHub. No file in this tree turns them on or off, and
merging this page changes none of them. The page lists the settings the owner
decides, what each one protects, how to read its current state with a read-only
command, and the traps found when the settings were reviewed.

Nothing here says a setting is on. Read the state yourself and record what you
found, and the date, in the owner's private notes. Operational state stays
outside public Git (see [the public transition](PUBLIC-TRANSITION.md)).

The existing drift audit covers branch protection, the Live Instance Smoke
environment and Vercel fork protection:

```sh
node scripts/release/check-managed-hosting-controls.mjs --live
```

It does not read the settings below. See
[managed hosting releases](MANAGED-HOSTING-RELEASES.md) for what it does cover.

## Owner settings

| Setting | Target | Read its state |
|---|---|---|
| Dependabot alerts | On | `gh api repos/ashneil12/hivra/vulnerability-alerts -i` returns 204 when on and 404 when off |
| Dependabot security updates | On, after reading the trap below | `gh api repos/ashneil12/hivra/automated-security-fixes` shows `enabled` |
| Code scanning, CodeQL default setup | On for the languages the setup detects. A review proposed JavaScript and TypeScript, Python, GitHub Actions and Swift | `gh api repos/ashneil12/hivra/code-scanning/default-setup --jq .state` |
| Secret scanning and push protection | Keep on | `gh api repos/ashneil12/hivra --jq .security_and_analysis` |
| Secret scanning for non-provider patterns, and validity checks | Owner's choice; both add coverage to the repository's own Gitleaks rules | same call |
| Private vulnerability reporting | Keep on, because [SECURITY.md](../../SECURITY.md) points reporters to it | Settings, Code security |
| Required status checks on `canary` and `main` | `Current tree safety` stays required; see the trap on `Verify Dashboard` | `gh api repos/ashneil12/hivra/branches/canary/protection` |
| Required approving reviews | Leave at zero while the repository has one owner | same call |
| Stale branches | Delete only branches that have no open pull request and no unmerged work | `gh pr list --state open --json number,headRefName` |
| Allowed Actions | Optional: restrict to a selected list. Keep the requirement that actions are pinned to a commit | Settings, Actions, General |

## Traps

**Dependabot security updates open pull requests against `main`.** In the current
flow `main` is refreshed from `canary` through a release pull request (see
[the cutover packet](PROD-CUTOVER-PACKET.md)), so a dependency pull request that
lands on `main` first would put `main` ahead of `canary`. Retarget each one into
`canary`, or close it and make the same bump as an ordinary pull request into
`canary`. How the `target-branch` option of `dependabot.yml` applies to security
updates was not verified, so check the first pull request Dependabot opens. Alerts
only help when someone reads them and acts.

**Do not require `Verify Dashboard` yet.** Dashboard CI starts on a pull request
only when the change touches `dashboard/**`, `docker-compose.yml` or `.github/**`.
A pull request that touches only `docs/`, `scripts/`, `services/`, `apps/` or
`contracts/` never reports that check, so a required `Verify Dashboard` would wait
on it forever. Administrators follow the branch rules, so nobody could merge past
it. The branch must also be up to date before merging, and the check takes several
minutes, so every merge into `canary` restarts the required check on every other
open pull request. Two safe routes exist. One is to remove the path filter from
the `pull_request` trigger in `.github/workflows/dashboard-ci.yml` so the check
always reports. The other is to add a summary check that always reports. Land
that as its own reviewed change, and only add the requirement after the check has
reported on a docs-only pull request. [The regression lockdown notes](../regression-lockdown.md)
record the same constraint, and add that `Current tree safety` has no
`merge_group` trigger, which a merge queue would need.

**Do not require an approving review with one owner.** GitHub does not let an
author approve their own pull request, so a required approval would block every
merge. [Managed hosting releases](MANAGED-HOSTING-RELEASES.md) already states that
a second person's approval is not enforced. Revisit this when a second trusted
maintainer has write access. `.github/CODEOWNERS` already names the owner, so code
owner review can be switched on then.

**Deleting a branch closes its open pull request.** List the heads of open pull
requests first. A draft waiting on owner or legal review, and the current release
branch `release/canary-<sha7>`, keep their branches until the pull request is
merged or closed. Branches with no open pull request can still hold unmerged
work, so check each one before deleting it.

## Order that avoids surprises

1. Turn on Dependabot alerts and CodeQL default setup. Neither touches branch
   protection or the Canary deploy path.
2. Turn on Dependabot security updates once the owner has chosen how its pull
   requests reach `canary`.
3. Change required checks only after the path filter or summary check is in
   place and has reported on a docs-only pull request.
4. Re-run the drift audit above after any branch protection change.
