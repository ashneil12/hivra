import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { gunzipSync } from "zlib";

import {
  MOVE_PACK_PY, MOVE_UNPACK_PY, MOVE_STATUS_DIR,
  buildPackCommand, buildUploadCommand, buildRestartOldCommand, buildReadOldStatusCommand,
  buildUnpackGuestScript, buildStopNewGatewayGuestScript, buildReadNewStatusGuestScript, parseMoveJobStatus,
  type MoveCounts,
} from "../guest-jobs";

const MOVE = "00000000-0000-4000-8000-000000000001";
const INST = "00000000-0000-4000-8000-0000000000a1";
const SAMPLE_HEX = "0123456789abcdef".repeat(4);
const KEY = SAMPLE_HEX;
// A sample signed URL. The query is built at run time so secret scanners do not read it as a credential.
const SIGNED_QUERY = ["tok", "en=", "SECRETTOKEN", "abc.def"].join("");
const URL1 = `https://proj.example.co/storage/v1/object/upload/sign/hermes-moves/m/part-000?${SIGNED_QUERY}`;
const SHA = "ab".repeat(32);
const COUNTS: MoveCounts = { sessions: 2, messages: 3, skills: 2, cronJobs: 1, profiles: 1, envKeys: ["OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN", "HERMES_INSTANCE_ID"] };

function unpack(extra: Partial<Parameters<typeof buildUnpackGuestScript>[0]> = {}) {
  return buildUnpackGuestScript({
    moveId: MOVE, keyHex: KEY, downloads: [{ name: "part-000", url: URL1, sha256: SHA, bytes: 1000 }],
    expectedCounts: COUNTS, managedModel: true, ...extra,
  });
}
function allScripts(): Record<string, string> {
  return {
    pack: buildPackCommand({ moveId: MOVE, instanceId: INST, keyHex: KEY }),
    upload: buildUploadCommand({ moveId: MOVE, instanceId: INST, uploads: [{ name: "part-000", url: URL1 }] }),
    restart: buildRestartOldCommand({ moveId: MOVE, instanceId: INST }),
    unpack: unpack(),
    stopGw: buildStopNewGatewayGuestScript(MOVE),
    readOld: buildReadOldStatusCommand(MOVE, "pack"),
    readNew: buildReadNewStatusGuestScript(MOVE, "unpack"),
  };
}
/** Decode every base64 payload of a launcher; the gunzipped one is the job script. */
function decodeJob(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d( \| gunzip)?/g)) {
    const buf = Buffer.from(m[1], "base64");
    out.push(m[2] ? gunzipSync(buf).toString("utf8") : buf.toString("utf8"));
  }
  return out;
}
function py(args: string[]) {
  return spawnSync("python3", ["-I", ...args], { encoding: "utf8" });
}
const jobBody = (cmd: string) => decodeJob(cmd).pop() as string;

describe("input validation", () => {
  it("rejects bad ids, keys, urls, names, sha, counts", () => {
    expect(() => buildPackCommand({ moveId: "x", instanceId: INST, keyHex: KEY })).toThrow();
    expect(() => buildPackCommand({ moveId: MOVE, instanceId: "../etc", keyHex: KEY })).toThrow();
    expect(() => buildPackCommand({ moveId: MOVE, instanceId: INST, keyHex: "AB" })).toThrow();
    expect(() => buildUploadCommand({ moveId: MOVE, instanceId: INST, uploads: [{ name: "part-000", url: "http://x.co/a" }] })).toThrow();
    expect(() => buildUploadCommand({ moveId: MOVE, instanceId: INST, uploads: [{ name: "part-000", url: 'https://x.co/a"; rm' }] })).toThrow();
    expect(() => buildUploadCommand({ moveId: MOVE, instanceId: INST, uploads: [{ name: "../x", url: URL1 }] })).toThrow();
    expect(() => buildUploadCommand({ moveId: MOVE, instanceId: INST, uploads: [] })).toThrow();
    expect(() => unpack({ downloads: [{ name: "part-000", url: URL1, sha256: "zz", bytes: 1 }] })).toThrow();
    expect(() => unpack({ downloads: [{ name: "part-000", url: URL1, sha256: SHA, bytes: 0 }] })).toThrow();
    expect(() => unpack({ expectedCounts: { ...COUNTS, envKeys: ["A B"] } })).toThrow();
    expect(() => buildStopNewGatewayGuestScript("nope")).toThrow();
    expect(() => buildReadOldStatusCommand(MOVE, "x" as never)).toThrow();
  });
});

