export const CRYPTO_BILLING_UNAVAILABLE_MESSAGE = "Crypto billing is currently unavailable.";

export function isCryptoBillingEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (
    env.CRYPTO_BILLING_ENABLED === "true" ||
    env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED === "true"
  ) {
    return true;
  }

  return env.NODE_ENV !== "production";
}
