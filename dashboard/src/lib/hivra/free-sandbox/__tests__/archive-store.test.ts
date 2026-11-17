import type { runProxmoxHostScriptWithStdin } from "@/lib/services/proxmox-instance-service";
import { execFile, type ExecFileException } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ArchiveStoreError,
  FREE_ARCHIVE_PREFIX,
  StorageBoxArchiveStore,
  archiveLocation,
  buildEraseScript,
  buildFetchScript,
  buildUploadScript,
  type HostEnv,
  type HostScriptOptions,
  type HostScriptOutcome,
  type HostScriptRunner,
} from "../archive-store";
import type { ArchiveCopy, SandboxRef } from "../ports";

// The real runner must fit the injected type (checked at compile time only: a type import).
const realRunnerFits: HostScriptRunner = null as unknown as typeof runProxmoxHostScriptWithStdin;
void realRunnerFits;

jest.setTimeout(120_000);

const SID = "3f2c8a10-9b7e-4d2a-8c1e-5a6b7c8d9e0f";
const COMPUTER = "7d1e2f30-4a5b-4c6d-9e7f-8a9b0c1d2e3f";
const OWNER = "c".repeat(64);
const PAYLOAD = Buffer.from("packed free sandbox workspace\n");
const SIZE = PAYLOAD.length;
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");
const ARCHIVE_NAME = `${SHA}.tar.zst`;
const MANIFEST_NAME = `${SHA}.json`;
const LOCATION = `free-sandbox/${SID}/${ARCHIVE_NAME}`;
const MANIFEST = Buffer.from(`${JSON.stringify({ format: 1, sandboxId: SID, sha256: SHA }, null, 2)}\n`);
const SECRET = "SECRET-KEY-MATERIAL-do-not-leak";
const VERIFY = "HIVRA_FREE_ARCHIVE_VERIFY_FAILED";
const FAILED = "HIVRA_FREE_ARCHIVE_FAILED";
/** The production pool-server archive directory. The behavioural tests point it at a temp directory and nowhere else. */
const PRODUCTION_ARCHIVE_DIR = "ARCHIVES='/var/lib/hivra-gvisor/archives'";

const sandbox: SandboxRef = { sandboxId: SID, computerId: COMPUTER, ownerHash: OWNER };
const copy: ArchiveCopy = { location: LOCATION, sha256: SHA, bytes: SIZE };

// Stubs placed first on PATH. STUB_FAULT is "kind|match"; a stub applies the fault only where its match occurs.
// The ssh stub runs `ssh cold "<command>"` in the fake box's home directory (STUB_BOX).
const SSH_STUB = `#!/bin/bash
alias_name="$1"
shift
cmd="$*"
echo "ssh $cmd" >> "$STUB_LOG"
[ "$alias_name" = "cold" ] || exit 255
IFS='|' read -r kind match <<< "$STUB_FAULT"
case "$kind" in
  ssh-fail) case "$cmd" in *"$match"*) exit 255 ;; esac ;;
  rm-noop) case "$cmd" in "rm "*"$match"*) exit 0 ;; esac ;;
esac
cd "$STUB_BOX" || exit 255
case "$cmd" in
  "ls "*)
    if [ "$kind" = "ls-columns" ]; then
      out=$(sh -c "$cmd") || exit 1
      printf '%s ' $out
      echo
      exit 0
    fi
    ;;
esac
exec sh -c "$cmd"
`;

// The rsync stub handles `rsync -a <src> <dst>` where one side is cold:<path> on the fake box.
const RSYNC_STUB = `#!/bin/bash
echo "rsync $*" >> "$STUB_LOG"
IFS='|' read -r kind match <<< "$STUB_FAULT"
src="$2"
dst="$3"
case "$src" in
  cold:*)
    rel=$(echo "$src" | sed 's/^cold://')
    case "$kind" in rsync-from-box) case "$src" in *"$match"*) exit 23 ;; esac ;; esac
    [ -f "$STUB_BOX/$rel" ] || exit 23
    cp "$STUB_BOX/$rel" "$dst" || exit 1
    case "$kind" in corrupt-from-box) case "$src" in *"$match"*) echo corrupt >> "$dst" ;; esac ;; esac
    ;;
  *)
    rel=$(echo "$dst" | sed 's/^cold://')
    case "$kind" in rsync-to-box) case "$dst" in *"$match"*) exit 23 ;; esac ;; esac
    cp "$src" "$STUB_BOX/$rel" || exit 1
    ;;
esac
`;

