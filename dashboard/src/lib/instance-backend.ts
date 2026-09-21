// Per-instance backend discriminator.
//
// Reads `hermes_instances.backend` from Supabase. The Phase-2 webui-retirement
// collapsed 'gateway' and 'webui' onto one webfree stack, so the value no longer
// discriminates behaviour — isWebfreeBackend() returns true for both, and new
// provisioning always writes 'gateway'. The 'webui' value is a historical
// artifact; a companion migration coerces the RUNNING rows that still carry it
// (verified 2026-07-09: every live 'webui' box runs the webfree gateway
// topology). Getters therefore return 'webui' only for the unaudited
// stopped/archived cohort the migration deliberately leaves alone — harmless,
// because every consumer routes it through isWebfreeBackend().

import "server-only";

import { supabaseAdmin } from "@/lib/supabase";

export type InstanceBackend = "gateway" | "webui";

/**
 * Resolve an instance's backend, scoped to a user. The user_id filter is
 * the important bit — without it, any caller with an instance UUID can
 * read whether that instance is webui vs gateway, even if they don't own
 * it. That's a small information leak today (every downstream code path
 * re-validates ownership), but it's a future footgun if a route ever
 * branches on the result before checking ownership.
 *
 * Returns "gateway" (the safe default) when:
 *   - the row doesn't exist
 *   - the row isn't owned by `userId`
 *   - the DB lookup fails
 */
export async function getInstanceBackend(
  instanceId: string,
  userId: string,
): Promise<InstanceBackend> {
  if (!supabaseAdmin) return "gateway";
  const query = supabaseAdmin
    .from("hermes_instances")
    .select("backend")
    .eq("id", instanceId)
    .eq("user_id", userId);

  if (typeof query.maybeSingle !== "function") {
    return "gateway";
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    // Fail closed to gateway so existing flows keep working on transient DB errors.
    return "gateway";
  }
  const backend = (data?.backend as string | null | undefined) ?? "gateway";
  return backend === "webui" ? "webui" : "gateway";
}

/**
 * Server-to-server lookup that intentionally skips the user_id filter.
 * Use ONLY from worker / cron contexts where a Clerk userId isn't
 * available (the request is signed via instance bearer / cron secret
 * instead). Application routes must use `getInstanceBackend(id, userId)`.
 */
export async function getInstanceBackendUnchecked(instanceId: string): Promise<InstanceBackend> {
  if (!supabaseAdmin) return "gateway";
  const query = supabaseAdmin
    .from("hermes_instances")
    .select("backend")
    .eq("id", instanceId);

  if (typeof query.maybeSingle !== "function") {
    return "gateway";
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    return "gateway";
  }
  const backend = (data?.backend as string | null | undefined) ?? "gateway";
  return backend === "webui" ? "webui" : "gateway";
}

/**
 * Build the WebUI base URL for an instance. Mirrors the way the legacy
 * gateway resolves baseUrl from instance.gateway_url, but does not touch
 * profile-port logic (WebUI doesn't use profile ports).
 */
export function deriveWebUIBaseUrl(gatewayUrl: string): string {
  // hermes-webui sits on the same Caddy front-end as the gateway used to;
  // both serve from the per-instance fqdn on :443/:80. The internal Docker
  // port differs (8787 vs 8642) but the public URL is identical.
  //
  // During the temporary HTTP migration (while ACME issuance was rate-limited),
  // some instances had their `gateway_url` flipped to `http://<ip>.sslip.io`.
  // Once HTTPS is available again, the dashboard should prefer HTTPS even if
  // the stored value lags behind.
  const normalized = gatewayUrl.replace(/\/+$/, "");

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol === "http:" && parsed.hostname.endsWith(".sslip.io")) {
      parsed.protocol = "https:";
      return parsed.toString().replace(/\/+$/, "");
    }
  } catch {
    // If gatewayUrl isn't parseable, fall back to the trimmed string.
  }

  return normalized;
}
