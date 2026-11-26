import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { buildTestEnvExports, selectProductionEnvValue, shellQuote } from "../catalog-certification/canary-test-env.mjs";
import { certificationRowFromSweep } from "../catalog-certification/append-certification-result.mjs";
import { chooseRemediation, remediationFingerprint, remediationRow, REMEDIATION_LEDGER_SCHEMA } from "../catalog-certification/catalog-remediation.mjs";
import {
  CERTIFICATION_LEDGER_SCHEMA,
  chooseCertificationTarget,
  readProvisionerVersion,
  summarizeCatalog,
} from "../catalog-certification/certification-plan.mjs";
import { parseServedRevision } from "../catalog-certification/served-canary-revision.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const HOST = "canary.hermesos.cloud";
const PROVISIONER = "2026.11.25.2";
const NOW = new Date("2026-11-25T12:00:00.000Z");

function inspectFixture(overrides = {}) {
  return JSON.stringify({
    id: "dpl_2W4wvcDcfy51XFEgBkGF5nfc8tGn",
    readyState: "READY",
    target: "production",
    aliases: [HOST],
    ...overrides,
  });
}

function deploymentFixture(overrides = {}) {
  return JSON.stringify({
    id: "dpl_2W4wvcDcfy51XFEgBkGF5nfc8tGn",
    source: "git",
    readyState: "READY",
    target: "production",
    alias: [HOST],
    gitSource: { type: "github", ref: "canary", sha: SHA },
    meta: {
      githubHost: "github.com",
      githubOrg: "ashneil12",
      githubRepo: "hivra",
      githubCommitRef: "canary",
      githubCommitSha: SHA,
    },
    project: { id: "prj_example", name: "hermesos-canary" },
    ...overrides,
  });
}

test("served revision parser proves alias, git source, branch and exact SHA", () => {
  const parsed = parseServedRevision({
    inspectJson: inspectFixture(),
    deploymentJson: deploymentFixture(),
    host: HOST,
    owner: "ashneil12",
    repo: "hivra",
    ref: "canary",
  });
  assert.equal(parsed.sha, SHA);
  assert.equal(parsed.ref, "canary");
  assert.equal(parsed.deploymentId, "dpl_2W4wvcDcfy51XFEgBkGF5nfc8tGn");
});

test("served revision parser refuses a CLI-sourced or cross-repo deployment", () => {
  assert.throws(
    () => parseServedRevision({
      inspectJson: inspectFixture(),
      deploymentJson: deploymentFixture({ source: "cli" }),
      host: HOST,
      owner: "ashneil12",
      repo: "hivra",
      ref: "canary",
    }),
    /not Git-sourced/,
  );
  assert.throws(
    () => parseServedRevision({
      inspectJson: inspectFixture(),
      deploymentJson: deploymentFixture({
        meta: {
          githubHost: "github.com",
          githubOrg: "attacker",
          githubRepo: "hivra",
          githubCommitRef: "canary",
          githubCommitSha: SHA,
        },
      }),
      host: HOST,
      owner: "ashneil12",
      repo: "hivra",
      ref: "canary",
    }),
    /did not come from ashneil12\/hivra/,
  );
});

test("Canary env export selects production rows and never accepts a live Clerk key", () => {
  const rows = [
    { key: "CLERK_SECRET_KEY", value: "sk_live_bad", target: [], updatedAt: 3 },
    { key: "CLERK_SECRET_KEY", value: "sk_test_good", target: ["production"], updatedAt: 2 },
    { key: "SUPABASE_URL", value: "https://example.supabase.co", target: ["production"], updatedAt: 2 },
    { key: "SUPABASE_SERVICE_ROLE_KEY", value: "service-role-value-long-enough", target: ["production"], updatedAt: 2 },
  ];
  assert.equal(selectProductionEnvValue(rows, "CLERK_SECRET_KEY"), "sk_test_good");
  const exportsText = buildTestEnvExports(rows);
  assert.match(exportsText, /export CLERK_SECRET_KEY='sk_test_good'/);
  assert.doesNotMatch(exportsText, /sk_live_bad/);
  rows[1].value = "sk_live_not_allowed";
  assert.throws(() => buildTestEnvExports(rows), /not the Canary Clerk test key/);
});

