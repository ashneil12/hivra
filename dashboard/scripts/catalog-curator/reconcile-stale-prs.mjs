#!/usr/bin/env node
// Reconcile stale one-pass curation PRs before the scheduler starts another.
//
// A curation branch is immutable evidence for one pass. Once Canary already
// contains every app a PR added, or a newer open PR carries the same app, the
// older dirty PR can never be the right merge candidate. Close that class only
// (without deleting branches). Ledger-only and unique-app PRs are reported for
// rebase/recovery, never auto-closed, because they can carry triage or evidence
// that Canary does not have yet.
//
//   node reconcile-stale-prs.mjs --dry-run   classify only
//   node reconcile-stale-prs.mjs             close redundant/superseded PRs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DASHBOARD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = path.resolve(DASHBOARD_DIR, "..");
const GH_REPO = process.env.CURATOR_GH_REPO || "ashneil12/hivra";
const DRY_RUN = process.argv.includes("--dry-run");

function gh(args) {
  return execFileSync("gh", [...args, "-R", GH_REPO], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function tryGh(args) {
  try {
    return gh(args);
  } catch {
    return null;
  }
}

function currentCatalogIds() {
  // Classify against the fetched canary ref, not whatever checkout happened to
  // invoke the scheduler. Fall back to the worktree only outside the repo.
  let index = "";
  try {
    index = execFileSync("git", ["-C", REPO_ROOT, "show", "origin/canary:dashboard/src/lib/hivra/catalog-manifests/manifests/index.ts"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  } catch {
    index = readFileSync(path.join(DASHBOARD_DIR, "src/lib/hivra/catalog-manifests/manifests/index.ts"), "utf8");
  }
  const body = index.split("export const UNIVERSAL_CATALOG_IDS = [")[1]?.split("] as const")[0] ?? "";
  return new Set([...body.matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1]));
}

function addedManifestIds(diff) {
  // Only count entries added by the PR. Context lines and deletions do not.
  return new Set([...diff.matchAll(/^\+\s*id:\s*"([a-z0-9-]+)"/gm)].map((match) => match[1]));
}

function ghApi(endpoint, extra = []) {
  return execFileSync("gh", ["api", endpoint, ...extra], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function filePaths(prNumber) {
  const raw = tryGh(["pr", "view", String(prNumber), "--json", "files", "--jq", ".files[].path"]);
  return raw ? raw.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

/**
 * Manifest ids a PR still uniquely carries. An entry already on canary needs no
 * recovery; an entry also carried by a newer open curation PR is superseded.
 * PR numbers increase in creation order for this one-pass branch flow.
 */
export function catalogIdsNeedingRecovery(ids, presentOnCanary, slugOwners, prNumber) {
  return ids.filter((id) => {
    if (presentOnCanary.has(id)) return false;
    return !(slugOwners.get(id) ?? []).some((number) => number > prNumber);
  });
}

function parseLedger(text) {
  const rows = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.slug) rows.set(row.slug, row);
    } catch {
      // A malformed historical line must not make reconciliation destructive.
    }
  }
  return rows;
}

function canaryLedger() {
  const text = execFileSync("git", ["-C", REPO_ROOT, "show", "origin/canary:dashboard/catalog-curation/candidates.jsonl"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return parseLedger(text);
}

function branchLedger(branch) {
  try {
    const encoded = ghApi(`repos/${GH_REPO}/contents/dashboard/catalog-curation/candidates.jsonl?ref=${encodeURIComponent(branch)}`, ["--jq", ".content"]);
    return parseLedger(Buffer.from(encoded.trim(), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function uniqueLedgerTransitions(head, canary) {
  if (!head) return ["head ledger unreadable"];
  const unique = [];
  for (const [slug, row] of head) {
    const current = canary.get(slug);
    if (!current) {
      unique.push(`${slug}: absent on canary`);
      continue;
    }
    if (current.status === row.status && current.reason === row.reason) continue;
    const headDate = Date.parse(row.checkedAt ?? "");
    const canaryDate = Date.parse(current.checkedAt ?? "");
    const headNotOlder = Number.isFinite(headDate) && Number.isFinite(canaryDate) ? headDate >= canaryDate : true;
    if (row.status !== "pending" && current.status === "pending" && headNotOlder) {
      unique.push(`${slug}: ${row.status} in PR but pending on canary`);
    }
  }
  return unique;
}

function closePr(pr, reason) {
  const comment = `Closing this stale one-pass curation PR: ${reason}. The branch is intentionally kept, so any unique evidence can still be recovered or rebased.`;
  if (DRY_RUN) return { closed: false, comment };
  gh(["pr", "close", String(pr.number), "--comment", comment]);
  return { closed: true, comment };
}

function main() {
  const raw = gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,headRefName,createdAt,updatedAt,mergeStateStatus,url"]);
  const prs = JSON.parse(raw)
    .filter((pr) => pr.headRefName.startsWith("curation/"))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const present = currentCatalogIds();
  const canaryRows = canaryLedger();
  const rows = [];
  const slugOwners = new Map();

  for (const pr of prs) {
    const diff = tryGh(["pr", "diff", String(pr.number)]) ?? "";
    const ids = [...addedManifestIds(diff)];
    const files = filePaths(pr.number);
    const ledgerOnly = files.length > 0 && files.every((file) => file === "dashboard/catalog-curation/candidates.jsonl");
    const ledgerUnique = ledgerOnly ? uniqueLedgerTransitions(branchLedger(pr.headRefName), canaryRows) : [];
    rows.push({ pr, ids, files, ledgerOnly, ledgerUnique });
    for (const id of ids) {
      if (!slugOwners.has(id)) slugOwners.set(id, []);
      slugOwners.get(id).push(pr.number);
    }
  }

  const report = [];
  for (const row of rows) {
    const { pr, ids, ledgerOnly, ledgerUnique } = row;
    const alreadyInCanary = ids.length > 0 && ids.every((id) => present.has(id));
    const needingRecovery = catalogIdsNeedingRecovery(ids, present, slugOwners, pr.number);
    const fullySuperseded = !alreadyInCanary && ids.length > 0 && needingRecovery.length === 0;
    let action = "keep";
    let reason = null;
    if (alreadyInCanary) {
      action = "close";
      reason = `all added catalog entries already exist on canary (${ids.join(", ")})`;
    } else if (fullySuperseded) {
      action = "close";
      reason = `every added catalog entry not yet on canary is carried by a newer open curation PR (${ids.filter((id) => !present.has(id)).join(", ")})`;
    } else if (ledgerOnly && ledgerUnique.length === 0) {
      action = "close";
      reason = "its ledger transitions are already represented or superseded on canary";
    } else if (ledgerOnly) {
      reason = `ledger-only PR kept for manual rebase/recovery; possible unique transitions: ${ledgerUnique.slice(0, 5).join("; ")}${ledgerUnique.length > 5 ? `; and ${ledgerUnique.length - 5} more` : ""}`;
    } else if (ids.length > 0) {
      reason = `contains catalog entries not on canary (${ids.filter((id) => !present.has(id)).join(", ") || ids.join(", ")})`;
    } else {
      reason = "no added manifest ids detected; left open for manual review";
    }

    if (action === "close") {
      try {
        const result = closePr(pr, reason);
        report.push({ number: pr.number, action: result.closed ? "closed" : "would-close", reason, url: pr.url });
      } catch (err) {
        report.push({ number: pr.number, action: "close-failed", reason: `${reason}; ${err?.message ?? err}`, url: pr.url });
      }
    } else {
      report.push({ number: pr.number, action: DRY_RUN ? "would-keep" : "kept", reason, url: pr.url });
    }
  }

  console.log(JSON.stringify({ repo: GH_REPO, dryRun: DRY_RUN, openCurationPrs: prs.length, report }, null, 2));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
