/**
 * Shell-level test for scripts/ops/reencrypt-cold-archive.sh with fake ssh / rsync
 * shims over a directory standing in for the Storage Box, and the real `age`.
 * Skipped when age / age-keygen are not installed. Keys are generated per run.
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

const script = path.join(__dirname, "../../scripts/ops/reencrypt-cold-archive.sh");
const have = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;
const describeIfAge = have("age") && have("age-keygen") ? describe : describe.skip;

const INSTANCE = "00000000-0000-4000-8000-000000000001";
const TS = "20260101T000000Z";
const PLAIN = `free/${INSTANCE}/data-${TS}.tar.zst`;
const ENC = `${PLAIN}.age`;
const MANIFEST = `meta/${INSTANCE}/${TS}.json`;
const PAYLOAD = "FAKE-COLD-ARCHIVE-PAYLOAD";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const SHIMS: Record<string, string> = {
  ssh: `#!/bin/bash
echo "ssh $*" >> "$SHIM_LOG"
args=(); for a in "$@"; do case "$a" in -*) ;; *) args+=("$a") ;; esac; done
[ "\${args[0]}" = cold ] || exit 255
cd "$STORE" && eval "\${args[1]}"
`,
  rsync: `#!/bin/bash
echo "rsync $*" >> "$SHIM_LOG"
src="\${@: -2:1}"; dst="\${@: -1}"
if [ -n "$FAIL_UPLOAD" ] && [[ "$dst" == cold:*.age ]]; then
  head -c 3 "$src" > "$STORE/\${dst#cold:}"; exit 30
fi
map() { case "$1" in cold:*) echo "$STORE/\${1#cold:}" ;; *) echo "$1" ;; esac; }
s="$(map "$src")"; d="$(map "$dst")"
mkdir -p "$(dirname "$d")"
cp "$s" "$d" || exit 23
`,
};

type Env = { root: string; bin: string; store: string; log: string; recipient: string; idFile: string };
const envs: Env[] = [];

function setup(withAge = true): Env {
  const root = mkdtempSync(path.join(tmpdir(), "reenc-"));
  envs.push({} as Env);
  const bin = path.join(root, "bin");
  const store = path.join(root, "store");
  mkdirSync(bin);
  mkdirSync(store);
  for (const [n, body] of Object.entries(SHIMS)) {
    writeFileSync(path.join(bin, n), body);
    chmodSync(path.join(bin, n), 0o755);
  }
  const tools = ["bash", "env", "awk", "sed", "grep", "stat", "sha256sum", "cat", "mktemp", "rm", "mkdir",
    "basename", "dirname", "df", "cp", "hostname", "tr", "ls", "python3", "head", "tail", "sort", "date", "wc", "mv"];
  if (withAge) tools.push("age");
  for (const t of tools) {
    const found = spawnSync("sh", ["-c", `command -v ${t}`]).stdout.toString().trim();
    if (found && !existsSync(path.join(bin, t))) symlinkSync(found, path.join(bin, t));
  }
  const out = spawnSync("age-keygen", [], { encoding: "utf8" });
  const identity = out.stdout.split("\n").find((l) => l.startsWith("AGE-SECRET-KEY-1")) as string;
  const recipient = (out.stdout.match(/public key: (age1[0-9a-z]+)/) as RegExpMatchArray)[1];
  const idFile = path.join(root, "identity.txt");
  writeFileSync(idFile, `${identity}\n`, { mode: 0o600 });
  const e = { root, bin, store, log: path.join(root, "shim.log"), recipient, idFile };
  envs[envs.length - 1] = e;

  mkdirSync(path.join(store, "free", INSTANCE), { recursive: true });
  mkdirSync(path.join(store, "meta", INSTANCE), { recursive: true });
  writeFileSync(path.join(store, PLAIN), PAYLOAD);
  writeFileSync(
    path.join(store, MANIFEST),
    JSON.stringify({
      schema_version: 1, instance_id: INSTANCE, archive_path: PLAIN, archive_size_bytes: PAYLOAD.length,
      archive_sha256: sha(PAYLOAD), tier: "free", pve_host: "fixturenodea", vmid: 101, archived_at: "2026-01-01T00:00:00Z",
    })
  );
  return e;
}

function run(e: Env, args: string[], extra: Record<string, string> = {}) {
  writeFileSync(e.log, "");
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      PATH: e.bin, HOME: e.root, TMPDIR: e.root, SHIM_LOG: e.log, STORE: e.store,
      HERMES_BACKUP_AGE_RECIPIENT: e.recipient,
      HERMES_REENCRYPT_SCRATCH_ROOT: e.root,
      HERMES_REENCRYPT_SCRATCH_SLACK_MB: "1",
      ...extra,
    } as unknown as NodeJS.ProcessEnv,
  });
}

const listAll = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((en) =>
    en.isDirectory() ? listAll(path.join(dir, en.name)).map((f) => path.join(en.name, f)) : [en.name]
  );
const snapshot = (e: Env) =>
  Object.fromEntries(listAll(e.store).sort().map((f) => [f, readFileSync(path.join(e.store, f), "utf8")]));
const goodArgs = [PLAIN, `--expected-sha256=${sha(PAYLOAD)}`];
const resultLine = (out: string) => out.split("\n").find((l) => l.startsWith("REENCRYPT_RESULT "))!;
const kv = (line: string) => Object.fromEntries(line.split(" ").slice(1).map((t) => t.split("=")));

describeIfAge("reencrypt-cold-archive.sh", () => {
  afterAll(() => envs.forEach((e) => e.root && rmSync(e.root, { recursive: true, force: true })));

  it("dry run (default) changes nothing and prints the plan", () => {
    const e = setup();
    const before = snapshot(e);
    const r = run(e, goodArgs);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DRY_RUN reencrypt");
    expect(r.stdout).not.toContain("REENCRYPT_RESULT");
    expect(snapshot(e)).toEqual(before);
    expect(readFileSync(e.log, "utf8")).not.toMatch(/rsync|rm -f/);
  });

  it("--apply leaves only the .age copy plus the updated manifest, and decrypts back", () => {
    const e = setup();
    const r = run(e, [...goodArgs, "--apply"]);
    expect(r.status).toBe(0);
    expect(listAll(e.store).sort()).toEqual([ENC, MANIFEST].sort());
    const encBytes = readFileSync(path.join(e.store, ENC));
    const manifest = JSON.parse(readFileSync(path.join(e.store, MANIFEST), "utf8"));
    expect(manifest).toMatchObject({
      archive_path: ENC, archive_sha256: sha(encBytes), archive_size_bytes: encBytes.length,
      encryption: "age", plain_sha256: sha(PAYLOAD), instance_id: INSTANCE, tier: "free",
    });
    const res = kv(resultLine(r.stdout));
    expect(res).toMatchObject({
      plain: PLAIN, enc: ENC, enc_sha256: sha(encBytes), enc_size: String(encBytes.length),
      plain_sha256: sha(PAYLOAD), plain_deleted: "1", resumed: "0",
    });
    expect(readdirSync(e.root).filter((f) => f.startsWith("hermes-reencrypt-"))).toEqual([]);
    const dec = spawnSync("age", ["-d", "-i", e.idFile, path.join(e.store, ENC)], { encoding: "utf8" });
    expect(dec.stdout).toBe(PAYLOAD);
  });

  it("--apply --keep-plain keeps the plain copy; --delete-plain then removes it only when confirmed", () => {
    const e = setup();
    const r = run(e, [...goodArgs, "--apply", "--keep-plain"]);
    expect(r.status).toBe(0);
    const res = kv(resultLine(r.stdout));
    expect(res.plain_deleted).toBe("0");
    expect(existsSync(path.join(e.store, PLAIN))).toBe(true);
    expect(existsSync(path.join(e.store, ENC))).toBe(true);

    const wrong = run(e, [...goodArgs, "--delete-plain", `--enc-sha256=${"0".repeat(64)}`, `--enc-size=${res.enc_size}`]);
    expect(wrong.status).toBe(12);
    expect(existsSync(path.join(e.store, PLAIN))).toBe(true);

    const ok = run(e, [...goodArgs, "--delete-plain", `--enc-sha256=${res.enc_sha256}`, `--enc-size=${res.enc_size}`]);
    expect(ok.status).toBe(0);
    expect(existsSync(path.join(e.store, PLAIN))).toBe(false);
    expect(kv(resultLine(ok.stdout)).plain_deleted).toBe("1");
  });

  it("--delete-plain refuses when the manifest still describes the plain archive", () => {
    const e = setup();
    writeFileSync(path.join(e.store, ENC), "whatever");
    const r = run(e, [...goodArgs, "--delete-plain", `--enc-sha256=${sha("whatever")}`, "--enc-size=8"]);
    expect(r.status).toBe(12);
    expect(existsSync(path.join(e.store, PLAIN))).toBe(true);
  });

  it("re-running --apply after a keep-plain run resumes without re-encrypting", () => {
    const e = setup();
    const first = kv(resultLine(run(e, [...goodArgs, "--apply", "--keep-plain"]).stdout));
    const encBefore = readFileSync(path.join(e.store, ENC));
    const r = run(e, [...goodArgs, "--apply", "--keep-plain"]);
    expect(r.status).toBe(0);
    expect(kv(resultLine(r.stdout))).toMatchObject({ resumed: "1", enc_sha256: first.enc_sha256 });
    expect(readFileSync(path.join(e.store, ENC)).equals(encBefore)).toBe(true);
  });

  it("a sha mismatch refuses with exit 3 and leaves everything intact", () => {
    const e = setup();
    const before = snapshot(e);
    const r = run(e, [PLAIN, `--expected-sha256=${"a".repeat(64)}`, "--apply"]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("REFUSING_REENCRYPT_SHA_MISMATCH");
    expect(snapshot(e)).toEqual(before);
  });

  it("a downloaded archive that does not match the (agreeing) manifest sha refuses with exit 3", () => {
    const e = setup();
    writeFileSync(path.join(e.store, PLAIN), "CORRUPTED-ON-THE-BOX");
    const before = snapshot(e);
    const r = run(e, [...goodArgs, "--apply"]);
    expect(r.status).toBe(3);
    expect(snapshot(e)).toEqual(before);
  });

  it.each([
    ["traversal", `free/${INSTANCE}/../x/data-${TS}.tar.zst`],
    ["already encrypted", ENC],
    ["shell metacharacters", `free/${INSTANCE}/data-${TS};rm.tar.zst`],
    ["absolute", `/etc/passwd`],
    ["other prefix", `trash/${INSTANCE}/data-${TS}.tar.zst`],
    ["trailing newline", `${PLAIN}\n`],
  ])("an unsafe path (%s) is refused with exit 2 before any remote call", (_n, p) => {
    const e = setup();
    const before = snapshot(e);
    const r = run(e, [p, `--expected-sha256=${sha(PAYLOAD)}`, "--apply"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("REFUSING_REENCRYPT_UNSAFE_PATH");
    expect(readFileSync(e.log, "utf8")).toBe("");
    expect(snapshot(e)).toEqual(before);
  });

  it("refuses with distinct codes: age missing (7), bad recipient (8), no scratch space (5)", () => {
    const noAge = setup(false);
    expect(run(noAge, [...goodArgs, "--apply"]).status).toBe(7);

    const e = setup();
    const before = snapshot(e);
    expect(run(e, [...goodArgs, "--apply"], { HERMES_BACKUP_AGE_RECIPIENT: "age1nope" }).status).toBe(8);
    expect(run(e, [...goodArgs, "--apply"], { HERMES_BACKUP_AGE_RECIPIENT: "" }).status).toBe(8);
    const space = run(e, [...goodArgs, "--apply"], { HERMES_REENCRYPT_SCRATCH_SLACK_MB: "999999999" });
    expect(space.status).toBe(5);
    expect(space.stderr).toContain("REFUSING_REENCRYPT_NO_SCRATCH_SPACE");
    expect(snapshot(e)).toEqual(before);
  });

  it("when the upload fails the plain copy and the manifest survive untouched", () => {
    const e = setup();
    const plainBefore = readFileSync(path.join(e.store, PLAIN), "utf8");
    const manifestBefore = readFileSync(path.join(e.store, MANIFEST), "utf8");
    const r = run(e, [...goodArgs, "--apply"], { FAIL_UPLOAD: "1" });
    expect(r.status).toBe(6);
    expect(readFileSync(path.join(e.store, PLAIN), "utf8")).toBe(plainBefore);
    expect(readFileSync(path.join(e.store, MANIFEST), "utf8")).toBe(manifestBefore);
    expect(existsSync(path.join(e.store, ENC))).toBe(false); // partial upload cleaned up
    expect(r.stdout).not.toContain("REENCRYPT_RESULT");
  });

  it("an unreadable manifest refuses before downloading or uploading anything", () => {
    const e = setup();
    rmSync(path.join(e.store, MANIFEST));
    const r = run(e, [...goodArgs, "--apply"]);
    expect(r.status).toBe(10);
    expect(readFileSync(e.log, "utf8")).not.toContain("rsync");
    expect(existsSync(path.join(e.store, PLAIN))).toBe(true);
  });

  it("handles a daily backup path and its daily-meta manifest", () => {
    const e = setup();
    const daily = `daily/paid/${INSTANCE}/vzdump-qemu-101-${TS}.vma.zst`;
    const dm = `daily-meta/${INSTANCE}/${TS}.json`;
    mkdirSync(path.join(e.store, "daily", "paid", INSTANCE), { recursive: true });
    mkdirSync(path.join(e.store, "daily-meta", INSTANCE), { recursive: true });
    writeFileSync(path.join(e.store, daily), "DAILY");
    writeFileSync(path.join(e.store, dm), JSON.stringify({ schema_version: 2, backup_path: daily, backup_sha256: sha("DAILY"), backup_size_bytes: 5 }));
    const r = run(e, [daily, `--expected-sha256=${sha("DAILY")}`, "--apply"]);
    expect(r.status).toBe(0);
    const m = JSON.parse(readFileSync(path.join(e.store, dm), "utf8"));
    expect(m).toMatchObject({ backup_path: `${daily}.age`, encryption: "age", plain_sha256: sha("DAILY") });
    expect(existsSync(path.join(e.store, daily))).toBe(false);
  });
});
