import { spawnSync } from "child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  UPDATE_STACK_VERSION,
  buildReleaseClientShell,
  buildSessionSurvivalShell,
} from "@/lib/services/box-release-shell";

const INST = "11111111-1111-4111-8111-111111111111";
const REPO = "ghcr.io/example/agent";
const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;

interface Sandbox {
  dir: string;
  bin: string;
  envDir: string;
  curlLog: string;
  run: (body: string, env?: Record<string, string>) => { status: number | null; stdout: string; stderr: string };
  writeBin: (name: string, body: string) => void;
}

function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "box-shell-"));
  const bin = join(dir, "bin");
  const envDir = join(dir, "inst");
  mkdirSync(bin);
  mkdirSync(envDir);
  const curlLog = join(dir, "curl.log");
  const writeBin = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // curl stub: record the arguments, answer with $CURL_REPLY.
  writeBin("curl", `printf '%s\\n' "$*" >> "${curlLog}"\n[ -n "\${CURL_FAIL:-}" ] && exit 22\nprintf '%s' "\${CURL_REPLY:-}"`);
  writeFileSync(join(envDir, ".env"), "# Generated\nHERMES_DASHBOARD_URL=https://dash.example.test/\nAPI_SERVER_KEY=box-secret\n");
  return {
    dir,
    bin,
    envDir,
    curlLog,
    writeBin,
    run: (body, env = {}) => {
      const script = `set -u\nENV_DIR="${envDir}"\n${buildReleaseClientShell({ instanceId: INST })}\n${buildSessionSurvivalShell()}\n${body}`;
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

describe("release client shell", () => {
  let box: Sandbox;
  beforeEach(() => {
    box = sandbox();
  });
  afterEach(() => rmSync(box.dir, { recursive: true, force: true }));

  it("asks the dashboard with the box bearer, the repo and the digest it runs", () => {
    const result = box.run(`hermes_release_get "${REPO}" "${D1}"`, { CURL_REPLY: "action=roll\n" });
    expect(result.stdout).toBe("action=roll\n");
    const logged = readFileSync(box.curlLog, "utf8");
    expect(logged).toContain("Authorization: Bearer box-secret");
    expect(logged).toContain(`repo=${REPO}`);
    expect(logged).toContain(`cur=${D1}`);
    expect(logged).toContain(`https://dash.example.test/api/u/${INST}/release`);
  });

  it("fails (so the caller does not roll) when the dashboard is unreachable or the box has no credentials", () => {
    expect(box.run(`hermes_release_get "${REPO}" ""`, { CURL_FAIL: "1" }).status).not.toBe(0);
    writeFileSync(join(box.envDir, ".env"), "# nothing here\n");
    expect(box.run(`hermes_release_get "${REPO}" ""`).status).not.toBe(0);
  });

  it("reports an outcome with the kind, stack version and validated digests", () => {
    const result = box.run(`hermes_release_report rolled_back failed "unhealthy after roll" "${D1}" "${D2}"`);
    expect(result.status).toBe(0);
    const logged = readFileSync(box.curlLog, "utf8");
    expect(logged).toContain(`/api/u/${INST}?s=failed&t=scheduled&k=rolled_back&sv=${UPDATE_STACK_VERSION}&i=${D1}&ti=${D2}`);
    expect(logged).toContain("r=unhealthy after roll");
  });

  it("leaves a malformed digest off the URL instead of sending it", () => {
    box.run(`hermes_release_report paused failed paused "x&k=updated" "$(printf 'sha256:%s' zz)"`);
    const logged = readFileSync(box.curlLog, "utf8");
    expect(logged).not.toContain("&i=");
    expect(logged).not.toContain("&ti=");
    expect(logged).toContain("&k=paused");
  });

  it("reads one field from a reply", () => {
    const result = box.run(`hermes_reply_field "$(printf 'action=roll\\nimage=${REPO}@${D2}\\n')" image`);
    expect(result.stdout.trim()).toBe(`${REPO}@${D2}`);
  });

  it("finds the registry digest of an image for the box's repo only", () => {
    box.writeBin(
      "docker",
      `printf '%s\\n' "other.example/x@${D1}" "${REPO}@${D2}"`
    );
    expect(box.run(`hermes_image_digest sha256:abc "${REPO}"`).stdout.trim()).toBe(D2);
    expect(box.run(`hermes_image_digest sha256:abc "ghcr.io/none/here"`).stdout.trim()).toBe("");
  });
});

describe("session survival shell", () => {
  let box: Sandbox;
  beforeEach(() => {
    box = sandbox();
  });
  afterEach(() => rmSync(box.dir, { recursive: true, force: true }));

  function seedDb(sessions: number | null, options: { corrupt?: boolean } = {}) {
    const volume = join(box.dir, "volume");
    mkdirSync(volume, { recursive: true });
    const dbPath = join(volume, "state.db");
    if (options.corrupt) {
      writeFileSync(dbPath, "this is not a sqlite database".repeat(100));
    } else if (sessions !== null) {
      const py = spawnSync(
        "python3",
        [
          "-c",
          `import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]);c.execute("create table sessions(id integer primary key)")\nc.executemany("insert into sessions(id) values (?)",[(i,) for i in range(${sessions})]);c.commit()`,
          dbPath,
        ],
        { encoding: "utf8" }
      );
      expect(py.status).toBe(0);
    }
    box.writeBin("docker", `printf '%s\\n' "/home/hermes/.hermes ${volume}"`);
    return volume;
  }

  const snapshot = () => box.run("hermes_sessions_snapshot agent-gateway").stdout.trim();

  it("counts sessions in a healthy state.db", () => {
    seedDb(7);
    expect(snapshot()).toBe("ok 7");
  });

  it("reports a corrupt database, a missing one, and an unreadable mount", () => {
    seedDb(null, { corrupt: true });
    expect(snapshot()).toBe("corrupt");
    rmSync(join(box.dir, "volume", "state.db"));
    seedDb(null);
    expect(snapshot()).toBe("missing");
    box.writeBin("docker", "exit 1");
    expect(snapshot()).toBe("unknown");
  });

  it.each([
    ["ok 50", "ok 50", 0],
    ["ok 50", "ok 60", 0],
    ["ok 50", "ok 46", 0], // within the allowed drop of 5
    ["ok 50", "ok 44", 1],
    ["ok 200", "ok 179", 1], // more than 10%
    ["ok 200", "ok 180", 0],
    ["ok 50", "ok 0", 1],
    ["ok 3", "ok 0", 0], // tiny counts: drop of 3 is under the floor of 5
    ["ok 50", "missing", 1],
    ["ok 50", "corrupt", 1],
    ["ok 50", "unknown", 0], // cannot read: does not block
    ["unknown", "ok 5", 0],
    ["missing", "missing", 0],
    ["corrupt", "corrupt", 0],
    ["unknown", "corrupt", 1],
  ])("survived(%s -> %s) exits %i", (before, after, expected) => {
    expect(box.run(`hermes_sessions_survived "${before}" "${after}"`).status).toBe(expected);
  });
});
