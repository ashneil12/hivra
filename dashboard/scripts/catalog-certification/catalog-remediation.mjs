#!/usr/bin/env node
/**
 * Choose and record cheap-agent remediation attempts for live catalog failures.
 *
 * The certifier proves what is broken. This planner only decides whether one
 * remediation agent may start; it never mutates Canary and never assumes a PR
 * fixed something until the certifier later proves it.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CERTIFICATION_LEDGER_SCHEMA, readCertificationLedger } from "./certification-plan.mjs";

export const REMEDIATION_LEDGER_SCHEMA = "hivra.catalog-remediation.v1";
const ACTIONABLE_FAILURES = new Set(["product", "not_offered"]);
const STARTED_STALE_MS = 3 * 60 * 60_000;
const ATTEMPT_BACKOFF_MS = 24 * 60 * 60_000;

function remediationError(message) {
  return new Error(`[catalog-remediation] ${message}`);
}

function parseTime(value) {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

export function readJsonLines(file, schema) {
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
      if (!schema || row?.schema === schema) rows.push({ ...row, ledgerLine: index + 1 });
    } catch {
      // Local operator state must fail open to a human retry, not wedge the loop.
    }
  });
  return rows;
}

function latestByProfile(rows) {
  const latest = new Map();
  for (const row of rows) {
    const existing = latest.get(row.profileId);
    if (!existing || (row.ledgerLine ?? 0) > (existing.ledgerLine ?? 0)) latest.set(row.profileId, row);
  }
  return latest;
}

export function remediationFingerprint(row) {
  return `${row.profileId}:${row.manifestSha256 ?? "unknown"}`;
}

function sanitizeReason(value) {
  return String(value ?? "")
    .replace(/\buser_[A-Za-z0-9]{6,}\b/g, "user_redacted")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "uuid_redacted")
    .replace(/https?:\/\/\S+[?#]\S+/g, "url-with-query-redacted")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function attemptBlocks(row, fingerprint, failureMs, nowMs) {
  if (row.fingerprint !== fingerprint) return null;
  const rowMs = parseTime(row.finishedAt ?? row.startedAt);
  if (row.status === "started" && nowMs - rowMs < STARTED_STALE_MS) return "remediation already running";
  if (row.status === "pr-open") return "remediation PR is open";
  if (row.status === "merged" && rowMs >= failureMs) return "a remediation merge is waiting for recertification";
  if (rowMs && nowMs - rowMs < ATTEMPT_BACKOFF_MS) return "remediation attempt is inside its backoff";
  return null;
}

/**
 * Pick one actionable latest certification failure. A target is skipped when
 * an attempt is already running, an open branch/PR exists for it, a merge is
 * waiting for recertification, or a failed attempt is inside its backoff.
 */
export function chooseRemediation({ certificationRows, remediationRows, openPrs = [], now = new Date() }) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw remediationError("invalid current time");
  const latest = latestByProfile(certificationRows.filter((row) => row.schema === CERTIFICATION_LEDGER_SCHEMA));
  const openBranches = new Set((openPrs ?? []).map((pr) => pr?.headRefName).filter(Boolean));
  const candidates = [];
  for (const row of latest.values()) {
    if (row.passed || !ACTIONABLE_FAILURES.has(row.failure?.category)) continue;
    const fingerprint = remediationFingerprint(row);
    const branchPrefix = `catalog-fix/${row.profileId}`;
    if ([...openBranches].some((branch) => branch === branchPrefix || branch.startsWith(`${branchPrefix}-`))) {
      continue;
    }
    const failureMs = parseTime(row.finishedAt ?? row.startedAt);
    const currentAttempts = remediationRows.map((attempt) => {
      if (attempt.status === "pr-open" && attempt.branch && !openBranches.has(attempt.branch)) {
        return { ...attempt, status: "stale-pr-open" };
      }
      return attempt;
    });
    const blocker = currentAttempts.map((attempt) => attemptBlocks(attempt, fingerprint, failureMs, nowMs)).find(Boolean);
    if (blocker) continue;
    candidates.push({
      profileId: row.profileId,
      tile: row.tile ?? row.profileId,
      fingerprint,
      canarySha: row.canarySha ?? null,
      manifestSha256: row.manifestSha256 ?? null,
      provisionerVersion: row.provisionerVersion ?? null,
      failure: {
        stage: row.failure?.stage ?? "unknown",
        category: row.failure?.category ?? "product",
        reason: sanitizeReason(row.failure?.reason),
      },
      evidenceFile: row.evidenceFile ?? null,
      runId: row.runId ?? null,
      failedAt: row.finishedAt ?? null,
    });
  }
  candidates.sort((a, b) => parseTime(a.failedAt) - parseTime(b.failedAt));
  return candidates[0] ?? null;
}

export function appendRemediationRow({ ledgerFile, row }) {
  if (row?.schema !== REMEDIATION_LEDGER_SCHEMA) throw remediationError("row has the wrong schema");
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  appendFileSync(ledgerFile, `${JSON.stringify(row)}\n`, "utf8");
  return row;
}

export function remediationRow({ target, status, branch, runId, prNumber = null, reason = null, now = () => new Date() }) {
  if (!target?.profileId || !target?.fingerprint) throw remediationError("target and fingerprint are required");
  if (!status) throw remediationError("status is required");
  return {
    schema: REMEDIATION_LEDGER_SCHEMA,
    profileId: target.profileId,
    fingerprint: target.fingerprint,
    status,
    branch: branch ?? null,
    runId: runId ?? null,
    prNumber,
    reason: reason ? sanitizeReason(reason) : null,
    canarySha: target.canarySha ?? null,
    manifestSha256: target.manifestSha256 ?? null,
    provisionerVersion: target.provisionerVersion ?? null,
    startedAt: now().toISOString(),
    ...(status === "started" ? {} : { finishedAt: now().toISOString() }),
  };
}

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) throw remediationError(`invalid option ${key ?? "<missing>"}`);
    if (key === "--choose" || key === "--append") {
      options.set(key, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) throw remediationError(`${key} needs a value`);
    options.set(key, value);
    index += 1;
  }
  return options;
}

function readJsonFile(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw remediationError(`could not read ${label} JSON`);
  }
}

function cli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const remediationLedger = options.get("--remediation-ledger");
  if (!remediationLedger) throw remediationError("--remediation-ledger is required");
  const remediationRows = readJsonLines(remediationLedger, REMEDIATION_LEDGER_SCHEMA);

  if (options.get("--append")) {
    const targetJson = options.get("--target-json");
    if (!targetJson) throw remediationError("--target-json is required when appending");
    const target = JSON.parse(targetJson);
    const row = remediationRow({
      target,
      status: options.get("--status"),
      branch: options.get("--branch"),
      runId: options.get("--run-id"),
      prNumber: options.get("--pr-number") ? Number.parseInt(options.get("--pr-number"), 10) : null,
      reason: options.get("--reason"),
    });
    return appendRemediationRow({ ledgerFile: remediationLedger, row });
  }

  const certLedger = options.get("--cert-ledger");
  if (!certLedger) throw remediationError("--cert-ledger is required");
  const openPrsFile = options.get("--open-prs");
  const openPrs = openPrsFile ? readJsonFile(openPrsFile, "open PR") : [];
  return chooseRemediation({
    certificationRows: readCertificationLedger(certLedger),
    remediationRows,
    openPrs,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const result = cli();
    if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export const __private = { sanitizeReason };
