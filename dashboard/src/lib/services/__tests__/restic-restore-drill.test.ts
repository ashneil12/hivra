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

// Fake restic: one snapshot, and a restore that writes a webui-state tree with a
// WAL-mode SQLite database and a config file untouched for two days.
const FAKE_RESTIC = `#!/usr/bin/env python3
import os, sqlite3, sys, time
args = sys.argv[1:]
if "snapshots" in args:
    print('[{"short_id":"abcd1234","time":"2026-10-29T04:03:12.123456789+01:00"}]')
    raise SystemExit(0)
if "restore" in args:
    target = args[args.index("--target") + 1]
    include = args[args.index("--include") + 1]
    tree = target + include
    os.makedirs(os.path.join(tree, "profiles", "main"), exist_ok=True)
    db = os.path.join(tree, "profiles", "main", "state.db")
    if os.environ.get("FAKE_CORRUPT") == "1":
        with open(db, "wb") as handle:
            handle.write(b"SQLite format 3\\x00" + b"\\xff" * 4096)
    else:
        connection = sqlite3.connect(db)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)")
        connection.execute("INSERT INTO sessions VALUES ('s1', 'hello')")
        connection.commit()
    config = os.path.join(tree, "config.yaml")
    with open(config, "w") as handle:
        handle.write(os.environ["FAKE_CONFIG_BODY"])
    old = time.time() - 2 * 86400
    os.utime(config, (old, old))
    raise SystemExit(0)
raise SystemExit(2)
`;

// Fake qm: a running Hermes VM with a guest agent whose live volume maps to a
// fixture directory.
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

function runDrill(options: { corrupt?: boolean; liveConfig: string }) {
  const work = mkdtempSync(join(tmpdir(), "restore-drill-"));
  const bin = join(work, "bin");
  const live = join(work, "live");
  const root = join(work, "restore");
  mkdirSync(bin);
  mkdirSync(live);
  writeFileSync(join(bin, "restic"), FAKE_RESTIC);
  writeFileSync(join(bin, "qm"), FAKE_QM);
  chmodSync(join(bin, "restic"), 0o755);
  chmodSync(join(bin, "qm"), 0o755);
  writeFileSync(join(live, "config.yaml"), options.liveConfig);

  const script = buildRestoreDrillScript({ instanceId: INSTANCE_ID, vmid: 1138 });
  const result = spawnSync("bash", ["-c", `set -euo pipefail\n${script}`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RESTIC_PASSWORD: "test-only",
      RESTIC_CACHE_DIR: join(work, "cache"),
      HERMES_RESTORE_DRILL_ROOT: root,
      HERMES_RESTORE_DRILL_MIN_DISK_MB: "0",
      FAKE_CONFIG_BODY: "model: test\n",
      FAKE_LIVE_ROOT: live,
      FAKE_CORRUPT: options.corrupt ? "1" : "0",
    },
  });
  const leftovers = existsSync(root) ? readdirSync(root) : [];
  rmSync(work, { recursive: true, force: true });
  return { ...result, leftovers };
}

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
  });

  (canRunHostScript ? it : it.skip)(
    "restores, checks the database, matches the live box and removes the copy",
    () => {
      const run = runDrill({ liveConfig: "model: test\n" });
      expect(run.status).toBe(0);
      const drill = parseRestoreDrillResult(run.stdout);
      expect(drill).not.toBeNull();
      expect(drill).toMatchObject({
        pass: true,
        snapshot: "abcd1234",
        cleanup: "removed",
        compare: { status: "compared", sampled: 1, matched: 1, changed: 0, missing: 0 },
      });
      expect(drill!.databases).toEqual([
        { path: "profiles/main/state.db", ok: true, result: "ok" },
      ]);
      expect(run.leftovers).toEqual([]);
    }
  );

  (canRunHostScript ? it : it.skip)("fails on a corrupt database and still removes the copy", () => {
    const run = runDrill({ corrupt: true, liveConfig: "model: test\n" });
    expect(run.status).toBe(11);
    const drill = parseRestoreDrillResult(run.stdout);
    expect(drill?.pass).toBe(false);
    expect(drill?.databases[0]?.ok).toBe(false);
    expect(drill?.cleanup).toBe("removed");
    expect(run.leftovers).toEqual([]);
  });

  (canRunHostScript ? it : it.skip)("fails when no sampled file matches the live box", () => {
    const run = runDrill({ liveConfig: "model: changed\n" });
    expect(run.status).toBe(11);
    const drill = parseRestoreDrillResult(run.stdout);
    expect(drill?.pass).toBe(false);
    expect(drill?.compare).toMatchObject({ status: "compared", matched: 0, changed: 1 });
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
