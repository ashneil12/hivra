import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildRestoreDrillScript, parseRestoreDrillResult } from "@/lib/services/restic-restore-drill";

// The restore drill against a real restic binary and a disposable local repo:
// back up a webui-state mirror exactly as backup-vm-restic.sh does, delete the
// mirror, then let the drill restore the snapshot and check it. A fake restic
// proves the drill's logic; only a real one proves a snapshot comes back.
// CI installs a pinned restic (see dashboard-ci.yml); a developer machine
// without one skips this suite, CI fails it.

const INSTANCE_ID = "99999999-8888-7777-6666-555555555555";
const PASSWORD = "drill-test-password";

function hasTool(name: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;
}

const hasRestic = hasTool("restic");
const canRun =
  hasRestic && hasTool("bash") && hasTool("python3") && spawnSync("python3", ["-c", "import sqlite3"]).status === 0;
if (process.env.CI && !canRun) {
  throw new Error("CI must provide restic, bash and python3 with sqlite3 for the real restore drill");
}

// Only the host's VM tooling is faked: qm reads the "live box" from a fixture
// directory, df reports plenty of space and flock is a no-op on machines without it.
const FAKE_QM = `#!/usr/bin/env python3
import hashlib, json, os, sys
args = sys.argv[1:]
if args[:1] == ["config"]:
    print("agent: 1\\nipconfig0: ip=10.240.0.1/24")
elif args[:1] == ["status"]:
    print("status: running")
elif args[:2] == ["guest", "exec"]:
    paths = args[args.index("--", args.index("sha256sum")) + 1:]
    prefix = "/var/lib/docker/volumes/agent-${INSTANCE_ID}_webui-state/_data"
    lines = []
    for path in paths:
        local = os.environ["FAKE_LIVE_ROOT"] + path[len(prefix):]
        if os.path.isfile(local):
            lines.append(hashlib.sha256(open(local, "rb").read()).hexdigest() + "  " + path)
    print(json.dumps({"exited": 1, "exitcode": 0, "out-data": "\\n".join(lines) + "\\n"}))
else:
    raise SystemExit(2)
`;
const FAKE_DF = `#!/bin/sh
printf 'Avail\\n100000M\\n'
`;
const FAKE_FLOCK = `#!/bin/sh
exit 0
`;

type Fixture = { work: string; bin: string; repo: string; mirrorRoot: string; live: string; root: string };

function restic(fixture: Fixture, args: string[], password = PASSWORD): string {
  return execFileSync("restic", ["-r", fixture.repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, RESTIC_PASSWORD: password, RESTIC_CACHE_DIR: join(fixture.work, "cache") },
  });
}

// Build a webui-state tree like a Hermes box holds, back it up with real restic
// the way backup-vm-restic.sh does (same paths, --host and tag), then remove the
// mirror so the drill can only get the data back from the repo.
function backedUpFixture(): Fixture {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "restore-drill-real-")));
  const fixture: Fixture = {
    work,
    bin: join(work, "bin"),
    repo: join(work, "repo"),
    mirrorRoot: join(work, "mirror"),
    live: join(work, "live"),
    root: join(work, "restore"),
  };
  mkdirSync(fixture.bin);
  for (const [name, body] of Object.entries({ qm: FAKE_QM, df: FAKE_DF, flock: FAKE_FLOCK })) {
    writeFileSync(join(fixture.bin, name), body);
    chmodSync(join(fixture.bin, name), 0o755);
  }

  const state = join(fixture.mirrorRoot, INSTANCE_ID, "webui-state");
  const workspace = join(fixture.mirrorRoot, INSTANCE_ID, "webui-workspace");
  mkdirSync(join(state, "profiles", "main"), { recursive: true });
  mkdirSync(join(workspace, "project"), { recursive: true });
  execFileSync("python3", [
    "-c",
    // The live box never checkpoints before the copy: the committed table lives
    // only in the WAL, so the drill passes only if it restores the sidecar too.
    `import os, sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("PRAGMA journal_mode=WAL")
c.execute("PRAGMA wal_autocheckpoint=0")
c.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)")
c.executemany("INSERT INTO sessions VALUES (?, ?)", [("s%d" % i, "chat %d" % i * 20) for i in range(500)])
c.commit()
sys.stdout.flush()
os._exit(0)`,
    join(state, "profiles", "main", "state.db"),
  ]);
  const dbPath = join(state, "profiles", "main", "state.db");
  const mainOnly = join(work, "main-only.db");
  cpSync(dbPath, mainOnly);
  const mainTables = execFileSync("python3", [
    "-c",
    `import sqlite3, sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0])`,
    mainOnly,
  ]).toString().trim();
  if (mainTables !== "0" || statSync(dbPath + "-wal").size === 0) {
    throw new Error("fixture database was checkpointed; the WAL path would go untested");
  }
  rmSync(mainOnly);
  const stable = ["config.yaml", "profiles/main/SOUL.md", "profiles/main/memory.json"];
  writeFileSync(join(state, "config.yaml"), "model: test\nprovider: venice\n");
  writeFileSync(join(state, "profiles", "main", "SOUL.md"), "# Main profile\n");
  writeFileSync(join(state, "profiles", "main", "memory.json"), JSON.stringify({ notes: ["a", "b"] }));
  const old = new Date(Date.now() - 2 * 86_400_000);
  for (const rel of stable) utimesSync(join(state, rel), old, old);
  writeFileSync(join(workspace, "project", "README.md"), "workspace\n");

  // The live box: the same volume, as the guest still holds it after the backup.
  cpSync(state, fixture.live, { recursive: true, preserveTimestamps: true });

  restic(fixture, ["init"]);
  restic(fixture, ["backup", "--tag", "hermes-daily", "--tag", `instance:${INSTANCE_ID}`, "--host", INSTANCE_ID, state, workspace]);
  rmSync(join(fixture.mirrorRoot, INSTANCE_ID), { recursive: true, force: true });
  return fixture;
}

