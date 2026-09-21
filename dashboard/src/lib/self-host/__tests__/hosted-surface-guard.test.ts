import { isHostedBillingPath } from "../hosted-surface-guard";

describe("self-host hosted-surface guard", () => {
  it.each([
    "/api/billing/usage",
    "/api/mobile/iap/attach",
    "/api/webhooks/stripe",
    "/api/workspace-cloud/billing/subscribe",
    "/checkout/canceled",
    "/dashboard/billing",
    "/workspace-cloud/billing",
  ])("classifies %s as hosted billing", (pathname) => {
    expect(isHostedBillingPath(pathname)).toBe(true);
  });

  it.each([
    "/api/hivra/agents",
    "/api/infrastructure/connections",
    "/dashboard",
    "/dashboard/infrastructure",
    "/dashboard/usage",
    "/workspace-cloud/connect",
  ])("preserves the open functional surface at %s", (pathname) => {
    expect(isHostedBillingPath(pathname)).toBe(false);
  });
});
