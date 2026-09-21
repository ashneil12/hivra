#!/usr/bin/env node

const { execFileSync } = require("child_process");
const path = require("path");

const ZERO_SHA = /^0+$/;
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const HOT_SURFACES = [
  {
    name: "Billing APIs",
    prefixes: ["dashboard/src/app/api/billing/"],
  },
  {
    name: "Conversation APIs",
    prefixes: ["dashboard/src/app/api/conversations/"],
  },
  {
    name: "Chat UI",
    prefixes: ["dashboard/src/components/chat/"],
  },
  {
    name: "Hetzner infrastructure",
    prefixes: ["dashboard/src/lib/hetzner/"],
  },
  {
    name: "Service-layer orchestration",
    prefixes: ["dashboard/src/lib/services/"],
  },
  {
    name: "Gateway probe",
    prefixes: ["dashboard/src/lib/gateway-probe.ts"],
  },
  {
    name: "Dashboard-agent web API bridge",
    prefixes: [
      "dashboard/src/lib/agent-web-api.ts",
      "dashboard/src/lib/hermes-web.ts",
      "dashboard/src/app/api/instances/[id]/skills/",
      "dashboard/src/app/api/instances/[id]/oauth/providers/",
    ],
  },
  {
    name: "Official dashboard handoff",
    prefixes: [
      "dashboard/src/lib/official-dashboard-handoff.ts",
      "dashboard/src/app/api/instances/[id]/official-dashboard/",
    ],
  },
  {
    name: "Interactive terminal bridge",
    prefixes: ["dashboard/src/app/api/instances/[id]/terminal/interactive/"],
  },
  {
    name: "Sidecar management contract",
    prefixes: [
      "dashboard/src/lib/services/sidecar-script.ts",
      "dashboard/src/app/api/instances/[id]/integrations/",
    ],
  },
  {
    name: "Upstream compatibility audit",
    prefixes: [
      "dashboard/src/lib/hermes-upstream-audit.ts",
      "dashboard/scripts/hermes-upstream-audit.cjs",
    ],
  },
  {
    name: "Runtime topology",
    prefixes: ["docker-compose.yml"],
  },
];

const DIFF_PATHS = ["dashboard", "docker-compose.yml"];

const TEST_FILE_RE =
  /^dashboard\/(?:__tests__\/.+|src\/__tests__\/.+|src\/.+\/__tests__\/.+)\.test\.(ts|tsx)$/;

const EXAMPLE_TESTS = [
  "dashboard/__tests__/check-runtime-topology-contract.test.ts",
  "dashboard/src/__tests__/chat-stream.test.ts",
  "dashboard/src/__tests__/cron-sync-service.test.ts",
  "dashboard/src/__tests__/gateway-probe.test.ts",
  "dashboard/src/__tests__/hetzner-instance-service.test.ts",
  "dashboard/src/__tests__/plan-limits.test.ts",
  "dashboard/src/__tests__/profile-service.test.ts",
  "dashboard/src/app/api/billing/subscribe/__tests__/route.test.ts",
  "dashboard/src/app/api/conversations/[conversationId]/__tests__/route.test.ts",
  "dashboard/src/app/api/instances/[id]/integrations/__tests__/route.test.ts",
  "dashboard/src/app/api/instances/[id]/official-dashboard/__tests__/route.test.ts",
  "dashboard/src/app/api/instances/[id]/terminal/interactive/__tests__/route.test.ts",
  "dashboard/src/lib/__tests__/agent-web-api.test.ts",
  "dashboard/src/lib/__tests__/hermes-upstream-audit.test.ts",
  "dashboard/src/lib/__tests__/official-dashboard-handoff.test.ts",
  "dashboard/src/lib/__tests__/sidecar-script.test.ts",
];

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
          "Usage: node scripts/check-risk-surface-coverage.cjs --base <sha> --head <sha>",
          "",
          "Fails when protected dashboard surfaces change without any accompanying test change.",
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
      "Missing regression diff base.",
      "Pass --base <sha> --head <sha>, or set MIGRATION_BASE_SHA and MIGRATION_HEAD_SHA.",
    ]);
  }

  if (ZERO_SHA.test(base)) {
    base = EMPTY_TREE_SHA;
  } else {
    git(repoRoot, ["rev-parse", "--verify", base]);
  }

  git(repoRoot, ["rev-parse", "--verify", head]);

  return { base, head };
}

function parseChangedFiles(output) {
  if (!output) {
    return [];
  }

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function findTriggeredSurface(file) {
  return HOT_SURFACES.find((surface) =>
    surface.prefixes.some((prefix) => file.startsWith(prefix)),
  );
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const dashboardRoot = path.resolve(__dirname, "..");
  const repoRoot = git(dashboardRoot, ["rev-parse", "--show-toplevel"]);
  const { base, head } = resolveRange(repoRoot, parsed);

  const changedFiles = parseChangedFiles(
    git(repoRoot, ["diff", "--name-only", `${base}`, `${head}`, "--", ...DIFF_PATHS]),
  );

  if (changedFiles.length === 0) {
    console.log(`No dashboard changes detected for ${base}..${head}.`);
    return;
  }

  const changedTests = changedFiles.filter((file) => TEST_FILE_RE.test(file));
  const hotSurfaceChanges = [];

  for (const file of changedFiles) {
    if (TEST_FILE_RE.test(file)) {
      continue;
    }

    const triggeredSurface = findTriggeredSurface(file);
    if (!triggeredSurface) {
      continue;
    }

    hotSurfaceChanges.push({
      file,
      surface: triggeredSurface.name,
    });
  }

  if (hotSurfaceChanges.length === 0) {
    console.log(
      `Protected hot-surface coverage check passed for ${base}..${head}: no protected surfaces changed.`,
    );
    return;
  }

  if (changedTests.length > 0) {
    console.log(
      [
        `Protected hot-surface coverage check passed for ${base}..${head}.`,
        "",
        "Protected surfaces changed:",
        ...hotSurfaceChanges.map(
          ({ file, surface }) => `  - ${surface}: ${file}`,
        ),
        "",
        "Changed test files:",
        ...changedTests.map((file) => `  - ${file}`),
      ].join("\n"),
    );
    return;
  }

  die([
    "Protected hot-surface coverage check failed.",
    "",
    "The following protected surfaces changed without any accompanying test update:",
    ...hotSurfaceChanges.map(({ file, surface }) => `  - ${surface}: ${file}`),
    "",
    "Add or update at least one regression test in this change.",
    "Examples from the current suite:",
    ...EXAMPLE_TESTS.map((file) => `  - ${file}`),
    "",
    "Why this guard exists:",
    "  - repeated regressions have been landing in high-risk dashboard paths",
    "  - code changes in these paths must leave behind durable coverage",
  ]);
}

main();
