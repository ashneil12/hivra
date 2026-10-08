/**
 * Shapes and limits CSP violation reports before they become ops events.
 *
 * `/api/csp/report` is public and cookie-less, so anyone can post anything to
 * it. Two things kept that from being a flood:
 *
 *   1. The ops-event fingerprint is a hash of source, title, message and
 *      route. The old route put the full blocked URL and full document URL in
 *      the message and route, so every different URL made a new row. The
 *      shaped event here keeps only low-cardinality parts: the directive name,
 *      the blocked host (or a keyword such as inline), and a short, id-free
 *      document path.
 *   2. Even low-cardinality text can be varied by hand, so the route also has a
 *      budget of distinct fingerprints per hour. Past the budget, reports fold
 *      into one shared overflow row and only raise its count.
 *
 * The counters live in this module's memory, so they are per server instance.
 * That is a real limit (see lib/rate-limit.ts), not a global one: the budget
 * bounds how many rows one instance can add per hour.
 */

export interface RawCspFields {
  blockedUri?: string;
  documentUri?: string;
  violatedDirective?: string;
  effectiveDirective?: string;
  disposition?: string;
  sourceFile?: string;
}

export interface ShapedCspEvent {
  directive: string;
  blockedLabel: string;
  documentPath: string;
  disposition: "enforce" | "report";
  title: string;
  message: string;
  route: string;
  /** Low-cardinality copies of the URLs, safe to store as metadata. */
  blockedUri?: string;
  documentUri?: string;
  sourceFile?: string;
}

const KNOWN_DIRECTIVES = new Set([
  "default-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "img-src",
  "font-src",
  "connect-src",
  "media-src",
  "object-src",
  "frame-src",
  "child-src",
  "worker-src",
  "manifest-src",
  "prefetch-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
  "navigate-to",
  "sandbox",
  "upgrade-insecure-requests",
  "require-trusted-types-for",
  "trusted-types",
]);

const MAX_HOST_LENGTH = 100;
const MAX_PATH_SEGMENTS = 3;
const MAX_SEGMENT_LENGTH = 32;
const OVERFLOW_LABEL = "<many>";

/** Distinct fingerprints one instance may add per window. */
export const CSP_DISTINCT_KEYS_PER_WINDOW = 100;
export const CSP_DISTINCT_KEY_WINDOW_MS = 60 * 60 * 1000;

let windowStartedAt = 0;
let seenKeys = new Set<string>();

export function resetCspReportBudgetForTests(): void {
  windowStartedAt = 0;
  seenKeys = new Set<string>();
}

function parseUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** The hostname of the document the browser says it reported from. */
export function documentHostname(documentUri: string | undefined): string | null {
  const url = parseUrl(documentUri);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  return url.hostname.toLowerCase() || null;
}

export function normalizeDirective(effective?: string, violated?: string): string {
  const raw = (effective || violated || "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return KNOWN_DIRECTIVES.has(raw) ? raw : "other";
}

export function blockedLabelFor(blockedUri: string | undefined): string {
  const raw = (blockedUri ?? "").trim();
  if (!raw || raw === "inline") return "inline";
  if (raw === "eval") return "eval";
  if (raw === "self") return "self";
  const url = parseUrl(raw);
  if (!url) return "other";
  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:") {
    return url.hostname.toLowerCase().slice(0, MAX_HOST_LENGTH) || "other";
  }
  // data:, blob:, about:, chrome-extension: and the like. The scheme is enough.
  return /^[a-z][a-z0-9+.-]{0,19}:$/.test(url.protocol) ? url.protocol : "other";
}

function isIdLike(segment: string): boolean {
  return (
    /^\d+$/.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
    /^[0-9a-f]{16,}$/i.test(segment)
  );
}

/** A short path with ids replaced, so the same page always gives the same text. */
export function normalizeDocumentPath(documentUri: string | undefined): string {
  const url = parseUrl(documentUri);
  if (!url) return "/";
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .slice(0, MAX_PATH_SEGMENTS)
    .map((segment) => {
      if (isIdLike(segment)) return ":id";
      if (segment.length > MAX_SEGMENT_LENGTH || !/^[A-Za-z0-9._~-]+$/.test(segment)) return ":x";
      return segment.toLowerCase();
    });
  return `/${segments.join("/")}`;
}

/** A URL without its query or fragment, which can carry tokens. */
function withoutQuery(value: string | undefined): string | undefined {
  const url = parseUrl(value);
  if (!url) return undefined;
  return `${url.origin === "null" ? `${url.protocol}//` : url.origin}${url.pathname}`.slice(0, 500);
}

export function shapeCspEvent(fields: RawCspFields, now: number = Date.now()): ShapedCspEvent {
  const disposition: "enforce" | "report" = fields.disposition === "enforce" ? "enforce" : "report";
  let directive = normalizeDirective(fields.effectiveDirective, fields.violatedDirective);
  let blockedLabel = blockedLabelFor(fields.blockedUri);
  let documentPath = normalizeDocumentPath(fields.documentUri);

  // Spend one of the hour's distinct-fingerprint slots, or fold into the
  // shared overflow row.
  if (now - windowStartedAt > CSP_DISTINCT_KEY_WINDOW_MS) {
    windowStartedAt = now;
    seenKeys = new Set<string>();
  }
  const key = `${disposition}|${directive}|${blockedLabel}|${documentPath}`;
  if (!seenKeys.has(key)) {
    if (seenKeys.size >= CSP_DISTINCT_KEYS_PER_WINDOW) {
      directive = "other";
      blockedLabel = OVERFLOW_LABEL;
      documentPath = OVERFLOW_LABEL;
    } else {
      seenKeys.add(key);
    }
  }

  return {
    directive,
    blockedLabel,
    documentPath,
    disposition,
    title: `CSP ${disposition}: ${directive}`,
    message: `Blocked ${blockedLabel} on ${documentPath}`,
    route: documentPath,
    blockedUri: withoutQuery(fields.blockedUri),
    documentUri: withoutQuery(fields.documentUri),
    sourceFile: withoutQuery(fields.sourceFile),
  };
}
