/**
 * Links for the optional $HermesOS → $HIVRA conversion.
 *
 * The $HIVRA contract itself is NOT set here: it comes only from the platform
 * token registry (lib/billing/hivra-token-launch.ts via token-registry.ts), the
 * one place that activates $HIVRA. Never take a token address from user input,
 * a query string, a token search or a price site: several tokens using the
 * Hivra name already exist on Base, and none of them is Hivra's.
 *
 * Both links stay null until $HIVRA is live and its conversion terms are
 * published. Setting them is a reviewed pull request, not a runtime change.
 */
export type ConversionLinksConfig = {
  /** Public page with the published conversion terms (rate basis, fees, price protection). */
  termsUrl: string | null;
  /** Where holders convert. The swap runs outside Hivra. */
  conversionUrl: string | null;
};

export const CONVERSION_LINKS: ConversionLinksConfig = {
  termsUrl: null,
  conversionUrl: null,
};

/**
 * Exact hosts a conversion link may point at (subdomains are not implied).
 * Anything else keeps conversion closed, so a typo or a lookalike domain can
 * never be shown as the way to convert. Add the exact host Bankr publishes.
 */
export const CONVERSION_URL_ALLOWED_HOSTS: readonly string[] = ["bankr.bot"];

/** Exact hosts the published terms may live on. */
export const TERMS_URL_ALLOWED_HOSTS: readonly string[] = [
  "hivra.cloud",
  "canary.hermesos.cloud",
];
