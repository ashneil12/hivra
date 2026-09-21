import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SOURCE_SCRIPT = path.resolve(
  __dirname,
  "../scripts/check-supabase-migration-hygiene.cjs"
);

function getSanitizedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_PREFIX;
  return env;
}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    env: getSanitizedGitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeFile(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function commitAll(repoRoot: string, message: string): string {
  run("git", ["add", "."], repoRoot);
  run("git", ["commit", "-m", message], repoRoot);
  return run("git", ["rev-parse", "HEAD"], repoRoot);
}

function makeTempRepo(): string {
  const repoRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "migration-hygiene-")
  );
  run("git", ["init"], repoRoot);
  run("git", ["config", "user.email", "tests@example.com"], repoRoot);
  run("git", ["config", "user.name", "Migration Tests"], repoRoot);

  const scriptTarget = path.join(
    repoRoot,
    "dashboard/scripts/check-supabase-migration-hygiene.cjs"
  );
  writeFile(scriptTarget, fs.readFileSync(SOURCE_SCRIPT, "utf8"));

  return repoRoot;
}

function runGuard(repoRoot: string, base: string, head: string): string {
  return run(
    process.execPath,
    [
      path.join(repoRoot, "dashboard/scripts/check-supabase-migration-hygiene.cjs"),
      "--base",
      base,
      "--head",
      head,
    ],
    repoRoot
  );
}

describe("check-supabase-migration-hygiene", () => {
  it("allows brand-new migration files", () => {
    const repoRoot = makeTempRepo();
    const migrationsDir = path.join(repoRoot, "dashboard/supabase/migrations");

    writeFile(
      path.join(migrationsDir, "20260401000000_initial_schema.sql"),
      "create table demo(id int);\n"
    );
    const base = commitAll(repoRoot, "base");

    writeFile(
      path.join(migrationsDir, "20260402000000_add_index.sql"),
      "create index demo_id_idx on demo(id);\n"
    );
    const head = commitAll(repoRoot, "head");

    expect(runGuard(repoRoot, base, head)).toContain(
      "Supabase migration hygiene check passed"
    );
  });

  it("fails when an existing migration is modified", () => {
    const repoRoot = makeTempRepo();
    const migrationsDir = path.join(repoRoot, "dashboard/supabase/migrations");
    const migrationPath = path.join(
      migrationsDir,
      "20260401000000_initial_schema.sql"
    );

    writeFile(migrationPath, "create table demo(id int);\n");
    const base = commitAll(repoRoot, "base");

    writeFile(migrationPath, "create table demo(id bigint);\n");
    const head = commitAll(repoRoot, "head");

    expect(() => runGuard(repoRoot, base, head)).toThrow(
      "Existing migration was modified"
    );
  });
});
