import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import * as dotenv from "dotenv";
import * as path from "path";

// Load .env.local
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const stripeKey = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_TEST_SECRET_KEY;
if (!stripeKey) throw new Error("Missing STRIPE_SECRET_KEY or STRIPE_TEST_SECRET_KEY");

const stripe = new Stripe(stripeKey, {
  apiVersion: "2026-03-25.dahlia",
});

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!supabaseUrl || !supabaseServiceKey) throw new Error("Missing Supabase credentials");

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
const clerkSecretKey = process.env.CLERK_SECRET_KEY;

async function purgeUser(userId: string) {
  console.log(`\n--- Starting purge for user: ${userId} ---`);

  // 1. Get stripe customer ID
  const { data: sub } = await supabaseAdmin
    .from("hermes_subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (sub?.stripe_customer_id) {
    try {
      await stripe.customers.del(sub.stripe_customer_id);
      console.log(`✅ Stripe customer deleted: ${sub.stripe_customer_id}`);
    } catch (e: unknown) {
      const err = e as { message?: string };
      console.error(`⚠️ Stripe customer deletion failed: ${err.message}`);
    }
  } else {
    console.log(`ℹ️ No Stripe customer found in DB for user ${userId}`);
  }

  // 2. Delete Supabase records
  try {
    await supabaseAdmin.from("hermes_instances").delete().eq("user_id", userId);
    await supabaseAdmin.from("hermes_subscriptions").delete().eq("user_id", userId);
    await supabaseAdmin.from("hermes_trial_usage").delete().eq("user_id", userId);
    await supabaseAdmin.from("user_api_keys").delete().eq("user_id", userId);
    await supabaseAdmin.from("user_vault_profiles").delete().eq("user_id", userId);
    console.log(`✅ Supabase application records deleted.`);
  } catch (e: unknown) {
    const err = e as { message?: string };
    console.error(`⚠️ Failed to delete some Supabase records: ${err.message}`);
  }

  // 3. Delete Clerk user
  if (clerkSecretKey) {
    const res = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${clerkSecretKey}` },
    });
    if (res.ok) {
      console.log(`✅ Clerk user deleted.`);
    } else {
      const errorText = await res.text();
      // 404 means it's already deleted
      if (res.status === 404) {
        console.log(`✅ Clerk user not found (likely already deleted).`);
      } else {
        console.log(`⚠️ Clerk user deletion failed: ${res.statusText} - ${errorText}`);
      }
    }
  } else {
    console.log(`ℹ️ CLERK_SECRET_KEY not set. Skipping Clerk deletion.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      "Please provide a list of Clerk user IDs to purge.\nUsage: npx ts-node scripts/purge-abusers.ts user_123 user_456"
    );
    process.exit(1);
  }

  for (const arg of args) {
    await purgeUser(arg);
  }
}

main().catch(console.error);
