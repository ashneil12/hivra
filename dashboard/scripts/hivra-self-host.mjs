#!/usr/bin/env node

import { createHash, randomBytes, scryptSync } from "node:crypto";
import { createReadStream, existsSync, realpathSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import net from "node:net";
import readline from "node:readline/promises";
import { assertOwnedLoopbackContainers, loopbackDockerEnvironment } from "./hivra-self-host-docker.mjs";
import { transferStorageSnapshot, withQuiescedStorage } from "./hivra-self-host-storage.mjs";
import {
  BACKUP_PAYLOAD_FILES,
  createBackupManifest,
  databaseRestorePreamble,
  databaseRestorePsqlArgs,
  decryptBackupArchive,
  encryptBackupArchive,
  inspectExtractedBackup,
  rejectIncompleteLegacyStorage,
  resolveExistingBackupPath,
  resolveNewBackupPath,
  sha256File,
  writeBackupManifest,
} from "./hivra-self-host-backup.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const dashboardRoot = path.resolve(path.dirname(scriptPath), "..");
const repositoryRoot = path.resolve(dashboardRoot, "..");
const PINNED_SUPABASE_CLI = "2.116.0";
const DEFAULT_APP_URL = "http://127.0.0.1:3000";
const FIRST_BOOT_CALLBACK_PATH = "/api/infrastructure/first-boot/enroll";
const REQUIRED_STATUS_KEYS = ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY", "JWT_SECRET"];
const DASHBOARD_PROCESS_FORMAT = "hivra-self-host-dashboard-process-v1";

function line(message = "") {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

export function parseArgs(argv) {
  const [command = "doctor", ...rest] = argv;
  const allowedOptions = {
    // The native client supplies its state directory uniformly, including doctor.
    doctor: ["state-dir"],
    init: ["state-dir", "email", "name"],
    start: ["state-dir", "public-url"],
    status: ["state-dir"],
    stop: ["state-dir"],
    backup: ["state-dir", "output"],
    export: ["state-dir", "output"],
    restore: ["state-dir", "input"],
    "rotate-keys": ["state-dir", "backup-output", "confirm"],
    uninstall: ["state-dir", "confirm"],
  };
  if (!Object.hasOwn(allowedOptions, command)) {
    fail(`Unknown self-host command. Choose: ${Object.keys(allowedOptions).join(", ")}.`);
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const entry = rest[index];
    if (!entry.startsWith("--")) fail("Unexpected positional argument; use named --option value pairs.");
    const key = entry.slice(2);
    if (!allowedOptions[command].includes(key)) {
      fail(`Unknown option for ${command}. Allowed options: ${allowedOptions[command].map(name => `--${name}`).join(", ")}.`);
    }
    if (Object.hasOwn(options, key)) fail(`Duplicate option --${key}; supply it exactly once.`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function defaultStateDirectory() {
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "Hivra");
  }
  return path.join(os.homedir(), ".config", "hivra");
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveStateDirectory(value) {
  const directory = path.resolve(value || process.env.HIVRA_STATE_DIR || defaultStateDirectory());
  if (isInside(repositoryRoot, directory)) {
    fail("The self-host state directory must be outside the source repository.");
  }
  if (
    directory === path.parse(directory).root ||
    directory === path.resolve(os.homedir()) ||
    isInside(directory, repositoryRoot)
  ) {
    fail("The self-host state directory cannot be a filesystem root, home directory, or source ancestor.");
  }
  return directory;
}

function commandResult(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || dashboardRoot,
    encoding: "utf8",
    env: options.env || process.env,
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    timeout: options.timeout || 120_000,
  });
}

function executableOnPath(name) {
  const pathEntries = (process.env.PATH || "").split(path.delimiter);
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function redactSupabaseOutput(output) {
  return String(output || "")
    .replace(/\b(ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET|PUBLISHABLE_KEY|SECRET_KEY|S3_PROTOCOL_ACCESS_KEY_ID|S3_PROTOCOL_ACCESS_KEY_SECRET)=([^\s]+)/g, "$1=[redacted]")
    .replace(/("(?:ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET|PUBLISHABLE_KEY|SECRET_KEY|S3_PROTOCOL_ACCESS_KEY_ID|S3_PROTOCOL_ACCESS_KEY_SECRET)"\s*:\s*)"[^"]*"/g, '$1"[redacted]"')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]")
    .replace(/\bsb_(?:publishable|secret)_[A-Za-z0-9_-]+\b/g, "[redacted-api-key]")
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+@/g, "$1[redacted]@");
}

export function selectSupabaseCommand({ local, npx, global }) {
  if (local) return { command: local, prefix: [] };
  // Prefer the declared version over an arbitrary machine-global CLI. The
  // local control plane depends on exact startup, migration and teardown
  // semantics, so PATH precedence must not silently change those contracts.
  if (npx) return { command: npx, prefix: ["--yes", `supabase@${PINNED_SUPABASE_CLI}`] };
  if (global) return { command: global, prefix: [] };
  return null;
}

export function resolveSupabaseCommand() {
  const localPath = path.join(dashboardRoot, "node_modules", ".bin", process.platform === "win32" ? "supabase.cmd" : "supabase");
  return selectSupabaseCommand({
    local: existsSync(localPath) ? localPath : null,
    npx: executableOnPath("npx"),
    global: executableOnPath("supabase"),
  });
}

function runSupabase(args, options = {}) {
  const resolved = resolveSupabaseCommand();
  if (!resolved) fail("Supabase CLI is unavailable. Install it or make npx available.");
  const result = commandResult(resolved.command, [...resolved.prefix, ...args], {
    ...options,
    cwd: options.workdir || dashboardRoot,
    timeout: options.timeout || 10 * 60 * 1000,
  });
  if (result.error || result.status !== 0) {
    const rawDetail = [result.stderr, result.stdout, result.error?.message]
      .filter(Boolean)
      .join("\n");
    const detail = redactSupabaseOutput(rawDetail || "unknown error").slice(-16_384).trim();
    fail(`Supabase command failed: ${detail}`);
  }
  return result.stdout;
}

export function parseSupabaseEnvironment(output) {
  const values = {};
  for (const rawLine of output.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        fail(`Supabase returned malformed JSON quoting for ${key}.`);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  for (const key of REQUIRED_STATUS_KEYS) {
    if (!values[key]) fail(`Supabase status did not provide ${key}.`);
  }
  const apiUrl = new URL(values.API_URL);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(apiUrl.hostname)) {
    fail("The simple self-host setup accepts only a loopback Supabase API URL.");
  }
  if (values.JWT_SECRET.length < 32) fail("Supabase returned an unsafe JWT secret.");
  return values;
}

function dotenvLine(key, value) {
  if (typeof value !== "string" || /[\r\n\u0000]/.test(value)) fail(`Unsafe value for ${key}.`);
  return `${key}=${JSON.stringify(value)}`;
}

export function renderPrivateEnvironment(values) {
  const orderedKeys = Object.keys(values).sort();
  return `${orderedKeys.map((key) => dotenvLine(key, values[key])).join("\n")}\n`;
}

export function parsePrivateEnvironment(contents) {
  const values = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const lineValue = rawLine.trim();
    if (!lineValue || lineValue.startsWith("#")) continue;
    const separator = lineValue.indexOf("=");
    if (separator < 1) fail("The private self-host environment file is malformed.");
    const key = lineValue.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || key in values) fail("The private self-host environment file is malformed.");
    try {
      values[key] = JSON.parse(lineValue.slice(separator + 1));
    } catch {
      fail(`The private self-host environment value for ${key} is malformed.`);
    }
    if (typeof values[key] !== "string") fail(`The private self-host environment value for ${key} must be a string.`);
  }
  return values;
}