// sha256sum is not on macOS. The stub uses the real one where it exists, else shasum, else openssl.
const SHA256_STUB = `#!/bin/bash
if [ -x /usr/bin/sha256sum ]; then exec /usr/bin/sha256sum "$@"; fi
if [ -x /usr/bin/shasum ]; then exec /usr/bin/shasum -a 256 "$@"; fi
exec openssl dgst -sha256 -r "$@"
`;

interface Fixture {
  root: string;
  bin: string;
  box: string;
  host: string;
  tmp: string;
  log: string;
}

const fixtureRoots: string[] = [];

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "free-archive-store-"));
  fixtureRoots.push(root);
  const fx: Fixture = {
    root,
    bin: path.join(root, "bin"),
    box: path.join(root, "box"),
    host: path.join(root, "host", "archives"),
    tmp: path.join(root, "tmp"),
    log: path.join(root, "calls.log"),
  };
  for (const dir of [fx.bin, fx.box, fx.host, fx.tmp]) fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of [
    ["ssh", SSH_STUB],
    ["rsync", RSYNC_STUB],
    ["sha256sum", SHA256_STUB],
  ]) {
    const file = path.join(fx.bin, name);
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);
  }
  return fx;
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function runBash(file: string, env: Record<string, string | undefined>, timeoutMs: number): Promise<HostScriptOutcome> {
  return new Promise((resolve) => {
    const options = {
      env: env as NodeJS.ProcessEnv,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      encoding: "utf8" as const,
    };
    execFile("/bin/bash", [file], options, (error: ExecFileException | null, stdout: string, stderr: string) => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** A runner that executes each generated script with bash, using the stubs and the fixture's directories. */
function localRunner(fx: Fixture, fault = ""): HostScriptRunner {
  let step = 0;
  return async (script: string, _stdin: string, env: HostEnv, options: HostScriptOptions) => {
    if (!script.includes(PRODUCTION_ARCHIVE_DIR)) throw new Error("the archive directory line is missing");
    step += 1;
    const file = path.join(fx.root, `step-${step}.sh`);
    fs.writeFileSync(file, script.split(PRODUCTION_ARCHIVE_DIR).join(`ARCHIVES='${fx.host}'`));
    const childEnv: Record<string, string | undefined> = {
      PATH: `${fx.bin}:${process.env.PATH ?? ""}`,
      TMPDIR: fx.tmp,
      STUB_BOX: fx.box,
      STUB_LOG: fx.log,
      STUB_FAULT: fault,
    };
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) childEnv[key] = value;
    }
    return runBash(file, childEnv, options.timeoutMs);
  };
}

function behaviouralStore(fx: Fixture, fault = ""): StorageBoxArchiveStore {
  return new StorageBoxArchiveStore({
    runScript: localRunner(fx, fault),
    envFor: (serverId) => ({ POOL_TAG: serverId }),
    serverForErase: () => "pool-2",
  });
}

const boxDir = (fx: Fixture) => path.join(fx.box, FREE_ARCHIVE_PREFIX, SID);

function putBox(fx: Fixture, name: string, content: Buffer): void {
  fs.mkdirSync(boxDir(fx), { recursive: true });
  fs.writeFileSync(path.join(boxDir(fx), name), content);
}

function boxNames(fx: Fixture): string[] {
  return fs.existsSync(boxDir(fx)) ? fs.readdirSync(boxDir(fx)).sort() : [];
}

const finalNames = (fx: Fixture) => boxNames(fx).filter((n) => n === ARCHIVE_NAME || n === MANIFEST_NAME);
const partialNames = (fx: Fixture) => boxNames(fx).filter((n) => n.includes(".partial"));

function boxFile(fx: Fixture, name: string): Buffer {
  return fs.readFileSync(path.join(boxDir(fx), name));
}

/** The pool server's local copy, as the adapter keeps it. */
function seedLocal(fx: Fixture, archive: Buffer = PAYLOAD, manifest: Buffer = MANIFEST): void {
  fs.writeFileSync(path.join(fx.host, `${SID}.tar.zst`), archive);
  fs.writeFileSync(path.join(fx.host, `${SID}.json`), manifest);
}

function hostNames(fx: Fixture): string[] {
  return fs.readdirSync(fx.host).sort();
}

function commandLog(fx: Fixture): string[] {
  return fs.existsSync(fx.log)
    ? fs
        .readFileSync(fx.log, "utf8")
        .split("\n")
        .filter((l) => l !== "")
    : [];
}

/** The commands sent to the box, in order, without the `ssh` prefix. */
function sshCalls(fx: Fixture): string[] {
  return commandLog(fx)
    .filter((l) => l.startsWith("ssh "))
    .map((l) => l.slice("ssh ".length));
}

/** The destination (last argument) of every rsync, in order. */
function rsyncDestinations(fx: Fixture): string[] {
  return commandLog(fx)
    .filter((l) => l.startsWith("rsync "))
    .map((l) => l.split(" ").pop() ?? "");
}

function lastIndexWhere(items: string[], predicate: (item: string) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i])) return i;
  }
  return -1;
}

