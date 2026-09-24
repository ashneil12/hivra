import "server-only";

import { z } from "zod";
import { decryptApiKey } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";

/** A launch may name a Venice key the owner saved in their Vault instead of
 * sending the key again. The server reads it here, for this owner only, and
 * the launch then carries it exactly like a pasted key: the model admission,
 * its fingerprint and delivery never see the Vault reference. */
const VaultReferenceSchema = z.object({
  provider: z.literal("venice"),
  mode: z.literal("byok"),
  vaultKeyId: z.string().uuid(),
  model: z.string().optional(),
}).strict();

export type SavedVaultKeyRow = { provider: string; encrypted_key: string | null };
export type VaultKeyReader = (userId: string, vaultKeyId: string) => Promise<SavedVaultKeyRow | null>;

async function readOwnerVaultKey(userId: string, vaultKeyId: string): Promise<SavedVaultKeyRow | null> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const { data, error } = await supabaseAdmin
    .from("user_api_keys")
    .select("*")
    .eq("id", vaultKeyId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error("Vault read failed");
  if (!data) return null;
  // Older rows used key_encrypted; the Vault route writes encrypted_key.
  const row = data as { provider?: unknown; encrypted_key?: unknown; key_encrypted?: unknown };
  const encrypted = typeof row.encrypted_key === "string" ? row.encrypted_key
    : typeof row.key_encrypted === "string" ? row.key_encrypted : null;
  return { provider: typeof row.provider === "string" ? row.provider : "", encrypted_key: encrypted };
}

export type ResolvedLaunchLlm =
  | { ok: true; llm: unknown }
  | { ok: false; status: number; error: string };

/** Swaps a Vault reference in a launch's `llm` for the saved key it names.
 * Anything without a reference is returned untouched for the normal
 * validation, so a request can never mix a reference with a pasted key. */
export async function resolveLaunchLlmVaultKey(
  userId: string,
  raw: unknown,
  readKey: VaultKeyReader = readOwnerVaultKey,
): Promise<ResolvedLaunchLlm> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("vaultKeyId" in raw)) return { ok: true, llm: raw };
  const reference = VaultReferenceSchema.safeParse(raw);
  if (!reference.success) {
    return { ok: false, status: 400, error: "Choose either a saved Vault key or a pasted key for this launch." };
  }
  let saved: SavedVaultKeyRow | null;
  try {
    saved = await readKey(userId, reference.data.vaultKeyId);
  } catch {
    return { ok: false, status: 503, error: "Your saved key couldn't be read right now. Nothing was launched; try again." };
  }
  if (!saved || saved.provider.trim().toLowerCase() !== "venice" || !saved.encrypted_key) {
    return { ok: false, status: 404, error: "That saved Venice key is no longer in your Vault. Paste the key, or choose another option." };
  }
  let apiKey: string;
  try {
    apiKey = decryptApiKey(saved.encrypted_key);
  } catch {
    return { ok: false, status: 503, error: "Your saved key couldn't be read right now. Nothing was launched; try again." };
  }
  const { vaultKeyId: _vaultKeyId, ...selection } = reference.data;
  void _vaultKeyId;
  return { ok: true, llm: { ...selection, apiKey } };
}