test("shellQuote preserves apostrophes without breaking shell syntax", () => {
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
});

function manifest(id, category = "app", imageTag = "1") {
  return {
    id,
    name: id,
    category,
    runtime: {
      kind: "docker-web",
      imageRepo: `example/${id}`,
      imageTag,
      containerPort: 80,
      hostPort: 3200,
      healthPath: "/",
      volumes: [],
    },
  };
}

function catalogEntries() {
  return summarizeCatalog([manifest("alpha"), manifest("it-tools"), manifest("agent-one", "agent")]);
}

function ledgerRow(overrides = {}) {
  return {
    schema: CERTIFICATION_LEDGER_SCHEMA,
    profileId: "it-tools",
    passed: true,
    finishedAt: NOW.toISOString(),
    canarySha: SHA,
    manifestSha256: catalogEntries()[1].manifestSha256,
    provisionerVersion: PROVISIONER,
    ...overrides,
  };
}

test("planner chooses a pilot target first when nothing is certified", () => {
  const chosen = chooseCertificationTarget({
    catalog: catalogEntries(),
    ledgerRows: [],
    currentCanarySha: SHA,
    currentProvisionerVersion: PROVISIONER,
    now: NOW,
  });
  assert.equal(chosen.id, "it-tools");
  assert.equal(chosen.reason, "never-certified");
});

test("planner does not recertify a fresh pass for unchanged inputs", () => {
  const catalog = [catalogEntries()[1]];
  const chosen = chooseCertificationTarget({
    catalog,
    ledgerRows: [ledgerRow()],
    currentCanarySha: SHA,
    currentProvisionerVersion: PROVISIONER,
    now: NOW,
  });
  assert.equal(chosen, null);
});

test("planner recertifies when the manifest or provisioner changes", () => {
  const catalog = [catalogEntries()[1]];
  const changed = chooseCertificationTarget({
    catalog,
    ledgerRows: [ledgerRow({ manifestSha256: "old" })],
    currentCanarySha: SHA,
    currentProvisionerVersion: PROVISIONER,
    now: NOW,
  });
  assert.equal(changed.id, "it-tools");
  assert.equal(changed.reason, "inputs-changed-since-pass");
  const provisionerChanged = chooseCertificationTarget({
    catalog,
    ledgerRows: [ledgerRow({ provisionerVersion: "2026.11.23.1" })],
    currentCanarySha: SHA,
    currentProvisionerVersion: PROVISIONER,
    now: NOW,
  });
  assert.equal(provisionerChanged.id, "it-tools");
});

test("planner closes a changed-input remediation loop before new uncertified entries", () => {
  const entries = catalogEntries();
  const failedFixed = entries[0];
  const neverCertified = entries[2];
  const failure = ledgerRow({
    profileId: failedFixed.id,
    passed: false,
    canarySha: SHA,
    finishedAt: "2026-11-25T11:00:00.000Z",
    failure: { stage: "open", category: "product", reason: "broken" },
  });
  const chosen = chooseCertificationTarget({
    catalog: [neverCertified, failedFixed],
    ledgerRows: [failure],
    currentCanarySha: OTHER_SHA,
    currentProvisionerVersion: PROVISIONER,
    now: NOW,
  });
  assert.equal(chosen.id, failedFixed.id);
  assert.equal(chosen.reason, "inputs-changed-since-failure");
});

test("planner backs off same-revision product failures but retries after Canary moves", () => {
  const catalog = [catalogEntries()[1]];
  const failure = ledgerRow({
    passed: false,
    finishedAt: "2026-11-25T11:00:00.000Z",
    failure: { stage: "open", category: "product", reason: "broken" },
  });
  assert.equal(chooseCertificationTarget({
    catalog,
    ledgerRows: [failure],
    currentCanarySha: SHA,
    currentProvisionerVersion: PROVISIONER,
    now: NOW,
  }), null);
  const afterCanaryMoves = chooseCertificationTarget({
    catalog,
    ledgerRows: [failure],
    currentCanarySha: OTHER_SHA,
    currentProvisionerVersion: PROVISIONER,
    now: NOW,
  });
  assert.equal(afterCanaryMoves.id, "it-tools");
  assert.equal(afterCanaryMoves.reason, "inputs-changed-since-failure");
});

