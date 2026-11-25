#!/usr/bin/env node
/**
 * Choose the next universal-catalog entry for live certification.
 *
 * Certification is continuous but deliberately serial: one customer-visible
 * launch at a time. A target becomes due when it has never been certified,
 * when the manifest/provisioner/Canary revision changes after a failure, when
 * a passed manifest or provisioner changes, or when its periodic revalidation
 * is stale. Failed targets back off instead of hot-looping paid computers.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

export const CERTIFICATION_LEDGER_SCHEMA = "hivra.catalog-certification.v1";
export const DEFAULT_FAILURE_RETRY_HOURS = 24;
export const DEFAULT_HARNESS_RETRY_HOURS = 6;
export const DEFAULT_REVALIDATE_DAYS = 7;
export const PILOT_PRIORITY_IDS = ["it-tools", "vaultwarden", "umami", "nanobot", "openhands"];

function planError(message) {
  return new Error(`[catalog-certification-plan] ${message}`);
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function runtimeEvidence(manifest) {
  const runtime = manifest.runtime;
  if (!runtime || typeof runtime !== "object") throw planError(`manifest ${manifest.id ?? "<missing>"} has no runtime`);
  const hostPort = runtime.kind === "docker-web"
    ? runtime.hostPort ?? null
    : runtime.kind === "docker-stack"
      ? runtime.web?.hostPort ?? null
      : runtime.webService?.hostPort ?? null;
  const healthPath = runtime.kind === "docker-web"
    ? runtime.healthPath ?? null
    : runtime.kind === "docker-stack"
      ? runtime.web?.healthPath ?? null
      : runtime.webService?.healthPath ?? null;
  const runtimeRefs = runtime.kind === "docker-web"
    ? [`${runtime.imageRepo}:${runtime.imageTag}`]
    : runtime.kind === "docker-stack"
      ? (runtime.services ?? []).map((service) => `${service.imageRepo}:${service.imageTag}`)
      : runtime.installer?.method === "npm-global" || runtime.installer?.method === "uv-tool"
        ? [`${runtime.installer.method}:${runtime.installer.packageName}#${runtime.installer.binName}`]
        : [`github-release:${runtime.installer?.repo}#${runtime.installer?.assetX64}${runtime.installer?.assetArm64 ? `,${runtime.installer.assetArm64}` : ""}#${runtime.installer?.binName}`];
  return { runtimeKind: runtime.kind, hostPort, healthPath, runtimeRefs };
}

export function summarizeCatalog(manifests) {
  if (!Array.isArray(manifests) || manifests.length === 0) throw planError("catalog manifest list is empty");
  return manifests.map((manifest, index) => {
    if (!/^[a-z0-9-]+$/.test(manifest?.id ?? "")) throw planError("catalog manifest has an invalid id");
    return {
      id: manifest.id,
      name: manifest.name ?? manifest.id,
      category: manifest.category ?? "app",
      order: index,
      manifestSha256: sha256Json(manifest),
      ...runtimeEvidence(manifest),
    };
  });
}

/** Load the checkout's real TypeScript manifest registry through the existing dump helper. */
export function loadCatalog(dashboardDir) {
  const dump = path.join(dashboardDir, "scripts/catalog-curator/dump-manifest.ts");
  if (!existsSync(dump)) throw planError(`missing ${dump}`);
  let output;
  const tempDir = mkdtempSync(path.join(tmpdir(), "hivra-catalog-dump-"));
  const outputFile = path.join(tempDir, "catalog.json");
  let fd = null;
  try {
    // Older dump implementations exit immediately after one large stdout
    // write. Through a pipe that can truncate at the OS pipe buffer; a regular
    // file receives the whole write before process exit. Keep this file sink
    // even now that the dump helper is fixed, because certification must be
    // able to run against older exact Canary revisions while bootstrapping.
    fd = openSync(outputFile, "w");
    execFileSync(process.execPath, ["-r", "ts-node/register/transpile-only", dump, "--all"], {
      cwd: dashboardDir,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        TS_NODE_TRANSPILE_ONLY: "true",
        TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: "commonjs", moduleResolution: "node" }),
      },
      stdio: ["ignore", fd, "pipe"],
    });
    output = readFileSync(outputFile, "utf8");
  } catch (error) {
    const stderr = error?.stderr ? ` ${String(error.stderr).split("\n")[0].slice(0, 240)}` : "";
    throw planError(`could not load catalog manifests.${stderr}`);
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(tempDir, { recursive: true, force: true });
  }
  try {
    return summarizeCatalog(JSON.parse(output));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[catalog-certification-plan]")) throw error;
    throw planError("catalog dump did not produce valid JSON");
  }
}

