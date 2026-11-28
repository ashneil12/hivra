#!/usr/bin/env node
/**
 * Append one sanitized launch-sweep result to the local certification ledger.
 *
 * Raw sweep evidence stays in the operator's state directory. The ledger keeps
 * only the fields needed to decide what to certify next and to explain why:
 * no account ids, agent ids, Clerk ids, bearer material, or env values.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CERTIFICATION_LEDGER_SCHEMA } from "./certification-plan.mjs";

const SWEEP_SCHEMA = "hivra.launch-sweep.v1";

function appendError(message) {
  return new Error(`[append-certification-result] ${message}`);
}

function parseArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw appendError(`invalid option ${key ?? "<missing>"}`);
    if (options.has(key)) throw appendError(`${key} may be supplied only once`);
    options.set(key, value);
  }
  return options;
}

function required(options, name) {
  const value = options.get(name);
  if (!value) throw appendError(`${name} is required`);
  return value;
}

function readSweepResult(file) {
  try {
    const row = JSON.parse(readFileSync(file, "utf8"));
    return row?.schema === SWEEP_SCHEMA ? row : null;
  } catch {
    return null;
  }
}

function safeReason(value) {
  return String(value ?? "")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "email_redacted")
    .replace(/\buser_[A-Za-z0-9]{6,}\b/g, "user_redacted")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "uuid_redacted")
    .replace(/https?:\/\/\S+[?#]\S+/g, "url-with-query-redacted")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

export function certificationRunDisposition(row) {
  if (!row.evidenceFile || (row.sweepPassed && !row.teardown) || row.teardown && (
    row.teardown.error || row.teardown.agentsLeft !== 0 ||
    row.teardown.instancesLeft !== 0 || row.teardown.accountDeleted !== false
  )) return "hold";
  if (row.failure?.stage === "account") return "account";
  return row.passed ? "pass" : "fail";
}

export function certificationRowFromSweep({ result, file, target, canarySha, provisionerVersion, runId, sweepExitCode, now = () => new Date() }) {
  if (!result) {
    return {
      schema: CERTIFICATION_LEDGER_SCHEMA,
      profileId: target,
      runId,
      canarySha,
      provisionerVersion,
      passed: false,
      finishedAt: now().toISOString(),
      sweepExitCode,
      failure: {
        stage: "runner",
        category: "harness_environment",
        reason: "launch sweep produced no result file",
      },
    };
  }

  const revisionMatches = result.checkoutSha === canarySha && result.expectedCanarySha === canarySha;
  const teardown = result.teardown
    ? {
        agentsLeft: result.teardown.agentsLeft ?? 0,
        instancesLeft: result.teardown.instancesLeft ?? 0,
        accountDeleted: Boolean(result.teardown.accountDeleted),
        error: result.teardown.error ? safeReason(result.teardown.error) : undefined,
      }
    : null;
  const cleanupLeaked = Boolean(teardown && (teardown.agentsLeft > 0 || teardown.instancesLeft > 0));
  const cleanupVerified = Boolean(teardown && !teardown.error && result.teardown.accountDeleted === false &&
    result.teardown.agentsLeft === 0 && result.teardown.instancesLeft === 0);
  let passed = Boolean(result.passed) && revisionMatches && cleanupVerified && sweepExitCode === 0;
  let failure = result.failure
    ? {
        stage: result.failure.stage,
        category: result.failure.category,
        reason: safeReason(result.failure.reason),
      }
    : null;
  if (!revisionMatches) {
    passed = false;
    failure = {
      stage: "runner",
      category: "harness_environment",
      reason: "sweep revision evidence does not match the served Canary SHA",
    };
  } else if (cleanupLeaked) {
    passed = false;
    failure = {
      stage: "teardown",
      category: "harness_environment",
      reason: "teardown left paid computers or agent records behind",
    };
  } else if (result.passed && !cleanupVerified) {
    failure = {
      stage: "teardown",
      category: "harness_environment",
      reason: "teardown did not verify an empty and preserved certification account",
    };
  } else if (result.passed && sweepExitCode !== 0) {
    failure = {
      stage: "runner",
      category: "harness_environment",
      reason: "launch sweep did not exit successfully",
    };
  }

  return {
    schema: CERTIFICATION_LEDGER_SCHEMA,
    profileId: result.profileId ?? target,
    tile: result.tile,
    runId,
    canarySha,
    provisionerVersion,
    checkoutSha: result.checkoutSha ?? null,
    expectedCanarySha: result.expectedCanarySha ?? null,
    expectedProvisionerVersion: result.expectedProvisionerVersion ?? null,
    manifestSha256: result.catalog?.manifestSha256 ?? null,
    runtimeKind: result.catalog?.runtimeKind ?? null,
    runtimeRefs: Array.isArray(result.catalog?.runtimeRefs) ? result.catalog.runtimeRefs : [],
    startedAt: result.startedAt ?? null,
    finishedAt: result.finishedAt ?? now().toISOString(),
    passed,
    sweepPassed: Boolean(result.passed),
    reached: result.reached ?? null,
    failure,
    teardown,
    sweepExitCode,
    evidenceFile: path.basename(file),
    screenshots: Array.isArray(result.screenshots) ? result.screenshots.map((name) => path.basename(String(name))) : [],
  };
}

export function appendCertificationResult({ ledgerFile, row }) {
  if (row?.schema !== CERTIFICATION_LEDGER_SCHEMA) throw appendError("row has the wrong schema");
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  appendFileSync(ledgerFile, `${JSON.stringify(row)}\n`, "utf8");
  return row;
}

function cli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const ledgerFile = required(options, "--ledger");
  const outDir = required(options, "--out-dir");
  const target = required(options, "--target");
  const canarySha = required(options, "--canary-sha");
  const provisionerVersion = required(options, "--provisioner-version");
  const runId = required(options, "--run-id");
  const sweepExitCode = Number.parseInt(required(options, "--sweep-exit-code"), 10);
  if (!Number.isFinite(sweepExitCode)) throw appendError("--sweep-exit-code must be an integer");
  const file = path.join(outDir, `${runId}-${target}.json`);
  const result = existsSync(file) ? readSweepResult(file) : null;
  const row = certificationRowFromSweep({
    result,
    file,
    target,
    canarySha,
    provisionerVersion,
    runId,
    sweepExitCode,
  });
  return appendCertificationResult({ ledgerFile, row });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(cli(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
