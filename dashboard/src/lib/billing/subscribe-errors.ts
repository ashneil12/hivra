export const BILLING_SUBSCRIBE_REASON = {
  ACTIVE_SUBSCRIPTION: "ACTIVE_SUBSCRIPTION",
  CHECKOUT_IN_PROGRESS: "CHECKOUT_IN_PROGRESS",
  INVALID_BODY: "INVALID_BODY",
  INVALID_PLAN: "INVALID_PLAN",
} as const;

export type BillingSubscribeReason =
  (typeof BILLING_SUBSCRIBE_REASON)[keyof typeof BILLING_SUBSCRIBE_REASON];

export function isBillingSubscribeReason(value: unknown): value is BillingSubscribeReason {
  return (
    typeof value === "string" &&
    Object.values(BILLING_SUBSCRIBE_REASON).includes(
      value as BillingSubscribeReason
    )
  );
}