export function readProvisionerVersion(dashboardDir) {
  const file = path.join(dashboardDir, "src/lib/infrastructure/portable-provisioner-contract.ts");
  const text = readFileSync(file, "utf8");
  const match = text.match(/PORTABLE_HIVRA_PROVISIONER_VERSION\s*=\s*"([0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+)"/);
  if (!match) throw planError("could not read PORTABLE_HIVRA_PROVISIONER_VERSION");
  return match[1];
}

export function readCertificationLedger(file) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const row = JSON.parse(line);
      if (row?.schema === CERTIFICATION_LEDGER_SCHEMA && typeof row.profileId === "string") {
        rows.push({ ...row, ledgerLine: index + 1 });
      }
    } catch {
      // A malformed local state line must not stop certification. It simply
      // cannot count as evidence either way.
    }
  });
  return rows;
}

function parseTime(value) {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

function latestRowsByProfile(ledgerRows) {
  const latest = new Map();
  for (const row of ledgerRows) {
    const existing = latest.get(row.profileId);
    if (!existing || (row.ledgerLine ?? 0) > (existing.ledgerLine ?? 0)) latest.set(row.profileId, row);
  }
  return latest;
}

function inputsChanged(row, entry, currentProvisionerVersion) {
  return row.manifestSha256 !== entry.manifestSha256 || row.provisionerVersion !== currentProvisionerVersion;
}

function dueRowState({ entry, row, nowMs, currentCanarySha, currentProvisionerVersion, failureRetryHours, harnessRetryHours, revalidateDays }) {
  if (!row) return { due: true, reason: "never-certified", group: 0, dueAtMs: 0 };
  const finishedMs = parseTime(row.finishedAt ?? row.startedAt);
  if (!finishedMs) return { due: true, reason: "last-attempt-unusable", group: 2, dueAtMs: 0 };

  if (!row.passed) {
    const harness = row.failure?.category === "harness_bug" || row.failure?.category === "harness_environment";
    if (inputsChanged(row, entry, currentProvisionerVersion) || row.canarySha !== currentCanarySha) {
      return { due: true, reason: "inputs-changed-since-failure", group: 1, dueAtMs: finishedMs };
    }
    const retryHours = harness ? harnessRetryHours : failureRetryHours;
    const dueAtMs = finishedMs + retryHours * 60 * 60_000;
    return {
      due: nowMs >= dueAtMs,
      reason: harness ? "harness-retry-backoff" : "failure-retry-backoff",
      group: 2,
      dueAtMs,
    };
  }

  if (inputsChanged(row, entry, currentProvisionerVersion)) {
    return { due: true, reason: "inputs-changed-since-pass", group: 1, dueAtMs: finishedMs };
  }
  const dueAtMs = finishedMs + revalidateDays * 24 * 60 * 60_000;
  return {
    due: nowMs >= dueAtMs,
    reason: "periodic-revalidation",
    group: 3,
    dueAtMs,
  };
}

function compareEntries(a, b) {
  return a.entry.order - b.entry.order;
}

/**
 * Return the next due entry, or null. The ordering is intentional: prove the
 * runtime matrix first, then new agents before new apps, then fixes whose
 * inputs changed, then backed-off failures, then periodic revalidation.
 */
export function chooseCertificationTarget({
  catalog,
  ledgerRows,
  currentCanarySha,
  currentProvisionerVersion,
  now = new Date(),
  failureRetryHours = DEFAULT_FAILURE_RETRY_HOURS,
  harnessRetryHours = DEFAULT_HARNESS_RETRY_HOURS,
  revalidateDays = DEFAULT_REVALIDATE_DAYS,
  priorityIds = PILOT_PRIORITY_IDS,
}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw planError("invalid current time");
  if (!/^[0-9a-f]{40}$/.test(currentCanarySha ?? "")) throw planError("currentCanarySha must be a full lowercase SHA");
  if (!currentProvisionerVersion) throw planError("currentProvisionerVersion is required");
  const latest = latestRowsByProfile(ledgerRows);
  const candidates = catalog.map((entry) => ({
    entry,
    row: latest.get(entry.id) ?? null,
    state: dueRowState({
      entry,
      row: latest.get(entry.id) ?? null,
      nowMs,
      currentCanarySha,
      currentProvisionerVersion,
      failureRetryHours,
      harnessRetryHours,
      revalidateDays,
    }),
  })).filter((candidate) => candidate.state.due);

  const priorityIndex = new Map(priorityIds.map((id, index) => [id, index]));
  candidates.sort((a, b) => {
    const aPilot = priorityIndex.has(a.entry.id) && !a.row;
    const bPilot = priorityIndex.has(b.entry.id) && !b.row;
    if (aPilot || bPilot) {
      if (aPilot && bPilot) return priorityIndex.get(a.entry.id) - priorityIndex.get(b.entry.id);
      return aPilot ? -1 : 1;
    }
    if (a.state.group !== b.state.group) return a.state.group - b.state.group;
    if (!a.row && !b.row) {
      const aAgent = a.entry.category === "agent" ? 0 : 1;
      const bAgent = b.entry.category === "agent" ? 0 : 1;
      if (aAgent !== bAgent) return aAgent - bAgent;
      return compareEntries(a, b);
    }
    if ((a.state.dueAtMs ?? 0) !== (b.state.dueAtMs ?? 0)) return (a.state.dueAtMs ?? 0) - (b.state.dueAtMs ?? 0);
    return compareEntries(a, b);
  });

  const chosen = candidates[0] ?? null;
  return chosen
    ? {
        ...chosen.entry,
        reason: chosen.state.reason,
        lastResult: chosen.row
          ? {
              passed: chosen.row.passed,
              finishedAt: chosen.row.finishedAt ?? null,
              canarySha: chosen.row.canarySha ?? null,
              failure: chosen.row.failure ?? null,
            }
          : null,
      }
    : null;
}

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) throw planError(`invalid option ${key ?? "<missing>"}`);
    if (key === "--choose" || key === "--report") {
      options.set(key, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw planError(`${key} needs a value`);
    if (options.has(key)) throw planError(`${key} may be supplied only once`);
    options.set(key, value);
    index += 1;
  }
  return options;
}

