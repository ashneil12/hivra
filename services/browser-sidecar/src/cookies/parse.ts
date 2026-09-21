// Cookie import parser: turn whatever a user exported from their browser into
// Playwright's addCookies() shape. We accept the three formats that cover the
// recommended export extensions, so the user just exports → uploads and we
// figure out the format:
//
//   1. Netscape cookies.txt  — "Get cookies.txt LOCALLY" (open-source, the
//      privacy-safe pick), yt-dlp, curl. Tab-separated, '#'-comments, with the
//      '#HttpOnly_' domain prefix convention.
//   2. Cookie-Editor JSON    — array of { name, value, domain, expirationDate,
//      sameSite: "no_restriction"|"lax"|"strict", hostOnly, ... }.
//   3. Playwright storageState — { cookies: [...], origins: [...] }.
//
// Everything normalizes to PlaywrightCookie. We never log values.

export interface PlaywrightCookie {
  name: string;
  value: string;
  // A cookie is addressed by EITHER url OR domain+path (never both — Playwright
  // rejects that). Host-only cookies (the `__Host-` prefix) use url so they
  // carry no Domain attribute, which Chromium requires for that prefix.
  url?: string;
  domain?: string;
  path?: string;
  expires?: number; // unix seconds; omitted => session cookie
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** Display host for a cookie, whether it's url- or domain-addressed. */
export function cookieHost(c: PlaywrightCookie): string {
  if (c.domain) return c.domain.replace(/^\./, "");
  if (c.url) {
    try {
      return new URL(c.url).hostname;
    } catch {
      return "";
    }
  }
  return "";
}

export interface ParseResult {
  cookies: PlaywrightCookie[];
  format: "netscape" | "cookie-editor-json" | "storage-state" | "cookie-json-array";
  /** Distinct registrable-ish domains, for showing the user what they're importing. */
  domains: string[];
}

export class CookieParseError extends Error {}

const MAX_COOKIES = 5000;

function normalizeSameSite(v: unknown): PlaywrightCookie["sameSite"] | undefined {
  if (typeof v !== "string") return undefined;
  switch (v.trim().toLowerCase()) {
    case "strict":
      return "Strict";
    case "lax":
      return "Lax";
    case "no_restriction":
    case "none":
      return "None";
    // "unspecified" / "" / unknown -> let the browser default apply
    default:
      return undefined;
  }
}

function cleanDomain(d: string): string {
  return d.trim().replace(/^#HttpOnly_/i, "");
}

function finalize(raw: PlaywrightCookie[]): ParseResult["cookies"] {
  const out: PlaywrightCookie[] = [];
  for (const c of raw) {
    if (!c.name || c.value == null || !c.domain) continue;
    const host = c.domain.replace(/^\./, "");
    if (!host) continue;
    const base: PlaywrightCookie = {
      name: c.name,
      value: c.value,
      ...(c.expires ? { expires: c.expires } : {}),
      ...(c.httpOnly ? { httpOnly: true } : {}),
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    };
    if (/^__Host-/.test(c.name)) {
      // The `__Host-` prefix MUST be host-only (no Domain), Secure, Path=/ —
      // Chromium rejects it otherwise, and since addCookies is atomic ONE such
      // cookie fails the whole import. Address it by url so it carries no Domain.
      out.push({ ...base, url: `https://${host}/`, secure: true });
    } else {
      // `__Secure-` requires Secure; sameSite=None also requires Secure, else the
      // browser drops the cookie. Enforce rather than silently no-op the import.
      const secure =
        /^__Secure-/.test(c.name) || c.sameSite === "None" ? true : Boolean(c.secure);
      out.push({ ...base, domain: c.domain, path: c.path || "/", secure });
    }
    if (out.length >= MAX_COOKIES) break;
  }
  return out;
}

function parseNetscape(text: string): PlaywrightCookie[] {
  const cookies: PlaywrightCookie[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // '#HttpOnly_' lines are real cookies; other '#' lines are comments.
    const isHttpOnly = /^#HttpOnly_/i.test(line);
    if (line.startsWith("#") && !isHttpOnly) continue;
    const f = line.split("\t");
    if (f.length < 7) continue;
    const [domain, , path, secure, expiry, name, ...rest] = f;
    const value = rest.join("\t"); // values can (rarely) contain tabs
    const exp = Number.parseInt(expiry, 10);
    cookies.push({
      name: name.trim(),
      value,
      domain: cleanDomain(domain),
      path: path.trim() || "/",
      ...(Number.isFinite(exp) && exp > 0 ? { expires: exp } : {}),
      httpOnly: isHttpOnly,
      secure: secure.trim().toUpperCase() === "TRUE",
    });
  }
  return cookies;
}

function fromJsonCookie(o: Record<string, unknown>): PlaywrightCookie | null {
  const name = o.name ?? o.Name;
  const value = o.value ?? o.Value;
  const domain = o.domain ?? o.Domain ?? o.host;
  if (typeof name !== "string" || value == null || typeof domain !== "string") return null;
  // expiry can arrive as expirationDate (Cookie-Editor, float seconds),
  // expires (Playwright, seconds or -1), or expirationDate as ms.
  let expires: number | undefined;
  const expRaw = o.expirationDate ?? o.expires ?? o.expiry;
  if (typeof expRaw === "number" && expRaw > 0) {
    // Heuristic: a value far in the future in *ms* would be > year 5000 in s.
    expires = expRaw > 1e12 ? Math.floor(expRaw / 1000) : Math.floor(expRaw);
  }
  return {
    name,
    value: String(value),
    domain: cleanDomain(domain),
    path: typeof o.path === "string" && o.path ? o.path : "/",
    ...(expires ? { expires } : {}),
    httpOnly: Boolean(o.httpOnly ?? o.HttpOnly),
    secure: Boolean(o.secure ?? o.Secure),
    sameSite: normalizeSameSite(o.sameSite ?? o.SameSite),
  };
}

export function parseCookies(input: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) throw new CookieParseError("empty cookie file");

  let cookies: PlaywrightCookie[];
  let format: ParseResult["format"];

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new CookieParseError("file looks like JSON but did not parse");
    }
    if (Array.isArray(json)) {
      cookies = json
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map(fromJsonCookie)
        .filter((c): c is PlaywrightCookie => c !== null);
      format = "cookie-editor-json";
    } else if (json && typeof json === "object" && Array.isArray((json as { cookies?: unknown }).cookies)) {
      cookies = ((json as { cookies: unknown[] }).cookies)
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
        .map(fromJsonCookie)
        .filter((c): c is PlaywrightCookie => c !== null);
      format = "storage-state";
    } else {
      throw new CookieParseError("unrecognised JSON cookie shape");
    }
  } else {
    cookies = parseNetscape(trimmed);
    format = "netscape";
  }

  const finalized = finalize(cookies);
  if (finalized.length === 0) {
    throw new CookieParseError("no valid cookies found in file");
  }
  const domains = [...new Set(finalized.map(cookieHost).filter(Boolean))].sort();
  return { cookies: finalized, format, domains };
}
