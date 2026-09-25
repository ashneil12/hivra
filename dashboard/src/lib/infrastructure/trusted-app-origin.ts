export class TrustedAppOriginError extends Error {
  constructor() {
    super("The deployment's public HTTPS app origin is not configured correctly");
    this.name = "TrustedAppOriginError";
  }
}

/**
 * Validate a deployment-configured origin as a bare `https://host`: no user,
 * password, port, path, query or fragment, and a plain lowercase DNS name.
 * Callers pass trusted deployment configuration, never a Host, Origin or
 * forwarded header from the incoming request.
 */
export function validateTrustedAppOrigin(origin: string): string {
  try {
    if (typeof origin !== "string" || origin.length > 253
      || /[^\x21-\x7e]|\\/.test(origin)) throw new Error();
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || url.pathname !== "/" || url.search || url.hash || !url.hostname
      || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname)
      || url.hostname.split(".").some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new TrustedAppOriginError();
  }
}

/** This deployment's own public origin from NEXT_PUBLIC_APP_URL, validated,
 * or null when it is missing or unusable. Read at runtime (not inlined at
 * build time) through a computed key. */
export function trustedAppOrigin(env: Record<string, string | undefined> = process.env): string | null {
  const key = "NEXT_PUBLIC_APP_URL";
  const configured = env[key]?.trim();
  if (!configured) return null;
  try {
    return validateTrustedAppOrigin(configured);
  } catch {
    return null;
  }
}
