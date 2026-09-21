import { recordInstanceUserActivity } from "@/lib/instance-activity";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

describe("recordInstanceUserActivity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("records deliberate user activity with a source and timestamp", async () => {
    const update = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: null }),
      }),
    });
    (supabaseAdmin!.from as jest.Mock).mockReturnValue({ update });

    await recordInstanceUserActivity({
      instanceId: "inst_123",
      userId: "user_123",
      source: "chat_send",
      now: new Date("2026-05-14T20:30:00.000Z"),
    });

    expect(supabaseAdmin!.from).toHaveBeenCalledWith("hermes_instances");
    expect(update).toHaveBeenCalledWith({
      last_activity_at: "2026-05-14T20:30:00.000Z",
      updated_at: "2026-05-14T20:30:00.000Z",
    });
  });

  it("does not throw when the best-effort activity write fails", async () => {
    const update = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: { message: "db unavailable" } }),
      }),
    });
    (supabaseAdmin!.from as jest.Mock).mockReturnValue({ update });

    await expect(
      recordInstanceUserActivity({
        instanceId: "inst_123",
        userId: "user_123",
        source: "terminal_input",
      })
    ).resolves.toEqual({ ok: false, error: "db unavailable" });

    expect(log.warn).toHaveBeenCalledWith(
      "failed to record instance user activity",
      expect.objectContaining({
        source: "instance-activity",
        activitySource: "terminal_input",
        instanceId: "inst_123",
        userId: "user_123",
        failureType: "instance_activity_update_failed",
      })
    );
  });
});
