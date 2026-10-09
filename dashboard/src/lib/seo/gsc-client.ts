import { createSign } from "node:crypto";

/**
 * Minimal Google Search Console (Search Analytics) client — zero dependencies.
 *
 * Auth is the plain service-account OAuth2 flow: build a JWT assertion, sign it
 * RS256 with the service account's private key (node:crypto createSign), swap
 * it at https://oauth2.googleapis.com/token for a short-lived access token,
 * then call the webmasters v3 searchAnalytics/query endpoint.
 *
 * The service-account JSON lives in process.env.GSC_SA_KEY (the full key file
 * contents). The SA must be added as a user on each GSC property; until that
 * grant exists Google returns 403 — surfaced as GscApiError(403) so callers
 * can treat "permission pending" as a non-alarm condition.
 */

export const GSC_SITES = [
  "sc-domain:hivra.cloud",
  "sc-domain:hermesos.cloud",
] as const;

const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const GSC_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GSC_API_BASE = "https://www.googleapis.com/webmasters/v3/sites";

// URL Inspection lives on a different host and API version than Search
// Analytics, but takes the SAME webmasters.readonly scope — so enabling it
// needs no new grant on the service account or the property.
const GSC_INSPECTION_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

/** GSC caps searchAnalytics/query at 25k rows per request; paginate past it. */
export const GSC_MAX_ROW_LIMIT = 25_000;

export interface GscServiceAccount {
  client_email: string;
  private_key: string;
}

export class GscApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GscApiError";
    this.status = status;
  }
}

/**
 * Parse a service-account key JSON string (the raw key-file contents).
 * Throws on malformed JSON or missing fields so misconfiguration is loud.
 */
export function parseServiceAccountKey(raw: string): GscServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GSC service account key is not valid JSON");
  }
  const obj = (parsed || {}) as Record<string, unknown>;
  const clientEmail = typeof obj.client_email === "string" ? obj.client_email : "";
  const privateKey = typeof obj.private_key === "string" ? obj.private_key : "";
  if (!clientEmail || !privateKey) {
    throw new Error("GSC service account key is missing client_email or private_key");
  }
  return { client_email: clientEmail, private_key: privateKey };
}

/** Read + parse GSC_SA_KEY from the environment; null when unset/blank. */
export function getServiceAccountFromEnv(): GscServiceAccount | null {
  const raw = process.env.GSC_SA_KEY;
  if (!raw || !raw.trim()) return null;
  return parseServiceAccountKey(raw);
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export interface JwtParts {
  header: { alg: "RS256"; typ: "JWT" };
  claims: {
    iss: string;
    scope: string;
    aud: string;
    iat: number;
    exp: number;
  };
  /** `${base64url(header)}.${base64url(claims)}` — the bytes that get signed. */
  signingInput: string;
}

/**
 * Assemble the unsigned JWT (header + claim set + signing input) for the
 * service-account assertion. Split out from signing so the structure is
 * unit-testable without a real key.
 */
export function buildJwtParts(clientEmail: string, nowSeconds: number): JwtParts {
  const header = { alg: "RS256", typ: "JWT" } as const;
  const claims = {
    iss: clientEmail,
    scope: GSC_SCOPE,
    aud: GSC_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(claims),
  )}`;
  return { header, claims, signingInput };
}

/** Sign the assertion RS256 and return the full three-part JWT. */
export function buildSignedJwt(sa: GscServiceAccount, nowSeconds: number): string {
  const { signingInput } = buildJwtParts(sa.client_email, nowSeconds);
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(sa.private_key).toString("base64url");
  return `${signingInput}.${signature}`;
}

export interface SearchAnalyticsQueryOptions {
  startDate: string;
  endDate: string;
  dimensions: string[];
  /** Per-request page size; defaults to (and is capped at) GSC_MAX_ROW_LIMIT. */
  rowLimit?: number;
  startRow?: number;
}

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface TokenCacheEntry {
  token: string;
  expiresAtMs: number;
}

// Access tokens live ~1h; cache per SA email so a multi-site pull in one
// invocation exchanges the JWT once, not per request.
const tokenCache = new Map<string, TokenCacheEntry>();
const TOKEN_EXPIRY_HEADROOM_MS = 60_000;

export async function getAccessToken(sa: GscServiceAccount): Promise<string> {
  const cached = tokenCache.get(sa.client_email);
  if (cached && cached.expiresAtMs - TOKEN_EXPIRY_HEADROOM_MS > Date.now()) {
    return cached.token;
  }

  const assertion = buildSignedJwt(sa, Math.floor(Date.now() / 1000));
  const response = await fetch(GSC_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new GscApiError(response.status, `GSC token exchange failed (${response.status})`);
  }

  const json = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
  const token = typeof json.access_token === "string" ? json.access_token : "";
  if (!token) {
    throw new GscApiError(500, "GSC token exchange returned no access_token");
  }
  const expiresInSec = typeof json.expires_in === "number" ? json.expires_in : 3600;
  tokenCache.set(sa.client_email, {
    token,
    expiresAtMs: Date.now() + expiresInSec * 1000,
  });
  return token;
}

function parseRow(entry: unknown): SearchAnalyticsRow | null {
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, unknown>;
  const keys = Array.isArray(obj.keys)
    ? obj.keys.filter((k): k is string => typeof k === "string")
    : [];
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    keys,
    clicks: num(obj.clicks),
    impressions: num(obj.impressions),
    ctr: num(obj.ctr),
    position: num(obj.position),
  };
}

/**
 * Run a Search Analytics query against one site, transparently paginating
 * (GSC caps each request at 25k rows) until the API returns a short page.
 */
export async function searchAnalyticsQuery(
  siteUrl: string,
  options: SearchAnalyticsQueryOptions,
  sa?: GscServiceAccount,
): Promise<SearchAnalyticsRow[]> {
  const account = sa ?? getServiceAccountFromEnv();
  if (!account) {
    throw new Error("GSC_SA_KEY is not configured");
  }
  const token = await getAccessToken(account);
  const endpoint = `${GSC_API_BASE}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const pageSize = Math.min(options.rowLimit ?? GSC_MAX_ROW_LIMIT, GSC_MAX_ROW_LIMIT);

  const rows: SearchAnalyticsRow[] = [];
  let startRow = options.startRow ?? 0;

  for (;;) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate: options.startDate,
        endDate: options.endDate,
        dimensions: options.dimensions,
        rowLimit: pageSize,
        startRow,
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      throw new GscApiError(
        response.status,
        `GSC searchAnalytics/query failed for ${siteUrl} (${response.status})`,
      );
    }

    const json = (await response.json()) as { rows?: unknown };
    const pageRows = Array.isArray(json.rows) ? json.rows : [];
    for (const entry of pageRows) {
      const parsed = parseRow(entry);
      if (parsed) rows.push(parsed);
    }

    if (pageRows.length < pageSize) break;
    startRow += pageSize;
  }

  return rows;
}