function report(catalog, ledgerRows, currentCanarySha, currentProvisionerVersion) {
  const latest = latestRowsByProfile(ledgerRows);
  const rows = catalog.map((entry) => {
    const row = latest.get(entry.id) ?? null;
    return {
      id: entry.id,
      category: entry.category,
      runtimeKind: entry.runtimeKind,
      manifestSha256: entry.manifestSha256,
      certified: Boolean(row?.passed && row.manifestSha256 === entry.manifestSha256 && row.provisionerVersion === currentProvisionerVersion),
      last: row
        ? {
            passed: row.passed,
            finishedAt: row.finishedAt ?? null,
            canarySha: row.canarySha ?? null,
            failure: row.failure ?? null,
          }
        : null,
    };
  });
  return {
    currentCanarySha,
    currentProvisionerVersion,
    total: rows.length,
    certifiedCurrentInputs: rows.filter((row) => row.certified).length,
    rows,
  };
}

function cli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const dashboardDir = options.get("--dashboard");
  const ledger = options.get("--ledger");
  const canarySha = options.get("--canary-sha");
  if (!dashboardDir || !ledger || !canarySha) throw planError("--dashboard, --ledger and --canary-sha are required");
  const catalog = loadCatalog(dashboardDir);
  const provisionerVersion = options.get("--provisioner-version") ?? readProvisionerVersion(dashboardDir);
  const ledgerRows = readCertificationLedger(ledger);
  if (options.get("--report")) return report(catalog, ledgerRows, canarySha, provisionerVersion);
  const chosen = chooseCertificationTarget({
    catalog,
    ledgerRows,
    currentCanarySha: canarySha,
    currentProvisionerVersion: provisionerVersion,
  });
  if (!chosen) return null;
  return options.get("--choose") ? chosen.id : chosen;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const result = cli();
    if (typeof result === "string") process.stdout.write(`${result}\n`);
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
