jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/hivra/pinned-guest-seed", () => ({ buildPinnedGuestHostScript: jest.fn(), resolvePinnedGuestTarget: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { execFileSync } from "node:child_process";
import path from "node:path";

import { ASK_MARKER, buildAskFirstGuestScript, sweepAskHookUpdates } from "../ask-first";
import { ASK_HOOK_FILE, ASK_HOOK_VERSION } from "../plugin-bundle.generated";

describe("Ask me first hook bundle", () => {
  it("matches the hook file (run node scripts/generate-inbox-plugin-bundle.cjs after changing it)", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { askBundle } = require(path.join(process.cwd(), "scripts", "generate-inbox-plugin-bundle.cjs"));
    expect(askBundle()).toEqual({ file: ASK_HOOK_FILE, version: ASK_HOOK_VERSION });
  });
});

describe("buildAskFirstGuestScript", () => {
  const on = buildAskFirstGuestScript("https://canary.example.com", true);
  const off = buildAskFirstGuestScript("https://canary.example.com", false);

  it("is valid bash that installs the hook root-owned and lists it in the managed settings", () => {
    expect(() => execFileSync("bash", ["-n"], { input: on })).not.toThrow();
    expect(on).toContain("/opt/hivra/ask/hivra-ask-hook.py");
    expect(on).toContain("/etc/claude-code/managed-settings.json");
    expect(on).toContain('"matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit"');
    expect(on).toContain("/etc/hivra/control-origin");
    expect(on).toContain(Buffer.from("https://canary.example.com").toString("base64"));
    expect(on).toContain(`${ASK_MARKER} ${ASK_HOOK_VERSION} on`);
    expect(off).toContain(`${ASK_MARKER} ${ASK_HOOK_VERSION} off`);
    expect(off).toContain("printf '%s\\n' 'off' > /etc/hivra/ask-first.tmp");
  });

  it("only runs on Claude Code computers", () => {
    expect(on).toContain('= claude ] || { echo "not a Claude Code computer"');
  });

  it("refuses an address that is not a plain https origin", () => {
    expect(() => buildAskFirstGuestScript("http://hivra.cloud", true)).toThrow();
    expect(() => buildAskFirstGuestScript("https://hivra.cloud/x'; rm -rf /", true)).toThrow();
  });
});

describe("sweepAskHookUpdates", () => {
  const before = process.env.HIVRA_INBOX_ANSWERS;
  afterEach(() => { process.env.HIVRA_INBOX_ANSWERS = before; });
  it("does nothing while the switch is off", async () => {
    delete process.env.HIVRA_INBOX_ANSWERS;
    await expect(sweepAskHookUpdates()).resolves.toEqual({ tried: 0, installed: 0, failed: 0 });
  });
});
