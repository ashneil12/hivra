/**
 * Create Stripe yearly recurring prices for Pro and Power.
 *
 * Why a script and not the Stripe Dashboard UI: the price IDs become
 * env vars (`STRIPE_OPERATOR_YEARLY_PRICE_ID`, `STRIPE_FLEET_YEARLY_PRICE_ID`)
 * and we want a record of how/when they were created. Re-running this
 * script is idempotent — it looks up the existing monthly price to find
 * the Stripe product, then checks whether a yearly price already exists
 * on that product before creating a new one.
 *
 * Usage (from dashboard/):
 *   $ npm run script -- scripts/create-stripe-yearly-prices.ts
 *   or
 *   $ npx tsx scripts/create-stripe-yearly-prices.ts
 *   or
 *   $ npx tsx scripts/create-stripe-yearly-prices.ts --dry-run
 *
 * Requires STRIPE_SECRET_KEY in .env.local plus the existing monthly
 * price-ID env vars (STRIPE_OPERATOR_PRICE_ID, STRIPE_FLEET_PRICE_ID)
 * so we can resolve the right Stripe products.
 *
 * Yearly USD targets (locked in PricingSection / landing copy):
 *   Pro    → $79.00  (operator)
 *   Power  → $149.00 (fleet)
 *
 * After running, paste the printed price IDs into your env:
 *   STRIPE_OPERATOR_YEARLY_PRICE_ID=price_...
 *   STRIPE_FLEET_YEARLY_PRICE_ID=price_...
 */

import Stripe from "stripe";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const STRIPE_API_VERSION = "2026-03-25.dahlia";

interface YearlyPriceSpec {
  /** Internal plan key used in env-var name and logging. */
  planKey: "operator" | "fleet";
  /** User-facing label. */
  label: string;
  /** Existing monthly price-ID env var, used to find the Stripe product. */
  monthlyPriceEnvVar: string;
  /** Yearly price in cents. */
  yearlyAmountCents: number;
  /** Suffix for the new env var the user should set after running. */
  yearlyEnvVarName: string;
}

const SPECS: YearlyPriceSpec[] = [
  {
    planKey: "operator",
    label: "Pro",
    monthlyPriceEnvVar: "STRIPE_OPERATOR_PRICE_ID",
    yearlyAmountCents: 7900, // $79.00
    yearlyEnvVarName: "STRIPE_OPERATOR_YEARLY_PRICE_ID",
  },
  {
    planKey: "fleet",
    label: "Power",
    monthlyPriceEnvVar: "STRIPE_FLEET_PRICE_ID",
    yearlyAmountCents: 14900, // $149.00
    yearlyEnvVarName: "STRIPE_FLEET_YEARLY_PRICE_ID",
  },
];

function getStripeOrDie(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY missing from .env.local. Add it before running this script."
    );
  }
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion });
}

function parseOptions(): { dryRun: boolean } {
  const args = process.argv.slice(2);
  return { dryRun: args.includes("--dry-run") };
}

async function findExistingYearlyPrice(
  stripe: Stripe,
  productId: string,
  amountCents: number
): Promise<Stripe.Price | null> {
  // Search all active prices on the product. We match by interval=year,
  // currency=usd, and unit_amount so accidental re-runs don't create
  // duplicate $79/yr prices.
  const prices = await stripe.prices.list({
    product: productId,
    active: true,
    limit: 100,
  });
  for (const price of prices.data) {
    if (
      price.recurring?.interval === "year" &&
      price.currency === "usd" &&
      price.unit_amount === amountCents
    ) {
      return price;
    }
  }
  return null;
}

async function ensureYearlyPrice(
  stripe: Stripe,
  spec: YearlyPriceSpec,
  dryRun: boolean
): Promise<void> {
  const monthlyPriceId = process.env[spec.monthlyPriceEnvVar];
  if (!monthlyPriceId) {
    console.error(
      `[skip] ${spec.label}: ${spec.monthlyPriceEnvVar} not set — can't resolve Stripe product. ` +
        `Set the monthly price first.`
    );
    return;
  }

  const monthlyPrice = await stripe.prices.retrieve(monthlyPriceId);
  const productId =
    typeof monthlyPrice.product === "string" ? monthlyPrice.product : monthlyPrice.product.id;
  const product = await stripe.products.retrieve(productId);

  console.log(
    `[${spec.label}] resolved Stripe product "${product.name}" (${productId}) from monthly price ${monthlyPriceId}`
  );

  const existing = await findExistingYearlyPrice(stripe, productId, spec.yearlyAmountCents);
  if (existing) {
    console.log(
      `[${spec.label}] yearly price already exists at $${(spec.yearlyAmountCents / 100).toFixed(2)}/yr → ${existing.id}`
    );
    console.log(`             set ${spec.yearlyEnvVarName}=${existing.id}`);
    return;
  }

  if (dryRun) {
    console.log(
      `[${spec.label}] (dry-run) would create yearly price: $${(spec.yearlyAmountCents / 100).toFixed(2)}/yr on ${productId}`
    );
    return;
  }

  const created = await stripe.prices.create({
    product: productId,
    currency: "usd",
    unit_amount: spec.yearlyAmountCents,
    recurring: { interval: "year" },
    nickname: `${spec.label} yearly ($${(spec.yearlyAmountCents / 100).toFixed(2)})`,
    metadata: {
      hermes_plan_key: spec.planKey,
      hermes_cadence: "yearly",
      created_by_script: "create-stripe-yearly-prices",
    },
  });
  console.log(
    `[${spec.label}] ✓ created yearly price ${created.id} ($${(spec.yearlyAmountCents / 100).toFixed(2)}/yr)`
  );
  console.log(`             set ${spec.yearlyEnvVarName}=${created.id}`);
}

async function main(): Promise<void> {
  const { dryRun } = parseOptions();
  const stripe = getStripeOrDie();

  if (dryRun) {
    console.log("─── DRY RUN — no Stripe writes will happen ───");
  }

  for (const spec of SPECS) {
    await ensureYearlyPrice(stripe, spec, dryRun);
  }

  console.log("\nNext steps:");
  console.log("  1. Copy the price IDs into your .env.local AND your Vercel env (production + preview).");
  console.log("  2. Re-deploy so the runtime picks up the new env vars.");
  console.log("  3. The yearly cadence flag in the subscribe API will start accepting `cadence: \"yearly\"` once the env vars resolve.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
