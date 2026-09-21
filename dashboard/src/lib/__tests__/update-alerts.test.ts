import { getLatestFailedInstanceUpdateAlerts } from "../update-alerts";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

function mockOpsEventsQuery(options: {
  data?: unknown[] | null;
  error?: unknown;
  reject?: Error;
}) {
  const limitMock = options.reject
    ? jest.fn().mockRejectedValue(options.reject)
    : jest.fn().mockResolvedValue({
        data: options.data ?? null,
        error: options.error ?? null,
      });
  // Order chain now ends in .limit() so the dedupe-by-instance pull is
  // bounded. The mock matches the production shape: order(...).limit(...).
  const orderMock = jest.fn().mockReturnValue({
    limit: limitMock,
  });
  const inMock = jest.fn().mockReturnValue({
    order: orderMock,
  });
  const isMock = jest.fn().mockReturnValue({
    in: inMock,
  });
  const eqMock = jest.fn().mockReturnValue({
    is: isMock,
  });
  const selectMock = jest.fn().mockReturnValue({
    eq: eqMock,
  });

  (supabaseAdmin!.from as jest.Mock).mockReturnValue({
    select: selectMock,
  });

  return {
    selectMock,
    eqMock,
    isMock,
    inMock,
    orderMock,
    limitMock,
  };
}

describe("getLatestFailedInstanceUpdateAlerts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the latest failure when it is still the most recent update event", async () => {
    mockOpsEventsQuery({
      data: [
        {
          instance_id: "inst-123",
          title: "Auto-update failed",
          message: "Auto-update reported a host-side failure.",
          last_seen_at: "2026-04-23T06:00:00.000Z",
          metadata: {
            status: "failed",
            runType: "scheduled",
            reason: "exit_status_1",
          },
        },
      ],
    });

    await expect(
      getLatestFailedInstanceUpdateAlerts(["inst-123"])
    ).resolves.toEqual({
      "inst-123": {
        title: "Auto-update failed",
        message: "Auto-update reported a host-side failure.",
        lastSeenAt: "2026-04-23T06:00:00.000Z",
        reason: "exit_status_1",
        runType: "scheduled",
      },
    });
  });

  it("suppresses stale failures when a newer success has already been recorded", async () => {
    mockOpsEventsQuery({
      data: [
        {
          instance_id: "inst-123",
          title: "Manual update succeeded",
          message: "Manual update completed successfully.",
          last_seen_at: "2026-04-23T07:00:00.000Z",
          metadata: {
            status: "succeeded",
            runType: "manual",
          },
        },
        {
          instance_id: "inst-123",
          title: "Auto-update failed",
          message: "Auto-update reported a host-side failure.",
          last_seen_at: "2026-04-23T06:00:00.000Z",
          metadata: {
            status: "failed",
            runType: "scheduled",
          },
        },
      ],
    });

    await expect(
      getLatestFailedInstanceUpdateAlerts(["inst-123"])
    ).resolves.toEqual({});
  });

  it("normalizes requested ids and skips malformed rows", async () => {
    const { inMock } = mockOpsEventsQuery({
      data: [
        {
          instance_id: "inst-123",
          title: "   ",
          message: "Auto-update reported a host-side failure.",
          last_seen_at: "2026-04-23T06:00:00.000Z",
          metadata: {
            status: "failed",
            runType: "scheduled",
          },
        },
        {
          instance_id: "inst-456",
          title: "Manual update failed",
          message: "Manual update reported a host-side failure.",
          last_seen_at: "2026-04-23T07:00:00.000Z",
          metadata: {
            status: "failed",
            runType: "manual",
            reason: " exit_status_2 ",
          },
        },
        {
          instance_id: "inst-789",
          title: "Broken status",
          message: "This should be ignored.",
          last_seen_at: "2026-04-23T08:00:00.000Z",
          metadata: {
            status: "unknown",
            runType: "manual",
          },
        },
      ],
    });

    await expect(
      getLatestFailedInstanceUpdateAlerts([" inst-456 ", "", "inst-456", " inst-123 "])
    ).resolves.toEqual({
      "inst-456": {
        title: "Manual update failed",
        message: "Manual update reported a host-side failure.",
        lastSeenAt: "2026-04-23T07:00:00.000Z",
        reason: "exit_status_2",
        runType: "manual",
      },
    });

    expect(inMock).toHaveBeenCalledWith("instance_id", ["inst-456", "inst-123"]);
  });

  it("warns and returns no alerts when the ops-events query returns an error", async () => {
    (log.warn as jest.Mock).mockClear();
    mockOpsEventsQuery({
      error: { message: "relation does not exist" },
    });

    await expect(
      getLatestFailedInstanceUpdateAlerts(["inst-123"])
    ).resolves.toEqual({});

    expect(log.warn).toHaveBeenCalledWith(
      "failed to read update status events; continuing without alert badges",
      expect.objectContaining({
        source: "update-alerts",
        failureType: "update_alert_read_failed",
        context: "query_error",
        errorDescription: "relation does not exist",
      }),
      expect.anything()
    );
  });

  it("warns and returns no alerts when the ops-events query throws unexpectedly", async () => {
    (log.warn as jest.Mock).mockClear();
    mockOpsEventsQuery({
      reject: new Error("boom"),
    });

    await expect(
      getLatestFailedInstanceUpdateAlerts(["inst-123"])
    ).resolves.toEqual({});

    expect(log.warn).toHaveBeenCalledWith(
      "failed to read update status events; continuing without alert badges",
      expect.objectContaining({
        source: "update-alerts",
        failureType: "update_alert_read_failed",
        context: "unexpected_error",
        errorDescription: "boom",
      }),
      expect.anything()
    );
  });
});