/** A runner that records every call and answers with `reply`. */
interface Call {
  script: string;
  stdin: string;
  env: HostEnv;
  options: HostScriptOptions;
}

function fakeRunner(reply: (call: Call) => HostScriptOutcome | Promise<HostScriptOutcome> | never) {
  const calls: Call[] = [];
  const runScript: HostScriptRunner = async (script, stdin, env, options) => {
    const call = { script, stdin, env, options };
    calls.push(call);
    return reply(call);
  };
  return { calls, runScript };
}

const ok = (stdout: string): HostScriptOutcome => ({ ok: true, stdout, stderr: "" });

const receipt = (op: string, fields: Record<string, unknown>) =>
  `HIVRA_FREE_ARCHIVE_V1 ${JSON.stringify({ version: 1, op, ...fields })}`;

const uploadReceipt = (over: Record<string, unknown> = {}) =>
  receipt("upload", { sha256: SHA, location: LOCATION, bytes: SIZE, ...over });
const fetchReceipt = (over: Record<string, unknown> = {}) =>
  receipt("fetch", { sha256: SHA, location: LOCATION, bytes: SIZE, ...over });
const eraseReceipt = (over: Record<string, unknown> = {}) =>
  receipt("erase", { sha256: SHA, location: LOCATION, ...over });

function makeStore(runScript: HostScriptRunner, erase: () => string | Promise<string> = () => "pool-2") {
  return new StorageBoxArchiveStore({
    runScript,
    envFor: (serverId) => ({ POOL_TAG: serverId }),
    serverForErase: erase,
  });
}

/** The rejection of a promise, or a failure if it resolved. */
async function errorOf(promise: Promise<unknown>): Promise<ArchiveStoreError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ArchiveStoreError) return err;
    throw err;
  }
  throw new Error("expected a rejection");
}

