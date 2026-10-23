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
  const hostHeader = request.headers.get("host")?.trim();
  // x-forwarded-host is only meaningful when the last proxy rewrote it. On a
  // direct request — or behind a pass-through proxy — the client picks the
  // value, so when it disagrees with Host it is honoured only where the
  // platform is known to overwrite it (Vercel) or the operator opted in via
  // HIVRA_TRUST_FORWARDED_HEADERS.
  const trustForwarded =
    process.env.HIVRA_TRUST_FORWARDED_HEADERS === "true" || process.env.VERCEL === "1";
  const host =
    forwardedHost &&
    hostHeader &&
    hostHeader.toLowerCase() !== forwardedHost.toLowerCase() &&
    !trustForwarded
      ? hostHeader
      : forwardedHost || hostHeader;
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol || requestUrl.protocol.replace(/:$/, "");
  if (host && /^[A-Za-z0-9.:[\]-]+$/.test(host) && (protocol === "http" || protocol === "https")) {
    const publicOrigin = normalizedOrigin(`${protocol}://${host}`);
    if (publicOrigin) allowed.add(publicOrigin);
  }
  return allowed.has(origin);
}
