// Whether the Hivra agent surfaces are enabled. On by default on canary (by
// hostname) so a fresh account flows straight in; also via the build env or a
// ?hivra=1 escape hatch on previews. Stays OFF on prod (different hostname,
// env unset).
export function isHivraEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_HIVRA_AGENTS === "1") return true;
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).get("hivra") === "1") return true;
    if (/(^|\.)canary\./i.test(window.location.hostname)) return true;
    if (window.location.hostname.startsWith("hermesos-canary")) return true; // vercel preview alias
  } catch {
    /* ignore */
  }
  return false;
}

// Whether this deployment can serve the prepared Canary desktop computer
// (Omarchy). It is a retained guest that exists only on the Canary fleet: the
// claim route (POST /api/hivra/prepared-computers, Omarchy only) reads
// HIVRA_MANAGED_PROVISIONER_CHANNEL === "canary" plus
// HIVRA_CANARY_PREPARED_COMPUTERS_JSON, and production sets neither. Offering
// the profile anywhere else ends at a 503 ("not configured on Canary") shown as
// an uncertain launch (first production user, 2026-10-10). Keyed on the Canary
// hostname like the rest of the Hivra surface, deliberately NOT on
// NEXT_PUBLIC_HIVRA_AGENTS, which production sets too.
export function preparedCanarySurfaceAvailable(): boolean {
  if (process.env.NEXT_PUBLIC_HIVRA_PREPARED_CANARY === "1") return true;
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).get("prepared") === "1") return true;
    if (/(^|\.)canary\./i.test(window.location.hostname)) return true;
    if (window.location.hostname.startsWith("hermesos-canary")) return true; // vercel preview alias
  } catch {
    /* ignore */
  }
  return false;
}

// Server-side gate for the Hivra API routes (provision / list / poll / action /
// destroy). Placement is handled by the Proxmox allocator, but the feature is
// canary-only, so the API must be reachable only from canary (by request host)
// or an explicit build-env opt-in — prod (hermesos.cloud) is rejected. Note we
// deliberately do NOT honor ?hivra=1 here: that's a client UI escape hatch, not
// an auth bypass for the server. Pass the request's Host header.
export function isHivraApiAllowed(host: string | null | undefined): boolean {
  if (process.env.NEXT_PUBLIC_HIVRA_AGENTS === "1") return true;
  const h = (host || "").toLowerCase().split(":")[0]; // strip any :port
  if (/(^|\.)canary\./i.test(h)) return true;
  if (h.startsWith("hermesos-canary")) return true; // vercel preview alias
  return false;
}
