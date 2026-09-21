import {
  ERROR_PURGE_PROVIDER_MUTATION_ENABLED,
  runPurgeErrorHivraAgentsSweep,
} from "../purge-error-agents";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import { deleteBoxTunnel } from "@/lib/services/cloudflare-tunnel";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/hivra/agent-events", () => ({
  logHivraAgentEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/services/cloudflare-tunnel", () => ({
  deleteBoxTunnel: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxTargetConfiguration: jest.fn(),
  runProxmoxHostScript: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

describe("runPurgeErrorHivraAgentsSweep", () => {
  const mockedFrom = (supabaseAdmin as unknown as { from: jest.Mock }).from;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("keeps the legacy destructive provider sweep hard-disabled", async () => {
    expect(ERROR_PURGE_PROVIDER_MUTATION_ENABLED).toBe(false);

    const summary = await runPurgeErrorHivraAgentsSweep();

    expect(summary).toEqual({ scanned: 0, purged: 0, skipped: 0, results: [] });
    expect(mockedFrom).not.toHaveBeenCalled();
    expect(runProxmoxHostScript).not.toHaveBeenCalled();
    expect(deleteBoxTunnel).not.toHaveBeenCalled();
    expect(logHivraAgentEvent).not.toHaveBeenCalled();
  });

  it("cannot bypass the authority fuse through the targeted-agent option", async () => {
    const summary = await runPurgeErrorHivraAgentsSweep({
      agentId: "00000000-0000-4000-8000-000000001038",
      now: new Date("2026-06-10T12:00:00.000Z"),
    });

    expect(summary).toEqual({ scanned: 0, purged: 0, skipped: 0, results: [] });
    expect(mockedFrom).not.toHaveBeenCalled();
    expect(runProxmoxHostScript).not.toHaveBeenCalled();
    expect(deleteBoxTunnel).not.toHaveBeenCalled();
  });
});