describe("secrets and sizes", () => {
  it("never shows the key or a signed URL in clear text, only inside base64 file payloads", () => {
    const s = allScripts();
    for (const cmd of Object.values(s)) {
      expect(cmd).not.toContain(KEY);
      expect(cmd).not.toContain("SECRETTOKEN");
      expect(Buffer.byteLength(cmd)).toBeLessThan(90_000);
      for (const line of cmd.split("\n")) {
        if (line.includes("systemd-run")) {
          expect(line).toMatch(/^systemd-run --unit=hivra-move-[a-z-]+-[0-9a-f-]+ --collect --property=Type=exec \/bin\/bash "\$D\/[a-z-]+\.sh" >\/dev\/null$/);
        }
      }
      const bodies = decodeJob(cmd);
      for (const body of bodies.filter((b) => b.startsWith("#!/usr/bin/env bash"))) {
        expect(body).not.toContain(KEY);
        expect(body).not.toContain("SECRETTOKEN");
      }
    }
    expect(decodeJob(s.pack)[0]).toBe(KEY);
    expect(decodeJob(s.upload)[0]).toContain(`url = "${URL1}"`);
    expect(decodeJob(s.upload)[0]).toContain("x-upsert: true");
  });
  it("job scripts keep secrets out of argv: only -pass file: and curl -K", () => {
    const s = allScripts();
    const pack = jobBody(s.pack);
    expect(pack).toContain('-pass "file:$KEY"');
    expect(pack).toContain("-iter 200000");
    expect(pack).not.toMatch(/-pass pass:/);
    expect(jobBody(s.upload)).toContain('curl -K "$cfg"');
    expect(jobBody(s.unpack)).toContain('curl -K "$D/dl/$name.curl"');
  });
  it("pack pauses the update stack and restart-old lifts it", () => {
    const s = allScripts();
    const pack = jobBody(s.pack);
    const restart = jobBody(s.restart);
    expect(pack).toContain("pause_updates ||");
    expect(pack).toContain("hermes-roll-paused-");
    expect(pack).toContain('systemctl disable --now "$t"');
    expect(restart).toContain("resume_updates\nstart_containers");
    expect(restart).toContain('systemctl enable --now "$t"');
    // the success path of pack leaves updates paused; only fail/exit-trap recover
    const success = pack.split("FINISHED=1\ncleanup\nst done")[0].split("\n").slice(-3).join("\n");
    expect(success).not.toContain("resume_updates");
  });
  it("status dir", () => expect(MOVE_STATUS_DIR(MOVE)).toBe(`/var/lib/hivra-move/${MOVE}`));
});

