import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "dotenv";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { decryptStoredChatText, encryptStoredChatText } from "@/lib/chat-crypto";

const script = path.resolve(__dirname, "../../scripts/operator-keys.cjs");
const primaryFixtureKeys = ["ENCRYPTION_KEY", "CHAT_ENCRYPTION_KEY", "LAUNCH_FINGERPRINT_KEY"];
const fixtureKeys = [...primaryFixtureKeys, "ENCRYPTION_KEY_LEGACY", "CHAT_ENCRYPTION_KEY_LEGACY", "LAUNCH_FINGERPRINT_KEY_LEGACY"];
const keyFile = `ENCRYPTION_KEY=${"a".repeat(64)}\nCHAT_ENCRYPTION_KEY=${"b".repeat(64)}\nLAUNCH_FINGERPRINT_KEY=${"c".repeat(64)}\n`;

describe("fresh-install operator keys", () => {
  let directory: string;
  let output: string;
  let previousKeys: Record<string, string | undefined>;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), "hivra-operator-keys-"));
    output = path.join(directory, ".env.local");
    previousKeys = Object.fromEntries(fixtureKeys.map((name) => [name, process.env[name]]));
    for (const name of fixtureKeys) delete process.env[name];
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(previousKeys)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    // Only this test's mkdtemp-owned fixture directory is ever removed.
    rmSync(directory, { recursive: true, force: true });
  });

  function run(args: string[], extraEnv: Partial<NodeJS.ProcessEnv> = {}) {
    return spawnSync(process.execPath, [script, ...args], {
      cwd: directory,
      encoding: "utf8",
      timeout: 5000,
      env: { PATH: process.env.PATH, NODE_ENV: "test", ...extraEnv },
    });
  }

  function writeFixture(content = keyFile) {
    writeFileSync(output, content, { mode: 0o600 });
  }

  it("creates separate random keys without exposing either key in output", () => {
    const result = run(["init", "--output", output]);
    expect(result.status).toBe(0);
    const parsed = parse(readFileSync(output, "utf8"));
    expect(Object.keys(parsed).sort()).toEqual([...primaryFixtureKeys].sort());
    for (const key of Object.values(parsed)) {
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(result.stdout + result.stderr).not.toContain(key);
    }
    expect(parsed.ENCRYPTION_KEY).not.toBe(parsed.CHAT_ENCRYPTION_KEY);
    expect(new Set(primaryFixtureKeys.map((name) => parsed[name])).size).toBe(3);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(JSON.parse(result.stdout).status).toBe("created");
    expect(existsSync(path.join(directory, ".env"))).toBe(false);
  });

  it("checks a generated file and uses its keys with the real secret and chat envelopes", () => {
    expect(run(["init", "--output", output]).status).toBe(0);
    const result = run(["check", "--file", output]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).scope).toContain("not runtime configuration");
    Object.assign(process.env, parse(readFileSync(output, "utf8")));
    expect(decryptSecret(encryptSecret("isolated-provider-credential"))).toBe("isolated-provider-credential");
    expect(decryptStoredChatText(encryptStoredChatText("isolated chat"))).toBe("isolated chat");
  });

  it("creates usable 0600 permissions even under a restrictive caller umask", () => {
    const result = spawnSync(process.execPath, ["-e", "process.umask(0o777); require(process.argv[1]).bootstrapOperatorKeys(process.argv[2]);", script, output], {
      cwd: directory,
      encoding: "utf8",
      timeout: 5000,
      env: { PATH: process.env.PATH, NODE_ENV: "test" },
    });
    expect(result.status).toBe(0);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(run(["check", "--file", output]).status).toBe(0);
  });

  it("can read previously encrypted fixture data after restoring the same keys", () => {
    expect(run(["init", "--output", output]).status).toBe(0);
    Object.assign(process.env, parse(readFileSync(output, "utf8")));
    const secret = encryptSecret("recovery-fixture-only");
    const chat = encryptStoredChatText("recovery chat fixture");
    const backup = path.join(directory, "operator-backup.env");
    copyFileSync(output, backup);
    process.env.ENCRYPTION_KEY = "c".repeat(64);
    process.env.CHAT_ENCRYPTION_KEY = "d".repeat(64);
    expect(() => decryptSecret(secret)).toThrow();
    expect(() => decryptStoredChatText(chat)).toThrow();
    expect(run(["check", "--file", backup]).status).toBe(0);
    Object.assign(process.env, parse(readFileSync(backup, "utf8")));
    expect(decryptSecret(secret)).toBe("recovery-fixture-only");
    expect(decryptStoredChatText(chat)).toBe("recovery chat fixture");
  });

  it("never overwrites an existing file, including an empty one", () => {
    writeFixture("");
    const result = run(["init", "--output", output]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Nothing was overwritten");
    expect(readFileSync(output, "utf8")).toBe("");
  });

  it("refuses an existing symlink and preserves its target", () => {
    const target = path.join(directory, "existing.env");
    writeFileSync(target, "keep-existing-configuration", { mode: 0o600 });
    symlinkSync(target, output);
    expect(run(["init", "--output", output]).status).toBe(1);
    expect(run(["check", "--file", output]).status).toBe(1);
    expect(readFileSync(target, "utf8")).toBe("keep-existing-configuration");
  });

  it("refuses a dangling symlink without creating its target", () => {
    const target = path.join(directory, "absent.env");
    symlinkSync(target, output);
    expect(run(["init", "--output", output]).status).toBe(1);
    expect(existsSync(target)).toBe(false);
  });

  it("refuses hard-linked key files", () => {
    writeFixture();
    linkSync(output, path.join(directory, "alias.env"));
    expect(run(["check", "--file", output]).status).toBe(1);
  });

  it.each([0o644, 0o640, 0o606])("refuses non-private mode %i without changing it", (mode) => {
    writeFixture();
    chmodSync(output, mode);
    const result = run(["check", "--file", output]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("owner-only");
    expect(statSync(output).mode & 0o777).toBe(mode);
    expect(result.stdout + result.stderr).not.toContain("a".repeat(64));
  });

  it("refuses another-user-writable parent directories", () => {
    chmodSync(directory, 0o777);
    expect(run(["init", "--output", output]).status).toBe(1);
    expect(existsSync(output)).toBe(false);
  });

  it("refuses a writable ancestor even when the immediate parent is private", () => {
    const privateChild = path.join(directory, "private");
    mkdirSync(privateChild, { mode: 0o700 });
    chmodSync(directory, 0o777);
    const destination = path.join(privateChild, "keys.env");
    expect(run(["init", "--output", destination]).status).toBe(1);
    expect(existsSync(destination)).toBe(false);
  });

  (process.platform === "darwin" ? it : it.skip)("rejects inheritable macOS access grants before creating a file", () => {
    const acl = spawnSync("/bin/chmod", ["+a", "everyone allow read,search,readattr,readextattr,readsecurity,file_inherit,directory_inherit", directory]);
    expect(acl.status).toBe(0);
    const result = run(["init", "--output", output]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ACL");
    expect(existsSync(output)).toBe(false);
  });

  (process.platform === "darwin" ? it : it.skip)("rejects existing 0600 files with macOS read grants without modifying them", () => {
    writeFixture();
    expect(spawnSync("/bin/chmod", ["+a", "everyone allow read", output]).status).toBe(0);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    const result = run(["check", "--file", output]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ACL");
    expect(result.stdout + result.stderr).not.toContain("a".repeat(64));
    expect(readFileSync(output, "utf8")).toBe(keyFile);
    expect(spawnSync("/bin/ls", ["-lde", output], { encoding: "utf8" }).stdout).toContain("allow read");
  });

  (process.platform === "darwin" ? it : it.skip)("preserves deny-only macOS directory protection", () => {
    expect(spawnSync("/bin/chmod", ["+a", "everyone deny delete", directory]).status).toBe(0);
    try {
      expect(run(["init", "--output", output]).status).toBe(0);
      expect(run(["check", "--file", output]).status).toBe(0);
      expect(spawnSync("/bin/ls", ["-lde", directory], { encoding: "utf8" }).stdout).toContain("deny delete");
    } finally {
      // Remove only the ACE this test added, before deleting the owned fixture.
      expect(spawnSync("/bin/chmod", ["-a", "everyone deny delete", directory]).status).toBe(0);
    }
  });

  it("rejects named pipes without waiting for a writer", () => {
    expect(spawnSync("mkfifo", [output]).status).toBe(0);
    const result = run(["check", "--file", output]);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("regular file");
  });

  it("requires an existing parent instead of silently creating a hierarchy", () => {
    const missing = path.join(directory, "not-created", "keys.env");
    expect(run(["init", "--output", missing]).status).toBe(1);
    expect(existsSync(path.dirname(missing))).toBe(false);
  });

  it("rejects directories and oversized input files", () => {
    mkdirSync(output, { mode: 0o700 });
    expect(run(["check", "--file", output]).status).toBe(1);
    const oversized = path.join(directory, "oversized.env");
    writeFileSync(oversized, keyFile + "#".repeat(65537), { mode: 0o600 });
    expect(run(["check", "--file", oversized]).status).toBe(1);
  });

  it.each(fixtureKeys)("does not initialize over an inherited %s", (name) => {
    const result = run(["init", "--output", output], { [name]: "inherited-secret-must-not-print" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not rotation");
    expect(result.stdout + result.stderr).not.toContain("inherited-secret-must-not-print");
    expect(existsSync(output)).toBe(false);
  });

  it.each(["z", "0", " #truncated", "\\n"])("rejects malformed quoted key suffix %j", (suffix) => {
    writeFixture(`ENCRYPTION_KEY="${"a".repeat(64)}${suffix}"\nCHAT_ENCRYPTION_KEY=${"b".repeat(64)}\n`);
    const result = run(["check", "--file", output]);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("a".repeat(64));
  });

  it("rejects duplicate definitions and public key aliases", () => {
    writeFixture(keyFile + `export ENCRYPTION_KEY=${"c".repeat(64)}\n`);
    expect(run(["check", "--file", output]).status).toBe(1);
    writeFileSync(output, keyFile + `NEXT_PUBLIC_ENCRYPTION_KEY=${"a".repeat(64)}\n`);
    expect(run(["check", "--file", output]).status).toBe(1);
  });

  it.each([
    `ENCRYPTION_KEY="${"a".repeat(64)}"z`,
    `ENCRYPTION_KEY: ${"c".repeat(64)}`,
    `NEXT_PUBLIC_ENCRYPTION_KEY: ${"a".repeat(64)}`,
    `\uFEFFENCRYPTION_KEY=${"c".repeat(64)}`,
    `\vNEXT_PUBLIC_ENCRYPTION_KEY=${"a".repeat(64)}`,
    `# comment\u2028NEXT_PUBLIC_ENCRYPTION_KEY=${"a".repeat(64)}`,
    "UNRELATED=not-a-key-file",
  ])("rejects ambiguous or non-key syntax %j", (line) => {
    writeFixture(keyFile + line + "\n");
    const result = run(["check", "--file", output]);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain("a".repeat(64));
  });

  it.each(["", "'", '"'])("accepted %j quoting matches the installed Next.js environment loader", (quote) => {
    writeFixture(` # key-only fixture\r\nexport ENCRYPTION_KEY = ${quote}${"a".repeat(64)}${quote} # secret\r\n\tCHAT_ENCRYPTION_KEY=${quote}${"B".repeat(64)}${quote}\r\nLAUNCH_FINGERPRINT_KEY=${quote}${"c".repeat(64)}${quote}\r\n`);
    expect(run(["check", "--file", output]).status).toBe(0);
    const result = spawnSync(process.execPath, ["-e", `
      const content = require('node:fs').readFileSync(process.argv[3], 'utf8');
      const expected = require(process.argv[1]).parseOperatorKeyFile(content);
      const [, actual] = require(process.argv[2]).processEnv([{ path: '.env.local', contents: content, env: {} }], process.cwd(), { info() {}, error() { throw new Error('Environment parse failed'); } }, true);
      process.exit(require('node:util').isDeepStrictEqual(expected, actual) ? 0 : 1);
    `, script, require.resolve("@next/env"), output], { cwd: directory, env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toBe("");
  });

  it("requires independent primary keys, even with different hex casing", () => {
    writeFixture(`ENCRYPTION_KEY=${"a".repeat(64)}\nCHAT_ENCRYPTION_KEY=${"A".repeat(64)}\nLAUNCH_FINGERPRINT_KEY=${"c".repeat(64)}\n`);
    expect(run(["check", "--file", output]).status).toBe(1);
  });

  it("accepts quoted keys and reports legacy presence without claiming rotation", () => {
    writeFixture(`export ENCRYPTION_KEY='${"a".repeat(64)}'\nCHAT_ENCRYPTION_KEY="${"b".repeat(64)}" # chat\nLAUNCH_FINGERPRINT_KEY=${"c".repeat(64)}\nENCRYPTION_KEY_LEGACY=${"d".repeat(64)}\n`);
    const result = run(["check", "--file", output]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).variables).toContain("ENCRYPTION_KEY_LEGACY");
    expect(JSON.parse(result.stdout).scope).toContain("not runtime configuration, database recovery, or rotation acceptance");
    expect(result.stdout + result.stderr).not.toContain("d".repeat(64));
  });

  it("requires explicit paths and has no force or overwrite option", () => {
    for (const args of [[], ["init"], ["init", "--output", output, "--force"], ["rotate", "--file", output]]) {
      expect(run(args).status).toBe(1);
    }
    expect(run(["--help"]).status).toBe(0);
    expect(existsSync(output)).toBe(false);
  });
});
