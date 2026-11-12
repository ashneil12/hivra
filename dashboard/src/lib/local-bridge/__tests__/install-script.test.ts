/** @jest-environment node */
jest.mock("server-only", () => ({}));

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BRIDGE_FILES, BridgeScriptError, renderBridgeInstaller } from "../install-script";

const ORIGIN = "https://canary.example.test";

describe("the local bridge installer", () => {
  it("serves the same bridge files that live in services/host-connector", () => {
    for (const name of BRIDGE_FILES) {
      const served = readFileSync(join(process.cwd(), "bootstrap/local-bridge", name));
      const source = readFileSync(join(process.cwd(), "..", "services/host-connector", name));
      expect(served.equals(source)).toBe(true);
    }
  });

  it("renders one script that passes bash -n and carries the files, the origin and the steps", async () => {
    const script = await renderBridgeInstaller(ORIGIN);
    const dir = mkdtempSync(join(tmpdir(), "bridge-install-"));
    const file = join(dir, "install.sh");
    writeFileSync(file, script);
    const check = spawnSync("bash", ["-n", file], { encoding: "utf8" });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    expect(script).not.toContain("@@");
    expect(script).toContain(`origin='${ORIGIN}'`);
    expect(script).toContain("^hvb_[A-Za-z0-9_-]{32}$");
    for (const name of BRIDGE_FILES) expect(script).toContain(`base64 -d > "$program_dir/${name}"`);
    expect(script).toContain("/api/hivra/bridge/enrol");
    expect(script).toContain("python3");
    expect(script).toContain("Do not run this with sudo");
    expect(script).toContain("cloud.hivra.bridge");
    expect(script).toContain("systemctl --user");
    expect(script).toContain('shared="$HOME/Hivra"');
    expect(script).toContain("chmod 700");
    // The config is written 0600 and never echoed; the code is never printed.
    expect(script).toContain("0o600");
    expect(script).not.toMatch(/echo .*\$code|cat .*(config|enrol)\.json/);
  });

  it("carries no secret: no key, no token, no database or relay value", async () => {
    const script = await renderBridgeInstaller(ORIGIN);
    expect(script).not.toMatch(/hvb_[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/);
    expect(script).not.toMatch(/bridgeKey"\s*:\s*"[0-9a-f]{64}"/);
  });

  it("refuses to run as root, and without a valid code", async () => {
    const script = await renderBridgeInstaller(ORIGIN);
    const dir = mkdtempSync(join(tmpdir(), "bridge-run-"));
    const file = join(dir, "install.sh");
    writeFileSync(file, script);
    const bad = spawnSync("bash", [file, "nope"], { encoding: "utf8", env: { ...process.env, HOME: dir } });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("full command from Hivra");
    if (process.getuid?.() === 0) {
      const root = spawnSync("bash", [file, `hvb_${"a".repeat(32)}`], { encoding: "utf8", env: { ...process.env, HOME: dir } });
      expect(root.status).toBe(1);
      expect(root.stderr).toContain("sudo");
    }
  });

  it("refuses an origin that is not the bare https app origin", async () => {
    await expect(renderBridgeInstaller("http://canary.example.test")).rejects.toThrow();
    await expect(renderBridgeInstaller("https://x.test/'; rm -rf /")).rejects.toThrow();
  });

  it("serves nothing when a file is missing", async () => {
    await expect(renderBridgeInstaller(ORIGIN, async () => { throw new Error("missing"); })).rejects.toBeInstanceOf(BridgeScriptError);
  });
});
