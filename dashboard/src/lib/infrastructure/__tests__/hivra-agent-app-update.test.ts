/** @jest-environment node */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// hivra-agent-app-update.sh moves a computer's hosted agent app (the Aeon
// dashboard, OpenClaw, Agent Zero) to the release's tested version. These
// tests run the real helper (bash, python and the file system are real) with
// systemctl, docker, npm, git, curl, df, runuser, timeout and install replaced
// by fakes that keep their state in files beside them. The helper runs some
// steps under env -i, so the fakes read their settings from fake.env.

const HELPER = path.join(process.cwd(), "provisioner", "hivra-agent-app-update.sh");
const OLD_DIGEST = `sha256:${"d".repeat(64)}`;
const NEW_DIGEST = `sha256:${"b".repeat(64)}`;
const OLD_COMMIT = "8".repeat(40);
const NEW_COMMIT = "e".repeat(40);

const FAKES: Record<string, string> = {
  runuser: `#!/bin/sh
. "\${0%/*}/fake.env"
[ "$1" = -u ] && [ "$3" = -- ] || { echo "unexpected runuser $*" >&2; exit 97; }
user="$2"; shift 3
# Log the command run as the user, past env -i and its settings.
cmd=""; for arg in "$@"; do case "$arg" in env|-i|*=*) ;; *) cmd="$arg"; break ;; esac; done
echo "runuser $user $cmd" >> "$FAKE_LOG"
exec "$@"
`,
  timeout: `#!/bin/sh
while [ "\${1#-}" != "$1" ]; do shift 2; done
shift
exec "$@"
`,
  // install -o root -g root ...: ownership is the only thing the fixture can't do.
  install: `#!/bin/sh
args=""
while [ $# -gt 0 ]; do
  case "$1" in -o|-g) shift 2 ;; *) args="$args '$1'"; shift ;; esac
done
eval "exec /usr/bin/install $args"
`,
  df: `#!/bin/sh
. "\${0%/*}/fake.env"
printf 'Filesystem 1048576-blocks Used Available Capacity Mounted\\nfake 999999 1 %s 1%% /\\n' "\${FAKE_FREE_MB:-50000}"
`,
  // curl: the gateway's /api/meta (how recently the app was used through
  // Hivra), or an app health check whose answer systemctl decided.
  curl: `#!/bin/sh
. "\${0%/*}/fake.env"
url=""; for arg in "$@"; do url="$arg"; done
case "$url" in
  */api/meta)
    echo "meta lock=$([ -e "$FAKE_LOCK" ] && echo held || echo free)" >> "$FAKE_LOG"
    now=$(date +%s); at=$((now - \${FAKE_LAST_USED_AGE:-100000}))
    python3 -c 'import sys,time; print("{\\"agentApp\\":{\\"activity\\":{\\"lastUsedAt\\":\\"%s\\",\\"openConnections\\":%s}}}" % (time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(int(sys.argv[1]))), sys.argv[2]))' "$at" "\${FAKE_OPEN_CONNECTIONS:-0}"
    ;;
  *) echo "curl $url" >> "$FAKE_LOG"; cat "$FAKE_DIR/http-code" 2>/dev/null || printf 000 ;;
esac
`,
  // systemctl: start/restart make the app answer 200 unless it now runs FAKE_BAD_VERSION.
  systemctl: `#!/bin/sh
. "\${0%/*}/fake.env"
echo "systemctl $* lock=$([ -e "$FAKE_LOCK" ] && echo held || echo free)" >> "$FAKE_LOG"
case "$1" in
  is-active) [ -f "$FAKE_DIR/active" ] ;;
  stop) rm -f "$FAKE_DIR/active" "$FAKE_DIR/http-code" ;;
  start|restart)
    running=""
    case "$FAKE_APP" in
      agent-zero)
        running=$(grep -oE 'sha256:[0-9a-f]{64}' "$FAKE_UNIT_FILE" | head -n 1)
        printf 'agent0ai/agent-zero@%s\\n' "$running" > "$FAKE_DIR/container"
        # The new version migrates its data on first start.
        [ "$running" = "$FAKE_OLD" ] || echo migrated > "$FAKE_DATA/migrated-by-new"
        ;;
      openclaw) running=$("$FAKE_HOME/.npm-global/bin/openclaw" --version 2>/dev/null) ;;
      aeon) running=$(sed -n 's#^WorkingDirectory=.*/\\([0-9a-f]\\{40\\}\\)/apps/dashboard$#\\1#p' "$FAKE_DROPIN" 2>/dev/null) ;;
    esac
    touch "$FAKE_DIR/active"
    if [ -n "$FAKE_BAD_VERSION" ] && [ "$running" = "$FAKE_BAD_VERSION" ]; then printf 502 > "$FAKE_DIR/http-code"; else printf 200 > "$FAKE_DIR/http-code"; fi
    ;;
esac
exit 0
`,
  docker: `#!/bin/sh
. "\${0%/*}/fake.env"
echo "docker $* lock=$([ -e "$FAKE_LOCK" ] && echo held || echo free)" >> "$FAKE_LOG"
case "$1 $2" in
  "inspect --format") cat "$FAKE_DIR/container" 2>/dev/null ;;
  "image inspect") exit 0 ;;
  "image rm") exit 0 ;;
  pull*) exit "\${FAKE_PULL_EXIT:-0}" ;;
esac
`,
  npm: `#!/bin/sh
. "\${0%/*}/fake.env"
if [ "$1" = --prefix ]; then
  prefix="$2"; shift 2
  spec=""; for arg in "$@"; do spec="$arg"; done
  echo "npm $1 $spec lock=$([ -e "$FAKE_LOCK" ] && echo held || echo free)" >> "$FAKE_LOG"
  case "$1" in
    cache) exit "\${FAKE_NPM_CACHE_EXIT:-0}" ;;
    install)
      version="\${spec##*@}"; dir="$prefix/lib/node_modules/openclaw"
      rm -rf "$dir"; mkdir -p "$dir"
      printf '#!/bin/sh\\necho "OpenClaw %s"\\n' "$version" > "$dir/cli.sh"; chmod 755 "$dir/cli.sh"
      exit 0 ;;
  esac
  exit 95
fi
echo "npm $* in $(basename "$(dirname "$(dirname "$PWD")")")" >> "$FAKE_LOG"
case "$1" in
  ci) exit "\${FAKE_NPM_CI_EXIT:-0}" ;;
  run) mkdir -p .next; exit "\${FAKE_NPM_BUILD_EXIT:-0}" ;;
esac
exit 95
`,
  git: `#!/bin/sh
. "\${0%/*}/fake.env"
case "$1" in
  init|remote) exit 0 ;;
  fetch) sha=""; for arg in "$@"; do sha="$arg"; done; echo "git fetch $sha" >> "$FAKE_LOG"; [ -z "$FAKE_GIT_FAIL" ] || exit 1; echo "$sha" > .fake-head ;;
  checkout) mkdir -p apps/dashboard ;;
  rev-parse) cat .fake-head ;;
esac
exit 0
`,
};

