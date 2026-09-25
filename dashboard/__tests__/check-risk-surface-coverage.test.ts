import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SOURCE_SCRIPT = path.resolve(
  __dirname,
  "../scripts/check-risk-surface-coverage.cjs"
);

function getSanitizedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_PREFIX;
  return env;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
): string {
  return execFileSync(command, args, {
    cwd,
    env: env ?? getSanitizedGitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function makeTempRepo(): { repoRoot: string; dashboardRoot: string; scriptPath: string; sha: string } {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "risk-surface-guard-"));
  const dashboardRoot = path.join(repoRoot, "dashboard");
  const scriptPath = path.join(dashboardRoot, "scripts/check-risk-surface-coverage.cjs");

  run("git", ["init"], repoRoot);
  run("git", ["config", "user.email", "tests@example.com"], repoRoot);
  run("git", ["config", "user.name", "Guard Test"], repoRoot);

  writeFile(scriptPath, fs.readFileSync(SOURCE_SCRIPT, "utf8"));
  writeFile(path.join(dashboardRoot, "package.json"), JSON.stringify({ private: true }, null, 2));
  writeFile(path.join(dashboardRoot, "src/lib/services/example.ts"), "export const example = true;\n");

  run("git", ["add", "."], repoRoot);
  run("git", ["commit", "-m", "test: seed guard repo"], repoRoot);

  return {
    repoRoot,
    dashboardRoot,
    scriptPath,
    sha: run("git", ["rev-parse", "HEAD"], repoRoot),
  };
}

describe("check-risk-surface-coverage", () => {
  it("ignores hook-provided git env vars when resolving the repo root", () => {
    const repo = makeTempRepo();

    const output = run(
      process.execPath,
      [repo.scriptPath, "--base", repo.sha, "--head", repo.sha],
      repo.dashboardRoot,
      {
        ...process.env,
        GIT_DIR: ".git",
        GIT_WORK_TREE: ".",
      }
    );

    expect(output).toContain(`No dashboard changes detected for ${repo.sha}...${repo.sha}.`);
  });

  describe("when the base branch moves after the branch point", () => {
    function commitAll(repoRoot: string, message: string): string {
      run("git", ["add", "."], repoRoot);
      run("git", ["commit", "-m", message], repoRoot);
      return run("git", ["rev-parse", "HEAD"], repoRoot);
    }

    function runGuard(repo: ReturnType<typeof makeTempRepo>, base: string, head: string): string {
      return run(process.execPath, [repo.scriptPath, "--base", base, "--head", head], repo.repoRoot);
    }

    function divergeBase(
      repo: ReturnType<typeof makeTempRepo>,
      baseChange: (dashboardRoot: string) => void,
    ): { base: string; baseBranch: string } {
      const baseBranch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo.repoRoot);
      run("git", ["checkout", "-q", "-b", "feature"], repo.repoRoot);
      run("git", ["checkout", "-q", baseBranch], repo.repoRoot);
      baseChange(repo.dashboardRoot);
      const base = commitAll(repo.repoRoot, "base moves on");
      run("git", ["checkout", "-q", "feature"], repo.repoRoot);
      return { base, baseBranch };
    }

    it("does not credit a test added on base to an untested hot-surface change on the branch", () => {
      const repo = makeTempRepo();
      const { base } = divergeBase(repo, (dashboardRoot) => {
        writeFile(path.join(dashboardRoot, "src/__tests__/base-only.test.ts"), "test.todo('base');\n");
      });

      writeFile(path.join(repo.dashboardRoot, "src/lib/services/example.ts"), "export const example = false;\n");
      const head = commitAll(repo.repoRoot, "untested hot-surface change");

      expect(() => runGuard(repo, base, head)).toThrow("Protected hot-surface coverage check failed.");
    });

    it("does not blame the branch for a hot-surface change that only landed on base", () => {
      const repo = makeTempRepo();
      const { base } = divergeBase(repo, (dashboardRoot) => {
        writeFile(path.join(dashboardRoot, "src/lib/services/example.ts"), "export const example = 1;\n");
      });

      writeFile(path.join(repo.dashboardRoot, "README.md"), "unrelated\n");
      const head = commitAll(repo.repoRoot, "unrelated change");

      expect(runGuard(repo, base, head)).toContain(
        "Protected hot-surface coverage check passed",
      );
    });
  });
});
