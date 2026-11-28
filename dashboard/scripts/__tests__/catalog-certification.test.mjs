import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadCanaryTestEnv } from "../catalog-certification/canary-test-env.mjs";
import { certificationRowFromSweep, certificationRunDisposition } from "../catalog-certification/append-certification-result.mjs";
import { buildCertificationAllowlist } from "../catalog-certification/export-allowlist.mjs";
import { chooseRemediation, remediationFingerprint, remediationRow, REMEDIATION_LEDGER_SCHEMA } from "../catalog-certification/catalog-remediation.mjs";
import {
  CERTIFICATION_LEDGER_SCHEMA,
  chooseCertificationTarget,
  readProvisionerVersion,
  summarizeCatalog,
} from "../catalog-certification/certification-plan.mjs";
import { resolveServedRevision } from "../catalog-certification/served-canary-revision.mjs";
import { createVercelGetter } from "../catalog-certification/vercel-rest.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const HOST = "canary.hermesos.cloud";
const PROVISIONER = "2026.11.25.2";
const NOW = new Date("2026-11-25T12:00:00.000Z");

test("allowlist emits only clean, exact-revision passes and drops a subsequent product failure", () => {
  const entry = { id: "example", manifestSha256: "a".repeat(64) };
  const pass = {
    profileId: entry.id,
    manifestSha256: entry.manifestSha256,
    canarySha: SHA,
    checkoutSha: SHA,
    expectedCanarySha: SHA,
    provisionerVersion: PROVISIONER,
    expectedProvisionerVersion: PROVISIONER,
    passed: true,
    sweepPassed: true,
    sweepExitCode: 0,
    reached: "teardown",
    finishedAt: NOW.toISOString(),
    teardown: { agentsLeft: 0, instancesLeft: 0, accountDeleted: false },
  };
  const launchSeals = { unpinned: [PROVISIONER, "2026.11.26.1"], pinned: "2026.11.26.1" };
  const apps = (...rows) => buildCertificationAllowlist([entry], rows, launchSeals).apps;
  assert.deepEqual(apps(pass), { example: {
    manifestSha256: entry.manifestSha256,
    provisionerVersion: PROVISIONER,
    canarySha: SHA,
    certifiedAt: NOW.toISOString(),
  } });
  for (const invalid of [
    { canarySha: OTHER_SHA },
    { manifestSha256: "b".repeat(64) },
    { expectedProvisionerVersion: "2026.11.20.5" },
    { sweepExitCode: 1 },
    { teardown: { agentsLeft: 1, instancesLeft: 0, accountDeleted: false } },
  ]) assert.deepEqual(apps({ ...pass, ...invalid }), {});
  const denied = { ...pass, passed: false, failure: { category: "product" } };
  assert.deepEqual(apps(pass, denied), {});
  assert.deepEqual(apps(pass, { ...denied, failure: { category: "harness_environment" } }), apps(pass));
  const pinned = { ...entry, requiresPinnedCatalogDigest: true };
  assert.deepEqual(buildCertificationAllowlist([pinned], [pass], launchSeals).apps, {});
  const pinnedPass = { ...pass, provisionerVersion: launchSeals.pinned, expectedProvisionerVersion: launchSeals.pinned };
  assert.equal(buildCertificationAllowlist([pinned], [pinnedPass], launchSeals).apps.example.provisionerVersion, launchSeals.pinned);
});

const PROJECT = "prj_example01";
const DEPLOYMENT = "dpl_2W4wvcDcfy51XFEgBkGF5nfc8tGn";

function aliasFixture(overrides = {}) {
  return { alias: HOST, deploymentId: DEPLOYMENT, projectId: PROJECT, ...overrides };
}

function deploymentFixture(overrides = {}) {
  return {
    id: DEPLOYMENT,
    projectId: PROJECT,
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
    ...overrides,
  };
}

test("served revision uses scoped GETs and proves the exact alias, project and Git SHA", async () => {
  const visited = [];
  const get = createVercelGetter("our-team", {
    env: { HIVRA_VERCEL_TOKEN: "mock" },
    fetchImpl: async (url, options) => {
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer mock");
      assert.equal(url.origin, "https://api.vercel.com");
      assert.equal(url.searchParams.get("slug"), "our-team");
      visited.push(url.pathname);
      return Response.json(visited.length === 1 ? aliasFixture() : deploymentFixture());
    },
  });
  assert.deepEqual(await resolveServedRevision({ projectId: PROJECT, get }), { deploymentId: DEPLOYMENT, host: HOST, sha: SHA, projectId: PROJECT });
  assert.deepEqual(visited, [`/v4/aliases/${HOST}`, `/v13/deployments/${DEPLOYMENT}`]);
  await assert.rejects(get("/v13/deployments/../not-allowed"), /unsupported API read/);
  await assert.rejects(get("/v4/aliases/hivra.cloud"), /unsupported API read/);
});

