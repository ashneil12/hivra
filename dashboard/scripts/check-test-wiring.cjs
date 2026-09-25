#!/usr/bin/env node

/**
 * Every test file in the repository must be run by CI, or be exempted with a
 * reason.
 *
 * A test that nothing runs is worse than no test: it reads as coverage. On
 * 2026-09-25, 21 test files in dashboard/scripts were run by nothing, and one
 * of them (test-prepared-desktop-lab-service.py) had been failing since the
 * day it was published.
 *
 * A test file counts as run when there is evidence that CI executes it:
 *   - jest discovers it (dashboard/jest.config.js roots and testMatch);
 *   - a jest suite names it and starts a child process (a jest wrapper);
 *   - an automatic workflow (push, pull_request, merge_group or schedule)
 *     names it, or names its Python module together with its directory;
 *   - a package.json script names or globs it, and an automatic workflow runs
 *     that script in that package.
 *
 * Being named only by a manual workflow (workflow_dispatch) or a package.json
 * script that no workflow runs does not count: nothing runs it on a change.
 * Such files, and files that genuinely cannot run in CI, go in
 * scripts/test-wiring-exemptions.json with one of these categories:
 *   - vm: needs a disposable machine the test owns end to end (a real VM,
 *     systemd, or a whole Docker stack), beyond the CI fixture jobs.
 *   - live: talks to a live external service or a deployed environment.
 *   - helper: not an entry point; `runBy` names the wired test that imports
 *     or spawns it, and that test must name it.
 *   - needs-artifact: needs a pinned binary, image or generated file that the
 *     repository does not contain.
 *   - not-in-ci: a real suite whose runner has no CI job yet. This is debt;
 *     the reason must say what blocks it.
 * An exemption for a file that is now run, or that no longer exists, is stale
 * and fails the check, so the list cannot rot.
 *
 * Usage: node scripts/check-test-wiring.cjs [--root <repo>] [--exemptions <file>] [--json]
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CATEGORIES = new Set(["vm", "live", "helper", "needs-artifact", "not-in-ci"]);
const MIN_REASON_LENGTH = 20;
const DEFAULT_EXEMPTIONS = "dashboard/scripts/test-wiring-exemptions.json";
const JEST_PACKAGE = "dashboard";
const AUTOMATIC_TRIGGERS = new Set(["push", "pull_request", "pull_request_target", "merge_group", "schedule", "workflow_run"]);
const CHILD_PROCESS_CALL = /\b(?:execFileSync|execFile|execSync|spawnSync|spawn|fork)\s*\(/;
const PATH_TOKEN = /[A-Za-z0-9_.\-/]+/g;
// The guard's own test names real scripts as fixtures and starts processes; it
// runs none of them.
const OWN_TEST = "dashboard/__tests__/check-test-wiring.test.ts";

const TEST_FILE_PATTERNS = [
  /(?:^|\/)test[-_][^/]+\.(?:py|cjs|mjs|js|ts|sh)$/,
  /\.(?:test|spec)\.(?:cjs|mjs|js|jsx|ts|tsx|py)$/,
  /_test\.py$/,
  /\.t\.sol$/,
  /(?:^|\/)Tests\/.+\.swift$/,
];

function isTestFile(file) {
  if (file.split("/").includes("node_modules")) return false;
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(file));
}

function escapeRegex(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

// Minimal glob support for jest testMatch and package.json script globs.
function globToRegex(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        source += "(?:[^/]*/)*";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function jestDiscovery(jestConfig) {
  const roots = (jestConfig.roots ?? ["<rootDir>"]).map((root) => root.replace(/^<rootDir>\/?/, ""));
  const matchers = (jestConfig.testMatch ?? []).map((glob) => globToRegex(glob.startsWith("**/") ? glob : `**/${glob}`));
  const ignored = (jestConfig.testPathIgnorePatterns ?? ["/node_modules/"])
    .map((pattern) => new RegExp(pattern.replace(/<rootDir>/g, "")));
  return (file) => {
    if (!file.startsWith(`${JEST_PACKAGE}/`)) return false;
    const relative = file.slice(JEST_PACKAGE.length + 1);
    if (!roots.some((root) => root === "" || relative.startsWith(`${root}/`))) return false;
    const rooted = `/${relative}`;
    if (ignored.some((pattern) => pattern.test(rooted))) return false;
    return matchers.some((matcher) => matcher.test(relative));
  };
}

function stripYamlComments(text) {
  return text.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
}

