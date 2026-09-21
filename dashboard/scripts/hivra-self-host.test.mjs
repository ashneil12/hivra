import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import net from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  parseArgs,
  dashboardStatusUrls,
  dashboardProcessOwnershipStatus,
  assertSuccessfulEmptyInventory,
  withRestoreWorkspaceCleanup,
  hashOperatorPassword,
  isOwnedDashboardCommand,
  normalizePublicAppUrl,
  parseDashboardProcessReceipt,
  parsePrivateEnvironment,
  parseSupabaseEnvironment,
  portAvailable,
  probePublicFirstBootCallback,
  redactSupabaseOutput,
  rebaseSupabaseConfig,
  renderPrivateEnvironment,
  rotationConfirmationToken,
  selectSupabaseCommand,
  supportedNodeVersion,
  withRequiredSelfHostedDefaults,
  waitForDashboardReady,
  uninstallConfirmationToken,
} from "./hivra-self-host.mjs";

test("self-host arguments reject misspelled and command-inappropriate options", () => {
  assert.throws(() => parseArgs(["stop", "--state_dir", "/private/other-installation"]), /unknown option/i);
  assert.throws(() => parseArgs(["start", "--confirm", "unused-confirmation"]), /unknown option/i);
  assert.throws(() => parseArgs(["restore", "--output", "/private/wrong-direction"]), /unknown option/i);
});

test("self-host arguments reject duplicate destinations before dispatch", () => {
  assert.throws(() => parseArgs(["uninstall", "--state-dir", "/private/one", "--state-dir", "/private/two"]), /duplicate/i);
});

test("self-host argument errors never echo supplied values or unknown arguments", () => {
  for (const args of [
    ["start", "synthetic-private-value"],
    ["start", "--password=synthetic-private-value"],
    ["synthetic-private-value"],
  ]) {
    assert.throws(() => parseArgs(args), error => !String(error).includes("synthetic-private-value"));
  }
});

test("self-host arguments preserve explicit supported options and doctor default", () => {
  assert.deepEqual(parseArgs([]), { command: "doctor", options: {} });
  assert.deepEqual(parseArgs(["doctor", "--state-dir", "/private/hivra"]), { command: "doctor", options: { "state-dir": "/private/hivra" } });
  assert.deepEqual(parseArgs(["init", "--state-dir", "/private/hivra", "--email", "operator@example.test", "--name", "Local Operator"]), {
    command: "init", options: { "state-dir": "/private/hivra", email: "operator@example.test", name: "Local Operator" },
  });
  for (const command of ["backup", "export"]) {
    assert.deepEqual(parseArgs([command, "--output", "/private/archive.hivra"]), { command, options: { output: "/private/archive.hivra" } });
  }
  assert.deepEqual(parseArgs(["start", "--public-url", "local"]), { command: "start", options: { "public-url": "local" } });
  for (const args of [["constructor"], ["start", "--__proto__", "value"], ["stop", "--state-dir"]]) {
    assert.throws(() => parseArgs(args));
  }
});

test("the actual self-host CLI rejects invalid options before prerequisite execution", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("./hivra-self-host.mjs", import.meta.url)),
    "doctor", "--state_dir", "/nonexistent-synthetic-hivra-state",
  ], { encoding: "utf8", timeout: 3_000, env: { PATH: "" } });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option for doctor/i);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /nonexistent-synthetic-hivra-state/);
});

test("adopts only a live owned dashboard process", () => {
  const receipt = { launcherPid: 123 };
  assert.equal(dashboardProcessOwnershipStatus({ receipt, running: true, command: "node scripts/hivra-self-host.mjs start" }), "up");
  assert.equal(dashboardProcessOwnershipStatus({ receipt, running: true, command: null }), "up");
  assert.equal(dashboardProcessOwnershipStatus({ receipt, running: false, command: "node scripts/hivra-self-host.mjs start" }), "down");
  assert.equal(dashboardProcessOwnershipStatus({ receipt: null, running: false, command: null }), "down");
  assert.equal(dashboardProcessOwnershipStatus({ receipt, running: true, command: "node unrelated.mjs start" }), "mismatch");
});

