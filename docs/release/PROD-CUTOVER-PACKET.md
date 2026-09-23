# Production cutover packet: hivra.cloud → public `main`

This is the procedure for the **first** Promote of a public-repository build to
hivra.cloud. Nothing in this document has been executed against production.
Every production write and the Promote itself are owner actions.

The live domain is not served from this repository today. It serves a CLI
deployment of the retired private repository. The first Promote therefore
replaces the whole application and needs a database catch-up of a large
migration backlog. It is not an incremental release.

The procedure is written to be recomputed at Promote time, because `canary`
keeps moving. [PROD-CUTOVER-SNAPSHOT.md](PROD-CUTOVER-SNAPSHOT.md) records one
run of it (candidate `1f825ba`, 2026-09-23) as a worked example. Treat the
snapshot's numbers as stale once `canary` or either database changes.

Binding rules: the "Deployment topology" section of `AGENTS.md` and
[MANAGED-HOSTING-RELEASES.md](MANAGED-HOSTING-RELEASES.md). In short: no agent
runs `vercel deploy`, `--prod`, `--force`, `redeploy`, `promote`, `rollback`,
`alias set` or `link` against `hermesos` or `hermesos-canary`, and no agent
writes to the production database.

## 0. Roles

| Step | Who |
|---|---|
| Read-only recompute (sections 1–5) | any maintainer or agent |
| Refresh the pinned release PR into `main` | maintainer or agent |
| Merge the release PR (stages a candidate, changes nothing live) | owner |
| Production database catch-up (section 6) | **owner only** |
| Promote and rollback (sections 7–8) | **owner only** |
| Post-Promote acceptance (section 9) | maintainer or agent, read-only plus one signed-in journey |

## 1. Pin the candidate

1. Record what Canary serves. The deployment must be `source: git`, repository
   `ashneil12/hivra`, ref `canary`, state READY, and its commit is the candidate
   SHA. Vercel project `hermesos-canary`; read the alias for
   `canary.hermesos.cloud` (Vercel dashboard, the Vercel API, or the maintainer's
   `served-revision.sh`).
2. Record what hivra.cloud serves. This is the **rollback target**. Until the
   cutover it is a `source: cli` deployment from the retired private repository.
3. Push the candidate SHA to `release/canary-<sha7>` and open a PR from that
   branch into `main`. Never use the moving `canary` branch as the head. Close
   any older release PR as superseded.
4. After the owner merges it, find the staged candidate: Vercel project
   `hermesos`, target production, filter by the merge commit SHA. Require READY,
   `source: git`, `githubRepo: hivra`, ref `main`, **no** custom domain alias, and
   `git diff --quiet <candidate sha> <main merge sha>` (identical trees).

## 2. Release contents

```sh
git fetch origin
git log --merges --first-parent --format='%h %s' origin/main..<candidate sha>   # PRs being released
git log --no-merges --format='%h %s' <candidate sha>..origin/main              # main-only commits: must be none apart from release merges
git diff --name-status origin/main <candidate sha> -- dashboard/supabase/migrations/
git diff --stat origin/main <candidate sha> -- dashboard/provisioner dashboard/runtime-adapters
```

Provisioner or sealed-runtime changes need their own immutable provisioner
release and VM rollout. A Promote changes no installed box.

Note that `origin/main..candidate` understates the cutover. The live build is the
retired repository, so the real delta is **everything** in the public tree
against that build. Sections 3–5 measure it directly.

## 3. Database: object diff, not ledger

Production's migration ledger (`supabase_migrations.schema_migrations`) records
only sporadically, so "no ledger row" does not mean "not applied". Compare
objects.

```sh
# Read-only. Every query runs with read_only:true through the Supabase Management API.
export HIVRA_CANARY_DB_REF=<canary project ref> HIVRA_PROD_DB_REF=<prod project ref>
node scripts/release/prod-schema-diff.mjs --json diff.json --save-snapshots snap > diff.md
```