// Whole-line // and /* */ comments; a comment that mentions a script does not run it.
function stripScriptComments(text) {
  return text.split("\n").filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join("\n");
}

function workflowTriggers(text) {
  const lines = stripYamlComments(text).split("\n");
  const start = lines.findIndex((line) => /^(?:on|"on"|'on'|true)\s*:/.test(line));
  if (start === -1) return [];
  const inline = lines[start].replace(/^[^:]+:\s*/, "").trim();
  if (inline) return inline.replace(/[[\]{}]/g, " ").split(/[\s,]+/).map((part) => part.replace(/:$/, "")).filter(Boolean);
  const triggers = [];
  let indent = null;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    const match = /^(\s+)([A-Za-z_]+)\s*:/.exec(line);
    if (!/^\s/.test(line)) break;
    if (!match) continue;
    if (indent === null) indent = match[1].length;
    if (match[1].length === indent) triggers.push(match[2]);
  }
  return triggers;
}

function pathTokens(text) {
  const tokens = new Set();
  for (const raw of text.match(PATH_TOKEN) ?? []) {
    const token = raw.replace(/^(?:\.\/)+/, "").replace(/\.+$/, "");
    if (token) tokens.add(token);
  }
  return tokens;
}

/** The shortest trailing path (by segments) that names only this file among all tracked files. */
function uniqueSuffixes(files, trackedFiles) {
  const counts = new Map();
  for (const file of trackedFiles) {
    const parts = file.split("/");
    for (let length = 1; length <= parts.length; length += 1) {
      const suffix = parts.slice(-length).join("/");
      counts.set(suffix, (counts.get(suffix) ?? 0) + 1);
    }
  }
  const suffixes = new Map();
  for (const file of files) {
    const parts = file.split("/");
    for (let length = 1; length <= parts.length; length += 1) {
      const suffix = parts.slice(-length).join("/");
      if (counts.get(suffix) === 1 || length === parts.length) {
        suffixes.set(file, suffix);
        break;
      }
    }
  }
  return suffixes;
}

function tokenNames(token, file, suffix) {
  return token === file || token === suffix || token.endsWith(`/${suffix}`);
}

function packageRunsScript(workflowText, packageDir, scriptName) {
  const invocation = scriptName === "test"
    ? /\bnpm\s+(?:test|t|run\s+test|run-script\s+test)(?![\w:.-])/
    : new RegExp(`\\bnpm\\s+(?:run|run-script)\\s+${escapeRegex(scriptName)}(?![\\w:.-])`);
  if (!invocation.test(workflowText)) return false;
  if (workflowText.includes(packageDir)) return true;
  const base = packageDir.split("/").pop();
  return workflowText.includes("${{ matrix.") && new RegExp(`(?<![\\w.-])${escapeRegex(base)}(?![\\w.-])`).test(workflowText);
}

/**
 * Pure analysis over an in-memory view of the repository.
 * @param {{ trackedFiles: string[], readFile: (file: string) => string, jestConfig: object, exemptions: object[] }} input
 */
