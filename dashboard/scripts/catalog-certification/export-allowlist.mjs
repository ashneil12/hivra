#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadCatalog, readCertificationLedger } from "./certification-plan.mjs";

export function buildCertificationAllowlist(catalog, ledger, launchSeals) {
  const apps = {};
  for (const entry of catalog) {
    const row = ledger.findLast((candidate) => candidate.profileId === entry.id
      && candidate.manifestSha256 === entry.manifestSha256
      && (entry.requiresPinnedCatalogDigest
        ? candidate.provisionerVersion === launchSeals.pinned
        : launchSeals.unpinned.includes(candidate.provisionerVersion))
      && (candidate.passed === true || candidate.failure?.category === "product"));
    if (!row || row.passed !== true || row.sweepPassed !== true || row.sweepExitCode !== 0
      || row.reached !== "teardown" || row.failure
      || !/^[0-9a-f]{40}$/.test(row.canarySha)
      || row.canarySha !== row.checkoutSha || row.canarySha !== row.expectedCanarySha
      || row.expectedProvisionerVersion !== row.provisionerVersion
      || row.teardown?.agentsLeft !== 0 || row.teardown?.instancesLeft !== 0
      || row.teardown?.accountDeleted !== false || row.teardown?.error
      || !Number.isFinite(Date.parse(row.finishedAt))) continue;
    apps[entry.id] = {
      manifestSha256: row.manifestSha256,
      provisionerVersion: row.provisionerVersion,
      canarySha: row.canarySha,
      certifiedAt: row.finishedAt,
    };
  }
  return { apps };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [dashboard, ledgerFile] = process.argv.slice(2);
  if (!dashboard || !ledgerFile) {
    throw new Error("Usage: export-allowlist.mjs <dashboard-directory> <certification-ledger.jsonl>");
  }
  const ledger = readCertificationLedger(ledgerFile);
  if (ledger.length === 0) throw new Error("No certification ledger rows found");
  const launchSeals = JSON.parse(readFileSync(path.join(dashboard, "src/lib/hivra/catalog-manifests/launch-seals.json"), "utf8"));
  const output = buildCertificationAllowlist(loadCatalog(dashboard), ledger, launchSeals);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}
