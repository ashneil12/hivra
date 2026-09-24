import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

// Aeon config edits must reach the user's GitHub fork. The complete, unmodified
// guest gateway (provisioner/hivra-chat/server.js) is evaluated against real git
// repositories: bare repos stand in for the upstream template and the user's
// fork (github.com URLs are rewritten to them with git's url.insteadOf), and a
// stub stands in for `gh` (GH_BIN). No network is used. After a sync, the
// exact git sequence the Aeon dashboard runs on every save (upstream
// apps/dashboard/lib/github.ts commitAndPush) must land the edit on the fork.

const TOKEN = "d".repeat(64);
const SERVER_PATH = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, "utf8");
const LOGIN = "octo-user";
const FORK_URL = `https://github.com/${LOGIN}/aeon`;
const UPSTREAM_URL = "https://github.com/aaronjmars/aeon.git";
// Written by provision-claude-code-box.sh so the dashboard serves under /aeon.
const HIVRA_NEXT_CONFIG = `import type { NextConfig } from 'next'
// Hivra hosts this dashboard behind a token-proxy mounted at /aeon.
const basePath = process.env.AEON_BASE_PATH || undefined
const nextConfig: NextConfig = basePath ? { basePath, assetPrefix: basePath } : {}
export default nextConfig
`;
const WORKFLOW_FILES = ["aeon.yml", "scheduler.yml", "messages.yml", "chain-runner.yml", "setup-commands.yml"];

const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_STUB_LOG"
case "$1 $2" in
  "auth status") echo "  Logged in to github.com account ${LOGIN} (keyring)" >&2; exit 0 ;;
  "auth login") cat >/dev/null; exit 0 ;;
  "auth setup-git") git config --global credential.https://github.com.helper "!$0 auth git-credential"; exit 0 ;;
  "api user")
    [ -n "\${GH_STUB_AUTH_FAIL:-}" ] && { echo "HTTP 401: Bad credentials (https://api.github.com/user)" >&2; exit 1; }
    if [ "$3" = "-q" ]; then echo ${LOGIN}; else echo '{"login":"${LOGIN}","id":4242,"type":"User"}'; fi
    exit 0 ;;
  "repo view"|"repo sync"|"repo set-default"|"repo fork") exit 0 ;;
esac
case "$*" in
  "api -X PUT repos/"*"/actions/permissions "*) exit 0 ;;
  "api repos/"*"/actions/secrets/public-key") exit 0 ;;
  "api repos/"*"/actions/workflows?per_page=100") cat "$GH_STUB_WORKFLOWS"; exit 0 ;;
  "api -X PUT repos/"*"/actions/workflows/\${GH_STUB_ENABLE_FAIL:-none}/enable")
    echo "HTTP 403: Resource not accessible by personal access token" >&2; exit 1 ;;
  "api -X PUT repos/"*"/actions/workflows/"*"/enable") exit 0 ;;
