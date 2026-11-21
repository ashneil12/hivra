---
name: catalog-curator
description: Run one unattended curation pass of Hivra's universal catalog. Finds new open-source apps and agents, writes one manifest per candidate, gates each on the deterministic verifier, and ships passing entries to Canary in a small PR. Use for "/catalog-curator", "add more apps to the catalog", or when the scheduled curator loop starts.
---

# Catalog curator (one pass)

You are running unattended. Nobody will answer questions. Decide, record the
reason, and keep going. A pass is a bounded batch. The scheduler starts the
next one.

## What counts as done

A candidate is accepted only when `npm run catalog:verify -- <slug>` (run from
`dashboard/`) exits 0 and writes
`dashboard/catalog-curation/evidence/<slug>.json` with `"verdict": "pass"`.
Never write or edit an evidence file by hand. Never weaken a check to make an
app pass. If the verifier is wrong, stop and write that down in the pass notes
(see "Finish"). Do not patch the verifier.

## Hard limits

Change only these paths:
- `dashboard/src/lib/hivra/catalog-manifests/manifests/*.ts` (category files; add entries, do not edit or remove someone else's entry except to remove one you added this pass)
- `apps/shared/native-contract/route-grammar.v1.json` (the two value-set cases per app: `profile=<slug>&stage=choose` and `infrastructure?launch=<slug>`, next to the other catalog slugs)
- `dashboard/catalog-curation/evidence/*.json` (written by the verifier only)

Never touch the schema, the licence list, the mount policy, the guest runner,
the gateway, migrations, tests, CI, Vercel, any database, or production.
Never add secrets or real credentials to a manifest. Never deploy. Never
force-push. Never merge a PR whose CI is not fully green or whose diff leaves
the paths above.

## Setup

1. Work in `$CURATOR_WORKTREE` (the runner script prepares it on a fresh
   branch from `origin/canary`). Confirm `git status` is clean.
2. `docker info` must succeed. If Docker is down, run `open -a Docker`, wait
   up to 3 minutes, and stop the pass if it is still down.
3. `gh auth status` must succeed.

## 1. Refill the queue

Read `dashboard/catalog-curation/candidates.jsonl` and the registry ids
(`rg -o 'id: "[a-z0-9-]+"' dashboard/src/lib/hivra/catalog-manifests/manifests`).
If fewer than 15 lines have `"status": "pending"`, add new candidates (dedupe
by slug and by sourceUrl against both) from, in order:
- `https://github.com/awesome-selfhosted/awesome-selfhosted-data`, the
  `software/*.yml` files (use `gh api` or a shallow clone in /tmp). Prefer
  entries that list a Docker platform and a licence on the allowlist.
- GitHub search: `gh search repos --topic self-hosted --stars '>800' --sort stars`,
  then the same for topics `ai-agent`, `llm`, `agents`, `homelab`,
  `docker-image`.
- Well-known open-source AI agents, AI apps and developer tools you know of.

Each new line: `{"slug","name","sourceUrl","status":"pending","reason":"","checkedAt":"<today>"}`.
Slugs follow `^[a-z][a-z0-9-]{1,38}[a-z0-9]$`.

## 2. Triage fast, before writing anything

Work through pending candidates until 5 are accepted, 25 have been triaged,
or 90 minutes have passed, whichever comes first. Do not just go by stars:
big platforms usually need a database. Try first the ones whose docs show a
single `docker run` with SQLite or file storage. Reject early and record the
status and a one-line reason:
- `rejected`: licence not in `CATALOG_OSI_LICENSES` (check
  `gh api repos/<o>/<r> --jq .license.spdx_id`; NOASSERTION and Other count as
  rejected), archived repo, no official container image and no installable
  CLI, needs docker.sock, privileged mode, host networking or a GPU, or keeps
  its only state under a forbidden mount path (/etc, /usr, /var/run and the
  rest in schema.ts).
- `compose-needed`: needs Postgres, MySQL, Redis, Mongo or a second container.
- `needs-secret`: refuses to boot without a secret key we would have to invent.
- `needs-public-url`: needs its public URL or hostname in env to work.
- `pending` with reason `rate-limited`: Docker Hub returned 429. Stop pulling
  for the rest of the pass.

## 3. Write the manifest

Copy the shape of a similar existing entry in the right category file. Rules:
- Official upstream image (vendor's Docker Hub, ghcr.io or quay.io). Use
  linuxserver.io only when upstream publishes none. Prefer a major-version tag
  over `latest` when upstream publishes one.
- `containerPort` and `volumes` from the upstream docs. Stateless apps still
  need one volume on a harmless documented path.
- Also add the slug to `UNIVERSAL_CATALOG_IDS` in
  `manifests/index.ts` at the position matching the category file order,
  and add the two value-set cases to
  `apps/shared/native-contract/route-grammar.v1.json`. Wait, that file is
  already listed above — follow the existing komga entries' shape.
  `manifests/index.ts`, at the same position the entry has in the
  concatenated category files (the test compares the two lists in order).
- `hostPort`: the next free port in 3200-3999 (one higher than the current
  maximum in the registry).
- Static env only when upstream documents it and it has a safe default. No
  secrets.
- CLI agents (`cli-web`): verify every flag in `--help` output from a local
  install before using it. Use `modelEnv`, `managedVenice: true` and `llm` the
  way `zeroclaw` and `aider` do.
- Copy: plain, factual, no em or en dashes, no claims you did not verify. Do
  not imply a web UI when the root is a JSON API. `metaDescription` ends with
  "From $9.99/mo." like the others.
- Sizes from the verifier's measured memory: `floor.ram` at least 1.5x idle
  memory rounded up to a whole GB, `minPlan: "pro"`, `weight: 1`.

## 4. Verify

From `dashboard/`: `npm run catalog:verify -- <slug>`.
- Exit 0: set the ledger line to `accepted` with reason
  `evidence catalog-curation/evidence/<slug>.json`.
- Non-zero: try at most one documented fix (an env var or
  `proxyMode: "loopback-origin"`) and rerun. If it still fails, delete the
  manifest entry and its evidence file, and record the matching status and the
  verifier's failing check as the reason.

## 5. Ship the batch

When the batch has at least one accepted app:
1. From `dashboard/`: `npx jest src/lib/hivra/__tests__/catalog-manifests.test.ts src/lib/hivra/__tests__/agent-catalog.test.ts src/lib/__tests__/native-route-grammar.test.ts`
   (find the right paths with `rg --files -g '*native-route-grammar*'` if they
   moved) and `npm run typecheck`. Fix only your own manifest entries.
2. Commit with message `Add <n> catalog apps: <names>` and the Devin
   co-author trailer. Push the branch and open a PR to `canary` titled the
   same, body listing each app with licence, image and evidence path, plus the
   rejected ones with reasons.
3. Wait for CI (`gh pr checks <n> --watch`). If every check passes and
   `gh pr diff <n> --name-only` lists only the allowed paths, merge with
   `gh pr merge <n> --merge --delete-branch`. Otherwise leave the PR open and
   say why in the pass notes.

When nothing was accepted, still ship the ledger changes the same way
(commit, push, PR, merge when green). A pass that leaves its ledger only on
the local branch loses its work, because the next pass starts from
`origin/canary`.

## Finish

Append a short entry to `~/.local/state/hivra-catalog-curator/notes.md`:
date, PR number and state, accepted and rejected counts, anything that looked
wrong (verifier doubts, flaky CI, rate limits). Then stop.
