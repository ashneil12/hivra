#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const dashboardRoot = path.resolve(path.dirname(scriptPath), "..");
const repositoryRoot = path.resolve(dashboardRoot, "..");

function fail(message) {
  throw new Error(message);
}

function sha256(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

export function parseBootstrapArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--work-dir" || !path.isAbsolute(argv[1])) {
    fail("Usage: npm run test:self-host-public-source -- --work-dir /absolute/empty/private/directory");
  }
  const workDirectory = realpathSync(argv[1]);
  const metadata = statSync(workDirectory);
  if (
    !metadata.isDirectory() ||
    typeof process.getuid !== "function" ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o077) !== 0
  ) {
    fail("The public-source test work directory must already exist and be owner-only (normally chmod 700).");
  }
  if (readdirSync(workDirectory).length !== 0) {
    fail("The public-source test work directory must be empty; no prior evidence is overwritten.");
  }
  return { workDirectory };
}

export function validateCandidateReceipt(receipt, expectedRevision) {
  if (
    receipt?.format !== "hivra-public-source-candidate-v1" ||
    receipt?.status !== "review-candidate" ||
    receipt?.releaseApproved !== false ||
    receipt?.artifactClass !== "source-only-current-tree" ||
    receipt?.source?.commit !== expectedRevision ||
    receipt?.checks?.cleanCommittedTree !== true ||
    receipt?.checks?.releaseRegressionTests !== "pass" ||
    receipt?.checks?.archiveMatchesTrackedTree !== true
  ) {
    fail("The generated public-source candidate receipt is incomplete or bound to another revision.");
  }
  const archiveName = `hivra-source-${expectedRevision.slice(0, 12)}.tar.gz`;
  const artifact = receipt.artifacts?.find((entry) => entry?.path === archiveName);
  if (!artifact || !/^[0-9a-f]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
    fail("The generated public-source candidate does not contain its exact source archive receipt.");
  }
  return { archiveName, archiveSha256: artifact.sha256, archiveBytes: artifact.bytes };
}

export function validateRecoveryReceipt(receipt, expectedRevision) {
  if (
    receipt?.format !== "hivra-self-host-recovery-e2e-v1" ||
    receipt?.status !== "pass" ||
    receipt?.sourceRevision !== expectedRevision ||
    receipt?.secretsPrinted !== false ||
    receipt?.checks?.health !== "pass" ||
    receipt?.checks?.operatorLogin !== "pass" ||
    receipt?.checks?.recoveredMarker !== "pass" ||
    receipt?.checks?.infrastructureRegistry !== "pass" ||
    receipt?.checks?.hostedBillingGuard !== "pass" ||
    receipt?.checks?.masterKeyRotation?.secretCiphertextRewrapped !== "pass" ||
    receipt?.checks?.originalLoopbackBindings !== "pass" ||
    receipt?.checks?.restoredLoopbackBindings !== "pass" ||
    receipt?.checks?.recoveredStorageBytes !== "pass" ||
    receipt?.checks?.masterKeyRotation?.oldSecretKeyRejected !== "pass" ||
    receipt?.checks?.masterKeyRotation?.launchFingerprintKeyPreserved !== "pass" ||
    receipt?.cleanup?.originalUninstall !== "pass" ||
    receipt?.cleanup?.restoredUninstall !== "pass" ||
    receipt?.cleanup?.retainedComputerGuard !== "pass" ||
    !Array.isArray(receipt?.resourcesRetainedForInspection) ||
    receipt.resourcesRetainedForInspection.length !== 0
  ) {
    fail("The exported-source recovery receipt is incomplete or bound to another revision.");
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.inherit === false ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: options.timeout ?? 60 * 60 * 1000,
  });
  if (result.error || result.status !== 0) {
    fail(options.failure ?? `${command} failed during the exact public-source bootstrap rehearsal.`);
  }
  return result;
}

function exactHead() {
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { inherit: false });
  if (status.stdout.length !== 0) fail("Commit and clean the source tree before running the exact public-source rehearsal.");
  const head = run("git", ["rev-parse", "HEAD"], { inherit: false }).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(head)) fail("Could not resolve an exact source revision.");
  return head;
}

async function main(argv = process.argv.slice(2)) {
  const { workDirectory } = parseBootstrapArguments(argv);
  const sourceRevision = exactHead();
  const candidateDirectory = path.join(workDirectory, "candidate");
  const sourceDirectory = path.join(workDirectory, "source");
  const recoveryDirectory = path.join(workDirectory, "recovery");
  const finalReceiptPath = path.join(workDirectory, "public-source-bootstrap-e2e.json");

  run(process.execPath, [
    "scripts/release/public-source-candidate.mjs",
    "--out", candidateDirectory,
    "--commit", sourceRevision,
  ]);
  const candidateBytes = await readFile(path.join(candidateDirectory, "candidate.json"));
  const candidate = JSON.parse(candidateBytes);
  const archive = validateCandidateReceipt(candidate, sourceRevision);
  const archivePath = path.join(candidateDirectory, archive.archiveName);
  const archiveBytes = await readFile(archivePath);
  if (sha256(archiveBytes) !== archive.archiveSha256 || archiveBytes.length !== archive.archiveBytes) {
    fail("The public-source archive bytes do not match the candidate receipt.");
  }

  await mkdir(sourceDirectory, { mode: 0o700 });
  await mkdir(recoveryDirectory, { mode: 0o700 });
  run("tar", ["-xzf", archivePath, "-C", sourceDirectory], {
    failure: "The exact public-source archive could not be extracted.",
  });

  const exportedDashboard = path.join(sourceDirectory, "dashboard");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  run(npm, ["ci"], {
    cwd: exportedDashboard,
    failure: "The exact exported dependency lock did not install cleanly.",
  });
  run(npm, ["run", "self-host:doctor"], {
    cwd: exportedDashboard,
    failure: "The exact exported self-host prerequisites did not pass.",
  });
  run(npm, [
    "run", "test:self-host-recovery", "--",
    "--work-dir", recoveryDirectory,
    "--source-revision", sourceRevision,
  ], {
    cwd: exportedDashboard,
    failure: "The exact exported self-host recovery rehearsal did not pass.",
  });

  const recoveryBytes = await readFile(path.join(recoveryDirectory, "recovery-e2e.json"));
  const recovery = JSON.parse(recoveryBytes);
  validateRecoveryReceipt(recovery, sourceRevision);
  const receipt = {
    format: "hivra-public-source-bootstrap-e2e-v1",
    status: "pass",
    releaseApproved: false,
    sourceRevision,
    candidateReceiptSha256: sha256(candidateBytes),
    sourceArchive: archive,
    dependencyInstall: "pass",
    selfHostDoctor: "pass",
    recoveryReceiptSha256: sha256(recoveryBytes),
    recoveryChecks: recovery.checks,
    cleanup: {
      candidateRemoved: "pass",
      exportedSourceRemoved: "pass",
      nestedRecoveryEvidenceRemoved: "pass",
      retainedProviderResources: [],
    },
    warning: "This closes exact exported-source bootstrap and local recovery only. Live provider/runtime acceptance and remaining public-release review gates are separate.",
  };

  await rm(candidateDirectory, { recursive: true, force: false });
  await rm(sourceDirectory, { recursive: true, force: false });
  await rm(recoveryDirectory, { recursive: true, force: false });
  await writeFile(finalReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(finalReceiptPath, 0o600);
  process.stdout.write(`${JSON.stringify({ status: receipt.status, sourceRevision, receipt: finalReceiptPath })}\n`);
}

if (path.resolve(process.argv[1] || "") === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`ERROR  ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
