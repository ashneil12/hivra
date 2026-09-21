import { redeployPendingResizes } from "../pending-resize";
import { applyLiveUpdate, resolveInstanceIpv4 } from "../instance-orchestrator";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@clerk/nextjs/server", () => ({
  clerkClient: jest.fn().mockResolvedValue({
    users: { getUser: jest.fn().mockResolvedValue({ publicMetadata: {} }) },
  }),
}));
jest.mock("@/lib/instance-settings", () => ({
  extractGlobalHermesSettings: jest.fn(() => ({})),
}));
jest.mock("../instance-orchestrator", () => ({
  applyLiveUpdate: jest.fn(),
  resolveInstanceIpv4: jest.fn(),
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

const mockApply = applyLiveUpdate as jest.Mock;
const mockResolveIp = resolveInstanceIpv4 as jest.Mock;
const fromMock = supabaseAdmin!.from as jest.Mock;

let updateMock: jest.Mock;
let eqMock: jest.Mock;
let consoleWarn: jest.SpyInstance;
let consoleInfo: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  eqMock = jest.fn().mockResolvedValue({ error: null });
  updateMock = jest.fn(() => ({ eq: eqMock }));
  fromMock.mockReturnValue({ update: updateMock });
  mockResolveIp.mockResolvedValue("203.0.113.4");
  mockApply.mockResolvedValue({ applied: true });
  consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {});
  consoleInfo = jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleWarn.mockRestore();
  consoleInfo.mockRestore();
});

function row(over: Record<string, unknown> = {}) {
  return { id: "i1", user_id: "u1", backend: "webui", ...over } as never;
}

describe("redeployPendingResizes", () => {
  it("redeploys a webui instance and clears tier_change_pending", async () => {
    const summary = await redeployPendingResizes([row()]);
    expect(summary).toMatchObject({ redeployed: 1, failed: 0, skipped: 0 });
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({ tier_change_pending: false });
  });

  it("skips non-webui instances without redeploying", async () => {
    const summary = await redeployPendingResizes([row({ backend: "agent" })]);
    expect(summary.skipped).toBe(1);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("counts a failed redeploy and leaves the flag set", async () => {
    mockApply.mockResolvedValueOnce({ applied: false, error: "boom" });
    const summary = await redeployPendingResizes([row()]);
    expect(summary).toMatchObject({ redeployed: 0, failed: 1 });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("treats a missing IP as a failure (no redeploy attempted)", async () => {
    mockResolveIp.mockResolvedValueOnce("");
    const summary = await redeployPendingResizes([row()]);
    expect(summary.failed).toBe(1);
    expect(mockApply).not.toHaveBeenCalled();
  });

  // applyLiveUpdate is NOT wrapped by redeployOne and genuinely throws — e.g.
  // decryptApiKey rethrows on an undecryptable api_key_encrypted, which fails
  // identically on every tick rather than transiently. Under Promise.all that
  // one row rejected the whole wave, so this function threw, the
  // apply-pending-resizes cron's unguarded `await` 500'd the tick, and the
  // backlog ops event meant to escalate never fired. Because
  // tier_change_pending only clears on SUCCESS the poisoned row came back every
  // tick — and idle-first ordering sorts an unreachable box to the FRONT, so it
  // re-poisoned wave 1 forever and no cap upgrade behind it ever landed.
  it("contains a throwing row instead of rejecting the whole sweep", async () => {
    mockApply
      .mockRejectedValueOnce(new Error("Failed to decrypt API key"))
      .mockResolvedValueOnce({ applied: true });

    const summary = await redeployPendingResizes([row({ id: "poison" }), row({ id: "healthy" })]);

    expect(summary).toMatchObject({ redeployed: 1, failed: 1, skipped: 0 });
    expect(summary.results).toEqual(
      expect.arrayContaining([
        { id: "poison", redeployed: false, error: "redeploy_threw" },
        { id: "healthy", redeployed: true },
      ])
    );
    // The healthy row must still clear its flag — the poison must not block it.
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("keeps sweeping later waves after an earlier wave throws", async () => {
    // Poison sorts first (idle-first ordering); concurrency 1 forces it into its
    // own wave, so under Promise.all nothing after it was ever attempted.
    mockApply.mockRejectedValueOnce(new Error("SSH readiness timeout"));

    const summary = await redeployPendingResizes(
      [row({ id: "poison" }), row({ id: "a" }), row({ id: "b" })],
      { concurrency: 1 }
    );

    expect(summary).toMatchObject({ redeployed: 2, failed: 1 });
    expect(mockApply).toHaveBeenCalledTimes(3);
  });
});
