import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { getStripe } from "@/lib/stripe";
import { StripeWebhookService } from "@/lib/services/stripe-webhook-service";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
const mockMaybeSingle = jest.fn();
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = () => mockMaybeSingle();
      return q;
    },
  },
}));
jest.mock("@/lib/stripe", () => ({ getStripe: jest.fn() }));
jest.mock("@/lib/services/stripe-webhook-service", () => ({
  StripeWebhookService: { handleSubscriptionChange: jest.fn().mockResolvedValue(undefined) },
}));

const trialing = { id: "sub_1", status: "trialing", metadata: { user_id: "u1", plan: "operator", hivra_trial: "card_7d" } };

describe("POST /api/billing/end-trial", () => {
  let retrieve: jest.Mock;
  let update: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "u1" });
    mockMaybeSingle.mockResolvedValue({ data: { stripe_subscription_id: "sub_1" }, error: null });
    retrieve = jest.fn().mockResolvedValue(trialing);
    update = jest.fn().mockResolvedValue({ ...trialing, status: "active" });
    (getStripe as jest.Mock).mockReturnValue({ subscriptions: { retrieve, update } });
  });

  it("ends the trial now, charges the card and applies the full plan", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith("sub_1", { trial_end: "now", payment_behavior: "error_if_incomplete" });
    expect(StripeWebhookService.handleSubscriptionChange).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }), expect.anything());
    expect((await res.json()).data).toEqual({ upgraded: true });
  });

  it.each([
    ["a subscription that is not a card trial", { ...trialing, metadata: { user_id: "u1", plan: "operator" } }],
    ["a trial that is already over", { ...trialing, status: "active" }],
    ["someone else's subscription", { ...trialing, metadata: { ...trialing.metadata, user_id: "u2" } }],
  ])("refuses %s", async (_name, sub) => {
    retrieve.mockResolvedValueOnce(sub);
    const res = await POST();
    expect(res.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps the trial and says so when the charge fails", async () => {
    update.mockRejectedValueOnce(new Error("card_declined"));
    const res = await POST();
    expect(res.status).toBe(402);
    expect(StripeWebhookService.handleSubscriptionChange).not.toHaveBeenCalled();
  });

  it("requires sign-in", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
    expect((await POST()).status).toBe(401);
  });
});
