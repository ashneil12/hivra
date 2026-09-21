export const SSH_WARMUP_MESSAGE = "Instance is still provisioning SSH access. Try again in a moment.";

const SSH_WARMUP_PATTERNS = [
  "timed out capturing ssh host fingerprint",
  "ssh fingerprint capture failed:",
  "ssh connection error: connect etimedout",
  "ssh connection error: connect econnrefused",
  "ssh connection error: read econnreset",
  "ssh connection error: connect ehostunreach",
  "ssh connection error: connect enetunreach",
  "ssh operation timed out",
  "timed out while waiting for handshake",
  "connection lost before handshake",
];

export function isSshWarmupError(message: string | null | undefined): boolean {
  const normalized = message?.toLowerCase().trim() ?? "";
  return SSH_WARMUP_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function normalizeSshWarmupMessage(
  message: string | null | undefined,
  fallback = "Unknown error"
): string {
  const trimmed = message?.trim() ?? "";
  if (isSshWarmupError(trimmed)) {
    return SSH_WARMUP_MESSAGE;
  }

  return trimmed || fallback;
}