It diffs the `public` schema between the two projects: tables (with RLS flags),
views, columns (type, nullability, default), functions (body hash, SECURITY
DEFINER, `search_path`), EXECUTE grants for `anon`/`authenticated`/`service_role`,
RLS policies, table privileges, triggers, constraints, indexes, enums,
extensions and storage buckets. Objects on a table that exists on one side only
are counted separately so shared-table drift stays readable. It also lists
SECURITY DEFINER functions callable by the API roles and tables with RLS off,
per side.

Then list the migrations production lacks at the candidate SHA and flag the ones
that are unsafe to run as-is:

```sh
# Versions in dashboard/supabase/migrations at <sha> with no matching prod ledger row
# (by name, then version). The maintainer's ledger-drift tool prints this list;
# the SQL is: select version, name from supabase_migrations.schema_migrations;
node scripts/release/prod-migration-risk.mjs --rev <sha> \
  --prod-snapshot snap-prod.json --canary-snapshot snap-canary.json \
  --versions-file missing.txt --json risk.json > risk.txt
```

Verdicts, per file:

- **ADDITIVE**: new tables, columns, functions, indexes or policies only. Safe
  while the old build is live.
- **REVIEW**: data statements, DO blocks, dynamic SQL, drops, a replaced
  function that already exists on production, or SECURITY DEFINER without a
  revoke in the same file. Read the file; decide per object.
- **NOT-AS-IS**: NOT NULL or validated constraints on a production table that
  holds rows, destructive alters, `CREATE TABLE` of a table production already
  has, `CONCURRENTLY`, or a reference to a production-only table. Needs a
  rehearsal against production-shaped data, or a reconciling migration merged
  into `canary` first.

The flags are heuristics that point a reviewer at the right file. After
applying, the maintainer's per-migration object check (tables, columns,
constraints, triggers, policies, grants and exact function bodies) is the proof,
not this script.

## 4. Environment variable names

Compare names only. Values are sensitive and are never read or printed.

```sh
vercel env ls production   # in a checkout linked to hermesos-canary, then one linked to hermesos (read-only listing)
```

Sort the difference into four groups:

1. **Set on Canary only, read by the candidate**: behaviour Canary exercised
   that production will not have. Decide per name whether production needs it.
2. **Set on production only, read by the candidate**: code paths Canary never
   exercised (gates such as crypto billing, cold storage, inactivity sweep and
   self-serve downgrade).
3. **Set on production only, NOT read by the candidate**: behaviour of the live
   private build that disappears at Promote (trials, dunning, SEO jobs).
4. `NEXT_PUBLIC_*` names in any group: baked in at build time. A change needs a
   new candidate build and a new Promote.

Any production env change is an owner action, made before the release PR is
merged so the staged build picks it up.

## 5. Cron differences

