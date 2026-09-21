#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { cleanupRecoverySteps, resolveSourceRevision, waitForDatabaseRecovery } from "./test-self-host-recovery-e2e.mjs";

test("uses an explicit revision for a Git-free exported source tree", async (t) => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "hivra-exported-source-test-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const revision = "a".repeat(40);
  assert.equal(resolveSourceRevision(revision, directory), revision);
  assert.throws(
    () => resolveSourceRevision(undefined, directory),
    /bind the recovery rehearsal to an exact source revision/,
  );
});

test("rejects a malformed explicit revision", () => {
  assert.throws(() => resolveSourceRevision("HEAD"), /explicit source revision is invalid/);
  assert.throws(() => resolveSourceRevision("A".repeat(40)), /explicit source revision is invalid/);
});

test("cleanup attempts every owned step even if an earlier step fails", async () => {
  const visited = [];
  await assert.rejects(cleanupRecoverySteps([
    ["launcher", async () => { visited.push("launcher"); throw new Error("private process detail"); }],
    ["original-state", async () => { visited.push("original"); }],
    ["restored-state", async () => { visited.push("restored"); }],
  ]), error => /launcher/.test(error.message) && !/private process detail/.test(error.message));
  assert.deepEqual(visited, ["launcher", "original", "restored"]);
});

test("database recovery waits for Docker health before accepting REST marker readiness", async () => {
  let inspections = 0;
  let markerReads = 0;
  assert.equal(await waitForDatabaseRecovery({
    marker: "owned-marker", timeoutMs: 1000, pollIntervalMs: 1,
    readContainerState: () => ({ Running: true, Health: { Status: ++inspections === 1 ? "starting" : "healthy" } }),
    readMarker: () => { markerReads += 1; return "owned-marker"; },
  }), true);
  assert.equal(inspections, 2);
  assert.equal(markerReads, 1);
});

test("healthy database with wrong restored marker never passes recovery", async () => {
  assert.equal(await waitForDatabaseRecovery({
    marker: "owned-marker", timeoutMs: 10, pollIntervalMs: 1,
    readContainerState: () => ({ Running: true, Health: { Status: "healthy" } }),
    readMarker: () => "different-marker",
  }), false);
});
