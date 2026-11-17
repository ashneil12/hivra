/**
 * Shell-level encrypt -> store -> decrypt round trip for the cold-storage ops
 * scripts, with fake qm / vzdump / ssh / rsync shims and a directory standing
 * in for the Storage Box. Needs the real `age` and `age-keygen`; skipped when
 * they are not installed. Keys are generated per run and never committed.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const opsDir = path.join(__dirname, "../../scripts/ops");
const have = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;
const HAVE_AGE = have("age") && have("age-keygen");
const describeIfAge = HAVE_AGE ? describe : describe.skip;

const INSTANCE = "00000000-0000-4000-8000-000000000001";
const sha = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

const SHIMS: Record<string, string> = {
  qm: `#!/bin/bash
echo "qm $*" >> "$SHIM_LOG"
case "$1" in
  config) exit "\${QM_CONFIG_RC:-0}" ;;
  status) echo "status: running" ;;
  list) echo "VMID NAME STATUS" ;;
  clone) echo "reached qm clone" >&2; exit 42 ;;
esac
exit 0
`,
  vzdump: `#!/bin/bash
echo "vzdump $*" >> "$SHIM_LOG"
vmid="$1"; dir=""
while [ $# -gt 0 ]; do [ "$1" = "--dumpdir" ] && dir="$2"; shift; done
printf 'FAKE-VZDUMP-PAYLOAD-%s' "$vmid" > "$dir/vzdump-qemu-$vmid-fake.vma.zst"
`,
  ssh: `#!/bin/bash
echo "ssh $*" >> "$SHIM_LOG"
args=(); for a in "$@"; do case "$a" in -*) ;; *) args+=("$a") ;; esac; done
[ "\${args[0]}" = cold ] || exit 255
cd "$STORE" && eval "\${args[1]}"
`,
  rsync: `#!/bin/bash
echo "rsync $*" >> "$SHIM_LOG"
src="\${@: -2:1}"; dst="\${@: -1}"
map() { case "$1" in cold:*) echo "$STORE/\${1#cold:}" ;; *) echo "$1" ;; esac; }
s="$(map "$src")"; d="$(map "$dst")"
mkdir -p "$(dirname "$d")"
if [[ "$src" == */ ]]; then mkdir -p "$d"; cp -r "$s/." "$d" 2>/dev/null || exit 23; else cp "$s" "$d" || exit 23; fi
`,
};

type Env = { root: string; bin: string; store: string; log: string; work: string };

function setup(opts: { withAge: boolean }): Env {
  const root = mkdtempSync(path.join(tmpdir(), "enc-roundtrip-"));
  const bin = path.join(root, "bin");
  const store = path.join(root, "store");
  const work = path.join(root, "work");
  for (const d of [bin, store, work]) mkdirSync(d);
  for (const [name, body] of Object.entries(SHIMS)) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  // A PATH that holds the shims plus only the tools the scripts need, so a run
  // without `age` is a real "age not installed".
  const tools = [
    "bash", "env", "awk", "sed", "grep", "find", "head", "tail", "sort", "stat", "sha256sum", "date",
    "cat", "mktemp", "rm", "mkdir", "basename", "dirname", "df", "cp", "mv", "hostname", "tr", "ls",
    "python3", "numfmt", "seq", "sleep", "timeout", "printf", "tee", "cut", "wc", "uname", "id",
  ];
  if (opts.withAge) tools.push("age", "age-keygen");
  for (const t of tools) {
    const found = spawnSync("sh", ["-c", `command -v ${t}`]).stdout.toString().trim();
    if (found && !existsSync(path.join(bin, t))) symlinkSync(found, path.join(bin, t));
  }
  return { root, bin, store, log: path.join(root, "shim.log"), work };
}

function run(env: Env, script: string, args: string[], extra: Record<string, string> = {}) {
  writeFileSync(env.log, "");
  return spawnSync("bash", [path.join(opsDir, script), ...args], {
    encoding: "utf8",
    env: {
      PATH: env.bin,
      HOME: env.root,
      SHIM_LOG: env.log,
      STORE: env.store,
      TMPDIR: env.root,
      ...extra,
    } as unknown as NodeJS.ProcessEnv,
  });
}

function keypair(root: string) {
  const out = spawnSync("age-keygen", [], { encoding: "utf8" });
  const identity = out.stdout.split("\n").find((l) => l.startsWith("AGE-SECRET-KEY-1")) as string;
  const recipient = (out.stdout.match(/public key: (age1[0-9a-z]+)/) as RegExpMatchArray)[1];
  const idFile = path.join(root, "identity.txt");
  writeFileSync(idFile, `${identity}\n`, { mode: 0o600 });
  return { recipient, idFile };
}

const dailyEnv = (env: Env, extra: Record<string, string> = {}) => ({
  HERMES_DAILY_BACKUP_SCRATCH_ROOTS: env.work,
  HERMES_DAILY_BACKUP_MIN_SCRATCH_MB: "1",
  HERMES_DAILY_BACKUP_MIN_HOST_HEADROOM_MB: "0",
  ...extra,
});
const dailyArgs = ["101", INSTANCE, "paid", "--apply"];
const listAll = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? listAll(path.join(dir, e.name)).map((f) => path.join(e.name, f)) : [e.name]
      )
    : [];

describeIfAge("backup-vm-daily.sh encryption round trip", () => {
  const roots: Env[] = [];
  const mk = (withAge = true) => {
    const e = setup({ withAge });
    roots.push(e);
    return e;
  };
  afterAll(() => roots.forEach((e) => rmSync(e.root, { recursive: true, force: true })));

  it("switch off: uploads the plain archive and a manifest without encryption fields", () => {
    const env = mk();
    const r = run(env, "backup-vm-daily.sh", dailyArgs, dailyEnv(env));
    expect(r.status).toBe(0);
    const files = listAll(env.store);
    expect(files.some((f) => f.endsWith(".vma.zst"))).toBe(true);
    expect(files.some((f) => f.endsWith(".age"))).toBe(false);
    const manifest = files.find((f) => f.startsWith("daily-meta"))!;
    const text = readFileSync(path.join(env.store, manifest), "utf8");
    expect(text).not.toContain("encryption");
    expect(text).not.toContain("plain_sha256");
    expect(JSON.parse(text).backup_sha256).toBe(sha("FAKE-VZDUMP-PAYLOAD-101"));
  });

  it("switch on: uploads only the .age file, hashes the encrypted file, and decrypts back", () => {
    const env = mk();
    const { recipient, idFile } = keypair(env.root);
    const r = run(env, "backup-vm-daily.sh", dailyArgs, dailyEnv(env, {
      HERMES_BACKUP_ENCRYPTION: "on",
      HERMES_BACKUP_AGE_RECIPIENT: recipient,
    }));
    expect(r.status).toBe(0);
    const files = listAll(env.store);
    expect(files.filter((f) => f.endsWith(".vma.zst"))).toHaveLength(0);
    const enc = files.find((f) => f.endsWith(".vma.zst.age"))!;
    expect(enc).toBeDefined();
    const manifestFile = files.find((f) => f.startsWith("daily-meta"))!;
    const manifest = JSON.parse(readFileSync(path.join(env.store, manifestFile), "utf8"));
    expect(manifest.encryption).toBe("age");
    expect(manifest.backup_path).toBe(enc);
    const encBytes = readFileSync(path.join(env.store, enc));
    expect(manifest.backup_sha256).toBe(sha(encBytes));
    expect(manifest.backup_size_bytes).toBe(encBytes.length);
    expect(manifest.plain_sha256).toBe(sha("FAKE-VZDUMP-PAYLOAD-101"));
    // the secret never reached the script, and the plaintext is not on scratch
    expect(r.stdout + r.stderr).not.toContain("AGE-SECRET-KEY");
    expect(listAll(env.work)).toEqual([]);
    const dec = spawnSync("age", ["-d", "-i", idFile, path.join(env.store, enc)], { encoding: "utf8" });
    expect(dec.stdout).toBe("FAKE-VZDUMP-PAYLOAD-101");
  });

  it("switch on, age missing: refuses with the distinct code before vzdump", () => {
    const env = mk(false);
    const r = run(env, "backup-vm-daily.sh", dailyArgs, dailyEnv(env, {
      HERMES_BACKUP_ENCRYPTION: "on",
      HERMES_BACKUP_AGE_RECIPIENT: `age1${"q".repeat(58)}`,
    }));
    expect(r.status).toBe(7);
    expect(r.stderr).toContain("REFUSING_BACKUP_NO_AGE");
    expect(readFileSync(env.log, "utf8")).not.toContain("vzdump");
    expect(listAll(env.store)).toEqual([]);
  });

  it.each([["missing", ""], ["invalid", "age1nope"]])(
    "switch on, recipient %s: refuses before vzdump and uploads nothing",
    (_n, recipient) => {
      const env = mk();
      const r = run(env, "backup-vm-daily.sh", dailyArgs, dailyEnv(env, {
        HERMES_BACKUP_ENCRYPTION: "on",
        HERMES_BACKUP_AGE_RECIPIENT: recipient,
      }));
      expect(r.status).toBe(8);
      expect(r.stderr).toContain("REFUSING_BACKUP_BAD_AGE_RECIPIENT");
      expect(readFileSync(env.log, "utf8")).not.toContain("vzdump");
      expect(listAll(env.store)).toEqual([]);
    }
  );

  it("retention deletes the right .age archive and its manifest", () => {
    const env = mk();
    const { recipient } = keypair(env.root);
    const old = `daily/paid/${INSTANCE}/vzdump-qemu-101-20250101T000000Z.vma.zst.age`;
    mkdirSync(path.join(env.store, path.dirname(old)), { recursive: true });
    mkdirSync(path.join(env.store, "daily-meta", INSTANCE), { recursive: true });
    writeFileSync(path.join(env.store, old), "old");
    for (let i = 1; i <= 7; i++) {
      const ts = `2025010${i}T000000Z`;
      const p = i === 1 ? old : `daily/paid/${INSTANCE}/vzdump-qemu-101-${ts}.vma.zst.age`;
      writeFileSync(path.join(env.store, p), "x");
      writeFileSync(path.join(env.store, "daily-meta", INSTANCE, `${ts}.json`), JSON.stringify({ backup_path: p }));
    }
    const r = run(env, "backup-vm-daily.sh", dailyArgs, dailyEnv(env, {
      HERMES_BACKUP_ENCRYPTION: "on",
      HERMES_BACKUP_AGE_RECIPIENT: recipient,
    }));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`RETENTION_DELETED manifest=daily-meta/${INSTANCE}/20250101T000000Z.json archive=${old}`);
    expect(existsSync(path.join(env.store, old))).toBe(false);
    expect(existsSync(path.join(env.store, "daily-meta", INSTANCE, "20250101T000000Z.json"))).toBe(false);
    expect(listAll(env.store).filter((f) => f.endsWith(".vma.zst.age"))).toHaveLength(7);
  });
});

describeIfAge("restore-vm-cold.sh decrypt path", () => {
  const roots: Env[] = [];
  afterAll(() => roots.forEach((e) => rmSync(e.root, { recursive: true, force: true })));
  const TS = "20260101T000000Z";
  const PAYLOAD = "FAKE-TAR-ZST-PAYLOAD";

  function stage(opts: { encrypted: boolean; plainShaInManifest?: string }) {
    const env = setup({ withAge: true });
    roots.push(env);
    const { recipient, idFile } = keypair(env.root);
    const dir = path.join(env.store, "free", INSTANCE);
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(env.store, "meta", INSTANCE), { recursive: true });
    const plainFile = path.join(env.root, "plain.bin");
    writeFileSync(plainFile, PAYLOAD);
    let name = `data-${TS}.tar.zst`;
    let storedSha = sha(PAYLOAD);
    const manifest: Record<string, unknown> = { schema_version: 1, instance_id: INSTANCE };
    if (opts.encrypted) {
      name += ".age";
      spawnSync("age", ["-r", recipient, "-o", path.join(dir, name), plainFile]);
      storedSha = sha(readFileSync(path.join(dir, name)));
      manifest.encryption = "age";
      manifest.plain_sha256 = opts.plainShaInManifest ?? sha(PAYLOAD);
    } else {
      writeFileSync(path.join(dir, name), PAYLOAD);
    }
    writeFileSync(path.join(env.store, "meta", INSTANCE, `${TS}.json`), JSON.stringify(manifest));
    const args = [INSTANCE, `free/${INSTANCE}/${name}`, storedSha, "555", "10.0.0.5", "10.0.0.1", "9000"];
    return { env, idFile, args, name, storedSha };
  }
  const restoreRun = (env: Env, args: string[], extra: Record<string, string> = {}) =>
    run(env, "restore-vm-cold.sh", args, { QM_CONFIG_RC: "1", ...extra });

  it("plain archive: unchanged path, reaches the clone step without age or an identity", () => {
    const s = stage({ encrypted: false });
    const r = restoreRun(s.env, s.args);
    expect(r.status).toBe(42);
    expect(r.stderr).toContain("reached qm clone");
    expect(r.stdout).not.toContain("decrypt");
  });

  it("encrypted archive: verifies sha, decrypts, verifies plain sha, then reaches the clone step", () => {
    const s = stage({ encrypted: true });
    const r = restoreRun(s.env, s.args, { HERMES_BACKUP_AGE_IDENTITY_FILE: s.idFile });
    expect(r.stdout).toContain("step 2b/6: decrypt age archive");
    expect(r.stdout).toMatch(/decrypted; plain sha256:[0-9a-f]{16}… verified/);
    expect(r.status).toBe(42);
    expect(r.stdout + r.stderr).not.toContain("AGE-SECRET-KEY");
  });

  it("encrypted archive without an identity: exit 6 with a clear reason, nothing cloned", () => {
    const s = stage({ encrypted: true });
    const r = restoreRun(s.env, s.args);
    expect(r.status).toBe(6);
    expect(r.stderr).toContain("REFUSING_RESTORE_NO_AGE_IDENTITY");
    expect(readFileSync(s.env.log, "utf8")).not.toContain("qm clone");
    expect(readFileSync(s.env.log, "utf8")).not.toContain("rsync");
  });

  it("encrypted archive with age missing: exit 6, nothing cloned", () => {
    const s = stage({ encrypted: true });
    rmSync(path.join(s.env.bin, "age"));
    const r = restoreRun(s.env, s.args, { HERMES_BACKUP_AGE_IDENTITY_FILE: s.idFile });
    expect(r.status).toBe(6);
    expect(r.stderr).toContain("REFUSING_RESTORE_NO_AGE");
    expect(readFileSync(s.env.log, "utf8")).not.toContain("qm clone");
  });

  it("wrong identity: decrypt fails, exit 6, nothing cloned", () => {
    const s = stage({ encrypted: true });
    const otherDir = path.join(s.env.root, "other");
    mkdirSync(otherDir);
    const other = keypair(otherDir);
    const r = restoreRun(s.env, s.args, { HERMES_BACKUP_AGE_IDENTITY_FILE: other.idFile });
    expect(r.status).toBe(6);
    expect(r.stderr).toContain("age decrypt failed");
    expect(readFileSync(s.env.log, "utf8")).not.toContain("qm clone");
  });

  it("plain sha mismatch after decrypt: exit 6, nothing cloned", () => {
    const s = stage({ encrypted: true, plainShaInManifest: "0".repeat(64) });
    const r = restoreRun(s.env, s.args, { HERMES_BACKUP_AGE_IDENTITY_FILE: s.idFile });
    expect(r.status).toBe(6);
    expect(r.stderr).toContain("PLAIN SHA MISMATCH");
    expect(readFileSync(s.env.log, "utf8")).not.toContain("qm clone");
  });

  it("encrypted file sha mismatch is caught before decrypting", () => {
    const s = stage({ encrypted: true });
    const args = [...s.args];
    args[2] = "f".repeat(64);
    const r = restoreRun(s.env, args, { HERMES_BACKUP_AGE_IDENTITY_FILE: s.idFile });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("SHA MISMATCH");
    expect(r.stdout).not.toContain("decrypt age archive");
  });
});