function runDrill(fixture: Fixture, password = PASSWORD) {
  const script = buildRestoreDrillScript({ instanceId: INSTANCE_ID, vmid: 4242 });
  const result = spawnSync("bash", ["-c", `set -euo pipefail\n${script}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      RESTIC_PASSWORD: password,
      RESTIC_CACHE_DIR: join(fixture.work, "cache"),
      HERMES_RESTIC_REPO_OVERRIDE: fixture.repo,
      HERMES_RESTIC_MIRROR_ROOT: fixture.mirrorRoot,
      HERMES_RESTORE_DRILL_ROOT: fixture.root,
      HERMES_RESTIC_LOCK_DIR: fixture.work,
      FAKE_LIVE_ROOT: fixture.live,
    },
  });
  const leftovers = existsSync(fixture.root) ? readdirSync(fixture.root) : [];
  return { ...result, leftovers, drill: parseRestoreDrillResult(result.stdout ?? "") };
}

const realIt = canRun ? it : it.skip;

describe("restic restore drill against a real restic repo", () => {
  let fixture: Fixture | null = null;
  afterEach(() => {
    if (fixture) rmSync(fixture.work, { recursive: true, force: true });
    fixture = null;
  });

  realIt("restores the latest snapshot, checks it and removes the copy", () => {
    fixture = backedUpFixture();
    const snapshots = JSON.parse(restic(fixture, ["snapshots", "--json"])) as { short_id: string }[];
    const run = runDrill(fixture);
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: "" });
    expect(run.drill).toMatchObject({
      pass: true,
      instance: INSTANCE_ID,
      snapshot: snapshots[0].short_id,
      cleanup: "removed",
      // config.yaml, SOUL.md, memory.json, state.db and its -wal and -shm sidecars.
      files: 6,
      databases_total: 1,
      databases: [{ path: "profiles/main/state.db", ok: true, result: "ok", tables: 1 }],
      compare: { status: "compared", sampled: 3, matched: 3, changed: 0, missing: 0 },
    });
    expect(run.stdout).toContain(`RESTORE_DRILL_OK instance=${INSTANCE_ID}`);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  realIt("fails when the repo password is wrong", () => {
    fixture = backedUpFixture();
    const run = runDrill(fixture, "not-the-password");
    expect(run.status).toBe(7);
    expect(run.stderr).toContain("RESTORE_DRILL_ABORT reason=repo_unreadable");
    expect(run.drill).toBeNull();
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  realIt("fails when the snapshot's data is damaged in the repo", () => {
    fixture = backedUpFixture();
    // Corrupt every data pack: the tree metadata still lists the files, but
    // their content no longer decrypts, so a backup that "succeeded" must not pass.
    const dataDir = join(fixture.repo, "data");
    for (const shard of readdirSync(dataDir)) {
      for (const pack of readdirSync(join(dataDir, shard))) {
        const path = join(dataDir, shard, pack);
        chmodSync(path, 0o644);
        writeFileSync(path, Buffer.alloc(64, 0xff));
      }
    }
    rmSync(join(fixture.work, "cache"), { recursive: true, force: true });
    const run = runDrill(fixture);
    expect(run.status).not.toBe(0);
    expect(run.drill?.pass ?? false).toBe(false);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  realIt("fails when the live box no longer matches the restored files", () => {
    fixture = backedUpFixture();
    writeFileSync(join(fixture.live, "config.yaml"), "model: changed\n");
    writeFileSync(join(fixture.live, "profiles", "main", "SOUL.md"), "# changed\n");
    const run = runDrill(fixture);
    expect(run.status).toBe(11);
    expect(run.drill).toMatchObject({ pass: false, compare: { status: "compared", sampled: 3, matched: 1, changed: 2 } });
    expect(run.leftovers).toEqual([]);
  }, 60_000);
});
