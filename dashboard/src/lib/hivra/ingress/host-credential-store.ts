import "server-only";

// Database side of the host credential (see host-credential.ts): the
// generation Hivra honours per host, and the nonces of signed host requests.
// Service role only. No credential is ever stored.

import { supabaseAdmin } from "@/lib/supabase";
import {
  buildHostCredentialDocument,
  isHostCredentialHostId,
  storedHostCredentialGeneration,
  type HostCredentialDocument,
  type HostCredentialRow,
  type NonceClaim,
} from "@/lib/hivra/ingress/host-credential";
import { resolveIngressSecret } from "@/lib/hivra/ingress/route-file";
import { trustedAppOrigin } from "@/lib/infrastructure/trusted-app-origin";

type Env = Record<string, string | undefined>;

const UNIQUE_VIOLATION = "23505";

function db() {
  if (!supabaseAdmin) throw new Error("database_unavailable");
  return supabaseAdmin;
}

/** The host row, or null when there is none. Throws when it cannot be read. */
export async function loadHostCredentialRow(hostId: string): Promise<HostCredentialRow | null> {
  const { data, error } = await db()
    .from("proxmox_hosts")
    .select("id, ingress_credential_generation")
    .eq("id", hostId)
    .maybeSingle();
  if (error) throw new Error("host_read_failed");
  return (data as HostCredentialRow | null) ?? null;
}

/** Records a request's nonce. replayed when it was seen before; expired ones of this host are cleared first. */
export async function claimHostRequestNonce(hostId: string, nonce: string, expiresAtMs: number): Promise<NonceClaim> {
  try {
    await db().from("hivra_ingress_host_nonces").delete().eq("host_id", hostId).lt("expires_at", new Date().toISOString());
  } catch {
    // Clearing is housekeeping; the insert below decides.
  }
  const { error } = await db().from("hivra_ingress_host_nonces").insert({
    host_id: hostId,
    nonce,
    expires_at: new Date(expiresAtMs).toISOString(),
  });
  if (!error) return "ok";
  return (error as { code?: string }).code === UNIQUE_VIOLATION ? "replayed" : "error";
}

/** Moves the generation from `from` to `to` only if it is still `from`. */
async function compareAndSetGeneration(hostId: string, from: number, to: number): Promise<boolean> {
  const { data, error } = await db()
    .from("proxmox_hosts")
    .update({ ingress_credential_generation: to })
    .eq("id", hostId)
    .eq("ingress_credential_generation", from)
    .select("id");
  if (error) throw new Error("host_write_failed");
  return Array.isArray(data) && data.length > 0;
}

export type HostCredentialIssue =
  | { ok: true; document: HostCredentialDocument }
  | { ok: false; reason: "secret_missing" | "origin_missing" | "bad_host" | "unknown_host" | "busy" };

/**
 * The credential document for the host's current generation, starting the
 * first generation (1) when none was ever issued. Issuing again gives the same
 * document, so a repeated install changes nothing on the host.
 */
export async function issueHostCredential(hostId: string, env: Env = process.env): Promise<HostCredentialIssue> {
  if (!isHostCredentialHostId(hostId)) return { ok: false, reason: "bad_host" };
  const secret = resolveIngressSecret(env);
  if (!secret) return { ok: false, reason: "secret_missing" };
  const origin = trustedAppOrigin(env);
  if (!origin) return { ok: false, reason: "origin_missing" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await loadHostCredentialRow(hostId);
    if (!row) return { ok: false, reason: "unknown_host" };
    const generation = storedHostCredentialGeneration(row);
    if (generation >= 1) {
      return { ok: true, document: buildHostCredentialDocument({ secret, hostId, generation, origin }) };
    }
    await compareAndSetGeneration(hostId, 0, 1);
  }
  return { ok: false, reason: "busy" };
}

/** Moves the host's generation on, so the credential it holds stops working. Returns the new generation. */
export async function revokeHostCredential(hostId: string): Promise<{ ok: true; generation: number } | { ok: false; reason: string }> {
  if (!isHostCredentialHostId(hostId)) return { ok: false, reason: "bad_host" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await loadHostCredentialRow(hostId);
    if (!row) return { ok: false, reason: "unknown_host" };
    const raw = row.ingress_credential_generation;
    const current = storedHostCredentialGeneration(row);
    // Compare against what the column holds (0 included), then move it past it.
    const from = current === 0 ? Number(raw ?? 0) : current;
    if (!Number.isSafeInteger(from) || from < 0) return { ok: false, reason: "bad_generation" };
    if (await compareAndSetGeneration(hostId, from, from + 1)) return { ok: true, generation: from + 1 };
  }
  return { ok: false, reason: "busy" };
}
