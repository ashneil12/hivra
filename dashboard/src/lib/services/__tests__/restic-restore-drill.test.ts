import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRestoreDrillScript,
  parseRestoreDrillResult,
} from "@/lib/services/restic-restore-drill";

const INSTANCE_ID = "11111111-2222-3333-4444-555555555555";

function hasTool(name: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;
}

const canRunHostScript =
  hasTool("bash") &&
  hasTool("python3") &&
  spawnSync("python3", ["-c", "import sqlite3"]).status === 0;

// Fake restic: one snapshot, a restore size, and a restore that writes a
// webui-state tree. FAKE_DB picks the database: a WAL-mode one with a table,
// a corrupt file, an empty file, or none.
const FAKE_RESTIC = `#!/usr/bin/env python3
import json, os, sqlite3, sys, time
args = sys.argv[1:]
if "snapshots" in args:
    print(json.dumps([{"short_id": "abcd1234", "time": os.environ["FAKE_SNAPSHOT_TIME"]}]))
    raise SystemExit(0)
if "stats" in args:
    print(json.dumps({"total_size": int(os.environ["FAKE_RESTORE_BYTES"]), "total_file_count": 2}))
    raise SystemExit(0)
if "restore" in args:
    target = args[args.index("--target") + 1]
    include = args[args.index("--include") + 1]
    tree = target + include
    os.makedirs(os.path.join(tree, "profiles", "main"), exist_ok=True)
    db = os.path.join(tree, "profiles", "main", "state.db")
    kind = os.environ["FAKE_DB"]
    if kind == "corrupt":
        with open(db, "wb") as handle:
            handle.write(b"SQLite format 3\\x00" + b"\\xff" * 4096)
    elif kind == "empty":
        open(db, "wb").close()
    elif kind == "good":
        connection = sqlite3.connect(db)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)")
        connection.execute("INSERT INTO sessions VALUES ('s1', 'hello')")
        connection.commit()
    config = os.path.join(tree, "config.yaml")
    with open(config, "w") as handle:
        handle.write("model: test\\n")
    old = time.time() - 2 * 86400
    os.utime(config, (old, old))
    raise SystemExit(0)
raise SystemExit(2)
`;

// Fake qm: a Hermes VM with a guest agent whose live volume maps to a fixture
// directory. FAKE_VM_STATUS sets what qm status reports.
const FAKE_QM = `#!/usr/bin/env python3
import hashlib, json, os, sys
args = sys.argv[1:]
if args[:1] == ["config"]:
    print("agent: 1\\nipconfig0: ip=10.240.0.1/24")
elif args[:1] == ["status"]:
    print("status: " + os.environ["FAKE_VM_STATUS"])
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

// Linux tools the host has that a developer machine may not.
const FAKE_DF = `#!/bin/sh
printf 'Avail\\n%sM\\n' "$FAKE_AVAIL_MB"
`;
const FAKE_FLOCK = `#!/bin/sh
exit 0
`;

type DrillOptions = {
  db?: "good" | "corrupt" | "empty" | "none";
  liveConfig?: string;
  vmStatus?: string;
  snapshotTime?: string;
  minDiskMb?: number;
  availMb?: number;
  restoreBytes?: number;
};

function runDrill(options: DrillOptions = {}) {
  const work = mkdtempSync(join(tmpdir(), "restore-drill-"));
  const bin = join(work, "bin");
  const live = join(work, "live");
  const root = join(work, "restore");
  mkdirSync(bin);
  mkdirSync(live);
  for (const [name, body] of Object.entries({ restic: FAKE_RESTIC, qm: FAKE_QM, df: FAKE_DF, flock: FAKE_FLOCK })) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(live, "config.yaml"), options.liveConfig ?? "model: test\n");

  const script = buildRestoreDrillScript({ instanceId: INSTANCE_ID, vmid: 1138 });
  const result = spawnSync("bash", ["-c", `set -euo pipefail\n${script}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RESTIC_PASSWORD: "test-only",
      RESTIC_CACHE_DIR: join(work, "cache"),
      HERMES_RESTORE_DRILL_ROOT: root,
      HERMES_RESTIC_LOCK_DIR: work,
      HERMES_RESTORE_DRILL_MIN_DISK_MB: String(options.minDiskMb ?? 0),
      FAKE_AVAIL_MB: String(options.availMb ?? 100000),
      FAKE_RESTORE_BYTES: String(options.restoreBytes ?? 4096),
      FAKE_SNAPSHOT_TIME: options.snapshotTime ?? "2026-10-29T04:03:12.123456789+01:00",
      FAKE_DB: options.db ?? "good",
      FAKE_VM_STATUS: options.vmStatus ?? "running",
      FAKE_LIVE_ROOT: live,
    },
  });
  const leftovers = existsSync(root) ? readdirSync(root) : [];
  rmSync(work, { recursive: true, force: true });
  return { ...result, leftovers, drill: parseRestoreDrillResult(result.stdout ?? "") };
}

