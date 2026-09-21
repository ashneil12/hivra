#!/usr/bin/env node

const HIGH_RISK_PATTERNS = [
  /^src\/app\/api\/billing\//,
  /^src\/app\/api\/conversations\//,
  /^src\/components\/chat\//,
  /^src\/lib\/hetzner\//,
  /^src\/lib\/services\//,
  /^src\/lib\/gateway-probe\.ts$/,
  /^src\/lib\/agent-web-api\.ts$/,
  /^src\/lib\/hermes-web\.ts$/,
  /^src\/lib\/official-dashboard-handoff\.ts$/,
  /^src\/app\/api\/instances\/\[id\]\/(?:health|browser-sessions|integrations|official-dashboard|terminal\/interactive|skills|oauth\/providers)\//,
  /^supabase\/migrations\//,
  /^middleware\.ts$/,
  /^next\.config\./,
];

const NORMAL_RISK_PATTERNS = [
  /^src\//,
  /^scripts\//,
  /^__tests__\//,
  /^package(-lock)?\.json$/,
  /^jest\.config\./,
  /^tsconfig\.json$/,
];

const LEVELS = new Set(["tiny", "normal", "high"]);

function printUsage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(
    [
      "Usage: npm run verify:plan -- --risk <tiny|normal|high> [--files <path...>]",
      "",
      "Examples:",
      "  npm run verify:plan -- --risk tiny",
      "  npm run verify:plan -- --risk normal --files src/components/example.tsx",
      "  npm run verify:plan -- --risk high",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function parseArgs(argv) {
  const parsed = { risk: "", files: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      printUsage(0);
    }

    if (arg === "--risk") {
      parsed.risk = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (arg === "--files") {
      parsed.files = argv.slice(index + 1).filter((file) => !file.startsWith("--"));
      break;
    }

    console.error(`Unknown argument: ${arg}`);
    printUsage(1);
  }

  if (!LEVELS.has(parsed.risk)) {
    console.error("Missing or invalid --risk. Expected tiny, normal, or high.");
    printUsage(1);
  }

  return parsed;
}

function normalizeFile(file) {
  return file.replace(/^dashboard\//, "").replace(/^\.\//, "");
}

function classifyFiles(files) {
  const normalized = files.map(normalizeFile);

  if (normalized.some((file) => HIGH_RISK_PATTERNS.some((pattern) => pattern.test(file)))) {
    return "high";
  }

  if (normalized.some((file) => NORMAL_RISK_PATTERNS.some((pattern) => pattern.test(file)))) {
    return "normal";
  }

  return "tiny";
}

function strongerRisk(left, right) {
  const order = ["tiny", "normal", "high"];
  return order[Math.max(order.indexOf(left), order.indexOf(right))];
}

function planForRisk(risk) {
  if (risk === "tiny") {
    return [
      "Run the smallest relevant check for the touched file or behavior.",
      "Examples: focused unit test, script smoke check, lint for the touched area, or docs review.",
      "No post-deploy canary check is expected unless the tiny change affects live behavior.",
    ];
  }

  if (risk === "normal") {
    return [
      "Run the relevant focused tests for the changed behavior.",
      "Run lint/typecheck when source code changed.",
      "Do a basic sanity check for the affected workflow.",
      "If user-facing behavior changed, check canary after the GitHub/Vercel build.",
    ];
  }

  return [
    "Run the relevant focused regression suite, usually npm run test:hot-paths or npm run test:smoke-contracts.",
    "Run npm run verify when practical, or record the specific blocker if full verification cannot run.",
    "Confirm the root cause was fixed, not only masked by retry, fallback UI, or logging.",
    "After the GitHub/Vercel build, perform a canary check for the affected live workflow.",
  ];
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const inferredRisk = parsed.files.length > 0 ? classifyFiles(parsed.files) : parsed.risk;
  const effectiveRisk = strongerRisk(parsed.risk, inferredRisk);

  console.log(`Requested risk: ${parsed.risk}`);

  if (parsed.files.length > 0) {
    console.log(`File-inferred risk: ${inferredRisk}`);
  }

  console.log(`Effective verification level: ${effectiveRisk}`);
  console.log("");
  console.log("Recommended checks:");

  for (const line of planForRisk(effectiveRisk)) {
    console.log(`- ${line}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  classifyFiles,
  planForRisk,
  strongerRisk,
};
