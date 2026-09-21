#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const NEXT_BUILD_MAX_OLD_SPACE_SIZE_MB = 4096;

function buildLockPath(cwd) {
  return path.join(cwd, ".next", "dev", "lock");
}

function readLockMetadata(lockPath) {
  const raw = fs.readFileSync(lockPath, "utf8");
  const parsed = JSON.parse(raw);
  const pid = Number(parsed?.pid);

  return {
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    port: parsed?.port ?? null,
    hostname: parsed?.hostname ?? null,
    appUrl: parsed?.appUrl ?? null,
    startedAt: parsed?.startedAt ?? null,
  };
}

function isProcessActive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    return true;
  }
}

function inspectNextDevLock(options = {}) {
  const cwd = options.cwd || process.cwd();
  const lockPath = options.lockPath || buildLockPath(cwd);
  const pidActive = options.isPidActive || isProcessActive;

  if (!fs.existsSync(lockPath)) {
    return { status: "missing", lockPath, removed: false };
  }

  let metadata;
  try {
    metadata = readLockMetadata(lockPath);
  } catch (error) {
    return {
      status: "unknown",
      lockPath,
      removed: false,
      reason: "unreadable-lock",
      errorName: error instanceof Error ? error.name : typeof error,
    };
  }

  if (!metadata.pid) {
    return {
      status: "unknown",
      lockPath,
      removed: false,
      reason: "missing-pid",
      ...metadata,
    };
  }

  if (pidActive(metadata.pid)) {
    return {
      status: "active",
      lockPath,
      removed: false,
      ...metadata,
    };
  }

  return {
    status: "stale",
    lockPath,
    removed: false,
    reason: "pid-not-running",
    ...metadata,
  };
}

function prepareNextBuildLock(options = {}) {
  const logger = options.logger || console;
  const result = inspectNextDevLock(options);

  if (result.status === "stale") {
    fs.unlinkSync(result.lockPath);
    const removed = { ...result, removed: true };
    logger.warn("[next-build-lock-recovery] removed stale Next dev lock", removed);
    return removed;
  }

  if (result.status === "active") {
    logger.warn("[next-build-lock-recovery] active Next dev lock still exists", result);
  } else if (result.status === "unknown") {
    logger.warn("[next-build-lock-recovery] Next dev lock exists but could not prove stale", result);
  }

  return result;
}

function nextBuildCommand(
  nextBin = require.resolve("next/dist/bin/next"),
  extraArgs = [],
) {
  return [
    process.execPath,
    `--max-old-space-size=${NEXT_BUILD_MAX_OLD_SPACE_SIZE_MB}`,
    nextBin,
    "build",
    ...extraArgs,
  ];
}

function nextBuildEnvironment(env = process.env) {
  const inheritedNodeOptions = String(env.NODE_OPTIONS || "").trim();
  const heapOption = `--max-old-space-size=${NEXT_BUILD_MAX_OLD_SPACE_SIZE_MB}`;

  return {
    ...env,
    // Next starts a separate Node process for build-time type checking. A flag
    // on the parent Node command does not propagate to that child, but
    // NODE_OPTIONS does. Append the reviewed limit so it wins over a smaller
    // inherited heap while preserving unrelated runtime options.
    NODE_OPTIONS: [inheritedNodeOptions, heapOption].filter(Boolean).join(" "),
  };
}

function runNextBuild(options = {}) {
  const cwd = options.cwd || process.cwd();
  prepareNextBuildLock({ ...options, cwd });

  const [nodeBin, ...args] = nextBuildCommand(options.nextBin, options.args || []);
  const result = spawnSync(nodeBin, args, {
    cwd,
    env: nextBuildEnvironment(options.env || process.env),
    stdio: options.stdio || "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

if (require.main === module) {
  process.exitCode = runNextBuild({ args: process.argv.slice(2) });
}

module.exports = {
  buildLockPath,
  inspectNextDevLock,
  nextBuildCommand,
  nextBuildEnvironment,
  prepareNextBuildLock,
  runNextBuild,
};