test("planner retries an unchanged product failure only after backoff", () => {
  const catalog = [catalogEntries()[1]];
  const failure = ledgerRow({
    passed: false,
    finishedAt: "2026-11-24T10:00:00.000Z",
    failure: { stage: "open", category: "product", reason: "broken" },
  });
  const chosen = chooseCertificationTarget({
    catalog,
    ledgerRows: [failure],
    currentCanarySha: SHA,
    currentProvisionerVersion: PROVISIONER,
    now: NOW,
  });
  assert.equal(chosen.id, "it-tools");
  assert.equal(chosen.reason, "failure-retry-backoff");
});

function sweepResult(overrides = {}) {
  return {
    schema: "hivra.launch-sweep.v1",
    runId: "abcd1234",
    profileId: "it-tools",
    tile: "IT-Tools",
    startedAt: "2026-11-25T11:00:00.000Z",
    finishedAt: "2026-11-25T11:05:00.000Z",
    passed: true,
    reached: "teardown",
    checkoutSha: SHA,
    expectedCanarySha: SHA,
    expectedProvisionerVersion: PROVISIONER,
    catalog: { manifestSha256: "manifestsha", runtimeKind: "docker-web", runtimeRefs: ["corentinth/it-tools:latest"] },
    teardown: { agentsLeft: 0, instancesLeft: 0, accountDeleted: true },
    screenshots: ["pass.png"],
    ...overrides,
  };
}

test("append row keeps certification evidence but strips account and agent identifiers", () => {
  const row = certificationRowFromSweep({
    result: sweepResult({ agentId: "00000000-0000-4000-8000-000000000000" }),
    file: "/tmp/abcd1234-it-tools.json",
    target: "it-tools",
    canarySha: SHA,
    provisionerVersion: PROVISIONER,
    runId: "abcd1234",
    sweepExitCode: 0,
    now: () => NOW,
  });
  assert.equal(row.passed, true);
  assert.equal(row.manifestSha256, "manifestsha");
  assert.equal("agentId" in row, false);
  assert.equal(JSON.stringify(row).includes("6f38f0f6"), false);
});

test("append row invalidates a pass when revision evidence or cleanup is wrong", () => {
  const revision = certificationRowFromSweep({
    result: sweepResult({ expectedCanarySha: OTHER_SHA }),
    file: "/tmp/abcd1234-it-tools.json",
    target: "it-tools",
    canarySha: SHA,
    provisionerVersion: PROVISIONER,
    runId: "abcd1234",
    sweepExitCode: 0,
    now: () => NOW,
  });
  assert.equal(revision.passed, false);
  assert.equal(revision.failure.category, "harness_environment");
  const leaked = certificationRowFromSweep({
    result: sweepResult({ teardown: { agentsLeft: 1, instancesLeft: 0, accountDeleted: false } }),
    file: "/tmp/abcd1234-it-tools.json",
    target: "it-tools",
    canarySha: SHA,
    provisionerVersion: PROVISIONER,
    runId: "abcd1234",
    sweepExitCode: 0,
    now: () => NOW,
  });
  assert.equal(leaked.passed, false);
  assert.match(leaked.failure.reason, /left paid computers/);
});

test("a passing app requires a successful sweep and verified teardown without deleting the account", () => {
  const args = { file: "/tmp/abcd1234-it-tools.json", target: "it-tools", canarySha: SHA,
    provisionerVersion: PROVISIONER, runId: "abcd1234", now: () => NOW, sweepExitCode: 0 };
  const teardown = { agentsLeft: 0, instancesLeft: 0, accountDeleted: false };
  const result = sweepResult({ teardown });
  assert.equal(certificationRowFromSweep({ ...args, result }).passed, true);
  assert.equal(certificationRowFromSweep({ ...args, result, sweepExitCode: 1 }).passed, false);
  for (const unverified of [undefined, {}, { ...teardown, error: "unverified" }]) {
    const row = certificationRowFromSweep({ ...args, result: sweepResult({ teardown: unverified }) });
    assert.equal(row.passed, false);
    assert.equal(row.failure.stage, "teardown");
  }
});


