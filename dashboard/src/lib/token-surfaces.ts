/**
 * The one switch for the NEW token surfaces: HIVRA_NEW_TOKEN_SURFACES.
 *
 * OFF (unset, anything but 1/true/on/yes) is the production default. It holds
 * back the pages, documents and links that belong to the $HIVRA / dual-token
 * launch (token page, tokenomics, the evolution page, the convert page, the
 * litepaper, whitepaper and tokenomics documents) and makes the UK geo list
 * inert, so the platform behaves for customers as the $HermesOS-only build
 * they use today. Every $HermesOS money path (wallet verification, tier
 * eligibility, withdraw, top-ups, yearly token payments, managed-Venice
 * deposits) is untouched by the switch.
 *
 * Server-side only. It deliberately has no NEXT_PUBLIC twin: the proxy, the
 * route handlers and the server pages read it and pass the answer down as a
 * prop. A client component reading it would see "off" in the browser whatever
 * the server said. Turning it on later: docs/token/NEW-TOKEN-SURFACES-SWITCH.md.
 */
export const NEW_TOKEN_SURFACES_ENV = "HIVRA_NEW_TOKEN_SURFACES";

export function newTokenSurfacesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[NEW_TOKEN_SURFACES_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

interface HeldBackRoute {
  /** The page or document, and everything beneath it. */
  prefix: string;
  /** Where a signed-out visitor goes. */
  signedOut: string;
  /** Where a signed-in customer goes (defaults to signedOut). */
  signedIn?: string;
}

const HELD_BACK: readonly HeldBackRoute[] = [
  // The $HermesOS holder information moved to the wallet; signed-in customers land there.
  { prefix: "/token", signedOut: "/pricing", signedIn: "/dashboard/wallet" },
  { prefix: "/tokenomics", signedOut: "/pricing", signedIn: "/pricing" },
  { prefix: "/why-hivra/evolution", signedOut: "/why-hivra", signedIn: "/why-hivra" },
  { prefix: "/dashboard/convert", signedOut: "/dashboard/billing", signedIn: "/dashboard/billing" },
  { prefix: "/docs/litepaper", signedOut: "/", signedIn: "/" },
  { prefix: "/LITEPAPER.md", signedOut: "/", signedIn: "/" },
  { prefix: "/WHITEPAPER.md", signedOut: "/", signedIn: "/" },
  { prefix: "/TOKENOMICS.md", signedOut: "/", signedIn: "/" },
];

/** Paths that are held back while the switch is off (for docs and tests). */
export const HELD_BACK_PREFIXES: readonly string[] = HELD_BACK.map((route) => route.prefix);

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Where a request for a held-back path should be sent, or null when the path is
 * not held back. The caller checks the switch first: this only maps paths.
 */
export function heldBackTokenSurfaceTarget(pathname: string, signedIn: boolean): string | null {
  const route = HELD_BACK.find((candidate) => underPrefix(pathname, candidate.prefix));
  if (!route) return null;
  return signedIn ? (route.signedIn ?? route.signedOut) : route.signedOut;
}
