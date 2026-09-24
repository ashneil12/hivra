import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
// The gateway-stop case runs the real server.js as its own node process and
// stops it with SIGTERM, the way a runtime update restarts it.

const TOKEN = "d".repeat(64);
const SERVER_PATH = path.join(process.cwd(), "provisioner/hivra-chat/server.js");
const SERVER_SOURCE = fs.readFileSync(SERVER_PATH, "utf8");
const PROVISIONER_SOURCE = fs.readFileSync(path.join(process.cwd(), "provisioner/provision-claude-code-box.sh"), "utf8");
const LOGIN = "octo-user";
const FORK_URL = `https://github.com/${LOGIN}/aeon`;
const UPSTREAM_URL = "https://github.com/aaronjmars/aeon.git";
// Exactly what provision-claude-code-box.sh writes so the dashboard serves under /aeon.
const HIVRA_NEXT_CONFIG = (() => {
  const opener = `cat > "\${AEON_DASH}/next.config.ts" <<'NEXTCFG'\n`;
  const start = PROVISIONER_SOURCE.indexOf(opener);
  const end = PROVISIONER_SOURCE.indexOf("\nNEXTCFG\n", start);
  if (start < 0 || end < 0) throw new Error("the provisioner no longer writes the Aeon next.config.ts heredoc");
  return PROVISIONER_SOURCE.slice(start + opener.length, end) + "\n";
})();
const TEMPLATE_NEXT_CONFIG = "import type { NextConfig } from 'next'\n\nconst nextConfig: NextConfig = {}\n\nexport default nextConfig\n";
// The gateway's retry schedule for syncs GitHub could not be reached for.
const RETRY_DELAYS: number[] = (() => {
  const m = SERVER_SOURCE.match(/const AEON_SYNC_RETRY_DELAYS_MS = (\[[^\]]*\]);/);
  return m ? JSON.parse(m[1]) : [];
})();
const WORKFLOW_FILES = ["aeon.yml", "scheduler.yml", "messages.yml", "chain-runner.yml", "setup-commands.yml"];

const GH_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_STUB_LOG"
case "$1 $2" in
  "auth status") echo "  Logged in to github.com account ${LOGIN} (keyring)" >&2; exit 0 ;;
  "auth login") cat >/dev/null; exit 0 ;;
  "auth setup-git")
    [ -n "\${GH_STUB_SETUP_GIT_FAIL:-}" ] && { echo "failed to set up git credential helper: could not lock config file" >&2; exit 1; }
    git config --global credential.https://github.com.helper "!$0 auth git-credential"; exit 0 ;;
  "api user")
    [ -n "\${GH_STUB_AUTH_FAIL:-}" ] && { echo "HTTP 401: Bad credentials (https://api.github.com/user)" >&2; exit 1; }
    if [ -n "\${GH_STUB_OFFLINE_CALLS:-}" ]; then
      n="$(cat "$GH_STUB_OFFLINE_COUNT" 2>/dev/null || echo 0)"
      if [ "$n" -lt "$GH_STUB_OFFLINE_CALLS" ]; then
        echo $((n + 1)) > "$GH_STUB_OFFLINE_COUNT"
        printf 'error connecting to api.github.com\\ncheck your internet connection or https://githubstatus.com\\n' >&2
        exit 1
      fi
    fi
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

// Loaded into the real gateway process (node --require) for the stop test: when
// the gateway runs the named git command, it records the basePath config on
// disk at that moment and stops itself with SIGTERM before the command runs.
const STOP_PRELOAD = `const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const realExecFile = childProcess.execFile;
childProcess.execFile = function execFile(cmd, args, ...rest) {
  const stopAt = process.env.HIVRA_TEST_STOP_AT;
  if (stopAt && cmd === "git" && Array.isArray(args) && args.join(" ") === stopAt) {
    fs.writeFileSync(process.env.HIVRA_TEST_STOP_MARK, fs.readFileSync(path.join(process.env.AEON_DIR, "apps/dashboard/next.config.ts"), "utf8"));
    process.kill(process.pid, "SIGTERM");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  }
  return realExecFile.call(this, cmd, args, ...rest);
};
`;

jest.setTimeout(180_000);