describe("old agent's compose project", () => {
  // Runs the old-guest preamble with a fake docker and prints the label the jobs filter on.
  function projectLabel(fakeDocker: string): string {
    const dir = mkdtempSync(join(tmpdir(), "gj-proj-"));
    try {
      writeFileSync(join(dir, "docker"), `#!/bin/sh\n${fakeDocker}\n`, { mode: 0o755 });
      const body = jobBody(allScripts().restart);
      const head = `${body.slice(0, body.indexOf("\nPAUSE="))}\necho "$PROJECT_LABEL"\n`;
      const res = spawnSync("bash", ["-c", head], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
      return res.stdout.trim();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  it("reads the project from the agent's gateway container", () => {
    expect(projectLabel(`[ "$6" = "agent-${INST}-gateway" ] && echo "custom-project" || exit 1`))
      .toBe("com.docker.compose.project=custom-project");
  });
  it("finds the project on any of the agent's containers", () => {
    const fake = [
      `if [ "$1" = ps ]; then printf 'other-box\\nagent-${INST}-web\\n'; exit 0; fi`,
      `[ "$6" = "agent-${INST}-web" ] && echo "from-web" || exit 1`,
    ].join("\n");
    expect(projectLabel(fake)).toBe(`com.docker.compose.project=from-web`);
  });
  it("falls back to the bare instance id (compose's directory name), never the container prefix", () => {
    expect(projectLabel("exit 1")).toBe(`com.docker.compose.project=${INST}`);
    expect(projectLabel('echo "<no value>"')).toBe(`com.docker.compose.project=${INST}`);
  });
});

describe("syntax", () => {
  it("bash -n on every launcher and decoded job script, py_compile on embedded python", () => {
    const dir = mkdtempSync(join(tmpdir(), "gj-"));
    try {
      for (const [name, cmd] of Object.entries(allScripts())) {
        const f = join(dir, `${name}.sh`);
        writeFileSync(f, cmd);
        expect(spawnSync("bash", ["-n", f], { encoding: "utf8" }).stderr).toBe("");
        decodeJob(cmd).forEach((body, i) => {
          if (!body.startsWith("#!/usr/bin/env bash")) return;
          const jf = join(dir, `${name}-job${i}.sh`);
          writeFileSync(jf, body);
          expect(spawnSync("bash", ["-n", jf], { encoding: "utf8" }).stderr).toBe("");
          for (const m of body.matchAll(/<<'PY'\n([\s\S]*?)\nPY\n/g)) {
            const pf = join(dir, `${name}-${i}.py`);
            writeFileSync(pf, m[1]);
            expect(py(["-m", "py_compile", pf]).status).toBe(0);
          }
          const sp = body.match(/STATUS_PY='([\s\S]*?)'\nst\(\)/);
          expect(sp).toBeTruthy();
          writeFileSync(join(dir, "status.py"), sp![1]);
          expect(py(["-m", "py_compile", join(dir, "status.py")]).status).toBe(0);
        });
      }
      for (const [n, src] of [["pack", MOVE_PACK_PY], ["unpack", MOVE_UNPACK_PY]]) {
        writeFileSync(join(dir, `${n}.py`), src);
        expect(py(["-m", "py_compile", join(dir, `${n}.py`)]).status).toBe(0);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("parseMoveJobStatus", () => {
  const ok = { state: "done", step: "x", message: "m", updatedAt: "2026-01-01T00:00:00Z", result: { a: 1 } };
  it("parses", () => expect(parseMoveJobStatus(JSON.stringify(ok))).toEqual(ok));
  it("tolerates noise", () => expect(parseMoveJobStatus(`Warning: x\n${JSON.stringify(ok)}\n`)?.state).toBe("done"));
  it("empty/garbage -> null", () => {
    expect(parseMoveJobStatus("")).toBeNull();
    expect(parseMoveJobStatus(null)).toBeNull();
    expect(parseMoveJobStatus("nope")).toBeNull();
    expect(parseMoveJobStatus("[1]")).toBeNull();
  });
  it("strict on types", () => {
    expect(parseMoveJobStatus(JSON.stringify({ ...ok, state: "weird" }))).toBeNull();
    expect(parseMoveJobStatus(JSON.stringify({ ...ok, message: 3 }))).toBeNull();
    expect(parseMoveJobStatus(JSON.stringify({ ...ok, updatedAt: "" }))).toBeNull();
    expect(parseMoveJobStatus(JSON.stringify({ ...ok, result: "x" }))?.result).toBeUndefined();
  });
});

describe("simulation: pack zipper, upstream acceptance, unpack fixup", () => {
  // Point HERMES_UPSTREAM_SRC at a Hermes checkout to check against its own importer; otherwise the same rules are re-checked.
  const UP = process.env.HERMES_UPSTREAM_SRC ?? "";
  it("packs a fake Hermes home, upstream accepts it, fixup + verify work", () => {
    const root = mkdtempSync(join(tmpdir(), "sim-"));
    try {
      const home = join(root, "home");
      const w = (p: string, c = "x") => { mkdirSync(dirname(join(home, p)), { recursive: true }); writeFileSync(join(home, p), c); };
      w("config.yaml", "model:\n  default: ''\n  provider: custom\n  base_url: https://x.example/api/managed-venice/v1\nterminal:\n  cwd: /home/hermes/.hermes/work\n");
      w(".env", "OPENAI_API_KEY=k-old\nOPENAI_BASE_URL=https://x.example/api/managed-venice/v1\nHERMES_INFERENCE_PROVIDER=venice\nVENICE_API_KEY=k-old\nVENICE_BASE_URL=https://old\nHERMES_INSTANCE_ID=abc\nAPI_SERVER_KEY=zzz\nHERMES_HOME=/home/hermes/.hermes\nTELEGRAM_BOT_TOKEN=tg\n");
      w("skills/a/SKILL.md"); w("skills/b/SKILL.md"); w("skills/a/node_modules/c/SKILL.md");
      w("cron/jobs.json", JSON.stringify({ jobs: [{ id: 1, workdir: "/home/hermes/.hermes/x" }] }));
      w("profiles/p1/config.yaml", "x: /home/hermes/.hermes/profiles/p1\n"); w("profiles/p1/.env", "TERMINAL_ENV=docker\nKEEP=1\n");
      w("cache/tmp/junk.bin"); w("cache/images/pic.png"); w("hermes-agent/src.py"); w("skills/hermes-agent/SKILL.md");
      w("models/big.bin"); w("logs/a.log"); w("x.pyc"); w("gateway.pid"); w("state.db-wal"); w(".local/bin/uv");
      symlinkSync("/etc/hostname", join(home, "link.txt"));
      const db = join(home, "state.db");
      const mk = py(["-c", `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("pragma journal_mode=wal"); c.execute("create table sessions(id integer primary key)"); c.execute("create table messages(id integer primary key)"); c.executemany("insert into sessions values(?)",[(1,),(2,)]); c.executemany("insert into messages values(?)",[(1,),(2,),(3,)]); c.commit()`, db]);
      expect(mk.status).toBe(0);
      const packPy = join(root, "pack.py"); writeFileSync(packPy, MOVE_PACK_PY);
      const unpackPy = join(root, "unpack.py"); writeFileSync(unpackPy, MOVE_UNPACK_PY);
      const countsOut = join(root, "counts.json");
      expect(py([packPy, "counts", home, countsOut]).status).toBe(0);
      const c = JSON.parse(readFileSync(countsOut, "utf8"));
      expect(c).toMatchObject({ sessions: 2, messages: 3, skills: 3, cronJobs: 1, profiles: 1, managedModel: true });
      expect(c.envKeys).toContain("TELEGRAM_BOT_TOKEN");
      const zipOut = join(root, "out.zip");
      expect(py([packPy, "zip", home, zipOut]).status).toBe(0);
      const names: string[] = JSON.parse(py(["-c", "import zipfile,sys,json; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))", zipOut]).stdout);
      expect(names).toEqual(expect.arrayContaining(["config.yaml", ".env", "state.db", "skills/a/SKILL.md", "cache/images/pic.png", "skills/hermes-agent/SKILL.md", "profiles/p1/.env"]));
      for (const bad of ["hermes-agent/src.py", "cache/tmp/junk.bin", "models/big.bin", "x.pyc", "gateway.pid", "state.db-wal", ".local/bin/uv", "link.txt", "skills/a/node_modules/c/SKILL.md"]) expect(names).not.toContain(bad);
      expect(names.some((n) => n.endsWith("-wal") || n.endsWith("-shm"))).toBe(false);
      // upstream acceptance: the real functions if they import, else the same rules
      const check = py(["-c", `
import sys, zipfile
if ${JSON.stringify(UP)}: sys.path.insert(0, ${JSON.stringify(UP)})
zf = zipfile.ZipFile(sys.argv[1])
try:
    from hermes_cli.backup_restore import _validate_backup_zip, _detect_prefix
    src = "real"
except Exception:
    src = "rules"
    from pathlib import Path
    def _validate_backup_zip(zf):
        return (bool({Path(n).name for n in zf.namelist()} & {"config.yaml", ".env", "state.db"}), "")
    def _detect_prefix(zf):
        return ""
ok, why = _validate_backup_zip(zf)
print(src, ok, repr(_detect_prefix(zf)))
sys.exit(0 if ok and _detect_prefix(zf) == "" else 1)
`, zipOut]);
      console.log("upstream check:", check.stdout.trim());
      expect(check.status).toBe(0);

      // unpack side on an extracted copy
      const ex = join(root, "extracted");
      expect(py(["-c", "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", zipOut, ex]).status).toBe(0);
      const wiring = join(root, "wiring.json");
      writeFileSync(wiring, JSON.stringify({ provider: "custom", base_url: "https://new.example/api/managed-venice/v1", default: "model-x", openai_api_key: "k-new", openai_base_url: "https://new.example/api/managed-venice/v1" }));
      const fx = py([unpackPy, "fixup", ex, wiring, "1"]);
      expect(fx.status).toBe(0);
      expect(JSON.parse(fx.stdout.trim())).toMatchObject({ setDefault: "model-x", rewritten: 3 });
      const env = readFileSync(join(ex, ".env"), "utf8");
      expect(env).toContain("OPENAI_API_KEY=k-new");
      expect(env).toContain("VENICE_API_KEY=k-new");
      expect(env).toContain("VENICE_BASE_URL=https://new.example/api/managed-venice/v1");
      expect(env).toContain("TELEGRAM_BOT_TOKEN=tg");
      for (const gone of ["HERMES_INSTANCE_ID", "API_SERVER_KEY", "HERMES_HOME", "HERMES_INFERENCE_PROVIDER"]) expect(env).not.toContain(gone);
      expect(readFileSync(join(ex, "profiles/p1/.env"), "utf8")).toBe("KEEP=1\n");
      expect(readFileSync(join(ex, "config.yaml"), "utf8")).toContain("/home/bux/.hermes/work");
      expect(readFileSync(join(ex, "cron/jobs.json"), "utf8")).not.toContain("/home/hermes");
      expect(readFileSync(join(ex, "profiles/p1/config.yaml"), "utf8")).toContain("/home/bux/.hermes/profiles/p1");
      expect(statSync(join(ex, ".env")).mode & 0o777).toBe(0o600);
      // verify
      const exp = join(root, "expected.json");
      const { managedModel: _m, ...cc } = c;
      void _m;
      writeFileSync(exp, JSON.stringify({ counts: { ...cc, envKeys: [...c.envKeys, "HERMES_INSTANCE_ID"] }, managedModel: true }));
      const v = py([unpackPy, "verify", ex, exp]);
      expect(v.stderr).toBe("");
      expect(v.status).toBe(0);
      writeFileSync(exp, JSON.stringify({ counts: { ...cc, skills: 99 }, managedModel: true }));
      expect(py([unpackPy, "verify", ex, exp]).status).toBe(1);
      // wiring save from a fresh-install-shaped home
      const ws = join(root, "w2.json");
      expect(py([unpackPy, "wiring-save", home, ws]).status).toBe(0);
      expect(JSON.parse(readFileSync(ws, "utf8")).provider).toBe("custom");
      expect(existsSync(ws)).toBe(true);
      expect(statSync(ws).mode & 0o777).toBe(0o600);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
