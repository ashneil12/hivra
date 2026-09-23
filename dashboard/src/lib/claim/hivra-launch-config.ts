/**
 * Launch settings for the optional $HermesOS → $HIVRA conversion.
 *
 * This file is the ONLY place the $HIVRA contract address and the conversion
 * link may come from. Never read them from user input, a query string, a token
 * search or a price site: several tokens using the Hivra name already exist on
 * Base, and none of them is Hivra's.
 *
 * Every value stays null until $HIVRA has launched and its terms are
 * published. Setting them is a reviewed pull request, not a runtime change.
 * While any required value is null the /dashboard/convert page stays dormant.
 *
 * Temporary home: once the dual-token registry lands in canary, the $HIVRA
 * address moves there and this file reads it from the registry instead.
 */
export type HivraLaunchConfig = {
  /** $HIVRA contract on Base, exactly as published by Hivra. */
  hivraTokenAddress: string | null;
  /** Public page with the published conversion terms (rate basis, fees, price protection). */
  termsUrl: string | null;
  /** Where holders convert. The swap runs outside Hivra; Hivra never holds the tokens. */
  conversionUrl: string | null;
};

export const HIVRA_LAUNCH_CONFIG: HivraLaunchConfig = {
  hivraTokenAddress: null,
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