type App = "openclaw" | "agent-zero" | "aeon";
interface Fixture {
  root: string; home: string; state: string; systemd: string; a0: string; fakes: string; lock: string; log: string;
  unit: string; dropin: string; env: NodeJS.ProcessEnv;
}

function fixture(app: App): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hivra-agent-app-update-")));
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const systemd = path.join(root, "systemd");
  const a0 = path.join(root, "a0");
  const fakes = path.join(root, "fakes");
  for (const dir of [path.join(home, ".hivra"), state, systemd, fakes]) fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(FAKES)) fs.writeFileSync(path.join(fakes, name), body, { mode: 0o755 });
  fs.writeFileSync(path.join(home, ".hivra", "api-token"), "a".repeat(64));
  const unitName = app === "aeon" ? "bux-aeon.service" : app === "openclaw" ? "bux-openclaw.service" : "hivra-agent-zero.service";
  const unit = path.join(systemd, unitName);
  const dropin = path.join(systemd, "bux-aeon.service.d", "20-hivra-dashboard.conf");
  if (app === "agent-zero") {
    fs.writeFileSync(unit, `[Service]\nExecStart=/usr/bin/docker run --rm --name hivra-agent-zero -v ${a0}/.env:/a0/.env -v ${a0}/usr:/a0/usr -p 127.0.0.1:50080:80 agent0ai/agent-zero@${OLD_DIGEST}\n`);
    fs.mkdirSync(path.join(a0, "usr", "chats"), { recursive: true });
    fs.mkdirSync(path.join(a0, "usr", "scheduler"), { recursive: true });
    fs.writeFileSync(path.join(a0, "usr", "settings.json"), "{\"v\":2.2}");
    fs.writeFileSync(path.join(a0, "usr", "scheduler", "tasks.json"), JSON.stringify({ tasks: [] }));
    const old = Date.now() / 1000 - 3600;
    fs.utimesSync(path.join(a0, "usr", "settings.json"), old, old);
    fs.writeFileSync(path.join(fakes, "container"), `agent0ai/agent-zero@${OLD_DIGEST}\n`);
  } else if (app === "openclaw") {
    fs.writeFileSync(unit, "[Service]\nExecStart=/home/bux/.npm-global/bin/openclaw gateway --port 18789\n");
    const dir = path.join(home, ".npm-global", "lib", "node_modules", "openclaw");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(home, ".npm-global", "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cli.sh"), "#!/bin/sh\necho \"OpenClaw 2026.6.10\"\n", { mode: 0o755 });
    fs.symlinkSync("../lib/node_modules/openclaw/cli.sh", path.join(home, ".npm-global", "bin", "openclaw"));
  } else {
    fs.writeFileSync(unit, "[Service]\nWorkingDirectory=/home/bux/aeon/apps/dashboard\nExecStart=/usr/bin/env npm run start -- -p 5555\n");
    fs.mkdirSync(path.join(home, "aeon", ".git"), { recursive: true });
    fs.writeFileSync(path.join(state, "agent-app.json"), JSON.stringify({ name: "aeon", version: OLD_COMMIT }));
  }
  fs.writeFileSync(path.join(fakes, "active"), "");
  fs.writeFileSync(path.join(fakes, "http-code"), "200");
  const lock = path.join(root, "agent-app-update.lock");
  const log = path.join(root, "log");
  fs.writeFileSync(log, "");
  return {
    root, home, state, systemd, a0, fakes, lock, log, unit, dropin,
    env: {
      PATH: `${fakes}:/usr/bin:/bin`, NODE_ENV: "test",
      HIVRA_AGENT_HOME: home, HIVRA_AGENT_APP_STATE_DIR: state, HIVRA_SYSTEMD_DIR: systemd, HIVRA_A0_ROOT: a0,
      HIVRA_AGENT_APP_LOCK: lock, HIVRA_AGENT_APP_TEST_BIN: fakes,
      HIVRA_AGENT_APP_POLL_SECONDS: "0", HIVRA_AGENT_APP_LOCK_SETTLE_SECONDS: "0", HIVRA_AGENT_APP_WAIT_SECONDS: "0",
      HIVRA_AGENT_APP_HEALTH_SECONDS: "0", HIVRA_AGENT_APP_HEALTH_POLL_SECONDS: "0",
    },
  };
}