test("existing self-hosted installations rebuild on the Hivra product surface", () => {
  assert.deepEqual(withRequiredSelfHostedDefaults({
    HIVRA_AUTH_MODE: "legacy",
    NEXT_PUBLIC_HIVRA_AGENTS: "0",
    NEXT_PUBLIC_POSTHOG_KEY: "stale-key",
    POSTHOG_DISABLED: "0",
    PRESERVED_VALUE: "yes",
  }), {
    HIVRA_AUTH_MODE: "local",
    NEXT_PUBLIC_HIVRA_AGENTS: "1",
    NEXT_PUBLIC_POSTHOG_KEY: "",
    POSTHOG_DISABLED: "1",
    PRESERVED_VALUE: "yes",
  });
});

test("self-host setup accepts supported current and future Node releases", () => {
  assert.equal(supportedNodeVersion("22.21.9"), false);
  assert.equal(supportedNodeVersion("22.22.0"), true);
  assert.equal(supportedNodeVersion("23.0.0"), true);
  assert.equal(supportedNodeVersion("26.5.0"), true);
  assert.equal(supportedNodeVersion("not-a-version"), false);
});

test("dashboard readiness waits for a real HTTP response before announcing the app", async () => {
  let time = 0;
  let attempts = 0;
  await waitForDashboardReady({
    timeoutMs: 1_000,
    intervalMs: 100,
    now: () => time,
    sleep: async delay => { time += delay; },
    processRunning: () => true,
    probe: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("connection refused");
      return attempts >= 3;
    },
  });
  assert.equal(attempts, 3);
  assert.equal(time, 200);
});

test("dashboard readiness fails immediately when the server process exits", async () => {
  let probes = 0;
  await assert.rejects(waitForDashboardReady({
    processRunning: () => false,
    probe: async () => { probes += 1; return true; },
  }), /stopped before it became reachable/i);
  assert.equal(probes, 0);
});

test("dashboard readiness has a bounded deadline", async () => {
  let time = 0;
  await assert.rejects(waitForDashboardReady({
    timeoutMs: 250,
    intervalMs: 100,
    now: () => time,
    sleep: async delay => { time += delay; },
    processRunning: () => true,
    probe: async () => false,
  }), /did not become reachable within 30 seconds/i);
  assert.equal(time, 250);
});

test("absence requires successful empty container, volume and network inventories", () => {
  const empty = { status: 0, stdout: "\n" };
  assert.doesNotThrow(() => assertSuccessfulEmptyInventory([empty, empty, empty]));
  assert.throws(() => assertSuccessfulEmptyInventory([]), /absence could not be verified/);
  for (let index = 0; index < 3; index += 1) {
    for (const failed of [{ status: 1, stdout: "" }, { status: null, stdout: "" },
      { status: 0, stdout: "", error: new Error("daemon offline") },
      { status: 0, stdout: "surviving-resource\n" }, { status: 0 }]) {
      const results = [empty, empty, empty];
      results[index] = failed;
      assert.throws(() => assertSuccessfulEmptyInventory(results), /absence could not be verified/);
    }
  }
});

for (const cleanupFails of [false, true]) test(`failed restore ${cleanupFails ? "retains" : "removes"} its private identity after cleanup`, async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), ".hivra-restore-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const state = path.join(workspace, "state");
  await mkdir(state);
  await writeFile(path.join(state, "database-runtime.json"), '{"projectId":"hivra-0123456789"}');
  const primary = new Error("synthetic restore error");
  const cleanup = new Error("synthetic cleanup error");
  let attempted = false;
  await assert.rejects(withRestoreWorkspaceCleanup(workspace, async () => { throw primary; }, async () => {
    attempted = true;
    assert.match(await readFile(path.join(state, "database-runtime.json"), "utf8"), /hivra-0123456789/);
    if (cleanupFails) throw cleanup;
  }), error => {
    if (!cleanupFails) return error === primary;
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, cleanup]);
    assert.ok(error.message.includes(state));
    assert.doesNotMatch(error.message, /synthetic/);
    return true;
  });
  assert.equal(attempted, true);
  if (cleanupFails) await access(path.join(state, "database-runtime.json"));
  else await assert.rejects(access(workspace), { code: "ENOENT" });
});

test("successful restore removes only staging and never runs failure teardown", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "hivra-restore-success-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, ".hivra-restore-owned");
  const original = path.join(base, "original-backup.hivra");
  await mkdir(workspace); await writeFile(original, "preserved encrypted fixture");
  const result = await withRestoreWorkspaceCleanup(workspace, async () => "restored", async () => assert.fail("must not destroy a successful restore"));
  assert.equal(result, "restored");
  await assert.rejects(access(workspace), { code: "ENOENT" });
  assert.equal(await readFile(original, "utf8"), "preserved encrypted fixture");
});

