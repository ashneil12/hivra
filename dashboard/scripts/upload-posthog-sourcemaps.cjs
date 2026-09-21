#!/usr/bin/env node

const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const requiredEnv = ["POSTHOG_CLI_API_KEY", "POSTHOG_CLI_PROJECT_ID"];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);

if (missingEnv.length > 0) {
  console.info(`[posthog-sourcemaps] skipping upload; missing ${missingEnv.join(", ")}`);
  process.exit(0);
}

const chunksDir = join(process.cwd(), ".next", "static", "chunks");

if (!existsSync(chunksDir)) {
  console.info(`[posthog-sourcemaps] skipping upload; ${chunksDir} does not exist`);
  process.exit(0);
}

function readGitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const releaseVersion =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
  readGitSha() ||
  "local-build";

const result = spawnSync(
  "npx",
  [
    "--yes",
    "@posthog/cli@0.7.11",
    "--host",
    process.env.POSTHOG_CLI_HOST || "https://us.posthog.com",
    "sourcemap",
    "process",
    "--directory",
    chunksDir,
    "--release-name",
    "hermes-deploy",
    "--release-version",
    releaseVersion,
    "--delete-after",
  ],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  }
);

if (result.error) {
  console.error("[posthog-sourcemaps] failed to start PostHog CLI", result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
