/** @jest-environment node */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// hivra-agent-app-update.sh for OpenBot (CopilotKit): no Hivra pin, the target
// is "latest". The real helper runs (bash, python and the file system are
// real) with systemctl, docker, curl, df, runuser and timeout replaced by fakes
// that keep their state in files beside them.

const HELPER = path.join(process.cwd(), "provisioner", "hivra-agent-app-update.sh");
const REPO = "ghcr.io/copilotkit/openbot";
const OLD = `sha256:${"1".repeat(64)}`;
const NEW = `sha256:${"2".repeat(64)}`;

const FAKES: Record<string, string> = {
  runuser: `#!/bin/sh
[ "$1" = -u ] && [ "$3" = -- ] || exit 97
shift 3
exec "$@"
`,
  timeout: `#!/bin/sh
while [ "\${1#-}" != "$1" ]; do shift 2; done
shift
exec "$@"
`,
  df: `#!/bin/sh
. "\${0%/*}/fake.env"
printf 'Filesystem 1048576-blocks Used Available Capacity Mounted\\nfake 999999 1 %s 1%% /\\n' "\${FAKE_FREE_MB:-50000}"
`,
  curl: `#!/bin/sh
. "\${0%/*}/fake.env"
url=""; for arg in "$@"; do url="$arg"; done
case "$url" in
  */api/meta) printf '{"agentApp":{"activity":{"lastUsedAt":"2000-01-01T00:00:00.000Z","openConnections":0}}}' ;;
  *) echo "curl $url" >> "$FAKE_LOG"; cat "$FAKE_DIR/http-code" 2>/dev/null || printf 000 ;;
esac
`,
  systemctl: `#!/bin/sh
. "\${0%/*}/fake.env"
echo "systemctl $* lock=$([ -e "$FAKE_LOCK" ] && echo held || echo free)" >> "$FAKE_LOG"
case "$1" in
  is-active) [ -f "$FAKE_DIR/active" ] ;;
  stop) rm -f "$FAKE_DIR/active" "$FAKE_DIR/http-code" ;;
  start|restart)
    touch "$FAKE_DIR/active"
    running=$(grep -oE 'sha256:[0-9a-f]{64}' "$FAKE_OB_ROOT/image" | head -n 1)
    # The new release migrates the database on first start.
    [ "$running" = "$FAKE_OLD" ] || echo migrated > "$FAKE_VOLUME/migrated-by-new"
    if [ -n "$FAKE_BAD" ] && [ "$running" = "$FAKE_BAD" ]; then printf 502 > "$FAKE_DIR/http-code"; else printf 200 > "$FAKE_DIR/http-code"; fi
    ;;
esac
exit 0
`,
  docker: `#!/bin/sh
. "\${0%/*}/fake.env"
echo "docker $* lock=$([ -e "$FAKE_LOCK" ] && echo held || echo free)" >> "$FAKE_LOG"
last=""; for arg in "$@"; do last="$arg"; done
case "$1 $2" in
  "pull ghcr.io/copilotkit/openbot:latest") exit "\${FAKE_PULL_EXIT:-0}" ;;
  "image inspect")
    case "$4" in
      *RepoDigests*) echo "ghcr.io/copilotkit/openbot@$FAKE_LATEST" ;;
      *Config.Env*)
        digest="\${last#*@}"
        [ -f "$FAKE_DIR/version-$digest" ] || exit 1
        echo "PATH=/usr/bin"; echo "OPENBOT_BUILD_VERSION=v$(cat "$FAKE_DIR/version-$digest")" ;;
    esac ;;
  "image rm") exit 0 ;;
esac
exit 0
`,
};

interface Fixture { root: string; home: string; state: string; systemd: string; obRoot: string; volume: string; fakes: string; lock: string; log: string; env: NodeJS.ProcessEnv }

function fixture({ key = true } = {}): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hivra-openbot-update-")));
  const home = path.join(root, "home");
  const state = path.join(root, "state");
  const systemd = path.join(root, "systemd");
  const obRoot = path.join(root, "openbot");
  const volume = path.join(root, "volume", "_data");
  const fakes = path.join(root, "fakes");
  for (const dir of [path.join(home, ".hivra"), state, systemd, obRoot, volume, fakes]) fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(FAKES)) fs.writeFileSync(path.join(fakes, name), body, { mode: 0o755 });
  fs.writeFileSync(path.join(home, ".hivra", "api-token"), "a".repeat(64));
  if (key) fs.writeFileSync(path.join(home, ".hivra", "openbot-intelligence-key"), "cpk-test-key\n", { mode: 0o600 });
  fs.writeFileSync(path.join(systemd, "hivra-openbot.service"), "[Service]\nExecStart=/usr/local/sbin/hivra-openbot-run\n");
  fs.writeFileSync(path.join(obRoot, "image"), `${REPO}@${OLD}\n`);
  fs.writeFileSync(path.join(volume, "PG_VERSION"), "16\n");
  fs.writeFileSync(path.join(fakes, `version-${OLD}`), "1.0.2");
  fs.writeFileSync(path.join(fakes, `version-${NEW}`), "1.1.0");
  fs.writeFileSync(path.join(fakes, "active"), "");
  fs.writeFileSync(path.join(fakes, "http-code"), "200");
  const lock = path.join(root, "agent-app-update.lock");
  const log = path.join(root, "log");
  fs.writeFileSync(log, "");
  return {
    root, home, state, systemd, obRoot, volume, fakes, lock, log,
    env: {
      PATH: `${fakes}:/usr/bin:/bin`, NODE_ENV: "test",
      HIVRA_AGENT_HOME: home, HIVRA_AGENT_APP_STATE_DIR: state, HIVRA_SYSTEMD_DIR: systemd,
      HIVRA_OPENBOT_ROOT: obRoot, HIVRA_OPENBOT_VOLUME_DIR: volume,
      HIVRA_AGENT_APP_LOCK: lock, HIVRA_AGENT_APP_TEST_BIN: fakes,
      HIVRA_AGENT_APP_POLL_SECONDS: "0", HIVRA_AGENT_APP_LOCK_SETTLE_SECONDS: "0", HIVRA_AGENT_APP_WAIT_SECONDS: "0",
      HIVRA_AGENT_APP_HEALTH_SECONDS: "0", HIVRA_AGENT_APP_HEALTH_POLL_SECONDS: "0",
    },
  };
}

