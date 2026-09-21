// Shared, framework-free helpers for the GDPR/UK cookie-consent gate.
//
// The whole point of this module is the invariant in PostHogProvider: in
// consent-required regions (EU/EEA + UK), NO non-essential analytics or
// session-replay events may fire before the visitor grants consent. We treat
// unknown/missing geo as consent-REQUIRED (fail safe) so a missing
// `x-vercel-ip-country` header never silently turns analytics on for an EU
// visitor.
//
// Geo is read server-side from Vercel's `x-vercel-ip-country` header by
// `/api/geo`; the client never trusts a client-derived country.

// The 27 EU member states + the 3 remaining EEA states (Iceland,
// Liechtenstein, Norway) + the United Kingdom. ISO 3166-1 alpha-2, upper-case.
// These are the regions where prior opt-in consent is required before dropping
// non-essential analytics/replay cookies. (Switzerland's nFADP is opt-out, so
// it is intentionally NOT included.)
const CONSENT_REQUIRED_COUNTRIES: ReadonlySet<string> = new Set([
  // EU member states
  'AT', // Austria
  'BE', // Belgium
  'BG', // Bulgaria
  'HR', // Croatia
  'CY', // Cyprus
  'CZ', // Czechia
  'DK', // Denmark
  'EE', // Estonia
  'FI', // Finland
  'FR', // France
  'DE', // Germany
  'GR', // Greece
  'HU', // Hungary
  'IE', // Ireland
  'IT', // Italy
  'LV', // Latvia
  'LT', // Lithuania
  'LU', // Luxembourg
  'MT', // Malta
  'NL', // Netherlands
  'PL', // Poland
  'PT', // Portugal
  'RO', // Romania
  'SK', // Slovakia
  'SI', // Slovenia
  'ES', // Spain
  'SE', // Sweden
  // EEA (non-EU)
  'IS', // Iceland
  'LI', // Liechtenstein
  'NO', // Norway
  // United Kingdom (UK GDPR + PECR)
  'GB', // Great Britain + Northern Ireland
]);

/**
 * Whether prior opt-in consent is required for a given ISO country code.
 *
 * FAIL SAFE: an unknown, empty, or missing country is treated as
 * consent-REQUIRED. A visitor whose geo we cannot determine must never have
 * analytics turned on before they choose.
 */
export function isConsentRequiredCountry(country: string | null | undefined): boolean {
  if (!country) return true; // unknown geo => require consent
  return CONSENT_REQUIRED_COUNTRIES.has(country.trim().toUpperCase());
}

// Shape returned by GET /api/geo.
export interface GeoConsentSignal {
  country: string | null;
  consentRequired: boolean;
}

export type ConsentChoice = 'accepted' | 'rejected';

// Bump when the consent prompt's meaning changes materially (e.g. new
// processing purposes) so previously-stored choices are re-prompted.
export const CONSENT_VERSION = 1;

// First-party persistence. We mirror the choice in BOTH a cookie and
// localStorage: the cookie lets server/edge code (and a non-JS read) see the
// choice, localStorage is the primary client read. Either being present counts
// as "decided".
export const CONSENT_STORAGE_KEY = 'hh_cookie_consent';
const CONSENT_COOKIE_NAME = 'hh_cookie_consent';
const CONSENT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180; // 180 days

export interface StoredConsent {
  choice: ConsentChoice;
  version: number;
  timestamp: number;
}

function parseStored(raw: string | null | undefined): StoredConsent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredConsent>;
    if (parsed?.choice !== 'accepted' && parsed?.choice !== 'rejected') return null;
    if (typeof parsed.version !== 'number') return null;
    // A stored choice from an older prompt version is treated as "no choice"
    // so the visitor is re-asked under the current terms.
    if (parsed.version !== CONSENT_VERSION) return null;
    return {
      choice: parsed.choice,
      version: parsed.version,
      timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : 0,
    };
  } catch {
    return null;
  }
}

function readConsentCookie(): StoredConsent | null {
  if (typeof document === 'undefined') return null;
  try {
    const match = document.cookie
      .split('; ')
      .find((row) => row.startsWith(`${CONSENT_COOKIE_NAME}=`));
    if (!match) return null;
    const value = decodeURIComponent(match.slice(CONSENT_COOKIE_NAME.length + 1));
    return parseStored(value);
  } catch {
    return null;
  }
}

/**
 * Read the persisted consent choice (localStorage first, cookie as fallback).
 * Returns null when there is no valid stored choice for the current version.
 * Safe to call at module load — never throws.
 */
export function readStoredConsent(): StoredConsent | null {
  if (typeof window !== 'undefined') {
    try {
      const fromLs = parseStored(window.localStorage.getItem(CONSENT_STORAGE_KEY));
      if (fromLs) return fromLs;
    } catch {
      // localStorage unavailable (private mode / blocked) — fall through to cookie.
    }
  }
  return readConsentCookie();
}

/**
 * Persist a consent choice to BOTH localStorage and a first-party cookie.
 * Best-effort: never throws.
 */
export function writeStoredConsent(choice: ConsentChoice): StoredConsent {
  const record: StoredConsent = {
    choice,
    version: CONSENT_VERSION,
    timestamp: Date.now(),
  };
  const serialized = JSON.stringify(record);

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(CONSENT_STORAGE_KEY, serialized);
    } catch {
      // Best-effort.
    }
  }

  if (typeof document !== 'undefined') {
    try {
      const secure = typeof window !== 'undefined' && window.location.protocol === 'https:'
        ? '; Secure'
        : '';
      document.cookie =
        `${CONSENT_COOKIE_NAME}=${encodeURIComponent(serialized)}` +
        `; Path=/; Max-Age=${CONSENT_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
    } catch {
      // Best-effort.
    }
  }

  return record;
}
