// First-party Venice attribution. A visit that arrives with ?ref=<source> (for
// example ref=venice) and an optional ?code=<promo code> is remembered for 30
// days so a later sign-up or promo system can read it after the person has gone
// through sign-in and Launch.
//
// Cookie name: `hivra_venice_attr` (see VENICE_ATTRIBUTION_COOKIE). Value is a
// URL-encoded query string, `ref=venice&code=VENICE`. It is first-party, not
// HttpOnly (the browser writes it), SameSite=Lax, path=/, 30 days. It holds no
// secrets and no personal data. No other attribution mechanism exists in the app
// (the PostHog UTM properties are analytics only and not readable by billing).
//
// Client-safe: no server-only imports. Server code reads the same cookie through
// parseVeniceAttribution(request cookie value).

export const VENICE_ATTRIBUTION_COOKIE = "hivra_venice_attr";
export const VENICE_ATTRIBUTION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export type VeniceAttribution = { ref: string | null; code: string | null };

const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return TOKEN.test(trimmed) ? trimmed : null;
}

/** Reads and sanitises ref and code from query params. Anything odd becomes null. */
export function attributionFromParams(get: (key: string) => string | null | undefined): VeniceAttribution {
  return { ref: clean(get("ref")), code: clean(get("code")) };
}

/** Parses a raw cookie value (URL-encoded query string). Never throws. */
export function parseVeniceAttribution(raw: string | null | undefined): VeniceAttribution {
  if (!raw) return { ref: null, code: null };
  try {
    const params = new URLSearchParams(decodeURIComponent(raw));
    return attributionFromParams(key => params.get(key));
  } catch {
    return { ref: null, code: null };
  }
}

function serialize(attribution: VeniceAttribution): string {
  const params = new URLSearchParams();
  if (attribution.ref) params.set("ref", attribution.ref);
  if (attribution.code) params.set("code", attribution.code);
  return params.toString();
}

/** Reads the attribution from document.cookie. Empty outside a browser. */
export function readVeniceAttribution(cookieString?: string): VeniceAttribution {
  const source = cookieString ?? (typeof document === "undefined" ? "" : document.cookie);
  for (const part of source.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === VENICE_ATTRIBUTION_COOKIE) {
      return parseVeniceAttribution(part.slice(index + 1).trim());
    }
  }
  return { ref: null, code: null };
}

/**
 * Remembers a new ref and/or code. A value the visit does not carry keeps the
 * earlier one, so landing on Launch with only ref=venice does not erase a code.
 * Does nothing when the visit carries neither. Returns what is now stored.
 */
export function captureVeniceAttribution(incoming: VeniceAttribution): VeniceAttribution {
  if (typeof document === "undefined" || (!incoming.ref && !incoming.code)) return readVeniceAttribution();
  const current = readVeniceAttribution();
  const next = { ref: incoming.ref ?? current.ref, code: incoming.code ?? current.code };
  try {
    document.cookie = `${VENICE_ATTRIBUTION_COOKIE}=${encodeURIComponent(serialize(next))}; Max-Age=${VENICE_ATTRIBUTION_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  } catch {
    // Cookies blocked: attribution is best effort.
  }
  return next;
}