esac
echo "gh stub: unexpected: $*" >&2
exit 1
`;

jest.setTimeout(120_000);

type Gateway = { port: number; close: () => Promise<void>; logs: string[]; restarts: string[] };

describe("Aeon fork sync in the Hivra guest gateway", () => {
  let root: string;
  let home: string;
  let clone: string;
  let upstreamGit: string;
  let forkGit: string;
  let ghStub: string;
  let ghLog: string;
  let gitEnv: NodeJS.ProcessEnv;
  let pinned: string;
  const gateways: Gateway[] = [];

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
    return result.stdout.trim();
  }
  function gitOk(cwd: string, ...args: string[]) {
    return spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
  }
  const forkShow = (spec: string) => git(forkGit, "show", spec);
  const forkLog = () => git(forkGit, "log", "--format=%s", "main").split("\n");
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  // A commit made on the fork by GitHub Actions (Aeon's run bots commit memory).
  function botCommitOnFork(file: string, text: string, message: string) {
    const work = fs.mkdtempSync(path.join(root, "bot-"));
    git(root, "clone", "--quiet", forkGit, work);
    write(path.join(work, file), text);
    git(work, "add", "-A");
    git(work, "-c", "user.name=aeonframework", "-c", "user.email=bot@example.invalid", "commit", "--quiet", "-m", message);
    git(work, "push", "--quiet", "origin", "HEAD:main");
  }

  // Exactly what the Aeon dashboard runs after every save (local mode).
  function commitAndPush(paths: string[], message: string): { synced: boolean; reason?: string } {
    const run = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: clone, env: gitEnv, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
      return result.stdout;
    };
    try {
      run("add", "--", ...paths);
      let staged = true;
      try { run("diff", "--cached", "--quiet", "--", ...paths); staged = false; } catch { staged = true; }
      if (!staged) return { synced: true };
      run("commit", "-m", message, "--", ...paths);
      try {
        run("push");
      } catch {
        try {
          run("pull", "--rebase", "--autostash");
          run("push");
        } catch (e) {
          try { run("rebase", "--abort"); } catch { /* not mid-rebase */ }
          return { synced: false, reason: (e as Error).message };
        }
      }
      return { synced: true };
    } catch (e) {
      return { synced: false, reason: (e as Error).message };
    }
  }

  // The template history: C0, then the pinned commit the provisioner checks out.
  function seedUpstream() {
    const seed = path.join(root, "seed");
    fs.mkdirSync(seed);
    git(seed, "init", "--quiet", "-b", "main");
    write(path.join(seed, "aeon.yml"), "skills:\n  digest:\n    enabled: false\n\n\n\n  news:\n    enabled: false\n");
    write(path.join(seed, "STRATEGY.md"), "# Strategy\n");
    write(path.join(seed, "apps/dashboard/next.config.ts"), "import type { NextConfig } from 'next'\n\nconst nextConfig: NextConfig = {}\n\nexport default nextConfig\n");
    write(path.join(seed, "apps/dashboard/next-env.d.ts"), "/// <reference types=\"next\" />\n");
    for (const file of WORKFLOW_FILES) write(path.join(seed, ".github/workflows", file), `name: ${file}\n`);
    git(seed, "add", "-A");
    git(seed, "-c", "user.name=Template", "-c", "user.email=template@example.invalid", "commit", "--quiet", "-m", "template base");
    write(path.join(seed, "CHANGELOG.md"), "pinned template change\n");
    git(seed, "add", "-A");
    git(seed, "-c", "user.name=Template", "-c", "user.email=template@example.invalid", "commit", "--quiet", "-m", "pinned template");
    pinned = git(seed, "rev-parse", "HEAD");
    git(root, "clone", "--quiet", "--bare", seed, upstreamGit);
    return seed;
  }

  // What provision-claude-code-box.sh leaves: a detached depth-1 checkout of
  // the pinned commit, origin = the upstream template, the Hivra basePath
  // config, and Next's rewrite of its tracked next-env.d.ts from the build.
  function provisionClone() {
    fs.mkdirSync(clone);
    git(clone, "init", "--quiet");
    git(clone, "remote", "add", "origin", `file://${upstreamGit}`);
    git(clone, "fetch", "--quiet", "--depth", "1", "origin", pinned);
    git(clone, "checkout", "--quiet", "--detach", "FETCH_HEAD");
    git(clone, "remote", "set-url", "origin", UPSTREAM_URL);
    write(path.join(clone, "apps/dashboard/next.config.ts"), HIVRA_NEXT_CONFIG);
    write(path.join(clone, "apps/dashboard/next-env.d.ts"), "/// <reference types=\"next\" />\n/// <reference path=\"./.next/types/routes.d.ts\" />\n");
  }

  function setWorkflows(states: Record<string, string>) {
    const workflows = Object.entries(states).map(([file, state], index) => ({ id: index + 1, name: file, path: `.github/workflows/${file}`, state }));
    fs.writeFileSync(path.join(root, "workflows.json"), JSON.stringify({ total_count: workflows.length, workflows }));
  }

  function boot(extraEnv: Record<string, string> = {}): Promise<Gateway> {
    let server: http.Server | undefined;
    const sockets = new Set<net.Socket>();
    const logs: string[] = [];
    const restarts: string[] = [];
    const realRequire = createRequire(SERVER_PATH);
    const childProcess = realRequire("child_process");
    vm.runInNewContext(SERVER_SOURCE, {
      require: (name: string) => {
        if (name === "http") {
          return {
            ...http,
            createServer: (handler: http.RequestListener) => {
              server = http.createServer(handler);
              server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
              return server;
            },
          };
        }
        if (name === "child_process") {
          // The dashboard restart helper is root-only; record it instead of running sudo.
          return {
            ...childProcess,
            spawn: (cmd: string, args: string[], options: object) => {
              if (cmd !== "sudo") return childProcess.spawn(cmd, args, options);
              restarts.push(args.join(" ") + " status=" + String(JSON.parse(fs.readFileSync(path.join(home, ".hivra", "aeon-connect.json"), "utf8")).status));
              const fake = new EventEmitter();
              setTimeout(() => fake.emit("close", 0), 0);
              return fake;
            },
          };
        }
        if (["fs", "path", "net", "crypto", "./llm-application.js", "./guarded-files.cjs", "./agent-zero-editor.cjs"].includes(name)) {
          return realRequire(name);
        }
        throw new Error(`Unexpected guest dependency: ${name}`);
      },
      process: {
        env: {
          HOME: home,
          HIVRA_CHAT_PORT: "0",
          GH_BIN: ghStub,
          AEON_DIR: clone,
          GH_STUB_LOG: ghLog,
          GH_STUB_WORKFLOWS: path.join(root, "workflows.json"),
          GIT_CONFIG_NOSYSTEM: "1",
          ...extraEnv,
        },
        once: () => undefined,
      },
      __dirname: path.dirname(SERVER_PATH),
      console: { log: () => undefined, warn: (...a: unknown[]) => logs.push(a.join(" ")), error: (...a: unknown[]) => logs.push(a.join(" ")) },
      Buffer, URL, URLSearchParams, setTimeout, clearTimeout, setImmediate,
    }, { filename: SERVER_PATH });
    if (!server) throw new Error("gateway did not create its HTTP server");
    const created = server;
    return new Promise((resolve) => {
      const ready = () => {
        const gateway: Gateway = {
          port: (created.address() as net.AddressInfo).port,
          logs,
          restarts,
          close: async () => {
            for (const socket of sockets) socket.destroy();
            if (created.listening) await new Promise<void>((done) => created.close(() => done()));
          },
        };
        gateways.push(gateway);
        resolve(gateway);
      };
      if (created.listening) ready(); else created.once("listening", ready);
    });
  }

  function request(gateway: Gateway, method: string, pathname: string, body?: unknown) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1", port: gateway.port, path: pathname, method, agent: false,
        headers: { Authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { text += chunk; });
        res.once("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.once("error", reject);
      req.setTimeout(50_000, () => req.destroy(new Error(`${method} ${pathname} timed out`)));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  const status = () => {
    try { return JSON.parse(fs.readFileSync(path.join(home, ".hivra", "aeon-connect.json"), "utf8")); } catch { return null; }
  };
  // The first settled status written after `since` (a previous status's `at`).
  async function settledStatus(gateway: Gateway, since?: string) {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const current = status();
      if (current && current.status !== "syncing" && current.at !== since) return current;
      if (Date.now() > deadline) throw new Error(`fork sync did not settle: ${JSON.stringify(current)} ${gateway.logs.join("\n")}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const ghCalls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, "utf8").trim().split("\n") : []);

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hivra-aeon-sync-")));
    home = path.join(root, "home");
    clone = path.join(home, "aeon");
    upstreamGit = path.join(root, "upstream.git");
    forkGit = path.join(root, "fork.git");
    ghLog = path.join(root, "gh.log");
    fs.mkdirSync(path.join(home, ".hivra"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, ".hivra", "api-token"), TOKEN);
    fs.writeFileSync(path.join(home, ".hivra", "agent-kind"), "aeon\n");
    ghStub = path.join(root, "gh");
    fs.writeFileSync(ghStub, GH_STUB, { mode: 0o755 });
    // Like a computer whose hostname has no domain: git cannot invent an
    // identity, so a commit needs one to be configured. The fork URL resolves
    // to the local bare repo standing in for the user's GitHub fork.
    fs.writeFileSync(path.join(home, ".gitconfig"), [
      "[user]", "\tuseConfigOnly = true",
      `[url "file://${forkGit}"]`, `\tinsteadOf = ${FORK_URL}`,
      "[init]", "\tdefaultBranch = main",
      "",
    ].join("\n"));
    gitEnv = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } as unknown as NodeJS.ProcessEnv;
    setWorkflows({
      "aeon.yml": "disabled_fork",
      "scheduler.yml": "disabled_fork",
      "messages.yml": "active",
      "chain-runner.yml": "disabled_inactivity",
      "setup-commands.yml": "disabled_manually",
    });
  });

  afterEach(async () => {
    while (gateways.length) await gateways.pop()!.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("connects GitHub so every dashboard save is pushed to the user's fork", async () => {
    seedUpstream();
    git(root, "clone", "--quiet", "--bare", upstreamGit, forkGit);
    botCommitOnFork("memory/log.md", "run 1\n", "chore: aeon memory");
    provisionClone();

    const gateway = await boot();
    const connect = await request(gateway, "POST", "/api/login/complete", { code: "github_pat_fixture" });
    expect(connect.status).toBe(200);
    const reply = JSON.parse(connect.body);
    expect(reply).toMatchObject({ ok: true, repo: `${LOGIN}/aeon`, sync: { status: "ok", repo: `${LOGIN}/aeon`, branch: "main", pushReady: true } });
    // The dashboard restarts only once the clone follows the fork.
    expect(gateway.restarts).toEqual(["-n /usr/local/bin/hivra-aeon-apply restart status=ok"]);

    // A real branch tracking the fork, the account as identity, gh as the
    // credential helper, and the Hivra basePath config still in place.
    expect(git(clone, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(clone, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(forkGit, "rev-parse", "main"));
    expect(git(clone, "config", "user.name")).toBe(LOGIN);
    expect(git(clone, "config", "user.email")).toBe(`4242+${LOGIN}@users.noreply.github.com`);
    expect(ghCalls()).toContain("auth setup-git --hostname github.com");
    expect(fs.readFileSync(path.join(clone, "apps/dashboard/next.config.ts"), "utf8")).toBe(HIVRA_NEXT_CONFIG);
    // Next's build rewrite is set aside, never pushed; nothing else is dirty.
    expect(git(clone, "status", "--porcelain")).toBe("M apps/dashboard/next.config.ts");
    expect(git(clone, "stash", "list")).toContain("hivra: Aeon dashboard build changes");
    expect(forkLog()).toEqual(["chore: aeon memory", "pinned template", "template base"]);

    // Workflows GitHub disabled by itself are enabled; a manual disable stays.
    const enabled = ghCalls().filter((call) => call.endsWith("/enable"));
    expect(enabled).toEqual(["aeon.yml", "scheduler.yml", "chain-runner.yml"]
      .map((file) => `api -X PUT repos/${LOGIN}/aeon/actions/workflows/${file}/enable`));
    expect(reply.sync.workflows).toEqual({
      "aeon.yml": "active", "scheduler.yml": "active", "messages.yml": "active",
      "chain-runner.yml": "active", "setup-commands.yml": "disabled_manually",
    });

    // The truth survives a refresh: /api/login/status reports the sync.
    const login = JSON.parse((await request(gateway, "GET", "/api/login/status")).body);
    expect(login).toMatchObject({ loggedIn: true, email: LOGIN, connect: { status: "ok", repo: `${LOGIN}/aeon`, pushReady: true, workflows: reply.sync.workflows } });
    expect(typeof login.connect.at).toBe("string");

    // A dashboard save now lands on the fork...
    write(path.join(clone, "aeon.yml"), fs.readFileSync(path.join(clone, "aeon.yml"), "utf8").replace("digest:\n    enabled: false", "digest:\n    enabled: true"));
    expect(commitAndPush(["aeon.yml"], "chore: enable digest")).toEqual({ synced: true });
    expect(forkShow("main:aeon.yml")).toContain("digest:\n    enabled: true");
    // ...including after Actions committed to the fork in the meantime (the
    // dashboard's pull --rebase --autostash path, with next.config.ts dirty).
    botCommitOnFork("memory/log.md", "run 1\nrun 2\n", "chore: aeon memory 2");
    write(path.join(clone, "STRATEGY.md"), "# Strategy\nShip daily.\n");
    expect(commitAndPush(["STRATEGY.md"], "chore: update strategy")).toEqual({ synced: true });
    expect(forkLog().slice(0, 3)).toEqual(["chore: update strategy", "chore: aeon memory 2", "chore: enable digest"]);
    expect(fs.readFileSync(path.join(clone, "apps/dashboard/next.config.ts"), "utf8")).toBe(HIVRA_NEXT_CONFIG);
  });

  it("fails the connect with an actionable message when the token cannot push", async () => {
    seedUpstream();
    git(root, "clone", "--quiet", "--bare", upstreamGit, forkGit);
    provisionClone();
    // Reads work; every push is refused (a token without Contents: write).
    fs.appendFileSync(path.join(home, ".gitconfig"), `[url "file://${path.join(root, "push-denied.git")}"]\n\tpushInsteadOf = ${FORK_URL}\n`);

    const gateway = await boot();
    const connect = await request(gateway, "POST", "/api/login/complete", { code: "github_pat_fixture" });
    expect(connect.status).toBe(400);
    const reply = JSON.parse(connect.body);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain(`This computer cannot push to ${LOGIN}/aeon`);
    expect(reply.error).toContain("set Contents and Workflows to Read and write, then reconnect");
    expect(reply.sync).toMatchObject({ status: "push_failed", pushReady: false });
    // The dashboard still restarts against the fork, and a refresh shows the truth.
    expect(gateway.restarts).toEqual(["-n /usr/local/bin/hivra-aeon-apply restart status=push_failed"]);
    const login = JSON.parse((await request(gateway, "GET", "/api/login/status")).body);
    expect(login.connect).toMatchObject({ status: "push_failed", pushReady: false, repo: `${LOGIN}/aeon` });
  });

  it("repairs a computer connected before the sync existed on the next gateway start", async () => {
    seedUpstream();
    git(root, "clone", "--quiet", "--bare", upstreamGit, forkGit);
    botCommitOnFork("memory/log.md", "run 1\n", "chore: aeon memory");
    provisionClone();
    // The old connect only repointed origin at the fork.
    git(clone, "remote", "set-url", "origin", FORK_URL);

    // The bug: a dashboard save never reached GitHub (no identity, detached HEAD).
    write(path.join(clone, "aeon.yml"), fs.readFileSync(path.join(clone, "aeon.yml"), "utf8").replace("news:\n    enabled: false", "news:\n    enabled: true"));
    const before = commitAndPush(["aeon.yml"], "chore: enable news");
    expect(before.synced).toBe(false);
    expect(forkShow("main:aeon.yml")).toContain("news:\n    enabled: false");
    // A new skill the dashboard created and staged in the same failed save,
    // and a private file nothing ever staged.
    write(path.join(clone, "skills/briefing/SKILL.md"), "# Briefing\n");
    expect(commitAndPush(["skills/briefing"], "feat: add briefing skill").synced).toBe(false);
    write(path.join(clone, "notes-with-keys.txt"), "sk-private\n");

    // A runtime update restarts the gateway; the start-up sync repairs the clone.
    const gateway = await boot();
    const settled = await settledStatus(gateway);
    expect(settled).toMatchObject({ status: "ok", repo: `${LOGIN}/aeon`, branch: "main", pushReady: true, parkedBranches: [] });
    // The unsaved edit was carried onto the fork (on top of the bot's commit)
    // without the pinned template commit or any build output.
    expect(forkShow("main:aeon.yml")).toContain("news:\n    enabled: true");
    expect(forkShow("main:skills/briefing/SKILL.md")).toBe("# Briefing");
    expect(forkLog()).toEqual(["chore: save Aeon dashboard edits made on this computer", "chore: aeon memory", "pinned template", "template base"]);
    expect(git(forkGit, "show", "--name-only", "--format=", "main").split("\n")).toEqual(["aeon.yml", "skills/briefing/SKILL.md"]);
    expect(fs.readFileSync(path.join(clone, "notes-with-keys.txt"), "utf8")).toBe("sk-private\n");
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(forkGit, "rev-parse", "main"));

    write(path.join(clone, "STRATEGY.md"), "# Strategy\nShip weekly.\n");
    expect(commitAndPush(["STRATEGY.md"], "chore: update strategy")).toEqual({ synced: true });
    expect(forkShow("main:STRATEGY.md")).toBe("# Strategy\nShip weekly.");

    // Idempotent: another start changes nothing and pushes nothing.
    const forkTip = git(forkGit, "rev-parse", "main");
    const stashes = git(clone, "stash", "list");
    fs.rmSync(path.join(home, ".hivra", "aeon-connect.json"));
    await gateway.close();
    const again = await boot();
    expect(await settledStatus(again)).toMatchObject({ status: "ok", pushReady: true });
    expect(git(forkGit, "rev-parse", "main")).toBe(forkTip);
    expect(git(clone, "stash", "list")).toBe(stashes);
    expect(git(clone, "status", "--porcelain").split("\n")).toEqual([" M apps/dashboard/next.config.ts", "?? notes-with-keys.txt"].map((line) => line.trim()));
  });

  it("carries only this computer's edits onto a fork older than the pinned template", async () => {
    const seed = seedUpstream();
    // The user's long-lived fork branched before the pinned commit and has its own history.
    git(root, "clone", "--quiet", "--bare", seed, forkGit);
    git(forkGit, "update-ref", "refs/heads/main", git(seed, "rev-parse", "HEAD~1"));
    botCommitOnFork("memory/log.md", "old run\n", "chore: aeon memory");
    provisionClone();
    git(clone, "remote", "set-url", "origin", FORK_URL);
    write(path.join(clone, "aeon.yml"), fs.readFileSync(path.join(clone, "aeon.yml"), "utf8").replace("digest:\n    enabled: false", "digest:\n    enabled: true"));
    expect(commitAndPush(["aeon.yml"], "chore: enable digest").synced).toBe(false);
    // An older fork: some Aeon workflows do not exist yet, and one cannot be enabled.
    setWorkflows({ "aeon.yml": "disabled_fork", "messages.yml": "active" });

    const gateway = await boot({ GH_STUB_ENABLE_FAIL: "aeon.yml" });
    const settled = await settledStatus(gateway);
    expect(settled).toMatchObject({ status: "ok", pushReady: true });
    expect(settled.workflows).toEqual({
      "aeon.yml": "enable_failed", "scheduler.yml": "missing", "messages.yml": "active",
      "chain-runner.yml": "missing", "setup-commands.yml": "missing",
    });
    expect(gateway.logs.join("\n")).toContain("aeon workflow aeon.yml could not be enabled on octo-user/aeon: HTTP 403");
    expect(forkLog()).toEqual(["chore: save Aeon dashboard edits made on this computer", "chore: aeon memory", "template base"]);
    expect(forkShow("main:aeon.yml")).toContain("digest:\n    enabled: true");
    // The template change the user never chose was not pushed into their fork.
    expect(gitOk(forkGit, "cat-file", "-e", "main:CHANGELOG.md").status).not.toBe(0);
  });

  it("keeps edits that conflict with the fork on a local branch and follows the fork", async () => {
    seedUpstream();
    git(root, "clone", "--quiet", "--bare", upstreamGit, forkGit);
    botCommitOnFork("STRATEGY.md", "# Strategy\nFrom GitHub.\n", "chore: strategy from github");
    provisionClone();
    git(clone, "remote", "set-url", "origin", FORK_URL);
    write(path.join(clone, "STRATEGY.md"), "# Strategy\nFrom this computer.\n");
    expect(commitAndPush(["STRATEGY.md"], "chore: update strategy").synced).toBe(false);

    const gateway = await boot();
    const settled = await settledStatus(gateway);
    expect(settled).toMatchObject({ status: "ok", pushReady: true });
    expect(settled.parkedBranches).toHaveLength(1);
    const [parked] = settled.parkedBranches;
    expect(parked).toMatch(/^hivra\/unpushed-edits-\d{8}T\d{6}Z$/);
    expect(settled.detail).toContain(parked);
    expect(git(clone, "show", `${parked}:STRATEGY.md`)).toBe("# Strategy\nFrom this computer.");
    expect(forkShow("main:STRATEGY.md")).toBe("# Strategy\nFrom GitHub.");
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(forkGit, "rev-parse", "main"));
    expect(fs.readFileSync(path.join(clone, "apps/dashboard/next.config.ts"), "utf8")).toBe(HIVRA_NEXT_CONFIG);
    // Saving works again; the parked branch stays reported after a restart.
    write(path.join(clone, "aeon.yml"), fs.readFileSync(path.join(clone, "aeon.yml"), "utf8").replace("news:\n    enabled: false", "news:\n    enabled: true"));
    expect(commitAndPush(["aeon.yml"], "chore: enable news")).toEqual({ synced: true });
    await gateway.close();
    const again = await boot();
    expect(await settledStatus(again, settled.at)).toMatchObject({ status: "ok", parkedBranches: [parked] });
  });

  it("never replays one fork's commits into a newly connected fork", async () => {
    seedUpstream();
    git(root, "clone", "--quiet", "--bare", upstreamGit, forkGit);
    provisionClone();
    git(clone, "remote", "set-url", "origin", FORK_URL);
    const first = await boot();
    const firstStatus = await settledStatus(first);
    expect(firstStatus).toMatchObject({ status: "ok", repo: `${LOGIN}/aeon` });
    await first.close();
    // A local commit the first fork never received, then the user connects another account.
    write(path.join(clone, "STRATEGY.md"), "# Strategy\nFirst account.\n");
    git(clone, "commit", "--quiet", "-m", "chore: first account edit", "--", "STRATEGY.md");
    const otherGit = path.join(root, "other.git");
    git(root, "clone", "--quiet", "--bare", upstreamGit, otherGit);
    fs.appendFileSync(path.join(home, ".gitconfig"), `[url "file://${otherGit}"]\n\tinsteadOf = https://github.com/other-user/aeon\n`);
    git(clone, "remote", "set-url", "origin", "https://github.com/other-user/aeon");

    const second = await boot();
    const settled = await settledStatus(second, firstStatus.at);
    expect(settled).toMatchObject({ status: "ok", repo: "other-user/aeon", pushReady: true });
    expect(git(otherGit, "log", "--format=%s", "main").split("\n")).toEqual(["pinned template", "template base"]);
    expect(settled.parkedBranches).toHaveLength(1);
    expect(git(clone, "show", `${settled.parkedBranches[0]}:STRATEGY.md`)).toBe("# Strategy\nFirst account.");
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(otherGit, "rev-parse", "main"));
  });

  it("leaves a branch the owner switched to by hand exactly as it is", async () => {
    seedUpstream();
    git(root, "clone", "--quiet", "--bare", upstreamGit, forkGit);
    provisionClone();
    git(clone, "remote", "set-url", "origin", FORK_URL);
    const first = await boot();
    const firstStatus = await settledStatus(first);
    expect(firstStatus).toMatchObject({ status: "ok" });
    await first.close();
    // In the computer's terminal: an experiment on its own branch, left checked out.
    git(clone, "checkout", "--quiet", "-b", "experiment");
    write(path.join(clone, "STRATEGY.md"), "# Strategy\nExperiment.\n");
    git(clone, "commit", "--quiet", "-m", "experiment", "--", "STRATEGY.md");
    const experiment = git(clone, "rev-parse", "experiment");
    botCommitOnFork("memory/log.md", "run 1\n", "chore: aeon memory");

    const second = await boot();
    const settled = await settledStatus(second, firstStatus.at);
    expect(settled).toMatchObject({ status: "ok", pushReady: true, parkedBranches: [] });
    expect(git(clone, "rev-parse", "experiment")).toBe(experiment);
    expect(git(clone, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(forkGit, "rev-parse", "main"));
    expect(forkLog()[0]).toBe("chore: aeon memory");
  });

  it("reports a broken GitHub sign-in instead of claiming the fork is connected", async () => {
    seedUpstream();
    git(root, "clone", "--quiet", "--bare", upstreamGit, forkGit);
    provisionClone();
    git(clone, "remote", "set-url", "origin", FORK_URL);
    const gateway = await boot({ GH_STUB_AUTH_FAIL: "1" });
    const settled = await settledStatus(gateway);
    expect(settled).toMatchObject({ status: "auth_failed", pushReady: false, repo: `${LOGIN}/aeon` });
    expect(settled.detail).toContain("Bad credentials");
    expect(gitOk(clone, "symbolic-ref", "HEAD").status).not.toBe(0);
    expect(gateway.logs.join("\n")).toContain("aeon fork sync (startup) auth_failed");
  });

  it("leaves a clone that was never connected to GitHub untouched", async () => {
    seedUpstream();
    provisionClone();
    const gateway = await boot();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(status()).toBeNull();
    expect(ghCalls()).toEqual([]);
    const login = JSON.parse((await request(gateway, "GET", "/api/login/status")).body);
    expect(login.connect).toBeNull();
    expect(git(clone, "rev-parse", "HEAD")).toBe(pinned);
  });
});
