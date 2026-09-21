const DEFAULT_APP_URL = "https://hivra.cloud";
const DEFAULT_ALLOWED_ORIGINS = ["hermesos.cloud", "*.hermesos.cloud"];
const LOCAL_DEBUG_SUBDOMAIN = "local";

type ClerkRuntimeBlocker = "host" | "https" | "port";

export type ClerkRuntimeEnvironment = {
  allowedOrigins: string[];
  blockers: ClerkRuntimeBlocker[];
  isLiveKey: boolean;
  recommendedLiveKeyDebugOrigin: string;
  runtimeOrigin: string | null;
  shouldBlock: boolean;
};

function normalizeOriginPattern(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const hasExplicitScheme = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed);

  if (trimmed.startsWith("*.")) {
    const wildcardValue = trimmed.slice(2).replace(/^\.+/, "");
    try {
      return `*.${new URL(hasExplicitScheme ? wildcardValue : `http://${wildcardValue}`).hostname.toLowerCase()}`;
    } catch {
      return `*.${wildcardValue.replace(/\/.*$/, "").replace(/:\d+$/, "").toLowerCase()}`;
    }
  }

  try {
    return new URL(hasExplicitScheme ? trimmed : `http://${trimmed}`).hostname.toLowerCase();
  } catch {
    return trimmed
      .replace(/^https?:\/\//i, "")
      .replace(/\/.*$/, "")
      .replace(/:\d+$/, "")
      .toLowerCase();
  }
}

function resolveSiteHost(appUrl?: string | null): string {
  try {
    return new URL(appUrl || DEFAULT_APP_URL).hostname.toLowerCase();
  } catch {
    return new URL(DEFAULT_APP_URL).hostname.toLowerCase();
  }
}

function buildDefaultAllowedOrigins(siteHost: string): string[] {
  return Array.from(new Set([siteHost, `*.${siteHost}`, ...DEFAULT_ALLOWED_ORIGINS]));
}

export function parseClerkAllowedOrigins(value?: string | null, appUrl?: string | null): string[] {
  const siteHost = resolveSiteHost(appUrl);
  const configuredPatterns = (value || "")
    .split(",")
    .map((entry) => normalizeOriginPattern(entry))
    .filter((entry): entry is string => Boolean(entry));

  if (configuredPatterns.length === 0) {
    return buildDefaultAllowedOrigins(siteHost);
  }

  return Array.from(new Set([...configuredPatterns, ...buildDefaultAllowedOrigins(siteHost)]));
}

export function deriveRuntimeOriginFromHeaders(
  input: Pick<Headers, "get">
): string | null {
  const forwardedHost = input.get("x-forwarded-host");
  const host = forwardedHost || input.get("host");

  if (!host) return null;

  const proto =
    input.get("x-forwarded-proto") ||
    (/^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0)(:\d+)?$/i.test(host) ? "http" : "https");

  return `${proto}://${host}`;
}

function matchesAllowedOrigin(hostname: string, pattern: string): boolean {
  const normalizedHost = hostname.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();

  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return normalizedHost.endsWith(suffix) && normalizedHost !== suffix.slice(1);
  }

  return normalizedHost === normalizedPattern;
}

export function analyzeClerkRuntimeEnvironment({
  publishableKey,
  allowedOrigins,
  appUrl,
  runtimeOrigin,
}: {
  publishableKey?: string | null;
  allowedOrigins?: string | null;
  appUrl?: string | null;
  runtimeOrigin?: string | null;
}): ClerkRuntimeEnvironment {
  const isLiveKey = (publishableKey || "").trim().startsWith("pk_live_");
  const normalizedAllowedOrigins = parseClerkAllowedOrigins(allowedOrigins, appUrl);
  const siteHost = resolveSiteHost(appUrl);
  const recommendedLiveKeyDebugOrigin = `https://${LOCAL_DEBUG_SUBDOMAIN}.${siteHost}`;

  if (!runtimeOrigin) {
    return {
      allowedOrigins: normalizedAllowedOrigins,
      blockers: [],
      isLiveKey,
      recommendedLiveKeyDebugOrigin,
      runtimeOrigin: null,
      shouldBlock: false,
    };
  }

  const currentUrl = new URL(runtimeOrigin);
  const blockers: ClerkRuntimeBlocker[] = [];

  const hostAllowed = normalizedAllowedOrigins.some((pattern) =>
    matchesAllowedOrigin(currentUrl.hostname, pattern)
  );

  if (!hostAllowed) blockers.push("host");
  if (currentUrl.protocol !== "https:") blockers.push("https");
  if (currentUrl.port && currentUrl.port !== "443") blockers.push("port");

  return {
    allowedOrigins: normalizedAllowedOrigins,
    blockers,
    isLiveKey,
    recommendedLiveKeyDebugOrigin,
    runtimeOrigin: currentUrl.origin,
    shouldBlock: isLiveKey && blockers.length > 0,
  };
}

