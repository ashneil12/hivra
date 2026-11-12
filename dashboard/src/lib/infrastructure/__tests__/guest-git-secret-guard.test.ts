/** @jest-environment node */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Claude Code's "Yes, and don't ask again" saves the approved command, passwords
// included, to .claude/settings.local.json. Every new computer ignores that file
// and refuses to commit it.
const installer = readFileSync(path.join(process.cwd(), "provisioner", "provision-claude-code-box.sh"), "utf8");
const guard = installer.slice(installer.indexOf("install_git_secret_guard() {"), installer.indexOf("\ninstall_git_secret_guard\n"));
const hook = guard.slice(guard.indexOf("<<'HOOK'\n") + "<<'HOOK'\n".length, guard.indexOf("\nHOOK\n") + 1);

describe("computer git guard for Claude Code's local approvals", () => {
  let root: string;
  let repo: string;
  let ignore: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "hivra-git-guard-test-"));
    repo = path.join(root, "repo");
    ignore = path.join(root, "ignore");
    // The same line the installer writes to ~/.config/git/ignore.
    writeFileSync(ignore, "**/.claude/settings.local.json\n");
    mkdirSync(path.join(repo, ".claude"), { recursive: true });
    git("init", "-q");
    writeFileSync(path.join(repo, ".git/hooks/pre-commit"), hook);
    chmodSync(path.join(repo, ".git/hooks/pre-commit"), 0o755);
    writeFileSync(path.join(repo, ".claude/settings.local.json"), '{"permissions":{"allow":["Bash(PGPASSWORD=hunter2 psql)"]}}\n');
    writeFileSync(path.join(repo, "app.txt"), "hello\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function git(...args: string[]) {
    return spawnSync("git", ["-c", `core.excludesFile=${ignore}`, "-c", "user.name=t", "-c", "user.email=t@example.invalid",
      "-c", "commit.gpgSign=false", ...args], {
      cwd: repo, encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", NODE_ENV: "test" },
    });
  }

  it("installs the hook through the system template and the ignore line for the agent user", () => {
    expect(guard).toContain('git config --system init.templateDir "$template"');
    expect(guard).toContain("cp -a /usr/share/git-core/templates");
    expect(guard).toContain("pattern='**/.claude/settings.local.json'");
    expect(guard).toContain('ignore="$ignore_dir/ignore"');
    expect(guard).toContain('ignore_dir="${AGENT_HOME}/.config/git"');
    expect(hook.startsWith("#!/bin/sh\n")).toBe(true);
  });

  it("keeps the file out of `git add -A`", () => {
    expect(git("add", "-A").status).toBe(0);
    expect(git("diff", "--cached", "--name-only").stdout).toBe("app.txt\n");
    expect(git("commit", "-qm", "ok").status).toBe(0);
  });

  it("refuses a commit that force-adds the file, at the root or nested", () => {
    mkdirSync(path.join(repo, "sub dir/.claude"), { recursive: true });
    writeFileSync(path.join(repo, "sub dir/.claude/settings.local.json"), "{}\n");
    expect(git("add", "-f", "app.txt", ".claude/settings.local.json", "sub dir/.claude/settings.local.json").status).toBe(0);
    const result = git("commit", "-qm", "leak");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Hivra: commit blocked");
    expect(result.stderr).toContain("  .claude/settings.local.json\n");
    expect(result.stderr).toContain("  sub dir/.claude/settings.local.json\n");
    expect(git("rev-parse", "--verify", "-q", "HEAD").status).not.toBe(0);
  });

  it("refuses changes to an already tracked copy but lets the owner remove it", () => {
    expect(git("add", "-f", ".claude/settings.local.json").status).toBe(0);
    expect(git("commit", "-qm", "old leak", "--no-verify").status).toBe(0);
    writeFileSync(path.join(repo, ".claude/settings.local.json"), '{"permissions":{"allow":["Bash(curl -H token)"]}}\n');
    expect(git("commit", "-qam", "more").status).toBe(1);
    expect(git("rm", "-q", "--cached", ".claude/settings.local.json").status).toBe(0);
    expect(git("commit", "-qm", "remove it").status).toBe(0);
  });

  it("leaves other Claude settings alone", () => {
    writeFileSync(path.join(repo, ".claude/settings.json"), "{}\n");
    expect(git("add", ".claude/settings.json").status).toBe(0);
    expect(git("commit", "-qm", "shared settings").status).toBe(0);
  });
});
