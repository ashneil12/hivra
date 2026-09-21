#!/usr/bin/env node

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parsePrivateEnvironment } from "./hivra-self-host.mjs";
import { assertOwnedLoopbackContainers } from "./hivra-self-host-docker.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const dashboardRoot = path.resolve(path.dirname(scriptPath), "..");
const repositoryRoot = path.resolve(dashboardRoot, "..");
const origin = "http://127.0.0.1:3000";

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  let workDirectoryInput;
  let sourceRevision;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail("Usage: npm run test:self-host-recovery -- --work-dir /absolute/empty/private/directory [--source-revision COMMIT]");
    }
    if (key === "--work-dir") workDirectoryInput = value;
    else if (key === "--source-revision") sourceRevision = value;
    else fail(`Unexpected argument: ${key}`);
    index += 1;
  }
  if (!workDirectoryInput || !path.isAbsolute(workDirectoryInput)) {
    fail("Usage: npm run test:self-host-recovery -- --work-dir /absolute/empty/private/directory [--source-revision COMMIT]");
  }
  if (sourceRevision !== undefined && !/^[0-9a-f]{40}$/.test(sourceRevision)) {
    fail("The explicit source revision must be a full lowercase Git commit.");
  }
  const workDirectory = realpathSync(workDirectoryInput);
  const metadata = statSync(workDirectory);
  if (!metadata.isDirectory() || typeof process.getuid !== "function" || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) {
    fail("The recovery test work directory must already exist and be owner-only (normally chmod 700).");
  }
  return { workDirectory, sourceRevision };
}

export function resolveSourceRevision(explicitRevision, root = repositoryRoot) {
  if (explicitRevision !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(explicitRevision)) fail("The explicit source revision is invalid.");
    return explicitRevision;
  }
  const source = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const revision = source.status === 0 ? source.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    fail("Could not bind the recovery rehearsal to an exact source revision; pass --source-revision for an exported tree.");
  }
  return revision;
}

function commandEnvironment(password, passphrase) {
  return {
    ...process.env,
    HIVRA_SETUP_EMAIL: "recovery-e2e@hivra.local",
    HIVRA_SETUP_NAME: "Recovery E2E",
    HIVRA_SETUP_PASSWORD: password,
    HIVRA_BACKUP_PASSPHRASE: passphrase,
  };
}

function runSelfHost(args, environment, { inherit = true } = {}) {
  const result = spawnSync(process.execPath, ["scripts/hivra-self-host.mjs", ...args], {
    cwd: dashboardRoot,
    env: environment,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    timeout: 45 * 60 * 1000,
  });
  if (result.error || result.status !== 0) fail(`Self-host ${args[0]} failed.`);
  return result;
}

function encryptFixture(plaintext, keyHex) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

function decryptFixture(ciphertext, keyHex) {
  const value = Buffer.from(ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), value.subarray(0, 12));
  decipher.setAuthTag(value.subarray(12, 28));
  return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
}

async function readPrivateValues(stateDirectory) {
  return parsePrivateEnvironment(await readFile(path.join(stateDirectory, "dashboard.env"), "utf8"));
}

