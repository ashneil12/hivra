import { runResumeMispausedPaidSweep } from "@/lib/recovery/resume-mispaused-paid-instances";
import { supabaseAdmin } from "@/lib/supabase";
import {
  startProxmoxInstance,
  getProxmoxInfrastructure,
  getProxmoxHostRoutingConfigFromInfrastructure,
  isProxmoxVmMissingResult,
} from "@/lib/services/proxmox-instance-service";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  startProxmoxInstance: jest.fn(),
  getProxmoxInfrastructure: jest.fn(),
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(() => null),
  isProxmoxVmMissingResult: jest.fn(() => false),
}));

type InstanceRow = {
  id: string;
  user_id: string;
  resource_tier: string;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  host_id: string | null;
  config: Record<string, unknown> | null;
};

const infra = {
  provider: "proxmox" as const,
  node: "fixturenode1",
  vmid: 200,
  privateIpv4: "10.250.20.50",
  gatewayHost: "x.agents.hermesos.cloud",
};

/**
 * Routes from("hermes_instances") select→candidates / update→capture, and
 * from("hermes_subscriptions") select→activeSubUserIds, by method not call
 * order. `.eq`/`.in`/`.is` are chainable mid-select and terminal for an update.
 */
function buildStub(params: {
  candidates: InstanceRow[];
  activeSubUserIds: string[];
}) {
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    if (table === "hermes_subscriptions") {
      const query: Record<string, unknown> = {};
      query.select = jest.fn(() => query);
      query.eq = jest.fn(() => query);
      // terminal: production awaits the result of the final .in(plan)
      query.in = jest.fn((col: string) => {
        if (col === "plan") {
          return Promise.resolve({
            data: params.activeSubUserIds.map((user_id) => ({ user_id })),
            error: null,
          });
        }
        return query;
      });
      return query;
    }
    if (table !== "hermes_instances") {
      throw new Error(`Unexpected table lookup: ${table}`);
    }
    const captured: { patch: Record<string, unknown> } = { patch: {} };
    let mode: "select" | "update" | null = null;
    const query: Record<string, unknown> = {};
    query.select = jest.fn(() => {
      mode = "select";
      return query;
    });
    query.update = jest.fn((patch: Record<string, unknown>) => {
      mode = "update";
      captured.patch = patch;
      return query;
    });
    query.eq = jest.fn((_col: string, value: string) => {
      if (mode === "update") {
        updates.push({ id: value, patch: captured.patch });
        return Promise.resolve({ error: null });
      }
      return query;
    });
    query.is = jest.fn(() => query);
    query.in = jest.fn(() => query);
    query.limit = jest.fn(async () => ({ data: params.candidates, error: null }));
    return query;
  });

  return { updates };
}

const row = (over: Partial<InstanceRow> & { id: string; user_id: string }): InstanceRow => ({
  resource_tier: "operator",
  proxmox_node: "fixturenode1",
  proxmox_vmid: 200,
  host_id: null,
  config: { infrastructure: infra },
  ...over,
});

describe("runResumeMispausedPaidSweep", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue(infra);
    (getProxmoxHostRoutingConfigFromInfrastructure as jest.Mock).mockReturnValue(null);
    (isProxmoxVmMissingResult as jest.Mock).mockReturnValue(false);
    (startProxmoxInstance as jest.Mock).mockResolvedValue({ ok: true, stdout: "", stderr: "" });
  });

  it("resumes eligible paid instances and writes the running patch (paused_reason cleared)", async () => {
    const { updates } = buildStub({
      candidates: [row({ id: "inst_a", user_id: "u_a" })],
      activeSubUserIds: ["u_a"],
    });

    const summary = await runResumeMispausedPaidSweep();

    expect(summary.resumed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(startProxmoxInstance).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("inst_a");
    expect(updates[0].patch).toEqual(
      expect.objectContaining({
        status: "running",
        lifecycle_state: "active",
        paused_reason: null,
      })
    );
  });

  it("skips paid instances whose owner has no active paid subscription", async () => {
    const { updates } = buildStub({
      candidates: [
        row({ id: "inst_active", user_id: "u_active" }),
        row({ id: "inst_lapsed", user_id: "u_lapsed" }),
      ],
      activeSubUserIds: ["u_active"],
    });

    const summary = await runResumeMispausedPaidSweep();

    expect(summary.scanned).toBe(2);
    expect(summary.eligible).toBe(1);
    expect(summary.skippedLapsed).toBe(1);
    expect(summary.resumed).toBe(1);
    expect(updates.map((u) => u.id)).toEqual(["inst_active"]);
  });

  it("respects the per-run limit cap", async () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      row({ id: `inst_${i}`, user_id: `u_${i}` })
    );
    buildStub({ candidates, activeSubUserIds: candidates.map((c) => c.user_id) });

    const summary = await runResumeMispausedPaidSweep({ limit: 2 });

    expect(summary.eligible).toBe(5);
    expect(summary.resumed).toBe(2);
    expect(startProxmoxInstance).toHaveBeenCalledTimes(2);
  });

  it("dry run reports eligibility without touching any VM", async () => {
    const { updates } = buildStub({
      candidates: [row({ id: "inst_a", user_id: "u_a" })],
      activeSubUserIds: ["u_a"],
    });

    const summary = await runResumeMispausedPaidSweep({ dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.eligible).toBe(1);
    expect(summary.resumed).toBe(0);
    expect(startProxmoxInstance).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("marks a missing VM as error instead of counting it resumed", async () => {
    (startProxmoxInstance as jest.Mock).mockResolvedValueOnce({
      ok: false,
      stdout: "HERMES_VM_MISSING\n",
      stderr: "",
      error: "exit 255",
    });
    (isProxmoxVmMissingResult as jest.Mock).mockReturnValueOnce(true);

    const { updates } = buildStub({
      candidates: [row({ id: "inst_gone", user_id: "u_a" })],
      activeSubUserIds: ["u_a"],
    });

    const summary = await runResumeMispausedPaidSweep();

    expect(summary.vmMissing).toBe(1);
    expect(summary.resumed).toBe(0);
    expect(updates[0].patch).toEqual(
      expect.objectContaining({ status: "error", lifecycle_state: "failed" })
    );
  });
});
