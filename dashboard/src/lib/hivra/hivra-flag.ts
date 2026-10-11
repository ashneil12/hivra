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
