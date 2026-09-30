import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  COLD_STORAGE_HOST_ENV,
  COLD_STORAGE_KEY_ENV,
  COLD_STORAGE_USER_ENV,
  buildColdStorageInstallScript,
  buildColdStorageInstallScriptOrExit,
  buildColdStorageSshConfigBlock,
  resolveColdStorageTarget,
} from "../cold-storage-ssh";

const HOST = "box.cold-storage.example.test";
const USER = "u000000";
const KEY_B64 = Buffer.from("synthetic-test-key").toString("base64");

const fullEnv = {
  [COLD_STORAGE_HOST_ENV]: HOST,
  [COLD_STORAGE_USER_ENV]: USER,
  [COLD_STORAGE_KEY_ENV]: KEY_B64,
};

describe("resolveColdStorageTarget", () => {
  it("returns the configured host and user, trimmed", () => {
    expect(
      resolveColdStorageTarget({
        [COLD_STORAGE_HOST_ENV]: `  ${HOST}\n`,
        [COLD_STORAGE_USER_ENV]: ` ${USER} `,
      })
    ).toEqual({ ok: true, target: { host: HOST, user: USER } });
  });

  it("has no default: an empty environment is refused and names both settings", () => {
    expect(resolveColdStorageTarget({})).toEqual({
      ok: false,
      reason: "HERMES_COLD_STORAGE_HOST and HERMES_COLD_STORAGE_USER missing",
    });
  });

  it("treats a blank value as missing", () => {
    expect(
      resolveColdStorageTarget({ [COLD_STORAGE_HOST_ENV]: "   ", [COLD_STORAGE_USER_ENV]: USER })
    ).toEqual({ ok: false, reason: "HERMES_COLD_STORAGE_HOST missing" });
  });

  it.each([
    ["a newline that would start a new directive", `${HOST}\n  ProxyCommand id`],
    ["a space", `${HOST} extra`],
    ["a shell metacharacter", `${HOST};id`],
    ["a leading dash", `-oProxyCommand=id`],
    ["a trailing dot-dash", `${HOST}-`],
  ])("refuses a host with %s and never echoes the value", (_label, host) => {
    const result = resolveColdStorageTarget({
      [COLD_STORAGE_HOST_ENV]: host,
      [COLD_STORAGE_USER_ENV]: USER,
    });
    expect(result).toEqual({ ok: false, reason: "HERMES_COLD_STORAGE_HOST invalid" });
    expect(JSON.stringify(result)).not.toContain("ProxyCommand");
  });

  it.each([
    ["a newline", `${USER}\n  IdentityFile /root/.ssh/id_rsa`],
    ["a space", `${USER} root`],
    ["a slash", `../${USER}`],
  ])("refuses a user with %s", (_label, user) => {
    expect(
      resolveColdStorageTarget({ [COLD_STORAGE_HOST_ENV]: HOST, [COLD_STORAGE_USER_ENV]: user })
    ).toEqual({ ok: false, reason: "HERMES_COLD_STORAGE_USER invalid" });
  });
});

describe("buildColdStorageSshConfigBlock", () => {
  it("defines both aliases with the configured address and the fixed port", () => {
    const block = buildColdStorageSshConfigBlock({ host: HOST, user: USER });
    expect(block.startsWith("# BEGIN HERMES COLD STORAGE\n")).toBe(true);
    expect(block.endsWith("\n# END HERMES COLD STORAGE")).toBe(true);
    expect(block).toContain("Host cold hermes-cold-storage");
    expect(block).toContain(`  HostName ${HOST}`);
    expect(block).toContain(`  User ${USER}`);
    expect(block).toContain("  Port 23");
    expect(block).toContain("  IdentityFile /etc/hivra/keys/cold-storage");
  });
});

describe("buildColdStorageInstallScript", () => {
  it("installs the key and the alias when everything is configured", () => {
    const result = buildColdStorageInstallScript(fullEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.script).toContain(KEY_B64);
    expect(result.script).toContain(`  HostName ${HOST}`);
    expect(result.script).toContain(`  User ${USER}`);
  });

  it.each([
    [COLD_STORAGE_KEY_ENV, "HETZNER_SSH_PRIVATE_KEY_B64 missing"],
    [COLD_STORAGE_HOST_ENV, "HERMES_COLD_STORAGE_HOST missing"],
    [COLD_STORAGE_USER_ENV, "HERMES_COLD_STORAGE_USER missing"],
  ])("returns a reason instead of a script when %s is not set", (name, reason) => {
    const env: Record<string, string | undefined> = { ...fullEnv };
    delete env[name];
    expect(buildColdStorageInstallScript(env)).toEqual({ ok: false, reason });
  });
});

describe("buildColdStorageInstallScriptOrExit", () => {
  it("stops the host script with exit code 20 and names the missing setting", () => {
    expect(buildColdStorageInstallScriptOrExit({ [COLD_STORAGE_KEY_ENV]: KEY_B64 })).toBe(
      'echo "HERMES_COLD_STORAGE_HOST and HERMES_COLD_STORAGE_USER missing; cold storage alias unavailable" >&2; exit 20'
    );
  });

  it("returns the install fragment when configured", () => {
    expect(buildColdStorageInstallScriptOrExit(fullEnv)).toContain(`  HostName ${HOST}`);
  });
});

describe("the repository names no storage box", () => {
  const dashboardRoot = join(__dirname, "..", "..", "..");
  const files = [
    "src/app/api/cron/daily-vm-backups/route.ts",
    "src/app/api/cron/daily-instance-backups/route.ts",
    "src/app/api/instances/[id]/backups/route.ts",
    "src/lib/cold-storage-ssh.ts",
    "docs/cold-storage.md",
    "../docs/superpowers/specs/2026-05-25-daily-vm-backups-storagebox.md",
  ];

  it.each(files)("%s has no Hetzner Storage Box host or account name", (file) => {
    const text = readFileSync(join(dashboardRoot, file), "utf8");
    expect(text).not.toMatch(/\.your-storagebox\.de/i);
    expect(text).not.toMatch(/\bu\d{6}\b/);
  });

  it.each(files.slice(0, 3))("%s gets the alias from the shared helper", (file) => {
    const text = readFileSync(join(dashboardRoot, file), "utf8");
    expect(text).toContain("@/lib/cold-storage-ssh");
    expect(text).not.toMatch(/HostName\s+\S/);
  });
});