test("served revision refuses a wrong alias or a non-Canary deployment", async () => {
  await assert.rejects(resolveServedRevision({
    projectId: PROJECT, get: async () => aliasFixture({ projectId: "prj_elsewhere" }),
  }), /alias does not match/);
  for (const overrides of [
    { source: "cli" }, { projectId: "prj_elsewhere" }, { readyState: "BUILDING" }, { alias: [] },
    { gitSource: { type: "github", ref: "main", sha: SHA } },
    { meta: { ...deploymentFixture().meta, githubOrg: "outsider" } },
    { meta: { ...deploymentFixture().meta, githubCommitSha: OTHER_SHA } },
  ]) {
    const get = async (path) => path.startsWith("/v4/") ? aliasFixture() : deploymentFixture(overrides);
    await assert.rejects(resolveServedRevision({ projectId: PROJECT, get }), /Git (Canary alias|revision)/);
  }
});

test("Canary env read selects only bound production-scope Supabase values", async () => {
  const serviceRole = "fixture-service-role-long-enough";
  const rows = [
    { key: "CLERK_SECRET_KEY", value: "sk_test_fixture", target: ["production"], updatedAt: 2 },
    { key: "SUPABASE_URL", value: "https://preview.supabase.co", target: ["preview"], updatedAt: 3 },
    { key: "SUPABASE_URL", value: "https://example.supabase.co", target: ["production"], updatedAt: 2 },
    { key: "SUPABASE_URL", value: "https://branch.supabase.co", target: ["production"], gitBranch: "other", updatedAt: 3 },
    { key: "SUPABASE_SERVICE_ROLE_KEY", value: serviceRole, target: ["production"], updatedAt: 2 },
  ];
  const get = async (path, query) => {
    if (path.startsWith("/v4/")) return aliasFixture();
    assert.equal(path, `/v8/projects/${PROJECT}/env`);
    assert.deepEqual(query, { decrypt: "true" });
    return { envs: rows };
  };
  assert.deepEqual(await loadCanaryTestEnv({ projectId: PROJECT, deploymentId: DEPLOYMENT, get }), {
    LAUNCH_SWEEP_SUPABASE_URL: "https://example.supabase.co",
    LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY: serviceRole,
  });
});

test("an alias move refuses to read env rows, and API failures omit response bodies", async () => {
  const get = async (path) => {
    assert.equal(path, `/v4/aliases/${HOST}`);
    return aliasFixture({ deploymentId: "dpl_different" });
  };
  await assert.rejects(loadCanaryTestEnv({ projectId: PROJECT, deploymentId: DEPLOYMENT, get }), /changed after revision/);
  const denied = createVercelGetter("team_12345678", {
    env: { HIVRA_VERCEL_TOKEN: "mock" },
    fetchImpl: async (url) => {
      assert.equal(url.searchParams.get("teamId"), "team_12345678");
      return new Response("credential-like response", { status: 403 });
    },
  });
  await assert.rejects(denied(`/v4/aliases/${HOST}`), { message: "[vercel-rest] Vercel API read failed (HTTP 403)" });
  assert.throws(() => createVercelGetter("", { env: { HIVRA_VERCEL_TOKEN: "mock" } }), /explicit Vercel team/);
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

test("a shared standing-account failure does not replace the last usable target result", () => {
  const entry = catalogEntries()[1];
  const chosen = chooseCertificationTarget({
    catalog: [entry],
    ledgerRows: [
      ledgerRow({ ledgerLine: 1 }),
      ledgerRow({ ledgerLine: 2, passed: false, canarySha: OTHER_SHA, failure: { stage: "account" } }),
    ],
    currentCanarySha: SHA,
    currentProvisionerVersion: PROVISIONER,
    now: NOW,
  });
  assert.equal(chosen, null);
});

test("planner prefers a due agent retry over a due generic app retry in the same group", () => {
  const [app, , agent] = catalogEntries();
  const ledgerRows = [app, agent].map((entry, index) => ledgerRow({
    profileId: entry.id,
    manifestSha256: entry.manifestSha256,
    canarySha: OTHER_SHA,
    passed: false,
    finishedAt: new Date(NOW.getTime() - (2 - index) * 60_000).toISOString(),
  }));
  assert.equal(chooseCertificationTarget({
    catalog: [app, agent], ledgerRows, currentCanarySha: SHA, currentProvisionerVersion: PROVISIONER, now: NOW,
  }).id, agent.id);
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
    manifestSha256: failedFixed.manifestSha256,
  });
  for (const previousInputs of [{ manifestSha256: "old" }, { provisionerVersion: "2026.11.23.1" }]) {
    const chosen = chooseCertificationTarget({
      catalog: [neverCertified, failedFixed],
      ledgerRows: [{ ...failure, ...previousInputs }],
      currentCanarySha: SHA,
      currentProvisionerVersion: PROVISIONER,
      now: NOW,
    });
    assert.equal(chosen.id, failedFixed.id);
    assert.equal(chosen.reason, "inputs-changed-since-failure");
  }
});

