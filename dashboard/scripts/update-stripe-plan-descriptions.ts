/**
 * Sync Stripe product descriptions for Hivra plans and legacy Stripe products.
 *
 * Usage (from dashboard/):
 *   $ npx tsx scripts/update-stripe-plan-descriptions.ts --dry-run
 *   $ npx tsx scripts/update-stripe-plan-descriptions.ts
 *
 * Requires STRIPE_SECRET_KEY plus the paid plan monthly price IDs in
 * .env.local. The script resolves each price to its Stripe product and
 * writes the description from src/lib/subscription/plans.ts.
 */

import Stripe from "stripe";
import * as dotenv from "dotenv";
import * as path from "path";
import { PLANS, type PlanKey } from "../src/lib/subscription/plans";

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

const STRIPE_API_VERSION = "2026-03-25.dahlia";

interface PlanDescriptionSpec {
  planKey?: PlanKey;
  label: string;
  monthlyPriceEnvVar?: string;
  fallbackProductNames?: string[];
  description: string;
}

const SPECS: PlanDescriptionSpec[] = [
  {
    planKey: "free",
    label: "Legacy Starter products",
    fallbackProductNames: ["MoltBot Starter"],
    description: PLANS.free.description,
  },
  {
    planKey: "operator",
    label: PLANS.operator.name,
    monthlyPriceEnvVar: "STRIPE_OPERATOR_PRICE_ID",
    fallbackProductNames: ["OpenClaw Pro", "MoltBot Pro"],
    description: PLANS.operator.description,
  },
  {
    planKey: "fleet",
    label: PLANS.fleet.name,
    monthlyPriceEnvVar: "STRIPE_FLEET_PRICE_ID",
    fallbackProductNames: ["OpenClaw Business", "MoltBot Enterprise"],
    description: PLANS.fleet.description,
  },
  {
    planKey: "command",
    label: PLANS.command.name,
    monthlyPriceEnvVar: "STRIPE_COMMAND_PRICE_ID",
    fallbackProductNames: ["OpenClaw Done For You", "MoltBot Done For You 2026"],
    description: PLANS.command.description,
  },
  {
    label: "Legacy shared OpenClaw Starter product",
    fallbackProductNames: ["OpenClaw Starter"],
    description:
      "Hivra plans use fixed active-agent slots: 1 on Free, 3 on Pro, and 5 on Power.",
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

function isDeletedProduct(product: Stripe.Product | Stripe.DeletedProduct): product is Stripe.DeletedProduct {
  return "deleted" in product && product.deleted === true;
}

async function resolveProductIdFromPrice(stripe: Stripe, monthlyPriceId: string): Promise<string> {
  const monthlyPrice = await stripe.prices.retrieve(monthlyPriceId);
  return typeof monthlyPrice.product === "string" ? monthlyPrice.product : monthlyPrice.product.id;
}

async function listActiveProducts(stripe: Stripe): Promise<Stripe.Product[]> {
  const products: Stripe.Product[] = [];
  let startingAfter: string | undefined;

  do {
    const page = await stripe.products.list({
      active: true,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    products.push(...page.data);
    startingAfter = page.has_more ? page.data[page.data.length - 1]?.id : undefined;
  } while (startingAfter);

  return products;
}

async function resolveProductIds(stripe: Stripe, spec: PlanDescriptionSpec): Promise<string[]> {
  const productIds = new Set<string>();

  if (spec.monthlyPriceEnvVar) {
    const monthlyPriceId = process.env[spec.monthlyPriceEnvVar];
    if (monthlyPriceId) {
      productIds.add(await resolveProductIdFromPrice(stripe, monthlyPriceId));
    } else {
      console.warn(
        `[info] ${spec.label}: ${spec.monthlyPriceEnvVar} not set, trying legacy product names.`
      );
    }
  }

  if (spec.fallbackProductNames?.length) {
    const activeProducts = await listActiveProducts(stripe);
    for (const productName of spec.fallbackProductNames) {
      const matches = activeProducts.filter((product) => product.name === productName);
      if (matches.length === 1) {
        productIds.add(matches[0].id);
      } else if (matches.length === 0) {
        console.warn(`[info] ${spec.label}: no active Stripe product named "${productName}".`);
      } else {
        console.warn(
          `[skip] ${spec.label}: found ${matches.length} active Stripe products named "${productName}".`
        );
      }
    }
  }

  return [...productIds];
}

async function syncProductDescription(
  stripe: Stripe,
  spec: PlanDescriptionSpec,
  productId: string,
  dryRun: boolean
): Promise<void> {
  const product = await stripe.products.retrieve(productId);

  if (isDeletedProduct(product)) {
    console.warn(`[skip] ${spec.label}: Stripe product ${productId} is deleted.`);
    return;
  }

  if (product.description === spec.description) {
    console.log(`[ok] ${spec.label}: Stripe product ${productId} already has the current description.`);
    return;
  }

  if (dryRun) {
    console.log(
      `[dry-run] ${spec.label}: would update Stripe product ${productId} description to "${spec.description}".`
    );
    return;
  }

  await stripe.products.update(productId, {
    description: spec.description,
    metadata: {
      ...product.metadata,
      ...(spec.planKey ? { hermes_plan_key: spec.planKey } : {}),
      description_source: "dashboard/src/lib/subscription/plans.ts",
      updated_by_script: "update-stripe-plan-descriptions",
    },
  });
  console.log(`[updated] ${spec.label}: Stripe product ${productId} description synced.`);
}

async function main(): Promise<void> {
  const { dryRun } = parseOptions();
  const stripe = getStripeOrDie();

  if (dryRun) {
    console.log("--- DRY RUN: no Stripe writes will happen ---");
  }

  for (const spec of SPECS) {
    const productIds = await resolveProductIds(stripe, spec);
    if (productIds.length === 0) {
      console.warn(`[skip] ${spec.label}: no Stripe product resolved.`);
      continue;
    }

    for (const productId of productIds) {
      await syncProductDescription(stripe, spec, productId, dryRun);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