function run(f: Fixture, app: App, target: string, settings: Record<string, string> = {}) {
  const all = {
    FAKE_LOG: f.log, FAKE_LOCK: f.lock, FAKE_DIR: f.fakes, FAKE_APP: app, FAKE_UNIT_FILE: f.unit, FAKE_DROPIN: f.dropin,
    FAKE_HOME: f.home, FAKE_DATA: path.join(f.a0, "usr"), FAKE_OLD: OLD_DIGEST, FAKE_BAD_VERSION: "", ...settings,
  };
  fs.writeFileSync(path.join(f.fakes, "fake.env"), Object.entries(all).map(([key, value]) => `${key}='${value}'\n`).join(""));
  const result = spawnSync("/bin/bash", [HELPER, app, target], { encoding: "utf8", timeout: 30_000, env: f.env });
  const read = (file: string) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  return {
    status: result.status, stderr: result.stderr,
    doc: read(path.join(f.state, "agent-app-update.json")),
    record: read(path.join(f.state, "agent-app.json")),
    log: fs.readFileSync(f.log, "utf8").trim().split("\n").filter(Boolean),
  };
}
const openclawVersion = (f: Fixture) => spawnSync(path.join(f.home, ".npm-global", "bin", "openclaw"), [], { encoding: "utf8" }).stdout.trim();

