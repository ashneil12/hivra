import { supabaseAdmin } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";

/**
 * Takes the $10/month backup add-on off a customer's Stripe subscription.
 *
 * POST /api/billing/backup-addon adds one subscription item per purchase and
 * stamps it with metadata `type: "backup_addon"` and the `instance_id` it was
 * bought from. Turning backups off must remove that item, or the customer keeps
 * paying for backups that are no longer running.
 *
 * Only items with that metadata and one of the given instance ids are removed;
 * the plan's own items are never touched. Returns how many items were removed
 * (0 when there is no subscription or no matching item, which also makes a
 * retry after a later step failed safe).
 */
export async function removeBackupAddonBilling(params: {
  userId: string;
  instanceIds: string[];
}): Promise<{ removed: number }> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const instanceIds = new Set(params.instanceIds.filter(Boolean));
  if (instanceIds.size === 0) return { removed: 0 };

  const { data: sub, error } = await supabaseAdmin
    .from("hermes_subscriptions")
    .select("stripe_subscription_id")
    .eq("user_id", params.userId)
    .maybeSingle();
  if (error) throw new Error("Failed to load the subscription");
  const subscriptionId = (sub as { stripe_subscription_id?: string | null } | null)?.stripe_subscription_id;
  if (!subscriptionId) return { removed: 0 };

  const stripe = getStripe();
  const matching: string[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.subscriptionItems.list({
      subscription: subscriptionId,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const item of page.data) {
      const metadata = item.metadata ?? {};
      if (metadata.type === "backup_addon" && metadata.instance_id && instanceIds.has(metadata.instance_id)) {
        matching.push(item.id);
      }
    }
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }

  for (const itemId of matching) {
    await stripe.subscriptionItems.del(itemId, { proration_behavior: "create_prorations" });
  }
  return { removed: matching.length };
}