function run(f: Fixture, target: string, settings: Record<string, string> = {}) {
  const all = { FAKE_LOG: f.log, FAKE_LOCK: f.lock, FAKE_DIR: f.fakes, FAKE_OB_ROOT: f.obRoot, FAKE_VOLUME: f.volume,
    FAKE_OLD: OLD, FAKE_LATEST: NEW, FAKE_BAD: "", ...settings };
  fs.writeFileSync(path.join(f.fakes, "fake.env"), Object.entries(all).map(([k, v]) => `${k}='${v}'\n`).join(""));
  const result = spawnSync("/bin/bash", [HELPER, "openbot", target], { encoding: "utf8", timeout: 30_000, env: f.env });
  const read = (file: string) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  return {
    status: result.status, stderr: result.stderr,
    doc: read(path.join(f.state, "agent-app-update.json")),
    record: read(path.join(f.state, "agent-app.json")),
    image: fs.readFileSync(path.join(f.obRoot, "image"), "utf8").trim(),
    log: fs.readFileSync(f.log, "utf8").trim().split("\n").filter(Boolean),
  };
}

describe("hivra-agent-app-update.sh openbot", () => {
  const made: Fixture[] = [];
  const make = (options?: { key?: boolean }) => { const f = fixture(options); made.push(f); return f; };
  afterEach(() => { for (const f of made.splice(0)) fs.rmSync(f.root, { recursive: true, force: true }); });

  it("accepts only latest as a target", () => {
    const f = make();
    expect(run(f, "1.1.0").status).toBe(64);
    expect(run(f, NEW).status).toBe(64);
  });

  it("pulls the latest image, swaps under the lock with the database copied aside, and records the new release", () => {
    const f = make();
    const result = run(f, "latest");
    expect(result.status).toBe(0);
    expect(result.image).toBe(`${REPO}@${NEW}`);
    expect(result.record).toMatchObject({ name: "openbot", version: "1.1.0" });
    expect(result.doc).toMatchObject({ name: "openbot", state: "done", from: "1.0.2", to: "latest" });
    expect(result.log).toContain("docker pull ghcr.io/copilotkit/openbot:latest lock=free");
    expect(result.log).toContain("systemctl stop hivra-openbot.service lock=held");
    expect(result.log).toContain("systemctl start hivra-openbot.service lock=held");
    expect(result.log).toContain(`docker image rm ${REPO}@${OLD} lock=free`);
    // The copy is dropped once the new release answers.
    expect(fs.existsSync(path.join(f.obRoot, "data.hivra-update-backup"))).toBe(false);
    expect(fs.existsSync(f.lock)).toBe(false);
  });

  it("does nothing but record the version when the latest image is the one running", () => {
    const f = make();
    const result = run(f, "latest", { FAKE_LATEST: OLD });
    expect(result.status).toBe(0);
    expect(result.image).toBe(`${REPO}@${OLD}`);
    expect(result.doc).toMatchObject({ state: "done" });
    expect(result.log.filter((line) => line.startsWith("systemctl stop"))).toEqual([]);
  });

  it("only records the new image while OpenBot waits for its Intelligence key", () => {
    const f = make({ key: false });
    const result = run(f, "latest");
    expect(result.status).toBe(0);
    expect(result.image).toBe(`${REPO}@${NEW}`);
    expect(result.record).toMatchObject({ version: "1.1.0" });
    expect(result.log.filter((line) => line.startsWith("systemctl stop"))).toEqual([]);
  });

  it("puts the previous image and database back when the new release does not answer", () => {
    const f = make();
    const result = run(f, "latest", { FAKE_BAD: NEW });
    expect(result.status).toBe(1);
    expect(result.image).toBe(`${REPO}@${OLD}`);
    expect(result.doc).toMatchObject({ state: "rolled_back", reason: "install_failed" });
    expect(result.record).toMatchObject({ version: "1.0.2" });
    // The old release runs on the database as it was; what the new one wrote is kept aside.
    expect(fs.existsSync(path.join(f.volume, "migrated-by-new"))).toBe(false);
    expect(fs.existsSync(path.join(`${f.volume}.hivra-replaced`, "migrated-by-new"))).toBe(true);
    expect(fs.readFileSync(path.join(f.volume, "PG_VERSION"), "utf8")).toBe("16\n");
    expect(fs.existsSync(f.lock)).toBe(false);
  });

  it("fails without touching the running release when the pull fails", () => {
    const f = make();
    const result = run(f, "latest", { FAKE_PULL_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.doc).toMatchObject({ state: "failed", reason: "download_failed" });
    expect(result.image).toBe(`${REPO}@${OLD}`);
  });
});
