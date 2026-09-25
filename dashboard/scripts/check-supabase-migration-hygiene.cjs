#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const ZERO_SHA = /^0+$/;
const MIGRATION_NAME_RE = /^\d{14}_.+\.sql$/;

function die(lines, exitCode = 1) {
  for (const line of lines) {
    console.error(line);
  }
  process.exit(exitCode);
}

function sanitizedGitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_PREFIX;
  return env;
}

function git(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    env: sanitizedGitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--base" || arg === "--head") {
      const value = argv[index + 1];
      if (!value) {
        die([`Missing value for ${arg}.`]);
      }
      parsed[arg.slice(2)] = value;
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: node scripts/check-supabase-migration-hygiene.cjs --base <sha> --head <sha>",
          "",
          "Fails if an existing migration under dashboard/supabase/migrations was modified, deleted, or renamed.",
          "Also validates migration filename format and duplicate timestamp prefixes.",
        ].join("\n"),
      );
      process.exit(0);
    }

    die([`Unknown argument: ${arg}`]);
  }

  return parsed;
}

function resolveRange(repoRoot, parsed) {
  let base = parsed.base || process.env.MIGRATION_BASE_SHA || "";
  const head = parsed.head || process.env.MIGRATION_HEAD_SHA || "HEAD";

  if (!base) {
    die([
      "Missing migration diff base.",
      "Pass --base <sha> --head <sha>, or set MIGRATION_BASE_SHA and MIGRATION_HEAD_SHA.",
    ]);
  }

  if (ZERO_SHA.test(base)) {
    base = EMPTY_TREE_SHA;
  } else {
    git(repoRoot, ["rev-parse", "--verify", base]);
  }

  git(repoRoot, ["rev-parse", "--verify", head]);

  return { base: resolveMergeBase(repoRoot, base, head), head };
}

// Diff from the point where head branched off base (three-dot semantics), so
// commits that landed on base after the branch point are not reported as
// changes in head. The empty tree has no history and is used as-is.
function resolveMergeBase(repoRoot, base, head) {
  if (base === EMPTY_TREE_SHA) {
    return base;
  }

  try {
    return git(repoRoot, ["merge-base", base, head]);
  } catch (error) {
    die([
      `Cannot find a merge base for migration diff ${base}...${head}.`,
      "The histories are unrelated or incomplete; CI must check out with fetch-depth: 0.",
      String(error.stderr || error.message).trim(),
    ]);
  }
}

function validateCurrentMigrations(migrationsDir) {
  const files = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

  const errors = [];
  const timestamps = new Map();

  for (const file of files) {
    if (!MIGRATION_NAME_RE.test(file)) {
      errors.push(
        `Invalid migration filename: ${file}. Expected format YYYYMMDDHHMMSS_description.sql`,
      );
      continue;
    }

    const timestamp = file.slice(0, 14);
    if (timestamps.has(timestamp)) {
      errors.push(
        `Duplicate migration timestamp prefix ${timestamp}: ${timestamps.get(timestamp)} and ${file}`,
      );
      continue;
    }

    timestamps.set(timestamp, file);
  }

  if (errors.length > 0) {
    die(["Supabase migration hygiene check failed:", ...errors]);
  }
}

function parseNameStatus(output) {
  if (!output) {
    return [];
  }

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const dashboardRoot = path.resolve(__dirname, "..");
  const repoRoot = git(dashboardRoot, ["rev-parse", "--show-toplevel"]);
  const migrationsDir = path.join(dashboardRoot, "supabase", "migrations");
  const migrationsPath = path.relative(repoRoot, migrationsDir).replace(/\\/g, "/");

  validateCurrentMigrations(migrationsDir);

  const { base, head } = resolveRange(repoRoot, parsed);
  const diffOutput = git(repoRoot, [
    "diff",
    "--name-status",
    "--find-renames",
    `${base}`,
    `${head}`,
    "--",
    migrationsPath,
  ]);

  const changes = parseNameStatus(diffOutput);
  const violations = [];

  for (const fields of changes) {
    const status = fields[0];
    const kind = status[0];

    if (kind === "A") {
      const addedPath = fields[1];
      const addedName = path.basename(addedPath);
      if (!MIGRATION_NAME_RE.test(addedName)) {
        violations.push(
          `Added migration has invalid filename: ${addedName}. Expected format YYYYMMDDHHMMSS_description.sql`,
        );
      }
      continue;
    }

    if (kind === "R") {
      violations.push(
        `Existing migration was renamed: ${fields[1]} -> ${fields[2]}. Migrations must be append-only.`,
      );
      continue;
    }

    if (kind === "M") {
      violations.push(
        `Existing migration was modified: ${fields[1]}. Create a new migration instead of editing history.`,
      );
      continue;
    }

    if (kind === "D") {
      violations.push(
        `Existing migration was deleted: ${fields[1]}. Migrations must be append-only.`,
      );
      continue;
    }

    violations.push(
      `Unsupported migration change detected (${status}): ${fields.slice(1).join(" -> ")}`,
    );
  }

  if (violations.length > 0) {
    die([
      "Supabase migration hygiene check failed:",
      ...violations,
      "",
      "Allowed change:",
      "  - add a brand-new migration file under dashboard/supabase/migrations",
      "",
      "Disallowed changes:",
      "  - modify, rename, or delete an existing migration",
    ]);
  }

  console.log(
    `Supabase migration hygiene check passed for ${migrationsPath} (${base}...${head}).`,
  );
}

main();
