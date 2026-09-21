import { markStripeWebhookEventFailed } from "../stripe-webhook-events";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

describe("markStripeWebhookEventFailed", () => {
  let updateBuilder: {
    update: jest.Mock;
    eq: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    updateBuilder = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };
    (supabaseAdmin!.from as jest.Mock).mockReturnValue(updateBuilder);
  });

  it("redacts secret-like values before persisting the failure message", async () => {
    await markStripeWebhookEventFailed(
      "evt_123",
      new Error("refresh_token=super-secret client_secret=top-secret")
    );

    const updatePayload = updateBuilder.update.mock.calls[0][0];

    expect(updatePayload.status).toBe("failed");
    expect(updatePayload.last_error).toContain("refresh_token=[REDACTED]");
    expect(updatePayload.last_error).toContain("client_secret=[REDACTED]");
    expect(updatePayload.last_error).not.toContain("super-secret");
    expect(updatePayload.last_error).not.toContain("top-secret");
  });
});
