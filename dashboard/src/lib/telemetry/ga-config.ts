// Google Analytics settings shared by the browser loader (DeferredGTM), the
// sign-up event and the server route that sends that event.

export const GOOGLE_ANALYTICS_ID =
  process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_ID ||
  process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID ||
  "G-ML3NFRHMYF";

/**
 * "Public pages only" mode. Off by default.
 *
 * Off: Google Analytics and the Tag Manager container load on every page once
 * the visitor has accepted analytics, and the sign-up conversion is sent from
 * the browser on the first signed-in page.
 *
 * On: they never load on a signed-in page or on the pages that handle sign-in,
 * payment or tokens (lib/telemetry/analytics-private-routes). If they were
 * already loaded on a public page before a client-side move into the app, GA is
 * told to stop sending (`ga-disable-<id>`) until the visitor is back on a public
 * page. The sign-up conversion is sent by the server instead
 * (/api/telemetry/ga-sign-up, GA4 Measurement Protocol), which needs
 * GA_MEASUREMENT_PROTOCOL_API_SECRET. Set the secret before the switch, or
 * sign-ups stop reaching Google Analytics.
 *
 * NEXT_PUBLIC_, so it is fixed at build time: changing it needs a new build.
 */
export function isGaPublicPagesOnly(): boolean {
  return process.env.NEXT_PUBLIC_HIVRA_GA_PUBLIC_PAGES_ONLY?.trim().toLowerCase() === "true";
}
