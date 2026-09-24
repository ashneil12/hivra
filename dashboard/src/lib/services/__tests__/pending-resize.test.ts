import { redeployPendingResizes } from "../pending-resize";
import { applyLiveUpdate, resolveInstanceIpv4 } from "../instance-orchestrator";
import { USER_LIVE_UPDATE, systemLiveUpdate } from "../live-update-initiator";
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
  mockApply.mockResolvedValue({ applied: true, initiator: SWEEP, inFlightGate: null });
  consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {});
  consoleInfo = jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleWarn.mockRestore();
  consoleInfo.mockRestore();
});

const SWEEP = systemLiveUpdate("pending_resize_sweep");
const sweep = { initiator: SWEEP };

function row(over: Record<string, unknown> = {}) {
  return { id: "i1", user_id: "u1", backend: "webui", ...over } as never;
}

describe("redeployPendingResizes", () => {
  it("redeploys a webui instance and clears tier_change_pending", async () => {
    const summary = await redeployPendingResizes([row()], sweep);
    expect(summary).toMatchObject({ redeployed: 1, failed: 0, skipped: 0 });
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({ tier_change_pending: false });
  });

  it("passes the caller's initiator through: the sweep is gated, the unlock flow is not", async () => {
    await redeployPendingResizes([row()], sweep);
    expect(mockApply.mock.calls[0][4]).toEqual({ initiator: SWEEP });

    mockApply.mockClear();
    await redeployPendingResizes([row()], { initiator: USER_LIVE_UPDATE });
    expect(mockApply.mock.calls[0][4]).toEqual({ initiator: USER_LIVE_UPDATE });
  });

  it("defers a box with an agent turn in flight and keeps its flag for the next tick", async () => {
    mockApply.mockResolvedValueOnce({
      applied: false,
      deferred: true,
      reason: "deferred_busy",
      error: "Deferred: an agent turn is in flight (deferral 1); the next run retries",
      initiator: SWEEP,
      inFlightGate: {
        action: "defer",
        verdict: "busy",
        reason: "in_flight_turn",
        trigger: "pending_resize_sweep",
        liveTurns: 1,
        unreadableMarkers: 0,
        gatewayActive: 0,
        gatewayUnknown: 0,
        deferrals: 1,
        streakSeconds: 0,
      },
    });

    const summary = await redeployPendingResizes([row()], sweep);

    expect(summary).toMatchObject({ redeployed: 0, failed: 0, skipped: 0, deferred: 1 });
    expect(summary.results).toEqual([
      { id: "i1", redeployed: false, deferred: true, error: "deferred_busy" },
    ]);
    // tier_change_pending stays set: the next sweep retries this box.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("skips non-webui instances without redeploying", async () => {
    const summary = await redeployPendingResizes([row({ backend: "agent" })], sweep);
    expect(summary.skipped).toBe(1);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it("counts a failed redeploy and leaves the flag set", async () => {
    mockApply.mockResolvedValueOnce({ applied: false, error: "boom", initiator: SWEEP });
    const summary = await redeployPendingResizes([row()], sweep);
    expect(summary).toMatchObject({ redeployed: 0, failed: 1 });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("treats a missing IP as a failure (no redeploy attempted)", async () => {
    mockResolveIp.mockResolvedValueOnce("");
    const summary = await redeployPendingResizes([row()], sweep);
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
      .mockResolvedValueOnce({ applied: true, initiator: SWEEP, inFlightGate: null });

    const summary = await redeployPendingResizes([row({ id: "poison" }), row({ id: "healthy" })], sweep);

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
      { concurrency: 1, initiator: SWEEP }
    );

    expect(summary).toMatchObject({ redeployed: 2, failed: 1 });
    expect(mockApply).toHaveBeenCalledTimes(3);
  });
});