test("actual restore wiring retains identity after partial startup and failed teardown", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "hivra-restore-wiring-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, ".hivra-restore-owned");
  await mkdir(workspace);
  // Keep the real restore callback/flag ordering and real cleanup helper, while
  // replacing only external effects. No production Docker daemon is touched.
  const source = await readFile(new URL("./hivra-self-host.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function restore(");
  const end = source.indexOf("async function stop(", start);
  assert.ok(start >= 0 && end > start);
  const primary = new Error("startup interrupted after allocation");
  const cleanup = new Error("Docker unavailable during teardown");
  let allocatedState, cleanupAttempted = false;
  const restore = vm.runInNewContext(`(${source.slice(start, end)})`, {
    path, withRestoreWorkspaceCleanup,
    ensureDoctor() {},
    resolveStateDirectory: () => path.join(base, "restored"),
    existsSync: () => false,
    resolveExistingBackupPath: () => path.join(base, "original.hivra"),
    collectBackupPassphrase: async () => "synthetic-passphrase",
    realpathSync: value => value,
    mkdtemp: async () => workspace,
    chmod: async () => {}, mkdir,
    decryptBackupArchive: async () => {}, extractBackupTar() {},
    inspectExtractedBackup: async () => ({}),
    rejectIncompleteLegacyStorage: async () => {},
    readFile: async () => JSON.stringify({ format: "hivra-self-host-installation-v1" }),
    parsePrivateEnvironment: () => ({ HIVRA_AUTH_MODE: "local" }),
    fail(message) { throw new Error(message); },
    async startSupabase(state, options) {
      assert.equal(options.initialize, true);
      allocatedState = state;
      await writeFile(path.join(state, "database-runtime.json"), '{"projectId":"hivra-0123456789"}');
      throw primary;
    },
    async stopSupabaseForState(state, options) {
      cleanupAttempted = true;
      assert.equal(state, allocatedState);
      assert.equal(options.destroy, true);
      throw cleanup;
    },
    removeOwnedNetwork() { assert.fail("must not continue after failed teardown"); },
    assertLocalDatabaseRemoved() { assert.fail("must not claim verified absence"); },
  });
  await assert.rejects(restore({}), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, cleanup]);
    assert.ok(error.message.includes(allocatedState));
    return true;
  });
  assert.equal(cleanupAttempted, true);
  assert.match(await readFile(path.join(allocatedState, "database-runtime.json"), "utf8"), /hivra-0123456789/);
});