function analyzeTestWiring({ trackedFiles, readFile, jestConfig, exemptions }) {
  const tracked = [...new Set(trackedFiles)].sort();
  const trackedSet = new Set(tracked);
  const inventory = tracked.filter(isTestFile);
  const isJestTest = jestDiscovery(jestConfig);
  const jestTests = tracked.filter(isJestTest);
  const suffixes = uniqueSuffixes(inventory, tracked);
  const byBasename = new Map();
  for (const file of inventory) {
    const base = path.posix.basename(file);
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(file);
  }
  const pyStemCounts = new Map();
  for (const file of tracked.filter((candidate) => candidate.endsWith(".py"))) {
    const stem = path.posix.basename(file, ".py");
    pyStemCounts.set(stem, (pyStemCounts.get(stem) ?? 0) + 1);
  }

  const evidence = new Map(inventory.map((file) => [file, []]));
  const weak = new Map(inventory.map((file) => [file, []]));
  const add = (map, file, entry) => {
    if (map.has(file) && !map.get(file).includes(entry)) map.get(file).push(entry);
  };
  const namedIn = (text) => {
    const found = new Set();
    for (const token of pathTokens(text)) {
      for (const file of byBasename.get(path.posix.basename(token)) ?? []) {
        if (tokenNames(token, file, suffixes.get(file))) found.add(file);
      }
    }
    return found;
  };

  for (const file of jestTests) add(evidence, file, "jest");

  for (const suite of jestTests) {
    if (suite === OWN_TEST) continue;
    const text = stripScriptComments(readFile(suite));
    if (!CHILD_PROCESS_CALL.test(text)) continue;
    for (const file of namedIn(text)) if (file !== suite) add(evidence, file, `jest wrapper ${suite}`);
  }

  const workflows = tracked.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file));
  const automaticWorkflows = [];
  for (const workflow of workflows) {
    const text = stripYamlComments(readFile(workflow));
    const automatic = workflowTriggers(text).some((trigger) => AUTOMATIC_TRIGGERS.has(trigger));
    if (automatic) automaticWorkflows.push({ workflow, text });
    const target = automatic ? evidence : weak;
    const label = automatic ? `workflow ${workflow}` : `manual-only workflow ${workflow}`;
    for (const file of namedIn(text)) add(target, file, label);
    const tokens = pathTokens(text);
    for (const file of inventory.filter((candidate) => candidate.endsWith(".py"))) {
      const stem = path.posix.basename(file, ".py");
      if (pyStemCounts.get(stem) === 1 && tokens.has(stem) && text.includes(path.posix.dirname(file))) {
        add(target, file, `${label} (python module)`);
      }
    }
  }

  const packages = tracked.filter((file) => path.posix.basename(file) === "package.json" && !file.split("/").includes("node_modules"));
  for (const manifest of packages) {
    let scripts;
    try {
      scripts = JSON.parse(readFile(manifest)).scripts ?? {};
    } catch {
      continue;
    }
    const packageDir = path.posix.dirname(manifest);
    const prefix = packageDir === "." ? "" : `${packageDir}/`;
    const local = inventory.filter((file) => file.startsWith(prefix));
    for (const [name, command] of Object.entries(scripts)) {
      if (typeof command !== "string") continue;
      const covered = new Set();
      for (const raw of command.split(/\s+/)) {
        const token = raw.replace(/^["']|["']$/g, "").replace(/^\.\//, "");
        if (!token || token.startsWith("-")) continue;
        if (/[*?]/.test(token)) {
          const matcher = globToRegex(token);
          for (const file of local) if (matcher.test(file.slice(prefix.length))) covered.add(file);
        } else if (trackedSet.has(`${prefix}${token}`)) {
          covered.add(`${prefix}${token}`);
        }
      }
      if (covered.size === 0) continue;
      const runner = automaticWorkflows.find(({ text }) => packageRunsScript(text, packageDir, name));
      for (const file of covered) {
        if (runner) add(evidence, file, `${manifest} "${name}" via ${runner.workflow}`);
        else add(weak, file, `${manifest} "${name}" (no workflow runs it)`);
      }
    }
  }

  const problems = [];
  const exempted = new Map();
  const seen = new Set();
  for (const [index, exemption] of exemptions.entries()) {
    const where = `exemption ${index + 1}${exemption && exemption.path ? ` (${exemption.path})` : ""}`;
    if (!exemption || typeof exemption.path !== "string" || exemption.path.length === 0) {
      problems.push({ kind: "invalid", path: where, detail: "has no path" });
      continue;
    }
    if (seen.has(exemption.path)) {
      problems.push({ kind: "invalid", path: exemption.path, detail: "is listed twice" });
      continue;
    }
    seen.add(exemption.path);
    if (!CATEGORIES.has(exemption.category)) {
      problems.push({ kind: "invalid", path: exemption.path, detail: `has unknown category "${exemption.category}" (use ${[...CATEGORIES].join(", ")})` });
      continue;
    }
    if (typeof exemption.reason !== "string" || exemption.reason.trim().length < MIN_REASON_LENGTH) {
      problems.push({ kind: "invalid", path: exemption.path, detail: `needs a reason of at least ${MIN_REASON_LENGTH} characters` });
      continue;
    }
    const directory = exemption.path.endsWith("/");
    const covered = directory ? inventory.filter((file) => file.startsWith(exemption.path)) : inventory.filter((file) => file === exemption.path);
    if (covered.length === 0) {
      problems.push({ kind: "stale", path: exemption.path, detail: "names no tracked test file; remove it" });
      continue;
    }
    const unwired = covered.filter((file) => evidence.get(file).length === 0);
    if (unwired.length === 0) {
      const how = evidence.get(covered[0])[0];
      problems.push({ kind: "stale", path: exemption.path, detail: `is already run (${how}); remove the exemption` });
      continue;
    }
    if (exemption.category === "helper") {
      if (directory) {
        problems.push({ kind: "invalid", path: exemption.path, detail: "a helper exemption must name one file" });
        continue;
      }
      if (typeof exemption.runBy !== "string" || !evidence.has(exemption.runBy)) {
        problems.push({ kind: "invalid", path: exemption.path, detail: "a helper exemption needs runBy naming the tracked test that runs it" });
        continue;
      }
      if (evidence.get(exemption.runBy).length === 0) {
        problems.push({ kind: "invalid", path: exemption.path, detail: `its runBy ${exemption.runBy} is not run by CI either` });
        continue;
      }
      if (!readFile(exemption.runBy).includes(path.posix.basename(exemption.path))) {
        problems.push({ kind: "stale", path: exemption.path, detail: `its runBy ${exemption.runBy} no longer names it` });
        continue;
      }
    }
    for (const file of unwired) exempted.set(file, exemption);
  }

  const orphans = inventory
    .filter((file) => evidence.get(file).length === 0 && !exempted.has(file))
    .map((file) => ({ path: file, weak: weak.get(file) }));

  return {
    inventory,
    run: inventory.filter((file) => evidence.get(file).length > 0).map((file) => ({ path: file, evidence: evidence.get(file) })),
    exempted: [...exempted.entries()].map(([file, exemption]) => ({ path: file, category: exemption.category, exemption: exemption.path })),
    orphans,
    problems,
    ok: orphans.length === 0 && problems.length === 0,
  };
}

function loadRepository(root, exemptionsPath) {
  // Tracked plus new, not-ignored files, as they are on disk, so a local run
  // sees the change being made. In CI the two are the same.
  const trackedFiles = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((file) => file && fs.existsSync(path.join(root, file)));
  const cache = new Map();
  const readFile = (file) => {
    if (!cache.has(file)) {
      try {
        cache.set(file, fs.readFileSync(path.join(root, file), "utf8"));
      } catch {
        cache.set(file, "");
      }
    }
    return cache.get(file);
  };
  const jestConfig = require(path.join(root, JEST_PACKAGE, "jest.config.js"));
  const exemptionsFile = path.resolve(root, exemptionsPath);
  const exemptions = fs.existsSync(exemptionsFile) ? JSON.parse(fs.readFileSync(exemptionsFile, "utf8")).exemptions ?? [] : [];
  return { trackedFiles, readFile, jestConfig, exemptions };
}

function formatReport(result) {
  const lines = [
    `Test wiring: ${result.inventory.length} test files; ${result.run.length} run by CI, ${result.exempted.length} exempted.`,
  ];
  if (result.orphans.length > 0) {
    lines.push("", `${result.orphans.length} test files are run by nothing. Wire each into jest or an automatic workflow,`);
    lines.push(`or exempt it with a category and reason in ${DEFAULT_EXEMPTIONS}:`);
    for (const orphan of result.orphans) {
      lines.push(`  ${orphan.path}${orphan.weak.length ? `  (only named by ${orphan.weak.join("; ")})` : ""}`);
    }
  }
  const stale = result.problems.filter((problem) => problem.kind === "stale");
  if (stale.length > 0) {
    lines.push("", "Stale exemptions:");
    for (const problem of stale) lines.push(`  ${problem.path} ${problem.detail}`);
  }
  const invalid = result.problems.filter((problem) => problem.kind === "invalid");
  if (invalid.length > 0) {
    lines.push("", "Invalid exemptions:");
    for (const problem of invalid) lines.push(`  ${problem.path} ${problem.detail}`);
  }
  if (result.ok) lines.push("PASS test wiring: every test file is run by CI or exempted with a reason.");
  return lines.join("\n");
}

function main(argv) {
  let root = path.resolve(__dirname, "..", "..");
  let exemptionsPath = DEFAULT_EXEMPTIONS;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") root = path.resolve(argv[++index]);
    else if (arg === "--exemptions") exemptionsPath = path.resolve(argv[++index]);
    else if (arg === "--json") json = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      return 2;
    }
  }
  const result = analyzeTestWiring(loadRepository(root, exemptionsPath));
  console.log(json ? JSON.stringify(result, null, 2) : formatReport(result));
  return result.ok ? 0 : 1;
}

module.exports = { analyzeTestWiring, formatReport, globToRegex, isTestFile, jestDiscovery, workflowTriggers, CATEGORIES };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
