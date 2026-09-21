export const CARD_REQUIRED_REASON = "card_required";

export const DEFAULT_CARD_REQUIRED_MESSAGE =
  "For this free-tier deploy, we need a quick card-on-file check before provisioning. You will not be charged.";

type ApiErrorShape = {
  success?: boolean;
  error?: unknown;
  reason?: unknown;
};

function isObject(value: unknown): value is ApiErrorShape {
  return typeof value === "object" && value !== null;
}

export function isCardRequiredResponse(value: unknown): value is ApiErrorShape & {
  reason: typeof CARD_REQUIRED_REASON;
} {
  return isObject(value) && value.reason === CARD_REQUIRED_REASON;
}

export function getApiErrorMessage(value: unknown, fallback: string): string {
  if (!isObject(value) || typeof value.error !== "string") {
    return fallback;
  }

  const message = value.error.trim();
  return message.length > 0 ? message : fallback;
}

export function getCardRequiredMessage(value: unknown): string {
  return getApiErrorMessage(value, DEFAULT_CARD_REQUIRED_MESSAGE);
}