describe("hivra-agent-app-update.sh", () => {
  const made: Fixture[] = [];
  const make = (app: App) => { const f = fixture(app); made.push(f); return f; };
  afterEach(() => { for (const f of made.splice(0)) fs.rmSync(f.root, { recursive: true, force: true }); });

  it("refuses a version not in the app's own form", () => {
    const f = make("openclaw");
    expect(run(f, "openclaw", "latest").status).toBe(64);
    expect(run(f, "agent-zero" as App, "v2.14").status).toBe(64);
    expect(run(f, "aeon" as App, "main").status).toBe(64);
  });

  it("moves an idle OpenClaw computer to the tested version as its owner, restarting only under the lock", () => {
    const f = make("openclaw");
    const result = run(f, "openclaw", "2026.9.33");
    expect(result.status).toBe(0);
    expect(openclawVersion(f)).toBe("OpenClaw 2026.9.33");
    expect(result.doc).toMatchObject({ name: "openclaw", state: "done", from: "2026.6.10", to: "2026.9.33" });
    expect(result.record).toMatchObject({ name: "openclaw", version: "2026.9.33" });
    // Downloaded first with the lock free, then installed and restarted under it.
    expect(result.log.filter((line) => line.startsWith("npm ") || line.startsWith("systemctl restart"))).toEqual([
      "npm cache openclaw@2026.9.33 lock=free",
      "npm install openclaw@2026.9.33 lock=held",
      "systemctl restart bux-openclaw.service lock=held",
    ]);
    // Every step on the agent's npm prefix runs as the agent's user.
    expect(result.log.filter((line) => line.startsWith("runuser ")).every((line) => line.startsWith("runuser bux "))).toBe(true);
    expect(fs.existsSync(f.lock)).toBe(false);
    expect(fs.existsSync(path.join(f.home, ".hivra", "agent-app-backup"))).toBe(false);
    expect(fs.existsSync(path.join(f.state, "agent-app-swap"))).toBe(false);
  });

  it("puts the previous OpenClaw back when the new one doesn't come up", () => {
    const f = make("openclaw");
    const result = run(f, "openclaw", "2026.9.33", { FAKE_BAD_VERSION: "OpenClaw 2026.9.33" });
    expect(result.status).toBe(1);
    expect(openclawVersion(f)).toBe("OpenClaw 2026.6.10");
    expect(result.doc).toMatchObject({ state: "rolled_back", reason: "install_failed", from: "2026.6.10", to: "2026.9.33" });
    expect(result.record).toMatchObject({ version: "2026.6.10" });
    expect(fs.existsSync(f.lock)).toBe(false);
  });

  it("swaps Agent Zero's image digest in its unit and drops the old image once the new one answers", () => {
    const f = make("agent-zero");
    const result = run(f, "agent-zero", NEW_DIGEST);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(f.unit, "utf8")).toContain(`agent0ai/agent-zero@${NEW_DIGEST}`);
    expect(fs.readFileSync(f.unit, "utf8")).not.toContain(OLD_DIGEST);
    expect(result.doc).toMatchObject({ name: "agent-zero", state: "done", from: OLD_DIGEST, to: NEW_DIGEST });
    expect(result.record).toMatchObject({ name: "agent-zero", version: NEW_DIGEST });
    const steps = result.log.filter((line) => /^(docker (pull|image rm)|systemctl (stop|start))/.test(line));
    expect(steps).toEqual([
      `docker pull agent0ai/agent-zero@${NEW_DIGEST} lock=free`,
      "systemctl stop hivra-agent-zero.service lock=held",
      "systemctl start hivra-agent-zero.service lock=held",
      `docker image rm agent0ai/agent-zero@${OLD_DIGEST} lock=free`,
    ]);
    // The data copy taken for a rollback is gone; the data itself is kept.
    expect(fs.existsSync(path.join(f.a0, "usr.hivra-update-backup"))).toBe(false);
    expect(fs.readFileSync(path.join(f.a0, "usr", "settings.json"), "utf8")).toBe("{\"v\":2.2}");
  });

  it("puts Agent Zero's previous image and its data as they were back when the new image doesn't come up", () => {
    const f = make("agent-zero");
    const result = run(f, "agent-zero", NEW_DIGEST, { FAKE_BAD_VERSION: NEW_DIGEST });
    expect(result.status).toBe(1);
    expect(result.doc).toMatchObject({ state: "rolled_back", reason: "install_failed" });
    expect(fs.readFileSync(f.unit, "utf8")).toContain(`agent0ai/agent-zero@${OLD_DIGEST}`);
    // What the new version migrated on its first start is undone.
    expect(fs.existsSync(path.join(f.a0, "usr", "migrated-by-new"))).toBe(false);
    expect(fs.readFileSync(path.join(f.a0, "usr", "settings.json"), "utf8")).toBe("{\"v\":2.2}");
    expect(result.log.some((line) => line.startsWith("docker image rm"))).toBe(false);
    expect(result.record).toMatchObject({ version: OLD_DIGEST });
  });

  it("builds the Aeon dashboard at the tested commit beside the clone and points the service at it", () => {
    const f = make("aeon");
    const result = run(f, "aeon", NEW_COMMIT);
    expect(result.status).toBe(0);
    const build = path.join(f.home, ".hivra", "aeon-dashboard", NEW_COMMIT);
    expect(fs.existsSync(path.join(build, ".hivra-built"))).toBe(true);
    expect(fs.readFileSync(path.join(build, "apps", "dashboard", "next.config.ts"), "utf8")).toContain("AEON_BASE_PATH");
    expect(fs.readFileSync(f.dropin, "utf8")).toBe(
      `[Service]\nWorkingDirectory=${build}/apps/dashboard\nEnvironment=AEON_REPO_ROOT=${path.join(f.home, "aeon")}\n`,
    );
    expect(result.doc).toMatchObject({ name: "aeon", state: "done", from: OLD_COMMIT, to: NEW_COMMIT });
    expect(result.record).toMatchObject({ name: "aeon", version: NEW_COMMIT });
    expect(result.log).toEqual(expect.arrayContaining([
      `git fetch ${NEW_COMMIT}`,
      "systemctl restart bux-aeon.service lock=held",
    ]));
    // The owner's clone is never touched.
    expect(fs.readdirSync(path.join(f.home, "aeon"))).toEqual([".git"]);
  });

  it("keeps only the current and the previous Aeon build", () => {
    const f = make("aeon");
    const third = "c".repeat(40);
    expect(run(f, "aeon", NEW_COMMIT).status).toBe(0);
    expect(run(f, "aeon", third).status).toBe(0);
    expect(fs.readdirSync(path.join(f.home, ".hivra", "aeon-dashboard")).sort()).toEqual([third, NEW_COMMIT].sort());
  });

  it("changes nothing when the Aeon build fails", () => {
    const f = make("aeon");
    const result = run(f, "aeon", NEW_COMMIT, { FAKE_NPM_BUILD_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.doc).toMatchObject({ state: "failed", reason: "download_failed" });
    expect(fs.existsSync(f.dropin)).toBe(false);
    expect(fs.readdirSync(path.join(f.home, ".hivra", "aeon-dashboard"))).toEqual([]);
    expect(result.log.some((line) => line.startsWith("systemctl restart"))).toBe(false);
  });

  it("goes back to the dashboard built in the clone when the first Aeon swap fails", () => {
    const f = make("aeon");
    const result = run(f, "aeon", NEW_COMMIT, { FAKE_BAD_VERSION: NEW_COMMIT });
    expect(result.status).toBe(1);
    expect(result.doc).toMatchObject({ state: "rolled_back" });
    expect(fs.existsSync(f.dropin)).toBe(false);
    expect(result.record).toMatchObject({ version: OLD_COMMIT });
  });

  it("waits while someone uses the app through Hivra, and changes nothing when that outlasts the wait", () => {
    const f = make("openclaw");
    const result = run(f, "openclaw", "2026.9.33", { FAKE_LAST_USED_AGE: "30" });
    expect(result.status).toBe(0);
    expect(result.doc).toMatchObject({ state: "deferred", reason: "app_in_use" });
    expect(openclawVersion(f)).toBe("OpenClaw 2026.6.10");
    expect(result.log.some((line) => line.startsWith("npm install") || line.startsWith("systemctl restart"))).toBe(false);
    expect(fs.existsSync(f.lock)).toBe(false);
  });

  it("counts an open WebSocket as use however long ago the last request was", () => {
    const f = make("openclaw");
    expect(run(f, "openclaw", "2026.9.33", { FAKE_OPEN_CONNECTIONS: "1" }).doc).toMatchObject({ state: "deferred" });
  });

  it("waits while an Agent Zero task is running or a chat saved a step recently", () => {
    const f = make("agent-zero");
    fs.writeFileSync(path.join(f.a0, "usr", "scheduler", "tasks.json"), JSON.stringify({ tasks: [{ state: "running" }] }));
    expect(run(f, "agent-zero", NEW_DIGEST).doc).toMatchObject({ state: "deferred", reason: "app_in_use" });
    fs.writeFileSync(path.join(f.a0, "usr", "scheduler", "tasks.json"), JSON.stringify({ tasks: [{ state: "idle" }] }));
    fs.mkdirSync(path.join(f.a0, "usr", "chats", "c1"), { recursive: true });
    fs.writeFileSync(path.join(f.a0, "usr", "chats", "c1", "chat.json"), "{}");
    expect(run(f, "agent-zero", NEW_DIGEST).doc).toMatchObject({ state: "deferred" });
    expect(fs.readFileSync(f.unit, "utf8")).toContain(OLD_DIGEST);
  });

  it("waits while a save is being committed in the Aeon clone", () => {
    const f = make("aeon");
    fs.writeFileSync(path.join(f.home, "aeon", ".git", "index.lock"), "");
    expect(run(f, "aeon", NEW_COMMIT).doc).toMatchObject({ state: "deferred" });
    expect(fs.existsSync(f.dropin)).toBe(false);
  });

  it("only reports when the computer already runs the tested version", () => {
    const f = make("agent-zero");
    const result = run(f, "agent-zero", OLD_DIGEST);
    expect(result.status).toBe(0);
    expect(result.doc).toMatchObject({ state: "done", from: OLD_DIGEST, to: OLD_DIGEST });
    expect(result.record).toMatchObject({ version: OLD_DIGEST });
    expect(result.log.some((line) => line.startsWith("docker pull"))).toBe(false);
  });

  it("stops before downloading when the disk can't hold the new version", () => {
    const f = make("agent-zero");
    const result = run(f, "agent-zero", NEW_DIGEST, { FAKE_FREE_MB: "4000" });
    expect(result.status).toBe(1);
    expect(result.doc).toMatchObject({ state: "failed", reason: "no_space" });
    expect(result.log.some((line) => line.startsWith("docker pull"))).toBe(false);
  });

  it("says so when the app's service isn't on the computer", () => {
    const f = make("openclaw");
    fs.rmSync(f.unit);
    expect(run(f, "openclaw", "2026.9.33").doc).toMatchObject({ state: "failed", reason: "not_installed" });
  });

  // A swap that rewrote the unit and copied the data aside, then the computer
  // rebooted; the new version started on the data it migrated.
  function cutShort(f: Fixture) {
    const journal = path.join(f.state, "agent-app-swap");
    fs.mkdirSync(journal);
    fs.writeFileSync(path.join(journal, "name"), "agent-zero\n");
    fs.writeFileSync(path.join(journal, "from"), `${OLD_DIGEST}\n`);
    fs.writeFileSync(path.join(journal, "to"), `${NEW_DIGEST}\n`);
    fs.copyFileSync(f.unit, path.join(journal, "unit"));
    fs.cpSync(path.join(f.a0, "usr"), path.join(f.a0, "usr.hivra-update-backup"), { recursive: true });
    fs.writeFileSync(path.join(journal, "a0-data"), "");
    fs.writeFileSync(f.unit, fs.readFileSync(f.unit, "utf8").replace(OLD_DIGEST, NEW_DIGEST));
    fs.writeFileSync(path.join(f.a0, "usr", "written-since"), "a chat the owner had since");
    fs.writeFileSync(path.join(f.fakes, "container"), `agent0ai/agent-zero@${NEW_DIGEST}\n`);
    return journal;
  }

  it("keeps a swap cut short when the new version runs and answers, losing nothing written since", () => {
    const f = make("agent-zero");
    const journal = cutShort(f);
    const result = run(f, "agent-zero", NEW_DIGEST);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(f.unit, "utf8")).toContain(NEW_DIGEST);
    expect(fs.readFileSync(path.join(f.a0, "usr", "written-since"), "utf8")).toBe("a chat the owner had since");
    expect(fs.existsSync(path.join(f.a0, "usr.hivra-update-backup"))).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
    expect(result.record).toMatchObject({ version: NEW_DIGEST });
    expect(result.doc).toMatchObject({ state: "done", to: NEW_DIGEST });
  });

  it("undoes a swap cut short when the new version doesn't answer, moving what it wrote aside rather than deleting it", () => {
    const f = make("agent-zero");
    const journal = cutShort(f);
    fs.writeFileSync(path.join(f.fakes, "http-code"), "502");
    const result = run(f, "agent-zero", OLD_DIGEST);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(f.unit, "utf8")).toContain(OLD_DIGEST);
    expect(fs.existsSync(path.join(f.a0, "usr", "written-since"))).toBe(false);
    const aside = fs.readdirSync(f.a0).filter((entry) => entry.startsWith("usr.hivra-replaced-"));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(f.a0, aside[0], "written-since"), "utf8")).toBe("a chat the owner had since");
    expect(fs.existsSync(journal)).toBe(false);
    expect(result.doc).toMatchObject({ state: "done", to: OLD_DIGEST });
  });

  it("never holds the app while someone is using it, and reads the token only as the agent's user", () => {
    const f = make("openclaw");
    const result = run(f, "openclaw", "2026.9.33", { FAKE_LAST_USED_AGE: "30" });
    const checks = result.log.filter((line) => line.startsWith("meta "));
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((line) => line === "meta lock=free")).toBe(true);
    expect(result.log).toContain("runuser bux head");
  });

  it("points the Aeon build's outputs folder at the owner's clone, where skill runs commit them", () => {
    const f = make("aeon");
    expect(run(f, "aeon", NEW_COMMIT).status).toBe(0);
    const outputs = path.join(f.home, ".hivra", "aeon-dashboard", NEW_COMMIT, "apps", "dashboard", "outputs");
    expect(fs.lstatSync(outputs).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(outputs)).toBe(path.join(f.home, "aeon", "apps", "dashboard", "outputs"));
  });
});
