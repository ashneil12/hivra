function normalizedOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isSameOriginRequest(request: Request): boolean {
  const originHeader = request.headers.get("origin");
  if (!originHeader) return true;
  const origin = normalizedOrigin(originHeader);
  if (!origin) return false;

  const requestUrl = new URL(request.url);
  const allowed = new Set([requestUrl.origin]);
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim();
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol || requestUrl.protocol.replace(/:$/, "");
  if (host && /^[A-Za-z0-9.:[\]-]+$/.test(host) && (protocol === "http" || protocol === "https")) {
    const publicOrigin = normalizedOrigin(`${protocol}://${host}`);
    if (publicOrigin) allowed.add(publicOrigin);
  }
  return allowed.has(origin);
}
