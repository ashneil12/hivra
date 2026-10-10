type ApiErrorShape = {
  success?: boolean;
  error?: unknown;
  reason?: unknown;
};

function isObject(value: unknown): value is ApiErrorShape {
  return typeof value === "object" && value !== null;
}

export function getApiErrorMessage(value: unknown, fallback: string): string {
  if (!isObject(value) || typeof value.error !== "string") {
    return fallback;
  }

  const message = value.error.trim();
  return message.length > 0 ? message : fallback;
}
