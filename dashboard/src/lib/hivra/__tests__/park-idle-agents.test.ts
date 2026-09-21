import { runParkIdleHivraAgentsSweep, PARKABLE_INTERACTIVE_KINDS } from "../park-idle-agents";
import { logHivraAgentEvent } from "@/lib/hivra/agent-events";
import {
  runProxmoxHostScript,
} from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/hivra/agent-events", () => ({
  logHivraAgentEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  resolveProxmoxTargetConfiguration: jest.fn(() => ({ env: { PROXMOX_NODE: "fixturenode21" } })),
  runProxmoxHostScript: jest.fn(),
}));
jest.mock("@/lib/hivra/proxmox-target", () => ({
  resolveHivraProxmoxHost: (h: string | null) => h ?? "fixturenode21",
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

const mockedFrom = (supabaseAdmin as unknown as { from: jest.Mock }).from;
const mockedRunScript = runProxmoxHostScript as jest.MockedFunction<typeof runProxmoxHostScript>;
const mockedLogEvent = logHivraAgentEvent as jest.MockedFunction<typeof logHivraAgentEvent>;

function candidateRow(vmid: number, type = "claude-code", daysOld = 10) {
  return {
    id: `agent-${vmid}`,
    user_id: `user-${vmid}`,
    type,
    vmid,
    proxmox_host: "fixturenode21",
    created_at: new Date(Date.now() - daysOld * 86_400_000).toISOString(),
  };
}

let selectFilters: Record<string, unknown>;
let updateFlipResolves: () => { data: Array<{ id: string }> };

/** from() returns the candidate SELECT builder first, then UPDATE builders. */
function wireSupabase(candidates: ReturnType<typeof candidateRow>[]) {
  selectFilters = {};
  let firstCall = true;
  mockedFrom.mockImplementation(() => {
    if (firstCall) {
      firstCall = false;
      const sb: Record<string, jest.Mock> = {};
      for (const m of ["select", "order"]) sb[m] = jest.fn(() => sb);
      sb.eq = jest.fn((k: string, v: unknown) => { selectFilters[k] = v; return sb; });
      sb.is = jest.fn((k: string, v: unknown) => { selectFilters[k] = v; return sb; });
      sb.in = jest.fn((k: string, v: unknown) => { selectFilters[k] = v; return sb; });
      sb.lt = jest.fn((k: string, v: unknown) => { selectFilters[`${k}__lt`] = v; return sb; });
      sb.limit = jest.fn(() => Promise.resolve({ data: candidates, error: null }));
      return sb;
    }
    // per-candidate UPDATE: .update().eq().eq().select() -> { data }
    const ub: Record<string, jest.Mock> = {};
    ub.update = jest.fn(() => ub);
    ub.eq = jest.fn(() => ub);
    ub.select = jest.fn(() => Promise.resolve(updateFlipResolves()));
    return ub;
  });
}

describe("runParkIdleHivraAgentsSweep", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.HIVRA_IDLE_PARK_ENABLED;
    updateFlipResolves = () => ({ data: [{ id: "flipped" }] });
    mockedRunScript.mockResolvedValue({ ok: true, stdout: "parked\n" } as never);
  });

  it("only queries never-opened, running, INTERACTIVE boxes past the age floor (aeon excluded)", async () => {
    wireSupabase([candidateRow(2100)]);
    process.env.HIVRA_IDLE_PARK_ENABLED = "true";
    await runParkIdleHivraAgentsSweep();
    expect(selectFilters.status).toBe("running");
    expect(selectFilters.deployment_target_id).toBeNull();
    expect(selectFilters.first_usage_at).toBeNull();
    expect(selectFilters.type).toEqual(PARKABLE_INTERACTIVE_KINDS);
    expect(PARKABLE_INTERACTIVE_KINDS).not.toContain("aeon");
    expect(selectFilters.created_at__lt).toEqual(expect.any(String));
  });

  it("is a no-op preview when HIVRA_IDLE_PARK_ENABLED is unset (parks nothing)", async () => {
    wireSupabase([candidateRow(2100), candidateRow(2101)]);
    const summary = await runParkIdleHivraAgentsSweep();
    expect(summary.enabled).toBe(false);
    expect(summary.dryRun).toBe(true);
    expect(summary.scanned).toBe(2);
    expect(summary.parked).toBe(0);
    expect(summary.results.every((r) => r.action === "would_park")).toBe(true);
    expect(mockedRunScript).not.toHaveBeenCalled();
    expect(mockedLogEvent).not.toHaveBeenCalled();
  });

  it("keeps provider mutation fused off even when the legacy feature flag is enabled", async () => {
    wireSupabase([candidateRow(2100), candidateRow(2103, "codex")]);
    process.env.HIVRA_IDLE_PARK_ENABLED = "true";

    const summary = await runParkIdleHivraAgentsSweep();

    expect(summary.enabled).toBe(true);
    expect(summary.dryRun).toBe(true);
    expect(summary.parked).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.results.every((result) => result.action === "would_park")).toBe(true);
    expect(mockedRunScript).not.toHaveBeenCalled();
    expect(mockedLogEvent).not.toHaveBeenCalled();
  });

  it("does not log a park event if the row left 'running' under us (no clobber)", async () => {
    wireSupabase([candidateRow(2100)]);
    process.env.HIVRA_IDLE_PARK_ENABLED = "true";
    updateFlipResolves = () => ({ data: [] }); // status-guarded update matched nothing

    const summary = await runParkIdleHivraAgentsSweep();

    expect(summary.parked).toBe(0);
    expect(mockedLogEvent).not.toHaveBeenCalled();
  });

  it("explicit dryRun previews even when enabled", async () => {
    wireSupabase([candidateRow(2100)]);
    process.env.HIVRA_IDLE_PARK_ENABLED = "true";
    const summary = await runParkIdleHivraAgentsSweep({ dryRun: true });
    expect(summary.dryRun).toBe(true);
    expect(summary.parked).toBe(0);
    expect(mockedRunScript).not.toHaveBeenCalled();
  });
});
