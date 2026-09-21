import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import * as dotenv from "dotenv";
import * as path from "path";
import {
  assertValidTrialExtensionOptions,
  parseTrialExtensionOptions,
  type TrialExtensionOptions,
} from "../src/lib/billing/trial-extension-options";

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const STRIPE_API_VERSION = "2026-03-25.dahlia";
const TIME_EXTENSION_METADATA_KEY = "hermes_time_extension_2026_04";
const TRIAL_EXTENSION_METADATA_KEY = "hermes_trial_extension_2026_04";
const SECONDS_PER_DAY = 24 * 60 * 60;

type SubscriptionRow = {
  user_id: string;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  status: string | null;
  plan: string | null;
};

function hasGrantMarker(subscription: Stripe.Subscription) {
  return (
    subscription.metadata?.[TIME_EXTENSION_METADATA_KEY] === "true" ||
    subscription.metadata?.[TRIAL_EXTENSION_METADATA_KEY] === "true"
  );
}

function getSavedBaseEnd(subscription: Stripe.Subscription) {
  const value = subscription.metadata?.[`${TIME_EXTENSION_METADATA_KEY}_base_end`];
  if (!value) return null;

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getSavedGrantKind(subscription: Stripe.Subscription) {
  const value = subscription.metadata?.[`${TIME_EXTENSION_METADATA_KEY}_kind`];
  return value === "active_billing_delay" || value === "trialing_trial_end_extension"
    ? value
    : null;
}

function getSubscriptionCurrentPeriodEnd(subscription: Stripe.Subscription) {
  const firstItemPeriodEnd = subscription.items?.data?.[0]?.current_period_end;
  if (typeof firstItemPeriodEnd === "number") return firstItemPeriodEnd;

  const legacyPeriodEnd = (subscription as unknown as { current_period_end?: unknown })
    .current_period_end;
  return typeof legacyPeriodEnd === "number" ? legacyPeriodEnd : null;
}

async function fetchSubscriptionRows(supabaseAdmin: SupabaseClient) {
  const rows: SubscriptionRow[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await supabaseAdmin
      .from("hermes_subscriptions")
      .select("user_id, stripe_subscription_id, stripe_customer_id, status, plan")
      .not("stripe_subscription_id", "is", null)
      .range(from, to);

    if (error) {
      throw new Error(`Failed to read subscriptions: ${error.message}`);
    }

    rows.push(...((data || []) as SubscriptionRow[]));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

async function extendActiveSubscriptionTime({
  stripe,
  subscription,
  options,
}: {
  stripe: Stripe;
  subscription: Stripe.Subscription;
  options: TrialExtensionOptions;
}) {
  const alreadyGranted = hasGrantMarker(subscription);
  if (alreadyGranted && !options.reapplyGrant) {
    return "skipped_already_granted";
  }

  const savedGrantKind = getSavedGrantKind(subscription);
  const treatAsActiveBillingDelay =
    subscription.status === "active" || savedGrantKind === "active_billing_delay";

  if (subscription.status === "trialing" && !treatAsActiveBillingDelay) {
    const baseEnd =
      (options.reapplyGrant ? getSavedBaseEnd(subscription) : null) ??
      Math.max(subscription.trial_end || 0, Math.floor(Date.now() / 1000));
    const trialEnd = baseEnd + options.extensionDays * SECONDS_PER_DAY;

    if (!options.dryRun) {
      await stripe.subscriptions.update(subscription.id, {
        trial_end: trialEnd,
        proration_behavior: "none",
        metadata: {
          ...subscription.metadata,
          [TIME_EXTENSION_METADATA_KEY]: "true",
          [`${TIME_EXTENSION_METADATA_KEY}_days`]: String(options.extensionDays),
          [`${TIME_EXTENSION_METADATA_KEY}_kind`]: "trialing_trial_end_extension",
          [`${TIME_EXTENSION_METADATA_KEY}_base_end`]: String(baseEnd),
        },
      });
    }

    return `trial_extended_until_${new Date(trialEnd * 1000).toISOString()}`;
  }

  if (treatAsActiveBillingDelay) {
    const baseEnd =
      (options.reapplyGrant ? getSavedBaseEnd(subscription) : null) ??
      Math.max(
        getSubscriptionCurrentPeriodEnd(subscription) || 0,
        Math.floor(Date.now() / 1000)
      );
    const trialEnd = baseEnd + options.extensionDays * SECONDS_PER_DAY;

    if (!options.dryRun) {
      await stripe.subscriptions.update(subscription.id, {
        trial_end: trialEnd,
        proration_behavior: "none",
        metadata: {
          ...subscription.metadata,
          [TIME_EXTENSION_METADATA_KEY]: "true",
          [`${TIME_EXTENSION_METADATA_KEY}_days`]: String(options.extensionDays),
          [`${TIME_EXTENSION_METADATA_KEY}_kind`]: "active_billing_delay",
          [`${TIME_EXTENSION_METADATA_KEY}_base_end`]: String(baseEnd),
        },
      });
    }

    return `active_billing_delayed_until_${new Date(trialEnd * 1000).toISOString()}`;
  }

  return `skipped_status_${subscription.status}`;
}

async function main() {
  const options = parseTrialExtensionOptions(process.argv.slice(2));
  assertValidTrialExtensionOptions(options);

  const stripeKey = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_TEST_SECRET_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!stripeKey) throw new Error("Missing STRIPE_SECRET_KEY or STRIPE_TEST_SECRET_KEY");
  if (!supabaseUrl || !supabaseServiceKey) throw new Error("Missing Supabase credentials");

  const stripe = new Stripe(stripeKey, {
    apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
  });
  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
  const rows = await fetchSubscriptionRows(supabaseAdmin);

  console.log(
    `${options.dryRun ? "Dry run" : "Executing"} time extension for ${rows.length} subscription records.`
  );

  const summary = new Map<string, number>();

  for (const row of rows) {
    if (!row.stripe_subscription_id || row.stripe_subscription_id.startsWith("manual_")) {
      summary.set("skipped_manual", (summary.get("skipped_manual") || 0) + 1);
      continue;
    }

    try {
      const subscription = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
      const result = await extendActiveSubscriptionTime({
        stripe,
        subscription,
        options,
      });

      summary.set(result, (summary.get(result) || 0) + 1);
      console.log(`${row.user_id} ${row.stripe_subscription_id}: ${result}`);
    } catch (error) {
      summary.set("failed", (summary.get("failed") || 0) + 1);
      console.error(`${row.user_id} ${row.stripe_subscription_id}: failed`, {
        errorName: error instanceof Error ? error.name : typeof error,
        stripeErrorType: error instanceof Stripe.errors.StripeError ? error.type : undefined,
        stripeErrorCode: error instanceof Stripe.errors.StripeError ? error.code : undefined,
      });
    }
  }

  console.log("Summary:");
  for (const [key, count] of summary.entries()) {
    console.log(`- ${key}: ${count}`);
  }

  if (options.dryRun) {
    console.log("No Stripe changes were made. Re-run with --execute to extend active subscription time.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