async function saveStorageFixture(stateDirectory, objectBytes) {
  const values = await readPrivateValues(stateDirectory);
  const base = `${values.NEXT_PUBLIC_SUPABASE_URL}/storage/v1`;
  const bucket = await fetch(`${base}/bucket`, {
    method: "POST", headers: serviceHeaders(values, { "content-type": "application/json" }),
    body: JSON.stringify({ id: "recovery-proof", name: "recovery-proof", public: false }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!bucket.ok) fail("Could not create the private recovery storage fixture bucket.");
  const upload = await fetch(`${base}/object/recovery-proof/nested/byte-proof.bin`, {
    method: "POST", headers: serviceHeaders(values, { "content-type": "application/octet-stream" }),
    body: objectBytes, signal: AbortSignal.timeout(10_000),
  });
  if (!upload.ok) fail("Could not upload the bounded recovery file fixture.");
}

async function verifyStorageFixture(stateDirectory, objectBytes) {
  const values = await readPrivateValues(stateDirectory);
  const response = await fetch(`${values.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/recovery-proof/nested/byte-proof.bin`, {
    headers: serviceHeaders(values), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || !Buffer.from(await response.arrayBuffer()).equals(objectBytes)) {
    fail("The recovered storage file is missing or its bytes differ from the original upload.");
  }
  return "pass";
}

async function verifyLoopbackBindings(stateDirectory) {
  const runtime = JSON.parse(await readFile(path.join(stateDirectory, "database-runtime.json"), "utf8"));
  const suffix = createHash("sha256").update(stateDirectory).digest("hex").slice(0, 10);
  const count = assertOwnedLoopbackContainers("docker", {
    projectId: runtime.projectId, network: `hivra-local-${suffix}`,
  });
  if (count < 2) fail("The recovery test did not observe both database and API containers.");
  return "pass";
}

function serviceHeaders(values, additional = {}) {
  return {
    apikey: values.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${values.SUPABASE_SERVICE_ROLE_KEY}`,
    ...additional,
  };
}

async function saveRotationFixture(stateDirectory, fixtureId, plaintext) {
  const values = await readPrivateValues(stateDirectory);
  const response = await fetch(`${values.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/user_api_keys`, {
    method: "POST",
    headers: serviceHeaders(values, {
      "content-type": "application/json",
      prefer: "return=minimal",
    }),
    body: JSON.stringify({
      id: fixtureId,
      user_id: "hivra-local-operator",
      name: "Master-key rotation fixture",
      provider: "synthetic",
      encrypted_key: encryptFixture(plaintext, values.ENCRYPTION_KEY),
      key_preview: "rotation-e2e",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) fail("Could not write the bounded master-key rotation fixture.");
  return {
    encryptionKey: values.ENCRYPTION_KEY,
    launchFingerprintKey: values.LAUNCH_FINGERPRINT_KEY,
  };
}

async function readRotationCiphertext(stateDirectory, fixtureId) {
  const values = await readPrivateValues(stateDirectory);
  const response = await fetch(
    `${values.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/user_api_keys?id=eq.${fixtureId}&select=encrypted_key`,
    {
      headers: serviceHeaders(values),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const rows = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.encrypted_key !== "string") {
    fail("Could not read the bounded master-key rotation fixture.");
  }
  return rows[0].encrypted_key;
}

async function rotateStateKeys({ stateDirectory, backupOutput, environment, fixtureId, plaintext, previousKeys }) {
  const preview = runSelfHost(["rotate-keys", "--state-dir", stateDirectory], environment, { inherit: false });
  const token = preview.stdout.match(/--confirm (ROTATE-[A-F0-9]{12})\b/)?.[1];
  if (!token) fail("The key-rotation preview did not return a state-bound confirmation token.");
  runSelfHost([
    "rotate-keys",
    "--state-dir", stateDirectory,
    "--backup-output", backupOutput,
    "--confirm", token,
  ], environment, { inherit: false });
  if (!existsSync(backupOutput)) fail("Key rotation did not retain its encrypted pre-rotation backup.");
  const nextValues = await readPrivateValues(stateDirectory);
  if (nextValues.ENCRYPTION_KEY === previousKeys.encryptionKey) fail("Secret master-key rotation retained the old primary key.");
  if (!previousKeys.launchFingerprintKey || nextValues.LAUNCH_FINGERPRINT_KEY !== previousKeys.launchFingerprintKey) {
    fail("Master-key rotation changed launch-fingerprint custody.");
  }
  if (nextValues.ENCRYPTION_KEY_LEGACY || nextValues.CHAT_ENCRYPTION_KEY_LEGACY) {
    fail("Completed key rotation retained legacy keys in the active configuration.");
  }
  const ciphertext = await readRotationCiphertext(stateDirectory, fixtureId);
  if (decryptFixture(ciphertext, nextValues.ENCRYPTION_KEY) !== plaintext) {
    fail("The rotated credential is not readable with the new primary key.");
  }
  let oldKeyRejected = false;
  try {
    decryptFixture(ciphertext, previousKeys.encryptionKey);
  } catch {
    oldKeyRejected = true;
  }
  if (!oldKeyRejected) fail("The rotated credential remained readable with the retired primary key.");
  return { secretCiphertextRewrapped: "pass", oldSecretKeyRejected: "pass", launchFingerprintKeyPreserved: "pass" };
}

async function saveRecoveryMarker(stateDirectory, marker) {
  const values = parsePrivateEnvironment(await readFile(path.join(stateDirectory, "dashboard.env"), "utf8"));
  const response = await fetch(`${values.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/self_host_operator_settings?on_conflict=operator_id`, {
    method: "POST",
    headers: {
      apikey: values.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${values.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      operator_id: "hivra-local-operator",
      public_metadata: { recoveryMarker: marker },
      updated_at: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) fail("Could not write the bounded recovery marker.");
}

export async function waitForDatabaseRecovery({ readMarker, readContainerState, marker, timeoutMs = 60_000, pollIntervalMs = 500 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await readContainerState();
      // REST can answer before Docker marks Postgres healthy. Supabase CLI
      // refuses that starting state, so prove both before the next backup.
      if (state.Running && state.Health?.Status === "healthy" && await readMarker() === marker) return true;
    } catch {
      // The explicitly restarted, owned database is still recovering.
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  return false;
}

async function verifyDatabaseCrashRecovery(stateDirectory, marker) {
  const runtime = JSON.parse(await readFile(path.join(stateDirectory, "database-runtime.json"), "utf8"));
  await verifyLoopbackBindings(stateDirectory);
  const name = `supabase_db_${runtime.projectId}`;
  const docker = (args) => {
    const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000 });
    if (result.error || result.status !== 0) fail("The owned database crash-recovery command failed.");
    return result.stdout;
  };
  const before = JSON.parse(docker(["inspect", name]))[0];
  if (before.Config.Labels["com.supabase.cli.workdir"] !== path.join(stateDirectory, "control-plane")) {
    fail("The database crash target is not owned by this recovery rehearsal.");
  }
  const values = await readPrivateValues(stateDirectory);
  const readMarker = async () => {
    const response = await fetch(`${values.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/self_host_operator_settings?operator_id=eq.hivra-local-operator&select=public_metadata`, {
      headers: serviceHeaders(values), signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error("Database marker endpoint unavailable.");
    const rows = await response.json();
    return rows[0]?.public_metadata?.recoveryMarker;
  };
  if (await readMarker() !== marker) fail("The crash recovery baseline marker differs.");
  const startedAt = new Date().toISOString();
  let interruptionObserved = false;
  let recovered = false;
  try {
    docker(["update", "--restart=no", name]);
    docker(["kill", "--signal=KILL", name]);
    if (JSON.parse(docker(["inspect", name]))[0].State.Running) fail("The owned database did not stop.");
    try { await readMarker(); } catch { interruptionObserved = true; }
    if (!interruptionObserved) fail("The database API interruption was not observed.");
    docker(["start", name]);
    recovered = await waitForDatabaseRecovery({
      readMarker, marker,
      readContainerState: () => JSON.parse(docker(["inspect", name]))[0].State,
    });
    if (!recovered) fail("The crashed database did not recover the exact marker.");
  } finally {
    docker(["start", name]);
    docker(["update", `--restart=${before.HostConfig.RestartPolicy.Name}`, name]);
  }
  const after = JSON.parse(docker(["inspect", name]))[0];
  if (after.HostConfig.RestartPolicy.Name !== before.HostConfig.RestartPolicy.Name) {
    fail("Database recovery did not restore the original restart policy.");
  }
  const mounts = value => value.Mounts.map(mount => mount.Name || mount.Source).sort();
  if (JSON.stringify(mounts(before)) !== JSON.stringify(mounts(after))) fail("Database recovery changed volume identity.");
  return {
    target: name, startedAt, finishedAt: new Date().toISOString(),
    interruption: "SIGKILL with owned automatic restart disabled",
    recovery: "explicit docker start (manual)",
    apiInterruptionObserved: "pass", exactMarkerRecovered: "pass",
    volumeIdentitiesPreserved: "pass", restartPolicyRestored: "pass",
  };
}

async function writeUninstallBlocker(stateDirectory, blockerId) {
  const values = parsePrivateEnvironment(await readFile(path.join(stateDirectory, "dashboard.env"), "utf8"));
  const response = await fetch(`${values.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/hermes_instances`, {
    method: "POST",
    headers: {
      apikey: values.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${values.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify({
      id: blockerId,
      user_id: "hivra-local-operator",
      name: "Uninstall safety fixture",
      status: "running",
      provider: "openrouter",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) fail("Could not create the uninstall safety fixture.");
}

async function removeUninstallBlocker(stateDirectory, blockerId) {
  const values = parsePrivateEnvironment(await readFile(path.join(stateDirectory, "dashboard.env"), "utf8"));
  const response = await fetch(`${values.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/hermes_instances?id=eq.${blockerId}`, {
    method: "DELETE",
    headers: {
      apikey: values.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${values.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) fail("Could not remove the uninstall safety fixture.");
}

// The owned launcher performs a production build (bounded to 20 minutes)
// before serving HTTP; include that phase in the rehearsal readiness deadline.
async function waitForHealth(timeoutMs = 22 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(3_000) });
      const body = await response.json();
      if (response.ok && body?.status === "healthy" && body?.checks?.db?.status === "up") return;
    } catch {
      // The dashboard is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail("The restored dashboard did not become healthy before the bounded deadline.");
}

function cookieFrom(response) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  const cookie = values[0]?.split(";", 1)[0];
  if (!cookie?.startsWith("hivra_operator_session=")) fail("The restored login did not set the expected HttpOnly session cookie.");
  return cookie;
}

async function verifyRestoredApplication({ password, marker }) {
  await waitForHealth();
  const login = await fetch(`${origin}/api/self-host/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: "recovery-e2e@hivra.local", password }),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (login.status !== 200) fail("The restored operator credentials were not accepted.");
  const cookie = cookieFrom(login);
  const session = await fetch(`${origin}/api/self-host/auth/session`, {
    headers: { cookie },
    signal: AbortSignal.timeout(10_000),
  });
  const sessionBody = await session.json();
  if (
    session.status !== 200 ||
    sessionBody?.authenticated !== true ||
    sessionBody?.user?.publicMetadata?.recoveryMarker !== marker
  ) {
    fail("The restored operator session did not recover the exact database marker.");
  }
  const infrastructure = await fetch(`${origin}/api/infrastructure/connections`, {
    headers: { cookie },
    signal: AbortSignal.timeout(10_000),
  });
  if (infrastructure.status !== 200) fail("The restored operator cannot access the infrastructure registry.");
  const hostedBilling = await fetch(`${origin}/api/billing/usage`, {
    headers: { cookie },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (hostedBilling.status !== 404) fail("The restored standalone build exposed a hosted billing endpoint.");
  return {
    health: "pass",
    operatorLogin: "pass",
    recoveredMarker: "pass",
    infrastructureRegistry: "pass",
    hostedBillingGuard: "pass",
  };
}

async function stopLauncher(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const code = await new Promise((resolve) => child.once("exit", (value) => resolve(value ?? 0)));
  if (code !== 0 && code !== 143) fail("The restored dashboard launcher did not stop cleanly.");
}

function uninstallState(stateDirectory, environment) {
  const preview = runSelfHost(["uninstall", "--state-dir", stateDirectory], environment, { inherit: false });
  const token = preview.stdout.match(/--confirm (ERASE-[A-F0-9]{12})\b/)?.[1];
  if (!token) fail("The uninstall preview did not return a state-bound confirmation token.");
  runSelfHost(["uninstall", "--state-dir", stateDirectory, "--confirm", token], environment, { inherit: false });
  if (existsSync(stateDirectory)) fail("The accepted uninstall retained its installation state directory.");
}

function proveUninstallFailsClosed(stateDirectory, environment) {
  const preview = runSelfHost(["uninstall", "--state-dir", stateDirectory], environment, { inherit: false });
  const token = preview.stdout.match(/--confirm (ERASE-[A-F0-9]{12})\b/)?.[1];
  if (!token) fail("The uninstall safety proof could not resolve its confirmation token.");
  const result = spawnSync(process.execPath, ["scripts/hivra-self-host.mjs", "uninstall", "--state-dir", stateDirectory, "--confirm", token], {
    cwd: dashboardRoot,
    env: environment,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 45 * 60 * 1000,
  });
  if (result.status === 0 || !/Delete all legacy computers through Hivra/i.test(result.stderr)) {
    fail("Uninstall did not fail closed around a retained computer.");
  }
  if (!existsSync(stateDirectory)) fail("Blocked uninstall removed the private installation state.");
}

export async function cleanupRecoverySteps(steps) {
  const failures = [];
  for (const [name, action] of steps) {
    try { await action(); } catch { failures.push(name); }
  }
  if (failures.length) fail(`Recovery test cleanup could not verify: ${failures.join(", ")}. Owned state was retained where safe uninstall failed.`);
}

async function main(argv = process.argv.slice(2)) {
  const { workDirectory, sourceRevision } = parseArgs(argv);
  const originalState = path.join(workDirectory, "original-state");
  const restoredState = path.join(workDirectory, "restored-state");
  const backup = path.join(workDirectory, "operator-backup.hivra");
  const rotationBackup = path.join(workDirectory, "pre-rotation-backup.hivra");
  const receiptPath = path.join(workDirectory, "recovery-e2e.json");
  for (const target of [originalState, restoredState, backup, rotationBackup, receiptPath]) {
    if (existsSync(target)) fail("The recovery test refuses to overwrite an earlier run.");
  }
  const password = randomBytes(24).toString("base64url");
  const passphrase = randomBytes(32).toString("base64url");
  const marker = randomBytes(16).toString("hex");
  const storageFixture = randomBytes(131_073);
  const rotationFixtureId = randomUUID();
  const rotationPlaintext = randomBytes(32).toString("base64url");
  const environment = commandEnvironment(password, passphrase);
  let launcher;
  let uninstallBlockerId;
  const startedAt = new Date().toISOString();
  try {
    runSelfHost(["init", "--state-dir", originalState], environment);
    const originalLoopbackBindings = await verifyLoopbackBindings(originalState);
    await saveStorageFixture(originalState, storageFixture);
    await saveRecoveryMarker(originalState, marker);
    const databaseCrashRecovery = await verifyDatabaseCrashRecovery(originalState, marker);
    const previousKeys = await saveRotationFixture(originalState, rotationFixtureId, rotationPlaintext);
    runSelfHost(["backup", "--state-dir", originalState, "--output", backup], environment);
    runSelfHost(["restore", "--state-dir", restoredState, "--input", backup], environment);
    launcher = spawn(process.execPath, ["scripts/hivra-self-host.mjs", "start", "--state-dir", restoredState], {
      cwd: dashboardRoot,
      env: environment,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const checks = await verifyRestoredApplication({ password, marker });
    checks.databaseCrashRecovery = databaseCrashRecovery;
    checks.originalLoopbackBindings = originalLoopbackBindings;
    checks.restoredLoopbackBindings = await verifyLoopbackBindings(restoredState);
    checks.recoveredStorageBytes = await verifyStorageFixture(restoredState, storageFixture);
    await stopLauncher(launcher);
    launcher = undefined;
    // Interrupt only the dashboard process launched by this rehearsal. Both
    // databases and every unrelated service remain running. Require the public
    // loopback endpoint to be unavailable before proving a fresh connection.
    let interruptionObserved = false;
    try {
      await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(3_000) });
    } catch {
      interruptionObserved = true;
    }
    if (!interruptionObserved) fail("The owned dashboard interruption was not observed.");
    launcher = spawn(process.execPath, ["scripts/hivra-self-host.mjs", "start", "--state-dir", restoredState], {
      cwd: dashboardRoot,
      env: environment,
      stdio: ["ignore", "ignore", "ignore"],
    });
    checks.dashboardRestartRecovery = {
      interruption: "owned launcher SIGTERM and explicit start",
      interruptionObserved: "pass",
      ...await verifyRestoredApplication({ password, marker }),
      recoveredStorageBytes: await verifyStorageFixture(restoredState, storageFixture),
    };
    await stopLauncher(launcher);
    launcher = undefined;
    checks.masterKeyRotation = await rotateStateKeys({
      stateDirectory: restoredState,
      backupOutput: rotationBackup,
      environment,
      fixtureId: rotationFixtureId,
      plaintext: rotationPlaintext,
      previousKeys,
    });
    const rotationBackupBytes = await readFile(rotationBackup);
    uninstallBlockerId = randomUUID();
    await writeUninstallBlocker(restoredState, uninstallBlockerId);
    runSelfHost(["stop", "--state-dir", originalState], environment, { inherit: false });
    const exactSourceRevision = resolveSourceRevision(sourceRevision);
    const backupBytes = await readFile(backup);
    proveUninstallFailsClosed(restoredState, environment);
    await removeUninstallBlocker(restoredState, uninstallBlockerId);
    uninstallState(originalState, environment);
    uninstallState(restoredState, environment);
    await rm(backup, { force: true });
    await rm(rotationBackup, { force: true });
    const receipt = {
      format: "hivra-self-host-recovery-e2e-v1",
      status: "pass",
      startedAt,
      finishedAt: new Date().toISOString(),
      sourceRevision: exactSourceRevision,
      backupSha256: createHash("sha256").update(backupBytes).digest("hex"),
      backupBytes: backupBytes.length,
      rotationBackupSha256: createHash("sha256").update(rotationBackupBytes).digest("hex"),
      rotationBackupBytes: rotationBackupBytes.length,
      checks,
      cleanup: {
        originalUninstall: "pass",
        restoredUninstall: "pass",
        retainedComputerGuard: "pass",
        encryptedTestBackupRemoved: "pass",
        encryptedRotationBackupRemoved: "pass",
      },
      secretsPrinted: false,
      resourcesRetainedForInspection: [],
    };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await chmod(receiptPath, 0o600);
    process.stdout.write(`${JSON.stringify({ status: receipt.status, receipt: receiptPath, checks })}\n`);
  } finally {
    // Failure paths get the same owned cleanup as success. Never use a global
    // Docker prune or bypass uninstall's provider/retained-computer guards.
    await cleanupRecoverySteps([
      ["dashboard shutdown", async () => { if (launcher) await stopLauncher(launcher); }],
      ["synthetic blocker removal", async () => {
        if (uninstallBlockerId && existsSync(restoredState)) await removeUninstallBlocker(restoredState, uninstallBlockerId);
      }],
      ...[originalState, restoredState].map(state => [path.basename(state), async () => {
        if (existsSync(state)) uninstallState(state, environment);
      }]),
      ["encrypted backup removal", async () => {
        await rm(backup, { force: true });
        await rm(rotationBackup, { force: true });
      }],
    ]);
  }
}

if (path.resolve(process.argv[1] || "") === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`ERROR  ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
