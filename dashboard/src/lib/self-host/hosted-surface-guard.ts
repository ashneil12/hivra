const HOSTED_BILLING_PREFIXES = [
  "/api/billing",
  "/api/mobile/iap",
  "/api/webhooks/apple",
  "/api/webhooks/stripe",
  "/api/workspace-cloud/billing",
  "/checkout",
  "/dashboard/billing",
  "/workspace-cloud/billing",
];

export function isHostedBillingPath(pathname: string): boolean {
  return HOSTED_BILLING_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
