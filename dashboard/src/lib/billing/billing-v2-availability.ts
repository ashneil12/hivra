export const BILLING_V2_UNAVAILABLE_MESSAGE = "Billing v2 is currently unavailable.";
export const CREDIT_TOPUPS_UNAVAILABLE_MESSAGE = "Credit top-ups are currently unavailable.";

export function isBillingV2ServerEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (
    env.BILLING_V2_ENABLED === "true" ||
    env.NEXT_PUBLIC_BILLING_V2_ENABLED === "true"
  ) {
    return true;
  }

  return env.NODE_ENV !== "production";
}

export function isCreditTopUpsServerEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (env.CREDIT_TOPUPS_ENABLED === "true") {
    return true;
  }

  return env.NODE_ENV !== "production";
}