function certificationFailure(overrides = {}) {
  return {
    schema: CERTIFICATION_LEDGER_SCHEMA,
    profileId: "nanobot",
    tile: "Nanobot",
    passed: false,
    finishedAt: NOW.toISOString(),
    canarySha: SHA,
    manifestSha256: "manifestsha",
    provisionerVersion: PROVISIONER,
    failure: { stage: "open", category: "product", reason: "No place to type a message" },
    ...overrides,
  };
}

test("remediation planner picks the oldest actionable product failure", () => {
  const failure = certificationFailure();
  const chosen = chooseRemediation({ certificationRows: [failure], remediationRows: [], openPrs: [], now: NOW });
  assert.equal(chosen.profileId, "nanobot");
  assert.equal(chosen.fingerprint, remediationFingerprint(failure));
});

test("remediation planner skips targets with an open fix branch or an open remediation record", () => {
  const failure = certificationFailure();
  assert.equal(chooseRemediation({
    certificationRows: [failure],
    remediationRows: [],
    openPrs: [{ headRefName: "catalog-fix/nanobot-20261125120000" }],
    now: NOW,
  }), null);
  const openAttempt = remediationRow({
    target: { profileId: "nanobot", fingerprint: remediationFingerprint(failure), canarySha: SHA, manifestSha256: "manifestsha", provisionerVersion: PROVISIONER },
    status: "pr-open",
    branch: "catalog-fix/nanobot-20261125120000",
    runId: "abcd1234",
    now: () => NOW,
  });
  assert.equal(openAttempt.schema, REMEDIATION_LEDGER_SCHEMA);
  assert.equal(chooseRemediation({ certificationRows: [failure], remediationRows: [openAttempt], openPrs: [], now: NOW }), null);
});

test("remediation planner retries after attempt backoff, but not while a merged fix waits for recertification", () => {
  const failure = certificationFailure({ finishedAt: "2026-11-24T12:00:00.000Z" });
  const target = { profileId: "nanobot", fingerprint: remediationFingerprint(failure), canarySha: SHA, manifestSha256: "manifestsha", provisionerVersion: PROVISIONER };
  const failedAttempt = remediationRow({
    target,
    status: "agent-failed",
    branch: "catalog-fix/nanobot-20261123120000",
    runId: "abcd1234",
    now: () => new Date("2026-11-23T12:00:00.000Z"),
  });
  const retry = chooseRemediation({ certificationRows: [failure], remediationRows: [failedAttempt], openPrs: [], now: NOW });
  assert.equal(retry.profileId, "nanobot");
  const mergedAfterFailure = remediationRow({
    target,
    status: "merged",
    branch: "catalog-fix/nanobot-20261124130000",
    runId: "abcd1234",
    now: () => new Date("2026-11-24T13:00:00.000Z"),
  });
  assert.equal(chooseRemediation({ certificationRows: [failure], remediationRows: [mergedAfterFailure], openPrs: [], now: NOW }), null);
});

test("catalog dump --all emits complete parseable JSON for the whole registry", () => {
  const dashboardDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  const output = execFileSync(process.execPath, ["-r", "ts-node/register/transpile-only", "scripts/catalog-curator/dump-manifest.ts", "--all"], {
    cwd: dashboardDir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      TS_NODE_TRANSPILE_ONLY: "true",
      TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: "commonjs", moduleResolution: "node" }),
    },
  });
  const manifests = JSON.parse(output);
  assert.ok(manifests.length >= 80);
  assert.ok(manifests.some((entry) => entry.id === "it-tools"));
});

test("provisioner version parser reads the exact checkout contract", () => {
  const dashboardDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  assert.match(readProvisionerVersion(dashboardDir), /^2026\./);
});
