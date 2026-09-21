function isErrorLike(value: unknown): value is {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
} {
  return typeof value === "object" && value !== null;
}

function describeSingleError(value: unknown): string {
  if (!isErrorLike(value)) {
    if (typeof value === "string") return value;
    return String(value);
  }

  const parts: string[] = [];
  const name = typeof value.name === "string" ? value.name : null;
  const code = typeof value.code === "string" ? value.code : null;
  const message = typeof value.message === "string" ? value.message : null;

  if (name) parts.push(name);
  if (code) parts.push(`[${code}]`);
  if (message) parts.push(message);

  return parts.join(": ") || String(value);
}

export function describeErrorWithCauses(error: unknown): string {
  const segments: string[] = [];
  let current: unknown = error;
  let depth = 0;

  while (current !== undefined && current !== null && depth < 5) {
    segments.push(depth === 0 ? describeSingleError(current) : `cause: ${describeSingleError(current)}`);
    current = isErrorLike(current) ? current.cause : undefined;
    depth += 1;
  }

  return segments.join(" | ");
}