test("planner advances first attempts across unrelated Canary revisions", () => {
  const catalog = catalogEntries();
  const ledgerRows = [ledgerRow({ passed: false })];
  for (const [currentCanarySha, expected] of [[OTHER_SHA, catalog[2]], ["a".repeat(40), catalog[0]]]) {
    const chosen = chooseCertificationTarget({
      catalog,
      ledgerRows,
      currentCanarySha,
      currentProvisionerVersion: PROVISIONER,
      now: NOW,
    });
    assert.equal(chosen.id, expected.id);
    assert.equal(chosen.reason, "never-certified");
    ledgerRows.push(ledgerRow({ profileId: expected.id, canarySha: currentCanarySha, manifestSha256: expected.manifestSha256 }));
  }
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
    teardown: { agentsLeft: 0, instancesLeft: 0, accountDeleted: false },
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
  for (const unverified of [undefined, {}, { ...teardown, error: "unverified" }, { ...teardown, accountDeleted: true }]) {
    const row = certificationRowFromSweep({ ...args, result: sweepResult({ teardown: unverified }) });
    assert.equal(row.passed, false);
    assert.equal(row.failure.stage, "teardown");
  }
});

test("an uncertain launch cleanup stops the entire runner, even if the product already failed", () => {
  const evidenceFile = "abcd1234-trilium.json";
  const failure = { stage: "ready", category: "product" };
  const clean = { agentsLeft: 0, instancesLeft: 0, accountDeleted: false };
  assert.equal(certificationRunDisposition({ evidenceFile, failure, teardown: { ...clean, error: "unverified" } }), "hold");
  const incomplete = certificationRowFromSweep({
    result: sweepResult({ passed: false, failure, teardown: { agentsLeft: 0, instancesLeft: 0 } }),
    file: evidenceFile, target: "trilium", canarySha: SHA, provisionerVersion: PROVISIONER, runId: "abcd1234", sweepExitCode: 1,
  });
  assert.equal(certificationRunDisposition(incomplete), "hold");
  assert.equal(certificationRunDisposition({ evidenceFile, failure, teardown: { ...clean, agentsLeft: 1 } }), "hold");
  assert.equal(certificationRunDisposition({ evidenceFile, failure, teardown: { ...clean, accountDeleted: true } }), "hold");
  assert.equal(certificationRunDisposition({ evidenceFile, sweepPassed: true, teardown: null }), "hold");
  assert.equal(certificationRunDisposition({ failure }), "hold");
  assert.equal(certificationRunDisposition({ evidenceFile, failure, teardown: clean }), "fail");
  assert.equal(certificationRunDisposition({ evidenceFile, failure: { stage: "account" } }), "account");
  assert.equal(certificationRunDisposition({ evidenceFile, passed: true, teardown: clean }), "pass");
});

test("the operator's teardown hold persists across invocations and releases the serial lock", () => {
  const state = mkdtempSync(path.join(tmpdir(), "catalog-teardown-hold-"));
  try {
    const marker = path.join(state, "TEARDOWN_REVIEW_REQUIRED");
    writeFileSync(marker, "run=abcd1234\n");
    const runner = new URL("../catalog-certification/run-once.sh", import.meta.url);
    for (let index = 0; index < 2; index++) {
      assert.throws(() => execFileSync("bash", [runner.pathname], {
        env: { ...process.env, CERT_STATE: state },
        stdio: "pipe",
      }), (error) => error.status === 77 && error.stderr.toString().includes("verify the previous run"));
      assert.equal(existsSync(path.join(state, "certification-lock.d")), false);
      assert.equal(existsSync(marker), true);
    }
  } finally {
    rmSync(state, { force: true, recursive: true });
  }
});

test("the shell's disposition command reads a clean or unsafe receipt without appending again", () => {
  const state = mkdtempSync(path.join(tmpdir(), "catalog-disposition-"));
  try {
    const file = path.join(state, "ledger-row.json");
    const helper = new URL("../catalog-certification/append-certification-result.mjs", import.meta.url);
    const row = {
      schema: CERTIFICATION_LEDGER_SCHEMA, evidenceFile: "abcd1234-example.json",
      passed: true, teardown: { agentsLeft: 0, instancesLeft: 0, accountDeleted: false },
    };
    const disposition = () => execFileSync(process.execPath, [helper.pathname, "--disposition", file], { encoding: "utf8" }).trim();
    writeFileSync(file, JSON.stringify(row));
    assert.equal(disposition(), "pass");
    writeFileSync(file, JSON.stringify({ ...row, passed: false, teardown: { ...row.teardown, error: "unverified" } }));
    assert.equal(disposition(), "hold");
    assert.deepEqual(readdirSync(state), ["ledger-row.json"]);
  } finally {
    rmSync(state, { force: true, recursive: true });
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
