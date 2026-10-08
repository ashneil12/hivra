import { removeBackupAddonBilling } from "../backup-addon-billing";
import { getStripe } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock("@/lib/stripe", () => ({ getStripe: jest.fn() }));

type Item = { id: string; metadata?: Record<string, string> };

function stubSubscription(data: { stripe_subscription_id: string | null } | null, error: unknown = null) {
  (supabaseAdmin!.from as jest.Mock).mockReturnValue({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        maybeSingle: jest.fn().mockResolvedValue({ data, error }),
      }),
    }),
  });
}

function stubStripe(pages: Item[][]) {
  const list = jest.fn();
  pages.forEach((data, index) => {
    list.mockResolvedValueOnce({ data, has_more: index < pages.length - 1 });
  });
  const del = jest.fn().mockResolvedValue({});
  (getStripe as jest.Mock).mockReturnValue({ subscriptionItems: { list, del } });
  return { list, del };
}

describe("removeBackupAddonBilling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("removes only the backup add-on items bought from the given instances", async () => {
    stubSubscription({ stripe_subscription_id: "sub_1" });
    const { list, del } = stubStripe([
      [
        { id: "si_plan", metadata: {} },
        { id: "si_backup_a", metadata: { type: "backup_addon", instance_id: "inst-a" } },
        { id: "si_backup_other", metadata: { type: "backup_addon", instance_id: "inst-other" } },
        { id: "si_not_backup", metadata: { type: "something_else", instance_id: "inst-a" } },
        { id: "si_backup_b", metadata: { type: "backup_addon", instance_id: "inst-b" } },
      ],
    ]);

    const result = await removeBackupAddonBilling({ userId: "user_1", instanceIds: ["inst-a", "inst-b"] });

    expect(result).toEqual({ removed: 2 });
    expect(list).toHaveBeenCalledWith({ subscription: "sub_1", limit: 100 });
    expect(del).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledWith("si_backup_a", { proration_behavior: "create_prorations" });
    expect(del).toHaveBeenCalledWith("si_backup_b", { proration_behavior: "create_prorations" });
  });

  it("reads every page of subscription items", async () => {
    stubSubscription({ stripe_subscription_id: "sub_1" });
    const { list, del } = stubStripe([
      [{ id: "si_1", metadata: {} }],
      [{ id: "si_backup", metadata: { type: "backup_addon", instance_id: "inst-a" } }],
    ]);

    const result = await removeBackupAddonBilling({ userId: "user_1", instanceIds: ["inst-a"] });

    expect(result).toEqual({ removed: 1 });
    expect(list).toHaveBeenNthCalledWith(2, { subscription: "sub_1", limit: 100, starting_after: "si_1" });
    expect(del).toHaveBeenCalledWith("si_backup", expect.anything());
  });

  it("removes nothing, and calls Stripe for nothing, when there is no subscription", async () => {
    stubSubscription(null);
    const { list, del } = stubStripe([[]]);

    expect(await removeBackupAddonBilling({ userId: "user_1", instanceIds: ["inst-a"] })).toEqual({ removed: 0 });
    expect(list).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("removes nothing when no add-on item matches, so a repeated request is safe", async () => {
    stubSubscription({ stripe_subscription_id: "sub_1" });
    const { del } = stubStripe([[{ id: "si_plan", metadata: {} }]]);

    expect(await removeBackupAddonBilling({ userId: "user_1", instanceIds: ["inst-a"] })).toEqual({ removed: 0 });
    expect(del).not.toHaveBeenCalled();
  });

  it("does nothing for an empty instance list", async () => {
    stubSubscription({ stripe_subscription_id: "sub_1" });
    const { list } = stubStripe([[]]);

    expect(await removeBackupAddonBilling({ userId: "user_1", instanceIds: [] })).toEqual({ removed: 0 });
    expect(list).not.toHaveBeenCalled();
  });

  it("throws, so the caller keeps backups on, when the subscription cannot be read or Stripe fails", async () => {
    stubSubscription(null, { message: "db down" });
    await expect(removeBackupAddonBilling({ userId: "user_1", instanceIds: ["inst-a"] })).rejects.toThrow(
      "Failed to load the subscription",
    );

    stubSubscription({ stripe_subscription_id: "sub_1" });
    const { del } = stubStripe([[{ id: "si_backup", metadata: { type: "backup_addon", instance_id: "inst-a" } }]]);
    del.mockRejectedValueOnce(new Error("stripe down"));
    await expect(removeBackupAddonBilling({ userId: "user_1", instanceIds: ["inst-a"] })).rejects.toThrow("stripe down");
  });
});
