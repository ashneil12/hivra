import "server-only";

import { decryptApiKey } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";

export type BuzzVaultProvider = "venice";

/** Resolve an account-owned model key without exposing it to the browser.
 * Buzz receives the plaintext only inside the short-lived install coordinator;
 * the runtime journal then encrypts it until the exact guest receipt settles. */
export async function resolveBuzzVaultCredential(userId: string, provider: BuzzVaultProvider): Promise<string | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from("user_api_keys")
    .select("encrypted_key")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  const encrypted = !error && typeof data?.encrypted_key === "string" ? data.encrypted_key : null;
  if (!encrypted) return null;
  try {
    const key = decryptApiKey(encrypted);
    return /^[\x21-\x7e]{1,8192}$/.test(key) ? key : null;
  } catch {
    return null;
  }
}