export function hashOperatorPassword(password, salt = randomBytes(16)) {
  if (password.length < 12) fail("Operator password must contain at least 12 characters.");
  const digest = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

export function normalizePublicAppUrl(value) {
  if (value === undefined) return null;
  if (value === "local") return DEFAULT_APP_URL;
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("--public-url must be 'local' or an absolute HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    fail("--public-url must be an origin-only HTTPS URL on the default HTTPS port, without credentials, path, query, or fragment.");
  }
  return url.origin;
}

export function dashboardStatusUrls(values) {
  const configuredPublicUrl = values?.NEXT_PUBLIC_APP_URL || DEFAULT_APP_URL;
  return {
    local: DEFAULT_APP_URL,
    publicCallback: configuredPublicUrl === DEFAULT_APP_URL ? null : configuredPublicUrl,
  };
}

export async function probePublicFirstBootCallback(origin, request = fetch) {
  try {
    const response = await request(new URL(FIRST_BOOT_CALLBACK_PATH, origin), {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    const payload = await response.json().catch(() => null);
    if (
      response.status === 401 &&
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      payload.accepted === false &&
      Object.keys(payload).length === 1
    ) {
      return "up";
    }
    return response.status >= 500
      ? `unhealthy (${response.status})`
      : `misconfigured (${response.status})`;
  } catch {
    return "down";
  }
}

function secureRandomHex(bytes = 32) {
  return randomBytes(bytes).toString("hex");
}

async function promptLine(prompt, fallback = "") {
  if (!process.stdin.isTTY) return fallback;
  const interfaceHandle = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await interfaceHandle.question(prompt)).trim();
    return answer || fallback;
  } finally {
    interfaceHandle.close();
  }
}

async function promptHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    fail("Set HIVRA_SETUP_PASSWORD for non-interactive setup.");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const stdin = process.stdin;
    const finish = (error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      line();
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      for (const character of text) {
        if (character === "\u0003") return finish(new Error("Setup cancelled."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function collectOperatorIdentity(options) {
  const email = (options.email || process.env.HIVRA_SETUP_EMAIL || await promptLine("Operator email: ")).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("Enter a valid operator email address.");
  const name = (options.name || process.env.HIVRA_SETUP_NAME || await promptLine("Operator name [Operator]: ", "Operator")).trim();
  if (!name || name.length > 80) fail("Operator name must contain 1 to 80 characters.");
  let password = process.env.HIVRA_SETUP_PASSWORD;
  if (!password) {
    password = await promptHidden("Operator password (12+ characters): ");
    const confirmation = await promptHidden("Confirm operator password: ");
    if (password !== confirmation) fail("Operator passwords did not match.");
  }
  const passwordHash = hashOperatorPassword(password);
  password = "";
  return { email, name, passwordHash };
}

function dockerReady() {
  const docker = executableOnPath("docker");
  if (!docker) return { ok: false, detail: "Docker-compatible CLI not found" };
  const result = commandResult(docker, ["info", "--format", "{{.ServerVersion}}"], { timeout: 20_000 });
  return result.status === 0
    ? { ok: true, detail: `daemon ${result.stdout.trim()}` }
    : { ok: false, detail: "container runtime is not running" };
}

export function supportedNodeVersion(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map(Number);
  return Number.isInteger(major) && Number.isInteger(minor)
    && (major > 22 || (major === 22 && minor >= 22));
}

function nodeReady() {
  return supportedNodeVersion()
    ? { ok: true, detail: process.versions.node }
    : { ok: false, detail: `${process.versions.node}; require Node 22.22 or newer` };
}

function supabaseReady() {
  const resolved = resolveSupabaseCommand();
  if (!resolved) return { ok: false, detail: "CLI unavailable" };
  const result = commandResult(resolved.command, [...resolved.prefix, "--version"], { timeout: 120_000 });
  return result.status === 0
    ? { ok: true, detail: result.stdout.trim() }
    : { ok: false, detail: "CLI failed to run" };
}

function dependencyReady() {
  return existsSync(path.join(dashboardRoot, "node_modules", "next", "package.json"))
    ? { ok: true, detail: "installed" }
    : { ok: false, detail: "run npm ci in dashboard/" };
}

function doctorChecks() {
  return {
    node: nodeReady(),
    dependencies: dependencyReady(),
    containerRuntime: dockerReady(),
    supabaseCli: supabaseReady(),
    config: existsSync(path.join(dashboardRoot, "supabase", "config.toml"))
      ? { ok: true, detail: "present" }
      : { ok: false, detail: "supabase/config.toml missing" },
    seed: existsSync(path.join(dashboardRoot, "supabase", "seed.sql"))
      ? { ok: true, detail: "present" }
      : { ok: false, detail: "supabase/seed.sql missing" },
  };
}

function printDoctor(checks) {
  for (const [name, result] of Object.entries(checks)) {
    line(`${result.ok ? "PASS" : "FAIL"}  ${name}: ${result.detail}`);
  }
}

function ensureDoctor() {
  const checks = doctorChecks();
  printDoctor(checks);
  if (Object.values(checks).some((check) => !check.ok)) {
    fail("Self-host prerequisites are not ready.");
  }
}

function networkName(stateDirectory) {
  const digest = createHash("sha256").update(stateDirectory).digest("hex").slice(0, 10);
  return `hivra-local-${digest}`;
}

function ensureLoopbackNetwork(stateDirectory) {
  const docker = executableOnPath("docker");
  if (!docker) fail("Docker-compatible CLI not found.");
  const name = networkName(stateDirectory);
  const inspect = commandResult(docker, ["network", "inspect", name], { timeout: 30_000 });
  if (inspect.status === 0) return name;
  const create = commandResult(
    docker,
    ["network", "create", "-o", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", name],
    { timeout: 30_000 },
  );
  if (create.status !== 0) fail(`Could not create the loopback-only container network: ${(create.stderr || "").trim()}`);
  return name;
}

function canListen(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function portAvailable(port) {
  // On macOS, wildcard and loopback listeners can coexist at the same port.
  // Probe both sequentially: either alone misses one Docker Desktop mapping.
  return await canListen("0.0.0.0", port) && await canListen("127.0.0.1", port);
}

export async function waitForDashboardReady({
  url = DEFAULT_APP_URL,
  timeoutMs = 30_000,
  intervalMs = 250,
  probe = async (candidate) => {
    const response = await fetch(candidate, {
      redirect: "manual",
      signal: AbortSignal.timeout(1_000),
    });
    return response.status < 500;
  },
  processRunning = () => true,
  now = () => Date.now(),
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
} = {}) {
  const startedAt = now();
  while (true) {
    if (!processRunning()) {
      fail("The local dashboard stopped before it became reachable.");
    }
    try {
      if (await probe(url)) return;
    } catch {
      // A refused connection is expected while Next finishes binding. Keep the
      // readiness deadline authoritative instead of exposing transient errors.
    }
    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) {
      fail("The local dashboard did not become reachable within 30 seconds.");
    }
    await sleep(Math.min(intervalMs, timeoutMs - elapsed));
  }
}

async function choosePortBase() {
  const offsets = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10];
  for (let base = 55320; base <= 61320; base += 20) {
    const free = await Promise.all(offsets.map((offset) => portAvailable(base + offset)));
    if (free.every(Boolean)) return base;
  }
  fail("Could not find a free local port block for the Hivra database services.");
}

export function rebaseSupabaseConfig(source, { projectId, portBase }) {
  let config = source.replace(/^project_id\s*=\s*"[^"]+"/m, `project_id = "${projectId}"`);
  for (let offset = 0; offset <= 9; offset += 1) {
    config = config.replaceAll(String(54320 + offset), String(portBase + offset));
  }
  config = config.replace(/^inspector_port\s*=\s*\d+/m, `inspector_port = ${portBase + 10}`);
  return config;
}

async function prepareSupabaseWorkspace(stateDirectory, { initialize = false } = {}) {
  const controlPlane = path.join(stateDirectory, "control-plane");
  const targetSupabase = path.join(controlPlane, "supabase");
  const runtimePath = path.join(stateDirectory, "database-runtime.json");
  let runtime;
  if (existsSync(runtimePath)) {
    runtime = JSON.parse(await readFile(runtimePath, "utf8"));
  } else {
    if (!initialize) fail("The private database workspace is missing. Run self-host:init first.");
    const portBase = await choosePortBase();
    const suffix = createHash("sha256").update(stateDirectory).digest("hex").slice(0, 10);
    runtime = {
      format: "hivra-local-database-runtime-v1",
      projectId: `hivra-${suffix}`,
      portBase,
    };
    await atomicPrivateWrite(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`, { exclusive: true });
  }
  if (
    runtime?.format !== "hivra-local-database-runtime-v1" ||
    !/^hivra-[a-f0-9]{10}$/.test(runtime.projectId) ||
    !Number.isInteger(runtime.portBase) ||
    runtime.portBase < 1024 || runtime.portBase > 65400
  ) {
    fail("The private database runtime receipt is invalid.");
  }

  await mkdir(targetSupabase, { recursive: true, mode: 0o700 });
  await cp(path.join(dashboardRoot, "supabase", "migrations"), path.join(targetSupabase, "migrations"), {
    recursive: true,
    force: true,
  });
  await cp(path.join(dashboardRoot, "supabase", "seed.sql"), path.join(targetSupabase, "seed.sql"), { force: true });
  const sourceConfig = await readFile(path.join(dashboardRoot, "supabase", "config.toml"), "utf8");
  await writeFile(
    path.join(targetSupabase, "config.toml"),
    rebaseSupabaseConfig(sourceConfig, runtime),
    { mode: 0o600 },
  );
  return { controlPlane, runtime };
}

async function startSupabase(stateDirectory, { initialize = false } = {}) {
  const { controlPlane, runtime } = await prepareSupabaseWorkspace(stateDirectory, { initialize });
  const network = ensureLoopbackNetwork(stateDirectory);
  const docker = executableOnPath("docker");
  const scope = { projectId: runtime.projectId, network };
  // Do not start old wildcard-bound containers even briefly. The normal stop
  // command removes containers but preserves their database/storage volumes.
  try {
    assertOwnedLoopbackContainers(docker, scope);
  } catch {
    fail("Local database containers have unverified or non-loopback ports. Run self-host:stop for this state directory (data is preserved), then start again to recreate them with explicit loopback bindings.");
  }
  if (runSupabase(["--version"]).trim() !== PINNED_SUPABASE_CLI) {
    fail(`The local Docker adapter requires Supabase CLI ${PINNED_SUPABASE_CLI}; remove a mismatched repository-local CLI.`);
  }
  const env = await loopbackDockerEnvironment({ directory: path.join(stateDirectory, "docker-loopback-bin"), docker, ...scope });
  runSupabase([
    "start",
    "--network-id",
    network,
    "--exclude",
    // Keep GoTrue running even though Hivra uses its own local operator login.
    // The Supabase CLI only publishes the generated project API keys once
    // GoTrue is healthy; PostgREST and the dashboard still need those keys.
    "studio,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor,postgres-meta",
  ], { timeout: 20 * 60 * 1000, workdir: controlPlane, env });
  if (assertOwnedLoopbackContainers(docker, scope) === 0) fail("No verified local database containers were started.");
  // Existing installations need newly committed migrations too. `start`
  // initializes a brand-new volume, but it does not advance an already-running
  // local database when the source checkout changes.
  runSupabase(["migration", "up", "--local"], {
    timeout: 20 * 60 * 1000,
    workdir: controlPlane,
    env,
  });
  return {
    environment: parseSupabaseEnvironment(runSupabase(["status", "-o", "env"], { workdir: controlPlane })),
    runtime,
  };
}

function buildEnvironment(supabase, operator, previous = {}) {
  return {
    ...previous,
    API_SERVER_KEY: previous.API_SERVER_KEY || secureRandomHex(),
    CHAT_ENCRYPTION_KEY: previous.CHAT_ENCRYPTION_KEY || secureRandomHex(),
    CRON_SECRET: previous.CRON_SECRET || secureRandomHex(),
    ENCRYPTION_KEY: previous.ENCRYPTION_KEY || secureRandomHex(),
    ...(Object.keys(previous).length === 0 || previous.LAUNCH_FINGERPRINT_KEY
      ? { LAUNCH_FINGERPRINT_KEY: previous.LAUNCH_FINGERPRINT_KEY || secureRandomHex() }
      : {}),
    HIVRA_AUTH_MODE: "local",
    HIVRA_LOCAL_JWT_SECRET: supabase.JWT_SECRET,
    HIVRA_OPERATOR_EMAIL: operator.email,
    HIVRA_OPERATOR_NAME: operator.name,
    HIVRA_OPERATOR_PASSWORD_HASH: operator.passwordHash,
    NEXT_PUBLIC_APP_URL: previous.NEXT_PUBLIC_APP_URL || DEFAULT_APP_URL,
    NEXT_PUBLIC_HIVRA_AGENTS: "1",
    NEXT_PUBLIC_POSTHOG_KEY: "",
    NEXT_PUBLIC_SITE_URL: previous.NEXT_PUBLIC_SITE_URL || DEFAULT_APP_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: supabase.ANON_KEY,
    NEXT_PUBLIC_SUPABASE_URL: supabase.API_URL,
    POSTHOG_DISABLED: "1",
    SUPABASE_SERVICE_ROLE_KEY: supabase.SERVICE_ROLE_KEY,
  };
}

export function withRequiredSelfHostedDefaults(values) {
  return {
    ...values,
    // Existing installations predate the public Hivra feature flag. Keep the
    // local control plane on the same product surface as a fresh install when
    // it is rebuilt from a newer checkout.
    HIVRA_AUTH_MODE: "local",
    NEXT_PUBLIC_HIVRA_AGENTS: "1",
    NEXT_PUBLIC_POSTHOG_KEY: "",
    POSTHOG_DISABLED: "1",
  };
}

async function atomicPrivateWrite(target, contents, { exclusive = false } = {}) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(target), 0o700);
  if (exclusive && existsSync(target)) fail(`Private configuration already exists at ${target}.`);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

function safeChildEnvironment(privateValues) {
  const allowedPublic = new Set([
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_HIVRA_AGENTS",
    "NEXT_PUBLIC_SITE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
  ]);
  const hostedSecretPrefixes = [
    "AEON_DISPATCH_", "ANTHROPIC_", "APPLE_", "BANKR_", "BASE_RPC_",
    "CLERK_", "CLOUDFLARE_", "CROF_", "CRYPTO_", "FINGERPRINT_",
    "GEMINI_", "GHCR_", "HERMESOS_BACKUP_", "MANAGED_VENICE_",
    "MODEL_SYNC_", "OPENAI_", "PINATA_", "POSTHOG_", "PRODUCTCLANK_",
    "PROXMOX_", "RESEND_", "STRIPE_", "VERCEL_",
  ];
  const operatorCloudflareKeys = new Set([
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_DNS_DOMAIN",
    "CLOUDFLARE_DNS_PROXIED",
    "CLOUDFLARE_TUNNEL_API_TOKEN",
    "CLOUDFLARE_TUNNEL_DOMAIN",
    "CLOUDFLARE_ZONE_ID",
  ]);
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      !operatorCloudflareKeys.has(key) &&
      ((key.startsWith("NEXT_PUBLIC_") && !allowedPublic.has(key)) ||
        hostedSecretPrefixes.some((prefix) => key.startsWith(prefix)))
    ) {
      delete environment[key];
    }
  }
  Object.assign(environment, privateValues);
  delete environment.HIVRA_SETUP_PASSWORD;
  return environment;
}

function dashboardProcessPath(stateDirectory) {
  return path.join(stateDirectory, "dashboard-process.json");
}

export function parseDashboardProcessReceipt(contents, stateDirectory) {
  let receipt;
  try {
    receipt = JSON.parse(contents);
  } catch {
    fail("The dashboard process receipt is malformed.");
  }
  if (
    receipt?.format !== DASHBOARD_PROCESS_FORMAT ||
    receipt.stateDirectory !== stateDirectory ||
    !Number.isSafeInteger(receipt.launcherPid) ||
    receipt.launcherPid < 2 ||
    !Number.isSafeInteger(receipt.childPid) ||
    receipt.childPid < 2 ||
    typeof receipt.startedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.startedAt))
  ) {
    fail("The dashboard process receipt is invalid.");
  }
  return receipt;
}

export function isOwnedDashboardCommand(command) {
  return typeof command === "string" &&
    /(?:^|[\/\\])hivra-self-host\.mjs(?:\s|$)/.test(command) &&
    /(?:^|\s)start(?:\s|$)/.test(command);
}

function processCommand(pid) {
  if (process.platform === "win32") return null;
  const result = commandResult("ps", ["-p", String(pid), "-o", "command="], { timeout: 10_000 });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readDashboardProcess(stateDirectory) {
  const target = dashboardProcessPath(stateDirectory);
  if (!existsSync(target)) return null;
  return parseDashboardProcessReceipt(await readFile(target, "utf8"), stateDirectory);
}

export function dashboardProcessOwnershipStatus({ receipt, running, command }) {
  if (!receipt || !running) return "down";
  return command === null || isOwnedDashboardCommand(command) ? "up" : "mismatch";
}

async function clearDashboardProcessReceipt(stateDirectory, launcherPid) {
  const receipt = await readDashboardProcess(stateDirectory).catch(() => null);
  if (receipt?.launcherPid !== launcherPid) return;
  await unlink(dashboardProcessPath(stateDirectory)).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function stopDashboard(stateDirectory) {
  const receipt = await readDashboardProcess(stateDirectory);
  if (!receipt) return false;
  if (!processExists(receipt.launcherPid)) {
    await clearDashboardProcessReceipt(stateDirectory, receipt.launcherPid);
    return false;
  }
  const command = processCommand(receipt.launcherPid);
  if (command !== null && !isOwnedDashboardCommand(command)) {
    fail("The saved dashboard process identity no longer matches; refusing to stop an unrelated process.");
  }
  process.kill(receipt.launcherPid, "SIGTERM");
  for (let attempt = 0; attempt < 50 && processExists(receipt.launcherPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (processExists(receipt.launcherPid)) fail("The Hivra dashboard did not stop cleanly.");
  await clearDashboardProcessReceipt(stateDirectory, receipt.launcherPid);
  return true;
}

async function readPrivateConfig(stateDirectory) {
  const target = path.join(stateDirectory, "dashboard.env");
  const values = parsePrivateEnvironment(await readFile(target, "utf8"));
  for (const key of [
    "HIVRA_LOCAL_JWT_SECRET",
    "HIVRA_OPERATOR_EMAIL",
    "HIVRA_OPERATOR_PASSWORD_HASH",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ENCRYPTION_KEY",
    "CHAT_ENCRYPTION_KEY",
  ]) {
    if (!values[key]) fail(`Private configuration is missing ${key}.`);
  }
  return { target, values };
}

async function refreshSupabaseCredentials(target, values, supabase) {
  const next = withRequiredSelfHostedDefaults({
    ...values,
    HIVRA_LOCAL_JWT_SECRET: supabase.JWT_SECRET,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: supabase.ANON_KEY,
    NEXT_PUBLIC_SUPABASE_URL: supabase.API_URL,
    SUPABASE_SERVICE_ROLE_KEY: supabase.SERVICE_ROLE_KEY,
  });
  if (renderPrivateEnvironment(next) !== renderPrivateEnvironment(values)) {
    await atomicPrivateWrite(target, renderPrivateEnvironment(next));
    line("Updated local database connection values in the private configuration.");
  }
  return next;
}

async function refreshPublicAppUrl(target, values, requestedUrl) {
  const publicUrl = normalizePublicAppUrl(requestedUrl);
  if (publicUrl === null) return values;
  const next = {
    ...values,
    NEXT_PUBLIC_APP_URL: publicUrl,
    NEXT_PUBLIC_SITE_URL: publicUrl,
  };
  if (renderPrivateEnvironment(next) !== renderPrivateEnvironment(values)) {
    await atomicPrivateWrite(target, renderPrivateEnvironment(next));
    line(publicUrl === DEFAULT_APP_URL
      ? "Remote first-boot callbacks disabled; using the local dashboard origin."
      : "Configured the explicit HTTPS origin for remote first-boot callbacks.");
  }
  return next;
}

function runBuild(environment) {
  // The self-host launcher must work from both ordinary clones and Git
  // worktrees whose dependency directory is symlinked to a shared checkout.
  // Turbopack rejects a node_modules symlink outside its filesystem root;
  // Webpack supports that normal Git-worktree arrangement.
  const result = commandResult(executableOnPath("npm") || "npm", ["run", "build", "--", "--webpack"], {
    cwd: dashboardRoot,
    env: safeChildEnvironment(environment),
    inherit: true,
    timeout: 20 * 60 * 1000,
  });
  if (result.error || result.status !== 0) fail("The self-host dashboard production build failed.");
}

async function initialize(options) {
  ensureDoctor();
  const stateDirectory = resolveStateDirectory(options["state-dir"]);
  const target = path.join(stateDirectory, "dashboard.env");
  if (existsSync(target)) fail(`An installation already exists at ${target}. Use self-host:start.`);
  line("Starting the local database and applying committed migrations...");
  const { environment: supabase, runtime: databaseRuntime } = await startSupabase(stateDirectory, { initialize: true });
  const operator = await collectOperatorIdentity(options);
  const environment = buildEnvironment(supabase, operator);
  const git = commandResult("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, timeout: 10_000 });
  const receipt = {
    format: "hivra-self-host-installation-v1",
    createdAt: new Date().toISOString(),
    sourceRevision: git.status === 0 ? git.stdout.trim() : null,
    nodeVersion: process.versions.node,
    supabaseCliVersion: supabaseReady().detail,
    databaseProjectId: databaseRuntime.projectId,
    databasePortBase: databaseRuntime.portBase,
    stateDirectory,
    secretsPrinted: false,
  };
  line("Building the self-host dashboard...");
  runBuild(environment);
  // Do not advertise a configured installation until its production build is
  // usable. A failed build can be retried through Set up instead of leaving
  // the native app pointing at a partial installation.
  await atomicPrivateWrite(target, renderPrivateEnvironment(environment), { exclusive: true });
  await atomicPrivateWrite(path.join(stateDirectory, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { exclusive: true });
  line(`READY  private configuration: ${target}`);
  line("Run npm run self-host:start to open Hivra at http://127.0.0.1:3000.");
}

async function start(options) {
  ensureDoctor();
  const stateDirectory = resolveStateDirectory(options["state-dir"]);
  const existingProcess = await readDashboardProcess(stateDirectory);
  if (existingProcess && processExists(existingProcess.launcherPid)) {
    const command = processCommand(existingProcess.launcherPid);
    if (command === null || isOwnedDashboardCommand(command)) {
      fail("The Hivra dashboard is already running for this installation. Run self-host:stop first.");
    }
    fail("The saved dashboard process identity no longer matches; inspect the process receipt before starting.");
  }
  if (existingProcess) await clearDashboardProcessReceipt(stateDirectory, existingProcess.launcherPid);
  const { target, values: storedValues } = await readPrivateConfig(stateDirectory);
  const values = await refreshPublicAppUrl(target, storedValues, options["public-url"]);
  line("Starting local database services...");
  const { environment: supabase } = await startSupabase(stateDirectory);
  const environment = await refreshSupabaseCredentials(target, values, supabase);
  line("Building the dashboard against this installation...");
  runBuild(environment);
  const child = spawn(executableOnPath("npm") || "npm", ["start", "--", "-H", "127.0.0.1", "-p", "3000"], {
    cwd: dashboardRoot,
    env: safeChildEnvironment(environment),
    stdio: "inherit",
  });
  const exitPromise = new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
  try {
    await atomicPrivateWrite(dashboardProcessPath(stateDirectory), `${JSON.stringify({
      format: DASHBOARD_PROCESS_FORMAT,
      stateDirectory,
      launcherPid: process.pid,
      childPid: child.pid,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`, { exclusive: true });
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  try {
    await waitForDashboardReady({
      processRunning: () => child.exitCode === null && child.signalCode === null,
    });
  } catch (error) {
    child.kill("SIGTERM");
    await clearDashboardProcessReceipt(stateDirectory, process.pid);
    throw error;
  }
  // The native app treats this marker as permission to reload its WKWebView.
  // Emit it only after the loopback HTTP surface has actually answered.
  line("OPEN   http://127.0.0.1:3000");
  const exitCode = await exitPromise;
  await clearDashboardProcessReceipt(stateDirectory, process.pid);
  process.exitCode = exitCode;
}

async function status(options) {
  const stateDirectory = resolveStateDirectory(options["state-dir"]);
  const { values } = await readPrivateConfig(stateDirectory);
  const statusUrls = dashboardStatusUrls(values);
  const probe = async (url) => {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      return response.status < 500 ? "up" : `unhealthy (${response.status})`;
    } catch {
      return "down";
    }
  };
  let database = "down";
  try {
    const response = await fetch(`${values.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: values.NEXT_PUBLIC_SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(5_000),
    });
    database = response.status < 500 ? "up" : `unhealthy (${response.status})`;
  } catch {
    database = "down";
  }
  const dashboard = await probe(statusUrls.local);
  const dashboardProcess = await readDashboardProcess(stateDirectory).catch(() => null);
  const dashboardProcessStatus = dashboardProcessOwnershipStatus({
    receipt: dashboardProcess,
    running: dashboardProcess ? processExists(dashboardProcess.launcherPid) : false,
    command: dashboardProcess ? processCommand(dashboardProcess.launcherPid) : null,
  });
  line(`database: ${database}`);
  line(`dashboard: ${dashboard}`);
  line(`dashboard process: ${dashboardProcessStatus}`);
  if (statusUrls.publicCallback) {
    line(`public callback: ${await probePublicFirstBootCallback(statusUrls.publicCallback)}`);
  }
  line(`configuration: valid (${Object.keys(values).length} values; secrets withheld)`);
}

async function requireDashboardStopped(stateDirectory) {
  const receipt = await readDashboardProcess(stateDirectory);
  if (!receipt) return;
  if (!processExists(receipt.launcherPid)) {
    await clearDashboardProcessReceipt(stateDirectory, receipt.launcherPid);
    return;
  }
  fail("Stop the Hivra dashboard before backup, restore, or recovery operations.");
}

async function collectBackupPassphrase({ confirm = false } = {}) {
  let passphrase = process.env.HIVRA_BACKUP_PASSPHRASE;
  if (!passphrase) {
    passphrase = await promptHidden("Backup passphrase (16+ characters): ");
    if (confirm) {
      const confirmation = await promptHidden("Confirm backup passphrase: ");
      if (passphrase !== confirmation) fail("Backup passphrases did not match.");
    }
  }
  if (passphrase.length < 16 || passphrase.length > 1024) {
    fail("Backup passphrase must contain 16 to 1024 characters.");
  }
  return passphrase;
}

async function databaseIsReachable(values) {
  try {
    const response = await fetch(`${values.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: values.NEXT_PUBLIC_SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(3_000),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

function currentSourceRevision() {
  const result = commandResult("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, timeout: 10_000 });
  return result.status === 0 && /^[a-f0-9]{40}$/.test(result.stdout.trim()) ? result.stdout.trim() : null;
}

function tarCommand() {
  const command = executableOnPath("tar");
  if (!command) fail("The system tar command is required for encrypted backup and restore.");
  return command;
}

function createBackupTar(stagingDirectory, archive) {
  const result = commandResult(tarCommand(), [
    "-cf", archive,
    "-C", stagingDirectory,
    ...BACKUP_PAYLOAD_FILES,
  ], { timeout: 10 * 60 * 1000 });
  if (result.error || result.status !== 0) fail("Could not assemble the private backup payload.");
}

function extractBackupTar(archive, destination) {
  const listed = commandResult(tarCommand(), ["-tf", archive], { timeout: 60_000 });
  if (listed.error || listed.status !== 0) fail("The decrypted backup archive could not be inspected.");
  const names = listed.stdout.split(/\r?\n/).filter(Boolean).sort();
  const expected = ["backup.json", "dashboard.env", "database.sql", "receipt.json"];
  if (![expected, BACKUP_PAYLOAD_FILES].some(files => JSON.stringify(names) === JSON.stringify(files))) fail("The decrypted backup archive contains unexpected paths.");
  const extracted = commandResult(tarCommand(), ["-xf", archive, "-C", destination], { timeout: 10 * 60 * 1000 });
  if (extracted.error || extracted.status !== 0) fail("The decrypted backup archive could not be extracted.");
}

async function stopSupabaseForState(stateDirectory, { destroy = false } = {}) {
  const { controlPlane, runtime } = await prepareSupabaseWorkspace(stateDirectory);
  const args = ["stop", "--project-id", runtime.projectId];
  if (destroy) args.push("--no-backup");
  runSupabase(args, { timeout: 10 * 60 * 1000, workdir: controlPlane });
  return runtime;
}

function removeOwnedNetwork(stateDirectory) {
  const docker = executableOnPath("docker");
  if (!docker) fail("Docker-compatible CLI not found during network removal.");
  commandResult(docker, ["network", "rm", networkName(stateDirectory)], { timeout: 30_000 });
  // A lost remove acknowledgement is harmless only if a successful fresh
  // inventory proves absence. Never equate an inspect error with not found.
  assertSuccessfulEmptyInventory([commandResult(docker,
    ["network", "ls", "--format", "{{.Name}}", "--filter", `name=^${networkName(stateDirectory)}$`],
    { timeout: 30_000 })]);
}

export function uninstallConfirmationToken(stateDirectory, projectId) {
  if (!path.isAbsolute(stateDirectory) || !/^hivra-[a-f0-9]{10}$/.test(projectId)) {
    fail("The uninstall identity is invalid.");
  }
  const digest = createHash("sha256")
    .update(`hivra-local-uninstall-v1\0${stateDirectory}\0${projectId}`)
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
  return `ERASE-${digest}`;
}

export function rotationConfirmationToken(stateDirectory, projectId) {
  if (!path.isAbsolute(stateDirectory) || !/^hivra-[a-f0-9]{10}$/.test(projectId)) {
    fail("The rotation identity is invalid.");
  }
  const digest = createHash("sha256")
    .update(`hivra-local-master-key-rotation-v1\0${stateDirectory}\0${projectId}`)
    .digest("hex").slice(0, 12).toUpperCase();
  return `ROTATE-${digest}`;
}

function keyDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rotationPaths(stateDirectory) {
  return {
    keys: path.join(stateDirectory, "key-rotation.env"),
    receipt: path.join(stateDirectory, "key-rotation.json"),
  };
}

function rotationEnvironment(values) {
  const environment = safeChildEnvironment(values);
  for (const key of ["ENCRYPTION_KEY", "ENCRYPTION_KEY_LEGACY", "CHAT_ENCRYPTION_KEY", "CHAT_ENCRYPTION_KEY_LEGACY"]) {
    delete environment[key];
  }
  Object.assign(environment, values);
  return environment;
}

function runRotationTool(values, args) {
  const result = commandResult(process.execPath, [
    "-r", "ts-node/register/transpile-only",
    "-r", "tsconfig-paths/register",
    "scripts/rotate-encryption-keys.ts",
    ...args,
  ], {
    env: {
      ...rotationEnvironment(values),
      TS_NODE_TRANSPILE_ONLY: "true",
      TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs","moduleResolution":"node"}',
    },
    timeout: 30 * 60 * 1000,
  });
  return result;
}

async function readStagedRotation(stateDirectory, currentValues) {
  const targets = rotationPaths(stateDirectory);
  if (!existsSync(targets.keys) && !existsSync(targets.receipt)) return null;
  if (!existsSync(targets.keys) || !existsSync(targets.receipt)) {
    fail("The interrupted key-rotation state is incomplete. Restore its pre-rotation backup before continuing.");
  }
  for (const target of Object.values(targets)) {
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) {
      fail("The interrupted key-rotation files are not owner-only regular files.");
    }
  }
  let receipt;
  let keys;
  try {
    receipt = JSON.parse(await readFile(targets.receipt, "utf8"));
    keys = parsePrivateEnvironment(await readFile(targets.keys, "utf8"));
  } catch {
    fail("The interrupted key-rotation state could not be read safely.");
  }
  if (
    receipt?.format !== "hivra-self-host-key-rotation-v1" ||
    receipt.stateDirectory !== stateDirectory ||
    !/^[a-f0-9]{64}$/.test(receipt.oldSecretKeySha256 || "") ||
    !/^[a-f0-9]{64}$/.test(receipt.newSecretKeySha256 || "") ||
    !/^[a-f0-9]{64}$/.test(receipt.oldChatKeySha256 || "") ||
    !/^[a-f0-9]{64}$/.test(receipt.newChatKeySha256 || "") ||
    !/^[a-f0-9]{64}$/.test(keys.ENCRYPTION_KEY || "") ||
    !/^[a-f0-9]{64}$/.test(keys.ENCRYPTION_KEY_LEGACY || "") ||
    !/^[a-f0-9]{64}$/.test(keys.CHAT_ENCRYPTION_KEY || "") ||
    !/^[a-f0-9]{64}$/.test(keys.CHAT_ENCRYPTION_KEY_LEGACY || "") ||
    keyDigest(keys.ENCRYPTION_KEY_LEGACY) !== receipt.oldSecretKeySha256 ||
    keyDigest(keys.ENCRYPTION_KEY) !== receipt.newSecretKeySha256 ||
    keyDigest(keys.CHAT_ENCRYPTION_KEY_LEGACY) !== receipt.oldChatKeySha256 ||
    keyDigest(keys.CHAT_ENCRYPTION_KEY) !== receipt.newChatKeySha256 ||
    ![receipt.oldSecretKeySha256, receipt.newSecretKeySha256].includes(keyDigest(currentValues.ENCRYPTION_KEY)) ||
    ![receipt.oldChatKeySha256, receipt.newChatKeySha256].includes(keyDigest(currentValues.CHAT_ENCRYPTION_KEY))
  ) {
    fail("The interrupted key-rotation state does not match this installation.");
  }
  return { targets, receipt, keys };
}

async function rotateKeys(options) {
  ensureDoctor();
  const stateDirectory = resolveStateDirectory(options["state-dir"]);
  const { runtime } = await readInstallationIdentity(stateDirectory);
  const token = rotationConfirmationToken(stateDirectory, runtime.projectId);
  await requireDashboardStopped(stateDirectory);
  const { target: configTarget, values: storedValues } = await readPrivateConfig(stateDirectory);
  const databaseWasUp = await databaseIsReachable(storedValues);
  try {
    const { environment: supabase } = await startSupabase(stateDirectory);
    const currentValues = await refreshSupabaseCredentials(configTarget, storedValues, supabase);
    if (!options.confirm) {
      const inspection = runRotationTool(currentValues, ["--coverage-only"]);
      if (inspection.error || ![0, 2].includes(inspection.status)) {
        fail("The key-rotation coverage inspection failed without changing ciphertext.");
      }
      line(inspection.stdout.trim());
      line("DRY RUN  local Hivra master-key rotation");
      line("The launch-fingerprint key is independent and will not change.");
      line(`Re-run with --confirm ${token} --backup-output /absolute/pre-rotation-backup.hivra`);
      return;
    }
    if (options.confirm !== token) fail("The state-bound key-rotation confirmation token is incorrect; nothing was changed.");
    if (!options["backup-output"]) fail("Confirmed key rotation requires --backup-output for its encrypted pre-rotation backup.");
    if (currentValues.ENCRYPTION_KEY_LEGACY || currentValues.CHAT_ENCRYPTION_KEY_LEGACY) {
      fail("Legacy keys already exist in the active configuration. Finish or recover that earlier rotation first.");
    }

    let staged = await readStagedRotation(stateDirectory, currentValues);
    if (!staged) {
      await backup({ "state-dir": stateDirectory, output: options["backup-output"] });
      const backupReceipt = await sha256File(path.resolve(options["backup-output"]));
      const keys = {
        ENCRYPTION_KEY: secureRandomHex(),
        ENCRYPTION_KEY_LEGACY: currentValues.ENCRYPTION_KEY,
        CHAT_ENCRYPTION_KEY: secureRandomHex(),
        CHAT_ENCRYPTION_KEY_LEGACY: currentValues.CHAT_ENCRYPTION_KEY,
      };
      const targets = rotationPaths(stateDirectory);
      const receipt = {
        format: "hivra-self-host-key-rotation-v1",
        stateDirectory,
        startedAt: new Date().toISOString(),
        backupPath: path.resolve(options["backup-output"]),
        backupSha256: backupReceipt.sha256,
        oldSecretKeySha256: keyDigest(keys.ENCRYPTION_KEY_LEGACY),
        newSecretKeySha256: keyDigest(keys.ENCRYPTION_KEY),
        oldChatKeySha256: keyDigest(keys.CHAT_ENCRYPTION_KEY_LEGACY),
        newChatKeySha256: keyDigest(keys.CHAT_ENCRYPTION_KEY),
      };
      await atomicPrivateWrite(targets.keys, renderPrivateEnvironment(keys), { exclusive: true });
      await atomicPrivateWrite(targets.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { exclusive: true });
      staged = { targets, receipt, keys };
    }

    const apply = runRotationTool({ ...currentValues, ...staged.keys }, ["--apply"]);
    if (apply.error || apply.status !== 0) {
      fail("Key rewrap did not finish. The dashboard remains stopped; rerun the same rotation command to resume from its owner-only staged keys.");
    }
    const nextValues = { ...currentValues,
      ENCRYPTION_KEY: staged.keys.ENCRYPTION_KEY,
      CHAT_ENCRYPTION_KEY: staged.keys.CHAT_ENCRYPTION_KEY };
    delete nextValues.ENCRYPTION_KEY_LEGACY;
    delete nextValues.CHAT_ENCRYPTION_KEY_LEGACY;
    const verification = runRotationTool(nextValues, ["--apply"]);
    const updates = verification.stdout.match(/Updates applied:\s+(\d+)/)?.[1];
    if (verification.error || verification.status !== 0 || updates !== "0") {
      fail("Primary-only verification did not pass. The staged recovery keys and pre-rotation backup were retained.");
    }
    await atomicPrivateWrite(configTarget, renderPrivateEnvironment(nextValues));
    await unlink(staged.targets.keys);
    await unlink(staged.targets.receipt);
    line("ROTATED  standalone secret and chat master keys");
    line(`BACKUP  ${staged.receipt.backupPath}`);
    line("Verified every covered value with primary keys only; launch-fingerprint custody was unchanged.");
  } finally {
    if (!databaseWasUp) await stopSupabaseForState(stateDirectory).catch(() => undefined);
  }
}

async function readInstallationIdentity(stateDirectory) {
  if (!existsSync(stateDirectory) || realpathSync(stateDirectory) !== stateDirectory) {
    fail("Uninstall requires the exact real installation state directory, not a link.");
  }
  const metadata = await lstat(stateDirectory);
  if (
    !metadata.isDirectory() ||
    typeof process.getuid !== "function" ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o077) !== 0
  ) {
    fail("The installation state directory must be owner-only before uninstall (normally chmod 700).");
  }
  let receipt;
  let runtime;
  try {
    receipt = JSON.parse(await readFile(path.join(stateDirectory, "receipt.json"), "utf8"));
    runtime = JSON.parse(await readFile(path.join(stateDirectory, "database-runtime.json"), "utf8"));
  } catch {
    fail("The installation identity receipts could not be read safely.");
  }
  if (
    receipt?.format !== "hivra-self-host-installation-v1" ||
    receipt.stateDirectory !== stateDirectory ||
    runtime?.format !== "hivra-local-database-runtime-v1" ||
    !/^hivra-[a-f0-9]{10}$/.test(runtime.projectId || "") ||
    receipt.databaseProjectId !== runtime.projectId
  ) {
    fail("The installation identity receipts do not match this state directory.");
  }
  return { receipt, runtime };
}

async function ensureNoRetainedComputers(values) {
  const checks = [
    ["agent computers", "hivra_agents?select=id&status=neq.deleted&limit=1"],
    ["legacy computers", "hermes_instances?select=id&status=neq.deleted&limit=1"],
    ["provider capacity orders", "infrastructure_capacity_orders?select=id&limit=1"],
  ];
  for (const [label, query] of checks) {
    let response;
    try {
      response = await fetch(`${values.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${query}`, {
        headers: {
          apikey: values.SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${values.SUPABASE_SERVICE_ROLE_KEY}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      fail(`Could not confirm the absence of ${label}; uninstall stopped before local data deletion.`);
    }
    if (!response.ok) fail(`Could not confirm the absence of ${label}; uninstall stopped before local data deletion.`);
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows)) fail(`Could not confirm the absence of ${label}; uninstall stopped before local data deletion.`);
    if (rows.length > 0) {
      fail(`Delete all ${label} through Hivra before uninstall so provider resources are not orphaned.`);
    }
  }
}

export function assertSuccessfulEmptyInventory(results) {
  // A nonzero inspect exit might be a disconnected daemon, not absence.
  if (!Array.isArray(results) || results.length === 0 || results.some(result => !result || result.error || result.status !== 0 ||
      typeof result.stdout !== "string" || result.stdout.trim())) {
    fail("Local container resource absence could not be verified; the private state directory was retained for recovery.");
  }
}

function assertLocalDatabaseRemoved(stateDirectory, projectId) {
  const docker = executableOnPath("docker");
  if (!docker) fail("Docker-compatible CLI not found during uninstall verification.");
  const containers = commandResult(docker, ["ps", "-aq", "--filter", `name=${projectId}`], { timeout: 30_000 });
  const volumes = commandResult(docker, ["volume", "ls", "-q", "--filter", `name=${projectId}`], { timeout: 30_000 });
  const network = commandResult(docker, ["network", "ls", "--format", "{{.Name}}", "--filter", `name=^${networkName(stateDirectory)}$`], { timeout: 30_000 });
  assertSuccessfulEmptyInventory([containers, volumes, network]);
}

async function uninstall(options) {
  ensureDoctor();
  const stateDirectory = resolveStateDirectory(options["state-dir"]);
  const { runtime } = await readInstallationIdentity(stateDirectory);
  const token = uninstallConfirmationToken(stateDirectory, runtime.projectId);
  if (!options.confirm) {
    line("DRY RUN  local Hivra uninstall");
    line(`State directory: ${stateDirectory}`);
    line(`Local database project: ${runtime.projectId}`);
    line("Provider servers, hosts and cloud accounts will not be modified.");
    line("First delete every computer and provider capacity order through Hivra, and keep an encrypted export if needed.");
    line(`Re-run with --confirm ${token} to erase this local database and state directory.`);
    return;
  }
  if (options.confirm !== token) fail("The state-bound uninstall confirmation token is incorrect; nothing was deleted.");
  await requireDashboardStopped(stateDirectory);
  const { values: storedValues } = await readPrivateConfig(stateDirectory);
  const databaseWasUp = await databaseIsReachable(storedValues);
  let deletionStarted = false;
  try {
    const { environment: supabase } = await startSupabase(stateDirectory);
    const values = await refreshSupabaseCredentials(path.join(stateDirectory, "dashboard.env"), storedValues, supabase);
    await ensureNoRetainedComputers(values);
    deletionStarted = true;
    await stopSupabaseForState(stateDirectory, { destroy: true });
    removeOwnedNetwork(stateDirectory);
    assertLocalDatabaseRemoved(stateDirectory, runtime.projectId);
    await rm(stateDirectory, { recursive: true, force: false });
    if (existsSync(stateDirectory)) fail("The local installation state directory could not be removed.");
    line("REMOVED  local Hivra database and private installation state");
    line("Provider servers, hosts and cloud accounts were not modified.");
  } catch (error) {
    if (!deletionStarted && !databaseWasUp) {
      await stopSupabaseForState(stateDirectory).catch(() => undefined);
    }
    throw error;
  }
}

async function runDatabaseRestore(sqlFile, projectId) {
  const docker = executableOnPath("docker");
  if (!docker) fail("Docker-compatible CLI not found.");
  const child = spawn(docker, databaseRestorePsqlArgs(projectId), {
    cwd: dashboardRoot,
    env: process.env,
    stdio: ["pipe", "ignore", "pipe"],
  });
  let diagnosticBytes = 0;
  child.stderr.on("data", (chunk) => {
    diagnosticBytes += chunk.length;
    if (diagnosticBytes > 1024 * 1024) child.kill("SIGTERM");
  });
  const input = createReadStream(sqlFile);
  const inputDone = new Promise((resolve, reject) => {
    input.on("error", reject);
    child.stdin.on("error", reject);
    child.stdin.on("finish", resolve);
  });
  child.stdin.write(await databaseRestorePreamble(sqlFile));
  input.pipe(child.stdin);
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
  await inputDone;
  if (exitCode !== 0) fail("The database restore failed; no SQL or row contents were printed.");
}

async function backup(options) {
  ensureDoctor();
  const stateDirectory = resolveStateDirectory(options["state-dir"]);
  await requireDashboardStopped(stateDirectory);
  const { values } = await readPrivateConfig(stateDirectory);
  const output = resolveNewBackupPath(options.output, { repositoryRoot, stateDirectory });
  const passphrase = await collectBackupPassphrase({ confirm: true });
  const stagingDirectory = await mkdtemp(path.join(path.dirname(output), ".hivra-backup-"));
  await chmod(stagingDirectory, 0o700);
  const databaseWasUp = await databaseIsReachable(values);
  let databaseStarted = false;
  try {
    const { runtime } = await startSupabase(stateDirectory);
    databaseStarted = true;
    const { controlPlane } = await prepareSupabaseWorkspace(stateDirectory);
    const databaseDump = path.join(stagingDirectory, "database.sql");
    const docker = executableOnPath("docker");
    // Stop file writes while taking BOTH halves of the snapshot. The dashboard
    // is already required to be stopped; a database dump alone omits uploads.
    await withQuiescedStorage(docker, runtime.projectId, async target => {
      runSupabase([
        "db", "dump", "--local", "--data-only", "--use-copy",
        "--schema", "auth,public,storage", "--file", databaseDump,
      ], { timeout: 30 * 60 * 1000, workdir: controlPlane });
      await transferStorageSnapshot({ docker, target, file: path.join(stagingDirectory, "storage.ndjson") });
    });
    await chmod(databaseDump, 0o600);
    const dashboardEnvironment = path.join(stagingDirectory, "dashboard.env");
    const receiptFile = path.join(stagingDirectory, "receipt.json");
    await cp(path.join(stateDirectory, "dashboard.env"), dashboardEnvironment, { force: false });
    await cp(path.join(stateDirectory, "receipt.json"), receiptFile, { force: false });
    await chmod(dashboardEnvironment, 0o600);
    await chmod(receiptFile, 0o600);
    const stateReceipt = JSON.parse(await readFile(receiptFile, "utf8"));
    if (stateReceipt?.format !== "hivra-self-host-installation-v1") fail("The installation receipt is invalid.");
    const files = {};
    for (const name of BACKUP_PAYLOAD_FILES.filter(name => name !== "backup.json")) {
      files[name] = await sha256File(path.join(stagingDirectory, name));
    }
    const manifest = createBackupManifest({
      sourceRevision: currentSourceRevision() || stateReceipt.sourceRevision,
      stateReceipt,
      files,
    });
    await writeBackupManifest(path.join(stagingDirectory, "backup.json"), manifest);
    const archive = path.join(stagingDirectory, "payload.tar");
    createBackupTar(stagingDirectory, archive);
    await encryptBackupArchive({ archive, output, passphrase });
    const encrypted = await sha256File(output);
    line(`READY  encrypted backup: ${output}`);
    line(`SHA256 ${encrypted.sha256}`);
    line(`Database project ${runtime.projectId} was captured without printing credentials.`);
  } finally {
    if (databaseStarted && !databaseWasUp) {
      await stopSupabaseForState(stateDirectory).catch(() => undefined);
    }
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export async function withRestoreWorkspaceCleanup(workspace, action, cleanupFailure) {
  let retainWorkspace = false;
  try {
    return await action();
  } catch (primaryError) {
    try {
      await cleanupFailure();
    } catch (cleanupError) {
      retainWorkspace = true;
      throw new AggregateError([primaryError, cleanupError],
        `Restore failed and resource cleanup could not be verified. Private recovery state retained at ${path.join(workspace, "state")}. Keep this directory and the original encrypted backup; reconcile its exact database project before removal. No SQL or credentials were printed.`);
    }
    throw primaryError;
  } finally {
    // This owns only the freshly created restore workspace, never the source
    // installation or encrypted backup. Failed teardown must retain identity.
    if (!retainWorkspace) await rm(workspace, { recursive: true, force: true });
  }
}

async function restore(options) {
  ensureDoctor();
  const stateDirectory = resolveStateDirectory(options["state-dir"]);
  if (existsSync(stateDirectory)) fail("Restore requires a new state directory; nothing was overwritten.");
  const input = resolveExistingBackupPath(options.input);
  const passphrase = await collectBackupPassphrase();
  const parent = realpathSync(path.dirname(stateDirectory));
  const workspace = await mkdtemp(path.join(parent, ".hivra-restore-"));
  await chmod(workspace, 0o700);
  const payloadDirectory = path.join(workspace, "payload");
  const stagedState = path.join(workspace, "state");
  await mkdir(payloadDirectory, { mode: 0o700 });
  await mkdir(stagedState, { mode: 0o700 });
  let databaseCreated = false;
  return withRestoreWorkspaceCleanup(workspace, async () => {
    const archive = path.join(workspace, "payload.tar");
    await decryptBackupArchive({ input, output: archive, passphrase });
    extractBackupTar(archive, payloadDirectory);
    const manifest = await inspectExtractedBackup(payloadDirectory);
    await rejectIncompleteLegacyStorage(manifest, path.join(payloadDirectory, "database.sql"));
    const storedValues = parsePrivateEnvironment(await readFile(path.join(payloadDirectory, "dashboard.env"), "utf8"));
    if (storedValues.HIVRA_AUTH_MODE !== "local") fail("The backup is not a standalone local-auth installation.");
    const originalReceipt = JSON.parse(await readFile(path.join(payloadDirectory, "receipt.json"), "utf8"));
    if (originalReceipt?.format !== "hivra-self-host-installation-v1") fail("The backup installation receipt is invalid.");
    databaseCreated = true;
    const { environment: supabase, runtime } = await startSupabase(stagedState, { initialize: true });
    const docker = executableOnPath("docker");
    await withQuiescedStorage(docker, runtime.projectId, async target => {
      await runDatabaseRestore(path.join(payloadDirectory, "database.sql"), runtime.projectId);
      if (manifest.files["storage.ndjson"]) {
        await transferStorageSnapshot({ docker, target, file: path.join(payloadDirectory, "storage.ndjson"), restore: true });
      }
    });
    const restoredValues = buildEnvironment(supabase, {
      email: storedValues.HIVRA_OPERATOR_EMAIL,
      name: storedValues.HIVRA_OPERATOR_NAME,
      passwordHash: storedValues.HIVRA_OPERATOR_PASSWORD_HASH,
    }, storedValues);
    await atomicPrivateWrite(path.join(stagedState, "dashboard.env"), renderPrivateEnvironment(restoredValues), { exclusive: true });
    const restoredReceipt = {
      format: "hivra-self-host-installation-v1",
      createdAt: originalReceipt.createdAt,
      restoredAt: new Date().toISOString(),
      restoredFromBackupCreatedAt: manifest.createdAt,
      sourceRevision: currentSourceRevision() || manifest.sourceRevision,
      originalSourceRevision: originalReceipt.sourceRevision ?? null,
      nodeVersion: process.versions.node,
      supabaseCliVersion: supabaseReady().detail,
      databaseProjectId: runtime.projectId,
      databasePortBase: runtime.portBase,
      stateDirectory,
      secretsPrinted: false,
    };
    await atomicPrivateWrite(path.join(stagedState, "receipt.json"), `${JSON.stringify(restoredReceipt, null, 2)}\n`, { exclusive: true });
    line("Building the restored self-host dashboard...");
    runBuild(restoredValues);
    await stopSupabaseForState(stagedState);
    removeOwnedNetwork(stagedState);
    await rename(stagedState, stateDirectory);
    line(`READY  restored installation: ${stateDirectory}`);
    line("Run npm run self-host:start with this state directory to verify the recovered service.");
  }, async () => {
    if (databaseCreated) {
      const runtime = await stopSupabaseForState(stagedState, { destroy: true });
      removeOwnedNetwork(stagedState);
      assertLocalDatabaseRemoved(stagedState, runtime.projectId);
    }
  });
}

async function stop(options) {
  const checks = doctorChecks();
  if (!checks.containerRuntime.ok || !checks.supabaseCli.ok) {
    printDoctor(checks);
    fail("Cannot stop local database services until the container runtime and Supabase CLI are available.");
  }
  const stateDirectory = resolveStateDirectory(options["state-dir"]);
  const dashboardStopped = await stopDashboard(stateDirectory);
  const { controlPlane } = await prepareSupabaseWorkspace(stateDirectory);
  runSupabase(["stop"] , { inherit: true, timeout: 10 * 60 * 1000, workdir: controlPlane });
  line(dashboardStopped ? "Stopped Hivra's dashboard." : "Hivra's dashboard was not running.");
  line("Stopped Hivra's local database services. Persistent volumes were preserved.");
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === "doctor") {
    const checks = doctorChecks();
    printDoctor(checks);
    if (Object.values(checks).some((check) => !check.ok)) process.exitCode = 1;
    return;
  }
  if (command === "init") return initialize(options);
  if (command === "start") return start(options);
  if (command === "status") return status(options);
  if (command === "stop") return stop(options);
  if (command === "backup" || command === "export") return backup(options);
  if (command === "restore") return restore(options);
  if (command === "rotate-keys") return rotateKeys(options);
  if (command === "uninstall") return uninstall(options);
  fail("Usage: npm run self-host:<doctor|init|start|status|stop|backup|export|restore|rotate-keys|uninstall> -- [--state-dir /absolute/path] [--output /absolute/backup.hivra] [--input /absolute/backup.hivra] [--backup-output /absolute/pre-rotation.hivra] [--confirm STATE_BOUND_TOKEN]");
}

if (path.resolve(process.argv[1] || "") === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`ERROR  ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