describe("archive locations", () => {
  it("keeps free archives under their own prefix, apart from the paid cold storage prefixes", () => {
    expect(FREE_ARCHIVE_PREFIX).toBe("free-sandbox");
    expect(archiveLocation(SID, SHA)).toBe(LOCATION);
    expect(LOCATION).not.toMatch(/^(free|paid|meta)\//);
  });

  it("refuses ids and digests that are not in the fixed formats", () => {
    expect(() => archiveLocation("../../etc", SHA)).toThrow(ArchiveStoreError);
    expect(() => archiveLocation(SID.toUpperCase(), SHA)).toThrow(ArchiveStoreError);
    expect(() => archiveLocation(SID, "zz".repeat(32))).toThrow(ArchiveStoreError);
    expect(() => archiveLocation(SID, SHA.slice(1))).toThrow(ArchiveStoreError);
  });
});

describe("input checks, before any script runs", () => {
  it("refuses a sandbox id that is not a UUID", async () => {
    const { calls, runScript } = fakeRunner(() => ok(uploadReceipt()));
    const hostile = { ...sandbox, sandboxId: "x'; rm -rf / #" };
    const err = await errorOf(makeStore(runScript).upload("pool-1", hostile, SHA));
    expect(err.code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("refuses a digest that is not 64 lowercase hex", async () => {
    const { calls, runScript } = fakeRunner(() => ok(uploadReceipt()));
    const err = await errorOf(makeStore(runScript).upload("pool-1", sandbox, SHA.toUpperCase()));
    expect(err.code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("accepts lowercase server ids of up to 63 characters and refuses every other form", async () => {
    for (const bad of ["Pool-1", "pool_1", "pool.1", "-pool", "pool-1; reboot", "a".repeat(64)]) {
      const { calls, runScript } = fakeRunner(() => ok(uploadReceipt()));
      const err = await errorOf(makeStore(runScript).upload(bad, sandbox, SHA));
      expect(err.code).toBe("invalid_input");
      expect(calls).toHaveLength(0);
    }
    for (const good of ["pool-1", "a".repeat(63)]) {
      const { runScript } = fakeRunner(() => ok(uploadReceipt()));
      await expect(makeStore(runScript).upload(good, sandbox, SHA)).resolves.toMatchObject({ sha256: SHA });
    }
  });

  it("refuses a location outside the free prefix, a location with a quote, and a copy of another sandbox", async () => {
    const { calls, runScript } = fakeRunner(() => ok(fetchReceipt()));
    const store = makeStore(runScript);
    const other = { ...sandbox, sandboxId: "11111111-2222-4333-8444-555555555555" };
    for (const err of [
      await errorOf(store.fetch("pool-1", sandbox, { ...copy, location: `free/${SID}/${SHA}.tar.zst` })),
      await errorOf(store.fetch("pool-1", sandbox, { ...copy, location: `${LOCATION}'; id #` })),
      await errorOf(store.fetch("pool-1", other, copy)),
      await errorOf(store.erase({ ...copy, location: "paid/x/y.qcow2.zst" })),
    ]) {
      expect(err.code).toBe("invalid_input");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a chosen erase server id that is not valid", async () => {
    const { calls, runScript } = fakeRunner(() => ok(eraseReceipt()));
    const err = await errorOf(makeStore(runScript, () => "pool-1 && reboot").erase(copy));
    expect(err.code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });
});

describe("receipts and failure reporting", () => {
  it("reports a failed step with the fixed code and never the script's output", async () => {
    const { runScript } = fakeRunner(() => ({ ok: false, stdout: "", stderr: `rsync: ${SECRET}`, error: SECRET }));
    const err = await errorOf(makeStore(runScript).upload("pool-1", sandbox, SHA));
    expect(err.code).toBe("host_failed");
    expect(err.message).not.toContain(SECRET);
    expect(String(err)).not.toContain(SECRET);
  });

  it("reports a read-back mismatch as verify_failed", async () => {
    const { runScript } = fakeRunner(() => ({ ok: false, stdout: "", stderr: `${VERIFY}\n` }));
    const err = await errorOf(makeStore(runScript).fetch("pool-1", sandbox, copy));
    expect(err.code).toBe("verify_failed");
  });

  it("refuses a success that printed no receipt, or a receipt for another operation or digest", async () => {
    for (const reply of [ok("some noise\n"), ok(fetchReceipt()), ok(uploadReceipt({ sha256: "0".repeat(64) }))]) {
      const { runScript } = fakeRunner(() => reply);
      const err = await errorOf(makeStore(runScript).upload("pool-1", sandbox, SHA));
      expect(err.code).toBe("receipt_invalid");
    }
  });

  it("refuses a receipt with no usable size and an unreadable receipt line", async () => {
    for (const reply of [ok(uploadReceipt({ bytes: -1 })), ok("HIVRA_FREE_ARCHIVE_V1 {not json")]) {
      const { runScript } = fakeRunner(() => reply);
      const err = await errorOf(makeStore(runScript).upload("pool-1", sandbox, SHA));
      expect(err.code).toBe("receipt_invalid");
    }
  });

  it("refuses a fetch success whose receipt is for an erase, and an erase with no receipt", async () => {
    const fetchRun = fakeRunner(() => ok(eraseReceipt()));
    expect((await errorOf(makeStore(fetchRun.runScript).fetch("pool-1", sandbox, copy))).code).toBe("receipt_invalid");
    const eraseRun = fakeRunner(() => ok(""));
    expect((await errorOf(makeStore(eraseRun.runScript).erase(copy))).code).toBe("receipt_invalid");
  });

  it("does not leak a secret thrown by the runner or an unreadable host environment", async () => {
    const thrown = fakeRunner(() => {
      throw new Error(SECRET);
    });
    const err = await errorOf(makeStore(thrown.runScript).upload("pool-1", sandbox, SHA));
    expect(err.code).toBe("host_failed");
    expect(err.message).not.toContain(SECRET);

    const env = fakeRunner(() => ok(uploadReceipt()));
    const store = new StorageBoxArchiveStore({
      runScript: env.runScript,
      envFor: () => {
        throw new Error(SECRET);
      },
      serverForErase: () => "pool-2",
    });
    const envErr = await errorOf(store.upload("pool-1", sandbox, SHA));
    expect(envErr.code).toBe("host_failed");
    expect(envErr.message).not.toContain(SECRET);
    expect(env.calls).toHaveLength(0);
  });

  it("never puts a secret into an error from any operation, whatever the runner says", async () => {
    const replies: HostScriptOutcome[] = [
      { ok: false, stdout: SECRET, stderr: SECRET, error: SECRET },
      { ok: true, stdout: SECRET, stderr: SECRET },
      { ok: true, stdout: `HIVRA_FREE_ARCHIVE_V1 ${SECRET}`, stderr: "" },
    ];
    for (const reply of replies) {
      const { runScript } = fakeRunner(() => reply);
      const store = makeStore(runScript);
      const errors = [
        await errorOf(store.upload("pool-1", sandbox, SHA)),
        await errorOf(store.fetch("pool-1", sandbox, copy)),
        await errorOf(store.erase(copy)),
      ];
      for (const err of errors) {
        expect(err.message).not.toContain(SECRET);
        expect(String(err.stack ?? "")).not.toContain(SECRET);
      }
    }
  });
});

describe("upload, run as bash against a fake box", () => {
  it("publishes both names and returns the copy, with no partial name left behind", async () => {
    const fx = makeFixture();
    seedLocal(fx);
    const result = await behaviouralStore(fx).upload("pool-1", sandbox, SHA);

    expect(result).toEqual({ location: LOCATION, sha256: SHA, bytes: SIZE });
    expect(boxNames(fx)).toEqual([MANIFEST_NAME, ARCHIVE_NAME]);
    expect(boxFile(fx, ARCHIVE_NAME).equals(PAYLOAD)).toBe(true);
    expect(boxFile(fx, MANIFEST_NAME).equals(MANIFEST)).toBe(true);
    expect(partialNames(fx)).toEqual([]);
  });

  it("reads each copy back before either final name is published", async () => {
    const fx = makeFixture();
    seedLocal(fx);
    await behaviouralStore(fx).upload("pool-1", sandbox, SHA);

    const lines = commandLog(fx);
    const lastReadBack = lastIndexWhere(lines, (l) => l.startsWith("rsync -a cold:") && l.includes(".partial."));
    const firstPublish = lines.findIndex((l) => l.startsWith("ssh mv "));
    expect(lastReadBack).toBeGreaterThan(-1);
    expect(firstPublish).toBeGreaterThan(lastReadBack);
    // The archive is published before the manifest, so the manifest stays the completion signal.
    const mvs = sshCalls(fx).filter((c) => c.startsWith("mv "));
    expect(mvs).toHaveLength(2);
    expect(mvs[0].startsWith(`mv free-sandbox/${SID}/${ARCHIVE_NAME}.partial.`)).toBe(true);
    expect(mvs[0].endsWith(` free-sandbox/${SID}/${ARCHIVE_NAME}`)).toBe(true);
    expect(mvs[1].startsWith(`mv free-sandbox/${SID}/${MANIFEST_NAME}.partial.`)).toBe(true);
    expect(mvs[1].endsWith(` free-sandbox/${SID}/${MANIFEST_NAME}`)).toBe(true);
    // Nothing is sent to a final name.
    expect(rsyncDestinations(fx).filter((d) => d.startsWith("cold:"))).not.toContain(`cold:${LOCATION}`);
    expect(rsyncDestinations(fx).filter((d) => d.startsWith("cold:"))).not.toContain(
      `cold:free-sandbox/${SID}/${MANIFEST_NAME}`,
    );
  });

  it("refuses a local archive that does not match its digest before anything is sent to the box", async () => {
    const fx = makeFixture();
    seedLocal(fx, Buffer.from("tampered"));
    const err = await errorOf(behaviouralStore(fx).upload("pool-1", sandbox, SHA));
    expect(err.code).toBe("verify_failed");
    expect(commandLog(fx)).toEqual([]);
  });

  it("refuses a local manifest that names another digest before anything is sent", async () => {
    const fx = makeFixture();
    seedLocal(fx, PAYLOAD, Buffer.from(`{"sha256": "${"0".repeat(64)}"}\n`));
    const err = await errorOf(behaviouralStore(fx).upload("pool-1", sandbox, SHA));
    expect(err.code).toBe("verify_failed");
    expect(commandLog(fx)).toEqual([]);
  });

  it("publishes nothing when the send of the archive fails", async () => {
    const fx = makeFixture();
    seedLocal(fx);
    const err = await errorOf(behaviouralStore(fx, "rsync-to-box|.tar.zst.partial").upload("pool-1", sandbox, SHA));
    expect(err.code).toBe("host_failed");
    expect(finalNames(fx)).toEqual([]);
    expect(partialNames(fx)).toEqual([]);
  });

  it("publishes nothing when the archive reads back wrong, even though the manifest is fine", async () => {
    const fx = makeFixture();
    seedLocal(fx);
    const err = await errorOf(behaviouralStore(fx, "corrupt-from-box|.tar.zst.partial").upload("pool-1", sandbox, SHA));
    expect(err.code).toBe("verify_failed");
    expect(finalNames(fx)).toEqual([]);
    expect(partialNames(fx)).toEqual([]);
  });

  it("publishes no archive when the manifest reads back wrong, so the copy never becomes half published", async () => {
    const fx = makeFixture();
    seedLocal(fx);
    const err = await errorOf(behaviouralStore(fx, "corrupt-from-box|.json.partial").upload("pool-1", sandbox, SHA));
    expect(err.code).toBe("verify_failed");
    expect(finalNames(fx)).toEqual([]);
    expect(partialNames(fx)).toEqual([]);
  });

  it("publishes no archive when the manifest cannot be sent", async () => {
    const fx = makeFixture();
    seedLocal(fx);
    const err = await errorOf(behaviouralStore(fx, "rsync-to-box|.json.partial").upload("pool-1", sandbox, SHA));
    expect(err.code).toBe("host_failed");
    expect(finalNames(fx)).toEqual([]);
    expect(partialNames(fx)).toEqual([]);
  });

  it("removes the archive it published when the manifest publish fails, and nothing else", async () => {
    const fx = makeFixture();
    seedLocal(fx);
    const fault = `ssh-fail|mv free-sandbox/${SID}/${MANIFEST_NAME}.partial`;
    const err = await errorOf(behaviouralStore(fx, fault).upload("pool-1", sandbox, SHA));
    expect(err.code).toBe("host_failed");
    expect(finalNames(fx)).toEqual([]);
    expect(partialNames(fx)).toEqual([]);
  });

  it("publishes nothing when the archive publish fails", async () => {
    const fx = makeFixture();
    seedLocal(fx);
    const fault = `ssh-fail|mv free-sandbox/${SID}/${ARCHIVE_NAME}.partial`;
    const err = await errorOf(behaviouralStore(fx, fault).upload("pool-1", sandbox, SHA));
    expect(err.code).toBe("host_failed");
    expect(finalNames(fx)).toEqual([]);
    expect(partialNames(fx)).toEqual([]);
  });

  it("refuses when the box listing fails, and publishes nothing", async () => {
    const fx = makeFixture();
    seedLocal(fx);
    const err = await errorOf(behaviouralStore(fx, `ssh-fail|ls free-sandbox/${SID}`).upload("pool-1", sandbox, SHA));
    expect(err.code).toBe("host_failed");
    expect(finalNames(fx)).toEqual([]);
  });

  it("keeps a stored archive it did not publish when its own manifest publish fails", async () => {
    const fx = makeFixture();
    seedLocal(fx);
    putBox(fx, ARCHIVE_NAME, PAYLOAD);
    const fault = `ssh-fail|mv free-sandbox/${SID}/${MANIFEST_NAME}.partial`;
    const err = await errorOf(behaviouralStore(fx, fault).upload("pool-1", sandbox, SHA));

    expect(err.code).toBe("host_failed");
    expect(finalNames(fx)).toEqual([ARCHIVE_NAME]);
    expect(boxFile(fx, ARCHIVE_NAME).equals(PAYLOAD)).toBe(true);
    expect(partialNames(fx)).toEqual([]);
  });

  it("verifies a stored copy that already matches and publishes nothing", async () => {
    const fx = makeFixture();
    seedLocal(fx);
    putBox(fx, ARCHIVE_NAME, PAYLOAD);
    putBox(fx, MANIFEST_NAME, MANIFEST);
    const result = await behaviouralStore(fx).upload("pool-1", sandbox, SHA);

    expect(result).toEqual({ location: LOCATION, sha256: SHA, bytes: SIZE });
    expect(sshCalls(fx).filter((c) => c.startsWith("mv "))).toEqual([]);
    expect(rsyncDestinations(fx).filter((d) => d.startsWith("cold:"))).toEqual([]);
    expect(boxNames(fx)).toEqual([MANIFEST_NAME, ARCHIVE_NAME]);
  });

  it("refuses a stored archive under the digest's name that does not match, and leaves it in place", async () => {
    const fx = makeFixture();
    seedLocal(fx);
    putBox(fx, ARCHIVE_NAME, Buffer.from("other bytes under the same name"));
    const err = await errorOf(behaviouralStore(fx).upload("pool-1", sandbox, SHA));

    expect(err.code).toBe("verify_failed");
    expect(boxFile(fx, ARCHIVE_NAME).toString()).toBe("other bytes under the same name");
    expect(finalNames(fx)).toEqual([ARCHIVE_NAME]);
  });

  it("refuses a stored manifest that differs from the local one, and leaves it in place", async () => {
    const fx = makeFixture();
    seedLocal(fx);
    putBox(fx, ARCHIVE_NAME, PAYLOAD);
    putBox(fx, MANIFEST_NAME, Buffer.from("{}\n"));
    const err = await errorOf(behaviouralStore(fx).upload("pool-1", sandbox, SHA));

    expect(err.code).toBe("verify_failed");
    expect(boxFile(fx, MANIFEST_NAME).toString()).toBe("{}\n");
    expect(boxFile(fx, ARCHIVE_NAME).equals(PAYLOAD)).toBe(true);
  });

  it("runs the upload script directly and prints no receipt when the read-back fails", async () => {
    const fx = makeFixture();
    seedLocal(fx);
    const outcome = await localRunner(fx, "corrupt-from-box|.tar.zst.partial")(
      buildUploadScript({ sandboxId: SID, sha256: SHA }),
      "",
      {},
      { timeoutMs: 60_000 },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain(VERIFY);
    expect(outcome.stdout).not.toContain("HIVRA_FREE_ARCHIVE_V1");
    expect(finalNames(fx)).toEqual([]);
  });
});

describe("erase, run as bash against a fake box", () => {
  it("removes the manifest, then the archive, re-listing the directory before and after each removal", async () => {
    const fx = makeFixture();
    putBox(fx, ARCHIVE_NAME, PAYLOAD);
    putBox(fx, MANIFEST_NAME, MANIFEST);
    await behaviouralStore(fx).erase(copy);

    expect(boxNames(fx)).toEqual([]);
    expect(sshCalls(fx)).toEqual([
      `ls free-sandbox/${SID}`,
      `rm free-sandbox/${SID}/${MANIFEST_NAME}`,
      `ls free-sandbox/${SID}`,
      `ls free-sandbox/${SID}`,
      `rm free-sandbox/${SID}/${ARCHIVE_NAME}`,
      `ls free-sandbox/${SID}`,
    ]);
  });

  it("accepts an already-erased copy once the directory listing has succeeded, and removes nothing", async () => {
    const fx = makeFixture();
    fs.mkdirSync(boxDir(fx), { recursive: true });
    await behaviouralStore(fx).erase(copy);

    expect(sshCalls(fx)).toEqual([`ls free-sandbox/${SID}`, `ls free-sandbox/${SID}`]);
  });

  it("does not treat a copy as erased when its directory cannot be listed", async () => {
    const fx = makeFixture();
    const err = await errorOf(behaviouralStore(fx).erase(copy));
    expect(err.code).toBe("host_failed");
    expect(sshCalls(fx)).toEqual([`ls free-sandbox/${SID}`]);
  });

  it("stops before any removal when the listing fails, and leaves both files", async () => {
    const fx = makeFixture();
    putBox(fx, ARCHIVE_NAME, PAYLOAD);
    putBox(fx, MANIFEST_NAME, MANIFEST);
    const err = await errorOf(behaviouralStore(fx, `ssh-fail|ls free-sandbox/${SID}`).erase(copy));

    expect(err.code).toBe("host_failed");
    expect(sshCalls(fx)).toEqual([`ls free-sandbox/${SID}`]);
    expect(finalNames(fx)).toEqual([MANIFEST_NAME, ARCHIVE_NAME].sort());
  });

  it("fails and leaves the copy as it was when a removal fails", async () => {
    const fx = makeFixture();
    putBox(fx, ARCHIVE_NAME, PAYLOAD);
    putBox(fx, MANIFEST_NAME, MANIFEST);
    const fault = `ssh-fail|rm free-sandbox/${SID}/${MANIFEST_NAME}`;
    const err = await errorOf(behaviouralStore(fx, fault).erase(copy));

    expect(err.code).toBe("host_failed");
    expect(finalNames(fx)).toEqual([MANIFEST_NAME, ARCHIVE_NAME].sort());
  });

  it("catches a removal that reports success but leaves the file, and prints no receipt", async () => {
    const fx = makeFixture();
    putBox(fx, ARCHIVE_NAME, PAYLOAD);
    putBox(fx, MANIFEST_NAME, MANIFEST);
    const fault = `rm-noop|${MANIFEST_NAME}`;
    const err = await errorOf(behaviouralStore(fx, fault).erase(copy));

    expect(err.code).toBe("host_failed");
    expect(sshCalls(fx)).toEqual([
      `ls free-sandbox/${SID}`,
      `rm free-sandbox/${SID}/${MANIFEST_NAME}`,
      `ls free-sandbox/${SID}`,
    ]);
    expect(finalNames(fx)).toEqual([MANIFEST_NAME, ARCHIVE_NAME].sort());
  });

  it("reads a listing that puts the names in columns the same as one name per line", async () => {
    const fx = makeFixture();
    putBox(fx, ARCHIVE_NAME, PAYLOAD);
    putBox(fx, MANIFEST_NAME, MANIFEST);
    await behaviouralStore(fx, "ls-columns|").erase(copy);

    expect(boxNames(fx)).toEqual([]);
  });

  it("removes an archive-only copy", async () => {
    const fx = makeFixture();
    putBox(fx, ARCHIVE_NAME, PAYLOAD);
    await behaviouralStore(fx).erase(copy);
    expect(boxNames(fx)).toEqual([]);
  });

  it("uses only single-file removals, never a recursive or forced one", async () => {
    const fx = makeFixture();
    putBox(fx, ARCHIVE_NAME, PAYLOAD);
    putBox(fx, MANIFEST_NAME, MANIFEST);
    await behaviouralStore(fx).erase(copy);
    const removals = sshCalls(fx).filter((c) => c.startsWith("rm "));
    expect(removals).toHaveLength(2);
    for (const removal of removals) expect(removal).toMatch(/^rm free-sandbox\/[^ ]+$/);
  });

  it("runs the erase script directly and prints no receipt when a removal is not confirmed", async () => {
    const fx = makeFixture();
    putBox(fx, ARCHIVE_NAME, PAYLOAD);
    putBox(fx, MANIFEST_NAME, MANIFEST);
    const outcome = await localRunner(fx, `rm-noop|${MANIFEST_NAME}`)(
      buildEraseScript({ sandboxId: SID, sha256: SHA }),
      "",
      {},
      { timeoutMs: 60_000 },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain(FAILED);
    expect(outcome.stdout).not.toContain("HIVRA_FREE_ARCHIVE_V1");
  });
});

describe("fetch, run as bash against a fake box", () => {
  it("places a verified copy on the adapter's path, with no partial name left", async () => {
    const fx = makeFixture();
    putBox(fx, ARCHIVE_NAME, PAYLOAD);
    putBox(fx, MANIFEST_NAME, MANIFEST);
    await behaviouralStore(fx).fetch("pool-1", sandbox, copy);

    expect(hostNames(fx)).toEqual([`${SID}.json`, `${SID}.tar.zst`].sort());
    expect(fs.readFileSync(path.join(fx.host, `${SID}.tar.zst`)).equals(PAYLOAD)).toBe(true);
    expect(fs.readFileSync(path.join(fx.host, `${SID}.json`)).equals(MANIFEST)).toBe(true);
  });

  it("refuses a download that does not match and leaves nothing on the host", async () => {
    const fx = makeFixture();
    putBox(fx, ARCHIVE_NAME, PAYLOAD);
    putBox(fx, MANIFEST_NAME, MANIFEST);
    const err = await errorOf(behaviouralStore(fx, `corrupt-from-box|.tar.zst`).fetch("pool-1", sandbox, copy));

    expect(err.code).toBe("verify_failed");
    expect(hostNames(fx)).toEqual([]);
  });

  it("refuses a manifest that does not name the digest and leaves nothing on the host", async () => {
    const fx = makeFixture();
    putBox(fx, ARCHIVE_NAME, PAYLOAD);
    putBox(fx, MANIFEST_NAME, Buffer.from(`{"sha256": "${"0".repeat(64)}"}\n`));
    const err = await errorOf(behaviouralStore(fx).fetch("pool-1", sandbox, copy));

    expect(err.code).toBe("verify_failed");
    expect(hostNames(fx)).toEqual([]);
  });

  it("runs the fetch script directly and prints no receipt when the download is corrupt", async () => {
    const fx = makeFixture();
    putBox(fx, ARCHIVE_NAME, PAYLOAD);
    putBox(fx, MANIFEST_NAME, MANIFEST);
    const outcome = await localRunner(fx, "corrupt-from-box|.tar.zst")(
      buildFetchScript({ sandboxId: SID, sha256: SHA }, SIZE),
      "",
      {},
      { timeoutMs: 60_000 },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain(VERIFY);
    expect(outcome.stdout).not.toContain("HIVRA_FREE_ARCHIVE_V1");
    expect(hostNames(fx)).toEqual([]);
  });
});

describe("store wiring", () => {
  it("runs each operation on the server it was given, with its own host environment and no stdin", async () => {
    const uploads = fakeRunner(() => ok(uploadReceipt()));
    const erases = fakeRunner(() => ok(eraseReceipt()));
    await makeStore(uploads.runScript).upload("pool-1", sandbox, SHA);
    await makeStore(erases.runScript, () => "pool-9").erase(copy);

    expect(uploads.calls.map((c) => c.env)).toEqual([{ POOL_TAG: "pool-1" }]);
    expect(erases.calls.map((c) => c.env)).toEqual([{ POOL_TAG: "pool-9" }]);
    expect([...uploads.calls, ...erases.calls].every((c) => c.stdin === "")).toBe(true);
  });
});
