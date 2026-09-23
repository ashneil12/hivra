import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/** Every .ts/.tsx source file under a directory (tests excluded). */
function sourceFilesUnder(relativeDir: string): string[] {
  const absoluteDir = path.join(ROOT, relativeDir);
  if (!existsSync(absoluteDir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(absoluteDir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const relativePath = path.join(relativeDir, entry);
    const absolutePath = path.join(ROOT, relativePath);
    if (statSync(absolutePath).isDirectory()) {
      files.push(...sourceFilesUnder(relativePath));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      files.push(relativePath);
    }
  }
  return files;
}

// The billing page is split into a controller hook and section components,
// so the whole billing route directory is scanned (plus the shared billing
// panels and display models its copy now lives in).
const BILLING_SURFACES = [
  ...sourceFilesUnder("src/app/dashboard/billing"),
  "src/components/billing/BillingPanels.tsx",
  "src/components/billing/BillingActivityPanel.tsx",
  "src/components/billing/ManagedVeniceWalletPanel.tsx",
  "src/lib/billing/plan-display.ts",
  "src/lib/billing/token-plan-prices.ts",
];

const PRICE_INCREASE_SURFACES = [
  ...BILLING_SURFACES,
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

// Stale billing copy that must not come back: the launch-epoch hold prices
// (the server has required $149/$299 since 2026-05-30, founders differ), the
// literal savings ribbons (savings are computed from PLANS), and the claim
// that billing is card-only.
const FORBIDDEN_BILLING_COPY = [
  /Hold \$?(99|199)\b/i,
  /Save up to ~?59%/i,
  /Save (38|34)% vs card/i,
  /pay by card\. No wallet required/i,
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

function findMatches(surfaces: string[], patterns: RegExp[]): string[] {
  const matches: string[] = [];
  for (const relativePath of surfaces) {
    const absolutePath = path.join(ROOT, relativePath);
    if (!existsSync(absolutePath)) continue;

    const source = readFileSync(absolutePath, "utf8");
    for (const pattern of patterns) {
      if (pattern.test(source)) {
        matches.push(`${relativePath}: ${pattern}`);
      }
    }
  }
  return matches;
}

describe("pricing increase copy", () => {
  it("scans the split billing page, not just page.tsx", () => {
    expect(BILLING_SURFACES).toEqual(
      expect.arrayContaining([
        "src/app/dashboard/billing/page.tsx",
        "src/app/dashboard/billing/useBillingController.ts",
        path.join("src/app/dashboard/billing/_components", "PlansTab.tsx"),
      ])
    );
  });

  it("keeps old price-increase messaging out of billing and checkout surfaces", () => {
    expect(findMatches(PRICE_INCREASE_SURFACES, FORBIDDEN_PRICE_INCREASE_COPY)).toEqual([]);
  });

  it("keeps stale hold prices, literal savings and card-only claims out of billing", () => {
    expect(findMatches(BILLING_SURFACES, FORBIDDEN_BILLING_COPY)).toEqual([]);
  });

  it("keeps plan descriptions from promising unlimited agent profiles", () => {
    expect(findMatches(SLOT_LIMIT_COPY_SURFACES, FORBIDDEN_SLOT_LIMIT_COPY)).toEqual([]);
  });
});
