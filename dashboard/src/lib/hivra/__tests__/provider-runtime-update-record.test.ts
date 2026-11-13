/** @jest-environment node */
jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

const mockRecord = jest.fn();
const mockRead = jest.fn();
jest.mock("../agent-cli-store", () => ({
  ...jest.requireActual("../agent-cli-store"),
  recordOwnerAgentSoftwareRequest: (...args: unknown[]) => mockRecord(...args),
  readAgentSoftwareRecord: (...args: unknown[]) => mockRead(...args),
}));

import { recordProviderSoftwareUpdate } from "../provider-runtime-update";
import { AGENT_CLI_VERSIONS, AGENT_APP_VERSIONS } from "@/lib/infrastructure/portable-provisioner-contract";

const row = (type: string, extra: Record<string, unknown> = {}) =>
  ({ id: "agent-1", user_id: "owner", type, computer_profile: null, computer_substrate: "provider-vm", ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockResolvedValue(null);
});

describe("recordProviderSoftwareUpdate", () => {
  it("records a My cloud CLI agent's scheduled move as the owner's request", async () => {
    const line = `HIVRA_AGENT_CLI name=codex version=0.149.1 target=${AGENT_CLI_VERSIONS.codex} state=scheduled`;
    await recordProviderSoftwareUpdate(row("codex"), { agentCli: line, agentApp: null });
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
      agent: { id: "agent-1", user_id: "owner", type: "codex" },
      target: AGENT_CLI_VERSIONS.codex, result: "scheduled",
      report: expect.objectContaining({ name: "codex", state: "scheduled" }),
    }));
  });

  it("records an app agent against its tested app version", async () => {
    const target = AGENT_APP_VERSIONS.openclaw.version;
    await recordProviderSoftwareUpdate(row("openclaw"), {
      agentCli: null, agentApp: `HIVRA_AGENT_APP name=openclaw version=2026.1.1 target=${target} state=current`,
    });
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ target, result: "current" }));
  });

  it("records an unverified request against the tested version when the guest reported nothing", async () => {
    await recordProviderSoftwareUpdate(row("claude-code"), { agentCli: null, agentApp: null });
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ target: AGENT_CLI_VERSIONS["claude-code"], result: "unverified", report: null }));
  });

  it("ignores a report for another agent, and agents Hivra does not cover", async () => {
    await recordProviderSoftwareUpdate(row("codex"), {
      agentCli: `HIVRA_AGENT_CLI name=claude-code version=1.0.0 target=${AGENT_CLI_VERSIONS["claude-code"]} state=scheduled`, agentApp: null,
    });
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ result: "unverified", report: null }));
    mockRecord.mockClear();
    await recordProviderSoftwareUpdate(row("deepseek-harness"), { agentCli: null, agentApp: null });
    await recordProviderSoftwareUpdate(row("codex", { computer_profile: "ubuntu-desktop" }), { agentCli: null, agentApp: null });
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
