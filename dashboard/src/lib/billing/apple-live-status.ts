/**
 * Asks the App Store Server API what Apple says about one subscription right
 * now (Get All Subscription Statuses by originalTransactionId).
 *
 * A StoreKit 2 signed transaction is a static, Apple-signed record. It carries
 * no revocationDate if it was saved before a refund, and its expiresDate stays
 * in the future, so a person who was refunded could send the saved record again
 * and pass every check that reads only the record. Only Apple's live status
 * says the subscription was revoked. The attach route calls this before it
 * grants anything.
 */

import type { AppStoreServerAPIClient } from "@apple/app-store-server-library";

import type { AppleEnvironment } from "@/lib/billing/apple-products";
import { getAppStoreServerAPIClient } from "@/lib/billing/apple-verifier";

/** App Store Server API status codes (the Status enum). */
export const APPLE_LIVE_STATUS_ACTIVE = 1;
export const APPLE_LIVE_STATUS_EXPIRED = 2;
export const APPLE_LIVE_STATUS_BILLING_RETRY = 3;
export const APPLE_LIVE_STATUS_BILLING_GRACE_PERIOD = 4;
export const APPLE_LIVE_STATUS_REVOKED = 5;

/** The App Store Connect API credentials are not set, so nothing can be asked. */
export class AppleLiveStatusConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleLiveStatusConfigError";
  }
}

export interface AppleLiveStatusDeps {
  getClient?: (environment: AppleEnvironment) => AppStoreServerAPIClient;
}

/**
 * The live status code for the subscription, or "missing" when Apple has no
 * record of it. Throws AppleLiveStatusConfigError when the API credentials are
 * not configured, and rethrows any other failure (network, 5xx, rejected key)
 * so the caller can refuse instead of guessing.
 */
export async function getAppleLiveSubscriptionStatus(
  originalTransactionId: string,
  environment: AppleEnvironment,
  deps: AppleLiveStatusDeps = {},
): Promise<number | "missing"> {
  let client: AppStoreServerAPIClient;
  try {
    client = (deps.getClient ?? getAppStoreServerAPIClient)(environment);
  } catch (error) {
    throw new AppleLiveStatusConfigError(error instanceof Error ? error.message : String(error));
  }

  let response;
  try {
    response = await client.getAllSubscriptionStatuses(originalTransactionId);
  } catch (error) {
    if ((error as { httpStatusCode?: number })?.httpStatusCode === 404) return "missing";
    throw error;
  }

  const entry = (response.data ?? [])
    .flatMap((group) => group.lastTransactions ?? [])
    .find((item) => item.originalTransactionId === originalTransactionId);
  return entry && typeof entry.status === "number" ? entry.status : "missing";
}