Vercel crons come from `dashboard/vercel.json`. Compare the live build's file
(retired repository at the live deployment's commit, read-only) with the
candidate's:

```sh
git -C <retired checkout> show <live sha>:dashboard/vercel.json > live.json
git show <candidate sha>:dashboard/vercel.json > candidate.json
node -e 'const [a,b]=[1,2].map(i=>Object.fromEntries(require(require("path").resolve(process.argv[i+1])).crons.map(c=>[c.path,c.schedule])));for(const p of new Set([...Object.keys(a),...Object.keys(b)]))if(a[p]!==b[p])console.log(p,a[p]??"-",b[p]??"-")' _ live.json candidate.json
```

Also list database-side cron (`select jobname, schedule, active from cron.job`)
on production. It needs a role that can see all jobs; the read-only role sees
none.

For every cron that starts, changes or stops at Promote, write down what its
first run does on production data (read-only counts), especially retirements,
cancellations and sweeps.

## 6. Production database catch-up (owner)

Order: every migration production lacks, in filename order, one file per atomic
transaction that also writes its ledger row. Stop at the first failure and
re-check that file's objects before anything else.

Timing, because rollback of the application does not undo SQL:

1. **Rehearse first.** Restore a schema-only dump of production into a local
   Postgres, plus the rows of the populated tables that NOT-AS-IS files
   constrain (in the 2026-09-23 run, `hivra_agents`, `crypto_deposit_receipts`,
   `yearly_token_quotes`, `yearly_token_subscriptions`). Apply the full ordered
   chain. Fix failures by a PR into `canary` (a reconciling migration), never by
   editing a merged file. Taking the dump creates a temporary database login, so
   it is an owner action.
2. **Before the Promote window:** ADDITIVE files whose objects the live build
   never touches, plus the SECURITY DEFINER revocations. The live build keeps
   working.
3. **In the Promote window, immediately before Promote:** the rest, in order.
   The NOT-AS-IS chain on `hivra_agents` adds guard triggers and constraints
   that the live private build does not satisfy. From that point until Promote,
   agent actions on the live build may fail, so keep the window short.
4. **Record-only:** a missing ledger row whose objects are all proven present
   (exact function bodies included) gets its ledger row only. Never record a row
   on name presence alone.
5. **Not in this release:** anything in
   `dashboard/supabase/_pending_destructive_migrations/`.

After the chain, re-run section 3. Required: every candidate migration has a
ledger row; the canary-only tables the candidate reads exist on production;
production has zero SECURITY DEFINER functions callable by `anon` or
`authenticated`; and no table in `public` has RLS off.

## 7. Promote (owner)

In the Vercel dashboard, project `hermesos`, select the staged candidate from
section 1.4 and choose **Promote**. Do not promote main's newest deployment
automatically if main has advanced.

## 8. Rollback (owner)

The rollback target is the deployment recorded in section 1.2. In the Vercel
dashboard, project `hermesos`, open that deployment and **Promote** it (or use
Instant Rollback to it). Confirm all four domains point back to it:
hivra.cloud, www.hivra.cloud, hermesos.cloud, www.hermesos.cloud.

Rollback restores code only. Before cutting over, decide that the migrated
schema can run under the old build or accept that it cannot:

- ADDITIVE objects are harmless to the old build.
- The `hivra_agents` guard triggers and constraints can reject the old build's
  writes. If the old build must run for more than a short period after a
  rollback, the owner needs a reviewed down-plan for those triggers. Write it
  and rehearse it with the section 6.1 rehearsal. None exists today.
- Cron side effects (quote retirements, sweeps) already made are not undone.

## 9. Post-Promote acceptance

Hard-reload first. Skew Protection keeps open tabs on the old build for up to
12 hours.

1. **Served SHA.** For each of hivra.cloud, www.hivra.cloud, hermesos.cloud and
   www.hermesos.cloud: the alias resolves to the candidate deployment, `source:
   git`, `ashneil12/hivra`, commit = main merge SHA. The HTML carries the same
   deployment id.
2. **Public pages.** `/` is the Hivra site, not the old "Hermes OS is now Hivra"
   page. `/token` returns 200 with the current token copy. `/docs/litepaper`
   redirects (307) to `/docs/litepaper/index.html`, which returns 200. Canary
   behaves this way today; the live build returns 404 for both. `/LITEPAPER.md` and
   `/WHITEPAPER.md` match the files at the candidate SHA byte for byte (or
   whatever `.vercelignore` says they should).
3. **Health.** `GET /api/health` is 200 and the JSON is not degraded. This is a
   smoke check only.
4. **Controls.** `node scripts/release/check-managed-hosting-controls.mjs --live`.
5. **Sign-in.** Clerk sign-in on hivra.cloud with an owned account reaches the
   dashboard.
6. **Launch an agent.** With an owned test account, launch one agent end to end
   until it answers, then delete it. No customer sessions, no spending without
   the owner's OK.
7. **Billing page.** Signed in, `/dashboard/billing` loads for a paid and a
   free account and shows the right plan. Signed out it returns 404 by design
   (same on Canary).
8. **Token tier cron.** The first scheduled `/api/cron/refresh-token-tiers` run
   after Promote must not return 500. Check the Vercel runtime logs for that
   path, or its cron heartbeat row. On a database without
   `apple_iap_subscriptions` it returns 500 ("Apple subscription scan failed")
   before making any tier decision.
9. **Drift cron.** `/api/cron/migration-drift-check` reports no missing
   migrations for the served manifest.
10. **Errors.** Vercel runtime errors for `hermesos` in the first hour: no new
    5xx class compared with Canary.

A check that could not run is reported as not run. It is never reported as
passed.