export interface UrlIndexStatus {
  /** PASS | PARTIAL | FAIL | NEUTRAL | VERDICT_UNSPECIFIED */
  verdict: string | null;
  /** e.g. "Submitted and indexed", "Crawled - currently not indexed". */
  coverageState: string | null;
  robotsTxtState: string | null;
  indexingState: string | null;
  pageFetchState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  /** RFC3339 timestamp, or null when Google has never crawled the URL. */
  lastCrawlTime: string | null;
}

/**
 * Pull `inspectionResult.indexStatusResult` out of a URL Inspection response.
 *
 * Every field is optional in the API: an unindexed URL comes back with a
 * verdict and coverageState but no lastCrawlTime or googleCanonical. Missing
 * and wrong-typed fields both become null so a partial response can never
 * write a bad row.
 */
export function parseIndexStatus(payload: unknown): UrlIndexStatus {
  const empty: UrlIndexStatus = {
    verdict: null,
    coverageState: null,
    robotsTxtState: null,
    indexingState: null,
    pageFetchState: null,
    googleCanonical: null,
    userCanonical: null,
    lastCrawlTime: null,
  };
  if (!payload || typeof payload !== "object") return empty;
  const result = (payload as Record<string, unknown>).inspectionResult;
  if (!result || typeof result !== "object") return empty;
  const status = (result as Record<string, unknown>).indexStatusResult;
  if (!status || typeof status !== "object") return empty;

  const obj = status as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

  return {
    verdict: str(obj.verdict),
    coverageState: str(obj.coverageState),
    robotsTxtState: str(obj.robotsTxtState),
    indexingState: str(obj.indexingState),
    pageFetchState: str(obj.pageFetchState),
    googleCanonical: str(obj.googleCanonical),
    userCanonical: str(obj.userCanonical),
    lastCrawlTime: str(obj.lastCrawlTime),
  };
}

/**
 * Ask Google whether one URL is in its index (URL Inspection API).
 *
 * This answers what searchAnalyticsQuery cannot: a page with no performance
 * rows might be unindexed, or indexed but never surfacing. Those need opposite
 * fixes, so the distinction matters.
 *
 * Quota is per property: 2,000 inspections/day and 600/minute. Callers sweeping
 * the sitemap should stay well under both. A 429 surfaces as GscApiError(429)
 * so the caller can stop early rather than burn the daily allowance.
 */
export async function inspectUrl(
  siteUrl: string,
  inspectionUrl: string,
  sa?: GscServiceAccount,
): Promise<UrlIndexStatus> {
  const account = sa ?? getServiceAccountFromEnv();
  if (!account) {
    throw new Error("GSC_SA_KEY is not configured");
  }
  const token = await getAccessToken(account);

  const response = await fetch(GSC_INSPECTION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inspectionUrl, siteUrl, languageCode: "en-US" }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new GscApiError(
      response.status,
      `GSC urlInspection failed for ${inspectionUrl} (${response.status})`,
    );
  }

  return parseIndexStatus(await response.json());
}
