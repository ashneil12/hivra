jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/hivra/pinned-guest-seed", () => ({ buildPinnedGuestHostScript: jest.fn(), resolvePinnedGuestTarget: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { execFileSync } from "node:child_process";
import path from "node:path";

import { INSTALLED_MARKER, buildInboxInstallGuestScript, needsInstall, retryAfterMinutes, sweepInboxInstalls } from "../install";
import { INBOX_PLUGIN_FILES, INBOX_PLUGIN_VERSION } from "../plugin-bundle.generated";

describe("hivra-inbox plugin bundle", () => {
  it("matches the plugin files (run node scripts/generate-inbox-plugin-bundle.cjs after changing them)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { bundle } = require(path.join(process.cwd(), "scripts", "generate-inbox-plugin-bundle.cjs"));
    const fresh = bundle();
    expect(fresh.version).toBe(INBOX_PLUGIN_VERSION);
    expect(fresh.files).toEqual(INBOX_PLUGIN_FILES);
  });
});

describe("buildInboxInstallGuestScript", () => {
  const script = buildInboxInstallGuestScript("https://canary.example.com");

  it("is valid bash that writes the plugin, the Hivra address and enables it with Hermes's own command", () => {
    expect(() => execFileSync("bash", ["-n"], { input: script })).not.toThrow();
    expect(script).toContain('P="$H/.hermes/plugins/hivra-inbox"');
    expect(script).toContain('"$HERMES" plugins enable hivra-inbox');
    expect(script).toContain('"$HERMES" gateway restart');
    expect(script).toContain(`${INSTALLED_MARKER} ${INBOX_PLUGIN_VERSION}`);
    expect(script).toContain(Buffer.from("https://canary.example.com").toString("base64"));
    for (const name of Object.keys(INBOX_PLUGIN_FILES)) expect(script).toContain(`"$P/${name}"`);
  });

  it("only runs on Hermes computers", () => {
    expect(script).toContain('= hermes ] || { echo "not a Hermes computer"');
  });

  it("refuses an address that is not a plain https origin", () => {
    expect(() => buildInboxInstallGuestScript("http://hivra.cloud")).toThrow();
    expect(() => buildInboxInstallGuestScript("https://hivra.cloud/x'; rm -rf /")).toThrow();
  });
});

describe("needsInstall", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  it("installs once per version and backs off after failures", () => {
    expect(needsInstall(undefined, now)).toBe(true);
    expect(needsInstall({ agent_id: "a", version: INBOX_PLUGIN_VERSION, attempted_at: null, attempts: 0 }, now)).toBe(false);
    expect(needsInstall({ agent_id: "a", version: "0000000000000000", attempted_at: null, attempts: 0 }, now)).toBe(true);
    const failedAt = new Date(now - 10 * 60_000).toISOString();
    expect(needsInstall({ agent_id: "a", version: null, attempted_at: failedAt, attempts: 1 }, now)).toBe(false);
    expect(needsInstall({ agent_id: "a", version: null, attempted_at: failedAt, attempts: 1 }, now + 6 * 60_000)).toBe(true);
    expect(retryAfterMinutes(10)).toBe(360);
  });
});

describe("sweepInboxInstalls", () => {
  const before = process.env.HIVRA_INBOX_ANSWERS;
  afterEach(() => { process.env.HIVRA_INBOX_ANSWERS = before; });
  it("does nothing while the switch is off", async () => {
    delete process.env.HIVRA_INBOX_ANSWERS;
    await expect(sweepInboxInstalls()).resolves.toEqual({ state: "off" });
  });
});
