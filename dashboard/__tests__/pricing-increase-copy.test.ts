import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

const PRICE_INCREASE_SURFACES = [
  "src/app/dashboard/billing/page.tsx",
  "src/app/get-started/page.tsx",
  "src/components/dashboard/welcome/PlanSelection.tsx",
  "src/components/ui/UrgencyCountdown.tsx",
  "scripts/broadcasts/2026-04-30-platform-stable-pricing.txt",
];

const FORBIDDEN_PRICE_INCREASE_COPY = [
  /UrgencyCountdown/,
  /targetPrice=\{39\}/,
  /Rising to\s+\$?39/i,
  /Rising to\s+\$\{targetPrice\}/i,
  /Limited Offer.*Lock In Price/i,
  /Pricing update\s*\(effective next billing cycle\)/i,
  /updated pricing will apply automatically/i,
];

const SLOT_LIMIT_COPY_SURFACES = [
  "src/lib/subscription/plans.ts",
  "src/app/page.tsx",
  "src/app/features/page.tsx",
  "src/app/features/[slug]/page.tsx",
  "src/app/compare/[slug]/page.tsx",
  "scripts/update-stripe-plan-descriptions.ts",
];

const FORBIDDEN_SLOT_LIMIT_COPY = [
  /unlimited agent profiles/i,
  /unlimited profiles/i,
  /unlimited agents/i,
  /no hard limit/i,
  /operator profiels?/i,
  /operator profiles?/i,
];

describe("pricing increase copy", () => {
  it("keeps old price-increase messaging out of billing and checkout surfaces", () => {
    const matches: string[] = [];

    for (const relativePath of PRICE_INCREASE_SURFACES) {
      const absolutePath = path.join(ROOT, relativePath);
      if (!existsSync(absolutePath)) continue;

      const source = readFileSync(absolutePath, "utf8");
      for (const pattern of FORBIDDEN_PRICE_INCREASE_COPY) {
        if (pattern.test(source)) {
          matches.push(`${relativePath}: ${pattern}`);
        }
      }
    }

    expect(matches).toEqual([]);
  });

  it("keeps plan descriptions from promising unlimited agent profiles", () => {
    const matches: string[] = [];

    for (const relativePath of SLOT_LIMIT_COPY_SURFACES) {
      const absolutePath = path.join(ROOT, relativePath);
      if (!existsSync(absolutePath)) continue;

      const source = readFileSync(absolutePath, "utf8");
      for (const pattern of FORBIDDEN_SLOT_LIMIT_COPY) {
        if (pattern.test(source)) {
          matches.push(`${relativePath}: ${pattern}`);
        }
      }
    }

    expect(matches).toEqual([]);
  });
});