const hostIt = canRunHostScript ? it : it.skip;

describe("restic restore drill host script", () => {
  it("refuses an unsafe instance id or vmid", () => {
    expect(() => buildRestoreDrillScript({ instanceId: "x; rm -rf /", vmid: 1 })).toThrow();
    expect(() => buildRestoreDrillScript({ instanceId: INSTANCE_ID, vmid: 0 })).toThrow();
    expect(() => buildRestoreDrillScript({ instanceId: INSTANCE_ID, vmid: 1.5 })).toThrow();
  });

  it("is valid bash and never writes to the guest or the repo", () => {
    const script = buildRestoreDrillScript({ instanceId: INSTANCE_ID, vmid: 1138 });
    if (hasTool("bash")) execFileSync("bash", ["-n", "-c", script]);
    expect(script).toContain(`restic -r "$REPO" restore`);
    expect(script).not.toMatch(/restic -r "\$REPO" (backup|forget|prune|init|unlock)/);
    expect(script).not.toContain("ssh ");
    expect(script).not.toContain("rsync");
    expect(script).toContain('"$RESTORE_ROOT"/"$INSTANCE_ID"-drill-*) rm -rf -- "$STAGE"');
    // Shares the backup's per-instance lock so a drill never races a prune.
    expect(script).toContain("/hermes-restic-$INSTANCE_ID.lock");
  });

  hostIt("restores, checks the database, matches the live box and removes the copy", () => {
    const run = runDrill();
    expect(run.status).toBe(0);
    expect(run.drill).toMatchObject({
      pass: true,
      snapshot: "abcd1234",
      cleanup: "removed",
      databases_total: 1,
      compare: { status: "compared", sampled: 1, matched: 1, changed: 0, missing: 0 },
    });
    expect(run.drill!.databases).toEqual([
      { path: "profiles/main/state.db", ok: true, result: "ok", tables: 1 },
    ]);
    expect(run.leftovers).toEqual([]);
  });

  hostIt("reads restic timestamps with any number of fractional digits", () => {
    for (const time of ["2026-10-29T04:03:12.1+01:00", "2026-10-29T04:03:12.12345Z", "2026-10-29T04:03:12Z"]) {
      const run = runDrill({ snapshotTime: time });
      expect({ time, status: run.status, pass: run.drill?.pass }).toEqual({ time, status: 0, pass: true });
    }
  });

  hostIt("fails on a corrupt database and still removes the copy", () => {
    const run = runDrill({ db: "corrupt" });
    expect(run.status).toBe(11);
    expect(run.drill?.pass).toBe(false);
    expect(run.drill?.databases[0]?.ok).toBe(false);
    expect(run.drill?.cleanup).toBe("removed");
    expect(run.leftovers).toEqual([]);
  });

  hostIt("fails when the snapshot holds no database, or only an empty one", () => {
    const none = runDrill({ db: "none" });
    expect(none.status).toBe(11);
    expect(none.drill).toMatchObject({ pass: false, databases_total: 0, databases: [] });

    const empty = runDrill({ db: "empty" });
    expect(empty.status).toBe(11);
    expect(empty.drill?.databases[0]).toMatchObject({ ok: false, result: "no tables" });
  });

  hostIt("fails when the sampled files do not match the live box", () => {
    const run = runDrill({ liveConfig: "model: changed\n" });
    expect(run.status).toBe(11);
    expect(run.drill?.pass).toBe(false);
    expect(run.drill?.compare).toMatchObject({ status: "compared", matched: 0, changed: 1 });
  });

  hostIt("fails, rather than passes, when the live comparison cannot run", () => {
    const run = runDrill({ vmStatus: "stopped" });
    expect(run.status).toBe(11);
    expect(run.drill?.pass).toBe(false);
    expect(run.drill?.compare.status).toBe("skipped:vm_not_running");
    expect(run.leftovers).toEqual([]);
  });

  hostIt("refuses a restore that would not fit on the host disk", () => {
    const run = runDrill({ minDiskMb: 8000, availMb: 9000, restoreBytes: 2 * 1024 * 1024 * 1024 });
    expect(run.status).toBe(9);
    expect(run.stderr).toContain("RESTORE_DRILL_ABORT reason=restore_too_large");
    expect(run.drill).toBeNull();
    expect(run.leftovers).toEqual([]);
  });

  hostIt("refuses to start when the host disk is below the floor", () => {
    const run = runDrill({ minDiskMb: 8000, availMb: 500 });
    expect(run.status).toBe(9);
    expect(run.stderr).toContain("low_host_disk_avail_mb_500");
  });

  it("reads only a well-formed result line", () => {
    expect(parseRestoreDrillResult("noise\n")).toBeNull();
    expect(parseRestoreDrillResult("RESTORE_DRILL_RESULT {not json\n")).toBeNull();
    expect(parseRestoreDrillResult('RESTORE_DRILL_RESULT {"pass":true,"files":3}\n')).toMatchObject({
      pass: true,
      files: 3,
    });
  });
});