test("failed setup build does not commit a partial installation", async () => {
  const source = await readFile(new URL("./hivra-self-host.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function initialize(");
  const end = source.indexOf("async function start(", start);
  assert.ok(start >= 0 && end > start);
  const primary = new Error("synthetic build failure");
  let writes = 0;
  const initialize = vm.runInNewContext(`(${source.slice(start, end)})`, {
    path,
    ensureDoctor() {},
    resolveStateDirectory: () => "/tmp/hivra-test-state",
    existsSync: () => false,
    line() {},
    startSupabase: async () => ({
      environment: { JWT_SECRET: "fixture" },
      runtime: { projectId: "hivra-fixture", portBase: 55320 },
    }),
    collectOperatorIdentity: async () => ({ email: "operator@example.test" }),
    buildEnvironment: () => ({ HIVRA_AUTH_MODE: "local" }),
    commandResult: () => ({ status: 0, stdout: "fixture-revision\n" }),
    repositoryRoot: "/fixture/repository",
    process: { versions: { node: "26.5.0" } },
    supabaseReady: () => ({ detail: "2.116.0" }),
    runBuild() { throw primary; },
    async atomicPrivateWrite() { writes += 1; },
    renderPrivateEnvironment: () => "fixture",
    JSON,
    Date,
  });

  await assert.rejects(initialize({}), error => error === primary);
  assert.equal(writes, 0);
});

for (const host of ["0.0.0.0", "127.0.0.1"]) test(`rejects a port already held by a ${host} listener`, async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port: 0, exclusive: true }, resolve);
  });
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.equal(await portAvailable(address.port), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("binds destructive uninstall confirmation to the exact state and database identity", () => {
  const first = uninstallConfirmationToken("/private/operator-a", "hivra-0123456789");
  assert.match(first, /^ERASE-[A-F0-9]{12}$/);
  assert.equal(first, uninstallConfirmationToken("/private/operator-a", "hivra-0123456789"));
  assert.notEqual(first, uninstallConfirmationToken("/private/operator-b", "hivra-0123456789"));
  assert.notEqual(first, uninstallConfirmationToken("/private/operator-a", "hivra-abcdef0123"));
  assert.throws(() => uninstallConfirmationToken("relative", "hivra-0123456789"), /invalid/i);
});

test("binds master-key rotation confirmation separately from uninstall", () => {
  const state = "/private/operator-a", project = "hivra-0123456789";
  const token = rotationConfirmationToken(state, project);
  assert.match(token, /^ROTATE-[A-F0-9]{12}$/);
  assert.notEqual(token, uninstallConfirmationToken(state, project));
  assert.notEqual(token, rotationConfirmationToken("/private/operator-b", project));
});

test("prefers the pinned Supabase package over a drifting global CLI", () => {
  assert.deepEqual(
    selectSupabaseCommand({ local: null, npx: "/usr/bin/npx", global: "/opt/bin/supabase" }),
    { command: "/usr/bin/npx", prefix: ["--yes", "supabase@2.116.0"] },
  );
  assert.deepEqual(
    selectSupabaseCommand({ local: "/repo/node_modules/.bin/supabase", npx: "/usr/bin/npx", global: null }),
    { command: "/repo/node_modules/.bin/supabase", prefix: [] },
  );
});

test("checks the local dashboard independently from an optional public callback", () => {
  assert.deepEqual(dashboardStatusUrls({ NEXT_PUBLIC_APP_URL: "https://control.example.com" }), {
    local: "http://127.0.0.1:3000",
    publicCallback: "https://control.example.com",
  });
  assert.deepEqual(dashboardStatusUrls({ NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000" }), {
    local: "http://127.0.0.1:3000",
    publicCallback: null,
  });
});

test("checks the exact public first-boot callback without sending credentials", async () => {
  let observedUrl;
  let observedOptions;
  const status = await probePublicFirstBootCallback(
    "https://control.example.com",
    async (url, options) => {
      observedUrl = url;
      observedOptions = options;
      return {
        status: 401,
        json: async () => ({ accepted: false }),
      };
    },
  );
  assert.equal(status, "up");
  assert.equal(observedUrl.toString(), "https://control.example.com/api/infrastructure/first-boot/enroll");
  assert.equal(observedOptions.method, "POST");
  assert.equal(observedOptions.redirect, "manual");
  assert.equal("headers" in observedOptions, false);
  assert.equal("body" in observedOptions, false);

  assert.equal(await probePublicFirstBootCallback("https://control.example.com", async () => ({
    status: 200,
    json: async () => ({ status: "healthy" }),
  })), "misconfigured (200)");
  assert.equal(await probePublicFirstBootCallback("https://control.example.com", async () => {
    throw new Error("connection refused");
  }), "down");
});

test("accepts only an installation-bound dashboard process receipt", () => {
  const stateDirectory = "/tmp/hivra-state";
  const valid = {
    format: "hivra-self-host-dashboard-process-v1",
    stateDirectory,
    launcherPid: 123,
    childPid: 124,
    startedAt: "2026-08-29T20:00:00.000Z",
  };
  assert.deepEqual(parseDashboardProcessReceipt(JSON.stringify(valid), stateDirectory), valid);
  assert.throws(() => parseDashboardProcessReceipt(JSON.stringify({ ...valid, stateDirectory: "/tmp/other" }), stateDirectory), /invalid/i);
  assert.throws(() => parseDashboardProcessReceipt(JSON.stringify({ ...valid, launcherPid: 1 }), stateDirectory), /invalid/i);
});

test("recognizes only the self-host start launcher before stopping a saved pid", () => {
  assert.equal(isOwnedDashboardCommand("node scripts/hivra-self-host.mjs start --state-dir /tmp/hivra"), true);
  assert.equal(isOwnedDashboardCommand("/usr/bin/node /repo/dashboard/scripts/hivra-self-host.mjs start"), true);
  assert.equal(isOwnedDashboardCommand("node scripts/hivra-self-host.mjs stop --state-dir /tmp/hivra"), false);
  assert.equal(isOwnedDashboardCommand("next-server (v16.3.3)"), false);
  assert.equal(isOwnedDashboardCommand("node unrelated.mjs start"), false);
});

test("parses quoted Supabase status without logging or weakening credentials", () => {
  const parsed = parseSupabaseEnvironment([
    'API_URL="http://127.0.0.1:54321"',
    'ANON_KEY="anon-value"',
    'SERVICE_ROLE_KEY="service-value"',
    'JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long"',
  ].join("\n"));
  assert.equal(parsed.API_URL, "http://127.0.0.1:54321");
  assert.equal(parsed.SERVICE_ROLE_KEY, "service-value");
});

test("refuses an external Supabase target in simple local mode", () => {
  assert.throws(() => parseSupabaseEnvironment([
    'API_URL="https://example.supabase.co"',
    'ANON_KEY="anon-value"',
    'SERVICE_ROLE_KEY="service-value"',
    'JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long"',
  ].join("\n")), /loopback/i);
});

test("private environment rendering is deterministic and round-trips special characters", () => {
  const rendered = renderPrivateEnvironment({
    Z_VALUE: "plain",
    A_VALUE: "name with spaces and # punctuation",
  });
  assert.equal(rendered.split("\n")[0], 'A_VALUE="name with spaces and # punctuation"');
  assert.deepEqual(parsePrivateEnvironment(rendered), {
    A_VALUE: "name with spaces and # punctuation",
    Z_VALUE: "plain",
  });
});

test("operator password hashing is deterministic for a fixed salt and never embeds plaintext", () => {
  const password = "correct horse battery staple";
  const encoded = hashOperatorPassword(password, Buffer.alloc(16, 7));
  assert.equal(encoded, "scrypt$BwcHBwcHBwcHBwcHBwcHBw$Z65ESsHNOjUHGsgNtDm0Xr7vbTBZ7rd-kPBvsNw3uuo");
  assert.equal(encoded.includes(password), false);
  assert.throws(() => hashOperatorPassword("too-short"), /at least 12/i);
});

test("rebases the private Supabase project and every configured local port", () => {
  const source = [
    'project_id = "hermes-deploy"',
    "port = 54321",
    "port = 54322",
    "shadow_port = 54320",
    "port = 54329",
    "inspector_port = 8083",
  ].join("\n");
  const rebased = rebaseSupabaseConfig(source, {
    projectId: "hivra-0123456789",
    portBase: 55320,
  });
  assert.match(rebased, /project_id = "hivra-0123456789"/);
  assert.match(rebased, /port = 55321/);
  assert.match(rebased, /port = 55322/);
  assert.match(rebased, /shadow_port = 55320/);
  assert.match(rebased, /port = 55329/);
  assert.match(rebased, /inspector_port = 55330/);
  assert.doesNotMatch(rebased, /5432[0-9]|8083/);
});

test("redacts every local database credential format before reporting CLI failures", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature";
  const output = [
    `ANON_KEY=${jwt}`,
    '"SERVICE_ROLE_KEY":"service-role-value"',
    "PUBLISHABLE_KEY=sb_publishable_example",
    "SECRET_KEY=sb_secret_example",
    "DB_URL=postgresql://postgres:database-password@127.0.0.1:54322/postgres",
  ].join("\n");
  const redacted = redactSupabaseOutput(output);
  for (const secret of [jwt, "service-role-value", "sb_publishable_example", "sb_secret_example", "database-password"]) {
    assert.equal(redacted.includes(secret), false);
  }
  assert.match(redacted, /ANON_KEY=\[redacted\]/);
  assert.match(redacted, /SERVICE_ROLE_KEY/);
});

test("accepts only an explicit origin for remote first-boot callbacks", () => {
  assert.equal(normalizePublicAppUrl(undefined), null);
  assert.equal(normalizePublicAppUrl("local"), "http://127.0.0.1:3000");
  assert.equal(normalizePublicAppUrl("https://control.example.com/"), "https://control.example.com");
  for (const value of [
    "http://control.example.com",
    "https://control.example.com:8443",
    "https://user:pass@control.example.com",
    "https://control.example.com/path",
    "https://control.example.com/?token=secret",
  ]) {
    assert.throws(() => normalizePublicAppUrl(value), /public-url/i);
  }
});