type Gateway = { port: number; close: () => Promise<void>; logs: string[]; restarts: string[]; retryWaits: number[] };
type BootOptions = { onGit?: (args: string[]) => void };

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
  const processes: ChildProcess[] = [];
  const servers: http.Server[] = [];

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
    return result.stdout.trim();
  }
  function gitOk(cwd: string, ...args: string[]) {
    return spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
  }
  // `git status --porcelain` lines, sorted, with their leading status columns intact.
  const porcelain = () => gitOk(clone, "status", "--porcelain").stdout.split("\n").filter(Boolean).sort();
  const forkShow = (spec: string) => git(forkGit, "show", spec);
  const forkLog = () => git(forkGit, "log", "--format=%s", "main").split("\n");
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const readClone = (file: string) => fs.readFileSync(path.join(clone, file), "utf8");
  const nextConfigBackup = () => path.join(home, ".hivra", "aeon-next.config.ts");

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
    write(path.join(seed, "soul/SOUL.md"), "# Soul\n");
    write(path.join(seed, ".mcp.json"), "{\n  \"mcpServers\": {}\n}\n");
    write(path.join(seed, "scripts/notify.sh"), "#!/usr/bin/env bash\necho notify\n");
    write(path.join(seed, "apps/dashboard/next.config.ts"), TEMPLATE_NEXT_CONFIG);
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

  // The user's fork of the template, and a computer the old connect pointed at it.
  function connectedComputer() {
    seedUpstream();
    git(root, "clone", "--quiet", "--bare", upstreamGit, forkGit);
    provisionClone();
    git(clone, "remote", "set-url", "origin", FORK_URL);
  }

  function setWorkflows(states: Record<string, string>) {
    const workflows = Object.entries(states).map(([file, state], index) => ({ id: index + 1, name: file, path: `.github/workflows/${file}`, state }));
    fs.writeFileSync(path.join(root, "workflows.json"), JSON.stringify({ total_count: workflows.length, workflows }));
  }

  function gatewayEnv(extraEnv: Record<string, string> = {}): Record<string, string> {
    return {
      HOME: home,
      HIVRA_CHAT_PORT: "0",
      GH_BIN: ghStub,
      AEON_DIR: clone,
      GH_STUB_LOG: ghLog,
      GH_STUB_WORKFLOWS: path.join(root, "workflows.json"),
      GH_STUB_OFFLINE_COUNT: path.join(root, "offline-count"),
      GIT_CONFIG_NOSYSTEM: "1",
      ...extraEnv,
    };
  }

  function boot(extraEnv: Record<string, string> = {}, options: BootOptions = {}): Promise<Gateway> {
    let server: http.Server | undefined;
    const sockets = new Set<net.Socket>();
    const logs: string[] = [];
    const restarts: string[] = [];
    const retryWaits: number[] = [];
    const timers = new Set<NodeJS.Timeout>();
    let closed = false;
    // The retry waits (minutes) run in milliseconds here; every other timer is
    // real. A closed gateway schedules no more retries.
    const guestSetTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      const retry = typeof ms === "number" && RETRY_DELAYS.includes(ms);
      if (retry && closed) return setTimeout(() => undefined, 0);
      if (retry) retryWaits.push(ms as number);
      const timer = setTimeout((...a: unknown[]) => { timers.delete(timer); fn(...a); }, retry ? 25 : ms, ...rest);
      timers.add(timer);
      return timer;
    };
    const guestClearTimeout = (timer: NodeJS.Timeout) => { timers.delete(timer); clearTimeout(timer); };
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
          return {
            ...childProcess,
            // The dashboard restart helper is root-only; record it instead of running sudo.
            spawn: (cmd: string, args: string[], spawnOptions: object) => {
              if (cmd !== "sudo") return childProcess.spawn(cmd, args, spawnOptions);
              restarts.push(args.join(" ") + " status=" + String(JSON.parse(fs.readFileSync(path.join(home, ".hivra", "aeon-connect.json"), "utf8")).status));
              const fake = new EventEmitter();
              setTimeout(() => fake.emit("close", 0), 0);
              return fake;
            },
            execFile: (cmd: string, args: string[], ...rest: unknown[]) => {
              if (cmd === "git" && options.onGit) options.onGit(args);
              return childProcess.execFile(cmd, args, ...rest);
            },
          };
        }
        if (["fs", "path", "net", "crypto", "./llm-application.js", "./guarded-files.cjs", "./agent-zero-editor.cjs"].includes(name)) {
          return realRequire(name);
        }
        throw new Error(`Unexpected guest dependency: ${name}`);
      },
      process: { env: gatewayEnv(extraEnv), once: () => undefined },
      __dirname: path.dirname(SERVER_PATH),
      console: { log: () => undefined, warn: (...a: unknown[]) => logs.push(a.join(" ")), error: (...a: unknown[]) => logs.push(a.join(" ")) },
      Buffer, URL, URLSearchParams, setTimeout: guestSetTimeout, clearTimeout: guestClearTimeout, setImmediate,
    }, { filename: SERVER_PATH });
    if (!server) throw new Error("gateway did not create its HTTP server");
    const created = server;
    return new Promise((resolve) => {
      const ready = () => {
        const gateway: Gateway = {
          port: (created.address() as net.AddressInfo).port,
          logs,
          restarts,
          retryWaits,
          close: async () => {
            closed = true;
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
            // A sync already running finishes before the test's files go away.
            const deadline = Date.now() + 60_000;
            while (status()?.status === "syncing" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
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

  // The real guest gateway as its own node process (as systemd runs it).
  function startRealGateway(extraEnv: Record<string, string> = {}) {
    const preload = path.join(root, "stop-preload.cjs");
    fs.writeFileSync(preload, STOP_PRELOAD);
    const child = spawn(process.execPath, ["--require", preload, SERVER_PATH], {
      env: gatewayEnv({ HIVRA_TEST_STOP_MARK: path.join(root, "stop-mark"), ...extraEnv }) as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    processes.push(child);
    const output: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(String(chunk)));
    child.stderr.on("data", (chunk: Buffer) => output.push(String(chunk)));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    return { child, output, exited };
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
      req.setTimeout(90_000, () => req.destroy(new Error(`${method} ${pathname} timed out`)));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  const status = () => {
    try { return JSON.parse(fs.readFileSync(path.join(home, ".hivra", "aeon-connect.json"), "utf8")); } catch { return null; }
  };
  // The first status written after `since` (a previous status's `at`) that matches `done`.
  async function waitForStatus(logs: () => string, done: (current: Record<string, unknown>) => boolean, since?: string) {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const current = status();
      if (current && current.at !== since && done(current)) return current;
      if (Date.now() > deadline) throw new Error(`fork sync did not settle: ${JSON.stringify(current)} ${logs()}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const settledStatus = (gateway: Gateway, since?: string) =>
    waitForStatus(() => gateway.logs.join("\n"), (current) => current.status !== "syncing", since);
  const ghCalls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, "utf8").trim().split("\n") : []);

  // A stand-in for GitHub refusing this token's push (HTTP 403 on git-receive-pack).
  async function pushRefusingServer() {
    const server = http.createServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end(`Permission to ${LOGIN}/aeon.git denied to ${LOGIN}.\n`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/${LOGIN}/aeon`;
  }

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
    for (const child of processes.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGKILL");
        await exited;
      }
    }
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
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
    expect(reply.sync.retryAt).toBeUndefined();
    // The dashboard restarts only once the clone follows the fork.
    expect(gateway.restarts).toEqual(["-n /usr/local/bin/hivra-aeon-apply restart status=ok"]);

    // A real branch tracking the fork, the account as identity, gh as the
    // credential helper, and the Hivra basePath config still in place (and
    // durably copied for any later sync that is stopped part-way).
    expect(git(clone, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(clone, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(forkGit, "rev-parse", "main"));
    expect(git(clone, "config", "user.name")).toBe(LOGIN);
    expect(git(clone, "config", "user.email")).toBe(`4242+${LOGIN}@users.noreply.github.com`);
    expect(ghCalls()).toContain("auth setup-git --hostname github.com");
    expect(readClone("apps/dashboard/next.config.ts")).toBe(HIVRA_NEXT_CONFIG);
    expect(fs.readFileSync(nextConfigBackup(), "utf8")).toBe(HIVRA_NEXT_CONFIG);
    // The basePath config and Next's build rewrite stay local edits: never
    // pushed, never set aside, nothing else dirty.
    expect(porcelain()).toEqual([" M apps/dashboard/next-env.d.ts", " M apps/dashboard/next.config.ts"]);
    expect(git(clone, "stash", "list")).toBe("");
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
    write(path.join(clone, "aeon.yml"), readClone("aeon.yml").replace("digest:\n    enabled: false", "digest:\n    enabled: true"));
    expect(commitAndPush(["aeon.yml"], "chore: enable digest")).toEqual({ synced: true });
    expect(forkShow("main:aeon.yml")).toContain("digest:\n    enabled: true");
    // ...including after Actions committed to the fork in the meantime (the
    // dashboard's pull --rebase --autostash path, with next.config.ts dirty).
    botCommitOnFork("memory/log.md", "run 1\nrun 2\n", "chore: aeon memory 2");
    write(path.join(clone, "STRATEGY.md"), "# Strategy\nShip daily.\n");
    expect(commitAndPush(["STRATEGY.md"], "chore: update strategy")).toEqual({ synced: true });
    expect(forkLog().slice(0, 3)).toEqual(["chore: update strategy", "chore: aeon memory 2", "chore: enable digest"]);
    expect(readClone("apps/dashboard/next.config.ts")).toBe(HIVRA_NEXT_CONFIG);
  });

  it("fails the connect with the token-permissions message when GitHub refuses the push", async () => {
    seedUpstream();
    git(root, "clone", "--quiet", "--bare", upstreamGit, forkGit);
    provisionClone();
    // Reads work; GitHub answers every push with 403 (a token without Contents: write).
    fs.appendFileSync(path.join(home, ".gitconfig"), `[url "${await pushRefusingServer()}"]\n\tpushInsteadOf = ${FORK_URL}\n`);

    const gateway = await boot();
    const connect = await request(gateway, "POST", "/api/login/complete", { code: "github_pat_fixture" });
    expect(connect.status).toBe(400);
    const reply = JSON.parse(connect.body);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain(`GitHub refused this computer's push to ${LOGIN}/aeon`);
    expect(reply.error).toContain("403");
    expect(reply.error).toContain("set Contents and Workflows to Read and write, then reconnect");
    expect(reply.sync).toMatchObject({ status: "push_denied", pushReady: false });
    expect(reply.sync.retryAt).toBeUndefined();
    // The dashboard still restarts against the fork, and a refresh shows the truth.
    expect(gateway.restarts).toEqual(["-n /usr/local/bin/hivra-aeon-apply restart status=push_denied"]);
    const login = JSON.parse((await request(gateway, "GET", "/api/login/status")).body);
    expect(login.connect).toMatchObject({ status: "push_denied", pushReady: false, repo: `${LOGIN}/aeon` });
  });

  it("does not blame the token when the push fails because GitHub cannot be reached", async () => {
    seedUpstream();
    git(root, "clone", "--quiet", "--bare", upstreamGit, forkGit);
    provisionClone();
    // Reads work; pushes cannot connect at all (nothing listens on port 1).
    fs.appendFileSync(path.join(home, ".gitconfig"), `[url "http://127.0.0.1:1/${LOGIN}/aeon"]\n\tpushInsteadOf = ${FORK_URL}\n`);

    const gateway = await boot();
    const connect = await request(gateway, "POST", "/api/login/complete", { code: "github_pat_fixture" });
    expect(connect.status).toBe(200);
    const reply = JSON.parse(connect.body);
    expect(reply).toMatchObject({ ok: true, repo: `${LOGIN}/aeon`, sync: { status: "unreachable", pushReady: false, attempt: 1 } });
    expect(reply.sync.detail).toContain(`Could not reach GitHub to push to ${LOGIN}/aeon`);
    expect(JSON.stringify(reply)).not.toContain("Read and write");
    expect(typeof reply.sync.retryAt).toBe("string");
    // The computer tries again on its own.
    const retried = await waitForStatus(() => gateway.logs.join("\n"), (current) => current.attempt === 2 && current.status !== "syncing");
    expect(retried).toMatchObject({ status: "unreachable", pushReady: false });
    expect(gateway.retryWaits.slice(0, 1)).toEqual(RETRY_DELAYS.slice(0, 1));
  });

  it("reports a credential-helper failure as its own status, not as token permissions", async () => {
    seedUpstream();
    git(root, "clone", "--quiet", "--bare", upstreamGit, forkGit);
    provisionClone();

    const gateway = await boot({ GH_STUB_SETUP_GIT_FAIL: "1" });
    const connect = await request(gateway, "POST", "/api/login/complete", { code: "github_pat_fixture" });
    expect(connect.status).toBe(400);
    const reply = JSON.parse(connect.body);
    expect(reply.sync).toMatchObject({ status: "credentials_failed", pushReady: false });
    expect(reply.error).toContain("could not be given the GitHub sign-in");
    expect(reply.error).toContain("could not lock config file");
    expect(reply.error).toContain("Connect GitHub again to retry.");
    expect(reply.error).not.toContain("Read and write");
    // Nothing on the computer moved.
    expect(gitOk(clone, "symbolic-ref", "HEAD").status).not.toBe(0);
    expect(git(clone, "rev-parse", "HEAD")).toBe(pinned);
  });

  it("retries a push the fork rejected because it moved, instead of failing the connect", async () => {
    seedUpstream();
    git(root, "clone", "--quiet", "--bare", upstreamGit, forkGit);
    provisionClone();
    // A dashboard save made before GitHub was connected.
    write(path.join(clone, "aeon.yml"), readClone("aeon.yml").replace("news:\n    enabled: false", "news:\n    enabled: true"));
    expect(commitAndPush(["aeon.yml"], "chore: enable news").synced).toBe(false);

    // An Actions run commits to the fork between the sync's fetch and its push.
    let raced = false;
    const gateway = await boot({}, {
      onGit: (args) => {
        if (!raced && args.join(" ") === "push --quiet") {
          raced = true;
          botCommitOnFork("memory/log.md", "run 1\n", "chore: aeon memory");
        }
      },
    });
    const connect = await request(gateway, "POST", "/api/login/complete", { code: "github_pat_fixture" });
    expect(raced).toBe(true);
    expect(connect.status).toBe(200);
    expect(JSON.parse(connect.body)).toMatchObject({ ok: true, sync: { status: "ok", pushReady: true } });
    expect(forkLog()).toEqual(["chore: save Aeon dashboard edits made on this computer", "chore: aeon memory", "pinned template", "template base"]);
    expect(forkShow("main:aeon.yml")).toContain("news:\n    enabled: true");
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(forkGit, "rev-parse", "main"));
  });

  it("repairs a computer connected before the sync existed on the next gateway start", async () => {
    connectedComputer();
    botCommitOnFork("memory/log.md", "run 1\n", "chore: aeon memory");

    // The bug: a dashboard save never reached GitHub (no identity, detached HEAD).
    write(path.join(clone, "aeon.yml"), readClone("aeon.yml").replace("news:\n    enabled: false", "news:\n    enabled: true"));
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
    expect(readClone("notes-with-keys.txt")).toBe("sk-private\n");
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(forkGit, "rev-parse", "main"));

    write(path.join(clone, "STRATEGY.md"), "# Strategy\nShip weekly.\n");
    expect(commitAndPush(["STRATEGY.md"], "chore: update strategy")).toEqual({ synced: true });
    expect(forkShow("main:STRATEGY.md")).toBe("# Strategy\nShip weekly.");

    // Idempotent: another start changes nothing and pushes nothing.
    const forkTip = git(forkGit, "rev-parse", "main");
    fs.rmSync(path.join(home, ".hivra", "aeon-connect.json"));
    await gateway.close();
    const again = await boot();
    expect(await settledStatus(again)).toMatchObject({ status: "ok", pushReady: true });
    expect(git(forkGit, "rev-parse", "main")).toBe(forkTip);
    expect(git(clone, "stash", "list")).toBe("");
    expect(porcelain()).toEqual([" M apps/dashboard/next-env.d.ts", " M apps/dashboard/next.config.ts", "?? notes-with-keys.txt"]);
  });

  it("pushes only the dashboard's saves and leaves every other edit on the computer", async () => {
    connectedComputer();
    // Dashboard saves whose commit failed, so the dashboard left them staged:
    // an MCP server and the workflow secret allowlist that save also writes.
    write(path.join(clone, ".mcp.json"), "{\n  \"mcpServers\": { \"search\": { \"command\": \"search-mcp\" } }\n}\n");
    expect(commitAndPush([".mcp.json"], "chore: update .mcp.json from dashboard").synced).toBe(false);
    write(path.join(clone, ".github/workflows/aeon.yml"), "name: aeon.yml\n# ALL_SECRETS allowlist: SEARCH_KEY\n");
    expect(commitAndPush([".github/workflows/aeon.yml"], "chore: allowlist MCP secret(s) SEARCH_KEY in aeon.yml").synced).toBe(false);
    // An unstaged edit to a file the dashboard saves.
    write(path.join(clone, "soul/SOUL.md"), "# Soul\nCurious and direct.\n");
    // Terminal edits nothing ever staged: a workflow, and a script holding a secret.
    write(path.join(clone, ".github/workflows/scheduler.yml"), "name: scheduler.yml\non: push\n");
    write(path.join(clone, "scripts/notify.sh"), "#!/usr/bin/env bash\nNOTIFY_TOKEN=local-only-placeholder\n");

    const gateway = await boot();
    const settled = await settledStatus(gateway);
    expect(settled).toMatchObject({ status: "ok", pushReady: true });
    expect(git(forkGit, "show", "--name-only", "--format=", "main").split("\n").sort())
      .toEqual([".github/workflows/aeon.yml", ".mcp.json", "soul/SOUL.md"]);
    expect(forkShow("main:soul/SOUL.md")).toBe("# Soul\nCurious and direct.");
    // Nothing else reached the public fork...
    expect(forkShow("main:.github/workflows/scheduler.yml")).toBe("name: scheduler.yml");
    expect(forkShow("main:scripts/notify.sh")).not.toContain("local-only-placeholder");
    // ...and those edits are still on the computer, uncommitted.
    expect(porcelain()).toEqual([
      " M .github/workflows/scheduler.yml",
      " M apps/dashboard/next-env.d.ts",
      " M apps/dashboard/next.config.ts",
      " M scripts/notify.sh",
    ]);
    expect(readClone("scripts/notify.sh")).toContain("local-only-placeholder");
  });

  it("keeps a dashboard save that lands in the middle of a sync", async () => {
    connectedComputer();
    const first = await boot();
    const firstStatus = await settledStatus(first);
    expect(firstStatus).toMatchObject({ status: "ok" });
    await first.close();
    botCommitOnFork("memory/log.md", "run 1\n", "chore: aeon memory");

    // The dashboard writes a save just as the sync starts moving the clone.
    let landed = false;
    const second = await boot({}, {
      onGit: (args) => {
        if (!landed && args[0] === "rebase") {
          landed = true;
          write(path.join(clone, "aeon.yml"), readClone("aeon.yml").replace("digest:\n    enabled: false", "digest:\n    enabled: true"));
        }
      },
    });
    const settled = await settledStatus(second, firstStatus.at);
    expect(landed).toBe(true);
    expect(settled).toMatchObject({ status: "ok", pushReady: true, parkedBranches: [] });
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(forkGit, "rev-parse", "main"));
    // The save is still on disk (never reset away), so the dashboard's own push delivers it.
    expect(readClone("aeon.yml")).toContain("digest:\n    enabled: true");
    expect(commitAndPush(["aeon.yml"], "chore: enable digest")).toEqual({ synced: true });
    expect(forkShow("main:aeon.yml")).toContain("digest:\n    enabled: true");
  });

  it("never forces the clone over a file git does not track", async () => {
    connectedComputer();
    const first = await boot();
    const firstStatus = await settledStatus(first);
    expect(firstStatus).toMatchObject({ status: "ok" });
    await first.close();
    const before = git(clone, "rev-parse", "HEAD");
    // The fork gains a file the owner also created on the computer (never added to git).
    botCommitOnFork("memory/log.md", "run 1\n", "chore: aeon memory");
    write(path.join(clone, "memory/log.md"), "my own notes\n");

    const second = await boot();
    const settled = await settledStatus(second, firstStatus.at);
    expect(settled).toMatchObject({ status: "error", pushReady: false });
    expect(settled.detail).toContain("memory/log.md");
    expect(readClone("memory/log.md")).toBe("my own notes\n");
    expect(git(clone, "rev-parse", "HEAD")).toBe(before);
    expect(git(clone, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(readClone("apps/dashboard/next.config.ts")).toBe(HIVRA_NEXT_CONFIG);
  });

  it("keeps local edits the fork also changed in the stash list, with no conflict markers left behind", async () => {
    connectedComputer();
    const first = await boot();
    const firstStatus = await settledStatus(first);
    expect(firstStatus).toMatchObject({ status: "ok" });
    await first.close();
    // A terminal edit on the computer, while upstream Aeon (via the fork)
    // changes the same script and ships its own next.config.ts.
    write(path.join(clone, "scripts/notify.sh"), "#!/usr/bin/env bash\necho notify from this computer\n");
    const work = fs.mkdtempSync(path.join(root, "bot-"));
    git(root, "clone", "--quiet", forkGit, work);
    write(path.join(work, "scripts/notify.sh"), "#!/usr/bin/env bash\necho notify v2\n");
    write(path.join(work, "apps/dashboard/next.config.ts"), "import type { NextConfig } from 'next'\n\nconst nextConfig: NextConfig = { reactStrictMode: true }\n\nexport default nextConfig\n");
    git(work, "add", "-A");
    git(work, "-c", "user.name=aeonframework", "-c", "user.email=bot@example.invalid", "commit", "--quiet", "-m", "chore: sync upstream");
    git(work, "push", "--quiet", "origin", "HEAD:main");

    const second = await boot();
    const settled = await settledStatus(second, firstStatus.at);
    expect(settled).toMatchObject({ status: "ok", pushReady: true, parkedBranches: [] });
    expect(settled.detail).toContain("kept in the git stash");
    expect(settled.detail).toContain("scripts/notify.sh");
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(forkGit, "rev-parse", "main"));
    // The fork's script, no conflict markers, nothing staged or unmerged...
    expect(readClone("scripts/notify.sh")).toBe("#!/usr/bin/env bash\necho notify v2\n");
    expect(porcelain().filter((line) => !line.startsWith(" "))).toEqual([]);
    // ...the local edit recoverable from the stash list...
    expect(git(clone, "stash", "list")).toContain("autostash");
    expect(git(clone, "stash", "show", "-p", "stash@{0}")).toContain("+echo notify from this computer");
    // ...and the dashboard's basePath config back in place.
    expect(readClone("apps/dashboard/next.config.ts")).toBe(HIVRA_NEXT_CONFIG);
  });

  it("puts the /aeon basePath config back after the gateway is stopped in the middle of a sync", async () => {
    connectedComputer();
    botCommitOnFork("STRATEGY.md", "# Strategy\nFrom GitHub.\n", "chore: strategy from github");
    // A dashboard save that conflicts with the fork, so the sync has to roll its replay back.
    write(path.join(clone, "STRATEGY.md"), "# Strategy\nFrom this computer.\n");
    expect(commitAndPush(["STRATEGY.md"], "chore: update strategy").synced).toBe(false);

    // A runtime update restarts the gateway (SIGTERM) just as the sync rolls
    // that replay back, while the working tree holds the template's config.
    const stopped = startRealGateway({ HIVRA_TEST_STOP_AT: "rebase --abort" });
    expect(await stopped.exited).toEqual({ code: null, signal: "SIGTERM" });
    const atStop = fs.readFileSync(path.join(root, "stop-mark"), "utf8");
    expect(atStop).not.toContain("AEON_BASE_PATH");

    // The next start finishes the job and the config is back.
    const restarted = startRealGateway();
    const settled = await waitForStatus(() => restarted.output.join(""), (current) => current.status !== "syncing");
    expect(settled).toMatchObject({ status: "ok", pushReady: true });
    expect(settled.parkedBranches).toHaveLength(1);
    expect(readClone("apps/dashboard/next.config.ts")).toBe(HIVRA_NEXT_CONFIG);
    expect(readClone("apps/dashboard/next-env.d.ts")).toContain("routes.d.ts");
    expect(git(clone, "show", `${settled.parkedBranches[0]}:STRATEGY.md`)).toBe("# Strategy\nFrom this computer.");
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(forkGit, "rev-parse", "main"));
    expect(forkShow("main:apps/dashboard/next.config.ts")).toBe(TEMPLATE_NEXT_CONFIG.trimEnd());
    restarted.child.kill("SIGTERM");
    await restarted.exited;
  });

  it("puts a lost basePath config back from its durable copy, or from the provisioner's text", async () => {
    connectedComputer();
    // An earlier sync lost the working-tree file but had kept its durable copy.
    const kept = HIVRA_NEXT_CONFIG + "// kept by an earlier sync\n";
    fs.writeFileSync(nextConfigBackup(), kept);
    write(path.join(clone, "apps/dashboard/next.config.ts"), TEMPLATE_NEXT_CONFIG);
    const first = await boot();
    const firstStatus = await settledStatus(first);
    expect(firstStatus).toMatchObject({ status: "ok" });
    expect(readClone("apps/dashboard/next.config.ts")).toBe(kept);
    expect(first.logs.join("\n")).toContain("basePath config was missing");
    await first.close();

    // No durable copy either: the exact text the provisioner writes.
    fs.rmSync(nextConfigBackup());
    write(path.join(clone, "apps/dashboard/next.config.ts"), TEMPLATE_NEXT_CONFIG);
    const second = await boot();
    expect(await settledStatus(second, firstStatus.at)).toMatchObject({ status: "ok" });
    expect(readClone("apps/dashboard/next.config.ts")).toBe(HIVRA_NEXT_CONFIG);
    expect(fs.readFileSync(nextConfigBackup(), "utf8")).toBe(HIVRA_NEXT_CONFIG);
    expect(forkShow("main:apps/dashboard/next.config.ts")).not.toContain("AEON_BASE_PATH");
  });

  it("carries only this computer's edits onto a fork older than the pinned template", async () => {
    const seed = seedUpstream();
    // The user's long-lived fork branched before the pinned commit and has its own history.
    git(root, "clone", "--quiet", "--bare", seed, forkGit);
    git(forkGit, "update-ref", "refs/heads/main", git(seed, "rev-parse", "HEAD~1"));
    botCommitOnFork("memory/log.md", "old run\n", "chore: aeon memory");
    provisionClone();
    git(clone, "remote", "set-url", "origin", FORK_URL);
    write(path.join(clone, "aeon.yml"), readClone("aeon.yml").replace("digest:\n    enabled: false", "digest:\n    enabled: true"));
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
    connectedComputer();
    botCommitOnFork("STRATEGY.md", "# Strategy\nFrom GitHub.\n", "chore: strategy from github");
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
    expect(readClone("apps/dashboard/next.config.ts")).toBe(HIVRA_NEXT_CONFIG);
    // Saving works again; the parked branch stays reported after a restart.
    write(path.join(clone, "aeon.yml"), readClone("aeon.yml").replace("news:\n    enabled: false", "news:\n    enabled: true"));
    expect(commitAndPush(["aeon.yml"], "chore: enable news")).toEqual({ synced: true });
    await gateway.close();
    const again = await boot();
    expect(await settledStatus(again, settled.at)).toMatchObject({ status: "ok", parkedBranches: [parked] });
  });

  it("never replays one fork's commits into a newly connected fork", async () => {
    connectedComputer();
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

  it("leaves a branch the owner checked out by hand exactly as it is", async () => {
    connectedComputer();
    const first = await boot();
    const firstStatus = await settledStatus(first);
    expect(firstStatus).toMatchObject({ status: "ok" });
    await first.close();
    const mainBefore = git(clone, "rev-parse", "main");
    // In the computer's terminal: an experiment on its own branch, left checked
    // out with work in progress (in a file the dashboard also saves).
    git(clone, "checkout", "--quiet", "-b", "experiment");
    write(path.join(clone, "STRATEGY.md"), "# Strategy\nExperiment.\n");
    git(clone, "commit", "--quiet", "-m", "experiment", "--", "STRATEGY.md");
    const experiment = git(clone, "rev-parse", "experiment");
    write(path.join(clone, "STRATEGY.md"), "# Strategy\nExperiment, work in progress.\n");
    botCommitOnFork("memory/log.md", "run 1\n", "chore: aeon memory");
    const forkTip = git(forkGit, "rev-parse", "main");

    const second = await boot();
    const settled = await settledStatus(second, firstStatus.at);
    expect(settled).toMatchObject({ status: "on_other_branch", branch: "main", pushReady: false, parkedBranches: [] });
    expect(settled.detail).toContain("experiment");
    expect(settled.retryAt).toBeUndefined();
    // Nothing committed onto it, HEAD not moved, nothing pushed.
    expect(git(clone, "symbolic-ref", "--short", "HEAD")).toBe("experiment");
    expect(git(clone, "rev-parse", "experiment")).toBe(experiment);
    expect(git(clone, "rev-parse", "main")).toBe(mainBefore);
    expect(readClone("STRATEGY.md")).toBe("# Strategy\nExperiment, work in progress.\n");
    expect(porcelain()).toContain(" M STRATEGY.md");
    expect(git(forkGit, "rev-parse", "main")).toBe(forkTip);
  });

  it("retries a start-up sync while GitHub cannot be reached, instead of reporting a broken sign-in", async () => {
    connectedComputer();
    botCommitOnFork("memory/log.md", "run 1\n", "chore: aeon memory");
    // The computer boots before its network is up: GitHub is unreachable for the first two tries.
    const gateway = await boot({ GH_STUB_OFFLINE_CALLS: "2" });
    const settled = await waitForStatus(() => gateway.logs.join("\n"), (current) => current.status === "ok");
    expect(settled).toMatchObject({ status: "ok", pushReady: true, attempt: 3 });
    expect(settled.retryAt).toBeUndefined();
    const logs = gateway.logs.join("\n");
    expect(logs.match(/aeon fork sync \(startup\) unreachable: Could not reach GitHub from this computer/g)).toHaveLength(2);
    expect(logs).not.toContain("auth_failed");
    // Backoff: each retry waited longer than the one before.
    expect(gateway.retryWaits).toEqual(RETRY_DELAYS.slice(0, 2));
    expect(RETRY_DELAYS[1]).toBeGreaterThan(RETRY_DELAYS[0]);
    expect(ghCalls().filter((call) => call === "api user")).toHaveLength(3);
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(forkGit, "rev-parse", "main"));
  });

  it("stops retrying after a bounded number of attempts", async () => {
    connectedComputer();
    const gateway = await boot({ GH_STUB_OFFLINE_CALLS: "99" });
    const last = await waitForStatus(() => gateway.logs.join("\n"), (current) => current.attempt === RETRY_DELAYS.length + 1 && current.status !== "syncing");
    expect(last).toMatchObject({ status: "unreachable", pushReady: false });
    expect(last.retryAt).toBeUndefined();
    expect(last.detail).toContain("check your internet connection");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(RETRY_DELAYS.length).toBeGreaterThanOrEqual(3);
    expect(gateway.retryWaits).toEqual(RETRY_DELAYS);
    expect(ghCalls().filter((call) => call === "api user")).toHaveLength(RETRY_DELAYS.length + 1);
    expect(RETRY_DELAYS.reduce((sum, wait) => sum + wait, 0)).toBeGreaterThanOrEqual(3 * 60_000);
  });

  it("reports a broken GitHub sign-in without retrying it", async () => {
    connectedComputer();
    const gateway = await boot({ GH_STUB_AUTH_FAIL: "1" });
    const settled = await settledStatus(gateway);
    expect(settled).toMatchObject({ status: "auth_failed", pushReady: false, repo: `${LOGIN}/aeon` });
    expect(settled.detail).toContain("Bad credentials");
    expect(settled.retryAt).toBeUndefined();
    expect(gitOk(clone, "symbolic-ref", "HEAD").status).not.toBe(0);
    expect(gateway.logs.join("\n")).toContain("aeon fork sync (startup) auth_failed");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(gateway.retryWaits).toEqual([]);
    expect(ghCalls().filter((call) => call === "api user")).toHaveLength(1);
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
