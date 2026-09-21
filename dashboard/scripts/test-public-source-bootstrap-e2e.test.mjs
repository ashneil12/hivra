#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  parseBootstrapArguments,
  validateCandidateReceipt,
  validateRecoveryReceipt,
} from "./test-public-source-bootstrap-e2e.mjs";

test("accepts only a new owner-only empty work directory", async (t) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "hivra-public-bootstrap-test-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(parseBootstrapArguments(["--work-dir", directory]), { workDirectory: directory });
  writeFileSync(path.join(directory, "prior"), "held\n");
  assert.throws(() => parseBootstrapArguments(["--work-dir", directory]), /must be empty/);
  assert.throws(() => parseBootstrapArguments([]), /Usage/);
});

test("validates exact candidate and recovery identities", () => {
  const revision = "a".repeat(40);
  const archiveName = `hivra-source-${revision.slice(0, 12)}.tar.gz`;
  const candidate = {
    format: "hivra-public-source-candidate-v1",
    status: "review-candidate",
    releaseApproved: false,
    artifactClass: "source-only-current-tree",
    source: { commit: revision },
    checks: {
      cleanCommittedTree: true,
      releaseRegressionTests: "pass",
      archiveMatchesTrackedTree: true,
    },
    artifacts: [{ path: archiveName, sha256: "b".repeat(64), bytes: 123 }],
  };
  assert.deepEqual(validateCandidateReceipt(candidate, revision), {
    archiveName,
    archiveSha256: "b".repeat(64),
    archiveBytes: 123,
  });
  assert.throws(() => validateCandidateReceipt({ ...candidate, releaseApproved: true }, revision), /incomplete/);

  const recovery = {
    format: "hivra-self-host-recovery-e2e-v1",
    status: "pass",
    sourceRevision: revision,
    secretsPrinted: false,
    checks: {
      health: "pass",
      operatorLogin: "pass",
      recoveredMarker: "pass",
      infrastructureRegistry: "pass",
      hostedBillingGuard: "pass",
      originalLoopbackBindings: "pass",
      restoredLoopbackBindings: "pass",
      recoveredStorageBytes: "pass",
      masterKeyRotation: {
        secretCiphertextRewrapped: "pass",
        oldSecretKeyRejected: "pass",
        launchFingerprintKeyPreserved: "pass",
      },
    },
    cleanup: {
      originalUninstall: "pass",
      restoredUninstall: "pass",
      retainedComputerGuard: "pass",
    },
    resourcesRetainedForInspection: [],
  };
  assert.doesNotThrow(() => validateRecoveryReceipt(recovery, revision));
  assert.throws(() => validateRecoveryReceipt({ ...recovery, sourceRevision: "c".repeat(40) }, revision), /incomplete/);
  for (const check of ["originalLoopbackBindings", "restoredLoopbackBindings", "recoveredStorageBytes"]) {
    assert.throws(() => validateRecoveryReceipt({ ...recovery, checks: { ...recovery.checks, [check]: undefined } }, revision), /incomplete/);
  }
});
